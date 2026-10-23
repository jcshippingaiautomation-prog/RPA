// ============================================================
//  เอกสารต้นทางฉบับไฮไลท์ — ให้ลูกค้าตรวจว่าระบบหยิบข้อมูลจากตรงไหน ไปใส่ช่องไหน ทำอย่างไร
//  A4 แนวนอน: ซ้ายเป็นเอกสารต้นฉบับพร้อมกรอบสี · ขวาเป็นคำอธิบายของหมายเลขในหน้าเดียวกัน
//
//  ใช้:  node scripts/highlight-source.mjs <spec.json>
//
//  spec (JSON)
//    title, subtitle, out (path .pdf)
//    sources: [{ file, label }]                       เอกสารต้นทาง (PDF)
//    marks:   [{ src, find, kind, field, how, value, note }]   how = ระบบทำอย่างไร (ภาษาง่าย ๆ)
//             find = ข้อความที่จะไฮไลท์ — string หรือ { text, xmin, xmax, ymin, ymax, page }
//                    หรือ array ของข้อความเหล่านั้น (รวมเป็นกรอบเดียว)
//             kind = doc (อ่านจากเอกสาร) · master (ใช้ค่าจาก Master) · calc (ระบบคำนวณจากค่านี้) · info (ไม่ได้ใช้)
//    masterMap: { xlsx, sheet }   แผนที่ Master จาก `npm run compare -- … --no-ai` → ตารางค่าคงที่
//    notes:   [string]            เรื่องที่อยากให้ลูกค้าช่วยดู (ท้ายหน้าข้อมูลตั้งต้น)
//
//  ไม่แตะฐานข้อมูล ไม่แตะ DCTK — อ่านไฟล์ในเครื่องแล้วเขียน PDF ออกมาไฟล์เดียว
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "package.json"));
const XLSX = require("xlsx");
const pdfjs = await import(pathToFileURL(path.join(ROOT, "node_modules/pdfjs-dist/legacy/build/pdf.mjs")).href);
const { chromium } = await import(pathToFileURL(path.join(ROOT, "..", "rpa-import-node", "node_modules", "playwright", "index.mjs")).href);

const spec = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));
const SCALE = 2;
const COLORS = {
  doc: { line: "#15803d", fill: "rgba(34,197,94,0.22)", name: "อ่านจากเอกสารทุกใบ" },
  calc: { line: "#1d4ed8", fill: "rgba(59,130,246,0.20)", name: "อ่านจากเอกสาร แล้วแปลงหน่วยหรือรูปแบบ" },
  master: { line: "#c2410c", fill: "rgba(249,115,22,0.24)", name: "ไม่อ่านจากเอกสาร ใช้ค่าที่ตั้งไว้ล่วงหน้า (Master)" },
  info: { line: "#6b7280", fill: "rgba(156,163,175,0.25)", name: "ระบบไม่ได้ใช้" },
};
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const br = (s) => esc(s).replace(/\n/g, "<br>");

// ── อ่านเอกสาร: ภาพหน้า + ตำแหน่งข้อความ ─────────────────────────
const docs = [];
for (const s of spec.sources) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(s.file)), verbosity: 0 }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: SCALE });
    const { canvas, context } = doc.canvasFactory.create(Math.ceil(vp.width), Math.ceil(vp.height));
    await page.render({ canvasContext: context, viewport: vp, canvas }).promise;
    const img = canvas.toBuffer("image/jpeg", 85).toString("base64");
    const items = (await page.getTextContent()).items
      .filter((it) => it.str && it.str.trim())
      .map((it) => {
        const h = Math.abs(it.transform[3]) || 8;
        return { str: it.str, x: it.transform[4], top: vp1.height - it.transform[5] - h * 0.85, w: it.width, h: h * 1.1 };
      });
    pages.push({ w: vp1.width, h: vp1.height, img, items, boxes: [] });
  }
  docs.push({ ...s, pages });
}

// ── หาตำแหน่งข้อความที่จะไฮไลท์ ────────────────────────────────
function locate(src, find) {
  const parts = Array.isArray(find) ? find : [find];
  const hits = [];
  for (const f of parts) {
    const q = typeof f === "string" ? { text: f } : f;
    const want = q.text.toUpperCase();
    let found = null;
    for (const [pi, pg] of docs[src].pages.entries()) {
      if (q.page && q.page !== pi + 1) continue;
      for (const it of pg.items) {
        if (!it.str.toUpperCase().includes(want)) continue;
        if (q.xmin != null && it.x < q.xmin) continue;
        if (q.xmax != null && it.x > q.xmax) continue;
        if (q.ymin != null && it.top < q.ymin) continue;
        if (q.ymax != null && it.top > q.ymax) continue;
        found = { pi, it };
        break;
      }
      if (found) break;
    }
    if (!found) { console.warn(`  ⚠ หาข้อความไม่เจอ: "${q.text}"`); continue; }
    hits.push(found);
  }
  if (!hits.length) return null;
  const pi = hits[0].pi;
  const same = hits.filter((h) => h.pi === pi).map((h) => h.it);
  const x0 = Math.min(...same.map((i) => i.x)) - 2, y0 = Math.min(...same.map((i) => i.top)) - 2;
  const x1 = Math.max(...same.map((i) => i.x + i.w)) + 2, y1 = Math.max(...same.map((i) => i.top + i.h)) + 1;
  return { pi, x0, y0, x1, y1 };
}

