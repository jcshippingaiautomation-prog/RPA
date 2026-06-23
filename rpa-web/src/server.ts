// ============================================================
//  rpa-web — Express server controlling the DCTK RPA import.
//  Features: run / stop / run-selected-rows, live logs (SSE),
//  per-row status, config get/set, headless toggle.
// ============================================================
import express, { type Request, type Response } from "express";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  previewRows,
  type AppConfig,
  type RowInfo,
  type RunResult,
} from "rpa-import-node";

import { config } from "./config.js";
import {
  listDocuments,
  listDocumentsFor,
  getDownloadUrl,
  supabaseEnabled,
  listCustomerSettings,
  upsertCustomerSetting,
  deleteCustomerSetting,
  listDeclarations,
  listEmailRules,
  upsertEmailRule,
  deleteEmailRule,
  getAppSetting,
  setAppSetting,
  RULE_FIELDS,
  updateDeclaration,
  replaceItems,
  getDeclaration,
  createDeclaration,
  deleteDeclaration,
  setDeclarationStatus,
  declarationStatusEnabled,
  uploadBytes,
  enqueueJob,
  cancelActiveJobs,
  listJobs,
  getJob,
  getJobLogs,
  subscribeJobLogs,
  type JobLogRow,
  type JobRow,
} from "./supabase.js";
import { summarizeJobError, extractLogLines } from "./job-error.js";
import { validateDeclaration } from "./validate-declaration.js";
import { runGet, getStatus as gasGetStatus, gasEnabled } from "./gas.js";
import {
  initScheduler,
  setRunner,
  getSchedule,
  updateSchedule,
  setEmailRunner,
  getEmailSchedule,
  updateEmailSchedule,
  type ScheduleConfig,
} from "./scheduler.js";
import { requireUser, requireAdmin, authEnabled, serviceClient } from "./auth.js";
import { processInbox, extractFromAttachments, type InboxSummary } from "./getemail/pipeline.js";
import { draftCustomerLogic } from "./getemail/setup-agent.js";

// Get Email (Node) พร้อมใช้เมื่อมี Gmail OAuth + Gemini key
function getEmailReady(): boolean {
  return config.gmail.enabled && config.gemini.enabled && supabaseEnabled();
}
let lastGetEmailSummary: InboxSummary | null = null;

// resolve config.json ภายใน package rpa-import-node (ไม่ hard-code path)
const require = createRequire(import.meta.url);
const RPA_PKG_JSON = require.resolve("rpa-import-node/package.json");
const RPA_ROOT = path.dirname(RPA_PKG_JSON);
const CONFIG_PATH = path.join(RPA_ROOT, "config.json");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const PORT = config.port;

// ---- Run state (single run at a time) ----------------------
interface RunState {
  running: boolean;
  stopRequested: boolean;
  startedAt: number | null;
  rows: RowInfo[];
  result: RunResult | null;
  mode: "all" | "selected" | null;
  activeJobId: string | null;
}
const state: RunState = {
  running: false,
  stopRequested: false,
  startedAt: null,
  rows: [],
  result: null,
  mode: null,
  activeJobId: null,
};

// map jobId → declarationId (รัน RPA ต่อใบ → อัปเดตสถานะใบเมื่อ job เสร็จ)
const jobToDeclaration = new Map<string, string>();
// jobId → "import" | "edit" (ให้ bridge ตั้งสถานะ done vs edited ถูก)
const jobKind = new Map<string, "import" | "edit" | "print">();

// ---- SSE clients -------------------------------------------
type Client = Response;
const clients = new Set<Client>();

function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    try {
      c.write(payload);
    } catch {
      /* client หลุด — เก็บกวาดตอน close */
    }
  }
}

// ---- App ----------------------------------------------------
const app = express();
app.use(express.json({ limit: "30mb" })); // เผื่อ upload ไฟล์ (base64)
// no-cache สำหรับไฟล์ frontend (html/js/css) — กันเบราว์เซอร์ค้างโค้ดเก่าหลัง deploy
app.use(express.static(PUBLIC_DIR, {
  setHeaders: (res, filePath) => {
    if (/\.(html|js|css)$/.test(filePath)) {
      res.setHeader("Cache-Control", "no-cache, must-revalidate");
    }
  },
}));

// ---- Public endpoints (ไม่ต้อง login) ----------------------
// health check (สำหรับ uptime monitor / load balancer ตอน deploy)
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, status: "healthy", auth: authEnabled() });
});

// คืนเฉพาะ url + anonKey ให้ frontend ใช้กับ Supabase Auth (ห้ามคืน service key)
app.get("/api/public-config", (_req, res) => {
  res.json({
    supabaseUrl: config.supabase.url,
    anonKey: config.supabase.anonKey,
    authEnabled: authEnabled(),
  });
});

// ใครเป็นใคร (ต้อง login) — frontend ใช้ตัดสินใจ user/admin
app.get("/api/me", requireUser, (req, res) => {
  res.json({ ok: true, user: req.user });
});

// ---- บังคับ login สำหรับ /api/* ทั้งหมด (ยกเว้น public-config/me ที่ประกาศไว้ข้างบน) ----
// route ตั้งค่า (มุตเตชัน config) จะถูกครอบ requireAdmin เพิ่มเป็นรายตัวด้านล่าง
app.use("/api", requireUser);

// SSE: live logs + row status + run lifecycle
app.get("/api/events", (req: Request, res: Response) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  // ส่ง snapshot ปัจจุบันให้ client ที่เพิ่งต่อ
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
  clients.add(res);
  req.on("close", () => {
    clients.delete(res);
  });
});

function snapshot() {
  return {
    running: state.running,
    startedAt: state.startedAt,
    rows: state.rows,
    result: state.result,
    mode: state.mode,
  };
}

// สถานะปัจจุบัน (polling เผื่อ SSE ไม่พร้อม)
app.get("/api/status", (_req, res) => {
  res.json(snapshot());
});

