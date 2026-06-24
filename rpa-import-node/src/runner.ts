// ============================================================
//  runImport() — programmatic entry used by both the CLI (main.ts)
//  and the web server (rpa-web). Wraps the original run loop with
//  callbacks (log / row status), runtime options, and a stop signal.
// ============================================================
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";

import { log, sleep, setLogSink, type LogSink } from "./helpers.js";
import {
  loadRecordsFromSheet,
  loadRecords,
  loadRecordsFromSupabase,
  markDeclarationDone,
  loadFieldRules,
  loadCustomerRules,
  matchCustomerKey,
  isTruthy,
  SHEET_HEADER_MAP,
} from "./data.js";
import { login, openPortfolioAndAdd, fillPage1, fillPage2, fillPage2Open, fillPage2Fill, fillPage3, openDeclarationForEdit, saveDeclarationEdit } from "./pages.js";
import * as S from "./selectors.js";
import { dumpPage, dumpGridColumns } from "./inspect.js";
import { finalizeAndPrint, reprintDeclaration } from "./finalize.js";
import { sendEmailWithPdf, buildCapturePdf } from "./email.js";
import type { AppConfig, Record } from "./types.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(ROOT, "..");
const CONFIG_PATH = path.join(PROJECT_ROOT, "config.json");

export type RowStatus = "pending" | "running" | "done" | "error" | "skipped";

export interface RowFieldPreview {
  key: string;        // internal key
  label: string;      // ชื่อช่อง (ไทย)
  value: string;      // ค่าที่จะกรอก
  source: "ai" | "config" | "empty"; // มาจาก AI(เอกสาร) / config(preset) / ว่าง
  allowed: boolean;   // ลูกค้านี้กรอกช่องนี้ไหม
}

export interface RowInfo {
  index: number; // 1-based
  customer: string;
  invoice: string;
  status: RowStatus;
  error?: string;
  fields?: RowFieldPreview[]; // รายละเอียดทุกช่อง (เฉพาะ preview)
  items?: number;             // จำนวนรายการสินค้า
  declarationId?: string;     // id ใน Supabase (ไว้แก้ไข)
}

/** สิ่งที่ caller ส่งเข้ามาเพื่อคุม/สังเกตการรัน */
export interface RunOptions {
  /** override config.json (เช่น headless จากหน้าเว็บ) */
  configOverrides?: Partial<AppConfig>;
  /** dry run: กรอกข้อมูลจริงแต่ไม่ Save/Print และไม่ส่งอีเมล */
  dryRun?: boolean;
  /**
   * field rules จากภายนอก (เช่น Supabase) — { customer_name: [allowed fields] }
   * ถ้าส่งมา จะใช้แทน Google Sheet 'การกรอกข้อมูล' ทั้งหมด
   */
  fieldRulesOverride?: { [customer: string]: string[] };
  /** capture flag จากภายนอก (Supabase) — { customer_name: true/false } */
  captureOverride?: { [customer: string]: boolean };
  /**
   * presets ต่อลูกค้า (Supabase customer_settings.presets) — { customer_name: { field: value } }
   * เติมเฉพาะช่องที่ record ยังว่าง (ค่าจากเอกสารชนะ preset) เหมือนฝั่ง GAS
   */
  presetsOverride?: { [customer: string]: { [field: string]: string } };
  /**
   * inspect mode: หยุดทีละหน้า + dump element (screenshot + JSON) ไม่กรอก/ไม่ Save
   * สำหรับสำรวจ element เพื่อ map ช่องต่อลูกค้า
   */
  inspect?: boolean;
  /**
   * inspect-edit mode: login → portfolio → dump element หน้าค้น/แก้ใบ (ไม่กรอก)
   * สำหรับหา selectors หน้าค้น/แก้ใบขนเดิม (ดู RPA_INSPECT_DECL_NO เป็นเลขทดสอบ)
   */
  inspectEdit?: boolean;
  /** โหมดทำงาน: "create" (สร้างใบใหม่ default) | "edit" (ค้นใบเดิม→แก้) | "reprint" (พิมพ์ใบเดิมซ้ำ ไม่กรอก) */
  mode?: "create" | "edit" | "reprint";
  /** เลขใบขน DCTK ที่จะค้นเพื่อแก้ (mode=edit) หรือพิมพ์ซ้ำ (mode=reprint) */
  editDeclarationNo?: string;
  /** id ใน Supabase ของใบที่จะแก้/พิมพ์ซ้ำ (ผูก status + onCaptureMeta/onDocument) */
  editDeclarationId?: string;
  /** รันเฉพาะแถวเหล่านี้ (1-based). ว่าง = ทุกแถว */
  onlyRows?: number[];
  /** ตัวรับ log สด */
  onLog?: LogSink;
  /** แจ้งรายการแถวทั้งหมดตอนเริ่ม (หลังโหลด sheet) */
  onRows?: (rows: RowInfo[]) => void;
  /** แจ้งเมื่อสถานะแถวเปลี่ยน */
  onRowStatus?: (row: RowInfo) => void;
  /** สัญญาณหยุด — คืน true เพื่อหยุดก่อนแถวถัดไป */
  shouldStop?: () => boolean;
  /** เรียกเมื่อมี PDF ถูกสร้าง (ให้ caller อัปขึ้น Supabase ฯลฯ) */
  onDocument?: (doc: {
    filePath: string;
    kind: "declaration" | "screenshot" | "capture";
    customer: string;
    invoice: string;
  }) => Promise<void> | void;
  /** เรียกเมื่อ capture เลขใบขน DCTK ได้ตอน finalize (ให้ caller เก็บลง declarations.declaration_no) */
  onCaptureMeta?: (meta: {
    declarationId?: string;
    declarationNo: string;
  }) => Promise<void> | void;
}

export interface RunResult {
  total: number;
  done: number;
  errors: number;
  skipped: number;
  stopped: boolean;
  /** true ถ้ามี record ที่สร้างใบใน DCTK สำเร็จแล้ว (ได้ declaration_no) — worker ใช้กันการ retry ที่จะสร้างใบซ้ำ */
  declarationCreated?: boolean;
}

