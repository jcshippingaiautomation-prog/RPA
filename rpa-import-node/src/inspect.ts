// ============================================================
//  Inspect mode — dump ทุก element ที่กรอกได้บนหน้า (สำหรับ map ช่อง)
//  เขียน screenshot + JSON (label, id, type, selector, value) ต่อหน้า
// ============================================================
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { log } from "./helpers.js";

export interface ElementInfo {
  tag: string;
  type: string;        // input type / "select" / "combobox(kendo)" / "checkbox" / "button"
  label: string;       // label/placeholder/aria-label ที่เดาได้
  id: string;
  name: string;
  selector: string;    // selector ที่ใช้เจาะถึง element นี้
  value: string;
  visible: boolean;
}

/**
 * dump element ทั้งหมดบนหน้า (รันใน browser context ผ่าน page.evaluate)
 * - input (text/number/...), textarea, select, checkbox/radio
 * - Kendo combobox/dropdown (span.k-widget ... > input)
 * - button (เพื่อรู้ว่ามีปุ่มอะไรกดได้)
 */
async function collectElements(page: Page): Promise<ElementInfo[]> {
  return page.evaluate(() => {
    const out: ElementInfo[] = [];

    // หา label ที่ใกล้ที่สุด: <label for=id>, label หุ้ม, ข้อความ sibling ก่อนหน้า, placeholder, aria-label
    function findLabel(el: Element): string {
      const id = (el as HTMLElement).id;
      if (id) {
        const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lab && lab.textContent) return lab.textContent.trim();
      }
      // label หุ้ม
      let p: Element | null = el;
      for (let i = 0; i < 4 && p; i++) {
        if (p.tagName === "LABEL" && p.textContent) return p.textContent.trim();
        p = p.parentElement;
      }
      // หา label/ข้อความใน container ใกล้ ๆ
      let c: Element | null = el.parentElement;
      for (let i = 0; i < 4 && c; i++) {
        const lab = c.querySelector("label");
        if (lab && lab.textContent && lab.textContent.trim()) return lab.textContent.trim();
        c = c.parentElement;
      }
      const aria = el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
      return aria.trim();
    }

    // สร้าง selector แบบสั้น (id > name > nth path)
    function selectorFor(el: Element): string {
      const id = (el as HTMLElement).id;
      if (id) return `#${id}`;
      const name = el.getAttribute("name");
      if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
      // path สั้น ๆ
      const parts: string[] = [];
      let node: Element | null = el;
      for (let i = 0; i < 4 && node && node.tagName !== "BODY"; i++) {
        let part = node.tagName.toLowerCase();
        const cls = (node.getAttribute("class") || "").split(/\s+/).filter(Boolean).slice(0, 2);
        if (cls.length) part += "." + cls.join(".");
        parts.unshift(part);
        node = node.parentElement;
      }
      return parts.join(" > ");
    }

    function isVisible(el: Element): boolean {
      const r = (el as HTMLElement).getBoundingClientRect();
      const st = getComputedStyle(el as HTMLElement);
      return r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden";
    }

    function push(el: Element, type: string) {
      out.push({
        tag: el.tagName.toLowerCase(),
        type,
        label: findLabel(el),
        id: (el as HTMLElement).id || "",
        name: el.getAttribute("name") || "",
        selector: selectorFor(el),
        value: (el as HTMLInputElement).value || "",
        visible: isVisible(el),
      });
    }

    // 1) input / textarea / select มาตรฐาน
    document.querySelectorAll("input, textarea, select").forEach((el) => {
      const t = el.tagName === "SELECT" ? "select" : (el.getAttribute("type") || "text");
      // ข้าม hidden ที่ไม่เกี่ยว
      if (t === "hidden") return;
      push(el, t);
    });

    // 2) Kendo combobox/dropdown — เก็บ container ที่มี input ข้างใน (อาจซ้ำกับข้อ 1 แต่ติด class kendo)
    document.querySelectorAll("span.k-widget").forEach((w) => {
      const cls = w.getAttribute("class") || "";
      const kind = cls.includes("k-combobox") ? "combobox(kendo)"
        : cls.includes("k-dropdown") ? "dropdown(kendo)"
        : cls.includes("k-datepicker") ? "datepicker(kendo)"
        : cls.includes("k-numerictextbox") ? "numeric(kendo)"
        : "";
      if (!kind) return;
      const inner = w.querySelector("input");
      if (inner) {
        out.push({
          tag: "span.k-widget",
          type: kind,
          label: findLabel(w),
          id: (inner as HTMLElement).id || "",
          name: inner.getAttribute("name") || "",
          selector: selectorFor(inner),
          value: (inner as HTMLInputElement).value || "",
          visible: isVisible(w),
        });
      }
    });

    // 3) ปุ่ม (button / a ที่ทำหน้าที่ปุ่ม)
    document.querySelectorAll("button, a.k-button, [role='button']").forEach((el) => {
      const txt = (el.textContent || "").trim().slice(0, 40);
      out.push({
        tag: el.tagName.toLowerCase(),
        type: "button",
        label: txt,
        id: (el as HTMLElement).id || "",
        name: "",
        selector: selectorFor(el),
        value: "",
        visible: isVisible(el),
      });
    });

    return out;
  });
}

