// ============================================================
//  Dump inline scripts — ดึงโค้ด JS ที่ฝังอยู่ในหน้า DCTK
//
//  ทำไมต้องดึง: logic เงื่อนไขจริงของแต่ละหน้า (ถ้าเลือก A แล้วช่อง B ต้อง…)
//  ไม่ได้อยู่ในไฟล์ .js ภายนอก (cds.min.js เป็นแค่ helper ทั่วไป)
//  แต่อยู่ใน <script> ที่ ASP.NET ฝังมากับหน้า → ต้องอ่านจาก DOM
//
//  วิธีรัน:
//    set -a; . ../rpa-web/.env; set +a
//    DUMP_DECL_NO=DCTK000034914 node dist/dump-inline-cli.js
//
//  อ่านอย่างเดียว — ไม่กรอก ไม่กด Save อะไรทั้งสิ้น
// ============================================================
import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { loadConfig, PROJECT_ROOT } from "./runner.js";
import { login, openPortfolioAndAdd, openDeclarationForEdit } from "./pages.js";
import { setLogSink, log, sleep } from "./helpers.js";
import * as S from "./selectors.js";

setLogSink(null);

const DECL_NO = (process.env.DUMP_DECL_NO ?? "").trim();
const cfg = await loadConfig();
if (!cfg.url) { console.error("✗ ไม่พบ config.json"); process.exit(1); }

const outDir = path.join(
  cfg.download_dir ? path.resolve(PROJECT_ROOT, cfg.download_dir) : path.join(PROJECT_ROOT, "file download"),
  "rules", "inline",
);
await mkdir(outDir, { recursive: true });

/** ดึง <script> ที่ไม่มี src (โค้ดฝังในหน้า) + <script src> */
async function dumpScripts(page: Page, label: string): Promise<void> {
  const data = await page.evaluate(() => {
    const inline: string[] = [];
    const external: string[] = [];
    document.querySelectorAll("script").forEach((s) => {
      const el = s as HTMLScriptElement;
      if (el.src) external.push(el.src);
      else if ((el.textContent || "").trim().length > 40) inline.push(el.textContent || "");
    });
    return { inline, external, url: location.href };
  });
  const body =
    `// ===== ${label} =====\n// URL: ${data.url}\n` +
    `// ไฟล์ภายนอก:\n${data.external.map((u) => "//   " + u).join("\n")}\n\n` +
    data.inline.map((code, i) => `// ---------- inline #${i + 1} ----------\n${code}`).join("\n\n");
  await writeFile(path.join(outDir, `${label}.js`), body, "utf-8");
  const chars = data.inline.reduce((n, c) => n + c.length, 0);
  log(`  ✓ [${label}] inline ${data.inline.length} ก้อน (${Math.round(chars / 1024)} KB) + ภายนอก ${data.external.length} ไฟล์`);
}

const browser = await chromium.launch({ headless: process.env.DUMP_HEADLESS === "1" });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await context.newPage();
page.setDefaultTimeout(cfg.default_timeout_ms ?? 30000);

async function openRow(cur: Page, gridId: string, what: string): Promise<Page | null> {
  const waitNew = context.waitForEvent("page", { timeout: 20000 }).catch(() => null);
  try {
    await cur.locator(`#${gridId} tbody tr[role='row'], #${gridId} tbody tr`).first().dblclick({ timeout: 15000 });
  } catch { log(`  ⚠ ไม่พบแถวใน #${gridId} — ข้าม ${what}`); return null; }
  const fresh = await waitNew;
  if (fresh) { await fresh.waitForLoadState("domcontentloaded").catch(() => { /* */ }); await sleep(5000); return fresh; }
  await sleep(5000);
  return cur;
}

try {
  await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await login(page, cfg.username, cfg.password);

  if (DECL_NO) {
    await openDeclarationForEdit(page, DECL_NO);
    await sleep(2500);
    await dumpScripts(page, "page1-edit");
    await page.click(S.SEL_TAB2);
    await sleep(4000);
    const inv = await openRow(page, "gridExInvoice", "ฟอร์มใบกำกับ");
    if (inv) { await dumpScripts(inv, "page2-invoice"); if (inv !== page) await inv.close(); }
    const item = await openRow(page, "gridExDecDtl", "ฟอร์มรายการสินค้า");
    if (item) { await dumpScripts(item, "page3-item"); if (item !== page) await item.close(); }
  }

  await openPortfolioAndAdd(page);
  await sleep(3000);
  await dumpScripts(page, "page1-create");

  log(`\n✅ ดึงโค้ดเสร็จ — ${outDir}`);
} catch (e) {
  log(`✗ error: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await browser.close();
}