export async function loadConfig(): Promise<AppConfig> {
  // ถ้าไม่มี config.json (เช่น เว็บบน Render ที่ไม่มี DCTK credentials — มีแค่ worker บน VM)
  //   → คืน config เปล่า ไม่ throw. เว็บใช้ previewRows แค่หา row index จาก Supabase
  //   ไม่ต้องใช้ DCTK url/pass; ส่วน worker (ที่เปิด browser จริง) มี config.json อยู่แล้ว
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as AppConfig;
  } catch (e: unknown) {
    if ((e as { code?: string })?.code === "ENOENT") {
      return {} as AppConfig; // เว็บ: ไม่มี config.json → ใช้ค่าเปล่า (ดึง records จาก Supabase ได้ปกติ)
    }
    throw e;
  }
}

/** ผูก field_rules + customer_rule + capture flag ให้แต่ละ record (Python _attach_rules) */
async function attachRules(
  records: Record[],
  cfg: AppConfig,
  override?: { [customer: string]: string[] },
  captureOverride?: { [customer: string]: boolean },
  presetsOverride?: { [customer: string]: { [field: string]: string } },
): Promise<void> {
  const gs = cfg.google_sheet;

  let fieldRules: { [cust: string]: Set<string> } = {};
  let customerRules: { [cust: string]: { [k: string]: string } } = {};

  // 1) field rules: ใช้ override (Supabase) ก่อน ถ้ามี
  if (override && Object.keys(override).length > 0) {
    for (const [cust, fields] of Object.entries(override)) {
      fieldRules[cust] = new Set(fields);
    }
    log(`  ✓ ใช้ field rules จาก Supabase: ${Object.keys(override).length} ลูกค้า`);
  } else if (gs && gs.enabled && gs.field_rules_sheet) {
    // fallback: Google Sheet 'การกรอกข้อมูล'
    try {
      fieldRules = await loadFieldRules(gs.sheet_id, gs.field_rules_sheet);
    } catch (ex) {
      log(`  ⚠ โหลด field rules ไม่สำเร็จ: ${ex}`);
    }
  }

  // 2) customer rules (capture flag ฯลฯ) ยังมาจาก Google Sheet เหมือนเดิม
  if (gs && gs.enabled && gs.customer_rule_sheet) {
    try {
      customerRules = await loadCustomerRules(gs.sheet_id, gs.customer_rule_sheet);
    } catch (ex) {
      log(`  ⚠ โหลด customer rules ไม่สำเร็จ: ${ex}`);
    }
  }

  const downloadDir = path.join(PROJECT_ROOT, cfg.download_dir ?? "file download");
  for (const r of records) {
    const cust = String(r.company_search ?? "");
    const fk = matchCustomerKey(cust, Object.keys(fieldRules));
    const ck = matchCustomerKey(cust, Object.keys(customerRules));
    r.__field_rules__ = fk ? fieldRules[fk] : null;
    r.__customer_rule__ = ck ? (customerRules[ck] as Record) : {};
    // capture: ใช้ override (Supabase) ก่อน ถ้าไม่มีค่อย fallback Google Sheet
    if (captureOverride && Object.keys(captureOverride).length > 0) {
      const cak = matchCustomerKey(cust, Object.keys(captureOverride));
      r.__capture_screenshots__ = cak ? captureOverride[cak] : false;
    } else {
      r.__capture_screenshots__ = isTruthy(
        ck ? customerRules[ck]["ร้องขอภาพหน้าจอ"] ?? "" : "",
      );
    }
    r.__download_dir__ = downloadDir;

    // เติม presets ต่อลูกค้า (Supabase) — "กำหนดเอง" override ค่า AI เสมอ (ตามนิยาม config)
    let presetCount = 0;
    if (presetsOverride) {
      const pk = matchCustomerKey(cust, Object.keys(presetsOverride));
      const presets = pk ? presetsOverride[pk] : null;
      if (presets) presetCount = applyPresetsToRecord(r, presets);
    }

    log(
      `  rules('${cust}'): ` +
        `fields=${fk === null ? "all" : (r.__field_rules__ as Set<string>).size}, ` +
        `capture=${r.__capture_screenshots__}, presets=${presetCount}`,
    );
  }
}

/**
 * เติม presets (DB field names) ลง record (internal keys)
 * นิยาม "กำหนดเอง": ใช้ค่า preset "เสมอ" (override ค่า AI/เอกสาร) — ไม่ใช่แค่ช่องว่าง
 * preset key เป็นชื่อคอลัมน์ DB (semantic key) เช่น incoterms, customs_unit_code
 *   → map เป็น internal key ผ่าน SHEET_HEADER_MAP เพื่อ set ค่าใน record
 *   → mark semantic key ลง __preset_keys__ (Set) ให้ helper รู้ว่าช่องนี้ "กำหนดเอง"
 *     (ถ้าค่าว่าง = ตั้งใจให้ว่าง → helper จะล้างช่อง)
 * คืนจำนวน preset ที่ตั้ง (รวมค่าว่าง)
 */
function applyPresetsToRecord(
  r: Record,
  presets: { [field: string]: string },
): number {
  const presetKeys = (r.__preset_keys__ ??= new Set<string>()) as Set<string>;
  let n = 0;
  for (const [dbKey, value] of Object.entries(presets)) {
    const v = value === null || value === undefined ? "" : String(value);
    const internalKey = SHEET_HEADER_MAP[dbKey] ?? dbKey;
    // override เสมอ (กำหนดเอง = ใช้ค่านี้แน่นอน ไม่สนค่า AI/เอกสาร)
    r[internalKey] = v;
    presetKeys.add(dbKey); // semantic key (ตรงกับ sheetField ที่ allowed/put ใช้)
    n++;
  }
  return n;
}

function rowLabel(r: Record): { customer: string; invoice: string } {
  return {
    customer: String(r.company_search ?? r.consignee ?? ""),
    invoice: String(r.invoice_no ?? ""),
  };
}

/**
 * โหลด records — ลำดับความสำคัญ:
 *   1) Supabase declarations (ถ้าตั้ง env SUPABASE_URL/KEY)
 *   2) Google Sheet (ถ้า enabled)
 *   3) Excel
 */
