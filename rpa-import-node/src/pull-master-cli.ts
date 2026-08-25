// ============================================================
//  Pull master — ดึงใบขนที่ทำไว้แล้วใน DCTK ออกมาเป็น "Master ข้อมูล"
//
//  ตรงกับที่ตกลงในที่ประชุม (Action item ข้อ 2):
//    ลูกค้าส่ง "เลขที่ใบกำกับสินค้า" มาให้ → เราไปเปิดใบนั้นใน DCTK
//    → อ่านค่าทุกช่องทั้ง 3 หน้า → บันทึกเป็น Master ในระบบเรา
//    → ครั้งต่อไปเอกสารใหม่เข้ามา ระบบก๊อป Master มาแก้แค่ยอดเงิน/จำนวน/น้ำหนัก
//
//  ⚠ อ่านอย่างเดียว ไม่กด Save ใด ๆ ในระบบกรมฯ
//
//  วิธีรัน:
//    set -a; . ../rpa-web/.env; set +a
//    PULL_INVOICE="DKN 22/2026" PULL_CUSTOMER=THANAKORN node dist/pull-master-cli.js
//
//  ตัวแปร:
//    PULL_INVOICE   เลขที่ใบกำกับสินค้า (หรือเลขอ้างอิง/เลขใบขน — ระบบเดาเอง)
//    PULL_CUSTOMER  ชื่อลูกค้าที่จะผูก Master นี้
//    PULL_NAME      ชื่อ Master (ไม่ใส่ = ตั้งให้อัตโนมัติ)
//    PULL_DRY=1     อ่านอย่างเดียว ไม่บันทึกลงฐานข้อมูล
// ============================================================
import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { loadConfig, PROJECT_ROOT } from "./runner.js";
import { login, openDeclarationForEdit, detectSearchColumn } from "./pages.js";
import { setLogSink, log, sleep } from "./helpers.js";
import { loadFieldRegistry, type FieldDef } from "./field-registry.js";
import * as S from "./selectors.js";

setLogSink(null);

const INVOICE = (process.env.PULL_INVOICE ?? "").trim();
const CUSTOMER = (process.env.PULL_CUSTOMER ?? "").trim();
const DRY = process.env.PULL_DRY === "1";
// ทำสำเนาก่อนอ่าน — จำเป็นกับใบที่ผ่านกรมฯ แล้ว (ไม่งั้นเข้ารายการสินค้าไม่ได้)
const VIA_COPY = process.env.PULL_VIA_COPY === "1";
// ลบใบร่างสำเนาทิ้งหลังอ่านเสร็จ (ค่าปริยาย: ลบ) — ใส่ PULL_CLEANUP=0 ถ้าอยากเก็บไว้ดู
const CLEANUP = process.env.PULL_CLEANUP !== "0";
let copyRef: string | null = null;
if (!INVOICE) { console.error("✗ ต้องระบุ PULL_INVOICE (เลขที่ใบกำกับสินค้า)"); process.exit(1); }

const cfg = await loadConfig();
if (!cfg.url) { console.error("✗ ไม่พบ config.json"); process.exit(1); }

const outDir = path.join(
  cfg.download_dir ? path.resolve(PROJECT_ROOT, cfg.download_dir) : path.join(PROJECT_ROOT, "file download"),
  "masters",
);
await mkdir(outDir, { recursive: true });

const registry: FieldDef[] = await loadFieldRegistry();

