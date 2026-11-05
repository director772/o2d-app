/**
 * O2D — Cloudflare Worker (CRM jaisa: data Cloudflare D1 mein, Sheet backup)
 * ------------------------------------------------------------
 * - Har screen aur har save yahin turant (core.js) — Google ka intezaar nahi.
 * - Save → D1 turant + "job" line mein → peeche se Apps Script Sheet mein
 *   likhta hai (purana code: bill check, photo Drive folder, Activity Log).
 *   Job ke baad Sheet ka taaza data (BMP deadline) wapas D1 mein.
 * - Har minute: Sheet mein haath se badlav? → D1 mein le aao. Ruke hue job chalao.
 * - Login / staff page / video upload shuru: seedha Apps Script (kabhi-kabhi wale kaam).
 * - Kisi save ko Sheet mana kare (jaise bill number pehle se laga) → us staff ko
 *   app mein saaf message (alerts) + order Sheet jaisa wapas.
 */
import * as core from './core.js';

const NATIVE_WRITES = {
  submitStep: core.submitStep, createOrder: core.createOrder, billIssue: core.billIssue,
  cancelOrder: core.cancelOrder, editOrder: core.editOrder, editStep: core.editStep, undoStep: core.undoStep
};
const WRITE_LABEL = {
  submitStep: 'Step save', createOrder: 'Naya order', billIssue: 'Galti mili', cancelOrder: 'Order cancel',
  editOrder: 'Order badla', editStep: 'Step badla', undoStep: 'Step wapas khola', addOrderPhotos: 'Parchi photo'
};
const PART = 900000;                 // bada payload (photo) D1 mein tukdon mein
const VIDEO_CHUNK = 16 * 1024 * 1024;

let tablesReady = false;
let MEM = null;                      // { ver, M }

async function ensureTables(env) {
  if (tablesReady) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, json TEXT, h TEXT, pending_job INTEGER DEFAULT 0)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS plogs (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER, json TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER, actor TEXT, action TEXT, token TEXT, order_id TEXT, want_id TEXT, label TEXT, status TEXT, tries INTEGER DEFAULT 0, error TEXT, done_at INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS job_parts (job_id INTEGER, part INTEGER, data TEXT, PRIMARY KEY (job_id, part))'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT, created INTEGER, json TEXT, seen INTEGER DEFAULT 0)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, url TEXT, size INTEGER, mime TEXT, th TEXT, at INTEGER)'),
    env.DB.prepare('DROP TABLE IF EXISTS screens'),
    env.DB.prepare('DROP TABLE IF EXISTS cache')
  ]);
  tablesReady = true;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api')) await ensureTables(env);
    if (url.pathname === '/api' && request.method === 'POST') return handleApi(request, env, ctx);
    if (url.pathname === '/api/status') return json(await status(env));
    if (url.pathname === '/api/refresh') { await importFromSheet(env, true); ctx.waitUntil(processJobs(env)); return json(await status(env)); }
    if (url.pathname === '/api/video-chunk' && request.method === 'POST') return videoChunk(request, env, url);
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    await ensureTables(env);
    await processJobs(env);
    await importFromSheet(env, false);
  }
};

/* ============================================================
 *  API
 * ============================================================ */

