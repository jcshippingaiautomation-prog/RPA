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
    types: opt("WORKER_TYPES", "rpa_import,get_email,rpa_edit")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
};

export function assertConfig(): void {
  if (!config.supabase.url || !config.supabase.serviceKey) {
    throw new Error(
      "ต้องตั้ง SUPABASE_URL และ SUPABASE_SERVICE_KEY ใน .env ก่อนรัน worker",
    );
  }
}
