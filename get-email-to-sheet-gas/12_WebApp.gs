/**
 * Web App entry — ให้ rpa-web สั่งรัน + ดึงสถานะผ่าน HTTP
 * ============================================================
 * Deploy: Deploy → New deployment → type = Web app
 *   - Execute as: Me
 *   - Who has access: Anyone  (ป้องกันด้วย token แทน)
 * เอา URL (.../exec) ไปใส่ GAS_WEBAPP_URL ใน rpa-web/.env
 *
 * ตั้ง token: Project Settings → Script Properties → WEBAPP_TOKEN
 * แล้วใส่ค่าเดียวกันที่ GAS_SHARED_TOKEN ใน rpa-web/.env
 */

function doPost(e) {
  var body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (err) {
    return jsonOut_({ ok: false, error: "invalid JSON" });
  }

  // ตรวจ token (ถ้าตั้งไว้)
  var expected = PropertiesService.getScriptProperties().getProperty("WEBAPP_TOKEN");
  if (expected && body.token !== expected) {
    return jsonOut_({ ok: false, error: "unauthorized" });
  }

  var action = body.action || "";
  try {
    if (action === "run") {
      // โหมดทดสอบ: ถ้าส่ง subject มา → ค้นอีเมลด้วย subject นั้นแทน (ชั่วคราว)
      var summary = processInbox(body.subject || null);
      return jsonOut_({ ok: true, action: "run", summary: summary });
    }
    if (action === "status") {
      return jsonOut_({
        ok: true,
        action: "status",
        lastRun: getLastRunSummary_(),
        latestRows: getLatestRows_(5),
      });
    }
    return jsonOut_({ ok: false, error: "unknown action: " + action });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err && err.stack || err) });
  }
}

/** เผื่อเปิด URL ตรงๆ ด้วย GET (health check) */
function doGet() {
  return jsonOut_({ ok: true, service: "get-email-to-sheet", hint: "ใช้ POST + action" });
}

/** ผลลัพธ์รันล่าสุด (จาก PropertiesService) */
function getLastRunSummary_() {
  var raw = PropertiesService.getScriptProperties().getProperty("LAST_RUN_SUMMARY");
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/** ดึง N แถวล่าสุด — จาก Supabase ถ้าตั้งค่าไว้ ไม่งั้นจาก Sheet 'รายการ' */
function getLatestRows_(n) {
  var pick = function (r) {
    return {
      customer_name: r.customer_name || "",
      consignee_name: r.consignee_name || "",
      invoice_number: r.invoice_number || "",
      invoice_date: r.invoice_date || "",
      etd: r.etd || "",
      incoterms: r.incoterms || "",
      currency: r.currency || "",
      total_goods_amount: r.total_goods_amount || "",
    };
  };

  if (!supabaseEnabled_()) return [];
  var c = supabaseConfig_();
  var url = c.url + "/rest/v1/declarations?select=*&order=created_at.desc&limit=" + n;
  try {
    var res = UrlFetchApp.fetch(url, {
      method: "get",
      headers: { apikey: c.key, Authorization: "Bearer " + c.key },
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() < 300) {
      return JSON.parse(res.getContentText()).map(pick); // ใหม่สุดก่อนอยู่แล้ว
    }
  } catch (e) {
    console.error("getLatestRows_ supabase error: " + e);
  }
  return [];
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
