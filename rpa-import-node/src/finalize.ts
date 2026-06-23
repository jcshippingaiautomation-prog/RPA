// ============================================================
//  Finalize + print PDF (Stimulsoft viewer) — Python finalize_and_print
// ============================================================
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import * as S from "./selectors.js";
import { log, sleep } from "./helpers.js";

function nowStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

export interface FinalizeResult {
  pdf: string | null;
  declarationNo: string | null;
}

export async function finalizeAndPrint(
  page: Page,
  context: BrowserContext,
  downloadDir: string,
): Promise<FinalizeResult> {
  log("Finalize → print PDF");
  let declarationNo: string | null = null;

  // หลัง Save & Close ของ Page 3, tab invoice ปิดไปแล้ว → ใช้ tab ที่ยังเปิดอยู่
  if (page.isClosed()) {
    const openPages = context.pages().filter((p) => !p.isClosed());
    if (openPages.length === 0) {
      log("  ✗ ไม่มี tab เหลืออยู่ — ยกเลิก finalize");
      return { pdf: null, declarationNo: null };
    }
    page = openPages[openPages.length - 1];
    await page.bringToFront();
    log(`  → switched กลับไปยัง tab หลัก: ${page.url()}`);
  }

  // ---- ก่อนกด "เสร็จสิ้นใบกำกับ" — ตรวจสภาพหน้า/ปุ่ม + dump ถ้าผิดปกติ ----
  //   ช่วย debug: ปุ่มมีจริงไหม / disabled / มี validation error บนหน้าไหม / ตาราง invoice ว่างไหม
  try {
    const diag = await page.evaluate(() => {
      const out: Record<string, unknown> = {};
      const btn = document.querySelector("#BtnDoneExInvoice");
      out.btnExists = !!btn;
      out.btnVisible = btn ? (btn as HTMLElement).offsetParent !== null : false;
      out.btnDisabled = btn ? (btn.classList.contains("disabled") || (btn as HTMLButtonElement).disabled || btn.getAttribute("disabled") != null) : null;
      out.btnHtml = btn ? (btn as HTMLElement).outerHTML.slice(0, 200) : null;
      // error/validation บนหน้า
      const errs = Array.from(document.querySelectorAll(".field-validation-error, .text-danger, .validation-summary-errors li, span.k-invalid-msg, .alert-danger"))
        .map((e) => (e as HTMLElement).innerText.trim()).filter(Boolean);
      out.errors = errs.slice(0, 8);
      // จำนวนแถวในตารางใบกำกับ/ส่วนรายละเอียด
      const gridRows = document.querySelectorAll(".k-grid-content tr, table.k-selectable tbody tr");
      out.gridRowCount = gridRows.length;
      // modal/dialog ที่เปิดอยู่
      const modals = Array.from(document.querySelectorAll(".modal.in, .modal.show, .k-window, [role='dialog']"))
        .filter((m) => (m as HTMLElement).offsetParent !== null)
        .map((m) => (m as HTMLElement).innerText.trim().slice(0, 120));
      out.openModals = modals;
      return out;
    });
    log(`  🔬 finalize diag: ${JSON.stringify(diag)}`);
    // เซฟ screenshot จุดนี้ (ก่อนกดเสร็จสิ้น) ให้ดูหน้าจริง — ชื่อคงที่ทับได้
    try {
      await page.screenshot({ path: path.join(downloadDir, "..", "debug_finalize_before.png"), fullPage: true });
      log("  📸 เซฟ debug_finalize_before.png");
    } catch { /* ignore */ }
  } catch (e) {
    log(`  ⚠ finalize diag ล้มเหลว: ${e instanceof Error ? e.message : String(e)}`);
  }

  // helper: คืน page ที่ใช้งานได้ (เผื่อ tab ปัจจุบันปิดระหว่าง finalize)
  const livePage = (): Page => {
    if (!page.isClosed()) return page;
    const open = context.pages().filter((p) => !p.isClosed());
    return open.length ? open[open.length - 1] : page;
  };
  // helper: คลิกแบบทน (ถ้า page ปิด/ปุ่มหาย ไม่ throw)
  const safeClick = async (sel: string, ms = 8000): Promise<void> => {
    try { await livePage().click(sel, { timeout: ms }); } catch (e) { log(`  ⚠ คลิก ${sel.slice(-30)} ข้าม: ${e instanceof Error ? e.message.slice(0, 60) : ""}`); }
  };

  await safeClick(S.SEL_BTN_DONE_INVOICE);
  await sleep(5000);
  await safeClick(S.SEL_DIALOG_OK);
  await safeClick(S.SEL_BTN_SAVE);
  await safeClick(S.SEL_BTN_SAVE_CLOSE);
  await sleep(2000);

  // หลัง Save&Close tab อาจปิด → re-acquire page ที่ยังเปิด ก่อนรอ grid
  page = livePage();

  // ---- capture เลขใบขน DCTK ก่อน (จาก URL — ชัวร์สุด ขณะยังอยู่หน้า Edit) ----
  try {
    const urlMatch = (page.url() || "").match(/DCTK\d+/i);
    if (urlMatch) {
      declarationNo = urlMatch[0].toUpperCase();
      log(`  🧾 capture เลขใบขน (จาก URL): ${declarationNo}`);
    }
  } catch { /* */ }

  // รอ grid รายการขึ้น (หลังบันทึกและปิด DCTK ควรกลับมาหน้า portfolio/grid)
  let gridReady = false;
  try {
    await page.waitForSelector(S.SEL_GRID_FIRST_ROW, { timeout: 15000 });
    gridReady = true;
  } catch {
    log("  ⚠ รอ grid แถวแรกไม่ขึ้น — DCTK ค้างหน้า Edit");
  }

  // ---- ถ้า grid ไม่ขึ้น (DCTK ค้างหน้า Edit) → กด "บันทึกและปิด" เพื่อกลับหน้ารายการ ----
  //   (ไม่ต้องค้นหา — หลังบันทึกและปิด ใบที่เพิ่งสร้างจะอยู่ "แถวแรก" ของ grid อยู่แล้ว)
  if (!gridReady) {
    log(`  ↻ ค้างหน้า Edit — กด "บันทึกและปิด" (#BtnSaveAndClose) เพื่อกลับหน้ารายการ`);
    page = livePage();
    // ปุ่ม #BtnSaveAndClose มีจริงบนหน้า Edit (ยืนยันจากภาพ) — DCTK ช้า → retry normal/force/JS
    const saveClose = page.locator("#BtnSaveAndClose").first();
    let saved = false;
    for (let a = 1; a <= 3 && !saved; a++) {
      try {
        await saveClose.waitFor({ state: "visible", timeout: 8000 });
        await saveClose.scrollIntoViewIfNeeded().catch(() => { /* */ });
        try { await saveClose.click({ timeout: 5000 }); }
        catch { try { await saveClose.click({ force: true, timeout: 5000 }); } catch { await saveClose.evaluate((el: any) => el.click()); } }
        saved = true;
        log(`  ✓ กด #BtnSaveAndClose (รอบ ${a})`);
      } catch {
        log(`  ⚠ กด #BtnSaveAndClose รอบ ${a} ไม่ติด — รอแล้วลองใหม่`);
        await sleep(2000);
        page = livePage();
      }
    }
    await sleep(4000);
    page = livePage();
  }

  // คลิกแถวแรกใน grid = ใบที่เพิ่งสร้าง (DCTK เรียงใบล่าสุดขึ้นบนสุด)
  //   DCTK ช้า: ลองรอ grid → ถ้าไม่ขึ้น เปิดเมนู portfolio เอง แล้วรออีกครั้ง (รวมทนได้นาน)
  const waitGrid = async (ms: number): Promise<boolean> => {
    try { await page.waitForSelector(S.SEL_GRID_FIRST_ROW, { timeout: ms }); return true; }
    catch { return false; }
  };
  let rowReady = await waitGrid(20000);
  if (!rowReady) {
    log("  ↻ grid ยังไม่ขึ้น — เปิดเมนู portfolio (รายการใบขน) เอง");
    page = livePage();
    await page.click(S.SEL_PORTFOLIO_MENU, { timeout: 8000 }).catch(() => { /* */ });
    await sleep(5000);
    page = livePage();
    rowReady = await waitGrid(20000);
  }
  if (!rowReady) {
    log("  ✗ เลือกแถวใบเพื่อพิมพ์ไม่สำเร็จ: grid ไม่ขึ้นหลังรอ ~50s");
    return { pdf: null, declarationNo };
  }

  // grid พร้อมแล้ว → เลือกแถวใบ + พิมพ์ PDF (แยกเป็นฟังก์ชันให้ reprint reuse ได้)
  return clickRowAndPrint(page, context, downloadDir, declarationNo);
}

