// ============================================================
//  อ่าน "วันที่" จากไฟล์ Excel ตรง ๆ แล้วส่งให้ AI เป็นค่าตั้งต้น
//
//  ทำไมต้องมี: ลูกค้าเขียนวันที่ในไฟล์ไม่เหมือนกันเลย แม้ในไฟล์เดียวกัน
//    "46175"      = เลขลำดับวันของ Excel (นับจาก 30 ธ.ค. 1899)
//    "7/26/2026"  = เดือน/วัน/ปี
//    "28/8/2026"  = วัน/เดือน/ปี
//    "6/2/2026"   = กำกวม — เป็นได้ทั้ง 6 ก.พ. และ 2 มิ.ย.
//  ปล่อยให้ AI เดาเองแล้วได้ผลไม่คงที่ (ทดสอบไฟล์เดิมซ้ำ ได้คนละค่า)
//  จึงแปลงเองด้วยโค้ดตรงนี้ แล้วบอก AI ไปเลยว่าวันไหนคือวันไหน
// ============================================================
import * as XLSX from "xlsx";

/** ป้ายชื่อช่องวันที่ที่พบในเอกสารลูกค้า → ชื่อที่จะบอก AI */
const DATE_LABELS: [RegExp, string][] = [
  [/loading\s*date/i, "วันโหลดตู้ (Loading date)"],
  [/departure\s*date/i, "วันเรือออก (Departure Date)"],
  [/arrival\s*date/i, "วันเรือถึง (Arrival Date)"],
  [/^date\s*[:：]?\s*$|^date\s*[:：]/i, "วันที่บนเอกสาร (DATE)"],
];

const iso = (d: Date) => d.toISOString().slice(0, 10);
/** เลขลำดับวันของ Excel → วันที่ (ฐานคือ 30 ธ.ค. 1899) */
const fromSerial = (n: number) => new Date(Date.UTC(1899, 11, 30) + n * 86400000);
const isSerial = (n: number) => Number.isFinite(n) && n > 40000 && n < 60000;

/** แปลงข้อความวันที่ — คืนทั้งสองความหมายถ้ากำกวม */
function parseText(s: string): { day: Date; alt: Date | null } | null {
  const m = s.trim().match(/^(\d{1,2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{4})$/);
  if (!m) return null;
  const [a, b, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const mk = (dd: number, mm: number) => new Date(Date.UTC(y, mm - 1, dd));
  if (a > 12 && b <= 12) return { day: mk(a, b), alt: null };   // วัน/เดือน แน่นอน
  if (b > 12 && a <= 12) return { day: mk(b, a), alt: null };   // เดือน/วัน แน่นอน
  if (a <= 12 && b <= 12) return { day: mk(a, b), alt: mk(b, a) }; // กำกวม
  return null;
}

/**
 * หาค่าวันที่ที่คู่กับป้ายชื่อ
 * ⚠ ต้องตรวจว่า "หน้าตาเป็นวันที่" ด้วย ไม่ใช่หยิบช่องถัดไปมาเฉย ๆ
 *   เพราะเอกสารลูกค้าวางป้ายชื่อเรียงกันหลายอันในแถวเดียว
 *   ("Loading date : | Port Of Loading : | Booking Nbr :") แล้วค่าจริงอยู่แถวถัดลงมา
 */
function valueNear(rows: unknown[][], r: number, c: number): unknown {
  const dateish = (v: unknown) => {
    const t = String(v ?? "").trim();
    if (!t) return false;
    const n = Number(t.replace(/,/g, ""));
    return isSerial(n) || parseText(t) !== null;
  };
  const below = rows[r + 1] ?? [];
  const row = rows[r] ?? [];
  for (const v of [below[c], below[c + 1], below[c - 1]]) if (dateish(v)) return v;   // ใต้ป้าย (พบบ่อยสุด)
  for (let i = c + 1; i < row.length; i++) if (dateish(row[i])) return row[i];        // ข้างป้าย
  return null;
}

/**
 * สรุปวันที่ทั้งหมดในไฟล์ Excel เป็นข้อความสั้น ๆ ให้แนบไปกับคำสั่ง AI
 * คืนค่าว่างถ้าไม่ใช่ไฟล์ Excel หรืออ่านไม่ได้ (ไม่ทำให้ flow ล้ม)
 */
export function sheetDateFacts(filename: string, bytes: Buffer): string {
  if (!/\.(xlsx?|xlsm)$/i.test(filename)) return "";
  let wb: XLSX.WorkBook;
  try { wb = XLSX.read(bytes, { type: "buffer" }); } catch { return ""; }

  const found = new Map<string, { date: Date; alt: Date | null; raw: string }>();
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, blankrows: false });
    rows.forEach((row, r) => {
      (row ?? []).forEach((cell, c) => {
        const text = String(cell ?? "").trim();
        if (!text) return;
        const hit = DATE_LABELS.find(([re]) => re.test(text));
        if (!hit) return;
        // ค่าอาจอยู่ในเซลล์เดียวกับป้ายชื่อ เช่น "DATE : 28/8/2026" หรือ "Date : 46175"
        const inline = text.replace(/^[^:：]*[:：]\s*/, "").trim();
        const raw = (inline && inline !== text && (isSerial(Number(inline)) || parseText(inline)))
          ? inline
          : valueNear(rows, r, c);
        if (raw == null) return;
        const n = Number(String(raw).replace(/,/g, ""));
        if (isSerial(n)) {
          if (!found.has(hit[1])) found.set(hit[1], { date: fromSerial(n), alt: null, raw: String(raw) });
          return;
        }
        const p = parseText(String(raw));
        if (p && !found.has(hit[1])) found.set(hit[1], { date: p.day, alt: p.alt, raw: String(raw) });
      });
    });
  }
  if (!found.size) return "";

  // วันที่กำกวม (เช่น 6/2/2026) — เลือกความหมายที่ใกล้ "วันโหลดตู้" ที่สุด
  //   เพราะใบกำกับออกวันเดียวกับหรือใกล้วันโหลดตู้เสมอ
  const anchor = found.get("วันโหลดตู้ (Loading date)")?.date;
  const lines: string[] = [];
  for (const [label, v] of found) {
    let pick = v.date;
    if (v.alt && anchor) {
      const gap = (d: Date) => Math.abs(d.getTime() - anchor.getTime());
      if (gap(v.alt) < gap(v.date)) pick = v.alt;
    }
    const note = v.alt ? `  (ในไฟล์เขียน "${v.raw}" ซึ่งกำกวม เลือกค่านี้เพราะใกล้วันโหลดตู้ที่สุด)` : "";
    lines.push(`  ${label}: ${iso(pick)}${note}`);
  }
  return `ไฟล์ ${filename}\n${lines.join("\n")}`;
}

/** รวมสรุปวันที่ของทุกไฟล์แนบเป็นบล็อกเดียวสำหรับใส่ในคำสั่ง AI */
export function dateFactsBlock(atts: { filename: string; bytes: Buffer }[]): string {
  const parts = atts.map((a) => sheetDateFacts(a.filename, a.bytes)).filter(Boolean);
  if (!parts.length) return "";
  return [
    "[วันที่ที่ระบบอ่านจากไฟล์ Excel ให้แล้ว — ถือเป็นค่าที่ถูกต้อง ห้ามแปลงเอง ห้ามสลับวัน-เดือน]",
    ...parts,
    "ใช้ค่าเหล่านี้ตรง ๆ: invoice_date = วันที่บนเอกสาร · etd = วันเรือออก",
  ].join("\n");
}
