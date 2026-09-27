// ============================================================
//  ตรวจ "คลัง Master" ว่าตั้งค่าไว้ถูกต้องไหม — ก่อนจะเอาไปใช้กับใบจริง
//
//  ทำไมต้องมี: Master ตั้งผิดทีเดียว ใบขนของลูกค้ารายนั้นพังทุกใบ
//  และอาการมักเงียบ (ค่าผิดถูกส่งเข้า DCTK แล้วค่อยตีกลับตอนหน้า 3)
//  เคสจริงที่เคยเจอและกฎในไฟล์นี้จับได้:
//    · วิธีชำระอากร "L" ทั้งที่ติ๊กชำระค่าธรรมเนียม (DCTK ต้องการ A/H)
//    · หน่วยหีบห่อ "FB" ที่ไม่มีในรายการของกรมฯ (ต้องเป็น "1F")
//    · ชื่อผู้ซื้อยาวเกิน 70 · ที่อยู่ยาวเกิน 35
//    · ตั้งช่องชื่อลูกค้า/เลขใบกำกับเป็น "ไม่กรอก" → ใบกลายเป็น null ทั้งชุด
//    · ตรึงสกุลเงิน/น้ำหนักไว้ใน Master → ทับค่าที่อ่านจากเอกสารเงียบ ๆ
//
//  ใช้กฎชุดเดียวกับที่ใช้ตรวจใบขน (field-rules.json) ไม่ได้เขียนกฎซ้ำ
// ============================================================
import { loadDctkRules, type CrossFieldRule } from "./dctk-rules.js";
import type { DeclarationTemplate } from "./supabase.js";

export interface MasterIssue {
  level: "error" | "warn";
  key: string;
  label: string;
  message: string;
  itemLine?: number;
}

/** ช่องที่ผูกกับคอลัมน์ระบุตัวตนของใบ — ตั้ง "ไม่กรอก" ไม่ได้ */
const IDENTITY_KEYS: { [k: string]: string } = {
  cmp_name_thai: "ชื่อลูกค้า (ใช้ค้นบริษัทผู้ส่งออกใน DCTK)",
  invoice_no: "เลขที่ใบกำกับ (ใช้ระบุใบ + กันสร้างซ้ำ)",
};

/** ช่องที่ต้องเปลี่ยนทุกชิปเมนต์ — ตรึงไว้ใน Master แล้วจะทับค่าจากเอกสาร */
const VOLATILE_KEYS: { [k: string]: string } = {
  amount: "สกุลเงิน", amount_currency: "สกุลเงินราคาสินค้า", unit_price: "สกุลเงินราคาต่อหน่วย",
  amount_foreign: "ยอดเงิน", freight_foreign: "ค่าระวาง", insurance_foreign: "ค่าประกัน",
  total_net_weight: "น้ำหนักสุทธิรวม", total_gross_weight: "น้ำหนักรวมหีบห่อ",
  net_weight: "น้ำหนักสุทธิ", gross_weight: "น้ำหนักรวม",
  total_package: "จำนวนหีบห่อรวม", package: "จำนวนหีบห่อ",
  quantity: "ปริมาณ", inv_quantity: "ปริมาณในใบกำกับ",
  invoice_date: "วันที่ใบกำกับ", departure_date: "วันที่ส่งออก",
  vessel_name: "ชื่อยานพาหนะ", voyage: "เที่ยวเรือ",
  // ⚠ ไม่ใส่ tariff_code ไว้ในนี้ — ลูกค้าที่ขายสินค้าชนิดเดียว (ไทยซิง/ธนากร/COCOS)
  //   พิกัดคงที่จริง ๆ ต่อ Master การเตือนจะกลายเป็นเสียงรบกวน 19 ข้อจาก 25 อัน
  //   ลูกค้าที่พิกัดเปลี่ยนต่อรายการ (Q-Cine/สยามฮิตาชิ) จะถูกจับด้วยชั้นที่ 2 แทน
};

/** ค่าที่ตั้งเป็น "ตัวแทน" โดยตั้งใจ — ไม่ใช่การตรึงค่าจริง จึงไม่ต้องเตือน */
const PLACEHOLDER = /^(x+|n\/a|na|-|tbd|tba|\.)$/i;