async function loadAllRecords(cfg: AppConfig): Promise<Record[]> {
  const fromSupabase = await loadRecordsFromSupabase();
  if (fromSupabase.length > 0) return fromSupabase;

  const gs = cfg.google_sheet;
  if (gs && gs.enabled) {
    return loadRecordsFromSheet(gs.sheet_id, gs.sheet_name);
  }
  return loadRecords(path.join(PROJECT_ROOT, cfg.data_file ?? "data.xlsx"));
}

/**
 * ขั้นที่ 1 — ดึงข้อมูลจาก Google Sheet มาแสดง โดย "ไม่เปิด browser"
 * ใช้ให้ผู้ใช้เลือกแถวก่อนกดรันจริง
 */
export async function previewRows(
  opts: {
    configOverrides?: Partial<AppConfig>;
    onLog?: LogSink;
    fieldRulesOverride?: { [c: string]: string[] };
    presetsOverride?: { [c: string]: { [field: string]: string } };
  } = {},
): Promise<RowInfo[]> {
  if (opts.onLog) setLogSink(opts.onLog);
  try {
    const cfg: AppConfig = { ...(await loadConfig()), ...(opts.configOverrides ?? {}) };
    const records = await loadAllRecords(cfg);
    // apply rules + presets เพื่อให้ preview เห็นค่าครบ (เหมือนตอนรันจริง)
    await attachRules(records, cfg, opts.fieldRulesOverride, undefined, opts.presetsOverride);

    return records.map((r, i) => {
      const { customer, invoice } = rowLabel(r);
      const allowedSet = r.__field_rules__ as Set<string> | null;
      const presetKeys = new Set<string>(); // DB keys ที่เป็น preset ของลูกค้านี้
      if (opts.presetsOverride) {
        const pk = matchCustomerKey(customer, Object.keys(opts.presetsOverride));
        if (pk) Object.keys(opts.presetsOverride[pk] ?? {}).forEach((k) => presetKeys.add(k));
      }
      const fields: RowFieldPreview[] = PREVIEW_FIELDS.map((f) => {
        const internal = SHEET_HEADER_MAP[f.dbKey] ?? f.dbKey;
        const value = r[internal] != null ? String(r[internal]) : "";
        const allowed = !allowedSet || allowedSet.has(f.dbKey);
        let source: "ai" | "config" | "empty" = "empty";
        if (value) source = presetKeys.has(f.dbKey) ? "config" : "ai";
        return { key: f.dbKey, label: f.label, value, source, allowed };
      });
      const items = Array.isArray(r.__items__) ? r.__items__.length : 0;
      const declarationId = r.__supabase_id__ != null ? String(r.__supabase_id__) : undefined;
      return { index: i + 1, customer, invoice, status: "pending" as RowStatus, fields, items, declarationId };
    });
  } finally {
    if (opts.onLog) setLogSink(null);
  }
}

// ช่องที่แสดงใน preview (DB key + label) — ครอบคลุมช่องหลักที่ RPA กรอก
const PREVIEW_FIELDS: { dbKey: string; label: string }[] = [
  { dbKey: "customer_name", label: "ลูกค้า" },
  { dbKey: "consignee_name", label: "Consignee" },
  { dbKey: "buyer_country_code", label: "ประเทศผู้ซื้อ" },
  { dbKey: "destination_country_code", label: "ประเทศปลายทาง" },
  { dbKey: "vessel_name", label: "ชื่อเรือ" },
  { dbKey: "voyage_number", label: "เที่ยวเรือ" },
  { dbKey: "release_port_code", label: "ท่าตรวจปล่อย" },
  { dbKey: "loading_port_code", label: "ท่ารับบรรทุก" },
  { dbKey: "shipping_mark", label: "Shipping mark" },
  { dbKey: "tax_payment_method_code", label: "วิธีชำระภาษี" },
  { dbKey: "etd", label: "ETD" },
  { dbKey: "invoice_number", label: "เลขที่ Invoice" },
  { dbKey: "invoice_date", label: "วันที่ Invoice" },
  { dbKey: "incoterms", label: "Incoterms" },
  { dbKey: "currency", label: "สกุลเงิน" },
  { dbKey: "total_goods_amount", label: "มูลค่าสินค้า" },
  { dbKey: "freight_charge", label: "ค่าระวาง" },
  { dbKey: "insurance_charge", label: "ค่าประกัน" },
  { dbKey: "net_weight_kg", label: "น้ำหนักสุทธิ (kg)" },
  { dbKey: "gross_weight_kg", label: "น้ำหนักรวม (kg)" },
  { dbKey: "description_eng", label: "รายละเอียดสินค้า" },
  { dbKey: "net_weight_ton", label: "น้ำหนักสุทธิ (ton)" },
  { dbKey: "net_weight_unit_code", label: "หน่วยน้ำหนัก" },
  { dbKey: "container_or_volume_qty", label: "จำนวน/ปริมาณตู้" },
  { dbKey: "container_unit_code", label: "หน่วยตู้" },
  { dbKey: "customs_unit_code", label: "หน่วยปริมาณในใบขน" },
  { dbKey: "export_tariff", label: "ประเภทพิกัดขาออก" },
];

/**
 * รันกระบวนการ import แบบโปรแกรม — ใช้ได้ทั้ง CLI และ web server
 */
export async function runImport(opts: RunOptions = {}): Promise<RunResult> {
  if (opts.onLog) setLogSink(opts.onLog);

  const result: RunResult = { total: 0, done: 0, errors: 0, skipped: 0, stopped: false };

  try {
    const cfg: AppConfig = { ...(await loadConfig()), ...(opts.configOverrides ?? {}) };

    const records = await loadAllRecords(cfg);
    if (records.length === 0) {
      log("ไม่มีข้อมูลให้ประมวลผล");
      return result;
    }
    await attachRules(
      records,
      cfg,
      opts.fieldRulesOverride,
      opts.captureOverride,
      opts.presetsOverride,
    );

    result.total = records.length;

    // สร้างรายการสถานะแถว
    const rows: RowInfo[] = records.map((r, i) => {
      const { customer, invoice } = rowLabel(r);
      return { index: i + 1, customer, invoice, status: "pending" };
    });
    opts.onRows?.(rows);

    const onlySet = opts.onlyRows && opts.onlyRows.length
      ? new Set(opts.onlyRows)
      : null;

    const setStatus = (i: number, status: RowStatus, error?: string) => {
      rows[i].status = status;
      if (error) rows[i].error = error;
      opts.onRowStatus?.(rows[i]);
    };

    await runBrowser(records, rows, cfg, opts, onlySet, setStatus, result);
  } finally {
    if (opts.onLog) setLogSink(null);
  }

  return result;
}

