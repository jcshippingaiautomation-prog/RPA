// ============================================================
//  Term Factor — ดึง "ตารางเงื่อนไข Incoterms" ตรงจากเซิร์ฟเวอร์กรมฯ
//
//  ที่มาของกฎ: โค้ดในหน้า DCTK เรียก POST {base}Term/GetFactor
//    ส่ง { TermCode } → ได้ factor ของแต่ละช่องค่าใช้จ่ายกลับมา
//    Factor = 0  → DCTK "ปิดช่องนั้น + ล้างค่าเป็น 0"
//    Factor ≠ 0  → กรอกได้
//
//  ดึงครบทุก Incoterms ครั้งเดียว = ได้กฎเป๊ะ ๆ ว่าเงื่อนไขไหนกรอกอะไรได้
//  (แม่นกว่าการเดา และแม่นกว่าการทดลองสลับทีละค่า)
//
//  วิธีรัน:
//    set -a; . ../rpa-web/.env; set +a
//    node dist/term-factor-cli.js
// ============================================================
import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { loadConfig, PROJECT_ROOT } from "./runner.js";
import { login, openPortfolioAndAdd } from "./pages.js";
import { setLogSink, log, sleep } from "./helpers.js";
import { loadFieldRegistry } from "./field-registry.js";

setLogSink(null);

const cfg = await loadConfig();
if (!cfg.url) { console.error("✗ ไม่พบ config.json"); process.exit(1); }

const outDir = path.join(
  cfg.download_dir ? path.resolve(PROJECT_ROOT, cfg.download_dir) : path.join(PROJECT_ROOT, "file download"),
  "rules",
);
await mkdir(outDir, { recursive: true });

// Incoterms ทั้งหมดที่ DCTK มี — อ่านจากทะเบียนช่อง (ตัวเลือกจริงของ _TermCode)
const registry = await loadFieldRegistry();
const termField = registry.find((f) => f.dctkName === "_TermCode" && f.options?.length);
const TERMS = termField?.options.map((o) => o.value || o.text).filter(Boolean) ?? [
  "CFR", "CIF", "CIP", "CPT", "DAP", "DAT", "DDP", "DDU", "EXW", "FAS", "FCA", "FOB",
];
log(`📊 ดึงตารางเงื่อนไข Incoterms ${TERMS.length} แบบ: ${TERMS.join(", ")}`);

const browser = await chromium.launch({ headless: process.env.TERM_HEADLESS !== "0" });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(cfg.default_timeout_ms ?? 30000);

try {
  await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await login(page, cfg.username, cfg.password);
  // เปิดหน้าที่มี $urlBase ประกาศไว้ (ฟอร์มสร้างใบ) เพื่อยิง ajax ด้วย session เดียวกัน
  await openPortfolioAndAdd(page);
  await sleep(2500);

  // ToTermCode = เงื่อนไข "ปลายทาง" ที่ DCTK แปลงราคาไป — ใบขาออกใช้ FOB
  //   ถ้าส่งค่าว่าง เซิร์ฟเวอร์คืน factor คนละชุด (เคยหลงมาแล้ว) → ต้องระบุให้ตรงของจริง
  const TO_TERM = (process.env.TERM_TO ?? "FOB").trim();
  log(`   แปลงราคาไปเป็นเงื่อนไข: ${TO_TERM}`);
  const results = await page.evaluate(async ({ terms, toTerm }: { terms: string[]; toTerm: string }) => {
    const w = window as unknown as { $urlBase?: string; jQuery?: unknown; $?: unknown };
    const base = w.$urlBase || "/DCTK/";
    const out: { term: string; ok: boolean; factors: Record<string, unknown>; error?: string }[] = [];
    for (const t of terms) {
      try {
        const resp = await fetch(base + "Term/GetFactor", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
          body: `ToTermCode=${encodeURIComponent(toTerm)}&TermCode=${encodeURIComponent(t)}`,
          credentials: "same-origin",
        });
        const data = await resp.json();
        out.push({ term: t, ok: Array.isArray(data) && data.length > 0, factors: (data?.[0] ?? {}) as Record<string, unknown> });
      } catch (e) {
        out.push({ term: t, ok: false, factors: {}, error: String(e) });
      }
    }
    return out;
  }, { terms: TERMS, toTerm: TO_TERM });

  // ── แปลง factor → "ช่องไหนกรอกได้/ไม่ได้" ──
  const ROWS: { factor: string; label: string; keys: string[] }[] = [
    { factor: "AmountFactor", label: "ราคา", keys: ["amount", "amount_foreign", "amount_baht", "amount_average_by"] },
    { factor: "ForwardFactor", label: "ค่าขนส่ง", keys: ["forward", "forward_foreign", "forward_baht", "forward_average_by"] },
    { factor: "FreightFactor", label: "ค่าระวาง", keys: ["freight", "freight_foreign", "freight_baht", "freight_average_by"] },
    { factor: "InsuranceFactor", label: "ค่าประกัน", keys: ["insurance", "insurance_foreign", "insurance_baht", "insurance_average_by"] },
    { factor: "PackFactor", label: "ค่าบรรจุ", keys: ["pack", "pack_foreign", "pack_baht", "pack_average_by"] },
    { factor: "InlandFactor", label: "Inland", keys: ["inland", "inland_foreign", "inland_baht", "inland_average_by"] },
    { factor: "LandingFactor", label: "Landing", keys: ["landing", "landing_foreign", "landing_baht", "landing_average_by"] },
    { factor: "Extra1Factor", label: "ค่าใช้จ่ายอื่น 1", keys: ["extra1", "extra1_foreign", "extra1_baht", "extra1_average_by", "extra1_charge_code"] },
    { factor: "Extra2Factor", label: "ค่าใช้จ่ายอื่น 2", keys: ["extra2", "extra2_foreign", "extra2_baht", "extra2_average_by", "extra2_charge_code"] },
  ];

  const table: { term: string; allowed: string[]; blocked: string[]; blockedKeys: string[] }[] = [];
  for (const r of results) {
    if (!r.ok) { log(`  ⚠ ${r.term}: เซิร์ฟเวอร์ไม่คืนข้อมูล`); continue; }
    const allowed: string[] = [], blocked: string[] = [], blockedKeys: string[] = [];
    for (const row of ROWS) {
      const v = Number(r.factors[row.factor] ?? 0);
      if (v === 0) { blocked.push(row.label); blockedKeys.push(...row.keys); }
      else allowed.push(row.label);
    }
    table.push({ term: r.term, allowed, blocked, blockedKeys });
    log(`  ${r.term.padEnd(5)} กรอกได้: ${allowed.join(", ") || "-"}`);
    log(`  ${"".padEnd(5)} ปิด:     ${blocked.join(", ") || "-"}`);
  }

  await writeFile(path.join(outDir, "term-factors.json"),
    JSON.stringify({ toTermCode: TO_TERM, raw: results, table }, null, 1), "utf-8");
  log(`\n✅ เขียน rules/term-factors.json — ${table.length} เงื่อนไข`);
} catch (e) {
  log(`✗ error: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await browser.close();
}
