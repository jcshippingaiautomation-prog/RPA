// ============================================================
//  Supabase — เก็บ/ดึงเอกสาร PDF ที่ RPA สร้าง
//  ถ้าไม่ได้ตั้งค่า key จะ disabled แบบ graceful (ไม่ throw)
// ============================================================
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config.js";

export interface DocumentRecord {
  id?: string;
  customer: string | null;
  invoice: string | null;
  kind: string; // 'declaration' | 'capture'
  filename: string;
  storage_path: string;
  public_url: string | null;
  created_at?: string;
}

let client: SupabaseClient | null = null;
function getClient(): SupabaseClient | null {
  if (!config.supabase.enabled) return null;
  if (!client) {
    client = createClient(config.supabase.url, config.supabase.serviceKey, {
      auth: { persistSession: false },
    });
  }
  return client;
}

export function supabaseEnabled(): boolean {
  return config.supabase.enabled;
}

/** อ่านค่า global config (app_config) ตาม key — คืน null ถ้าไม่มี/ปิด Supabase */
export async function getAppConfig<T = unknown>(key: string): Promise<T | null> {
  const sb = getClient();
  if (!sb) return null;
  try {
    const { data, error } = await sb.from("app_config").select("value").eq("key", key).maybeSingle();
    if (error) throw error;
    return (data?.value ?? null) as T | null;
  } catch (err) {
    console.error("[web] getAppConfig error:", err);
    return null;
  }
}

/** เขียนค่า global config (upsert) */
export async function setAppConfig(key: string, value: unknown): Promise<boolean> {
  const sb = getClient();
  if (!sb) return false;
  try {
    const { error } = await sb.from("app_config")
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) throw error;
    return true;
  } catch (err) {
    console.error("[web] setAppConfig error:", err);
    return false;
  }
}

/** ดึงข้อความ error ที่อ่านง่ายจาก error object ของ Supabase */
function errMsg(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { message?: string; error?: string; hint?: string; code?: string };
    return e.message || e.error || e.hint || e.code || JSON.stringify(err);
  }
  return String(err);
}

/**
 * อัป PDF จาก path ในเครื่อง → Supabase Storage + บันทึก metadata
 * คืน record (หรือ null ถ้า disabled/ล้มเหลว — ไม่ throw เพื่อไม่ให้ RPA ล่ม)
 */
export async function uploadDocument(
  filePath: string,
  meta: { customer?: string | null; invoice?: string | null; kind: string },
): Promise<DocumentRecord | null> {
  const sb = getClient();
  if (!sb) return null;

  try {
    const filename = path.basename(filePath);
    const bytes = await readFile(filePath);
    // วาง path เป็น <kind>/<yyyy-mm>/<filename> กันชื่อชนกัน
    const d = new Date();
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const storagePath = `${meta.kind}/${ym}/${Date.now()}_${filename}`;

    const up = await sb.storage
      .from(config.supabase.bucket)
      .upload(storagePath, bytes, {
        contentType: "application/pdf",
        upsert: false,
      });
    if (up.error) throw up.error;

    const { data: pub } = sb.storage
      .from(config.supabase.bucket)
      .getPublicUrl(storagePath);

    const record: DocumentRecord = {
      customer: meta.customer ?? null,
      invoice: meta.invoice ?? null,
      kind: meta.kind,
      filename,
      storage_path: storagePath,
      public_url: pub?.publicUrl ?? null,
    };

    const ins = await sb.from("documents").insert(record).select().single();
    if (ins.error) throw ins.error;
    return ins.data as DocumentRecord;
  } catch (err) {
    console.error("[supabase] uploadDocument error:", errMsg(err));
    return null;
  }
}

/**
 * อัปไฟล์จาก Buffer (ไม่ใช่ path) → Storage + insert documents
 * ใช้สำหรับไฟล์แนบอีเมล (Get Email) ที่อยู่ในหน่วยความจำ
 */
