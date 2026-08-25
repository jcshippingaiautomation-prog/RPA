// ============================================================
//  ทดสอบแบบ "ผู้ใช้จริง" — ขับเบราว์เซอร์ไล่ทุกจอ ถ่ายภาพทุกขั้น
//
//  ต่างจากการตรวจโค้ด: อันนี้เห็นสิ่งที่ผู้ใช้เห็นจริง ๆ
//  ทั้งของที่วางผิดที่ ปุ่มที่กดไม่ได้ ข้อความที่อ่านไม่รู้เรื่อง
//
//  รัน:  node journey-test.mjs          (ไม่อัปโหลดไฟล์ — ไม่เสียค่า AI)
//        JOURNEY_UPLOAD=1 node journey-test.mjs   (อัปโหลดจริง เรียก AI)
// ============================================================
import { chromium } from "playwright";
import path from "node:path";
import { mkdir } from "node:fs/promises";

const BASE = process.env.JOURNEY_URL ?? "http://localhost:8100";
const DO_UPLOAD = process.env.JOURNEY_UPLOAD === "1";
const SHOT_DIR = "/private/tmp/journey";
await mkdir(SHOT_DIR, { recursive: true });

const findings = [];
const note = (severity, screen, what) => {
  findings.push({ severity, screen, what });
  console.log(`   ${severity === "bug" ? "🔴" : severity === "ux" ? "🟡" : "ℹ"} [${screen}] ${what}`);
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const jsErrors = [];
page.on("pageerror", (e) => jsErrors.push(String(e).slice(0, 160)));
page.on("console", (m) => { if (m.type() === "error") jsErrors.push("console: " + m.text().slice(0, 160)); });

let step = 0;
const shot = async (name) => {
  step++;
  const f = path.join(SHOT_DIR, `${String(step).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: f, fullPage: false });
  return f;
};

try {
  // ═══ 1. เข้าหน้าแรก ═══
  console.log("\n═══ 1. เปิดเว็บครั้งแรก ═══");
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);
  await shot("home");

  const title = await page.locator("h1").first().innerText().catch(() => "");
  console.log(`   หัวข้อหน้า: "${title}"`);

  // สถิติบนหัว
  const stats = await page.locator(".stat-card").allInnerTexts().catch(() => []);
  console.log(`   การ์ดสถิติ: ${stats.map((s) => s.replace(/\n/g, " ")).join(" | ") || "(ไม่มี)"}`);

  // ตารางว่างหรือไม่ — ตอนนี้เราล้างข้อมูลไปแล้ว ควรมี empty state ที่บอกว่าต้องทำอะไรต่อ
  const rowCount = await page.locator("#declBody tr, table tbody tr").count().catch(() => 0);
  const emptyText = await page.locator(".empty").first().innerText().catch(() => "");
  console.log(`   แถวในตาราง: ${rowCount} · ข้อความตอนว่าง: "${emptyText.replace(/\n/g, " ").slice(0, 80)}"`);
  if (rowCount === 0 && !emptyText) {
    note("ux", "รายการใบขน", "ตารางว่างแต่ไม่มีข้อความบอกผู้ใช้ว่าต้องทำอะไรต่อ");
  }
  if (rowCount === 0 && emptyText && !/อัปโหลด|เพิ่ม|เริ่ม/.test(emptyText)) {
    note("ux", "รายการใบขน", `ข้อความตอนว่างไม่ได้ชี้ทางต่อ: "${emptyText.slice(0, 60)}"`);
  }

  // ═══ 2. เปิด modal อัปโหลด ═══
  console.log("\n═══ 2. กดปุ่มอัปโหลดไฟล์ ═══");
  await page.click("#btnUpload");
  await page.waitForTimeout(1500);
  await shot("upload-modal");

  const custOpts = await page.locator("#upCustomer option").allInnerTexts();
  console.log(`   ตัวเลือกลูกค้า (${custOpts.length}): ${custOpts.join(" · ")}`);

  const tplSel = page.locator("#upTemplate");
  const tplExists = await tplSel.count();
  if (!tplExists) note("bug", "อัปโหลด", "ไม่มีช่องเลือก Master");
  else {
    const before = await tplSel.locator("option").allInnerTexts();
    const disabledBefore = await tplSel.isDisabled();
    console.log(`   Master ก่อนเลือกลูกค้า: ${before.length} ตัวเลือก · disabled=${disabledBefore}`);

    // เลือกลูกค้า THANAKORN แล้วดูว่ารายการ Master กรองให้ไหม
    await page.selectOption("#upCustomer", { label: "THANAKORN" }).catch(() => {});
    await page.waitForTimeout(1500);
    const after = await tplSel.locator("option").allInnerTexts();
    console.log(`   Master หลังเลือก THANAKORN: ${after.length} ตัวเลือก`);
    await shot("upload-master-list");
    if (after.length <= 1) note("bug", "อัปโหลด", "เลือกลูกค้าแล้วรายการ Master ไม่ขึ้น");
    else {
      const names = after.slice(1, 4).map((n) => n.slice(0, 46));
      console.log(`      ตัวอย่าง: ${names.join(" / ")}`);
      const tooLong = after.filter((n) => n.length > 55).length;
      if (tooLong > 0) note("ux", "อัปโหลด", `ชื่อ Master ยาวเกิน (${tooLong} อัน >55 ตัวอักษร) อ่านยากใน dropdown`);
    }
    // ปุ่มถัดไปกดได้ทั้งที่ยังไม่เลือกไฟล์?
    const submitDisabled = await page.locator("#upSubmit").isDisabled();
    if (!submitDisabled) {
      await page.click("#upSubmit");
      await page.waitForTimeout(1200);
      const err = await page.locator("#upErr").innerText().catch(() => "");
      const stillStep1 = await page.locator("#upStep1").isVisible();
      console.log(`   กด "ถัดไป" ทั้งที่ยังไม่เลือกไฟล์ → ข้อความ: "${err.slice(0, 60)}" · ยังอยู่ขั้น 1: ${stillStep1}`);
      if (!err && !stillStep1) note("bug", "อัปโหลด", "กดถัดไปได้ทั้งที่ยังไม่เลือกไฟล์ และไม่มีข้อความเตือน");
      await shot("upload-no-file");
    }
  }

  // ═══ 3. ปิด modal → ไปคลัง Master ═══
  console.log("\n═══ 3. เข้าหน้าคลัง Master ═══");
  await page.click("#upClose").catch(() => {});
  await page.waitForTimeout(800);
  await page.click('a[data-page="masters"]');
  await page.waitForTimeout(3000);
  await shot("masters-list");

  const mRows = await page.locator("#mastersBody tr").count().catch(() => 0);
  console.log(`   Master ในรายการ: ${mRows}`);
  const mNote = await page.locator("#mastersNote").innerText().catch(() => "");
  if (mNote.trim()) console.log(`   ข้อความเตือน: "${mNote.slice(0, 80)}"`);
  if (mRows === 0) note("bug", "คลัง Master", "ไม่มี Master แสดง ทั้งที่ในฐานข้อมูลมี 11 อัน");

  // เปิด Master อันแรก
  if (mRows > 0) {
    console.log("\n═══ 4. เปิดแก้ Master ═══");
    // ★ ปุ่มแรกของแถวคือ "สร้างใบ" ไม่ใช่ "แก้ไข" — ต้องเจาะจงด้วยข้อความ
    const editBtn = page.locator("#mastersBody tr").first().locator("button:has-text('แก้ไข')").first();
    if (!(await editBtn.count())) { note("bug", "คลัง Master", "ไม่มีปุ่มแก้ไขในแถว"); }
    await editBtn.click();
    await page.waitForTimeout(2500);
    await shot("master-edit");

    // แท็บมีกี่หน้า
    const tabs = await page.locator(".md-tab").allInnerTexts().catch(() => []);
    console.log(`   แท็บ: ${tabs.join(" | ")}`);
    if (tabs.length < 4) note("bug", "แก้ Master", `แท็บมีแค่ ${tabs.length} หน้า ควรมี 4`);

    // ★ จุดที่ user เจอบั๊ก: ช่องกรอกค่าต้องกว้างพอ ไม่โดน dropdown โหมดกิน
    const sizes = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll(".ms-row")).slice(0, 40);
      return rows.map((r) => {
        const inp = r.querySelector("input.ms-edit");
        const sel = r.querySelector("select.ms-mode");
        return {
          inp: inp ? Math.round(inp.getBoundingClientRect().width) : -1,
          sel: sel ? Math.round(sel.getBoundingClientRect().width) : -1,
        };
      }).filter((x) => x.inp >= 0);
    });
    if (!sizes.length) note("bug", "แก้ Master", "ไม่พบแถวช่องกรอก (.ms-row) เลย");
    else {
      const narrow = sizes.filter((s) => s.inp < 100).length;
      const avgInp = Math.round(sizes.reduce((a, s) => a + s.inp, 0) / sizes.length);
      const avgSel = Math.round(sizes.reduce((a, s) => a + s.sel, 0) / sizes.length);
      console.log(`   ความกว้างเฉลี่ย: ช่องกรอก ${avgInp}px · ตัวเลือกโหมด ${avgSel}px (จาก ${sizes.length} แถว)`);
      if (narrow) note("bug", "แก้ Master", `ช่องกรอกแคบกว่า 100px อยู่ ${narrow}/${sizes.length} แถว — กรอกค่าไม่ได้`);
    }

    // กลุ่มที่ยุบ/กาง + ตัวนับ
    const groups = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("details.reg-group")).map((d) => ({
        title: (d.querySelector(".reg-group-title")?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 44),
        open: d.hasAttribute("open"),
      }));
    });
    console.log(`   กลุ่มช่อง: ${groups.length} (กางอยู่ ${groups.filter((g) => g.open).length})`);
    if (groups.length) console.log(`      ตัวอย่าง: ${groups.slice(0, 3).map((g) => g.title).join(" / ")}`);
    if (!groups.length) note("ux", "แก้ Master", "กลุ่มช่องไม่ได้เป็นแบบยุบได้ — ต้องเลื่อนยาวมาก");

    // ทดลองเปลี่ยนโหมดเป็น "ใช้ค่า Master" แล้วพิมพ์ค่า — ผู้ใช้ทำแบบนี้จริง
    const firstRow = page.locator(".ms-row").first();
    await firstRow.locator("select.ms-mode").selectOption("master").catch(() => {});
    await page.waitForTimeout(400);
    const canType = await firstRow.locator("input.ms-edit").isEditable().catch(() => false);
    const w = await firstRow.locator("input.ms-edit").evaluate((e) => Math.round(e.getBoundingClientRect().width)).catch(() => 0);
    console.log(`   เลือก "ใช้ค่า Master" แล้วพิมพ์ได้: ${canType} · ช่องกว้าง ${w}px`);
    if (!canType || w < 100) note("bug", "แก้ Master", `เลือก "ใช้ค่า Master" แล้วกรอกค่าไม่ได้ (พิมพ์ได้=${canType} กว้าง=${w}px)`);
    await shot("master-mode-master");

    // แท็บรายการสินค้า
    const itemTab = page.locator('.md-tab[data-page="3"]');
    if (await itemTab.count()) {
      await itemTab.click();
      await page.waitForTimeout(1800);
      await shot("master-items");
      const cards = await page.locator(".item-card").count();
      console.log(`   แท็บหน้า 3 — การ์ดรายการสินค้า: ${cards}`);
      if (!cards) note("bug", "แก้ Master", "Master มีรายการสินค้าในฐานข้อมูล แต่แท็บหน้า 3 ไม่แสดง");
    }
    // แท็บหน้า 4
    const p4 = page.locator('.md-tab[data-page="4"]');
    if (await p4.count()) {
      await p4.click();
      await page.waitForTimeout(1500);
      await shot("master-page4");
      const f4 = await page.locator(".reg-fld, .fld").count();
      console.log(`   แท็บหน้า 4 (สิทธิประโยชน์) — ช่อง: ${f4}`);
      if (!f4) note("bug", "แก้ Master", "แท็บหน้า 4 ไม่มีช่องเลย");
    } else note("bug", "แก้ Master", "ไม่มีแท็บหน้า 4");
  }

  // ═══ 5. หน้าตั้งค่า → ลูกค้า ═══
  console.log("\n═══ 5. หน้าตั้งค่า → ลูกค้า ═══");
  // ทดสอบ: กด Escape ปิด modal ได้ไหม (ผู้ใช้คาดหวังแบบนั้น)
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(1000);
  const stillOpen = await page.locator(".modal:visible").count().catch(() => 0);
  if (stillOpen) {
    note("ux", "ทั้งเว็บ", "กด Escape แล้วหน้าต่างไม่ปิด ต้องกดปุ่ม × เท่านั้น");
    // ปิดด้วยปุ่มกากบาทแทน
    for (const sel of [".modal:visible .modal-x", "#msClose", "#mdClose", "#crClose"]) {
      const b = page.locator(sel).first();
      if (await b.count() && await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await page.waitForTimeout(700); }
    }
  }
  await page.waitForTimeout(800);
  await page.click('a[data-page="settings"]');
  await page.waitForTimeout(2500);
  const custTab = page.locator('.tab[data-tab="customer"]');
  if (await custTab.count()) { await custTab.click(); await page.waitForTimeout(2000); }
  await shot("settings-customer");
  const csNote = await page.locator(".cs-note").innerText().catch(() => "");
  const csCust = await page.locator(".cs-cust").count();
  console.log(`   ลูกค้าในรายการ: ${csCust} · มีคำอธิบายหัวหน้า: ${csNote ? "มี" : "ไม่มี"}`);
  if (!csNote) note("ux", "ตั้งค่าลูกค้า", "ไม่มีคำอธิบายว่าการคุมช่องย้ายไป Master แล้ว");
  const leftovers = await page.locator(".cs-row, .csMode, .csPreset").count();
  if (leftovers) note("bug", "ตั้งค่าลูกค้า", `ยังมีของเก่าค้างอยู่ ${leftovers} จุด (ควรย้ายไป Master หมดแล้ว)`);

  // ═══ 6. สร้างใบขนเอง (ไม่อัปโหลด) ═══
  console.log("\n═══ 6. กดสร้างใบขนเอง ═══");
  await page.click('a[data-page="list"]');
  await page.waitForTimeout(2000);
  const btnCreate = page.locator("#btnCreate, #btnNew, button:has-text('สร้าง')").first();
  if (await btnCreate.count()) {
    await btnCreate.click();
    await page.waitForTimeout(2500);
    await shot("create-form");
    const cTabs = await page.locator(".md-tab").allInnerTexts().catch(() => []);
    const cFields = await page.locator(".reg-fld").count();
    console.log(`   ฟอร์มสร้างใหม่ — แท็บ: ${cTabs.length} · ช่อง: ${cFields}`);
    if (cFields < 50) note("bug", "สร้างใบขน", `ฟอร์มมีช่องแค่ ${cFields} ช่อง น่าจะโหลดทะเบียนช่องไม่ครบ`);
  } else note("ux", "รายการใบขน", "หาปุ่มสร้างใบขนเองไม่เจอ");

  // ═══ สรุป ═══
  console.log(`\n═══ JavaScript errors: ${jsErrors.length} ═══`);
  for (const e of [...new Set(jsErrors)].slice(0, 10)) console.log(`   ✗ ${e}`);
  if (jsErrors.length) note("bug", "ทั้งเว็บ", `มี JS error ${jsErrors.length} ครั้ง`);

  console.log(`\n╔═══════════════════════════════════════╗`);
  console.log(`║  สรุปสิ่งที่เจอ: ${String(findings.length).padStart(2)} รายการ            ║`);
  console.log(`╚═══════════════════════════════════════╝`);
  for (const f of findings) console.log(`  ${f.severity === "bug" ? "🔴 บั๊ก" : "🟡 UX "} [${f.screen}] ${f.what}`);
  console.log(`\nภาพหน้าจอ: ${SHOT_DIR}`);
} catch (e) {
  console.error(`✗ การทดสอบหยุดกลางคัน: ${e.message}`);
  await shot("crash");
} finally {
  await browser.close();
}
