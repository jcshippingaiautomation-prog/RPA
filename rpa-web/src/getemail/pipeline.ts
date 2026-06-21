// ============================================================
//  Get Email orchestration — port จาก GAS 01_Main.gs
//  processInbox → ทุก message: allowlist → AI classify → lookup →
//  extract → postProcess → insert declarations (+ items) → label dedup
// ============================================================
import { config } from "../config.js";
import {
  supabaseEnabled,
  isSenderAllowed,
  getAllowlistSenders,
  getExtractionRulesByKeyword,
  insertDeclaration,
  uploadBytes,
} from "../supabase.js";
import {
  searchMessages,
  getMessage,
  getOrCreateLabelId,
  labelMessage,
  parseSenderEmail,
  gmailEnabled,
  type GmailMessage,
} from "./gmail.js";
import type { RawAttachment } from "./files.js";
import { prepareFilesForAI } from "./files.js";
import { classifyCustomer, extractDeclaration } from "./agents.js";
import { postProcess, type DeclarationRecord } from "./postprocess.js";

export interface InboxSummary {
  threads: number;
  done: number;
  skip: number;
  retry: number;
  error: number;
  finishedAt?: string;
}

type Log = (line: string) => void;

/** สร้าง Gmail query — กรอง allowlist sender (ประหยัด AI) */
async function buildSearchQuery(): Promise<string> {
  const senders = await getAllowlistSenders();
  const base = config.gmail.searchQuery;
  if (!senders.length) return base;
  return `${base} from:(${senders.join(" OR ")})`;
}

/**
 * สกัด declaration จากไฟล์แนบดิบ (ใช้โดย upload ในเว็บ — ไม่ผ่าน Gmail/allowlist)
 * @param customerHint ถ้า user เลือกลูกค้ามา → ข้าม classify ใช้กฎลูกค้านั้นตรง ๆ (แม่นกว่า)
 * คืน { record, customer } หรือโยน error ถ้าสกัดไม่ได้
 */
export async function extractFromAttachments(
  attachments: RawAttachment[],
  log: Log = () => {},
  customerHint?: string,
): Promise<{ record: DeclarationRecord; customer: string }> {
  const files = await prepareFilesForAI(attachments, log);
  if (!files.length) throw new Error("ไม่มีไฟล์ที่ AI อ่านได้");

  // ลูกค้า: ใช้ที่ user เลือก (ถ้ามี) ไม่งั้นให้ AI classify
  let keyword = (customerHint || "").trim();
  if (keyword) {
    log(`ลูกค้า (เลือกเอง): ${keyword}`);
  } else {
    const classification = await classifyCustomer(files);
    keyword = classification?.search_keyword || "";
    if (keyword) log(`ระบุลูกค้า (AI): ${keyword}`);
  }

  // ดึง extraction_rules ของลูกค้า (จับคู่ keyword) → ให้ AI ถอดตามกฎลูกค้านั้น
  const cs = keyword ? await getExtractionRulesByKeyword(keyword) : null;
  const rule = cs
    ? { Customer_Name: cs.customer_name, Extraction_Rules: cs.extraction_rules || "" }
    : (keyword ? { Customer_Name: keyword, Extraction_Rules: "" } : null);

  const raw = await extractDeclaration(files, rule, "");
  const record = postProcess(raw);
  if (record._has_error) throw new Error("AI สกัดข้อมูลไม่สำเร็จ (parse ล้มเหลว)");
  // ถ้า user เลือกลูกค้ามา → ใช้ชื่อนั้นเป็นหลัก (กัน AI สกัดชื่อเพี้ยน)
  const finalCustomer = cs?.customer_name || keyword || String(record.customer_name ?? "");
  if (finalCustomer) record.customer_name = finalCustomer;
  return { record, customer: finalCustomer };
}

/**
 * ประมวลผล 1 อีเมล (1 message) → "DONE" | "SKIP" | "RETRY"
 * - 1 อีเมล = 1 declaration ใช้ไฟล์แนบของข้อความนั้นเท่านั้น (ไม่รวม reply/ทั้งเธรด)
 */
