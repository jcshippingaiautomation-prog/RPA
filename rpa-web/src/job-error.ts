// ============================================================
//  สรุปสาเหตุที่ RPA ไม่สำเร็จ จาก job_logs
//  - ไม่ต้องแก้ engine: parse บรรทัด log + row-status + lifecycle
//  - เป้าหมาย: บอก user ว่า "ติดที่ field/ขั้นตอน/รายการไหน" อ่านง่าย
//    แล้วให้ frontend แสดงสรุป + ปุ่มดู log เต็ม
// ============================================================
import type { JobLogRow } from "./supabase.js";

/** 1 ปัญหาที่ตรวจพบจาก log (อ่านง่าย พร้อมความรุนแรง) */
export interface JobIssue {
  /** "error" = ทำให้ใบล้มเหลว/หยุด, "warn" = กรอกข้าม/ค่าอาจผิดแต่ไม่หยุด */
  level: "error" | "warn";
  /** ข้อความสรุปสั้น ๆ ภาษาคน (เอาไปโชว์ตรง ๆ ได้) */
  text: string;
  /** ตำแหน่งโดยพฤตินัย เช่น "Page 3" / "รายการ 2/3" (ถ้าเดาได้) */
  where?: string;
}

/** ผลสรุป error ของงาน 1 งาน — frontend เอาไปแสดงได้ทันที */
export interface JobErrorSummary {
  /** งานนี้ถือว่าล้มเหลว/มีปัญหาไหม */
  failed: boolean;
  /** พาดหัวสรุป 1 บรรทัด เช่น "ไม่สำเร็จ — รหัสสินค้าไม่อยู่ใน master (รายการ 2)" */
  headline: string;
  /** จุดที่ติดล่าสุด เช่น "Page 3 · รายการ 2/3" (ถ้าเดาได้จาก log) */
  stuckAt?: string;
  /** รายการปัญหาที่ตรวจพบ เรียงตามที่พบ (error ก่อน warn) */
  issues: JobIssue[];
  /** จำนวนรายการสินค้าที่ error (จาก row-status) */
  failedRows: number[];
  /** ข้อความ error ดิบจาก lifecycle run-error (ถ้ามี) */
  rawError?: string;
}

const asLine = (payload: unknown): string => {
  if (payload && typeof payload === "object" && "line" in payload) {
    return String((payload as { line?: unknown }).line ?? "");
  }
  return "";
};

/**
 * จับ "ตำแหน่ง" จากบรรทัด log เช่น
 *   "[RPA] Page 3: goods detail — 3 รายการ" → "Page 3"
 *   "[RPA] • รายการ 2/3: ..."               → "รายการ 2/3"
 */
function detectWhere(line: string): { page?: string; item?: string } {
  const out: { page?: string; item?: string } = {};
  const mPage = line.match(/Page\s*([123])/i);
  if (mPage) out.page = `Page ${mPage[1]}`;
  const mItem = line.match(/รายการ\s*(\d+)\s*\/\s*(\d+)/);
  if (mItem) out.item = `รายการ ${mItem[1]}/${mItem[2]}`;
  return out;
}

/**
 * แปลงบรรทัด log ที่เป็นปัญหา → ข้อความสรุปอ่านง่าย (ตัด prefix/อิโมจิรก ๆ)
 * คืน null ถ้าบรรทัดนี้ไม่ใช่ปัญหา
 *
 * @param inDctkErrorBlock true ถ้าบรรทัดก่อนหน้าเป็น "DCTK แสดง error:" — bullet (•)
 *   ที่ตามมาถือเป็นรายละเอียด error (ไม่ใช่ bullet บอกความคืบหน้าทั่วไป)
 */
