/**
 * อ่าน/lookup/append Google Sheet (Spec §6.3.1, §6.6, §6.9)
 * ============================================================
 */

// cache tab ที่อ่านแล้วภายในรอบการรัน (กันอ่านซ้ำ)
var _tabCache_ = {};
var _ssCache_ = null;

/** เปิด spreadsheet (ครั้งเดียว) */
function getSpreadsheet_() {
  if (!_ssCache_) _ssCache_ = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  return _ssCache_;
}

/**
 * อ่านทั้ง tab → array ของ object (key = header แถวแรก)
 * @return {Object[]}
 */
function readTab_(tabName) {
  if (_tabCache_[tabName]) return _tabCache_[tabName];

  const sheet = getSpreadsheet_().getSheetByName(tabName);
  if (!sheet) throw new Error("ไม่พบ tab: " + tabName);

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    _tabCache_[tabName] = [];
    return [];
  }

  const headers = values[0].map(function (h) { return String(h).trim(); });
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      const v = values[i][c];
      obj[headers[c]] = (v === null || v === undefined) ? "" : String(v);
    }
    rows.push(obj);
  }
  _tabCache_[tabName] = rows;
  return rows;
}

/** หาแถวแรกที่ column = value (case-insensitive trim) */
function findRow_(tabName, column, value) {
  if (!value) return null;
  const target = String(value).trim().toLowerCase();
  const rows = readTab_(tabName);
  for (const r of rows) {
    if (String(r[column] || "").trim().toLowerCase() === target) return r;
  }
  return null;
}

/** lookup ลูกค้าด้วย sender email (Customer_Rule tab) */
function lookupCustomerByEmail_(email) {
  return findRow_(CONFIG.CUSTOMER_RULE_TAB, CONFIG.COL_RULE_EMAIL, email);
}

/** lookup กฎด้วย keyword จาก classifier (Identify_Customer tab) */
function lookupRuleByKeyword_(keyword) {
  return findRow_(CONFIG.IDENTIFY_CUSTOMER_TAB, CONFIG.COL_IDENT_KEYWORD, keyword);
}

/** lookup กฎด้วยชื่อลูกค้า — ใช้โดย Gemini tool Get_Customer_Rules (Spec §8) */
function lookupRuleByName_(customerName) {
  return findRow_(CONFIG.CUSTOMER_RULE_TAB, CONFIG.COL_RULE_NAME, customerName);
}

/**
 * บันทึก declaration record ลงตาราง declarations (Supabase เท่านั้น)
 *   1) เติม preset รายลูกค้า (AI ชนะ — preset เติมช่องว่าง)
 *   2) เขียนลง Supabase declarations
 */
function appendDeclaration_(record) {
  // เติม preset จาก customer_settings (ใช้ customer_name ที่ AI สกัดได้)
  var settings = getCustomerSettings_(record.customer_name);
  if (settings && settings.presets) {
    applyPresets_(record, settings.presets);
  }
  insertDeclaration_(record);
}