/**
 * เลือกแถวใบใน grid (ตาม declarationNo) → คลิกพิมพ์ใบขนสินค้า → save PDF จาก Stimulsoft viewer.
 * Precondition: page อยู่หน้ารายการใบขน (portfolio) + grid โหลดแถวแล้ว.
 * ใช้ร่วมกันระหว่าง finalizeAndPrint (สร้างใหม่) และ reprintDeclaration (พิมพ์ซ้ำ).
 */
async function clickRowAndPrint(
  page: Page,
  context: BrowserContext,
  downloadDir: string,
  declarationNo: string | null,
): Promise<FinalizeResult> {
  //   ⚠ สำคัญ: ใบที่เพิ่งสร้าง "อาจไม่ใช่แถวแรก" — DCTK มักมีใบเปล่า (referenceNo ใหม่ ยังไม่มี invoice)
  //     ค้างอยู่แถวบนสุด → ต้องเลือกแถวที่ "เลขที่อ้างอิง = declarationNo" ของเราจริง ไม่ใช่แถวแรกเสมอ
  try {
    let clicked = false;
    if (declarationNo) {
      // หา cell ที่มีข้อความ = declarationNo ของเรา แล้วคลิกแถวนั้น
      const cell = page.locator(`#grid table tbody tr td:has-text("${declarationNo}")`).first();
      if (await cell.count().catch(() => 0)) {
        await cell.scrollIntoViewIfNeeded().catch(() => { /* */ });
        await cell.click({ timeout: 8000 });
        clicked = true;
        log(`  ✓ เลือกแถวใบ ${declarationNo} (ตรงเลขใบ ไม่ใช่แค่แถวแรก)`);
      } else {
        log(`  ⚠ หาแถว ${declarationNo} ใน grid ไม่เจอ — fallback คลิกแถวแรก`);
      }
    }
    if (!clicked) {
      // fallback: คลิกแถวแรก + อ่านเลขใบจากแถวนั้น
      if (!declarationNo) {
        const rowText = (await page.locator(S.SEL_GRID_FIRST_ROW).first().innerText()).trim();
        const m = rowText.match(/DCTK\d+/i);
        if (m) { declarationNo = m[0].toUpperCase(); log(`  🧾 capture เลขใบขน (จาก grid): ${declarationNo}`); }
      }
      await page.click(S.SEL_GRID_FIRST_ROW);
      log(`  ✓ เลือกแถวแรก (${declarationNo ?? "?"})`);
    }
  } catch (e) {
    log(`  ✗ คลิกแถวใบไม่สำเร็จ: ${e instanceof Error ? e.message.slice(0, 60) : ""}`);
    return { pdf: null, declarationNo };
  }

  // คลิกปุ่มพิมพ์ใบขน — หน้ารายการมีปุ่ม "พิมพ์ใบขนสินค้า" = #BtnPrintDec (action=RptExDec) โดยตรง
  //   (ไม่มี submenu — ปุ่มโผล่บน toolbar เลย) → คลิก #BtnPrintDec ตรงๆ; fallback ไป flow เดิม (submenu by text)
  const pagesBefore = new Set(context.pages());
  let reportPage: Page | null = null;

  // flow Python ที่สำเร็จ: คลิก "พิมพ์ข้อมูล" (#BtnPrint) เปิดเมนูก่อน → submenu "พิมพ์ใบขนสินค้า"
  //   (#BtnPrintDec = item ในเมนู ที่ปรากฏ/clickable ได้ก็ต่อเมื่อกด #BtnPrint เปิดเมนูแล้ว)
  const clickPrint = async (): Promise<void> => {
    // 1) เปิดเมนูพิมพ์
    await page.click(S.SEL_BTN_PRINT).catch(() => { /* บางหน้าปุ่มพิมพ์โผล่เลย ไม่ต้องเปิดเมนู */ });
    await page.waitForTimeout(800);
    // 2) คลิก item "พิมพ์ใบขนสินค้า" — ลอง #BtnPrintDec ก่อน (เร็ว) แล้ว fallback by text
    const decBtn = page.locator("#BtnPrintDec").first();
    if (await decBtn.count().catch(() => 0)) {
      await decBtn.waitFor({ state: "visible", timeout: 10000 }).catch(() => { /* */ });
      log("  🖨 คลิก #BtnPrintDec (พิมพ์ใบขนสินค้า)");
      try { await decBtn.click({ timeout: 5000 }); return; } catch { /* */ }
      try { await decBtn.click({ force: true, timeout: 5000 }); log("  🖨 force"); return; } catch { /* */ }
      await decBtn.evaluate((el: any) => el.click()); log("  🖨 JS click"); return;
    }
    const item = page.getByText("พิมพ์ใบขนสินค้า", { exact: true }).first();
    await item.waitFor({ state: "visible", timeout: 10000 });
    log("  🖨 คลิก by text 'พิมพ์ใบขนสินค้า'");
    await item.click();
  };

  // การคลิกจะเปิด tab ใหม่ (URL จะมี ExportReport/RptExDec)
  try {
    const [popup] = await Promise.all([
      context.waitForEvent("page", { timeout: 15000 }),
      clickPrint(),
    ]);
    reportPage = popup;
  } catch {
    // ถ้าไม่เปิด popup ทันที ลองคลิกอีกครั้ง (best-effort)
    await clickPrint().catch(() => { /* */ });
  }

  // ถ้ายังไม่ได้ ให้ poll หา tab ใหม่ที่ url คือ report viewer
  if (reportPage === null || !(reportPage.url() || "").includes("ExportReport")) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const newPages = context.pages().filter((p) => !pagesBefore.has(p));
      const pool = newPages.length ? newPages : context.pages();
      const cand = pool.filter(
        (p) =>
          (p.url() || "").includes("ExportReport") ||
          (p.url() || "").includes("RptExDec"),
      );
      if (cand.length) {
        reportPage = cand[cand.length - 1];
        break;
      }
      await sleep(500);
    }
  }

  if (reportPage === null) {
    log("  ✗ หา tab ของ report viewer ไม่เจอ");
    return { pdf: null, declarationNo };
  }

  try { await reportPage.bringToFront(); } catch { /* */ }
  // ⚠ report tab อาจ redirect/ปิดเร็ว → waitForLoadState อาจ throw "Target closed" — กันไว้
  try {
    await reportPage.waitForLoadState("networkidle", { timeout: 20000 });
  } catch (e) {
    log(`  ⚠ report tab networkidle ไม่ครบ (${e instanceof Error ? e.message.slice(0, 50) : ""}) — ลองต่อ`);
  }
  try { await reportPage.waitForTimeout(1500); } catch { /* */ }
  if (reportPage.isClosed()) {
    log("  ✗ report tab ปิดไปแล้ว — หาไฟล์ PDF ไม่ได้ (ใบขนสร้างเสร็จแล้ว)");
    return { pdf: null, declarationNo };
  }
  log(`  · report tab: ${reportPage.url()}`);

  // diagnostic: dump id ของปุ่มที่เกี่ยวข้อง
  try {
    const ids = await reportPage.evaluate(
      () =>
        Array.from(document.querySelectorAll("[id]"))
          .map((e) => (e as HTMLElement).id)
          .filter((i) => /save|print|pdf|export/i.test(i))
          .slice(0, 30),
    );
    log(`  · ids: ${JSON.stringify(ids)}`);
    const framesInfo = reportPage.frames().map((f) => [f.url().slice(0, 80), f.name()]);
    log(`  · frames: ${JSON.stringify(framesInfo)}`);
  } catch (ex) {
    log(`  · diag error: ${ex}`);
  }

  await mkdir(downloadDir, { recursive: true });
  const dest = path.join(downloadDir, `declaration_${nowStamp()}.pdf`);

  // ---- flow Stimulsoft viewer: Save dropdown → PDF → Export
  // id ของ menu/dialog เป็น GUID random ทุก session → หา by text แทน
  const SEL_SAVE_DROPDOWN =
    "#Report_JsViewerMainPanel > div:nth-child(4) > div > table > tbody > " +
    "tr > td:nth-child(1) > table > tbody > tr > td:nth-child(2) > div > " +
    "table > tbody > tr > td:nth-child(2)";

  let captured = false;
  try {
    await reportPage.click(SEL_SAVE_DROPDOWN, { timeout: 10000 });
    log("  · คลิก Save dropdown");
    await sleep(1000);

    await reportPage
      .locator("td", { hasText: "Adobe PDF File" })
      .first()
      .click({ timeout: 10000 });
    log("  · คลิก Adobe PDF File");
    await sleep(1000);

    // ดัก download ผ่าน Playwright — bypass Chrome insecure-download block
    const [download] = await Promise.all([
      reportPage.waitForEvent("download", { timeout: 60000 }),
      reportPage
        .locator("div.stiJsViewerFormButtonsPanel td", { hasText: "OK" })
        .first()
        .click({ timeout: 10000 }),
    ]);
    log("  · คลิก OK");
    await download.saveAs(dest);
    captured = true;
    log(`  ✓ PDF saved → ${dest}`);
  } catch (ex) {
    log(`  ⚠ Stimulsoft export error: ${ex}`);
  }

  // ---- fallback: render หน้า viewer เป็น PDF (headless Chromium เท่านั้น)
  if (!captured) {
    try {
      await reportPage.emulateMedia({ media: "print" });
      await reportPage.pdf({ path: dest, format: "A4", printBackground: true });
      captured = true;
      log(`  ✓ PDF saved (page.pdf fallback) → ${dest}`);
    } catch (ex) {
      log(`  ✗ page.pdf() ไม่สำเร็จ: ${ex}`);
    }
  }

  return { pdf: captured ? dest : null, declarationNo };
}