export async function uploadBytes(
  bytes: Buffer | Uint8Array,
  filename: string,
  meta: { customer?: string | null; invoice?: string | null; kind: string },
): Promise<DocumentRecord | null> {
  const sb = getClient();
  if (!sb) return null;
  try {
    const lower = filename.toLowerCase();
    const ct = lower.endsWith(".pdf") ? "application/pdf"
      : lower.endsWith(".png") ? "image/png"
      : lower.match(/\.jpe?g$/) ? "image/jpeg"
      : lower.endsWith(".xlsx") ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : lower.endsWith(".xls") ? "application/vnd.ms-excel"
      : lower.endsWith(".docx") ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/octet-stream";
    const d = new Date();
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const storagePath = `${meta.kind}/${ym}/${Date.now()}_${filename}`;
    const up = await sb.storage.from(config.supabase.bucket).upload(storagePath, bytes, { contentType: ct, upsert: false });
    if (up.error) throw up.error;
    const { data: pub } = sb.storage.from(config.supabase.bucket).getPublicUrl(storagePath);
    const record: DocumentRecord = {
      customer: meta.customer ?? null, invoice: meta.invoice ?? null, kind: meta.kind,
      filename, storage_path: storagePath, public_url: pub?.publicUrl ?? null,
    };
    const ins = await sb.from("documents").insert(record).select().single();
    if (ins.error) throw ins.error;
    return ins.data as DocumentRecord;
  } catch (err) {
    console.error("[supabase] uploadBytes error:", errMsg(err));
    return null;
  }
}

/** list เอกสารของ declaration (จับคู่ด้วย customer+invoice) */
export async function listDocumentsFor(
  customer: string,
  invoice: string,
  declId?: string,
): Promise<DocumentRecord[]> {
  const sb = getClient();
  if (!sb) return [];
  try {
    // ผูกไฟล์กับใบเจาะจง (declaration_id) — ดึงเฉพาะไฟล์ของใบนี้ กันไฟล์ปนใบ invoice ซ้ำ
    if (declId) {
      try {
        const { data, error } = await sb.from("documents").select("*")
          .eq("declaration_id", declId).order("created_at", { ascending: false });
        if (error) throw error;
        // ถ้ามีไฟล์ผูก declaration_id แล้ว (ใบที่รันหลัง migration) → คืนเฉพาะของใบนี้
        if (data && data.length) return data as DocumentRecord[];
        // ไม่มี → ใบเก่าที่ยังไม่ผูก id → fallback ไป customer+invoice (พฤติกรรมเดิม)
      } catch (e) {
        // คอลัมน์ declaration_id ยังไม่มี (ยังไม่รัน sql/09) → fallback ไป customer+invoice
        console.error("[supabase] declaration_id query fallback:", errMsg(e));
      }
    }
    let q = sb.from("documents").select("*").order("created_at", { ascending: false });
    if (customer) q = q.eq("customer", customer);
    if (invoice) q = q.eq("invoice", invoice);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as DocumentRecord[];
  } catch (err) {
    console.error("[supabase] listDocumentsFor error:", errMsg(err));
    return [];
  }
}

/** list เอกสารล่าสุด (ใหม่สุดก่อน) */
export async function listDocuments(limit = 100): Promise<DocumentRecord[]> {
  const sb = getClient();
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from("documents")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []) as DocumentRecord[];
  } catch (err) {
    console.error("[supabase] listDocuments error:", errMsg(err));
    return [];
  }
}

// ============================================================
//  Field rules — ลูกค้ารายไหนต้องกรอก field ไหนบ้าง
// ============================================================

/** รายชื่อ field ทั้งหมดที่ติ๊กได้ (ตรงกับ mapping ใน rpa-import-node) */
export const RULE_FIELDS: { key: string; label: string }[] = [
  { key: "customer_name", label: "ชื่อลูกค้า (buyer search)" },
  { key: "consignee_name", label: "Consignee" },
  { key: "buyer_country_code", label: "ประเทศผู้ซื้อ" },
  { key: "destination_country_code", label: "ประเทศปลายทาง" },
  { key: "vessel_name", label: "ชื่อเรือ" },
  { key: "voyage_number", label: "เที่ยวเรือ" },
  { key: "release_port_code", label: "ท่าตรวจปล่อย" },
  { key: "loading_port_code", label: "ท่ารับบรรทุก" },
  { key: "shipping_mark", label: "Shipping mark" },
  { key: "tax_payment_method_code", label: "วิธีชำระภาษี" },
  { key: "etd", label: "ETD" },
  { key: "invoice_number", label: "เลขที่ Invoice" },
  { key: "invoice_date", label: "วันที่ Invoice" },
  { key: "incoterms", label: "Incoterms" },
  { key: "currency", label: "สกุลเงิน" },
  { key: "total_goods_amount", label: "มูลค่าสินค้า" },
  { key: "freight_charge", label: "ค่าระวาง" },
  { key: "insurance_charge", label: "ค่าประกัน" },
  { key: "net_weight_kg", label: "น้ำหนักสุทธิ (kg)" },
  { key: "gross_weight_kg", label: "น้ำหนักรวม (kg)" },
  { key: "description_eng", label: "รายละเอียดสินค้า" },
  { key: "net_weight_ton", label: "น้ำหนักสุทธิ (ton)" },
  { key: "net_weight_unit_code", label: "หน่วยน้ำหนัก" },
  { key: "container_or_volume_qty", label: "จำนวน/ปริมาณตู้" },
  { key: "container_unit_code", label: "หน่วยตู้" },
  { key: "customs_unit_code", label: "หน่วยปริมาณในใบขน (หลังพิกัด เช่น C62)" },
  { key: "freight_alloc", label: "วิธีลงค่าระวาง/รายการ (zero|first|each)" },
  // ช่อง Page 1 เพิ่มเติม
  { key: "transport_mode", label: "วิธีขนส่ง (Page 1)" },
  { key: "mawb", label: "MAWB (Page 1)" },
  { key: "hawb", label: "HAWB/BL (Page 1)" },
  { key: "reference_no", label: "เลขอ้างอิงในการขนส่ง (Page 1)" },
  { key: "exdec_doc_type", label: "ชนิดเอกสารใบขนขาออก (Page 1)" },
];

