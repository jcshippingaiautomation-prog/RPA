// ============================================================
//  Rules — ถอด "เงื่อนไขของระบบ DCTK" ออกมาเป็นข้อมูล
//
//  เป้าหมาย: ระบบเราตรวจข้อมูลได้เหมือน DCTK ตั้งแต่ในเว็บเรา
//            ไม่ต้องรอไปพังตอน RPA กรอกจริง
//
//  ดึงจาก 3 แหล่ง (เรียงตามความน่าเชื่อถือ):
//    A. data-val-*        = validation ที่ ASP.NET ฝังมาจาก model ฝั่ง server
//                           (required / regex / range / length / remote) — กฎจริงของกรมฯ
//    B. Kendo widget      = cascadeFrom (ช่องนี้กรองตัวเลือกจากช่องไหน),
//                           enable/readonly, dataSource url (ปลายทางที่ใช้ค้นค่า)
//    C. ทดลองสลับค่าจริง  = เปลี่ยนค่าช่อง "ตัวขับ" แล้วดูว่าช่องไหน
//                           เปิด/ปิด/บังคับ/เปลี่ยนค่า ตามไปด้วย → ได้กฎ "ถ้า X แล้ว Y"
// ============================================================
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { log, sleep, kendoDropdownListPick, kendoDropdownPick } from "./helpers.js";

/** กฎ validation ของช่องหนึ่ง (จาก data-val-* + Kendo) */
export interface FieldRule {
  name: string;                    // ชื่อช่องใน DCTK
  required: boolean;
  requiredMessage: string;
  /** ชนิดข้อมูลที่บังคับ (number/date/…) */
  dataType: string;
  /** regex ที่ต้องผ่าน */
  regex: string;
  regexMessage: string;
  /** ช่วงค่าที่ยอมรับ */
  rangeMin: string;
  rangeMax: string;
  rangeMessage: string;
  maxLength: number;
  /** ต้องเท่ากับช่องอื่น */
  equalTo: string;
  /** ตรวจกับ server (endpoint + ช่องอื่นที่ส่งไปด้วย) */
  remoteUrl: string;
  remoteFields: string;
  /** Kendo: ตัวเลือกของช่องนี้ถูกกรองด้วยค่าของช่องไหน */
  cascadeFrom: string;
  /** Kendo: ปลายทางที่ใช้ดึงตัวเลือก */
  dataSourceUrl: string;
  /** สถานะตั้งต้นบนหน้าจอ */
  disabled: boolean;
  readonly: boolean;
  /** attribute ดิบทั้งหมดที่ขึ้นต้นด้วย data-val (เผื่อมีกฎที่ยังไม่ได้ถอด) */
  raw: { [k: string]: string };
}

/** สถานะช่องหนึ่ง ณ ขณะหนึ่ง (ใช้เทียบก่อน/หลังสลับค่า) */
export interface FieldState {
  disabled: boolean;
  readonly: boolean;
  required: boolean;
  visible: boolean;
  value: string;
  optionCount: number;
}

/** กฎ "ถ้าช่อง X = V แล้วช่อง Y เปลี่ยนไปอย่างไร" */
export interface DependencyRule {
  driver: string;                  // ช่องที่เปลี่ยน
  driverLabel: string;
  value: string;                   // ค่าที่ตั้ง
  valueLabel: string;
  effects: {
    field: string;
    change: string;                // "เปิดให้กรอก" | "ปิด" | "กลายเป็นบังคับ" | "เลิกบังคับ" | "ค่าเปลี่ยน" | "ตัวเลือกเปลี่ยน"
    from: string;
    to: string;
  }[];
}