/** ช่องที่ Master "ควรมี" ไม่งั้นใบจะกรอกไม่ครบ (เตือนเฉย ๆ ไม่บล็อก) */
const EXPECTED_KEYS: { [k: string]: string } = {
  consignee_name: "ชื่อผู้ซื้อ",
  consignee_street_and_no: "ที่อยู่ผู้ซื้อ (เลขที่/ถนน)",
  loaded_port: "สถานที่รับบรรทุก",
  brand: "ยี่ห้อสินค้า",
  export_tariff: "ประเภทพิกัดขาออก",
};

const str = (v: unknown): string => String(v ?? "").trim();
const has = (v: unknown): boolean => str(v) !== "";

/** อ่านค่าของ key จาก Master (หัวใบ หรือ แถวรายการ) */
function pick(tpl: DeclarationTemplate, key: string, item?: Record<string, unknown>): unknown {
  if (item && key in item) return item[key];
  return (tpl.header as Record<string, unknown> | undefined)?.[key];
}

/** โหมดที่ตั้งไว้จริงของช่อง (ไม่เดาปริยาย — ต้องการรู้ว่า "ตั้งไว้" หรือเปล่า) */
function modeOf(tpl: DeclarationTemplate, key: string): string {
  return str(tpl.field_modes?.[key]);
}

/** ประเมินว่ากฎข้ามช่องข้อนี้ "มีผล" กับค่าชุดนี้ไหม */
function applies(c: CrossFieldRule, get: (k: string) => unknown): boolean {
  const truthy = (v: unknown) => /^(1|true|yes|y|on|ใช่)$/i.test(str(v));
  if (c.when.always) return true;
  if (c.when.field && c.when.isTrue) return truthy(get(c.when.field));
  if (c.when.field && c.when.notEmpty) return has(get(c.when.field));
  if (c.when.anyNotEmpty) return c.when.anyNotEmpty.some((k) => has(get(k)));
  if (c.when.bothNotEmpty) return c.when.bothNotEmpty.every((k) => has(get(k)));
  if (c.when.anyFieldEquals) return str(get(c.when.anyFieldEquals.field)).includes(c.when.anyFieldEquals.contains);
  return false;
}

/** ข้อกำหนดของกฎข้ามช่องผ่านไหม (คืน true = ผิด) */
function fails(c: CrossFieldRule, get: (k: string) => unknown): boolean {
  const req = c.require;
  if (req.itemsMin !== undefined) return false;           // นับรายการ — ไม่เกี่ยวกับ Master
  if (req.allNotEmpty) return req.allNotEmpty.some((k) => !has(get(k)));
  if (req.anyNotEmpty) return req.anyNotEmpty.every((k) => !has(get(k)));
  if (req.field && req.oneOf) {
    const v = str(get(req.field)).toUpperCase();
    if (!v) return false;                                  // ยังไม่ได้ตั้ง = ไม่ตัดสิน
    return !req.oneOf.some((o) => v === o || v.startsWith(o + " ") || v.startsWith(o + "-"));
  }
  if (req.field && req.maxLength !== undefined) return str(get(req.field)).length > req.maxLength;
  if (req.field && req.matches) {
    const v = str(get(req.field));
    return v ? !new RegExp(req.matches).test(v) : false;
  }
  return false;
}

/**
 * ตรวจ Master หนึ่งอัน
 *   error = ใช้แล้วใบพังแน่ ๆ · warn = ควรดู แต่ไม่ถึงกับพัง
 */
