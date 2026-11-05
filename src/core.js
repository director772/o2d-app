/**
 * O2D — app ka poora logic Cloudflare ke andar (Apps Script jaisa hi, JS mein)
 * ------------------------------------------------------------
 * Data (D1 se memory mein): orders, log, config(staff, office, chhutti, niyam)
 * Screens: home, stepList, orders, orderDetail, dashboard, search, config
 * Save: step, naya order, galti mili, cancel, edit — turant D1 mein;
 *       Sheet mein peeche se (Apps Script ka purana code, 19_Cloud_Core).
 * Samay: India (UTC+5:30, koi DST nahi).
 */

const TZ_MS = 330 * 60000;
export const STATUS = { DONE: 'Done', YES: 'Yes', NO: 'No' };
const COLOR_ORDER = { red: 0, yellow: 1, green: 2, grey: 3, wait: 4, done: 5 };
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export class AppError extends Error {}
const fail = (m) => { throw new AppError(m); };

/* ============================================================
 *  SAMAY
 * ============================================================ */

const p2 = (n) => String(n).padStart(2, '0');
function ist(ms) { return new Date(ms + TZ_MS); }
export function dayKey(ms) { const d = ist(ms); return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()); }
export function makeDate(key, hhmm) {
  const [y, m, d] = key.split('-').map(Number);
  const [h, mi] = String(hhmm || '00:00').split(':').map(Number);
  return Date.UTC(y, m - 1, d, h || 0, mi || 0) - TZ_MS;
}
function nextDayKey(key) { return dayKey(makeDate(key, '12:00') + 86400000); }
export function fmtDateTime(ms) {
  if (ms === null || ms === undefined || isNaN(ms)) return '';
  const d = ist(ms);
  let h = d.getUTCHours();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return p2(d.getUTCDate()) + '/' + p2(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear() + ' ' + p2(h) + ':' + p2(d.getUTCMinutes()) + ' ' + ap;
}
export function fmtDate(ms) {
  if (ms === null || ms === undefined || isNaN(ms)) return '';
  const d = ist(ms);
  return p2(d.getUTCDate()) + '/' + p2(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear();
}
function fmtDayKey(key) { const ms = makeDate(key, '12:00'); return fmtDate(ms) + ' (' + DAY_NAMES[ist(ms).getUTCDay()] + ')'; }
export function fmtMinutes(mins) {
  const m = Math.max(0, Math.round(Number(mins) || 0));
  const h = Math.floor(m / 60), r = m % 60;
  if (h === 0) return r + ' min';
  if (r === 0) return h + (h === 1 ? ' ghanta' : ' ghante');
  return h + (h === 1 ? ' ghanta ' : ' ghante ') + r + ' min';
}

function isWorkingDayKey(C, key) {
  const jsDay = ist(makeDate(key, '12:00')).getUTCDay();
  if ((C.office.offDays || []).indexOf(jsDay) >= 0) return false;
  if ((C.holidays || []).indexOf(key) >= 0) return false;
  return true;
}
export function workingMinutesBetween(C, from, to) {
  if (!from || !to || to <= from) return 0;
  let total = 0, key = dayKey(from);
  const endKey = dayKey(to);
  for (let g = 0; key <= endKey && g < 800; g++) {
    if (isWorkingDayKey(C, key)) {
      const s = Math.max(from, makeDate(key, C.office.openTime));
      const e = Math.min(to, makeDate(key, C.office.closeTime));
      if (e > s) total += (e - s) / 60000;
    }
    key = nextDayKey(key);
  }
  return Math.round(total);
}
function timeUsedPercent(C, start, planned, now) {
  if (!start || !planned) return null;
  const full = workingMinutesBetween(C, start, planned);
  if (full <= 0) return now >= planned ? 100 : 0;
  return Math.round((workingMinutesBetween(C, start, now) / full) * 100);
}
/** start ke baad itne KAAM ke minute (office time, chhutti chhod ke) */
function addWorkingMinutes(C, start, minutes) {
  let left = minutes, key = dayKey(start);
  for (let g = 0; g < 400; g++) {
    if (isWorkingDayKey(C, key)) {
      const open = makeDate(key, C.office.openTime), close = makeDate(key, C.office.closeTime);
      const s = Math.max(start, open);
      if (close > s) {
        const avail = (close - s) / 60000;
        if (left <= avail) return s + left * 60000;
        left -= avail;
      }
    }
    key = nextDayKey(key);
  }
  return null;
}

/* ============================================================
 *  CHHOTE KAAM
 * ============================================================ */

export const norm = (s) => String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
export function clean(v, maxLen) {
  let s = String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim();
  if (maxLen && s.length > maxLen) s = s.slice(0, maxLen);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}
const shown = (v) => String(v || '').replace(/^'/, '');
function cleanPhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 12 && d.indexOf('91') === 0) d = d.slice(2);
  if (d.length === 11 && d.charAt(0) === '0') d = d.slice(1);
  if (d.length !== 10) fail('Phone number 10 digit ka hona chahiye.');
  return d;
}
function properCase(v) {
  const s = String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const lead = s.charAt(0) === "'" ? "'" : '';
  const body = lead ? s.slice(1) : s;
  return lead + body.toLowerCase().replace(/(^|[\s.\-\/(&])([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase());
}
const billKey = (v) => String(v || '').replace(/^'/, '').replace(/\s+/g, '').toUpperCase();
function cleanBill(v) {
  let s = String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim();
  s = s.replace(/\s*([\/\-])\s*/g, '$1');
  if (s.length > 40) s = s.slice(0, 40);
  return clean(s);
}

export function stepDef(C, key) { return C.steps.find((s) => s.key === key) || fail('Step nahi mila: ' + key); }
function nonEntry(C) { return C.steps.filter((s) => s.kind !== 'entry'); }
function stateStep(o, key) { return o.steps.find((s) => s.key === key) || null; }
export function actorCan(a, key) { if (!a || !a.name) return false; if (a.isAdmin) return true; return (a.steps || []).indexOf(key) >= 0; }
function mustCan(C, a, key) { if (!actorCan(a, key)) fail(a.name + ' ko "' + stepDef(C, key).label + '" karne ki permission nahi hai.'); }
function prevStepKey(C, key) { const l = nonEntry(C); const i = l.findIndex((s) => s.key === key); return i > 0 ? l[i - 1].key : null; }
function nextStepKey(C, key) { const l = C.steps; const i = l.findIndex((s) => s.key === key); return i >= 0 && i < l.length - 1 ? l[i + 1].key : null; }
const isLate = (planned, doneAt) => !!planned && !!doneAt && doneAt > planned + 60000;
const links = (txt) => String(txt || '').split(',').map((s) => s.trim()).filter((s) => s.indexOf('http') === 0);

/* ============================================================
 *  DATA TAIYAR KARNA (Sheet ka export → app ki haalat)
 * ============================================================ */

/** orders + log → har order ki poori haalat (currentStep, cancel...) */
export function buildModel(C, rawOrders, log) {
  const cancelled = {};
  log.forEach((l) => { if (l.kaam === 'Order Cancel') cancelled[l.orderId] = l.details; });
  const orders = rawOrders.map((r) => {
    const o = JSON.parse(JSON.stringify(r));
    o.currentStep = null;
    for (const s of o.steps) { if (!s.done) { o.currentStep = s.key; break; } }
    o.complete = o.currentStep === null;
    o.cancelled = !!cancelled[o.orderId];
    o.cancelReason = cancelled[o.orderId] || '';
    o.isTest = !!o.isTest || /^TEST ORDER/i.test(o.customerName || '');
    return o;
  });
  return { C, orders, log, byId: new Map(orders.map((o) => [o.orderId, o])) };
}

function recompute(o) {
  o.currentStep = null;
  for (const s of o.steps) { if (!s.done) { o.currentStep = s.key; break; } }
  o.complete = o.currentStep === null;
}

/** Deadline (BMP jaisa): number = kaam ke ghante, "By 19:00 (+0 days)" = us din ka time */
export function plannedFor(C, o, key) {
  const w = (C.when || {})[key] || {};
  const idx = o.steps.findIndex((s) => s.key === key);
  const prevActual = idx === 0 ? o.createdAt : (o.steps[idx - 1] ? o.steps[idx - 1].actual : null);
  if (!prevActual) return null;
  const tat = Number(w.tat);
  if (w.tat !== null && w.tat !== undefined && !isNaN(tat)) return addWorkingMinutes(C, prevActual, tat * 60);
  const m = String(w.text || '').match(/(\d{1,2}):(\d{2}).*?\+\s*(\d+)/);
  if (m) {
    const stock = stateStep(o, 'STOCK_CHECK');
    const mk = stock && stock.fields && stock.fields.MAAL_KAB_AAYEGA;
    const base = mk && mk.d ? mk.d : prevActual;
    let k = dayKey(base);
    for (let i = 0; i < Number(m[3]); i++) k = nextDayKey(k);
    return makeDate(k, p2(m[1]) + ':' + m[2]);
  }
  return null;
}

/* ============================================================
 *  RANG + CARD
 * ============================================================ */

export function signal(M, o, now) {
  const C = M.C;
  if (o.complete) return { color: 'done', text: 'Complete' };
  const idx = o.steps.findIndex((s) => s.key === o.currentStep);
  const cur = o.steps[idx];
  const start = idx === 0 ? o.createdAt : o.steps[idx - 1].actual;
  if (cur.key === 'MAAL_READY') {
    const stock = o.steps[0];
    if (stock.status === STATUS.NO && cur.planned && dayKey(cur.planned) > dayKey(now)) {
      return { color: 'wait', text: 'Maal ka intezaar — ' + fmtDate(cur.planned) + ' tak', planned: cur.planned };
    }
  }
  if (!cur.planned) return { color: 'grey', text: 'Deadline abhi nahi bani' };
  if (now > cur.planned) {
    const late = workingMinutesBetween(C, cur.planned, now);
    return { color: 'red', text: fmtMinutes(late) + ' late', planned: cur.planned, lateMinutes: late };
  }
  const pct = timeUsedPercent(C, start, cur.planned, now);
  const left = workingMinutesBetween(C, now, cur.planned);
  return { color: pct !== null && pct >= 80 ? 'yellow' : 'green', text: fmtMinutes(left) + ' bache', planned: cur.planned, percent: pct };
}
const sigOut = (s) => Object.assign({}, s, s.planned ? { planned: fmtDateTime(s.planned) } : {});

function flowFor(C, o) {
  const out = [{ s: stepDef(C, 'ORDER_ENTRY').short || 'Order', st: 'd' }];
  o.steps.forEach((x) => {
    const short = x.key === 'DISPATCH' ? 'Bilty' : (stepDef(C, x.key).short || x.label);
    out.push({ s: short, st: x.done ? 'd' : (x.key === o.currentStep ? 'n' : 't') });
  });
  return out;
}

function cardFor(M, o, sig) {
  const C = M.C;
  const pack = stateStep(o, 'PACKAGING'), bill = stateStep(o, 'INVOICE'), stock = stateStep(o, 'STOCK_CHECK');
  return {
    orderId: o.orderId, customer: shown(o.customerName), city: shown(o.city), item: o.item, orderType: o.orderType,
    payment: o.payment, salesperson: o.salesperson, orderTime: fmtDateTime(o.createdAt),
    step: o.currentStep, stepLabel: o.currentStep ? stepDef(C, o.currentStep).label : 'Complete',
    color: sig.color, signal: sig.text,
    deadline: sig.planned ? fmtDateTime(sig.planned) : '', deadlineMs: sig.planned || 0,
    stockNahi: !!(stock && stock.status === STATUS.NO),
    billNo: bill ? shown(bill.fields.BILL_NUMBER || '') : '',
    courierType: pack ? pack.fields.COURIER_TYPE || '' : '',
    flow: flowFor(C, o)
  };
}
const cardSort = (a, b) => (COLOR_ORDER[a.color] - COLOR_ORDER[b.color]) || ((a.deadlineMs || 9e15) - (b.deadlineMs || 9e15));

/* ============================================================
 *  SCREENS
 * ============================================================ */

export function whoByStep(C) {
  const staff = C.staff.filter((s) => s.active && !s.isAdmin);
  const out = {};
  C.steps.forEach((st) => { out[st.key] = staff.filter((s) => s.steps.indexOf(st.key) >= 0).map((s) => s.name).join(' / '); });
  return out;
}

export function myWork(M, a, now) {
  const C = M.C;
  const mySteps = nonEntry(C).filter((s) => actorCan(a, s.key));
  const by = {};
  mySteps.forEach((s) => { by[s.key] = []; });
  M.orders.forEach((o) => {
    if (o.cancelled || o.isTest || o.complete || !by[o.currentStep]) return;
    by[o.currentStep].push(cardFor(M, o, signal(M, o, now)));
  });
  let red = 0, yellow = 0, total = 0;
  const groups = mySteps.map((s) => {
    const items = by[s.key].sort(cardSort);
    items.forEach((c) => { total++; if (c.color === 'red') red++; if (c.color === 'yellow') yellow++; });
    return { step: s.key, label: s.label, count: items.length, items };
  });
  return { total, red, yellow, groups, at: fmtDateTime(now) };
}

export function homeFor(M, a, now) {
  const w = myWork(M, a, now);
  return {
    at: w.at, total: w.total, red: w.red, yellow: w.yellow,
    canNewOrder: actorCan(a, 'ORDER_ENTRY'),
    steps: w.groups.map((g) => ({
      step: g.step, label: g.label, count: g.count,
      red: g.items.filter((c) => c.color === 'red').length,
      yellow: g.items.filter((c) => c.color === 'yellow').length,
      wait: g.items.filter((c) => c.color === 'wait').length
    })),
    groups: w.groups,
    who: whoByStep(M.C)
  };
}

export function stepList(M, a, step, now) {
  if (!step) fail('Step nahi chuna.');
  if (!actorCan(a, step)) fail(a.name + ' ka yeh kaam nahi hai.');
  return myWork(M, { name: a.name, role: a.role, steps: [step], isAdmin: false }, now);
}

export function meFor(C, a) {
  return { name: a.name, role: a.role, steps: a.steps, stepLabels: (a.steps || []).map((k) => stepDef(C, k).label), isAdmin: !!a.isAdmin, isDirector: !!a.isDirector, canEdit: !!(a.isDirector || a.canEdit) };
}

export function uiConfig(C, a, now) {
  const staff = C.staff.filter((s) => s.active);
  return {
    title: C.title,
    steps: C.steps.map((s) => ({
      key: s.key, label: s.label, kind: s.kind, canDo: actorCan(a, s.key),
      fields: s.fields.filter((f) => f.type !== 'auto').map((f) => ({ key: f.key, header: f.header, type: f.type, required: !!f.required, options: f.options || [] })),
      staffNames: staff.filter((x) => !x.isAdmin && x.steps.indexOf(s.key) >= 0).map((x) => x.name)
    })),
    lateReasons: C.lateReasons, roles: C.roles,
    office: { open: C.office.openTime, close: C.office.closeTime, offDays: C.office.offDays, offDayNames: C.office.offDayNames },
    holidays: C.holidays, today: dayKey(now), photo: C.photo
  };
}

export function loginNames(C) {
  const order = { Director: 0, PC: 1, Staff: 2 };
  return C.staff.filter((s) => s.active)
    .sort((a, b) => ((order[a.role] ?? 3) - (order[b.role] ?? 3)) || a.name.localeCompare(b.name))
    .map((s) => s.name);
}
export function loginInfo(C, code) {
  const c = String(code || '').trim().toUpperCase();
  if (c) {
    const st = C.staff.find((s) => s.linkCode && s.linkCode.toUpperCase() === c);
    if (st && st.active) return { names: [st.name], linkCode: c, linkName: st.name, linkError: '' };
    return { names: [], linkCode: '', linkName: '', linkError: 'Yeh link band ho chuka hai. Director se naya link mango.' };
  }
  return { names: loginNames(C), linkCode: '', linkName: '', linkError: '' };
}

export function myOrders(M, a, days, now) {
  const C = M.C;
  const since = now - (days || 30) * 86400000;
  const who = whoByStep(C);
  const list = M.orders.filter((o) => {
    if (o.cancelled || o.isTest) return false;
    if (!a.isAdmin && o.salesperson !== a.name) return false;
    if (o.createdAt && o.createdAt < since) return false;
    return true;
  }).map((o) => {
    const c = cardFor(M, o, signal(M, o, now));
    c.whereNow = o.complete ? 'Dispatch ho gaya ✅' : stepDef(C, o.currentStep).label + ' — ' + (who[o.currentStep] || 'Director / PC') + ' ke paas';
    c.complete = o.complete;
    c.createdMs = o.createdAt || 0;
    const d = stateStep(o, 'DISPATCH');
    c.dispatchedAt = d && d.actual ? fmtDateTime(d.actual) : '';
    c.transporter = d ? d.fields.TRANSPORTER || '' : '';
    return c;
  }).sort((x, y) => y.createdMs - x.createdMs);
  return { total: list.length, running: list.filter((c) => !c.complete).length, complete: list.filter((c) => c.complete).length, items: list };
}

export function orderDetail(M, id, a, now) {
  const C = M.C;
  const o = findOrder(M, id);
  const sig = signal(M, o, now);
  const logs = M.log.filter((l) => l.orderId === o.orderId);
  const lastDoneBy = {};
  logs.forEach((l) => {
    if (l.kaam === 'Done' || l.kaam.indexOf('Jawab:') === 0) lastDoneBy[l.step] = { doneBy: l.doneBy, enteredBy: l.enteredBy, lateReason: l.lateReason };
    if (l.kaam === 'Step wapas khola') delete lastDoneBy[l.step];
  });
  const photoKeys = C.photoFields || [];
  const steps = o.steps.map((s) => {
    const who = lastDoneBy[s.label] || {};
    const photos = [];
    const fields = {};
    Object.keys(s.fields || {}).forEach((k) => {
      const v = s.fields[k];
      if (photoKeys.indexOf(k) >= 0) { links(v).forEach((u) => photos.push(u)); return; }
      fields[k] = v && v.d ? fmtDate(v.d) : shown(v);
    });
    return {
      key: s.key, label: s.label, done: s.done,
      status: s.status === 'Yes' ? 'Haan' : s.status === 'No' ? 'Nahi' : s.status,
      planned: fmtDateTime(s.planned), actual: fmtDateTime(s.actual),
      late: s.done ? isLate(s.planned, s.actual) : (s.planned ? now > s.planned : false),
      doneBy: who.doneBy || '', enteredBy: who.enteredBy && who.enteredBy !== who.doneBy ? who.enteredBy : '',
      lateReason: who.lateReason || '', fields, photos, isCurrent: s.key === o.currentStep,
      uploading: !!s.uploading
    };
  });
  return {
    orderId: o.orderId, customer: shown(o.customerName), phone: shown(o.phone), city: shown(o.city), item: o.item,
    customerType: o.customerType, orderType: o.orderType, payment: o.payment,
    salesperson: o.salesperson, orderTime: fmtDateTime(o.createdAt), orderPhotos: links(o.orderPhoto),
    currentStep: o.currentStep, currentLabel: o.currentStep ? stepDef(C, o.currentStep).label : 'Complete',
    signal: sigOut(sig), complete: o.complete, cancelled: o.cancelled, cancelReason: o.cancelReason,
    steps,
    history: logs.map((l) => ({ time: l.time, step: l.step, kaam: l.kaam, doneBy: l.doneBy, details: l.details, lateReason: l.lateReason })),
    canAct: !o.cancelled && !!o.currentStep && actorCan(a, o.currentStep)
  };
}

function findOrder(M, id) {
  const want = String(id || '').trim().toUpperCase();
  const o = M.byId.get(want) || M.orders.find((x) => x.orderId.toUpperCase() === want);
  if (!o) fail('Order "' + id + '" nahi mila.');
  return o;
}

export function searchOrders(M, query, now) {
  const q = norm(query);
  if (q.length < 2) fail('Kam se kam 2 akshar likho.');
  const qId = String(query || '').trim().toUpperCase();
  return M.orders.filter((o) => {
    if (o.isTest) return false;
    const bill = stateStep(o, 'INVOICE');
    const hay = [o.orderId, o.customerName, o.city, o.phone, bill ? bill.fields.BILL_NUMBER : ''].map(norm).join(' | ');
    return o.orderId === qId || hay.indexOf(q) >= 0;
  }).slice(-30).reverse().map((o) => {
    const c = cardFor(M, o, signal(M, o, now));
    c.cancelled = o.cancelled; c.complete = o.complete;
    return c;
  });
}

function dashPeriod(opts, now) {
  const parse = (s) => { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? m[1] + '-' + m[2] + '-' + m[3] : null; };
  const today = dayKey(now);
  let from = parse(opts.from), to = parse(opts.to);
  if (!from || !to) {
    const n = Math.max(1, Math.min(parseInt(opts.days, 10) || 30, 3660));
    to = today; from = today;
    for (let i = 1; i < n; i++) from = dayKey(makeDate(from, '12:00') - 86400000);
  }
  if (from > to) { const t = from; from = to; to = t; }
  if (to > today) to = today;
  if (from > today) from = today;
  const since = makeDate(from, '00:00'), until = makeDate(to, '00:00') + 86400000 - 1;
  const days = Math.round((makeDate(to, '12:00') - makeDate(from, '12:00')) / 86400000) + 1;
  const show = (k) => fmtDate(makeDate(k, '12:00'));
  const label = days === 1 ? (from === today ? 'Aaj' : show(from)) : show(from) + ' se ' + show(to);
  return { since, until, days, label, fromKey: from, toKey: to };
}

export function dashboard(M, a, opts, now) {
  const C = M.C;
  if (!a.isAdmin) fail('Yeh hissa sirf Director / PC ke liye hai.');
  const todayKey = dayKey(now);
  const P = dashPeriod(opts || {}, now);
  const orders = M.orders.filter((o) => !o.cancelled && !o.isTest);
  const who = whoByStep(C);
  const board = {};
  nonEntry(C).forEach((s) => { board[s.key] = { step: s.key, label: s.label, who: who[s.key] || 'Director / PC', total: 0, red: 0, yellow: 0, wait: 0 }; });
  const redList = [];
  let running = 0, todayOrders = 0, todayDispatch = 0;
  orders.forEach((o) => {
    if (o.createdAt && dayKey(o.createdAt) === todayKey) todayOrders++;
    const d = stateStep(o, 'DISPATCH');
    if (d && d.actual && dayKey(d.actual) === todayKey) todayDispatch++;
    if (o.complete) return;
    running++;
    const sig = signal(M, o, now);
    const b = board[o.currentStep];
    b.total++;
    if (sig.color === 'red') { b.red++; redList.push(cardFor(M, o, sig)); }
    if (sig.color === 'yellow') b.yellow++;
    if (sig.color === 'wait') b.wait++;
  });
  redList.sort((x, y) => x.deadlineMs - y.deadlineMs);

  const testIds = {}, liveIds = {};
  M.orders.forEach((o) => { if (o.isTest) testIds[o.orderId] = true; else if (!o.cancelled) liveIds[o.orderId] = true; });
  const nameByNorm = {};
  C.staff.forEach((s) => { if (s.active) nameByNorm[norm(s.name)] = s.name; });
  const per = {}, reasons = {};
  M.log.forEach((l) => {
    const isDone = l.kaam === 'Done' || l.kaam.indexOf('Jawab:') === 0;
    if (!isDone || !l.t || l.t < P.since || l.t > P.until) return;
    if (!liveIds[l.orderId] || testIds[l.orderId] || /^TEST/i.test(l.details) || String(l.lateReason).indexOf('Test') >= 0) return;
    const name = nameByNorm[norm(l.doneBy)];
    if (!name) return;
    const p = per[name] || (per[name] = { name, done: 0, late: 0 });
    p.done++;
    if (l.late) { p.late++; const r = String(l.lateReason).split(' — ')[0] || 'Pata nahi'; reasons[r] = (reasons[r] || 0) + 1; }
  });
  C.staff.forEach((s) => { if (s.active && !s.isAdmin && !per[s.name]) per[s.name] = { name: s.name, done: 0, late: 0 }; });
  const staff = Object.values(per).map((p) => { p.onTimePct = p.done ? Math.round(((p.done - p.late) / p.done) * 100) : 0; return p; })
    .sort((x, y) => (!x.done !== !y.done ? (x.done ? -1 : 1) : (x.onTimePct - y.onTimePct || y.done - x.done)));

  const logDone = {};
  M.log.forEach((l) => {
    const k = l.orderId + '|' + l.step;
    if (l.kaam === 'Done' || l.kaam.indexOf('Jawab:') === 0) logDone[k] = l;
    else if (l.kaam === 'Step wapas khola') delete logDone[k];
  });
  const mismatch = [];
  orders.forEach((o) => o.steps.forEach((s) => {
    if (s.done) return;
    const l = logDone[o.orderId + '|' + s.label];
    if (l) mismatch.push({ orderId: o.orderId, customer: shown(o.customerName), step: s.label, doneBy: l.doneBy, time: l.time });
  }));

  const lateReasons = Object.keys(reasons).map((k) => ({ reason: k, count: reasons[k] })).sort((x, y) => y.count - x.count);
  const durations = [];
  orders.forEach((o) => {
    const d = stateStep(o, 'DISPATCH');
    if (o.complete && d && d.actual && o.createdAt && d.actual >= P.since && d.actual <= P.until) durations.push(workingMinutesBetween(C, o.createdAt, d.actual));
  });
  const avg = durations.length ? Math.round(durations.reduce((x, y) => x + y, 0) / durations.length) : 0;
  return {
    at: fmtDateTime(now), days: P.days, periodLabel: P.label, from: P.fromKey, to: P.toKey,
    summary: { running, red: redList.length, todayOrders, todayDispatch, completeInPeriod: durations.length, avgOrderToDispatch: durations.length ? fmtMinutes(avg) : '-' },
    steps: nonEntry(C).map((s) => board[s.key]), redList: redList.slice(0, 50), staff, lateReasons, mismatch
  };
}

/* ============================================================
 *  SAVE (turant D1 mein — Sheet mein peeche se)
 *  Har function: { result, order (badla hua), logs (nayi lines) }
 * ============================================================ */

function newLog(C, now, o, step, kaam, doneBy, enteredBy, doneAt, late, lateReason, details) {
  const d = ist(now);
  const time = p2(d.getUTCDate()) + '/' + p2(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear() + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds());
  return { t: now, time, orderId: o ? o.orderId : '', step, kaam, doneBy: doneBy || '', enteredBy: enteredBy || doneBy || '', doneAt: doneAt || null, late: !!late, lateReason: lateReason || '', details: details || '', pending: true };
}

function resolveDoneBy(C, input, a, stepKey) {
  const wanted = String(input.doneBy || '').trim();
  if (!wanted || wanted === a.name) return a.name;
  if (!a.isAdmin) fail('Sirf Director / PC kisi aur ki jagah entry kar sakte hain.');
  const s = C.staff.find((x) => x.name === wanted);
  if (!s) fail('"' + wanted + '" naam ka staff nahi mila.');
  if (s.steps.indexOf(stepKey) < 0) fail(wanted + ' ka yeh step nahi hai ("' + stepDef(C, stepKey).label + '"). Staff tab mein tick check karo.');
  return wanted;
}

function parseLocal(raw) {
  const m = String(raw || '').trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})$/);
  return m ? makeDate(m[1], m[2] + ':' + m[3]) : null;
}
function resolveDoneAt(input, a, minDate, now) {
  const raw = String(input.doneAt || '').trim();
  if (!raw) {
    const tap = Number(input.tapAt) || 0;
    if (tap && tap <= now + 60000 && tap >= now - 15 * 60000) {
      const t = Math.min(tap, now);
      if (!minDate || t >= minDate) return t;
    }
    return now;
  }
  if (!a.isAdmin) fail('Sirf Director / PC kaam ka time badal sakte hain.');
  const d = parseLocal(raw);
  if (!d) fail('"Kaam kab hua" ka time sahi se chuno.');
  if (d > now + 60000) fail('"Kaam kab hua" aage ka time nahi ho sakta.');
  if (minDate && d < minDate - 60000) fail('"Kaam kab hua" pichle step (' + fmtDateTime(minDate) + ') se pehle ka nahi ho sakta.');
  return d;
}

function checkLateReason(C, input) {
  const reason = String(input.lateReason || '').trim();
  if (!reason || C.lateReasons.indexOf(reason) < 0) return null;
  const isOther = reason === C.lateReasons[C.lateReasons.length - 1];
  const note = clean(input.lateNote, 200);
  if (isOther && !note) return null;
  return reason + (note ? ' — ' + note : '');
}

function parseDateInput(C, s, label, now) {
  s = String(s || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) fail(label + ' sahi se chuno.');
  if (s < dayKey(now)) fail(label + ' beeta hua din nahi ho sakta.');
  if (!isWorkingDayKey(C, s)) fail(label + ': ' + fmtDayKey(s) + ' ko chhutti hai. Koi aur din chuno.');
  return makeDate(s, '00:00');
}

function checkCanDo(C, o, stepKey) {
  const def = stepDef(C, stepKey);
  const st = stateStep(o, stepKey);
  if (!st) fail('Step nahi mila: ' + stepKey);
  if (st.done) fail(o.orderId + ': "' + def.label + '" pehle hi ho chuka hai (' + (st.actual ? fmtDateTime(st.actual) : st.status) + ').');
  const pk = prevStepKey(C, stepKey);
  if (pk && !stateStep(o, pk).done) fail(o.orderId + ': pehle "' + stepDef(C, pk).label + '" pura hona chahiye.');
}

/** Har step ka apna niyam (07–12 jaisa) → { status, values, details, photos } */
function stepHandler(M, o, stepKey, input, now) {
  const C = M.C;
  const f = input.fields || {};
  const photosOf = (k) => ((input.photos || {})[k] || []).filter((x) => x && (x.data || x.url));
  if (stepKey === 'STOCK_CHECK') {
    const s = norm(input.decision);
    let status;
    if (['yes', 'haan', 'ha', 'han'].indexOf(s) >= 0) status = STATUS.YES;
    else if (['no', 'nahi', 'nhi'].indexOf(s) >= 0) status = STATUS.NO;
    else fail('Stock hai ya nahi — "Haan" ya "Nahi" chuno.');
    let maal, details;
    if (status === STATUS.YES) { maal = makeDate(dayKey(now), '00:00'); details = 'Stock hai — maal aaj ready karna hai'; }
    else {
      const raw = String(f.MAAL_KAB_AAYEGA || '').trim();
      if (!raw) fail('Stock nahi hai — "Maal kab tak aayega?" ki date chuno.');
      maal = parseDateInput(C, raw, 'Maal kab tak aayega', now);
      details = 'Stock nahi — maal ' + fmtDate(maal) + ' tak aayega';
    }
    return { status, values: { MAAL_KAB_AAYEGA: { d: maal } }, details };
  }
  if (stepKey === 'MAAL_READY') {
    const st = stateStep(o, 'STOCK_CHECK');
    return { status: STATUS.DONE, values: {}, details: st && st.status === STATUS.NO ? 'Maal aa gaya aur ready hai (stock nahi tha)' : 'Maal nikaal ke alag rakh diya' };
  }
  if (stepKey === 'INVOICE') {
    const billNo = cleanBill(f.BILL_NUMBER);
    if (!billNo) fail('"Bill Number" bharna zaroori hai.');
    const key = billKey(billNo);
    const clash = M.orders.find((x) => x.orderId !== o.orderId && !x.cancelled && billKey((stateStep(x, 'INVOICE') || { fields: {} }).fields.BILL_NUMBER) === key);
    if (clash) fail('Bill Number "' + billNo + '" pehle se order ' + clash.orderId + ' (' + shown(clash.customerName) + ') pe laga hai. Sahi number daalo — alag series ho toh series ke saath likho (jaise L/' + billNo + ').');
    const photos = photosOf('BILL_PHOTO');
    if (!photos.length) fail('Bill ki photo daalo.');
    return { status: STATUS.DONE, values: { BILL_NUMBER: billNo }, details: 'Bill No. ' + billNo + ' | ' + photos.length + ' photo', uploading: true };
  }
  if (stepKey === 'BILL_CHECK') {
    const bill = stateStep(o, 'INVOICE');
    const billNo = bill ? shown(bill.fields.BILL_NUMBER) : '';
    const issues = M.log.filter((l) => l.orderId === o.orderId && l.kaam === 'Galti mili').length;
    return { status: STATUS.DONE, values: {}, details: 'Maal bill' + (billNo ? ' ' + billNo : '') + ' se match' + (issues ? ' (pehle ' + issues + ' baar galti mili thi)' : '') };
  }
  if (stepKey === 'PACKAGING') {
    const def = stepDef(C, 'PACKAGING');
    const opts = (def.fields.find((x) => x.key === 'COURIER_TYPE') || {}).options || [];
    const courier = String(f.COURIER_TYPE || '').trim();
    if (!courier) fail('"Courier Type" chuno — By Courier ya By Hand.');
    if (opts.length && opts.indexOf(courier) < 0) fail('Courier Type: "' + courier + '" sahi option nahi hai.');
    const photos = photosOf('PACKING_PHOTOS');
    const vids = (input.videos || []).filter((v) => v && v.fileId);
    if (vids.length > 3) fail('Ek order mein zyada se zyada 3 video daal sakte ho.');
    const skip = input.skipMedia === true || input.skipMedia === 'true';
    if (!skip && !photos.length && !vids.length) fail('Packing ki kam se kam 1 photo ya 1 video daalo (ya "skip" pe tick karo).');
    const vLinks = vids.map((v) => 'https://drive.google.com/file/d/' + v.fileId + '/view#video');
    return {
      status: STATUS.DONE, values: { COURIER_TYPE: courier, PACKING_PHOTOS: vLinks.join(', ') },
      details: courier + ' | ' + photos.length + ' photo' + (vids.length ? ' | ' + vids.length + ' video' : '') + (skip && !photos.length && !vids.length ? ' | Photo/Video skip' : ''),
      uploading: photos.length > 0
    };
  }
  if (stepKey === 'DISPATCH') {
    const pack = stateStep(o, 'PACKAGING');
    const byHand = !!(pack && norm(pack.fields.COURIER_TYPE) === 'by hand');
    let transporter = properCase(clean(f.TRANSPORTER, 80));
    const biltyNo = clean(String(f.BILTY_NO || '').replace(/\s+/g, ' ').trim(), 40);
    const photos = photosOf('BILTY_PHOTO');
    if (byHand) { if (!transporter) transporter = 'By Hand'; }
    else {
      if (!transporter) fail('"Transporter Name" bharo.');
      if (!biltyNo) fail('"Bilty Number" bharo.');
      if (!photos.length) fail('Bilty ki photo daalo.');
    }
    return {
      status: STATUS.DONE, values: { TRANSPORTER: transporter, BILTY_NO: biltyNo },
      details: (byHand ? 'By Hand' : 'By Courier') + ' | ' + transporter + (biltyNo ? ' | Bilty ' + biltyNo : '') + (photos.length ? ' | ' + photos.length + ' photo' : '') + ' | ORDER COMPLETE',
      uploading: photos.length > 0
    };
  }
  fail('Yeh step nahi pehchana: ' + stepKey);
}

export function submitStep(M, a, p, now) {
  const C = M.C;
  const stepKey = String(p.stepKey || '');
  const input = Object.assign({}, p.input || {});
  if (!a.isAdmin) { input.doneBy = ''; input.doneAt = ''; }
  const def = stepDef(C, stepKey);
  if (def.kind === 'entry') fail('Naya Order ke liye alag form hai.');
  mustCan(C, a, stepKey);
  const o = findOrder(M, p.orderId);
  if (o.cancelled) fail(o.orderId + ' cancel ho chuka hai.');
  checkCanDo(C, o, stepKey);
  const plan = stepHandler(M, o, stepKey, input, now);

  const who = resolveDoneBy(C, input, a, stepKey);
  const pk = prevStepKey(C, stepKey);
  const prevDoneAt = pk ? stateStep(o, pk).actual : o.createdAt;
  const doneAt = resolveDoneAt(input, a, prevDoneAt, now);
  const st = stateStep(o, stepKey);
  const late = isLate(st.planned, doneAt);
  let lateReason = '';
  if (late) {
    lateReason = checkLateReason(C, input);
    if (!lateReason) {
      return { result: { needLateReason: true, planned: fmtDateTime(st.planned), message: def.label + ' ki deadline ' + fmtDateTime(st.planned) + ' thi. Late kyun hua? Reason chuno.', reasons: C.lateReasons } };
    }
  }

  Object.keys(plan.values).forEach((k) => { st.fields[k] = plan.values[k]; });
  st.actual = doneAt; st.status = plan.status; st.done = true;
  if (plan.uploading) st.uploading = true;
  recompute(o);
  // Agle step ki deadline (Sheet ka BMP formula baad mein pakka kar deta hai)
  const nk = nextStepKey(C, stepKey);
  if (nk) { const ns = stateStep(o, nk); if (ns && !ns.done) ns.planned = plannedFor(C, o, nk); }
  if (stepKey === 'STOCK_CHECK') { const mr = stateStep(o, 'MAAL_READY'); if (mr && !mr.done) mr.planned = plannedFor(C, o, 'MAAL_READY'); }

  const kaam = plan.status === STATUS.DONE ? 'Done' : 'Jawab: ' + (plan.status === STATUS.YES ? 'Haan' : 'Nahi');
  const log = newLog(C, now, o, def.label, kaam, who, a.name, doneAt, late, lateReason, plan.details);
  return {
    order: o, logs: [log],
    result: {
      orderId: o.orderId, step: stepKey, label: def.label, status: plan.status, late, doneBy: who, doneAt: fmtDateTime(doneAt),
      nextStep: o.currentStep, nextLabel: o.currentStep ? stepDef(C, o.currentStep).label : '', complete: o.complete
    }
  };
}

export function nextOrderId(M, now) {
  const d = ist(now);
  const prefix = 'OD-' + p2(d.getUTCDate()) + p2(d.getUTCMonth() + 1) + String(d.getUTCFullYear()).slice(-2) + '-';
  let max = 0;
  M.orders.forEach((o) => { if (o.orderId.indexOf(prefix) === 0) max = Math.max(max, parseInt(o.orderId.slice(prefix.length), 10) || 0); });
  return prefix + p2(max + 1);
}

export function createOrder(M, a, p, now) {
  const C = M.C;
  mustCan(C, a, 'ORDER_ENTRY');
  const def = stepDef(C, 'ORDER_ENTRY');
  const F = {}; def.fields.forEach((f) => { F[f.key] = f; });
  const req = (v, f) => { if (v === null || v === undefined || String(v).trim() === '') fail('"' + f.header + '" bharna zaroori hai.'); return v; };
  const oneOf = (v, f) => { if ((f.options || []).indexOf(String(v).trim()) < 0) fail(f.header + ': "' + v + '" sahi option nahi hai.'); return String(v).trim(); };
  const customerName = clean(req(p.customerName, F.CUSTOMER_NAME), 100);
  const phone = cleanPhone(p.phone);
  const city = clean(p.city, 60);
  let items = p.item;
  if (typeof items === 'string') items = items ? items.split(',') : [];
  items = (items || []).map((s) => String(s).trim()).filter(Boolean);
  items.forEach((it) => oneOf(it, F.ITEM));
  const customerType = oneOf(req(p.customerType, F.CUSTOMER_TYPE), F.CUSTOMER_TYPE);
  const orderType = oneOf(req(p.orderType, F.ORDER_TYPE), F.ORDER_TYPE);
  const payment = oneOf(req(p.payment, F.PAYMENT), F.PAYMENT);
  const photos = (p.photos || []).filter((x) => x && x.data);
  if (!photos.length) fail('"' + F.ORDER_PHOTO.header + '" ki photo daalo.');
  let salesperson = a.name;
  if (a.isAdmin && p.salesperson && String(p.salesperson).trim()) salesperson = clean(p.salesperson, 60);

  const orderId = nextOrderId(M, now);
  const o = {
    orderId, fmsRow: null, createdAt: now, customerName, phone, city, item: items.join(', '),
    customerType, orderType, payment, salesperson, orderPhoto: '', isTest: /^TEST ORDER/i.test(customerName), uploading: true,
    steps: nonEntry(C).map((s) => ({ key: s.key, label: s.label, done: false, status: '', planned: null, actual: null, fields: Object.fromEntries(s.fields.map((f) => [f.key, ''])) })),
    cancelled: false, cancelReason: ''
  };
  recompute(o);
  o.steps[0].planned = plannedFor(C, o, o.steps[0].key);
  const log = newLog(C, now, o, def.label, 'Order bana', salesperson, a.name, now, false, '', customerName + (items.length ? ' | ' + items.join(', ') : '') + ' | ' + orderType + ' | ' + payment);
  return { order: o, logs: [log], isNew: true, result: { orderId, photoSaved: true, warning: '' } };
}

export function billIssue(M, a, p, now) {
  const C = M.C;
  mustCan(C, a, 'BILL_CHECK');
  const note = clean(p.note, 300);
  if (!note) fail('Kya galti mili? Likho (jaise "2 pcs kam", "size galat").');
  const o = findOrder(M, p.orderId);
  checkCanDo(C, o, 'BILL_CHECK');
  const who = a.isAdmin && p.doneBy ? String(p.doneBy) : a.name;
  const log = newLog(C, now, o, stepDef(C, 'BILL_CHECK').label, 'Galti mili', who, a.name, now, false, '', note);
  return { order: o, logs: [log], result: { orderId: o.orderId, recorded: true, message: 'Galti record ho gayi — order yahin ruka hai. Theek hone ke baad "Sab Sahi Hai" dabao.' } };
}

export function cancelOrder(M, a, p, now) {
  if (!a || a.role !== 'Director') fail('Order cancel sirf Director kar sakta hai.');
  const r = clean(p.reason, 200);
  if (!r) fail('Cancel kyun kar rahe ho? Reason likho.');
  const o = findOrder(M, p.orderId);
  if (o.cancelled) fail(o.orderId + ' pehle se cancel hai.');
  o.cancelled = true; o.cancelReason = r;
  const log = newLog(M.C, now, o, 'Order', 'Order Cancel', a.name, a.name, now, false, '', r);
  return { order: o, logs: [log], result: { orderId: o.orderId, cancelled: true } };
}

function editValue(f, raw) {
  if (!f) fail('Yeh field badla nahi ja sakta.');
  if (f.type === 'multiselect') {
    const list = (Array.isArray(raw) ? raw : String(raw || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
    list.forEach((x) => { if ((f.options || []).indexOf(x) < 0) fail(f.header + ': "' + x + '" sahi option nahi hai.'); });
    if (f.required && !list.length) fail(f.header + ' chuno.');
    return list.join(', ');
  }
  if (f.type === 'date') {
    const s = String(raw || '').trim();
    if (!s) { if (f.required) fail(f.header + ' chuno.'); return ''; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) fail(f.header + ' ki date sahi se chuno.');
    return { d: makeDate(s, '00:00') };
  }
  const v = clean(raw, 200);
  if (f.required && !v) fail(f.header + ' khaali nahi ho sakta.');
  if (f.type === 'select' && v && (f.options || []).indexOf(v) < 0) fail(f.header + ': "' + v + '" sahi option nahi hai.');
  if (f.type === 'phone' && v && !/^[0-9+\-\s]{6,20}$/.test(v)) fail('Phone number sahi nahi lag raha.');
  return v;
}
const valText = (v) => (v && v.d ? fmtDate(v.d) : shown(v));

export function editOrder(M, a, p, now) {
  const C = M.C;
  if (!(a.isDirector || a.canEdit)) fail('Aapko badalne ka access nahi hai. Director se maango.');
  const o = findOrder(M, p.orderId);
  const def = stepDef(C, 'ORDER_ENTRY');
  const map = { CUSTOMER_NAME: 'customerName', PHONE: 'phone', CITY: 'city', ITEM: 'item', CUSTOMER_TYPE: 'customerType', ORDER_TYPE: 'orderType', PAYMENT: 'payment' };
  const input = p.fields || {};
  const changes = [];
  Object.keys(map).forEach((k) => {
    if (!Object.prototype.hasOwnProperty.call(input, k)) return;
    const f = def.fields.find((x) => x.key === k);
    const v = editValue(f, input[k]);
    if (String(v) === String(o[map[k]] || '')) return;
    changes.push(f.header + ': "' + (shown(o[map[k]]) || '-') + '" → "' + (shown(v) || '-') + '"');
    o[map[k]] = v;
  });
  if (!changes.length) return { result: { ok: true, message: 'Kuch badla nahi.' }, nothing: true };
  const log = newLog(C, now, o, 'Naya Order', 'Order badla', a.name, a.name, now, false, '', changes.join(' · '));
  return { order: o, logs: [log], result: { ok: true, message: o.orderId + ' ki jaankari badal gayi.' } };
}

export function editStep(M, a, p, now) {
  const C = M.C;
  if (!(a.isDirector || a.canEdit)) fail('Aapko badalne ka access nahi hai. Director se maango.');
  const stepKey = String(p.stepKey || '');
  const def = stepDef(C, stepKey);
  if (def.kind === 'entry') fail('Order ki jaankari "Order badlo" se badlo.');
  const o = findOrder(M, p.orderId);
  const st = stateStep(o, stepKey);
  if (!st || !st.done) fail('"' + def.label + '" abhi bhara hi nahi gaya — pehle step bharo.');
  const input = p.fields || {};
  const changes = [];
  def.fields.forEach((f) => {
    if (f.type === 'photos' || f.type === 'auto' || !Object.prototype.hasOwnProperty.call(input, f.key)) return;
    const v = editValue(f, input[f.key]);
    const oldT = valText(st.fields[f.key]), newT = valText(v);
    if (oldT === newT) return;
    changes.push(f.header + ': "' + (oldT || '-') + '" → "' + (newT || '-') + '"');
    st.fields[f.key] = v;
  });
  let photoUp = false;
  def.fields.forEach((f) => {
    if (f.type !== 'photos') return;
    const list = ((p.photos || {})[f.key]) || [];
    if (!list.length) return;
    changes.push(f.header + ': nayi ' + list.length + ' photo lagi (purani Drive mein hai)');
    photoUp = true;
  });
  if (String(p.doneAt || '').trim()) {
    const pk = prevStepKey(C, stepKey);
    const minDate = pk ? stateStep(o, pk).actual : o.createdAt;
    const d = resolveDoneAt({ doneAt: p.doneAt }, a, minDate, now);
    const nk = nextStepKey(C, stepKey);
    const next = nk ? stateStep(o, nk) : null;
    if (next && next.done && next.actual && d > next.actual + 60000) fail('Time agle step (' + fmtDateTime(next.actual) + ') ke baad ka nahi ho sakta.');
    if (!st.actual || Math.abs(d - st.actual) >= 60000) {
      changes.push('Kaam kab hua: ' + fmtDateTime(st.actual) + ' → ' + fmtDateTime(d));
      st.actual = d;
      if (next && !next.done) next.planned = plannedFor(C, o, nk);
    }
  }
  if (!changes.length) return { result: { ok: true, message: 'Kuch badla nahi.' }, nothing: true };
  const log = newLog(C, now, o, def.label, 'Step badla', a.name, a.name, now, false, '', changes.join(' · '));
  if (photoUp) st.uploading = true;         // naya link Sheet se aate hi (kuch second) dikhega
  return { order: o, logs: [log], result: { ok: true, message: def.label + ' badal gaya.' + (photoUp ? ' Nayi photo Drive mein ja rahi hai — link kuch second mein dikhega.' : '') } };
}

export function undoStep(M, a, p, now) {
  const C = M.C;
  if (!(a.isDirector || a.canEdit)) fail('Aapko badalne ka access nahi hai. Director se maango.');
  const stepKey = String(p.stepKey || '');
  const def = stepDef(C, stepKey);
  if (def.kind === 'entry') fail('Naya Order wapas nahi khul sakta — zaroorat ho toh order cancel karo.');
  const why = clean(p.reason, 200);
  if (!why) fail('Wapas kholne ki wajah likho.');
  const o = findOrder(M, p.orderId);
  const st = stateStep(o, stepKey);
  if (!st || !st.done) fail('"' + def.label + '" pehle se khula hai.');
  const nk = nextStepKey(C, stepKey);
  if (nk && stateStep(o, nk).done) fail('Pehle agla step "' + stepDef(C, nk).label + '" wapas kholo — sirf aakhri bhara step wapas khulta hai.');
  Object.keys(st.fields).forEach((k) => { st.fields[k] = ''; });
  st.actual = null; st.status = ''; st.done = false;
  if (nk) { const ns = stateStep(o, nk); if (ns) ns.planned = null; }
  recompute(o);
  const log = newLog(C, now, o, def.label, 'Step wapas khola', a.name, a.name, now, false, '', why);
  return { order: o, logs: [log], result: { ok: true, message: def.label + ' wapas khul gaya — ab dobara bharo.' } };
}

/* ============================================================
 *  LOGIN TOKEN (Apps Script jaisa hi — dono ek doosre ka token maante hain)
 * ============================================================ */

const enc = new TextEncoder();
function b64ws(bytes) {
  let s = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_');
}
function unb64ws(s) {
  const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64ws(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

/** token → actor, ya error (relogin) */
export async function actorFromToken(C, token) {
  const t = String(token || '');
  const dot = t.indexOf('.');
  const bad = () => { const e = new AppError('Login khatam ho gaya. Dobara naam chun ke PIN daalo.'); e.relogin = true; throw e; };
  if (dot < 1 || !C.secret) bad();
  const payload = t.slice(0, dot), sig = t.slice(dot + 1);
  if ((await hmac(C.secret, payload)) !== sig) bad();
  let parts;
  try { parts = new TextDecoder().decode(unb64ws(payload)).split('|'); } catch (e) { bad(); }
  if (parts.length !== 3 || !(Number(parts[2]) > Date.now())) bad();
  const s = C.staff.find((x) => x.name === parts[0]);
  if (!s || s.linkCode !== parts[1]) { const e = new AppError('Aapka login band kiya gaya hai. Dobara naam chun ke PIN daalo.'); e.relogin = true; throw e; }
  if (!s.active) { const e = new AppError(s.name + ' ka access band hai. Director se baat karo.'); e.relogin = true; throw e; }
  return { name: s.name, role: s.role, steps: s.steps, isAdmin: s.isAdmin, isDirector: s.role === 'Director', canEdit: s.role === 'Director' || !!s.canEdit };
}
