// ============================================================
//  Master ข้อมูล — ตรรกะการนำ Master มาใช้กับใบขน
//
//  โหมดรายช่อง (ตั้งไว้ล่วงหน้าตอนสร้าง Master):
//    'master' → ใช้ค่าใน Master เสมอ ทับค่าที่ AI สกัดมา
//    'ai'     → ปล่อยให้ AI สกัด; Master เติมให้เฉพาะช่องที่ AI ไม่ได้ค่า
//    'off'    → ไม่กรอกช่องนี้ลง DCTK (worker ข้าม)
//
//  ไม่ระบุโหมด = เดาให้อัตโนมัติ: Master มีค่า → 'master', ไม่มีค่า → 'ai'
// ============================================================
import type { DeclarationTemplate, FieldMode } from "./supabase.js";

const isEmpty = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/** โหมดที่ใช้จริงของช่องหนึ่ง (ตามที่ตั้งไว้ หรือเดาจากการมีค่าใน Master) */
export function effectiveMode(tpl: DeclarationTemplate, key: string): FieldMode {
  const set = tpl.field_modes?.[key];
  if (set === "master" || set === "ai" || set === "off") return set;
  return isEmpty(tpl.header?.[key]) ? "ai" : "master";
}

export interface ApplyResult {
  /** record หลังผสม Master แล้ว (พร้อมส่งเข้า createDeclaration) */
  record: Record<string, unknown>;
  /** โหมดรายช่องที่ต้องบันทึกติดไปกับใบ (worker ใช้ตอนกรอก) */
  fieldModes: { [key: string]: FieldMode };
  /** ช่องที่ Master เขียนทับค่าเดิม */
  overridden: string[];
  /** ช่องที่ Master เติมให้เพราะเดิมว่าง */
  filled: string[];
}

/**
 * ผสม Master เข้ากับ record (ค่าที่ AI สกัดมา / ที่ผู้ใช้กรอก)
 *
 * @param tpl     Master ที่เลือก
 * @param base    record ตั้งต้น ({} = สร้างใบใหม่จาก Master ล้วน ๆ)
 * @param opts.includeItems  คัดลอกรายการสินค้าจาก Master เมื่อ base ยังไม่มีรายการ
 */
export function applyTemplate(
  tpl: DeclarationTemplate,
  base: Record<string, unknown> = {},
  opts: { includeItems?: boolean } = {},
): ApplyResult {
  const record: Record<string, unknown> = { ...base };
  const fieldModes: { [key: string]: FieldMode } = {};
  const overridden: string[] = [];
  const filled: string[] = [];

  const header = tpl.header ?? {};
  // ครอบคลุมทั้งช่องที่ Master มีค่า และช่องที่ตั้งโหมดไว้แต่ไม่มีค่า (เช่นตั้ง 'off')
  const keys = new Set([...Object.keys(header), ...Object.keys(tpl.field_modes ?? {})]);

  for (const key of keys) {
    const mode = effectiveMode(tpl, key);
    fieldModes[key] = mode;
    const tplVal = header[key];

    if (mode === "off") {
      // ไม่กรอกช่องนี้ — ล้างค่าที่ติดมาจาก AI ด้วย กันหลุดลง DCTK
      if (!isEmpty(record[key])) overridden.push(key);
      record[key] = "";
      continue;
    }
    if (isEmpty(tplVal)) continue;               // Master ไม่มีค่าให้ใช้

    if (mode === "master") {
      if (!isEmpty(record[key]) && String(record[key]) !== String(tplVal)) overridden.push(key);
      record[key] = tplVal;
    } else if (isEmpty(record[key])) {           // mode 'ai' → เติมเฉพาะช่องว่าง
      record[key] = tplVal;
      filled.push(key);
    }
  }

  // รายการสินค้า: ใช้ของ Master เมื่อ record ยังไม่มีรายการเลย
  const curItems = (record._items as unknown[] | undefined) ?? [];
  if (opts.includeItems !== false && !curItems.length && (tpl.items?.length ?? 0) > 0) {
    record._items = tpl.items.map((it) => ({ ...it }));
  }

  return { record, fieldModes, overridden, filled };
}

/** ช่องที่สั่ง "ไม่กรอก" — worker เอาไปข้ามตอนกรอกฟอร์ม */
export function offFields(modes: { [key: string]: FieldMode } | null | undefined): string[] {
  if (!modes) return [];
  return Object.entries(modes).filter(([, m]) => m === "off").map(([k]) => k);
}
