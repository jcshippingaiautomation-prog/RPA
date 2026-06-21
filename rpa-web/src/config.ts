// ============================================================
//  rpa-web configuration (จาก .env) — ทุก field เป็น optional
//  ฟีเจอร์ที่ไม่มี key จะถูกปิดแบบ graceful
// ============================================================
import "dotenv/config";

function opt(name: string, fallback = ""): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : fallback;
}

export const config = {
  port: Number(opt("PORT", "8000")),
  supabase: {
    url: opt("SUPABASE_URL"),
    serviceKey: opt("SUPABASE_SERVICE_KEY"), // server-only — ห้าม expose ลง frontend
    anonKey: opt("SUPABASE_ANON_KEY"),       // ปลอดภัยส่งให้ frontend (ใช้กับ Supabase Auth)
    bucket: opt("SUPABASE_BUCKET", "rpa-documents"),
    get enabled(): boolean {
      return Boolean(this.url && this.serviceKey);
    },
    // Auth เปิดได้เมื่อมี url + anonKey (login ฝั่ง frontend)
    get authEnabled(): boolean {
      return Boolean(this.url && this.anonKey);
    },
  },
  gas: {
    webappUrl: opt("GAS_WEBAPP_URL"),
    sharedToken: opt("GAS_SHARED_TOKEN"),
    get enabled(): boolean {
      return Boolean(this.webappUrl);
    },
  },
  // ---- Get Email (port จาก GAS) ----
  gemini: {
    apiKey: opt("GEMINI_API_KEY"),
    defaultModel: opt("GEMINI_MODEL", "gemini-2.5-flash"),
    get enabled(): boolean {
      return Boolean(this.apiKey);
    },
  },
  gmail: {
    clientId: opt("GMAIL_CLIENT_ID"),
    clientSecret: opt("GMAIL_CLIENT_SECRET"),
    refreshToken: opt("GMAIL_REFRESH_TOKEN"),
    processedLabel: opt("GMAIL_PROCESSED_LABEL", "processed-by-rpa"),
    searchQuery: opt("GMAIL_SEARCH_QUERY", "has:attachment newer_than:1d -label:processed-by-rpa"),
    maxThreads: Number(opt("GMAIL_MAX_THREADS", "2")),
    get enabled(): boolean {
      return Boolean(this.clientId && this.clientSecret && this.refreshToken);
    },
  },
  // บริการแปลง Office→PDF ภายนอก (เรียกเมื่อเจอ xlsx/docx แล้วส่งดิบให้ Gemini ไม่ได้)
  fileConvert: {
    apiUrl: opt("FILE_CONVERT_API_URL"),
    apiKey: opt("FILE_CONVERT_API_KEY"),
    get enabled(): boolean {
      return Boolean(this.apiUrl);
    },
  },
};
