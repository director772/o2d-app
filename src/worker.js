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
let lastKickCheck = 0;
async function ensureTables(env) {
  if (tablesReady) return;
  await env.DB.batch([
    env.DB.prepare('DROP TABLE IF EXISTS cache'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS screens (k TEXT PRIMARY KEY, v TEXT, h TEXT)'),
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
    if (url.pathname === '/api/refresh') {
      // Copy turant taaza (30 sec mein ek hi baar)
      const m = await getMetaAll(env);
      if (m.builtAt && Date.now() - Number(m.builtAt) < 30000) return json(await status(env));
      await refreshMirror(env, 'manual');
      return json(await status(env));
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    await ensureTables(env);
    await refreshMirror(env, 'cron');
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

  // Peeche-peeche: copy purani ho (cron ruka ho) toh taaza karwa do — 2 minute mein ek baar hi dekhta hai
  if (Date.now() - lastKickCheck > 120000) { lastKickCheck = Date.now(); ctx.waitUntil(kickIfStale(env).catch(() => {})); }

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
  // Suffix = "|action|payload" — naam token se database khud jodta hai (EK hi chakkar)
  const isPublic = PUBLIC_READS.has(action);
  let suffixes;
  if (action === 'details') {
    const ids = (payload.orderIds || []).slice(0, 15);
    if (!ids.length) return {};
    suffixes = ids.map((id) => cacheKey('', 'orderDetail', { orderId: id }));
  } else {
    suffixes = [cacheKey('', action, payload)];
  }

  let h = '';
  if (!isPublic) {
    if (!tokenAlive(token)) return null;
    h = await sha(token);
  }

  const ph = suffixes.map(() => '(?)').join(',');
  const [metaR, tokR, rowsR] = await env.DB.batch([
    env.DB.prepare('SELECT k, v FROM meta'),
    env.DB.prepare('SELECT name, staff FROM tokens WHERE h = ?').bind(h),
    env.DB.prepare(
      `SELECT c.k, c.v FROM screens c WHERE c.k IN (
         SELECT t.name || s.column1 FROM tokens t, (VALUES ${ph}) s WHERE t.h = ?
         UNION ALL SELECT '*' || s2.column1 FROM (VALUES ${ph}) s2)`
    ).bind(...suffixes, h, ...suffixes)
  ]);

  const meta = {};
  for (const r of metaR.results || []) meta[r.k] = r.v;
  if (!meta.ver) return null;
  if (meta.dirty && Number(meta.dirty) > Number(meta.builtFrom || 0) && Date.now() - Number(meta.dirty) < DIRTY_MS) return null;

  let who = '*';
  if (!isPublic) {
    const t = (tokR.results || [])[0];
    if (!t || t.staff !== meta.staff) return null;   // staff mein badlav → Sheet se dobara pakka karo
    who = t.name;
  }

  const rows = {};
  for (const r of rowsR.results || []) rows[r.k] = r.v;
  const pick = (suf) => rows[who + suf] || rows['*' + suf] || null;

  if (action === 'details') {
    const ids = (payload.orderIds || []).slice(0, 15);
    const out = {};
    for (let i = 0; i < ids.length; i++) {
      const v = pick(suffixes[i]);
      if (!v) return null;                        // koi bhi kam ho → Sheet se poora
      out[ids[i]] = JSON.parse(v);
    }
    return out;
  }
  const v = pick(suffixes[0]);
  return v ? JSON.parse(v) : null;
}

function tokenAlive(token) {
  if (!token) return false;
  try {
    const p = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    const txt = new TextDecoder().decode(Uint8Array.from(atob(p), (c) => c.charCodeAt(0)));
    return Number(txt.split('|')[2]) > Date.now();
  } catch (e) { return false; }
}

/* ---------------- Token → naam ---------------- */

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
  const h = await sha(t);
  const old = await env.DB.prepare('SELECT name, staff FROM tokens WHERE h = ?').bind(h).first();
  if (old && old.name === name && old.staff === meta.staff) return;   // pehle se hai → likhne ki zaroorat nahi
  await env.DB.prepare('INSERT OR REPLACE INTO tokens (h, name, staff, at) VALUES (?, ?, ?, ?)')
    .bind(h, name, meta.staff, Date.now()).run();
}

/* ---------------- Copy banana ---------------- */

async function refreshMirror(env, why) {
  try { await refreshMirrorInner(env, why); }
  catch (e) { await setMeta(env, 'lastError', why + ': ' + String(e && e.stack || e).slice(0, 500)).catch(() => {}); }
}

async function refreshMirrorInner(env, why) {
  const started = Date.now();
  const meta = await getMetaAll(env);
  const force = why === 'write' || why === 'manual' || !meta.ver;
  const res = await forward(env, {
    mirrorKey: env.MIRROR_KEY,
    action: force ? 'mirrorBuild' : 'mirrorCheck',
    knownVer: meta.ver || ''
  });
  if (!res || !res.ok) { await setMeta(env, 'lastError', (res && res.error) || 'no response'); return; }
  if (res.same) {
    // Kuch nahi badla → kuch mat likho (sirf 5 minute mein ek baar "dekha" note)
    if (!meta.checkedAt || Date.now() - Number(meta.checkedAt) > 300000) await setMeta(env, 'checkedAt', String(Date.now()));
    return;
  }

  // Purana build naye ke upar na chadhe
  const now = await getMetaAll(env);
  if (Number(now.builtFrom || 0) > started) return;

  const ver = res.ver.full;

  // Sirf jo screen badli hai wahi likho (CRM jaisa) — baaki ko chhuo bhi mat
  const have = {};
  const cur = await env.DB.prepare('SELECT k, h FROM screens').all();
  for (const r of cur.results || []) have[r.k] = r.h;

  const stmts = [];
  const seen = {};
  for (const e of res.mirror || []) {
    const k = cacheKey(e.who, e.action, e.payload);
    const v = JSON.stringify(e.data);
    // "at" (kab bana) har baar badalta hai — use chhod ke dekho asli data badla ya nahi
    const h = await sha(JSON.stringify(e.data, (key, val) => (key === 'at' ? undefined : val)));
    seen[k] = true;
    if (have[k] === h) continue;
    stmts.push(env.DB.prepare('INSERT OR REPLACE INTO screens (k, v, h) VALUES (?, ?, ?)').bind(k, v, h));
  }
  for (const k of Object.keys(have)) {
    if (!seen[k]) stmts.push(env.DB.prepare('DELETE FROM screens WHERE k = ?').bind(k));
  }
  const changed = stmts.length;

  stmts.push(
    metaStmt(env, 'ver', ver),
    metaStmt(env, 'builtFrom', String(started)),
    metaStmt(env, 'builtAt', String(Date.now())),
    metaStmt(env, 'info', JSON.stringify({ ms: Date.now() - started, screens: Object.keys(seen).length, changed: changed }))
  );
  if (now.staff !== res.ver.staff) stmts.push(metaStmt(env, 'staff', res.ver.staff));
  if (now.lastError) stmts.push(metaStmt(env, 'lastError', ''));
  for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
}

async function kickIfStale(env) {
  const m = await getMetaAll(env);
  const last = Math.max(Number(m.builtAt || 0), Number(m.checkedAt || 0));
  if (Date.now() - last < 8 * 60000) return;
  if (m.kickAt && Date.now() - Number(m.kickAt) < 60000) return;
  await setMeta(env, 'kickAt', String(Date.now()));
  await refreshMirror(env, 'stale');
}

async function status(env) {
  const m = await getMetaAll(env);
  let info = {};
  try { info = JSON.parse(m.info || '{}'); } catch (e) {}
  return {
    copyBani: m.builtAt ? new Date(Number(m.builtAt)).toISOString() : null,
    banneMeLaga: info.ms ? info.ms + ' ms' : null,
    screens: info.screens || 0,
    pichliBaarBadli: info.changed,
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
