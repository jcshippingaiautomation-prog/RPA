// ============================================================
//  Pairwise — หากฎที่เกิดจาก "ค่า 2 ช่องพร้อมกัน"
//
//  ปัญหาของการทดลองทีละช่อง: จับได้แค่ "ถ้า A แล้ว Y"
//  แต่ระบบจริงมีกฎแบบ "ถ้า A **และ** B แล้ว Y" ซึ่งทีละช่องมองไม่เห็น
//
//  วิธีที่ใช้ (differential): สำหรับคู่ (A, B)
//    1. วัดผลของ B เดี่ยว ๆ            → effect(B)
//    2. ตั้ง A ก่อน แล้วค่อยตั้ง B      → effect(B | A)
//    3. ถ้า effect(B|A) ≠ effect(B) → มีปฏิสัมพันธ์จริง = กฎใหม่
//
//  เพื่อให้รันไหว: ใช้ค่าที่ "มีผลมากที่สุด" ของแต่ละช่องเพียงค่าเดียว
//  (ค่าที่ทำให้ช่องอื่นเปลี่ยนเยอะสุดตอนทดลองทีละช่อง)
//
//  วิธีรัน:
//    set -a; . ../rpa-web/.env; set +a
//    PAIR_DECL_NO=DCTK000034914 node dist/pairwise-cli.js
// ============================================================
import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { loadConfig, PROJECT_ROOT } from "./runner.js";
import { login, openPortfolioAndAdd, openDeclarationForEdit } from "./pages.js";
import { setLogSink, log, sleep, kendoDropdownListPick } from "./helpers.js";
import { loadFieldRegistry, type FieldDef } from "./field-registry.js";
import * as S from "./selectors.js";

setLogSink(null);

const DECL_NO = (process.env.PAIR_DECL_NO ?? "DCTK000034914").trim();
const MAX_DRIVERS = Number(process.env.PAIR_MAX_DRIVERS ?? 10);
const cfg = await loadConfig();
if (!cfg.url) { console.error("✗ ไม่พบ config.json"); process.exit(1); }

const rulesDir = path.join(
  cfg.download_dir ? path.resolve(PROJECT_ROOT, cfg.download_dir) : path.join(PROJECT_ROOT, "file download"),
  "rules",
);
await mkdir(rulesDir, { recursive: true });

const registry: FieldDef[] = await loadFieldRegistry();

/** ช่องที่ "มีอิทธิพล" + ค่าที่มีผลมากสุดของช่องนั้น (จากผลทดลองทีละช่อง) */
async function effectiveDrivers(page: 1 | 2 | 3) {
  const raw = JSON.parse(await readFile(path.join(rulesDir, `page${page}.json`), "utf-8")) as {
    dependencies: { driver: string; driverLabel: string; value: string; valueLabel: string; effects: unknown[] }[];
  };
  const best = new Map<string, { name: string; label: string; value: string; valueLabel: string; n: number }>();
  for (const d of raw.dependencies ?? []) {
    const cur = best.get(d.driver);
    if (!cur || d.effects.length > cur.n) {
      best.set(d.driver, { name: d.driver, label: d.driverLabel, value: d.value, valueLabel: d.valueLabel, n: d.effects.length });
    }
  }
  const list = [...best.values()].sort((a, b) => b.n - a.n).slice(0, MAX_DRIVERS);
  return list.map((d) => ({
    ...d,
    isCheckbox: registry.find((f) => f.dctkName === d.name)?.type === "checkbox",
  }));
}

interface State { [name: string]: { disabled: boolean; readonly: boolean; required: boolean; visible: boolean; value: string } }

function snapshot(): State {
  const out: State = {};
  document.querySelectorAll("input, select, textarea").forEach((el) => {
    const name = el.getAttribute("name") || (el as HTMLElement).id;
    if (!name || out[name]) return;
    const r = (el as HTMLElement).getBoundingClientRect();
    const st = getComputedStyle(el as HTMLElement);
    const cls = (el.getAttribute("class") || "") + " " + (el.closest(".k-widget")?.getAttribute("class") || "");
    out[name] = {
      disabled: (el as HTMLInputElement).disabled === true,
      readonly: (el as HTMLInputElement).readOnly === true,
      required: /-required\b/.test(cls),
      visible: r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden",
      value: (el as HTMLInputElement).value ?? "",
    };
  });
  return out;
}