/**
 * พิมพ์ใบขนซ้ำ (reprint) — ไม่สร้างใบใหม่/ไม่กรอกฟอร์ม.
 * Precondition: login DCTK สำเร็จแล้ว (page อยู่หน้าหลัง login).
 * Flow: เปิดเมนูรายการใบขน (portfolio) → ค้นด้วย declarationNo → เลือกแถว → คลิกพิมพ์ → save PDF.
 * ใช้ตอน finalize ตอนสร้างใบล้มเหลว (DCTK ค้าง) แต่ใบถูกสร้างใน DCTK แล้ว — มาพิมพ์ทีหลัง.
 */
export async function reprintDeclaration(
  page: Page,
  context: BrowserContext,
  downloadDir: string,
  declarationNo: string,
): Promise<FinalizeResult> {
  log(`Reprint → พิมพ์ใบขนซ้ำ: ${declarationNo}`);
  const declNo = declarationNo.trim().toUpperCase();
  if (!declNo) {
    log("  ✗ ไม่มีเลขใบขนสำหรับพิมพ์ซ้ำ");
    return { pdf: null, declarationNo: null };
  }

  // 1) เปิดเมนูรายการใบขน (portfolio)
  await page.click(S.SEL_PORTFOLIO_MENU, { timeout: 10000 }).catch((e) => {
    log(`  ⚠ เปิดเมนู portfolio ไม่สำเร็จ: ${e instanceof Error ? e.message.slice(0, 60) : ""}`);
  });
  await sleep(5000);

  // 2) ค้นด้วยเลขใบขน (filter cell คอลัมน์ "เลขที่ใบขนฯ") — best-effort
  //    ถ้าหาช่องค้นไม่เจอ ยังไปต่อได้ (clickRowAndPrint จะหาแถวตาม declNo เอง)
  try {
    const search = page.locator(S.SEL_DECL_SEARCH_INPUT).first();
    if (await search.count().catch(() => 0)) {
      await search.click({ timeout: 8000 });
      await search.fill(declNo);
      await page.keyboard.press("Enter");
      log(`  🔎 ค้นใบเลข ${declNo}`);
      await sleep(4000);
    } else {
      log("  ℹ ไม่เจอช่องค้น (filter) — ใช้การหาแถวตามเลขใบใน grid แทน");
    }
  } catch (e) {
    log(`  ⚠ ค้นใบไม่สำเร็จ: ${e instanceof Error ? e.message.slice(0, 60) : ""} — ลองหาแถวใน grid ต่อ`);
  }

  // 3) รอ grid โหลดแถว แล้วเลือกแถว + พิมพ์ (reuse logic เดียวกับ finalize)
  try {
    await page.waitForSelector(S.SEL_GRID_FIRST_ROW, { timeout: 30000 });
  } catch {
    log("  ✗ grid รายการใบขนไม่ขึ้น — พิมพ์ซ้ำไม่สำเร็จ");
    return { pdf: null, declarationNo: declNo };
  }
  return clickRowAndPrint(page, context, downloadDir, declNo);
}
