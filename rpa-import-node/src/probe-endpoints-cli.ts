// ============================================================
//  Probe endpoints — ยิงทดลอง "ปลายทางตรวจสอบ" ของ DCTK
//  เพื่อหากฎฝั่งเซิร์ฟเวอร์ที่ทำให้ "บันทึกไม่ผ่าน"
//
//  ปลายทางที่ยิง (พารามิเตอร์ยืนยันจากโค้ดในหน้า):
//    ExInvoice/CheckValidateSave        {referenceNo, purCountryCode, invoiceNo, invoiceDate, cmpTaxNo, departureDate}
//      → คืน { Msg } — ถ้า Msg ไม่ว่าง = DCTK จะถามยืนยันก่อนบันทึก (คือกฎที่เราอยากรู้)
//    ExInvoice/CheckSumInvoice_Detail   {referenceNo}
//      → ตรวจผลรวมใบกำกับ vs ส่วนรายละเอียด
//    ExchangeRate/GetExchangeRateByCurrencyCode {CurrencyCode, referenceNo, isExport}
//      → อัตราแลกเปลี่ยนที่กรมฯ ใช้ (ได้ตารางสกุลเงินที่รองรับด้วย)
//
//  ⚠ ทั้งหมดเป็นการ "ถาม" ไม่ใช่ "บันทึก" — ไม่แก้ข้อมูลใน DCTK
//
//  วิธีรัน:
//    set -a; . ../rpa-web/.env; set +a
//    PROBE_DECL_NO=DCTK000034914 node dist/probe-endpoints-cli.js
// ============================================================
import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { loadConfig, PROJECT_ROOT } from "./runner.js";
import { login, openDeclarationForEdit } from "./pages.js";
import { setLogSink, log, sleep } from "./helpers.js";
import * as S from "./selectors.js";

setLogSink(null);

const DECL_NO = (process.env.PROBE_DECL_NO ?? "DCTK000034914").trim();
const cfg = await loadConfig();
if (!cfg.url) { console.error("✗ ไม่พบ config.json"); process.exit(1); }

const outDir = path.join(
  cfg.download_dir ? path.resolve(PROJECT_ROOT, cfg.download_dir) : path.join(PROJECT_ROOT, "file download"),
  "rules",
);
await mkdir(outDir, { recursive: true });

interface Probe { name: string; params: Record<string, string>; msg: string; raw: string }

const browser = await chromium.launch({ headless: process.env.PROBE_HEADLESS !== "0" });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(cfg.default_timeout_ms ?? 30000);

async function openRow(cur: Page, gridId: string): Promise<Page | null> {
  const waitNew = context.waitForEvent("page", { timeout: 20000 }).catch(() => null);
  try {
    await cur.locator(`#${gridId} tbody tr[role='row'], #${gridId} tbody tr`).first().dblclick({ timeout: 15000 });
  } catch { return null; }
  const fresh = await waitNew;
  if (fresh) { await fresh.waitForLoadState("domcontentloaded").catch(() => { /* */ }); await sleep(5000); return fresh; }
  await sleep(5000);
  return cur;
}

