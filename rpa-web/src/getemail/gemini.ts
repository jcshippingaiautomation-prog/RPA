// ============================================================
//  Gemini REST client — port จาก GAS 07_Gemini.gs
//  UrlFetchApp → fetch, Utilities.sleep → await sleep
// ============================================================
import { config } from "../config.js";
import { getAppSetting } from "../supabase.js";
import { sleep } from "./utils.js";

export interface InlineFile {
  mimeType: string;
  bytesBase64: string;
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown };
}
interface GeminiContent {
  role: string;
  parts: GeminiPart[];
}
interface GeminiResponse {
  candidates?: { content?: GeminiContent }[];
}

/** model: Supabase app_settings(gemini_model) > env GEMINI_MODEL > default */
async function geminiModel(): Promise<string> {
  const fromSupabase = await getAppSetting<string>("gemini_model");
  if (fromSupabase && String(fromSupabase).trim()) return String(fromSupabase).trim();
  return config.gemini.defaultModel;
}

async function geminiEndpoint(): Promise<string> {
  const model = await geminiModel();
  return (
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    model + ":generateContent?key=" + config.gemini.apiKey
  );
}

/** map [{mimeType,bytesBase64}] → Gemini inlineData parts */
export function fileParts(files: InlineFile[]): GeminiPart[] {
  return files.map((f) => ({ inlineData: { mimeType: f.mimeType, data: f.bytesBase64 } }));
}

/** หาเวลารอจาก response ("retry in Ns") ไม่งั้น exponential backoff */
function retryDelayMs(text: string, attempt: number): number {
  const m = text && text.match(/retry in ([\d.]+)s/i);
  if (m) {
    const s = parseFloat(m[1]);
    return Math.min(Math.ceil(s) * 1000 + 1000, 50000);
  }
  return Math.min(2000 * Math.pow(2, attempt), 30000);
}

/**
 * เรียก Gemini หนึ่งครั้ง (retry 429/5xx สูงสุด 3 ครั้ง)
 */
export async function geminiGenerate(
  systemPrompt: string,
  parts: GeminiPart[] | null,
  contents?: GeminiContent[] | null,
  tools?: unknown[] | null,
): Promise<GeminiResponse> {
  if (!config.gemini.enabled) {
    throw new Error("ไม่พบ GEMINI_API_KEY — ตั้งใน .env ก่อน");
  }
  const payload: Record<string, unknown> = {
    contents: contents || [{ role: "user", parts: parts || [] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { temperature: 0 },
  };
  if (tools) payload.tools = tools;
  const body = JSON.stringify(payload);

  const MAX_TRIES = 3;
  let lastText = "";
  let lastCode = 0;
  const endpoint = await geminiEndpoint();
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    lastCode = res.status;
    lastText = await res.text();
    if (lastCode >= 200 && lastCode < 300) {
      return JSON.parse(lastText) as GeminiResponse;
    }
    if ((lastCode === 429 || lastCode >= 500) && attempt < MAX_TRIES) {
      const waitMs = retryDelayMs(lastText, attempt);
      console.warn(`[getemail] Gemini ${lastCode} — รอ ${Math.round(waitMs / 1000)}s แล้วลองใหม่ (${attempt}/${MAX_TRIES - 1})`);
      await sleep(waitMs);
      continue;
    }
    break;
  }
  throw new Error(`Gemini HTTP ${lastCode}: ${lastText.slice(0, 500)}`);
}

/** ดึง text รวมจาก candidate แรก */
export function geminiText(response: GeminiResponse): string {
  const parts = response?.candidates?.[0]?.content?.parts;
  if (!parts) return "";
  return parts.map((p) => p.text || "").join("").trim();
}

/** ดึง functionCall จาก candidate แรก */
export function geminiFunctionCalls(
  response: GeminiResponse,
): { name: string; args?: Record<string, unknown> }[] {
  const parts = response?.candidates?.[0]?.content?.parts;
  if (!parts) return [];
  const calls: { name: string; args?: Record<string, unknown> }[] = [];
  for (const p of parts) if (p.functionCall) calls.push(p.functionCall);
  return calls;
}

/** ดึง content ของ candidate แรก (สำหรับ echo turn) */
export function geminiCandidateContent(response: GeminiResponse): GeminiContent | null {
  return response?.candidates?.[0]?.content ?? null;
}

export type { GeminiContent, GeminiPart, GeminiResponse };
