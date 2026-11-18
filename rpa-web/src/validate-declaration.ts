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
    // DCTK บังคับน้ำหนักสุทธิ > 0 ทุกรายการ — รวมถึงของแถม/ตัวอย่าง
    //   (DCTK ตอบว่า "ข้อมูลนี้ต้องมีค่ามากกว่าค่าต่ำสุด (0)" แล้วบันทึกรายการนั้นไม่ผ่าน)
    //   เจอจริงกับแถวตัวอย่างที่สกัดน้ำหนักสุทธิไม่ติด ทั้งที่ Packing List มีค่าอยู่
    if (num(it.net_weight_kg) <= 0) {
      add("error", "net_weight_kg", `รายการที่ ${line}: ขาด/เป็น 0 'น้ำหนักสุทธิ' — DCTK บังคับ > 0 ทุกรายการ (รวมของแถม/ตัวอย่าง) ดูค่าจาก Packing List`, line);
    } else if (num(it.gross_weight_kg) > 0 && num(it.net_weight_kg) > num(it.gross_weight_kg)) {
      add("warn", "net_weight_kg", `รายการที่ ${line}: 'น้ำหนักสุทธิ' มากกว่า 'น้ำหนักรวม' — น่าจะสลับคอลัมน์กัน`, line);
    }
    if (isEmpty(it.customs_unit_code)) {
      add("error", "customs_unit_code", `รายการที่ ${line}: ขาด 'หน่วยปริมาณในใบขน' (customs_unit_code)`, line);
    }
    // ยอดหีบห่อทั้งหมดอยู่ที่รายการแรก (ตั้งใจ เช่น ZECK __package_alloc=first ตามใบที่ยื่นจริง) → รายการอื่นเป็น 0 ได้
    const firstHoldsAll = line > 1 && num(items[0]?.container_or_volume_qty) > 0
      && Math.abs(num(items[0]?.container_or_volume_qty) - num(decl.container_or_volume_qty)) < 0.001;
    if (!it.is_foc && num(it.container_or_volume_qty) <= 0 && !firstHoldsAll) {
      add("warn", "container_or_volume_qty", `รายการที่ ${line}: 'จำนวน/ปริมาณ' เป็น 0 — ตรวจสอบ (ถ้าไม่ใช่ของแถม FOC ควรมีจำนวน)`, line);
    }
  });

  // หมายเหตุ: การเทียบ "ผลรวมรายการ vs ยอดทั้งใบ" ย้ายไปที่ dctk-rules.ts (กฎกระทบยอด)
  //   เพราะถอดมาจากหน้ารายงานจริงของกรมฯ (ExDec/ExCheckDiff) ครอบคลุมทั้ง
  //   ราคา · ค่าประกัน · น้ำหนักสุทธิ · น้ำหนักรวมหีบห่อ · จำนวนหีบห่อ (ไม่ใช่แค่ราคา)

  const ok = !issues.some((i) => i.level === "error");
  return { ok, issues };
}

/**
 * ตรวจแบบเต็ม = กฎจากประสบการณ์ (ข้างบน) + กฎจริงที่ถอดมาจากหน้าจอ DCTK
 *   - ความยาวสูงสุดของแต่ละช่อง (DCTK ประกาศไว้เอง)
 *   - ช่องที่ต้องเป็นตัวเลข
 *   - ช่องที่ถูกปิดตามเงื่อนไข (เช่น Incoterms = CFR → ค่าประกันกรอกไม่ได้)
 * ใช้แทน validateDeclaration ได้เลย (คืนรูปแบบเดียวกัน)
 */
export async function validateDeclarationFull(decl: Decl): Promise<ValidationResult> {
  const base = validateDeclaration(decl);
  try {
    const [{ checkDctkRules }, { columnMap }] = await Promise.all([
      import("./dctk-rules.js"),
      import("./field-registry.js"),
    ]);
    const extra = await checkDctkRules(decl, await columnMap());
    const issues = [...base.issues, ...extra, ...(await productCodeIssues(decl))];
    return { ok: !issues.some((i) => i.level === "error"), issues };
  } catch {
    return base;                 // ไม่มีไฟล์กฎ → ใช้ผลเดิม (ไม่ทำให้ระบบล่ม)
  }
}

/**
 * รหัสสินค้าที่ "คล้ายแต่ไม่ตรง" กับรหัสที่ลูกค้ารายนี้เคยยื่นผ่าน → เตือน (ไม่บล็อกการกดรันเอง)
 *   การรันอัตโนมัติหลังอัปโหลดจะหยุดรอให้ตรวจถ้าเจอข้อนี้
 */
async function productCodeIssues(decl: Decl): Promise<ValidationIssue[]> {
  const customer = String(decl.customer_name ?? "").trim();
  const items = decl._items ?? [];
  if (!customer || !items.length) return [];
  try {
    const { productCodeSuspects } = await import("./supabase.js");
    const sus = await productCodeSuspects(customer, items.map((it) => String(it.description_eng ?? "")));
    if (!sus.length) return [];
    const out: ValidationIssue[] = [];
    items.forEach((it, i) => {
      const s = sus.find((x) => x.code === String(it.description_eng ?? "").trim());
      if (!s) return;
      out.push({
        level: "warn", field: "description_eng", itemLine: i + 1,
        message: `รหัสสินค้า "${s.code}" ไม่เคยใช้ผ่านกับลูกค้ารายนี้ — ใบที่ผ่านใช้ "${s.near.join('" / "')}" · ถ้าคลังสินค้า DCTK ไม่มีชื่อนี้ RPA จะหยุดที่หน้า 3`,
      });
    });
    return out;
  } catch { return []; }
}
