// แคปหน้าจอ frontend ทุกหน้า/แท็บ/modal → frontend-docs/screenshots/
// รัน: node frontend-docs/capture.mjs   (เว็บ local ต้องรันที่ :8100)
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "screenshots");
const BASE = process.env.WEB_URL || "http://localhost:8100";
const EMAIL = process.env.LOGIN_EMAIL || "jcshipping@gmail.com";
const PASS = process.env.LOGIN_PASS || "Admin@123";

const shots = [];
async function shot(page, name, full = true) {
  const f = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: f, fullPage: full });
  shots.push(name);
  console.log("📸", name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

try {
  // ---- 1. Login ----
  await page.goto(`${BASE}/login.html`, { waitUntil: "networkidle" });
  await sleep(800);
  await shot(page, "01-login", false);

  // login
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASS);
  await page.click("#btnLogin");
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 20000 }).catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
  await sleep(2500);

  // ---- 2. หน้ารายการใบขน ----
  await shot(page, "02-list");

  // ---- 3. Modal อัปโหลด ----
  await page.click("#btnUpload").catch(() => {});
  await sleep(900);
  await shot(page, "03-modal-upload", false);
  await page.click("#upCancel").catch(() => {});
  await sleep(400);

  // ---- 4. Modal สร้างรายการ ----
  await page.click("#btnCreate").catch(() => {});
  await sleep(900);
  await shot(page, "04-modal-create", false);
  await page.click("#crCancel").catch(() => {});
  await sleep(400);

  // ---- 5. Modal ดึงอีเมล ----
  await page.click("#btnPollEmail").catch(() => {});
  await sleep(700);
  await shot(page, "05-modal-poll", false);
  await page.click("#pollCancel, #pollClose").catch(() => {});
  await sleep(400);

  // ---- 6. Modal รายละเอียด (คลิกปุ่มรายละเอียดแถวแรก ถ้ามี) ----
  const detailBtn = page.locator(".actDetail").first();
  if (await detailBtn.count().catch(() => 0)) {
    await detailBtn.click().catch(() => {});
    await sleep(1500);
    await shot(page, "06-modal-detail");
    await page.click("#mdClose").catch(() => {});
    await sleep(400);
  }

  // ---- 7. หน้าประวัติงาน ----
  await page.click('.nav-item[data-page="history"]').catch(() => {});
  await sleep(1500);
  await shot(page, "07-history");

  // ---- 8-11. หน้าตั้งค่า + 4 แท็บ ----
  await page.click('.nav-item[data-page="settings"]').catch(() => {});
  await sleep(1200);
  await shot(page, "08-settings-email");           // แท็บแรก (email) default

  await page.click('.tab[data-tab="airpa"]').catch(() => {});
  await sleep(800);
  await shot(page, "09-settings-airpa");

  await page.click('.tab[data-tab="customer"]').catch(() => {});
  await sleep(800);
  await shot(page, "10-settings-customer");

  await page.click('.tab[data-tab="users"]').catch(() => {});
  await sleep(1000);
  await shot(page, "11-settings-users");

  console.log(`\n✅ แคปครบ ${shots.length} หน้า → ${OUT}`);
} catch (e) {
  console.error("❌ error:", e.message);
} finally {
  await browser.close();
}
