// ============================================================
//  Generic helpers + Kendo widget interactions
//  (ported 1:1 from rpa_import.py)
// ============================================================
import type { Page } from "playwright";

/** ตัวรับ log เพิ่มเติม (เช่น web server) — ตั้งผ่าน setLogSink() */
export type LogSink = (line: string) => void;
let logSink: LogSink | null = null;

export function setLogSink(sink: LogSink | null): void {
  logSink = sink;
}

export function log(msg: string): void {
  const line = `[RPA] ${msg}`;
  console.log(line);
  if (logSink) {
    try {
      logSink(line);
    } catch {
      /* อย่าให้ sink ที่พังทำให้ flow ล้ม */
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** '1500.00' -> '1500'; '1500.50' -> '1500.50' */
export function stripZeroDecimals(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) return s;
  const f = Number(s);
  if (!Number.isFinite(f)) return s;
  if (f === Math.trunc(f)) return String(Math.trunc(f));
  return s;
}

/**
 * พิมพ์ลง combo Kendo แล้วคลิกผลลัพธ์ตัวเลือกตัวแรก
 * (combo_pick ใน Python)
 */
/**
 * comboPick แบบเรียบง่าย — เลียนแบบ Python combo_pick ที่สำเร็จเป๊ะ
 *   พิมพ์ค่า → รอ ul.k-list:visible > li.k-item:first-child → คลิก → ถ้าไม่เจอกด Enter
 *   ใช้กับ dropdown list ธรรมดา (เช่น "สกุลเงิน" USD) ที่ comboPick เวอร์ชัน grid ทำพัง
 *   (เวอร์ชัน grid force-set ด้วย dispatchEvent → ได้ค่ายาวเกิน 3 ตัว → DCTK ฟ้อง)
 */
export async function comboPickSimple(
  page: Page,
  inputSelector: string,
  value: string,
): Promise<void> {
  // วิธีที่ user ยืนยันว่าทำสำเร็จด้วยมือ (เหมือนกันทั้งช่อง ราคา/ค่าระวาง/ค่าประกัน):
  //   1. คลิกช่อง → ล้างของเดิม → พิมพ์สกุลเงิน (เช่น USD ที่มาจากข้อมูลใบ ไม่ hardcode)
  //   2. รอ dropdown โผล่ (DCTK ajax filter ช้า) จน filter เหลือแถวเดียว
  //   3. กด Enter เลย — Kendo เลือกแถวที่ highlight แล้ว commit ค่า hidden ที่ submit ใช้จริง
  //      ⚠ "Enter เลย ไม่ต้องคลิกแถว / ไม่ต้อง ArrowDown" — ArrowDown/คลิกพิกัด เคยทำให้เลือกผิดแถว
  //   4. เช็ค commit จาก "dropdown ปิดแล้ว" ไม่ใช่จาก input.value (input แสดงค่าตั้งแต่พิมพ์ ยังไม่ commit)
  // ⭐ วิธีที่พิสูจน์แล้วว่าได้กับ "ช่องราคา" (รัน 1): พิมพ์ → Enter — ห้ามเปลี่ยน
  //   (ช่องราคา commit "USD" ถูกต้องด้วยวิธีนี้; ถ้าไปคลิกแถว grid กลับทำให้ราคาได้ค่ายาวเกิน 3)
  //   ⚠ ช่อง "ค่าระวาง" วิธีนี้ยังได้ "0" — แก้แยกที่ตัวเรียก (putFreightCurrency) ไม่แตะฟังก์ชันนี้
  const want = value.trim().toUpperCase();
  const rowSel =
    ".k-animation-container:visible li[role=option], " +
    ".k-animation-container:visible tbody tr, " +
    ".k-popup:visible li[role=option], " +
    ".k-popup:visible tbody tr, " +
    "[role=listbox]:visible tr";

  // 📝 ACTION LOG: ช่องนี้ชื่ออะไร ค่าเดิมอะไร กำลังจะล้าง+พิมพ์อะไร
  try {
    const before = await page.locator(inputSelector).first().evaluate((el: HTMLInputElement) => ({ name: el.name || el.id || "", was: el.value ?? "" }));
    log(`  📝 comboPickSimple → [${before.name || inputSelector.slice(-40)}] เดิม="${before.was}" → ล้าง("") แล้วพิมพ์="${want}"`);
  } catch { log(`  📝 comboPickSimple → [${inputSelector.slice(-40)}] ล้าง+พิมพ์="${want}"`); }

  await page.click(inputSelector);
  await page.fill(inputSelector, "");
  await page.type(inputSelector, want, { delay: 80 });

  // รอ dropdown (ajax) โผล่ — เช็คทุก 500ms ได้ถึง ~8s
  let appeared = false;
  for (let w = 0; w < 16; w++) {
    if ((await page.locator(rowSel).count()) > 0) { appeared = true; break; }
    await sleep(500);
  }
  await sleep(500); // ให้ list นิ่งก่อนกด Enter

  // กด Enter — เลือกแถวที่ filter เหลือ (เทียบเท่าคลิกแถวด้วยมือ → Kendo commit)
  await page.keyboard.press("Enter");
  await sleep(500);

  const stillOpen = (await page.locator(rowSel).count()) > 0;
  if (!appeared) {
    log(`  ⚠ สกุลเงิน '${want}' — dropdown ไม่โผล่ (ajax ช้า/หาไม่พบ)`);
  } else if (stillOpen) {
    log(`  ⚠ สกุลเงิน '${want}' — กด Enter แล้ว dropdown ยังไม่ปิด (อาจยังไม่ commit)`);
  } else {
    log(`  ✓ สกุลเงิน '${want}' เลือกแล้ว (พิมพ์ → Enter)`);
  }
  await sleep(300);
}

/**
 * comboPickGridRow — เลือกสกุลเงินด้วยการ "คลิกแถวในตาราง (grid)"
 *   ใช้เฉพาะช่อง **ค่าระวาง/ค่าประกัน** เท่านั้น (พิมพ์→Enter ได้ "0" กับช่องพวกนี้)
 *   ⚠ ห้ามเอาไปใช้กับช่อง "ราคา" — ราคาใช้ comboPickSimple (พิมพ์→Enter) ที่พิสูจน์แล้วว่าได้
 *      (เคยเอา grid-click ไปใช้ราคา → จำนวนเงินหลุดลงช่องสกุลเงิน = พัง)
 *   วิธี: คลิกช่อง → พิมพ์ code → รอ grid → คลิก cell แรกที่ == code → ตรวจ input == 3 ตัว
 */
/**
 * setCurrencyViaKendo — commit สกุลเงินผ่าน Kendo widget API "โดยตรง" (ไม่พึ่งการคลิก UI)
 *   ใช้กับช่องที่คลิก/Enter แล้วแสดงตัวอักษรแต่ "ไม่ commit dataItem จริง" (เช่น ค่าระวาง)
 *   widget เข้าถึงผ่าน input ที่ name ลงท้าย "_input" (id ว่าง) → $('input[name="X_input"]')
 *   ลอง dropdowngrid → combobox → dropdownlist; set value + select dataItem (code==want) + trigger change
 *   @param inputName ชื่อ input ที่ลงท้าย _input เช่น "_Freight_input"
 *   คืน true ถ้า commit ค่าจริง == want (3 ตัว) สำเร็จ
 */
export async function setCurrencyViaKendo(
  page: Page,
  inputName: string,
  value: string,
): Promise<boolean> {
  const want = value.trim().toUpperCase();
  const valueField = inputName.replace(/_input$/, ""); // _Freight_input → _Freight (ช่องค่าจริง)
  const res = await page.evaluate(({ inp, want, valField }) => {
    const out: { ok: boolean; via: string; committed: string; found: string[] } = { ok: false, via: "", committed: "", found: [] };
    const w = window as unknown as { jQuery?: (s: string | Element) => { data: (k: string) => unknown; length?: number } };
    const $ = w.jQuery;
    if (!$) { out.via = "no-jquery"; return out; }
    // หา widget จากหลาย element ที่ Kendo อาจ init ไว้: #_Freight (value), input[name=_Freight_input],
    //   .k-dropdowngrid wrapper, span.k-widget ใกล้ ๆ
    const inpEl = document.querySelector(`input[name="${inp}"]`) as HTMLElement | null;
    const cands: Element[] = [];
    const byId = document.getElementById(valField); if (byId) cands.push(byId);          // #_Freight
    const byName = document.querySelector(`[name="${valField}"]`); if (byName && byName !== byId) cands.push(byName);
    if (inpEl) {
      cands.push(inpEl);
      const wrap = inpEl.closest(".k-widget, .k-dropdowngrid, [data-role]"); if (wrap) cands.push(wrap);
    }
    for (const c of cands) {
      for (const role of ["kendoDropDownGrid", "kendoComboBox", "kendoDropDownList", "kendoDropDownTree"]) {
        const widget = $(c).data(role) as {
          value: (v?: string) => string;
          trigger: (e: string) => void;
          dataSource?: { data: () => Array<Record<string, unknown>>; view?: () => Array<Record<string, unknown>> };
          select?: (fn: number | ((d: Record<string, unknown>) => boolean)) => void;
        } | undefined;
        if (!widget) continue;
        out.found.push(role + "@" + (c.id || (c as HTMLElement).className?.slice(0, 20) || c.tagName));
        try {
          if (widget.select && widget.dataSource) {
            widget.select((d) => Object.values(d).some((x) => String(x).trim().toUpperCase() === want));
          }
          widget.value(want);
          widget.trigger("change");
          out.via = role + "@" + (c.id || c.tagName);
        } catch (e) { out.via = "err:" + String(e).slice(0, 40); }
        break;
      }
      if (out.via) break;
    }
    const vf = document.querySelector(`[name="${valField}"]`) as HTMLInputElement | null;
    out.committed = (vf?.value ?? "").trim().toUpperCase();
    out.ok = out.committed === want;
    return out;
  }, { inp: inputName, want, valField: valueField });
  log(`  🔧 Kendo set [${inputName}] via=${res.via} found=[${res.found.join(",")}] committed="${res.committed}" ok=${res.ok}`);
  await sleep(300);
  return res.ok;
}

/**
 * selectCurrencyRealClick — "เลือกสกุลเงินแบบจริง" เหมือน user คลิกด้วยมือ
 *   1. คลิกช่อง (focus) → ล้าง → พิมพ์ code (เปิด+กรอง grid ให้เหลือแถวที่ต้องการ)
 *   2. รอ <li role=option> ใน popup ของ widget (id = "{base}_listbox")
 *   3. **คลิก <li> ทั้งแถว** (ไม่ใช่ span ข้างใน) → Kendo เซ็ต aria-selected=true + commit dataItem จริง
 *   4. ตรวจ aria-selected / ค่าจริง (_Freight) กลับมา
 *   @param inputName ชื่อ input ที่ลงท้าย _input เช่น "_Freight_input"
 *   คืน true ถ้า "เลือกจริง" สำเร็จ
 */
export async function selectCurrencyRealClick(
  page: Page,
  inputName: string,
  value: string,
): Promise<boolean> {
  const want = value.trim().toUpperCase();
  const base = inputName.replace(/_input$/, "");        // _Freight_input → _Freight
  const inputSel = `input[name="${inputName}"]`;
  const listboxSel = `#${base}_listbox`;                // popup listbox ของ widget นี้
  const rowSel = `${listboxSel} li[role="option"]`;

  log(`  🎯 เลือกสกุลเงินแบบจริง [${inputName}] = "${want}"`);
  // 1) focus + clear + type → เปิด/กรอง grid
  await page.locator(inputSel).first().click();
  await page.locator(inputSel).first().fill("");
  await page.locator(inputSel).first().type(want, { delay: 90 });

  // 2) รอแถวใน listbox ของ widget นี้โดยเฉพาะ (ajax filter)
  let appeared = false;
  for (let w = 0; w < 20; w++) {
    if ((await page.locator(rowSel).count()) > 0) { appeared = true; break; }
    await sleep(500);
  }
  await sleep(400);
  if (!appeared) { log(`  ⚠ [${inputName}] grid ไม่โผล่`); return false; }

  // 3) คลิก <li> ทั้งแถว ที่ cell แรก == want (real mouse click → Kendo select dataItem)
  const rows = page.locator(rowSel);
  const n = await rows.count();
  let clicked = false;
  for (let i = 0; i < n; i++) {
    const li = rows.nth(i);
    const code = ((await li.locator("span.k-cell").first().innerText().catch(() => "")) || "").trim().toUpperCase();
    if (code === want || (n === 1)) {
      await li.scrollIntoViewIfNeeded().catch(() => {});
      await li.click();          // ← คลิกทั้งแถว (ตัว li) ไม่ใช่ span
      await sleep(500);
      clicked = true;
      break;
    }
  }
  if (!clicked) { log(`  ⚠ [${inputName}] ไม่เจอแถว "${want}" ใน ${n} แถว`); return false; }

  // 4) ตรวจ "เลือกจริง" — aria-selected + ค่าจริง (_Freight)
  const chk = await page.evaluate(({ lb, valField, want }) => {
    const sel = document.querySelector(`${lb} li[aria-selected="true"] span.k-cell`)?.textContent?.trim().toUpperCase() || "";
    const vf = (document.querySelector(`[name="${valField}"]`) as HTMLInputElement | null)?.value?.trim().toUpperCase() || "";
    return { selectedRow: sel, valueField: vf, ok: vf === want };
  }, { lb: listboxSel, valField: base, want });
  log(`  🎯 ผลเลือกจริง [${inputName}]: aria-selected="${chk.selectedRow}" ${base}="${chk.valueField}" ok=${chk.ok}`);
  await sleep(300);
  return chk.ok;
}

export async function comboPickGridRow(
  page: Page,
  inputSelector: string,
  value: string,
): Promise<void> {
  const want = value.trim().toUpperCase();
  const rowSel =
    ".k-animation-container:visible li[role=option], " +
    ".k-popup:visible li[role=option]";

  await page.click(inputSelector);
  await page.fill(inputSelector, "");
  await page.type(inputSelector, want, { delay: 80 });

  // รอ grid (ajax) โผล่
  let appeared = false;
  for (let w = 0; w < 16; w++) {
    if ((await page.locator(rowSel).count()) > 0) { appeared = true; break; }
    await sleep(500);
  }
  await sleep(500);

  const rows = page.locator(rowSel);
  const n = await rows.count();
  let clicked = false;
  // คลิก cell แรก (รหัสสกุลเงิน) ที่ == code เป๊ะก่อน, ไม่งั้น startsWith
  for (let pass = 0; pass < 2 && !clicked; pass++) {
    for (let i = 0; i < n; i++) {
      const cell = rows.nth(i).locator("span.k-cell").first();
      const code = ((await cell.innerText().catch(() => "")) || "").trim().toUpperCase();
      const hit = pass === 0 ? code === want : (code && code.startsWith(want));
      if (hit) { await cell.click(); await sleep(400); clicked = true; break; }
    }
  }
  // ถ้าไม่เจอ cell แต่มีแถว → คลิกทั้งแถวแรก
  if (!clicked && n > 0) {
    try { await rows.first().click(); await sleep(400); clicked = true; } catch { /* */ }
  }

  // ตรวจ input — ต้องเป็น code 3 ตัวจริง; ถ้า Kendo set ชื่อยาว → force fill + dispatch change
  try {
    const cur = (await page.locator(inputSelector).inputValue()).trim();
    if (cur.toUpperCase() !== want) {
      await page.locator(inputSelector).fill(want);
      await page.locator(inputSelector).evaluate((el: HTMLElement) => {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
      });
    }
  } catch { /* คงค่าเดิม */ }

  const got = (await page.locator(inputSelector).inputValue().catch(() => "")).trim().toUpperCase();
  if (!appeared) log(`  ⚠ สกุลเงิน '${want}' — grid ไม่โผล่`);
  else if (got !== want) log(`  ⚠ สกุลเงิน '${want}' — คลิกแถวแล้ว got="${got}" (ไม่ใช่ 3 ตัว)`);
  else log(`  ✓ สกุลเงิน '${want}' เลือกแถว grid แล้ว (commit)`);
  await sleep(300);
}

export async function comboPick(
  page: Page,
  inputSelector: string,
  value: string,
): Promise<void> {
  const want = value.trim().toUpperCase();

  // 📝 ACTION LOG + เช็คค่าเดิม
  let wasVal = "";
  try {
    const before = await page.locator(inputSelector).first().evaluate((el: HTMLInputElement) => ({ name: el.name || el.id || "", was: el.value ?? "" }));
    wasVal = (before.was || "").trim();
    log(`  📝 comboPick → [${before.name || inputSelector.slice(-40)}] เดิม="${before.was}" → ล้าง("") แล้วพิมพ์="${value}"`);
  } catch { log(`  📝 comboPick → [${inputSelector.slice(-40)}] ล้าง+พิมพ์="${value}"`); }

  // ⚡ ถ้าค่าเดิม = ค่าที่ต้องการอยู่แล้ว (DCTK เติม/รายการก่อนหน้าค้างไว้) → ไม่ต้องล้างพิมพ์ใหม่
  //    (สำคัญกับ multi-item: รายการ 2+ DCTK มักเติมหน่วยเดิมค้างไว้ การล้าง+พิมพ์ทำให้ dropdown ไม่โผล่ → เลือกไม่ได้)
  if (wasVal.toUpperCase() === want) {
    log(`  ⚡ comboPick: ค่าเดิม="${wasVal}" = ที่ต้องการแล้ว — ข้าม (ไม่ล้าง/พิมพ์ใหม่)`);
    return;
  }

  await page.click(inputSelector);
  await page.fill(inputSelector, "");
  await page.type(inputSelector, value, { delay: 50 });

  // รอ dropdown โผล่ (DCTK ajax — บน VM ช้า รอได้ถึง 12s, เช็กทุก 500ms; พิมพ์ซ้ำกระตุ้นถ้าเกินครึ่งทาง)
  let dropdownUp = false;
  for (let w = 0; w < 24; w++) {
    const has = await page.locator(
      ".k-animation-container:visible li[role=option], ul.k-list:visible > li.k-item",
    ).count();
    if (has > 0) { dropdownUp = true; break; }
    // กลางทาง (6s) ยังไม่โผล่ → กระตุ้นใหม่ (พิมพ์ตัวสุดท้ายซ้ำ — เผื่อ ajax รอบแรกหลุดบน VM ช้า)
    if (w === 12) {
      try { await page.locator(inputSelector).press("Backspace"); await page.type(inputSelector, value.slice(-1), { delay: 50 }); } catch { /* */ }
    }
    await sleep(500);
  }
  if (!dropdownUp) log(`  ⚠ comboPick: dropdown ไม่โผล่ใน 12s (VM ช้า?) — ลองเลือกจากที่มีต่อ`);

  // (A) dropdowngrid (Kendo): row = li[role=option] มี span.k-cell (cell แรก = code) — เช็กก่อน
  try {
    const gridRows = page.locator(".k-animation-container:visible li[role=option] span.k-cell, .k-popup:visible li[role=option] span.k-cell");
    if (await gridRows.count()) {
      const rows = page.locator(".k-animation-container:visible li[role=option], .k-popup:visible li[role=option]");
      const n = await rows.count();
      const fixInput = async () => {
        // หลังเลือก ถ้า Kendo เซ็ตค่ายาว (text เต็ม row) → force set เป็น code ที่ต้องการ
        try {
          const cur = (await page.locator(inputSelector).inputValue()).trim();
          if (cur.toUpperCase() !== want) {
            await page.locator(inputSelector).fill(want);
            await page.locator(inputSelector).evaluate((el) => {
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
              el.dispatchEvent(new Event("blur", { bubbles: true }));
            });
          }
        } catch { /* คงค่าเดิม */ }
      };
      // pass 1: cell แรก (code) == value เป๊ะ → คลิก cell → fix input
      for (let i = 0; i < n; i++) {
        const firstCell = rows.nth(i).locator("span.k-cell").first();
        const code = ((await firstCell.innerText()) || "").trim().toUpperCase();
        if (code === want) { await firstCell.click(); await sleep(400); await fixInput(); return; }
      }
      // pass 2: cell แรก startsWith → คลิก cell → fix
      for (let i = 0; i < n; i++) {
        const firstCell = rows.nth(i).locator("span.k-cell").first();
        const code = ((await firstCell.innerText()) || "").trim().toUpperCase();
        if (code && code.startsWith(want)) { await firstCell.click(); await sleep(400); await fixInput(); return; }
      }
      // pass 3: keyboard + fix
      if (n > 0) { await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter"); await sleep(400); await fixInput(); return; }
    }
  } catch { /* ลอง list ปกติต่อ */ }

  // (B) dropdown list ปกติ ul.k-list > li.k-item (ไม่ใช่ grid)
  try {
    const listItem = "ul.k-list:visible > li.k-item:first-child";
    await page.waitForSelector(listItem, { timeout: 3000 });
    await page.click(listItem);
    return;
  } catch { /* */ }

  log(`  ⚠ combo ไม่เจอผลลัพธ์ '${value}' ที่ ${inputSelector.slice(0, 60)}…`);
  await page.keyboard.press("Enter");
}

/**
 * comboPick แบบ "ต้องเลือกจาก master เท่านั้น" (เช่น รหัสสินค้า/description)
 * พิมพ์ค่า → รอ dropdown → เลือกแถวที่ match (เป๊ะ/startsWith/contains 2 ทาง)
 * ถ้าไม่เจอแถวที่ match → **throw error** (หยุด + แจ้ง ตามคู่มือ: สินค้าไม่มีใน master ห้ามกรอกมั่ว)
 */
export async function comboPickStrict(
  page: Page,
  inputSelector: string,
  value: string,
  fieldLabel = "รหัสสินค้า",
): Promise<void> {
  const want = value.trim().toUpperCase();
  // รอ combo โผล่ก่อน (Page 3 อาจโหลดช้า — กัน click timeout)
  await page.waitForSelector(inputSelector, { state: "visible", timeout: 15000 });
  await sleep(300);

  const rowsSel =
    ".k-animation-container:visible li[role=option], .k-popup:visible li[role=option], ul.k-list:visible > li.k-item";
  const firstToken = want.split(/\s+/)[0] || want; // คำสำคัญตัวแรกของชื่อสินค้า

  // พิมพ์ค้น + รอ dropdown — retry ได้ถึง 3 รอบ เผื่อ dropdown ค้างผลของเก่า (multi-item รายการ 2+)
  //   อาการ: ค้น "THAI FRESH..." แต่ dropdown ขึ้นผลเก่าที่ไม่เกี่ยว (เช่น "LIFT") เพราะ ajax ยังไม่ refresh
  let n = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.click(inputSelector);
    await page.fill(inputSelector, "");
    await sleep(200);
    await page.type(inputSelector, value, { delay: 50 });
    // รอ dropdown ajax
    for (let w = 0; w < 14; w++) {
      if ((await page.locator(rowsSel).count()) > 0) break;
      await sleep(500);
    }
    n = await page.locator(rowsSel).count();
    // ตรวจว่า dropdown "เกี่ยวกับสิ่งที่ค้น" ไหม — ถ้าทุกแถวไม่มี firstToken เลย = ค้างผลเก่า → ค้นใหม่
    //   ⚠ ใช้ Playwright locator (รองรับ :visible) ไม่ใช่ querySelectorAll (DOM API ไม่รู้จัก :visible)
    if (n > 0) {
      let fresh = false;
      const checkN = Math.min(n, 20);
      for (let r = 0; r < checkN; r++) {
        const t = (await page.locator(rowsSel).nth(r).innerText().catch(() => "")).toUpperCase();
        if (t.includes(firstToken)) { fresh = true; break; }
      }
      if (fresh) break; // dropdown ตรงกับที่ค้นแล้ว
      log(`  ↻ ${fieldLabel}: dropdown ขึ้นผลที่ไม่เกี่ยวกับ "${firstToken}" (อาจค้างของเก่า) — รอ ${attempt}/3 แล้วค้นใหม่`);
    } else {
      // ไม่มีแถวเลย — อาจ ajax ช้า ลองใหม่ (ยกเว้นรอบสุดท้ายปล่อยไปเข้า fuzzy)
      log(`  ↻ ${fieldLabel}: dropdown ว่าง รอบ ${attempt}/3`);
    }
    if (attempt < 3) { await page.keyboard.press("Escape").catch(() => { /* */ }); await sleep(2000); }
  }

  const rows = page.locator(rowsSel);
  n = await rows.count();
  if (n === 0) {
    // dropdown ว่าง = ค้นด้วยชื่อเต็มแบบ prefix ไม่เจอ (เช่น "RBD SOYBEAN..." ไม่ match "RBD SOYA BEAN...")
    //   → ลอง fuzzy ด้วยคำสำคัญคำแรกก่อน (ค้นกว้างขึ้น ให้ master โผล่ แล้วเทียบความเหมือน)
    log(`  🔎 รหัสสินค้า: ค้น "${value}" เต็มๆ ไม่เจอแถว → ลอง fuzzy ด้วยคำสำคัญ`);
    const picked = await fuzzyPickFromMaster(page, inputSelector, want);
    if (picked) { await sleep(400); return; }
    throw new Error(`${fieldLabel}: ไม่พบรายการใน master DCTK สำหรับ "${value}" (ต้องเพิ่มสินค้าใน master ก่อน)`);
  }

  // อ่าน text ทุกแถว (cell แรกถ้าเป็น grid ไม่งั้นทั้ง row)
  const textOf = async (i: number): Promise<string> => {
    const row = rows.nth(i);
    const cell = row.locator("span.k-cell").first();
    try {
      const t = (await cell.count()) ? await cell.innerText() : await row.innerText();
      return (t || "").trim().toUpperCase();
    } catch { return ""; }
  };

  // pass 1: เป๊ะ
  for (let i = 0; i < n; i++) {
    if ((await textOf(i)) === want) { await rows.nth(i).click(); await sleep(400); return; }
  }
  // pass 2: startsWith
  for (let i = 0; i < n; i++) {
    const t = await textOf(i);
    if (t && (t.startsWith(want) || want.startsWith(t))) { await rows.nth(i).click(); await sleep(400); return; }
  }
  // pass 3: contains 2 ทาง (master อาจชื่อสั้นกว่าค่าที่สกัด)
  for (let i = 0; i < n; i++) {
    const t = await textOf(i);
    if (t && (t.includes(want) || want.includes(t))) { await rows.nth(i).click(); await sleep(400); return; }
  }

  // pass 4: FUZZY FALLBACK — ชื่อในเอกสารอาจสะกดต่างจาก master เล็กน้อย
  //   (เช่น "RBD SOYBEAN OIL (NON-GMOS)" ในเอกสาร vs "RBD SOYA BEAN OIL" ใน master)
  //   วิธี: retype ด้วย "คำสำคัญ" (token แรกๆ ที่ไม่ใช่ stopword/วงเล็บ) แล้ว
  //   เทียบ token overlap — เลือกเฉพาะเมื่อมีแถวเดียวที่ overlap สูงพอ (ปลอดภัย ไม่เดามั่ว)
  const picked = await fuzzyPickFromMaster(page, inputSelector, want);
  if (picked) { await sleep(400); return; }

  // ไม่ match แถวไหนเลย → หยุด + แจ้ง พร้อม list ชื่อใน master ที่มีให้เห็น (ช่วยแก้)
  const master = [];
  for (let i = 0; i < Math.min(n, 10); i++) {
    const t = await textOf(i);
    if (t) master.push(t);
  }
  log(`  📋 ${fieldLabel} "${value}" ไม่อยู่ใน master — รายการที่มีใน master (${n} รายการ):`);
  master.forEach((m) => log(`     • ${m}`));
  throw new Error(`${fieldLabel}: "${value}" ไม่ตรงกับ master DCTK — master มี: ${master.slice(0, 6).join(" / ")}${n > 6 ? ` …(${n} รายการ)` : ""}`);
}

/** token ของชื่อสินค้า (ตัดวงเล็บ/อักขระพิเศษ/stopword ออก) เพื่อเทียบความเหมือน */
function productTokens(s: string): string[] {
  const STOP = new Set(["OIL", "THE", "OF", "AND", "FOR", "WITH", "GMOS", "GMO", "NON", "CE"]);
  return s
    .toUpperCase()
    .replace(/\([^)]*\)/g, " ")      // ตัดเนื้อในวงเล็บ เช่น (NON-GMOS)
    .replace(/[^A-Z0-9 ]/g, " ")      // เหลือเฉพาะ A-Z 0-9 และเว้นวรรค
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

/** รวม token เป็นสตริงเดียว (ตัด space) — จับเคส "SOYBEAN" ≈ "SOYA BEAN" */
function productKey(s: string): string {
  return productTokens(s).join("");
}

/** ความเหมือนระดับตัวอักษร 0..1 (Levenshtein-based) — เทียบ productKey */
function strSimilarity(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return 1 - dp[m][n] / Math.max(m, n);
}

/**
 * Fuzzy fallback: retype ด้วยคำสำคัญ (token แรก) → ดูแถวที่ขึ้น → เลือกถ้า "ปลอดภัย"
 * ปลอดภัย = มีแถวเดียวที่ token overlap ≥ 60% ของฝั่งที่สั้นกว่า (กันเลือกผิดเมื่อมีหลายแถวคล้าย)
 * คืน true ถ้าเลือกสำเร็จ, false ถ้าไม่กล้าเลือก (ให้ caller throw ตามเดิม)
 */
async function fuzzyPickFromMaster(
  page: Page,
  inputSelector: string,
  want: string,
): Promise<boolean> {
  const wantTok = productTokens(want);
  if (wantTok.length === 0) return false;
  const wantKey = productKey(want);

  const rowsSel =
    ".k-animation-container:visible li[role=option], .k-popup:visible li[role=option], ul.k-list:visible > li.k-item";

  // คะแนนความเหมือนของชื่อ master กับ want — max(token overlap, char similarity)
  const scoreOf = (t: string): number => {
    const tok = productTokens(t);
    const overlap = tok.filter((x) => wantTok.includes(x)).length;
    const tokScore = overlap / (Math.min(tok.length, wantTok.length) || 1);
    const charScore = strSimilarity(wantKey, productKey(t));
    return Math.max(tokScore, charScore);
  };

  // ค้นทีละคำสำคัญ (token แรก → ถ้าไม่เจอแถว ลองคำที่ 2,3...) แล้วรวม candidate ที่ดีที่สุด
  //   เช่น "FREEZE DRIED ICE CREAM - COCONUT" ค้น "FREEZE" ไม่เจอ → ลอง "DRIED"/"ICE"/"COCONUT"
  let best: { text: string; score: number } | null = null;
  let second: { text: string; score: number } | null = null;
  let bestRowText = "";
  for (const query of wantTok) {
    log(`  🔎 fuzzy: ค้น master ด้วยคำสำคัญ "${query}" (จาก "${want}")`);
    // ปิด dropdown เดิมที่อาจเปิดค้าง (บัง input → click ค้าง 30s บน VM) + ทุก action มี timeout สั้น + log สเต็ป
    await page.keyboard.press("Escape").catch(() => { /* */ });
    log(`     · click ช่องค้น...`);
    await page.click(inputSelector, { timeout: 8000 }).catch((e) => log(`     ⚠ click fail: ${String(e).slice(0, 40)}`));
    log(`     · เคลียร์ + พิมพ์ "${query}"...`);
    await page.fill(inputSelector, query, { timeout: 8000 }).catch((e) => log(`     ⚠ fill fail: ${String(e).slice(0, 40)}`));
    // กระตุ้น Kendo ให้ค้น (fill อย่างเดียวบางทีไม่ trigger) — พิมพ์ตัวสุดท้ายซ้ำ
    await page.locator(inputSelector).press("End", { timeout: 4000 }).catch(() => { /* */ });
    await page.keyboard.type(" ", { delay: 20 }).catch(() => { /* */ });
    await page.keyboard.press("Backspace").catch(() => { /* */ });
    log(`     · รอ dropdown...`);
    let appeared = false;
    for (let w = 0; w < 14; w++) {
      const c = await page.locator(rowsSel).count().catch(() => 0);
      if (c > 0) { appeared = true; break; }
      await sleep(500);
    }
    log(`     · dropdown ${appeared ? "ขึ้นแล้ว" : "ไม่ขึ้น (7s)"}`);
    const rows = page.locator(rowsSel);
    const n = await rows.count().catch(() => 0);
    if (n === 0) { log(`  🔎 fuzzy: ค้น "${query}" ไม่เจอแถว — ลองคำถัดไป`); continue; }

    // เก็บ candidate ที่ดีสุด/รองจากแถวที่ขึ้นกับ query นี้
    for (let i = 0; i < Math.min(n, 30); i++) {
      const cell = rows.nth(i).locator("span.k-cell").first();
      let t = "";
      try { t = ((await cell.count()) ? await cell.innerText() : await rows.nth(i).innerText()).trim().toUpperCase(); }
      catch { continue; }
      if (!t) continue;
      const sc = scoreOf(t);
      if (!best || sc > best.score) { second = best; best = { text: t, score: sc }; bestRowText = t; }
      else if (!second || sc > second.score) { second = { text: t, score: sc }; }
    }
    // ถ้าเจอ candidate ที่ดีพอแล้ว (≥0.8) หยุดค้นคำถัดไป (เร็วขึ้น)
    if (best && best.score >= 0.8) break;
  }

  if (!best) { log(`  🔎 fuzzy: ทุกคำสำคัญค้นไม่เจอแถวใน master`); return false; }

  // ปลอดภัย: best ต้อง score ≥ 0.6 และไม่คลุมเครือ (ห่างจากอันดับ 2 ชัด หรืออันดับ 2 ต่ำกว่า threshold)
  const SAFE = 0.6;
  if (best.score >= SAFE && (!second || best.score - second.score >= 0.2 || second.score < SAFE)) {
    // ค้นชื่อ best อีกรอบให้ขึ้น dropdown แล้วคลิกแถวที่ตรง (text ตรง) เพื่อเลือก
    log(`  ✓ fuzzy: เลือก "${best.text}" (overlap ${Math.round(best.score * 100)}%) แทน "${want}"`);
    await page.keyboard.press("Escape").catch(() => { /* */ });
    log(`     · click+พิมพ์ใหม่เพื่อเปิด dropdown เลือก...`);
    await page.click(inputSelector, { timeout: 8000 }).catch(() => { /* */ });
    // พิมพ์คำสำคัญที่ทำให้ best โผล่ (ใช้ token แรกของ best เอง) — fill มี timeout
    const bestFirstTok = productTokens(bestRowText)[0] || wantTok[0];
    await page.fill(inputSelector, bestFirstTok, { timeout: 8000 }).catch(() => { /* */ });
    await page.locator(inputSelector).press("End", { timeout: 4000 }).catch(() => { /* */ });
    await page.keyboard.type(" ", { delay: 20 }).catch(() => { /* */ });
    await page.keyboard.press("Backspace").catch(() => { /* */ });
    log(`     · รอ dropdown รอบเลือก...`);
    for (let w = 0; w < 14; w++) {
      if ((await page.locator(rowsSel).count().catch(() => 0)) > 0) break;
      await sleep(500);
    }
    const rows = page.locator(rowsSel);
    const n = await rows.count().catch(() => 0);
    log(`     · มี ${n} แถว — หาแถว "${best.text}" เพื่อคลิก`);
    // หาแถว text ตรง → คลิก (timeout สั้น กันค้าง)
    for (let i = 0; i < n; i++) {
      const cell = rows.nth(i).locator("span.k-cell").first();
      let t = "";
      try { t = ((await cell.count()) ? await cell.innerText() : await rows.nth(i).innerText()).trim().toUpperCase(); }
      catch { continue; }
      if (t === best.text) {
        log(`     · คลิกแถว ${i} (ตรง)`);
        await rows.nth(i).click({ timeout: 8000 }).catch(() => { /* */ });
        await sleep(300);
        return true;
      }
    }
    // เผื่อหาแถวเป๊ะไม่เจอ — คลิกแถวที่ score สูงสุดในรอบนี้
    let bi = -1, bs = -1;
    for (let i = 0; i < n; i++) {
      const cell = rows.nth(i).locator("span.k-cell").first();
      let t = "";
      try { t = ((await cell.count()) ? await cell.innerText() : await rows.nth(i).innerText()).trim().toUpperCase(); }
      catch { continue; }
      const sc = scoreOf(t); if (sc > bs) { bs = sc; bi = i; }
    }
    if (bi >= 0 && bs >= SAFE) {
      log(`     · คลิกแถว ${bi} (score สูงสุด ${Math.round(bs * 100)}%)`);
      await rows.nth(bi).click({ timeout: 8000 }).catch(() => { /* */ });
      await sleep(300);
      return true;
    }
    // เผื่อคลิกแถวไม่ได้เลย — ลอง ArrowDown+Enter เลือก highlighted (Kendo combo)
    log(`     · คลิกแถวไม่สำเร็จ — ลอง ArrowDown+Enter`);
    await page.keyboard.press("ArrowDown").catch(() => { /* */ });
    await page.keyboard.press("Enter").catch(() => { /* */ });
    await sleep(300);
    return true;
  }
  log(`  🔎 fuzzy: ไม่กล้าเลือก (best="${best?.text}" ${Math.round((best?.score ?? 0) * 100)}%, รอง="${second?.text}" ${Math.round((second?.score ?? 0) * 100)}%) — ปล่อยให้ error`);
  return false;
}

/**
 * เปิด Kendo dropdown แล้วเลือก item ที่ขึ้นต้นด้วยรหัส (เช่น 'A' → 'A - ...')
 * (kendo_dropdown_pick ใน Python)
 */
export async function kendoDropdownPick(
  page: Page,
  dropdownSelector: string,
  code: string,
): Promise<void> {
  await page.click(dropdownSelector);
  await sleep(800);
  const codeNorm = code.trim().toUpperCase();
  const wordBoundary = new RegExp(`^${escapeRegExp(codeNorm)}\\b`);
  // รองรับทั้ง ul.k-list ปกติ และ dropdowngrid (li[role=option] + span.k-cell)
  const itemSel =
    "ul.k-list:visible > li.k-item, " +
    ".k-animation-container:visible li[role=option], " +
    ".k-popup:visible li.k-item";
  try { await page.waitForSelector(itemSel, { timeout: 8000 }); } catch { /* */ }
  const items = page.locator(itemSel);
  const count = await items.count();
  for (let i = 0; i < count; i++) {
    const row = items.nth(i);
    // dropdowngrid: เทียบ cell แรก (code); list ปกติ: เทียบ text ทั้ง item
    const firstCell = row.locator("span.k-cell").first();
    let text = "";
    try { text = ((await firstCell.count()) ? await firstCell.innerText() : await row.innerText()).trim().toUpperCase(); }
    catch { continue; }
    if (!text) continue;
    if (text === codeNorm || wordBoundary.test(text)) {
      await row.click();
      return;
    }
  }
  throw new Error(`dropdown ไม่พบรหัส '${code}' (มี ${count} items)`);
}

/**
 * คลิก 1 ครั้ง → ลบของเดิมให้หมด → พิมพ์ค่าใหม่
 * ใช้ JS focus+click เพื่อ bypass visibility check ของ Kendo formatted input
 * (_click_then_type ใน Python)
 */
export async function clickThenType(
  page: Page,
  selector: string,
  value: unknown,
  opts?: { commit?: boolean },
): Promise<void> {
  if (value === null || value === undefined || value === "") return;
  const loc = page.locator(selector).first();
  // 📝 ACTION LOG: อ่านชื่อ/ค่าเดิมของช่องก่อนเขียน เพื่อรู้ว่าเขียนทับช่องไหน
  try {
    const before = await loc.evaluate((el: HTMLInputElement) => ({ name: el.name || el.id || "", was: el.value ?? "" }));
    log(`  📝 clickThenType → [${before.name || selector.slice(-40)}] เดิม="${before.was}" พิมพ์="${String(value)}"${opts?.commit ? " +Tab" : ""}`);
  } catch { log(`  📝 clickThenType → [${selector.slice(-40)}] พิมพ์="${String(value)}"`); }
  await loc.evaluate((el: any) => {
    el.scrollIntoView({ block: "center" });
    el.focus();
    el.click();
  });
  await page.waitForTimeout(150);
  // ลบของเดิมให้หมด (เผื่อ field ถูก auto-fill จาก field อื่น)
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Meta+A"); // macOS
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Delete");
  await page.keyboard.type(String(value), { delay: 30 });
  // blur เพื่อให้ Kendo widget commit ค่า — เฉพาะเมื่อขอ (opts.commit)
  //   ⚠ ช่องราคา Kendo: ถ้าไม่ blur ค่าจะค้างที่ formatted-value แต่ค่าจริง = 0
  //   ห้าม blur ทุก field (เช่น login) เพราะ Tab อาจเลื่อน focus ไปโดน element ผิด
  if (opts?.commit) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(100);
  }
}

/**
 * ล้างค่าในช่องให้ว่าง (สำหรับ config "กำหนดเอง/AI ที่ค่าว่าง = ตั้งใจให้ว่าง")
 * รองรับทั้ง text input และ Kendo widget (เคลียร์ value + dispatch event ให้ Kendo รับรู้)
 * best-effort — ถ้าหา element ไม่เจอก็ข้าม (ไม่ throw)
 */
export async function clearField(page: Page, selector: string): Promise<void> {
  try {
    const loc = page.locator(selector).first();
    if (!(await loc.count())) return;
    // 📝 ACTION LOG
    try {
      const b = await loc.evaluate((el: HTMLInputElement) => ({ name: el.name || el.id || "", was: el.value ?? "" }));
      log(`  📝 clearField → [${b.name || selector.slice(-40)}] เดิม="${b.was}" → ล้างเป็นว่าง`);
    } catch { /* */ }
    await loc.evaluate((el: any) => {
      el.scrollIntoView({ block: "center" });
      el.focus();
      el.click();
    });
    await page.waitForTimeout(100);
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Meta+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Delete");
    // บังคับ value ว่าง + แจ้ง Kendo ผ่าน event (กันค่าค้างใน widget)
    await loc.evaluate((el: any) => {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    });
  } catch {
    /* ช่องไม่มี/ล้างไม่ได้ — ข้าม */
  }
}

/**
 * เลือกวันที่จาก Kendo datepicker (รับ YYYY-MM-DD)
 * (kendo_pick_date ใน Python)
 */
export async function kendoPickDate(
  page: Page,
  datepickerSelector: string,
  isoDate: string,
): Promise<void> {
  if (!isoDate) return;
  const target = parseIsoDate(isoDate);
  await page.click(datepickerSelector);
  await page.waitForSelector("div.k-calendar:visible", { timeout: 10000 });

  const targetText = formatMonthYear(target); // e.g. "April 2026"

  for (let i = 0; i < 36; i++) {
    // safety cap (~3 yrs each direction)
    const header = page
      .locator(
        "div.k-calendar:visible a.k-nav-fast, " +
          "div.k-calendar:visible .k-header .k-link",
      )
      .first();
    const current = ((await header.innerText()) || "").trim();
    if (current.startsWith(targetText) || current.includes(targetText)) break;

    const curDt = parseMonthYear(current);
    if (curDt === null) break;
    if (target.getTime() < curDt.getTime()) {
      await page.click("div.k-calendar:visible a.k-nav-prev");
    } else {
      await page.click("div.k-calendar:visible a.k-nav-next");
    }
    await page.waitForTimeout(150);
  }

  const dayLink =
    `div.k-calendar:visible td:not(.k-other-month) a.k-link:text-is('${target.getDate()}')`;
  await page.click(dayLink);
}

// ---- date utilities (replace Python datetime/strftime) -------------

const MONTHS_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTHS_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function parseIsoDate(iso: string): Date {
  // YYYY-MM-DD → Date (local, midday to avoid TZ rollover)
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  return new Date(y, m - 1, d, 12, 0, 0);
}

function formatMonthYear(dt: Date): string {
  return `${MONTHS_FULL[dt.getMonth()]} ${dt.getFullYear()}`;
}

/** parse "April 2026" or "Apr 2026" → Date (day=1); null if unparseable */
function parseMonthYear(text: string): Date | null {
  const m = text.match(/([A-Za-z]+)\s+(\d{4})/);
  if (!m) return null;
  const name = m[1];
  const year = parseInt(m[2], 10);
  let idx = MONTHS_FULL.findIndex((x) => x.toLowerCase() === name.toLowerCase());
  if (idx === -1) {
    idx = MONTHS_ABBR.findIndex((x) => x.toLowerCase() === name.toLowerCase());
  }
  if (idx === -1) return null;
  return new Date(year, idx, 1, 12, 0, 0);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// alias เผื่อโค้ดเดิมเรียก (Python: _fill_kendo_numeric = _click_then_type)
export const fillKendoNumeric = clickThenType;

/**
 * Kendo DropDownList (data-role="dropdownlist") — input จริงถูกซ่อน, widget เป็น span.k-dropdown
 * เปิดด้วยการคลิก widget wrapper (span ที่ wrap input id เดิม) → เลือก item ที่ขึ้นต้นด้วยรหัส
 * @param inputId เช่น "#NatureTrans" (id ของ hidden input)
 * @param code เช่น "1" หรือ "01" (รหัสนำหน้า เช่น "1-ของแถม")
 */
export async function kendoDropdownListPick(
  page: Page,
  inputId: string,
  code: string,
): Promise<void> {
  const id = inputId.replace(/^#/, "");
  // widget wrapper ของ Kendo dropdownlist = span.k-dropdown ที่ wrap input#id
  //   หาได้จาก: span.k-dropdown:has(input#id) หรือ aria-owns=id_listbox
  const wrapper = page.locator(
    `span.k-dropdown:has(#${id}), span.k-dropdownlist:has(#${id}), #${id} ~ span.k-dropdown, span[aria-owns="${id}_listbox"]`,
  ).first();
  // เปิด dropdown
  try { await wrapper.click({ timeout: 4000 }); }
  catch {
    // fallback: คลิก k-input หรือ k-select ในแถวเดียวกัน
    await page.locator(`#${id}`).evaluate((el: any) => { const w = el.closest("span.k-dropdown") || el.nextElementSibling; w?.click?.(); }).catch(() => {});
  }
  await sleep(600);
  // รายการของ dropdownlist = ul#id_listbox > li
  const items = page.locator(`#${id}_listbox > li, ul.k-list:visible > li.k-item`);
  await items.first().waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  const codeNorm = code.trim().toUpperCase();
  const wb = new RegExp(`^${escapeRegExp(codeNorm)}\\b`);
  const n = await items.count();
  for (let i = 0; i < n; i++) {
    const t = ((await items.nth(i).innerText()) || "").trim().toUpperCase();
    if (t === codeNorm || wb.test(t)) { await items.nth(i).click(); await sleep(300); return; }
  }
  throw new Error(`dropdownlist ${inputId} ไม่พบรหัส '${code}' (มี ${n} items)`);
}

/** dump ตัวเลือกของ Kendo DropDownList (#NatureTrans ฯลฯ) ออกมาเป็น log */
export async function dumpDropdownListOptions(page: Page, inputId: string, label: string): Promise<void> {
  const id = inputId.replace(/^#/, "");
  try {
    const wrapper = page.locator(`span.k-dropdown:has(#${id}), span[aria-owns="${id}_listbox"]`).first();
    await wrapper.click({ timeout: 4000 }).catch(async () => {
      await page.locator(`#${id}`).evaluate((el: any) => { (el.closest("span.k-dropdown") || el.nextElementSibling)?.click?.(); }).catch(() => {});
    });
    await sleep(600);
    const items = page.locator(`#${id}_listbox > li`);
    const n = await items.count();
    log(`  📋 ${label} — มี ${n} ตัวเลือก:`);
    for (let i = 0; i < Math.min(n, 20); i++) {
      const t = ((await items.nth(i).innerText()) || "").replace(/\s+/g, " ").trim();
      log(`     • ${t}`);
    }
    // ปิด dropdown
    await page.keyboard.press("Escape").catch(() => {});
  } catch (e) {
    log(`  ⚠ dump ${label} ล้ม: ${e instanceof Error ? e.message : String(e)}`);
  }
}
