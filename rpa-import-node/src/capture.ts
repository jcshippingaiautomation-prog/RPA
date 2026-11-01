// ============================================================
//  แคปหน้าจอใบขนที่มีอยู่แล้วใน DCTK รวมเป็น PDF ไฟล์เดียว
//
//  ใช้กับปุ่ม "📸 แคปหน้าจอ" บนเว็บ (ใบที่ระบบเราสร้าง) และเมนู "แคปหน้าจอใบขน" (ใส่เลขเอง)
//  เมนูทำ 2 ขั้น: scanDeclaration ดึงรายการมาให้เลือก → captureExistingDeclaration แคปเฉพาะที่เลือก
//  ลำดับ: หัวใบขน → ตารางใบกำกับ & รายการ → ฟอร์มใบกำกับ → รายการสินค้า (แท็บทั่วไป + สิทธิประโยชน์) → การแลกเปลี่ยนข้อมูล
//
//  ⚠ อ่านอย่างเดียว:
//    - ไม่กดบันทึก/ยืนยันใด ๆ ทั้งสิ้น
//    - ใบที่ยื่นกรมฯ แล้ว DCTK จะถาม "ปรับสถานะเอกสารให้พร้อมแก้ไข" → ตอบ NO เสมอ (openDeclarationForEdit)
//    - กล่องคำถามของเบราว์เซอร์ (confirm/alert) ตอบ "ยกเลิก" ทุกกล่อง
//    - ใบที่ยื่นแล้ว DCTK อาจไม่ให้เปิดรายละเอียดรายการสินค้า → แคปตารางรายการไว้แทน และบอกใน log
// ============================================================
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, type Page, type BrowserContext } from "playwright";
import { PDFDocument } from "pdf-lib";
import { loadConfig, PROJECT_ROOT } from "./runner.js";
import type { AppConfig } from "./types.js";
import { login, openDeclarationForEdit } from "./pages.js";
import { log, sleep, waitForPageReady, setRunHooks, stepProgress, detailProgress, checkStop, StopRequested, type RunProgress } from "./helpers.js";
import * as S from "./selectors.js";

const SEL_TAB3 = "#TabStrip > ul > li:nth-child(3) > span.k-link";
/** หน้ารายการสินค้ามี 2 แท็บ: "ทั่วไป" · "สิทธิประโยชน์/ภาษีอากร" (สำรวจจริง 1 พ.ย. 2569) */
const SEL_ITEM_TAB2 = "#TabStrip > ul > li:nth-child(2) > span.k-link";

/** ส่วนที่จะแคป — ไม่ส่ง = ทุกหน้า ทุกรายการ (ค่าเริ่มต้น) */
export interface CaptureSelection {
  /** หน้า 1 ใบขนสินค้าขาออก (หัวใบ) */
  header?: boolean;
  /** หน้า 2 ตารางใบกำกับ & รายการสินค้า */
  list?: boolean;
  /** ฟอร์มใบกำกับสินค้า */
  invoice?: boolean;
  /** หน้า 3 การแลกเปลี่ยนข้อมูล */
  exchange?: boolean;
  /** รายการสินค้าที่เลือก (ItemNo ใน DCTK) — general = แท็บ "ทั่วไป" · privilege = แท็บ "สิทธิประโยชน์/ภาษีอากร" */
  items?: { no: number; general?: boolean; privilege?: boolean }[];
}

/** ข้อมูลใบที่ดึงมาให้ผู้ใช้เลือกก่อนแคป */
export interface DeclarationScan {
  ref: string;
  referenceNo: string;
  invoices: { no: string; date: string; consignee: string }[];
  items: { no: number; invoiceNo: string; productCode: string; description: string; tariff: string; quantity: string; unit: string; amount: string; currency: string }[];
  status: string;
}

export interface CaptureResult {
  pdf: string | null;
  shots: number;
  invoice: string;
  notes: string[];
  /** ผู้ใช้กดยกเลิกระหว่างแคป (ไม่สร้าง PDF) */
  stopped?: boolean;
}

