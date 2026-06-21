/**
 * เรียก Gemini REST API ผ่าน UrlFetchApp
 * ============================================================
 * Endpoint: generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 */

function geminiModel_() {
  // ลำดับ: Supabase app_settings (gemini_model) > Script Property GEMINI_MODEL > CONFIG
  var fromSupabase = getAppSettingSupabase_("gemini_model");
  if (fromSupabase && String(fromSupabase).trim()) return String(fromSupabase).trim();
  var m = PropertiesService.getScriptProperties().getProperty("GEMINI_MODEL");
  return (m && m.trim()) ? m.trim() : CONFIG.GEMINI_MODEL;
}

function geminiEndpoint_() {
  return "https://generativelanguage.googleapis.com/v1beta/models/" +
    geminiModel_() + ":generateContent?key=" + getGeminiApiKey_();
}

/** สร้าง parts ของ inlineData จากไฟล์ที่เตรียมไว้ */
function fileParts_(files) {
  return files.map(function (f) {
    return { inlineData: { mimeType: f.mimeType, data: f.bytesBase64 } };
  });
}

/**
 * เรียก Gemini หนึ่งครั้ง
 * @param {string} systemPrompt
 * @param {Object[]} parts          parts ของ user turn
 * @param {Object[]=} contents      ถ้าส่งมา จะใช้แทน (สำหรับ multi-turn tool calling)
 * @param {Object[]=} tools         function declarations
 * @return {Object} full response JSON
 */
function geminiGenerate_(systemPrompt, parts, contents, tools) {
  const payload = {
    contents: contents || [{ role: "user", parts: parts }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { temperature: 0 },
  };
  if (tools) payload.tools = tools;
  const body = JSON.stringify(payload);

  // retry เมื่อเจอ 429 (rate limit) หรือ 5xx — backoff สูงสุด ~3 ครั้ง
  var MAX_TRIES = 3;
  var lastText = "";
  var lastCode = 0;
  for (var attempt = 1; attempt <= MAX_TRIES; attempt++) {
    var res = UrlFetchApp.fetch(geminiEndpoint_(), {
      method: "post",
      contentType: "application/json",
      payload: body,
      muteHttpExceptions: true,
    });
    lastCode = res.getResponseCode();
    lastText = res.getContentText();

    if (lastCode >= 200 && lastCode < 300) {
      return JSON.parse(lastText);
    }

    // 429 = rate limit, 500/503 = ชั่วคราว → รอแล้วลองใหม่
    if ((lastCode === 429 || lastCode >= 500) && attempt < MAX_TRIES) {
      var waitMs = retryDelayMs_(lastText, attempt);
      console.warn("Gemini " + lastCode + " — รอ " + Math.round(waitMs / 1000) +
        "s แล้วลองใหม่ (ครั้งที่ " + attempt + "/" + (MAX_TRIES - 1) + ")");
      Utilities.sleep(waitMs);
      continue;
    }
    break; // error อื่น ไม่ retry
  }
  throw new Error("Gemini HTTP " + lastCode + ": " + lastText.slice(0, 500));
}

/** หาเวลารอจาก response (ถ้ามี "retry in Ns") ไม่งั้น backoff แบบ exponential */
function retryDelayMs_(text, attempt) {
  var m = text && text.match(/retry in ([\d.]+)s/i);
  if (m) {
    var s = parseFloat(m[1]);
    // จำกัดไม่เกิน 50s (GAS execution limit 6 นาที)
    return Math.min(Math.ceil(s) * 1000 + 1000, 50000);
  }
  return Math.min(2000 * Math.pow(2, attempt), 30000); // 4s, 8s, ...
}

/** ดึง text รวมจาก candidate แรก */
function geminiText_(response) {
  const parts =
    response &&
    response.candidates &&
    response.candidates[0] &&
    response.candidates[0].content &&
    response.candidates[0].content.parts;
  if (!parts) return "";
  return parts
    .map(function (p) { return p.text || ""; })
    .join("")
    .trim();
}

/** ดึง functionCall จาก candidate แรก (ถ้ามี) */
function geminiFunctionCalls_(response) {
  const parts =
    response &&
    response.candidates &&
    response.candidates[0] &&
    response.candidates[0].content &&
    response.candidates[0].content.parts;
  if (!parts) return [];
  const calls = [];
  for (const p of parts) {
    if (p.functionCall) calls.push(p.functionCall);
  }
  return calls;
}
