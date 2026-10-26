// ============================================================
//  rpa-worker config (จาก .env) — ต้องมี Supabase service key
// ============================================================
import "dotenv/config";

function opt(name: string, fallback = ""): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : fallback;
}

export const config = {
  supabase: {
    url: opt("SUPABASE_URL"),
    serviceKey: opt("SUPABASE_SERVICE_KEY"),
    bucket: opt("SUPABASE_BUCKET", "rpa-documents"),
  },
  worker: {
    pollMs: Number(opt("WORKER_POLL_MS", "3000")),
    // worker นี้รับงาน type ไหนบ้าง (คั่นด้วย comma) — default ทั้งคู่
    //   rpa_print / rpa_capture ต้องรัน sql/14 ก่อน ฐานข้อมูลถึงจะรับงานชนิดนี้
    //   ⚠ VM ตั้ง WORKER_TYPES ไว้เองในไฟล์ .env (รายชื่อเก่า) → งานชนิดใหม่ค้างรอคิวไม่มีใครหยิบ
    //     ถ้ารายชื่อมีงานสร้างใบ (rpa_import) ให้รับงานพิมพ์ซ้ำ/แคปหน้าจอด้วยเสมอ ไม่ต้องเข้าไปแก้บน VM
    types: (() => {
      const list = opt("WORKER_TYPES", "rpa_import,get_email,rpa_edit,rpa_print,rpa_capture")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.includes("rpa_import")) for (const t of ["rpa_print", "rpa_capture"]) if (!list.includes(t)) list.push(t);
      return list;
    })(),
  },
};

export function assertConfig(): void {
  if (!config.supabase.url || !config.supabase.serviceKey) {
    throw new Error(
      "ต้องตั้ง SUPABASE_URL และ SUPABASE_SERVICE_KEY ใน .env ก่อนรัน worker",
    );
  }
}
