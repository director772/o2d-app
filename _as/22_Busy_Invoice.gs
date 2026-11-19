/**
 * ============================================================
 *  22_Busy_Invoice.gs  —  Busy ka bill → "Bill Banao" step (Sheet)
 * ============================================================
 *  Cloudflare ne Busy mein sale bill dekha aur order se joda (naam se apne aap,
 *  ya staff ne bill number daala). Yahan:
 *   1. Bill ki PDF banti hai (party, bill no, tareekh, items, total) →
 *      Drive ke Bill Photo folder mein, link wala koi bhi dekh sake
 *   2. FMS mein Bill Number + PDF link + Actual (Busy mein bill bana tab ka time) + Done
 *   3. Activity Log
 *  Purane o2dCompleteStep jaisa hi likhta hai — bas photo ki jagah PDF.
 * ============================================================
 */

const O2D_BUSY_NAME = 'Busy (apne aap)';

/** job.payload = { stepKey, orderId, input:{doneBy,lateReason,lateNote,busyAuto}, busy:{no,at,party,total,items[]} } */
function o2dBusyInvoice_(p, actor) {
  const bill = p.busy || {};
  const billNo = String(bill.no || '').trim();
  if (!billNo) throw new Error('Busy bill ka number nahi mila.');
  const input = p.input || {};
  const def = o2dGetStepDef('INVOICE');
  const isAuto = !actor;
  if (actor) o2dActorMustCan_(actor, 'INVOICE');

  const found = o2dFindOrderOrFail(p.orderId);
  const state = o2dReadOrderRow_(found.fmsRow, found.id);
  const stState = o2dStateStep_(state, 'INVOICE');
  if (stState.done) {
    // Pehle hi ho chuka (dobara chala) — wahi bill ho toh theek
    if (o2dBusyKey_(stState.fields.BILL_NUMBER) === o2dBusyKey_(billNo)) return { orderId: state.orderId, step: 'INVOICE', already: true };
    throw new Error('Bill Banao pehle se ho chuka hai (bill ' + stState.fields.BILL_NUMBER + ').');
  }
  o2dCheckCanDoStep_(state, 'INVOICE');

  // Yeh bill number kisi aur order pe toh nahi?
  const st = o2dGetStep('INVOICE');
  const fms = o2dGetSheet_('FMS');
  const R = O2D.FMS_ROWS;
  const last = fms.getLastRow();
  if (last >= R.FIRST_DATA && st.fieldCols.BILL_NUMBER) {
    const nos = fms.getRange(R.FIRST_DATA, st.fieldCols.BILL_NUMBER, last - R.FIRST_DATA + 1, 1).getDisplayValues();
    const ids = fms.getRange(R.FIRST_DATA, 2, last - R.FIRST_DATA + 1, 1).getDisplayValues();
    const k = o2dBusyKey_(billNo);
    for (let i = 0; i < nos.length; i++) {
      if (R.FIRST_DATA + i !== found.fmsRow && o2dBusyKey_(nos[i][0]) === k) {
        throw new Error('Bill Number "' + billNo + '" pehle se order ' + ids[i][0] + ' pe laga hai.');
      }
    }
  }

  // Kisne / kab
  const who = isAuto ? O2D_BUSY_NAME : o2dResolveDoneBy_(input, actor, 'INVOICE');
  const prevKey = o2dPrevStepKey_('INVOICE');
  const prevDoneAt = prevKey ? o2dStateStep_(state, prevKey).actual : state.createdAt;
  const now = o2dNow();
  let doneAt = bill.at ? new Date(Number(bill.at)) : now;
  if (prevDoneAt instanceof Date && doneAt < prevDoneAt) doneAt = prevDoneAt;
  if (doneAt > now) doneAt = now;

  const late = o2dIsLate_(stState.planned, doneAt);
  let lateReason = '';
  if (late) {
    if (isAuto || input.busyAuto) lateReason = 'Busy mein bill deadline ke baad bana';
    else {
      const r = o2dCheckLateReason_(input);
      lateReason = r.ok ? r.text : 'Busy mein bill deadline ke baad bana';
    }
  }

  // PDF (lock ke bahar)
  const pdfUrl = o2dBusyBillPdf_(state, bill, doneAt);

  o2dWithLock(function () {
    const fresh = o2dReadOrderRow_(found.fmsRow, found.id);
    if (o2dStateStep_(fresh, 'INVOICE').done) throw new Error('Beech mein kisi aur ne Bill Banao kar diya.');
    const sh = o2dGetSheet_('FMS');
    sh.getRange(found.fmsRow, st.fieldCols.BILL_NUMBER).setValue(billNo);
    if (st.fieldCols.BILL_PHOTO) sh.getRange(found.fmsRow, st.fieldCols.BILL_PHOTO).setValue(pdfUrl);
    sh.getRange(found.fmsRow, st.actualCol).setValue(doneAt);
    sh.getRange(found.fmsRow, st.statusCol).setValue(O2D.STATUS_VALUE.DONE);
    SpreadsheetApp.flush();
    const chkActual = sh.getRange(found.fmsRow, st.actualCol).getValue();
    const chkStatus = String(sh.getRange(found.fmsRow, st.statusCol).getDisplayValue()).trim();
    if (!(chkActual instanceof Date) || chkStatus !== O2D.STATUS_VALUE.DONE) {
      throw new Error(def.label + ' Sheet mein save nahi hua (FMS row ' + found.fmsRow + ').');
    }
  });

  o2dLog({
    orderId: state.orderId, fmsRow: found.fmsRow, step: def.label, action: 'Done',
    doneBy: who, enteredBy: actor ? actor.name : O2D_BUSY_NAME, doneAt: doneAt,
    late: late, lateReason: lateReason,
    details: 'Bill No. ' + billNo + ' | Busy se (PDF apne aap)' + (isAuto ? ' | party ' + (bill.party || '') + ' — naam se juda' : '') +
             (bill.total ? ' | ₹' + o2dBusyMoney_(bill.total) : '')
  });

  const after = o2dReadOrderRow_(found.fmsRow, found.id);
  return {
    orderId: state.orderId, step: 'INVOICE', label: def.label, status: O2D.STATUS_VALUE.DONE, late: late,
    doneBy: who, doneAt: o2dFmtDateTime(doneAt), billNo: billNo, pdf: pdfUrl,
    nextStep: after.currentStep, nextLabel: after.currentStep ? o2dGetStepDef(after.currentStep).label : '', complete: after.complete
  };
}