/**
 * เจาะตารางราคา Page 3 — map แต่ละแถว (ราคา/หน่วย, ค่าระวาง...) →
 * ช่องสกุลเงิน (_X_input) + ช่องตัวเลข (เงินตปท) ในแถวเดียวกัน พร้อม selector ที่ robust
 * พิมพ์ผลเป็น log + คืน mapping
 */
export async function dumpPriceTable(page: Page): Promise<Record<string, { currencySel: string; foreignSel: string }>> {
  try {
    const map = await page.evaluate(() => {
      const result: Record<string, { currencySel: string; foreignSel: string; label: string }> = {};
      // ช่องสกุลเงินมี name = _UnitPrice_input, _Amount_input, _Forward_input, _Freight_input, _Insurance_input, _Pack_input...
      const currencyNames = ["_UnitPrice", "_Amount", "_Forward", "_Freight", "_Insurance", "_Pack", "_Inland", "_Landing"];
      for (const base of currencyNames) {
        const cur = document.querySelector(`input[name="${base}_input"]`) as HTMLElement | null;
        if (!cur) continue;
        // หา row container (เดินขึ้นไปหา .form-group / fieldset > div ที่ใกล้สุด)
        let row: HTMLElement | null = cur;
        for (let i = 0; i < 6 && row; i++) {
          if (row.classList.contains("form-group") || row.classList.contains("DecDtl")) break;
          row = row.parentElement;
        }
        if (!row) row = cur.closest("div") as HTMLElement;
        // ช่องตัวเลข "เงินต่างประเทศ" = .k-formatted-value ใน .termForeign ของแถวนี้
        const foreign = row?.querySelector(".termForeign input.k-formatted-value, .termForeign input.right-numeric") as HTMLElement | null;
        // label ของแถว
        let label = "";
        const lab = row?.querySelector("label, .control-label");
        if (lab) label = (lab.textContent || "").trim();
        // สร้าง selector: currency = name; foreign = ใช้ relative จาก currency (เดินผ่าน row)
        result[base] = {
          label,
          currencySel: `input[name="${base}_input"]`,
          // foreign selector: ระบุผ่าน :has() ไม่ชัวร์ทุก browser → คืน path สั้น
          foreignSel: foreign ? "(พบ .termForeign numeric ในแถว)" : "(ไม่พบช่องตัวเลขในแถว)",
        };
      }
      return result;
    });
    log("  📊 ตารางราคา Page 3 (แถว → สกุลเงิน/ตัวเลข):");
    for (const [k, v] of Object.entries(map)) {
      log(`     ${k.padEnd(12)} | label='${v.label}' | currency=${v.currencySel} | foreign=${v.foreignSel}`);
    }
    return map as Record<string, { currencySel: string; foreignSel: string }>;
  } catch (e) {
    log(`  ⚠ dumpPriceTable error: ${e}`);
    return {};
  }
}

/**
 * dump element ของหน้า → screenshot + JSON ใน <dir>/inspect/
 * @param pageLabel เช่น "page1", "page2", "page3", "finalize"
 */
/**
 * dump คอลัมน์ของ Kendo grid (data-field + title + index ของ filter cell)
 * ช่วย map ว่าช่อง filter "เลขที่ใบขน" คือคอลัมน์ที่เท่าไหร่
 */
