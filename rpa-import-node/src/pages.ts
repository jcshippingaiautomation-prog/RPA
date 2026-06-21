// ============================================================
//  Page handlers — login, portfolio, Page 1–3
//  (ported 1:1 from rpa_import.py)
// ============================================================
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import * as S from "./selectors.js";
import {
  log,
  sleep,
  stripZeroDecimals,
  comboPick,
  comboPickSimple,
  comboPickGridRow,
  setCurrencyViaKendo,
  selectCurrencyRealClick,
  comboPickStrict,
  kendoDropdownPick,
  kendoDropdownListPick,
  dumpDropdownListOptions,
  clickThenType,
  clearField,
  kendoPickDate,
} from "./helpers.js";
import type { Record } from "./types.js";

/**
 * เปิด combo แล้ว dump ตัวเลือกที่มีออกมาเป็น log (เพื่อรู้ค่าที่ถูกต้อง)
 */
export async function dumpComboOptions(page: Page, inputSelector: string, label: string): Promise<void> {
  try {
    await page.click(inputSelector, { timeout: 4000 });
    await page.waitForTimeout(800);
    const opts = await page.evaluate(() => {
      const items: string[] = [];
      // หา list ที่มองเห็น (ไม่ใช้ :visible — ใช้ตรวจ offsetParent แทน)
      document.querySelectorAll("ul.k-list > li.k-item, ul.k-list li").forEach((li) => {
        const el = li as HTMLElement;
        if (el.offsetParent === null) return; // ซ่อนอยู่
        const t = (el.textContent || "").trim();
        if (t) items.push(t);
      });
      return items.slice(0, 40);
    });
    if (opts.length) {
      log(`  📋 ตัวเลือก combo "${label}" (${opts.length} ตัว):`);
      opts.forEach((o) => log(`       - ${o}`));
    } else {
      log(`  📋 combo "${label}" — ไม่พบตัวเลือก (อาจต้องพิมพ์ค้นก่อน)`);
    }
    await page.keyboard.press("Escape").catch(() => {});
  } catch (e) {
    log(`  ⚠ dump combo "${label}" ไม่สำเร็จ: ${e}`);
  }
}

/**
 * จับข้อความ error/validation ที่ DCTK แสดง (สำหรับ debug ว่าทำไม Save ไม่ผ่าน)
 * - validation message สีแดง (.field-validation-error, .text-danger, span.error ฯลฯ)
 * - modal alert ที่เด้งขึ้น (.modal:visible)
 * คืน array ของข้อความ (ไม่ throw)
 */
export async function captureFormErrors(page: Page): Promise<string[]> {
  try {
    return await page.evaluate(() => {
      const out: string[] = [];
      const seen = new Set<string>();
      const add = (t: string) => {
        const s = (t || "").trim().replace(/\s+/g, " ");
        if (s && s.length > 1 && !seen.has(s)) { seen.add(s); out.push(s); }
      };
      // 1) validation messages สีแดง (รูปแบบที่ DCTK / ASP.NET / Kendo ใช้)
      const errSel = [
        ".field-validation-error", ".text-danger", ".validation-summary-errors",
        "span.k-invalid-msg", ".error", ".invalid", "[style*='color:red']",
        "[style*='color: red']", ".redText", ".text-red",
      ];
      document.querySelectorAll(errSel.join(",")).forEach((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width > 0 && r.height > 0) add(el.textContent || "");
      });
      // 2) modal/alert ที่เด้ง (มองเห็น)
      document.querySelectorAll(".modal, [role='dialog'], .k-window").forEach((m) => {
        const r = (m as HTMLElement).getBoundingClientRect();
        const st = getComputedStyle(m as HTMLElement);
        if (r.width > 0 && r.height > 0 && st.display !== "none") {
          add("[MODAL] " + ((m as HTMLElement).innerText || "").slice(0, 300));
        }
      });
      return out;
    });
  } catch {
    return [];
  }
}

function nowStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * field นี้ถูกอนุญาตให้กรอกสำหรับลูกค้านี้หรือไม่ (นิยาม config "ปิดใช้งาน")
 *   - ไม่มี __field_rules__ (null) = ลูกค้าไม่ได้ตั้ง config → กรอกทุกช่อง (เดิม)
 *   - มี rules = กรอกเฉพาะช่องที่อยู่ใน set (= "จาก AI" หรือ "กำหนดเอง")
 *   - ช่องที่ไม่อยู่ใน set = "ปิดใช้งาน" → ไม่แตะเลย
 */
function allowed(r: Record, sheetField: string): boolean {
  const rules = r.__field_rules__;
  if (rules === null || rules === undefined) return true;
  return rules.has(sheetField);
}

/**
 * นิยาม config: ช่องที่ allowed แต่ค่าว่าง = "ตั้งใจให้ว่าง" → ต้องล้างช่อง
 *   (ใช้กับ put/putCombo/putKendoDd/putDate — ยกเว้นช่องที่ "ไม่อยู่ใน config เลย"
 *    คือ __field_rules__ = null ซึ่งหมายถึงไม่ได้ตั้ง config → ไม่ล้าง ปล่อย DCTK เติม)
 */
function shouldClearWhenEmpty(r: Record, sheetField: string): boolean {
  const rules = r.__field_rules__;
  if (rules === null || rules === undefined) return false; // ไม่ได้ตั้ง config → ไม่ล้าง
  return rules.has(sheetField); // allowed (AI/กำหนดเอง) + ว่าง → ล้าง
}

const isEmptyVal = (v: unknown) =>
  v === null || v === undefined || String(v).trim() === "";

/**
 * กรอก value ลง selector ตามนิยาม config:
 *   - ปิด (ไม่ allowed) → ไม่แตะ
 *   - allowed + มีค่า → กรอก
 *   - allowed + ว่าง → ล้างช่อง (ตั้งใจให้ว่าง)
 */
async function put(
  page: Page,
  r: Record,
  sheetField: string,
  selector: string,
  value: unknown,
): Promise<void> {
  if (!allowed(r, sheetField)) return;
  if (isEmptyVal(value)) {
    if (shouldClearWhenEmpty(r, sheetField)) await clearField(page, selector);
    return;
  }
  // commit:true → blur (Tab) หลังกรอก ให้ Kendo numeric (ราคา/น้ำหนัก) commit ค่าจริง
  await clickThenType(page, selector, value, { commit: true });
}

async function putCombo(
  page: Page,
  r: Record,
  sheetField: string,
  selector: string,
  value: string,
): Promise<void> {
  if (!allowed(r, sheetField)) return;
  if (isEmptyVal(value)) {
    if (shouldClearWhenEmpty(r, sheetField)) await clearField(page, selector);
    return;
  }
  await comboPick(page, selector, value);
}

async function putKendoDd(
  page: Page,
  r: Record,
  sheetField: string,
  selector: string,
  value: string,
): Promise<void> {
  if (!allowed(r, sheetField)) return;
  if (isEmptyVal(value)) {
    if (shouldClearWhenEmpty(r, sheetField)) await clearField(page, selector);
    return;
  }
  await kendoDropdownPick(page, selector, value);
}