function o2dBusyKey_(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

function o2dBusyMoney_(n) {
  const v = Math.round(Number(n) * 100) / 100;
  const parts = v.toFixed(2).split('.');
  let x = parts[0], last3 = x.slice(-3), rest = x.slice(0, -3);
  if (rest) last3 = ',' + last3;
  rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return rest + last3 + (parts[1] === '00' ? '' : '.' + parts[1]);
}

function o2dBusyEsc_(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
}

/** Bill ki PDF → Drive (Bill Photo wala folder) → link */
function o2dBusyBillPdf_(state, bill, when) {
  const tz = O2D.TIMEZONE || 'Asia/Kolkata';
  const items = bill.items || [];
  let qty = 0, sum = 0;
  const rows = items.map(function (it, i) {
    qty += Number(it.qty) || 0; sum += Number(it.amount) || 0;
    return '<tr><td>' + (i + 1) + '</td><td>' + o2dBusyEsc_(it.name) + '</td><td class="r">' + (Number(it.qty) || 0) +
      '</td><td class="r">' + o2dBusyMoney_(it.rate || 0) + '</td><td class="r">' + o2dBusyMoney_(it.amount || 0) + '</td></tr>';
  }).join('');
  const html =
    '<html><head><meta charset="utf-8"><style>' +
    'body{font-family:Arial,sans-serif;font-size:12px;color:#111;margin:24px}' +
    'h1{font-size:20px;margin:0}.muted{color:#555}.r{text-align:right}' +
    'table{border-collapse:collapse;width:100%;margin-top:12px}td,th{border:1px solid #999;padding:5px 6px}th{background:#eef2f7;text-align:left}' +
    '.info td{border:none;padding:2px 8px 2px 0}.tot td{font-weight:bold;background:#f6f6f6}' +
    '</style></head><body>' +
    '<h1>RK Garg Jeans</h1><div class="muted">Sale Bill — Busy ke data se</div>' +
    '<table class="info">' +
      '<tr><td><b>Bill No.</b></td><td>' + o2dBusyEsc_(bill.no) + '</td><td><b>Tareekh</b></td><td>' + Utilities.formatDate(when, tz, 'dd/MM/yyyy hh:mm a') + '</td></tr>' +
      '<tr><td><b>Party (Busy)</b></td><td>' + o2dBusyEsc_(bill.party || '') + '</td><td><b>Order</b></td><td>' + o2dBusyEsc_(state.orderId) + '</td></tr>' +
      '<tr><td><b>Customer (O2D)</b></td><td>' + o2dBusyEsc_(state.customerName || '') + '</td><td></td><td></td></tr>' +
    '</table>' +
    (items.length
      ? '<table><tr><th>#</th><th>Item</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr>' + rows +
        '<tr class="tot"><td></td><td>Kul</td><td class="r">' + qty + '</td><td></td><td class="r">' + o2dBusyMoney_(sum) + '</td></tr></table>'
      : '<p class="muted">Items ki jaankari Busy se nahi aayi.</p>') +
    '<p style="font-size:14px;margin-top:12px"><b>Bill ka kul amount (tax ke saath): ₹ ' + o2dBusyMoney_(bill.total || sum) + '</b></p>' +
    '<p class="muted" style="margin-top:24px">Yeh copy Busy ke data se apne aap bani hai. Asli bill Busy mein hai.</p>' +
    '</body></html>';

  const name = (state.orderId + ' - ' + (state.customerName || '') + ' - Bill ' + bill.no).replace(/[\\/:*?"<>|]/g, '-') + '.pdf';
  const blob = Utilities.newBlob(html, 'text/html', 'bill.html').getAs('application/pdf').setName(name);

  let folder = null;
  try { folder = o2dGetMonthFolder_('BILL_PHOTO', when); } catch (e) {}
  if (!folder) { try { folder = o2dGetStepFolder_('BILL_PHOTO'); } catch (e) {} }
  const file = folder ? folder.createFile(blob) : DriveApp.createFile(blob);
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { /* link sirf andar wale khol payenge */ }
  return 'https://drive.google.com/file/d/' + file.getId() + '/view';
}