/**
 * inspect-edit: เปิดหน้ารายการใบขน (portfolio) → dump element เพื่อหา selectors
 * หน้าค้น/แก้ใบเดิม. ถ้ามี RPA_INSPECT_DECL_NO จะลองค้น+dump หน้าผลลัพธ์/หน้าแก้ด้วย
 * best-effort — ครอบ try/catch ทุกขั้น ไม่ throw ออก
 */
async function inspectEditFlow(page: Page, downloadDir: string): Promise<void> {
  const declNo = (process.env.RPA_INSPECT_DECL_NO ?? "").trim();
  // 1) เปิดหน้ารายการใบขน (portfolio) แล้ว dump
  try {
    log("🔍 inspect-edit: เปิดหน้ารายการใบขน (portfolio)");
    await page.click(S.SEL_PORTFOLIO_MENU);
    await sleep(5000);
    await dumpPage(page, "portfolio", downloadDir);
    await dumpGridColumns(page, downloadDir); // map คอลัมน์ตาราง (เลขที่ใบขนอยู่คอลัมน์ไหน)
    log("  ✓ dump portfolio.json + grid-columns.json เสร็จ");
  } catch (e) {
    log(`  ⚠ เปิด portfolio ไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}`);
    await dumpPage(page, "inspect_edit_error", downloadDir).catch(() => {});
    return;
  }

  // 2) ถ้ามีเลขใบทดสอบ → ลองค้น (best-effort หาช่องค้นด้วย heuristic)
  if (!declNo) {
    log("  ℹ ไม่ได้ตั้ง RPA_INSPECT_DECL_NO — ข้ามขั้นค้น/แก้ (ตั้ง env นี้เพื่อ dump หน้าผลค้น+หน้าแก้)");
    return;
  }
  try {
    log(`🔍 inspect-edit: ลองค้นใบเลข ${declNo}`);
    // heuristic: หา input ที่เห็นได้ในหน้า (ช่องค้น) — ลองพิมพ์ + Enter
    const searchBox = page.locator('input[type="text"]:visible, input:not([type]):visible').first();
    if (await searchBox.count()) {
      await searchBox.click();
      await searchBox.fill(declNo);
      await page.keyboard.press("Enter");
      await sleep(4000);
      await dumpPage(page, "search", downloadDir);
      log("  ✓ dump search.json เสร็จ — ดูตารางผลค้น + ปุ่มแก้");
    } else {
      log("  ⚠ หาช่องค้นไม่เจอ (heuristic) — ดู portfolio.json เพื่อหา selector ช่องค้นเอง");
    }
  } catch (e) {
    log(`  ⚠ ค้นใบไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}`);
    await dumpPage(page, "inspect_edit_error", downloadDir).catch(() => {});
  }

  // 3) ลองเปิดใบแรกในผลค้น (double-click) → dump หน้าแก้
  try {
    const firstRow = page.locator(S.SEL_GRID_FIRST_ROW).first();
    if (await firstRow.count()) {
      await firstRow.dblclick();
      await sleep(5000);
      await dumpPage(page, "edit-page1", downloadDir);
      log("  ✓ dump edit-page1.json เสร็จ — ดูฟอร์มหน้าแก้ (ช่อง read-only? ปุ่ม save?)");
    }
  } catch (e) {
    log(`  ⚠ เปิดใบเพื่อแก้ไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}`);
  }
  log("✅ inspect-edit เสร็จ — ส่งไฟล์ inspect/portfolio.json, search.json, edit-page1.json กลับมาเพื่อเขียน selectors");
}

/**
 * inspect-combo: เปิด Page 1 → คลิก combo vessel → พิมพ์ → dump dropdown ที่โผล่จริง
 * เพื่อหา selector ที่ถูกต้อง (ตอนนี้ comboPick รอ ul.k-list:visible แต่ไม่เจอ)
 */
async function inspectComboFlow(page: Page, downloadDir: string): Promise<void> {
  const dir = path.join(downloadDir, "inspect");
  await mkdir(dir, { recursive: true });
  try {
    log("🔍 inspect-combo: เปิด Page 1 (Add)");
    await openPortfolioAndAdd(page);
    await sleep(3000);
    // คลิก combo vessel + พิมพ์
    const sel = S.SEL_VESSEL_INPUT;
    log(`  คลิก combo vessel: ${sel}`);
    await page.click(sel);
    await page.fill(sel, "");
    await page.type(sel, "KMTC", { delay: 80 });
    await sleep(3000); // รอ dropdown โผล่
    await page.screenshot({ path: path.join(dir, "combo-dropdown.png"), fullPage: true });
    // dump ทุก element ที่น่าจะเป็น dropdown (k-list / k-animation / k-popup / ul li)
    const dd = await page.evaluate(() => {
      const out: { selector: string; visible: boolean; itemCount: number; sample: string }[] = [];
      const cands = [
        "ul.k-list", ".k-list-container", ".k-animation-container", ".k-popup",
        ".k-list-ul", "[role=listbox]", ".k-grid-content", ".k-popup .k-item",
      ];
      for (const c of cands) {
        const els = Array.from(document.querySelectorAll(c));
        els.forEach((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          const vis = r.width > 0 && r.height > 0 && getComputedStyle(el as HTMLElement).display !== "none";
          const items = el.querySelectorAll("li, tr, .k-item");
          out.push({
            selector: c,
            visible: vis,
            itemCount: items.length,
            sample: (items[0]?.textContent || "").trim().slice(0, 40),
          });
        });
      }
      return out;
    });
    await writeFileSafe(path.join(dir, "combo-dropdown.json"), JSON.stringify(dd, null, 2));
    log("  🔍 dropdown candidates (visible + มี items = ตัวที่ใช่):");
    for (const d of dd) {
      if (d.visible && d.itemCount > 0) log(`     ✓ "${d.selector}" items=${d.itemCount} ตัวอย่าง="${d.sample}"`);
    }
    const none = dd.filter((d) => d.visible && d.itemCount > 0).length === 0;
    if (none) log("  ⚠ ไม่มี dropdown visible ที่มี items — dropdown อาจยังไม่โผล่ หรือ DCTK ใช้ ajax ช้า (ลองพิมพ์ค่าจริง/รอนานขึ้น)");
  } catch (e) {
    log(`  ✗ inspect-combo error: ${e instanceof Error ? e.message : String(e)}`);
    await page.screenshot({ path: path.join(dir, "combo-error.png"), fullPage: true }).catch(() => {});
  }
}

