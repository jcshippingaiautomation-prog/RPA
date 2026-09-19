// ============================================================
//  Supabase — เก็บ/ดึงเอกสาร PDF ที่ RPA สร้าง
//  ถ้าไม่ได้ตั้งค่า key จะ disabled แบบ graceful (ไม่ throw)
// ============================================================
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config.js";
import { splitRecord, rowToFields } from "./field-registry.js";
import { applyTemplate } from "./master-template.js";
import { normalizeToDctkCodes } from "./normalize-codes.js";

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

/** 1 กรณีย่อยของลูกค้า (เลือกด้วยค่าของ split_field) — override config ของ default */
export interface CustomerCase {
  name: string;                            // ชื่อกรณี เช่น "DK&N VIETNAM"
  match_value: string;                     // ค่าที่ต้องตรงกับ split_field (เช่น consignee = "DK&N")
  allowed_fields: string[];
  presets: { [field: string]: string };
  extraction_rules?: string;
  request_screenshot?: boolean;
}
export interface CustomerSetting {
  customer_name: string;
  allowed_fields: string[];                // = กรณีเริ่มต้น (default)
  presets: { [field: string]: string };
  extraction_rules?: string;
  request_screenshot?: boolean;
  split_field?: string;                    // ช่องที่ใช้แยกกรณี ("" = ไม่แยก)
  cases?: CustomerCase[];
}

/** config ที่ resolve แล้ว (default หรือ กรณีที่ match) */
export interface EffectiveConfig {
  case_name: string;                       // "" = default
  allowed_fields: string[];
  presets: { [field: string]: string };
  extraction_rules: string;
  request_screenshot: boolean;
}
/**
 * เลือก config ที่ใช้จริงจาก setting ตามค่าของ split_field ใน record
 *   - split_field ว่าง/ไม่มี cases → ใช้ default (คอลัมน์เดิม)
 *   - มี cases → หา case ที่ match_value ตรงกับ record[split_field] (ไม่สนตัวพิมพ์ + contains 2 ทาง)
 *   - ไม่เข้ากรณีไหน → default
 */
export function selectCaseConfig(
  s: CustomerSetting,
  record: { [k: string]: unknown },
): EffectiveConfig {
  const def: EffectiveConfig = {
    case_name: "",
    allowed_fields: s.allowed_fields ?? [],
    presets: s.presets ?? {},
    extraction_rules: s.extraction_rules ?? "",
    request_screenshot: !!s.request_screenshot,
  };
  const field = (s.split_field ?? "").trim();
  if (!field || !Array.isArray(s.cases) || !s.cases.length) return def;
  const val = String(record[field] ?? "").trim().toLowerCase();
  if (!val) return def;
  const matched = s.cases.find((c) => {
    const mv = String(c.match_value ?? "").trim().toLowerCase();
    return mv && (val === mv || val.includes(mv) || mv.includes(val));
  });
  if (!matched) return def;
  return {
    case_name: matched.name || matched.match_value || "",
    allowed_fields: matched.allowed_fields ?? [],
    presets: matched.presets ?? {},
    extraction_rules: matched.extraction_rules ?? "",
    request_screenshot: !!matched.request_screenshot,
  };
}