export interface CustomerSetting {
  customer_name: string;
  allowed_fields: string[];
  presets: { [field: string]: string };
  extraction_rules?: string;
  request_screenshot?: boolean;
}

/** อ่าน customer settings ทั้งหมด (allowed_fields + presets + extraction_rules) */
export async function listCustomerSettings(): Promise<CustomerSetting[]> {
  const sb = getClient();
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from("customer_settings")
      .select("customer_name, allowed_fields, presets, extraction_rules, request_screenshot")
      .order("customer_name", { ascending: true });
    if (error) throw error;
    return (data ?? []).map((r) => ({
      customer_name: r.customer_name,
      allowed_fields: r.allowed_fields ?? [],
      presets: r.presets ?? {},
      extraction_rules: r.extraction_rules ?? "",
      request_screenshot: r.request_screenshot ?? false,
    })) as CustomerSetting[];
  } catch (err) {
    console.error("[supabase] listCustomerSettings error:", errMsg(err));
    return [];
  }
}

/** บันทึก (upsert) setting ของลูกค้า 1 ราย */
export async function upsertCustomerSetting(s: CustomerSetting): Promise<boolean> {
  const sb = getClient();
  if (!sb) return false;
  try {
    const row: Record<string, unknown> = {
      customer_name: s.customer_name.trim(),
      allowed_fields: s.allowed_fields,
      presets: s.presets ?? {},
      updated_at: new Date().toISOString(),
    };
    // อัปเดต extraction_rules เฉพาะเมื่อส่งมา (กันเขียนทับด้วยค่าว่างโดยไม่ตั้งใจ)
    if (s.extraction_rules !== undefined) row.extraction_rules = s.extraction_rules;
    if (s.request_screenshot !== undefined) row.request_screenshot = s.request_screenshot;
    const { error } = await sb
      .from("customer_settings")
      .upsert(row, { onConflict: "customer_name" });
    if (error) throw error;
    return true;
  } catch (err) {
    console.error("[supabase] upsertCustomerSetting error:", errMsg(err));
    return false;
  }
}

/** ลบ setting ของลูกค้า */
export async function deleteCustomerSetting(customerName: string): Promise<boolean> {
  const sb = getClient();
  if (!sb) return false;
  try {
    const { error } = await sb
      .from("customer_settings")
      .delete()
      .eq("customer_name", customerName);
    if (error) throw error;
    return true;
  } catch (err) {
    console.error("[supabase] deleteCustomerSetting error:", errMsg(err));
    return false;
  }
}

/**
 * ดึง extraction_rules ของลูกค้า (สำหรับ tool Get_Customer_Rules ใน Get Email)
 * จับคู่ customer_name แบบ contains สองทาง (เหมือน GAS lookupCustomerByKeyword)
 * คืน { customer_name, extraction_rules } หรือ null
 */
export async function getExtractionRulesByKeyword(
  keyword: string,
): Promise<{ customer_name: string; extraction_rules: string } | null> {
  const sb = getClient();
  if (!sb || !keyword) return null;
  try {
    const { data, error } = await sb
      .from("customer_settings")
      .select("customer_name, extraction_rules");
    if (error) throw error;
    const kw = keyword.trim().toUpperCase();
    for (const row of data ?? []) {
      const cn = String(row.customer_name || "").trim().toUpperCase();
      if (cn && (cn === kw || cn.includes(kw) || kw.includes(cn))) {
        return {
          customer_name: row.customer_name,
          extraction_rules: row.extraction_rules || "",
        };
      }
    }
    return null;
  } catch (err) {
    console.error("[supabase] getExtractionRulesByKeyword error:", errMsg(err));
    return null;
  }
}

