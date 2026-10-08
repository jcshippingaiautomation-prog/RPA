// ============================================================
//  อัปโหลดเอกสารลูกค้าขึ้น Google Drive ตามโครงโฟลเดอร์ที่มีอยู่แล้ว
//
//  ใช้คู่กับโฟลเดอร์ในเครื่องที่จัดไว้แล้ว:  <ราก>/<ลูกค้า>/<Master>/<ไฟล์>
//  วิธีใช้:
//     node scripts/upload-to-drive.mjs <DRIVE_FOLDER_ID> ["<โฟลเดอร์ในเครื่อง>"]
//
//  กฎความปลอดภัย:
//   - ไม่ลบ ไม่ย้าย ไม่เขียนทับอะไรบน Drive — อัปเฉพาะไฟล์ที่ยังไม่มีชื่อนั้นในโฟลเดอร์นั้น
//   - ถ้าโฟลเดอร์ปลายทางยังไม่มี จะสร้างให้ (ชื่อตรงกับในเครื่อง)
//   - DRY=1 = ดูก่อนว่าจะอัปอะไรบ้าง ไม่อัปจริง
// ============================================================
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

const ROOT_ID = process.argv[2];
const LOCAL = process.argv[3] || "/Users/pok/Desktop/Jobs/ScriptMappingคุณแพรว/อัปขึ้น Drive";
const DRY = process.env.DRY === "1";
if (!ROOT_ID) { console.error("ใช้งาน: node scripts/upload-to-drive.mjs <DRIVE_FOLDER_ID>"); process.exit(1); }

const { GMAIL_CLIENT_ID: ID, GMAIL_CLIENT_SECRET: SECRET, GDRIVE_REFRESH_TOKEN: RT } = process.env;
if (!ID || !SECRET || !RT) {
  console.error("ยังไม่มีสิทธิ์ Drive — รัน: node scripts/get-drive-token.mjs ก่อน"); process.exit(1);
}
const tok = await (await fetch("https://oauth2.googleapis.com/token", {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: ID, client_secret: SECRET, refresh_token: RT, grant_type: "refresh_token" }),
})).json();
if (!tok.access_token) { console.error("ขอ access token ไม่ได้:", JSON.stringify(tok)); process.exit(1); }
const H = { Authorization: `Bearer ${tok.access_token}` };

const MIME = { ".pdf": "application/pdf", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".csv": "text/csv", ".txt": "text/plain" };

/** รายชื่อลูกของโฟลเดอร์ (ชื่อ → id) */
async function children(parentId) {
  const out = new Map();
  let pageToken;
  do {
    const q = encodeURIComponent(`'${parentId}' in parents and trashed = false`);
    const u = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=nextPageToken,files(id,name,mimeType,size)&pageSize=1000${pageToken ? "&pageToken=" + pageToken : ""}`;
    const r = await (await fetch(u, { headers: H })).json();
    for (const f of r.files ?? []) out.set(f.name, f);
    pageToken = r.nextPageToken;
  } while (pageToken);
  return out;
}
async function ensureFolder(parentId, name, cache) {
  const hit = cache.get(name);
  if (hit && hit.mimeType === "application/vnd.google-apps.folder") return hit.id;
  if (DRY) { console.log(`   (จะสร้างโฟลเดอร์ใหม่) ${name}`); return null; }
  const r = await (await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST", headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
  })).json();
  cache.set(name, { id: r.id, mimeType: "application/vnd.google-apps.folder" });
  return r.id;
}
async function uploadFile(parentId, file, name) {
  const body = fs.readFileSync(file);
  const mime = MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream";
  const boundary = "----rpa" + Date.now();
  const head = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name, parents: [parentId] }) + `\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--`);
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name", {
    method: "POST", headers: { ...H, "Content-Type": `multipart/related; boundary=${boundary}` },
    body: Buffer.concat([head, body, tail]),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 180)}`);
  return r.json();
}

const rootKids = await children(ROOT_ID);
let up = 0, skip = 0, bytes = 0; const problems = [];
for (const cust of fs.readdirSync(LOCAL).filter((d) => fs.statSync(path.join(LOCAL, d)).isDirectory())) {
  const custId = await ensureFolder(ROOT_ID, cust, rootKids);
  console.log(`\n📁 ${cust}`);
  if (!custId) continue;
  const custKids = await children(custId);
  for (const master of fs.readdirSync(path.join(LOCAL, cust)).filter((d) => fs.statSync(path.join(LOCAL, cust, d)).isDirectory())) {
    const mId = await ensureFolder(custId, master, custKids);
    if (!mId) continue;
    const have = await children(mId);
    const dir = path.join(LOCAL, cust, master);
    const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile() && !f.startsWith("."));
    let n = 0;
    for (const f of files) {
      if (have.has(f)) { skip++; continue; }
      if (DRY) { n++; up++; continue; }
      try { await uploadFile(mId, path.join(dir, f), f); n++; up++; bytes += fs.statSync(path.join(dir, f)).size; }
      catch (e) { problems.push(`${cust}/${master}/${f} — ${e.message}`); }
    }
    console.log(`   ${String(n).padStart(3)} ไฟล์ → ${master.slice(0, 60)}${files.length - n ? ` (มีอยู่แล้ว ${files.length - n})` : ""}`);
  }
}
console.log(`\n${DRY ? "(ดูก่อน) จะอัป" : "อัปแล้ว"} ${up} ไฟล์${DRY ? "" : ` · ${(bytes / 1048576).toFixed(1)} MB`} · ข้ามเพราะมีอยู่แล้ว ${skip} ไฟล์`);
if (problems.length) { console.log(`\n⚠ อัปไม่สำเร็จ ${problems.length} ไฟล์:`); problems.slice(0, 20).forEach((p) => console.log("   " + p)); }