function lineToIssue(line: string, inDctkErrorBlock: boolean): JobIssue | null {
  // ตัด prefix [RPA]/[WEB]/[WORKER] ออกเพื่ออ่านง่าย
  const body = line.replace(/^\s*\[(RPA|WEB|WORKER)\]\s*/i, "").trim();
  if (!body) return null;

  // ✗ = error รุนแรง (record fail), ⚠ = เตือน (กรอกข้าม/ค่าอาจผิด)
  const isError = /[✗❌]/.test(body) || /\berror\b/i.test(body);
  const isWarn = /⚠/.test(body);
  const isMaster = /📋/.test(body) || /ไม่อยู่ใน master/.test(body);
  const isModal = /\[MODAL\]/i.test(body) || /DCTK แสดง error/.test(body);
  // bullet (•) เป็นปัญหาก็ต่อเมื่ออยู่ในบล็อก DCTK error เท่านั้น
  //   (บรรทัด "• รายการ i/N: ..." ปกติเป็นแค่ progress — ไม่ใช่ error)
  const isDctkDetail = inDctkErrorBlock && /^•/.test(body);

  if (!isError && !isWarn && !isMaster && !isModal && !isDctkDetail) return null;

  // ทำความสะอาดข้อความ: ตัดอิโมจินำหน้า
  const text = body.replace(/^[✗❌⚠📋↪•\s]+/, "").trim();
  if (!text) return null;

  const level: JobIssue["level"] = isError || isMaster || isModal || isDctkDetail ? "error" : "warn";
  return { level, text };
}

/** บรรทัดนี้เปิดบล็อก "DCTK แสดง error:" หรือไม่ (bullet ถัดไปคือรายละเอียด error) */
function opensDctkErrorBlock(line: string): boolean {
  return /DCTK แสดง error/.test(line) || /\[MODAL\]/i.test(line);
}

/**
 * อ่าน job_logs ของงาน 1 งาน → สรุปสาเหตุที่ไม่สำเร็จแบบอ่านง่าย
 * (logs ควรเรียงตาม id ascending แล้ว — getJobLogs ทำให้แล้ว)
 */
