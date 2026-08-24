// ============================================================
//  Survey CLI — สำรวจทุกช่องของหน้าสร้างใบขน DCTK (ครบทุกแท็บ)
//
//  วิธีรัน (จาก rpa-import-node):
//    set -a; . ../rpa-web/.env; set +a
//    node dist/survey-cli.js
//
//  2 โหมด:
//    SURVEY_DECL_NO=DCTK000034700   ← แนะนำ: เปิด "ใบเดิม" มาสำรวจ
//         ไม่สร้างใบใหม่ · ไม่ทิ้งร่องรอย · ช่องมีค่าจริงให้ดู · dropdown มีตัวเลือกครบ
//    (ไม่ตั้ง)                       ← สร้างใบร่างใหม่ แล้วกรอก+Save เพื่อไล่ไปหน้า 2/3
//         SURVEY_INVOICE=Test900 กำหนดเลขใบกำกับทดสอบ
//
//  ตัวแปรอื่น:
//    SURVEY_HEADLESS=1       ไม่เปิดหน้าจอ
//    SURVEY_HOLD_SEC=45      ค้างเบราว์เซอร์หลังเสร็จ
//    SURVEY_STOP_AFTER=1|2|3 สำรวจถึงหน้าไหน (ค่าเริ่มต้น 3)
// ============================================================
import path from "node:path";
import { chromium } from "playwright";
import { loadConfig, PROJECT_ROOT } from "./runner.js";
import {
  login, openPortfolioAndAdd, fillPage1, fillPage2Open, fillPage2Fill,
  openDeclarationForEdit,
} from "./pages.js";
import { setLogSink, log, sleep } from "./helpers.js";
import { loadRecordsFromSupabase } from "./data.js";
import { surveyPage } from "./survey.js";
import * as S from "./selectors.js";
import type { Record } from "./types.js";

setLogSink(null); // log() พิมพ์ออก stdout อยู่แล้ว — ไม่ต้องซ้ำ

const num = (v: string | undefined, d: number) => (v && !Number.isNaN(+v) ? +v : d);
const HOLD = num(process.env.SURVEY_HOLD_SEC, 45);
const STOP_AFTER = num(process.env.SURVEY_STOP_AFTER, 3);
const HEADLESS = process.env.SURVEY_HEADLESS === "1";
const DECL_NO = (process.env.SURVEY_DECL_NO ?? "").trim();

const cfg = await loadConfig();
if (!cfg.url || !cfg.username) {
  console.error("✗ ไม่พบ config.json (url/username) — ตั้งค่า DCTK ก่อน");
  process.exit(1);
}

const downloadDir = cfg.download_dir
  ? path.resolve(PROJECT_ROOT, cfg.download_dir)
  : path.join(PROJECT_ROOT, "file download");

log(`🔎 สำรวจหน้าสร้างใบขน DCTK — ${DECL_NO ? `เปิดใบเดิม ${DECL_NO}` : "สร้างใบร่างใหม่"}`);
log(`   สำรวจถึงหน้า ${STOP_AFTER} · headless=${HEADLESS}`);

const browser = await chromium.launch({ headless: HEADLESS, slowMo: cfg.slow_mo_ms ?? 0 });
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1920, height: 1080 } });
const page = await context.newPage();
page.setDefaultTimeout(cfg.default_timeout_ms ?? 30000);


/**
 * ดับเบิลคลิกแถวในตาราง แล้วคืน "หน้าที่ต้องสำรวจต่อ"
 * DCTK เปิดฟอร์มใบกำกับ/รายการสินค้าใน **แท็บใหม่** → ต้องรอ event page
 * ถ้าไม่มีแท็บใหม่ (บางจังหวะเปิดในหน้าเดิม) ก็คืนหน้าเดิม
 */