// ============================================================
//  App settings — key/value JSON store (เช่น schedule config)
// ============================================================
export async function getAppSetting<T = unknown>(key: string): Promise<T | null> {
  const sb = getClient();
  if (!sb) return null;
  try {
    const { data, error } = await sb
      .from("app_settings")
      .select("value")
      .eq("key", key)
      .maybeSingle();
    if (error) throw error;
    return (data?.value ?? null) as T | null;
  } catch (err) {
    console.error("[supabase] getAppSetting error:", errMsg(err));
    return null;
  }
}

export async function setAppSetting(key: string, value: unknown): Promise<boolean> {
  const sb = getClient();
  if (!sb) return false;
  try {
    const { error } = await sb
      .from("app_settings")
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) throw error;
    return true;
  } catch (err) {
    console.error("[supabase] setAppSetting error:", errMsg(err));
    return false;
  }
}

// ============================================================
//  Email rules — กรองอีเมล Get Email (sender + subject keyword)
// ============================================================
export interface EmailRule {
  sender: string;
  subject: string;
  note?: string;
}

export async function listEmailRules(): Promise<EmailRule[]> {
  const sb = getClient();
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from("email_rules")
      .select("sender, subject, note")
      .order("sender", { ascending: true });
    if (error) throw error;
    return (data ?? []) as EmailRule[];
  } catch (err) {
    console.error("[supabase] listEmailRules error:", errMsg(err));
    return [];
  }
}

export async function upsertEmailRule(r: EmailRule): Promise<boolean> {
  const sb = getClient();
  if (!sb) return false;
  try {
    const { error } = await sb.from("email_rules").upsert(
      { sender: r.sender.trim(), subject: r.subject ?? "", note: r.note ?? "" },
      { onConflict: "sender" },
    );
    if (error) throw error;
    return true;
  } catch (err) {
    console.error("[supabase] upsertEmailRule error:", errMsg(err));
    return false;
  }
}

export async function deleteEmailRule(sender: string): Promise<boolean> {
  const sb = getClient();
  if (!sb) return false;
  try {
    const { error } = await sb.from("email_rules").delete().eq("sender", sender);
    if (error) throw error;
    return true;
  } catch (err) {
    console.error("[supabase] deleteEmailRule error:", errMsg(err));
    return false;
  }
}

/** อ่านใบขนล่าสุดจาก declarations (สำหรับแสดงในเว็บ) — ใส่ status เสมอ (derive ถ้าไม่มีคอลัมน์) */
export async function listDeclarations(limit = 100): Promise<Record<string, unknown>[]> {
  const sb = getClient();
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from("declarations")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []).map((r) => ({ ...r, status: deriveStatus(r) })) as Record<string, unknown>[];
  } catch (err) {
    console.error("[supabase] listDeclarations error:", errMsg(err));
    return [];
  }
}

/** อ่านใบขน 1 ใบ (พร้อม items) */
export async function getDeclaration(id: string): Promise<Record<string, unknown> | null> {
  const sb = getClient();
  if (!sb || !id) return null;
  try {
    const { data, error } = await sb.from("declarations").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const { data: items } = await sb
      .from("declaration_items")
      .select("*")
      .eq("declaration_id", id)
      .order("line_no", { ascending: true });
    return { ...data, status: deriveStatus(data), _items: items ?? [] };
  } catch (err) {
    console.error("[supabase] getDeclaration error:", errMsg(err));
    return null;
  }
}

/** สร้าง declaration ใหม่ (manual create หรือ upload) — คืน id */
export async function createDeclaration(
  record: Record<string, unknown> & { _items?: Record<string, unknown>[] },
  opts: { source?: string; status?: string } = {},
): Promise<{ id: string } | null> {
  const sb = getClient();
  if (!sb) return null;
  try {
    const payload: Record<string, unknown> = {};
    for (const col of DECL_COLUMNS) if (record[col] !== undefined) payload[col] = record[col] ?? null;
    const extra = await availableExtraColumns();
    for (const col of extra) if (record[col] !== undefined) payload[col] = record[col] ?? null;
    payload.source = opts.source ?? "manual";
    payload.doc_status = false;
    if (await declarationStatusEnabled()) {
      // ไม่ใช้ "new" — เริ่มที่ "ready" (พร้อมรัน) เสมอ
      const st = opts.status ?? "ready";
      payload.status = st === "new" ? "ready" : st;
      payload.updated_at = new Date().toISOString();
    }
    const ins = await sb.from("declarations").insert(payload).select("id").single();
    if (ins.error) throw ins.error;
    const declId = ins.data?.id as string;
    const items = record._items ?? [];
    if (declId && items.length) await insertItems(declId, items);
    return { id: declId };
  } catch (err) {
    console.error("[supabase] createDeclaration error:", errMsg(err));
    return null;
  }
}

