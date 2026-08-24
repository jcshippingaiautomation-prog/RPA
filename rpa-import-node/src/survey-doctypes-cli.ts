// ============================================================
//  Survey doc types — สำรวจว่า "ชนิดเอกสารใบขน" แต่ละแบบ ทำให้ฟอร์มต่างกันไหม
//
//  DCTK มีชนิดเอกสาร 10 แบบ (ใบขนขาออก · ผ่านแดน · ของเร่งด่วน · โอนย้าย ฯลฯ)
//  ที่ผ่านมาเราสำรวจแค่ "1-ใบขนสินค้าขาออก" แบบเดียว
//  ถ้าชนิดอื่นเปิด/ปิดช่องต่างกัน ระบบเราจะขาดช่องหรือขาดกฎเมื่อต้องทำใบชนิดนั้น
//
//  วิธี: เปิดฟอร์มสร้างใบใหม่ → เปลี่ยนชนิดเอกสารทีละแบบ → เทียบสถานะทุกช่องกับแบบที่ 1
//
//  วิธีรัน:
//    set -a; . ../rpa-web/.env; set +a
//    node dist/survey-doctypes-cli.js
// ============================================================
import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { loadConfig, PROJECT_ROOT } from "./runner.js";
import { login, openPortfolioAndAdd } from "./pages.js";
import { setLogSink, log, sleep, kendoDropdownListPick } from "./helpers.js";
import { loadFieldRegistry, type FieldDef } from "./field-registry.js";

setLogSink(null);

const cfg = await loadConfig();
if (!cfg.url) { console.error("✗ ไม่พบ config.json"); process.exit(1); }

const outDir = path.join(
  cfg.download_dir ? path.resolve(PROJECT_ROOT, cfg.download_dir) : path.join(PROJECT_ROOT, "file download"),
  "rules",
);
await mkdir(outDir, { recursive: true });

const registry: FieldDef[] = await loadFieldRegistry();
const docTypeField = registry.find((f) => f.dctkName === "ExDecDocType");
const TYPES = (docTypeField?.options ?? []).map((o) => ({ value: o.value || o.text, label: o.text || o.value }));
if (!TYPES.length) { console.error("✗ ไม่มีรายการชนิดเอกสารใน registry"); process.exit(1); }
log(`📄 สำรวจชนิดเอกสารใบขน ${TYPES.length} แบบ`);

interface FieldState { disabled: boolean; readonly: boolean; required: boolean; visible: boolean }

function snapshot(): { [name: string]: FieldState } {
  const out: { [name: string]: FieldState } = {};
  document.querySelectorAll("input, select, textarea").forEach((el) => {
    const name = el.getAttribute("name") || (el as HTMLElement).id;
    if (!name || out[name]) return;
    if (el.closest(".k-grid")) return;                 // ข้ามช่อง filter ในตาราง
    const r = (el as HTMLElement).getBoundingClientRect();
    const st = getComputedStyle(el as HTMLElement);
    const cls = (el.getAttribute("class") || "") + " " + (el.closest(".k-widget")?.getAttribute("class") || "");
    out[name] = {
      disabled: (el as HTMLInputElement).disabled === true,
      readonly: (el as HTMLInputElement).readOnly === true,
      required: /-required\b/.test(cls),
      visible: r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden",
    };
  });
  return out;
}

const browser = await chromium.launch({ headless: process.env.DOCTYPE_HEADLESS !== "0" });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
let page = await context.newPage();
page.setDefaultTimeout(cfg.default_timeout_ms ?? 30000);

/** เปิดฟอร์มสร้างใบใหม่สะอาด ๆ (แท็บใหม่ + login ใหม่ — วิธีที่ทนที่สุดกับ DCTK) */
async function freshForm(): Promise<Page> {
  const p = await context.newPage();
  p.setDefaultTimeout(cfg.default_timeout_ms ?? 30000);
  await p.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await sleep(1000);
  await login(p, cfg.username, cfg.password);
  await openPortfolioAndAdd(p);
  await sleep(2500);
  return p;
}

interface TypeResult {
  value: string; label: string;
  fieldCount: number;
  diffVsDefault: { field: string; change: string }[];
  error?: string;
}

const results: TypeResult[] = [];
try {
  // ── ฐานเปรียบเทียบ: ชนิด "1-ใบขนสินค้าขาออก" (ที่เราสำรวจมาแล้ว) ──
  page = await freshForm();
  const baseline = await page.evaluate(snapshot);
  log(`ฐานเปรียบเทียบ (ค่าตั้งต้นของฟอร์ม): ${Object.keys(baseline).length} ช่อง`);
  await page.close();

  for (const t of TYPES) {
    const p = await freshForm();
    const r: TypeResult = { value: t.value, label: t.label, fieldCount: 0, diffVsDefault: [] };
    try {
      await kendoDropdownListPick(p, "#ExDecDocType", t.value);
      await sleep(2500);                                // ให้ JS ของ DCTK ปรับฟอร์ม
      const after = await p.evaluate(snapshot);
      r.fieldCount = Object.keys(after).length;
      for (const [name, b] of Object.entries(baseline)) {
        const a = after[name];
        if (!a) { r.diffVsDefault.push({ field: name, change: "หายไปจากฟอร์ม" }); continue; }
        if (b.disabled !== a.disabled) r.diffVsDefault.push({ field: name, change: a.disabled ? "ถูกปิด" : "เปิดให้กรอก" });
        if (b.readonly !== a.readonly) r.diffVsDefault.push({ field: name, change: a.readonly ? "อ่านอย่างเดียว" : "แก้ไขได้" });
        if (b.required !== a.required) r.diffVsDefault.push({ field: name, change: a.required ? "กลายเป็นบังคับ" : "เลิกบังคับ" });
        if (b.visible !== a.visible) r.diffVsDefault.push({ field: name, change: a.visible ? "แสดงขึ้นมา" : "ถูกซ่อน" });
      }
      for (const name of Object.keys(after)) {
        if (!baseline[name]) r.diffVsDefault.push({ field: name, change: "เป็นช่องใหม่ที่ไม่มีในแบบตั้งต้น" });
      }
    } catch (e) {
      r.error = e instanceof Error ? e.message.slice(0, 120) : String(e);
    }
    results.push(r);
    log(`  ${t.label.slice(0, 38).padEnd(40)} ${r.error ? "✗ " + r.error : `${r.fieldCount} ช่อง · ต่างจากตั้งต้น ${r.diffVsDefault.length} จุด`}`);
    for (const d of r.diffVsDefault.slice(0, 8)) log(`       → ${d.field}: ${d.change}`);
    await p.close();
  }

  await writeFile(path.join(outDir, "doc-types.json"), JSON.stringify(results, null, 1), "utf-8");
  const changed = results.filter((r) => r.diffVsDefault.length);
  log(`\n✅ เขียน rules/doc-types.json — ชนิดที่ทำให้ฟอร์มเปลี่ยน ${changed.length}/${results.length}`);
} catch (e) {
  log(`✗ error: ${e instanceof Error ? e.message : String(e)}`);
  await writeFile(path.join(outDir, "doc-types.json"), JSON.stringify(results, null, 1), "utf-8").catch(() => { /* */ });
} finally {
  await browser.close();
}
