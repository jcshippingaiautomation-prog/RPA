// ============================================================
//  Combo lists — ดึง "รายการค่าที่ถูกต้อง" ของช่องที่ค้นจากเซิร์ฟเวอร์กรมฯ
//
//  ทำไมต้องมี: ช่องพวกนี้ (หน่วยปริมาณ · สกุลเงิน · ประเทศ · ท่าเรือ · พิกัด)
//  ต้องเลือกจากรายการของกรมฯ เท่านั้น ถ้ากรอกค่าที่ไม่มีในรายการ RPA จะ
//  "ค้นไม่เจอ" แล้วแถวนั้นล้ม (บั๊กที่เจอบ่อยที่สุดของระบบ)
//  ได้รายการมาแล้ว → ระบบเราตรวจได้ตั้งแต่ในเว็บเรา ก่อนส่งไปกรอกจริง
//
//  วิธีทำ: คลิกช่อง → รอ popup ของ Kendo → อ่านรายการที่ขึ้น
//          ถ้าเปิดเปล่าไม่ขึ้น ลองพิมพ์ตัวอักษรนำ (seed) ทีละตัว
//
//  วิธีรัน:
//    set -a; . ../rpa-web/.env; set +a
//    COMBO_DECL_NO=DCTK000034914 node dist/combo-lists-cli.js
// ============================================================
import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { loadConfig, PROJECT_ROOT } from "./runner.js";
import { login, openPortfolioAndAdd, openDeclarationForEdit } from "./pages.js";
import { setLogSink, log, sleep } from "./helpers.js";
import { loadFieldRegistry, type FieldDef } from "./field-registry.js";
import * as S from "./selectors.js";

setLogSink(null);

const DECL_NO = (process.env.COMBO_DECL_NO ?? "DCTK000034914").trim();
const MAX_ITEMS = Number(process.env.COMBO_MAX ?? 400);
const cfg = await loadConfig();
if (!cfg.url) { console.error("✗ ไม่พบ config.json"); process.exit(1); }

const outDir = path.join(
  cfg.download_dir ? path.resolve(PROJECT_ROOT, cfg.download_dir) : path.join(PROJECT_ROOT, "file download"),
  "rules",
);
await mkdir(outDir, { recursive: true });

const registry: FieldDef[] = await loadFieldRegistry();
/** ช่อง combo ที่ยังไม่มีรายการติดมา = ต้องค้นจากเซิร์ฟเวอร์ */
function serverCombos(page: 1 | 2 | 3) {
  const seen = new Set<string>();
  return registry.filter((f) => {
    if (f.page !== page || f.type !== "combo" || f.computed) return false;
    if (f.options?.length) return false;
    if (seen.has(f.dctkName)) return false;
    seen.add(f.dctkName);
    return true;
  });
}

// ตัวอักษรนำที่ใช้ลองพิมพ์ ถ้าเปิดเปล่าแล้วไม่มีรายการขึ้น
const SEEDS = ["", "A", "C", "K", "T", "0", "1"];
// โหมดกวาดลึก: ไล่ทุกตัวอักษร+ตัวเลข แล้ว "รวมผลทุก seed" → ได้รายการครบ
//   (จำเป็นเพราะ DCTK กรองตามตัวอักษรนำ พิมพ์ A ก็ได้แต่ตัวที่ขึ้นต้น A)
const DEEP_SEEDS = ["", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("")];
const DEEP = process.env.COMBO_DEEP === "1";
// ช่องที่คุ้มค่าจะกวาดลึก — เป็นช่องที่ RPA ต้องเลือกให้ตรงรายการกรมฯ ไม่งั้นแถวล้ม
const DEEP_FIELDS = new Set([
  "InvQuantityUnitCode_input", "QuantityUnitCode_input", "NetWeightUnitCode_input",
  "GrossWeightUnitCode_input", "PackageUnitCode_input",
  "_Amount_input", "PurCountryCode", "DestCountryCode", "OriginCountryCode",
  "ReleasedPort_input", "LoadedPort_input", "ExportTariff_input",
  "PrivilegeCode_input", "TariffSeq_input", "StatisticalCode_input",
]);
const ONLY_PAGE = Number(process.env.COMBO_PAGES ?? 0);   // 0 = ทุกหน้า