/** ผลของการเปลี่ยน = รายการ "ช่อง:สิ่งที่เปลี่ยน" (เอาไว้เทียบชุดต่อชุด) */
function diffKeys(a: State, b: State, ignore: string[]): Set<string> {
  const out = new Set<string>();
  for (const [k, x] of Object.entries(a)) {
    if (ignore.includes(k)) continue;
    const y = b[k];
    if (!y) continue;
    if (x.disabled !== y.disabled) out.add(`${k}:disabled=${y.disabled}`);
    if (x.readonly !== y.readonly) out.add(`${k}:readonly=${y.readonly}`);
    if (x.required !== y.required) out.add(`${k}:required=${y.required}`);
    if (x.visible !== y.visible) out.add(`${k}:visible=${y.visible}`);
    if (x.value !== y.value) out.add(`${k}:value`);
  }
  return out;
}

const browser = await chromium.launch({ headless: process.env.PAIR_HEADLESS !== "0" });
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

type Driver = { name: string; label: string; value: string; valueLabel: string; isCheckbox: boolean };

/** ตั้งค่าช่องหนึ่ง (คลิกจริง — Kendo ต้องคลิก ไม่ใช่ set value) */
async function setField(p: Page, d: Driver, on: boolean): Promise<boolean> {
  const sel = `#${d.name}`;
  try {
    if (d.isCheckbox) {
      const cur = await p.locator(sel).first().isChecked().catch(() => false);
      if (cur !== on) await p.locator(sel).first().click({ timeout: 8000 });
      return true;
    }
    if (!on) return true;                       // dropdown: "ปิด" = ไม่ตั้ง (ใช้ reload แทน)
    await kendoDropdownListPick(p, sel, d.value);
    return true;
  } catch { return false; }
}

interface Interaction {
  page: number;
  a: string; aLabel: string; aValue: string;
  b: string; bLabel: string; bValue: string;
  onlyWithA: string[];      // ผลที่เกิดเฉพาะตอนตั้ง A ไว้ก่อน
  lostWithA: string[];      // ผลที่หายไปเมื่อตั้ง A ไว้ก่อน
}

async function probePairs(p: Page, pageNo: 1 | 2 | 3, reload: () => Promise<Page>): Promise<Interaction[]> {
  const drivers = await effectiveDrivers(pageNo);
  log(`หน้า ${pageNo} — ช่องที่มีอิทธิพล ${drivers.length} ช่อง → ทดลอง ${drivers.length * (drivers.length - 1)} คู่`);
  const out: Interaction[] = [];
  let cur = p;

  // 1) ผลของแต่ละช่อง "เดี่ยว ๆ" (ฐานเปรียบเทียบ)
  const solo = new Map<string, Set<string>>();
  for (const d of drivers) {
    cur = await reload();
    const before = await cur.evaluate(snapshot);
    if (!(await setField(cur, d, true))) continue;
    await sleep(1000);
    const after = await cur.evaluate(snapshot);
    solo.set(d.name, diffKeys(before, after, [d.name]));
  }

  // 2) ผลของ B เมื่อ "ตั้ง A ไว้ก่อน" แล้วเทียบกับผลเดี่ยว
  for (const a of drivers) {
    for (const b of drivers) {
      if (a.name === b.name) continue;
      cur = await reload();
      if (!(await setField(cur, a, true))) continue;
      await sleep(900);
      const afterA = await cur.evaluate(snapshot);
      if (!(await setField(cur, b, true))) continue;
      await sleep(1000);
      const afterAB = await cur.evaluate(snapshot);

      const withA = diffKeys(afterA, afterAB, [a.name, b.name]);
      const alone = solo.get(b.name) ?? new Set<string>();
      const onlyWithA = [...withA].filter((k) => !alone.has(k));
      const lostWithA = [...alone].filter((k) => !withA.has(k));
      if (onlyWithA.length || lostWithA.length) {
        out.push({
          page: pageNo,
          a: a.name, aLabel: a.label, aValue: a.valueLabel,
          b: b.name, bLabel: b.label, bValue: b.valueLabel,
          onlyWithA: onlyWithA.slice(0, 20), lostWithA: lostWithA.slice(0, 20),
        });
        log(`  🔗 ตั้ง [${a.label.slice(0, 22)}=${a.valueLabel.slice(0, 12)}] ก่อน แล้ว [${b.label.slice(0, 22)}] → ต่างจากเดิม (+${onlyWithA.length}/-${lostWithA.length})`);
      }
    }
  }
  return out;
}

