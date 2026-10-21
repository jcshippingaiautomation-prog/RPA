// ============================================================
//  AI สำรอง — ThaiLLM (thaillm.or.th, รูปแบบเดียวกับ OpenAI chat/completions)
//  ใช้ชั่วคราวเมื่อ Gemini ใช้ไม่ได้ · เปิดด้วย AI_PROVIDER=thaillm หรือ app_settings(ai_provider)
//
//  ต่างจาก Gemini 2 เรื่อง:
//   - ไม่รับไฟล์ PDF/Excel → ถอดเป็นข้อความก่อนส่ง (รูปภาพส่งเป็นรูปได้)
//     PDF ที่เป็นภาพสแกนล้วนจะไม่มีข้อความให้ถอด → แจ้ง error ให้ชัด แทนที่จะให้ AI เดา
//   - ไม่ใช้ tool calling — หน้าอัปโหลดส่งบรีฟลูกค้าไปพร้อมคำสั่งอยู่แล้ว
// ============================================================
import * as XLSX from "xlsx";
import { getAppSetting } from "../supabase.js";
import { sleep } from "./utils.js";
import type { GeminiContent, GeminiPart, GeminiResponse } from "./gemini.js";

const ENDPOINT = "https://thaillm.or.th/api/v1/chat/completions";
const DEFAULT_MODEL = "qwen3.6-35b-a3b";

/** "thaillm" เมื่อสั่งให้ใช้ AI สำรอง: env AI_PROVIDER > app_settings(ai_provider) */
export async function useThaiLlm(): Promise<boolean> {
  const env = (process.env.AI_PROVIDER || "").trim().toLowerCase();
  if (env) return env === "thaillm";
  const fromDb = await getAppSetting<string>("ai_provider");
  return String(fromDb ?? "").trim().toLowerCase() === "thaillm";
}

async function thaiLlmModel(): Promise<string> {
  const fromDb = await getAppSetting<string>("thaillm_model");
  return String(fromDb ?? "").trim() || process.env.THAILLM_MODEL || DEFAULT_MODEL;
}

// ── ถอดไฟล์เป็นข้อความ ─────────────────────────────────────────

/** หน้า PDF → ข้อความ (หน้าที่มีตัวอักษร) หรือรูป JPEG (หน้าที่เป็นภาพสแกน) */
type PdfPage = { page: number; text?: string; jpegBase64?: string };

async function pdfPages(bytes: Buffer): Promise<PdfPage[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // verbosity 0 = ไม่พิมพ์คำเตือนเรื่องฟอนต์ ซึ่งไม่กระทบการถอดข้อความ
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const pages: PdfPage[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    type Run = { x: number; y: number; w: number; s: string };
    const runs: Run[] = [];
    for (const it of tc.items as { str?: string; transform?: number[]; width?: number }[]) {
      if (!it.str || !it.transform) continue;
      runs.push({ x: it.transform[4], y: it.transform[5], w: it.width ?? 0, s: it.str });
    }
    // จัดกลุ่มเป็นบรรทัด (y ใกล้กันไม่เกิน 3pt = บรรทัดเดียวกัน)
    runs.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines: Run[][] = [];
    for (const r of runs) {
      const line = lines[lines.length - 1];
      if (line && Math.abs(line[0].y - r.y) <= 3) line.push(r);
      else lines.push([r]);
    }
    const text = lines.map((line) => {
      line.sort((a, b) => a.x - b.x);
      let out = "";
      let end = 0;
      for (const r of line) {
        // ช่องว่างตามระยะห่างจริง — ให้ AI เห็นว่าค่าไหนอยู่คอลัมน์ไหน
        const gap = r.x - end;
        if (out) out += gap > 12 ? " ".repeat(Math.min(Math.round(gap / 5), 30)) : gap > 1 ? " " : "";
        out += r.s;
        end = r.x + r.w;
      }
      return out.trimEnd();
    }).filter((l) => l.trim()).join("\n");

    if (text.replace(/\s/g, "").length >= 30) { pages.push({ page: p, text }); continue; }

    // หน้าภาพสแกน → วาดเป็นรูปให้โมเดลอ่านด้วยตา (Qwen อ่านรูปได้)
    const viewport = page.getViewport({ scale: 1.6 });
    const factory = (doc as unknown as { canvasFactory: { create(w: number, h: number): { canvas: { toBuffer(t: string, q?: number): Buffer }; context: unknown } } }).canvasFactory;
    const { canvas, context } = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvasContext: context, viewport, canvas } as unknown as Parameters<typeof page.render>[0]).promise;
    pages.push({ page: p, jpegBase64: canvas.toBuffer("image/jpeg", 80).toString("base64") });
  }
  return pages;
}

/** Excel → ข้อความแผ่นละตาราง (CSV) — ข้ามแผ่นว่าง */
function excelToText(bytes: Buffer): string {
  const wb = XLSX.read(bytes, { type: "buffer", cellDates: false });
  const out: string[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws || !ws["!ref"]) continue;
    const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false }).replace(/,+$/gm, "");
    if (csv.trim()) out.push(`--- แผ่นงาน "${name}" ---\n${csv}`);
  }
  return out.join("\n\n");
}

type OaPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

async function toOpenAiParts(parts: GeminiPart[], fileNo: { n: number }): Promise<OaPart[]> {
  const out: OaPart[] = [];
  for (const p of parts) {
    if (p.text) { out.push({ type: "text", text: p.text }); continue; }
    if (p.functionResponse) {
      out.push({ type: "text", text: JSON.stringify(p.functionResponse.response) });
      continue;
    }
    const d = p.inlineData;
    if (!d) continue;
    const n = ++fileNo.n;
    const bytes = Buffer.from(d.data, "base64");
    if (d.mimeType.startsWith("image/")) {
      out.push({ type: "text", text: `[ไฟล์แนบที่ ${n}: รูปภาพ]` });
      out.push({ type: "image_url", image_url: { url: `data:${d.mimeType};base64,${d.data}` } });
    } else if (d.mimeType === "application/pdf") {
      for (const pg of await pdfPages(bytes)) {
        if (pg.text) {
          out.push({ type: "text", text: `[ไฟล์แนบที่ ${n}: PDF หน้า ${pg.page} — ข้อความที่ถอดจากไฟล์ จัดวางตามตำแหน่งในหน้า]\n${pg.text}` });
        } else {
          out.push({ type: "text", text: `[ไฟล์แนบที่ ${n}: PDF หน้า ${pg.page} — ภาพสแกน]` });
          out.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${pg.jpegBase64}` } });
        }
      }
    } else if (/spreadsheet|ms-excel|text\/csv/.test(d.mimeType)) {
      const text = d.mimeType === "text/csv" ? bytes.toString("utf-8") : excelToText(bytes);
      out.push({ type: "text", text: `[ไฟล์แนบที่ ${n}: Excel]\n${text}` });
    } else {
      throw new Error(`ไฟล์แนบที่ ${n} (${d.mimeType}) — AI สำรอง (ThaiLLM) อ่านไฟล์ชนิดนี้ไม่ได้ ให้แปลงเป็น PDF หรือ Excel`);
    }
  }
  return out;
}

// ── เรียก API ──────────────────────────────────────────────────

/** รับ/คืนรูปแบบเดียวกับ geminiGenerate — โค้ดส่วนอื่นไม่ต้องรู้ว่าใช้เจ้าไหน */
export async function thaiLlmGenerate(
  systemPrompt: string,
  contents: GeminiContent[],
): Promise<GeminiResponse> {
  const apiKey = process.env.THAILLM_API_KEY || "";
  if (!apiKey) throw new Error("ไม่พบ THAILLM_API_KEY — ตั้งใน .env / Render ก่อนเปิดใช้ AI สำรอง");

  const fileNo = { n: 0 };
  const messages: { role: string; content: string | OaPart[] }[] = [{ role: "system", content: systemPrompt }];
  for (const c of contents) {
    const parts = await toOpenAiParts(c.parts, fileNo);
    if (!parts.length) continue;
    const role = c.role === "model" ? "assistant" : "user";
    // ข้อความล้วน → ส่งเป็น string (บางโมเดลไม่รับ array ในบทบาท assistant)
    const onlyText = parts.every((p) => p.type === "text");
    messages.push({ role, content: onlyText ? parts.map((p) => (p as { text: string }).text).join("\n\n") : parts });
  }

  const think = /^(1|true|on)$/i.test(process.env.THAILLM_THINK || String((await getAppSetting<string>("thaillm_thinking")) ?? ""));
  const body = JSON.stringify({
    model: await thaiLlmModel(),
    messages,
    temperature: 0,
    max_tokens: think ? 14000 : 8192,
    // โหมด "คิดก่อนตอบ": ช้ากว่า แต่คำนวณยอดเงินตามบรีฟได้ดีกว่า (เปิดด้วย THAILLM_THINK=1)
    chat_template_kwargs: { enable_thinking: think },
  });

  let lastCode = 0;
  let lastText = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body,
    });
    lastCode = res.status;
    lastText = await res.text();
    if (res.ok) {
      const j = JSON.parse(lastText) as { choices?: { message?: { content?: string } }[] };
      const text = String(j.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      return { candidates: [{ content: { role: "model", parts: [{ text }] } }] };
    }
    if ((lastCode === 429 || lastCode >= 500) && attempt < 3) {
      console.warn(`[getemail] ThaiLLM ${lastCode} — รอแล้วลองใหม่ (${attempt}/2)`);
      await sleep(2000 * attempt);
      continue;
    }
    break;
  }
  throw new Error(`ThaiLLM HTTP ${lastCode}: ${lastText.slice(0, 500)}`);
}

/** สำหรับไล่บั๊ก: ข้อความที่ AI สำรองจะเห็นจากไฟล์ */
export async function _debugText(parts: GeminiPart[]): Promise<string> {
  const out = await toOpenAiParts(parts, { n: 0 });
  return out.map((p) => (p.type === "text" ? p.text : "[รูปภาพ]")).join("\n");
}
