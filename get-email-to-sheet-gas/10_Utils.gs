/**
 * Utilities — JSON extraction + type coercion
 * ============================================================
 */

/** strip markdown fence แล้ว parse JSON object (รองรับข้อความเจือปน) */
function safeParseJson_(raw) {
  if (!raw) return null;
  let cleaned = String(raw)
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  // ลอง parse ตรงๆ ก่อน
  try {
    return JSON.parse(cleaned);
  } catch (e) { /* ลองวิธีถัดไป */ }

  // หา balanced { ... } แรก
  const jsonStr = extractJsonObject_(cleaned);
  if (!jsonStr) return null;
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    return null;
  }
}

/** สแกนหา object JSON ที่วงเล็บปิดสมดุล (ข้าม string/escape) */
function extractJsonObject_(text) {
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
  // fallback greedy
  const m = text.match(/\{[\s\S]*\}/);
  return m ? m[0] : null;
}

/** "1,234.56" / "1234.56" / 1234.56 → 1234.56 (Spec edge case #13) */
function toNumber_(v) {
  if (typeof v === "number") return isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/,/g, "").trim());
    return isFinite(n) ? n : 0;
  }
  return 0;
}

function toStr_(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

/** ปัดทศนิยม n ตำแหน่ง */
function round_(num, digits) {
  const f = Math.pow(10, digits);
  return Math.round(num * f) / f;
}
