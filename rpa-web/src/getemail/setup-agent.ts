// ============================================================
//  AI Setup ลูกค้าใหม่ — ดึงอีเมลตัวอย่างตาม subject → ให้ AI สรุป
//  "คู่มือการสกัดข้อมูล (extraction logic)" ของลูกค้ารายนั้น
//  ผู้ใช้ดู/แก้/ส่ง comment ให้ AI ปรับใหม่ได้ ก่อนบันทึกลง extraction_rules
// ============================================================
import { searchMessages, getMessage } from "./gmail.js";
import { prepareFilesForAI } from "./files.js";
import {
  geminiGenerate,
  geminiText,
  fileParts,
  type GeminiContent,
} from "./gemini.js";

export type Log = (msg: string) => void;

const SETUP_SYSTEM_PROMPT = `คุณเป็นผู้เชี่ยวชาญด้านการตั้งค่าระบบสกัดข้อมูลใบขนสินค้าขาออก (DCTK กรมศุลกากรไทย)

หน้าที่: วิเคราะห์ "อีเมลตัวอย่าง + เอกสารแนบ (invoice/packing list)" ของลูกค้ารายหนึ่ง แล้วสรุปเป็น **คู่มือการสกัดข้อมูล (extraction logic)** เฉพาะลูกค้ารายนี้ เพื่อให้ AI ตัวสกัดใช้กรอกใบขนได้ถูกต้องในครั้งต่อ ๆ ไป

สิ่งที่ต้องระบุในคู่มือ (เขียนเป็นภาษาไทย กระชับ เป็นข้อ ๆ):
1. **แหล่งข้อมูลแต่ละช่อง** — ข้อมูลสำคัญ (invoice no, invoice date, vessel, voyage, ETD, ปลายทาง, สกุลเงิน, ราคา/FOB, ค่าระวาง, ค่าประกัน, น้ำหนัก net/gross, รายการสินค้า, พิกัด) อยู่ตรงไหนในเอกสาร/เนื้อหาอีเมล
2. **กฎเฉพาะของลูกค้า** — เช่น invoice เอามาจาก LOT, ETD เอาจาก "วันส่งออก" ไม่ใช่วันที่ยื่น, ชื่อผู้รับปลายทาง, รูปแบบวันที่ (พ.ศ./ค.ศ.), หน่วยน้ำหนัก
3. **รายการสินค้า** — มีกี่รายการโดยทั่วไป, แต่ละรายการมีพิกัดต่างกันไหม, FOC (ของแถม) จัดการยังไง
4. **ข้อควรระวัง** — ช่องที่มักผิด, ข้อมูลที่อยู่ในเนื้อหาอีเมลไม่ใช่เอกสาร, การแปลงค่า

**ชื่อบริษัทผู้ส่งออก (customer_name) ที่ใช้ค้นใน DCTK**: ระบุชื่อย่อที่น่าจะค้นเจอใน DCTK (ไม่ใช่ชื่อเต็มตามกฎหมาย) ถ้าเดาได้

ตอบเป็นข้อความคู่มือล้วน ๆ (ไม่ต้องมี JSON, ไม่ต้องเกริ่นนำ) ให้ผู้ใช้อ่านเข้าใจและแก้ไขได้ง่าย`;

interface DraftResult {
  rules: string;
  sampleCount: number;
  customerName: string;
}

/**
 * ร่าง extraction logic จากอีเมลตัวอย่าง (subject)
 * @param customerName ชื่อลูกค้า (hint)
 * @param subject subject ที่ใช้ค้นอีเมลตัวอย่างใน Gmail
 * @param comment (ถ้าแก้รอบ 2) คอมเมนต์จากผู้ใช้ + ร่างเดิม เพื่อให้ AI ปรับ
 * @param previousDraft ร่างเดิมที่ผู้ใช้ขอแก้
 */
export async function draftCustomerLogic(
  customerName: string,
  subject: string,
  comment: string,
  previousDraft: string,
  log: Log = () => {},
): Promise<DraftResult> {
  // 1) ค้นอีเมลตัวอย่างตาม subject (มีไฟล์แนบ)
  const query = `has:attachment subject:("${subject.replace(/"/g, '\\"')}")`;
  log(`ค้นอีเมลตัวอย่าง: ${query}`);
  const ids = await searchMessages(query, 3); // เอาตัวอย่างสูงสุด 3 ฉบับ
  if (!ids.length) {
    throw new Error(`ไม่พบอีเมลที่มี subject "${subject}" (ต้องมีไฟล์แนบ)`);
  }
  log(`พบ ${ids.length} อีเมลตัวอย่าง`);

  // 2) รวมไฟล์แนบ + เนื้อหา จากทุกฉบับ
  const allFiles = [];
  const bodies: string[] = [];
  for (const id of ids) {
    const msg = await getMessage(id);
    if (msg.plainBody) bodies.push(`[อีเมล: ${msg.subject}]\n${msg.plainBody.slice(0, 2000)}`);
    if (msg.attachments.length) {
      const files = await prepareFilesForAI(msg.attachments, log);
      allFiles.push(...files);
    }
  }
  log(`เตรียมไฟล์ ${allFiles.length} ไฟล์ + เนื้อหา ${bodies.length} อีเมล`);

  // 3) สร้าง prompt
  const intro =
    `ลูกค้า: ${customerName || "(ไม่ระบุชื่อ)"}\n\n` +
    `เนื้อหาอีเมลตัวอย่าง:\n${bodies.join("\n\n---\n\n") || "(ไม่มีเนื้อหาข้อความ)"}\n\n` +
    `กรุณาวิเคราะห์เอกสารแนบ + เนื้อหาด้านบน แล้วสรุปคู่มือการสกัดข้อมูลของลูกค้ารายนี้`;

  const parts = [{ text: intro }, ...fileParts(allFiles)];

  // multi-turn: ถ้ามี comment + ร่างเดิม → ส่งให้ AI ปรับ
  let contents: GeminiContent[] | null = null;
  if (comment && previousDraft) {
    contents = [
      { role: "user", parts },
      { role: "model", parts: [{ text: previousDraft }] },
      { role: "user", parts: [{ text: `กรุณาปรับคู่มือตามคำแนะนำนี้:\n${comment}\n\nตอบเป็นคู่มือฉบับปรับปรุงเต็ม ๆ` }] },
    ];
  }

  log("AI กำลังวิเคราะห์…");
  const res = await geminiGenerate(SETUP_SYSTEM_PROMPT, contents ? null : parts, contents);
  const rules = geminiText(res).trim();
  if (!rules) throw new Error("AI ไม่ได้คืนผลลัพธ์");

  return { rules, sampleCount: ids.length, customerName };
}
