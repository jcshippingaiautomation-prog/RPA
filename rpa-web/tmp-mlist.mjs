import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const { data } = await sb.from("declaration_templates").select("name,consignee_names,product_codes,header,items").eq("customer_name","THANAKORN");
console.log("Master ของ THANAKORN ที่มีอยู่", (data ?? []).length, "อัน:");
for (const t of data ?? []) {
  const h = t.header ?? {};
  console.log(` • ${(t.consignee_names ?? []).join(" / ") || "(ไม่ระบุผู้รับ)"}`);
  console.log(`     สินค้า: ${(t.product_codes ?? []).join(", ")} | ปลายทาง: ${h.destination_country_code ?? h.dest ?? "?"} | ท่า: ${h.loading_port_code ?? "?"} | ชื่อ Master: ${t.name}`);
}