try {
  await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await login(page, cfg.username, cfg.password);
  await openDeclarationForEdit(page, DECL_NO);
  await sleep(2500);
  await page.click(S.SEL_TAB2);
  await sleep(4000);
  const inv = await openRow(page, "gridExInvoice");
  if (!inv) throw new Error("เปิดฟอร์มใบกำกับไม่ได้");

  // ── อ่านค่าตั้งต้นที่ "ถูกต้องอยู่แล้ว" จากใบจริง เพื่อใช้เป็นฐานเปรียบเทียบ ──
  const base = await inv.evaluate(() => {
    const v = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value ?? "";
    return {
      referenceNo: v("ReferenceNo"),
      purCountryCode: v("PurCountryCode"),
      invoiceNo: v("InvoiceNo"),
      invoiceDate: v("InvoiceDate"),
      cmpTaxNo: v("CmpTaxNo"),
      departureDate: v("DepartureDate"),
    };
  });
  log(`ค่าตั้งต้นจากใบจริง: ${JSON.stringify(base)}`);

  // ── สร้างชุดทดลอง: เปลี่ยนทีละอย่างจากค่าที่ถูกต้อง ──
  const cases: { name: string; patch: Partial<typeof base> }[] = [
    { name: "ค่าถูกต้องทั้งหมด (ฐานเปรียบเทียบ)", patch: {} },
    { name: "เลขที่ใบกำกับฯ ว่าง", patch: { invoiceNo: "" } },
    { name: "วันที่ใบกำกับฯ ว่าง", patch: { invoiceDate: "" } },
    { name: "รหัสประเทศผู้ซื้อ ว่าง", patch: { purCountryCode: "" } },
    { name: "เลขผู้เสียภาษี ว่าง", patch: { cmpTaxNo: "" } },
    { name: "วันที่ส่งออก ว่าง", patch: { departureDate: "" } },
    { name: "รหัสประเทศไม่มีจริง (ZZ)", patch: { purCountryCode: "ZZ" } },
    { name: "รหัสประเทศตัวเดียว (V)", patch: { purCountryCode: "V" } },
    { name: "เลขผู้เสียภาษีมั่ว", patch: { cmpTaxNo: "9999999999999" } },
    { name: "วันที่ใบกำกับ หลัง วันที่ส่งออก", patch: { invoiceDate: "31/12/2030" } },
    { name: "วันที่ใบกำกับ เก่ามาก (ปี 2000)", patch: { invoiceDate: "01/01/2000" } },
    { name: "วันที่ส่งออก ก่อน วันที่ใบกำกับ", patch: { departureDate: "01/01/2000" } },
    { name: "เลขใบกำกับซ้ำกับใบเดิม", patch: {} },   // ใช้ค่าเดิม = ซ้ำแน่นอน
    { name: "เลขใบกำกับใหม่ไม่ซ้ำ", patch: { invoiceNo: "PROBE-TEST-9999" } },
    { name: "เลขใบกำกับยาว 40 ตัว", patch: { invoiceNo: "X".repeat(40) } },
    { name: "เลขที่อ้างอิงมั่ว", patch: { referenceNo: "DCTK000000001" } },
  ];

  const results: Probe[] = [];
  for (const c of cases) {
    const params = { ...base, ...c.patch };
    const r = await inv.evaluate(async (p: Record<string, string>) => {
      const w = window as unknown as { $urlBase?: string };
      const body = new URLSearchParams(p as Record<string, string>).toString();
      try {
        const resp = await fetch((w.$urlBase || "/DCTK/") + "ExInvoice/CheckValidateSave", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
          body, credentials: "same-origin",
        });
        const txt = await resp.text();
        try { const j = JSON.parse(txt); return { msg: String(j?.Msg ?? ""), raw: txt.slice(0, 400) }; }
        catch { return { msg: "", raw: txt.slice(0, 400) }; }
      } catch (e) { return { msg: "", raw: "ERROR " + String(e) }; }
    }, params as Record<string, string>);
    results.push({ name: c.name, params, msg: r.msg, raw: r.raw });
    const shown = r.msg ? r.msg.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "(ผ่าน — ไม่มีข้อความ)";
    log(`  ${c.name.padEnd(34)} → ${shown.slice(0, 110)}`);
    await sleep(300);
  }

  // ── ผลรวมใบกำกับ vs ส่วนรายละเอียด ──
  const sumCheck = await inv.evaluate(async (ref: string) => {
    const w = window as unknown as { $urlBase?: string };
    try {
      const resp = await fetch((w.$urlBase || "/DCTK/") + "ExInvoice/CheckSumInvoice_Detail", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: "referenceNo=" + encodeURIComponent(ref), credentials: "same-origin",
      });
      return (await resp.text()).slice(0, 600);
    } catch (e) { return "ERROR " + String(e); }
  }, base.referenceNo);
  log(`\n  ตรวจผลรวมใบกำกับ vs รายการ: ${sumCheck.replace(/\s+/g, " ").slice(0, 220)}`);

  // ── ตารางอัตราแลกเปลี่ยนที่กรมฯ ใช้ ──
  const CURRENCIES = ["USD", "EUR", "JPY", "CNY", "THB", "SGD", "GBP", "AUD", "HKD", "KRW", "VND", "MYR", "XXX"];
  const rates = await inv.evaluate(async ({ curs, ref }: { curs: string[]; ref: string }) => {
    const w = window as unknown as { $urlBase?: string };
    const out: { cur: string; body: string }[] = [];
    for (const c of curs) {
      try {
        const resp = await fetch((w.$urlBase || "/DCTK/") + "ExchangeRate/GetExchangeRateByCurrencyCode", {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
          body: `CurrencyCode=${encodeURIComponent(c)}&referenceNo=${encodeURIComponent(ref)}&isExport=true`,
          credentials: "same-origin",
        });
        out.push({ cur: c, body: (await resp.text()).slice(0, 200) });
      } catch (e) { out.push({ cur: c, body: "ERROR " + String(e) }); }
    }
    return out;
  }, { curs: CURRENCIES, ref: base.referenceNo });
  log(`\n  อัตราแลกเปลี่ยน (${rates.length} สกุล):`);
  for (const r of rates) log(`     ${r.cur}: ${r.body.replace(/\s+/g, " ").slice(0, 90)}`);

  await writeFile(path.join(outDir, "endpoint-probes.json"),
    JSON.stringify({ baseline: base, checkValidateSave: results, sumCheck, exchangeRates: rates }, null, 1), "utf-8");
  log(`\n✅ เขียน rules/endpoint-probes.json`);
} catch (e) {
  log(`✗ error: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await browser.close();
}
