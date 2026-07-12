// ============================================================
//  Worker-side Supabase data helpers — uploadDocument + customer settings
//  (มินิมอล mirror จาก rpa-web/src/supabase.ts; worker import ตรงไม่ได้)
// ============================================================
import { readFile } from "node:fs/promises";
import path from "node:path";
import { workerSupabase } from "./queue.js";
import { config } from "./config.js";

export interface CustomerSetting {
  customer_name: string;
  allowed_fields: string[];
  presets: { [field: string]: string };
  request_screenshot?: boolean;
}

/** อ่าน customer settings ทั้งหมด (สำหรับ build overrides เหมือน server.ts) */
export async function listCustomerSettings(): Promise<CustomerSetting[]> {
  try {
    const { data, error } = await workerSupabase()
      .from("customer_settings")
      .select("customer_name, allowed_fields, presets, request_screenshot");
    if (error) throw error;
    return (data ?? []).map((r) => ({
      customer_name: r.customer_name,
      allowed_fields: r.allowed_fields ?? [],
      presets: r.presets ?? {},
      request_screenshot: r.request_screenshot ?? false,
    }));
  } catch (err) {
    console.error("[worker] listCustomerSettings error:", err);
    return [];
  }
}

/** อัป PDF → Storage + insert documents (mirror rpa-web uploadDocument) */
export async function uploadDocument(
  filePath: string,
  meta: { customer?: string | null; invoice?: string | null; kind: string; declarationId?: string | null },
): Promise<{ filename: string } | null> {
  try {
    const sb = workerSupabase();
    const filename = path.basename(filePath);
    const bytes = await readFile(filePath);
    const d = new Date();
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const storagePath = `${meta.kind}/${ym}/${Date.now()}_${filename}`;
    // content type ตามนามสกุล (PDF ใบขน / PNG screenshot)
    const lower = filename.toLowerCase();
    const contentType = lower.endsWith(".png") ? "image/png"
      : lower.endsWith(".jpg") || lower.endsWith(".jpeg") ? "image/jpeg"
      : "application/pdf";

    const up = await sb.storage
      .from(config.supabase.bucket)
      .upload(storagePath, bytes, { contentType, upsert: false });
    if (up.error) throw up.error;

    const { data: pub } = sb.storage.from(config.supabase.bucket).getPublicUrl(storagePath);
    const record: Record<string, unknown> = {
      customer: meta.customer ?? null,
      invoice: meta.invoice ?? null,
      kind: meta.kind,
      filename,
      storage_path: storagePath,
      public_url: pub?.publicUrl ?? null,
      declaration_id: meta.declarationId ?? null, // ผูกไฟล์กับใบเจาะจง (กันไฟล์ปนใบ invoice ซ้ำ)
    };
    let ins = await sb.from("documents").insert(record).select().single();
    if (ins.error) {
      // คอลัมน์ declaration_id ยังไม่มี (ยังไม่รัน sql/09) → ลองใหม่โดยตัดคอลัมน์นั้นออก (กัน upload พัง)
      const { declaration_id, ...legacy } = record;
      ins = await sb.from("documents").insert(legacy).select().single();
      if (ins.error) throw ins.error;
    }
    return { filename };
  } catch (err) {
    console.error("[worker] uploadDocument error:", err);
    return null;
  }
}

/**
 * อัปเดตสถานะ declaration ตรง ๆ จาก worker (ไม่พึ่งเว็บ bridge ที่หลับบน Render free).
 * worker รันบน VM ตลอด → อัปเดตเชื่อถือได้กว่า. (เว็บ bridge ยังทำงานคู่ขนานได้ ไม่ชน)
 */
export async function setDeclarationStatus(
  declId: string,
  fields: { status?: string; declaration_no?: string; status_message?: string },
): Promise<void> {
  if (!declId) return;
  try {
    const { error } = await workerSupabase().from("declarations").update(fields).eq("id", declId);
    if (error) throw error;
  } catch (err) {
    console.error("[worker] setDeclarationStatus error:", err);
  }
}
