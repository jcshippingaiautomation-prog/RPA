// ============================================================
//  ตารางเทียบใบขน — "ของเรา" เทียบกับ "ใบที่เจ้าหน้าที่ยื่นจริง" ทีละช่อง
//
//  ตามที่รับปากในประชุม 9 ต.ค. 2569: เอาไฟล์ต้นทางกับใบขนจริงมาเทียบกัน
//  แล้วบอกว่าแต่ละค่าเอามาจากไหน และ AI ใช้หลักอะไรอ่าน เพื่อส่งให้ลูกค้าตรวจ
//
//  ทำอะไร (ไม่เขียนฐานข้อมูล ไม่สร้างใบในระบบกรมฯ)
//    1. หาเอกสารต้นทางของใบกำกับนั้นในคลังไฟล์ (หรือรับไฟล์จากเครื่องด้วย --file)
//    2. ให้ AI อ่าน → ผสม Master → กระทบยอด  (ขั้นตอนเดียวกับตอนอัปโหลดใบขนจริง)
//    3. อ่านใบขนจริงจาก DCTK (ดึงให้เองถ้ายังไม่เคยดึง — อ่านผ่านใบสำเนาแล้วลบทิ้ง)
//    4. เทียบทีละช่อง + บอกที่มาของค่า + กฎในบรีฟที่เกี่ยวข้อง
//    5. ออกรายงาน Excel 1 ไฟล์ (แผ่นสรุป + แผ่นละ 1 ใบกำกับ)
//
//  วิธีใช้
//    npm run compare -- <ลูกค้า> <เลขใบกำกับ> [<เลขใบกำกับ> …]
//    npm run compare -- THANAKORN "NKD 04/2026" --file "/path/FOB-NKD 04.2026.pdf"
//    --refresh   ดึงใบขนจริงจาก DCTK ใหม่ แม้เคยดึงไว้แล้ว
// ============================================================
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { extractFromAttachments } from "./getemail/pipeline.js";
import { prepareDeclarationRecord, listTemplates, type DeclarationTemplate } from "./supabase.js";
import { rowToFields, loadRegistry } from "./field-registry.js";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const XLSX: any = require("xlsx");

const RPA_DIR = path.resolve(process.cwd(), "..", "rpa-import-node");
const TRUTH_DIR = path.join(RPA_DIR, "file download", "masters");
const OUT_DIR = path.resolve(process.cwd(), "..", "รายงานเทียบใบขน");

type Row = Record<string, unknown>;

// ── อ่านอาร์กิวเมนต์ ─────────────────────────────────────────────
const argv = process.argv.slice(2);
const localFiles: string[] = [];
const positional: string[] = [];
let refresh = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--file") localFiles.push(argv[++i]);
  else if (argv[i] === "--refresh") refresh = true;
  else positional.push(argv[i]);
}
const [customer, ...invoices] = positional;
if (!customer || !invoices.length) {
  console.error('ใช้งาน: npm run compare -- <ลูกค้า> <เลขใบกำกับ> [<เลขใบกำกับ> …] [--file <ไฟล์>] [--refresh]');
  process.exit(1);
}
if (localFiles.length && invoices.length > 1) {
  console.error("--file ใช้ได้กับใบกำกับใบเดียวต่อครั้ง");
  process.exit(1);
}

const sb = createClient(process.env.SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_KEY ?? "");
const BUCKET = process.env.SUPABASE_BUCKET ?? "";

