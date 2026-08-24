// ============================================================
//  Survey — สำรวจ "ทุกช่อง" ของหน้าสร้างใบขน DCTK อย่างละเอียด
//
//  ต่างจาก inspect.ts เดิมตรงไหน (inspect เดิมตกหล่นเยอะ):
//    1. เดิมกรอง visible ทิ้ง → input ตัวที่ "มี name" ของ Kendo numeric (ซ่อนอยู่) หายหมด
//       → ช่องเงิน/น้ำหนัก/ปริมาณ ทั้งหมดเลยไม่มีชื่อ อ้างอิงไม่ได้
//       ที่นี่: จับคู่ input ที่คนเห็น (display) กับ input ที่ส่งค่า (value) ในวิดเจ็ตเดียวกัน
//    2. เดิม selector เป็น class path 4 ชั้น → ซ้ำกันเพียบ ใช้จริงไม่ได้
//       ที่นี่: สร้าง selector แล้ว "ตรวจว่าชี้ได้ตัวเดียวจริง" ในหน้า (unique = true)
//    3. เดิมไม่เก็บตัวเลือกของ dropdown/combo → ไม่รู้ว่ากรอกอะไรได้บ้าง
//       ที่นี่: ดึงรายการจาก Kendo dataSource
//    4. เดิมไม่รู้ว่าช่องไหนบังคับ → ที่นี่อ่านจาก class *-required / data-val-required / label ที่มี *
//    5. เดิมไม่รู้บริบท → ที่นี่เก็บ แท็บ / กลุ่ม (fieldset legend) / แถวในตาราง / คอลัมน์
// ============================================================
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { log } from "./helpers.js";

export interface SurveyField {
  /** ลำดับที่เจอบนหน้า (บนลงล่าง ซ้ายไปขวา) */
  order: number;
  /** ชนิดตัวควบคุม */
  kind: "text" | "textarea" | "number" | "combo" | "dropdown" | "date" | "checkbox" | "radio" | "select" | "display";
  /** ป้ายชื่อช่องที่อ่านได้จากหน้าจอ */
  label: string;
  /** ป้ายของกลุ่ม/หัวข้อ (fieldset legend หรือหัวข้อตัวหนาเหนือกลุ่ม) */
  group: string;
  /** ชื่อแท็บที่ช่องนี้อยู่ */
  tab: string;
  /** ถ้าอยู่ในตาราง: ชื่อแถว + ชื่อคอลัมน์ (เช่น "ค่าระวาง" / "เงินต่างประเทศ") */
  rowLabel: string;
  colLabel: string;
  /** ชื่อที่ส่งไป server (จาก input ที่ถือค่าจริง) */
  name: string;
  id: string;
  /** selector ที่ใช้ "กรอก" (ช่องที่ผู้ใช้พิมพ์/คลิกได้) */
  selector: string;
  /** selector ชี้ได้ตัวเดียวจริงไหม */
  unique: boolean;
  /** selector ของ input ที่ถือค่าจริง (Kendo numeric/combo มี 2 ชั้น) */
  valueSelector: string;
  value: string;
  required: boolean;
  readonly: boolean;
  disabled: boolean;
  maxLength: number;
  visible: boolean;
  /** ตัวเลือกทั้งหมด (dropdown/combo/select) — เก็บไม่เกิน 200 ตัว */
  options: { value: string; text: string }[];
  optionCount: number;
  /** อยู่ในตาราง Kendo (ช่อง filter/แก้ในตาราง) — ไม่ใช่ช่องกรอกของฟอร์ม */
  inGrid: boolean;
  /** id ของตารางที่ครอบอยู่ (ถ้ามี) */
  gridId: string;
}

/**
 * โค้ดที่รันในเบราว์เซอร์ — ต้อง self-contained (อ้างฟังก์ชันข้างนอกไม่ได้)
 * คืนช่องทั้งหมดของแท็บที่กำลังเปิดอยู่
 */