export async function captureExistingDeclaration(opts: {
  ref: string;
  headless?: boolean;
  configOverrides?: Partial<AppConfig>;
  shouldStop?: () => boolean;
  onProgress?: (p: RunProgress) => void;
  select?: CaptureSelection | null;
}): Promise<CaptureResult> {
  const ref = opts.ref.trim();
  if (!ref) throw new Error("ต้องระบุเลขอ้างอิง DCTK / เลขใบขน / เลขใบกำกับ");
  const cfg: AppConfig = { ...(await loadConfig()), ...(opts.configOverrides ?? {}) };
  const headless = opts.headless ?? cfg.headless ?? true;
  const outDir = cfg.download_dir ? path.resolve(PROJECT_ROOT, cfg.download_dir) : path.join(PROJECT_ROOT, "file download");
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const safeRef = ref.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40);
  const shots: string[] = [];
  const notes: string[] = [];
  let invoice = "";
  let stopped = false;
  setRunHooks({ stop: opts.shouldStop, progress: opts.onProgress });

  const browser = await chromium.launch({ headless });
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  // ทุกกล่องคำถามของเบราว์เซอร์ → ยกเลิก (งานนี้ไม่ต้องยืนยันอะไรเลย)
  context.on("page", (p) => p.on("dialog", (d) => { log(`  💬 กล่องคำถาม "${d.message().slice(0, 80)}" → ยกเลิก`); void d.dismiss().catch(() => {}); }));
  const page = await context.newPage();
  page.on("dialog", (d) => { log(`  💬 กล่องคำถาม "${d.message().slice(0, 80)}" → ยกเลิก`); void d.dismiss().catch(() => {}); });
  page.setDefaultTimeout(cfg.default_timeout_ms ?? 30000);

  const shot = async (p: Page, label: string) => {
    const file = path.join(outDir, `cap_${safeRef}_${String(shots.length + 1).padStart(2, "0")}_${label}_${stamp}.png`);
    await p.screenshot({ path: file, fullPage: true });
    shots.push(file);
    log(`  📸 ${label}`);
  };

  // ไม่เลือกอะไรมา = ทุกหน้า ทุกรายการ ทั้ง 2 แท็บ (ค่าเริ่มต้น)
  const sel = opts.select ?? null;
  const want = (k: "header" | "list" | "invoice" | "exchange") => !sel || sel[k] === true;

  try {
    log(`📸 แคปหน้าจอใบขน ${ref}${sel ? " (เฉพาะที่เลือก)" : " (ทุกหน้า ทุกรายการ)"}`);
    await loginAndOpen(page, cfg, ref, 4);

    // ── หน้า 1 ──
    stepProgress(3, 4, "แคปหน้าจอทีละหน้า");
    checkStop();
    if (want("header")) await shot(page, "หน้า1_หัวใบขน");

    // ── หน้า 2 "ใบกำกับสินค้า & ส่วนรายละเอียด": ตารางใบกำกับ + ตารางรายการสินค้า อยู่หน้าเดียวกัน ──
    await openTab2(page, notes);
    invoice = await page.evaluate(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const d = (window as any).$?.("#gridExInvoice").data("kendoGrid")?.dataSource?.data?.() ?? [];
      return d.length ? String(d[0].InvoiceNo ?? d[0].InvoiceNoText ?? "") : "";
    }).catch(() => "");
    if (want("list")) await shot(page, "หน้า2_ใบกำกับและรายการสินค้า");

    // ฟอร์มใบกำกับ (เปิดแท็บใหม่)
    if (want("invoice")) {
      const invPage = await openInNewTab(context, page, "#gridExInvoice tbody tr[data-uid]");
      if (invPage) {
        await shot(invPage, "ฟอร์มใบกำกับ");
        await invPage.close().catch(() => {});
      } else {
        notes.push("เปิดฟอร์มใบกำกับไม่ได้");
      }
    }

    // รายการสินค้า (เปิดแท็บใหม่ทีละรายการ) — จับคู่ "รายการที่" กับแถวในตารางผ่านข้อมูลของตาราง ไม่ใช่ลำดับแถวบนจอ
    const rows = await page.evaluate(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const d: any[] = (window as any).$?.("#gridExDecDtl").data("kendoGrid")?.dataSource?.data?.() ?? [];
      return d.map((r) => ({ no: Number(r.ItemNo), uid: String(r.uid) }));
    }).catch(() => [] as { no: number; uid: string }[]);
    const plan = sel
      ? (sel.items ?? []).filter((x) => x.general || x.privilege)
      : rows.map((r) => ({ no: r.no, general: true, privilege: true }));
    log(`  รายการสินค้าในใบ ${rows.length} รายการ · แคป ${plan.length} รายการ`);
    let itemFail = 0;
    for (let i = 0; i < plan.length; i++) {
      const it = plan[i];
      detailProgress(`รายการสินค้า ${i + 1}/${plan.length}`);
      checkStop();
      const row = rows.find((r) => r.no === it.no);
      if (!row) { itemFail++; notes.push(`ไม่พบรายการที่ ${it.no} ในใบ`); continue; }
      const itemPage = await openInNewTab(context, page, `#gridExDecDtl tbody tr[data-uid="${row.uid}"]`);
      if (!itemPage) { itemFail++; continue; }
      if (it.general) await shot(itemPage, `รายการ${it.no}_ทั่วไป`);
      if (it.privilege) {
        const ok = await itemPage.click(SEL_ITEM_TAB2, { timeout: 10000 }).then(() => true).catch(() => false);
        if (ok) { await sleep(2000); await shot(itemPage, `รายการ${it.no}_สิทธิประโยชน์`); }
        else notes.push(`เปิดแท็บสิทธิประโยชน์ของรายการที่ ${it.no} ไม่ได้`);
      }
      await itemPage.close().catch(() => {});
      await sleep(800);
    }
    if (itemFail) notes.push(`เปิดรายละเอียดรายการสินค้าไม่ได้ ${itemFail} จาก ${plan.length} รายการ`);

    // ── หน้า 3 "การแลกเปลี่ยนข้อมูล" (ประวัติส่งข้อมูล/คำตอบจากกรมฯ) ──
    if (want("exchange")) {
      checkStop();
      await page.click(SEL_TAB3).catch(() => { notes.push("เปิดแท็บการแลกเปลี่ยนข้อมูลไม่ได้"); });
      await sleep(2500);
      await shot(page, "หน้า3_การแลกเปลี่ยนข้อมูล");
    }
  } catch (e) {
    if (e instanceof StopRequested) {
      stopped = true;
      log("  ⏹ ผู้ใช้กดยกเลิก — หยุดแคปหน้าจอ (ไม่ได้แตะอะไรในใบ)");
    } else notes.push(`หยุดกลางทาง: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
    if (!stopped) log(`  ✗ ${notes[notes.length - 1]}`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    setRunHooks(null);
  }

  if (stopped) return { pdf: null, shots: shots.length, invoice, notes, stopped: true };
  if (!shots.length) return { pdf: null, shots: 0, invoice, notes };
  stepProgress(4, 4, "รวมภาพเป็น PDF", false);
  // รวมภาพเป็น PDF ไฟล์เดียว (หน้าละ 1 ภาพ ขนาดตามภาพจริง)
  const pdf = await PDFDocument.create();
  for (const f of shots) {
    const img = await pdf.embedPng(await readFile(f));
    pdf.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
  const out = path.join(outDir, `Capture_${safeRef}_${stamp}.pdf`);
  await writeFile(out, await pdf.save());
  log(`📄 รวมภาพหน้าจอ ${shots.length} ภาพ → ${path.basename(out)}${notes.length ? ` · หมายเหตุ: ${notes.join(" · ")}` : ""}`);
  return { pdf: out, shots: shots.length, invoice, notes };
}

/**
 * ดับเบิลคลิกแถวแล้วรอแท็บใหม่ (DCTK เปิดฟอร์มใบกำกับ/รายการสินค้าในแท็บใหม่)
 *   ใบที่ยื่นกรมฯ แล้ว DCTK จะถาม "ต้องการปรับสถานะเอกสารให้พร้อมแก้ไขหรือไม่" [YES][NO][CANCEL]
 *   → กด NO ของกล่องที่ "มองเห็นอยู่" เท่านั้น (ห้าม YES เด็ดขาด = เปลี่ยนสถานะใบจริง)
 */
async function openInNewTab(context: BrowserContext, cur: Page, rowSel: string): Promise<Page | null> {
  let fresh: Page | null = null;
  const onPage = (p: Page) => { fresh = p; };
  context.on("page", onPage);
  try {
    try {
      await cur.locator(rowSel).first().dblclick({ timeout: 15000 });
    } catch { return null; }
    for (let i = 0; i < 40 && !fresh; i++) {          // รอสูงสุด ~20 วินาที
      const said = await cur.evaluate(() => {
        // กล่องคำถามลอยทับหน้า (position: fixed) → offsetParent เป็น null แม้มองเห็น ต้องวัดขนาดบนจอแทน
        const vis = (el: Element) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          const cs = getComputedStyle(el as HTMLElement);
          return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
        };
        const box = Array.from(document.querySelectorAll(".modal, [role='dialog'], .k-window")).find(
          (m) => vis(m) && /ปรับสถานะ|พร้อมแก้ไข/.test((m as HTMLElement).innerText || ""));
        if (!box) return "";
        const no = Array.from(box.querySelectorAll("button, input[type=button]")).find(
          (b) => vis(b) && (((b as HTMLElement).innerText || (b as HTMLInputElement).value || "").trim().toUpperCase() === "NO"));
        if (!no) return "";
        (no as HTMLElement).click();
        return "NO";
      }).catch(() => "");
      if (said) log("  ℹ DCTK ถามว่าจะปรับสถานะใบให้แก้ไขได้ไหม → ตอบ NO (ไม่แตะสถานะใบจริง)");
      await sleep(500);
    }
  } finally {
    context.off("page", onPage);
  }
  const p = fresh as Page | null;
  if (!p) return null;
  await p.waitForLoadState("domcontentloaded").catch(() => { /* */ });
  await p.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => { /* */ });
  await sleep(2000);
  return p;
}

/** เปิด DCTK → login → เปิดใบ (อ่านอย่างเดียว) — ขั้น 1–2 ของทั้งงานแคปและงานดึงข้อมูล */
async function loginAndOpen(page: Page, cfg: AppConfig, ref: string, total: number): Promise<void> {
  stepProgress(1, total, "เปิดระบบ DCTK และเข้าสู่ระบบ");
  await page.goto(cfg.url, { waitUntil: "commit", timeout: 60000 });
  await waitForPageReady(page, "หน้า DCTK", 240000);
  await page.waitForSelector(S.SEL_USER_ID, { timeout: 300000 });
  await login(page, cfg.username, cfg.password);
  stepProgress(2, total, `ค้นใบ ${ref}`);
  checkStop();
  await openDeclarationForEdit(page, ref);
  await sleep(1500);
}

/** แท็บ "ใบกำกับสินค้า & ส่วนรายละเอียด" + ขยายตารางรายการให้เห็นครบ (ปกติหน้าละ 10 แถว) */
async function openTab2(page: Page, notes: string[]): Promise<void> {
  await page.click(S.SEL_TAB2).catch(() => { notes.push("เปิดแท็บใบกำกับสินค้าไม่ได้"); });
  await sleep(2500);
  const grew = await page.evaluate(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const ds = (window as any).$?.("#gridExDecDtl").data("kendoGrid")?.dataSource;
    if (!ds || !ds.total || ds.total() <= (ds.pageSize?.() ?? 0)) return false;
    ds.pageSize(1000);
    return true;
  }).catch(() => false);
  if (grew) await sleep(4000);
}

/**
 * ดึงข้อมูลใบ (ใบกำกับ + รายการสินค้า) มาให้ผู้ใช้เลือกว่าจะแคปส่วนไหน — อ่านอย่างเดียว ไม่เปิดฟอร์มใด ๆ
 */
export async function scanDeclaration(opts: {
  ref: string;
  headless?: boolean;
  configOverrides?: Partial<AppConfig>;
  shouldStop?: () => boolean;
  onProgress?: (p: RunProgress) => void;
}): Promise<{ scan: DeclarationScan | null; stopped?: boolean; error?: string }> {
  const ref = opts.ref.trim();
  if (!ref) throw new Error("ต้องระบุเลขอ้างอิง DCTK / เลขใบขน / เลขใบกำกับ");
  const cfg: AppConfig = { ...(await loadConfig()), ...(opts.configOverrides ?? {}) };
  setRunHooks({ stop: opts.shouldStop, progress: opts.onProgress });
  const browser = await chromium.launch({ headless: opts.headless ?? cfg.headless ?? true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  context.on("page", (p) => p.on("dialog", (d) => void d.dismiss().catch(() => {})));
  const page = await context.newPage();
  page.setDefaultTimeout(cfg.default_timeout_ms ?? 30000);
  const notes: string[] = [];
  try {
    log(`🔎 ดึงข้อมูลใบ ${ref} ให้เลือกส่วนที่จะแคป`);
    await loginAndOpen(page, cfg, ref, 3);
    stepProgress(3, 3, "อ่านรายการใบกำกับและรายการสินค้า");
    checkStop();
    const head = await page.evaluate(() => {
      const v = (sel: string) => ((document.querySelector(sel) as HTMLInputElement | null)?.value ?? "").trim();
      return { referenceNo: v("#ReferenceNo"), status: v("#DeclarationStatusName") || v("#DocumentStatusName") };
    }).catch(() => ({ referenceNo: "", status: "" }));
    await openTab2(page, notes);
    const data = await page.evaluate(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const jq = (window as any).$;
      const s = (v: unknown) => (v == null ? "" : String(v).trim());
      const date = (v: unknown) => { const d = v ? new Date(v as string) : null; return d && !isNaN(+d) ? d.toISOString().slice(0, 10) : s(v); };
      const inv: any[] = jq?.("#gridExInvoice").data("kendoGrid")?.dataSource?.data?.() ?? [];
      const dtl: any[] = jq?.("#gridExDecDtl").data("kendoGrid")?.dataSource?.data?.() ?? [];
      return {
        invoices: inv.map((r) => ({ no: s(r.InvoiceNo), date: date(r.InvoiceDate), consignee: s(r.ConsigneeName) })),
        items: dtl.map((r) => ({
          no: Number(r.ItemNo), invoiceNo: s(r.InvoiceNo), productCode: s(r.ProductCode),
          description: s(r.ProductDescriptionEng).slice(0, 160), tariff: s(r.TariffCode),
          quantity: s(r.Quantity), unit: s(r.QuantityUnitCode),
          amount: s(r.AmountForeign), currency: s(r.AmountCurrencyCode),
        })).sort((a, b) => a.no - b.no),
      };
    });
    log(`  ✓ ใบกำกับ ${data.invoices.length} ใบ · รายการสินค้า ${data.items.length} รายการ`);
    return { scan: { ref, referenceNo: head.referenceNo || ref, status: head.status, ...data } };
  } catch (e) {
    if (e instanceof StopRequested) { log("  ⏹ ผู้ใช้กดยกเลิก — หยุดดึงข้อมูล"); return { scan: null, stopped: true }; }
    const msg = e instanceof Error ? e.message.slice(0, 200) : String(e);
    log(`  ✗ ดึงข้อมูลใบไม่สำเร็จ: ${msg}`);
    return { scan: null, error: msg };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    setRunHooks(null);
  }
}