// ── เทียบค่าแบบให้อภัยเรื่องรูปแบบ แต่ไม่ให้อภัยเรื่องหน่วย ──────────────
const str = (v: unknown) => String(v ?? "").trim();
const flat = (v: unknown) => str(v).toUpperCase().replace(/\s+/g, " ");
/** ตัวเลขล้วน — ตัดหน่วยท้ายทิ้ง ("42.000 TNE" → 42) */
const num = (v: unknown): number => {
  const m = str(v).replace(/,/g, "").match(/^-?\d*\.?\d+/);
  return m ? Number(m[0]) : NaN;
};
/** วันที่ dd/mm/yyyy · yyyy-mm-dd → yyyy-mm-dd */
const isoDate = (v: unknown): string => {
  const s = str(v);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return "";
};
function sameValue(a: unknown, b: unknown): "same" | "format" | "diff" {
  if (flat(a) === flat(b)) return "same";
  const da = isoDate(a), db = isoDate(b);
  if (da && db) return da === db ? "same" : "diff";
  const na = num(a), nb = num(b);
  const pureA = /^[\d,.\s-]*[A-Z]*$/i.test(str(a)), pureB = /^[\d,.\s-]*[A-Z]*$/i.test(str(b));
  if (!Number.isNaN(na) && !Number.isNaN(nb) && pureA && pureB) {
    // ตัวเลขเท่ากัน ต่างแค่คอมม่า/ทศนิยมที่ DCTK แสดง = ตรง; มีหน่วยติดมาด้วยฝั่งเดียว = ต่างแค่รูปแบบ
    if (Math.abs(na - nb) < 0.005) return /[A-Z]/i.test(str(a)) === /[A-Z]/i.test(str(b)) ? "same" : "format";
    return "diff";
  }
  // เลขเที่ยวเรือ/รหัสที่ต่างแค่เลขศูนย์นำหน้าหรือคำนำหน้า "V."
  const core = (x: unknown) => flat(x).replace(/^V\.?\s*/, "").replace(/\b0+(\d)/g, "$1").replace(/[\s.,]/g, "");
  if (core(a) && core(a) === core(b)) return "format";
  return "diff";
}

// ช่องที่กรมฯ เติม/คำนวณเอง หรือเป็นค่าของระบบ ไม่ใช่สิ่งที่เราต้องกรอกให้ตรง
const DCTK_AUTO = /(_baht|exchange_rate|^line_no$|^item_no$|^inv_item_no$|total_tax|total_deposit|customs_fee|deposit_amount|^rate_|exemption|tax_amount|status|reference_no|declaration_no|sent_count|cmp_name_thai|_name_thai$)/;
// ช่องที่ค่าในใบจริงมาจากการ "ทำสำเนาเพื่ออ่าน" ไม่ใช่ค่าที่ยื่นจริง
const COPY_ARTIFACT = new Set(["departure_date"]);

interface Line {
  part: string; key: string; label: string;
  truth: string; ours: string; result: string; source: string; rule: string;
}

// ── ที่มาของค่า ────────────────────────────────────────────────
function sourceOf(
  key: string, ours: unknown, ai: Row, master: Row | null, mode: string | undefined,
): string {
  if (!str(ours)) return "—";
  const m = master ? master[key] : undefined;
  const a = ai[key];
  if (m != null && str(m) && sameValue(ours, m) !== "diff" && mode !== "ai") return "Master";
  if (a != null && str(a) && sameValue(ours, a) !== "diff") return "AI อ่านจากเอกสาร";
  if (a != null && str(a)) return "AI อ่านจากเอกสาร → ระบบแปลงรหัส/รูปแบบ";
  if (m != null && str(m) && sameValue(ours, m) !== "diff") return "Master (เติมช่องที่เอกสารไม่มี)";
  return "ระบบคำนวณ/กระทบยอด";
}

/** กฎในบรีฟที่พูดถึงช่องนี้ (บรรทัดแรกที่เจอ) */
function ruleFor(brief: string[], key: string, column: string | null, label: string): string {
  const keys = [key, column].filter(Boolean) as string[];
  for (const l of brief) {
    const t = l.trim();
    if (!t) continue;
    if (keys.some((k) => new RegExp(`(^|[^a-z_])${k}([^a-z_]|$)`, "i").test(t))) return t.slice(0, 220);
  }
  const lab = label.split(" — ")[0];
  if (lab.length >= 4) for (const l of brief) if (l.includes(lab)) return l.trim().slice(0, 220);
  return "";
}

