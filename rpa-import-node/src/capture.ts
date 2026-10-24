// ============================================================
//  แคปหน้าจอใบขนที่มีอยู่แล้วใน DCTK — ทุกหน้า รวมเป็น PDF ไฟล์เดียว
//
//  ใช้กับปุ่ม "📸 แคปหน้าจอ" บนเว็บ (ใบที่ระบบเราสร้าง) และเมนู "แคปหน้าจอใบขน" (ใส่เลขเอง)
//  ลำดับ: หน้า 1 (หัวใบขน) → หน้า 2 (รายการใบกำกับ + ฟอร์มใบกำกับ) → หน้า 3 (รายการสินค้า + ทุกรายการ)
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
import { log, sleep, waitForPageReady } from "./helpers.js";
import * as S from "./selectors.js";

const SEL_TAB3 = "#TabStrip > ul > li:nth-child(3) > span.k-link";

export interface CaptureResult {
  pdf: string | null;
  shots: number;
  invoice: string;
  notes: string[];
}

export async function captureExistingDeclaration(opts: {
  ref: string;
  headless?: boolean;
  configOverrides?: Partial<AppConfig>;
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

  try {
    log(`📸 แคปหน้าจอใบขน ${ref}`);
    await page.goto(cfg.url, { waitUntil: "commit", timeout: 60000 });
    await waitForPageReady(page, "หน้า DCTK", 240000);
    await page.waitForSelector(S.SEL_USER_ID, { timeout: 300000 });
    await login(page, cfg.username, cfg.password);
    await openDeclarationForEdit(page, ref);
    await sleep(1500);

    // ── หน้า 1 ──
    await shot(page, "หน้า1_หัวใบขน");

    // ── หน้า 2 "ใบกำกับสินค้า & ส่วนรายละเอียด": ตารางใบกำกับ + ตารางรายการสินค้า อยู่หน้าเดียวกัน ──
    await page.click(S.SEL_TAB2).catch(() => { notes.push("เปิดแท็บใบกำกับสินค้าไม่ได้"); });
    await sleep(2500);
    // ตารางรายการสินค้าแสดงหน้าละ 10 แถว — ขยายให้เห็นครบก่อน
    const grew = await page.evaluate(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const ds = (window as any).$?.("#gridExDecDtl").data("kendoGrid")?.dataSource;
      if (!ds || !ds.total || ds.total() <= (ds.pageSize?.() ?? 0)) return false;
      ds.pageSize(1000);
      return true;
    }).catch(() => false);
    if (grew) await sleep(4000);
    invoice = await page.evaluate(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const d = (window as any).$?.("#gridExInvoice").data("kendoGrid")?.dataSource?.data?.() ?? [];
      return d.length ? String(d[0].InvoiceNo ?? d[0].InvoiceNoText ?? "") : "";
    }).catch(() => "");
    await shot(page, "หน้า2_ใบกำกับและรายการสินค้า");

    // ฟอร์มใบกำกับ (เปิดแท็บใหม่)
    const invPage = await openInNewTab(context, page, "#gridExInvoice tbody tr[data-uid]");
    if (invPage) {
      await shot(invPage, "ฟอร์มใบกำกับ");
      await invPage.close().catch(() => {});
    } else {
      notes.push("เปิดฟอร์มใบกำกับไม่ได้ — มีภาพตารางใบกำกับแทน");
    }

    // ทุกรายการสินค้า (เปิดแท็บใหม่ทีละรายการ)
    const uids = await page.evaluate(() => {
      const set = new Set<string>();
      document.querySelectorAll("#gridExDecDtl tbody tr[data-uid]").forEach((tr) => {
        const u = tr.getAttribute("data-uid");
        if (u) set.add(u);
      });
      return [...set];
    }).catch(() => [] as string[]);
    log(`  รายการสินค้า ${uids.length} รายการ`);
    let itemFail = 0;
    for (let i = 0; i < uids.length; i++) {
      const itemPage = await openInNewTab(context, page, `#gridExDecDtl tbody tr[data-uid="${uids[i]}"]`);
      if (!itemPage) { itemFail++; continue; }
      await shot(itemPage, `รายการสินค้า${i + 1}`);
      await itemPage.close().catch(() => {});
      await sleep(800);
    }
    if (itemFail) notes.push(`เปิดรายละเอียดรายการสินค้าไม่ได้ ${itemFail} จาก ${uids.length} รายการ — มีภาพตารางรายการแทน`);

    // ── หน้า 3 "การแลกเปลี่ยนข้อมูล" (ประวัติส่งข้อมูล/คำตอบจากกรมฯ) ──
    await page.click(SEL_TAB3).catch(() => { notes.push("เปิดแท็บการแลกเปลี่ยนข้อมูลไม่ได้"); });
    await sleep(2500);
    await shot(page, "หน้า3_การแลกเปลี่ยนข้อมูล");
  } catch (e) {
    notes.push(`หยุดกลางทาง: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
    log(`  ✗ ${notes[notes.length - 1]}`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  if (!shots.length) return { pdf: null, shots: 0, invoice, notes };
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
