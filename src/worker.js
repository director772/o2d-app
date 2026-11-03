/**
 * O2D — Cloudflare Worker
 * ------------------------------------------------------------
 * - App ka page (public/) Cloudflare se — duniya ke paas wale server se.
 * - /api: screens ka data Cloudflare ki copy (D1) se turant.
 *   Asli data Google Sheet + Drive mein hi rehta hai (Apps Script).
 *   Save / login / photo / video → seedha Apps Script, phir copy taaza.
 * - Har minute (cron): Sheet mein kuch badla? → copy taaza.
 */

// Ye screens copy se khulti hain
const READS = new Set(['boot', 'me', 'home', 'stepList', 'orders', 'orderDetail', 'details', 'dashboard', 'loginInfo', 'loginNames']);
// Ye kaam data badalte hain → copy dobara banao
const WRITES = new Set(['createOrder', 'addOrderPhotos', 'submitStep', 'billIssue', 'cancelOrder', 'saveStaff', 'setPin', 'newLink', 'changePin']);
const PUBLIC_READS = new Set(['loginInfo', 'loginNames']);
const DIRTY_MS = 120000;     // save ke baad itni der tak (ya copy banne tak) seedha Sheet se

let tablesReady = false;
async function ensureTables(env) {
  if (tablesReady) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, v TEXT, ver TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS tokens (h TEXT PRIMARY KEY, name TEXT, staff TEXT, at INTEGER)')
  ]);
  tablesReady = true;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api')) await ensureTables(env);
    if (url.pathname === '/api') {
      if (request.method !== 'POST') return json({ ok: false, error: 'POST chahiye' }, 405);
      return handleApi(request, env, ctx);
    }
    if (url.pathname === '/api/status') return json(await status(env));
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    await ensureTables(env);
    ctx.waitUntil(refreshMirror(env, 'cron'));
  }
};

/* ---------------- API ---------------- */

async function handleApi(request, env, ctx) {
  let body;
  try { body = JSON.parse(await request.text()); } catch (e) { return json({ ok: false, error: 'Request samajh nahi aaya.' }); }
  const action = String(body.action || '');
  const token = String(body.token || '');
  const payload = body.payload || {};
  if (action === 'loginInfo' && payload.code) payload.code = String(payload.code).trim().toUpperCase();

  if (READS.has(action)) {
    try {
      const hit = await fromMirror(env, action, token, payload);
      if (hit) return json({ ok: true, data: hit, src: 'cf' });
    } catch (e) { /* copy mein dikkat → Sheet se */ }
  }

  // Apps Script (asli data) se
  const started = Date.now();
  if (WRITES.has(action)) await setMeta(env, 'dirty', String(started));
  const res = await forward(env, body);

  ctx.waitUntil((async () => {
    await learnToken(env, action, token, res);
    if (WRITES.has(action) && res && res.ok) await refreshMirror(env, 'write');
    else if (READS.has(action) && res && res.ok && res.who) await storeLazy(env, res.who, action, payload, res.data);
  })().catch(() => {}));

  if (res && typeof res === 'object') delete res.who;
  return json(res);
}

async function forward(env, body) {
  try {
    const r = await fetch(env.APPS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow'
    });
    const txt = await r.text();
    try { return JSON.parse(txt); }
    catch (e) { return { ok: false, error: 'Google Sheet ka jawab samajh nahi aaya. Thodi der baad try karo.' }; }
  } catch (e) {
    return { ok: false, error: 'Google Sheet se jud nahi paaye. Thodi der baad try karo.' };
  }
}

/** Copy mein se data — sirf jab copy taaza ho aur token jaana-pehchana ho */
async function fromMirror(env, action, token, payload) {
  const meta = await getMetaAll(env);
  if (!meta.ver) return null;
  if (meta.dirty && Number(meta.dirty) > Number(meta.builtFrom || 0) && Date.now() - Number(meta.dirty) < DIRTY_MS) return null;

  let who = '*';
  if (!PUBLIC_READS.has(action)) {
    who = await tokenName(env, token, meta.staff);
    if (!who) return null;
  }

  if (action === 'details') {
    const ids = (payload.orderIds || []).slice(0, 15);
    if (!ids.length) return {};
    const keys = ids.map((id) => cacheKey(who, 'orderDetail', { orderId: id }));
    const rows = await getRows(env, keys, meta.ver);
    const out = {};
    for (let i = 0; i < ids.length; i++) {
      if (!rows[keys[i]]) return null;           // koi bhi kam ho → Sheet se poora
      out[ids[i]] = rows[keys[i]];
    }
    return out;
  }

  const k1 = cacheKey(who, action, payload);
  const k2 = cacheKey('*', action, payload);
  const rows = await getRows(env, who === '*' ? [k2] : [k1, k2], meta.ver);
  return rows[k1] || rows[k2] || null;
}