// ── หาเอกสารต้นทาง ──────────────────────────────────────────────
async function sourceFiles(inv: string): Promise<{ filename: string; mimeType: string; bytes: Buffer }[]> {
  if (localFiles.length) {
    return localFiles.map((f) => ({
      filename: path.basename(f),
      mimeType: /\.pdf$/i.test(f) ? "application/pdf" : /\.xlsx?$/i.test(f)
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/octet-stream",
      bytes: fs.readFileSync(f),
    }));
  }
  const { data } = await sb.from("documents").select("filename,storage_path,created_at,customer")
    .eq("kind", "source").eq("invoice", inv).order("created_at", { ascending: false });
  const latest = new Map<string, { filename: string; storage_path: string }>();
  for (const d of data ?? []) {
    const c = str(d.customer).toUpperCase();
    const want = customer.toUpperCase();
    if (!(c === want || (want === "COCOS" && c === "COCO"))) continue;
    if (!latest.has(d.filename)) latest.set(d.filename, d);
  }
  const out = [];
  for (const d of latest.values()) {
    const { data: blob, error } = await sb.storage.from(BUCKET).download(d.storage_path);
    if (error || !blob) continue;
    const lower = d.filename.toLowerCase();
    out.push({
      filename: d.filename,
      mimeType: lower.endsWith(".pdf") ? "application/pdf"
        : /\.xlsx?$/.test(lower) ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : lower.endsWith(".docx") ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : /\.(png|jpe?g)$/.test(lower) ? `image/${lower.endsWith("png") ? "png" : "jpeg"}` : "application/octet-stream",
      bytes: Buffer.from(await blob.arrayBuffer()),
    });
  }
  return out;
}

// ── ใบขนจริงจาก DCTK ────────────────────────────────────────────
function truthFile(inv: string): string {
  return path.join(TRUTH_DIR, `${inv.replace(/[^\w-]+/g, "_")}.json`);
}
function loadTruth(inv: string): { header: Row; items: Row[] } | null {
  const f = truthFile(inv);
  if (refresh || !fs.existsSync(f)) {
    console.log(`   📥 ดึงใบขนจริงของ ${inv} จาก DCTK (อ่านผ่านใบสำเนาแล้วลบทิ้ง ไม่แตะใบจริง)…`);
    spawnSync("node", ["dist/pull-master-cli.js"], {
      cwd: RPA_DIR, stdio: "ignore",
      env: { ...process.env, PULL_INVOICE: inv, PULL_CUSTOMER: customer, PULL_DRY: "1", PULL_VIA_COPY: "1", RPA_HEADLESS: "1" },
    });
  }
  if (!fs.existsSync(f)) return null;
  const d = JSON.parse(fs.readFileSync(f, "utf-8"));
  return { header: d.header ?? {}, items: d.items ?? [] };
}

// ── ทำทีละใบกำกับ ───────────────────────────────────────────────
const reg = await loadRegistry();
const labelOf = new Map(reg.map((f) => [`${f.scope}|${f.key}`, f.label]));
const columnOf = new Map(reg.map((f) => [`${f.scope}|${f.key}`, f.column]));
const computed = new Set(reg.filter((f) => f.computed).map((f) => `${f.scope}|${f.key}`));
const { data: cs } = await sb.from("customer_settings").select("extraction_rules").eq("customer_name", customer).maybeSingle();
const brief = String(cs?.extraction_rules ?? "").split("\n");
const templates = await listTemplates(customer);

const summary: (string | number)[][] = [["เลขใบกำกับ", "Master ที่ระบบเลือก", "✅ ตรง", "⚠ ต่างแค่รูปแบบ", "❌ ต่าง", "❌ ระบบไม่ได้กรอก", "ℹ เรากรอก ใบจริงว่าง", "— เทียบไม่ได้", "หมายเหตุ"]];
const sheets: { name: string; lines: Line[] }[] = [];