spec.marks.forEach((m, i) => {
  m.n = i + 1;
  const box = locate(m.src ?? 0, m.find);
  if (box) docs[m.src ?? 0].pages[box.pi].boxes.push({ ...box, n: m.n, kind: m.kind });
  m.found = !!box;
});

// ── ตารางค่าคงที่จาก Master (จากแผนที่ Master) ──────────────────
// ชื่อช่องในทะเบียนบางตัวซ้ำกัน/เป็นศัพท์ระบบ — เปลี่ยนเป็นชื่อที่ลูกค้าอ่านแล้วเข้าใจ
const RELABEL = {
  cmp_tax_no: "เลขประจำตัวผู้เสียภาษี (ผู้ส่งออก)", brk_tax_no: "เลขประจำตัวผู้เสียภาษี (ตัวแทนออกของ)",
  manager_card_no: "ผู้จัดการ (Manager Card)", customs_card_no: "ผู้ผ่านพิธีการ", payment_method: "วิธีชำระภาษีอากร",
  total_net_weight_unit_code: "หน่วยน้ำหนักสุทธิรวม", total_gross_weight_unit_code: "หน่วยน้ำหนักรวมหีบห่อ",
  product_code: "รหัสสินค้า (ในคลังสินค้าของระบบศุลกากร)", import_tax_incentives_id: "เลขที่สิทธิชดเชยอากร (Import Tax Incentives)",
  product_year: "ปีสินค้า (ค.ศ.)", origin_country_code: "ประเทศกำเนิดสินค้า", consignee_name: "ชื่อผู้ซื้อ",
};
let masterRows = [];
if (spec.masterMap) {
  const wb = XLSX.readFile(spec.masterMap.xlsx);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[spec.masterMap.sheet], { header: 1 }).slice(1);
  const seen = new Map();
  for (const r of rows) {
    const [part, rawLabel, truth, ours, result, source, , key] = r.map((x) => String(x ?? ""));
    const label = RELABEL[key] ?? rawLabel;
    if (!source.startsWith("Master")) continue;
    const k = `${label}|${ours}`;
    if (seen.has(k)) { seen.get(k).parts.add(part.startsWith("หัวใบ") ? "หัวใบ" : "รายการ"); continue; }
    const row = { label, value: ours, truth, ok: result.startsWith("✅") || result.startsWith("⚠"), parts: new Set([part.startsWith("หัวใบ") ? "หัวใบ" : "รายการ"]) };
    seen.set(k, row);
    masterRows.push(row);
  }
  const skip = new Set(spec.masterMap.hide ?? []);
  masterRows = masterRows.filter((r) => !skip.has(r.label));
}

// ความหมายของรหัสที่ลูกค้าอ่านไม่ออก — ใส่เฉพาะที่ยืนยันจากใบขนที่พิมพ์ออกมาแล้วเท่านั้น
const UNIT = { TNE: "ตัน", KGM: "กิโลกรัม", C62: "ชิ้น", MTR: "เมตร", SET: "ชุด", RL: "ม้วน", "1F": "Container, flexibles", FB: "Flexibag", PX: "ถังพลาสติก (IBC)", BG: "กระสอบ", CT: "กล่อง", CS: "ลัง", PK: "Package", DR: "Drum" };
function meaning(label, value) {
  const v = String(value ?? "").trim();
  if (/พิกัดศุลกากร/.test(label) && /^\d{12}$/.test(v)) { const t = v.slice(4); return `${t.slice(0, 4)}.${t.slice(4, 6)}.${t.slice(6)}`; }
  if (/หน่วย/.test(label) && UNIT[v]) return `${v} (${UNIT[v]})`;
  if (/รายการของแถม/.test(label) && v === "11") return "11 (ขายปกติ ไม่ใช่ของแถม)";
  if (/วิธีขนส่ง/.test(label) && v === "1") return "1 (ทางเรือ)";
  if (/ชนิดเอกสารใบขน/.test(label) && v === "1") return "1 (ใบขนสินค้าขาออก)";
  if (/ใช้สิทธิ์/.test(label) && v === "1") return "ใช้";
  return v;
}
masterRows = masterRows.filter((r) => r.value && r.value !== "-");

