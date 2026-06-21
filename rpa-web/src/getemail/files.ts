// ============================================================
//  เตรียมไฟล์แนบให้ Gemini — port จาก GAS 05_Files.gs
//  - PDF / รูป: ส่ง Gemini ตรง ๆ
//  - Office (xlsx/docx): ลองส่งดิบให้ Gemini ก่อน, ถ้าไม่ได้เรียก API แปลง→PDF
//  - อื่น ๆ: ข้าม
// ============================================================
import { exec } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import type { InlineFile } from "./gemini.js";

/** หา binary LibreOffice (soffice) — รองรับ mac/linux/env override */
function sofficeBin(): string {
  const env = (process.env.SOFFICE_BIN ?? "").trim();
  if (env) return env;
  if (process.platform === "darwin") return "/Applications/LibreOffice.app/Contents/MacOS/soffice";
  return "soffice"; // linux (VM) — อยู่ใน PATH
}

/** แปลง Office → PDF ด้วย LibreOffice (soffice headless) — คืน null ถ้าไม่มี/ล้มเหลว */
async function officeToPdfLibre(bytes: Buffer, filename: string): Promise<Buffer | null> {
  let dir = "";
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), "getemail-"));
    const inPath = path.join(dir, filename);
    await writeFile(inPath, bytes);
    const bin = sofficeBin();
    await new Promise<void>((resolve, reject) => {
      exec(
        `"${bin}" --headless --norestore --convert-to pdf --outdir "${dir}" "${inPath}"`,
        { timeout: 60000 },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    // หาไฟล์ .pdf ที่สร้าง
    const files = await readdir(dir);
    const pdf = files.find((f) => f.toLowerCase().endsWith(".pdf"));
    if (!pdf) return null;
    return await readFile(path.join(dir, pdf));
  } catch (e) {
    console.warn("[getemail] LibreOffice แปลงไม่สำเร็จ:", e instanceof Error ? e.message : e);
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface RawAttachment {
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

type Kind = "pdf" | "image" | "office" | "unknown";

/** จำแนกชนิดไฟล์จากนามสกุล + MIME */
export function classifyAttachment(name: string, mime: string): Kind {
  const n = name.toLowerCase();
  const m = mime.toLowerCase();
  if (n.match(/\.pdf$/) || m === "application/pdf") return "pdf";
  if (n.match(/\.(png|jpe?g|webp|gif|bmp|tiff?)$/) || m.indexOf("image/") === 0) return "image";
  if (
    n.match(/\.(docx?|xlsx?|pptx?|csv|odt|ods)$/) ||
    m.indexOf("word") !== -1 ||
    m.indexOf("excel") !== -1 ||
    m.indexOf("spreadsheet") !== -1 ||
    m.indexOf("officedocument") !== -1 ||
    m.indexOf("opendocument") !== -1
  )
    return "office";
  return "unknown";
}

function normalizeImageMime(name: string, mime: string): string {
  const m = mime.toLowerCase();
  if (m.indexOf("image/") === 0) return m;
  const n = name.toLowerCase();
  if (n.match(/\.png$/)) return "image/png";
  if (n.match(/\.jpe?g$/)) return "image/jpeg";
  if (n.match(/\.webp$/)) return "image/webp";
  return "image/jpeg";
}

function toInline(bytes: Buffer, mimeType: string): InlineFile {
  return { mimeType, bytesBase64: bytes.toString("base64") };
}

/** MIME ของ Office (สำหรับส่งดิบให้ Gemini ลองอ่าน) */
function officeMime(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (n.endsWith(".xls")) return "application/vnd.ms-excel";
  if (n.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (n.endsWith(".doc")) return "application/msword";
  if (n.endsWith(".csv")) return "text/csv";
  return "application/octet-stream";
}

/**
 * แปลง Office → PDF — ลอง LibreOffice (soffice) ก่อน, ถ้าไม่มีค่อย fallback API ภายนอก
 * คืน null ถ้าแปลงไม่ได้ทั้งคู่
 */
export async function officeToPdf(bytes: Buffer, filename: string): Promise<Buffer | null> {
  // 1) LibreOffice (ฟรี, บน worker VM)
  const viaLibre = await officeToPdfLibre(bytes, filename);
  if (viaLibre) return viaLibre;
  // 2) fallback: API ภายนอก (ถ้าตั้งค่าไว้)
  if (!config.fileConvert.enabled) return null;
  try {
    const form = new FormData();
    const blob = new Blob([bytes], { type: officeMime(filename) });
    form.append("file", blob, filename);
    const headers: Record<string, string> = {};
    if (config.fileConvert.apiKey) headers["Authorization"] = "Bearer " + config.fileConvert.apiKey;
    const res = await fetch(config.fileConvert.apiUrl, {
      method: "POST",
      headers,
      body: form,
    });
    if (!res.ok) {
      console.warn(`[getemail] officeToPdf HTTP ${res.status}`);
      return null;
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch (e) {
    console.error("[getemail] officeToPdf error:", e);
    return null;
  }
}

/**
 * เตรียม attachments ทั้งหมด → InlineFile[] สำหรับ Gemini
 * Office: ลองส่งดิบก่อน (opportunistic) ถ้าไม่มั่นใจ → แปลง PDF
 */
export async function prepareFilesForAI(
  attachments: RawAttachment[],
  log: (msg: string) => void = () => {},
): Promise<InlineFile[]> {
  const out: InlineFile[] = [];
  for (const att of attachments) {
    const name = att.filename || "";
    const kind = classifyAttachment(name, att.mimeType);

    if (kind === "pdf") {
      out.push(toInline(att.bytes, "application/pdf"));
      continue;
    }
    if (kind === "image") {
      out.push(toInline(att.bytes, normalizeImageMime(name, att.mimeType)));
      continue;
    }
    if (kind === "office") {
      // 1) ลองแปลงเป็น PDF ก่อน (วิธีหลัก — เชื่อถือได้กว่าส่ง xlsx ดิบ)
      const pdf = await officeToPdf(att.bytes, name);
      if (pdf) {
        out.push(toInline(pdf, "application/pdf"));
        log(`แปลง Office→PDF: ${name}`);
        continue;
      }
      // 2) fallback: ส่งดิบให้ Gemini ลองอ่าน (อาจอ่าน docx ได้บางกรณี)
      log(`⚠ แปลง Office→PDF ไม่ได้ (ไม่ได้ตั้ง FILE_CONVERT_API_URL?) — ส่งไฟล์ดิบให้ AI: ${name}`);
      out.push(toInline(att.bytes, officeMime(name)));
      continue;
    }
    log(`⚠ ไฟล์แนบไม่รองรับ ข้าม: ${name} (${att.mimeType})`);
  }
  return out;
}