for (const inv of invoices) {
  console.log(`\n▶ ${customer} / ${inv}`);
  const files = await sourceFiles(inv);
  if (!files.length) {
    console.log("   ✗ ไม่พบเอกสารต้นทางในคลัง — ใส่ไฟล์เองด้วย --file");
    summary.push([inv, "", 0, 0, 0, 0, 0, 0, "ไม่พบเอกสารต้นทาง"]);
    continue;
  }
  console.log(`   📄 เอกสารต้นทาง ${files.length} ไฟล์: ${files.map((f) => f.filename).join(" · ").slice(0, 160)}`);
  const truth = loadTruth(inv);
  if (!truth) {
    console.log("   ✗ ไม่พบใบขนจริงใน DCTK — ยังเทียบไม่ได้");
    summary.push([inv, "", 0, 0, 0, 0, 0, 0, "ไม่พบใบขนจริงใน DCTK"]);
    continue;
  }

  // AI อ่าน → เก็บค่าดิบไว้ก่อน (prepare จะแก้ record ในที่)
  const { record } = await extractFromAttachments(files, () => { /* เงียบ */ }, customer);
  const aiHeader = await rowToFields(record as Row, "header");
  const aiItems: Row[] = [];
  for (const it of (record as { _items?: Row[] })._items ?? []) aiItems.push(await rowToFields(it, "item"));
  const prepared = await prepareDeclarationRecord(record as Row & { _items?: Row[] });
  const fm = prepared.fieldModes ?? {};
  const tpl: DeclarationTemplate | null = templates.find((t) => t.name === prepared.templateName) ?? null;
  const oursHeader = await rowToFields(prepared.record, "header");
  const oursItems: Row[] = [];
  for (const it of prepared.record._items ?? []) oursItems.push(await rowToFields(it, "item"));

  const lines: Line[] = [];
  const compare = (part: string, scope: "header" | "item", truthRow: Row, ours: Row, ai: Row, master: Row | null) => {
    const keys = new Set([...Object.keys(truthRow), ...Object.keys(ours)]);
    for (const key of keys) {
      let t = str(truthRow[key]), o = str(ours[key]);
      // ช่องเงินที่เป็นศูนย์ = ว่าง (ใบจริงเขียน 0.00 ส่วนระบบไม่ใส่อะไร คือค่าเดียวกัน)
      const zero = (x: string) => x !== "" && !Number.isNaN(num(x)) && num(x) === 0 && /^[\d,.\s]*$/.test(x);
      if (zero(t)) t = "";
      if (zero(o)) o = "";
      if (!t && !o) continue;
      let result: string;
      const itemAuto = scope === "item" && /^(invoice_no|unit_price_foreign|amount_currency|freight|insurance_currency)$/.test(key);
      // ค่าระวาง/ค่าประกันรายรายการ — ถ้าระบบไม่ได้ใส่ กรมฯ จะเฉลี่ยจากยอดหัวใบให้เอง
      //   (ใบที่มีรายการเดียว = ได้ยอดเต็มของหัวใบ) ไม่ใช่ช่องที่ระบบลืมกรอก
      const spread = scope === "item" && /^(freight_foreign|insurance_foreign)$/.test(key) && !o
        && str(truth.header[key]) !== "";
      if (DCTK_AUTO.test(key) || computed.has(`${scope}|${key}`) || itemAuto) result = "— กรมฯ/ระบบเติมเองตอนรัน";
      else if (spread) result = "— กรมฯ เฉลี่ยจากยอดหัวใบให้";
      else if (COPY_ARTIFACT.has(key)) result = "— เทียบไม่ได้ (ค่าจากใบสำเนา)";
      else if (!t) result = "ℹ เรากรอก ใบจริงว่าง";
      else if (!o) result = "❌ ระบบไม่ได้กรอก";
      else {
        const s = sameValue(o, t);
        result = s === "same" ? "✅ ตรง" : s === "format" ? "⚠ ต่างแค่รูปแบบ" : "❌ ต่าง";
      }
      lines.push({
        part, key, label: labelOf.get(`${scope}|${key}`) ?? key,
        truth: t, ours: o, result,
        source: sourceOf(key, o, ai, master, fm[key]),
        rule: ruleFor(brief, key, columnOf.get(`${scope}|${key}`) ?? null, labelOf.get(`${scope}|${key}`) ?? key),
      });
    }
  };
  compare("หัวใบ", "header", truth.header, oursHeader, aiHeader, (tpl?.header ?? null) as Row | null);
  const n = Math.max(truth.items.length, oursItems.length);
  for (let i = 0; i < n; i++) {
    compare(`รายการ ${i + 1}`, "item", truth.items[i] ?? {}, oursItems[i] ?? {}, aiItems[i] ?? {}, (tpl?.items?.[0] ?? null) as Row | null);
  }
  if (truth.items.length !== oursItems.length) {
    lines.unshift({ part: "จำนวนรายการ", key: "_items", label: "จำนวนรายการสินค้า", truth: String(truth.items.length),
      ours: String(oursItems.length), result: "❌ ต่าง", source: "AI อ่านจากเอกสาร", rule: "" });
  }
  // เรียง: ที่ต้องดูก่อนขึ้นบนสุด
  const order = ["❌", "ℹ", "⚠", "✅", "—"];
  lines.sort((a, b) => order.indexOf(a.result[0]) - order.indexOf(b.result[0]) || a.part.localeCompare(b.part, "th"));
  const c = (p: string) => lines.filter((l) => l.result.startsWith(p)).length;
  const counts = {
    ok: c("✅"), fmt: c("⚠"),
    diff: lines.filter((l) => l.result === "❌ ต่าง").length,
    miss: lines.filter((l) => l.result === "❌ ระบบไม่ได้กรอก").length,
    extra: c("ℹ"), skip: c("—"),
  };
  summary.push([inv, prepared.templateName ?? "(ไม่พบ Master ที่เข้ากับใบนี้)", counts.ok, counts.fmt, counts.diff, counts.miss, counts.extra, counts.skip, ""]);
  console.log(`   Master: ${prepared.templateName ?? "— ไม่พบ"}`);
  console.log(`   ✅ ตรง ${counts.ok} · ⚠ รูปแบบ ${counts.fmt} · ❌ ต่าง ${counts.diff} · ❌ ไม่ได้กรอก ${counts.miss} · ℹ เรากรอกเกิน ${counts.extra} · — เทียบไม่ได้ ${counts.skip}`);
  for (const l of lines.filter((x) => x.result.startsWith("❌")).slice(0, 12)) {
    console.log(`     ${l.result.padEnd(16)} ${l.part} · ${l.label}: เรา "${l.ours.slice(0, 40)}" · ใบจริง "${l.truth.slice(0, 40)}"`);
  }
  sheets.push({ name: inv, lines });
}

