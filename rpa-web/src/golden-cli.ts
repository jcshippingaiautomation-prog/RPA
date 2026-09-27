// ============================================================
//  ชุดทดสอบถอยหลัง (regression) ของ Master + บรีฟ AI
//
//  ปัญหาที่ต้องการกัน: แก้บรีฟหรือแก้ Master ของลูกค้ารายหนึ่ง แล้วของรายอื่น
//  (หรือของรายเดิมในจุดอื่น) พังโดยไม่มีใครรู้ จนไปเจอตอนยื่นกรมฯ
//  เคสจริง: แก้บรีฟสยามฮิตาชิ แล้วพิกัดศุลกากรหายทั้งใบทุกรายการ
//
//  วิธีทำงาน
//    golden/<ชื่อ>.json บอกว่า "เอกสารชุดนี้ ต้องได้ค่าเหล่านี้"
//    แล้วรันผ่านขั้นตอนเดียวกับตอนอัปโหลดจริง (prepareDeclarationRecord)
//    แต่ "ไม่เขียนฐานข้อมูล ไม่แตะ DCTK"
//
//  2 โหมด
//    replay (ปริยาย) — ใช้คำตอบ AI ที่เก็บไว้ในไฟล์ → เร็ว ฟรี ผลคงที่
//                      จับการเปลี่ยนแปลงของ Master/โค้ดกระทบยอด
//    live            — เรียก AI จริง → จับการเปลี่ยนแปลงของบรีฟด้วย (เสียเงิน)
//
//  รัน:  npm run golden           (replay ทั้งหมด)
//        npm run golden -- live   (เรียก AI จริง)
//        GOLDEN_ONLY=qcine-hk npm run golden
// ============================================================
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareDeclarationRecord } from "./supabase.js";
import { postProcess } from "./getemail/postprocess.js";

const DIR = path.join(process.cwd(), "golden");
const LIVE = process.argv.includes("live");
const ONLY = (process.env.GOLDEN_ONLY ?? "").trim();

interface Fixture {
  name: string;
  customer: string;
  note?: string;
  /** ไฟล์ต้นฉบับใน Supabase storage (ใช้เฉพาะโหมด live) */
  sources?: string[];
  /** คำตอบดิบ (ข้อความ JSON) ที่ AI ตอบมา — เก็บไว้ให้เล่นซ้ำได้ */
  aiAnswer?: string;
  /** ค่าที่ต้องได้ — ระดับหัวใบ */
  expectHeader?: { [k: string]: unknown };
  /** ค่าที่ต้องได้ — รายรายการ (ตามลำดับแถว) */
  expectItems?: { [k: string]: unknown }[];
}

const num = (v: unknown) => {
  const x = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(x) ? x : NaN;
};

/** เทียบค่าแบบให้อภัยเรื่องรูปแบบ: "44000" = 44000 = "44,000.000" */
function same(a: unknown, b: unknown): boolean {
  const na = num(a), nb = num(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return Math.abs(na - nb) < 0.005;
  return String(a ?? "").trim() === String(b ?? "").trim();
}

function pickItem(it: Record<string, unknown>, key: string): unknown {
  if (key in it) return it[key];
  const ex = (it.extra_fields ?? {}) as Record<string, unknown>;
  return ex[key];
}

async function runOne(fx: Fixture): Promise<{ ok: boolean; diffs: string[] }> {
  const diffs: string[] = [];
  let raw: unknown;

  if (LIVE) {
    // โหมด live: ดึงไฟล์จากคลังแล้วให้ AI อ่านใหม่ (จับบรีฟที่เปลี่ยน)
    const { getDownloadUrl } = await import("./supabase.js");
    const { extractFromAttachments } = await import("./getemail/pipeline.js");
    const atts = [];
    for (const p of fx.sources ?? []) {
      const url = await getDownloadUrl(p, null);
      if (!url) throw new Error(`ดึงไฟล์ไม่ได้: ${p}`);
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
      atts.push({ filename: path.basename(p), mimeType: p.endsWith(".pdf") ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: buf });
    }
    const out = await extractFromAttachments(atts, () => { /* เงียบ */ }, fx.customer);
    raw = out.record;
  } else {
    if (!fx.aiAnswer) throw new Error(`ไม่มี aiAnswer ในชุดนี้ — เก็บคำตอบ AI ใส่ไฟล์ก่อน`);
    raw = postProcess(fx.aiAnswer);
  }

  const { record } = await prepareDeclarationRecord(raw as Record<string, unknown>);

  for (const [k, want] of Object.entries(fx.expectHeader ?? {})) {
    const got = (record as Record<string, unknown>)[k];
    if (!same(got, want)) diffs.push(`หัวใบ.${k}: ได้ ${JSON.stringify(got)} · ต้องเป็น ${JSON.stringify(want)}`);
  }
  const items = record._items ?? [];
  (fx.expectItems ?? []).forEach((exp, i) => {
    const it = items[i];
    if (!it) { diffs.push(`รายการที่ ${i + 1}: ไม่มีในผลลัพธ์ (ได้ ${items.length} รายการ)`); return; }
    for (const [k, want] of Object.entries(exp)) {
      const got = pickItem(it, k);
      if (!same(got, want)) diffs.push(`รายการ ${i + 1}.${k}: ได้ ${JSON.stringify(got)} · ต้องเป็น ${JSON.stringify(want)}`);
    }
  });
  if (fx.expectItems && items.length !== fx.expectItems.length) {
    diffs.push(`จำนวนรายการ: ได้ ${items.length} · ต้องเป็น ${fx.expectItems.length}`);
  }
  return { ok: diffs.length === 0, diffs };
}

const files = (await readdir(DIR).catch(() => [] as string[])).filter((f) => f.endsWith(".json"));
if (!files.length) {
  console.log(`ยังไม่มีชุดทดสอบใน ${DIR} — สร้างไฟล์ .json ตามรูปแบบในหัวไฟล์นี้`);
  process.exit(0);
}
console.log(`โหมด: ${LIVE ? "live (เรียก AI จริง)" : "replay (ใช้คำตอบที่เก็บไว้)"} · ${files.length} ชุด\n`);

let pass = 0, fail = 0;
for (const f of files) {
  const fx = JSON.parse(await readFile(path.join(DIR, f), "utf-8")) as Fixture;
  if (ONLY && fx.name !== ONLY) continue;
  try {
    const r = await runOne(fx);
    if (r.ok) { pass++; console.log(`✓ ${fx.name.padEnd(18)} ${fx.customer}`); }
    else {
      fail++;
      console.log(`✗ ${fx.name.padEnd(18)} ${fx.customer} — ต่าง ${r.diffs.length} จุด`);
      for (const d of r.diffs.slice(0, 12)) console.log(`     ${d}`);
    }
  } catch (e) {
    fail++;
    console.log(`✗ ${fx.name.padEnd(18)} ${fx.customer} — รันไม่ได้: ${e instanceof Error ? e.message : String(e)}`);
  }
}
console.log(`\nสรุป: ผ่าน ${pass} · ไม่ผ่าน ${fail}`);
void writeFile;
process.exit(fail ? 1 : 0);
