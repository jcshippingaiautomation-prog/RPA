// ============================================================
//  ตรวจข้อมูลด้วย "กฎจริงของ DCTK" (ฝั่งเว็บ)
//
//  กฎมาจาก rpa-import-node/src/data/field-rules.json ซึ่งถอดจากหน้าจอ DCTK จริง
//  (data-val-* ของ ASP.NET + การทดลองสลับค่าดูว่าช่องไหนเปิด/ปิดตาม)
//
//  ใช้เสริม validate-declaration.ts (กฎจากประสบการณ์) — คนละชั้นกัน:
//    - validate-declaration = กฎเชิงธุรกิจที่เรารู้จากการ debug จริง
//    - ที่นี่                = กฎที่ระบบกรมฯ ประกาศไว้เอง (ความยาว/บังคับ/ช่องที่ถูกปิด)
// ============================================================
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

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
}

export interface DctkDependency {
  page: number;
  driverKey: string;
  driverScope: "header" | "item";
  driverLabel: string;
  value: string;
  valueLabel: string;
  effects: {
    key: string; scope: "header" | "item"; label: string;
    change: string; kind: "disable" | "enable" | "require" | "autofill";
    from: string; to: string;
  }[];
}

/** ตารางเงื่อนไข Incoterms — ช่องค่าใช้จ่ายไหนกรอกได้/DCTK ปิด */
export interface IncotermRule {
  term: string;
  allowed: string[];
  blocked: string[];
  /** key ของช่องที่ถูกปิด (ทั้งสกุลเงิน/จำนวนเงิน/วิธีเฉลี่ย ของแถวนั้น) */
  blockedKeys: string[];
}

/** กฎข้ามช่องที่ถอดจากโค้ดในหน้า DCTK (ยืนยันแล้วว่ายังเปิดใช้อยู่จริง) */
export interface CrossFieldRule {
  id: string;
  scope: "header" | "item";
  level: "error" | "warn";
  message: string;
  when: {
    field?: string; isTrue?: boolean; notEmpty?: boolean; always?: boolean;
    anyNotEmpty?: string[]; bothNotEmpty?: string[];
    anyFieldEquals?: { field: string; contains: string };
  };
  require: {
    field?: string; oneOf?: string[]; maxLength?: number; greaterThan?: number;
    allNotEmpty?: string[]; itemsMin?: number;
    /** [ก, ข] → วันที่ ก ต้องไม่เกินวันที่ ข */
    dateNotAfter?: [string, string];
    /** regex ที่ค่าต้องผ่าน */
    matches?: string;
  };
  source: string;
}

/** รายการค่าที่กรมฯ ยอมรับ (หน่วย/สกุลเงิน/พิกัด ฯลฯ) */
export interface ValueList {
  id: string;
  label: string;
  codes: string[];
  count: number;
  deepSwept: boolean;
  /** true = กวาดครบแล้ว เอาไปตรวจได้ · false = ได้บางส่วน ใช้อ้างอิงเท่านั้น */
  reliable: boolean;
  fields: { key: string; scope: "header" | "item"; column: string | null; label: string }[];
}

export interface DctkRules {
  fields: DctkFieldRule[];
  dependencies: DctkDependency[];
  incoterms?: IncotermRule[];
  incotermsToTerm?: string;
  crossField?: CrossFieldRule[];
  valueLists?: ValueList[];
  reconcile?: ReconcileRule[];
}

/** กฎกระทบยอด: ยอดระดับใบ (ส่วนควบคุม) ต้องเท่าผลรวมรายการ (ส่วนรายละเอียด) */
export interface ReconcileRule {
  id: string;
  label: string;
  /** key ของช่องฝั่งหัวใบ (resolve เป็นคอลัมน์จริงหรือ extra_fields ให้เอง) */
  headerKey: string;
  /** key ของช่องฝั่งรายการสินค้า */
  itemKey: string;
  tolerance: number;
  level: "error" | "warn";
}

const require = createRequire(import.meta.url);
const RPA_ROOT = path.dirname(require.resolve("rpa-import-node/package.json"));
const CANDIDATES = [
  path.join(RPA_ROOT, "dist", "data", "field-rules.json"),
  path.join(RPA_ROOT, "src", "data", "field-rules.json"),
];

