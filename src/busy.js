/**
 * ============================================================
 *  busy.js  —  Busy ka bill → O2D "Bill Banao" apne aap
 * ============================================================
 *  busy-live-db (BUSY binding) sirf PADHTE hain — kabhi likhte nahi.
 *
 *  Har minute (cron):
 *   1. busy_changes mein naya kya aaya (sirf pichhli baar ke baad wala) → naye Sale bill
 *   2. Hamari D1 ki "busy_bills" mein bill number, party, time, amount
 *   3. Party ke naam se pakka ek hi order mile (Bill Banao pe ruka ho) → bill apne aap lag jaata hai
 *      CASH MAIN / shak ho → staff Bill Banao mein bill number se jodta hai (list se ek tap)
 *
 *  Busy ke codes: Tran1 = bill ka sar (VchType 9 = Sale), Tran2 = bill ki lines
 *  (RecType 2 = item), Master1 = party / item ke naam.
 * ============================================================
 */

const SALE = 9;
const CASH_CODES = [1];                      // CASH MAIN
const BACKFILL_DAYS = 10;

export async function ensureBusyTables(env) {
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS busy_bills (vch INTEGER PRIMARY KEY, fy INTEGER, no TEXT, nkey TEXT, party_code INTEGER, party TEXT, at INTEGER, total REAL, deleted INTEGER DEFAULT 0, order_id TEXT, seen INTEGER)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS busy_bills_nkey ON busy_bills (nkey)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS busy_bills_at ON busy_bills (at)')
  ]);
}