/** อ่านค่าทุกช่องของหน้าปัจจุบัน ตามทะเบียนช่อง → { key: value } */
async function readFields(p: Page, page: 1 | 2 | 3, scope: "header" | "item") {
  // Kendo มี input 2 ชั้น (ตัวที่คนเห็น / ตัวที่ถือค่า) — ลองทั้งคู่ เอาอันที่มีค่า
  const defs = registry
    .filter((f) => f.page === page && f.scope === scope && !f.computed)
    .map((f) => ({
      key: f.key,
      type: f.type,
      sels: [f.selector, `#${f.dctkName}`, `[name="${f.dctkName}"]`,
             `#${f.dctkName.replace(/_input$/, "")}`, `[name="${f.dctkName.replace(/_input$/, "")}"]`]
        .filter((x): x is string => !!x),
    }));
  return p.evaluate((list: { key: string; type: string; sels: string[] }[]) => {
    const out: { [k: string]: string } = {};
    for (const f of list) {
      for (const sel of f.sels) {
        let el: HTMLInputElement | null = null;
        try { el = document.querySelector(sel) as HTMLInputElement | null; } catch { continue; }
        if (!el) continue;
        const v = f.type === "checkbox" ? (el.checked ? "1" : "") : String(el.value ?? "").trim();
        if (v) { out[f.key] = v; break; }
      }
    }
    return out;
  }, defs);
}


/**
 * DCTK แสดงวันที่เป็น dd/mm/yyyy แต่ระบบเราเก็บ yyyy-mm-dd
 * ถ้าไม่แปลง ตัวเลือกวันที่ของ RPA จะได้ NaN แล้วกรอกไม่ผ่าน (เจอจริงตอน dry run)
 * รองรับ พ.ศ. → ค.ศ. ด้วย
 */
function toIsoDate(v: string): string {
  const t = String(v ?? "").trim();
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return t;                                  // รูปแบบอื่น (เช่น ISO อยู่แล้ว) ปล่อยผ่าน
  let y = Number(m[3]);
  if (y > 2400) y -= 543;                            // พ.ศ. → ค.ศ.
  return `${y}-${String(Number(m[2])).padStart(2, "0")}-${String(Number(m[1])).padStart(2, "0")}`;
}

/** แปลงค่าช่องวันที่ทั้งหมดใน record ให้เป็น yyyy-mm-dd */
function normalizeDates(rec: { [k: string]: string }, scope: "header" | "item"): { [k: string]: string } {
  const dateKeys = new Set(
    registry.filter((f) => f.scope === scope && f.type === "date").map((f) => f.key),
  );
  for (const k of Object.keys(rec)) {
    if (dateKeys.has(k) || /(^|_)date$/.test(k)) rec[k] = toIsoDate(rec[k]);
  }
  return rec;
}


/**
 * ทำ "สำเนา" ใบใน DCTK แล้วเปิดสำเนานั้นแทนตัวจริง
 *
 * ทำไมต้องมี: ใบที่ผ่านกรมฯ แล้วเปิดได้แค่โหมดอ่าน → เข้ารายการสินค้า (หน้า 3) ไม่ได้
 *   ซึ่งเป็นส่วนที่สำคัญที่สุดของ Master (รหัสสินค้า พิกัด หน่วย น้ำหนักต่อรายการ)
 *   DCTK มีปุ่ม "สำเนา" (#BtnCopy) สร้างใบร่างที่มีข้อมูลครบเหมือนต้นฉบับ → อ่านได้เต็ม
 *   วิธีนี้ไม่แตะต้นฉบับเลย (ตรงข้ามกับการตอบ YES ปรับสถานะใบจริง)
 *
 * ⚠ ผลข้างเคียง: เหลือ "ใบร่างสำเนา" ค้างใน DCTK 1 ใบ (คืนเลขอ้างอิงกลับไปให้ลบทีหลัง)
 */
