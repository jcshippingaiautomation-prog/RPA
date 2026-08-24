// ============================================================
//  Field Registry (ฝั่งเว็บ) — อ่านทะเบียนช่องจาก rpa-import-node
//
//  ทะเบียนช่อง = แหล่งความจริงเดียวว่า DCTK มีช่องอะไรบ้าง (133 ช่อง / 3 หน้า)
//  ใช้ 2 อย่าง:
//    1) ส่งให้ frontend เรนเดอร์ฟอร์มครบทุกช่อง (/api/field-registry)
//    2) แยกค่าที่ส่งมาจากฟอร์ม → "คอลัมน์จริง" vs "extra_fields (jsonb)"
//       เพิ่มช่องใหม่ในอนาคต = แก้ registry อย่างเดียว ไม่ต้อง migrate DB
// ============================================================
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

export interface FieldDef {
  key: string;
  label: string;
  page: 1 | 2 | 3;
  /** หน้าในฟอร์มของเรา (แยกสิทธิประโยชน์เป็นหน้า 4 ตามที่ตกลงกับลูกค้า) */
  formPage: 1 | 2 | 3 | 4;
  group: string;
  type: "text" | "textarea" | "number" | "combo" | "dropdown" | "date" | "checkbox" | "radio" | "select";
  selector: string | null;
  selectorConst: string | null;
  column: string | null;
  scope: "header" | "item";
  fill: boolean;
  computed: boolean;
  ai: boolean;
  required: boolean;
  readonlyInDctk: boolean;
  /** ช่องสถานะ/ประวัติของ DCTK — ซ่อนจากฟอร์ม แต่ข้อมูลยังเก็บและ RPA ยังกรอก */
  system: boolean;
  dctkName: string;
  options: { value: string; text: string }[];
  catalogKey: string | null;
}

const require = createRequire(import.meta.url);
const RPA_ROOT = path.dirname(require.resolve("rpa-import-node/package.json"));
// dist ก่อน (production build) → src เป็น fallback (dev ที่ยังไม่ได้ build)
const CANDIDATES = [
  path.join(RPA_ROOT, "dist", "data", "field-registry.json"),
  path.join(RPA_ROOT, "src", "data", "field-registry.json"),
];

let _registry: FieldDef[] | null = null;

export async function loadRegistry(): Promise<FieldDef[]> {
  if (_registry) return _registry;
  for (const p of CANDIDATES) {
    try {
      _registry = JSON.parse(await readFile(p, "utf-8")) as FieldDef[];
      return _registry;
    } catch { /* ลองไฟล์ถัดไป */ }
  }
  console.warn("[registry] ไม่พบ field-registry.json — ฟอร์มจะแสดงเฉพาะช่องเดิม");
  _registry = [];
  return _registry;
}


// คอลัมน์ที่เป็นตัวเลขใน Supabase — ฟอร์มมี 300+ ช่อง ผู้ใช้พิมพ์อะไรมาก็ได้
//   ("42.000 TNE", "1,234.50") → ต้องดึงเฉพาะตัวเลขก่อนเขียน ไม่งั้น insert พัง (invalid input syntax)
const NUMERIC_COLUMNS = new Set([
  "total_goods_amount", "freight_charge", "insurance_charge",
  "net_weight_kg", "gross_weight_kg", "net_weight_ton",
  "container_or_volume_qty", "amount", "insurance",
]);
const BOOLEAN_COLUMNS = new Set(["is_foc", "doc_status"]);

/** แปลงค่าที่ผู้ใช้พิมพ์ → ชนิดที่คอลัมน์นั้นรับได้ (คืน null ถ้าว่าง) */
function coerce(column: string, v: unknown): unknown {
  if (v === "" || v === null || v === undefined) return null;
  if (NUMERIC_COLUMNS.has(column)) {
    // ตัดคอมมา + หน่วยที่ติดมา ("1,234.50 KGM" → 1234.5)
    const m = String(v).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
  }
  if (BOOLEAN_COLUMNS.has(column)) {
    if (typeof v === "boolean") return v;
    return /^(1|true|yes|y|on|ใช่)$/i.test(String(v).trim());
  }
  return v;
}

/** key → นิยามช่อง (แยก header/item เพราะ key ซ้ำกันได้ข้าม scope) */
async function indexBy(scope: "header" | "item"): Promise<Map<string, FieldDef>> {
  const all = await loadRegistry();
  return new Map(all.filter((f) => f.scope === scope).map((f) => [f.key, f]));
}

