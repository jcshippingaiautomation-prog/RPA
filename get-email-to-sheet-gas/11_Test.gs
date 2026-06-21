/**
 * ฟังก์ชันทดสอบ — รันด้วยมือจาก editor (เมนู Run)
 * ============================================================
 */

/** ตรวจว่าตั้งค่า + เข้าถึงทุกบริการได้ครบ (รันก่อนเปิด trigger) */
function selfTest() {
  // 1) Gemini key
  getGeminiApiKey_();
  console.log("✓ GEMINI_API_KEY พบแล้ว");

  // 2) Supabase config (แหล่งข้อมูลเดียวของระบบ)
  if (!supabaseEnabled_()) {
    throw new Error("ยังไม่ได้ตั้งค่า SUPABASE_URL / SUPABASE_SERVICE_KEY ใน Script Properties");
  }
  console.log("✓ Supabase config พบแล้ว");

  // 3) ทดสอบเชื่อม Supabase — อ่าน customer_settings
  var c = supabaseConfig_();
  var res = UrlFetchApp.fetch(
    c.url + "/rest/v1/customer_settings?select=customer_name&limit=5",
    { method: "get", headers: { apikey: c.key, Authorization: "Bearer " + c.key }, muteHttpExceptions: true }
  );
  if (res.getResponseCode() >= 300) {
    throw new Error("เชื่อม Supabase ไม่สำเร็จ: HTTP " + res.getResponseCode() + " " + res.getContentText().slice(0, 200));
  }
  var custs = JSON.parse(res.getContentText());
  console.log("✓ เชื่อม Supabase ได้ — customer_settings " + custs.length + " ราย: " +
    custs.map(function (x) { return x.customer_name; }).join(", "));

  // 4) email_rules
  var res2 = UrlFetchApp.fetch(
    c.url + "/rest/v1/email_rules?select=sender&limit=10",
    { method: "get", headers: { apikey: c.key, Authorization: "Bearer " + c.key }, muteHttpExceptions: true }
  );
  if (res2.getResponseCode() < 300) {
    var ers = JSON.parse(res2.getContentText());
    console.log("✓ email_rules " + ers.length + " ราย");
  }

  // 5) WEBAPP_TOKEN (สำหรับสั่งรันจากหน้าเว็บ)
  var token = PropertiesService.getScriptProperties().getProperty("WEBAPP_TOKEN");
  console.log(token ? "✓ WEBAPP_TOKEN ตั้งแล้ว" : "⚠ ยังไม่ตั้ง WEBAPP_TOKEN (สั่งรันจากเว็บจะไม่ได้)");

  // 6) Gmail search
  var n = GmailApp.search(CONFIG.SEARCH_QUERY, 0, 1).length;
  console.log("✓ Gmail search ใช้ได้ (พบ " + n + " thread ตัวอย่าง)");

  // 7) Drive advanced service
  if (typeof Drive === "undefined") {
    console.warn("⚠ Drive advanced service ยังไม่เปิด — DOCX/XLSX จะแปลงไม่ได้ (PDF/รูป ยังทำงานปกติ)");
  } else {
    console.log("✓ Drive advanced service พร้อม");
  }

  console.log("=== selfTest ผ่าน — พร้อมใช้งาน ===");
}

/** ทดสอบ post-process ด้วยตัวอย่างจาก Spec §13.4 */
function testPostProcess() {
  const sample = JSON.stringify({
    buyer_country_code: "ZA",
    destination_country_code: "ZA",
    customer_name: "ZECK TSE",
    vessel_name: "MAERSK SENTOSA",
    voyage_number: "445S",
    release_port_code: "2801",
    loading_port_code: "",
    shipping_mark: "ZECK TSE/DURBAN",
    tax_payment_method_code: "",
    etd: "2026-03-15",
    invoice_number: "2604034",
    invoice_date: "2026-02-28",
    consignee_name: "ZECK TSE TRADING (PTY) LTD",
    incoterms: "cif",
    currency: "usd",
    total_goods_amount: "45,230.50",
    freight_charge: 1850,
    insurance_charge: 120,
    net_weight_kg: 0,
    gross_weight_kg: 19200,
    description_eng: "REFINED PALM OIL",
    net_weight_ton: 18.5,
    net_weight_unit_code: "",
    container_or_volume_qty: "1",
    container_unit_code: "20FT",
  });
  const r = postProcess_(sample);
  console.log(JSON.stringify(r, null, 2));
  // คาดหวัง: tax=A, incoterms=CIF, total=45230.5, net_weight_kg=18500,
  //          loading_port_code=2801, net_weight_unit_code=TO
}