// ── HTML → PDF (A4 แนวนอน: ซ้ายเอกสาร · ขวาคำอธิบาย ในหน้าเดียวกัน) ─────────
const legend = Object.entries(COLORS).filter(([k]) => spec.marks.some((m) => m.kind === k))
  .map(([, c]) => `<span class="lg"><i style="background:${c.fill};border-color:${c.line}"></i>${c.name}</span>`).join("");

// แบ่งคำอธิบายเป็นชุดที่พอดีกับคอลัมน์ขวา 1 หน้า (ประมาณจากความยาวข้อความ)
const CHARS_PER_LINE = 44, LINES_PER_PAGE = 78;
const linesOf = (t) => String(t ?? "").split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / CHARS_PER_LINE)), 0);
const cost = (m) => 1.1 + linesOf(m.field) + linesOf(m.how ?? m.logic) + linesOf(`ในใบขนจริง: ${m.value}`) + (m.note ? linesOf(m.note) : 0);

function sheetsFor(srcIdx, pi) {
  const pg = docs[srcIdx].pages[pi];
  const mine = spec.marks.filter((m) => (m.src ?? 0) === srcIdx && pg.boxes.some((b) => b.n === m.n));
  const chunks = [];
  let cur = [], used = 0;
  for (const m of mine) {
    const c = cost(m);
    if (cur.length && used + c > LINES_PER_PAGE) { chunks.push(cur); cur = []; used = 0; }
    cur.push(m); used += c;
  }
  if (cur.length || !chunks.length) chunks.push(cur);
  return chunks.map((chunk, ci) => {
    const showing = new Set(chunk.map((m) => m.n));
    return `
  <section class="sheet">
    <header>
      <div><b>${esc(spec.title)}</b><div class="sub">${esc(docs[srcIdx].label)}${docs[srcIdx].pages.length > 1 ? ` หน้า ${pi + 1}` : ""}${chunks.length > 1 ? ` · คำอธิบายหมายเลข ${chunk[0].n}–${chunk[chunk.length - 1].n} (แผ่นที่ ${ci + 1}/${chunks.length})` : ""}</div></div>
      <div class="legend">${legend}</div>
    </header>
    <div class="body">
      <div class="doc"><div class="page" style="aspect-ratio:${pg.w}/${pg.h}">
        <img src="data:image/jpeg;base64,${pg.img}">
        ${pg.boxes.map((b) => `
          <div class="box${showing.has(b.n) ? "" : " dim"}" style="left:${(b.x0 / pg.w) * 100}%;top:${(b.y0 / pg.h) * 100}%;width:${((b.x1 - b.x0) / pg.w) * 100}%;height:${((b.y1 - b.y0) / pg.h) * 100}%;background:${COLORS[b.kind].fill};border-color:${COLORS[b.kind].line}">
            <b style="background:${COLORS[b.kind].line}">${b.n}</b>
          </div>`).join("")}
      </div></div>
      <div class="list">
        ${chunk.map((m) => `
          <div class="item" style="border-left-color:${COLORS[m.kind].line}">
            <div class="head"><b class="num" style="background:${COLORS[m.kind].line}">${m.n}</b><span class="field">${br(m.field)}</span></div>
            <div class="how">${br(m.how ?? m.logic)}</div>
            <div class="val"><span>ในใบขนจริง:</span> ${br(m.value)}</div>
            ${m.note ? `<div class="note">⚠ ${br(m.note)}</div>` : ""}
          </div>`).join("")}
      </div>
    </div>
  </section>`;
  }).join("");
}
const docSheets = docs.map((d, si) => d.pages.map((_, pi) => sheetsFor(si, pi)).join("")).join("");