// ── ออกรายงาน Excel ─────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });
const wb = XLSX.utils.book_new();
const sumWs = XLSX.utils.aoa_to_sheet([
  [`รายงานเทียบใบขน — ${customer}`], [`ทำเมื่อ ${new Date().toLocaleString("th-TH")} · เทียบ "ของระบบ" กับ "ใบที่เจ้าหน้าที่ยื่นจริงใน DCTK" ทีละช่อง`], [],
  ...summary, [],
  ["ความหมาย"],
  ["✅ ตรง", "ค่าเหมือนใบจริงทุกตัวอักษร"],
  ["⚠ ต่างแค่รูปแบบ", "ค่าเดียวกัน ต่างแค่การเขียน เช่น 42 กับ 42.000 TNE หรือ 0152N กับ 152N"],
  ["❌ ต่าง", "ค่าไม่ตรงใบจริง — ต้องแก้ Master หรือบรีฟ"],
  ["❌ ระบบไม่ได้กรอก", "ใบจริงมีค่า แต่ระบบไม่ได้ใส่"],
  ["ℹ เรากรอก ใบจริงว่าง", "ระบบใส่ค่า แต่เจ้าหน้าที่ไม่ได้ใส่ — ตรวจว่าควรใส่ไหม"],
  ["— เทียบไม่ได้", "ช่องที่กรมฯ เติม/คำนวณเอง หรือค่าที่เกิดจากการทำสำเนาเพื่ออ่าน"],
]);
sumWs["!cols"] = [{ wch: 20 }, { wch: 64 }, { wch: 8 }, { wch: 14 }, { wch: 8 }, { wch: 16 }, { wch: 18 }, { wch: 14 }, { wch: 28 }];
XLSX.utils.book_append_sheet(wb, sumWs, "สรุป");
for (const s of sheets) {
  const ws = XLSX.utils.aoa_to_sheet([
    ["ส่วน", "ช่อง", "ใบจริง (เจ้าหน้าที่ยื่น)", "ของระบบ", "ผล", "ค่าของระบบมาจากไหน", "กฎในบรีฟที่เกี่ยวข้อง", "รหัสช่อง"],
    ...s.lines.map((l) => [l.part, l.label, l.truth, l.ours, l.result, l.source, l.rule, l.key]),
  ]);
  ws["!cols"] = [{ wch: 11 }, { wch: 30 }, { wch: 34 }, { wch: 34 }, { wch: 18 }, { wch: 30 }, { wch: 70 }, { wch: 24 }];
  ws["!autofilter"] = { ref: `A1:H${s.lines.length + 1}` };
  XLSX.utils.book_append_sheet(wb, ws, s.name.replace(/[\\/?*[\]:]/g, "-").slice(0, 31));
}
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const out = path.join(OUT_DIR, `${customer}-${stamp}.xlsx`);
XLSX.writeFile(wb, out);
console.log(`\n📊 รายงาน: ${out}`);
