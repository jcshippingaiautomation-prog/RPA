// ============================================================
//  Worker-side queue helpers — claim งาน, เขียน log, mark สถานะ
//  ใช้ service key (bypass RLS)
// ============================================================
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config.js";

export interface JobRow {
  id: string;
  type: "rpa_import" | "get_email" | "rpa_edit";
  status: "pending" | "processing" | "done" | "error" | "cancel";
  payload: Record<string, unknown>;
  dry_run: boolean;
  triggered_by: string | null;
  trigger_source: string | null;
  created_at: string;
}

let client: SupabaseClient | null = null;
function sb(): SupabaseClient {
  if (!client) {
    client = createClient(config.supabase.url, config.supabase.serviceKey, {
      auth: { persistSession: false },
    });
  }
  return client;
}

/** หยิบงานถัดไปแบบ atomic ผ่าน RPC claim_next_job — คืน null ถ้าไม่มีงาน */
export async function claimNextJob(type: string): Promise<JobRow | null> {
  const { data, error } = await sb().rpc("claim_next_job", { p_type: type });
  if (error) {
    console.error("[worker] claimNextJob error:", error.message);
    return null;
  }
  // RPC คืน row เดียว (หรือ null)
  if (!data) return null;
  const row = Array.isArray(data) ? data[0] : data;
  return (row && row.id ? (row as JobRow) : null);
}

/** เขียน log 1 บรรทัด (mirror รูปแบบ SSE event เดิม) */
export async function appendLog(
  jobId: string,
  kind: string,
  payload: unknown,
): Promise<void> {
  const { error } = await sb().from("job_logs").insert({ job_id: jobId, kind, payload });
  if (error) console.error("[worker] appendLog error:", error.message);
}

/** เช็คว่ามีคำสั่ง cancel งานนี้ไหม (poll job_queue.status) */
export async function isCancelRequested(jobId: string): Promise<boolean> {
  const { data, error } = await sb()
    .from("job_queue")
    .select("status")
    .eq("id", jobId)
    .maybeSingle();
  if (error) return false;
  return data?.status === "cancel";
}

/** mark งานเสร็จ (done) + เก็บ result */
export async function markDone(jobId: string, result: unknown): Promise<void> {
  await sb()
    .from("job_queue")
    .update({ status: "done", result, finished_at: new Date().toISOString() })
    .eq("id", jobId)
    // ถ้าถูก cancel ไปแล้ว อย่าทับเป็น done
    .neq("status", "cancel");
}

/** mark งาน error */
export async function markError(jobId: string, errMsg: string): Promise<void> {
  await sb()
    .from("job_queue")
    .update({ status: "error", error: errMsg, finished_at: new Date().toISOString() })
    .eq("id", jobId)
    .neq("status", "cancel");
}

export { sb as workerSupabase };
