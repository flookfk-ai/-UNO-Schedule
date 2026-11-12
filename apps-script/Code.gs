/**
 * UNO! Coffee — ตารางกะพนักงาน : เซิร์ฟเวอร์ (Google Apps Script)
 * หน้าเว็บอยู่บน GitHub Pages ส่วนไฟล์นี้เก็บข้อมูลในชีต "_db" ของ Google Sheet และตรวจรหัสพนักงาน + PIN
 *
 * ก่อน Deploy: ตั้ง OWNER_EMP และ OWNER_PIN ด้านล่าง (บัญชี Super admin หลัก ใช้เข้าครั้งแรก)
 */
const OWNER_EMP = '100014';   // รหัสพนักงานของผู้ดูแลหลัก
const OWNER_PIN = '100014';         // ตั้ง PIN ตัวเลข 4–8 หลัก เช่น '258014' (ห้ามปล่อยว่าง)

const DBS = '_db';            // ชื่อชีตที่เก็บข้อมูล (อย่าแก้ข้อมูลในชีตนี้ด้วยมือ)
const CHUNK = 40000;          // ตัวอักษรต่อช่อง (Google Sheets รับได้ 50,000)
const SESSION_DAYS = 30;      // จำการเข้าสู่ระบบกี่วัน
const MAX_FAIL = 5, LOCK_MIN = 15;

// ---------- จุดรับคำขอจากหน้าเว็บ (GitHub Pages) ----------
function doPost(e) {
  const body = e && e.postData ? e.postData.contents : '';
  return ContentService.createTextOutput(api(body)).setMimeType(ContentService.MimeType.JSON);
}
function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, app: 'UNO ตารางกะ API' })).setMimeType(ContentService.MimeType.JSON);
}

// ---------- จุดเรียกเดียวจากหน้าเว็บ ----------
function api(raw) {
  let req;
  try { req = JSON.parse(raw); } catch (e) { return JSON.stringify({ error: 'คำขอไม่ถูกต้อง' }); }
  try { return JSON.stringify(handle(req)); }
  catch (e) { return JSON.stringify({ error: String((e && e.message) || e), auth: !!(e && e.auth) }); }
}
function authErr(m) { const e = new Error(m); e.auth = true; return e; }

function handle(req) {
  const a = req.args || {};
  if (req.op === 'login') return login(String(a.emp || '').trim(), String(a.pin || '').trim());
  const s = session(req.token);
  switch (req.op) {
    case 'load': return { me: s, ver: getVer(), docs: allDocs(0), url: appUrl() };
    case 'poll': { const since = +a.since || 0, v = getVer(); return v <= since ? { ver: v, me: s } : { ver: v, me: s, docs: allDocs(since) }; }
    case 'set': return setDoc(s, String(a.path || ''), a.data);
    case 'import': return importDocs(s, a.docs || {});
    case 'logout': props().deleteProperty('tok_' + req.token); return { ok: true, url: appUrl() };
  }
  throw new Error('ไม่รู้จักคำสั่ง');
}
function appUrl() { try { return ScriptApp.getService().getUrl(); } catch (e) { return ''; } }
function props() { return PropertiesService.getScriptProperties(); }

