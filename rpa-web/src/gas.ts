// ============================================================
//  เรียก Google Apps Script Web App (Get Email pipeline)
//  GAS deploy เป็น Web App (/exec) แล้วรับ action ผ่าน POST
//  ถ้าไม่ได้ตั้ง URL จะ disabled แบบ graceful
// ============================================================
import { config } from "./config.js";

export function gasEnabled(): boolean {
  return config.gas.enabled;
}

interface GasResponse {
  ok: boolean;
  [k: string]: unknown;
}

async function callGas(action: string, extra: Record<string, unknown> = {}): Promise<GasResponse> {
  if (!config.gas.enabled) {
    return { ok: false, error: "ยังไม่ได้ตั้งค่า GAS_WEBAPP_URL" };
  }
  try {
    const res = await fetch(config.gas.webappUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, token: config.gas.sharedToken, ...extra }),
      // GAS Web App ตอบ 302 redirect ไป googleusercontent — fetch ตาม redirect อัตโนมัติ
      redirect: "follow",
      // GAS อ่านหลายไฟล์ + เรียก Gemini (อาจ retry) ใช้เวลานาน — เผื่อไว้ 5 นาที
      signal: AbortSignal.timeout(300000),
    });
    const text = await res.text();
    try {
      return JSON.parse(text) as GasResponse;
    } catch {
      return { ok: false, error: "GAS ตอบกลับไม่ใช่ JSON", raw: text.slice(0, 500) };
    }
  } catch (err) {
    // timeout = แค่รอนานเกิน ไม่ได้แปลว่างานล้มเหลว (GAS อาจยังทำงานเบื้องหลังจนเสร็จ)
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    return {
      ok: false,
      error: isTimeout
        ? "รอ GAS นานเกินกำหนด — GAS อาจยังประมวลผลอยู่เบื้องหลัง ลองเช็กผลในตารางอีกครั้งใน 1-2 นาที"
        : String(err),
      timedOut: isTimeout,
    };
  }
}

/** สั่งรัน processInbox ใน GAS — คืนสรุปผลลัพธ์ (subject = โหมดทดสอบค้นด้วย subject) */
export function runGet(subject?: string): Promise<GasResponse> {
  return callGas("run", subject ? { subject } : {});
}

/** ดึงสถานะ/ผลลัพธ์ล่าสุด + แถวล่าสุดใน sheet 'รายการ' */
export function getStatus(): Promise<GasResponse> {
  return callGas("status");
}