/** ชื่อคอลัมน์จริง → นิยามช่อง (รองรับ payload เก่าที่ส่งชื่อคอลัมน์ตรง ๆ เช่น currency, is_foc) */
async function indexByColumn(scope: "header" | "item"): Promise<Map<string, FieldDef>> {
  const all = await loadRegistry();
  const m = new Map<string, FieldDef>();
  for (const f of all) if (f.scope === scope && f.column && !m.has(f.column)) m.set(f.column, f);
  return m;
}

/** ชุด key ของช่องที่ "ไม่มีคอลัมน์จริง" → ต้องลง extra_fields */
export async function extraFieldKeys(scope: "header" | "item"): Promise<Set<string>> {
  const all = await loadRegistry();
  return new Set(all.filter((f) => f.scope === scope && !f.column && !f.computed).map((f) => f.key));
}

/**
 * แยก record แบน ๆ จากฟอร์ม → { columns, extra }
 *   - key ที่ตรงกับช่อง registry ที่มี column → ไปที่คอลัมน์นั้น
 *   - key ที่เป็นช่อง registry แต่ไม่มี column → ไปที่ extra_fields
 *   - key ที่ไม่รู้จัก → ทิ้ง (กันยิงคอลัมน์มั่ว) เว้นแต่ passthrough ระบุไว้
 *   - ถ้า record ส่ง extra_fields มาเป็นก้อนอยู่แล้ว → รวมเข้าด้วยกัน
 */
export async function splitRecord(
  record: Record<string, unknown>,
  scope: "header" | "item" = "header",
  passthrough: string[] = [],
): Promise<{ columns: Record<string, unknown>; extra: Record<string, unknown> }> {
  const byKey = await indexBy(scope);
  const byCol = await indexByColumn(scope);
  const pass = new Set(passthrough);
  const columns: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};

  // ก้อน extra_fields ที่ frontend ส่งมาตรง ๆ (ถ้ามี)
  const bulk = record.extra_fields;
  if (bulk && typeof bulk === "object" && !Array.isArray(bulk)) {
    for (const [k, v] of Object.entries(bulk as Record<string, unknown>)) {
      const def = byKey.get(k);
      if (def && !def.computed) extra[k] = v;
    }
  }

  for (const [k, v] of Object.entries(record)) {
    if (k === "extra_fields") continue;
    // 1) key ของ registry (ฟอร์มใหม่)
    const def = byKey.get(k);
    if (def) {
      if (def.computed) continue;            // DCTK เติมเอง — ไม่รับค่าจากฟอร์ม
      if (def.column) columns[def.column] = coerce(def.column, v);
      else extra[k] = v;
      continue;
    }
    // 2) ชื่อคอลัมน์จริง (payload เก่า เช่น currency / is_foc) — ยังต้องใช้ได้
    const byColDef = byCol.get(k);
    if (byColDef) { columns[k] = coerce(k, v); continue; }
    // 3) คอลัมน์ระบบที่อนุญาตไว้ (status, source, line_no, ฯลฯ)
    if (pass.has(k)) columns[k] = v;
  }
  return { columns, extra };
}

/**
 * แปลงแถวจาก DB (declarations / declaration_items) → object ที่ key เป็น "key ของ registry"
 * (ตรงข้ามกับ splitRecord — ใช้ตอนส่งข้อมูลไปให้ฟอร์ม/บันทึกเป็น Master)
 *   - ช่องที่มีคอลัมน์จริง → อ่านจากคอลัมน์
 *   - ช่องที่ไม่มีคอลัมน์   → อ่านจาก extra_fields
 *   - ข้ามช่องที่ DCTK เติมเอง และค่าที่ว่าง
 */
export async function rowToFields(
  row: Record<string, unknown>,
  scope: "header" | "item" = "header",
): Promise<Record<string, unknown>> {
  const all = await loadRegistry();
  const extra = (row.extra_fields ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of all) {
    if (f.scope !== scope || f.computed) continue;
    const v = f.column ? row[f.column] : extra[f.key];
    if (v === null || v === undefined || v === "") continue;
    out[f.key] = v;
  }
  return out;
}

/** map "scope:key" → ชื่อคอลัมน์จริง (null = อยู่ใน extra_fields) — ให้ตัวตรวจกฎ DCTK ใช้ */
export async function columnMap(): Promise<Map<string, string | null>> {
  const all = await loadRegistry();
  return new Map(all.map((f) => [`${f.scope}:${f.key}`, f.column]));
}