/** insert declaration_items (ใช้ร่วม insert/create) */
// cache: declaration_items มีคอลัมน์ export_tariff/customs_unit_code ไหม (sql/04)
let _itemExtra: boolean | null = null;
// cache: มีคอลัมน์ multi-item ไหม (description_eng_field/net_weight_unit_code/insurance/product_description_thai — sql/07)
let _itemMulti: boolean | null = null;
async function itemMultiEnabled(): Promise<boolean> {
  if (_itemMulti !== null) return _itemMulti;
  const sb = getClient();
  if (!sb) { _itemMulti = false; return false; }
  const { error } = await sb.from("declaration_items").select("description_eng_field").limit(1);
  _itemMulti = !error;
  return _itemMulti;
}
async function itemExtraEnabled(): Promise<boolean> {
  if (_itemExtra !== null) return _itemExtra;
  const sb = getClient();
  if (!sb) { _itemExtra = false; return false; }
  const { error } = await sb.from("declaration_items").select("export_tariff").limit(1);
  _itemExtra = !error;
  return _itemExtra;
}

async function insertItems(declId: string, items: Record<string, unknown>[]): Promise<void> {
  const sb = getClient();
  if (!sb) return;
  const hasExtra = await itemExtraEnabled();
  const hasMulti = await itemMultiEnabled();
  const rows = items.map((it, i) => {
    const row: Record<string, unknown> = {
      declaration_id: declId,
      line_no: it.line_no ?? i + 1,
      description_eng: it.description_eng,
      brand_name: it.brand_name,
      container_or_volume_qty: it.container_or_volume_qty,
      container_unit_code: it.container_unit_code,
      net_weight_kg: it.net_weight_kg,
      gross_weight_kg: it.gross_weight_kg,
      net_weight_ton: it.net_weight_ton,
      amount: it.amount,
      is_foc: it.is_foc,
    };
    if (hasExtra) {
      row.export_tariff = it.export_tariff ?? null;
      row.customs_unit_code = it.customs_unit_code ?? null;
    }
    if (hasMulti) {
      // multi-item: คำอธิบายอังกฤษอิสระต่อรายการ + หน่วย/ประกัน/คำอธิบายไทย ต่อรายการ
      row.description_eng_field = it.description_eng_field ?? null;
      row.net_weight_unit_code = it.net_weight_unit_code ?? null;
      row.insurance = it.insurance ?? null;
      row.product_description_thai = it.product_description_thai ?? null;
    }
    return row;
  });
  const r = await sb.from("declaration_items").insert(rows);
  if (r.error) console.error("[supabase] insertItems error:", errMsg(r.error));
}

/** แทนที่ declaration_items ทั้งชุด (ลบเก่า → insert ใหม่) — สำหรับแก้รายการสินค้าจากหน้าเว็บ */
export async function replaceItems(declId: string, items: Record<string, unknown>[]): Promise<boolean> {
  const sb = getClient();
  if (!sb || !declId) return false;
  try {
    await sb.from("declaration_items").delete().eq("declaration_id", declId);
    if (Array.isArray(items) && items.length) await insertItems(declId, items);
    return true;
  } catch (err) {
    console.error("[supabase] replaceItems error:", errMsg(err));
    return false;
  }
}

/** ลบ declaration (+ items cascade) */
export async function deleteDeclaration(id: string): Promise<boolean> {
  const sb = getClient();
  if (!sb || !id) return false;
  try {
    await sb.from("declaration_items").delete().eq("declaration_id", id);
    const { error } = await sb.from("declarations").delete().eq("id", id);
    if (error) throw error;
    return true;
  } catch (err) {
    console.error("[supabase] deleteDeclaration error:", errMsg(err));
    return false;
  }
}