/** อ่าน customer settings ทั้งหมด (allowed_fields + presets + extraction_rules) */
export async function listCustomerSettings(): Promise<CustomerSetting[]> {
  const sb = getClient();
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from("customer_settings")
      .select("customer_name, allowed_fields, presets, extraction_rules, request_screenshot, split_field, cases")
      .order("customer_name", { ascending: true });
    if (error) throw error;
    return (data ?? []).map((r) => ({
      customer_name: r.customer_name,
      allowed_fields: r.allowed_fields ?? [],
      presets: r.presets ?? {},
      extraction_rules: r.extraction_rules ?? "",
      request_screenshot: r.request_screenshot ?? false,
      split_field: r.split_field ?? "",
      cases: Array.isArray(r.cases) ? r.cases : [],
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
    if (s.split_field !== undefined) row.split_field = s.split_field;
    if (s.cases !== undefined) row.cases = s.cases;
    let { error } = await sb
      .from("customer_settings")
      .upsert(row, { onConflict: "customer_name" });
    if (error) {
      // คอลัมน์ split_field/cases ยังไม่มี (ยังไม่รัน sql/10) → ลองใหม่โดยตัดออก (กันบันทึกพัง)
      delete row.split_field; delete row.cases;
      ({ error } = await sb.from("customer_settings").upsert(row, { onConflict: "customer_name" }));
      if (error) throw error;
    }
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
): Promise<CustomerSetting | null> {
  const sb = getClient();
  if (!sb || !keyword) return null;
  try {
    const all = await listCustomerSettings();
    const kw = keyword.trim().toUpperCase();
    for (const s of all) {
      const cn = String(s.customer_name || "").trim().toUpperCase();
      if (cn && (cn === kw || cn.includes(kw) || kw.includes(cn))) return s;
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
    const rows = (data ?? []).map((r) => ({ ...r, status: deriveStatus(r) })) as Record<string, unknown>[];

    // แนบ "รหัสสินค้า" ของแต่ละใบมาด้วย (ดึงเฉพาะคอลัมน์เดียว ไม่ดึงรายการทั้งก้อน)
    //   ใน DCTK ช่องรหัสสินค้าเก็บที่คอลัมน์ description_eng ของ declaration_items
    const ids = rows.map((r) => String(r.id)).filter(Boolean);
    if (ids.length) {
      const { data: items } = await sb
        .from("declaration_items")
        .select("declaration_id, description_eng")
        .in("declaration_id", ids);
      const byDecl = new Map<string, string[]>();
      for (const it of items ?? []) {
        const k = String((it as { declaration_id?: unknown }).declaration_id ?? "");
        const v = String((it as { description_eng?: unknown }).description_eng ?? "").trim();
        if (!k || !v) continue;
        const arr = byDecl.get(k) ?? [];
        if (!arr.includes(v)) arr.push(v);
        byDecl.set(k, arr);
      }
      for (const r of rows) r.product_codes = byDecl.get(String(r.id)) ?? [];
    }
    return rows;
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
/**
 * เติมจำนวนหีบห่อที่ขาดคืนให้แถวของแถม/ตัวอย่าง เพื่อให้ผลรวมรายการเท่ากับยอดหัวใบ
 *
 * ทำเฉพาะเมื่อมั่นใจว่าเป็นอาการ "อ่านคอลัมน์เลื่อน" เท่านั้น:
 *   - หัวใบมียอด และผลรวมรายการน้อยกว่าหัวใบ
 *   - ส่วนต่างเล็กมาก (ไม่เกิน 10 กล่อง และไม่เกิน 1% ของยอดทั้งใบ)
 *   - มีแถวของแถม (FOC) ที่จำนวนกล่องเป็น 0 ให้เติม
 * นอกเหนือจากนี้ไม่แตะ — ปล่อยให้ขึ้นเตือนในหน้าตรวจข้อมูลให้ผู้ใช้ตัดสินใจเอง
 */
function reconcilePackageCount(record: Record<string, unknown> & { _items?: Record<string, unknown>[] }): void {
  const items = record._items ?? [];
  if (items.length < 2) return;
  const n = (v: unknown) => {
    const x = Number(String(v ?? "").replace(/,/g, ""));
    return Number.isFinite(x) ? x : 0;
  };
  const sum0 = items.reduce((a, it) => a + n(it.container_or_volume_qty), 0);
  // หัวใบไม่มีจำนวนหีบห่อ แต่รายการมี → ใช้ผลรวมรายการ
  //   (เอกสารบางราย เช่น สยามฮิตาชิ ไม่มีแถวสรุปจำนวนลัง ต้องรวมเอง
  //    ไม่งั้นช่องบังคับของ DCTK ว่างแล้วบันทึกหน้า 1 ไม่ผ่าน)
  if (n(record.container_or_volume_qty) <= 0 && sum0 > 0) {
    record.container_or_volume_qty = sum0;
    console.log(`[กระทบยอด] จำนวนหีบห่อหัวใบว่าง → ใช้ผลรวมรายการ ${sum0}`);
  }
  const head = n(record.container_or_volume_qty);
  if (head <= 0) return;
  const sum = sum0;
  const gap = head - sum;
  if (gap <= 0 || gap > 10 || gap > head * 0.01) return;

  const target = items.find((it) => it.is_foc === true && n(it.container_or_volume_qty) === 0);
  if (!target) return;
  target.container_or_volume_qty = gap;
  console.log(`[กระทบยอด] จำนวนหีบห่อ: หัวใบ ${head} · รวมรายการ ${sum} — เติม ${gap} กล่องให้รายการของแถม "${String(target.description_eng_field ?? target.description_eng ?? "").slice(0, 40)}"`);
}

/**
 * เลือกแถวใน Master ที่ "เป็นสินค้าตัวเดียวกัน" กับรายการจากเอกสาร
 *
 * ใช้คำที่ใช้ร่วมกันเป็นเกณฑ์ เพราะชื่อในเอกสารกับในคลัง DCTK เขียนไม่เหมือนกัน
 * และแถวตัวอย่าง (SAMPLE) ของบางผู้รับมีรหัสสินค้าแยกต่างหาก
 * ถ้าไม่มีแถวไหนใกล้พอ ใช้แถวแรกเป็นต้นแบบ (เป็นสินค้าหลักของผู้รับรายนั้น)
 */
function pickMasterItem(
  aiItem: Record<string, unknown>,
  tplItems: Record<string, unknown>[],
): Record<string, unknown> {
  if (!tplItems.length) return {};
  if (tplItems.length === 1) return tplItems[0];
  const words = (v: unknown) =>
    new Set(String(v ?? "").toUpperCase().replace(/[^A-Z0-9ก-๙ ]/g, " ").split(/\s+/).filter((w) => w.length >= 2));
  const need = new Set<string>();
  for (const k of ["description_eng_field", "description_eng", "product_description_eng"]) {
    for (const w of words(aiItem[k])) need.add(w);
  }
  if (!need.size) return tplItems[0];
  let best = tplItems[0], bestScore = 0;
  for (const t of tplItems) {
    const have = new Set<string>();
    for (const k of ["product_description_eng", "product_code"]) for (const w of words(t[k])) have.add(w);
    if (!have.size) continue;
    let hit = 0;
    for (const w of have) if (need.has(w)) hit++;
    const score = hit / Math.min(have.size, need.size);
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return bestScore >= 0.5 ? best : tplItems[0];
}

/**
 * จัดข้อความ/รหัสระดับรายการให้ตรงกับที่กรมฯ ต้องการ — คำนวณเอง ไม่พึ่ง Master
 *
 * 1) รายการของแถม (nature_trans): 21 ถ้าเป็นของแถม · 11 ถ้าไม่ใช่
 *    เดิมเอามาจาก Master ตามลำดับแถว ซึ่งผิดทันทีที่เอกสารใหม่มีจำนวนรายการไม่เท่าเดิม
 * 2) คำอธิบายสินค้าภาษาอังกฤษ: ใบขนจริงเขียน "รหัสสินค้า" ขึ้นบรรทัดแรก
 *    แล้วต่อด้วยถ้อยคำจากใบกำกับ (ดูใบที่ยื่นจริง CTN2649)
 *    ถ้าขาดบรรทัดแรกไป ใบขนจะไม่ตรงกับที่เจ้าหน้าที่ทำมือ
 */
function normalizeItemText(record: Record<string, unknown> & { _items?: Record<string, unknown>[] }): void {
  for (const it of record._items ?? []) {
    const extra = (it.extra_fields ?? {}) as Record<string, unknown>;
    extra.nature_trans = it.is_foc === true ? "21" : "11";

    // ช่อง "ปริมาณ" ใช้เฉพาะหน่วยที่ไม่ใช่น้ำหนัก/ปริมาตร (MTK ตารางเมตร · C62 ชิ้น)
    //   ถ้าหน่วยเป็น KGM/TNE/LTR ตัวเลขก็คือน้ำหนักสุทธินั่นเอง เก็บซ้ำจะทำให้
    //   ยอดหัวใบ (เก็บเป็นตัน) กับผลรวมรายการ (เป็นกิโล) ขัดกันเอง แล้วขึ้นเตือนผิด ๆ
    const cu = String(it.customs_unit_code ?? "").trim().toUpperCase();
    if (["TNE", "TON", "TO", "MT", "KGM", "KG", "LTR", "L"].includes(cu)) {
      delete extra.quantity;
      delete it.quantity;
    }

    // สกุลเงินของรายการต้องเป็นสกุลเดียวกับทั้งใบเสมอ
    //   ถ้าไม่ตรง DCTK คำนวณยอดบาทคนละอัตราแล้วตีกลับตอนบันทึกหน้า 3:
    //   "ราคาสินค้าบาท: ผลรวมส่วนรายละเอียดไม่เท่ากับส่วนควบคุม"
    //   (เจอจริงกับไทยซิง: หัวใบเป็น USD แต่รายการติด CNY มาจาก Master → บันทึกไม่ผ่านทุกครั้ง)
    const cur = String(record.currency ?? "").trim().toUpperCase();
    if (cur) {
      // ราคาสินค้า/ราคาต่อหน่วย: ตั้งเสมอ แม้เอกสารไม่ได้เขียนสกุลซ้ำในแต่ละแถว
      //   (ปล่อยว่างแล้ว DCTK จะใช้ค่าปริยายของมันเอง แล้วยอดบาทไม่ตรงอีกแบบ)
      extra.amount_currency = cur;
      extra.unit_price = cur;
      // ค่าใช้จ่ายอื่น: เติมเฉพาะช่องที่ใบนี้มีค่าอยู่แล้ว ไม่ไปเปิดช่องที่ไม่ได้ใช้
      for (const k of ["freight", "insurance_currency", "pack", "inland", "landing", "extra1", "extra2"]) {
        if (String(extra[k] ?? "").trim()) extra[k] = cur;
      }
    }

    it.extra_fields = extra;

    const code = String(it.description_eng ?? "").trim();
    const desc = String(it.description_eng_field ?? "").trim();
    if (code && desc && !desc.toUpperCase().startsWith(code.toUpperCase())) {
      it.description_eng_field = `${code}\n${desc}`;
    }

    // 3) คำอธิบายภาษาไทย: ลูกค้าบางรายต้องขึ้นต้นด้วยรหัสสินค้าของตัวเอง (Part No) ของรายการนั้น
    //    แล้วตามด้วยชื่อสินค้าภาษาไทย — Part No เปลี่ยนทุกรายการ จะเก็บไว้ใน Master ไม่ได้
    //    (ลูกค้าแผงวงจรพิมพ์: "PCB-20260407-016" ขึ้นบรรทัดแรก แล้วต่อด้วย "แผงวงจรพิมพ์")
    // Part No อาจอยู่ได้ 2 ที่: ระดับบนของ item (ตอน AI เพิ่งสกัดมา) หรือใน extra_fields (หลังบันทึกแล้ว)
    const partNo = String(
      it.customs_product_code
      ?? ((it.extra_fields ?? {}) as Record<string, unknown>).customs_product_code
      ?? "",
    ).trim();
    const thai = String(it.product_description_thai ?? "").trim();
    if (partNo && thai) {
      // ตัดบรรทัด Part No เดิมที่ติดมากับ Master ออกก่อน (เป็นของชิปเมนต์เก่า)
      const body = thai.split("\n").filter((l) => !/^[A-Z]{2,}-\d/i.test(l.trim())).join("\n").trim();
      it.product_description_thai = body ? `${partNo}\n${body}` : partNo;
    }
  }
}

/**
 * จัดน้ำหนักรายรายการและยอดรวมหัวใบให้สอดคล้องกัน
 *
 * ใบแนบของลูกค้าบางรายมี "น้ำหนักรวมหีบห่อ" เฉพาะยอดรวมท้ายตาราง ไม่มีรายแถว
 * ใบขนที่เจ้าหน้าที่ทำจริงจะใส่น้ำหนักสุทธิลงทั้งสองช่องของแถวนั้น
 * แล้วยอดหัวใบก็เท่ากับผลรวมรายแถว (ดูใบจริง DCTK000035584: 696+175.5 = 871.5 ทั้งสุทธิและรวม)
 * ถ้าไม่ทำ กรมฯ จะตีกลับตอนกระทบยอด "ส่วนควบคุม vs ส่วนรายละเอียด"
 */
/**
 * ยอดเงินรายรายการ vs ยอดหัวใบ — บางลูกค้ายอดรวมในใบกำกับ "รวมค่าระวาง/ค่าประกัน" ไว้แล้ว
 *   DCTK เทียบผลรวมรายการกับยอดหัวใบ ถ้าไม่เท่าจะตีกลับตอนบันทึกหน้า 3
 *   ส่วนต่างต้องกระจายลงรายการ แต่ "วิธีกระจาย" ต่างกันตามที่ลูกค้าทำมาจริง:
 *     equal = เฉลี่ยเท่ากันทุกรายการ แล้วใส่เป็นค่าระวางรายรายการด้วย
 *             (Q-Cine: ค่าระวาง 450 / 10 รายการ → ใบขนจริงขึ้น F=USD 45.00 ทุกแถว)
 *     first = บวกรวมไว้ที่รายการแรกรายการเดียว ไม่ต้องกรอกค่าระวางรายรายการ
 *             (สยามฮิตาชิ: ค่า C/O + ค่าระวาง+ประกัน ไปรวมแถวแรก แล้ว DCTK เฉลี่ยเอง
 *              KW000985 แถวแรก 211.80 + 30.00 + 860.51 = 1,102.31 ตรงกับใบขนจริง)
 *   ลูกค้าที่ไม่ได้ตั้งค่า = ไม่แตะ (พฤติกรรมเดิม)
 */
/** วิธีกระจายส่วนต่างยอดเงินของลูกค้ารายนี้ — เก็บใน presets ของตั้งค่าลูกค้า */
async function extraAmountAlloc(customer: string): Promise<string> {
  if (!customer.trim()) return "";
  try {
    const s = await getExtractionRulesByKeyword(customer);
    return String(s?.presets?.__extra_amount_alloc ?? "");
  } catch { return ""; }
}

function reconcileItemAmounts(
  record: Record<string, unknown> & { _items?: Record<string, unknown>[] },
  alloc: string,
): void {
  const mode = alloc.trim().toLowerCase();
  if (mode !== "equal" && mode !== "first") return;
  const items = record._items ?? [];
  if (!items.length) return;
  const n = (v: unknown) => {
    const x = Number(String(v ?? "").replace(/,/g, ""));
    return Number.isFinite(x) ? x : 0;
  };
  const r2 = (x: number) => Number(x.toFixed(2));
  const sumAmt = () => r2(items.reduce((a, it) => a + n(it.amount), 0));

  if (mode === "equal") {
    // ค่าระวางหารเท่ากันทุกรายการ แล้วบวกเข้ายอดของแต่ละรายการ
    //   ใบกำกับของ Q-Cine มีคอลัมน์ที่บวกไว้ให้แล้วบ้าง ไม่มีบ้าง → เช็คก่อนว่าบวกไปหรือยัง
    const frt = n(record.freight_charge);
    if (frt <= 0) return;
    const share = r2(frt / items.length);
    const already = Math.abs(sumAmt() - r2(n(record.total_goods_amount) + frt)) < 0.05;
    let used = 0;
    items.forEach((it, i) => {
      const add = i === items.length - 1 ? r2(frt - used) : share;
      used = r2(used + add);
      if (!already) it.amount = r2(n(it.amount) + add);
      const ex = (it.extra_fields ?? {}) as Record<string, unknown>;
      ex.freight_foreign = add.toFixed(2);
      it.extra_fields = ex;
    });
    console.log(`[ยอดเงิน] ค่าระวาง ${frt.toLocaleString()} หารลง ${items.length} รายการ รายการละ ${share}` +
      (already ? " (ยอดในเอกสารบวกไว้ให้แล้ว — เติมเฉพาะช่องค่าระวาง)" : " (บวกเข้ายอดรายการด้วย)"));
  } else {
    // ส่วนที่ไม่ใช่สินค้า (ค่าระวาง/ประกัน/ค่า C-O) รวมไว้ที่รายการแรก แล้วให้ DCTK เฉลี่ยเอง
    //   ยอดที่กรอกทั้งใบต้องเป็น "ยอด Total ของใบกำกับ" = ราคาสินค้า + ค่าระวาง + ค่าประกัน
    //   DCTK จะถอดค่าระวาง/ประกันออกเองแล้วได้ราคา FOB กลับมา
    //   (AI มักอ่านยอดหัวใบเป็นผลรวมเฉพาะสินค้า จึงคำนวณเป้าหมายเองจากผลรวมรายการ)
    const charges = r2(n(record.freight_charge) + n(record.insurance_charge));
    if (charges <= 0.005) return;
    const head = n(record.total_goods_amount);
    const sum = sumAmt();
    // ส่วนต่างที่ต้องบวกเข้ารายการที่ 1
    //   บรีฟสั่งให้ AI ส่ง "ยอดสินค้าล้วน" ทั้งหัวใบและรายรายการ → ส่วนต่างคือค่าระวาง+ค่าประกัน
    //   แต่บางรอบ AI ส่งยอดหัวใบเป็นยอด Total ของใบกำกับ (รวมค่าใช้จ่ายแล้ว) → ใช้ส่วนต่างที่คำนวณได้แทน
    let gap = head > 0 ? r2(head - sum) : 0;
    if (gap <= 0.005) gap = charges;
    if (gap <= 0.005) return;
    items[0].amount = r2(n(items[0].amount) + gap);
    console.log(`[ยอดเงิน] ค่าใช้จ่ายนอกราคาสินค้า ${gap.toLocaleString()} → บวกเข้ารายการที่ 1 เป็น ${items[0].amount}`);
  }

  // ยอดหัวใบต้องเท่าผลรวมรายการเสมอ — DCTK เทียบสองยอดนี้ตอนบันทึกหน้า 3
  const sum = sumAmt();
  if (sum > 0 && Math.abs(sum - n(record.total_goods_amount)) > 0.02) {
    console.log(`[ยอดเงิน] ราคาสินค้าหัวใบ ${n(record.total_goods_amount).toLocaleString()} → ใช้ผลรวมรายการ ${sum.toLocaleString()}`);
    record.total_goods_amount = sum;
  }
}

function reconcileWeights(record: Record<string, unknown> & { _items?: Record<string, unknown>[] }): void {
  const items = record._items ?? [];
  if (!items.length) return;
  const n = (v: unknown) => {
    const x = Number(String(v ?? "").replace(/,/g, ""));
    return Number.isFinite(x) ? x : 0;
  };
  // 1) แถวไหนไม่มีน้ำหนักรวม → ใช้น้ำหนักสุทธิของแถวนั้น (เอกสารให้มาแค่นั้น)
  for (const it of items) {
    if (n(it.gross_weight_kg) <= 0 && n(it.net_weight_kg) > 0) {
      it.gross_weight_kg = n(it.net_weight_kg);
      console.log(`[น้ำหนัก] รายการ "${String(it.description_eng_field ?? it.description_eng ?? "").slice(0, 34)}" ไม่มีน้ำหนักรวมในเอกสาร → ใช้น้ำหนักสุทธิ ${it.gross_weight_kg}`);
    }
  }
  // 1.5) เอกสารบอก "น้ำหนักรวมทั้งใบ" ไว้ แต่คอลัมน์รายแถวว่าง
  //   → เกลี่ยยอดของเอกสารตามสัดส่วนน้ำหนักสุทธิ ไม่ใช่ทิ้งยอดเอกสารแล้วใช้ผลรวมสุทธิแทน
  //   (เจอจริง ไทยซิงชุด 9: ใบแพ็คกิ้งเขียน G/W รวม 186.50 แต่รายแถวว่าง
  //    ของเดิมทับหัวใบเป็น 171.50 = น้ำหนักสุทธิ ซึ่งไม่ตรงเอกสาร)
  const headGross = n(record.gross_weight_kg);
  const sumNet = items.reduce((a, it) => a + n(it.net_weight_kg), 0);
  const sumGross = items.reduce((a, it) => a + n(it.gross_weight_kg), 0);
  const tol = Math.max(0.02, sumNet * 0.0005);
  // "ไม่มีน้ำหนักรวมรายแถวจริง" = ผลรวมรายแถวเท่ากับน้ำหนักสุทธิพอดี
  //   (ไม่ว่าจะเพราะเราเติมให้เอง หรือ AI อ่านคอลัมน์สุทธิมาใส่ทั้งสองช่อง)
  const noRowGross = Math.abs(sumGross - sumNet) < tol;
  if (noRowGross && headGross > 0 && sumNet > 0 && headGross > sumNet + tol) {
    let used = 0;
    items.forEach((it, i) => {
      const v = i === items.length - 1
        ? Number((headGross - used).toFixed(2))
        : Number((headGross * n(it.net_weight_kg) / sumNet).toFixed(2));
      it.gross_weight_kg = v;
      used = Number((used + v).toFixed(2));
    });
    console.log(`[น้ำหนัก] เอกสารให้น้ำหนักรวมทั้งใบ ${headGross} แต่ไม่แยกรายแถว → เกลี่ยตามสัดส่วนน้ำหนักสุทธิ: ${items.map((it) => it.gross_weight_kg).join(" + ")}`);
  }
  // 2) ยอดหัวใบต้องเท่ากับผลรวมรายแถว (กรมฯ เทียบสองยอดนี้)
  for (const [col, label] of [["net_weight_kg", "น้ำหนักสุทธิ"], ["gross_weight_kg", "น้ำหนักรวม"]] as const) {
    const sum = items.reduce((a, it) => a + n(it[col]), 0);
    if (sum <= 0) continue;
    const head = n(record[col]);
    if (Math.abs(sum - head) < Math.max(0.02, sum * 0.0005)) continue;
    console.log(`[กระทบยอด] ${label}: หัวใบ ${head.toLocaleString()} → ใช้ผลรวมรายการ ${sum.toLocaleString()}`);
    record[col] = Number(sum.toFixed(3));
    if (col === "net_weight_kg") record.net_weight_ton = Number((sum / 1000).toFixed(3));
  }
}

export async function createDeclaration(
  record: Record<string, unknown> & { _items?: Record<string, unknown>[] },
  opts: {
    source?: string; status?: string; fieldModes?: { [k: string]: string };
    /** บังคับใช้ Master ตัวนี้ (ผู้ใช้เลือกเองตอนอัปโหลด) — ไม่ต้องให้ระบบจับคู่เอง */
    templateId?: string;
  } = {},
): Promise<{ id: string; codeFixes?: { label: string; from: string; to: string }[] } | null> {
  const sb = getClient();
  if (!sb) return null;
  try {
    // ── ผสม Master ก่อนบันทึก ────────────────────────────────────────────
    //   เดิมขั้นนี้อยู่ใน insertDeclaration ซึ่งไม่มีใครเรียก → อัปโหลดเอกสารแล้วไม่เคยได้ค่าจาก Master
    // ── ปรับหน่วย/สกุลเงิน/รหัสประเทศ ให้ตรงรหัสที่กรมฯ รับ ก่อนบันทึก ──
    //   AI อ่านตามที่เขียนในเอกสาร ("TON", "KGS") แต่ DCTK รับเฉพาะรหัสของตัวเอง
    //   ปรับตั้งแต่ตอนนี้ ผู้ใช้จะเห็นค่าที่ถูกในหน้าตรวจสอบ และ RPA ค้นคอมโบเจอ
    const codeFixes = await normalizeToDctkCodes(record);
    for (const f of codeFixes) {
      console.log(`[code] ${f.scope === "item" ? `รายการ ${f.itemLine}: ` : ""}${f.label}: "${f.from}" → "${f.to}" (${f.listLabel})`);
    }

    const mastered = await applyMasterToRecord(
      record,
      String(record.customer_name ?? ""),
      String(record.invoice_number ?? ""),
      opts.templateId,
    );
    record = mastered.record;
    const fieldModes = { ...(mastered.fieldModes ?? {}), ...(opts.fieldModes ?? {}) };

    // ── หัวใบสรุปหน่วยจากรายการสินค้า ────────────────────────────────
    //   DCTK บังคับให้ "ส่วนควบคุม" (หัวใบ) มีหน่วยด้วย ไม่ใช่แค่ในรายการ
    //   ใบหลายรายการ AI มักใส่หน่วยเฉพาะในรายการ → หัวใบว่าง แล้วติด validation ทุกใบ
    //   (เจอจริงกับ COCOS ทั้ง 4 ใบ: รายการมี LTR แต่หัวใบว่าง)
    //   เติมให้เฉพาะตอน "หัวใบว่าง" และ "ทุกรายการใช้หน่วยเดียวกัน" — ไม่เดาเมื่อไม่ตรงกัน
    const UNIT_COLS = ["customs_unit_code", "net_weight_unit_code", "container_unit_code"];
    const itemsForUnit = (record._items ?? []) as Record<string, unknown>[];
    if (itemsForUnit.length) {
      for (const col of UNIT_COLS) {
        if (String(record[col] ?? "").trim()) continue;             // หัวใบมีค่าแล้ว ไม่แตะ
        const vals = new Set(itemsForUnit
          .map((it) => String(it[col] ?? "").trim())
          .filter(Boolean));
        if (vals.size === 1) {
          record[col] = [...vals][0];
          console.log(`[unit] หัวใบ ${col} ว่าง → ใช้ค่าจากรายการสินค้า "${record[col]}"`);
        }
      }
    }

    // ── กระทบยอด "จำนวนหีบห่อ" หัวใบ vs รายการ ──────────────────────
    //   กรมฯ เทียบส่วนควบคุมกับผลรวมรายรายการ ถ้าไม่ตรงจะยื่นไม่ผ่าน
    //   ปัญหาที่เจอซ้ำ: ในใบแนบ แถวของแถม/ตัวอย่างเว้นช่อง "Pallet No." ว่าง
    //   ทำให้คอลัมน์เลื่อน AI จึงอ่านจำนวนกล่องของแถวนั้นเป็น 0 ทั้งที่เอกสารมี 1 กล่อง
    //   (ยืนยันกับใบขนที่ยื่นกรมฯ จริง CTN2648: แถวตัวอย่างแถวแรก = 1 กล่อง)
    //   → เติมส่วนต่างคืนให้แถวของแถมแถวแรกที่เป็น 0 เมื่อส่วนต่างเล็กเท่านั้น
    reconcilePackageCount(record);
    reconcileWeights(record);
    reconcileItemAmounts(record, await extraAmountAlloc(String(record.customer_name ?? "")));
    normalizeItemText(record);

    const payload: Record<string, unknown> = {};
    for (const col of DECL_COLUMNS) if (record[col] !== undefined) payload[col] = record[col] ?? null;
    const extra = await availableExtraColumns();
    for (const col of extra) if (record[col] !== undefined) payload[col] = record[col] ?? null;
    // ฟอร์มใหม่ส่งมาเป็น "key ของ registry" (เช่น amount_currency → คอลัมน์ currency)
    //   + ช่องที่ยังไม่มีคอลัมน์จริง → เก็บก้อนเดียวใน extra_fields jsonb
    const split = await splitRecord(record, "header");
    const knownCols = new Set([...DECL_COLUMNS, ...extra]);
    for (const [c, v] of Object.entries(split.columns)) if (knownCols.has(c)) payload[c] = v ?? null;
    if (Object.keys(split.extra).length && (await extraFieldsEnabled("declarations"))) {
      payload.extra_fields = split.extra;
    }
    // โหมดรายช่องที่ติดมาจาก Master ('master'/'ai'/'off') — worker ใช้ตอนกรอก
    if (Object.keys(fieldModes).length && (await fieldModesEnabled())) {
      payload.field_modes = fieldModes;
    }
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
    // คืนรายการที่ระบบปรับค่าให้ด้วย — ผู้ใช้ควรรู้ว่าเราแก้อะไรไป ไม่ใช่แก้เงียบ ๆ
    return { id: declId, codeFixes: codeFixes.map((f) => ({ label: f.label, from: f.from, to: f.to })) };
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
  const hasJson = await extraFieldsEnabled("declaration_items");
  // ฟอร์มใหม่ส่ง key ของ registry (เช่น item_net_weight_kg → คอลัมน์ net_weight_kg)
  //   → แยกเป็นคอลัมน์จริง + extra_fields ก่อนประกอบแถว
  const splits = await Promise.all(items.map((it) => splitRecord(it, "item", ["line_no", "is_foc"])));
  const rows = items.map((it, i) => {
    const row: Record<string, unknown> = {
      declaration_id: declId,
      // ⚠ ไล่เลขลำดับใหม่เสมอตามลำดับที่ส่งมา — ไม่ใช้ line_no ที่ AI ให้มา
      //   AI เคยให้เลขซ้ำ (เช่น 1,2,2) แล้วรายการหายไปตอนเรียงลำดับ/แสดงผล
      line_no: i + 1,
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
    // ค่าที่มาจากฟอร์มใหม่ (key ของ registry) — เขียนทับเฉพาะคอลัมน์ที่ DB มีจริง
    const okCols = new Set<string>([
      "description_eng", "brand_name", "container_or_volume_qty", "container_unit_code",
      "net_weight_kg", "gross_weight_kg", "net_weight_ton", "amount", "is_foc",
      ...(hasExtra ? ["export_tariff", "customs_unit_code"] : []),
      ...(hasMulti ? ["description_eng_field", "net_weight_unit_code", "insurance", "product_description_thai"] : []),
    ]);
    for (const [c, v] of Object.entries(splits[i].columns)) {
      if (okCols.has(c)) row[c] = v ?? null;
    }
    // ช่อง Page 3 ที่ยังไม่มีคอลัมน์จริง (พิกัด/สิทธิ/ต้นกำเนิด/หมายเหตุ ฯลฯ)
    if (hasJson && Object.keys(splits[i].extra).length) row.extra_fields = splits[i].extra;
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

// คอลัมน์ extra_fields (jsonb) — sql/11 · ใช้เก็บทุกช่อง DCTK ที่ยังไม่มีคอลัมน์จริง
//   graceful: ถ้ายังไม่ได้รัน sql/11 ระบบทำงานต่อได้ (แค่ไม่เก็บช่องใหม่)
const _extraJson: { [table: string]: boolean } = {};
export async function extraFieldsEnabled(table: "declarations" | "declaration_items"): Promise<boolean> {
  if (table in _extraJson) return _extraJson[table];
  const sb = getClient();
  if (!sb) { _extraJson[table] = false; return false; }
  const { error } = await sb.from(table).select("extra_fields").limit(1);
  _extraJson[table] = !error;
  if (error) console.warn(`[supabase] ${table}.extra_fields ยังไม่มี — โปรดรัน sql/11_extra_fields_and_masters.sql`);
  return _extraJson[table];
}

// คอลัมน์ field_modes (jsonb) — sql/11 · โหมดรายช่องที่คัดลอกมาจาก Master
let _fieldModesOk: boolean | null = null;
export async function fieldModesEnabled(): Promise<boolean> {
  if (_fieldModesOk !== null) return _fieldModesOk;
  const sb = getClient();
  if (!sb) { _fieldModesOk = false; return false; }
  const { error } = await sb.from("declarations").select("field_modes").limit(1);
  _fieldModesOk = !error;
  return _fieldModesOk;
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

/**
 * เลือก Master ที่เหมาะกับใบนี้แล้วผสมค่าลงไป
 *
 * ลำดับการเลือก:
 *   1. Master ที่ผู้ใช้เลือกเองตอนอัปโหลด (templateId) — ชนะทุกอย่าง ไม่ต้องเดา
 *   2. จับคู่ 3 ระดับ: ลูกค้า → consignee → รหัสสินค้า (ตามที่ตกลงในที่ประชุม)
 *   3. Master ค่าเริ่มต้นของลูกค้า
 * โหมดรายช่องตัดสินว่าใช้ค่าไหน: 'master' ทับค่า AI · 'ai' เติมเฉพาะช่องว่าง · 'off' ไม่กรอก
 *
 * แยกออกมาเป็นฟังก์ชันเพราะเดิมโค้ดนี้ฝังอยู่ใน insertDeclaration ตัวเดียว
 * ซึ่ง "ไม่มีใครเรียก" → การอัปโหลดเอกสารจึงไม่เคยใช้ Master เลย
 */
export async function applyMasterToRecord(
  record: Record<string, unknown> & { _items?: Record<string, unknown>[] },
  customer: string,
  invoice: string,
  templateId?: string,
): Promise<{
  record: Record<string, unknown> & { _items?: Record<string, unknown>[] };
  fieldModes?: { [k: string]: FieldMode };
  templateName?: string;
}> {
  const consigneeName = String(record.consignee_name ?? "");
  const destCountry = String(record.destination_country_code ?? record.dest_country_code ?? "");
  const productCodes = (record._items ?? [])
    .map((it) => String((it as Record<string, unknown>).description_eng ?? ""))
    .filter(Boolean);

  let tpl: DeclarationTemplate | null = null;
  if (templateId) {
    tpl = await getTemplate(templateId);
    if (tpl) console.log(`[master] ใช้ Master ที่ผู้ใช้เลือก: "${tpl.name}"`);
    else console.warn(`[master] ไม่พบ Master id=${templateId} — ถอยไปจับคู่อัตโนมัติ`);
  }
  if (!tpl) {
    tpl = (await templateLevelsEnabled())
      ? (await findBestTemplate(customer, consigneeName, productCodes, destCountry)) ?? (await getDefaultTemplate(customer))
      : await getDefaultTemplate(customer);
  }
  if (!tpl) return { record };

  const cur = await rowToFields(record, "header");             // คอลัมน์ → key ของ registry
  const applied = applyTemplate(tpl, cur, { includeItems: false });
  const split = await splitRecord(applied.record, "header");   // กลับเป็นคอลัมน์ + extra
  const out: Record<string, unknown> & { _items?: Record<string, unknown>[] } = {
    ...record,
    ...split.columns,
    extra_fields: { ...((record.extra_fields ?? {}) as object), ...split.extra },
  };
  // ── รายการสินค้า ────────────────────────────────────────────────────
  //   เดิมเป็นแบบ "ทั้งหมดหรือไม่เอาเลย": ถ้า AI อ่านรายการได้ ค่าของ Master จะไม่ถูกใช้เลย
  //   ซึ่งทำให้ พิกัดศุลกากร / หน่วย / รหัสสินค้า ที่ตั้งไว้ใน Master ไม่มีผลกับใบที่มาจากเอกสาร
  //   (ตรงข้ามกับที่ตกลงไว้ว่า "ของตายตัวต่อ consignee ให้มาจาก Master")
  //   → ผสมทีละช่องตามโหมด: master = ทับค่า AI · ai = เติมเฉพาะช่องว่าง · off = ไม่กรอก
  const tplItems = tpl.items ?? [];
  if (!(record._items?.length)) {
    if (tplItems.length) out._items = tplItems.map((it) => ({ ...it }));
  } else if (tplItems.length) {
    const aiItems = record._items as Record<string, unknown>[];
    out._items = await Promise.all(aiItems.map(async (aiIt, i) => {
      // จับคู่แถวใน Master ด้วย "ชื่อสินค้า" ไม่ใช่ "ลำดับที่"
      //   ชิปเมนต์แต่ละครั้งมีสินค้าไม่เหมือนกันและไม่เรียงเหมือนกัน
      //   (เจอจริง CTN2649: เอกสารมี น้ำมะพร้าว → ครีมสมูทตี้ → ตัวอย่าง
      //    แต่ Master เรียง น้ำมะพร้าว250 → น้ำมะพร้าว500 → ครีม → ตัวอย่าง ×2
      //    จับคู่ตามลำดับแล้วได้ชื่อสินค้าของแถวอื่นมาทับ ผิดทั้งใบ)
      const raw = pickMasterItem(aiIt, tplItems);
      // ระดับรายการเอาเฉพาะช่องโหมด "ใช้ค่า Master" เท่านั้น — ไม่เติมช่องว่างจาก Master
      //   เพราะช่องที่ว่างในรายการมักเป็นยอดเงิน/ปริมาณของชิปเมนต์นั้น
      //   ถ้าเอาค่าเก่ามาเติม จะได้ยอดที่ไม่ตรงกับหัวใบ แล้ว DCTK ตีกลับตอนกระทบยอด
      //   (เจอจริง: ค่าระวางหัวใบ 140 แต่รายการกลายเป็น 260 ของใบต้นแบบ)
      const base: Record<string, unknown> = {};
      for (const k of Object.keys(raw)) {
        // ⚠ effectiveMode() เดาโหมดปริยายจาก tpl.header — ใช้กับช่อง "ในรายการ" ไม่ได้
        //   เพราะค่าของรายการอยู่ใน tpl.items ไม่ใช่ header → จะได้ 'ai' หมดแล้วไม่มีอะไรผ่านเลย
        //   ที่ถูกคือ: ตั้งไว้ชัดเจนก็ใช้ตามนั้น · ไม่ได้ตั้งแต่รายการมีค่า = "ใช้ค่า Master"
        const set = tpl.field_modes?.[k];
        const mode = (set === "master" || set === "ai" || set === "off")
          ? set
          : (String((raw as Record<string, unknown>)[k] ?? "").trim() ? "master" : "ai");
        if (mode === "master") base[k] = (raw as Record<string, unknown>)[k];
      }
      const cur = await rowToFields(aiIt, "item");
      const merged = applyTemplate({ ...tpl, header: base }, cur, { includeItems: false });
      const sp = await splitRecord(merged.record, "item", ["line_no", "is_foc"]);
      return {
        ...aiIt,
        ...sp.columns,
        extra_fields: { ...((aiIt.extra_fields ?? {}) as object), ...sp.extra },
      };
    }));
    console.log(`[master] ผสมค่าจาก Master ลงรายการสินค้า ${aiItems.length} รายการ`);
  }
  const changed = applied.overridden.length + applied.filled.length;
  if (changed) {
    console.log(`[master] ใช้ Master "${tpl.name}" กับ ${customer}/${invoice} — ทับ ${applied.overridden.length} · เติม ${applied.filled.length} ช่อง`);
  }
  return { record: out, fieldModes: applied.fieldModes, templateName: tpl.name };
}

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
    // ── ผสม Master ที่ตั้งเป็นค่าเริ่มต้นของลูกค้า (ถ้ามี) ──────────────
    //   โหมดรายช่องตัดสินว่าใช้ค่าไหน: 'master' ทับค่า AI · 'ai' เติมเฉพาะช่องว่าง · 'off' ไม่กรอก
    let rec: Record<string, unknown> & { _items?: Record<string, unknown>[] } = record;
    const applied = await applyMasterToRecord(record, customer, invoice);
    let fieldModes = applied.fieldModes;
    rec = applied.record;

    // ── กระทบยอด/จัดรูปรายการ เหมือนทางอัปโหลดเอกสาร ────────────────
    //   เดิมทางนี้ (Get Email) ข้ามไปทั้งชุด ใบที่มาจากอีเมลจึงไม่ได้กระทบยอด
    //   จำนวนหีบห่อ/น้ำหนัก และรายการยังติดสกุลเงินของ Master → DCTK ตีกลับหน้า 3
    reconcilePackageCount(rec);
    reconcileWeights(rec);
    reconcileItemAmounts(rec, await extraAmountAlloc(customer));
    normalizeItemText(rec);

    const payload: Record<string, unknown> = {};
    for (const col of DECL_COLUMNS) payload[col] = rec[col] ?? null;
    // extra columns — ใส่เฉพาะที่ DB มีจริง (graceful)
    const extra = await availableExtraColumns();
    for (const col of extra) if (rec[col] != null) payload[col] = rec[col];
    // ช่องที่ยังไม่มีคอลัมน์จริง → extra_fields jsonb
    const extraJson = (rec.extra_fields ?? {}) as Record<string, unknown>;
    if (Object.keys(extraJson).length && (await extraFieldsEnabled("declarations"))) {
      payload.extra_fields = extraJson;
    }
    if (fieldModes && Object.keys(fieldModes).length && (await fieldModesEnabled())) {
      payload.field_modes = fieldModes;
    }
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

    const items = rec._items ?? [];
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
  // ฟอร์มใหม่: key ของ registry → คอลัมน์จริง + ช่องที่ไม่มีคอลัมน์ → extra_fields
  const split = await splitRecord(patch, "header");
  for (const [c, v] of Object.entries(split.columns)) {
    if (allowed.has(c)) clean[c] = v === "" ? null : v;
  }
  if (Object.keys(split.extra).length && (await extraFieldsEnabled("declarations"))) {
    // merge กับของเดิม (ฟอร์มอาจส่งมาบางส่วน — ห้ามล้างช่องอื่นที่ไม่ได้แก้)
    const cur = await sb.from("declarations").select("extra_fields").eq("id", id).maybeSingle();
    const before = (cur.data?.extra_fields ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...before };
    for (const [k, v] of Object.entries(split.extra)) {
      if (v === "" || v === null || v === undefined) delete merged[k];  // ล้างค่า = ลบ key
      else merged[k] = v;
    }
    clean.extra_fields = merged;
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

// ============================================================
//  Master ข้อมูล (declaration_templates) — sql/11
//  ชุดค่าตั้งต้นที่บันทึกไว้ ใช้สร้างใบใหม่ / เติมช่องว่างให้ใบที่มาจากอีเมล
//  field_modes = โหมดรายช่อง:
//    'master' ใช้ค่าใน Master เสมอ (ทับค่าที่ AI สกัดมา)
//    'ai'     ปล่อยให้ AI สกัด — Master เติมให้เฉพาะตอนที่ AI ไม่ได้ค่า
//    'off'    ไม่กรอกช่องนี้
// ============================================================
export type FieldMode = "master" | "ai" | "off";

export interface DeclarationTemplate {
  id?: string;
  name: string;
  customer_name: string;
  description?: string | null;
  /** ระดับ 2 — consignee ที่ Master นี้ใช้ได้ (ว่าง = ทุกราย) */
  consignee_names?: string[];
  /** ระดับ 3 — รหัสสินค้าที่ Master นี้ใช้ได้ (ว่าง = ทุกสินค้า) */
  product_codes?: string[];
  /** ลำดับความสำคัญเมื่อคะแนนเท่ากัน */
  priority?: number;
  source?: Record<string, unknown>;
  header: Record<string, unknown>;
  items: Record<string, unknown>[];
  field_modes: { [key: string]: FieldMode };
  is_default: boolean;
  created_at?: string;
  updated_at?: string;
}

let _templatesOk: boolean | null = null;
/** ตารางคลัง Master มีจริงไหม (รัน sql/11 แล้วหรือยัง) */
export async function templatesEnabled(): Promise<boolean> {
  if (_templatesOk !== null) return _templatesOk;
  const sb = getClient();
  if (!sb) { _templatesOk = false; return false; }
  const { error } = await sb.from("declaration_templates").select("id").limit(1);
  _templatesOk = !error;
  if (error) console.warn("[supabase] ยังไม่มีตาราง declaration_templates — โปรดรัน sql/11_extra_fields_and_masters.sql");
  return _templatesOk;
}

export async function listTemplates(customer?: string): Promise<DeclarationTemplate[]> {
  const sb = getClient();
  if (!sb || !(await templatesEnabled())) return [];
  try {
    let q = sb.from("declaration_templates").select("*").order("updated_at", { ascending: false });
    if (customer) q = q.eq("customer_name", customer);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as DeclarationTemplate[];
  } catch (err) {
    console.error("[supabase] listTemplates error:", errMsg(err));
    return [];
  }
}

export async function getTemplate(id: string): Promise<DeclarationTemplate | null> {
  const sb = getClient();
  if (!sb || !id || !(await templatesEnabled())) return null;
  try {
    const { data, error } = await sb.from("declaration_templates").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return (data ?? null) as DeclarationTemplate | null;
  } catch (err) {
    console.error("[supabase] getTemplate error:", errMsg(err));
    return null;
  }
}

/** Master ที่ตั้งเป็นค่าเริ่มต้นของลูกค้า (ใช้เติมใบที่มาจากอีเมลอัตโนมัติ) */
export async function getDefaultTemplate(customer: string): Promise<DeclarationTemplate | null> {
  const sb = getClient();
  if (!sb || !customer || !(await templatesEnabled())) return null;
  try {
    const { data, error } = await sb.from("declaration_templates").select("*")
      .eq("customer_name", customer).eq("is_default", true).maybeSingle();
    if (error) throw error;
    return (data ?? null) as DeclarationTemplate | null;
  } catch (err) {
    console.error("[supabase] getDefaultTemplate error:", errMsg(err));
    return null;
  }
}

/** สร้าง/แก้ Master — ส่ง id มา = แก้ของเดิม, ไม่ส่ง = สร้างใหม่ */
export async function saveTemplate(
  t: Partial<DeclarationTemplate> & { name: string },
  userId?: string | null,
): Promise<DeclarationTemplate | null> {
  const sb = getClient();
  if (!sb || !(await templatesEnabled())) return null;
  const payload: Record<string, unknown> = {
    name: t.name,
    customer_name: t.customer_name ?? "",
    description: t.description ?? null,
    header: t.header ?? {},
    items: t.items ?? [],
    field_modes: t.field_modes ?? {},
    is_default: !!t.is_default,
  };
  // ฟิลด์ 3 ระดับ (sql/12) — ใส่เฉพาะเมื่อ DB มีคอลัมน์แล้ว กันพังถ้ายังไม่ได้รัน
  if (await templateLevelsEnabled()) {
    payload.consignee_names = (t.consignee_names ?? []).map((x) => String(x).trim()).filter(Boolean);
    payload.product_codes = (t.product_codes ?? []).map((x) => String(x).trim()).filter(Boolean);
    payload.priority = Number(t.priority ?? 0);
    if (t.source) payload.source = t.source;
  }
  try {
    // 1 ลูกค้ามี default ได้อันเดียว → ปลด default เดิมก่อน (unique index จะไม่ให้ insert ซ้อน)
    if (payload.is_default && payload.customer_name) {
      let clear = sb.from("declaration_templates").update({ is_default: false })
        .eq("customer_name", payload.customer_name).eq("is_default", true);
      if (t.id) clear = clear.neq("id", t.id);
      await clear;
    }
    if (t.id) {
      const { data, error } = await sb.from("declaration_templates")
        .update(payload).eq("id", t.id).select().single();
      if (error) throw error;
      return data as DeclarationTemplate;
    }
    payload.created_by = userId ?? null;
    const { data, error } = await sb.from("declaration_templates")
      .insert(payload).select().single();
    if (error) throw error;
    return data as DeclarationTemplate;
  } catch (err) {
    console.error("[supabase] saveTemplate error:", errMsg(err));
    return null;
  }
}


let _tplLevels: boolean | null = null;
/** ตาราง Master มีคอลัมน์ 3 ระดับแล้วไหม (รัน sql/12 หรือยัง) */
export async function templateLevelsEnabled(): Promise<boolean> {
  if (_tplLevels !== null) return _tplLevels;
  const sb = getClient();
  if (!sb) { _tplLevels = false; return false; }
  const { error } = await sb.from("declaration_templates").select("consignee_names").limit(1);
  _tplLevels = !error;
  if (error) console.warn("[supabase] Master ยังไม่มีคอลัมน์ 3 ระดับ — โปรดรัน sql/12_master_3_levels.sql");
  return _tplLevels;
}

/**
 * เลือก Master ที่ "ตรงที่สุด" สำหรับใบนี้ — ตามที่ตกลงในที่ประชุม (3 ระดับ)
 *   คะแนน = ตรงรหัสสินค้า ×4 + ตรง consignee ×2 + เป็นค่าเริ่มต้น ×1 + priority
 *   ไม่ตรงเลยและไม่ใช่ค่าเริ่มต้น = ไม่เอา (กัน Master ของ consignee อื่นมาใช้ผิด)
 */
export function scoreTemplate(
  t: DeclarationTemplate,
  consignee: string,
  productCodes: string[],
  destCountry = "",
): number | null {
  const norm = (s: unknown) => String(s ?? "").trim().toUpperCase();
  const cons = norm(consignee);
  const prods = new Set(productCodes.map(norm).filter(Boolean));
  const tCons = (t.consignee_names ?? []).map(norm).filter(Boolean);
  const tProds = (t.product_codes ?? []).map(norm).filter(Boolean);

  // เทียบชื่อผู้รับสินค้าแบบ "ผ่อนปรน" — AI อ่านชื่อมาสั้น/ยาวกว่าที่บันทึกไว้ได้
  //   (เจอจริง: Master เก็บ "AL ACCAD DEPARTMENT STORE OWNED BY ORGANIC F AND C"
  //    แต่ในเอกสารเขียนแค่ "AL ACCAD DEPARTMENT STORE" → เทียบเป๊ะแล้วไม่ตรง Master ถูกทิ้ง)
  //   ยังไม่เดาสุ่ม: ต้องมีฝ่ายหนึ่งเป็นส่วนขึ้นต้นของอีกฝ่าย และยาวพอที่จะไม่บังเอิญ
  const consHit = (a: string, b: string) =>
    a === b || (a.length >= 8 && b.length >= 8 && (a.startsWith(b) || b.startsWith(a)));

  // null = Master ไม่ได้ระบุระดับนี้ → ใช้ได้กับทุกค่า
  const consMatch = tCons.length ? (!!cons && tCons.some((c) => consHit(c, cons))) : null;

  // ชื่อสินค้าเทียบเป๊ะไม่ได้ — ชื่อที่ลงทะเบียนใน DCTK กับที่เขียนในใบกำกับคนละแบบเสมอ
  //   DCTK "REFINED BLEACHED"        ↔ ใบกำกับ "REFINED BLEACHED DEODORIZED SOYBEAN OIL (RBDSBO)"
  //   DCTK "FROZEN COCONUT WATER"    ↔ ใบกำกับ "100% Raw Coconut Water by Mono 470ml"
  //   → ให้คะแนนความใกล้เคียงด้วยคำที่ใช้ร่วมกัน แทนการเทียบตัวอักษร
  //   วัดแบบ "คำที่ตรงกัน ÷ จำนวนคำของฝั่งที่สั้นกว่า" เพราะฝั่ง DCTK มักสั้นกว่ามาก
  const words = (s: string) =>
    new Set(s.replace(/[^A-Z0-9ก-๙ ]/g, " ").split(/\s+/).filter((w) => w.length >= 2));
  const similarity = (a: string, b: string): number => {
    const A = words(a), B = words(b);
    if (!A.size || !B.size) return 0;
    let hit = 0;
    for (const w of A) if (B.has(w)) hit++;
    return hit / Math.min(A.size, B.size);
  };
  const prodSim = tProds.length && prods.size
    ? Math.max(...tProds.map((p) => Math.max(...[...prods].map((q) => similarity(p, q)))))
    : null;

  // ผู้รับสินค้าระบุไว้แล้วไม่ตรง → ใช้ Master นี้ไม่ได้ (ชื่อผู้รับเชื่อถือได้)
  if (consMatch === false) return null;
  // สินค้าคนละอย่างชัดเจน (แทบไม่มีคำร่วมกันเลย) → ไม่ใช้
  //   กันเคสผู้รับรายเดียวซื้อหลายสินค้า แล้วเอา Master ของสินค้าอื่นมาใส่พิกัดผิด
  if (prodSim !== null && prodSim < 0.25) return null;

  // ประเทศปลายทาง — ใช้ "เพิ่มคะแนน" อย่างเดียว ไม่ใช้ตัดทิ้ง
  //   จำเป็นเมื่อผู้รับรายเดียวส่งหลายประเทศ (เจอจริง: FFF ส่งทั้ง NL และ IT)
  //   ไม่ใช้ตัดทิ้งเพราะ AI มักสับสนระหว่าง "ประเทศของผู้รับ" กับ "ประเทศปลายทาง"
  const tDest = norm((t.header ?? {}).dest_country_code);
  const destMatch = tDest && norm(destCountry) ? tDest === norm(destCountry) : null;

  let score = 0;
  if (prodSim !== null) score += prodSim >= 0.6 ? 4 : prodSim >= 0.4 ? 2 : 1;  // ระดับ 3 = สินค้า
  if (destMatch === true) score += 3;      // ปลายทางตรง
  if (consMatch === true) score += 2;      // ระดับ 2 ตรง
  if (t.is_default) score += 1;            // ค่าเริ่มต้นของลูกค้า
  score += Number(t.priority ?? 0);
  // ไม่ตรงอะไรเลยและไม่ใช่ค่าเริ่มต้น → ไม่เดาสุ่ม
  return score === 0 ? null : score;
}

export async function findBestTemplate(
  customer: string,
  consignee: string,
  productCodes: string[] = [],
  destCountry = "",
): Promise<DeclarationTemplate | null> {
  if (!customer) return null;
  const all = await listTemplates(customer);
  if (!all.length) return null;
  let best: { score: number; tpl: DeclarationTemplate } | null = null;
  for (const t of all) {
    const score = scoreTemplate(t, consignee, productCodes, destCountry);
    if (score === null) continue;
    if (!best || score > best.score) best = { score, tpl: t };
  }
  if (best) {
    console.log(`[master] เลือก "${best.tpl.name}" (คะแนน ${best.score}) สำหรับ ${customer}/${consignee || "-"}${destCountry ? " → " + destCountry : ""}`);
  }
  return best?.tpl ?? null;
}

export async function deleteTemplate(id: string): Promise<boolean> {
  const sb = getClient();
  if (!sb || !id || !(await templatesEnabled())) return false;
  try {
    const { error } = await sb.from("declaration_templates").delete().eq("id", id);
    if (error) throw error;
    return true;
  } catch (err) {
    console.error("[supabase] deleteTemplate error:", errMsg(err));
    return false;
  }
}
