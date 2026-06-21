// ============================================================
//  Email + capture-PDF building
//  (ported 1:1 from rpa_import.py)
// ============================================================
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import { PDFDocument } from "pdf-lib";
import { log } from "./helpers.js";
import type { AppConfig, Record } from "./types.js";

const EMAIL_BODY_EXCLUDE_COLS = new Set([
  "สถานะการสร้างเอกสาร",
  "สถานะการบันทึกข้อมูลลงระบบ",
  "ชื่อผู้ตรวจสอบ",
  "สถานะการอนุมัติ",
  "สถานะต้องแก้ไข",
  "สถานะการส่งข้อมูลให้ลูกค้า",
]);

/** สร้าง body แบบ key: value ของทุกคอลัมน์ (Python _build_email_body) */
function buildEmailBody(record: Record): string {
  const raw = record.__raw_row__ ?? {};
  if (Object.keys(raw).length === 0) return "ไม่พบข้อมูลแถวนี้";

  const lines = ["รายการข้อมูลที่บันทึก:", ""];
  for (const [col, val] of Object.entries(raw)) {
    if (EMAIL_BODY_EXCLUDE_COLS.has(col.trim())) continue;
    lines.push(`${col}: ${val}`);
  }
  return lines.join("\n");
}

/** รวม screenshots เป็น PDF เดียว Capture_<customer>.pdf (Python _build_capture_pdf) */
export async function buildCapturePdf(record: Record): Promise<string | null> {
  const shots = record.__screenshot_paths__ ?? [];
  if (shots.length === 0) return null;

  const customer = String(record.company_search ?? "unknown");
  const safe = customer.replace(/[^A-Za-z0-9_\-]+/g, "_").slice(0, 60);
  const out = path.join(record.__download_dir__ as string, `Capture_${safe}.pdf`);

  const pdf = await PDFDocument.create();
  for (const shotPath of shots) {
    const bytes = await readFile(shotPath);
    // screenshots เป็น PNG (Python ใช้ Pillow; ที่นี่ฝัง PNG ตรงๆ)
    const img = await pdf.embedPng(bytes);
    const pageDoc = pdf.addPage([img.width, img.height]);
    pageDoc.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
  const { writeFile } = await import("node:fs/promises");
  await writeFile(out, await pdf.save());
  log(`  📄 สร้าง capture PDF: ${path.basename(out)} (${shots.length} หน้า)`);
  return out;
}

/** ส่งอีเมลพร้อม PDF (Python send_email_with_pdf) */
export async function sendEmailWithPdf(
  pdfPath: string,
  cfg: AppConfig,
  record: Record,
): Promise<void> {
  const e = cfg.email;
  if (!e || !e.enabled) {
    log("email: disabled — ข้ามการส่ง");
    return;
  }

  const attachments: { filename: string; content: Buffer; contentType: string }[] =
    [];

  // แนบ PDF จากระบบ
  attachments.push({
    filename: path.basename(pdfPath),
    content: await readFile(pdfPath),
    contentType: "application/pdf",
  });

  // แนบ Capture_<customer>.pdf ถ้าลูกค้าขอ screenshots
  const capturePdf = await buildCapturePdf(record);
  if (capturePdf && existsSync(capturePdf)) {
    attachments.push({
      filename: path.basename(capturePdf),
      content: await readFile(capturePdf),
      contentType: "application/pdf",
    });
  }

  log(`email → ${e.recipient}`);
  const transporter = nodemailer.createTransport({
    host: e.smtp_host,
    port: e.smtp_port,
    secure: false, // STARTTLS บน port 587
    auth: { user: e.sender, pass: e.app_password },
  });

  await transporter.sendMail({
    from: e.sender,
    to: e.recipient,
    subject: e.subject ?? "แจ้งบันทึกข้อมูลในระบบ IXMPLE",
    text: buildEmailBody(record),
    attachments,
  });
  log("  ✓ ส่งอีเมลแล้ว");
}