/** ตั้งสถานะ workflow ของใบขน (graceful — เงียบถ้ายังไม่มีคอลัมน์) */
export async function setDeclarationStatus(
  id: string,
  status: string,
  message?: string | null,
  jobId?: string | null,
): Promise<boolean> {
  const sb = getClient();
  if (!sb || !id) return false;
  if (!(await declarationStatusEnabled())) return false;
  try {
    const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
    if (message !== undefined) patch.status_message = message;
    if (jobId !== undefined) patch.last_job_id = jobId;
    const { error } = await sb.from("declarations").update(patch).eq("id", id);
    if (error) throw error;
    return true;
  } catch (err) {
    console.error("[supabase] setDeclarationStatus error:", errMsg(err));
    return false;
  }
}

/**
 * สร้าง signed URL อายุสั้นสำหรับดาวน์โหลด (กรณี bucket เป็น private)
 * ถ้าทำไม่ได้ คืน public_url แทน
 */
export async function getDownloadUrl(
  storagePath: string,
  fallback: string | null,
): Promise<string | null> {
  const sb = getClient();
  if (!sb) return fallback;
  try {
    const { data, error } = await sb.storage
      .from(config.supabase.bucket)
      .createSignedUrl(storagePath, 3600);
    if (error || !data) return fallback;
    return data.signedUrl;
  } catch {
    return fallback;
  }
}

// ============================================================
//  Declarations insert (Get Email) — mirror GAS insertDeclaration_
//  กันซ้ำด้วย customer+invoice, insert items ต่อท้าย
// ============================================================
const DECL_COLUMNS = [
  "customer_name", "consignee_name", "buyer_country_code", "destination_country_code",
  "invoice_number", "invoice_date", "tax_payment_method_code", "vessel_name",
  "voyage_number", "etd", "release_port_code", "loading_port_code", "incoterms",
  "currency", "total_goods_amount", "freight_charge", "insurance_charge", "shipping_mark",
  "description_eng", "net_weight_kg", "gross_weight_kg", "net_weight_ton",
  "net_weight_unit_code", "container_or_volume_qty", "container_unit_code",
];
// คอลัมน์เพิ่มเติม (sql/04) — ใช้แบบ graceful: insert เฉพาะที่ DB มีจริง
const DECL_EXTRA_COLUMNS = [
  "export_tariff", "customs_unit_code", "freight_alloc", "transport_mode",
  "mawb", "hawb", "reference_no", "exdec_doc_type", "product_description_thai",
  "declaration_no",
];
// cache เซ็ตคอลัมน์ extra ที่มีจริงใน DB (null = ยังไม่ตรวจ)
let _extraCols: Set<string> | null = null;
async function availableExtraColumns(): Promise<Set<string>> {
  if (_extraCols) return _extraCols;
  const sb = getClient();
  _extraCols = new Set();
  if (!sb) return _extraCols;
  for (const col of DECL_EXTRA_COLUMNS) {
    const { error } = await sb.from("declarations").select(col).limit(1);
    if (!error) _extraCols.add(col);
  }
  if (_extraCols.size < DECL_EXTRA_COLUMNS.length) {
    console.warn(`[supabase] บางคอลัมน์ยังไม่มี — โปรดรัน sql/04_declarations_extra_fields.sql (มี ${_extraCols.size}/${DECL_EXTRA_COLUMNS.length})`);
  }
  return _extraCols;
}

// คอลัมน์ workflow (เพิ่มใน sql/03) — ใช้แบบ graceful: ถ้ายังไม่ได้รัน SQL ระบบยังทำงานได้
const STATUS_COLUMNS = ["status", "status_message", "last_job_id", "updated_at"];
// cache ว่าคอลัมน์ status มีจริงไหม (กันยิงซ้ำ) — null = ยังไม่ได้ตรวจ
let _statusColExists: boolean | null = null;

/** ตรวจครั้งเดียวว่า declarations มีคอลัมน์ status ไหม (รัน sql/03 แล้วหรือยัง) */
export async function declarationStatusEnabled(): Promise<boolean> {
  if (_statusColExists !== null) return _statusColExists;
  const sb = getClient();
  if (!sb) { _statusColExists = false; return false; }
  const { error } = await sb.from("declarations").select("status").limit(1);
  _statusColExists = !error;
  if (error) console.warn("[supabase] คอลัมน์ status ยังไม่มี — โปรดรัน sql/03_declarations_status.sql (ตอนนี้ใช้สถานะคำนวณชั่วคราว)");
  return _statusColExists;
}

