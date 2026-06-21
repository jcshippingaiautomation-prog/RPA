// ============================================================
//  AI Agents — Classifier + Extractor — port จาก GAS 08_Agents.gs
//  tool Get_Customer_Rules → ดึง extraction_rules จาก Supabase
// ============================================================
import { CLASSIFIER_SYSTEM_PROMPT, EXTRACTOR_SYSTEM_PROMPT } from "./prompts.js";
import {
  geminiGenerate,
  geminiText,
  geminiFunctionCalls,
  geminiCandidateContent,
  fileParts,
  type InlineFile,
  type GeminiContent,
  type GeminiPart,
} from "./gemini.js";
import { safeParseJson } from "./utils.js";
import { getExtractionRulesByKeyword } from "../supabase.js";

const MAX_TOOL_TURNS = 4;

/** Agent 1 — สกัด keyword ชื่อลูกค้าจากเอกสาร */
export async function classifyCustomer(
  files: InlineFile[],
): Promise<{ search_keyword: string; [k: string]: unknown } | null> {
  const parts: GeminiPart[] = [
    { text: "นี่คือเอกสารแนบจากอีเมล โปรดสกัด Keyword ชื่อลูกค้าตามกฎ" },
    ...fileParts(files),
  ];
  const response = await geminiGenerate(CLASSIFIER_SYSTEM_PROMPT, parts);
  const raw = geminiText(response);
  const parsed = safeParseJson(raw);
  if (!parsed || !parsed.search_keyword) {
    console.error("[getemail] classifier output ไม่ถูกต้อง: " + String(raw).slice(0, 300));
    return null;
  }
  parsed.search_keyword = String(parsed.search_keyword).trim().toUpperCase();
  return parsed as { search_keyword: string };
}

/** Agent 2 — สกัด declaration (multi-turn tool calling Get_Customer_Rules) */
export async function extractDeclaration(
  files: InlineFile[],
  preloadedRule: unknown,
  emailBody: string,
): Promise<string> {
  let intro = "นี่คือเอกสารแนบจากอีเมล โปรดสกัดข้อมูลใบขนสินค้าตาม Schema";
  if (preloadedRule) {
    intro += "\n\n[คู่มือการสกัดข้อมูลเฉพาะลูกค้า (preloaded)]\n" + JSON.stringify(preloadedRule);
  }
  if (emailBody && emailBody.trim()) {
    intro +=
      "\n\n[เนื้อหาอีเมล (email body) — ใช้หาข้อมูลที่ไม่อยู่ในไฟล์แนบ เช่น ค่าระวาง/Freight/O.F]\n" +
      emailBody.slice(0, 4000);
  }

  const contents: GeminiContent[] = [
    { role: "user", parts: [{ text: intro }, ...fileParts(files)] as GeminiPart[] },
  ];

  const tools = [
    {
      functionDeclarations: [
        {
          name: "Get_Customer_Rules",
          description: "ดึงคู่มือการสกัดข้อมูลเฉพาะลูกค้าจากฐานข้อมูล",
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
        },
      ],
    },
  ];

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const response = await geminiGenerate(EXTRACTOR_SYSTEM_PROMPT, null, contents, tools);
    const calls = geminiFunctionCalls(response);
    if (!calls.length) return geminiText(response);

    const modelContent = geminiCandidateContent(response);
    if (modelContent) contents.push(modelContent);

    const responseParts = [];
    for (const call of calls) {
      const name = call.name || "";
      let result: unknown = { error: "Unknown tool: " + name };
      if (name === "Get_Customer_Rules") {
        const customerName = String(call.args?.Customer_Name || "");
        const found = await getExtractionRulesByKeyword(customerName);
        result = {
          customer_rules: found
            ? { Customer_Name: found.customer_name, Extraction_Rules: found.extraction_rules }
            : null,
        };
        console.log(`[getemail] tool Get_Customer_Rules: ${customerName} → ${found ? "found" : "not found"}`);
      }
      responseParts.push({ functionResponse: { name, response: { result } } });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  console.warn("[getemail] extractor เกิน max tool turns — ดึง output ครั้งสุดท้าย");
  const finalResp = await geminiGenerate(EXTRACTOR_SYSTEM_PROMPT, null, contents, null);
  return geminiText(finalResp);
}
