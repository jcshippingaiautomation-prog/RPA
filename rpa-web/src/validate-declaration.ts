// ============================================================
//  ตรวจข้อมูลใบขน "ก่อนรัน RPA" — กันรันแล้วไม่ผ่าน
//  กฎมาจากประสบการณ์จริง: ช่องที่ DCTK บังคับ ถ้าขาด → save ไม่ผ่าน/finalize ติด
//  คืนรายการสิ่งที่ขาด (อ่านง่าย) ให้ frontend แจ้ง user แก้ก่อนกดรัน
// ============================================================

export interface ValidationIssue {
  /** "error" = ขาดแล้วรันไม่ผ่านแน่ ๆ, "warn" = เสี่ยง/ควรตรวจ */
  level: "error" | "warn";
  /** ช่องที่มีปัญหา (key) เพื่อให้ frontend highlight ได้ */
  field: string;
  /** ข้อความอ่านง่าย บอกว่าขาดอะไร + ต้องทำอะไร */
  message: string;
  /** รายการสินค้าที่เกี่ยวข้อง (ถ้าเป็นปัญหาระดับ item) — line_no */
  itemLine?: number;
}

export interface ValidationResult {
  ok: boolean;                 // true = รันได้ (ไม่มี error)
  issues: ValidationIssue[];   // error + warn ทั้งหมด
}

type Decl = Record<string, unknown> & { _items?: Record<string, unknown>[] };

const isEmpty = (v: unknown): boolean =>
  v === null || v === undefined || String(v).trim() === "";
const num = (v: unknown): number => {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * ตรวจใบขน 1 ใบ ว่าข้อมูลครบพอจะรัน RPA ไหม
 * อ้างกฎจริงจากการ debug DCTK:
 *   - หัวใบ: consignee, currency, ราคารวม, น้ำหนัก, หน่วยน้ำหนัก, customs_unit
 *   - CFR/CIF: ต้องมีค่าระวาง > 0
 *   - แต่ละ item: รหัสสินค้า, ราคา > 0, น้ำหนักรวม > 0, หน่วยปริมาณ (customs_unit), จำนวน > 0
 */
export function validateDeclaration(decl: Decl): ValidationResult {
  const issues: ValidationIssue[] = [];
  const add = (level: ValidationIssue["level"], field: string, message: string, itemLine?: number) =>
    issues.push({ level, field, message, itemLine });

  // ---- หัวใบ (ระดับใบ) ----
  if (isEmpty(decl.customer_name)) add("error", "customer_name", "ขาด 'ลูกค้า' — ต้องระบุชื่อลูกค้า (ใช้ค้นบริษัทผู้ส่งออกใน DCTK)");
  if (isEmpty(decl.consignee_name)) add("error", "consignee_name", "ขาด 'Consignee' (ผู้รับสินค้า) — DCTK บังคับ");
  if (isEmpty(decl.invoice_number)) add("error", "invoice_number", "ขาด 'เลขที่ Invoice'");
  if (isEmpty(decl.currency)) add("error", "currency", "ขาด 'สกุลเงิน' (เช่น USD)");

  const incoterms = String(decl.incoterms ?? "").trim().toUpperCase();
  if (isEmpty(incoterms)) add("error", "incoterms", "ขาด 'Incoterms' (เช่น CFR, CIF, FOB)");

  if (num(decl.total_goods_amount) <= 0) add("error", "total_goods_amount", "ขาด/เป็น 0 'มูลค่าสินค้า' — DCTK ตรวจผลรวมราคาต้องตรงกับรายการสินค้า");

  // ค่าระวาง: CFR/CIF/CNF บังคับ > 0 (ราคารวมค่าระวาง)
  const freightRequired = ["CIF", "CFR", "CNF", "C&F"].includes(incoterms);
  if (freightRequired && num(decl.freight_charge) <= 0) {
    add("error", "freight_charge", `Incoterms = ${incoterms} → ต้องมี 'ค่าระวาง' มากกว่า 0 (DCTK บังคับ)`);
  }

  // น้ำหนัก/หน่วยระดับใบ
  if (num(decl.net_weight_kg) <= 0) add("warn", "net_weight_kg", "'น้ำหนักสุทธิ (kg)' เป็น 0 — ตรวจสอบ");
  if (num(decl.gross_weight_kg) <= 0) add("error", "gross_weight_kg", "ขาด/เป็น 0 'น้ำหนักรวม (kg)' — DCTK บังคับ > 0");
  if (isEmpty(decl.net_weight_unit_code)) add("warn", "net_weight_unit_code", "ขาด 'หน่วยน้ำหนัก' (เช่น TO/KGM)");
  if (isEmpty(decl.customs_unit_code)) add("error", "customs_unit_code", "ขาด 'หน่วยปริมาณในใบขน' (customs_unit_code) — DCTK บังคับ ห้ามว่าง (ตั้ง preset ต่อลูกค้า เช่น TNE/KGM/C62)");

  // ---- รายการสินค้า (items) ----
  const items = Array.isArray(decl._items) ? decl._items : [];
  if (!items.length) {
    add("error", "items", "ไม่มี 'รายการสินค้า' — ต้องมีอย่างน้อย 1 รายการ");
  }
  items.forEach((it, idx) => {
    const line = Number(it.line_no ?? idx + 1);
    if (isEmpty(it.description_eng)) {
      add("error", "description_eng", `รายการที่ ${line}: ขาด 'รหัสสินค้า' (ต้องตรงกับ master DCTK)`, line);
    }
    if (num(it.amount) <= 0) {
      add("error", "amount", `รายการที่ ${line}: ขาด/เป็น 0 'มูลค่า' — ราคาแต่ละรายการต้อง > 0 (ผลรวมต้องตรงกับมูลค่ารวมทั้งใบ)`, line);
    }
    if (num(it.gross_weight_kg) <= 0) {
      add("error", "gross_weight_kg", `รายการที่ ${line}: ขาด/เป็น 0 'น้ำหนักรวม' — DCTK บังคับ > 0`, line);
    }
    if (isEmpty(it.customs_unit_code)) {
      add("error", "customs_unit_code", `รายการที่ ${line}: ขาด 'หน่วยปริมาณในใบขน' (customs_unit_code)`, line);
    }
    if (!it.is_foc && num(it.container_or_volume_qty) <= 0) {
      add("warn", "container_or_volume_qty", `รายการที่ ${line}: 'จำนวน/ปริมาณ' เป็น 0 — ตรวจสอบ (ถ้าไม่ใช่ของแถม FOC ควรมีจำนวน)`, line);
    }
  });

  // ตรวจผลรวมราคา item ตรงกับหัวใบไหม (DCTK ตรวจข้อนี้ → ถ้าไม่ตรง finalize ติด)
  if (items.length) {
    const sumItems = items.reduce((s, it) => s + num(it.amount), 0);
    const head = num(decl.total_goods_amount);
    if (head > 0 && sumItems > 0 && Math.abs(sumItems - head) > 1) {
      add("warn", "total_goods_amount",
        `ผลรวมราคารายการ (${sumItems.toLocaleString()}) ไม่เท่ากับมูลค่ารวมทั้งใบ (${head.toLocaleString()}) — DCTK จะ block ตอน finalize`);
    }
  }

  const ok = !issues.some((i) => i.level === "error");
  return { ok, issues };
}