async function copyThenOpen(page: Page, invoice: string): Promise<string | null> {
  const col = detectSearchColumn(invoice);
  log(`สำเนาใบ ${invoice} เพื่ออ่านข้อมูลให้ครบ (ไม่แตะใบต้นฉบับ)`);
  await page.click(S.SEL_PORTFOLIO_MENU);
  await sleep(5000);

  const setFilter = async () => await page.evaluate(({ f, v }: { f: string; v: string }) => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const ds = (window as any).$("#grid").data("kendoGrid")?.dataSource;
    if (!ds) return false;
    ds.filter({ field: f, operator: "contains", value: v });
    return true;
  }, { f: col.field, v: invoice });

  const readRows = async () => await page.evaluate(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const v: any[] = (window as any).$("#grid").data("kendoGrid")?.dataSource?.view?.() ?? [];
    return v.map((m) => ({
      uid: String(m.uid ?? ""),
      ref: String(m.ReferenceNo ?? ""),
      status: String(m.DeclarationStatusName ?? ""),
    }));
  }).catch(() => [] as { uid: string; ref: string; status: string }[]);

  await setFilter();
  await sleep(4500);
  const before = await readRows();
  if (!before.length) throw new Error(`ค้นใบ "${invoice}" ไม่เจอ — ตรวจเลขอีกที`);
  const beforeRefs = new Set(before.map((r) => r.ref));
  log(`  พบใบเดิม ${before.length} ใบ: ${before.map((r) => `${r.ref}(${r.status})`).join(", ")}`);

  // เลือกใบต้นฉบับ (ตัวที่ทำรายการเสร็จแล้วก่อน ถ้าไม่มีก็ตัวแรก) แล้วกดสำเนา
  const src = before.find((r) => !/กำลังทำข้อมูล/.test(r.status)) ?? before[0];
  await page.locator(`#grid tbody tr[data-uid="${src.uid}"]`).first().click({ timeout: 10000 });
  await sleep(1500);
  const clicked = await page.evaluate(() => {
    const b = document.querySelector("#BtnCopy") as HTMLElement | null;
    if (!b) return false;
    b.click(); return true;
  });
  if (!clicked) throw new Error(`ไม่พบปุ่ม "สำเนา" (#BtnCopy) ในหน้ารายการใบขน`);
  await sleep(9000);

  // หาใบใหม่ที่เพิ่งเกิด — เลขอ้างอิงที่ไม่เคยมีก่อนกดสำเนา
  await setFilter();
  await sleep(4500);
  const after = await readRows();
  const fresh = after.find((r) => !beforeRefs.has(r.ref));
  if (!fresh) throw new Error(`กดสำเนาแล้วแต่หาใบสำเนาใหม่ไม่เจอ (ใบที่มี: ${after.map((r) => r.ref).join(", ")})`);
  log(`  ✓ ได้ใบสำเนา ${fresh.ref} (${fresh.status})`);

  // เปิดใบสำเนา (เป็นใบร่าง → เปิดได้เต็ม ไม่มีกล่องถามปรับสถานะ)
  await openDeclarationForEdit(page, fresh.ref);
  return fresh.ref;
}


/**
 * ลบ "ใบร่างสำเนา" ที่เราสร้างขึ้นเพื่ออ่านข้อมูล
 *
 * ปลอดภัยเพราะตรวจ 2 ชั้นก่อนลบ:
 *   1. เลขอ้างอิงต้องตรงกับใบที่ "เราเพิ่งสร้าง" เป๊ะ ๆ
 *   2. สถานะต้องเป็น "กำลังทำข้อมูล" (ใบร่าง) — ถ้าเป็นใบที่ยื่นกรมฯ แล้วจะไม่แตะ
 * ใส่ PULL_CLEANUP=0 ถ้าอยากเก็บสำเนาไว้ดูเอง
 */