// ---------- เข้าสู่ระบบ ----------
function login(emp, pin) {
  if (!OWNER_PIN) throw new Error('ผู้ดูแลยังไม่ได้ตั้ง OWNER_PIN ในไฟล์ Code.gs');
  if (!emp || !pin) throw new Error('กรอกรหัสพนักงานและ PIN');
  const cache = CacheService.getScriptCache(), fk = 'fail_' + emp;
  const fails = +(cache.get(fk) || 0);
  if (fails >= MAX_FAIL) throw new Error('ใส่ PIN ผิดหลายครั้ง ลองใหม่ใน ' + LOCK_MIN + ' นาที');
  let ok = false;
  if (emp === String(OWNER_EMP)) ok = pin === String(OWNER_PIN);
  else { const u = accessUsers().find(x => x.emp === emp); ok = !!(u && u.pinHash && u.pinHash === hashPin(pin)); }
  if (!ok) { cache.put(fk, String(fails + 1), LOCK_MIN * 60); throw new Error('รหัสพนักงานหรือ PIN ไม่ถูกต้อง'); }
  cache.remove(fk);
  cleanTokens();
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  props().setProperty('tok_' + token, JSON.stringify({ emp: emp, exp: Date.now() + SESSION_DAYS * 864e5 }));
  const me = resolveUser(emp);
  return { token: token, me: me, ver: getVer(), docs: allDocs(0), url: appUrl() };
}
function session(token) {
  if (!token) throw authErr('กรุณาเข้าสู่ระบบ');
  const raw = props().getProperty('tok_' + token);
  if (!raw) throw authErr('หมดเวลาเข้าสู่ระบบ กรุณาเข้าใหม่');
  const t = JSON.parse(raw);
  if (t.exp < Date.now()) { props().deleteProperty('tok_' + token); throw authErr('หมดเวลาเข้าสู่ระบบ กรุณาเข้าใหม่'); }
  const me = resolveUser(t.emp);
  if (!me) { props().deleteProperty('tok_' + token); throw authErr('บัญชีนี้ไม่มีสิทธิ์เข้าใช้แล้ว'); }
  return me;
}
function resolveUser(emp) {
  if (emp === String(OWNER_EMP)) return { emp: emp, role: 'super', owner: true, branches: [], name: nameOf(emp) };
  const u = accessUsers().find(x => x.emp === emp);
  if (!u) return null;
  return { emp: emp, role: u.role, owner: false, branches: u.branches || [], name: nameOf(emp) };
}
function nameOf(emp) {
  const m = readDoc('config/master');
  const s = m && Array.isArray(m.staff) ? m.staff.find(x => String(x.id) === emp) : null;
  return s ? (s.nick || s.name || emp) : emp;
}
function accessUsers() {
  const a = readDoc('config/access');
  return a && Array.isArray(a.users) ? a.users.map(u => ({ emp: String(u.emp || '').trim(), role: u.role || 'viewer', branches: u.branches || [], pinHash: u.pinHash || '' })) : [];
}
function hashPin(pin) {
  let salt = props().getProperty('salt');
  if (!salt) { salt = Utilities.getUuid(); props().setProperty('salt', salt); }
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pin, Utilities.Charset.UTF_8));
}
function cleanTokens() {
  const all = props().getProperties(), now = Date.now();
  Object.keys(all).forEach(k => { if (k.indexOf('tok_') === 0) { try { if (JSON.parse(all[k]).exp < now) props().deleteProperty(k); } catch (e) { props().deleteProperty(k); } } });
}

// ---------- สิทธิ์การเขียน ----------
function canBranch(s, b) { return s.role === 'super' || (s.role === 'admin' && s.branches.indexOf(b) >= 0); }
function setDoc(s, path, data) {
  if (!data || typeof data !== 'object') throw new Error('ข้อมูลไม่ถูกต้อง');
  if (s.role === 'viewer') throw new Error('บัญชีนี้ดูได้อย่างเดียว');
  let m;
  if (path === 'config/master') { if (s.role !== 'super') throw new Error('แก้การตั้งค่าได้เฉพาะ Super admin'); }
  else if (path === 'config/access') { if (s.role !== 'super') throw new Error('แก้ผู้ใช้ได้เฉพาะ Super admin'); data = mergeAccess(data); }
  else if ((m = /^sched\/([^/]+)__\d{4}-\d{2}-\d{2}$/.exec(path))) { if (!canBranch(s, m[1])) throw new Error('ไม่มีสิทธิ์แก้สาขา ' + m[1]); data.bcode = m[1]; }
  else if ((m = /^offday\/([^/]+)$/.exec(path))) {
    const mm = readDoc('config/master'), st = mm && Array.isArray(mm.staff) ? mm.staff.find(x => String(x.id) === m[1]) : null;
    if (s.role !== 'super' && !(st && canBranch(s, st.bcode))) throw new Error('ไม่มีสิทธิ์แก้วันหยุดของพนักงานคนนี้');
  }
  else throw new Error('ไม่อนุญาตให้บันทึกที่นี่');
  data.by = s.emp; data.at = Date.now();
  const ver = writeDocs([[path, data]], s.emp);
  return { ver: ver, doc: sanitize(path, data) };
}
function mergeAccess(data) {
  const old = {}; accessUsers().forEach(u => { old[u.emp] = u; });
  const seen = {};
  const users = (Array.isArray(data.users) ? data.users : []).map(u => {
    const emp = String(u.emp || '').trim();
    if (!emp) return null;
    if (seen[emp]) throw new Error('รหัสพนักงานซ้ำ: ' + emp); seen[emp] = 1;
    const out = { emp: emp, role: ['super', 'admin', 'viewer'].indexOf(u.role) >= 0 ? u.role : 'viewer', branches: Array.isArray(u.branches) ? u.branches.map(String) : [] };
    const pin = String(u.pin || '').trim();
    if (pin) { if (!/^\d{4,8}$/.test(pin)) throw new Error('PIN ของ ' + emp + ' ต้องเป็นตัวเลข 4–8 หลัก'); out.pinHash = hashPin(pin); }
    else if (old[emp] && old[emp].pinHash) out.pinHash = old[emp].pinHash;
    else throw new Error('ตั้ง PIN ให้ ' + emp + ' ก่อน');
    return out;
  }).filter(Boolean);
  return { users: users };
}
function importDocs(s, docs) {
  if (s.role !== 'super') throw new Error('นำเข้าข้อมูลได้เฉพาะ Super admin');
  const list = [];
  Object.keys(docs).forEach(p => {
    if (p === 'config/access') return;                 // ไม่แตะผู้ใช้และ PIN
    if (p === 'config/master' || /^sched\/[^/]+__\d{4}-\d{2}-\d{2}$/.test(p) || /^offday\/[^/]+$/.test(p)) {
      if (docs[p] && typeof docs[p] === 'object') list.push([p, docs[p]]);
    }
  });
  const ver = writeDocs(list, s.emp);
  return { count: list.length, ver: ver, docs: allDocs(0) };
}

