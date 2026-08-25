// รอบ 3 — อัปโหลดเอกสารจริง แล้วไล่จนถึงหน้าตรวจสอบ (เหมือนผู้ใช้ทำทุกขั้น)
import { chromium } from "playwright";
import path from "node:path";
import { mkdir } from "node:fs/promises";

const BASE = process.env.JOURNEY_URL ?? "http://localhost:8101";
const PDF = process.env.JOURNEY_PDF ?? "/Users/pok/Desktop/Jobs/ScriptMappingคุณแพรว/FOB-DKN 22.2026.pdf";
const DIR = "/private/tmp/journey3";
await mkdir(DIR, { recursive: true });

const found = [];
const note = (sev, screen, what) => { found.push({ sev, screen, what }); console.log(`   ${sev === "bug" ? "🔴" : "🟡"} [${screen}] ${what}`); };

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const jsErr = [];
page.on("pageerror", (e) => jsErr.push(String(e).slice(0, 150)));
let n = 0;
const shot = async (name) => { n++; await page.screenshot({ path: path.join(DIR, `${String(n).padStart(2, "0")}-${name}.png`) }); };

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2500);

  // ═══ 1. เปิดอัปโหลด เลือกลูกค้า + Master ═══
  console.log("\n═══ 1. เลือกลูกค้า + Master + แนบไฟล์ ═══");
  await page.click("#btnUpload");
  await page.waitForTimeout(1500);
  await page.selectOption("#upCustomer", { label: "THANAKORN" });
  await page.waitForTimeout(1500);

  // เอกสารเป็นของ DK&N → เลือก Master ที่ตรง
  const opts = await page.locator("#upTemplate option").allInnerTexts();
  const dkn = opts.findIndex((o) => /DK&N/i.test(o));
  console.log(`   Master ที่เลือกได้ ${opts.length - 1} อัน · เจอ DK&N ที่ลำดับ ${dkn}`);
  if (dkn > 0) await page.selectOption("#upTemplate", { index: dkn });
  else note("ux", "อัปโหลด", "ไม่เจอ Master ของ DK&N ในรายการ");

  await page.setInputFiles("#fileInput", PDF);
  await page.waitForTimeout(1500);
  const fileShown = await page.locator("#fileList").innerText().catch(() => "");
  console.log(`   ไฟล์ที่แนบ: "${fileShown.replace(/\n/g, " ").slice(0, 70)}"`);
  if (!fileShown.trim()) note("bug", "อัปโหลด", "แนบไฟล์แล้วแต่ไม่แสดงชื่อไฟล์ — ผู้ใช้ไม่รู้ว่าแนบติดไหม");
  await shot("ready-to-upload");

  // ═══ 2. กดถัดไป — AI สกัด ═══
  console.log("\n═══ 2. กด 'ถัดไป — ให้ AI สกัด' ═══");
  const t0 = Date.now();
  await page.click("#upSubmit");
  await page.waitForTimeout(3000);
  await shot("ai-processing");

  const step2Visible = await page.locator("#upStep2").isVisible().catch(() => false);
  const procText = await page.locator("#upProcTitle").innerText().catch(() => "");
  console.log(`   เข้าขั้นที่ 2: ${step2Visible} · ข้อความ: "${procText}"`);
  if (!step2Visible) note("bug", "อัปโหลด", "กดถัดไปแล้วไม่เข้าหน้ากำลังประมวลผล");

  // รอจนหน้าตรวจสอบเปิด (หรือ error) สูงสุด 4 นาที
  let done = false, failed = "";
  for (let i = 0; i < 80; i++) {
    await page.waitForTimeout(3000);
    const detailOpen = await page.evaluate(() => {
      const m = document.getElementById("modalDetail");
      return m && getComputedStyle(m).display !== "none";
    });
    if (detailOpen) { done = true; break; }
    const err = await page.locator("#upErr").innerText().catch(() => "");
    if (err.trim()) { failed = err.trim(); break; }
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(`   ใช้เวลา ${secs} วินาที · สำเร็จ: ${done}${failed ? ` · error: ${failed.slice(0, 80)}` : ""}`);
  if (failed) { note("bug", "อัปโหลด", `AI สกัดไม่สำเร็จ: ${failed.slice(0, 90)}`); }
  if (!done && !failed) note("bug", "อัปโหลด", `รอเกิน ${secs} วินาทีแล้วยังไม่เปิดหน้าตรวจสอบ`);
  if (secs > 150) note("ux", "อัปโหลด", `ใช้เวลา ${secs} วินาที นานกว่าที่หน้าจอบอกไว้ (1–2 นาที)`);
  await shot("after-ai");

  if (!done) throw new Error("ไม่ถึงหน้าตรวจสอบ");

  // ═══ 3. หน้าตรวจสอบ ═══
  console.log("\n═══ 3. หน้าตรวจสอบข้อมูล ═══");
  await page.waitForTimeout(2500);
  await shot("review");

  const info = await page.evaluate(() => {
    const m = document.getElementById("modalDetail");
    const tabs = [...m.querySelectorAll(".md-tab")].map((t) => t.textContent.trim());
    const vis = (e) => e.getBoundingClientRect().width > 0;
    const inputs = [...m.querySelectorAll("input.inp")].filter(vis);
    const filled = inputs.filter((i) => String(i.value).trim());
    // ช่องในหน้าตรวจสอบใช้คลาส .md-edit (ไม่ใช่ data-key ลอย ๆ ซึ่งไปชนกับที่อื่น)
    const key = (k) => {
      const el = m.querySelector(`.md-edit[data-key="${k}"]`);
      return el ? String(el.value ?? "").trim() : null;
    };
    const errBox = m.querySelector(".vld-list");
    return {
      title: (m.querySelector(".modal-head h3")?.textContent || "").trim(),
      tabs,
      filled: filled.length, total: inputs.length,
      invoice: key("invoice_no") ?? key("invoice_number"),
      consignee: key("consignee_name"),
      etd: key("departure_date") ?? key("etd"),
      vessel: key("vessel_name"),
      amount: key("amount_foreign") ?? key("total_goods_amount"),
      errors: errBox ? errBox.innerText.replace(/\s+/g, " ").slice(0, 220) : "",
      itemCards: m.querySelectorAll(".item-card").length,
    };
  });
  console.log(`   หัวข้อ: "${info.title}"`);
  console.log(`   แท็บ: ${info.tabs.join(" | ")}`);
  console.log(`   ช่องที่มีค่า: ${info.filled}/${info.total} (แท็บที่เปิดอยู่)`);
  console.log(`   รายการสินค้า: ${info.itemCards} การ์ด`);
  console.log(`   ค่าสำคัญ — ใบกำกับ="${info.invoice}" consignee="${info.consignee}"`);
  console.log(`             ETD="${info.etd}" เรือ="${info.vessel}" ยอด="${info.amount}"`);
  if (info.errors) console.log(`   ข้อความตรวจสอบ: ${info.errors}`);

  if (!info.invoice) note("bug", "ตรวจสอบ", "ไม่มีเลขใบกำกับ — AI อ่านไม่ได้หรือไม่ได้แสดง");
  if (!info.consignee) note("bug", "ตรวจสอบ", "ไม่มีชื่อ consignee");
  if (!info.itemCards) note("bug", "ตรวจสอบ", "ไม่มีรายการสินค้าเลย");

  // เทียบกับ Master: ค่าที่ Master ควรเติมให้ (ท่าเรือ/ประเทศ) มาหรือยัง
  const fromMaster = await page.evaluate(() => {
    const m = document.getElementById("modalDetail");
    const g = (k) => { const el = m.querySelector(`.md-edit[data-key="${k}"]`); return el ? String(el.value ?? "").trim() : ""; };
    return {
      dest: g("dest_country_code") || g("destination_country_code"),
      buyer: g("pur_country_code") || g("buyer_country_code"),
      relPort: g("released_port") || g("release_port_code"),
      payment: g("payment_method") || g("tax_payment_method_code"),
    };
  });
  console.log(`   ค่าที่ควรมาจาก Master — ปลายทาง="${fromMaster.dest}" ผู้ซื้อ="${fromMaster.buyer}" ท่าเรือ="${fromMaster.relPort}" ชำระอากร="${fromMaster.payment}"`);
  const gotMaster = Object.values(fromMaster).filter(Boolean).length;
  if (gotMaster < 2) note("bug", "ตรวจสอบ", `เลือก Master ไว้แล้วแต่ค่าจาก Master แทบไม่มา (ได้ ${gotMaster}/4)`);

  // ═══ 4. ปิดแล้วดูในรายการ ═══
  console.log("\n═══ 4. กลับมาที่รายการใบขน ═══");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(2000);
  await shot("list-after");
  const row = await page.evaluate(() => {
    const tr = document.querySelector("#listBody tr");
    return tr ? tr.innerText.replace(/\s+/g, " ").slice(0, 140) : "(ไม่มีแถว)";
  });
  console.log(`   แถวแรกในตาราง: ${row}`);

  console.log(`\n   JS errors: ${jsErr.length}`);
  for (const e of [...new Set(jsErr)].slice(0, 5)) console.log(`      ✗ ${e}`);

  console.log(`\n╔═══════════════════════════════╗`);
  console.log(`║  เจอ ${String(found.length).padStart(2)} รายการ                 ║`);
  console.log(`╚═══════════════════════════════╝`);
  for (const f of found) console.log(`  ${f.sev === "bug" ? "🔴" : "🟡"} [${f.screen}] ${f.what}`);
  console.log(`\nภาพ: ${DIR}`);
} catch (e) {
  console.error(`✗ ${e.message}`);
  await shot("crash");
} finally { await browser.close(); }
