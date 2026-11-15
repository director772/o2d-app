/**
 * ============================================================
 *  push.js  —  Phone pe ghanti (Web Push notification)
 * ============================================================
 *  - Kaam yellow (deadline ke 80% paar) → har 1 minute ghanti
 *  - Kaam laal (late)                   → har 20 second ghanti
 *  - Sirf office time mein (Config ka khulna / band hona, chhutti ke din nahi)
 *  - Ghanti us staff ko jiske paas woh kaam hai (Staff tab ke tick);
 *    kisi staff ke paas nahi → Director / PC ko
 *
 *  Koi bahar ki service nahi: Worker khud apni chabi (VAPID) banata hai,
 *  D1 ke kv mein rakhta hai, aur seedha Google / Mozilla / Apple ke push
 *  server ko bhejta hai (RFC 8291 aes128gcm + RFC 8292 VAPID).
 * ============================================================
 */

const enc = new TextEncoder();

export function b64u(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64u(s) {
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(...parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  parts.forEach((p) => { out.set(p, o); o += p.length; });
  return out;
}
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/* ---------------- Chabi (VAPID) ---------------- */

let VAPID = null;   // isolate cache

export async function vapidKeys(env) {
  if (VAPID) return VAPID;
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'vapid'").first();
  if (row && row.v) { VAPID = JSON.parse(row.v); return VAPID; }
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const fresh = { jwk, pub: b64u(pub) };
  // Do isolate ek saath banaye toh pehla wala hi rahe
  await env.DB.prepare("INSERT OR IGNORE INTO kv (k, v) VALUES ('vapid', ?)").bind(JSON.stringify(fresh)).run();
  const again = await env.DB.prepare("SELECT v FROM kv WHERE k = 'vapid'").first();
  VAPID = JSON.parse(again.v);
  return VAPID;
}

async function vapidAuth(keys, endpoint, subject) {
  const aud = new URL(endpoint).origin;
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', keys.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + body)));
  return 'vapid t=' + head + '.' + body + '.' + b64u(sig) + ', k=' + keys.pub;
}

/* ---------------- Message band dabba (aes128gcm) ---------------- */

export async function encryptPayload(sub, text) {
  const uaPub = unb64u(sub.keys.p256dh);
  const auth = unb64u(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const prkKey = await hmac(auth, shared);
  const ikm = (await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPub, asPub, new Uint8Array([1])))).slice(0, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);

  const key = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const plain = concat(enc.encode(text), new Uint8Array([2]));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plain));

  const rs = new Uint8Array([0, 0, 16, 0]);   // 4096
  return concat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

/** Ek phone ko ghanti. Wapas: HTTP status (201 = gayi, 404/410 = phone ne band kar di) */
export async function sendPush(env, sub, data, subject) {
  const keys = await vapidKeys(env);
  const body = await encryptPayload(sub, JSON.stringify(data));
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuth(keys, sub.endpoint, subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '60',
      Urgency: 'high',
      Topic: 'o2d-ghanti'
    },
    body
  });
  return r.status;
}
