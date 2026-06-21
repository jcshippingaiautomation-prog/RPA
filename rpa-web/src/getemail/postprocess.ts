// ============================================================
//  Post-process + fallback — port จาก GAS 09_PostProcess.gs
// ============================================================
import { safeParseJson, toStr, toNumber, round } from "./utils.js";
import { OUTPUT_COLUMNS } from "./prompts.js";

export interface DeclarationItem {
  [k: string]: unknown;
  line_no: number;
  description_eng: string;              // รหัสสินค้า (combo เลือก master)
  description_eng_field?: string;       // คำอธิบายอังกฤษอิสระต่อรายการ
  product_description_thai?: string;    // คำอธิบายไทยต่อรายการ
  brand_name: string;
  container_or_volume_qty: string;
  container_unit_code: string;
  net_weight_kg: number;
  gross_weight_kg: number;
  net_weight_ton: number;
  net_weight_unit_code?: string;        // หน่วยน้ำหนัก/ปริมาณต่อรายการ
  amount: number;
  insurance?: number;                   // ค่าประกันต่อรายการ
  export_tariff?: string;
  customs_unit_code?: string;
  is_foc: boolean;
}

export interface DeclarationRecord {
  [k: string]: unknown;
  _items?: DeclarationItem[];
  _has_error?: boolean;
  _error_message?: string;
  _needs_review?: boolean;
}

export function postProcess(rawText: string): DeclarationRecord {
  const parsed = safeParseJson(rawText);
  if (!parsed) {
    const empty = emptyRecord();
    empty._has_error = true;
    empty._error_message = "Parse Failed";
    return empty;
  }

  const r: DeclarationRecord = {
    customer_name: toStr(parsed.customer_name),
    consignee_name: toStr(parsed.consignee_name),
    buyer_country_code: toStr(parsed.buyer_country_code).toUpperCase(),
    destination_country_code: toStr(parsed.destination_country_code).toUpperCase(),
    invoice_number: toStr(parsed.invoice_number),
    invoice_date: toStr(parsed.invoice_date),
    tax_payment_method_code: toStr(parsed.tax_payment_method_code) || "A",
    vessel_name: toStr(parsed.vessel_name),
    voyage_number: toStr(parsed.voyage_number),
    etd: toStr(parsed.etd),
    release_port_code: toStr(parsed.release_port_code),
    loading_port_code: toStr(parsed.loading_port_code),
    incoterms: toStr(parsed.incoterms).toUpperCase(),
    currency: toStr(parsed.currency).toUpperCase(),
    total_goods_amount: toNumber(parsed.total_goods_amount),
    freight_charge: toNumber(parsed.freight_charge),
    insurance_charge: toNumber(parsed.insurance_charge),
    shipping_mark: toStr(parsed.shipping_mark),
    description_eng: toStr(parsed.description_eng),
    net_weight_kg: toNumber(parsed.net_weight_kg),
    gross_weight_kg: toNumber(parsed.gross_weight_kg),
    net_weight_ton: toNumber(parsed.net_weight_ton),
    net_weight_unit_code: toStr(parsed.net_weight_unit_code) || "TO",
    container_or_volume_qty: toStr(parsed.container_or_volume_qty),
    container_unit_code: toStr(parsed.container_unit_code),
    // ช่องเพิ่มเติม (Page 1 + พิกัด) — เก็บถ้า AI สกัดมา
    export_tariff: toStr(parsed.export_tariff),
    customs_unit_code: toStr(parsed.customs_unit_code),
    transport_mode: toStr(parsed.transport_mode),
    mawb: toStr(parsed.mawb),
    hawb: toStr(parsed.hawb),
    reference_no: toStr(parsed.reference_no),
    exdec_doc_type: toStr(parsed.exdec_doc_type),
    product_description_thai: toStr(parsed.product_description_thai),
  };

  applyFallbacks(r);
  flagIfIncomplete(r);

  // items[] — normalize แต่ละรายการ
  r._items = [];
  const items = (parsed.items as unknown[]) || [];
  for (let i = 0; i < items.length; i++) {
    const it = (items[i] as Record<string, unknown>) || {};
    const item: DeclarationItem = {
      line_no: i + 1,
      description_eng: toStr(it.description_eng).toUpperCase(),                    // รหัสสินค้า (combo master)
      description_eng_field: toStr(it.description_eng_field).toUpperCase(),        // คำอธิบายอังกฤษอิสระต่อรายการ
      product_description_thai: toStr(it.product_description_thai),                // คำอธิบายไทยต่อรายการ
      brand_name: toStr(it.brand_name) || "NO BRAND",
      container_or_volume_qty: toStr(it.container_or_volume_qty),
      container_unit_code: toStr(it.container_unit_code) || (r.container_unit_code as string),
      net_weight_kg: toNumber(it.net_weight_kg),
      gross_weight_kg: toNumber(it.gross_weight_kg),
      net_weight_ton: toNumber(it.net_weight_ton),
      net_weight_unit_code: toStr(it.net_weight_unit_code),                        // หน่วยต่อรายการ
      amount: toNumber(it.amount),
      insurance: toNumber(it.insurance),                                          // ค่าประกันต่อรายการ
      export_tariff: toStr(it.export_tariff),
      customs_unit_code: toStr(it.customs_unit_code),
      is_foc: !!it.is_foc,
    };
    // ถ้า item ไม่มีพิกัด ใช้พิกัดระดับบนเป็น fallback
    if (!item.export_tariff && r.export_tariff) item.export_tariff = r.export_tariff as string;
    if (!item.customs_unit_code && r.customs_unit_code) item.customs_unit_code = r.customs_unit_code as string;
    if (item.is_foc) item.container_or_volume_qty = "0";
    if (item.net_weight_ton <= 0 && item.net_weight_kg > 0) {
      item.net_weight_ton = round(item.net_weight_kg / 1000, 3);
    }
    r._items.push(item);
  }

  // ใบที่มีสินค้า "รายการเดียว" — AI มักใส่น้ำหนัก/จำนวนไว้ที่หัวใบ ไม่ใส่ใน item
  //   → ใช้ค่าหัวใบเติมช่องที่ item ยังว่าง/0 (DCTK บังคับ gross_weight/qty > 0)
  //   ⚠ ทำเฉพาะใบ item เดียวเท่านั้น — ใบหลายรายการน้ำหนักต้องแยกจริง ห้าม copy
  if (r._items.length === 1) {
    const it = r._items[0];
    const headNetKg = r.net_weight_kg as number;
    const headGrossKg = r.gross_weight_kg as number;
    const headNetTon = r.net_weight_ton as number;
    const headQty = toStr(r.container_or_volume_qty);
    if (it.net_weight_kg <= 0 && headNetKg > 0) it.net_weight_kg = headNetKg;
    if (it.gross_weight_kg <= 0 && headGrossKg > 0) it.gross_weight_kg = headGrossKg;
    if (it.net_weight_ton <= 0 && headNetTon > 0) it.net_weight_ton = headNetTon;
    // จำนวน/ปริมาณตู้ — เติมจากหัวใบถ้า item เป็น 0/ว่าง (ยกเว้น FOC ที่ตั้งใจให้ 0)
    const qtyNum = Number(it.container_or_volume_qty);
    if (!it.is_foc && (!it.container_or_volume_qty || qtyNum <= 0) && headQty && Number(headQty) > 0) {
      it.container_or_volume_qty = headQty;
    }
  }
  return r;
}

