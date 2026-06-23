// ============================================================
//  RPA Worker — poll Supabase job_queue → claim → run → stream logs
//  รันบน VM ที่มีเบราว์เซอร์จริง (Playwright)
// ============================================================
import { runImport, type AppConfig, type RowInfo } from "rpa-import-node";
import { config, assertConfig } from "./config.js";
import {
  claimNextJob,
  appendLog,
  isCancelRequested,
  markDone,
  markError,
  type JobRow,
} from "./queue.js";
import { listCustomerSettings, uploadDocument } from "./supa.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** รันงาน rpa_import 1 งาน (เทียบเท่า startRun ใน server.ts แต่ log → job_logs) */
async function runRpaImport(job: JobRow): Promise<void> {
  const payload = job.payload as { onlyRows?: number[]; headless?: boolean };
  const dryRun = !!job.dry_run;
  const onlyRows = Array.isArray(payload.onlyRows) ? payload.onlyRows : undefined;

  const configOverrides: Partial<AppConfig> = {};
  if (typeof payload.headless === "boolean") configOverrides.headless = payload.headless;

  // build overrides จาก customer_settings (ยกมาจาก server.ts)
  let fieldRulesOverride: { [c: string]: string[] } | undefined;
  let captureOverride: { [c: string]: boolean } | undefined;
  let presetsOverride: { [c: string]: { [field: string]: string } } | undefined;
  const settings = await listCustomerSettings();
  if (settings.length) {
    fieldRulesOverride = {};
    captureOverride = {};
    presetsOverride = {};
    for (const s of settings) {
      fieldRulesOverride[s.customer_name] = s.allowed_fields;
      captureOverride[s.customer_name] = !!s.request_screenshot;
      presetsOverride[s.customer_name] = s.presets ?? {};
    }
    await appendLog(job.id, "log", {
      line: `[WORKER] ใช้ field rules + presets + capture จาก Supabase (${settings.length} ลูกค้า)`,
    });
  }

  await appendLog(job.id, "lifecycle", {
    event: "run-start",
    startedAt: Date.now(),
    mode: onlyRows && onlyRows.length ? "selected" : "all",
    dryRun,
  });
  if (dryRun) {
    await appendLog(job.id, "log", {
      line: "[WORKER] โหมด DRY RUN — กรอกข้อมูลจริงแต่ไม่บันทึก/ส่งอีเมล",
    });
  }

  const result = await runImport({
    configOverrides,
    dryRun,
    fieldRulesOverride,
    captureOverride,
    presetsOverride,
    onlyRows,
    onLog: (line) => void appendLog(job.id, "log", { line }),
    onRows: (rows: RowInfo[]) => void appendLog(job.id, "row", { rows }),
    onRowStatus: (row) => void appendLog(job.id, "row-status", row),
    onDocument: async (doc) => {
      await appendLog(job.id, "log", {
        line: `[WORKER] อัปเอกสารขึ้น Supabase: ${doc.filePath.split("/").pop()}`,
      });
      const rec = await uploadDocument(doc.filePath, {
        customer: doc.customer,
        invoice: doc.invoice,
        kind: doc.kind,
      });
      if (rec) await appendLog(job.id, "document", rec);
      else await appendLog(job.id, "log", { line: "[WORKER] ⚠ อัปเอกสารไม่สำเร็จ" });
    },
    onCaptureMeta: async (meta) => {
      await appendLog(job.id, "log", { line: `[WORKER] 🧾 เลขใบขน DCTK: ${meta.declarationNo}` });
      await appendLog(job.id, "capture-meta", meta);
    },
    shouldStop: () => {
      // poll cancel แบบไม่ block (best-effort; ดูที่จุดเริ่มแต่ละแถว)
      return cancelFlag;
    },
  });

  await appendLog(job.id, "lifecycle", { event: "run-done", result });
  await markDone(job.id, result as unknown as Record<string, unknown>);
}

/** รันงาน rpa_edit 1 งาน — ค้นใบเดิมใน DCTK (declaration_no) → แก้ → save */
async function runRpaEdit(job: JobRow): Promise<void> {
  const payload = job.payload as {
    onlyRows?: number[]; headless?: boolean; declId?: string; declaration_no?: string;
  };
  const onlyRows = Array.isArray(payload.onlyRows) ? payload.onlyRows : undefined;
  const declarationNo = String(payload.declaration_no ?? "");

  const configOverrides: Partial<AppConfig> = {};
  if (typeof payload.headless === "boolean") configOverrides.headless = payload.headless;

  // build overrides เหมือน import (field rules + presets + capture)
  let fieldRulesOverride: { [c: string]: string[] } | undefined;
  let captureOverride: { [c: string]: boolean } | undefined;
  let presetsOverride: { [c: string]: { [field: string]: string } } | undefined;
  const settings = await listCustomerSettings();
  if (settings.length) {
    fieldRulesOverride = {}; captureOverride = {}; presetsOverride = {};
    for (const s of settings) {
      fieldRulesOverride[s.customer_name] = s.allowed_fields;
      captureOverride[s.customer_name] = !!s.request_screenshot;
      presetsOverride[s.customer_name] = s.presets ?? {};
    }
  }

  await appendLog(job.id, "lifecycle", { event: "run-start", startedAt: Date.now(), mode: "edit" });
  await appendLog(job.id, "log", { line: `[WORKER] ✏️ แก้ไขใบขน DCTK เลข ${declarationNo}` });

  const result = await runImport({
    mode: "edit",
    editDeclarationNo: declarationNo,
    editDeclarationId: payload.declId,
    configOverrides,
    fieldRulesOverride,
    captureOverride,
    presetsOverride,
    onlyRows,
    onLog: (line) => void appendLog(job.id, "log", { line }),
    onRows: (rows: RowInfo[]) => void appendLog(job.id, "row", { rows }),
    onRowStatus: (row) => void appendLog(job.id, "row-status", row),
    onDocument: async (doc) => {
      const rec = await uploadDocument(doc.filePath, { customer: doc.customer, invoice: doc.invoice, kind: doc.kind });
      if (rec) await appendLog(job.id, "document", rec);
    },
    shouldStop: () => cancelFlag,
  });

  await appendLog(job.id, "lifecycle", { event: "run-done", result, mode: "edit" });
  await markDone(job.id, result as unknown as Record<string, unknown>);
}

