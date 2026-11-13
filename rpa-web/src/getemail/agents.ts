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
  dateFacts = "",
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

  // วันที่ที่ระบบแปลงมาให้แล้ว — วางท้ายสุดเพื่อให้มีน้ำหนักกว่ากฎอื่น
  if (dateFacts) intro += "\n\n" + dateFacts;

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

/**
 * Agent 3 — กรอกช่องที่ Master สั่งไว้เป็น "คำสั่ง" (โหมด rule)
 *   ทำหลังเลือก Master ได้แล้ว เพราะคำสั่งผูกกับ Master (ผู้ซื้อ/สินค้า) ไม่ใช่กับลูกค้าทั้งราย
 *   อ่านเอกสารชุดเดิม + ค่าที่สกัดมาแล้วรอบแรก (เช่น เลขใบกำกับ วันที่) → ตอบเฉพาะช่องที่ขอ
 *   คืน { key: value } · ช่องที่หาไม่ได้ = "" (ผู้เรียกตัดสินเองว่าจะทำอย่างไร)
 */
export async function fillFieldsByInstruction(
  files: InlineFile[],
  fields: { key: string; label: string; type: string; instruction: string }[],
  context: Record<string, unknown>,
): Promise<Record<string, string>> {
  if (!fields.length) return {};
  const system =
    "คุณคือผู้ช่วยเจ้าหน้าที่ชิปปิ้งที่กรอกใบขนสินค้าขาออก\n" +
    "ได้รับ: เอกสารของชิปเมนต์ + ข้อมูลที่สกัดจากเอกสารชุดนี้แล้ว + รายการช่องที่ต้องกรอกพร้อมคำสั่งของเจ้าหน้าที่\n" +
    "หน้าที่: ทำตามคำสั่งของแต่ละช่องให้ตรงที่สุด โดยใช้ข้อมูลจากเอกสารชุดนี้เท่านั้น\n" +
    "กฎ:\n" +
    "- ตอบเป็น JSON object อย่างเดียว ไม่มีคำอธิบาย: key = รหัสช่องตามที่ให้ไป, value = ข้อความที่จะกรอกลงช่องนั้น (string)\n" +
    "- ช่องชนิดวันที่ (date): ตอบรูปแบบ YYYY-MM-DD (ค.ศ.) เสมอ แม้คำสั่งจะบอกให้แสดงแบบอื่น\n" +
    "- ช่องข้อความ: ทำตามรูปแบบในคำสั่งเป๊ะ ๆ (ตัวพิมพ์ เว้นวรรค ขึ้นบรรทัดใหม่ใช้ \\n) ถ้าคำสั่งให้ใส่วันที่ในข้อความ ให้ใช้รูปแบบตามที่คำสั่งบอก ถ้าไม่บอกใช้ วว/ดด/ปปปป (ค.ศ.)\n" +
    "- ค่าที่ต้องเอามาจากเอกสาร ให้ใช้ค่าของชิปเมนต์นี้เท่านั้น ห้ามใช้ค่าตัวอย่างในคำสั่ง\n" +
    "- ถ้าหาข้อมูลตามคำสั่งไม่ได้จริง ๆ ให้ตอบ \"\" สำหรับช่องนั้น ห้ามเดา";
  const ctx: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(context)) {
    if (k.startsWith("_") || v == null || typeof v === "object") continue;
    const s = String(v).trim();
    if (s) ctx[k] = s.length > 300 ? s.slice(0, 300) + "…" : s;
  }
  const text =
    "[ข้อมูลที่สกัดจากเอกสารชุดนี้แล้ว]\n" + JSON.stringify(ctx, null, 1) + "\n\n" +
    "[ช่องที่ต้องกรอก + คำสั่ง]\n" +
    fields.map((f) => `- รหัสช่อง "${f.key}" (${f.label}, ชนิด ${f.type}): ${f.instruction}`).join("\n") +
    "\n\nตอบ JSON เช่น {" + fields.map((f) => `"${f.key}": "..."`).join(", ") + "}";
  const response = await geminiGenerate(system, [{ text }, ...fileParts(files)] as GeminiPart[]);
  const parsed = safeParseJson(geminiText(response)) as Record<string, unknown> | null;
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = parsed ? parsed[f.key] : undefined;
    out[f.key] = v == null ? "" : String(v).replace(/\\n/g, "\n").trim();
  }
  return out;
}