interface ComboResult { dctkName: string; label: string; page: number; scope: string; seedUsed: string; items: string[]; note: string; cap: number }

const browser = await chromium.launch({ headless: process.env.COMBO_HEADLESS !== "0" });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
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

/** อ่านรายการที่ popup ของ Kendo แสดงอยู่ตอนนี้ */
async function readPopup(p: Page, inputId: string): Promise<string[]> {
  return p.evaluate((id: string) => {
    const pick = (root: Element | Document) =>
      Array.from(root.querySelectorAll("ul.k-list > li, .k-list-container li, table tr"))
        .map((li) => (li as HTMLElement).innerText.replace(/\s+/g, " ").trim())
        .filter((t) => t && t.length < 200);
    // popup เฉพาะของช่องนี้ (Kendo ตั้ง id เป็น <id>-list)
    const own = document.querySelector(`#${CSS.escape(id)}-list`);
    if (own) {
      const r = pick(own);
      if (r.length) return r;
    }
    // ไม่งั้นเอา popup ที่กำลังเปิดอยู่ (มองเห็น)
    for (const c of Array.from(document.querySelectorAll(".k-animation-container"))) {
      const el = c as HTMLElement;
      if (el.offsetParent === null) continue;
      const r = pick(el);
      if (r.length) return r;
    }
    return [];
  }, inputId);
}

/** เปิด combo หนึ่งช่อง แล้วดึงรายการ (ลอง seed ทีละตัวจนกว่าจะเจอ) */
async function dumpCombo(p: Page, f: FieldDef): Promise<ComboResult> {
  const res: ComboResult = {
    dctkName: f.dctkName, label: f.label, page: f.page, scope: f.scope,
    seedUsed: "", items: [], note: "", cap: MAX_ITEMS,
  };
  const sel = f.selector || `#${f.dctkName}`;
  const loc = p.locator(sel).first();
  if (!(await loc.count().catch(() => 0))) { res.note = "ไม่พบช่องนี้ในหน้า"; return res; }
  if (!(await loc.isVisible().catch(() => false))) { res.note = "ช่องถูกซ่อน"; return res; }
  if (await loc.isDisabled().catch(() => false)) { res.note = "ช่องถูกปิด (กรอกไม่ได้)"; return res; }

  const inputId = await loc.getAttribute("id") ?? "";
  const deep = DEEP && DEEP_FIELDS.has(f.dctkName);
  const seeds = deep ? DEEP_SEEDS : SEEDS;
  const merged = new Set<string>();
  const usedSeeds: string[] = [];
  for (const seed of seeds) {
    try {
      await loc.click({ timeout: 6000 });
      await sleep(400);
      if (seed) {
        await loc.fill("");
        await loc.type(seed, { delay: 60 });
        await sleep(1600);                       // รอเซิร์ฟเวอร์ตอบ
      } else {
        await sleep(1200);
      }
      const items = await readPopup(p, inputId);
      if (items.length) {
        if (deep) {
          const before = merged.size;
          items.forEach((t) => merged.add(t));
          if (merged.size > before) usedSeeds.push(seed || "(เปล่า)");
        } else {
          res.seedUsed = seed || "(เปิดเปล่า)";
          res.items = items.slice(0, MAX_ITEMS);
          break;
        }
      }
    } catch { /* ลอง seed ถัดไป */ }
    finally {
      await p.keyboard.press("Escape").catch(() => { /* */ });
      await sleep(200);
    }
  }
  if (deep) {
    res.items = [...merged].slice(0, MAX_ITEMS);
    res.seedUsed = `กวาดลึก ${usedSeeds.length} seed`;
  }
  // ล้างค่าที่พิมพ์ทดลองทิ้ง (ไม่ให้ค้างในฟอร์ม — เราไม่ได้กด Save อยู่แล้ว)
  try { await loc.fill(""); await p.keyboard.press("Escape"); } catch { /* */ }
  if (!res.items.length) res.note = res.note || "เปิดแล้วไม่มีรายการขึ้น (อาจต้องกรอกช่องอื่นก่อน)";
  return res;
}


/**
 * เขียนผลลงไฟล์แบบ "รวมกับของเดิม" — สำคัญมาก
 * สคริปต์นี้รันทีละหน้าได้ (COMBO_PAGES) ถ้าเขียนทับทั้งไฟล์
 * ผลของหน้าที่รันก่อนหน้าจะหายหมด (เคยพลาดมาแล้ว)
 */
