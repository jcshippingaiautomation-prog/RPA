// ============================================================
//  Rules CLI — ถอดเงื่อนไขของระบบ DCTK ออกมาเป็นข้อมูล
//
//  วิธีรัน (จาก rpa-import-node):
//    set -a; . ../rpa-web/.env; set +a
//    RULES_DECL_NO=DCTK000034914 node dist/rules-cli.js
//
//  ตัวแปร:
//    RULES_DECL_NO=<เลขใบขน>  เปิดใบเดิมเพื่อถอดกฎหน้า 2/3 (ไม่ตั้ง = ถอดแค่หน้า 1)
//    RULES_HEADLESS=1         ไม่เปิดหน้าจอ
//    RULES_MAX_VALUES=4       ทดลองค่าละกี่ตัวเลือกต่อ 1 ช่อง (มากขึ้น = ละเอียดขึ้น แต่ช้า)
//
//  ⚠ สคริปต์นี้ "ไม่กด Save" ใด ๆ — แค่สลับค่าในหน้าจอเพื่อดูปฏิกิริยา แล้วคืนค่าเดิม
// ============================================================
import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { loadConfig, PROJECT_ROOT } from "./runner.js";
import { login, openPortfolioAndAdd, openDeclarationForEdit } from "./pages.js";
import { setLogSink, log, sleep } from "./helpers.js";
import { extractRules } from "./rules.js";
import { loadFieldRegistry, type FieldDef } from "./field-registry.js";
import * as S from "./selectors.js";

setLogSink(null);

const num = (v: string | undefined, d: number) => (v && !Number.isNaN(+v) ? +v : d);
const DECL_NO = (process.env.RULES_DECL_NO ?? "").trim();
const HEADLESS = process.env.RULES_HEADLESS === "1";
const MAX_VALUES = num(process.env.RULES_MAX_VALUES, 4);

const cfg = await loadConfig();
if (!cfg.url || !cfg.username) { console.error("✗ ไม่พบ config.json"); process.exit(1); }

const downloadDir = cfg.download_dir
  ? path.resolve(PROJECT_ROOT, cfg.download_dir)
  : path.join(PROJECT_ROOT, "file download");

// ── สร้างรายการ "ช่องตัวขับ" จากทะเบียนช่อง ────────────────────────────
//   ตัวขับ = ช่องที่เปลี่ยนแล้วน่าจะกระทบช่องอื่น: checkbox + dropdown ที่มีตัวเลือกจำกัด
const registry: FieldDef[] = await loadFieldRegistry();
function driversFor(page: 1 | 2 | 3) {
  return registry
    .filter((f) => f.page === page && !f.computed)
    .filter((f) => f.type === "checkbox" || (f.options && f.options.length > 0 && f.options.length <= 20))
    .map((f) => ({
      name: f.dctkName,
      label: f.label,
      isCheckbox: f.type === "checkbox",
      values: f.type === "checkbox"
        ? [{ value: "1", label: "ติ๊ก" }, { value: "0", label: "ไม่ติ๊ก" }]
        : f.options.slice(0, MAX_VALUES).map((o) => ({ value: o.value || o.text, label: o.text || o.value })),
    }))
    .filter((d) => d.values.length > 0);
}

log(`📐 ถอดเงื่อนไขระบบ DCTK — ${DECL_NO ? `หน้า 1-3 (เปิดใบ ${DECL_NO})` : "เฉพาะหน้า 1 (ฟอร์มสร้างใหม่)"}`);

const browser = await chromium.launch({ headless: HEADLESS, slowMo: 0 });
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1920, height: 1080 } });
const page = await context.newPage();
page.setDefaultTimeout(cfg.default_timeout_ms ?? 30000);

/** dblclick แถวในตาราง → คืนแท็บใหม่ถ้า DCTK เปิดแท็บใหม่ */
async function openRow(current: import("playwright").Page, gridId: string, what: string) {
  const waitNew = context.waitForEvent("page", { timeout: 20000 }).catch(() => null);
  try {
    await current.locator(`#${gridId} tbody tr[role='row'], #${gridId} tbody tr`).first().dblclick({ timeout: 15000 });
  } catch { log(`  ⚠ ไม่พบแถวใน #${gridId} — ข้าม ${what}`); return null; }
  const fresh = await waitNew;
  if (fresh) { await fresh.waitForLoadState("domcontentloaded").catch(() => { /* */ }); await sleep(5000); return fresh; }
  await sleep(5000);
  return current;
}

try {
  await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await login(page, cfg.username, cfg.password);

  // ── หน้า 2/3 ก่อน: ต้องเปิดจากใบจริง (ใช้แท็บเดิมที่ login แล้ว) ──
  if (DECL_NO) {
    await openDeclarationForEdit(page, DECL_NO);
    await sleep(2500);
    await page.click(S.SEL_TAB2);
    await sleep(4000);

    const inv = await openRow(page, "gridExInvoice", "ฟอร์มใบกำกับ");
    if (inv) {
      const d2 = driversFor(2);
      log(`หน้า 2 — ทดลองสลับ ${d2.length} ช่อง`);
      await extractRules(inv, "page2", downloadDir, d2);
      if (inv !== page) await inv.close();       // ปิดโดยไม่ Save
    }
    const item = await openRow(page, "gridExDecDtl", "ฟอร์มรายการสินค้า");
    if (item) {
      const d3 = driversFor(3);
      log(`หน้า 3 — ทดลองสลับ ${d3.length} ช่อง`);
      await extractRules(item, "page3", downloadDir, d3);
      if (item !== page) await item.close();
    }
  }

  // ── หน้า 1: ฟอร์ม "สร้างใบใหม่" (สถานะตั้งต้นสะอาด ไม่มีค่าค้างจากใบเก่า) ──
  await openPortfolioAndAdd(page);
  await sleep(3000);
  const d1 = driversFor(1);
  log(`หน้า 1 — ทดลองสลับ ${d1.length} ช่อง`);
  await extractRules(page, "page1", downloadDir, d1);

  // ── รายชื่อไฟล์ JS ที่ DCTK โหลด (ไว้ไปอ่าน logic ที่ซ่อนในโค้ด) ──
  const scripts = await page.evaluate(() =>
    Array.from(document.querySelectorAll("script[src]")).map((s) => (s as HTMLScriptElement).src));
  await mkdir(path.join(downloadDir, "rules"), { recursive: true });
  await writeFile(path.join(downloadDir, "rules", "scripts.txt"), scripts.join("\n"), "utf-8");
  log(`\n✅ ถอดเงื่อนไขเสร็จ — ไฟล์อยู่ที่ ${path.join(downloadDir, "rules")}`);
  log(`   ไฟล์ JS ของ DCTK ${scripts.length} ไฟล์ (rules/scripts.txt)`);
} catch (e) {
  log(`✗ error: ${e instanceof Error ? e.stack || e.message : String(e)}`);
} finally {
  await browser.close();
}
