// ============================================================
//  Data loading — Google Sheet (gviz CSV) + Excel + rules
//  (ported 1:1 from rpa_import.py)
// ============================================================
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { log } from "./helpers.js";
import type { AppConfig, Record } from "./types.js";

// Mapping จาก header ใน Google Sheet "รายการ" → key ภายในสคริปต์
export const SHEET_HEADER_MAP: { [k: string]: string } = {
  customer_name: "company_search",
  consignee_name: "consignee",
  exporter_name: "exporter_name",
  part_number: "part_number",
  buyer_country_code: "pur_country",
  destination_country_code: "dest_country",
  invoice_number: "invoice_no",
  invoice_date: "invoice_date",
  tax_payment_method_code: "tax_payment_code",
  vessel_name: "vessel_name",
  voyage_number: "voyage",
  etd: "etd_date",
  release_port_code: "paperless_code",
  loading_port_code: "loading_code",
  incoterms: "term",
  currency: "currency",
  total_goods_amount: "amount",
  freight_charge: "freight",
  insurance_charge: "insurance",
  shipping_mark: "shipping_mark",
  description_eng: "description",
  net_weight_ton: "net_weight_ton",
  net_weight_unit_code: "unit_code",
  customs_unit_code: "customs_unit_code", // หน่วยปริมาณในใบขน (ต้องตรงหน่วยหลังพิกัด เช่น C62) — ตั้งเป็น preset ต่อลูกค้า
  freight_alloc: "freight_alloc",         // วิธีกระจายค่าระวางต่อรายการ Page 3: zero|first|each — preset ต่อลูกค้า
  // ช่อง Page 1 เพิ่มเติม (จาก inspect)
  transport_mode: "transport_mode",       // วิธีขนส่ง (dropdown)
  mawb: "mawb",                           // เลขขนส่งทางอากาศ
  hawb: "hawb",                           // HAWB/BL
  reference_no: "reference_no",           // เลขอ้างอิงในการขนส่ง
  exdec_doc_type: "exdec_doc_type",       // ชนิดเอกสารใบขนขาออก (dropdown)
  // ช่องบังคับ Page 3
  export_tariff: "export_tariff",                   // ประเภทพิกัดขาออก (combo) — preset ต่อลูกค้า
  product_description_thai: "product_description_thai", // คำอธิบายสินค้าภาษาไทย — preset/AI
  net_weight_kg: "net_weight_kg",
  gross_weight_kg: "gross_weight_kg",
  container_or_volume_qty: "volume",
  container_unit_code: "container_unit",
};

/** ดึงเฉพาะส่วน key ภาษาอังกฤษหน้าวงเล็บ (Python _normalize_header) */
export function normalizeHeader(h: string): string {
  return h.trim().split(/[\s(（]/, 1)[0].trim();
}

/** แปลง row จาก Google Sheet → record ที่ fill_* ใช้ (Python _map_sheet_row) */
function mapSheetRow(row: { [k: string]: string }): Record {
  const out: Record = {};
  for (const [sheetKey, value] of Object.entries(row)) {
    const norm = normalizeHeader(sheetKey);
    if (norm in SHEET_HEADER_MAP) {
      out[SHEET_HEADER_MAP[norm]] = value;
    }
  }
  return out;
}

/** RFC-4180 CSV parser (รองรับ quoted fields ที่มี comma/newline) */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  // ตัด BOM ถ้ามี
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // flush ตัวสุดท้าย
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** โหลด sheet เป็น list-of-rows ผ่าน gviz CSV endpoint (Python _fetch_sheet_csv) */
async function fetchSheetCsv(
  sheetId: string,
  sheetName: string,
): Promise<string[][]> {
  const url =
    `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq` +
    `?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} โหลด sheet '${sheetName}' ไม่สำเร็จ`);
  }
  const text = await resp.text();
  return parseCsv(text);
}

function isTruthy(v: unknown): boolean {
  return ["TRUE", "1", "YES", "Y", "✓", "CHECKED"].includes(
    String(v).trim().toUpperCase(),
  );
}