function applyFallbacks(r: DeclarationRecord): void {
  const nk = r.net_weight_kg as number;
  const nt = r.net_weight_ton as number;
  if (nk <= 0 && nt > 0) r.net_weight_kg = round(nt * 1000, 2);
  if ((r.net_weight_ton as number) <= 0 && (r.net_weight_kg as number) > 0) {
    r.net_weight_ton = round((r.net_weight_kg as number) / 1000, 3);
  }
  if (String(r.release_port_code).indexOf("28") === 0 && !r.loading_port_code) {
    r.loading_port_code = "2801";
  }
  // หมายเหตุ: ประเทศผู้ซื้อ (buyer) อาจต่างจากประเทศปลายทาง (destination) ได้
  // เช่น ขายให้บริษัทญี่ปุ่น (JP) แต่ส่งของไปเกาหลี (KR) → ไม่บังคับให้เท่ากัน ปล่อยให้ AI สกัดแยก
  // เผื่อกรณี AI หา buyer ไม่เจอ ค่อย fallback เป็น destination
  if (!r.buyer_country_code && r.destination_country_code) {
    r.buyer_country_code = r.destination_country_code;
  }
}

function flagIfIncomplete(r: DeclarationRecord): void {
  if (!r.consignee_name || !r.invoice_number || !r.description_eng) {
    r._needs_review = true;
  }
}

export function emptyRecord(): DeclarationRecord {
  const o: DeclarationRecord = {};
  for (const col of OUTPUT_COLUMNS) o[col] = "";
  o.tax_payment_method_code = "A";
  o.net_weight_unit_code = "TO";
  o.total_goods_amount = 0;
  o.freight_charge = 0;
  o.insurance_charge = 0;
  o.net_weight_kg = 0;
  o.gross_weight_kg = 0;
  o.net_weight_ton = 0;
  return o;
}