// ค่าที่ตั้งไว้ใน Master — แบ่ง 2 คอลัมน์ให้จบในหน้าเดียว
const half = Math.ceil(masterRows.length / 2);
const masterTable = (rows) => `
  <table>
    <thead><tr><th>ช่องในใบขน</th><th>ค่าที่ตั้งไว้</th><th style="width:15%">ตรงกับใบขนจริงไหม</th><th style="width:24%">ถูกต้อง / ต้องแก้เป็น</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${esc(r.label)}</td><td>${br(meaning(r.label, r.value).replace(/\n\s*\n+/g, "\n"))}</td>
      <td>${r.ok ? "✅ ตรง" : `❌ ไม่ตรง<div class="sub">ใบจริง: ${br(r.truth)}</div>`}</td><td>☐&nbsp;ถูก&emsp;☐&nbsp;แก้เป็น&nbsp;……………</td></tr>`).join("")}</tbody>
  </table>`;
const masterHtml = masterRows.length ? `
  <section class="sheet free">
    <header><div><b>${esc(spec.title)}</b><div class="sub">ข้อมูลที่ตั้งไว้ล่วงหน้าสำหรับผู้ซื้อรายนี้ (Master)</div></div></header>
    ${spec.notes?.length ? `<div class="notes"><b>⚠ เรื่องที่อยากให้ช่วยดู (รายละเอียดอยู่ในแผ่นเอกสาร)</b><ul>${spec.notes.map((n) => `<li>${br(n)}</li>`).join("")}</ul></div>` : ""}
    <p class="intro">ช่องเหล่านี้ระบบ<b>ไม่ได้อ่านจากเอกสาร</b> แต่ใช้ค่าที่ตั้งไว้ล่วงหน้าเหมือนกันทุกใบของผู้ซื้อรายนี้
      ถ้าค่าไหนไม่ถูก หรือบางใบไม่เหมือนกัน กรุณาติ๊ก "แก้เป็น" แล้วเขียนค่าที่ถูก</p>
    <div class="two">${masterTable(masterRows.slice(0, half))}${masterTable(masterRows.slice(half))}</div>
  </section>` : "";

const html = `<!doctype html><html lang="th"><head><meta charset="utf-8"><style>
  @page { size: A4 landscape; margin: 8mm 9mm; }
  body { font-family: "Sukhumvit Set", "Thonburi", "Tahoma", sans-serif; color: #111827; font-size: 8.6pt; margin: 0; }
  .sheet { height: 193mm; display: flex; flex-direction: column; page-break-after: always; overflow: hidden; }
  .sheet:last-child { page-break-after: auto; }
  .sheet.free { height: auto; overflow: visible; display: block; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 4mm; padding-bottom: 1.5mm; border-bottom: 1px solid #e5e7eb; margin-bottom: 2mm; }
  header b { font-size: 10.5pt; } .sub { color: #6b7280; }
  .legend { display: grid; grid-template-columns: auto auto; gap: 0.6mm 4mm; font-size: 7.8pt; flex: none; }
  .lg i { display: inline-block; width: 10px; height: 10px; border: 1.5px solid; margin-right: 3px; vertical-align: -1px; }
  .body { flex: 1; display: flex; gap: 5mm; min-height: 0; }
  .doc { height: 100%; flex: none; }
  .page { position: relative; height: 100%; border: 1px solid #d1d5db; }
  .page img { height: 100%; width: 100%; display: block; }
  .box { position: absolute; border: 1.5px solid; border-radius: 2px; }
  .box.dim { opacity: 0.35; }
  .box b { position: absolute; right: calc(100% + 1px); top: 50%; transform: translateY(-50%); min-width: 14px; height: 14px; border-radius: 7px;
    color: #fff; font-size: 7pt; line-height: 14px; text-align: center; padding: 0 2px; box-sizing: border-box; }
  .list { flex: 1; min-width: 0; column-count: 2; column-gap: 4mm; column-fill: auto; height: 100%; }
  .item { border-left: 3px solid; padding: 0.5mm 0 0.5mm 2mm; margin-bottom: 1.8mm; break-inside: avoid; }
  .head { display: flex; align-items: baseline; gap: 2mm; }
  .num { flex: none; min-width: 15px; height: 15px; border-radius: 8px; color: #fff; font-size: 7.5pt; line-height: 15px; text-align: center; padding: 0 2px; box-sizing: border-box; }
  .field { font-weight: 700; font-size: 9pt; }
  .how { color: #374151; margin-top: 0.4mm; }
  .val { margin-top: 0.4mm; } .val span { color: #6b7280; }
  .note { color: #b45309; margin-top: 0.4mm; }
  .intro { margin: 0 0 2.5mm; font-size: 9pt; }
  .two { display: flex; gap: 4mm; align-items: flex-start; } .two table { flex: 1; }
  table { border-collapse: collapse; font-size: 7.5pt; line-height: 1.25; }
  th, td { border: 1px solid #d1d5db; padding: 1.5px 3px; vertical-align: top; text-align: left; } th { background: #f3f4f6; }
  .notes { margin: 0 0 2.5mm; font-size: 8.8pt; background: #fff7ed; border: 1px solid #fdba74; border-radius: 3px; padding: 2mm 3mm; } .notes ul { margin: 1mm 0 0; padding-left: 5mm; }
</style></head><body>
  ${docSheets}
  ${masterHtml}
</body></html>`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent(html, { waitUntil: "load" });
fs.mkdirSync(path.dirname(spec.out), { recursive: true });
await page.pdf({ path: spec.out, format: "A4", landscape: true, printBackground: true, preferCSSPageSize: true });
await browser.close();
const missing = spec.marks.filter((m) => !m.found).length;
console.log(`✓ ${spec.out}  (${spec.marks.length} จุด${missing ? ` · หาไม่เจอ ${missing}` : ""} · ค่าคงที่ ${masterRows.length} ช่อง)`);