export async function validateMaster(
  tpl: DeclarationTemplate,
): Promise<{ ok: boolean; issues: MasterIssue[] }> {
  const issues: MasterIssue[] = [];
  const add = (i: MasterIssue) => issues.push(i);
  const rules = await loadDctkRules();
  const items = (tpl.items ?? []) as Record<string, unknown>[];

  // ── 1) ค่าที่ตั้งไว้ อยู่ในรายการที่กรมฯ รับไหม ──────────────────
  //   ใช้เฉพาะรายการที่กวาดมาครบจริง (reliable) — ที่ได้มาบางส่วนใช้ตัดสินไม่ได้
  for (const vl of rules.valueLists ?? []) {
    if (!vl.reliable || !vl.codes?.length) continue;
    const codes = new Set(vl.codes.map((c) => c.toUpperCase()));
    for (const f of vl.fields ?? []) {
      const rows: [Record<string, unknown> | undefined, number | undefined][] =
        f.scope === "item" ? items.map((it, i) => [it, i + 1]) : [[undefined, undefined]];
      for (const [row, line] of rows) {
        const v = str(pick(tpl, f.key, row));
        if (!v || codes.has(v.toUpperCase())) continue;
        add({ level: "error", key: f.key, label: f.label, itemLine: line,
          message: `"${v}" ไม่มีใน${vl.label}ที่กรมฯ รับ (${vl.count} ค่า) — RPA จะค้นไม่เจอแล้วกรอกไม่ได้` });
      }
    }
  }

  // ── 2) ความยาว / รูปแบบ ตามที่กรมฯ กำหนด ────────────────────────
  for (const f of rules.fields ?? []) {
    const rows: [Record<string, unknown> | undefined, number | undefined][] =
      f.scope === "item" ? items.map((it, i) => [it, i + 1]) : [[undefined, undefined]];
    for (const [row, line] of rows) {
      const v = str(pick(tpl, f.key, row));
      if (!v) continue;
      if (f.maxLength && v.length > f.maxLength) {
        add({ level: "error", key: f.key, label: f.label, itemLine: line,
          message: `ยาว ${v.length} ตัวอักษร — กรมฯ รับไม่เกิน ${f.maxLength}` });
      }
      if (f.regex && !new RegExp(f.regex).test(v)) {
        add({ level: "warn", key: f.key, label: f.label, itemLine: line,
          message: f.regexMessage || `รูปแบบไม่ตรงที่กรมฯ กำหนด` });
      }
    }
  }

  // ── 3) กฎข้ามช่อง (เช่น ติ๊กชำระค่าธรรมเนียม → วิธีชำระต้องเป็น A/H) ──
  for (const c of rules.crossField ?? []) {
    const rows: [Record<string, unknown> | undefined, number | undefined][] =
      c.scope === "item" ? items.map((it, i) => [it, i + 1]) : [[undefined, undefined]];
    for (const [row, line] of rows) {
      const get = (k: string) => pick(tpl, k, row);
      if (!applies(c, get) || !fails(c, get)) continue;
      add({ level: c.level, key: c.require.field ?? c.when.field ?? c.id, label: c.id, itemLine: line,
        message: c.message });
    }
  }

  // ── 4) ช่องระบุตัวตนของใบ ห้ามตั้งเป็น "ไม่กรอก" ────────────────
  for (const [k, label] of Object.entries(IDENTITY_KEYS)) {
    if (modeOf(tpl, k) !== "off") continue;
    add({ level: "error", key: k, label,
      message: `ตั้งเป็น "ไม่กรอก" ไม่ได้ — ${label} จะถูกล้างทิ้ง ทำให้ใบที่อัปโหลดกลายเป็นใบไม่มีชื่อ กดรันไม่ได้` });
  }

  // ── 5) ช่องที่เปลี่ยนทุกชิปเมนต์ ไม่ควรตรึงไว้ใน Master ──────────
  for (const [k, label] of Object.entries(VOLATILE_KEYS)) {
    const mode = modeOf(tpl, k);
    const vHead = pick(tpl, k);
    const vItem = items.find((it) => has(it[k]));
    if (!has(vHead) && !vItem) continue;
    // "master" ที่ตั้งไว้ชัด หรือมีค่าแต่ไม่ได้ตั้งโหมด (= ปริยายเป็น master)
    if (mode === "ai" || mode === "off") continue;
    // "xxx" / "N/A" = ตั้งใจใส่ไว้ให้เจ้าหน้าที่แก้เอง (เช่น ชื่อเรือของไทยซิง) ไม่ใช่การตรึงค่า
    if (PLACEHOLDER.test(str(vHead || vItem?.[k]))) continue;
    add({ level: "warn", key: k, label,
      message: `ตั้งค่าตายตัวไว้ ("${str(vHead || vItem?.[k])}") จะทับค่าที่อ่านจากเอกสารทุกใบ — ช่องนี้ปกติเปลี่ยนทุกชิปเมนต์ ควรตั้งเป็น "อ่านจากเอกสาร"` });
  }

  // ── 6) ช่องที่ควรมี แต่ยังว่าง ──────────────────────────────────
  for (const [k, label] of Object.entries(EXPECTED_KEYS)) {
    if (modeOf(tpl, k) === "off") continue;               // ตั้งใจไม่กรอก = ไม่เตือน
    const inItems = items.some((it) => has(it[k]));
    if (has(pick(tpl, k)) || inItems) continue;
    add({ level: "warn", key: k, label,
      message: `ยังไม่ได้ตั้งค่า — ถ้าเอกสารไม่มีข้อมูลนี้ ใบจะกรอกไม่ครบ` });
  }

  return { ok: !issues.some((i) => i.level === "error"), issues };
}
