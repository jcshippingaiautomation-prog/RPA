// ============================================================
//  Scheduler — ตั้งเวลางานอัตโนมัติ (node-cron)
//  - import schedule  : รัน RPA import ตามรอบ (key = "import_schedule")
//  - email poll       : ดึงอีเมลอัตโนมัติ (key = "email_poll")  ← ใหม่
//  เก็บ config ใน Supabase app_settings
// ============================================================
import cron, { type ScheduledTask } from "node-cron";
import { getAppSetting, setAppSetting } from "./supabase.js";

export interface ScheduleConfig {
  enabled: boolean;
  /** "minutes" = ทุก N นาที, "hours" = ทุก N ชม., "daily" = ทุกวันเวลา HH:MM */
  mode: "minutes" | "hours" | "daily";
  every: number; // สำหรับ minutes/hours
  time: string; // "HH:MM" สำหรับ daily
  dryRun: boolean; // true = dry, false = รันจริง
}

/** แปลง config → cron expression */
export function toCron(cfg: ScheduleConfig): string {
  if (cfg.mode === "minutes") {
    const n = Math.max(1, Math.min(59, cfg.every));
    return `*/${n} * * * *`;
  }
  if (cfg.mode === "hours") {
    const n = Math.max(1, Math.min(23, cfg.every));
    return `0 */${n} * * *`;
  }
  const [h, m] = (cfg.time || "09:00").split(":").map((x) => parseInt(x, 10));
  return `${isNaN(m) ? 0 : m} ${isNaN(h) ? 9 : h} * * *`;
}

function humanize(cfg: ScheduleConfig): string {
  if (!cfg.enabled) return "ปิดอยู่";
  if (cfg.mode === "minutes") return `ทุก ${cfg.every} นาที`;
  if (cfg.mode === "hours") return `ทุก ${cfg.every} ชั่วโมง`;
  return `ทุกวันเวลา ${cfg.time} น.`;
}

// ------------------------------------------------------------
//  CronJob — instance เดียวต่อ 1 งาน (ผูก key + runner + config)
// ------------------------------------------------------------
class CronJob {
  private task: ScheduledTask | null = null;
  private current: ScheduleConfig;
  private runner: ((cfg: ScheduleConfig) => Promise<void>) | null = null;
  private lastRunAt: number | null = null;

  constructor(
    private readonly key: string,
    private readonly label: string,
    defaults: ScheduleConfig,
  ) {
    this.current = { ...defaults };
  }

  setRunner(fn: (cfg: ScheduleConfig) => Promise<void>): void {
    this.runner = fn;
  }

  private stop(): void {
    if (this.task) { this.task.stop(); this.task = null; }
  }

  private apply(): void {
    this.stop();
    if (!this.current.enabled) return;
    const expr = toCron(this.current);
    if (!cron.validate(expr)) {
      console.error(`[scheduler:${this.key}] invalid cron:`, expr);
      return;
    }
    this.task = cron.schedule(expr, async () => {
      if (!this.runner) return;
      this.lastRunAt = Date.now();
      console.log(`[scheduler:${this.key}] auto-run (${humanize(this.current)})`);
      try { await this.runner(this.current); }
      catch (e) { console.error(`[scheduler:${this.key}] error:`, String(e)); }
    });
    console.log(`[scheduler:${this.key}] เปิด: ${humanize(this.current)} (cron ${expr})`);
  }

  async init(): Promise<void> {
    const saved = await getAppSetting<ScheduleConfig>(this.key);
    this.current = { ...this.current, ...(saved ?? {}) };
    this.apply();
  }

  get(): ScheduleConfig & { lastRunAt: number | null; human: string } {
    return { ...this.current, lastRunAt: this.lastRunAt, human: humanize(this.current) };
  }

  async update(patch: Partial<ScheduleConfig>): Promise<void> {
    this.current = { ...this.current, ...patch };
    await setAppSetting(this.key, this.current);
    this.apply();
  }
}

// ------------------------------------------------------------
//  สอง instance: import + email poll
// ------------------------------------------------------------
const importJob = new CronJob("import_schedule", "Import RPA", {
  enabled: false, mode: "hours", every: 1, time: "09:00", dryRun: false,
});
// email poll: ปิดถาวรตามคำสั่ง user (2026-06-16) — ห้ามดึงอีเมลอัตโนมัติ
//   จะกลับมาเปิดต้องเอา EMAIL_POLL_DISABLED ออก + เปิดผ่านหน้าตั้งค่าใหม่
const EMAIL_POLL_DISABLED = true;
const emailJob = new CronJob("email_poll", "ดึงอีเมล", {
  enabled: false, mode: "minutes", every: 5, time: "09:00", dryRun: false,
});

// ---- API เดิม (import) — คงไว้ให้ server.ts ใช้ได้เหมือนเดิม ----
export function setRunner(fn: (dryRun: boolean) => Promise<void>): void {
  importJob.setRunner((cfg) => fn(cfg.dryRun));
}
export function getSchedule() { return importJob.get(); }
export function updateSchedule(patch: Partial<ScheduleConfig>) { return importJob.update(patch); }

// ---- API ใหม่ (email poll) ----
export function setEmailRunner(fn: () => Promise<void>): void {
  emailJob.setRunner(() => fn());
}
export function getEmailSchedule() { return emailJob.get(); }
export async function updateEmailSchedule(patch: Partial<ScheduleConfig>) {
  // ปิดถาวร: บังคับ enabled=false เสมอ ไม่ว่าผู้ใช้/หน้าเว็บจะส่งอะไรมา
  if (EMAIL_POLL_DISABLED) return emailJob.update({ ...patch, enabled: false });
  return emailJob.update(patch);
}

/** โหลด config ทั้งสองงานตอน start แล้ว apply */
export async function initScheduler(): Promise<void> {
  await importJob.init();
  if (EMAIL_POLL_DISABLED) {
    // ปิดถาวร: ไม่โหลด config email_poll จาก DB (กันค่าที่เคยเปิดไว้กลับมาทำงาน)
    //   และเขียน enabled=false กลับ DB ให้เรียบร้อย
    await emailJob.update({ enabled: false });
    console.log("[scheduler:email_poll] ปิดถาวร (EMAIL_POLL_DISABLED) — ไม่ดึงอีเมลอัตโนมัติ");
    return;
  }
  await emailJob.init();
}