export function summarizeJobError(logs: JobLogRow[]): JobErrorSummary {
  const issues: JobIssue[] = [];
  const failedRows = new Set<number>();
  let rawError: string | undefined;
  let lastPage: string | undefined;
  let lastItem: string | undefined;
  let sawRunError = false;
  let inDctkErrorBlock = false;   // อยู่ในบล็อก "DCTK แสดง error:" ที่ตามด้วย bullet

  for (const row of logs) {
    const p = row.payload as Record<string, unknown> | null;

    if (row.kind === "log") {
      const line = asLine(p);
      if (!line) continue;
      // ติดตามตำแหน่งล่าสุด (Page / รายการ) เพื่อบอกจุดที่ติด
      const w = detectWhere(line);
      if (w.page) lastPage = w.page;
      if (w.item) lastItem = w.item;
      // เก็บบรรทัดที่เป็นปัญหา
      const issue = lineToIssue(line, inDctkErrorBlock);
      // อัปเดต context บล็อก DCTK error: เปิดเมื่อเจอหัวข้อ, ปิดเมื่อเจอบรรทัดที่ไม่ใช่ bullet
      if (opensDctkErrorBlock(line)) inDctkErrorBlock = true;
      else if (!/^\s*\[(RPA|WEB|WORKER)\]\s*•/.test(line) && !/^\s*•/.test(line)) inDctkErrorBlock = false;
      if (issue) {
        if (lastPage || lastItem) {
          issue.where = [lastPage, lastItem].filter(Boolean).join(" · ");
        }
        issues.push(issue);
      }
    } else if (row.kind === "row-status") {
      const rs = p as { index?: number; status?: string; error?: string } | null;
      if (rs && rs.status === "error" && typeof rs.index === "number") {
        failedRows.add(rs.index);
        if (rs.error) {
          // index = ลำดับใบ/แถวงาน (ไม่ใช่เลขรายการสินค้า) — ถ้ามีใบเดียวไม่ต้องเติม prefix
          const prefix = rs.index > 1 ? `ใบที่ ${rs.index}: ` : "";
          issues.push({
            level: "error",
            text: `${prefix}${rs.error}`,
            where: lastPage,
          });
        }
      }
    } else if (row.kind === "lifecycle") {
      const ev = String((p as { event?: string })?.event ?? "");
      if (ev === "run-error") {
        sawRunError = true;
        rawError = String((p as { error?: string })?.error ?? "").trim() || rawError;
      }
    }
  }

  // ตัด issue ซ้ำ — normalize ก่อนเทียบ: ตัด prefix เชิงเทคนิค (Record N error:, ใบที่ N:)
  //   และ normalize ช่องว่าง/เครื่องหมาย เพื่อให้บรรทัดที่สื่อความเดียวกันถูกยุบเป็นอันเดียว
  const normalize = (t: string) =>
    t.replace(/^(Record\s*\d+\s*error|ใบที่\s*\d+)\s*[:：]?\s*/i, "")
      .replace(/\s+/g, " ")
      .replace(/[:：]\s*$/, "")
      .trim()
      .toLowerCase();
  const seen = new Set<string>();
  const uniqueIssues = issues.filter((it) => {
    const norm = normalize(it.text);
    // ข้ามถ้า normalize แล้วว่าง (เช่นเหลือแต่ prefix)
    const key = it.level + "|" + (norm || it.text);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // error ขึ้นก่อน warn (เสถียร — preserve ลำดับเดิมภายในกลุ่ม)
  uniqueIssues.sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1));

  const errorIssues = uniqueIssues.filter((i) => i.level === "error");
  const failed = sawRunError || failedRows.size > 0 || errorIssues.length > 0;

  const stuckAt = [lastPage, lastItem].filter(Boolean).join(" · ") || undefined;

  // พาดหัว: เลือก error ที่เป็น "เนื้อหาจริง" — ข้ามบรรทัดหัวข้อ (ลงท้าย ":")
  //   เช่น "DCTK แสดง error:" เป็น meta → ใช้รายละเอียดถัดไปแทน
  //   แล้วตัด prefix เชิงเทคนิค ("Record N error:", "ใบที่ N:") เพื่อให้อ่านง่าย
  const cleanHeadline = (t: string) =>
    t.replace(/^(Record\s*\d+\s*error)\s*[:：]\s*/i, "").trim();
  let headline: string;
  if (!failed) {
    headline = "ไม่พบข้อผิดพลาด";
  } else if (errorIssues.length) {
    const meaningful = errorIssues.find((i) => !/:\s*$/.test(i.text)) || errorIssues[0];
    const text = cleanHeadline(meaningful.text);
    headline = meaningful.where ? `${text} (${meaningful.where})` : text;
  } else if (rawError) {
    headline = rawError.length > 120 ? rawError.slice(0, 120) + "…" : rawError;
  } else {
    headline = "RPA ไม่สำเร็จ — ดู log เพื่อหาสาเหตุ";
  }

  return {
    failed,
    headline,
    stuckAt,
    issues: uniqueIssues,
    failedRows: [...failedRows].sort((a, b) => a - b),
    rawError,
  };
}

/** ดึงเฉพาะข้อความ log (kind=log) เป็น array ของ string สำหรับโชว์ log เต็ม */
export function extractLogLines(logs: JobLogRow[]): string[] {
  const out: string[] = [];
  for (const row of logs) {
    if (row.kind === "log") {
      const line = asLine(row.payload);
      if (line) out.push(line);
    } else if (row.kind === "lifecycle") {
      const p = row.payload as { event?: string; error?: string };
      if (p?.event === "run-error" && p.error) out.push(`✗ ${p.error}`);
    } else if (row.kind === "row-status") {
      const rs = row.payload as { index?: number; status?: string; error?: string };
      if (rs?.status === "error" && rs.error) {
        out.push(`✗ รายการที่ ${rs.index}: ${rs.error}`);
      }
    }
  }
  return out;
}
