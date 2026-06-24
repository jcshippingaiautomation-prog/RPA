// ============================================================
//  Shared types
// ============================================================
import type { Page } from "playwright";

/** A processed record handed to the fill_* functions. */
export interface Record {
  [key: string]: unknown;
  // internal attachments (set by attachRules)
  __field_rules__?: Set<string> | null;
  // ช่องที่ตั้ง "กำหนดเอง" (preset) — semantic keys; ใช้ค่า preset เสมอ + ค่าว่าง=ล้างช่อง
  __preset_keys__?: Set<string>;
  __customer_rule__?: Record;
  __capture_screenshots__?: boolean;
  __download_dir__?: string;
  __screenshot_paths__?: string[];
  __raw_row__?: { [col: string]: string };
  // dry run: กรอกข้อมูลจริงแต่ไม่กด Save/Save&Close/Print และไม่ส่งอีเมล
  __dry_run__?: boolean;
  // id ของแถวใน Supabase declarations (ไว้ mark doc_status หลังทำเสร็จ)
  __supabase_id__?: unknown;
  // เลขใบขน DCTK ที่จับได้ตั้งแต่ Page 2 (referenceNo) — fallback ให้ finalize/auto-reprint ถ้า save ค้าง
  __declaration_no__?: string;
  // รายการสินค้าหลายแถว (จาก declaration_items) — ถ้าว่าง fallback ใช้ค่าหัวรายการ
  __items__?: Record[];
}

export interface EmailConfig {
  enabled?: boolean;
  smtp_host: string;
  smtp_port: number;
  sender: string;
  app_password: string;
  recipient: string;
  subject?: string;
}

export interface GoogleSheetConfig {
  enabled?: boolean;
  sheet_id: string;
  sheet_name: string;
  field_rules_sheet?: string;
  customer_rule_sheet?: string;
}

export interface AppConfig {
  url: string;
  username: string;
  password: string;
  headless?: boolean;
  slow_mo_ms?: number;
  default_timeout_ms?: number;
  data_file?: string;
  download_dir?: string;
  pause_on_error?: boolean;
  google_sheet?: GoogleSheetConfig;
  email?: EmailConfig;
}

export type { Page };