async function getRows(env, keys, ver) {
  const ph = keys.map(() => '?').join(',');
  const r = await env.DB.prepare(`SELECT k, v FROM cache WHERE ver = ? AND k IN (${ph})`).bind(ver, ...keys).all();
  const out = {};
  for (const row of r.results || []) out[row.k] = JSON.parse(row.v);
  return out;
}

async function storeLazy(env, who, action, payload, data) {
  if (action === 'details' || PUBLIC_READS.has(action)) return;
  const meta = await getMetaAll(env);
  if (!meta.ver) return;
  await env.DB.prepare('INSERT OR REPLACE INTO cache (k, v, ver) VALUES (?, ?, ?)')
    .bind(cacheKey(who, action, payload), JSON.stringify(data), meta.ver).run();
}

/* ---------------- Token → naam ---------------- */

async function tokenName(env, token, staffVer) {
  if (!token) return null;
  // Token ki expiry khud check (naam|code|exp . sign)
  try {
    const p = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    const txt = new TextDecoder().decode(Uint8Array.from(atob(p), (c) => c.charCodeAt(0)));
    const exp = Number(txt.split('|')[2]);
    if (!(exp > Date.now())) return null;
  } catch (e) { return null; }
  const row = await env.DB.prepare('SELECT name, staff FROM tokens WHERE h = ?').bind(await sha(token)).first();
  if (!row || row.staff !== staffVer) return null;   // staff mein badlav → Sheet se dobara pakka karo
  return row.name;
}

async function learnToken(env, action, token, res) {
  if (!res) return;
  const meta = await getMetaAll(env);
  if (res.relogin && token) {
    await env.DB.prepare('DELETE FROM tokens WHERE h = ?').bind(await sha(token)).run();
    return;
  }
  if (!res.ok || !meta.staff) return;
  let t = token, name = res.who;
  if ((action === 'login' || action === 'loginLink') && res.data && res.data.token) {
    t = res.data.token;
    name = (res.data.boot && res.data.boot.me && res.data.boot.me.name) || (res.data.staff && res.data.staff.name) || '';
  }
  if (!t || !name) return;
  await env.DB.prepare('INSERT OR REPLACE INTO tokens (h, name, staff, at) VALUES (?, ?, ?, ?)')
    .bind(await sha(t), name, meta.staff, Date.now()).run();
}

/* ---------------- Copy banana ---------------- */

async function refreshMirror(env, why) {
  const started = Date.now();
  const meta = await getMetaAll(env);
  const force = why === 'write' || !meta.ver;
  const res = await forward(env, {
    mirrorKey: env.MIRROR_KEY,
    action: force ? 'mirrorBuild' : 'mirrorCheck',
    knownVer: meta.ver || ''
  });
  if (!res || !res.ok) { await setMeta(env, 'lastError', (res && res.error) || 'no response'); return; }
  if (res.same) { await setMeta(env, 'checkedAt', String(Date.now())); return; }

  // Purana build naye ke upar na chadhe
  const now = await getMetaAll(env);
  if (Number(now.builtFrom || 0) > started) return;

  const ver = res.ver.full;
  const stmts = [];
  for (const e of res.mirror || []) {
    stmts.push(env.DB.prepare('INSERT OR REPLACE INTO cache (k, v, ver) VALUES (?, ?, ?)')
      .bind(cacheKey(e.who, e.action, e.payload), JSON.stringify(e.data), ver));
  }
  for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));

  await env.DB.batch([
    metaStmt(env, 'ver', ver),
    metaStmt(env, 'staff', res.ver.staff),
    metaStmt(env, 'builtFrom', String(started)),
    metaStmt(env, 'builtAt', String(Date.now())),
    metaStmt(env, 'buildMs', String(Date.now() - started)),
    metaStmt(env, 'screens', String(stmts.length)),
    metaStmt(env, 'lastError', ''),
    env.DB.prepare('DELETE FROM cache WHERE ver != ?').bind(ver)
  ]);
}

async function status(env) {
  const m = await getMetaAll(env);
  return {
    copyBani: m.builtAt ? new Date(Number(m.builtAt)).toISOString() : null,
    banneMeLaga: m.buildMs ? m.buildMs + ' ms' : null,
    screens: m.screens || 0,
    lastCheck: m.checkedAt ? new Date(Number(m.checkedAt)).toISOString() : null,
    error: m.lastError || ''
  };
}

/* ---------------- Chhote helpers ---------------- */

function cacheKey(who, action, payload) {
  const p = {};
  Object.keys(payload || {}).sort().forEach((k) => {
    const v = payload[k];
    if (k === 'appUrl' || v === '' || v === null || v === undefined) return;
    p[k] = v;
  });
  return who + '|' + action + '|' + JSON.stringify(p);
}

async function getMetaAll(env) {
  const r = await env.DB.prepare('SELECT k, v FROM meta').all();
  const m = {};
  for (const row of r.results || []) m[row.k] = row.v;
  return m;
}

function metaStmt(env, k, v) {
  return env.DB.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').bind(k, v);
}

async function setMeta(env, k, v) { await metaStmt(env, k, v).run(); }

async function sha(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