/** โหลดชีท 'การกรอกข้อมูล' → {customer: set ของ field ที่ต้องกรอก} */
export async function loadFieldRules(
  sheetId: string,
  sheetName: string,
): Promise<{ [cust: string]: Set<string> }> {
  log(`โหลด field rules: ${sheetName}`);
  const rows = await fetchSheetCsv(sheetId, sheetName);
  if (rows.length === 0) return {};
  const headers = rows[0].map((h) => h.trim());
  const out: { [cust: string]: Set<string> } = {};
  for (const r of rows.slice(1)) {
    if (!r || !r[0] || !r[0].trim()) continue;
    const cust = r[0].trim();
    const allowed = new Set<string>();
    for (let i = 1; i < headers.length; i++) {
      const col = headers[i];
      if (i < r.length && isTruthy(r[i])) allowed.add(col);
    }
    out[cust] = allowed;
  }
  log(`  ✓ ได้ rules ของ ${Object.keys(out).length} ลูกค้า`);
  return out;
}

/** โหลดชีท 'Customer_Rule' → {customer: {รายละเอียด}} */
export async function loadCustomerRules(
  sheetId: string,
  sheetName: string,
): Promise<{ [cust: string]: { [k: string]: string } }> {
  log(`โหลด customer rules: ${sheetName}`);
  const rows = await fetchSheetCsv(sheetId, sheetName);
  if (rows.length === 0) return {};
  const headers = rows[0].map((h) => h.trim());
  const out: { [cust: string]: { [k: string]: string } } = {};
  for (const r of rows.slice(1)) {
    const d: { [k: string]: string } = {};
    for (let i = 0; i < headers.length; i++) {
      d[headers[i]] = i < r.length ? r[i].trim() : "";
    }
    const cust = (d["Customer_Name"] || "").trim();
    if (!cust) continue;
    out[cust] = d;
  }
  log(`  ✓ ได้ rules ของ ${Object.keys(out).length} ลูกค้า`);
  return out;
}

/** หา key ที่ตรงกับ customer_name (case-insensitive, contains-match) */
export function matchCustomerKey(
  customerName: string,
  keys: Iterable<string>,
): string | null {
  const cn = customerName.trim().toUpperCase();
  if (!cn) return null;
  for (const k of keys) {
    const ku = k.trim().toUpperCase();
    if (ku === cn || cn.includes(ku) || ku.includes(cn)) return k;
  }
  return null;
}

/** โหลด Google Sheet 'รายการ' (Python load_records_from_sheet) */
export async function loadRecordsFromSheet(
  sheetId: string,
  sheetName: string,
): Promise<Record[]> {
  log(`โหลด Google Sheet: ${sheetName}`);
  const rows = await fetchSheetCsv(sheetId, sheetName);
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  const out: Record[] = [];
  let skippedDone = 0;

  for (const r of rows.slice(1)) {
    if (r.every((c) => c === null || c === undefined || c.trim() === "")) continue;

    const raw: { [k: string]: string } = {};
    for (let i = 0; i < headers.length; i++) {
      raw[headers[i]] = i < r.length ? r[i].trim() : "";
    }

    // ต้องมี customer_name ที่ไม่ว่าง
    const hasCustomer = Object.entries(raw).some(
      ([k, v]) => normalizeHeader(k) === "customer_name" && v,
    );
    if (!hasCustomer) continue;

    if ((raw["สถานะการสร้างเอกสาร"] || "").trim().toLowerCase() === "true") {
      skippedDone++;
      continue;
    }

    const rec = mapSheetRow(raw);
    rec.__raw_row__ = raw;
    out.push(rec);
  }

  if (skippedDone) {
    log(`  ↷ ข้าม ${skippedDone} แถว (สถานะการสร้างเอกสาร = TRUE)`);
  }
  log(`  ✓ ได้ ${out.length} แถวที่ใช้ได้`);
  return out;
}

/**
 * โหลด records จาก Supabase declarations (doc_status = false)
 * map DB columns → internal keys ผ่าน SHEET_HEADER_MAP เหมือน Google Sheet
 * คืน [] ถ้าไม่ได้ตั้งค่า env หรือ error (ให้ caller fallback)
 */
