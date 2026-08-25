// รอบ 2 — เจาะจอที่ผู้ใช้ต้องทำงานจริง: เลื่อนดูช่องกรอก, ตรวจตัวเลขสรุป, ดู flow สร้างใบ
import { chromium } from "playwright";
import path from "node:path";
import { mkdir } from "node:fs/promises";

const BASE = process.env.JOURNEY_URL ?? "http://localhost:8101";
const DIR = "/private/tmp/journey2";
await mkdir(DIR, { recursive: true });

const found = [];
const note = (sev, screen, what) => { found.push({ sev, screen, what }); console.log(`   ${sev === "bug" ? "🔴" : "🟡"} [${screen}] ${what}`); };

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
let n = 0;
const shot = async (name) => { n++; await page.screenshot({ path: path.join(DIR, `${String(n).padStart(2, "0")}-${name}.png`) }); };

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2500);

  // ═══ A. คลัง Master → แก้ไข → เลื่อนไปที่ช่องกรอก ═══
  console.log("\n═══ A. หน้าจอแก้ Master (ส่วนที่ผู้ใช้ทำงานจริง) ═══");
  await page.click('a[data-page="masters"]');
  await page.waitForTimeout(3000);

  // ตัวเลขสรุปในตาราง — ตรงกับความจริงไหม
  const summary = await page.locator("#mastersBody tr:not(.ms-group)").first().locator("td").nth(2).innerText().catch(() => "");
  console.log(`   ตัวเลขสรุปในตาราง: "${summary.replace(/\n/g, " ")}"`);
  const api = await page.evaluate(async () => {
    const r = await fetch("/api/templates").then((x) => x.json());
    const t = (r.templates || [])[0];
    if (!t) return null;
    const modes = t.field_modes || {};
    const header = t.header || {};
    // โหมดที่มีผลจริง: ตั้งไว้ชัดเจน หรือเดาจาก "มีค่า = ใช้ค่า Master"
    let master = 0, ai = 0, off = 0;
    const keys = new Set([...Object.keys(header), ...Object.keys(modes)]);
    for (const k of keys) {
      const m = modes[k] ?? (String(header[k] ?? "").trim() ? "master" : "ai");
      if (m === "master") master++; else if (m === "off") off++; else ai++;
    }
    return { name: t.name, master, ai, off, values: Object.keys(header).length };
  });
  if (api) {
    console.log(`   โหมดที่มีผลจริง: ทับ AI ${api.master} · จาก AI ${api.ai} · ไม่กรอก ${api.off}`);
    const m = summary.match(/ทับ\s*AI\s*(\d+)/);
    if (m && Number(m[1]) !== api.master) {
      note("bug", "คลัง Master", `ตัวเลขในตารางบอก "ทับ AI ${m[1]}" แต่จริง ๆ มี ${api.master} ช่องที่จะทับค่า AI — ตัวเลขนี้หลอกผู้ใช้`);
    }
  }

  await page.locator("#mastersBody tr:not(.ms-group)").first().locator("button:has-text('แก้ไข')").first().click();
  await page.waitForTimeout(2500);

  // ระยะที่ต้องเลื่อนกว่าจะถึงช่องแรก
  const geo = await page.evaluate(() => {
    const body = document.querySelector(".modal:not([style*='display: none']) .modal-body")
      || document.querySelector(".modal-box .modal-body");
    const firstRow = document.querySelector(".ms-row");
    if (!firstRow) return null;
    const tabs = document.querySelector(".md-tabs, .md-tab")?.getBoundingClientRect();
    return {
      scrollTop: body?.scrollTop ?? 0,
      firstRowTop: Math.round(firstRow.getBoundingClientRect().top),
      tabsTop: tabs ? Math.round(tabs.top) : -1,
      viewportH: window.innerHeight,
    };
  });
  if (geo) {
    console.log(`   แท็บอยู่ที่ y=${geo.tabsTop} · ช่องแรกอยู่ที่ y=${geo.firstRowTop} (จอสูง ${geo.viewportH})`);
    if (geo.firstRowTop > geo.viewportH - 100) {
      note("ux", "แก้ Master", `เปิดมาแล้วมองไม่เห็นช่องกรอกเลย (ช่องแรกอยู่ต่ำกว่าขอบจอ) ต้องเลื่อนก่อนทุกครั้ง`);
    }
  }

  // เลื่อนลงไปที่ช่องกรอกแล้วถ่ายภาพ
  await page.locator(".ms-row").first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await shot("master-fields");

  const rows = await page.evaluate(() => {
    return Array.from(document.querySelectorAll(".ms-row")).slice(0, 6).map((r) => {
      const fld = r.closest(".fld");
      const inp = r.querySelector("input.ms-edit");
      const sel = r.querySelector("select.ms-mode");
      return {
        label: (fld?.querySelector("label")?.textContent || "").trim().slice(0, 30),
        value: inp?.value?.slice(0, 24) ?? "",
        mode: sel?.selectedOptions?.[0]?.text ?? "",
        inpW: inp ? Math.round(inp.getBoundingClientRect().width) : 0,
      };
    });
  });
  console.log(`   ตัวอย่างแถวช่องกรอก:`);
  for (const r of rows) console.log(`      ${r.label.padEnd(30)} [${r.value.padEnd(24)}] ${r.mode}  (${r.inpW}px)`);

  // ═══ B. แท็บรายการสินค้า ═══
  console.log("\n═══ B. แท็บรายการสินค้าใน Master ═══");
  await page.locator('.md-tab:has-text("หน้า 3")').first().click();
  await page.waitForTimeout(1800);
  await shot("master-items");
  const itemInfo = await page.evaluate(() => {
    const body = document.querySelector("#msiBody");
    const cards = body ? body.querySelectorAll(".item-card").length : -1;
    const inputs = body ? body.querySelectorAll("input").length : 0;
    const hasMode = body ? body.querySelectorAll("select.ms-mode").length : 0;
    return { cards, inputs, hasMode };
  });
  console.log(`   การ์ดรายการ: ${itemInfo.cards} · ช่องกรอก: ${itemInfo.inputs} · ตัวเลือกโหมด: ${itemInfo.hasMode}`);
  if (itemInfo.cards > 0 && itemInfo.hasMode === 0) {
    note("bug", "แก้ Master", "รายการสินค้าไม่มีตัวเลือกโหมดรายช่อง — ตั้ง 'ใช้ค่า Master/จาก AI' ระดับรายการไม่ได้");
  }

  // ═══ C. flow สร้างใบจาก Master ═══
  console.log("\n═══ C. กด 'สร้างใบ' จาก Master ═══");
  await page.keyboard.press("Escape");   // ตอนนี้ควรปิดได้แล้ว
  await page.waitForTimeout(1200);
  const stillOpen = await page.evaluate(() => [...document.querySelectorAll(".modal")].filter((m) => m.style.display !== "none").length);
  if (stillOpen) note("ux", "ทั้งเว็บ", "กด Escape แล้วยังปิดหน้าต่างไม่ได้");
  else console.log("   ✓ กด Escape ปิดหน้าต่างได้แล้ว");
  await page.waitForTimeout(1200);
  await page.locator("#mastersBody tr:not(.ms-group)").first().locator("button:has-text('สร้างใบ')").first().click();
  await page.waitForTimeout(3000);
  await shot("create-from-master");
  const cr = await page.evaluate(() => {
    const modal = document.querySelector("#modalCreate");
    if (!modal) return null;
    const vis = (e) => e && e.getBoundingClientRect().width > 0;
    const sel = modal.querySelector("select");
    const tabs = Array.from(modal.querySelectorAll(".md-tab")).map((t) => t.textContent.trim());
    const filled = Array.from(modal.querySelectorAll("input.inp")).filter((i) => vis(i) && i.value.trim()).length;
    const total = Array.from(modal.querySelectorAll("input.inp")).filter(vis).length;
    return { masterSelText: sel?.selectedOptions?.[0]?.text ?? "(ว่าง)", tabs, filled, total };
  });
  if (cr) {
    console.log(`   ช่องเลือก Master แสดง: "${cr.masterSelText}"`);
    console.log(`   แท็บ: ${cr.tabs.join(" | ")}`);
    console.log(`   ช่องที่มีค่าแล้ว: ${cr.filled}/${cr.total} (ที่มองเห็นในแท็บปัจจุบัน)`);
    if (!cr.masterSelText || cr.masterSelText === "(ว่าง)" || !cr.masterSelText.trim()) {
      note("bug", "สร้างใบจาก Master", "กด 'สร้างใบ' จาก Master แล้ว ช่องเลือก Master ยังว่าง ผู้ใช้ไม่รู้ว่าใช้ตัวไหนอยู่");
    }
  }

  // ═══ D. ตรวจว่าปิดหน้าต่างแล้วข้อมูลค้างไหม ═══
  console.log("\n═══ D. ปิดแล้วเปิดใหม่ ข้อมูลค้างไหม ═══");
  await page.locator("#modalCreate .modal-x").first().click().catch(() => {});
  await page.waitForTimeout(1200);
  await page.locator("#mastersBody tr:not(.ms-group)").nth(1).locator("button:has-text('สร้างใบ')").first().click();
  await page.waitForTimeout(3000);
  const cr2 = await page.evaluate(() => {
    const modal = document.querySelector("#modalCreate");
    const sel = modal?.querySelector("select");
    return sel?.selectedOptions?.[0]?.text ?? "";
  });
  console.log(`   เปิด Master ตัวที่ 2 → ช่องเลือกแสดง: "${cr2.slice(0, 50)}"`);
  await shot("create-second");

  console.log(`\n╔═══════════════════════════════════╗`);
  console.log(`║  เจอ ${String(found.length).padStart(2)} รายการ                     ║`);
  console.log(`╚═══════════════════════════════════╝`);
  for (const f of found) console.log(`  ${f.sev === "bug" ? "🔴" : "🟡"} [${f.screen}] ${f.what}`);
  console.log(`\nภาพ: ${DIR}`);
} catch (e) {
  console.error(`✗ ${e.message}`);
  await shot("crash");
} finally { await browser.close(); }