/** "L-26-27/2388" → "L262 72388" jaisa milaan ka key (space, -, / sab hata ke, bade akshar) */
export function nkey(no) { return String(no || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

/** Busy ki tareekh + CreationTime (sirf ghadi) → IST ms */
function billTime(t1) {
  const d = String(t1.Date || '').slice(0, 10);
  const tm = String(t1.CreationTime || '').match(/(\d{2}):(\d{2}):(\d{2})/);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return Date.now();
  const hh = tm ? tm[1] : '12', mm = tm ? tm[2] : '00', ss = tm ? tm[3] : '00';
  return Date.parse(d + 'T' + hh + ':' + mm + ':' + ss + '+05:30');
}

async function partyNames(env, fy, codes) {
  const out = {};
  const uniq = [...new Set(codes.filter((c) => c !== null && c !== undefined).map(String))];
  for (let i = 0; i < uniq.length; i += 80) {
    const part = uniq.slice(i, i + 80);
    const r = await env.BUSY.prepare("SELECT grp, data FROM busy_rows WHERE fy = ? AND tbl = 'Master1' AND grp IN (" + part.map(() => '?').join(',') + ')')
      .bind(fy, ...part).all();
    (r.results || []).forEach((x) => { try { out[x.grp] = JSON.parse(x.data).Name || ''; } catch (e) {} });
  }
  return out;
}

async function saveBills(env, fy, rows) {
  const sales = [];
  rows.forEach((x) => {
    let t; try { t = JSON.parse(x.data); } catch (e) { return; }
    if (Number(t.VchType) !== SALE || !t.VchNo) return;
    sales.push(t);
  });
  if (!sales.length) return [];
  const names = await partyNames(env, fy, sales.map((t) => t.MasterCode1));
  const now = Date.now();
  const bills = sales.map((t) => ({
    vch: Number(t.VchCode), fy, no: String(t.VchNo).trim(), nkey: nkey(t.VchNo),
    party_code: Number(t.MasterCode1) || 0, party: names[String(t.MasterCode1)] || '',
    at: billTime(t), total: Number(t.VchAmtBaseCur) || 0
  }));
  const stmts = bills.map((b) => env.DB.prepare(
    'INSERT INTO busy_bills (vch, fy, no, nkey, party_code, party, at, total, deleted, seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?) ' +
    'ON CONFLICT(vch) DO UPDATE SET fy = excluded.fy, no = excluded.no, nkey = excluded.nkey, party_code = excluded.party_code, party = excluded.party, at = excluded.at, total = excluded.total, deleted = 0'
  ).bind(b.vch, b.fy, b.no, b.nkey, b.party_code, b.party, b.at, b.total, now));
  for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
  return bills;
}

/**
 * Busy se naye / badle bill laao. Wapas: jo bill naye aaye ya badle (auto-jodne ke liye)
 * Pehli baar: pichhle 10 din ke sale bill (ek hi baar), aage sirf badlav.
 */
export async function syncBusy(env, getMeta, setMeta) {
  if (!env.BUSY) return [];
  const last = await getMeta(env, 'busySeq');
  if (last === null || last === undefined || last === '') {
    const mx = await env.BUSY.prepare('SELECT max(seq) s FROM busy_changes').first();
    const since = new Date(Date.now() + 330 * 60000 - BACKFILL_DAYS * 86400000).toISOString().slice(0, 10);
    const r = await env.BUSY.prepare("SELECT fy, grp, data FROM busy_rows WHERE tbl = 'Tran1' AND json_extract(data, '$.VchType') = ? AND json_extract(data, '$.Date') >= ?")
      .bind(SALE, since).all();
    const byFy = {};
    (r.results || []).forEach((x) => { (byFy[x.fy] = byFy[x.fy] || []).push(x); });
    let all = [];
    for (const fy of Object.keys(byFy)) all = all.concat(await saveBills(env, Number(fy), byFy[fy]));
    await setMeta(env, 'busySeq', (mx && mx.s) || 0);
    return all;
  }
  // Ek hi query: pichhli baar ke baad ke saare badlav (seq PK hai — sirf naye rows padhe jaate hain)
  const ch = await env.BUSY.prepare('SELECT seq, fy, tbl, grp FROM busy_changes WHERE seq > ? ORDER BY seq LIMIT 3000').bind(Number(last)).all();
  const allCh = ch.results || [];
  if (!allCh.length) return [];
  const list = allCh.filter((x) => x.tbl === 'Tran1');
  if (!list.length) { await setMeta(env, 'busySeq', allCh[allCh.length - 1].seq); return []; }
  const maxSeq = allCh[allCh.length - 1].seq;
  const byFy = {};
  list.forEach((x) => { (byFy[x.fy] = byFy[x.fy] || new Set()).add(String(x.grp)); });
  let all = [];
  for (const fy of Object.keys(byFy)) {
    const grps = [...byFy[fy]];
    for (let i = 0; i < grps.length; i += 80) {
      const part = grps.slice(i, i + 80);
      const r = await env.BUSY.prepare("SELECT grp, data FROM busy_rows WHERE fy = ? AND tbl = 'Tran1' AND grp IN (" + part.map(() => '?').join(',') + ')')
        .bind(Number(fy), ...part).all();
      const found = new Set((r.results || []).map((x) => String(x.grp)));
      all = all.concat(await saveBills(env, Number(fy), r.results || []));
      // Busy mein bill delete hua → yahan bhi "deleted"
      const gone = part.filter((g) => !found.has(g));
      if (gone.length) await env.DB.batch(gone.map((g) => env.DB.prepare('UPDATE busy_bills SET deleted = 1 WHERE vch = ?').bind(Number(g))));
    }
  }
  await setMeta(env, 'busySeq', maxSeq);
  return all;
}

/** Bill number se Busy ka bill (hamari D1 se — Busy DB nahi padhna padta) */
export async function findBill(env, billNo) {
  const k = nkey(billNo);
  if (!k) return null;
  return env.DB.prepare('SELECT * FROM busy_bills WHERE nkey = ? AND deleted = 0 ORDER BY at DESC LIMIT 1').bind(k).first();
}

/** Bill ki lines (item, qty, rate) — PDF ke liye. Sirf bill jodte waqt ek baar. */
export async function billItems(env, fy, vch) {
  if (!env.BUSY) return [];
  const r = await env.BUSY.prepare("SELECT rn, data FROM busy_rows WHERE fy = ? AND tbl = 'Tran2' AND grp = ? ORDER BY rn").bind(fy, String(vch)).all();
  const lines = [];
  (r.results || []).forEach((x) => {
    let t; try { t = JSON.parse(x.data); } catch (e) { return; }
    if (Number(t.RecType) !== 2) return;
    const qty = Math.abs(Number(t.Value1) || Number(t.D1) || 0);
    const rate = Math.abs(Number(t.D3) || Number(t.D2) || 0);
    lines.push({ code: t.MasterCode1, qty, rate, amount: Math.round(qty * rate * 100) / 100 });
  });
  const names = await partyNames(env, fy, lines.map((l) => l.code));
  return lines.map((l) => ({ name: names[String(l.code)] || ('Item ' + l.code), qty: l.qty, rate: l.rate, amount: l.amount }));
}

/** Bill Banao form ki list: pichhle 3 din ke Busy bill jo abhi kisi order pe nahi lage */
export async function recentFreeBills(env, usedKeys) {
  const r = await env.DB.prepare('SELECT no, nkey, party, party_code, at, total FROM busy_bills WHERE deleted = 0 AND at >= ? ORDER BY at DESC LIMIT 60')
    .bind(Date.now() - 3 * 86400000).all();
  return (r.results || []).filter((b) => !usedKeys.has(b.nkey)).slice(0, 25)
    .map((b) => ({ no: b.no, party: b.party, cash: CASH_CODES.indexOf(Number(b.party_code)) >= 0, at: b.at, total: b.total }));
}

export function isCash(b) { return CASH_CODES.indexOf(Number(b.party_code)) >= 0 || /^cash\b/i.test(String(b.party || '')); }