function collectAll(tabName: string): SurveyField[] {
  const out: SurveyField[] = [];
  let order = 0;

  // ⚠ ต้องเจาะจงชนิดวิดเจ็ต "ช่องกรอก" เท่านั้น
  //   ห้ามใช้ ".k-widget" เฉย ๆ เพราะ Kendo ใส่ class นี้ให้ Grid/Window/TabStrip ด้วย
  //   → closest() จะไปโดนทั้งตาราง แล้ว input ในตารางถูกมาร์ค seen ทิ้งหมด (เคยพลาดมาแล้ว)
  const EDITOR_WIDGET = [
    ".k-combobox", ".k-dropdown", ".k-dropdownlist", ".k-numerictextbox",
    ".k-datepicker", ".k-datetimepicker", ".k-timepicker",
    ".k-autocomplete", ".k-maskedtextbox", ".k-multiselect",
  ].join(",");

  const txt = (el: Element | null | undefined): string =>
    (el?.textContent || "").replace(/\s+/g, " ").trim();

  const isVisible = (el: Element): boolean => {
    const r = (el as HTMLElement).getBoundingClientRect();
    const st = getComputedStyle(el as HTMLElement);
    return r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden";
  };

  /** selector ที่ชี้ได้ตัวเดียว: #id → [name] → path nth-child จาก ancestor ที่มี id */
  function uniqueSelector(el: Element): { sel: string; unique: boolean } {
    const id = (el as HTMLElement).id;
    if (id && document.querySelectorAll(`#${CSS.escape(id)}`).length === 1) {
      return { sel: `#${CSS.escape(id)}`, unique: true };
    }
    const name = el.getAttribute("name");
    if (name) {
      const s = `${el.tagName.toLowerCase()}[name="${name}"]`;
      if (document.querySelectorAll(s).length === 1) return { sel: s, unique: true };
    }
    // ไต่ขึ้นไปหา ancestor ที่มี id แล้วต่อ path nth-child ลงมา
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node.tagName !== "BODY") {
      const pid = (node as HTMLElement).id;
      if (pid && document.querySelectorAll(`#${CSS.escape(pid)}`).length === 1) {
        parts.unshift(`#${CSS.escape(pid)}`);
        break;
      }
      const parent: Element | null = node.parentElement;
      if (!parent) break;
      const idx = Array.from(parent.children).indexOf(node) + 1;
      parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${idx})`);
      node = parent;
    }
    const sel = parts.join(" > ");
    let unique = false;
    try { unique = !!sel && document.querySelectorAll(sel).length === 1; } catch { unique = false; }
    return { sel, unique };
  }

  /** ป้ายชื่อช่อง: label[for] → label ใน container → หัวคอลัมน์ตาราง → placeholder */
  function labelFor(el: Element): string {
    const id = (el as HTMLElement).id;
    if (id) {
      const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (l && txt(l)) return txt(l);
    }
    // ไต่ขึ้นทีละชั้น หา label/หัวข้อที่อยู่ "ก่อนหน้า" ช่องนี้ในแถวเดียวกัน
    let node: Element | null = el;
    for (let i = 0; i < 6 && node; i++) {
      let sib: Element | null = node.previousElementSibling;
      while (sib) {
        if (/^(LABEL|SPAN|DIV|TD|TH)$/.test(sib.tagName)) {
          const t = txt(sib);
          // ต้องเป็นข้อความสั้น ๆ แบบป้ายชื่อ ไม่ใช่ก้อนเนื้อหา
          if (t && t.length <= 60 && !sib.querySelector("input, select, textarea")) return t;
        }
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    const c = el.closest("div, td");
    const l2 = c?.querySelector("label");
    if (l2 && txt(l2)) return txt(l2);
    return (el.getAttribute("placeholder") || el.getAttribute("aria-label") || "").trim();
  }

  /** หัวข้อกลุ่ม: legend ของ fieldset หรือหัวข้อตัวหนาก่อนกลุ่ม */
  function groupFor(el: Element): string {
    const fs = el.closest("fieldset");
    if (fs) {
      const lg = fs.querySelector("legend");
      if (lg && txt(lg)) return txt(lg);
      // DCTK ใช้ div หัวข้อสีเทาแทน legend บ่อย ๆ
      const first = fs.firstElementChild;
      if (first && !first.querySelector("input, select, textarea")) {
        const t = txt(first);
        if (t && t.length <= 50) return t;
      }
    }
    return "";
  }

  /** ถ้าอยู่ในตาราง: ป้ายแถว (คอลัมน์แรก) + ป้ายคอลัมน์ (หัวตารางตำแหน่งเดียวกัน) */
  function tableCtx(el: Element): { rowLabel: string; colLabel: string } {
    const td = el.closest("td, th");
    const tr = el.closest("tr");
    if (!td || !tr) {
      // DCTK ตารางราคาใช้ div grid ไม่ใช่ <table> → ป้ายแถว = ข้อความ div แรกของแถว
      const row = el.closest(".form-group, .DecDtl, .row");
      if (row) {
        const firstDiv = row.firstElementChild;
        const t = txt(firstDiv);
        if (t && t.length <= 40 && !firstDiv?.querySelector("input, select")) {
          return { rowLabel: t, colLabel: "" };
        }
      }
      return { rowLabel: "", colLabel: "" };
    }
    const cells = Array.from(tr.children);
    const idx = cells.indexOf(td);
    const rowLabel = txt(cells[0]).slice(0, 40);
    let colLabel = "";
    const table = el.closest("table");
    const headRow = table?.querySelector("thead tr");
    if (headRow && idx >= 0) colLabel = txt(headRow.children[idx]).slice(0, 40);
    return { rowLabel, colLabel };
  }

  function isRequired(el: Element, widget: Element | null): boolean {
    const cls = (el.getAttribute("class") || "") + " " + (widget?.getAttribute("class") || "");
    if (/-required\b|\brequired\b/.test(cls)) return true;
    if (el.hasAttribute("data-val-required") || el.hasAttribute("required")) return true;
    // ป้ายชื่อลงท้ายด้วย * = บังคับ
    return /\*\s*$/.test(labelFor(el));
  }

  /** ตัวเลือกของ Kendo widget (ผ่าน jQuery data) หรือ <select> ธรรมดา */
  function optionsOf(el: Element, widget: Element | null): { value: string; text: string }[] {
    // <select> ปกติ
    if (el.tagName === "SELECT") {
      return Array.from((el as HTMLSelectElement).options)
        .slice(0, 200)
        .map((o) => ({ value: o.value, text: (o.textContent || "").trim() }));
    }
    // Kendo DropDownList มักครอบ <select> เดิมไว้ (ซ่อน) — ตัวเลือกอยู่ในนั้น
    if (widget) {
      const sel = widget.querySelector("select") as HTMLSelectElement | null;
      if (sel && sel.options.length) {
        return Array.from(sel.options).slice(0, 200)
          .map((o) => ({ value: o.value, text: (o.textContent || "").trim() }));
      }
    }
    try {
      const jq = (window as unknown as { jQuery?: (e: Element) => { data: (k: string) => unknown } }).jQuery;
      if (!jq || !widget) return [];
      for (const kind of ["kendoComboBox", "kendoDropDownList", "kendoAutoComplete", "kendoMultiSelect"]) {
        const w = jq(widget).data(kind) as
          | { dataSource?: { data: () => unknown[] }; options?: { dataValueField?: string; dataTextField?: string } }
          | undefined;
        if (!w?.dataSource) continue;
        const vf = w.options?.dataValueField || "";
        const tf = w.options?.dataTextField || "";
        const data = w.dataSource.data() || [];
        return data.slice(0, 200).map((d: unknown) => {
          const o = d as Record<string, unknown>;
          return {
            value: String((vf && o[vf] != null ? o[vf] : o.value ?? o.Value ?? d) ?? ""),
            text: String((tf && o[tf] != null ? o[tf] : o.text ?? o.Text ?? d) ?? ""),
          };
        });
      }
    } catch { /* ไม่มี kendo/jQuery ก็ข้าม */ }
    // สุดท้าย: popup list ที่ Kendo สร้างไว้ล่วงหน้า (#<id>-list)
    try {
      const wid = (widget?.querySelector("input") as HTMLElement | null)?.id
        || (el as HTMLElement).id;
      if (wid) {
        const list = document.querySelector(`#${CSS.escape(wid)}-list`);
        const items = list ? Array.from(list.querySelectorAll("li")) : [];
        if (items.length) {
          return items.slice(0, 200).map((li) => ({ value: "", text: txt(li) }));
        }
      }
    } catch { /* ข้าม */ }
    return [];
  }

  function kindOf(el: Element, widget: Element | null): SurveyField["kind"] {
    const wcls = widget?.getAttribute("class") || "";
    if (wcls.includes("k-combobox") || wcls.includes("k-autocomplete")) return "combo";
    if (wcls.includes("k-dropdown")) return "dropdown";
    if (wcls.includes("k-datepicker") || wcls.includes("k-datetimepicker")) return "date";
    if (wcls.includes("k-numerictextbox")) return "number";
    if (el.tagName === "SELECT") return "select";
    if (el.tagName === "TEXTAREA") return "textarea";
    const t = (el.getAttribute("type") || "text").toLowerCase();
    if (t === "checkbox") return "checkbox";
    if (t === "radio") return "radio";
    if (t === "number") return "number";
    return "text";
  }

  // ── เก็บทุก input/textarea/select รวม hidden ของ Kendo ─────────────────
  const seen = new Set<Element>();
  const controls = Array.from(document.querySelectorAll("input, textarea, select"));

  for (const el of controls) {
    if (seen.has(el)) continue;
    const type = (el.getAttribute("type") || "").toLowerCase();
    // ข้าม hidden ของ ASP.NET (__VIEWSTATE ฯลฯ) แต่ไม่ข้าม hidden ที่อยู่ในวิดเจ็ต Kendo
    const widget = el.closest(EDITOR_WIDGET) as Element | null;
    if (type === "hidden" && !widget) continue;
    if (type === "submit" || type === "button" || type === "image") continue;

    // ── จับคู่ 2 ชั้นของ Kendo: display input (คนพิมพ์) + value input (ส่งค่า) ──
    let display: Element = el;
    let valueEl: Element = el;
    if (widget) {
      const inputs = Array.from(widget.querySelectorAll("input, select"));
      // display = ตัวที่มองเห็น; value = ตัวที่มี name (มักซ่อน)
      const vis = inputs.find((i) => isVisible(i));
      const named = inputs.find((i) => i.getAttribute("name"));
      display = vis || el;
      valueEl = named || display;
      inputs.forEach((i) => seen.add(i));
    }
    seen.add(el);

    const grid = display.closest(".k-grid") as Element | null;
    const { sel, unique } = uniqueSelector(display);
    const vSel = valueEl === display ? sel : uniqueSelector(valueEl).sel;
    const ctx = tableCtx(display);
    const opts = optionsOf(valueEl, widget);

    out.push({
      order: order++,
      kind: kindOf(display, widget),
      label: labelFor(display),
      group: groupFor(display),
      tab: tabName,
      rowLabel: ctx.rowLabel,
      colLabel: ctx.colLabel,
      name: valueEl.getAttribute("name") || "",
      id: (display as HTMLElement).id || (valueEl as HTMLElement).id || "",
      selector: sel,
      unique,
      valueSelector: vSel,
      value: (valueEl as HTMLInputElement).value || "",
      required: isRequired(display, widget),
      readonly: (display as HTMLInputElement).readOnly === true || display.hasAttribute("readonly"),
      disabled: (display as HTMLInputElement).disabled === true || display.hasAttribute("disabled"),
      maxLength: Number((display as HTMLInputElement).maxLength ?? -1),
      visible: isVisible(display),
      options: opts,
      optionCount: opts.length,
      inGrid: !!grid,
      gridId: grid ? (grid as HTMLElement).id || "" : "",
    });
  }

  return out;
}

