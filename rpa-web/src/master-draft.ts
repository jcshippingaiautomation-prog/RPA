// ============================================================
//  ร่าง Master จากเอกสาร — "ให้ AI ช่วยสร้าง Master"
//
//  ผู้ใช้แจ้ง 10 ต.ค. 2569 ว่าอยากเพิ่ม Master เองได้โดยมี AI ช่วย
//  ที่ผ่านมา Master เกิดได้ 2 ทางเท่านั้น คือดึงจากใบขนใน DCTK
//  หรือให้คนเขียนประกอบให้ทีละช่อง ซึ่งผู้ใช้ทำเองไม่ได้
//
//  ที่นี่รับ "ผลที่ AI อ่านจากเอกสาร" (ผ่านขั้นตอนเดียวกับตอนอัปโหลดใบขน)
//  แล้วแปลงเป็นร่าง Master ให้ผู้ใช้ตรวจก่อนกดบันทึก — ยังไม่เขียนฐานข้อมูล
// ============================================================
import { rowToFields } from "./field-registry.js";
import type { DeclarationTemplate, FieldMode } from "./supabase.js";

/**
 * ช่องที่ "เปลี่ยนทุกชิปเมนต์" — ต้องอ่านจากเอกสารใหม่ทุกใบ ไม่ใช่ค่าตายตัวของ Master
 * (ชุดเดียวกับที่ rpa-import-node/src/pull-master-cli.ts ใช้ตอนดึง Master จากใบขนจริง
 *  ถ้าแก้ที่นั่นต้องแก้ที่นี่ด้วย)
 */
const SHIPMENT_EXACT = new Set([
  "invoice_no", "invoice_date", "departure_date",
  "vessel_name", "voyage", "mawb", "hawb", "po_number", "reference_no_common",
  "total_gross_weight", "total_net_weight", "total_quantity", "total_package",
  "net_weight", "gross_weight", "package", "quantity", "inv_quantity",
  "released_port", "loaded_port",
]);
const SHIPMENT_SUFFIX = ["_foreign", "_baht", "_exchange_rate"];

/** ช่องนี้ควรตั้งโหมดอะไรใน Master ที่เพิ่งร่าง */
export function defaultMode(key: string): FieldMode {
  // หน่วยผูกกับผู้รับ/พิกัด ไม่ใช่รายชิปเมนต์ — ต้องให้ Master ชนะเสมอ
  //   (ลูกค้าแจ้งมาแล้ว 2 รอบ: ได้ "TO" แทน TNE และ 44.000 TNE แทน 44,000 KGM)
  if (key.endsWith("_unit_code")) return "master";
  if (SHIPMENT_EXACT.has(key) || SHIPMENT_SUFFIX.some((s) => key.endsWith(s))) return "ai";
  return "master";
}

/** ค่าที่เป็นของชิปเมนต์นี้เท่านั้น ไม่ควรติดไปกับ Master (ยอดเงิน/น้ำหนัก/วันที่/เรือ) */
function stripShipmentValues(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (defaultMode(k) === "ai") continue;
    if (v === null || v === undefined || String(v).trim() === "") continue;
    out[k] = v;
  }
  return out;
}

/**
 * แปลง "ใบขนที่ AI อ่านมา" → ร่าง Master (ยังไม่บันทึก)
 * @param record ผลจาก prepareDeclarationRecord()
 */
export async function draftTemplateFromRecord(
  record: Record<string, unknown> & { _items?: Record<string, unknown>[] },
  customer: string,
): Promise<DeclarationTemplate & { _guessed: string[] }> {
  const headerAll = await rowToFields(record, "header");
  const header = stripShipmentValues(headerAll);
  const items: Record<string, unknown>[] = [];
  for (const it of record._items ?? []) {
    items.push(stripShipmentValues(await rowToFields(it, "item")));
  }
  const consignee = String(record.consignee_name ?? "").trim();
  const products = [...new Set((record._items ?? [])
    .map((it) => String((it as Record<string, unknown>).description_eng ?? "").trim())
    .filter(Boolean))];

  const field_modes: { [k: string]: FieldMode } = {};
  for (const k of [...Object.keys(headerAll), ...items.flatMap((i) => Object.keys(i))]) {
    field_modes[k] = defaultMode(k);
  }
  // ช่องที่ AI มักอ่านไม่ครบ — บอกผู้ใช้ให้ตรวจก่อนใช้งานจริง
  const guessed: string[] = [];
  for (const [label, key] of [["พิกัดศุลกากร", "tariff_code"], ["รหัสสถิติสินค้า", "statistical_code"],
    ["ท่าที่ตรวจปล่อย", "released_port"], ["ท่าที่รับบรรทุก", "loaded_port"]] as const) {
    const has = items.some((i) => String(i[key] ?? "").trim()) || String(header[key] ?? "").trim();
    if (!has) guessed.push(label);
  }
  return {
    name: [customer, consignee, products[0]].filter(Boolean).join(" — ").slice(0, 120),
    label: "",
    customer_name: customer,
    description: `ร่างจากเอกสารด้วย AI (ใบกำกับ ${String(record.invoice_number ?? "-")}) — ตรวจก่อนใช้งานจริง`,
    consignee_names: consignee ? [consignee] : [],
    product_codes: products,
    priority: 0,
    header, items, field_modes, is_default: false,
    _guessed: guessed,
  } as DeclarationTemplate & { _guessed: string[] };
}