async function handleApi(request, env, ctx) {
  let body;
  try { body = JSON.parse(await request.text()); } catch (e) { return json({ ok: false, error: 'Request samajh nahi aaya.' }); }
  const action = String(body.action || '');
  const token = String(body.token || '');
  const payload = body.payload || {};
  const now = Date.now();

  let M;
  try { M = await loadModel(env); } catch (e) { M = null; }
  if (!M) {
    // Pehli baar: Sheet se data laao
    await importFromSheet(env, true);
    M = await loadModel(env);
    if (!M) return json({ ok: false, error: 'Data abhi taiyar ho raha hai. 1 minute baad try karo.' });
  }
  const C = M.C;

  try {
    // ---- Bina login ----
    if (action === 'loginNames') return json({ ok: true, data: core.loginNames(C) });
    if (action === 'loginInfo') return json({ ok: true, data: core.loginInfo(C, payload.code) });
    if (action === 'login' || action === 'loginLink') {
      const res = await forward(env, body);
      if (res && res.ok) ctx.waitUntil(importFromSheet(env, false).catch(() => {}));
      if (res && res.ok && res.data && res.data.token) {
        try {
          const a = await core.actorFromToken(C, res.data.token);
          res.data.boot = { config: core.uiConfig(C, a, now), me: core.meFor(C, a), home: core.homeFor(M, a, now) };
        } catch (e) { /* Apps Script wala boot hi chalega */ }
      }
      if (res) delete res.who;
      return json(res);
    }

    // ---- Login zaroori ----
    let a;
    try { a = await core.actorFromToken(C, token); }
    catch (e) { return json({ ok: false, error: e.message, relogin: true }); }
    const alerts = await takeAlerts(env, a.name);
    const reply = (data) => json(Object.assign({ ok: true, data }, alerts.length ? { alerts } : {}));

    switch (action) {
      case 'boot': return reply({ config: core.uiConfig(C, a, now), me: core.meFor(C, a), home: core.homeFor(M, a, now) });
      case 'me': return reply({ staff: core.meFor(C, a) });
      case 'home': return reply(core.homeFor(M, a, now));
      case 'stepList': return reply(core.stepList(M, a, payload.step, now));
      case 'orders': return reply(core.myOrders(M, viewActor(C), payload.days || 30, now));
      case 'search': return reply(core.searchOrders(M, payload.query, now));
      case 'orderDetail': return reply(core.orderDetail(M, payload.orderId, a, now));
      case 'details': {
        const out = {};
        (payload.orderIds || []).slice(0, 30).forEach((id) => { try { out[id] = core.orderDetail(M, id, a, now); } catch (e) { /* chhodo */ } });
        return reply(out);
      }
      case 'dashboard': return reply(core.dashboard(M, a, { days: payload.days, from: payload.from, to: payload.to }, now));
      case 'ackAlerts': return reply({ ok: true });
    }

    if (NATIVE_WRITES[action]) {
      const p = JSON.parse(JSON.stringify(payload));
      let out;
      try { out = NATIVE_WRITES[action](M, a, p, now); }
      catch (e) { if (!(e instanceof core.AppError)) MEM = null; throw e; }
      if (!out.order) return reply(out.result);                // late reason / kuch badla nahi → kuch save nahi
      await saveWrite(env, M, a, action, token, payload, out);
      ctx.waitUntil(processJobs(env));
      return reply(out.result);
    }

    if (action === 'addOrderPhotos') {
      const o = M.byId.get(String(payload.orderId || '').toUpperCase());
      if (!o) throw new core.AppError('Order nahi mila.');
      if (!core.actorCan(a, 'ORDER_ENTRY')) throw new core.AppError('Permission nahi hai.');
      o.uploading = true;
      await saveWrite(env, M, a, action, token, payload, { order: o, logs: [] });
      ctx.waitUntil(processJobs(env));
      return reply({ orderId: o.orderId, added: (payload.photos || []).length });
    }

    // ---- Baaki (staff page, PIN, video) → seedha Apps Script ----
    const res = await forward(env, body);
    if (res && res.ok && ['saveStaff', 'setPin', 'newLink', 'changePin'].indexOf(action) >= 0) ctx.waitUntil(importFromSheet(env, true).catch(() => {}));
    if (action === 'videoStart' && res && res.ok && res.data && res.data.sessionUrl) {
      await env.DB.prepare('INSERT OR REPLACE INTO uploads (id, url, size, mime, th, at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(res.data.uploadId, res.data.sessionUrl, Number(payload.size) || 0, String(payload.mimeType || 'video/mp4'), await sha(token), now).run();
      delete res.data.sessionUrl;
      res.data.direct = true;
      res.data.chunkBytes = VIDEO_CHUNK;
    }
    if (res) delete res.who;
    if (res && res.ok && alerts.length) res.alerts = alerts;
    return json(res);
  } catch (e) {
    if (e instanceof core.AppError) return json({ ok: false, error: e.message, relogin: !!e.relogin });
    return json({ ok: false, error: 'Kuch galat ho gaya: ' + (e && e.message ? e.message : e) });
  }
}

function viewActor(C) {
  return { name: 'Sab Orders', role: 'View', steps: C.steps.map((s) => s.key), isAdmin: true, isDirector: false };
}

/* ============================================================
 *  DATA: D1 ↔ memory
 * ============================================================ */

async function getMeta(env, k) { const r = await env.DB.prepare('SELECT v FROM meta WHERE k = ?').bind(k).first(); return r ? r.v : null; }
const metaStmt = (env, k, v) => env.DB.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').bind(k, String(v));
async function setMeta(env, k, v) { await metaStmt(env, k, v).run(); }
const newVer = () => Date.now() + '-' + Math.random().toString(36).slice(2, 8);

async function loadModel(env) {
  const ver = await getMeta(env, 'dataVer');
  if (!ver) return null;
  if (MEM && MEM.ver === ver) return MEM.M;
  const [cfgR, logR, ordR, plR] = await env.DB.batch([
    env.DB.prepare("SELECT v FROM kv WHERE k = 'config'"),
    env.DB.prepare("SELECT k, v FROM kv WHERE k LIKE 'log:%'"),
    env.DB.prepare('SELECT json FROM orders'),
    env.DB.prepare('SELECT json FROM plogs ORDER BY id')
  ]);
  const cfg = (cfgR.results || [])[0];
  if (!cfg) return null;
  const C = JSON.parse(cfg.v);
  const parts = (logR.results || []).sort((x, y) => Number(x.k.split(':')[1]) - Number(y.k.split(':')[1])).map((r) => r.v).join('');
  const log = parts ? JSON.parse(parts) : [];
  (plR.results || []).forEach((r) => log.push(JSON.parse(r.json)));
  const orders = (ordR.results || []).map((r) => JSON.parse(r.json)).sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
  const M = core.buildModel(C, orders, log);
  MEM = { ver, M };
  return M;
}

/** Save → order D1 mein + nayi log lines + job (Sheet ke liye) */
async function saveWrite(env, M, a, action, token, payload, out) {
  const o = out.order;
  const now = Date.now();
  const job = await env.DB.prepare('INSERT INTO jobs (created, actor, action, token, order_id, want_id, label, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
    .bind(now, a.name, action, token, o.orderId, out.isNew ? o.orderId : '', WRITE_LABEL[action] || action, 'wait').first();
  const jobId = job.id;
  const pl = JSON.stringify(Object.assign({}, payload, out.isNew ? { createdAt: o.createdAt } : {}));
  const stmts = [];
  for (let i = 0, n = 0; i < pl.length; i += PART, n++) stmts.push(env.DB.prepare('INSERT INTO job_parts (job_id, part, data) VALUES (?, ?, ?)').bind(jobId, n, pl.slice(i, i + PART)));
  stmts.push(env.DB.prepare('INSERT OR REPLACE INTO orders (id, json, h, pending_job) VALUES (?, ?, ?, ?)').bind(o.orderId, JSON.stringify(o), '', jobId));
  (out.logs || []).forEach((l) => stmts.push(env.DB.prepare('INSERT INTO plogs (job_id, json) VALUES (?, ?)').bind(jobId, JSON.stringify(l))));
  const ver = newVer();
  stmts.push(metaStmt(env, 'dataVer', ver));
  await env.DB.batch(stmts);
  // Memory bhi taaza (agla request turant naya data dekhe)
  if (out.isNew) { M.orders.push(o); M.byId.set(o.orderId, o); }
  (out.logs || []).forEach((l) => M.log.push(l));
  MEM = { ver, M };
}

/* ============================================================
 *  JOBS: D1 → Sheet (peeche se, line se)
 * ============================================================ */

async function processJobs(env) {
  const lock = await getMeta(env, 'jobLock');
  if (lock && Date.now() - Number(lock) < 90000) return;          // koi aur chala raha hai
  await setMeta(env, 'jobLock', Date.now());
  const t0 = Date.now();
  try {
    for (let n = 0; n < 20 && Date.now() - t0 < 25000; n++) {
      const job = await env.DB.prepare("SELECT * FROM jobs WHERE status IN ('wait','retry') ORDER BY id LIMIT 1").first();
      if (!job) break;
      const parts = await env.DB.prepare('SELECT data FROM job_parts WHERE job_id = ? ORDER BY part').bind(job.id).all();
      const payload = JSON.parse((parts.results || []).map((r) => r.data).join('') || '{}');
      const res = await forward(env, { mirrorKey: env.MIRROR_KEY, action: 'runJob', job: { action: job.action, token: job.token, payload, wantId: job.want_id } });

      if (!res || !res.ok || !res.res) {
        const tries = (job.tries || 0) + 1;
        await env.DB.prepare('UPDATE jobs SET status = ?, tries = ?, error = ? WHERE id = ?')
          .bind(tries >= 10 ? 'fail' : 'retry', tries, (res && res.error) || 'Google se jawab nahi', job.id).run();
        if (tries >= 10) await finishJob(env, job, false, (res && res.error) || 'Google Sheet tak nahi pahunch paaye', null);
        break;
      }
      const r = res.res;
      const ok = r.ok && !(r.data && r.data.needLateReason);
      const err = ok ? '' : (r.error || (r.data && r.data.message) || 'Sheet ne mana kiya');
      await finishJob(env, job, ok, err, res.state);
    }
  } finally {
    await setMeta(env, 'jobLock', 0);
  }
}

async function finishJob(env, job, ok, err, state) {
  const stmts = [
    env.DB.prepare('UPDATE jobs SET status = ?, error = ?, done_at = ? WHERE id = ?').bind(ok ? 'done' : 'fail', err || '', Date.now(), job.id),
    env.DB.prepare('DELETE FROM job_parts WHERE job_id = ?').bind(job.id),
    env.DB.prepare('DELETE FROM plogs WHERE job_id = ?').bind(job.id),
    env.DB.prepare('UPDATE orders SET pending_job = 0 WHERE pending_job = ?').bind(job.id),
    env.DB.prepare("DELETE FROM jobs WHERE status IN ('done','fail') AND done_at < ?").bind(Date.now() - 7 * 86400000)
  ];
  if (!ok) {
    stmts.push(env.DB.prepare('INSERT INTO alerts (actor, created, json) VALUES (?, ?, ?)')
      .bind(job.actor, Date.now(), JSON.stringify({ label: job.label, orderId: job.order_id, error: err, time: core.fmtDateTime(job.created) })));
  }
  stmts.push(metaStmt(env, 'dataVer', newVer()));
  await env.DB.batch(stmts);
  if (state) await applyState(env, state, ok ? null : job.order_id);
}

async function takeAlerts(env, actor) {
  const r = await env.DB.prepare('SELECT id, json FROM alerts WHERE actor = ? AND seen = 0 ORDER BY id').bind(actor).all();
  const rows = r.results || [];
  if (!rows.length) return [];
  await env.DB.prepare('UPDATE alerts SET seen = 1 WHERE actor = ? AND seen = 0').bind(actor).run();
  return rows.map((x) => JSON.parse(x.json));
}

/* ============================================================
 *  SHEET → D1
 * ============================================================ */

async function importFromSheet(env, force) {
  const known = force ? '' : (await getMeta(env, 'sheetVer')) || '';
  const res = await forward(env, { mirrorKey: env.MIRROR_KEY, action: 'exportIfChanged', knownVer: known });
  if (!res || !res.ok) { await setMeta(env, 'lastError', (res && res.error) || 'no response'); return; }
  await setMeta(env, 'checkedAt', Date.now());
  if (res.same) return;
  await applyState(env, res.state, null);
  await env.DB.batch([metaStmt(env, 'sheetVer', res.ver || ''), metaStmt(env, 'importedAt', Date.now()), metaStmt(env, 'lastError', '')]);
}

/** Sheet ka data D1 mein — sirf jo badla; jin orders ka save abhi Sheet tak nahi pahuncha unhe mat chhuo */
async function applyState(env, s, forceOrder) {
  if (!s || !s.orders) return;
  const stmts = [];
  let changed = false;

  const C = {
    staff: s.staff, office: s.office, holidays: s.holidays, when: s.when, steps: s.steps,
    lateReasons: s.lateReasons, roles: s.roles, photo: s.photo, photoFields: s.photoFields,
    title: s.title, secret: s.secret, tokenDays: s.tokenDays
  };
  const cfgJson = JSON.stringify(C);
  const cfgH = await sha(cfgJson);
  if (cfgH !== await getMeta(env, 'cfgHash')) { stmts.push(env.DB.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('config', ?)").bind(cfgJson), metaStmt(env, 'cfgHash', cfgH)); changed = true; }

  const logJson = JSON.stringify(s.log || []);
  const logH = await sha(logJson);
  if (logH !== await getMeta(env, 'logHash')) {
    stmts.push(env.DB.prepare("DELETE FROM kv WHERE k LIKE 'log:%'"));
    for (let i = 0, n = 0; i < logJson.length; i += PART, n++) stmts.push(env.DB.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').bind('log:' + n, logJson.slice(i, i + PART)));
    stmts.push(metaStmt(env, 'logHash', logH));
    changed = true;
  }

  const cur = await env.DB.prepare('SELECT id, h, pending_job FROM orders').all();
  const have = {};
  (cur.results || []).forEach((r) => { have[r.id] = r; });
  const seen = {};
  for (const o of s.orders) {
    seen[o.orderId] = true;
    const row = have[o.orderId];
    if (row && row.pending_job && o.orderId !== forceOrder) continue;     // app ka save abhi raste mein
    const j = JSON.stringify(o);
    const h = await sha(j);
    if (row && row.h === h && !row.pending_job) continue;
    stmts.push(env.DB.prepare('INSERT OR REPLACE INTO orders (id, json, h, pending_job) VALUES (?, ?, ?, 0)').bind(o.orderId, j, h));
    changed = true;
  }
  Object.keys(have).forEach((id) => {
    if (!seen[id] && (!have[id].pending_job || id === forceOrder)) { stmts.push(env.DB.prepare('DELETE FROM orders WHERE id = ?').bind(id)); changed = true; }
  });

  if (changed) stmts.push(metaStmt(env, 'dataVer', newVer()));
  for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
}

/* ============================================================
 *  VIDEO: seedha Drive tak (stream)
 * ============================================================ */

async function videoChunk(request, env, url) {
  const id = url.searchParams.get('u') || '';
  const token = request.headers.get('X-O2D-Token') || '';
  const row = await env.DB.prepare('SELECT url, size, mime, th FROM uploads WHERE id = ?').bind(id).first();
  if (!row || row.th !== await sha(token)) return json({ ok: false, error: 'Video upload ka samay khatam ho gaya. Video hata ke dobara daalo.' });
  const total = Number(row.size);
  let resp;
  try {
    if (url.searchParams.get('status')) {
      resp = await fetch(row.url, { method: 'PUT', headers: { 'Content-Range': 'bytes */' + total, 'Content-Length': '0' } });
    } else {
      const offset = Number(url.searchParams.get('offset')) || 0;
      const len = Number(request.headers.get('Content-Length')) || 0;
      if (!len || !request.body) return json({ ok: false, error: 'Video ka tukda khaali aaya. Dobara try karo.' });
      const end = offset + len - 1;
      if (end >= total) return json({ ok: false, error: 'Video ka size match nahi hua. Video hata ke dobara daalo.' });
      const { readable, writable } = new FixedLengthStream(len);
      const pipe = request.body.pipeTo(writable);
      resp = await fetch(row.url, { method: 'PUT', headers: { 'Content-Range': 'bytes ' + offset + '-' + end + '/' + total, 'Content-Type': row.mime || 'video/mp4' }, body: readable });
      await pipe.catch(() => {});
    }
  } catch (e) {
    return json({ ok: false, error: 'Video Drive tak nahi pahunchi. Net check karo, dobara try ho raha hai.' });
  }
  if (resp.status === 308) {
    const m = String(resp.headers.get('Range') || '').match(/-(\d+)$/);
    return json({ ok: true, data: { done: false, next: m ? Number(m[1]) + 1 : 0 } });
  }
  if (resp.status === 200 || resp.status === 201) {
    let file = {};
    try { file = await resp.json(); } catch (e) {}
    await env.DB.prepare('DELETE FROM uploads WHERE id = ?').bind(id).run();
    if (!file.id) return json({ ok: false, error: 'Video Drive mein gayi par link nahi mila. Dobara try karo.' });
    return json({ ok: true, data: { done: true, fileId: file.id, url: 'https://drive.google.com/file/d/' + file.id + '/view#video' } });
  }
  return json({ ok: false, error: 'Video ka tukda Drive tak nahi gaya (' + resp.status + '). Dobara try karo.' });
}

/* ============================================================
 *  CHHOTE KAAM
 * ============================================================ */

async function forward(env, body) {
  try {
    const r = await fetch(env.APPS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' });
    const txt = await r.text();
    try { return JSON.parse(txt); }
    catch (e) { return { ok: false, error: 'Google Sheet ka jawab samajh nahi aaya. Thodi der baad try karo.' }; }
  } catch (e) {
    return { ok: false, error: 'Google Sheet se jud nahi paaye. Thodi der baad try karo.' };
  }
}

async function status(env) {
  const g = async (k) => getMeta(env, k);
  const pend = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('wait','retry')").first();
  const failed = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'fail'").first();
  const cnt = await env.DB.prepare('SELECT COUNT(*) AS n FROM orders').first();
  const t = async (k) => { const v = await g(k); return v && Number(v) ? new Date(Number(v)).toISOString() : null; };
  return {
    orders: cnt ? cnt.n : 0, sheetMeinJaneBaaki: pend ? pend.n : 0, failJobs: failed ? failed.n : 0,
    sheetSeLiya: await t('importedAt'), lastCheck: await t('checkedAt'), error: (await g('lastError')) || ''
  };
}

async function sha(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function json(obj, st) {
  return new Response(JSON.stringify(obj), { status: st || 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