/** ชื่อแท็บทั้งหมดบนหน้า (Kendo TabStrip / ul.nav-tabs) */
export async function listTabs(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const els = Array.from(document.querySelectorAll(
      ".k-tabstrip-items > li, ul.nav-tabs > li, .k-tabstrip .k-item",
    ));
    return els
      .map((e) => (e.textContent || "").replace(/\s+/g, " ").trim())
      .filter((t) => t && t.length < 60);
  });
}

/** คลิกแท็บตามชื่อ (คืน true ถ้าคลิกได้) */
export async function clickTab(page: Page, name: string): Promise<boolean> {
  try {
    const ok = await page.evaluate((n: string) => {
      const els = Array.from(document.querySelectorAll(
        ".k-tabstrip-items > li, ul.nav-tabs > li, .k-tabstrip .k-item",
      ));
      const hit = els.find((e) => (e.textContent || "").replace(/\s+/g, " ").trim() === n);
      if (!hit) return false;
      const a = hit.querySelector("a") || hit;
      (a as HTMLElement).click();
      return true;
    }, name);
    return ok;
  } catch { return false; }
}

/** กดเปิดทุกส่วนที่พับไว้ (ปุ่ม ⊕ ของ DCTK: บริษัทรับขนส่ง, ผู้ขาย ฯลฯ) */
export async function expandAllSections(page: Page): Promise<number> {
  try {
    return await page.evaluate(() => {
      let n = 0;
      const toggles = Array.from(document.querySelectorAll(
        "a.glyphicon-plus, .glyphicon-plus, i.fa-plus-circle, .k-i-plus, [class*='expand']",
      ));
      for (const t of toggles) {
        const r = (t as HTMLElement).getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { (t as HTMLElement).click(); n++; }
      }
      return n;
    });
  } catch { return 0; }
}

