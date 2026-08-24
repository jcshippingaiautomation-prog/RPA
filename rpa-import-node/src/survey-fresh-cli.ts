// ============================================================
//  Survey fresh — สำรวจหน้า 2/3 จาก "ฟอร์มสร้างใหม่" (ไม่ใช่ใบเก่า)
//
//  ทำไมต้องมี: ที่ผ่านมาหน้า 2/3 สำรวจจากการเปิด "ใบเก่า"
//  ซึ่ง DCTK ล็อก/ซ่อนบางช่องไว้ ฟอร์มตอนสร้างใหม่อาจมีช่องที่เราไม่เคยเห็น
//
//  วิธีเข้าโดยไม่สร้างใบใหม่:
//    หน้า 2 → เปิดใบเดิม → แท็บใบกำกับ → ปุ่ม "เพิ่มข้อมูล" (#BtnExInvoiceAdd)
//             = ฟอร์มใบกำกับเปล่า บนใบที่มีอยู่แล้ว (ยังไม่บันทึก = ไม่ทิ้งร่องรอย)
//    หน้า 3 → ปุ่ม "สำเนารายการ" (#BtnExDecDtlCopy) = ฟอร์มรายการสินค้าในสถานะสร้างใหม่
//
//  ⚠ ไม่กด Save ใด ๆ — เปิดดู เก็บข้อมูล แล้วปิดทิ้ง
//
//  วิธีรัน:
//    set -a; . ../rpa-web/.env; set +a
//    FRESH_DECL_NO=DCTK000034914 node dist/survey-fresh-cli.js
// ============================================================
import path from "node:path";
import { chromium, type Page } from "playwright";
import { loadConfig, PROJECT_ROOT } from "./runner.js";
import { login, openDeclarationForEdit } from "./pages.js";
import { setLogSink, log, sleep } from "./helpers.js";
import { surveyPage } from "./survey.js";
import * as S from "./selectors.js";

setLogSink(null);

const DECL_NO = (process.env.FRESH_DECL_NO ?? "DCTK000034914").trim();
const cfg = await loadConfig();
if (!cfg.url) { console.error("✗ ไม่พบ config.json"); process.exit(1); }

const downloadDir = cfg.download_dir
  ? path.resolve(PROJECT_ROOT, cfg.download_dir)
  : path.join(PROJECT_ROOT, "file download");

const browser = await chromium.launch({ headless: process.env.FRESH_HEADLESS !== "0" });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await context.newPage();
page.setDefaultTimeout(cfg.default_timeout_ms ?? 30000);

/** คลิกปุ่ม แล้วคืนแท็บใหม่ที่ DCTK เปิด (ถ้ามี) */
async function clickForNewTab(p: Page, selector: string, what: string): Promise<Page | null> {
  const waitNew = context.waitForEvent("page", { timeout: 20000 }).catch(() => null);
  try {
    await p.click(selector, { timeout: 12000 });
  } catch { log(`  ⚠ กด "${what}" ไม่ได้ (${selector})`); return null; }
  const fresh = await waitNew;
  if (fresh) {
    await fresh.waitForLoadState("domcontentloaded").catch(() => { /* */ });
    await sleep(5000);
    log(`  ✓ ${what} เปิดในแท็บใหม่`);
    return fresh;
  }
  await sleep(4000);
  log(`  → ${what} เปิดในหน้าเดิม`);
  return p;
}

try {
  await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await login(page, cfg.username, cfg.password);
  await openDeclarationForEdit(page, DECL_NO);
  await sleep(2500);
  await page.click(S.SEL_TAB2);
  await sleep(4000);

  // ── หน้า 2 แบบสร้างใหม่: ปุ่ม "เพิ่มข้อมูล" บนตารางใบกำกับ ──
  log("→ เปิดฟอร์มใบกำกับเปล่า (ปุ่มเพิ่มข้อมูล)");
  const inv = await clickForNewTab(page, S.SEL_BTN_INVOICE_ADD, "ฟอร์มใบกำกับเปล่า");
  if (inv) {
    await surveyPage(inv, "page2-create", downloadDir);
    if (inv !== page) await inv.close();
  }
  await sleep(2000);

  // ── หน้า 3 แบบสร้างใหม่: ปุ่ม "สำเนารายการ" บนตารางส่วนรายละเอียด ──
  //   ต้องเลือกแถวก่อน DCTK ถึงจะยอมสำเนา
  log("→ เปิดฟอร์มรายการสินค้าแบบสร้างใหม่ (สำเนารายการ)");
  try {
    await page.locator("#gridExDecDtl tbody tr").first().click({ timeout: 10000 });
    await sleep(1200);
  } catch { log("  ⚠ เลือกแถวในตารางส่วนรายละเอียดไม่ได้"); }
  const item = await clickForNewTab(page, "#BtnExDecDtlCopy", "ฟอร์มรายการสินค้า (สำเนา)");
  if (item && item !== page) {
    await surveyPage(item, "page3-create", downloadDir);
    await item.close();
  } else {
    log("  ⚠ เข้าฟอร์มรายการสินค้าแบบสร้างใหม่ไม่ได้ — DCTK เปิดได้เฉพาะหลังบันทึกใบกำกับ");
  }

  log(`\n✅ เสร็จ — ไฟล์อยู่ที่ ${path.join(downloadDir, "survey")}`);
} catch (e) {
  log(`✗ error: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await browser.close();
}