async function saveMerged(file: string, fresh: ComboResult[]): Promise<number> {
  let prev: ComboResult[] = [];
  try { prev = JSON.parse(await readFile(file, "utf-8")) as ComboResult[]; } catch { /* ไฟล์ยังไม่มี */ }
  const key = (r: ComboResult) => `${r.page}:${r.scope}:${r.dctkName}`;
  const map = new Map(prev.map((r) => [key(r), r]));
  for (const r of fresh) {
    const old = map.get(key(r));
    // ของใหม่ชนะเมื่อได้ค่ามากกว่า (กันรอบที่ล้มกลางคันไปทับของดี)
    if (!old || r.items.length >= old.items.length) map.set(key(r), r);
  }
  const all = [...map.values()].sort((a, b) => a.page - b.page || a.dctkName.localeCompare(b.dctkName));
  await writeFile(file, JSON.stringify(all, null, 1), "utf-8");
  return all.length;
}

const results: ComboResult[] = [];

try {
  await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await login(page, cfg.username, cfg.password);

  // ── หน้า 3 (ฟอร์มรายการสินค้า) ก่อน — มีช่องสำคัญที่สุด (หน่วย/พิกัด/ประเทศ) ──
  //   ถ้าขอเฉพาะหน้า 1 ไม่ต้องเปิดใบเดิมเลย (เร็วกว่า + ไม่ชนกับ nav ของฟอร์มแก้ไข)
  if (ONLY_PAGE !== 1) {
    await openDeclarationForEdit(page, DECL_NO);
    await sleep(2500);
    await page.click(S.SEL_TAB2);
    await sleep(4000);
  }
  const skip3 = ONLY_PAGE !== 0 && ONLY_PAGE !== 3;
  const item = skip3 ? null : await openRow(page, "gridExDecDtl");
  if (item) {
    const list = serverCombos(3);
    log(`หน้า 3 — ดึงรายการ ${list.length} ช่อง`);
    for (const f of list) {
      const r = await dumpCombo(item, f);
      results.push(r);
      log(`  ${f.label.slice(0, 30).padEnd(32)} ${r.items.length ? `${r.items.length} ค่า (seed ${r.seedUsed})` : "— " + r.note}`);
    }
    if (item !== page) await item.close();
  }

  // ── หน้า 2 (ฟอร์มใบกำกับ) ──
  const skip2 = ONLY_PAGE !== 0 && ONLY_PAGE !== 2;
  const inv = skip2 ? null : await openRow(page, "gridExInvoice");
  if (inv) {
    const list = serverCombos(2);
    log(`หน้า 2 — ดึงรายการ ${list.length} ช่อง`);
    for (const f of list) {
      const r = await dumpCombo(inv, f);
      results.push(r);
      log(`  ${f.label.slice(0, 30).padEnd(32)} ${r.items.length ? `${r.items.length} ค่า (seed ${r.seedUsed})` : "— " + r.note}`);
    }
    if (inv !== page) await inv.close();
  }

  // ── หน้า 1 (ฟอร์มสร้างใบใหม่ — สถานะสะอาด) ──
  if (ONLY_PAGE === 0 || ONLY_PAGE === 1) {
    await openPortfolioAndAdd(page);
    await sleep(3000);
    const list = serverCombos(1);
    log(`หน้า 1 — ดึงรายการ ${list.length} ช่อง`);
    for (const f of list) {
      const r = await dumpCombo(page, f);
      results.push(r);
      log(`  ${f.label.slice(0, 30).padEnd(32)} ${r.items.length ? `${r.items.length} ค่า (seed ${r.seedUsed})` : "— " + r.note}`);
    }
  }

  const total = await saveMerged(path.join(outDir, "combo-lists.json"), results);
  const got = results.filter((r) => r.items.length);
  log(`\n✅ เขียน rules/combo-lists.json — รอบนี้ได้ ${got.length}/${results.length} ช่อง · รวมในไฟล์ ${total} ช่อง`);
} catch (e) {
  log(`✗ error: ${e instanceof Error ? e.message : String(e)}`);
  await saveMerged(path.join(outDir, "combo-lists.json"), results).catch(() => 0);
} finally {
  await browser.close();
}
