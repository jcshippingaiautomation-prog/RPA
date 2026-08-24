// ============================================================
//  DCTK Rules — เงื่อนไขของระบบกรมฯ ที่ถอดมาเป็นข้อมูล
//
//  ที่มา: src/data/field-rules.json (สร้างโดย scripts/gen_rules.py
//         จากผลรัน dist/rules-cli.js บนหน้าจอ DCTK จริง)
//
//  ใช้ให้ระบบเรา "ตรวจแบบเดียวกับ DCTK" ตั้งแต่ในเว็บเรา
//  ไม่ต้องรอไปเจอตอน RPA กรอกจริงแล้ว save ไม่ผ่าน
// ============================================================
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface DctkFieldRule {
  key: string;
  scope: "header" | "item";
  label: string;
  dctkName: string;
  required?: boolean;
  requiredMessage?: string;
  maxLength?: number;
  dataType?: string;
  regex?: string;
  regexMessage?: string;
  rangeMin?: string;
  rangeMax?: string;
  cascadeFrom?: string;
}

export interface DctkDependency {
  page: number;
  driverKey: string;
  driverScope: "header" | "item";
  driverLabel: string;
  /** ค่าของช่องตัวขับที่ทำให้เกิดผล */
  value: string;
  valueLabel: string;
  effects: {
    key: string;
    scope: "header" | "item";
    label: string;
    change: string;
    /** disable = ช่องนี้กรอกไม่ได้ · enable = เปิดให้กรอก · autofill = DCTK เขียนค่าให้ */
    kind: "disable" | "enable" | "require" | "autofill";
    from: string;
    to: string;
  }[];
}

export interface DctkRules {
  fields: DctkFieldRule[];
  dependencies: DctkDependency[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
let _rules: DctkRules | null = null;

export async function loadDctkRules(): Promise<DctkRules> {
  if (_rules) return _rules;
  try {
    _rules = JSON.parse(await readFile(path.join(HERE, "data", "field-rules.json"), "utf-8")) as DctkRules;
  } catch {
    _rules = { fields: [], dependencies: [] };
  }
  return _rules;
}

/** กฎของช่องหนึ่ง */
export async function ruleFor(scope: "header" | "item", key: string): Promise<DctkFieldRule | undefined> {
  const r = await loadDctkRules();
  return r.fields.find((f) => f.scope === scope && f.key === key);
}

/**
 * กฎที่มีผลเมื่อช่องตัวขับมีค่าตามที่ระบุ
 * เทียบแบบ "ขึ้นต้นด้วย" เพราะค่าใน DCTK มักเป็น "A - ชำระที่กรมศุลกากร" แต่เราเก็บแค่ "A"
 */
export async function dependenciesFor(
  driverKey: string,
  value: string,
): Promise<DctkDependency[]> {
  const r = await loadDctkRules();
  const v = String(value ?? "").trim().toUpperCase();
  if (!v) return [];
  return r.dependencies.filter((d) => {
    if (d.driverKey !== driverKey) return false;
    const dv = String(d.value ?? "").trim().toUpperCase();
    const dl = String(d.valueLabel ?? "").trim().toUpperCase();
    return dv === v || dl === v || dl.startsWith(v + " ") || dl.startsWith(v + "-");
  });
}
