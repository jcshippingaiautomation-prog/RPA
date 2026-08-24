// ============================================================
//  Survey portfolio — สำรวจ "หน้ารายการใบขน" (หน้าที่ใช้ค้นใบเดิม)
//
//  ทำไมต้องมี: ตามที่ตกลงในที่ประชุม เราต้องเอา "เลขที่ใบกำกับสินค้า"
//  ที่ลูกค้าส่งมา ไปค้นใบเดิมใน DCTK เพื่อดึงข้อมูลมาทำ Master
//  แต่โค้ดเดิมค้นจากคอลัมน์ "เลขที่ใบขนฯ" ซึ่งคนละคอลัมน์
//  → ต้องรู้ว่าตารางนี้มีคอลัมน์อะไร และช่องกรองของแต่ละคอลัมน์อยู่ตรงไหน
//
//  วิธีรัน:
//    set -a; . ../rpa-web/.env; set +a
//    node dist/survey-portfolio-cli.js
// ============================================================
import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { loadConfig, PROJECT_ROOT } from "./runner.js";
import { login } from "./pages.js";
import { setLogSink, log, sleep } from "./helpers.js";
import * as S from "./selectors.js";

setLogSink(null);

const cfg = await loadConfig();
if (!cfg.url) { console.error("✗ ไม่พบ config.json"); process.exit(1); }

const outDir = path.join(
  cfg.download_dir ? path.resolve(PROJECT_ROOT, cfg.download_dir) : path.join(PROJECT_ROOT, "file download"),
  "survey",
);
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: process.env.PORTFOLIO_HEADLESS !== "0" });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await context.newPage();
page.setDefaultTimeout(cfg.default_timeout_ms ?? 30000);

try {
  await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await login(page, cfg.username, cfg.password);
  log("→ เปิดหน้ารายการใบขน");
  await page.click(S.SEL_PORTFOLIO_MENU);
  await sleep(6000);

  // ── คอลัมน์ + ช่องกรองของตาราง ──
  const info = await page.evaluate(() => {
    const grids = Array.from(document.querySelectorAll(".k-grid")).map((g) => ({
      id: (g as HTMLElement).id || "",
      rows: g.querySelectorAll("tbody tr").length,
    })).filter((g) => g.id);

    // หา grid หลัก = ตัวที่มีแถวเยอะสุด
    const main = grids.sort((a, b) => b.rows - a.rows)[0];
    const root = main ? document.getElementById(main.id) : document.querySelector(".k-grid");
    if (!root) return { grids, columns: [], filters: [], mainGridId: "" };

    const columns = Array.from(root.querySelectorAll("thead th")).map((th, i) => ({
      index: i,
      field: th.getAttribute("data-field") || "",
      title: (th as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
    }));

    // ช่องกรองใต้หัวตาราง — ผูกกับคอลัมน์ด้วย data-field ของ th แม่
    const filters = Array.from(root.querySelectorAll("tr.k-filter-row th, .k-filtercell")).map((th, i) => {
      const inp = th.querySelector("input:not([type=hidden])") as HTMLInputElement | null;
      const parentTh = th.closest("th");
      return {
        index: i,
        field: parentTh?.getAttribute("data-field") || th.getAttribute("data-field") || "",
        hasInput: !!inp,
        inputName: inp?.getAttribute("name") || "",
        inputId: inp?.id || "",
        ariaLabel: inp?.getAttribute("aria-label") || inp?.getAttribute("title") || "",
      };
    });

    return { grids, mainGridId: main?.id ?? "", columns, filters };
  });

  log(`  ตารางที่พบ: ${info.grids.map((g) => `${g.id}(${g.rows} แถว)`).join(", ")}`);
  log(`  ตารางหลัก: #${info.mainGridId}`);
  log(`\n  คอลัมน์ในตาราง (${info.columns.length}):`);
  for (const c of info.columns) {
    if (!c.title && !c.field) continue;
    log(`     [${String(c.index).padStart(2)}] field="${c.field}" · "${c.title.slice(0, 40)}"`);
  }
  const withInput = info.filters.filter((f) => f.hasInput);
  log(`\n  ช่องกรอง (${withInput.length}):`);
  for (const f of withInput) log(`     field="${f.field}" name="${f.inputName}" id="${f.inputId}"`);

  // ── ทดลองกรองด้วยคอลัมน์ "เลขที่ใบกำกับ" จริง ──
  const invCol = info.columns.find((c) => /ใบกำกับ/.test(c.title) || /InvoiceNo/i.test(c.field));
  if (invCol) {
    log(`\n  ✓ คอลัมน์ "เลขที่ใบกำกับ" = index ${invCol.index} · field="${invCol.field}"`);
    const sel = invCol.field
      ? `#${info.mainGridId} th[data-field="${invCol.field}"] input`
      : `#${info.mainGridId} tr.k-filter-row th:nth-child(${invCol.index + 1}) input`;
    log(`     selector ที่ใช้กรอง: ${sel}`);
    try {
      const box = page.locator(sel).first();
      await box.waitFor({ state: "visible", timeout: 10000 });
      await box.click();
      await box.fill("DKN");
      await page.keyboard.press("Enter");
      await sleep(4000);
      const rows = await page.locator(`#${info.mainGridId} tbody tr`).count();
      log(`     ทดลองกรอง "DKN" → เหลือ ${rows} แถว ✓`);
    } catch (e) {
      log(`     ⚠ ทดลองกรองไม่สำเร็จ: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`);
    }
  } else {
    log(`\n  ⚠ ไม่พบคอลัมน์ "เลขที่ใบกำกับ" — ดูรายการคอลัมน์ด้านบน`);
  }

  await page.screenshot({ path: path.join(outDir, "portfolio.png"), fullPage: true }).catch(() => { /* */ });
  await writeFile(path.join(outDir, "portfolio-grid.json"), JSON.stringify(info, null, 1), "utf-8");
  log(`\n✅ เขียน survey/portfolio-grid.json + portfolio.png`);
} catch (e) {
  log(`✗ error: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await browser.close();
}