async function writeFileSafe(p: string, content: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(p, content, "utf-8");
}

/** inspect currency combo (Page 2) — ดู row structure + ค่า input หลังเลือก */
async function inspectCurrencyFlow(page: Page, record: Record, downloadDir: string): Promise<void> {
  const dir = path.join(downloadDir, "inspect");
  await mkdir(dir, { recursive: true });
  try {
    log("🔍 inspect-currency: เปิด Page 1 → fill → Page 2");
    await openPortfolioAndAdd(page);
    await fillPage1(page, record);
    // เปิด Page 2 แบบ minimal (ไม่ผ่าน fillPage2Open ที่ค้าง waitForLoadState)
    await page.click(S.SEL_TAB2);
    await sleep(2000);
    const ctx = page.context();
    const before = [...ctx.pages()];
    await page.locator(S.SEL_BTN_INVOICE_ADD).click({ force: true });
    await sleep(4000);
    const page2 = ctx.pages().find((p) => !before.includes(p)) || page;
    await page2.bringToFront();
    await sleep(2000);

    // === DUMP ตารางราคา Page 2 (ราคา/ค่าระวาง/ค่าประกัน + สกุลเงินแต่ละแถว) ===
    const priceTable = await page2.evaluate(() => {
      const out: unknown[] = [];
      // หา input ทุกตัวที่อยู่ในตารางราคา — เดินทีละ row ของ fieldset ราคา
      // เก็บทุก input/combo: name, value, classes, label แถว (col แรก), col index
      const rows = Array.from(document.querySelectorAll("#TabStrip-1 fieldset .form-group, #TabStrip-1 fieldset div.row"));
      rows.forEach((row, ri) => {
        const inputs = Array.from(row.querySelectorAll("input")).filter((el) => {
          const t = (el as HTMLInputElement).type;
          return t !== "hidden" && t !== "checkbox";
        });
        if (!inputs.length) return;
        const rowLabel = (row.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
        inputs.forEach((el, ci) => {
          const inp = el as HTMLInputElement;
          const parentCls = (inp.closest("div[class*='col-']")?.className || "").trim();
          out.push({
            row: ri, col: ci, rowLabel,
            name: inp.name || "(no-name)",
            id: inp.id || "(no-id)",
            value: inp.value,
            role: inp.getAttribute("role") || "",
            cls: inp.className.slice(0, 80),
            colCls: parentCls.slice(0, 80),
            isCurrency: /currencyCode/.test(parentCls),
            isNumeric: /termForeign|right-numeric|k-formatted-value/.test(inp.className + " " + parentCls),
          });
        });
      });
      return out;
    });
    await writeFileSafe(path.join(dir, "page2-price-table.json"), JSON.stringify(priceTable, null, 2));
    log(`  📋 price-table: ${(priceTable as unknown[]).length} inputs (ดู inspect/page2-price-table.json)`);
    for (const f of priceTable as { rowLabel: string; name: string; value: string; isCurrency: boolean; isNumeric: boolean; colCls: string }[]) {
      const tag = f.isCurrency ? "💱CUR" : f.isNumeric ? "🔢NUM" : "  ?  ";
      log(`     ${tag} [${f.rowLabel}] name=${f.name} val="${f.value}" col=${f.colCls.slice(0, 40)}`);
    }

    // === ทดสอบช่องสกุลเงินราคา (_Amount_input) ด้วยหลายวิธี → หาวิธีที่ค่าลง "USD" ===
    const curSel = 'input[name="_Amount_input"]';
    const numSel = 'input[name="_AmountForeign"]';
    const readBoth = async (tag: string) => {
      const c = await page2.locator(curSel).inputValue().catch(() => "?");
      const n = await page2.locator(numSel).inputValue().catch(() => "?");
      log(`  [${tag}] _Amount_input(สกุลเงิน)="${c}"  _AmountForeign(ตัวเลข)="${n}"`);
    };
    await readBoth("เริ่มต้น");

    // วิธี A: คลิกเปิด dropdown → รอ grid → คลิกแถว USD (ไม่พิมพ์)
    log("  🅰 วิธี A: คลิกเปิด dropdown แล้วเลือกแถว USD");
    await page2.locator(curSel).click();
    await sleep(1500);
    await page2.screenshot({ path: path.join(dir, "amount-cur-dropdownA.png"), fullPage: true }).catch(() => {});
    const dd = await page2.evaluate(() => {
      const cont = document.querySelector(".k-animation-container:not([style*='display: none']) [role=listbox], .k-list-container:not([style*='display: none']), .k-popup:not(.k-hidden)");
      if (!cont) return { found: false, rows: [] as string[] };
      const rows = Array.from(cont.querySelectorAll("li[role=option], tr")).slice(0, 6).map((r) => (r as HTMLElement).innerText?.replace(/\s+/g, " ").trim().slice(0, 40));
      return { found: true, rows };
    });
    log(`     dropdown found=${dd.found}, rows=[${(dd.rows as string[]).join(" || ")}]`);
    // ลองคลิกแถวที่มี USD
    try {
      const usdRow = page2.locator(".k-animation-container:visible li[role=option], .k-popup:visible li[role=option]").filter({ hasText: "USD" }).first();
      if (await usdRow.count()) { await usdRow.click(); log("     ✓ คลิกแถว USD แล้ว"); }
      else log("     ✗ ไม่เจอแถว USD ใน dropdown");
    } catch (e) { log(`     ✗ คลิก USD ล้ม: ${e}`); }
    await sleep(800);
    await readBoth("หลังวิธี A");

    // วิธี B: พิมพ์ "USD" ช้าๆ แล้วรอ filter
    log("  🅱 วิธี B: พิมพ์ USD ช้าๆ");
    await page2.locator(curSel).click();
    await page2.locator(curSel).fill("");
    await page2.locator(curSel).type("USD", { delay: 150 });
    await sleep(2500);
    await page2.screenshot({ path: path.join(dir, "amount-cur-dropdownB.png"), fullPage: true }).catch(() => {});
    const ddB = await page2.evaluate(() => {
      const cont = document.querySelector(".k-animation-container:not([style*='display: none']) [role=listbox], .k-popup:not(.k-hidden)");
      const rows = cont ? Array.from(cont.querySelectorAll("li[role=option], tr")).slice(0, 6).map((r) => (r as HTMLElement).innerText?.replace(/\s+/g, " ").trim().slice(0, 40)) : [];
      return rows;
    });
    log(`     หลังพิมพ์ rows=[${(ddB as string[]).join(" || ")}]`);
    await page2.keyboard.press("ArrowDown"); await page2.keyboard.press("Enter"); await sleep(800);
    await readBoth("หลังวิธี B");

    // ทดสอบใส่ตัวเลขลง _AmountForeign
    log("  🔢 ทดสอบใส่ 60811.2 ลง _AmountForeign");
    await page2.locator(numSel).click();
    await page2.keyboard.press("Control+A"); await page2.keyboard.press("Backspace");
    await page2.keyboard.type("60811.2", { delay: 30 });
    await sleep(500);
    await readBoth("หลังใส่ตัวเลข");
    await page2.screenshot({ path: path.join(dir, "amount-final.png"), fullPage: true }).catch(() => {});
  } catch (e) {
    log(`  ✗ inspect-currency error: ${e instanceof Error ? e.message : String(e)}`);
    await page.screenshot({ path: path.join(dir, "currency-error.png"), fullPage: true }).catch(() => {});
  }
}

async function runBrowser(
  records: Record[],
  rows: RowInfo[],
  cfg: AppConfig,
  opts: RunOptions,
  onlySet: Set<number> | null,
  setStatus: (i: number, s: RowStatus, e?: string) => void,
  result: RunResult,
): Promise<void> {
  const downloadDir = path.join(PROJECT_ROOT, cfg.download_dir ?? "file download");
  // headless: env RPA_HEADLESS override config.json (production VM ตั้ง RPA_HEADLESS=1 รันเงียบ
  //   โดยไม่ต้องแก้ config.json ที่ใช้ test แบบเห็น browser บนเครื่อง dev)
  //   "1"/"true" → true, "0"/"false" → false, ไม่ตั้ง → ใช้ cfg.headless (default false)
  const envHeadless = (process.env.RPA_HEADLESS ?? "").trim().toLowerCase();
  const headless = envHeadless === "1" || envHeadless === "true" ? true
    : envHeadless === "0" || envHeadless === "false" ? false
    : (cfg.headless ?? false);
  const browser = await chromium.launch({
    headless,
    slowMo: cfg.slow_mo_ms ?? 0,
  });
  const context: BrowserContext = await browser.newContext({ acceptDownloads: true });
  let page: Page = await context.newPage();
  page.setDefaultTimeout(cfg.default_timeout_ms ?? 30000);

  log(`open: ${cfg.url}`);
  // รอแค่ DOM พร้อม (ฟอร์ม login ใช้ได้ทันที) ไม่ต้องรอ resource ครบ (รูป/script เสริม)
  //   + เผื่อ timeout 45s กันหน้าโหลดช้า — กัน error "Timeout 15000ms ... waiting until load"
  await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await login(page, cfg.username, cfg.password);

  // ---- INSPECT-COMBO-CURRENCY: เปิดถึง Page 2 → คลิก currency → dump row + input value ----
  if (process.env.RPA_INSPECT_CURRENCY) {
    // เลือกใบที่ inspect: ใช้ใบแรกใน onlySet ถ้ามี (เจาะใบที่ต้องการ) ไม่งั้น records[0]
    const inspectIdx = onlySet && onlySet.size
      ? rows.findIndex((rw) => onlySet.has(rw.index))
      : 0;
    const inspectRec = records[inspectIdx >= 0 ? inspectIdx : 0];
    log(`🔍 inspect-currency: ใบ index=${rows[inspectIdx >= 0 ? inspectIdx : 0]?.index} (${String(inspectRec?.company_search ?? "")})`);
    await inspectCurrencyFlow(page, inspectRec, downloadDir);
    const holdSec = Number(process.env.RPA_INSPECT_SECONDS ?? "180") || 180;
    log(`⏸ inspect-currency — ค้าง ${holdSec}s`);
    await sleep(holdSec * 1000);
    await context.close(); await browser.close();
    return;
  }

  // ---- INSPECT-COMBO MODE: เปิด Page 1 → คลิก combo → dump dropdown ที่โผล่ ----
  if (process.env.RPA_INSPECT_COMBO) {
    await inspectComboFlow(page, downloadDir);
    const holdSec = Number(process.env.RPA_INSPECT_SECONDS ?? "300") || 300;
    log(`⏸ inspect-combo — ค้างเบราว์เซอร์ ${holdSec}s`);
    await sleep(holdSec * 1000);
    await context.close(); await browser.close();
    return;
  }

  // ---- INSPECT-EDIT MODE: dump element หน้าค้น/แก้ใบ (หา selectors) ----
  if (opts.inspectEdit) {
    await inspectEditFlow(page, downloadDir);
    const holdSec = Number(process.env.RPA_INSPECT_SECONDS ?? "600") || 600;
    log(`⏸ inspect-edit — ค้างเบราว์เซอร์ ${holdSec}s ให้ดูหน้าจอ (ดู element ใน inspect/)`);
    await sleep(holdSec * 1000);
    await context.close();
    await browser.close();
    return;
  }

  for (let idx = 0; idx < records.length; idx++) {
    const i = idx + 1; // 1-based

    if (opts.shouldStop?.()) {
      log("⏹ ได้รับสัญญาณหยุด — ยกเลิกแถวที่เหลือ");
      result.stopped = true;
      break;
    }

    if (onlySet && !onlySet.has(i)) {
      setStatus(idx, "skipped");
      result.skipped++;
      continue;
    }

    const record = records[idx];
    record.__dry_run__ = !!opts.dryRun;
    log(`========== Record ${i}${opts.inspect ? " [INSPECT]" : opts.dryRun ? " [DRY RUN]" : ""} ==========`);
    setStatus(idx, "running");

    // ---- INSPECT MODE: ไล่ dump element ทั้ง 3 หน้า (กรอก+Save เพื่อข้ามหน้า แต่ไม่ Finalize) ----
    if (opts.inspect) {
      record.__dry_run__ = false; // ต้องกรอก+Save จริงถึงจะข้ามหน้าได้
      try {
        // Page 1
        await openPortfolioAndAdd(page);
        await dumpPage(page, "page1", downloadDir);
        log("  🔍 dump Page 1 เสร็จ — กรอก+Save เพื่อไป Page 2");
        await fillPage1(page, record);

        // Page 2
        const page2 = await fillPage2Open(page);
        await dumpPage(page2, "page2", downloadDir);
        log("  🔍 dump Page 2 เสร็จ — กรอก+Save เพื่อไป Page 3");
        await fillPage2Fill(page2, record);

        // Page 3
        await dumpPage(page2, "page3", downloadDir);
        log("  🔍 dump Page 3 เสร็จ (ไม่ Finalize)");
        log("  ⏸ inspect: dump ครบ 3 หน้า — ดูไฟล์ใน inspect/page{1,2,3}.json");
        setStatus(idx, "done");
        result.done++;
      } catch (ex) {
        const msg = ex instanceof Error ? ex.message : String(ex);
        log(`  ✗ inspect error: ${msg}`);
        await dumpPage(page, "inspect_error", downloadDir).catch(() => {});
        setStatus(idx, "error", msg);
        result.errors++;
      }
      break; // inspect แค่ record เดียวพอ
    }

    // ---- REPRINT MODE: พิมพ์ใบเดิมซ้ำ (ไม่กรอก/ไม่สร้างใหม่) — ค้นใบใน DCTK → พิมพ์ PDF ----
    if (opts.mode === "reprint") {
      try {
        const declNo = String(opts.editDeclarationNo ?? record.declaration_no ?? "");
        if (!declNo) throw new Error("ไม่มีเลขใบขน DCTK สำหรับพิมพ์ซ้ำ");
        const { pdf, declarationNo } = await reprintDeclaration(page, context, downloadDir, declNo);
        if (!pdf) throw new Error("พิมพ์ใบขนซ้ำไม่สำเร็จ (ดู log — DCTK อาจค้าง/หาใบไม่เจอ)");
        // อัปเอกสารใบขนจริง (declaration) → caller เก็บลง Supabase
        if (opts.onDocument) {
          const { customer, invoice } = rowLabel(record);
          try {
            await opts.onDocument({ filePath: pdf, kind: "declaration", customer, invoice });
          } catch (e) {
            log(`  ⚠ onDocument callback error: ${e}`);
          }
        }
        // ยืนยันเลขใบขน (เผื่อ caller ยังไม่มี)
        if (declarationNo && opts.onCaptureMeta) {
          try {
            await opts.onCaptureMeta({
              declarationId: record.__supabase_id__ != null ? String(record.__supabase_id__) : undefined,
              declarationNo,
            });
          } catch { /* ignore */ }
        }
        setStatus(idx, "done");
        result.done++;
      } catch (ex) {
        const msg = ex instanceof Error ? ex.message : String(ex);
        log(`  ✗ พิมพ์ซ้ำ Record ${i} error: ${msg}`);
        setStatus(idx, "error", msg);
        result.errors++;
      }
      continue;
    }

    // ---- EDIT MODE: ค้นใบเดิมใน DCTK → แก้ช่อง → save (reuse fillPage*) ----
    if (opts.mode === "edit") {
      try {
        const declNo = String(opts.editDeclarationNo ?? record.declaration_no ?? "");
        if (!declNo) throw new Error("ไม่มีเลขใบขน DCTK สำหรับค้นเพื่อแก้");
        log(`  ✏️ แก้ไขใบเลข ${declNo}`);
        const editPage = await openDeclarationForEdit(page, declNo);
        await fillPage1(editPage, record);
        const page2 = await fillPage2(editPage, record);
        await fillPage3(page2, record);
        await saveDeclarationEdit(page2);
        if (record.__supabase_id__ != null) {
          await markDeclarationDone(record.__supabase_id__);
        }
        setStatus(idx, "done");
        result.done++;
      } catch (ex) {
        const msg = ex instanceof Error ? ex.message : String(ex);
        log(`  ✗ แก้ไข Record ${i} error: ${msg}`);
        const shot = path.join(PROJECT_ROOT, `error_edit_${i}.png`);
        try {
          await page.screenshot({ path: shot, fullPage: true });
          (record.__screenshot_paths__ ??= []).push(shot);
        } catch { /* ignore */ }
        setStatus(idx, "error", msg);
        result.errors++;
      }
      // รวม screenshot เป็น Capture PDF เดียว แล้วอัป (ไม่อัป PNG แยก)
      const editShots = (record.__screenshot_paths__ as string[] | undefined) ?? [];
      if (editShots.length && opts.onDocument) {
        const { customer, invoice } = rowLabel(record);
        try {
          const capturePdf = await buildCapturePdf(record);
          if (capturePdf) await opts.onDocument({ filePath: capturePdf, kind: "capture", customer, invoice });
        } catch { /* ignore */ }
      }
      continue;
    }

    try {
      await openPortfolioAndAdd(page);
      await fillPage1(page, record);
      const page2 = await fillPage2(page, record);
      await fillPage3(page2, record);
      if (opts.dryRun) {
        log("  🧪 dry run: ข้าม finalize/print/email — กรอกข้อมูลครบแล้วแต่ไม่บันทึก");
      } else {
        // เรียก finalize ครั้งเดียว (สร้างใบ + พยายามพิมพ์) — เก็บผลไว้ใช้ต่อ
        const finalizeRes = await finalizeAndPrint(page2, context, downloadDir);
        let pdf = finalizeRes.pdf;
        // declarationNo: ใช้จาก finalize ก่อน ไม่งั้น fallback เลขที่จับไว้ตั้งแต่ Page 2 (เผื่อ save ค้าง)
        const declarationNo = finalizeRes.declarationNo
          || (typeof record.__declaration_no__ === "string" ? record.__declaration_no__ : null);
        if (!finalizeRes.declarationNo && declarationNo) {
          log(`  🧾 finalize อ่านเลขใบขนไม่ได้ — ใช้เลขที่จับไว้ตั้งแต่ Page 2: ${declarationNo}`);
        }
        // capture เลขใบขน DCTK → แจ้ง caller เก็บลง declarations.declaration_no
        if (declarationNo) {
          result.declarationCreated = true; // ใบสร้างใน DCTK แล้ว — worker ห้าม retry import (กันใบซ้ำ)
          if (opts.onCaptureMeta) {
            try {
              await opts.onCaptureMeta({
                declarationId: record.__supabase_id__ != null ? String(record.__supabase_id__) : undefined,
                declarationNo,
              });
            } catch (e) {
              log(`  ⚠ onCaptureMeta callback error: ${e}`);
            }
          }
        }

        // ⏱ AUTO-REPRINT: ถ้า finalize ได้เลขใบขนแล้ว (ใบสร้างใน DCTK สำเร็จ) แต่ PDF=null
        //    (DCTK ค้างตอนพิมพ์ → ได้แต่ capture) → ลองพิมพ์ซ้ำเองทันที (login อยู่แล้ว ไม่ต้องเริ่มใหม่)
        //    ทำให้ได้ใบขนจริงโดย user ไม่ต้องกดพิมพ์ซ้ำเอง
        if (!pdf && declarationNo) {
          for (let rp = 1; rp <= 2 && !pdf; rp++) {
            log(`  ↻ finalize ได้แต่ capture (ใบ ${declarationNo} สร้างแล้ว) — auto-reprint พิมพ์ใบขนจริง (รอบ ${rp}/2)`);
            try {
              const re = await reprintDeclaration(page, context, downloadDir, declarationNo);
              if (re.pdf) { pdf = re.pdf; log(`  ✓ auto-reprint สำเร็จ — ได้ใบขนจริง`); break; }
            } catch (e) {
              log(`  ⚠ auto-reprint รอบ ${rp} error: ${e instanceof Error ? e.message.slice(0, 80) : ""}`);
            }
            await sleep(3000);
          }
          if (!pdf) log(`  ✗ auto-reprint ไม่สำเร็จทั้ง 2 รอบ — เก็บ capture ไว้ก่อน (กดพิมพ์ซ้ำในเว็บภายหลังได้)`);
        }

        if (pdf) {
          // แจ้ง caller ให้อัปเอกสาร (เช่น Supabase) ก่อนส่งอีเมล
          if (opts.onDocument) {
            try {
              const { customer, invoice } = rowLabel(record);
              await opts.onDocument({ filePath: pdf, kind: "declaration", customer, invoice });
            } catch (e) {
              log(`  ⚠ onDocument callback error: ${e}`);
            }
          }
          await sendEmailWithPdf(pdf, cfg, record);
        }
        // mark ใน Supabase ว่าทำเอกสารแล้ว (เฉพาะรันจริง)
        if (record.__supabase_id__ != null) {
          await markDeclarationDone(record.__supabase_id__);
        }
      }
      setStatus(idx, "done");
      result.done++;
    } catch (ex) {
      const msg = ex instanceof Error ? ex.message : String(ex);
      log(`  ✗ Record ${i} error: ${msg}`);
      const shot = path.join(PROJECT_ROOT, `error_record_${i}.png`);
      try {
        await page.screenshot({ path: shot, fullPage: true });
        log(`    saved screenshot: ${shot}`);
        (record.__screenshot_paths__ ??= []).push(shot); // ให้อัปขึ้น Supabase ด้วย
      } catch {
        /* ignore */
      }
      setStatus(idx, "error", msg);
      result.errors++;
    }

    // รวม screenshot ที่ capture ไว้เป็น "PDF เดียว" (Capture_<customer>.pdf) แล้วอัปขึ้น Supabase
    //   (แทนการอัป PNG แยกทีละรูป — ผู้ใช้ต้องการไฟล์เดียวที่มีทุกหน้า)
    const shots = (record.__screenshot_paths__ as string[] | undefined) ?? [];
    if (shots.length && opts.onDocument) {
      const { customer, invoice } = rowLabel(record);
      try {
        const capturePdf = await buildCapturePdf(record);
        if (capturePdf) {
          await opts.onDocument({ filePath: capturePdf, kind: "capture", customer, invoice });
          log(`  📤 อัป Capture PDF (รวม ${shots.length} หน้า) ขึ้น Supabase`);
        }
      } catch (e) {
        log(`  ⚠ สร้าง/อัป Capture PDF ไม่สำเร็จ: ${e}`);
      }
    }
  }

  // inspect mode: ค้างเบราว์เซอร์ไว้นานให้ดูหน้าจอ
  if (opts.inspect) {
    const holdSec = Number(process.env.RPA_INSPECT_SECONDS ?? "600") || 600;
    log(`⏸ inspect mode — ค้างเบราว์เซอร์ ${holdSec}s ให้ดูหน้าจอ (ดู element ใน inspect/)`);
    await sleep(holdSec * 1000);
    await context.close();
    await browser.close();
    return;
  }

  // ถ้ามี error และตั้ง RPA_PAUSE_ON_ERROR=1 → ค้างเบราว์เซอร์ไว้ให้ดูหน้าจอ (เช่น modal)
  const pauseOnError =
    result.errors > 0 && ["1", "true", "yes"].includes(
      (process.env.RPA_PAUSE_ON_ERROR ?? "").trim().toLowerCase(),
    );
  if (pauseOnError) {
    const holdSec = Number(process.env.RPA_PAUSE_SECONDS ?? "600") || 600;
    log(`⏸ พบ error — ค้างเบราว์เซอร์ไว้ ${holdSec}s ให้ตรวจหน้าจอ (RPA_PAUSE_ON_ERROR=1)`);
    await sleep(holdSec * 1000);
  } else {
    log("done — closing in 2s");
    await sleep(2000);
  }
  await context.close();
  await browser.close();
}
