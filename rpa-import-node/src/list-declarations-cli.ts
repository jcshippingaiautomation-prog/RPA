// ============================================================
//  List declarations — ไล่ดูใบขนที่มีอยู่แล้วใน DCTK
//
//  ใช้เลือกว่าจะดึงใบไหนมาทำ Master (ดู pull-master-cli.ts)
//  อ่านอย่างเดียว ไม่แตะปุ่มบันทึกใด ๆ
//
//  วิธีรัน:
//    set -a; . ../rpa-web/.env; set +a
//    node dist/list-declarations-cli.js                  # 50 ใบล่าสุด
//    LIST_CUSTOMER=THANAKORN node dist/list-declarations-cli.js
//    LIST_LIMIT=200 LIST_JSON=1 node dist/list-declarations-cli.js
// ============================================================
import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { loadConfig, PROJECT_ROOT } from "./runner.js";
import { login } from "./pages.js";
import { setLogSink, log, sleep } from "./helpers.js";
import * as S from "./selectors.js";

setLogSink(null);

const WANT_CUSTOMER = (process.env.LIST_CUSTOMER ?? "").trim().toUpperCase();
const LIMIT = Number(process.env.LIST_LIMIT ?? 50);

const cfg = await loadConfig();
if (!cfg.url) { console.error("✗ ไม่พบ config.json"); process.exit(1); }

const outDir = path.join(
  cfg.download_dir ? path.resolve(PROJECT_ROOT, cfg.download_dir) : path.join(PROJECT_ROOT, "file download"),
  "survey",
);
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: process.env.LIST_HEADLESS !== "0" });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await context.newPage();
page.setDefaultTimeout(cfg.default_timeout_ms ?? 30000);

interface Row {
  customer: string; invoice: string; declarationNo: string; reference: string;
  departure: string; status: string; vessel: string; destCountry: string;
  fobCurrency: string; fobForeign: string; items: string;
}

try {
  await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await login(page, cfg.username, cfg.password);
  log("→ เปิดหน้ารายการใบขน");
  await page.click(S.SEL_PORTFOLIO_MENU);
  await sleep(6000);

  // ขยายจำนวนแถวต่อหน้าให้มากที่สุด แล้วไล่ทีละหน้าจนครบ
  //   (ค่าปริยาย 30 แถว/หน้า — ลูกค้าบางรายอยู่หน้าหลัง ๆ)
  const readPage = async () => await page.evaluate(() => {
    const w = window as unknown as { $?: (s: string) => { data: (k: string) => { dataSource?: { view: () => unknown[] } } } };
    const grid = w.$ ? w.$("#grid").data("kendoGrid") : null;
    const view = grid?.dataSource?.view?.() ?? [];
    const val = (o: Record<string, unknown>, k: string) => {
      const v = o[k];
      if (v == null) return "";
      if (typeof v === "object" && v instanceof Date) return v.toISOString().slice(0, 10);
      return String(v);
    };
    return view.map((r) => {
      const o = r as Record<string, unknown>;
      return {
        customer: val(o, "CmpNameThai"),
        invoice: val(o, "InvoiceNoText"),
        declarationNo: val(o, "DeclarationNo"),
        reference: val(o, "ReferenceNo"),
        departure: val(o, "DepartureDate"),
        status: val(o, "DeclarationStatusName"),
        vessel: val(o, "VesselName"),
        destCountry: val(o, "DestCountryCode"),
        fobCurrency: val(o, "TotalFobCurrencyCode"),
        fobForeign: val(o, "TotalFobForeign"),
        items: val(o, "TotalPackage"),
      };
    });
  }).catch(() => [] as Row[]);

  // ไล่ทุกหน้าของตาราง (Kendo dataSource) — หยุดเมื่อหมดหน้าหรือชนเพดาน
  const rows: Row[] = [];
  const seen = new Set<string>();
  const MAX_PAGES = Number(process.env.LIST_PAGES ?? 12);
  for (let p = 1; p <= MAX_PAGES; p++) {
    const batch = await readPage();
    let fresh = 0;
    for (const r of batch) {
      const k = `${r.reference}|${r.invoice}`;
      if (seen.has(k)) continue;
      seen.add(k); rows.push(r); fresh++;
    }
    log(`   หน้า ${p}: อ่านได้ ${batch.length} แถว (ใหม่ ${fresh})`);
    if (!batch.length) break;
    const hasNext = await page.evaluate(() => {
      // Kendo: dataSource.page() อ่านหน้าปัจจุบัน · page(n) สั่งเปลี่ยนหน้า (ฟังก์ชันเดียวกัน)
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const jq = (window as any).$;
      const ds = jq ? jq("#grid").data("kendoGrid")?.dataSource : null;
      if (!ds || typeof ds.page !== "function" || typeof ds.totalPages !== "function") return false;
      const cur: number = ds.page(), total: number = ds.totalPages();
      if (cur >= total) return false;
      ds.page(cur + 1);
      return true;
    }).catch(() => false);
    if (!hasNext) break;
    await sleep(3500);
  }

  if (!rows.length) {
    log("✗ อ่านรายการไม่ได้ — DCTK อาจเปลี่ยนโครงตาราง (ตรวจ #grid)");
  } else {
    const filtered = (WANT_CUSTOMER
      ? rows.filter((r) => (r.customer || "").toUpperCase().includes(WANT_CUSTOMER))
      : rows).slice(0, LIMIT);

    log(`\nพบ ${rows.length} ใบในหน้านี้${WANT_CUSTOMER ? ` · ตรงกับ "${WANT_CUSTOMER}" ${filtered.length} ใบ` : ""}\n`);
    log(`${"เลขใบกำกับ".padEnd(22)}${"วันที่ส่งออก".padEnd(14)}${"ปลายทาง".padEnd(9)}${"มูลค่า".padEnd(18)}ผู้ส่งออก`);
    log("─".repeat(110));
    for (const r of filtered) {
      const money = r.fobCurrency ? `${r.fobCurrency} ${r.fobForeign}` : "";
      log(`${r.invoice.padEnd(22)}${r.departure.padEnd(14)}${r.destCountry.padEnd(9)}${money.padEnd(18)}${r.customer.slice(0, 40)}`);
    }
    log("─".repeat(110));
    log(`\nดึงใบไหนมาทำ Master ก็ใช้เลขใบกำกับข้างบน:`);
    if (filtered[0]) {
      log(`   PULL_INVOICE="${filtered[0].invoice}" PULL_CUSTOMER=<คำค้นบริษัท> node dist/pull-master-cli.js`);
    }

    if (process.env.LIST_JSON === "1") {
      const f = path.join(outDir, "declarations-list.json");
      await writeFile(f, JSON.stringify(filtered, null, 1), "utf-8");
      log(`\n✅ เขียน ${f}`);
    }
  }
} catch (e) {
  log(`✗ error: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await browser.close();
}
