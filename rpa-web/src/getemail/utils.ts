// ============================================================
//  JSON extraction + type coercion — port จาก GAS 10_Utils.gs
// ============================================================

/** strip markdown fence แล้ว parse JSON object (รองรับข้อความเจือปน) */
export function safeParseJson(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  const cleaned = String(raw)
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    /* ลองวิธีถัดไป */
  }
  const jsonStr = extractJsonObject(cleaned);
  if (!jsonStr) return null;
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

/** สแกนหา object JSON ที่วงเล็บปิดสมดุล (ข้าม string/escape) */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  const m = text.match(/\{[\s\S]*\}/);
  return m ? m[0] : null;
}

/** "1,234.56" / "1234.56" / 1234.56 → 1234.56 */
export function toNumber(v: unknown): number {
  if (typeof v === "number") return isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/,/g, "").trim());
    return isFinite(n) ? n : 0;
  }
  return 0;
}

export function toStr(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

/** ปัดทศนิยม n ตำแหน่ง */
export function round(num: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(num * f) / f;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