/** คำนวณสถานะจากข้อมูล (ใช้เมื่อยังไม่มีคอลัมน์ status) */
function deriveStatus(r: Record<string, unknown>): string {
  // ไม่มีสถานะ "new" (ใหม่·ต้องตรวจ) — ทุกใบเริ่มที่ "ready" (พร้อมรัน) เสมอ
  //   สถานะที่ใช้: ready (พร้อมรัน) / queued / running / done (เสร็จ) / edited / error
  const s = r.status ? String(r.status) : "";
  if (!s || s === "new") return "ready";
  return s;
}

/** เช็คว่ามี declaration ของ customer+invoice อยู่แล้วไหม (กันซ้ำ) */
async function declarationExists(customer: string, invoice: string): Promise<boolean> {
  const sb = getClient();
  if (!sb || !customer || !invoice) return false;
  const { data } = await sb
    .from("declarations")
    .select("id")
    .eq("customer_name", customer)
    .eq("invoice_number", invoice)
    .limit(1);
  return !!(data && data.length);
}

/**
 * insert declaration + items (จาก Get Email) — คืน { inserted, skipped }
 * record มี _items?: [] แนบมาด้วย
 */
export async function insertDeclaration(
  record: Record<string, unknown> & { _items?: Record<string, unknown>[] },
): Promise<{ inserted: boolean; reason?: string; id?: string }> {
  const sb = getClient();
  if (!sb) return { inserted: false, reason: "supabase ปิด" };
  const customer = String(record.customer_name ?? "");
  const invoice = String(record.invoice_number ?? "");
  if (await declarationExists(customer, invoice)) {
    return { inserted: false, reason: "ซ้ำ (customer+invoice มีอยู่แล้ว)" };
  }
  try {
    const payload: Record<string, unknown> = {};
    for (const col of DECL_COLUMNS) payload[col] = record[col] ?? null;
    // extra columns — ใส่เฉพาะที่ DB มีจริง (graceful)
    const extra = await availableExtraColumns();
    for (const col of extra) if (record[col] != null) payload[col] = record[col];
    payload.source = "get-email";
    payload.doc_status = false;
    // ไม่ใช้ "new" — ทุกใบเริ่มที่ "ready" (พร้อมรัน) เสมอ
    if (await declarationStatusEnabled()) {
      payload.status = "ready";
      payload.updated_at = new Date().toISOString();
    }

    const ins = await sb.from("declarations").insert(payload).select("id").single();
    if (ins.error) throw ins.error;
    const declId = ins.data?.id as string;

    const items = record._items ?? [];
    if (declId && items.length) await insertItems(declId, items);
    return { inserted: true, id: declId };
  } catch (err) {
    console.error("[supabase] insertDeclaration error:", errMsg(err));
    return { inserted: false, reason: errMsg(err) };
  }
}

/** แก้ไข declaration (จากหน้า preview) — รับเฉพาะคอลัมน์ที่อนุญาต */
export async function updateDeclaration(
  id: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const sb = getClient();
  if (!sb || !id) return false;
  // อนุญาตแก้เฉพาะคอลัมน์ใน declarations + extra + status (กันยิง field มั่ว)
  const extra = await availableExtraColumns();
  const allowed = new Set([...DECL_COLUMNS, ...extra, "status", "status_message"]);
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (allowed.has(k)) clean[k] = v === "" ? null : v;
  }
  if (!Object.keys(clean).length) return false;
  // ถ้าไม่มีคอลัมน์ status → ตัดออกกัน error
  if (!(await declarationStatusEnabled())) {
    delete clean.status; delete clean.status_message;
    if (!Object.keys(clean).length) return false;
  } else {
    clean.updated_at = new Date().toISOString();
  }
  try {
    const { error } = await sb.from("declarations").update(clean).eq("id", id);
    if (error) throw error;
    return true;
  } catch (err) {
    console.error("[supabase] updateDeclaration error:", errMsg(err));
    return false;
  }
}

/** เช็ค sender อยู่ใน allowlist (email_rules) ไหม */
export async function isSenderAllowed(email: string): Promise<boolean> {
  const sb = getClient();
  if (!sb || !email) return false;
  const { data } = await sb
    .from("email_rules")
    .select("sender")
    .ilike("sender", email)
    .limit(1);
  return !!(data && data.length);
}

/** ดึง allowlist senders ทั้งหมด (สำหรับ build Gmail query) */
export async function getAllowlistSenders(): Promise<string[]> {
  const sb = getClient();
  if (!sb) return [];
  const { data } = await sb.from("email_rules").select("sender");
  return (data ?? []).map((r) => r.sender).filter(Boolean);
}