async function openRow(current: import("playwright").Page, gridId: string, what: string) {
  const before = context.pages().length;
  const rowSel = `#${gridId} tbody tr[role='row'], #${gridId} tbody tr`;
  const waitNew = context.waitForEvent("page", { timeout: 20000 }).catch(() => null);
  try {
    await current.locator(rowSel).first().dblclick({ timeout: 15000 });
  } catch {
    log(`  ⚠ ไม่พบแถวใน #${gridId} — ข้าม ${what}`);
    return current;
  }
  const fresh = await waitNew;
  if (fresh) {
    await fresh.waitForLoadState("domcontentloaded").catch(() => { /* */ });
    await sleep(5000);
    log(`  ✓ ${what} เปิดในแท็บใหม่ (${context.pages().length - before} แท็บ)`);
    return fresh;
  }
  await sleep(5000);
  log(`  → ${what} เปิดในหน้าเดิม`);
  return current;
}

try {
  await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await login(page, cfg.username, cfg.password);

  if (DECL_NO) {
    // ─── โหมดเปิดใบเดิม: ไม่สร้างอะไรใหม่ ────────────────────────────
    await openDeclarationForEdit(page, DECL_NO);
    await sleep(2500);
    await surveyPage(page, "page1", downloadDir);

    if (STOP_AFTER >= 2) {
      log("→ เปิดแท็บใบกำกับสินค้า (หน้า 2)");
      await page.click(S.SEL_TAB2);
      await sleep(4000);
      // ฟอร์มใบกำกับเต็ม = dblclick แถวใน #gridExInvoice (เปิดแท็บใหม่)
      const page2 = await openRow(page, "gridExInvoice", "ฟอร์มใบกำกับ");
      await surveyPage(page2, "page2", downloadDir);

      if (STOP_AFTER >= 3) {
        log("→ เปิดรายการสินค้ารายการแรก (หน้า 3)");
        // ตารางส่วนรายละเอียดอยู่บนหน้าแก้ไขใบขน (page) ไม่ใช่ฟอร์มใบกำกับ
        const page3 = await openRow(page, "gridExDecDtl", "ฟอร์มรายการสินค้า");
        await surveyPage(page3, "page3", downloadDir);
      }
    }
  } else {
    // ─── โหมดสร้างใบร่างใหม่ (ต้องกรอก+Save ถึงจะข้ามหน้าได้) ─────────
    const records = await loadRecordsFromSupabase();
    if (!records.length) { console.error("✗ ไม่มีข้อมูลใน Supabase ให้ใช้กรอก"); process.exit(1); }
    const rec: Record = { ...records[0] };
    rec.invoice_no = (process.env.SURVEY_INVOICE ?? "Test900").trim();
    rec.__dry_run__ = false;

    await openPortfolioAndAdd(page);
    await sleep(2500);
    await surveyPage(page, "page1", downloadDir);

    if (STOP_AFTER >= 2) {
      log("→ กรอก+บันทึกหน้า 1 เพื่อเปิดหน้า 2");
      await fillPage1(page, rec);
      const page2 = await fillPage2Open(page);
      await sleep(2500);
      await surveyPage(page2, "page2", downloadDir);

      if (STOP_AFTER >= 3) {
        log("→ กรอก+บันทึกหน้า 2 เพื่อเปิดหน้า 3");
        await fillPage2Fill(page2, rec);
        log("→ รอฟอร์มรายการสินค้าพร้อม…");
        for (let i = 0; i < 20; i++) {
          const n = await page2.locator("#Brand, #TariffCode").count().catch(() => 0);
          if (n > 0) break;
          await sleep(3000);
        }
        await sleep(1500);
        await surveyPage(page2, "page3", downloadDir);
      }
    }
  }

  log(`\n✅ สำรวจเสร็จ — ไฟล์อยู่ที่ ${path.join(downloadDir, "survey")}`);
} catch (e) {
  log(`✗ error: ${e instanceof Error ? e.stack || e.message : String(e)}`);
  try { await surveyPage(page, "error", downloadDir); } catch { /* */ }
} finally {
  if (HOLD > 0) { log(`⏸ ค้างเบราว์เซอร์ ${HOLD}s`); await sleep(HOLD * 1000); }
  await browser.close();
}