export async function dumpGridColumns(page: Page, outDir: string): Promise<void> {
  const dir = path.join(outDir, "inspect");
  await mkdir(dir, { recursive: true });
  try {
    const cols = await page.evaluate(() => {
      const out: { index: number; field: string; title: string; filterSelector: string }[] = [];
      // หา header row ของ grid (th มี data-field / data-title)
      const ths = Array.from(document.querySelectorAll("th[data-field], th[data-title], .k-grid-header th"));
      ths.forEach((th, i) => {
        const el = th as HTMLElement;
        out.push({
          index: i,
          field: el.getAttribute("data-field") || "",
          title: (el.getAttribute("data-title") || el.innerText || "").trim().slice(0, 40),
          // filter input ของคอลัมน์นี้ (ถ้ามี filter row): th ลำดับเดียวกันใน filter row
          filterSelector: `.k-filter-row th:nth-child(${i + 1}) input, tr.k-filter-row > th:nth-child(${i + 1}) input`,
        });
      });
      return out;
    });
    const jsonPath = path.join(dir, "grid-columns.json");
    await writeFile(jsonPath, JSON.stringify(cols, null, 2), "utf-8");
    log(`  🔍 grid columns: ${cols.length} คอลัมน์ → grid-columns.json`);
    for (const c of cols) {
      if (c.field || c.title) log(`     [${c.index}] field="${c.field}" title="${c.title}"`);
    }

    // dump filter inputs จริง (พร้อม data-field ของ th แม่ + selector ที่ใช้ได้จริง)
    const filters = await page.evaluate(() => {
      const out: { field: string; ariaLabel: string; selector: string }[] = [];
      const inputs = Array.from(document.querySelectorAll("tr.k-filter-row input, .k-filtercell input"));
      inputs.forEach((inp) => {
        const el = inp as HTMLInputElement;
        const th = el.closest("th");
        const field = th?.getAttribute("data-field") || el.getAttribute("data-bind")?.match(/value:\s*(\w+)/)?.[1] || "";
        // Kendo มักตั้ง title/aria-label ที่ input ตามคอลัมน์
        out.push({
          field,
          ariaLabel: el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("name") || "",
          selector: field ? `th[data-field="${field}"] input.k-textbox, th[data-field="${field}"] input` : "",
        });
      });
      return out.filter((f) => f.field || f.ariaLabel);
    });
    const fPath = path.join(dir, "grid-filters.json");
    await writeFile(fPath, JSON.stringify(filters, null, 2), "utf-8");
    log(`  🔍 grid filters: ${filters.length} ช่อง → grid-filters.json`);
    for (const f of filters) log(`     field="${f.field}" aria="${f.ariaLabel}" sel=${f.selector}`);
  } catch (e) {
    log(`  ⚠ dumpGridColumns error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function dumpPage(
  page: Page,
  pageLabel: string,
  outDir: string,
): Promise<ElementInfo[]> {
  const dir = path.join(outDir, "inspect");
  await mkdir(dir, { recursive: true });

  // screenshot
  const shot = path.join(dir, `${pageLabel}.png`);
  try {
    await page.screenshot({ path: shot, fullPage: true });
  } catch { /* ignore */ }

  // เก็บ element ของทุก frame (main + iframe)
  const all: ElementInfo[] = [];
  try {
    all.push(...(await collectElements(page)));
  } catch (e) {
    log(`  ⚠ collect main frame error: ${e}`);
  }
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      const els = await frame.evaluate(collectElementsInFrame);
      all.push(...els.map((e) => ({ ...e, selector: `[iframe] ${e.selector}` })));
    } catch { /* ข้าม frame ที่อ่านไม่ได้ */ }
  }

  // กรองเฉพาะที่ visible + เขียน JSON
  const visible = all.filter((e) => e.visible);
  const jsonPath = path.join(dir, `${pageLabel}.json`);
  await writeFile(jsonPath, JSON.stringify(visible, null, 2), "utf-8");

  log(`  🔍 inspect [${pageLabel}]: ${visible.length} element (visible) → ${path.basename(jsonPath)}`);
  // log สรุปย่อ (label : type : selector)
  for (const e of visible) {
    if (e.type === "button") continue; // ปุ่มแยกดูใน json
    const lab = (e.label || "(no label)").slice(0, 30).padEnd(30);
    log(`     ${lab} | ${e.type.padEnd(16)} | ${e.selector.slice(0, 50)}`);
  }
  return visible;
}

// duplicate collector สำหรับ frame.evaluate (ต้อง self-contained — เรียก collectElements ข้าม context ไม่ได้)
function collectElementsInFrame(): ElementInfo[] {
  // re-declared minimal version (frame context)
  const out: ElementInfo[] = [];
  function selectorFor(el: Element): string {
    const id = (el as HTMLElement).id;
    if (id) return `#${id}`;
    const name = el.getAttribute("name");
    if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
    return el.tagName.toLowerCase();
  }
  function isVisible(el: Element): boolean {
    const r = (el as HTMLElement).getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  document.querySelectorAll("input, textarea, select").forEach((el) => {
    const t = el.tagName === "SELECT" ? "select" : (el.getAttribute("type") || "text");
    if (t === "hidden") return;
    out.push({
      tag: el.tagName.toLowerCase(), type: t,
      label: el.getAttribute("aria-label") || el.getAttribute("placeholder") || "",
      id: (el as HTMLElement).id || "", name: el.getAttribute("name") || "",
      selector: selectorFor(el), value: (el as HTMLInputElement).value || "",
      visible: isVisible(el),
    });
  });
  return out;
}