export async function loadRecordsFromSupabase(): Promise<Record[]> {
  const url = (process.env.SUPABASE_URL ?? "").trim();
  const key = (process.env.SUPABASE_SERVICE_KEY ?? "").trim();
  if (!url || !key) return [];

  log("โหลดจาก Supabase: declarations (doc_status=false)");
  try {
    const endpoint =
      `${url}/rest/v1/declarations` +
      `?select=*&doc_status=eq.false&order=created_at.asc`;
    const resp = await fetch(endpoint, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) {
      log(`  ⚠ Supabase HTTP ${resp.status} — fallback`);
      return [];
    }
    const rows = (await resp.json()) as { [k: string]: unknown }[];
    const out: Record[] = [];
    for (const raw of rows) {
      // ต้องมี customer_name
      if (!raw.customer_name || String(raw.customer_name).trim() === "") continue;
      const rec = mapSheetRow(
        Object.fromEntries(
          Object.entries(raw).map(([k, v]) => [k, v == null ? "" : String(v)]),
        ),
      );
      rec.__raw_row__ = Object.fromEntries(
        Object.entries(raw).map(([k, v]) => [k, v == null ? "" : String(v)]),
      );
      rec.__supabase_id__ = raw.id; // ไว้ mark doc_status หลังทำเสร็จ
      out.push(rec);
    }

    // ดึง declaration_items ของทุก declaration ที่โหลดมา แล้วแนบเป็น __items__
    await attachDeclarationItems(out, url, key);

    log(`  ✓ ได้ ${out.length} แถวจาก Supabase`);
    return out;
  } catch (ex) {
    log(`  ⚠ โหลดจาก Supabase ไม่สำเร็จ: ${ex} — fallback`);
    return [];
  }
}

/**
 * map 1 แถว declaration_items (DB) → ฟิลด์ภายในที่ Page 3 ใช้
 * (ชื่อ DB ตรงตาม [[declarations-schema]] — declaration_items)
 */
export function mapItemRow(it: { [k: string]: unknown }): Record {
  const s = (v: unknown): string => (v == null ? "" : String(v));
  return {
    line_no: it.line_no,
    description: s(it.description_eng),            // รหัสสินค้า (combo เลือก master)
    // คำอธิบายอังกฤษ "อิสระ" ต่อรายการ (text แยกจาก combo) — เคส COCO รหัสเดียวกันแต่คำอธิบายต่างกัน
    description_eng_field: s(it.description_eng_field),
    product_description_thai: s(it.product_description_thai),
    brand_name: s(it.brand_name),
    volume: s(it.container_or_volume_qty),
    container_unit: s(it.container_unit_code),
    net_weight_kg: s(it.net_weight_kg),
    gross_weight_kg: s(it.gross_weight_kg),
    net_weight_ton: s(it.net_weight_ton),
    unit_code: s(it.net_weight_unit_code),        // หน่วยน้ำหนัก/ปริมาณ ต่อรายการ
    amount: s(it.amount),
    insurance: s(it.insurance),                    // ค่าประกัน ต่อรายการ
    // พิกัด/หน่วยต่อรายการ (ใบที่มีหลายพิกัด เช่น ไข่ไก่ 04072100 + ไข่เป็ด 04072910)
    export_tariff: s(it.export_tariff),
    customs_unit_code: s(it.customs_unit_code),
    is_foc: it.is_foc === true || s(it.is_foc).toLowerCase() === "true",
  };
}

/**
 * ดึง declaration_items ของทุก record (1 fetch รวม) แล้วแนบเป็น __items__
 * ถ้า declaration ไหนไม่มี items → __items__ = [] (caller จะ fallback ใช้ค่าหัวรายการ)
 */
