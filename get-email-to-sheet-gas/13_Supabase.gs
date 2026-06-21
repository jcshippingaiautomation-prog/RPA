/**
 * Supabase integration (GAS) — เขียนผลลง declarations + ดึง preset
 * ============================================================
 * ตั้งค่าใน Project Settings → Script Properties:
 *   SUPABASE_URL          = https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY  = sb_secret_...  (service/secret key)
 *
 * ถ้าไม่ได้ตั้งค่า จะ fallback ไปเขียน Google Sheet (ของเดิม)
 */

function supabaseConfig_() {
  var p = PropertiesService.getScriptProperties();
  return {
    url: p.getProperty("SUPABASE_URL") || "",
    key: p.getProperty("SUPABASE_SERVICE_KEY") || "",
  };
}

function supabaseEnabled_() {
  var c = supabaseConfig_();
  return !!(c.url && c.key);
}

/** ดึง customer_settings (allowed_fields + presets) ของลูกค้า 1 ราย */
function getCustomerSettings_(customerName) {
  if (!customerName || !supabaseEnabled_()) return null;
  var c = supabaseConfig_();
  var url = c.url + "/rest/v1/customer_settings?select=allowed_fields,presets&customer_name=eq."
    + encodeURIComponent(customerName) + "&limit=1";
  try {
    var res = UrlFetchApp.fetch(url, {
      method: "get",
      headers: { apikey: c.key, Authorization: "Bearer " + c.key },
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() >= 300) return null;
    var arr = JSON.parse(res.getContentText());
    return (arr && arr.length) ? arr[0] : null;
  } catch (e) {
    console.error("getCustomerSettings_ error: " + e);
    return null;
  }
}

/**
 * รวม preset เข้ากับ record: AI ชนะ — preset เติมเฉพาะช่องที่ว่าง
 * (presets เป็น object { field: value } จาก customer_settings)
 */
function applyPresets_(record, presets) {
  if (!presets) return record;
  for (var key in presets) {
    if (!presets.hasOwnProperty(key)) continue;
    var cur = record[key];
    var isEmpty = (cur === null || cur === undefined || String(cur).trim() === "" ||
      (typeof cur === "number" && cur === 0 && key !== "total_goods_amount"));
    if (isEmpty && presets[key] !== "" && presets[key] != null) {
      record[key] = presets[key];
    }
  }
  return record;
}

/**
 * อ่านค่า app_settings ด้วย key — value เป็น jsonb
 * คืน string (ถ้า value เป็น "..." JSON string) หรือ null
 */
function getAppSettingSupabase_(key) {
  if (!supabaseEnabled_()) return null;
  var c = supabaseConfig_();
  var url = c.url + "/rest/v1/app_settings?select=value&key=eq." + encodeURIComponent(key) + "&limit=1";
  try {
    var res = UrlFetchApp.fetch(url, {
      method: "get",
      headers: { apikey: c.key, Authorization: "Bearer " + c.key },
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() >= 300) return null;
    var arr = JSON.parse(res.getContentText());
    if (!arr || !arr.length) return null;
    var v = arr[0].value;
    // value อาจเป็น string ตรงๆ หรือ JSON string
    return (typeof v === "string") ? v : (v == null ? null : String(v));
  } catch (e) {
    console.error("getAppSettingSupabase_ error: " + e);
    return null;
  }
}

/** ดึงรายชื่อ sender ทั้งหมดใน allowlist (email_rules) */
function getAllowlistSenders_() {
  if (!supabaseEnabled_()) return [];
  var c = supabaseConfig_();
  try {
    var res = UrlFetchApp.fetch(c.url + "/rest/v1/email_rules?select=sender", {
      method: "get",
      headers: { apikey: c.key, Authorization: "Bearer " + c.key },
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() >= 300) return [];
    return JSON.parse(res.getContentText()).map(function (r) { return r.sender; }).filter(Boolean);
  } catch (e) {
    console.error("getAllowlistSenders_ error: " + e);
    return [];
  }
}

/**
 * สร้าง Gmail search query — กรองเฉพาะ sender ใน allowlist (ที่ Gmail เลย ประหยัด AI)
 * ถ้า allowlist ว่าง ใช้ query ตั้งต้น (อาจไม่เจออะไร)
 */
function buildSearchQuery_() {
  var senders = getAllowlistSenders_();
  var base = CONFIG.SEARCH_QUERY;
  if (!senders.length) return base;
  var fromClause = "from:(" + senders.join(" OR ") + ")";
  return base + " " + fromClause;
}

/**
 * เช็คว่า sender อยู่ใน allowlist (ตาราง email_rules — ใช้คอลัมน์ sender)
 * คืน true ถ้าอยู่ใน allowlist
 */
function isSenderAllowed_(email) {
  if (!email || !supabaseEnabled_()) return false;
  var c = supabaseConfig_();
  var url = c.url + "/rest/v1/email_rules?select=sender&sender=ilike."
    + encodeURIComponent(email) + "&limit=1";
  try {
    var res = UrlFetchApp.fetch(url, {
      method: "get",
      headers: { apikey: c.key, Authorization: "Bearer " + c.key },
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() >= 300) return false;
    var arr = JSON.parse(res.getContentText());
    return !!(arr && arr.length);
  } catch (e) {
    console.error("isSenderAllowed_ error: " + e);
    return false;
  }
}

/**
 * ดึง extraction_rules (กฎสกัดข้อมูล AI) ของลูกค้าจาก Supabase customer_settings
 * คืน string หรือ "" ถ้าไม่เจอ/ไม่ได้ตั้งค่า
 */
function getExtractionRulesSupabase_(customerName) {
  if (!customerName || !supabaseEnabled_()) return "";
  var c = supabaseConfig_();
  // ลองตรงเป๊ะก่อน
  var url = c.url + "/rest/v1/customer_settings?select=extraction_rules&customer_name=ilike."
    + encodeURIComponent(customerName) + "&limit=1";
  try {
    var res = UrlFetchApp.fetch(url, {
      method: "get",
      headers: { apikey: c.key, Authorization: "Bearer " + c.key },
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() >= 300) return "";
    var arr = JSON.parse(res.getContentText());
    return (arr && arr.length) ? (arr[0].extraction_rules || "") : "";
  } catch (e) {
    console.error("getExtractionRulesSupabase_ error: " + e);
    return "";
  }
}

/**
 * หา customer_settings ด้วย keyword (จาก classifier) — แทน sheet Identify_Customer
 * จับคู่แบบ contains สองทางกับ customer_name
 * คืน { customer_name, extraction_rules } หรือ null
 */
function lookupCustomerByKeywordSupabase_(keyword) {
  if (!keyword || !supabaseEnabled_()) return null;
  var c = supabaseConfig_();
  var url = c.url + "/rest/v1/customer_settings?select=customer_name,extraction_rules";
  try {
    var res = UrlFetchApp.fetch(url, {
      method: "get",
      headers: { apikey: c.key, Authorization: "Bearer " + c.key },
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() >= 300) return null;
    var arr = JSON.parse(res.getContentText());
    var kw = String(keyword).trim().toUpperCase();
    for (var i = 0; i < arr.length; i++) {
      var cn = String(arr[i].customer_name || "").trim().toUpperCase();
      if (cn && (cn === kw || cn.indexOf(kw) !== -1 || kw.indexOf(cn) !== -1)) {
        return arr[i];
      }
    }
    return null;
  } catch (e) {
    console.error("lookupCustomerByKeywordSupabase_ error: " + e);
    return null;
  }
}

/**
 * เช็คว่ามี declaration ของ customer+invoice นี้อยู่แล้วไหม (กันซ้ำ)
 * คืน true ถ้ามีอยู่แล้ว
 */
function declarationExists_(customerName, invoiceNumber) {
  if (!supabaseEnabled_()) return false;
  // ต้องมีทั้งคู่ถึงจะเช็คได้ (ถ้า invoice ว่าง ปล่อยให้ insert ปกติ)
  if (!customerName || !invoiceNumber) return false;
  var c = supabaseConfig_();
  var url = c.url + "/rest/v1/declarations?select=id"
    + "&customer_name=eq." + encodeURIComponent(customerName)
    + "&invoice_number=eq." + encodeURIComponent(invoiceNumber)
    + "&limit=1";
  try {
    var res = UrlFetchApp.fetch(url, {
      method: "get",
      headers: { apikey: c.key, Authorization: "Bearer " + c.key },
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() >= 300) return false;
    var arr = JSON.parse(res.getContentText());
    return !!(arr && arr.length);
  } catch (e) {
    console.error("declarationExists_ error: " + e);
    return false;
  }
}

/** insert record ลงตาราง declarations (กันซ้ำด้วย customer+invoice) */
function insertDeclaration_(record) {
  // กันซ้ำ: ถ้ามี customer+invoice นี้อยู่แล้ว ข้าม
  if (declarationExists_(record.customer_name, record.invoice_number)) {
    console.log("declaration ซ้ำ (ข้าม insert): " +
      record.customer_name + " / " + record.invoice_number);
    return;
  }

  var c = supabaseConfig_();
  var url = c.url + "/rest/v1/declarations";

  // map เฉพาะคอลัมน์ที่ตาราง declarations มี (= OUTPUT_COLUMNS)
  var payload = {};
  OUTPUT_COLUMNS.forEach(function (col) {
    var v = record[col];
    payload[col] = (v === null || v === undefined) ? null : v;
  });
  payload.source = "get-email";
  payload.doc_status = false;

  // ขอ id กลับมา (return=representation) เพื่อใช้ผูก declaration_items
  var res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: {
      apikey: c.key,
      Authorization: "Bearer " + c.key,
      Prefer: "return=representation",
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  if (code >= 300) {
    throw new Error("Supabase insert HTTP " + code + ": " + res.getContentText().slice(0, 300));
  }

  // ดึง declaration id แล้ว insert items (ถ้ามี)
  var declId = null;
  try {
    var arr = JSON.parse(res.getContentText());
    if (arr && arr.length) declId = arr[0].id;
  } catch (e) { /* ignore */ }

  if (declId && record._items && record._items.length) {
    insertDeclarationItems_(declId, record._items);
  }
}

/** insert รายการสินค้า (declaration_items) ทีเดียวหลายแถว */
function insertDeclarationItems_(declarationId, items) {
  var c = supabaseConfig_();
  var rows = items.map(function (it) {
    return {
      declaration_id: declarationId,
      line_no: it.line_no,
      description_eng: it.description_eng,
      brand_name: it.brand_name,
      container_or_volume_qty: it.container_or_volume_qty,
      container_unit_code: it.container_unit_code,
      net_weight_kg: it.net_weight_kg,
      gross_weight_kg: it.gross_weight_kg,
      net_weight_ton: it.net_weight_ton,
      amount: it.amount,
      is_foc: it.is_foc,
    };
  });
  var res = UrlFetchApp.fetch(c.url + "/rest/v1/declaration_items", {
    method: "post",
    contentType: "application/json",
    headers: {
      apikey: c.key,
      Authorization: "Bearer " + c.key,
      Prefer: "return=minimal",
    },
    payload: JSON.stringify(rows),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    console.error("insertDeclarationItems_ HTTP " + res.getResponseCode() + ": " +
      res.getContentText().slice(0, 200));
  } else {
    console.log("insert items: " + rows.length + " รายการ");
  }
}
