/**
 * Post-process + fallback logic (Spec §6.8)
 * ============================================================
 * ทำงานบน FLAT schema ที่ extractor ส่งจริง (แก้ Known Issue #1)
 */

/**
 * @param {string} rawText  ผลลัพธ์ดิบจาก extractor
 * @return {Object} declaration record (มี _has_error ถ้า parse พัง)
 */
function postProcess_(rawText) {
  const parsed = safeParseJson_(rawText);
  if (!parsed) {
    const empty = emptyRecord_();
    empty._has_error = true;
    empty._error_message = "Parse Failed";
    return empty;
  }

  const r = {
    customer_name: toStr_(parsed.customer_name),
    consignee_name: toStr_(parsed.consignee_name),
    buyer_country_code: toStr_(parsed.buyer_country_code).toUpperCase(),
    destination_country_code: toStr_(parsed.destination_country_code).toUpperCase(),
    invoice_number: toStr_(parsed.invoice_number),
    invoice_date: toStr_(parsed.invoice_date),
    tax_payment_method_code: toStr_(parsed.tax_payment_method_code) || "A",
    vessel_name: toStr_(parsed.vessel_name),
    voyage_number: toStr_(parsed.voyage_number),
    etd: toStr_(parsed.etd),
    release_port_code: toStr_(parsed.release_port_code),
    loading_port_code: toStr_(parsed.loading_port_code),
    incoterms: toStr_(parsed.incoterms).toUpperCase(),
    currency: toStr_(parsed.currency).toUpperCase(),
    total_goods_amount: toNumber_(parsed.total_goods_amount),
    freight_charge: toNumber_(parsed.freight_charge),
    insurance_charge: toNumber_(parsed.insurance_charge),
    shipping_mark: toStr_(parsed.shipping_mark),
    description_eng: toStr_(parsed.description_eng),
    net_weight_kg: toNumber_(parsed.net_weight_kg),
    gross_weight_kg: toNumber_(parsed.gross_weight_kg),
    net_weight_ton: toNumber_(parsed.net_weight_ton),
    net_weight_unit_code: toStr_(parsed.net_weight_unit_code) || "TO",
    container_or_volume_qty: toStr_(parsed.container_or_volume_qty),
    container_unit_code: toStr_(parsed.container_unit_code),
  };

  applyFallbacks_(r);
  flagIfIncomplete_(r);

  // items[] (รายการสินค้า) — normalize แต่ละรายการ
  r._items = [];
  if (parsed.items && parsed.items.length) {
    for (var i = 0; i < parsed.items.length; i++) {
      var it = parsed.items[i] || {};
      var item = {
        line_no: i + 1,
        description_eng: toStr_(it.description_eng).toUpperCase(),
        brand_name: toStr_(it.brand_name) || "NO BRAND",
        container_or_volume_qty: toStr_(it.container_or_volume_qty),
        container_unit_code: toStr_(it.container_unit_code) || r.container_unit_code,
        net_weight_kg: toNumber_(it.net_weight_kg),
        gross_weight_kg: toNumber_(it.gross_weight_kg),
        net_weight_ton: toNumber_(it.net_weight_ton),
        amount: toNumber_(it.amount),
        is_foc: !!it.is_foc,
      };
      // FOC: จำนวนหีบห่อ = 0
      if (item.is_foc) item.container_or_volume_qty = "0";
      // ถ้าไม่มี ton แต่มี kg → คำนวณ
      if (item.net_weight_ton <= 0 && item.net_weight_kg > 0) {
        item.net_weight_ton = round_(item.net_weight_kg / 1000, 3);
      }
      r._items.push(item);
    }
  }
  return r;
}

function applyFallbacks_(r) {
  // (#10) มีแต่ ton → คำนวณ kg
  if (r.net_weight_kg <= 0 && r.net_weight_ton > 0) {
    r.net_weight_kg = round_(r.net_weight_ton * 1000, 2);
  }
  // inverse: มีแต่ kg → คำนวณ ton
  if (r.net_weight_ton <= 0 && r.net_weight_kg > 0) {
    r.net_weight_ton = round_(r.net_weight_kg / 1000, 3);
  }
  // (#11) release port "28xx" แต่ไม่มี loading port → default 2801
  if (r.release_port_code.indexOf("28") === 0 && !r.loading_port_code) {
    r.loading_port_code = "2801";
  }
  // (#12) บังคับ buyer country = destination country
  if (r.destination_country_code) {
    r.buyer_country_code = r.destination_country_code;
  }
}

/** มาร์ก record ที่ฟิลด์หลักขาด ให้ตรวจสอบ (Spec edge case #8) */
function flagIfIncomplete_(r) {
  if (!r.consignee_name || !r.invoice_number || !r.description_eng) {
    r._needs_review = true;
  }
}

function emptyRecord_() {
  const o = {};
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