// อ่าน config (ซ่อน password/app_password ก่อนส่งกลับ)
app.get("/api/config", async (_req, res) => {
  try {
    const cfg = JSON.parse(await readFile(CONFIG_PATH, "utf-8")) as AppConfig;
    res.json(maskConfig(cfg));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// บันทึก config (เฉพาะ field ที่อนุญาตแก้จากเว็บ) — admin เท่านั้น
app.post("/api/config", requireAdmin, async (req, res) => {
  try {
    const cfg = JSON.parse(await readFile(CONFIG_PATH, "utf-8")) as AppConfig;
    const body = req.body as Partial<AppConfig> & {
      email?: Partial<NonNullable<AppConfig["email"]>>;
    };

    if (typeof body.headless === "boolean") cfg.headless = body.headless;
    if (body.slow_mo_ms !== undefined) cfg.slow_mo_ms = Number(body.slow_mo_ms);
    if (body.default_timeout_ms !== undefined)
      cfg.default_timeout_ms = Number(body.default_timeout_ms);
    if (body.url) cfg.url = String(body.url);
    if (body.username) cfg.username = String(body.username);
    if (body.password) cfg.password = String(body.password); // เปลี่ยนเฉพาะถ้าส่งมา
    if (body.email) {
      cfg.email = cfg.email ?? ({} as NonNullable<AppConfig["email"]>);
      if (body.email.enabled !== undefined) cfg.email.enabled = body.email.enabled;
      if (body.email.recipient) cfg.email.recipient = String(body.email.recipient);
      if (body.email.subject) cfg.email.subject = String(body.email.subject);
    }

    await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
    res.json({ ok: true, config: maskConfig(cfg) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ไฟล์แนบต้นฉบับ + เอกสารของใบขน (จับคู่ด้วย customer+invoice)
app.get("/api/declaration-documents", async (req, res) => {
  const customer = String(req.query.customer ?? "");
  const invoice = String(req.query.invoice ?? "");
  res.json({ documents: await listDocumentsFor(customer, invoice) });
});

// แก้ไข declaration จากหน้า preview (บันทึกลง Supabase)
app.post("/api/declarations/:id", async (req, res) => {
  if (!supabaseEnabled()) { res.status(400).json({ error: "ยังไม่ได้ตั้งค่า Supabase" }); return; }
  const ok = await updateDeclaration(req.params.id, (req.body || {}) as Record<string, unknown>);
  if (!ok) { res.status(400).json({ error: "บันทึกไม่สำเร็จ (ไม่มีฟิลด์ที่แก้ได้ หรือ id ผิด)" }); return; }
  res.json({ ok: true });
});

// แก้ไขรายการสินค้า (items) ของใบขน — replace ทั้งชุด
app.put("/api/declarations/:id/items", async (req, res) => {
  if (!supabaseEnabled()) { res.status(400).json({ error: "ยังไม่ได้ตั้งค่า Supabase" }); return; }
  const body = (req.body || {}) as { items?: Record<string, unknown>[] };
  const items = Array.isArray(body.items) ? body.items : [];
  const ok = await replaceItems(req.params.id, items);
  if (!ok) { res.status(400).json({ error: "บันทึกรายการสินค้าไม่สำเร็จ" }); return; }
  res.json({ ok: true, count: items.length });
});

// สร้าง preview rows จาก declarations (ใส่ field rules + presets ต่อลูกค้า) — ใช้ร่วมหลายที่
async function buildPreviewRows(onLog?: (line: string) => void): Promise<RowInfo[]> {
  let fieldRulesOverride: { [c: string]: string[] } | undefined;
  let presetsOverride: { [c: string]: { [k: string]: string } } | undefined;
  if (supabaseEnabled()) {
    const settings = await listCustomerSettings();
    if (settings.length) {
      fieldRulesOverride = {};
      presetsOverride = {};
      for (const s of settings) {
        fieldRulesOverride[s.customer_name] = s.allowed_fields;
        presetsOverride[s.customer_name] = s.presets ?? {};
      }
    }
  }
  return previewRows({ onLog, fieldRulesOverride, presetsOverride });
}

// ขั้นที่ 1 — ดึงข้อมูล declarations มาแสดง (ไม่เปิด browser)
app.post("/api/preview", async (_req, res) => {
  if (state.running) {
    res.status(409).json({ error: "กำลังรันอยู่ — โหลดข้อมูลใหม่ไม่ได้ตอนนี้" });
    return;
  }
  try {
    const rows = await buildPreviewRows((line) => broadcast("log", { line }));
    state.rows = rows;
    state.result = null;
    state.mode = null;
    broadcast("rows", rows);
    res.json({ ok: true, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---- Declarations: สร้าง / รายละเอียด / แก้ไข / ลบ / รัน RPA ต่อใบ ----

// สร้างรายการใหม่ (manual create)
app.post("/api/declarations", async (req, res) => {
  if (!supabaseEnabled()) { res.status(400).json({ error: "ยังไม่ได้ตั้งค่า Supabase" }); return; }
  const body = (req.body || {}) as Record<string, unknown>;
  const result = await createDeclaration(body, { source: "manual", status: "new" });
  if (!result) { res.status(500).json({ error: "สร้างรายการไม่สำเร็จ" }); return; }
  res.json({ ok: true, id: result.id });
});

// รายละเอียดใบขน 1 ใบ (พร้อม items)
app.get("/api/declarations/:id", async (req, res) => {
  if (!supabaseEnabled()) { res.status(400).json({ error: "ยังไม่ได้ตั้งค่า Supabase" }); return; }
  const decl = await getDeclaration(req.params.id);
  if (!decl) { res.status(404).json({ error: "ไม่พบรายการ" }); return; }
  // ถ้าใบนี้ error และมี last_job_id → แนบสรุปสาเหตุ (ให้ modal โชว์ได้ทันที)
  let errorSummary: ReturnType<typeof summarizeJobError> | null = null;
  const lastJobId = String((decl as { last_job_id?: unknown }).last_job_id ?? "");
  if (decl.status === "error" && lastJobId) {
    const logs = await getJobLogs(lastJobId, 0);
    if (logs.length) errorSummary = summarizeJobError(logs);
  }
  // ตรวจข้อมูลก่อนรัน (แนบไปเลย ให้ modal โชว์ว่าครบ/ขาดอะไร ก่อน user กดรัน)
  const validation = validateDeclaration(decl as Record<string, unknown> & { _items?: Record<string, unknown>[] });
  res.json({ ok: true, declaration: decl, errorSummary, validation });
});

// ลบใบขน
app.delete("/api/declarations/:id", async (req, res) => {
  if (!supabaseEnabled()) { res.status(400).json({ error: "ยังไม่ได้ตั้งค่า Supabase" }); return; }
  const ok = await deleteDeclaration(req.params.id);
  if (!ok) { res.status(400).json({ error: "ลบไม่สำเร็จ" }); return; }
  res.json({ ok: true });
});

// สร้างสำเนาใบขน (copy ทุกฟิลด์ + items → ใบใหม่ status=new)
app.post("/api/declarations/:id/copy", async (req, res) => {
  if (!supabaseEnabled()) { res.status(400).json({ error: "ยังไม่ได้ตั้งค่า Supabase" }); return; }
  const src = await getDeclaration(req.params.id);
  if (!src) { res.status(404).json({ error: "ไม่พบรายการต้นฉบับ" }); return; }
  // เติม (สำเนา) ต่อท้าย invoice กันซ้ำ
  const copy: Record<string, unknown> = { ...src };
  delete copy.id; delete copy.created_at; delete copy.updated_at; delete copy.last_job_id;
  copy.invoice_number = `${src.invoice_number ?? ""} (สำเนา)`.trim();
  const created = await createDeclaration(
    copy as Record<string, unknown> & { _items?: Record<string, unknown>[] },
    { source: "manual", status: "new" },
  );
  if (!created) { res.status(500).json({ error: "สร้างสำเนาไม่สำเร็จ" }); return; }
  res.json({ ok: true, id: created.id });
});

// รัน RPA สำหรับใบขนใบเดียว → enqueue job (worker หยิบไปกรอกฟอร์ม)
app.post("/api/declarations/:id/run", async (req, res) => {
  if (!supabaseEnabled()) { res.status(400).json({ error: "ยังไม่ได้ตั้งค่า Supabase" }); return; }
  const id = req.params.id;
  try {
    // ---- ตรวจข้อมูลก่อนรัน (กันรันแล้วไม่ผ่าน) ----
    //   ถ้ามี error และไม่ได้ force → ไม่ enqueue, ส่ง issues กลับให้ user แก้ก่อน
    const force = !!(req.body && (req.body as { force?: boolean }).force);
    const declForCheck = await getDeclaration(id);
    if (declForCheck) {
      const check = validateDeclaration(declForCheck as Record<string, unknown> & { _items?: Record<string, unknown>[] });
      if (!check.ok && !force) {
        res.status(422).json({ error: "ข้อมูลไม่ครบ — แก้ไขก่อนรัน", validation: check });
        return;
      }
    }
    // หา index ของใบนี้ใน preview order (worker รับ onlyRows เป็น index)
    const rows = await buildPreviewRows();
    const row = rows.find((r) => String(r.declarationId) === String(id));
    if (!row) { res.status(404).json({ error: "ไม่พบใบขนนี้ในรายการที่ดึงมา (อาจถูกลบ/เปลี่ยน)" }); return; }
    const headless = (req.body && (req.body as { headless?: boolean }).headless) ?? true;
    const jobId = await enqueueJob(
      "rpa_import",
      // declId ลง payload ด้วย (persistent) — bridge fallback อ่านได้แม้เว็บ restart/หน่วยความจำหาย
      { onlyRows: [row.index], headless, declId: id },
      { dryRun: false, triggeredBy: req.user?.id ?? null, triggerSource: "manual" },
    );
    if (!jobId) { res.status(409).json({ error: "กำลังรันอยู่ หรือคิวไม่พร้อม" }); return; }
    await setDeclarationStatus(id, "queued", "ส่งเข้าคิว RPA แล้ว", jobId);
    // ผูก job → declaration id ไว้ ให้ bridge อัปเดตสถานะใบได้
    jobToDeclaration.set(jobId, id);
    jobKind.set(jobId, "import");
    state.running = true;
    state.activeJobId = jobId;
    broadcast("decl-status", { id, status: "queued", message: "ส่งเข้าคิว RPA แล้ว" });
    res.json({ ok: true, jobId });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// พิมพ์ใบขนซ้ำ: RPA ไปค้นใบเดิมใน DCTK (ด้วย declaration_no) → พิมพ์ PDF (ไม่กรอก/ไม่สร้างใหม่)
//   ใช้ตอน finalize ตอนสร้างล้มเหลว (DCTK ค้าง) แต่ใบถูกสร้างใน DCTK แล้ว → มาพิมพ์ใบขนจริงทีหลัง
app.post("/api/declarations/:id/reprint", async (req, res) => {
  if (!supabaseEnabled()) { res.status(400).json({ error: "ยังไม่ได้ตั้งค่า Supabase" }); return; }
  const id = req.params.id;
  try {
    const decl = await getDeclaration(id);
    if (!decl) { res.status(404).json({ error: "ไม่พบรายการ" }); return; }
    const declarationNo = String(decl.declaration_no ?? "").trim();
    if (!declarationNo) {
      res.status(400).json({ error: "ยังไม่มีเลขใบขน DCTK — ต้องมีเลขใบขนก่อนถึงพิมพ์ซ้ำได้" });
      return;
    }
    const rows = await buildPreviewRows();
    const row = rows.find((r) => String(r.declarationId) === String(id));
    if (!row) { res.status(404).json({ error: "ไม่พบใบขนนี้ในรายการที่ดึงมา" }); return; }
    const headless = (req.body && (req.body as { headless?: boolean }).headless) ?? true;
    const jobId = await enqueueJob(
      "rpa_print",
      { onlyRows: [row.index], headless, declId: id, declaration_no: declarationNo },
      { dryRun: false, triggeredBy: req.user?.id ?? null, triggerSource: "manual" },
    );
    if (!jobId) { res.status(409).json({ error: "คิวไม่พร้อม" }); return; }
    await setDeclarationStatus(id, "queued", "ส่งเข้าคิวพิมพ์ใบขนซ้ำ", jobId);
    jobToDeclaration.set(jobId, id);
    jobKind.set(jobId, "print");
    state.running = true;
    state.activeJobId = jobId;
    broadcast("decl-status", { id, status: "queued", message: "ส่งเข้าคิวพิมพ์ใบขนซ้ำ" });
    res.json({ ok: true, jobId });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// แก้ไขใบเดิม: บันทึก patch → RPA ไปค้นใบใน DCTK (ด้วย declaration_no) → แก้ → save
app.post("/api/declarations/:id/edit", async (req, res) => {
  if (!supabaseEnabled()) { res.status(400).json({ error: "ยังไม่ได้ตั้งค่า Supabase" }); return; }
  const id = req.params.id;
  try {
    // 1) บันทึกค่าที่ user แก้ก่อน (patch มาจาก detail modal)
    const patch = (req.body || {}) as Record<string, unknown>;
    if (Object.keys(patch).length) await updateDeclaration(id, patch);
    // 2) ต้องมีเลขใบขน DCTK เพื่อให้ RPA ค้นใบเดิม
    const decl = await getDeclaration(id);
    if (!decl) { res.status(404).json({ error: "ไม่พบรายการ" }); return; }
    const declarationNo = String(decl.declaration_no ?? "").trim();
    if (!declarationNo) {
      res.status(400).json({ error: "ยังไม่มีเลขใบขน DCTK — กรอกเลขใบขนก่อน (จำเป็นต่อการค้นใบเพื่อแก้)" });
      return;
    }
    // 3) หา index ใน preview order
    const rows = await buildPreviewRows();
    const row = rows.find((r) => String(r.declarationId) === String(id));
    if (!row) { res.status(404).json({ error: "ไม่พบใบขนนี้ในรายการที่ดึงมา" }); return; }
    const headless = (req.body && (req.body as { headless?: boolean }).headless) ?? true;
    // 4) enqueue job แก้ไข
    const jobId = await enqueueJob(
      "rpa_edit",
      { onlyRows: [row.index], headless, declId: id, declaration_no: declarationNo },
      { dryRun: false, triggeredBy: req.user?.id ?? null, triggerSource: "manual" },
    );
    if (!jobId) { res.status(409).json({ error: "คิวไม่พร้อม" }); return; }
    await setDeclarationStatus(id, "queued", "ส่งเข้าคิวแก้ไข RPA", jobId);
    jobToDeclaration.set(jobId, id);
    jobKind.set(jobId, "edit");
    state.running = true;
    state.activeJobId = jobId;
    broadcast("decl-status", { id, status: "queued", message: "ส่งเข้าคิวแก้ไข RPA" });
    res.json({ ok: true, jobId });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// upload ไฟล์ → AI สกัด → สร้าง declaration (frontend ส่ง base64)
app.post("/api/upload", async (req, res) => {
  if (!supabaseEnabled()) { res.status(400).json({ error: "ยังไม่ได้ตั้งค่า Supabase" }); return; }
  if (!config.gemini.enabled) { res.status(400).json({ error: "ยังไม่ได้ตั้งค่า Gemini (AI)" }); return; }
  const body = (req.body || {}) as { files?: { filename: string; mimeType?: string; dataBase64: string }[]; customer?: string };
  const files = Array.isArray(body.files) ? body.files : [];
  const customerHint = (body.customer || "").trim();
  if (!files.length) { res.status(400).json({ error: "ไม่มีไฟล์" }); return; }
  try {
    const attachments = files.map((f) => ({
      filename: f.filename || "upload",
      mimeType: f.mimeType || "application/octet-stream",
      bytes: Buffer.from(f.dataBase64, "base64"),
    }));
    broadcast("log", { line: `[UPLOAD] 📤 ประมวลผล ${attachments.length} ไฟล์ด้วย AI…` });
    const { record, customer } = await extractFromAttachments(attachments, (line) => broadcast("log", { line: "[UPLOAD] " + line }), customerHint);
    const needsReview = record._needs_review === true;
    const created = await createDeclaration(record, { source: "upload", status: needsReview ? "new" : "ready" });
    if (!created) { res.status(500).json({ error: "บันทึกรายการไม่สำเร็จ" }); return; }
    // เก็บไฟล์ต้นฉบับ ผูกด้วย customer+invoice
    const inv = String(record.invoice_number ?? "");
    for (const att of attachments) {
      await uploadBytes(att.bytes, att.filename, { customer, invoice: inv, kind: "source" });
    }
    broadcast("log", { line: `[UPLOAD] ✓ สร้างรายการ: ${customer} / ${inv || "(ไม่มี invoice)"}` });
    broadcast("decl-status", { id: created.id, status: needsReview ? "new" : "ready" });
    res.json({ ok: true, id: created.id, customer, invoice: inv, needsReview });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    broadcast("log", { line: "[UPLOAD] ✗ " + msg });
    res.status(500).json({ error: msg });
  }
});

/**
 * เริ่มรัน RPA = enqueue งานลง job_queue (worker บน VM จะมาหยิบไปทำ)
 * web ไม่รัน Playwright เองอีกต่อไป — แค่สั่งงาน + ตามดู log ผ่าน job_logs bridge
 * @return jobId ถ้า enqueue สำเร็จ, null ถ้า Supabase ปิด/กำลังรันอยู่
 */
async function startRun(opts: {
  onlyRows?: number[];
  headless?: boolean;
  dryRun?: boolean;
  trigger?: string;
  triggeredBy?: string | null;
}): Promise<string | null> {
  if (state.running) return null;
  if (!supabaseEnabled()) return null;

  const onlyRows = Array.isArray(opts.onlyRows) ? opts.onlyRows : undefined;
  const dryRun = !!opts.dryRun;

  const jobId = await enqueueJob(
    "rpa_import",
    { onlyRows, headless: opts.headless },
    {
      dryRun,
      triggeredBy: opts.triggeredBy ?? null,
      triggerSource: opts.trigger ? "schedule" : "manual",
    },
  );
  if (!jobId) return null;

  // ตั้ง state ฝั่งเว็บ (จะถูกอัปเดตจริงจาก job_logs bridge)
  state.running = true;
  state.stopRequested = false;
  state.startedAt = Date.now();
  state.rows = [];
  state.result = null;
  state.mode = onlyRows && onlyRows.length ? "selected" : "all";
  state.activeJobId = jobId;

  if (opts.trigger) broadcast("log", { line: `[WEB] ⏱ สั่งรันอัตโนมัติ (${opts.trigger}) → job ${jobId.slice(0, 8)}` });
  else broadcast("log", { line: `[WEB] ส่งงานเข้าคิวแล้ว (job ${jobId.slice(0, 8)}) — รอ worker หยิบไปทำ` });
  if (dryRun) broadcast("log", { line: "[WEB] โหมด DRY RUN" });

  return jobId;
}

// ---- Bridge: job_logs (Realtime) → SSE broadcast --------------
// map kind ใน job_logs → ชื่อ SSE event เดิม (frontend ไม่ต้องแก้)
function bridgeJobLog(row: JobLogRow): void {
  // สนใจเฉพาะ log ของงานที่ active อยู่
  if (state.activeJobId && row.job_id !== state.activeJobId) return;
  const p = row.payload as Record<string, unknown>;
  switch (row.kind) {
    case "log":
      broadcast("log", p);
      break;
    case "row":
      // payload = { rows: [...] }
      if (Array.isArray((p as { rows?: unknown }).rows)) {
        state.rows = (p as { rows: RowInfo[] }).rows;
        broadcast("rows", state.rows);
      }
      break;
    case "row-status":
      {
        const rs = p as unknown as RowInfo;
        if (rs && typeof rs.index === "number") state.rows[rs.index - 1] = rs;
        broadcast("row-status", rs);
      }
      break;
    case "document":
      broadcast("document", p);
      break;
    case "capture-meta":
      // RPA capture เลขใบขน DCTK → เก็บลง declarations.declaration_no
      {
        const declId = jobToDeclaration.get(row.job_id) || String((p as { declarationId?: string }).declarationId ?? "");
        const declNo = String((p as { declarationNo?: string }).declarationNo ?? "").trim();
        if (declId && declNo) {
          void updateDeclaration(declId, { declaration_no: declNo });
          broadcast("decl-meta", { id: declId, declaration_no: declNo });
        }
      }
      break;
    case "lifecycle":
      void (async () => {
        const ev = String((p as { event?: string }).event || "");
        // หา declId: map ในหน่วยความจำก่อน → ถ้าหาย (เช่น server restart) fallback อ่านจาก job payload (persistent)
        let declId = jobToDeclaration.get(row.job_id);
        let isEdit = jobKind.get(row.job_id) === "edit";
        if (!declId) {
          try {
            const job = await getJob(row.job_id);
            const jp = (job?.payload ?? {}) as { declId?: string };
            if (jp.declId) declId = jp.declId;
            if (job?.type === "rpa_edit") isEdit = true;
          } catch { /* ignore */ }
        }
        if (ev === "run-start") {
          broadcast("run-start", p);
          if (declId) {
            const m = isEdit ? "กำลังแก้ไขใบขน…" : "กำลังกรอกฟอร์ม…";
            void setDeclarationStatus(declId, "running", m, row.job_id);
            broadcast("decl-status", { id: declId, status: "running", message: m });
          }
        } else if (ev === "run-done") {
          state.result = (p as { result?: RunResult }).result ?? null;
          state.running = false;
          broadcast("run-done", state.result);
          broadcast("run-end", snapshot());
          if (declId) {
            const r = state.result;
            const ok = r ? (r.errors ?? 0) === 0 : true;
            // สำเร็จ: edit → "edited", create → "done"
            const status = ok ? (isEdit ? "edited" : "done") : "error";
            const msg = ok
              ? (isEdit ? "แก้ไขใบขนเสร็จ" : "กรอก + พิมพ์ PDF เสร็จ")
              : "RPA มีข้อผิดพลาด — ดูประวัติงาน";
            void setDeclarationStatus(declId, status, msg, row.job_id);
            broadcast("decl-status", { id: declId, status, message: msg });
            jobToDeclaration.delete(row.job_id);
            jobKind.delete(row.job_id);
          }
          state.activeJobId = null;
        } else if (ev === "run-error") {
          state.running = false;
          const emsg = (p as { error?: string }).error || "error";
          broadcast("run-error", { error: emsg });
          broadcast("run-end", snapshot());
          if (declId) {
            void setDeclarationStatus(declId, "error", String(emsg).slice(0, 200), row.job_id);
            broadcast("decl-status", { id: declId, status: "error", message: String(emsg).slice(0, 200) });
            jobToDeclaration.delete(row.job_id);
            jobKind.delete(row.job_id);
          }
          state.activeJobId = null;
        }
      })();
      break;
  }
}

// เริ่ม subscribe Realtime (ครั้งเดียวตอน boot)
function startJobBridge(): void {
  if (!supabaseEnabled()) return;
  subscribeJobLogs(
    (logRow) => bridgeJobLog(logRow),
    (jobRow: JobRow) => {
      // อัปเดตสถานะ active job เมื่อถูก cancel/done จากที่อื่น
      if (state.activeJobId && jobRow.id === state.activeJobId) {
        if (jobRow.status === "done" || jobRow.status === "error" || jobRow.status === "cancel") {
          state.running = false;
          if (jobRow.status === "cancel") {
            broadcast("log", { line: "[WEB] งานถูกยกเลิก" });
            broadcast("run-end", snapshot());
            state.activeJobId = null;
          }
        }
      }
    },
  );
}

// เริ่มรัน = enqueue งานเข้าคิว (worker บน VM จะหยิบไปทำ)
app.post("/api/run", async (req, res) => {
  const body = req.body as { onlyRows?: number[]; headless?: boolean; dryRun?: boolean };
  if (!supabaseEnabled()) {
    res.status(400).json({ error: "ยังไม่ได้ตั้งค่า Supabase (คิวงานต้องใช้ Supabase)" });
    return;
  }
  const jobId = await startRun({ ...body, triggeredBy: req.user?.id ?? null });
  if (!jobId) {
    res.status(409).json({ error: "กำลังรันอยู่แล้ว" });
    return;
  }
  res.json({ ok: true, jobId });
});

// ขอหยุด = สั่ง cancel งานในคิว (worker จะหยุดก่อนแถวถัดไป)
app.post("/api/stop", async (_req, res) => {
  const n = await cancelActiveJobs("rpa_import");
  state.stopRequested = true;
  broadcast("log", { line: `[WEB] ส่งคำสั่งยกเลิก ${n} งาน — worker จะหยุดหลังแถวปัจจุบัน` });
  res.json({ ok: true, cancelled: n });
});

// ---- Jobs (history + replay) -------------------------------
app.get("/api/jobs", async (req, res) => {
  if (!supabaseEnabled()) { res.json({ enabled: false, jobs: [] }); return; }
  const type = req.query.type as ("rpa_import" | "get_email" | "rpa_edit" | undefined);
  res.json({ enabled: true, jobs: await listJobs(200, type) });
});

app.get("/api/jobs/:id", async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) { res.status(404).json({ error: "ไม่พบงาน" }); return; }
  res.json({ ok: true, job });
});

app.get("/api/jobs/:id/logs", async (req, res) => {
  const after = Number(req.query.after ?? 0) || 0;
  const logs = await getJobLogs(req.params.id, after);
  // ส่งทั้ง log ดิบ + สรุปสาเหตุ (อ่านง่าย) + log เต็มที่กรองแล้ว
  res.json({
    ok: true,
    logs,
    summary: summarizeJobError(logs),
    lines: extractLogLines(logs),
  });
});

// ---- Documents (Supabase) ----------------------------------
app.get("/api/documents", async (_req, res) => {
  if (!supabaseEnabled()) {
    res.json({ enabled: false, documents: [] });
    return;
  }
  const documents = await listDocuments(200);
  res.json({ enabled: true, documents });
});

// คืน URL ดาวน์โหลด (signed ถ้า private) แล้ว redirect
app.get("/api/documents/download", async (req, res) => {
  const storagePath = String(req.query.path ?? "");
  const fallback = req.query.url ? String(req.query.url) : null;
  if (!storagePath) {
    res.status(400).json({ error: "ต้องระบุ path" });
    return;
  }
  const url = await getDownloadUrl(storagePath, fallback);
  if (!url) {
    res.status(404).json({ error: "ไม่พบเอกสาร" });
    return;
  }
  res.redirect(url);
});

// ---- Field catalog (ทุกช่อง DCTK จัดกลุ่มตามหน้า จาก inspect) ----
const FIELD_CATALOG_PATH = path.join(RPA_ROOT, "dist", "data", "field-catalog.json");
let _fieldCatalog: { key: string; label: string; page: number; type: string; selector: string }[] | null = null;
async function getFieldCatalog() {
  if (_fieldCatalog) return _fieldCatalog;
  try {
    _fieldCatalog = JSON.parse(await readFile(FIELD_CATALOG_PATH, "utf-8"));
  } catch {
    _fieldCatalog = [];
  }
  return _fieldCatalog!;
}
app.get("/api/field-catalog", async (_req, res) => {
  res.json({ fields: await getFieldCatalog() });
});

// ---- Customer settings (field rules + presets) -------------
app.get("/api/customer-settings", async (_req, res) => {
  res.json({
    enabled: supabaseEnabled(),
    fields: RULE_FIELDS,
    settings: supabaseEnabled() ? await listCustomerSettings() : [],
  });
});

app.post("/api/customer-settings", requireAdmin, async (req, res) => {
  if (!supabaseEnabled()) {
    res.status(400).json({ error: "ยังไม่ได้ตั้งค่า Supabase" });
    return;
  }
  const body = req.body as {
    customer_name?: string;
    allowed_fields?: string[];
    presets?: { [k: string]: string };
    extraction_rules?: string;
    request_screenshot?: boolean;
  };
  const name = (body.customer_name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "ต้องระบุชื่อลูกค้า" });
    return;
  }
  const ok = await upsertCustomerSetting({
    customer_name: name,
    allowed_fields: Array.isArray(body.allowed_fields) ? body.allowed_fields : [],
    presets: body.presets ?? {},
    extraction_rules: body.extraction_rules,
    request_screenshot: body.request_screenshot,
  });
  res.json({ ok });
});

// AI ร่าง extraction logic ของลูกค้าใหม่ จากอีเมลตัวอย่าง (subject)
//   รับ {customer_name, subject, comment?, previousDraft?} → คืน {rules, sampleCount}
//   comment+previousDraft = รอบแก้ (ผู้ใช้ส่ง feedback ให้ AI ปรับ)
app.post("/api/customer-settings/ai-draft", requireAdmin, async (req, res) => {
  if (!getEmailReady()) {
    res.status(400).json({ error: "ยังไม่ได้ตั้งค่า Gmail/Gemini — ตั้งค่าก่อนใช้ AI ร่างกฎ" });
    return;
  }
  const body = (req.body || {}) as {
    customer_name?: string; subject?: string; comment?: string; previousDraft?: string;
  };
  const customer = String(body.customer_name ?? "").trim();
  const subject = String(body.subject ?? "").trim();
  if (!subject) { res.status(400).json({ error: "ต้องระบุ Subject ตัวอย่าง" }); return; }
  try {
    const result = await draftCustomerLogic(
      customer, subject,
      String(body.comment ?? ""), String(body.previousDraft ?? ""),
      (line) => broadcast("gas-log", { line: "[AI-SETUP] " + line }),
    );
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: String((err as Error).message || err) });
  }
});

app.delete("/api/customer-settings", requireAdmin, async (req, res) => {
  if (!supabaseEnabled()) {
    res.status(400).json({ error: "ยังไม่ได้ตั้งค่า Supabase" });
    return;
  }
  const name = String(req.query.customer ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "ต้องระบุชื่อลูกค้า" });
    return;
  }
  const ok = await deleteCustomerSetting(name);
  res.json({ ok });
});

// ---- Schedule (ตั้งเวลารัน Import อัตโนมัติ) ----------------
app.get("/api/schedule", (_req, res) => {
  res.json({ supabase: supabaseEnabled(), ...getSchedule() });
});

app.post("/api/schedule", requireAdmin, async (req, res) => {
  const body = req.body as Partial<ScheduleConfig>;
  await updateSchedule(body);
  res.json({ ok: true, ...getSchedule() });
});

// ---- Email poll schedule (ดึงอีเมลอัตโนมัติ) ----
app.get("/api/email-schedule", (_req, res) => {
  res.json({ ready: getEmailReady(), ...getEmailSchedule() });
});

app.post("/api/email-schedule", requireAdmin, async (req, res) => {
  const body = req.body as Partial<ScheduleConfig>;
  await updateEmailSchedule(body);
  res.json({ ok: true, ...getEmailSchedule() });
});

// ---- Declarations (ผลจาก Get Email — แทน Sheet รายการ) -----
app.get("/api/declarations", async (_req, res) => {
  res.json({
    enabled: supabaseEnabled(),
    declarations: supabaseEnabled() ? await listDeclarations(50) : [],
  });
});

// ---- Email rules (กรอง sender/subject ของ Get Email) -------
app.get("/api/email-rules", async (_req, res) => {
  res.json({
    enabled: supabaseEnabled(),
    rules: supabaseEnabled() ? await listEmailRules() : [],
  });
});

app.post("/api/email-rules", requireAdmin, async (req, res) => {
  if (!supabaseEnabled()) {
    res.status(400).json({ error: "ยังไม่ได้ตั้งค่า Supabase" });
    return;
  }
  const body = req.body as { sender?: string; subject?: string; note?: string };
  const sender = (body.sender ?? "").trim();
  if (!sender) {
    res.status(400).json({ error: "ต้องระบุอีเมลผู้ส่ง" });
    return;
  }
  const ok = await upsertEmailRule({ sender, subject: body.subject ?? "", note: body.note ?? "" });
  res.json({ ok });
});

app.delete("/api/email-rules", requireAdmin, async (req, res) => {
  if (!supabaseEnabled()) {
    res.status(400).json({ error: "ยังไม่ได้ตั้งค่า Supabase" });
    return;
  }
  const sender = String(req.query.sender ?? "").trim();
  if (!sender) {
    res.status(400).json({ error: "ต้องระบุอีเมลผู้ส่ง" });
    return;
  }
  const ok = await deleteEmailRule(sender);
  res.json({ ok });
});

// ---- จัดการผู้ใช้ (admin เท่านั้น) — สร้าง/ดู/ลบ user ให้พนักงาน ----
app.get("/api/users", requireAdmin, async (_req, res) => {
  const sc = serviceClient();
  if (!sc) { res.status(400).json({ error: "ยังไม่ได้ตั้งค่า Supabase" }); return; }
  try {
    const { data, error } = await sc.auth.admin.listUsers({ page: 1, perPage: 200 });
    if (error) throw error;
    // ดึง role จาก profiles
    const ids = data.users.map((u) => u.id);
    const roleMap: Record<string, string> = {};
    if (ids.length) {
      const { data: profs } = await sc.from("profiles").select("id, role").in("id", ids);
      (profs ?? []).forEach((p: { id: string; role: string }) => (roleMap[p.id] = p.role));
    }
    const users = data.users.map((u) => ({
      id: u.id,
      email: u.email ?? "",
      role: roleMap[u.id] ?? "user",
      created_at: u.created_at,
      confirmed: !!u.email_confirmed_at,
    }));
    res.json({ enabled: true, users });
  } catch (err) {
    res.status(500).json({ error: String((err as Error).message || err) });
  }
});

app.post("/api/users", requireAdmin, async (req, res) => {
  const sc = serviceClient();
  if (!sc) { res.status(400).json({ error: "ยังไม่ได้ตั้งค่า Supabase" }); return; }
  const body = (req.body || {}) as { email?: string; password?: string; role?: string };
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const role = body.role === "admin" ? "admin" : "user";
  if (!email || !password) { res.status(400).json({ error: "ต้องระบุอีเมลและรหัสผ่าน" }); return; }
  if (password.length < 6) { res.status(400).json({ error: "รหัสผ่านต้องอย่างน้อย 6 ตัว" }); return; }
  try {
    // สร้าง user (ยืนยันอีเมลให้เลย เพราะ admin สร้างให้พนักงาน)
    const { data, error } = await sc.auth.admin.createUser({
      email, password, email_confirm: true,
    });
    if (error) throw error;
    const uid = data.user?.id;
    if (uid) {
      // บันทึก role + email ลง profiles (upsert)
      await sc.from("profiles").upsert({ id: uid, email, role }, { onConflict: "id" });
    }
    res.json({ ok: true, id: uid });
  } catch (err) {
    res.status(500).json({ error: String((err as Error).message || err) });
  }
});

app.delete("/api/users/:id", requireAdmin, async (req, res) => {
  const sc = serviceClient();
  if (!sc) { res.status(400).json({ error: "ยังไม่ได้ตั้งค่า Supabase" }); return; }
  const uid = String(req.params.id);
  try {
    const { error } = await sc.auth.admin.deleteUser(uid);
    if (error) throw error;
    await sc.from("profiles").delete().eq("id", uid);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String((err as Error).message || err) });
  }
});

// ---- Gemini model (เลือกจากหน้าเว็บ; GAS อ่านจาก app_settings) ----
app.get("/api/model", async (_req, res) => {
  const model = supabaseEnabled() ? await getAppSetting<string>("gemini_model") : null;
  res.json({ enabled: supabaseEnabled(), model: model || "gemini-2.5-flash" });
});

app.post("/api/model", requireAdmin, async (req, res) => {
  if (!supabaseEnabled()) {
    res.status(400).json({ error: "ยังไม่ได้ตั้งค่า Supabase" });
    return;
  }
  const model = String((req.body as { model?: string }).model ?? "").trim();
  if (!model) {
    res.status(400).json({ error: "ต้องระบุ model" });
    return;
  }
  const ok = await setAppSetting("gemini_model", model);
  res.json({ ok, model });
});

// ---- Get Email (GAS) ---------------------------------------
app.get("/api/gas/config", (_req, res) => {
  // Get Email พร้อมใช้เมื่อ: Node pipeline (Gmail+Gemini) หรือ GAS เดิม
  res.json({ enabled: getEmailReady() || gasEnabled(), mode: getEmailReady() ? "node" : (gasEnabled() ? "gas" : "off") });
});

// สั่งรัน Get Email — ใช้ Node pipeline ก่อน (ถ้าตั้งค่าครบ) ไม่งั้น fallback GAS เดิม
app.post("/api/gas/run", async (req, res) => {
  const subject = (req.body && (req.body as { subject?: string }).subject) || undefined;

  if (getEmailReady()) {
    // รัน Node pipeline ใน-process (Gmail API + Gemini — ไม่ต้องใช้เบราว์เซอร์)
    broadcast("gas-log", { line: subject ? `[GET-EMAIL] ▶ รัน (subject: ${subject})…` : "[GET-EMAIL] ▶ ดึงอีเมล…" });
    try {
      const summary = await processInbox(subject, (line) => broadcast("gas-log", { line: "[GET-EMAIL] " + line }));
      lastGetEmailSummary = summary;
      broadcast("gas-done", { ok: true, summary });
      broadcast("decl-changed", { reason: "manual-poll" });
      res.json({ ok: true, summary });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      broadcast("gas-done", { ok: false, error: msg });
      broadcast("gas-log", { line: `[GET-EMAIL] ✗ ล้มเหลว: ${msg}` });
      res.status(500).json({ ok: false, error: msg });
    }
    return;
  }

  // fallback: GAS เดิม
  if (!gasEnabled()) {
    res.status(400).json({ ok: false, error: "ยังไม่ได้ตั้งค่า Get Email (Gmail OAuth) หรือ GAS_WEBAPP_URL" });
    return;
  }
  broadcast("gas-log", { line: subject ? `[GAS] ▶ สั่งรัน (subject: ${subject})…` : "[GAS] ▶ สั่งรัน processInbox…" });
  const result = await runGet(subject);
  broadcast("gas-done", result);
  res.json(result);
});

app.get("/api/gas/status", async (_req, res) => {
  // คืน declarations จาก Get Email (source=get-email) มาแสดงในตารางผล
  const declarations = supabaseEnabled() ? await listDeclarations(50) : [];
  if (getEmailReady()) {
    res.json({ ok: true, enabled: true, mode: "node", lastRun: lastGetEmailSummary, latestRows: declarations });
    return;
  }
  if (!gasEnabled()) { res.json({ ok: false, enabled: false, latestRows: declarations }); return; }
  const result = await gasGetStatus();
  res.json({ enabled: true, mode: "gas", latestRows: declarations, ...result });
});

function maskConfig(cfg: AppConfig) {
  return {
    url: cfg.url,
    username: cfg.username,
    password: cfg.password ? "********" : "",
    headless: cfg.headless ?? false,
    slow_mo_ms: cfg.slow_mo_ms ?? 0,
    default_timeout_ms: cfg.default_timeout_ms ?? 30000,
    download_dir: cfg.download_dir ?? "file download",
    google_sheet: {
      enabled: cfg.google_sheet?.enabled ?? false,
      sheet_name: cfg.google_sheet?.sheet_name ?? "",
    },
    email: {
      enabled: cfg.email?.enabled ?? false,
      recipient: cfg.email?.recipient ?? "",
      subject: cfg.email?.subject ?? "",
    },
  };
}

// ลงทะเบียน runner ให้ scheduler (auto-run = headless + ตามโหมดที่ตั้ง)
setRunner(async (dryRun) => {
  await startRun({ headless: true, dryRun, trigger: "ตั้งเวลา" });
});

// ลงทะเบียน email runner (auto-poll อีเมล) — กันรันซ้อน
let emailPolling = false;
async function pollEmailOnce(log: (line: string) => void): Promise<InboxSummary | null> {
  if (!getEmailReady()) { log("ยังไม่ได้ตั้งค่า Gmail/Gemini — ข้าม"); return null; }
  if (emailPolling) { log("กำลังดึงอีเมลอยู่ — ข้ามรอบนี้"); return null; }
  emailPolling = true;
  try {
    const summary = await processInbox(undefined, log);
    lastGetEmailSummary = summary;
    return summary;
  } finally {
    emailPolling = false;
  }
}
setEmailRunner(async () => {
  await pollEmailOnce((line) => broadcast("gas-log", { line: "[AUTO] " + line }));
  // แจ้ง frontend ให้รีโหลดรายการ (มีใบใหม่จากอีเมล)
  broadcast("decl-changed", { reason: "email-poll" });
});

// ---- Global error handler (ตัวสุดท้าย) — กัน error หลุดนอก try/catch ----
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[rpa-web] unhandled error:", err);
  if (res.headersSent) return;
  res.status(500).json({ ok: false, error: "เกิดข้อผิดพลาดภายในระบบ" });
});

app.listen(PORT, async () => {
  console.log(`[rpa-web] เปิดที่ http://localhost:${PORT}`);
  console.log(`[rpa-web] config: ${CONFIG_PATH}`);
  // เริ่ม bridge: job_logs (Realtime) → SSE (worker logs ไหลเข้าเว็บ)
  try {
    startJobBridge();
    console.log("[rpa-web] job-log bridge: เริ่มแล้ว");
  } catch (e) {
    console.error("[rpa-web] startJobBridge error:", String(e));
  }
  // โหลด + เริ่ม schedule ที่บันทึกไว้ (ถ้ามี)
  try {
    await initScheduler();
  } catch (e) {
    console.error("[rpa-web] initScheduler error:", String(e));
  }
});