// ── A + B: อ่านกฎแบบ static จาก DOM ────────────────────────────────────
function collectRules(): FieldRule[] {
  const out: FieldRule[] = [];
  const seen = new Set<string>();

  const jq = (window as unknown as { jQuery?: (e: Element) => { data: (k?: string) => unknown } }).jQuery;

  document.querySelectorAll("input, select, textarea").forEach((el) => {
    const name = el.getAttribute("name") || (el as HTMLElement).id;
    if (!name || seen.has(name)) return;
    seen.add(name);

    const attr = (k: string) => el.getAttribute(k) || "";
    const raw: { [k: string]: string } = {};
    for (const a of Array.from(el.attributes)) {
      if (a.name.startsWith("data-val")) raw[a.name] = a.value;
    }
    // ถ้าไม่มี data-val เลย และไม่ใช่ช่องที่ปิดอยู่ ก็ยังเก็บไว้ (จะได้รู้ว่าไม่มีกฎ)

    // ── Kendo: cascadeFrom + dataSource url
    let cascadeFrom = "";
    let dsUrl = "";
    try {
      const widget = el.closest(".k-widget");
      if (jq && widget) {
        for (const kind of ["kendoComboBox", "kendoDropDownList", "kendoAutoComplete"]) {
          const w = jq(widget).data(kind) as
            | { options?: { cascadeFrom?: string }; dataSource?: { options?: { transport?: { read?: { url?: string } | string } } } }
            | undefined;
          if (!w) continue;
          cascadeFrom = w.options?.cascadeFrom || cascadeFrom;
          const rd = w.dataSource?.options?.transport?.read;
          dsUrl = (typeof rd === "string" ? rd : rd?.url) || dsUrl;
          if (cascadeFrom || dsUrl) break;
        }
      }
    } catch { /* ไม่มี kendo ก็ข้าม */ }

    const cls = el.getAttribute("class") || "";
    out.push({
      name,
      required: attr("data-val-required") !== "" || el.hasAttribute("required") || /-required\b/.test(cls),
      requiredMessage: attr("data-val-required"),
      dataType: attr("data-val-number") ? "number" : attr("data-val-date") ? "date" : "",
      regex: attr("data-val-regex-pattern"),
      regexMessage: attr("data-val-regex"),
      rangeMin: attr("data-val-range-min"),
      rangeMax: attr("data-val-range-max"),
      rangeMessage: attr("data-val-range"),
      maxLength: Number((el as HTMLInputElement).maxLength ?? -1),
      equalTo: attr("data-val-equalto-other"),
      remoteUrl: attr("data-val-remote-url"),
      remoteFields: attr("data-val-remote-additionalfields"),
      cascadeFrom,
      dataSourceUrl: dsUrl,
      disabled: (el as HTMLInputElement).disabled === true,
      readonly: (el as HTMLInputElement).readOnly === true,
      raw,
    });
  });

  return out;
}

/** รายชื่อไฟล์ JS ที่หน้านี้โหลด (ไว้ไปอ่าน logic เพิ่ม) */
function collectScripts(): string[] {
  return Array.from(document.querySelectorAll("script[src]"))
    .map((s) => (s as HTMLScriptElement).src)
    .filter(Boolean);
}

// ── C: สถานะทุกช่อง (สำหรับเทียบก่อน/หลัง) ─────────────────────────────
function snapshot(): { [name: string]: FieldState } {
  const out: { [name: string]: FieldState } = {};
  document.querySelectorAll("input, select, textarea").forEach((el) => {
    const name = el.getAttribute("name") || (el as HTMLElement).id;
    if (!name || out[name]) return;
    const r = (el as HTMLElement).getBoundingClientRect();
    const st = getComputedStyle(el as HTMLElement);
    const cls = (el.getAttribute("class") || "") + " " + (el.closest(".k-widget")?.getAttribute("class") || "");
    out[name] = {
      disabled: (el as HTMLInputElement).disabled === true,
      readonly: (el as HTMLInputElement).readOnly === true,
      required: /-required\b/.test(cls) || el.hasAttribute("data-val-required"),
      visible: r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden",
      value: (el as HTMLInputElement).value ?? "",
      optionCount: el.tagName === "SELECT" ? (el as HTMLSelectElement).options.length : -1,
    };
  });
  return out;
}