async function attachDeclarationItems(
  records: Record[],
  url: string,
  key: string,
): Promise<void> {
  const ids = records
    .map((r) => r.__supabase_id__)
    .filter((id): id is string => id != null && String(id).trim() !== "")
    .map((id) => String(id));
  if (ids.length === 0) return;

  try {
    const inList = ids.map((id) => `"${id}"`).join(",");
    const endpoint =
      `${url}/rest/v1/declaration_items` +
      `?select=*&declaration_id=in.(${encodeURIComponent(inList)})` +
      `&order=declaration_id.asc,line_no.asc`;
    const resp = await fetch(endpoint, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) {
      log(`  ⚠ โหลด declaration_items HTTP ${resp.status} — ใช้ค่าหัวรายการแทน`);
      return;
    }
    const items = (await resp.json()) as { [k: string]: unknown }[];

    // จัดกลุ่มตาม declaration_id
    const byDecl = new Map<string, Record[]>();
    for (const it of items) {
      const did = String(it.declaration_id ?? "");
      if (!did) continue;
      if (!byDecl.has(did)) byDecl.set(did, []);
      byDecl.get(did)!.push(mapItemRow(it));
    }

    let totalItems = 0;
    for (const r of records) {
      const did = String(r.__supabase_id__ ?? "");
      const list = byDecl.get(did) ?? [];
      r.__items__ = list;
      totalItems += list.length;
    }
    log(`  ✓ ได้ ${totalItems} รายการสินค้า (declaration_items) จาก ${byDecl.size} ใบ`);
  } catch (ex) {
    log(`  ⚠ โหลด declaration_items ไม่สำเร็จ: ${ex} — ใช้ค่าหัวรายการแทน`);
  }
}

/** mark declaration ว่าทำเอกสารแล้ว (doc_status=true) */
export async function markDeclarationDone(id: unknown): Promise<void> {
  const url = (process.env.SUPABASE_URL ?? "").trim();
  const key = (process.env.SUPABASE_SERVICE_KEY ?? "").trim();
  if (!url || !key || id == null) return;
  try {
    await fetch(`${url}/rest/v1/declarations?id=eq.${encodeURIComponent(String(id))}`, {
      method: "PATCH",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ doc_status: true }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (ex) {
    log(`  ⚠ mark declaration done ไม่สำเร็จ: ${ex}`);
  }
}

/** dummy record เดียว (Python load_records ตอนไม่พบไฟล์) */
function dummyRecord(): Record {
  return {
    pur_country: "JP", dest_country: "JP", company_search: "TEST COMPANY",
    vessel_name: "KMTC XIAMEN", voyage: "2603S", paperless_code: "2899",
    loading_code: "2801", shipping_mark: "MARK-001", tax_payment_code: "1",
    etd_date: "2026-04-25", invoice_no: "INV-001", invoice_date: "2026-04-25",
    consignee: "TEST CONSIGNEE", term: "CIF", currency: "USD", amount: "1000",
    freight: "50", insurance: "10", net_weight_kg: "1000", gross_weight_kg: "1100",
    description: "STEEL", net_weight_ton: "1", unit_code: "TO", volume: "1",
    container_unit: "1F",
  };
}

/** โหลดจาก Excel (Python load_records) */
export async function loadRecords(dataFile: string): Promise<Record[]> {
  if (!existsSync(dataFile)) {
    log(`ไม่พบไฟล์ ${path.basename(dataFile)} — ใช้ตัวอย่าง dummy 1 แถว`);
    return [dummyRecord()];
  }

  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(dataFile);
  const ws = wb.worksheets[0];
  if (!ws) return [];

  const rowsRaw: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    // exceljs values[0] เป็น undefined (1-indexed) — ตัดออก
    const vals = row.values as unknown[];
    for (let c = 1; c < vals.length; c++) {
      const v = vals[c];
      cells.push(v === null || v === undefined ? "" : String(v));
    }
    rowsRaw.push(cells);
  });

  if (rowsRaw.length === 0) return [];
  const headers = rowsRaw[0].map((h) => (h ? String(h).trim() : ""));
  const out: Record[] = [];
  for (const r of rowsRaw.slice(1)) {
    if (r.every((c) => c === null || c === undefined || String(c).trim() === ""))
      continue;
    const rec: Record = {};
    for (let i = 0; i < headers.length; i++) {
      rec[headers[i]] = r[i] === undefined || r[i] === null ? "" : String(r[i]);
    }
    out.push(rec);
  }
  return out;
}

export { isTruthy };