async function processMessage(
  msg: GmailMessage,
  log: Log,
): Promise<"DONE" | "SKIP" | "RETRY"> {
  // Step 1 — allowlist
  const email = parseSenderEmail(msg.from);
  if (!email || !(await isSenderAllowed(email))) {
    log(`sender ไม่อยู่ใน allowlist — skip: ${email}`);
    return "SKIP";
  }

  // Step 2 — ไฟล์แนบของข้อความนี้ (ข้ามรูป inline) — กันชื่อ+ขนาดซ้ำ
  const seen = new Set<string>();
  const atts: RawAttachment[] = [];
  for (const att of msg.attachments) {
    if (/^(image00|~wrd)/i.test(att.filename)) continue;
    const key = `${att.filename}:${att.bytes.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    atts.push(att);
  }

  // Step 3 — attachments → AI-ready
  const files = await prepareFilesForAI(atts, log);
  if (!files.length) { log("ไม่มีไฟล์แนบที่ใช้ได้ — skip"); return "SKIP"; }

  // Step 4 — classify
  const classification = await classifyCustomer(files);
  if (!classification?.search_keyword) {
    log("classifier ล้มเหลว — retry รอบหน้า");
    return "RETRY";
  }
  log(`keyword: ${classification.search_keyword}`);

  // Step 5 — ต้องเป็นลูกค้าที่ลงทะเบียน
  const cs = await getExtractionRulesByKeyword(classification.search_keyword);
  if (!cs) {
    log(`ไม่ใช่ลูกค้าที่ลงทะเบียน — skip: ${classification.search_keyword}`);
    return "SKIP";
  }
  const rule = { Customer_Name: cs.customer_name, Extraction_Rules: cs.extraction_rules || "" };

  // Step 6 — extract (ไฟล์ของอีเมลนี้ + body ของอีเมลนี้)
  const raw = await extractDeclaration(files, rule, msg.plainBody || "");

  // Step 7 — post-process
  const record = postProcess(raw);
  if (record._has_error) {
    log(`extractor parse พัง — retry รอบหน้า. raw=${String(raw).slice(0, 300)}`);
    return "RETRY";
  }

  // Step 8 — insert
  const res = await insertDeclaration(record as Record<string, unknown> & { _items?: Record<string, unknown>[] });
  if (!res.inserted) {
    log(`ข้าม insert: ${res.reason} (${record.customer_name}/${record.invoice_number})`);
    return "DONE"; // ถือว่าจัดการแล้ว (ติด label กันซ้ำ)
  }
  log(
    `✓ บันทึก declaration: ${record.customer_name} / inv ${record.invoice_number}` +
      (record._needs_review ? " (ต้องตรวจสอบ)" : ""),
  );

  // Step 9 — เก็บไฟล์แนบต้นฉบับของอีเมลนี้ขึ้น Supabase
  const custName = String(record.customer_name ?? "");
  const inv = String(record.invoice_number ?? "");
  let upN = 0;
  for (const att of atts) {
    const rec = await uploadBytes(att.bytes, att.filename, { customer: custName, invoice: inv, kind: "source" });
    if (rec) upN++;
  }
  if (upN) log(`  📎 เก็บไฟล์แนบต้นฉบับ ${upN} ไฟล์`);
  return "DONE";
}

/**
 * Entry — ค้นอีเมล (allowlist หรือ subject override) แล้วประมวลผลทุกฉบับ
 */
export async function processInbox(subjectOverride: string | undefined, log: Log): Promise<InboxSummary> {
  if (!supabaseEnabled()) throw new Error("ยังไม่ได้ตั้งค่า Supabase");
  if (!gmailEnabled()) throw new Error("ยังไม่ได้ตั้งค่า Gmail OAuth (GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN)");

  let query: string;
  if (subjectOverride && subjectOverride.trim()) {
    query = `has:attachment subject:("${subjectOverride.trim()}")`;
    log("[TEST MODE] ค้นด้วย subject");
  } else {
    query = await buildSearchQuery();
  }
  log(`query: ${query}`);

  const ids = await searchMessages(query, config.gmail.maxThreads);
  log(`พบ ${ids.length} อีเมล`);

  // 1 อีเมล = 1 รายการ — ประมวลทีละข้อความ (ใช้ไฟล์ของอีเมลนั้น ไม่รวม reply/ทั้งเธรด)
  const summary: InboxSummary = { threads: ids.length, done: 0, skip: 0, retry: 0, error: 0 };
  const labelId = await getOrCreateLabelId(config.gmail.processedLabel);

  for (const id of ids) {
    try {
      const msg = await getMessage(id);
      const result = await processMessage(msg, log);
      if (result === "DONE") { summary.done++; await labelMessage(id, labelId); }
      else if (result === "SKIP") { summary.skip++; await labelMessage(id, labelId); }
      else { summary.retry++; log("จะลองใหม่รอบหน้า (ไม่ติด label)"); }
    } catch (e) {
      summary.error++;
      log(`error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  summary.finishedAt = new Date().toISOString();
  log(`summary: ${JSON.stringify(summary)}`);
  return summary;
}