async function deleteCopy(page: Page, ref: string): Promise<boolean> {
  log(`\n🧹 ลบใบร่างสำเนา ${ref} (สำเนาที่สร้างเพื่ออ่านข้อมูล ไม่ใช่ใบจริง)`);
  try {
    // ตอนนี้เราอยู่ลึกในฟอร์มใบขน (บางทีคนละแท็บ) — กดเมนูอาจไม่ติด
    //   ไปหน้ารายการด้วย URL ตรง ๆ ชัวร์กว่า
    const base = new URL(cfg.url!).origin;
    await page.goto(`${base}/DCTK/ExDec/Index`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.locator("#grid").first().waitFor({ state: "visible", timeout: 30000 });
    await sleep(3000);

    await page.evaluate((v: string) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      (window as any).$("#grid").data("kendoGrid")?.dataSource
        ?.filter({ field: "ReferenceNo", operator: "eq", value: v });
    }, ref);
    await sleep(4500);

    const target = await page.evaluate((v: string) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const view: any[] = (window as any).$("#grid").data("kendoGrid")?.dataSource?.view?.() ?? [];
      const m = view.find((x) => String(x.ReferenceNo ?? "") === v);
      if (!m) return null;
      return { uid: String(m.uid ?? ""), status: String(m.DeclarationStatusName ?? "") };
    }, ref).catch(() => null);

    if (!target) { log(`   ⚠ หาใบ ${ref} ไม่เจอ — ข้ามการลบ`); return false; }
    if (!/กำลังทำข้อมูล/.test(target.status)) {
      log(`   ⚠ ใบ ${ref} สถานะ "${target.status}" ไม่ใช่ใบร่าง — ไม่ลบ (กันลบใบจริง)`);
      return false;
    }

    await page.locator(`#grid tbody tr[data-uid="${target.uid}"]`).first().click({ timeout: 10000 });
    await sleep(1500);
    const clicked = await page.evaluate(() => {
      const b = document.querySelector("#BtnDelete") as HTMLElement | null;
      if (!b) return false;
      b.click(); return true;
    });
    if (!clicked) { log(`   ⚠ ไม่พบปุ่ม "ลบข้อมูล" — ข้าม`); return false; }
    await sleep(3000);

    // ยืนยันการลบ (DCTK ถามก่อน) — กดปุ่มยืนยันแบบเทียบข้อความเป๊ะ ๆ
    for (let i = 0; i < 6; i++) {
      const ok = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button, input[type=button]"));
        const yes = btns.find((b) => {
          const t = ((b as HTMLElement).innerText || (b as HTMLInputElement).value || "").trim().toUpperCase();
          return t === "YES" || t === "ตกลง" || t === "OK";
        }) as HTMLElement | undefined;
        if (!yes) return false;
        yes.click(); return true;
      }).catch(() => false);
      if (ok) break;
      await sleep(1500);
    }
    await sleep(5000);

    const gone = await page.evaluate((v: string) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const ds = (window as any).$("#grid").data("kendoGrid")?.dataSource;
      ds?.read?.();
      const view: any[] = ds?.view?.() ?? [];
      return !view.some((x) => String(x.ReferenceNo ?? "") === v);
    }, ref).catch(() => false);
    log(gone ? `   ✓ ลบใบสำเนา ${ref} แล้ว` : `   ⚠ ยังเห็นใบ ${ref} อยู่ — ตรวจในเว็บอีกที`);
    return gone;
  } catch (e) {
    log(`   ⚠ ลบไม่สำเร็จ: ${e instanceof Error ? e.message.slice(0, 80) : ""} — ลบเองได้ในเว็บ`);
    return false;
  }
}

const browser = await chromium.launch({ headless: process.env.PULL_HEADLESS !== "0" });
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