let _rules: DctkRules | null = null;

export async function loadDctkRules(): Promise<DctkRules> {
  if (_rules) return _rules;
  for (const p of CANDIDATES) {
    try { _rules = JSON.parse(await readFile(p, "utf-8")) as DctkRules; return _rules; }
    catch { /* ลองไฟล์ถัดไป */ }
  }
  _rules = { fields: [], dependencies: [] };
  return _rules;
}

/** แปลงวันที่ให้เทียบกันได้ — รองรับทั้ง dd/mm/yyyy (DCTK) และ yyyy-mm-dd (DB) */
function parseThaiDate(v: string): number | null {
  const t = String(v ?? "").trim();
  if (!t) return null;
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    let y = +m[3];
    if (y > 2400) y -= 543;                 // พ.ศ. → ค.ศ.
    return Date.UTC(y, +m[2] - 1, +m[1]);
  }
  const d = Date.parse(t);
  return Number.isFinite(d) ? d : null;
}

const isEmpty = (v: unknown) => v === null || v === undefined || String(v).trim() === "";
const numOf = (v: unknown) => {
  const m = String(v ?? "").replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
};

export interface RuleIssue {
  level: "error" | "warn";
  field: string;
  message: string;
  itemLine?: number;
}

/** ค่าของช่องหนึ่งจากแถว (คอลัมน์จริง หรือ extra_fields) */
function valueOf(row: Record<string, unknown>, rule: DctkFieldRule, byKeyColumn: Map<string, string | null>): unknown {
  const mapKey = `${rule.scope}:${rule.key}`;
  const col = byKeyColumn.get(mapKey);
  if (col) return row[col];
  const extra = (row.extra_fields ?? {}) as Record<string, unknown>;
  if (rule.key in extra) return extra[rule.key];
  // ⚠ ห้าม fallback ไป row[key] ถ้าช่องนี้ไม่มีคอลัมน์
  //   key ของ registry ชนกับชื่อคอลัมน์ได้ เช่น item key "amount" = ช่องสกุลเงิน
  //   แต่คอลัมน์ amount = จำนวนเงิน → อ่านผิดช่องทันที
  return byKeyColumn.has(mapKey) ? undefined : row[rule.key];
}

/**
 * ตรวจข้อมูลด้วยกฎของ DCTK
 * @param registryColumns map "scope:key" → ชื่อคอลัมน์จริง (จาก field-registry)
 */
