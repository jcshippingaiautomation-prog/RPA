// ============================================================
//  ขอสิทธิ์ Google Drive (รันครั้งเดียว)
//
//  ใช้ OAuth Client ตัวเดิมที่ใช้กับ Gmail — แค่ขอสิทธิ์เพิ่มอีกอย่างเดียวคือ Drive
//  วิธีใช้:  node scripts/get-drive-token.mjs
//  (อ่าน GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET จาก .env ให้เอง)
//
//  เสร็จแล้วจะเขียน GDRIVE_REFRESH_TOKEN ลง .env
//  ⚠ ต้องเพิ่ม redirect URI นี้ใน Google Cloud ของ OAuth Client ตัวนั้นก่อน:
//      http://localhost:5599/oauth2callback   (ตัวเดียวกับที่ใช้ตอนขอ Gmail)
// ============================================================
import http from "node:http";
import { exec } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, "..", ".env");
const env = Object.fromEntries(
  (await readFile(ENV_PATH, "utf-8")).split("\n")
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const CLIENT_ID = process.argv[2] || env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.argv[3] || env.GMAIL_CLIENT_SECRET;
const PORT = 5599;
const REDIRECT = `http://localhost:${PORT}/oauth2callback`;
// drive.file = เห็นเฉพาะไฟล์/โฟลเดอร์ที่แอปนี้สร้างหรือที่ผู้ใช้เลือกให้เท่านั้น
//   แต่เราต้องอัปเข้าโฟลเดอร์ที่ผู้ใช้สร้างเองไว้แล้ว จึงต้องใช้ขอบเขต drive เต็ม
const SCOPES = "https://www.googleapis.com/auth/drive";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("\nไม่พบ GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET ใน .env");
  console.error("ใส่เองได้: node scripts/get-drive-token.mjs <CLIENT_ID> <CLIENT_SECRET>\n");
  process.exit(1);
}

const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
  client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: "code",
  scope: SCOPES, access_type: "offline", prompt: "consent",
});

async function upsertEnv(pairs) {
  const lines = (await readFile(ENV_PATH, "utf-8")).split("\n");
  for (const [k, v] of Object.entries(pairs)) {
    const i = lines.findIndex((l) => l.startsWith(k + "="));
    if (i >= 0) lines[i] = `${k}=${v}`; else lines.push(`${k}=${v}`);
  }
  await writeFile(ENV_PATH, lines.filter((l) => l !== "").join("\n") + "\n", "utf-8");
}

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith("/oauth2callback")) { res.writeHead(404); res.end(); return; }
  const code = new URL(req.url, `http://localhost:${PORT}`).searchParams.get("code");
  if (!code) { res.writeHead(400); res.end("ไม่พบ code"); return; }
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT, grant_type: "authorization_code" }),
    });
    const data = await r.json();
    if (!data.refresh_token) throw new Error("ไม่ได้ refresh_token: " + JSON.stringify(data));
    await upsertEnv({ GDRIVE_REFRESH_TOKEN: data.refresh_token });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h2>อนุญาตเรียบร้อย ปิดหน้านี้ได้เลย</h2>");
    console.log("\n✓ เขียน GDRIVE_REFRESH_TOKEN ลง .env แล้ว — รันตัวอัปโหลดต่อได้เลย\n");
    server.close(); process.exit(0);
  } catch (e) {
    res.writeHead(500); res.end("error: " + e.message);
    console.error("\n✗ ล้มเหลว:", e.message, "\n"); server.close(); process.exit(1);
  }
});
server.listen(PORT, () => {
  console.log("\nเปิดเบราว์เซอร์เพื่อ login + อนุญาต Google Drive…");
  console.log("(ถ้าไม่เปิดเอง ก๊อป URL นี้ไปเปิด):\n" + authUrl + "\n");
  exec(`open "${authUrl}"`);
});