const all: Interaction[] = [];
const ONLY_PAGE = Number(process.env.PAIR_PAGE ?? 0);      // 0 = ทำทุกหน้า

try {
  await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await login(page, cfg.username, cfg.password);

  // ── หน้า 1: ฟอร์มสร้างใบใหม่ — รีเซ็ตด้วยการเปิดแท็บใหม่ + login ใหม่ ──
  //   ⚠ DCTK เป็นหน้าเดียว (URL ไม่เปลี่ยน) goto กลับไปจะเจอหน้า login
  //     และกดปุ่มปิดฟอร์มบ้างไม่ติด → เปิดแท็บใหม่ทนที่สุด
  let cur: Page = page;
  const reload1 = async (): Promise<Page> => {
    const fresh = await context.newPage();
    fresh.setDefaultTimeout(cfg.default_timeout_ms ?? 30000);
    await fresh.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(1200);
    await login(fresh, cfg.username, cfg.password);
    await openPortfolioAndAdd(fresh);
    await sleep(2200);
    if (cur !== page) await cur.close().catch(() => { /* */ });
    cur = fresh;
    return fresh;
  };

  if (ONLY_PAGE === 0 || ONLY_PAGE === 1) {
    all.push(...(await probePairs(page, 1, reload1)));
    if (cur !== page) await cur.close().catch(() => { /* */ });
  }

  // ── หน้า 2/3: ต้องเปิดจากใบจริง — รีเซ็ตด้วยการปิดแท็บฟอร์มแล้วเปิดแถวใหม่ ──
  if (ONLY_PAGE === 0 || ONLY_PAGE === 2 || ONLY_PAGE === 3) {
    const parent = await context.newPage();
    parent.setDefaultTimeout(cfg.default_timeout_ms ?? 30000);
    await parent.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(1000);
    await login(parent, cfg.username, cfg.password);
    await openDeclarationForEdit(parent, DECL_NO);
    await sleep(2500);
    await parent.click(S.SEL_TAB2);
    await sleep(4000);

    /** เปิดฟอร์มจากตารางใหม่ทุกครั้ง (ปิดของเดิมก่อน) = สถานะสะอาด */
    const makeReload = (gridId: string) => {
      let opened: Page | null = null;
      return async (): Promise<Page> => {
        if (opened && opened !== parent) await opened.close().catch(() => { /* */ });
        opened = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          const fresh = await openRow(parent, gridId);
          if (fresh && fresh !== parent) { opened = fresh; return fresh; }
          await sleep(2000);
        }
        throw new Error(`เปิดฟอร์มจาก #${gridId} ไม่ได้`);
      };
    };

    if (ONLY_PAGE === 0 || ONLY_PAGE === 2) {
      const reload2 = makeReload("gridExInvoice");
      try { all.push(...(await probePairs(await reload2(), 2, reload2))); }
      catch (e) { log(`  ⚠ หน้า 2: ${e instanceof Error ? e.message : String(e)}`); }
    }
    if (ONLY_PAGE === 0 || ONLY_PAGE === 3) {
      const reload3 = makeReload("gridExDecDtl");
      try { all.push(...(await probePairs(await reload3(), 3, reload3))); }
      catch (e) { log(`  ⚠ หน้า 3: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }

  await writeFile(path.join(rulesDir, "pairwise.json"), JSON.stringify(all, null, 1), "utf-8");
  log(`\n✅ เขียน rules/pairwise.json — เจอปฏิสัมพันธ์ ${all.length} คู่`);
} catch (e) {
  log(`✗ error: ${e instanceof Error ? e.message : String(e)}`);
  await writeFile(path.join(rulesDir, "pairwise.json"), JSON.stringify(all, null, 1), "utf-8").catch(() => { /* */ });
} finally {
  await browser.close();
}
void openDeclarationForEdit; void S; void openRow;