try {
  const col = detectSearchColumn(INVOICE);
  log(`📥 ดึงใบขนจาก DCTK เป็น Master`);
  log(`   เลขที่ให้มา: "${INVOICE}" → ค้นในคอลัมน์ "${col.label}"`);

  await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await login(page, cfg.username, cfg.password);
  if (VIA_COPY) {
    copyRef = await copyThenOpen(page, INVOICE);
  } else {
    await openDeclarationForEdit(page, INVOICE);
  }
  await sleep(2500);

  // ── หน้า 1: หัวใบขน ──
  const header1 = normalizeDates(await readFields(page, 1, "header"), "header");
  log(`  ✓ หน้า 1 อ่านได้ ${Object.keys(header1).length} ช่อง`);

  // ── หน้า 2: ใบกำกับสินค้า ──
  await page.click(S.SEL_TAB2);
  await sleep(4000);
  let header2: { [k: string]: string } = {};
  const inv = await openRow(page, "gridExInvoice");
  if (inv) {
    header2 = normalizeDates(await readFields(inv, 2, "header"), "header");
    log(`  ✓ หน้า 2 อ่านได้ ${Object.keys(header2).length} ช่อง`);
    if (inv !== page) await inv.close();
  } else {
    log(`  ⚠ เปิดฟอร์มใบกำกับไม่ได้ — Master จะขาดข้อมูลหน้า 2`);
  }

  // ── หน้า 3: รายการสินค้า (อ่านทุกแถวในตาราง) ──
  const items: { [k: string]: string }[] = [];
  // ⚠ Kendo grid ที่มีคอลัมน์ตรึง จะ render 2 ตาราง (ล็อก + เลื่อนได้) แถวเดียวกันจึงนับได้ 2
  //   → ต้องนับ "data-uid ที่ไม่ซ้ำ" ถึงจะได้จำนวนรายการจริง
  const uids = await page.evaluate(() => {
    const set = new Set<string>();
    document.querySelectorAll("#gridExDecDtl tbody tr[data-uid]").forEach((tr) => {
      const u = tr.getAttribute("data-uid");
      if (u) set.add(u);
    });
    return [...set];
  }).catch(() => [] as string[]);
  const rowCount = uids.length;
  log(`  รายการสินค้าในใบนี้: ${rowCount} รายการ`);
  for (let i = 0; i < rowCount; i++) {
    const waitNew = context.waitForEvent("page", { timeout: 20000 }).catch(() => null);
    try {
      await page.locator(`#gridExDecDtl tbody tr[data-uid="${uids[i]}"]`).first().dblclick({ timeout: 15000 });
    } catch { log(`    ⚠ เปิดรายการที่ ${i + 1} ไม่ได้`); continue; }
    const itemPage = await waitNew;
    if (!itemPage) { log(`    ⚠ รายการที่ ${i + 1} ไม่เปิดแท็บใหม่`); await sleep(2000); continue; }
    await itemPage.waitForLoadState("domcontentloaded").catch(() => { /* */ });
    await sleep(5000);
    const it = normalizeDates(await readFields(itemPage, 3, "item"), "item");
    it.line_no = String(i + 1);
    items.push(it);
    log(`    ✓ รายการที่ ${i + 1}: ${Object.keys(it).length} ช่อง`);
    await itemPage.close();
    await sleep(1500);
  }

  // ── กันรายการซ้ำ ──────────────────────────────────────────────────
  //   ตารางของ DCTK บางใบให้แถวที่เนื้อหาเหมือนกันเป๊ะ (ใบที่ถูกสำเนามา)
  //   ถ้าเก็บทั้งคู่ไว้ใน Master ยอดรวมจะเป็น 2 เท่า → กระทบยอดไม่ตรงตอนส่งกรมฯ
  const seenItems = new Set<string>();
  const uniqueItems: typeof items = [];
  for (const it of items) {
    const { line_no: _ln, ...rest } = it;
    const sig = JSON.stringify(rest);
    if (seenItems.has(sig)) continue;
    seenItems.add(sig);
    uniqueItems.push({ ...rest, line_no: String(uniqueItems.length + 1) });
  }
  if (uniqueItems.length !== items.length) {
    log(`  ⚠ เจอรายการที่เนื้อหาซ้ำกันเป๊ะ ${items.length - uniqueItems.length} รายการ — ตัดออก เหลือ ${uniqueItems.length}`);
  }
  items.length = 0;
  items.push(...uniqueItems);

  const header = { ...header1, ...header2 };
  // ⚠ CmpNameThai ใน DCTK = ชื่อบริษัทเต็ม (DCTK เติมเองจากเลขผู้เสียภาษี)
  //   แต่ customer_name ของระบบเรา = "คำค้น" ที่ใช้หาบริษัทใน DCTK ต้องสั้นและค้นเจอ
  //   ถ้าเก็บชื่อเต็มไว้ จะยาวเกิน 35 ตัวที่กรมฯ รับ และ RPA ค้นบริษัทไม่เจอ
  if (header.cmp_name_thai) {
    log(`  ℹ ไม่เก็บชื่อบริษัทเต็มจาก DCTK ("${String(header.cmp_name_thai).slice(0, 40)}…")`);
    log(`    customer_name จะใช้ค่าจาก PULL_CUSTOMER แทน (ต้องเป็นคำค้นที่หาบริษัทใน DCTK เจอ)`);
    delete header.cmp_name_thai;
  }
  const consignee = header.consignee_name ?? "";
  const products = items.map((it) => it.product_code || it.description_eng).filter(Boolean);
  const name = (process.env.PULL_NAME ?? "").trim()
    || `${CUSTOMER || header.customer_name || "Master"}${consignee ? " — " + consignee : ""}${products[0] ? " · " + products[0].slice(0, 24) : ""}`;

  const master = {
    name,
    customer_name: CUSTOMER || header.customer_name || "",
    description: `ดึงจาก DCTK ด้วย ${col.label} "${INVOICE}"`,
    consignee_names: consignee ? [consignee] : [],
    product_codes: [...new Set(products)],
    header,
    items,
    field_modes: {},
    is_default: false,
    source: { pulledBy: col.label, value: INVOICE },
  };

  const file = path.join(outDir, `${INVOICE.replace(/[^\w-]+/g, "_")}.json`);
  await writeFile(file, JSON.stringify(master, null, 1), "utf-8");
  log(`\n📄 Master ที่ได้:`);
  log(`   ชื่อ:       ${master.name}`);
  log(`   ลูกค้า:     ${master.customer_name || "(ไม่ระบุ)"}`);
  log(`   Consignee:  ${consignee || "(ไม่พบ)"}`);
  log(`   รหัสสินค้า: ${master.product_codes.join(", ") || "(ไม่พบ)"}`);
  log(`   ช่องหัวใบ:  ${Object.keys(header).length} ช่อง · รายการสินค้า ${items.length} รายการ`);
  log(`   ไฟล์:       ${file}`);

  // ── บันทึกลงระบบเรา (ผ่าน REST ของ Supabase) ──
  if (DRY) {
    log(`\n🧪 PULL_DRY=1 — ไม่บันทึกลงฐานข้อมูล`);
  } else {
    const url = (process.env.SUPABASE_URL ?? "").trim();
    const key = (process.env.SUPABASE_SERVICE_KEY ?? "").trim();
    if (!url || !key) {
      log(`\n⚠ ไม่มี SUPABASE_URL/KEY — ข้ามการบันทึก (ไฟล์ JSON ยังใช้ import ทีหลังได้)`);
    } else {
      const body = {
        name: master.name, customer_name: master.customer_name, description: master.description,
        consignee_names: master.consignee_names, product_codes: master.product_codes,
        header: master.header, items: master.items, field_modes: {}, is_default: false,
      };
      const resp = await fetch(`${url}/rest/v1/declaration_templates`, {
        method: "POST",
        headers: {
          apikey: key, Authorization: `Bearer ${key}`,
          "Content-Type": "application/json", Prefer: "return=representation",
        },
        body: JSON.stringify(body),
      });
      if (resp.ok) log(`\n✅ บันทึก Master ลงระบบแล้ว`);
      else log(`\n⚠ บันทึกไม่สำเร็จ (HTTP ${resp.status}) — ${(await resp.text()).slice(0, 200)}\n   (ถ้ายังไม่ได้รัน sql/11+sql/12 จะบันทึกไม่ได้ — ไฟล์ JSON ยังอยู่ นำเข้าทีหลังได้)`);
    }
  }
} catch (e) {
  log(`✗ error: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  // เก็บกวาดใบร่างสำเนาเสมอ ไม่ว่าจะอ่านสำเร็จหรือพัง — ไม่งั้นจะทิ้งขยะไว้ใน DCTK
  if (copyRef) {
    const cleaned = CLEANUP ? await deleteCopy(page, copyRef).catch(() => false) : false;
    if (!cleaned) {
      log(`\n⚠ เหลือ "ใบร่างสำเนา" ค้างใน DCTK: ${copyRef}`);
      log(`   เป็นสำเนาที่สร้างเพื่ออ่านข้อมูล ไม่ใช่ใบจริง — ลบทิ้งได้ (เลือกแถวแล้วกด "ลบข้อมูล")`);
    }
  }
  await browser.close();
}