/**
 * สำรวจหน้าหนึ่ง "ครบทุกแท็บ" → เขียน JSON + screenshot
 * @param label ชื่อไฟล์ เช่น "page1"
 */
export async function surveyPage(
  page: Page,
  label: string,
  outDir: string,
): Promise<SurveyField[]> {
  const dir = path.join(outDir, "survey");
  await mkdir(dir, { recursive: true });

  const all: SurveyField[] = [];
  const tabs = await listTabs(page);
  log(`  🔎 [${label}] แท็บที่เจอ: ${tabs.length ? tabs.join(" | ") : "(ไม่มีแท็บ)"}`);

  const visit = async (tabName: string) => {
    const expanded = await expandAllSections(page);
    if (expanded) { log(`     กางส่วนที่พับไว้ ${expanded} จุด`); await page.waitForTimeout(700); }
    const fields = await page.evaluate(collectAll, tabName);
    const vis = fields.filter((f) => f.visible);
    all.push(...fields);
    log(`     แท็บ "${tabName || "-"}": ${fields.length} ช่อง (เห็นบนจอ ${vis.length})`);
    try {
      await page.screenshot({
        path: path.join(dir, `${label}${tabName ? "_" + tabName.replace(/[^\wก-๙]+/g, "-").slice(0, 24) : ""}.png`),
        fullPage: true,
      });
    } catch { /* ignore */ }
  };

  if (!tabs.length) {
    await visit("");
  } else {
    for (const t of tabs) {
      const ok = await clickTab(page, t);
      if (!ok) { log(`     ⚠ คลิกแท็บ "${t}" ไม่ได้ — ข้าม`); continue; }
      await page.waitForTimeout(1500);
      await visit(t);
    }
    // กลับมาแท็บแรก (ให้ flow เดิมทำงานต่อได้)
    await clickTab(page, tabs[0]);
    await page.waitForTimeout(800);
  }

  // ตัดช่องซ้ำข้ามแท็บ (element เดียวกันโผล่ทุกแท็บเพราะอยู่นอก tabstrip)
  const uniq: SurveyField[] = [];
  const key = new Set<string>();
  for (const f of all) {
    const k = `${f.name}|${f.id}|${f.selector}`;
    if (key.has(k)) continue;
    key.add(k);
    uniq.push(f);
  }

  await writeFile(path.join(dir, `${label}.json`), JSON.stringify(uniq, null, 1), "utf-8");
  const form = uniq.filter((f) => !f.inGrid);
  const named = form.filter((f) => f.name || f.id).length;
  const withOpts = form.filter((f) => f.optionCount > 0).length;
  log(`  ✅ [${label}] ช่องฟอร์มจริง ${form.length} (อ้างชื่อได้ ${named} · เห็นบนจอ ${form.filter((f) => f.visible).length} · บังคับ ${form.filter((f) => f.required).length} · มีตัวเลือก ${withOpts}) + ช่องในตาราง ${uniq.length - form.length} → survey/${label}.json`);
  return uniq;
}