/**
 * Agent 4 — ช่องในรายการสินค้าที่ Master สั่งไว้เป็น "คำสั่ง" (ตอบแยกทีละรายการ)
 *   คืน { "idx|key": value } — idx = ลำดับรายการ (0 = รายการแรก)
 */
export async function fillItemFieldsByInstruction(
  files: InlineFile[],
  asks: { idx: number; key: string; label: string; type: string; instruction: string }[],
  header: Record<string, unknown>,
  items: { line?: number; product: string; description: string }[],
): Promise<Record<string, string>> {
  if (!asks.length) return {};
  const system =
    "คุณคือผู้ช่วยเจ้าหน้าที่ชิปปิ้งที่กรอกใบขนสินค้าขาออก (ส่วนรายการสินค้า)\n" +
    "ได้รับ: เอกสารของชิปเมนต์ + ข้อมูลหัวใบที่สกัดแล้ว + รายการสินค้าตามลำดับ + ช่องที่ต้องกรอกในแต่ละรายการพร้อมคำสั่ง\n" +
    "กฎ:\n" +
    "- ตอบเป็น JSON object อย่างเดียว: {\"items\":[{\"idx\":ลำดับรายการ,\"key\":\"รหัสช่อง\",\"value\":\"ข้อความ\"}, ...]} ตอบครบทุกคู่ที่ขอ\n" +
    "- ค่าของแต่ละรายการต้องมาจากสินค้ารายการนั้นในเอกสาร ห้ามเอาค่าของรายการอื่น ห้ามใช้ค่าตัวอย่างในคำสั่ง\n" +
    "- ช่องชนิดวันที่ (date): ตอบ YYYY-MM-DD · ช่องข้อความ: ทำตามรูปแบบในคำสั่งเป๊ะ ๆ ขึ้นบรรทัดใหม่ใช้ \\n\n" +
    "- หาไม่ได้จริง ๆ ให้ value เป็น \"\" ห้ามเดา";
  const ctx: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(header)) {
    if (k.startsWith("_") || v == null || typeof v === "object") continue;
    const s = String(v).trim();
    if (s) ctx[k] = s.length > 200 ? s.slice(0, 200) + "…" : s;
  }
  const text =
    "[ข้อมูลหัวใบ]\n" + JSON.stringify(ctx, null, 1) + "\n\n" +
    "[รายการสินค้า]\n" + items.map((it, i) => `- idx ${i}${it.line ? ` (ลำดับ ${it.line})` : ""}: ${it.product} — ${it.description}`).join("\n") +
    "\n\n[ช่องที่ต้องกรอก]\n" +
    asks.map((a) => `- idx ${a.idx} · รหัสช่อง "${a.key}" (${a.label}, ชนิด ${a.type}): ${a.instruction}`).join("\n");
  const response = await geminiGenerate(system, [{ text }, ...fileParts(files)] as GeminiPart[]);
  const parsed = safeParseJson(geminiText(response)) as { items?: { idx?: unknown; key?: unknown; value?: unknown }[] } | null;
  const out: Record<string, string> = {};
  for (const r of parsed?.items ?? []) {
    const idx = Number(r.idx);
    if (!Number.isInteger(idx) || typeof r.key !== "string") continue;
    out[`${idx}|${r.key}`] = r.value == null ? "" : String(r.value).replace(/\\n/g, "\n").trim();
  }
  return out;
}