async function putDate(
  page: Page,
  r: Record,
  sheetField: string,
  selector: string,
  value: string,
): Promise<void> {
  if (!allowed(r, sheetField)) return;
  if (isEmptyVal(value)) {
    if (shouldClearWhenEmpty(r, sheetField)) await clearField(page, selector);
    return;
  }
  await kendoPickDate(page, selector, value);
}

/** ถ้าลูกค้าขอ screenshot → save PNG เก็บ path ไว้ใน record (Python _capture_if_requested) */
async function captureIfRequested(
  page: Page,
  r: Record,
  label: string,
): Promise<void> {
  if (!r.__capture_screenshots__) return;
  const shots = (r.__screenshot_paths__ ??= []);
  const downloadDir = r.__download_dir__ as string;
  await mkdir(downloadDir, { recursive: true });
  const customer = String(r.company_search ?? "unknown");
  const safe = customer.replace(/[^A-Za-z0-9_\-]+/g, "_").slice(0, 50);
  const file = path.join(downloadDir, `shot_${safe}_${label}_${nowStamp()}.png`);
  await page.screenshot({ path: file, fullPage: true });
  shots.push(file);
  log(`  📸 capture: ${path.basename(file)}`);
}

/** ใน popup 'บริษัทผู้ส่งออก/นำเข้า' (Python _search_company_in_popup) */
async function searchCompanyInPopup(page: Page, name: string): Promise<void> {
  await page.waitForSelector(S.SEL_SEARCHED_WORDS, { timeout: 10000 });
  await page.fill(S.SEL_SEARCHED_WORDS, "");
  await page.fill(S.SEL_SEARCHED_WORDS, name);

  await page.press(S.SEL_SEARCHED_WORDS, "Enter");
  await sleep(2500);

  // selector แถวผลลัพธ์ที่ยืดหยุ่น (structure DCTK อาจไม่ตรง hardcode เดิม)
  const rowFlexible = `${S.SEL_GRID_COMPANY_ROW}, #gridCompany .k-grid-content tbody tr:first-child, #gridCompany tbody tr:first-child`;
  try {
    await page.waitForSelector(rowFlexible, { timeout: 6000 });
  } catch {
    // fallback: ปุ่ม / ไอคอนแว่นขยาย
    for (const sel of [S.SEL_BTN_COMPANY, "button:has(span.k-i-search)", "a:has(span.k-i-search)", "span.k-i-search"]) {
      try { await page.click(sel, { timeout: 2000 }); break; } catch { continue; }
    }
    await page.waitForSelector(rowFlexible, { timeout: 15000 });
  }

  // dblclick แถวแรก (ลอง selector เดิมก่อน → fallback แถวแรกแบบกว้าง)
  try {
    await page.dblclick(S.SEL_GRID_COMPANY_ROW, { timeout: 4000 });
  } catch {
    await page.dblclick("#gridCompany tbody tr:first-child", { timeout: 8000 });
  }
  await sleep(1500);
}

export async function login(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  log("login");
  await clickThenType(page, S.SEL_USER_ID, username);
  await clickThenType(page, S.SEL_PASSWORD, password);
  await page.click(S.SEL_BTN_SUBMIT);
  // รอ "จนกว่า login สำเร็จจริง" = เมนู portfolio (หน้าหลัง login) ปรากฏ
  //   DCTK ช้าไม่แน่นอน (บางรอบ >30s) → รอจนเห็นเมนูจริง ไม่ใช่รอเวลาคงที่แล้วเดาว่าเสร็จ
  //   ทนได้นานสุด ~90s + retry กดปุ่ม login 1 ครั้งถ้ายังไม่เข้า (เผื่อคลิกแรกหลุด)
  const LOGIN_TOTAL_MS = 90000;
  const start = Date.now();
  let loggedIn = false;
  let retried = false;
  while (Date.now() - start < LOGIN_TOTAL_MS) {
    // เมนู portfolio โผล่ = เข้าระบบสำเร็จ
    if (await page.locator(S.SEL_PORTFOLIO_MENU).count().catch(() => 0)) {
      loggedIn = true;
      break;
    }
    // ยังอยู่หน้า login (ช่อง user ยังอยู่) + ผ่านไป >25s → ลองกดปุ่มอีกครั้ง (ครั้งเดียว)
    if (!retried && Date.now() - start > 25000) {
      const stillLogin = await page.locator(S.SEL_USER_ID).count().catch(() => 0);
      if (stillLogin) {
        log("  ↻ ยังไม่เข้าระบบหลัง 25s — ลองกดปุ่ม login ซ้ำ");
        await page.click(S.SEL_BTN_SUBMIT).catch(() => { /* */ });
        retried = true;
      }
    }
    await sleep(1500);
  }
  if (loggedIn) {
    log(`  ✓ login สำเร็จ (${Math.round((Date.now() - start) / 1000)}s) — เมนู portfolio ปรากฏ`);
  } else {
    log("  ⚠ รอ login เกิน 90s — เมนู portfolio ยังไม่ปรากฏ (DCTK ช้ามาก/ล่ม) — ลองทำต่อ");
  }
}

export async function openPortfolioAndAdd(page: Page): Promise<void> {
  log("portfolio → Add");
  await page.click(S.SEL_PORTFOLIO_MENU);
  await sleep(5000);
  await page.click(S.SEL_BTN_ADD);
  await sleep(5000);
}

/**
 * ค้นใบขนเดิมใน DCTK ด้วยเลขใบขน → เปิดหน้าแก้ → คืน Page ของหน้าแก้
 * TODO[inspect-edit]: เติม selectors จริงจาก inspect/portfolio.json + search.json + edit-page1.json
 *   (รัน `RPA_INSPECT_EDIT=1 RPA_INSPECT_DECL_NO="<เลขใบ>" npm start` ก่อน)
 *   pattern ค้นใช้แนวเดียวกับ searchCompanyInPopup (พิมพ์→Enter→รอ grid→double-click แถว)
 */
export async function openDeclarationForEdit(page: Page, declNo: string): Promise<Page> {
  log(`portfolio → ค้นใบ ${declNo} เพื่อแก้`);
  // 1) เปิดหน้ารายการใบขน
  await page.click(S.SEL_PORTFOLIO_MENU);
  await sleep(5000);
  // 2) filter คอลัมน์ "เลขที่ใบขนฯ" ด้วยเลขใบขน (Kendo grid filter — auto apply)
  const filterBox = page.locator(S.SEL_DECL_SEARCH_INPUT).first();
  await filterBox.waitFor({ state: "visible", timeout: 15000 });
  await filterBox.click();
  await filterBox.fill(declNo);
  await page.keyboard.press("Enter"); // Kendo filter apply
  await sleep(4000);
  // 3) double-click แถวผลแรก เพื่อเปิดใบ
  const row = page.locator(S.SEL_DECL_GRID_ROW).first();
  await row.waitFor({ state: "visible", timeout: 15000 });
  await row.dblclick();
  await sleep(5000);
  return page; // หน้าแก้เปิดในหน้าเดิม (DCTK ไม่เปิด tab ใหม่ที่ขั้นนี้)
}

/** บันทึกการแก้ไขใบขน (mode=edit) — TODO[inspect-edit]: ยืนยันปุ่ม save ของหน้าแก้ */
export async function saveDeclarationEdit(page: Page): Promise<void> {
  log("บันทึกการแก้ไขใบขน");
  await page.click(S.SEL_BTN_EDIT_SAVE);
  await sleep(3000);
}

