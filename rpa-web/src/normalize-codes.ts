// ============================================================
//  ปรับค่าที่ AI อ่านมา → รหัสที่กรมฯ รับจริง
//
//  ปัญหาที่แก้: AI อ่านหน่วยจากเอกสารตามที่เขียน ("TON", "KGS", "CARTON")
//  แต่ DCTK รับเฉพาะรหัสของตัวเอง (TNE, KGM, CT) → RPA ค้นในคอมโบไม่เจอแล้วแถวนั้นล้ม
//  (เจอจริง: AI อ่าน "TO" จาก TON — ต้องแก้มือทุกใบ)
//
//  วิธี: ใช้ "รายการรหัส + ชื่อเต็ม" ที่ดึงมาจาก DCTK เอง มาจับคู่
//    TNE = "TONNE (METRIC TON)"  →  "TON"/"TO"/"TONNE"/"METRIC TON" ล้วนชี้มาที่ TNE
//  ไม่ต้องเขียนตารางเดาเอง และอัปเดตตามกรมฯ อัตโนมัติเมื่อรัน combo-lists ใหม่
//
//  ⚠ แก้ให้เฉพาะตอน "มั่นใจ" (ตรงแบบเดียว) ถ้ากำกวมปล่อยไว้ให้ตัวตรวจฟ้อง
//    ดีกว่าเดาผิดแล้วยื่นข้อมูลผิดเข้ากรมฯ
// ============================================================
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { loadRegistry } from "./field-registry.js";

interface ValueList {
  id: string;
  label: string;
  codes: string[];
  names?: { [code: string]: string };
  reliable?: boolean;
  truncated?: boolean;
  fields?: { key: string; scope: "header" | "item"; column: string | null; label: string }[];
}

const require = createRequire(import.meta.url);
const RPA_ROOT = path.dirname(require.resolve("rpa-import-node/package.json"));
const CANDIDATES = [
  path.join(RPA_ROOT, "dist", "data", "field-rules.json"),
  path.join(RPA_ROOT, "src", "data", "field-rules.json"),
];

let _lists: ValueList[] | null = null;
async function loadLists(): Promise<ValueList[]> {
  if (_lists) return _lists;
  for (const p of CANDIDATES) {
    try {
      const j = JSON.parse(await readFile(p, "utf-8")) as { valueLists?: ValueList[] };
      _lists = (j.valueLists ?? []).filter((v) => v.reliable && !v.truncated && v.codes?.length);
      return _lists;
    } catch { /* ลองไฟล์ถัดไป */ }
  }
  _lists = [];
  return _lists;
}

const norm = (v: unknown) => String(v ?? "").trim().toUpperCase().replace(/[\s.\-_/]+/g, "");

/**
 * หา "รหัสที่ใช่" จากค่าที่ผู้ใช้/AI ใส่มา
 * คืน null ถ้าไม่มั่นใจ (ไม่เจอ หรือเจอหลายตัว)
 */