// ============================================================
//  Job queue (Phase C) — web enqueue งาน, worker (VM) มาหยิบทำ
// ============================================================
export type JobType = "rpa_import" | "get_email" | "rpa_edit" | "rpa_print";
export type JobStatus = "pending" | "processing" | "done" | "error" | "cancel";

export interface JobRow {
  id: string;
  type: JobType;
  status: JobStatus;
  payload: Record<string, unknown>;
  dry_run: boolean;
  triggered_by: string | null;
  trigger_source: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  claimed_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface JobLogRow {
  id: number;
  job_id: string;
  kind: string;
  payload: unknown;
  created_at: string;
}

/** สร้างงานใหม่ลงคิว — คืน job id (null ถ้า Supabase ปิด) */
export async function enqueueJob(
  type: JobType,
  payload: Record<string, unknown>,
  opts: { dryRun?: boolean; triggeredBy?: string | null; triggerSource?: string } = {},
): Promise<string | null> {
  const sb = getClient();
  if (!sb) return null;
  try {
    const { data, error } = await sb
      .from("job_queue")
      .insert({
        type,
        payload,
        dry_run: !!opts.dryRun,
        triggered_by: opts.triggeredBy ?? null,
        trigger_source: opts.triggerSource ?? "manual",
      })
      .select("id")
      .single();
    if (error) throw error;
    return (data?.id as string) ?? null;
  } catch (err) {
    console.error("[supabase] enqueueJob error:", errMsg(err));
    return null;
  }
}

/** สั่งยกเลิกงาน (worker จะหยุดก่อนแถวถัดไป) — ตั้ง status=cancel เฉพาะที่ยัง pending/processing */
export async function cancelActiveJobs(type?: JobType): Promise<number> {
  const sb = getClient();
  if (!sb) return 0;
  try {
    let q = sb
      .from("job_queue")
      .update({ status: "cancel" })
      .in("status", ["pending", "processing"]);
    if (type) q = q.eq("type", type);
    const { data, error } = await q.select("id");
    if (error) throw error;
    return (data ?? []).length;
  } catch (err) {
    console.error("[supabase] cancelActiveJobs error:", errMsg(err));
    return 0;
  }
}

/** อ่านรายการงานล่าสุด (history) */
export async function listJobs(limit = 30, type?: JobType): Promise<JobRow[]> {
  const sb = getClient();
  if (!sb) return [];
  try {
    let q = sb.from("job_queue").select("*").order("created_at", { ascending: false }).limit(limit);
    if (type) q = q.eq("type", type);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as JobRow[];
  } catch (err) {
    console.error("[supabase] listJobs error:", errMsg(err));
    return [];
  }
}

/** อ่านงานล่าสุด 1 งานตาม type (เช่น get_email สำหรับหน้าสถานะ) */
export async function latestJob(type: JobType): Promise<JobRow | null> {
  const jobs = await listJobs(1, type);
  return jobs[0] ?? null;
}

/** อ่าน job เดียวตาม id */
export async function getJob(id: string): Promise<JobRow | null> {
  const sb = getClient();
  if (!sb) return null;
  try {
    const { data, error } = await sb.from("job_queue").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as JobRow) ?? null;
  } catch (err) {
    console.error("[supabase] getJob error:", errMsg(err));
    return null;
  }
}

/** อ่าน log ของงาน (replay) — id > afterId สำหรับ polling แบบเพิ่ม */
export async function getJobLogs(jobId: string, afterId = 0): Promise<JobLogRow[]> {
  const sb = getClient();
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from("job_logs")
      .select("*")
      .eq("job_id", jobId)
      .gt("id", afterId)
      .order("id", { ascending: true });
    if (error) throw error;
    return (data ?? []) as JobLogRow[];
  } catch (err) {
    console.error("[supabase] getJobLogs error:", errMsg(err));
    return [];
  }
}

/** subscribe Realtime: log ใหม่ของงาน (คืนฟังก์ชัน unsubscribe) */
export function subscribeJobLogs(
  onLog: (row: JobLogRow) => void,
  onJobChange?: (row: JobRow) => void,
): () => void {
  const sb = getClient();
  if (!sb) return () => {};
  const ch = sb
    .channel("job-stream")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "job_logs" },
      (payload) => onLog(payload.new as JobLogRow),
    );
  if (onJobChange) {
    ch.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "job_queue" },
      (payload) => onJobChange(payload.new as JobRow),
    );
  }
  ch.subscribe();
  return () => {
    sb.removeChannel(ch);
  };
}