/** รันงาน rpa_print 1 งาน — พิมพ์ใบเดิมซ้ำ (ค้นใบใน DCTK ด้วย declaration_no → พิมพ์ PDF, ไม่กรอก/ไม่สร้างใหม่) */
async function runRpaPrint(job: JobRow): Promise<void> {
  const payload = job.payload as {
    onlyRows?: number[]; headless?: boolean; declId?: string; declaration_no?: string;
  };
  const onlyRows = Array.isArray(payload.onlyRows) ? payload.onlyRows : undefined;
  const declarationNo = String(payload.declaration_no ?? "");

  const configOverrides: Partial<AppConfig> = {};
  if (typeof payload.headless === "boolean") configOverrides.headless = payload.headless;

  await appendLog(job.id, "lifecycle", { event: "run-start", startedAt: Date.now(), mode: "reprint" });
  await appendLog(job.id, "log", { line: `[WORKER] 🖨 พิมพ์ใบขนซ้ำ DCTK เลข ${declarationNo}` });

  const result = await runImport({
    mode: "reprint",
    editDeclarationNo: declarationNo,
    editDeclarationId: payload.declId,
    configOverrides,
    onlyRows,
    onLog: (line) => void appendLog(job.id, "log", { line }),
    onRows: (rows: RowInfo[]) => void appendLog(job.id, "row", { rows }),
    onRowStatus: (row) => void appendLog(job.id, "row-status", row),
    onDocument: async (doc) => {
      const rec = await uploadDocument(doc.filePath, { customer: doc.customer, invoice: doc.invoice, kind: doc.kind });
      if (rec) await appendLog(job.id, "document", rec);
    },
    onCaptureMeta: async (meta) => void appendLog(job.id, "capture-meta", meta),
    shouldStop: () => cancelFlag,
  });

  await appendLog(job.id, "lifecycle", { event: "run-done", result, mode: "reprint" });
  await markDone(job.id, result as unknown as Record<string, unknown>);
}

// flag cancel ต่อ-งาน (poll ขนานกันระหว่างรัน)
let cancelFlag = false;

async function pollCancel(jobId: string): Promise<void> {
  // poll ทุก 2s ระหว่างงานทำงาน → set cancelFlag ให้ shouldStop เห็น
  while (!cancelFlag) {
    if (await isCancelRequested(jobId)) {
      cancelFlag = true;
      return;
    }
    await sleep(2000);
  }
}

async function handleJob(job: JobRow): Promise<void> {
  cancelFlag = false;
  const cancelWatcher = pollCancel(job.id); // ทำงานขนาน
  try {
    if (job.type === "rpa_import") {
      await runRpaImport(job);
    } else if (job.type === "rpa_edit") {
      await runRpaEdit(job);
    } else if (job.type === "rpa_print") {
      await runRpaPrint(job);
    } else if (job.type === "get_email") {
      // get_email รันผ่านเว็บ (in-process processInbox) ไม่ผ่าน worker queue
      //   ถ้ามี job ชนิดนี้หลุดเข้าคิว → จบแบบ done (emit lifecycle กัน state ค้าง)
      await appendLog(job.id, "log", {
        line: "[WORKER] get_email รันผ่านเว็บโดยตรง (ไม่ผ่าน worker) — ข้าม",
      });
      const emptyResult = { total: 0, done: 0, errors: 0, skipped: 0, stopped: false };
      await appendLog(job.id, "lifecycle", { event: "run-done", result: emptyResult });
      await markDone(job.id, emptyResult as unknown as Record<string, unknown>);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await appendLog(job.id, "lifecycle", { event: "run-error", error: msg });
    await markError(job.id, msg);
  } finally {
    cancelFlag = true; // หยุด watcher
    await cancelWatcher.catch(() => {});
  }
}

async function loop(): Promise<void> {
  assertConfig();
  const types = config.worker.types;
  console.log(`[worker] เริ่มทำงาน — types=${types.join(",")} poll=${config.worker.pollMs}ms`);
  // graceful shutdown
  let running = true;
  process.on("SIGINT", () => { running = false; });
  process.on("SIGTERM", () => { running = false; });

  while (running) {
    let picked = false;
    for (const t of types) {
      const job = await claimNextJob(t);
      if (job) {
        picked = true;
        console.log(`[worker] หยิบงาน ${job.type} id=${job.id}`);
        await handleJob(job);
        console.log(`[worker] จบงาน id=${job.id}`);
        break; // หยิบทีละงาน
      }
    }
    if (!picked) await sleep(config.worker.pollMs);
  }
  console.log("[worker] หยุดทำงาน");
}

loop().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
