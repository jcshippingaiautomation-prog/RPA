// ============================================================
//  enqueue-run — helper รันทดสอบ: หา declaration ตามคำค้น → คำนวณ index
//  (ลำดับเดียวกับที่ worker โหลด: doc_status=false, order created_at.asc,
//   เฉพาะแถวที่มี customer_name) → insert job_queue 1 งาน
//
//  ใช้: node dist/enqueue-run.js "<คำค้น invoice/customer>"  [--headless]
//  อ่าน key จาก .env (ไม่รับ key ทาง CLI) — ไม่พิมพ์ข้อมูลลูกค้าออกเกินจำเป็น
// ============================================================
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const url = (process.env.SUPABASE_URL ?? "").trim();
const key = (process.env.SUPABASE_SERVICE_KEY ?? "").trim();
if (!url || !key) {
  console.error("ต้องตั้ง SUPABASE_URL + SUPABASE_SERVICE_KEY ใน .env");
  process.exit(1);
}

const args = process.argv.slice(2);
const headless = args.includes("--headless");
const term = args.filter((a) => !a.startsWith("--")).join(" ").trim().toLowerCase();
if (!term) {
  console.error('ใส่คำค้นด้วย เช่น: node dist/enqueue-run.js "ADM 01(A)/2026"');
  process.exit(1);
}

async function main(): Promise<void> {
  // โหลดลำดับเดียวกับ data.ts loadRecordsFromSupabase (เพื่อให้ index ตรงกับ worker)
  const endpoint =
    `${url}/rest/v1/declarations` +
    `?select=id,invoice_number,customer_name,consignee_name,incoterms,currency&doc_status=eq.false&order=created_at.asc`;
  const resp = await fetch(endpoint, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!resp.ok) {
    console.error(`โหลด declarations ไม่สำเร็จ HTTP ${resp.status}`);
    process.exit(1);
  }
  const rows = (await resp.json()) as Array<{
    id: string; invoice_number: string | null; customer_name: string | null;
    consignee_name: string | null; incoterms: string | null; currency: string | null;
  }>;
  // filter เดียวกับ data.ts: ต้องมี customer_name
  const list = rows.filter((r) => r.customer_name && String(r.customer_name).trim() !== "");

  // หา index (1-based) ของแถวที่ตรงคำค้น (invoice หรือ customer)
  const matchIdx = list.findIndex((r) =>
    String(r.invoice_number ?? "").toLowerCase().includes(term) ||
    String(r.customer_name ?? "").toLowerCase().includes(term) ||
    String(r.consignee_name ?? "").toLowerCase().includes(term),
  );
  if (matchIdx < 0) {
    console.error(`ไม่พบใบที่ตรงคำค้น "${term}" ใน ${list.length} ใบ (doc_status=false)`);
    process.exit(1);
  }
  const rowNo = matchIdx + 1; // 1-based ตรงกับ onlyRows
  const hit = list[matchIdx];

  const sb = createClient(url, key, { auth: { persistSession: false } });
  // default เห็นหน้าจอ (headless=false); ใส่ --headless เพื่อรันแบบไม่เห็นหน้าจอ
  const payload = { onlyRows: [rowNo], headless };
  const { data, error } = await sb
    .from("job_queue")
    .insert({ type: "rpa_import", status: "pending", payload, dry_run: false, trigger_source: "enqueue-run" })
    .select("id")
    .single();
  if (error) {
    console.error("insert job_queue ไม่สำเร็จ:", error.message);
    process.exit(1);
  }

  console.log("==== ENQUEUED ====");
  console.log(`invoice : ${hit.invoice_number ?? "(none)"}`);
  console.log(`customer: ${hit.customer_name ?? "(none)"}`);
  console.log(`incoterms/currency: ${hit.incoterms ?? "?"} / ${hit.currency ?? "?"}`);
  console.log(`onlyRows: [${rowNo}]  (จาก ${list.length} ใบ doc_status=false)`);
  console.log(`headless: ${headless}`);
  console.log(`job id  : ${data.id}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