/** ตั้งค่าช่องหนึ่งแล้วยิง event ให้ JS ของ DCTK ทำงาน (รองรับ Kendo) */
function drive(arg: { name: string; value: string; isCheckbox: boolean }): boolean {
  const { name, value, isCheckbox } = arg;
  const el = (document.querySelector(`[name="${name}"]`) || document.getElementById(name)) as HTMLInputElement | null;
  if (!el) return false;
  const jq = (window as unknown as { jQuery?: ((e: Element) => { data: (k: string) => unknown }) & { (s: string): unknown } }).jQuery;

  if (isCheckbox) {
    el.checked = value === "1";
    el.dispatchEvent(new Event("click", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  // Kendo DropDownList/ComboBox → ต้องสั่งผ่าน widget ไม่งั้น event ไม่ยิง
  try {
    const widget = el.closest(".k-widget");
    if (jq && widget) {
      for (const kind of ["kendoDropDownList", "kendoComboBox"]) {
        const w = jq(widget).data(kind) as { value?: (v: string) => void; trigger?: (e: string) => void } | undefined;
        if (w?.value) { w.value(value); w.trigger?.("change"); return true; }
      }
    }
  } catch { /* ตกไปใช้วิธีธรรมดา */ }
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

/** เทียบ 2 snapshot → รายการผลกระทบที่อ่านรู้เรื่อง */
function diffStates(
  before: { [k: string]: FieldState },
  after: { [k: string]: FieldState },
  ignore: string,
): DependencyRule["effects"] {
  const out: DependencyRule["effects"] = [];
  for (const [name, b] of Object.entries(before)) {
    if (name === ignore) continue;
    const a = after[name];
    if (!a) continue;
    const push = (change: string, from: unknown, to: unknown) =>
      out.push({ field: name, change, from: String(from), to: String(to) });

    if (b.disabled !== a.disabled) push(a.disabled ? "ถูกปิด (กรอกไม่ได้)" : "เปิดให้กรอกได้", b.disabled, a.disabled);
    if (b.readonly !== a.readonly) push(a.readonly ? "กลายเป็นอ่านอย่างเดียว" : "แก้ไขได้", b.readonly, a.readonly);
    if (b.required !== a.required) push(a.required ? "กลายเป็นช่องบังคับ" : "เลิกบังคับ", b.required, a.required);
    if (b.visible !== a.visible) push(a.visible ? "แสดงขึ้นมา" : "ถูกซ่อน", b.visible, a.visible);
    if (b.value !== a.value) push("ค่าถูกเปลี่ยนให้อัตโนมัติ", b.value.slice(0, 30), a.value.slice(0, 30));
    if (b.optionCount !== a.optionCount && b.optionCount >= 0) push("ตัวเลือกเปลี่ยนจำนวน", b.optionCount, a.optionCount);
  }
  return out;
}

export interface RulesResult {
  rules: FieldRule[];
  dependencies: DependencyRule[];
  scripts: string[];
}

/**
 * ถอดกฎของหน้าหนึ่ง
 * @param drivers ช่องที่จะทดลองสลับค่า — [{name, values:[...], label}]
 */
export async function extractRules(
  page: Page,
  label: string,
  outDir: string,
  drivers: { name: string; label: string; values: { value: string; label: string }[]; isCheckbox?: boolean }[],
): Promise<RulesResult> {
  const dir = path.join(outDir, "rules");
  await mkdir(dir, { recursive: true });

  // ── A + B ──
  const rules = await page.evaluate(collectRules);
  const scripts = await page.evaluate(collectScripts);
  const withVal = rules.filter((r) => Object.keys(r.raw).length > 0);
  const cascades = rules.filter((r) => r.cascadeFrom);
  log(`  📐 [${label}] กฎ static: ${rules.length} ช่อง · มี data-val ${withVal.length} · บังคับ ${rules.filter((r) => r.required).length} · cascade ${cascades.length}`);
  for (const c of cascades) log(`     ↳ ${c.name} กรองตัวเลือกจาก → ${c.cascadeFrom}`);

  // ── C: ทดลองสลับค่า ──
  //   ⚠ Kendo DropDownList ตั้งค่าด้วย el.value ไม่ได้ — ต้อง "คลิกเลือกจริง"
  //     ไม่งั้น handler ของ DCTK ไม่ทำงาน เลยไม่เห็นผลกระทบอะไรเลย
  const dependencies: DependencyRule[] = [];
  for (const d of drivers) {
    const sel = `#${d.name}`;
    const exists = await page.locator(`[name="${d.name}"], ${sel}`).count().catch(() => 0);
    if (!exists) continue;
    const before = await page.evaluate(snapshot);
    const original = before[d.name]?.value ?? "";

    for (const v of d.values) {
      let applied = false;
      try {
        if (d.isCheckbox) {
          const want = v.value === "1";
          const cur = await page.locator(sel).first().isChecked().catch(() => false);
          if (cur !== want) { await page.locator(sel).first().click({ timeout: 8000 }); }
          applied = true;
        } else {
          // ลอง DropDownList ก่อน (ช่องส่วนใหญ่ของ DCTK) → ไม่ได้ค่อยลองแบบ dropdown ธรรมดา
          try { await kendoDropdownListPick(page, sel, v.value); applied = true; }
          catch { await kendoDropdownPick(page, sel, v.value); applied = true; }
        }
      } catch { applied = false; }
      if (!applied) { log(`     ⚠ สลับ ${d.label} = "${v.label}" ไม่สำเร็จ — ข้าม`); continue; }

      await sleep(1000);                       // ให้ JS ของ DCTK ทำงาน
      const after = await page.evaluate(snapshot);
      const effects = diffStates(before, after, d.name);
      if (effects.length) {
        dependencies.push({
          driver: d.name, driverLabel: d.label,
          value: v.value, valueLabel: v.label, effects,
        });
        log(`     🔗 ${d.label} = "${v.label}" → กระทบ ${effects.length} ช่อง`);
      }
    }

    // คืนค่าเดิม (กันผลสะสมข้ามช่อง)
    try {
      if (d.isCheckbox) {
        const wantOrig = before[d.name]?.value === "1" || before[d.name]?.value === "true";
        const cur = await page.locator(sel).first().isChecked().catch(() => false);
        if (cur !== wantOrig) await page.locator(sel).first().click({ timeout: 5000 });
      } else if (original) {
        await kendoDropdownListPick(page, sel, original).catch(() => { /* */ });
      }
    } catch { /* คืนค่าไม่ได้ก็ไม่เป็นไร ไม่ได้ Save อยู่แล้ว */ }
    await sleep(500);
  }

  await writeFile(path.join(dir, `${label}.json`),
    JSON.stringify({ rules, dependencies, scripts }, null, 1), "utf-8");
  log(`  ✅ [${label}] เขียน rules/${label}.json — กฎ ${rules.length} · ความสัมพันธ์ ${dependencies.length}`);
  return { rules, dependencies, scripts };
}
