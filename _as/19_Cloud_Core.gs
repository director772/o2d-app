/**
 * ============================================================
 *  19_Cloud_Core.gs  —  App ab Cloudflare pe chalta hai (CRM jaisa)
 * ============================================================
 *  Cloudflare (D1) ab app ka asli data rakhta hai — har screen aur
 *  har save wahin turant (website jaisi speed).
 *  Google Sheet = backup + report. Yeh file do kaam karti hai:
 *
 *  1. exportState — Cloudflare ko Sheet ka poora data deta hai
 *     (orders, Activity Log, staff, office time, chhutti, deadline ke niyam).
 *     Cloudflare har minute dekhta hai: Sheet mein haath se kuch badla?
 *     toh yahi data le leta hai.
 *
 *  2. runJob — app mein jo save hua (step, naya order, edit...), Cloudflare
 *     peeche se yahan bhejta hai → purana wala hi code Sheet mein likhta hai
 *     (bill number check, photo Drive folder, Activity Log — sab pehle jaisa).
 *     Wapas: Sheet ka taaza data (deadline BMP formula wali).
 *
 *  Suraksha: dono kaam sirf sahi Mirror Key ke saath (17_Cloud_Mirror).
 * ============================================================
 */

function o2dCloudCore_(body) {
  if (body.action === 'exportState') return { ok: true, state: o2dExportState_() };
  if (body.action === 'exportIfChanged') {
    const ver = o2dMirrorVersion_().full;
    if (body.knownVer && body.knownVer === ver) return { ok: true, same: true };
    return { ok: true, same: false, ver: ver, state: o2dExportState_() };
  }
  if (body.action === 'runJob') return o2dRunJob_(body.job || {});
  return { ok: false, error: 'Yeh kaam nahi pehchana: ' + body.action };
}

/* ---------------- 1. Poora data ---------------- */

function o2dExportState_() {
  O2D_FREEZE_ = false;
  O2D_ALL_MEMO_ = null;
  O2D_LOG_MEMO_ = null;
  const ms = function (d) { return (d instanceof Date && !isNaN(d.getTime())) ? d.getTime() : null; };

  const orders = o2dAllOrders_().map(function (o) {
    return {
      orderId: o.orderId, fmsRow: o.fmsRow, createdAt: ms(o.createdAt),
      customerName: o.customerName, phone: o.phone, city: o.city, item: o.item,
      customerType: o.customerType, orderType: o.orderType, payment: o.payment,
      salesperson: o.salesperson, orderPhoto: o.orderPhoto,
      isTest: !!o.isTest,
      steps: o.steps.map(function (s) {
        const f = {};
        Object.keys(s.fields || {}).forEach(function (k) {
          const v = s.fields[k];
          f[k] = (v instanceof Date) ? { d: v.getTime() } : v;
        });
        return { key: s.key, label: s.label, done: s.done, status: s.status, planned: ms(s.planned), actual: ms(s.actual), fields: f };
      })
    };
  });

  const log = o2dReadLog_().map(function (l) {
    return {
      t: ms(l.timeDate), time: l.time, orderId: l.orderId, step: l.step, kaam: l.kaam,
      doneBy: l.doneBy, enteredBy: l.enteredBy, doneAt: ms(l.doneAtDate),
      late: !!l.late, lateReason: l.lateReason, details: l.details
    };
  });

  const staff = o2dStaffListRefresh_().map(function (s) {
    return { name: s.name, role: s.role, steps: s.steps, isAdmin: !!s.isAdmin, active: !!s.active,
             canEdit: s.role === 'Director' || !!s.canEdit, linkCode: s.linkCode || '' };
  });

  const map = o2dReadStepMap();
  const when = {};
  map.steps.forEach(function (s) { if (s.key) when[s.key] = { text: s.whenText || '', tat: s.tatHours }; });

  const office = o2dReadOfficeConfig();
  return {
    orders: orders,
    log: log,
    staff: staff,
    office: { openTime: office.openTime, closeTime: office.closeTime, offDays: office.offDays, offDayNames: office.offDayNames },
    holidays: o2dReadHolidays(),
    when: when,
    steps: O2D.STEPS.map(function (s) {
      return { key: s.key, label: s.label, short: s.short, kind: s.kind,
               fields: s.fields.map(function (f) { return { key: f.key, header: f.header, type: f.type, required: !!f.required, options: f.options || [] }; }) };
    }),
    lateReasons: O2D.LATE_REASONS,
    roles: O2D.STAFF_ROLES,
    photo: { maxPerField: O2D.PHOTO_RULES.MAX_PER_FIELD, maxMb: O2D.PHOTO_RULES.MAX_MB },
    photoFields: Object.keys(O2D.PHOTO_FOLDERS),
    title: O2D_APP_TITLE,
    secret: o2dSecret_(),
    tokenDays: O2D_ACCESS.TOKEN_DAYS,
    at: Date.now()
  };
}

