/**
 * Get Email to Sheet — Google Apps Script
 * ============================================================
 * แทนที่ n8n workflow "Get Email to System"
 *
 *  ดึงอีเมลที่มีเอกสารแนบจากลูกค้าที่ลงทะเบียน
 *   → ใช้ Gemini 2.5 Pro สกัดข้อมูลใบขนสินค้า 25 ฟิลด์
 *   → เขียนลง Google Sheet "รายการ"
 *   → ติด Gmail label กันประมวลผลซ้ำ
 *
 * จากนั้น rpa_import.py จะอ่าน sheet นี้ไปกรอกเว็บ DCTK ต่อ
 *
 * วิธีติดตั้ง: ดู README.md (ย่อ: ใส่ GEMINI_API_KEY ใน Script Properties
 * แล้วตั้ง time-driven trigger ของ processInbox ทุก 1 นาที)
 * ============================================================
 */

const CONFIG = {
  // ---- Google Sheet ----
  SHEET_ID: "1-hR-Q_b01E6Ci_EB3Si9Pq8WiJ7j_UBwudzV9sVrFd8",
  OUTPUT_TAB: "รายการ",
  CUSTOMER_RULE_TAB: "Customer_Rule",
  IDENTIFY_CUSTOMER_TAB: "Identify_Customer",

  // ---- Gmail ----
  // query สำหรับหาอีเมลผู้สมัคร (มีไฟล์แนบ, ใหม่ใน 1 วัน, ยังไม่ติด label)
  SEARCH_QUERY: 'has:attachment newer_than:1d -label:processed-by-rpa',
  PROCESSED_LABEL: "processed-by-rpa",
  MAX_THREADS: 2,             // จำกัดต่อรอบ (ช่วงทดสอบ/ประหยัด quota; โปรดเพิ่มเป็น 5 เมื่อเปิด billing แล้ว)

  // ---- Gemini ----
  // ดีฟอลต์ gemini-2.5-flash (มี free tier); เปลี่ยนได้ด้วย Script Property GEMINI_MODEL
  GEMINI_MODEL: "gemini-2.5-flash",
  // อ่าน API key จาก Script Properties (ห้าม hard-code) — ดู README
  // Project Settings → Script Properties → GEMINI_API_KEY

  // ---- ชื่อคอลัมน์ lookup ----
  COL_RULE_EMAIL: "Email",                 // Customer_Rule: lookup ด้วย sender email
  COL_RULE_SUBJECT: "Subject",             // Customer_Rule: subject pattern
  COL_RULE_NAME: "Customer_Name",          // Customer_Rule: ชื่อลูกค้า (tool lookup)
  COL_IDENT_KEYWORD: "Keyword_To_Search",  // Identify_Customer: lookup ด้วย keyword
};

/** ลำดับคอลัมน์ของ output tab "รายการ" (ตรงกับ Spec §5.3) */
const OUTPUT_COLUMNS = [
  "customer_name",
  "consignee_name",
  "buyer_country_code",
  "destination_country_code",
  "invoice_number",
  "invoice_date",
  "tax_payment_method_code",
  "vessel_name",
  "voyage_number",
  "etd",
  "release_port_code",
  "loading_port_code",
  "incoterms",
  "currency",
  "total_goods_amount",
  "freight_charge",
  "insurance_charge",
  "shipping_mark",
  "description_eng",
  "net_weight_kg",
  "gross_weight_kg",
  "net_weight_ton",
  "net_weight_unit_code",
  "container_or_volume_qty",
  "container_unit_code",
];

/** อ่าน Gemini API key จาก Script Properties */
function getGeminiApiKey_() {
  const key = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!key) {
    throw new Error(
      'ไม่พบ GEMINI_API_KEY — ตั้งค่าใน Project Settings → Script Properties'
    );
  }
  return key;
}
