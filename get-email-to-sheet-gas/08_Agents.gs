/**
 * AI Agents — Classifier + Extractor (Spec §6.5, §6.7, §8)
 * ============================================================
 */

var MAX_TOOL_TURNS = 4;

/**
 * AI Agent 1 — สกัด keyword ชื่อลูกค้าจากเอกสาร
 * @return {Object|null} { search_keyword, confidence_score, found_in_document }
 */
function classifyCustomer_(files) {
  const parts = [{ text: "นี่คือเอกสารแนบจากอีเมล โปรดสกัด Keyword ชื่อลูกค้าตามกฎ" }]
    .concat(fileParts_(files));

  const response = geminiGenerate_(CLASSIFIER_SYSTEM_PROMPT, parts);
  const raw = geminiText_(response);
  const parsed = safeParseJson_(raw);

  if (!parsed || !parsed.search_keyword) {
    console.error("classifier output ไม่ถูกต้อง: " + String(raw).slice(0, 300));
    return null;
  }
  parsed.search_keyword = String(parsed.search_keyword).trim().toUpperCase();
  return parsed;
}

/**
 * AI Agent 2 — สกัดข้อมูล declaration 25 ฟิลด์
 * รองรับ tool Get_Customer_Rules (multi-turn function calling)
 * @return {string} raw text (JSON) จาก AI
 */
function extractDeclaration_(files, preloadedRule, emailBody) {
  let intro = "นี่คือเอกสารแนบจากอีเมล โปรดสกัดข้อมูลใบขนสินค้าตาม Schema";
  if (preloadedRule) {
    intro += "\n\n[คู่มือการสกัดข้อมูลเฉพาะลูกค้า (preloaded)]\n" +
      JSON.stringify(preloadedRule);
  }
  if (emailBody && String(emailBody).trim()) {
    // ตัด body ยาวเกินไป (กัน token บาน) — เก็บ 4000 ตัวอักษรแรกพอ
    intro += "\n\n[เนื้อหาอีเมล (email body) — ใช้หาข้อมูลที่ไม่อยู่ในไฟล์แนบ เช่น ค่าระวาง/Freight/O.F]\n" +
      String(emailBody).slice(0, 4000);
  }

  const contents = [{
    role: "user",
    parts: [{ text: intro }].concat(fileParts_(files)),
  }];

  const tools = [{
    functionDeclarations: [{
      name: "Get_Customer_Rules",
      description: "ดึงคู่มือการสกัดข้อมูลเฉพาะลูกค้าจาก Google Sheets",
      parameters: {
        type: "OBJECT",
        properties: {
          Customer_Name: {
            type: "STRING",
            description: "ชื่อลูกค้าที่สกัดได้จากเอกสาร (UPPERCASE keyword)",
          },
        },
        required: ["Customer_Name"],
      },
    }],
  }];

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const response = geminiGenerate_(EXTRACTOR_SYSTEM_PROMPT, null, contents, tools);
    const calls = geminiFunctionCalls_(response);

    if (!calls.length) {
      return geminiText_(response);
    }

    // echo turn ของ model แล้วตอบทุก function call
    contents.push(response.candidates[0].content);

    const responseParts = [];
    for (const call of calls) {
      const name = call.name || "";
      let result = { error: "Unknown tool: " + name };
      if (name === "Get_Customer_Rules") {
        const customerName = String((call.args && call.args.Customer_Name) || "");
        const sbRules = getExtractionRulesSupabase_(customerName);
        result = {
          customer_rules: sbRules
            ? { Customer_Name: customerName, Extraction_Rules: sbRules }
            : null,
        };
        console.log("tool Get_Customer_Rules: " + customerName +
          " → " + (sbRules ? "found" : "not found"));
      }
      responseParts.push({
        functionResponse: { name: name, response: { result: result } },
      });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  console.warn("extractor เกิน max tool turns — ลองดึง output ครั้งสุดท้าย");
  const finalResp = geminiGenerate_(EXTRACTOR_SYSTEM_PROMPT, null, contents, null);
  return geminiText_(finalResp);
}