/* ---------------- 2. App ka save → Sheet ---------------- */

/**
 * job = { action, token, payload, wantId }
 * Wapas: { ok:true, res:{ok,data|error}, state } — res = purana API jaisa jawab
 */
function o2dRunJob_(job) {
  let res;
  if (job.action === 'busyInvoice') {
    // Busy ka bill → Bill Banao (22_Busy_Invoice). Token khaali = apne aap juda (naam se)
    res = o2dSafeForWeb_(o2dRun_(function () {
      const a = job.token ? o2dActorFromToken(job.token) : null;
      return o2dBusyInvoice_(job.payload || {}, a);
    }));
  } else if (job.action === 'createOrder') {
    res = o2dSafeForWeb_(o2dRun_(function () {
      const a = o2dActorFromToken(job.token);
      const p = job.payload || {};
      p.doneBy = a.isAdmin ? (p.salesperson || '') : '';
      return o2dCreateOrderWithId_(p, a, job.wantId);
    }));
  } else {
    res = o2dApi(job.token || '', String(job.action || ''), job.payload || {});
  }
  let state = null;
  try { state = o2dExportState_(); } catch (e) { /* Cloudflare agle minute le lega */ }
  // Is order ki photo / video — jiske paas link ho woh dekh sake (20_Share_Links)
  try {
    const oid = (res && res.ok && res.data && res.data.orderId) || job.orderId || (job.payload || {}).orderId;
    if (state && oid) o2dShareOrderLinks_(state.orders.filter(function (o) { return o.orderId === oid; })[0]);
  } catch (e) { /* share na ho toh bhi save theek hai */ }
  return { ok: true, res: res, state: state };
}

/**
 * Naya order — Cloudflare ne jo Order ID diya wahi (app mein turant dikh chuka hai).
 * Woh ID pehle se sheet mein ho toh naya ID (res.orderId batata hai).
 */
function o2dCreateOrderWithId_(payload, actor, wantId) {
  o2dActorMustCan_(actor, 'ORDER_ENTRY');
  const clean = o2dValidateOrderPayload_(payload, actor);
  clean.photos.forEach(function (p, i) { o2dPhotoToBlob_(p, i + 1); });
  const now = payload.createdAt ? new Date(Number(payload.createdAt)) : o2dNow();

  const saved = o2dWithLock(function () {
    const sh = o2dGetSheet_('RESPONSES');
    let orderId = String(wantId || '').trim();
    const exists = orderId && o2dAllOrders_().some(function (o) { return o.orderId === orderId; });
    if (!orderId || exists) orderId = o2dNextOrderId_(now);
    const respRow = Math.max(sh.getLastRow(), O2D.RESPONSES_FIRST_DATA - 1) + 1;
    // Form responses ki rows khatam → 100 nayi rows jodo (warna "range bahar hai" error)
    if (respRow > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), respRow - sh.getMaxRows() + 100);
    const row = o2dBuildResponseRow_(clean, orderId, now, '');
    sh.getRange(respRow, 1, 1, row.length).setValues([row]);
    const fmsRow = o2dResponseRowToFmsRow(respRow);
    o2dEnsureFmsFormulas_(fmsRow);
    SpreadsheetApp.flush();
    return { orderId: orderId, respRow: respRow, fmsRow: fmsRow };
  });

  let photoSaved = false, warning = '';
  try {
    const res = o2dSavePhotos('ORDER_PHOTO', saved.orderId, clean.customerName, clean.photos);
    o2dWithLock(function () { o2dWriteResponseCell_(saved.respRow, 'Order Parchi Photo', res.text); });
    photoSaved = true;
  } catch (e) {
    warning = 'Order ban gaya (' + saved.orderId + ') par photo save nahi hui: ' + e.message;
  }

  o2dLog({
    orderId: saved.orderId, fmsRow: saved.fmsRow, step: o2dGetStepDef('ORDER_ENTRY').label,
    action: 'Order bana', doneBy: clean.salesperson, enteredBy: actor.name, doneAt: now,
    details: clean.customerName + (clean.items.length ? ' | ' + clean.items.join(', ') : '') +
             ' | ' + clean.orderType + ' | ' + clean.payment + (photoSaved ? '' : ' | PHOTO NAHI HUI')
  });
  return { orderId: saved.orderId, fmsRow: saved.fmsRow, respRow: saved.respRow, photoSaved: photoSaved, warning: warning };
}