// ---------- ที่เก็บข้อมูล (ชีต _db) ----------
function dbSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(DBS);
  if (!sh) {
    sh = ss.insertSheet(DBS);
    sh.getRange(1, 1, 1, 4).setValues([['path', 'updatedAt', 'by', 'data (แบ่งหลายช่อง)']]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function readRows() {
  const sh = dbSheet(), n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const w = Math.max(4, sh.getLastColumn());
  return sh.getRange(2, 1, n, w).getValues().map((r, i) => ({
    row: i + 2, path: String(r[0]), at: +r[1] || 0,
    json: r.slice(3).map(x => String(x)).filter(x => x !== '').map(x => x.charAt(0) === '~' ? x.slice(1) : x).join(''),
  })).filter(x => x.path);
}
function parse(j) { try { return JSON.parse(j); } catch (e) { return null; } }
function readDoc(path) {
  const cache = CacheService.getScriptCache(), key = 'doc_' + getVer() + '_' + path;
  const hit = cache.get(key);
  if (hit) return parse(hit);
  const r = readRows().find(x => x.path === path);
  const j = r ? r.json : 'null';
  if (j.length < 90000) cache.put(key, j, 600);
  return parse(j);
}
function sanitize(path, d) {
  if (path === 'config/access' && d) return { users: (d.users || []).map(u => ({ emp: u.emp, role: u.role, branches: u.branches || [], hasPin: !!u.pinHash })) };
  return d;
}
function allDocs(since) {
  const out = {};
  readRows().forEach(r => { if (r.at > since) out[r.path] = sanitize(r.path, parse(r.json)); });
  return out;
}
function getVer() { return +(props().getProperty('ver') || 0); }
function writeDocs(list, by) {
  if (!list.length) return getVer();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = dbSheet(), rows = readRows(), idx = {};
    rows.forEach(r => { idx[r.path] = r.row; });
    let now = Math.max(Date.now(), getVer() + 1);
    let next = Math.max(sh.getLastRow(), 1) + 1;
    list.forEach(([path, data]) => {
      const j = JSON.stringify(data), parts = [];
      for (let i = 0; i < j.length; i += CHUNK) parts.push('~' + j.slice(i, i + CHUNK));
      const w = Math.max(4, sh.getLastColumn(), 3 + parts.length);
      if (sh.getMaxColumns() < w) sh.insertColumnsAfter(sh.getMaxColumns(), w - sh.getMaxColumns());
      const row = [path, now, by].concat(parts); while (row.length < w) row.push('');
      const r = idx[path] || (idx[path] = next++);
      if (r > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), r - sh.getMaxRows() + 50);
      const rg = sh.getRange(r, 1, 1, w);
      rg.setNumberFormat('@');
      rg.setValues([row]);
    });
    props().setProperty('ver', String(now));
    return now;
  } finally { lock.releaseLock(); }
}
