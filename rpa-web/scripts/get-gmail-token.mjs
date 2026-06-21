// ============================================================
//  ขอ Gmail refresh token (รันครั้งเดียว)
//  วิธีใช้:
//    1. สร้าง OAuth Client (Web application) ใน Google Cloud
//       Authorized redirect URI: http://localhost:5599/oauth2callback
//    2. รัน: node scripts/get-gmail-token.mjs <CLIENT_ID> <CLIENT_SECRET>
//    3. เบราว์เซอร์จะเปิด → login อีเมลกล่อง → อนุญาต
//    4. script จะพิมพ์ refresh token + เขียนลง .env ให้อัตโนมัติ
// ============================================================
import http from "node:http";
import { exec } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, "..", ".env");

const CLIENT_ID = process.argv[2];
const CLIENT_SECRET = process.argv[3];
const PORT = 5599;
const REDIRECT = `http://localhost:${PORT}/oauth2callback`;
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
].join(" ");

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("\nใช้งาน: node scripts/get-gmail-token.mjs <CLIENT_ID> <CLIENT_SECRET>\n");
  console.error("(สร้าง OAuth Client type=Web ใน Google Cloud,");
  console.error(` redirect URI = ${REDIRECT})\n`);
  process.exit(1);
}

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent", // บังคับให้คืน refresh_token ทุกครั้ง
  }).toString();

function openBrowser(url) {
  const cmd =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "start" : "xdg-open";
  exec(`${cmd} "${url}"`);
}

async function upsertEnv(updates) {
  let lines = [];
  if (existsSync(ENV_PATH)) {
    lines = (await readFile(ENV_PATH, "utf-8")).split("\n");
  }
  for (const [k, v] of Object.entries(updates)) {
    const idx = lines.findIndex((l) => l.startsWith(k + "="));
    const line = `${k}=${v}`;
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  }
  await writeFile(ENV_PATH, lines.filter((l) => l !== "").join("\n") + "\n", "utf-8");
}

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith("/oauth2callback")) {
    res.writeHead(404); res.end("not found"); return;
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400); res.end("ไม่พบ code"); return;
  }
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT,
        grant_type: "authorization_code",
      }),
    });
    const data = await tokenRes.json();
    if (!data.refresh_token) {
      throw new Error("ไม่ได้ refresh_token: " + JSON.stringify(data));
    }
    await upsertEnv({
      GMAIL_CLIENT_ID: CLIENT_ID,
      GMAIL_CLIENT_SECRET: CLIENT_SECRET,
      GMAIL_REFRESH_TOKEN: data.refresh_token,
    });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h2>สำเร็จ! เขียนค่าลง .env แล้ว ปิดหน้านี้ได้เลย</h2>");
    console.log("\n✓ สำเร็จ — เขียนลง .env แล้ว:");
    console.log("  GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN");
    console.log("\nrefresh_token:", data.refresh_token, "\n");
    server.close();
    process.exit(0);
  } catch (e) {
    res.writeHead(500); res.end("error: " + e.message);
    console.error("\n✗ ล้มเหลว:", e.message, "\n");
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log("\nเปิดเบราว์เซอร์เพื่อ login + อนุญาต…");
  console.log("(ถ้าไม่เปิดเอง ก๊อป URL นี้ไปเปิด):\n" + authUrl + "\n");
  openBrowser(authUrl);
});