export function matchCode(value: unknown, list: ValueList): string | null {
  const v = norm(value);
  if (!v) return null;
  if (list.codes.includes(String(value).trim().toUpperCase())) return null;   // ถูกอยู่แล้ว

  const names = list.names ?? {};
  const hit = new Set<string>();

  // 1) รหัสเดียวกันแต่พิมพ์ต่างรูป (เว้นวรรค/ขีด)
  for (const c of list.codes) if (norm(c) === v) hit.add(c);
  if (hit.size === 1) return [...hit][0];

  // 2) ชื่อเต็มตรงเป๊ะ  ("TONNE (METRIC TON)" ↔ "TONNE(METRICTON)")
  for (const [c, n] of Object.entries(names)) if (norm(n) === v) hit.add(c);
  if (hit.size === 1) return [...hit][0];

  // 3) คำแรกของชื่อเต็มตรงกัน ("KILOGRAM" → KGM · "TONNE" → TNE)
  for (const [c, n] of Object.entries(names)) {
    const first = norm(n.split(/[\s(]/)[0]);
    if (first && first === v) hit.add(c);
  }
  if (hit.size === 1) return [...hit][0];

  // 4) ค่าที่ใส่มาเป็น "คำขึ้นต้น" ของชื่อเต็ม และยาวพอจะไม่กำกวม
  //    "TON" → TONNE ✓ · "TO" → TONNE ✓ (ถ้าไม่มีตัวอื่นขึ้นต้นด้วย TO)
  if (v.length >= 2) {
    for (const [c, n] of Object.entries(names)) if (norm(n).startsWith(v)) hit.add(c);
    if (hit.size === 1) return [...hit][0];
  }

  // 5) ชื่อเต็มมีคำนี้อยู่ในวงเล็บ/กลางข้อความ ("METRIC TON" อยู่ใน TONNE (METRIC TON))
  if (v.length >= 3) {
    const byWord = new Set<string>();
    for (const [c, n] of Object.entries(names)) {
      if (norm(n).includes(v)) byWord.add(c);
    }
    if (byWord.size === 1) return [...byWord][0];
  }
  return null;
}

export interface CodeFix {
  scope: "header" | "item";
  itemLine?: number;
  key: string;
  label: string;
  from: string;
  to: string;
  listLabel: string;
}

/**
 * ไล่ทุกช่องที่มีรายการรหัสของกรมฯ แล้วปรับค่าที่ยังไม่ตรงให้ตรง
 * คืนรายการที่แก้ไป เพื่อเอาไปแจ้งผู้ใช้ว่าระบบปรับอะไรให้บ้าง
 */
export async function normalizeToDctkCodes(
  record: Record<string, unknown> & { _items?: Record<string, unknown>[] },
): Promise<CodeFix[]> {
  const lists = await loadLists();
  if (!lists.length) return [];
  const registry = await loadRegistry();
  const fixes: CodeFix[] = [];

  const applyTo = (
    row: Record<string, unknown>,
    scope: "header" | "item",
    itemLine?: number,
  ) => {
    const extra = (row.extra_fields ?? {}) as Record<string, unknown>;
    for (const list of lists) {
      for (const f of list.fields ?? []) {
        if (f.scope !== scope) continue;
        const def = registry.find((r) => r.scope === scope && r.key === f.key);
        if (def?.computed) continue;
        const holder = f.column ? row : extra;
        const slot = f.column ?? f.key;
        const cur = holder[slot];
        if (cur === null || cur === undefined || String(cur).trim() === "") continue;
        const fixed = matchCode(cur, list);
        if (!fixed) continue;
        holder[slot] = fixed;
        fixes.push({
          scope, itemLine, key: f.key, label: f.label,
          from: String(cur).trim(), to: fixed, listLabel: list.label,
        });
      }
    }
    if (Object.keys(extra).length) row.extra_fields = extra;
  };

  applyTo(record, "header");
  (record._items ?? []).forEach((it, i) => applyTo(it, "item", i + 1));

  // ── หน่วยที่อยู่บน "หัวใบ" ด้วย ─────────────────────────────────────
  //   ตาราง declarations มีคอลัมน์หน่วยของสินค้าติดมาด้วย
  //   (net_weight_unit_code / customs_unit_code / container_unit_code / currency)
  //   ใช้ตอนใบมีสินค้ารายการเดียว — แต่รายการรหัสผูกไว้กับช่อง "ระดับรายการ" เท่านั้น
  //   ถ้าไม่ไล่ตรงนี้ด้วย ค่าอย่าง "TO" บนหัวใบจะรอดไปถึง RPA (เจอจริง ต้องแก้มือทุกใบ)
  //   ⚠ ต้องระบุว่าคอลัมน์ไหนใช้รายการไหน "ตามความหมายของคอลัมน์"
  //     ถ้าไปหยิบรายการจากช่องระดับรายการที่ผูกคอลัมน์เดียวกัน จะได้ผิดชุด
  //     เช่น net_weight_unit_code ถูกผูกกับช่อง "ปริมาณในใบกำกับ" (2,182 หน่วย)
  //     ทำให้ "TO" กำกวม 45 ตัว ทั้งที่จริงเป็นหน่วยน้ำหนัก (มีแค่ 4 ตัว → TNE ชัดเจน)
  const HEADER_COLUMN_LIST: { column: string; listId: string; label: string }[] = [
    { column: "net_weight_unit_code", listId: "weight_unit", label: "หน่วยน้ำหนักสุทธิ" },
    { column: "gross_weight_unit_code", listId: "weight_unit", label: "หน่วยน้ำหนักรวม" },
    { column: "customs_unit_code", listId: "quantity_unit", label: "หน่วยปริมาณในใบขน" },
    { column: "container_unit_code", listId: "package_unit", label: "หน่วยหีบห่อ" },
    { column: "currency", listId: "currency", label: "สกุลเงิน" },
  ];
  for (const h of HEADER_COLUMN_LIST) {
    const list = lists.find((l) => l.id === h.listId);
    if (!list) continue;
    const cur = record[h.column];
    if (cur === null || cur === undefined || String(cur).trim() === "") continue;
    const fixed = matchCode(cur, list);
    if (!fixed) continue;
    record[h.column] = fixed;
    fixes.push({
      scope: "header", key: h.column, label: `${h.label} (หัวใบ)`,
      from: String(cur).trim(), to: fixed, listLabel: list.label,
    });
  }
  return fixes;
}
