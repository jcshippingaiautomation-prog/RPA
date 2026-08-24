// ============================================================
//  Field Registry — ทะเบียนช่องกรอกทั้งหมดของ DCTK (แหล่งความจริงเดียว)
//
//  ไฟล์ข้อมูล: src/data/field-registry.json (สร้างจาก field-catalog.json + คัดกรองมือ)
//  ใช้ร่วมกัน 2 ที่:
//    - rpa-web  → ส่งให้ frontend เรนเดอร์ฟอร์ม (/api/field-registry)
//    - worker   → ตัวกรอกอัตโนมัติแบบ generic (pages.ts fillFromRegistry)
//
//  ⚠ ช่องที่ selectorConst มีค่า = Kendo numeric ที่ไม่มี id/name → selector อยู่ใน selectors.ts
//     (dump อัตโนมัติจับไม่ได้ ต้องอ้างด้วยตำแหน่ง div)
// ============================================================
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as S from "./selectors.js";

export interface FieldDef {
  /** ชื่อช่องที่ใช้ในฟอร์ม/extra_fields (ใช้ชื่อคอลัมน์จริงถ้ามี) */
  key: string;
  label: string;
  /** หน้าใน DCTK: 1 ใบขนขาออก · 2 ใบกำกับ · 3 รายการสินค้า */
  page: 1 | 2 | 3;
  /** หน้าในฟอร์มของเรา (สิทธิประโยชน์แยกเป็นหน้า 4) — ไม่กระทบการกรอกจริงที่ใช้ page */
  formPage: 1 | 2 | 3 | 4;
  /** หัวข้อกลุ่มในฟอร์ม */
  group: string;
  type: "text" | "textarea" | "number" | "combo" | "dropdown" | "date" | "checkbox" | "radio" | "select";
  /** CSS selector ตรง ๆ (จาก inspect) — null ถ้าใช้ selectorConst */
  selector: string | null;
  /** ชื่อ const ใน selectors.ts (สำหรับช่องที่ selector เป็นตำแหน่ง div) */
  selectorConst: string | null;
  /** คอลัมน์จริงใน declarations/declaration_items — null = เก็บใน extra_fields jsonb */
  column: string | null;
  /** header = ช่องหัวใบ · item = ช่องต่อรายการสินค้า */
  scope: "header" | "item";
  /** RPA กรอกช่องนี้ได้จริงแล้ว */
  fill: boolean;
  /** DCTK คำนวณ/เติมให้เอง → ฟอร์มแสดงแบบอ่านอย่างเดียว, RPA ห้ามกรอกทับ */
  computed: boolean;
  /** ให้ AI สกัดจากเอกสาร */
  ai: boolean;
  /** DCTK ทำเครื่องหมายว่าเป็นช่องบังคับ (กรอบเขียว/มี * ท้ายป้าย) */
  required: boolean;
  /** ตอนเปิด "ใบเดิม" DCTK ล็อกช่องนี้ (ตอนสร้างใบใหม่อาจกรอกได้) */
  readonlyInDctk: boolean;
  /** ชื่อจริงของช่องใน DCTK (name attribute) */
  dctkName: string;
  /** ตัวเลือกที่ DCTK มีให้ (dropdown/combo) — ว่าง = พิมพ์เอง/โหลดจากเซิร์ฟเวอร์ */
  options: { value: string; text: string }[];
  catalogKey: string | null;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(HERE, "data", "field-registry.json");

let _registry: FieldDef[] | null = null;

/** อ่านทะเบียนช่อง (cache ไว้หลังอ่านครั้งแรก) */
export async function loadFieldRegistry(): Promise<FieldDef[]> {
  if (_registry) return _registry;
  try {
    _registry = JSON.parse(await readFile(REGISTRY_PATH, "utf-8")) as FieldDef[];
  } catch {
    _registry = [];
  }
  return _registry;
}

/** path ของไฟล์ registry (ให้ rpa-web อ่านตรงได้โดยไม่ต้อง import โมดูลนี้) */
export function fieldRegistryPath(): string {
  return REGISTRY_PATH;
}

/**
 * selector จริงของช่อง — แปลง selectorConst → ค่าใน selectors.ts
 * คืน null ถ้าหาไม่ได้ (ช่องนั้นจะถูกข้าม ไม่ทำให้ทั้งใบล้ม)
 */
export function resolveSelector(f: FieldDef): string | null {
  if (f.selector) return f.selector;
  if (!f.selectorConst) return null;
  const sel = (S as unknown as { [k: string]: unknown })[f.selectorConst];
  return typeof sel === "string" ? sel : null;
}

/** ช่องที่ RPA กรอกได้ + ไม่ใช่ช่องที่ DCTK เติมเอง (ตัวกรอก generic ใช้ชุดนี้) */
export async function fillableFields(
  page: 1 | 2 | 3,
  scope: "header" | "item",
): Promise<FieldDef[]> {
  const all = await loadFieldRegistry();
  return all.filter((f) => f.page === page && f.scope === scope && f.fill && !f.computed);
}