export async function checkDctkRules(
  decl: Record<string, unknown> & { _items?: Record<string, unknown>[] },
  registryColumns: Map<string, string | null>,
): Promise<RuleIssue[]> {
  const { fields, dependencies } = await loadDctkRules();
  if (!fields.length) return [];
  const out: RuleIssue[] = [];
  const items = Array.isArray(decl._items) ? decl._items : [];

  // ── 1) ความยาวเกินที่กรมฯ กำหนด (เจอบ่อยกับ shipping mark / คำอธิบายสินค้า) ──
  const checkLen = (row: Record<string, unknown>, scope: "header" | "item", line?: number) => {
    for (const r of fields) {
      if (r.scope !== scope || !r.maxLength) continue;
      const v = valueOf(row, r, registryColumns);
      if (isEmpty(v)) continue;
      const len = String(v).length;
      if (len > r.maxLength) {
        out.push({
          level: "error", field: r.key, itemLine: line,
          message: `${line ? `รายการที่ ${line}: ` : ""}"${r.label}" ยาว ${len} ตัวอักษร — DCTK รับได้ไม่เกิน ${r.maxLength}`,
        });
      }
    }
  };
  checkLen(decl, "header");
  items.forEach((it, i) => checkLen(it, "item", Number(it.line_no ?? i + 1)));

  // ── 2) ช่องที่ต้องเป็นตัวเลข ──
  const checkNum = (row: Record<string, unknown>, scope: "header" | "item", line?: number) => {
    for (const r of fields) {
      if (r.scope !== scope || r.dataType !== "number") continue;
      const v = valueOf(row, r, registryColumns);
      if (isEmpty(v)) continue;
      if (!/^-?[\d,]*\.?\d*$/.test(String(v).trim())) {
        out.push({
          level: "error", field: r.key, itemLine: line,
          message: `${line ? `รายการที่ ${line}: ` : ""}"${r.label}" ต้องเป็นตัวเลข (ตอนนี้เป็น "${String(v).slice(0, 20)}")`,
        });
      }
    }
  };
  checkNum(decl, "header");
  items.forEach((it, i) => checkNum(it, "item", Number(it.line_no ?? i + 1)));

  // ── 3) กฎ "ถ้าเลือกแบบนี้ ช่องนั้นกรอกไม่ได้" ──
  //     เช่น Incoterms = CFR → DCTK ปิดช่องค่าประกัน ถ้าเราส่งค่าไปจะโดนตีกลับ
  // ตาราง Incoterms (ข้อ 4) เป็นแหล่งที่แม่นกว่าและครอบเรื่องเดียวกันอยู่แล้ว
  //   → ข้ามกฎความสัมพันธ์ที่มี Incoterms เป็นตัวขับ กันข้อความซ้ำ
  const INCOTERM_DRIVERS = new Set(["term_code", "incoterms"]);
  for (const dep of dependencies) {
    if (INCOTERM_DRIVERS.has(dep.driverKey)) continue;
    const driverRule = fields.find((f) => f.scope === dep.driverScope && f.key === dep.driverKey);
    const driverVal = String(
      valueOf(decl, driverRule ?? { key: dep.driverKey, scope: dep.driverScope, label: "", dctkName: "" }, registryColumns) ?? "",
    ).trim().toUpperCase();
    if (!driverVal) continue;
    const want = String(dep.valueLabel || dep.value).trim().toUpperCase();
    const hit = want === driverVal || want.startsWith(driverVal + " ") || want.startsWith(driverVal + "-");
    if (!hit) continue;

    for (const e of dep.effects) {
      if (e.kind !== "disable") continue;
      const rows: [Record<string, unknown>, number | undefined][] =
        e.scope === "item" ? items.map((it, i) => [it, Number(it.line_no ?? i + 1)]) : [[decl, undefined]];
      for (const [row, line] of rows) {
        const r = fields.find((f) => f.scope === e.scope && f.key === e.key)
          ?? { key: e.key, scope: e.scope, label: e.label, dctkName: "" };
        const v = valueOf(row, r, registryColumns);
        if (isEmpty(v) || numOf(v) === 0) continue;   // ว่าง/ศูนย์ = ไม่มีปัญหา
        out.push({
          level: "warn", field: e.key, itemLine: line,
          message: `${line ? `รายการที่ ${line}: ` : ""}${dep.driverLabel} = "${dep.valueLabel}" → DCTK ปิดช่อง "${e.label}" (กรอกไม่ได้) แต่เรามีค่า "${String(v).slice(0, 20)}" — DCTK จะไม่รับค่านี้`,
        });
      }
    }
  }

  // ── 4) เงื่อนไข Incoterms: ช่องค่าใช้จ่ายที่ DCTK ปิดสำหรับเงื่อนไขนี้ ──
  //     กฎมาจาก endpoint Term/GetFactor ของกรมฯ เอง (แม่นทุกเงื่อนไข ไม่ใช่แค่ CIF/CFR)
  const term = String(decl.incoterms ?? "").trim().toUpperCase();
  const inco = (await loadDctkRules()).incoterms?.find((t) => t.term.toUpperCase() === term);
  if (inco) {
    // ช่องหัวใบที่เราเก็บจริง → แถวค่าใช้จ่ายของ DCTK
    const HEAD: { key: string; col: string; label: string }[] = [
      { key: "freight_foreign", col: "freight_charge", label: "ค่าระวาง" },
      { key: "insurance_foreign", col: "insurance_charge", label: "ค่าประกัน" },
    ];
    for (const h of HEAD) {
      if (!inco.blockedKeys.includes(h.key)) continue;
      const v = decl[h.col];
      if (isEmpty(v) || numOf(v) === 0) continue;
      // ระดับหัวใบ = เตือน: RPA มีเงื่อนไขกันตามเงื่อนไขการค้าอยู่แล้ว
      //   และ DCTK แค่ล้างค่าเป็น 0 ให้ ไม่ได้ทำให้บันทึกไม่ผ่าน
      out.push({
        level: "warn", field: h.col,
        message: `Incoterms = ${term} → DCTK ปิดช่อง "${h.label}" (ล้างเป็น 0 ให้อัตโนมัติ) แต่เรามีค่า ${numOf(v).toLocaleString()} — ค่านี้จะไม่ถูกบันทึกลงใบขน`,
      });
    }
    // ระดับรายการสินค้า
    for (const [i, it] of items.entries()) {
      const line = Number(it.line_no ?? i + 1);
      if (inco.blockedKeys.includes("insurance_foreign") && numOf(it.insurance) > 0) {
        // ระดับรายการ = ผิดพลาด: RPA กรอกค่าประกันต่อรายการเมื่อมีค่า > 0 โดยไม่ดูเงื่อนไข
        //   ถ้าช่องถูกปิดอยู่ การพยายามกรอกจะทำให้แถวนั้นล้ม
        out.push({
          level: "error", field: "insurance", itemLine: line,
          message: `รายการที่ ${line}: Incoterms = ${term} → DCTK ปิดช่อง "ค่าประกัน" แต่รายการนี้มีค่า ${numOf(it.insurance).toLocaleString()} — RPA จะพยายามกรอกช่องที่ปิดอยู่ ให้ลบค่าออกก่อน`,
        });
      }
    }
  }

  // ── 5) กฎข้ามช่อง (ถอดจากโค้ดในหน้า DCTK) ──
  //     เช่น ติ๊กชำระค่าธรรมเนียม → วิธีชำระต้องเป็น A/H · ติ๊ก BOI → ต้องมีเลขบัตรส่งเสริม
  const cross = (await loadDctkRules()).crossField ?? [];
  for (const c of cross) {
    const rows: [Record<string, unknown>, number | undefined][] =
      c.scope === "item" ? items.map((it, i) => [it, Number(it.line_no ?? i + 1)]) : [[decl, undefined]];

    for (const [row, line] of rows) {
      const get = (k: string) => valueOf(row, { key: k, scope: c.scope, label: "", dctkName: "" }, registryColumns);
      const truthy = (v: unknown) => /^(1|true|yes|y|on|ใช่)$/i.test(String(v ?? "").trim());

      // เงื่อนไขว่ากฎนี้มีผลไหม
      let applies = false;
      if (c.when.always) applies = true;
      else if (c.when.field && c.when.isTrue) applies = truthy(get(c.when.field));
      else if (c.when.field && c.when.notEmpty) applies = !isEmpty(get(c.when.field));
      else if (c.when.anyNotEmpty) applies = c.when.anyNotEmpty.some((k) => !isEmpty(get(k)));
      else if (c.when.bothNotEmpty) applies = c.when.bothNotEmpty.every((k) => !isEmpty(get(k)));
      else if (c.when.anyFieldEquals) {
        const v = String(get(c.when.anyFieldEquals.field) ?? "");
        applies = v.includes(c.when.anyFieldEquals.contains);
      }
      if (!applies) continue;

      // ข้อกำหนดที่ต้องผ่าน
      const req = c.require;
      let failed = false;
      if (req.itemsMin !== undefined && items.length < req.itemsMin) failed = true;
      if (req.field && req.oneOf) {
        const v = String(get(req.field) ?? "").trim().toUpperCase();
        // ค่าจาก DCTK อาจเป็น "A - ชำระที่กรมศุลกากร" → เทียบตัวแรก
        failed = !req.oneOf.some((o) => v === o || v.startsWith(o + " ") || v.startsWith(o + "-"));
      }
      if (req.field && req.maxLength !== undefined) {
        failed = String(get(req.field) ?? "").length > req.maxLength;
      }
      if (req.field && req.greaterThan !== undefined) {
        failed = numOf(get(req.field)) <= req.greaterThan;
      }
      if (req.allNotEmpty) failed = req.allNotEmpty.some((k) => isEmpty(get(k)));
      if (req.matches) {
        failed = !new RegExp(req.matches).test(String(get(req.field ?? "") ?? "").trim());
      }
      if (req.dateNotAfter) {
        const [a, b] = req.dateNotAfter.map((k) => parseThaiDate(String(get(k) ?? "")));
        failed = a !== null && b !== null && a > b;
      }

      if (failed) {
        out.push({
          level: c.level, field: req.field ?? c.when.field ?? c.id, itemLine: line,
          message: `${line ? `รายการที่ ${line}: ` : ""}${c.message}`,
        });
      }
    }
  }

  // ── 6) ค่าที่กรอกต้องอยู่ในรายการที่กรมฯ มี ──
  //     บั๊กที่เจอบ่อยที่สุดของระบบคือ RPA "ค้นค่าในคอมโบไม่เจอ" แล้วแถวล้ม
  //     เช็คตรงนี้ก่อน = รู้ตั้งแต่ในเว็บเรา ไม่ต้องรอไปพังตอนกรอกจริง
  //     ⚠ ตรวจเฉพาะรายการที่กวาดมาครบจริง (reliable) — รายการที่ได้บางส่วนไม่เอามาตัดสิน
  for (const vl of (await loadDctkRules()).valueLists ?? []) {
    if (!vl.reliable) continue;
    const allowed = new Set(vl.codes.map((c) => c.toUpperCase()));
    for (const f of vl.fields) {
      const rows: [Record<string, unknown>, number | undefined][] =
        f.scope === "item" ? items.map((it, i) => [it, Number(it.line_no ?? i + 1)]) : [[decl, undefined]];
      for (const [row, line] of rows) {
        const v = valueOf(row, { key: f.key, scope: f.scope, label: f.label, dctkName: "" }, registryColumns);
        if (isEmpty(v)) continue;
        const code = String(v).trim().toUpperCase();
        if (allowed.has(code)) continue;
        out.push({
          level: "error", field: f.column ?? f.key, itemLine: line,
          message: `${line ? `รายการที่ ${line}: ` : ""}"${f.label}" = "${String(v).slice(0, 20)}" ไม่มีใน${vl.label}ที่กรมฯ รับ (${vl.count} ค่า) — RPA จะค้นไม่เจอแล้วแถวนี้ล้ม`,
        });
      }
    }
  }

  // ── 7) กระทบยอด "ส่วนควบคุม vs ส่วนรายละเอียด" ──
  //     กรมฯ มีหน้ารายงานเทียบยอดระดับใบกับผลรวมรายการโดยตรง (ExDec/ExCheckDiff)
  //     ถ้าไม่ตรง ใบจะติดตอนส่งกรมฯ → เทียบเองตั้งแต่ตอนนี้
  if (items.length) {
    const asRule = (key: string, scope: "header" | "item"): DctkFieldRule =>
      ({ key, scope, label: "", dctkName: "" });
    for (const rc of (await loadDctkRules()).reconcile ?? []) {
      // ค่าอาจอยู่ในคอลัมน์จริงหรือใน extra_fields — ให้ valueOf จัดการให้
      const head = numOf(valueOf(decl, asRule(rc.headerKey, "header"), registryColumns));
      if (head <= 0) continue;                       // ไม่ได้กรอกยอดระดับใบ = ไม่ต้องเทียบ
      const sum = items.reduce(
        (s, it) => s + numOf(valueOf(it, asRule(rc.itemKey, "item"), registryColumns)), 0);
      if (sum <= 0) continue;                        // รายการไม่ได้กรอกค่านี้ = ไม่ต้องเทียบ
      const diff = Math.abs(sum - head);
      if (diff <= rc.tolerance) continue;
      out.push({
        level: rc.level, field: rc.headerKey,
        message: `${rc.label}: ยอดทั้งใบ ${head.toLocaleString()} ≠ ผลรวมรายการ ${sum.toLocaleString()} (ต่าง ${diff.toLocaleString()}) — DCTK เทียบ "ส่วนควบคุม vs ส่วนรายละเอียด" ถ้าไม่ตรงจะติดตอนส่งกรมฯ`,
      });
    }
  }

  return out;
}

/** สรุปเงื่อนไข Incoterms หนึ่งค่า (ให้หน้าเว็บโชว์ว่ากรอกอะไรได้บ้าง) */
export async function incotermInfo(term: string): Promise<IncotermRule | undefined> {
  const t = String(term ?? "").trim().toUpperCase();
  if (!t) return undefined;
  return (await loadDctkRules()).incoterms?.find((x) => x.term.toUpperCase() === t);
}
