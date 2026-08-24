// ============================================================
//  Probe calc — ดึง "รายงานตรวจสอบค่าคำนวน" ของ DCTK
//
//  ปุ่ม "ตรวจสอบรายละเอียดค่าคำนวนต่าง ๆ" บนหน้าใบขน เรียก
//    GET  ExDec/ExCheckDiff?referenceNo=...   → หน้า HTML รายงานส่วนต่าง
//    POST ExInvoice/CheckSumInvoice_Detail    → {Result, Err} เทียบผลรวมใบกำกับ vs รายการ
//
//  นี่คือกฎ "ตอน submit จริง" ที่การอ่าน data-val ไม่เห็น
//  ดึงมาแล้ว → รู้ว่ากรมฯ เทียบอะไรกับอะไร ระบบเราจะได้เทียบแบบเดียวกัน
//
//  วิธีรัน:
//    set -a; . ../rpa-web/.env; set +a
//    CALC_DECL_NO=DCTK000034914 node dist/probe-calc-cli.js
// ============================================================
import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { loadConfig, PROJECT_ROOT } from "./runner.js";
import { login, openDeclarationForEdit } from "./pages.js";
import { setLogSink, log, sleep } from "./helpers.js";

setLogSink(null);

const DECL_NO = (process.env.CALC_DECL_NO ?? "DCTK000034914").trim();
const cfg = await loadConfig();
if (!cfg.url) { console.error("✗ ไม่พบ config.json"); process.exit(1); }

const outDir = path.join(
  cfg.download_dir ? path.resolve(PROJECT_ROOT, cfg.download_dir) : path.join(PROJECT_ROOT, "file download"),
  "rules",
);
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: process.env.CALC_HEADLESS !== "0" });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(cfg.default_timeout_ms ?? 30000);

try {
  await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await login(page, cfg.username, cfg.password);
  await openDeclarationForEdit(page, DECL_NO);
  await sleep(2500);

  const refNo = await page.evaluate(() =>
    (document.getElementById("ReferenceNo") as HTMLInputElement | null)?.value ?? "");
  log(`เลขที่อ้างอิงของใบนี้: ${refNo}`);

  // ── 1) รายงานตรวจสอบค่าคำนวน (HTML) ──
  const report = await page.evaluate(async (ref: string) => {
    const w = window as unknown as { $urlBase?: string };
    try {
      const resp = await fetch(`${w.$urlBase || "/DCTK/"}ExDec/ExCheckDiff?referenceNo=${encodeURIComponent(ref)}`, {
        credentials: "same-origin",
      });
      return await resp.text();
    } catch (e) { return "ERROR " + String(e); }
  }, refNo);

  // ดึงเฉพาะ "หัวตาราง + แถวข้อมูล" ออกมาให้อ่านรู้เรื่อง
  const parsed = await page.evaluate((html: string) => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const heads = Array.from(doc.querySelectorAll("th")).map((t) => (t as HTMLElement).innerText.replace(/\s+/g, " ").trim()).filter(Boolean);
    const rows = Array.from(doc.querySelectorAll("tbody tr")).slice(0, 40).map((tr) =>
      Array.from(tr.querySelectorAll("td")).map((td) => (td as HTMLElement).innerText.replace(/\s+/g, " ").trim()));
    const labels = Array.from(doc.querySelectorAll("label, legend, h1, h2, h3, .control-label"))
      .map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").trim())
      .filter((t) => t && t.length < 90);
    return { heads: [...new Set(heads)], rows: rows.filter((r) => r.length), labels: [...new Set(labels)].slice(0, 40) };
  }, report);

  log(`\n📊 รายงานตรวจสอบค่าคำนวน — คอลัมน์ที่กรมฯ เทียบ:`);
  for (const h of parsed.heads) log(`   • ${h}`);
  if (parsed.labels.length) {
    log(`   หัวข้อในรายงาน:`);
    for (const l of parsed.labels.slice(0, 15)) log(`     - ${l}`);
  }
  log(`   แถวข้อมูล ${parsed.rows.length} แถว (ตัวอย่าง 3 แถวแรก):`);
  for (const r of parsed.rows.slice(0, 3)) log(`     ${r.join(" | ").slice(0, 160)}`);

  // ── 2) เทียบผลรวมใบกำกับ vs ส่วนรายละเอียด ──
  const sum = await page.evaluate(async (ref: string) => {
    const w = window as unknown as { $urlBase?: string };
    try {
      const resp = await fetch(`${w.$urlBase || "/DCTK/"}ExInvoice/CheckSumInvoice_Detail`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: "referenceNo=" + encodeURIComponent(ref),
        credentials: "same-origin",
      });
      return await resp.text();
    } catch (e) { return "ERROR " + String(e); }
  }, refNo);
  log(`\n🧮 เทียบผลรวมใบกำกับ vs รายการ: ${sum.replace(/\s+/g, " ").slice(0, 300)}`);

  // ── 3) ลองเลขที่อ้างอิงที่ไม่มีจริง เพื่อดูรูปแบบข้อความ error ──
  const sumBad = await page.evaluate(async () => {
    const w = window as unknown as { $urlBase?: string };
    try {
      const resp = await fetch(`${w.$urlBase || "/DCTK/"}ExInvoice/CheckSumInvoice_Detail`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: "referenceNo=DCTK000000001", credentials: "same-origin",
      });
      return await resp.text();
    } catch (e) { return "ERROR " + String(e); }
  });
  log(`   ถ้าเลขอ้างอิงไม่มีจริง: ${sumBad.replace(/\s+/g, " ").slice(0, 200)}`);

  await writeFile(path.join(outDir, "calc-check.json"),
    JSON.stringify({ referenceNo: refNo, parsed, sumCheck: sum, sumCheckBadRef: sumBad, rawLength: report.length }, null, 1), "utf-8");
  await writeFile(path.join(outDir, "calc-check.html"), report, "utf-8");
  log(`\n✅ เขียน rules/calc-check.json + calc-check.html`);
} catch (e) {
  log(`✗ error: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await browser.close();
}