/**
 * กรอกรหัสประเทศ 2 ตัว (เช่น KR/SA/HK/RU) — ช่อง DCTK มี autocomplete มาดักตัวอักษรที่ 2
 *   ทำให้พิมพ์ "KR" เหลือ "K" → DCTK ฟ้อง "ความยาวต้องเท่ากับ 2 หลัก / ค้นหาไม่พบ"
 * วิธีแก้: พิมพ์ปกติก่อน → กด Escape ปิด dropdown → verify ค่าครบ 2 ตัว
 *   ถ้าไม่ครบ → force-set ค่าตรงผ่าน DOM + dispatch input/change ให้ระบบรับรู้ แล้ว Tab commit
 */
async function putCountryCode(
  page: Page,
  r: Record,
  sheetField: string,
  selector: string,
  value: unknown,
): Promise<void> {
  if (!allowed(r, sheetField)) return;
  if (isEmptyVal(value)) {
    if (shouldClearWhenEmpty(r, sheetField)) await clearField(page, selector);
    return;
  }
  const want = String(value).trim().toUpperCase();
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: "visible", timeout: 15000 }).catch(() => { /* */ });

  const readVal = async (): Promise<string> => {
    try { return (await loc.inputValue()).trim().toUpperCase(); } catch { return ""; }
  };

  // ลองหลายวิธีจนกว่าค่าจะ = want (DCTK ช้า/autocomplete ดักตัวอักษร ไม่แน่นอนแต่ละรอบ)
  for (let attempt = 1; attempt <= 4; attempt++) {
    // เคลียร์ช่องก่อน
    await loc.evaluate((el: any) => { el.focus(); el.click(); }).catch(() => { /* */ });
    await page.keyboard.press("Control+A").catch(() => { /* */ });
    await page.keyboard.press("Backspace").catch(() => { /* */ });
    await page.waitForTimeout(120);

    if (attempt <= 2) {
      // วิธี A: พิมพ์ทีละตัว + Escape ปิด autocomplete หลัง "แต่ละตัว" (กันตัวที่ 2 โดนดัก)
      for (const ch of want) {
        await page.keyboard.type(ch, { delay: 120 });
        await page.keyboard.press("Escape");
        await page.waitForTimeout(120);
      }
    } else {
      // วิธี B: force-set ค่าตรงผ่าน DOM + dispatch (เผื่อพิมพ์ไม่ติดเลย)
      await loc.evaluate((el: any, v: string) => {
        el.focus();
        el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("keyup", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, want);
      await page.keyboard.press("Escape").catch(() => { /* */ });
    }
    await page.waitForTimeout(250);
    const got = await readVal();
    if (got === want) {
      log(`  ✓ รหัสประเทศ [${sheetField}] = "${got}" (วิธี ${attempt <= 2 ? "พิมพ์ทีละตัว" : "force-set"}, รอบ ${attempt})`);
      await loc.evaluate((el: any) => el.blur());
      await page.waitForTimeout(100);
      return;
    }
    log(`  ⚠ รหัสประเทศ [${sheetField}] รอบ ${attempt} ได้ "${got}" ≠ "${want}" — ลองใหม่`);
  }
  log(`  🛑 รหัสประเทศ [${sheetField}] ใส่ "${want}" ไม่สำเร็จหลัง 4 รอบ (DCTK ช้า/autocomplete) — ทำต่อ (อาจ save ไม่ผ่าน)`);
  await loc.evaluate((el: any) => el.blur()).catch(() => { /* */ });
  await page.waitForTimeout(100);
}

export async function fillPage1(page: Page, r: Record): Promise<void> {
  log("Page 1: vessel / buyer / consignee");
  await putCountryCode(page, r, "buyer_country_code", S.SEL_PUR_COUNTRY, r.pur_country ?? "");
  await putCountryCode(page, r, "destination_country_code", S.SEL_DEST_COUNTRY, r.dest_country ?? "");

  // ---- buyer search (customer_name) — ต้องค้นเสมอ ถึงจะลิงก์ profile ได้
  if (allowed(r, "customer_name")) {
    await page.click(S.SEL_BTN_BUYER_SEARCH);
    await searchCompanyInPopup(page, String(r.company_search ?? ""));
  }

  // ---- consignee popup (ใช้ search popup เดียวกับ buyer — robust ด้วย fallback)
  if (allowed(r, "consignee_name")) {
    await page.click(S.SEL_BTN_CONSIGNEE_SEARCH);
    await sleep(2000);
    try {
      await page.waitForSelector(S.SEL_GRID_COMPANY_ROW, { timeout: 6000 });
      await page.dblclick(S.SEL_GRID_COMPANY_ROW, { timeout: 4000 });
    } catch {
      await page.waitForSelector("#gridCompany tbody tr:first-child", { timeout: 10000 });
      await page.dblclick("#gridCompany tbody tr:first-child", { timeout: 8000 });
    }
    await sleep(1500);
  }

  // ---- vessel / voyage / locations
  await putCombo(page, r, "vessel_name", S.SEL_VESSEL_INPUT, String(r.vessel_name ?? ""));
  await put(page, r, "voyage_number", S.SEL_VOYAGE, r.voyage ?? "");
  await putCombo(page, r, "release_port_code", S.SEL_PAPERLESS_INPUT, String(r.paperless_code ?? ""));
  await putCombo(page, r, "loading_port_code", S.SEL_LOADING_INPUT, String(r.loading_code ?? ""));
  // shipping_mark: DCTK จำกัด 512 ตัวอักษร — ถ้าเกิน ตัดที่ขอบบรรทัด (ให้ยังอ่านได้) ไม่ให้ save พัง
  let shipMark = String(r.shipping_mark ?? "");
  if (shipMark.length > 512) {
    const cut = shipMark.slice(0, 512);
    const lastNL = cut.lastIndexOf("\n");
    shipMark = lastNL > 400 ? cut.slice(0, lastNL) : cut; // ตัดท้ายบรรทัดถ้าใกล้ขอบพอ
    log(`  ✂ shipping_mark ยาว ${String(r.shipping_mark).length} ตัว > 512 → ตัดเหลือ ${shipMark.length} ตัว`);
  }
  await put(page, r, "shipping_mark", S.SEL_SHIPPING_MARK, shipMark);

  // ---- ช่องเพิ่มเติม Page 1 (text) — กรอกเมื่อ allow + มีค่า
  await put(page, r, "mawb", S.SEL_MAWB, r.mawb ?? "");
  await put(page, r, "hawb", S.SEL_HAWB, r.hawb ?? "");
  await put(page, r, "reference_no", S.SEL_REFERENCE_NO, r.reference_no ?? "");
  // ---- ช่องเพิ่มเติม Page 1 (dropdown kendo)
  await putKendoDd(page, r, "transport_mode", S.SEL_TRANSPORT_MODE, String(r.transport_mode ?? ""));
  await putKendoDd(page, r, "exdec_doc_type", S.SEL_EXDEC_DOC_TYPE, String(r.exdec_doc_type ?? ""));

  // ---- tax + ETD
  if (allowed(r, "tax_payment_method_code") && r.tax_payment_code) {
    try {
      await page.click(S.SEL_DIVWATCH_LABEL);
    } catch {
      log("  ⚠ divWatching label ไม่พบ");
    }
    await kendoDropdownPick(page, S.SEL_TAX_DROPDOWN, String(r.tax_payment_code ?? ""));
  }
  await putDate(page, r, "etd", S.SEL_ETD_DATEPICKER, String(r.etd_date ?? ""));

  await captureIfRequested(page, r, "page1");
  if (r.__dry_run__) {
    log("  🧪 dry run: ข้ามการกด Save (Page 1)");
    return;
  }
  await page.click(S.SEL_BTN_SAVE);
  await sleep(10000);
}

/** Page 2 ขั้น 1 — เปิด tab ใหม่ + รอฟอร์มพร้อม (แยกออกเพื่อ inspect) */
export async function fillPage2Open(page: Page): Promise<Page> {
  log("Page 2: invoice (เปิดฟอร์ม)");
  // รอ Page 1 save เสร็จ (network นิ่ง) ก่อนสลับ tab
  try { await page.waitForLoadState("networkidle", { timeout: 10000 }); } catch { /* */ }
  await page.click(S.SEL_TAB2);
  await sleep(3000); // รอ tab transition + grid โหลด

  const context = page.context();
  const addBtn = page.locator(S.SEL_BTN_INVOICE_ADD);
  await addBtn.waitFor({ state: "visible", timeout: 20000 });
  await sleep(1500);

  // retry คลิก "เพิ่มข้อมูล" จนกว่า tab ใหม่จะเปิด (สูงสุด 3 ครั้ง)
  let newPage: Page | null = null;
  for (let attempt = 0; attempt < 3 && !newPage; attempt++) {
    const pagesBefore = [...context.pages()];
    try { await addBtn.click({ timeout: 8000 }); } catch { await addBtn.click({ force: true }); }
    // รอ tab ใหม่ ~20 วิ
    for (let i = 0; i < 40; i++) {
      const np = context.pages().find((p) => !pagesBefore.includes(p));
      if (np) { newPage = np; break; }
      await page.waitForTimeout(500);
    }
    if (!newPage) log(`  ⚠ tab ใหม่ยังไม่เปิด (ครั้งที่ ${attempt + 1}) — ลองคลิกซ้ำ`);
  }

  if (newPage) {
    page = newPage;
    try { await page.waitForLoadState("domcontentloaded", { timeout: 15000 }); } catch { /* */ }
    await page.bringToFront();
    log(`  → switched ไปยัง tab ใหม่: ${page.url()}`);
  } else {
    log("  → ไม่พบ tab ใหม่ — ใช้ page เดิม (Page 1 อาจ save ไม่ผ่าน)");
  }

  // รอ #InvoiceNo (ฟอร์มใบกำกับพร้อม) — รอนานขึ้น + retry bringToFront
  for (let i = 0; i < 3; i++) {
    try { await page.waitForSelector(S.SEL_INVOICE_NO, { state: "visible", timeout: 20000 }); break; }
    catch { await page.bringToFront().catch(() => {}); await sleep(2000); }
  }
  try { await page.waitForLoadState("networkidle", { timeout: 10000 }); } catch { /* */ }
  await page.waitForTimeout(1500);
  return page;
}

/** Page 2 ขั้น 2 — กรอกฟิลด์ + Save&Close (แยกออกเพื่อ inspect) */
// หมายเหตุ: putComboCurrency (force-set สกุลเงิน) ถูกลบแล้ว — เคยทำให้ได้ค่ายาวเกิน 3 ตัว
//   ตอนนี้สกุลเงินกรอกผ่าน comboPickSimple (ราคา) / comboPickGridRow (ค่าระวาง+ประกัน) ใน fillPage2Fill

export async function fillPage2Fill(page: Page, r: Record): Promise<Page> {
  // รอฟอร์มใบกำกับโหลดเสร็จ (tab ใหม่อาจยังโหลดอยู่) ก่อนกรอก
  await page.waitForSelector(S.SEL_INVOICE_NO, { state: "visible", timeout: 15000 });
  await sleep(500);
  await put(page, r, "invoice_number", S.SEL_INVOICE_NO, r.invoice_no ?? "");
  await putDate(page, r, "invoice_date", S.SEL_INVOICE_DATE, String(r.invoice_date ?? ""));
  await putCombo(page, r, "consignee_name", S.SEL_CONSIGNEE_INPUT, String(r.consignee ?? ""));

  const term = String(r.term ?? "").trim().toUpperCase();
  const currency = String(r.currency ?? "").trim().toUpperCase() || "USD";
  await putKendoDd(page, r, "incoterms", S.SEL_TERM_DROPDOWN, term);

  // ==========================================================================
  // ตารางราคา Page 2 — กรอกทีละ STEP "แยกขาดจากกัน" ตาม selector ที่ user ให้
  //   แต่ละ step = 1 ช่อง 1 selector 1 วิธี → แก้ step ใดไม่กระทบ step อื่น
  //   ลำดับ (user ยืนยัน): สกุลเงิน → จำนวนเงิน ของแต่ละแถว
  //   วิธีเลือกสกุลเงิน (ห้ามสลับ — พิสูจน์จากผลรันจริง):
  //     • ราคา        = comboPickSimple (พิมพ์→Enter)     ← ได้ "USD" ถูก
  //     • ค่าระวาง    = comboPickGridRow (คลิกแถว grid)   ← พิมพ์→Enter ได้ "0"
  //     • ค่าประกัน   = comboPickGridRow (คลิกแถว grid)
  //   diagCurrency() = อ่านค่าอย่างเดียว (read-only) ไว้ยืนยัน ไม่แตะช่อง
  // ==========================================================================
  const diagCurrency = async (sel: string, label: string): Promise<void> => {
    try {
      const got = (await page.locator(sel).first().inputValue().catch(() => "")).trim();
      log(`  🔬 สกุลเงิน[${label}] = "${got}" (ต้องการ "${currency}")`);
    } catch { /* */ }
  };
  const wantCurrency = allowed(r, "currency") && !!currency;

  // ---- STEP 1: สกุลเงิน "ราคา" (div:6) — พิมพ์ → Enter ----
  if (wantCurrency) { await comboPickSimple(page, S.SEL_CURRENCY_INPUT, currency); await diagCurrency(S.SEL_CURRENCY_INPUT, "ราคา"); }
  // ---- STEP 2: จำนวนเงิน "ราคา" (div:6 termForeign / #_AmountForeign) ----
  await put(page, r, "total_goods_amount", S.SEL_AMOUNT, stripZeroDecimals(r.amount ?? ""));

  // ค่าระวาง: กรอกเมื่อ term รวมค่าระวาง (CIF/CFR/CNF/C&F) — DCTK บังคับค่าระวาง > 0
  //   🔑 จาก dump field จริง: ใส่ USD แล้ว _Freight="USD" ทันที แต่ "การกรอกจำนวนเงินทีหลัง"
  //      → DCTK คำนวณใหม่ → รีเซ็ต _Freight กลับเป็น "0" (เพราะแถวยัง aria-selected=false)
  //   ทางแก้: **กรอกจำนวนเงินก่อน → ใส่สกุลเงินเป็นอันสุดท้าย** (ไม่มีอะไรมารีเซ็ตหลัง USD)
  // 🔑 ensureCurrency: ถ้าช่องสกุลเงิน "เป็นค่าที่ต้องการอยู่แล้ว" (DCTK เติมให้จากสกุลเงินราคา) → **ข้าม ไม่แตะ**
  //   (เดิม comboPickSimple ไป fill("") ลบ USD ที่ถูกอยู่แล้ว → commit ไม่ติด → เด้งเป็น "0" = บั๊กตัวจริง)
  //   แตะเฉพาะกรณีค่าผิด/ว่างเท่านั้น
  const ensureCurrency = async (sel: string, label: string): Promise<void> => {
    if (!wantCurrency) return;
    const cur = (await page.locator(sel).first().inputValue().catch(() => "")).trim().toUpperCase();
    if (cur === currency) { log(`  ✓ สกุลเงิน[${label}] = "${cur}" ถูกอยู่แล้ว (ไม่แตะ)`); return; }
    log(`  ↪ สกุลเงิน[${label}] เดิม="${cur}" ≠ "${currency}" → ใส่ใหม่`);
    await comboPickSimple(page, sel, currency);
    await diagCurrency(sel, label);
  };

  if (term === "CIF" || term === "CFR" || term === "CNF" || term === "C&F") {
    const freightVal = stripZeroDecimals(r.freight ?? "");
    // ---- STEP 3: จำนวนเงิน "ค่าระวาง" ก่อน (div:8 termForeign) ----
    if (freightVal) await put(page, r, "freight_charge", S.SEL_FREIGHT, freightVal);
    // ---- STEP 4: สกุลเงิน "ค่าระวาง" — **เลือกแบบจริง (คลิกแถว)** ----
    //   ⚠ ห้ามเชื่อ text="USD" (DCTK เติมเป็นข้อความ แต่ค่า submit จริงยัง 0) → ต้อง "เลือกแถวจริง" เสมอ
    if (wantCurrency) await selectCurrencyRealClick(page, "_Freight_input", currency);

    // ค่าประกัน — เฉพาะ CIF (CFR ไม่มีประกัน)
    if (term === "CIF") {
      const insuranceVal = stripZeroDecimals(r.insurance ?? "");
      // ---- STEP 5: จำนวนเงิน "ค่าประกัน" ก่อน (div:9 termForeign) ----
      if (insuranceVal) await put(page, r, "insurance_charge", S.SEL_INSURANCE, insuranceVal);
      // ---- STEP 6: สกุลเงิน "ค่าประกัน" — เลือกแบบจริง ----
      if (wantCurrency) await selectCurrencyRealClick(page, "_Insurance_input", currency);
    }
  }

  // น้ำหนัก (ช่องแยกฝั่งขวา — คนละ fieldset กับตารางราคา)
  await put(page, r, "net_weight_kg", S.SEL_TOTAL_NET, String(r.net_weight_kg ?? ""));   // น้ำหนักสุทธิรวม
  await put(page, r, "gross_weight_kg", S.SEL_TOTAL_GROSS, String(r.gross_weight_kg ?? "")); // น้ำหนักรวมหีบห่อ

  // ✅ ตรวจค่าจริงก่อนเซฟ (รอบเดียวรู้ผล): _Freight ต้อง="USD", _FreightForeign ต้อง=จำนวนเงิน
  try {
    const fv = await page.evaluate(() => {
      const g = (n: string) => (document.querySelector(`[name="${n}"]`) as HTMLInputElement | null)?.value ?? "(none)";
      return { _Freight: g("_Freight"), _FreightForeign: g("_FreightForeign"), _FreightBaht: g("_FreightBaht"), _Amount: g("_Amount"), _AmountForeign: g("_AmountForeign") };
    });
    log(`  ✅ ก่อนเซฟ Page 2: ${JSON.stringify(fv)}`);
  } catch { /* */ }

  await captureIfRequested(page, r, "page2");
  if (r.__dry_run__) {
    log("  🧪 dry run: ข้ามการกด Save & Close (Page 2)");
    return page;
  }
  await page.click(S.SEL_BTN_SAVE_CLOSE);
  await sleep(2000);
  // modal "Invoice No ซ้ำ..." (หรือแจ้งเตือนอื่น) เด้ง → กด YES เพื่อบันทึกต่อ
  await dismissAlertIfPresent(page);
  await sleep(2000);
  const p2errs = await captureFormErrors(page);
  if (p2errs.length) {
    log("  ⚠ Page 2 Save&Close — DCTK แสดง error:");
    p2errs.forEach((e) => log("     • " + e.slice(0, 200)));
  }
  // 🔬🔬 DIAGNOSTIC: สภาพหน้าหลัง Save&Close — หาเหตุที่ใบกำกับบางใบ (ZECK) ไม่บันทึก
  try {
    const st = await page.evaluate(() => {
      const out: { [k: string]: unknown } = {};
      out.url = location.href.slice(0, 90);
      // ยังอยู่ฟอร์มใบกำกับ (ExInvoice/Create) ไหม = ยังไม่ปิด/ไม่บันทึก
      out.stillOnInvoiceForm = location.href.includes("ExInvoice");
      // modal/dialog ที่เปิดอยู่ + ข้อความ
      out.modals = Array.from(document.querySelectorAll(".modal.in, .modal.show, .k-window, [role='dialog']"))
        .filter((m) => (m as HTMLElement).offsetParent !== null)
        .map((m) => (m as HTMLElement).innerText.trim().slice(0, 150)).slice(0, 5);
      // ข้อความ error/เตือน "ทุกแบบ" (กว้างกว่า captureFormErrors)
      out.anyMsgs = Array.from(document.querySelectorAll(".text-danger, .field-validation-error, .validation-summary-errors, .alert, [class*='error'], [class*='invalid'], [class*='warning']"))
        .map((e) => (e as HTMLElement).innerText?.trim()).filter((t) => t && t.length > 1 && t.length < 150).slice(0, 8);
      // จำนวนแถวในตารางใบกำกับ (ถ้า 0 = ใบกำกับไม่ถูกเพิ่ม)
      const grids = Array.from(document.querySelectorAll(".k-grid-content"));
      out.gridRowsPerGrid = grids.map((g) => g.querySelectorAll("tr").length).slice(0, 6);
      return out;
    });
    log(`  🔬🔬 หลัง Save&Close Page 2: ${JSON.stringify(st)}`);
  } catch (e) { log(`  🔬🔬 diag หลัง save ล้ม: ${e instanceof Error ? e.message : String(e)}`); }
  await sleep(2000);
  return page;
}

/** กรอกหน้า 2 — เปิด tab + กรอก + Save (wrapper สำหรับ run ปกติ) */
export async function fillPage2(page: Page, r: Record): Promise<Page> {
  const page2 = await fillPage2Open(page);
  return fillPage2Fill(page2, r);
}

/**
 * เช็คว่ามี modal แจ้งเตือนเด้งไหม (ไม่ใช่ทุกลูกค้า) — ถ้ามีกด Yes
 * รอแบบ optional: ถ้าไม่เด้งภายในเวลาสั้นๆ ก็ผ่านไป ไม่ throw
 */
async function dismissAlertIfPresent(page: Page): Promise<void> {
  // รอ modal ใด ๆ ที่ visible (รองรับทั้ง #myModalAlert และ modal Bootstrap อื่น)
  const modalSel = `${S.SEL_MODAL_ALERT}.in, ${S.SEL_MODAL_ALERT}:visible, .modal.in:visible, .modal.show:visible`;
  try {
    await page.waitForSelector(modalSel, { timeout: 2500 });
  } catch {
    return; // ไม่มี modal — ปกติ
  }
  // กดปุ่ม YES/ตกลง — ลอง selector เดิมก่อน, ไม่ได้ค่อยหาปุ่มด้วย text
  try {
    await page.click(S.SEL_MODAL_ALERT_YES, { timeout: 3000 });
    log("  ✓ กดยืนยัน modal (Yes)");
  } catch {
    // fallback: ปุ่มใน modal ที่ข้อความเป็น YES / ตกลง / ใช่
    const yesBtn = page.locator(
      ".modal.in button:visible, .modal.show button:visible, #myModalAlert button:visible",
    ).filter({ hasText: /YES|ตกลง|ใช่|OK/i }).first();
    try {
      await yesBtn.click({ timeout: 3000 });
      log("  ✓ กดยืนยัน modal (Yes ด้วย text)");
    } catch (e) {
      log(`  ⚠ พบ modal แต่กด Yes ไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
  }
  await page.waitForSelector(modalSel, { state: "hidden", timeout: 5000 }).catch(() => {});
  await sleep(800);
}

/**
 * กรอกฟิลด์รายการสินค้า 1 รายการ (ไม่กดปุ่ม Save/Add)
 * อ่านค่าจาก item (__items__) แต่ใช้ field-rule gating จาก r (ลูกค้าเดียวกัน)
 */
async function fillOneGoodsItem(
  page: Page,
  r: Record,
  item: Record,
  itemIndex = 0,
  itemTotal = 1,
): Promise<void> {
  // === ทำตาม flow Python ที่เคยสำเร็จ (rpa_import.py fill_page3) เป๊ะ ===
  //   Python กรอกเฉพาะ: desc, น้ำหนัก×2+หน่วย×2, net/gross kg, volume+container, ราคา+ประกัน
  //   ⚠ Python "ไม่แตะ" ช่องพิกัด/Brand/descThai/descEng → DCTK เติมพิกัดเอง (ห้ามรบกวน)
  // รหัสสินค้า (description) = combo ที่ "ต้องเลือกจาก master เท่านั้น"
  //   → comboPickStrict: เลือกแถวที่ match; ไม่เจอ → throw (หยุด+แจ้ง ห้ามกรอกมั่ว ตามคู่มือ)
  const descVal = String(item.description ?? "").trim();
  if (allowed(r, "description_eng") && descVal) {
    await comboPickStrict(page, S.SEL_DESC_INPUT, descVal, "รหัสสินค้า");
  }

  // ⚠ ทำตาม Python ที่สำเร็จเป๊ะ: Python "ไม่แตะ" Brand/descThai/descEng/พิกัด/หน่วยช่อง2/ค่าระวาง
  //   เพราะ DCTK auto-fill ช่องเหล่านี้จากรหัสสินค้า การไปกรอกทับ = trigger validation → Save ไม่ผ่าน/tab ไม่ปิด
  //   ช่องเสริมพวกนี้เปิดได้ผ่าน env (RPA_FILL_EXTRA_GOODS=1) เมื่อจำเป็นจริง — default ปิดเหมือน Python
  if (process.env.RPA_FILL_EXTRA_GOODS) {
    const brand = String(item.brand_name ?? r.brand_name ?? "").trim();
    if (brand) await clickThenType(page, S.SEL_BRAND, brand);
    const descThai = String(item.product_description_thai ?? r.product_description_thai ?? "").trim();
    if (descThai) await clickThenType(page, S.SEL_DESC_THAI, descThai);
    const descEngExtra = String(item.description_eng_field ?? "").trim();
    if (descEngExtra) await clickThenType(page, S.SEL_DESC_ENG, descEngExtra);
    const exportTariff = String(item.export_tariff ?? r.export_tariff ?? "").trim();
    if (exportTariff) await comboPick(page, S.SEL_EXPORT_TARIFF_INPUT, exportTariff);
  }

  const netTon = String(item.net_weight_ton ?? "");
  const unit = String(item.unit_code ?? r.unit_code ?? "");
  // หน่วยช่อง 2 = "หน่วยปริมาณในใบขนฯ" (QuantityUnitCode) — DCTK auto-fill ตามพิกัด (เช่นไข่=C62)
  //   ⚠ ต้องตรง "หน่วยหลังพิกัด (C62)" ไม่งั้น save ไม่ผ่าน [[dctk-customs-unit-c62]]
  //   ใช้ customs_unit_code (item/preset) ถ้ามีระบุชัด; ถ้าไม่มี → "ไม่แตะ" ปล่อยค่าที่ DCTK เติมไว้
  // ⚠ ใช้ || ไม่ใช่ ?? — เพราะ item.customs_unit_code อาจเป็น "" (string ว่าง) ซึ่ง ?? ไม่ fallback
  //   ลำดับ: item ก่อน → preset/header (r.customs_unit_code = preset เช่น KASEMCHAI=TNE)
  const customsUnit = String(
    item.customs_unit || item.customs_unit_code || r.customs_unit_code || "",
  ).trim();

  // Python กรอกหน่วยช่อง 1 ด้วย unit (net_weight_unit_code) — ทำตามเป๊ะ
  await put(page, r, "net_weight_ton", S.SEL_NET_TON_1, netTon);
  await putCombo(page, r, "net_weight_unit_code", S.SEL_UNIT_1, unit);
  await put(page, r, "net_weight_ton", S.SEL_NET_TON_2, netTon);
  // ช่อง 2: กรอกเฉพาะเมื่อมี customs_unit ระบุชัด — ไม่งั้นปล่อย C62 ที่ DCTK เติมตามพิกัด
  if (customsUnit) {
    await putCombo(page, r, "customs_unit_code", S.SEL_UNIT_2, customsUnit);
  } else {
    log(`  ⏭ ช่องหน่วยปริมาณในใบขน (ช่อง 2): ไม่มี customs_unit ระบุ → ปล่อยค่าที่ DCTK เติม (กันชน C62)`);
  }

  await put(page, r, "net_weight_kg", S.SEL_NET_KG, String(item.net_weight_kg ?? ""));
  await put(page, r, "gross_weight_kg", S.SEL_GROSS_KG, String(item.gross_weight_kg ?? ""));

  await put(page, r, "container_or_volume_qty", S.SEL_VOLUME, String(item.volume ?? ""));
  // หน่วยหีบห่อ: ถ้าลูกค้าตั้ง preset (กำหนดเอง เช่น THANAKORN=1F) → preset ชนะค่า item เสมอ
  //   (item.container_unit อาจเป็นค่าดิบจาก AI เช่น "BAG" จาก "FLEXI BAG" ซึ่ง DCTK หาไม่เจอ → save ไม่ผ่าน)
  //   ไม่มี preset → ใช้ค่า item ตามเดิม
  const presetKeys = (r.__preset_keys__ as Set<string> | undefined);
  const unitIsPreset = presetKeys?.has("container_unit_code");
  const containerUnit = unitIsPreset
    ? String(r.container_unit ?? "")
    : String(item.container_unit ?? r.container_unit ?? "");
  await putCombo(page, r, "container_unit_code", S.SEL_CONTAINER_UNIT, containerUnit);

  // ตารางราคา Page 3 — แยกทีละ step (1 ช่อง 1 selector 1 วิธี เหมือน Page 2)
  const termP3 = String(r.term ?? "").trim().toUpperCase();
  const currencyP3 = String(r.currency ?? "").trim().toUpperCase() || "USD";
  const wantCurP3 = allowed(r, "currency") && !!currencyP3;

  // ---- STEP: จำนวนเงิน "ราคา" (#_AmountForeign) ----
  const amountVal = stripZeroDecimals(item.amount ?? r.amount ?? "");
  log(`  🔬 ราคา Page 3: amountVal="${amountVal}" (item.amount=${JSON.stringify(item.amount)}, r.amount=${JSON.stringify(r.amount)})`);
  await put(page, r, "total_goods_amount", S.SEL_TERM_AMOUNT, amountVal);
  try {
    const filled = await page.locator(S.SEL_TERM_AMOUNT).first().inputValue();
    log(`  🔬 ราคาในช่องหลังกรอก = "${filled}"`);
  } catch (e) {
    log(`  🔬 อ่านราคาในช่องไม่ได้: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ---- STEP: สกุลเงิน "ค่าระวาง" Page 3 (_Freight_input) — **เลือกแบบจริง (คลิกแถว)** ----
  //   ⚠ text อาจ="USD" (carry มา) แต่ค่า submit จริงยัง 0 → ต้อง "เลือกแถวจริง" ให้ aria-selected=true
  //   ทำหลังกรอกจำนวนเงินสินค้าแล้ว (บรรทัดบน) เพื่อไม่ให้ recalc มารีเซ็ตทีหลัง
  //   DCTK บังคับ "สกุลเงินค่าระวาง 3 หลัก" เสมอ แม้ freight=0 (เช่น CFR ที่รวมค่าระวางในราคา เช่น KASEMCHAI)
  if (wantCurP3 && (termP3 === "CIF" || termP3 === "CFR" || termP3 === "CNF" || termP3 === "C&F")) {
    await selectCurrencyRealClick(page, "_Freight_input", currencyP3);
    // force-set สกุลเงินค่าระวาง (กัน Kendo recalc รีเซ็ต / คลิกแถวไม่ติดตอน multi-item) [[dctk-currency-combo-attempts]]
    try {
      await page.evaluate((cur: string) => {
        for (const name of ["FreightCurrencyCode", "_Freight"]) {
          const el = document.querySelector(`[name="${name}"]`) as HTMLInputElement | null;
          if (el) { el.value = cur; el.dispatchEvent(new Event("change", { bubbles: true })); }
        }
        const inp = document.querySelector("#_Freight_input") as HTMLInputElement | null;
        if (inp) { inp.value = cur; inp.dispatchEvent(new Event("change", { bubbles: true })); }
      }, currencyP3);
      log(`  ✓ force-set สกุลเงินค่าระวาง Page 3 = ${currencyP3}`);
    } catch (e) { log(`  ⚠ force-set สกุลเงินค่าระวาง Page 3 ล้ม: ${e instanceof Error ? e.message.slice(0, 50) : ""}`); }
  }

  // ---- STEP: จำนวนเงิน "ค่าประกัน" ----
  await put(page, r, "insurance_charge", S.SEL_TERM_INSURANCE, stripZeroDecimals(item.insurance ?? r.insurance ?? ""));

  // FOC (รายการของแถม) — Kendo DropDownList #NatureTrans (ปกติ "11-ไม่ใช่ของแถม")
  //   RPA_DUMP_FOC=1 → dump ตัวเลือก dropdown (ครั้งแรก) เพื่อหาค่าที่ถูกของ "ของแถม"
  if (process.env.RPA_DUMP_FOC && itemIndex === 0) {
    await dumpDropdownListOptions(page, S.SEL_NATURE_TRANS, "รายการของแถม (NatureTrans)");
  }
  // ถ้าเป็น FOC → เลือก "21-เป็นของแถม" ใน dropdown #NatureTrans (ค่าจาก inspect จริง)
  //   ตัวเลือก: 11-ไม่ใช่ของแถม (default) / 21-เป็นของแถม / 90-รับจ้างทำของ
  //   override ได้ผ่าน env RPA_FOC_CODE ถ้าต้องการ
  const isFoc = item.is_foc === true;
  if (isFoc) {
    const focCode = (process.env.RPA_FOC_CODE ?? "21").trim();
    try { await kendoDropdownListPick(page, S.SEL_NATURE_TRANS, focCode); log(`  ✓ ตั้งรายการของแถม = ${focCode}-เป็นของแถม`); }
    catch (e) { log(`  ⚠ เลือก FOC (${focCode}) ล้ม: ${e}`); }
  }
}

// หมายเหตุ: ลบ dead code 4 ฟังก์ชันที่ "ผสมสกุลเงิน+จำนวนเงินในตัวเดียว" (anti-pattern) ออกแล้ว —
//   fillPriceRow / fillFreightRowByLabel / allocFreight / putTermFreight (ไม่มีใครเรียก)
//   เหตุผล: กันการเผลอนำกลับมาใช้แล้วทำให้แก้ช่องหนึ่งกระทบอีกช่อง. ค่าระวางกรอกที่ Page 2 (fillPage2Fill) แล้ว.
/** สร้าง 1 รายการจากค่าหัวรายการ (fallback เมื่อไม่มี __items__) */
function fallbackItemFromHeader(r: Record): Record {
  return {
    description: r.description ?? "",
    net_weight_ton: r.net_weight_ton ?? "",
    unit_code: r.unit_code ?? "",
    net_weight_kg: r.net_weight_kg ?? "",
    gross_weight_kg: r.gross_weight_kg ?? "",
    volume: r.volume ?? "",
    container_unit: r.container_unit ?? "",
    amount: r.amount ?? "",
    insurance: r.insurance ?? "",
  };
}

export async function fillPage3(page: Page, r: Record): Promise<void> {
  // ใช้รายการจาก declaration_items ถ้ามี ไม่งั้น fallback ใช้ค่าหัวรายการ 1 รายการ
  const items: Record[] =
    Array.isArray(r.__items__) && r.__items__.length > 0
      ? r.__items__
      : [fallbackItemFromHeader(r)];

  log(`Page 3: goods detail — ${items.length} รายการ`);

  // รอ Page 3 (หน้ารายการสินค้า) โหลดเสร็จก่อนกรอก — กัน combo รหัสสินค้ายังไม่ปรากฏ (DCTK ช้า)
  //   ZECK TSE เคย timeout 15s → เพิ่มเป็น poll ได้ถึง ~45s + รอ networkidle นานขึ้น
  try { await page.waitForLoadState("networkidle", { timeout: 20000 }); } catch { /* */ }
  let descReady = false;
  for (let w = 0; w < 15; w++) { // ~45s (15 × 3s)
    if (await page.locator(S.SEL_DESC_INPUT).first().isVisible().catch(() => false)) { descReady = true; break; }
    await sleep(3000);
  }
  if (!descReady) log("  ⚠ Page 3: ช่องรหัสสินค้ายังไม่ขึ้นหลังรอ ~45s — ลองกรอกต่อ (อาจ error)");
  else log("  ✓ Page 3 พร้อมกรอก (ช่องรหัสสินค้าปรากฏแล้ว)");
  await sleep(800);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const isLast = i === items.length - 1;
    log(`  • รายการ ${i + 1}/${items.length}: ${String(item.description ?? "").slice(0, 40)}`);

    await fillOneGoodsItem(page, r, item, i, items.length);

    if (isLast) {
      // รายการสุดท้าย: ติ๊ก last entry → Save & Close
      if (r.__dry_run__) {
        await captureIfRequested(page, r, `page3_item${i + 1}_last`);
        log("  🧪 dry run: ข้ามการติ๊ก last entry + Save & Close (Page 3)");
        return;
      }
      // ติ๊ก "รายการสุดท้าย" → Save & Close → รอ 5 วิ ให้ DCTK ปิด tab เอง
      //   ⚠ ทำตาม Python ที่สำเร็จเป๊ะ: หลัง Save&Close แค่ sleep(5) เปล่า ๆ
      //   ห้ามเรียก dismissAlert/captureFormErrors/evaluate บน tab นี้ —
      //   เพราะ DCTK กำลัง submit + ปิด tab การไปยุ่ง DOM จะขัดจังหวะ → tab ไม่ปิด
      await page.click(S.SEL_CHK_LAST_ENTRY);
      await captureIfRequested(page, r, `page3_item${i + 1}_last`);
      // 🔑 FORCE สกุลเงิน "ตอนสุดท้ายก่อนเซฟ" (หลังนี้ไม่มี recalc มาทับ) — วิธีที่พิสูจน์แล้วว่าได้ DCTK000034179
      //   พบจาก dump: ค่าจริงมี 2 ชั้น — model field (FreightCurrencyCode) + Kendo widget (_Freight/_Freight_input)
      //   หลัง real-select โดน recalc รีเซ็ต widget เป็น "0" → submit เอา 0 ไปทับ → finalize ฟ้อง
      //   ทางแก้: set ทั้ง model + widget = currency + dispatch change ตอนสุดท้าย
      //   ⚠ force "เฉพาะแถวที่มีจำนวนเงินจริง" — ถ้าใส่สกุลเงินในแถวที่ยอด=0 DCTK อาจฟ้องใหม่
      const curP3 = String(r.currency ?? "").trim().toUpperCase() || "USD";
      const hasFreightP3 = !!stripZeroDecimals(r.freight ?? "");
      const hasInsuranceP3 = !!stripZeroDecimals(r.insurance ?? "") || !!stripZeroDecimals(item.insurance ?? "");
      if (allowed(r, "currency") && curP3) {
        const forced = await page.evaluate(({ want, doFreight, doIns }) => {
          const setVal = (sel: string) => {
            const el = document.querySelector(sel) as HTMLInputElement | null;
            if (!el) return null;
            el.value = want;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return el.value;
          };
          const out: { [k: string]: string | null } = {};
          if (doFreight) {
            out.FreightCurrencyCode = setVal('[name="FreightCurrencyCode"]');
            out._Freight = setVal('[name="_Freight"]');
            out._Freight_input = setVal('input[name="_Freight_input"]');
          }
          if (doIns) {
            out.InsuranceCurrencyCode = setVal('[name="InsuranceCurrencyCode"]');
            out._Insurance = setVal('[name="_Insurance"]');
            out._Insurance_input = setVal('input[name="_Insurance_input"]');
          }
          return out;
        }, { want: curP3, doFreight: hasFreightP3, doIns: hasInsuranceP3 });
        log(`  🔑 force สกุลเงินก่อนเซฟ (freight=${hasFreightP3} insurance=${hasInsuranceP3}): ${JSON.stringify(forced)}`);
      }
      await page.click(S.SEL_BTN_SAVE_CLOSE);
      await sleep(5000);
      // diag เบา ๆ "หลัง" รอครบ (ปลอดภัย: tab น่าจะปิดแล้ว) — ไม่แตะ DOM ถ้าปิดแล้ว
      const closed = page.isClosed();
      log(`  ✓ Page 3 Save&Close — thisPageClosed=${closed}`);
      // ถ้าหน้าไม่ปิด = เซฟไม่ผ่าน → ดักข้อความ error ที่ค้างบนหน้า (จะได้รู้ว่า Page 3 ติดอะไร)
      if (!closed) {
        try {
          const errs = await page.evaluate(() => {
            const txt: string[] = [];
            document.querySelectorAll(".validation-summary-errors, .field-validation-error, .text-danger, [class*='error']:not(:empty)").forEach((e) => {
              const t = (e as HTMLElement).innerText?.trim(); if (t && t.length < 200) txt.push(t);
            });
            return [...new Set(txt)].slice(0, 10);
          });
          if (errs.length) log(`  🛑 Page 3 ยังไม่ปิด — error บนหน้า: ${JSON.stringify(errs)}`);
          else log(`  ℹ Page 3 ยังไม่ปิด แต่ไม่เจอข้อความ error (อาจกำลัง submit ช้า)`);
        } catch { /* */ }
      }
    } else {
      // ยังมีรายการถัดไป: กด "บันทึกและเพิ่มใหม่" (ปุ่มเดียว = บันทึก + เปิดฟอร์มรายการถัดไป)
      if (r.__dry_run__) {
        await captureIfRequested(page, r, `page3_item${i + 1}`);
        log(`  🧪 dry run: ข้ามการกด บันทึกและเพิ่มใหม่ (รายการ ${i + 1})`);
        continue;
      }
      await captureIfRequested(page, r, `page3_item${i + 1}`);
      await page.click(S.SEL_BTN_SAVE_AND_ADD);
      await sleep(2000);
      await dismissAlertIfPresent(page); // บางลูกค้าเด้ง modal หลังบันทึก
      await sleep(3000);
      // 🔑 รอฟอร์มรายการถัดไปพร้อมจริง ก่อนวนไปกรอก (กัน combo รหัสสินค้าค้างของเก่า/โหลดผิด)
      //   อาการเดิม: รายการ 2+ ค้นรหัสสินค้าเจอ master ผิด (เช่น "LIFT") เพราะ dropdown ยังไม่ refresh
      //   → รอช่องรหัสสินค้าว่าง (ฟอร์มใหม่เคลียร์แล้ว) + networkidle ก่อนกรอกรายการถัดไป
      try { await page.waitForLoadState("networkidle", { timeout: 15000 }); } catch { /* */ }
      for (let w = 0; w < 12; w++) { // ~24s
        const ready = await page.evaluate((sel: string) => {
          const el = document.querySelector(sel) as HTMLInputElement | null;
          return !!el && (el.offsetParent !== null) && (el.value ?? "").trim() === "";
        }, S.SEL_DESC_INPUT).catch(() => false);
        if (ready) break;
        await sleep(2000);
      }
      await sleep(500);
    }
  }
}
