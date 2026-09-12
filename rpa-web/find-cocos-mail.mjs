// ค้นอีเมลของ COCOS แบบ "อ่านอย่างเดียว 100%"
//
// ⚠ กล่องนี้มีคนใช้งานอยู่ — ห้ามกระทบอะไรทั้งสิ้น
//    สคริปต์นี้ยิงเฉพาะ HTTP GET ไปที่ Gmail API เท่านั้น
//    (messages.list · messages.get · attachments.get · profile.get)
//    ไม่มี POST/PUT/DELETE · ไม่แตะ labels · ไม่ทำให้เป็นอ่านแล้ว · ไม่ย้าย/ลบ
//    Gmail API: การอ่าน (GET) ไม่เปลี่ยนสถานะ UNREAD — สถานะเปลี่ยนได้ด้วย messages.modify เท่านั้น
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const QUERY = process.env.MAIL_QUERY ?? "COCOS";
const MAX = Number(process.env.MAIL_MAX ?? 20);
const SAVE_DIR = process.env.MAIL_SAVE ?? "";      // ใส่พาธถ้าจะโหลดไฟล์แนบ

// อ่าน .env เองเพื่อไม่ต้องพึ่ง shell (ค่าบางตัวมีอักขระที่ทำให้ source ไม่ติด)
const { readFile } = await import("node:fs/promises");
const envText = await readFile(new URL("./.env", import.meta.url), "utf-8").catch(() => "");
for (const line of envText.split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const need = ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"];
for (const k of need) if (!process.env[k]) { console.error(`✗ ไม่มี ${k} ใน .env`); process.exit(1); }

const tok = await (await fetch("https://oauth2.googleapis.com/token", {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: process.env.GMAIL_CLIENT_ID, client_secret: process.env.GMAIL_CLIENT_SECRET,
    refresh_token: process.env.GMAIL_REFRESH_TOKEN, grant_type: "refresh_token",
  }),
})).json();
if (!tok.access_token) { console.error("✗ แลก token ไม่ได้:", JSON.stringify(tok).slice(0, 200)); process.exit(1); }
const GET = async (p) => {
  const r = await fetch(`${API}${p}`, { headers: { Authorization: "Bearer " + tok.access_token } });
  if (!r.ok) throw new Error(`GET ${p} → HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
  return r.json();
};

const prof = await GET("/profile");
console.log(`📬 กล่องที่ระบบ RPA ใช้: ${prof.emailAddress}`);
console.log(`🔍 ค้น: "${QUERY}" (สูงสุด ${MAX} ฉบับ)\n`);

const list = await GET(`/messages?q=${encodeURIComponent(QUERY)}&maxResults=${MAX}`);
const ids = (list.messages ?? []).map((m) => m.id);
if (!ids.length) { console.log("ไม่พบอีเมลที่ตรงกับคำค้นนี้"); process.exit(0); }
console.log(`พบ ${ids.length} ฉบับ (จากทั้งหมดประมาณ ${list.resultSizeEstimate ?? "?"})\n`);

const walk = (part, out = []) => {
  if (!part) return out;
  if (part.filename && part.body?.attachmentId) {
    out.push({ filename: part.filename, mimeType: part.mimeType, size: part.body.size, attachmentId: part.body.attachmentId });
  }
  for (const p of part.parts ?? []) walk(p, out);
  return out;
};

if (SAVE_DIR) await mkdir(SAVE_DIR, { recursive: true });
let saved = 0;
for (const id of ids) {
  const m = await GET(`/messages/${id}?format=full`);
  const h = (n) => (m.payload?.headers ?? []).find((x) => x.name.toLowerCase() === n)?.value ?? "";
  const atts = walk(m.payload);
  const unread = (m.labelIds ?? []).includes("UNREAD");
  console.log(`── ${h("date").slice(0, 31)}  ${unread ? "🔵 ยังไม่อ่าน" : "อ่านแล้ว"}`);
  console.log(`   จาก  : ${h("from").slice(0, 70)}`);
  console.log(`   เรื่อง: ${h("subject").slice(0, 90)}`);
  console.log(`   แนบ  : ${atts.length ? atts.map((a) => `${a.filename} (${Math.round(a.size / 1024)} KB)`).join(" · ") : "(ไม่มี)"}`);

  if (SAVE_DIR) {
    for (const a of atts) {
      if (!/\.(xls[xm]?|pdf|csv|docx?)$/i.test(a.filename)) continue;
      const d = await GET(`/messages/${id}/attachments/${a.attachmentId}`);
      const buf = Buffer.from(String(d.data).replace(/-/g, "+").replace(/_/g, "/"), "base64");
      const safe = a.filename.replace(/[/\\]/g, "_");
      await writeFile(path.join(SAVE_DIR, safe), buf);
      console.log(`        ⬇ บันทึก ${safe}`);
      saved++;
    }
  }
}
console.log(`\n✓ อ่านอย่างเดียว — ไม่ได้แตะสถานะหรือป้ายกำกับใด ๆ${SAVE_DIR ? ` · บันทึกไฟล์ ${saved} ไฟล์ไว้ที่ ${SAVE_DIR}` : ""}`);
