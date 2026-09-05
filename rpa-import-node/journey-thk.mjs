// อัปโหลดใบกำกับ THANAKORN ผ่านหน้าเว็บ (เหมือนผู้ใช้) แล้วอ่านค่าที่ระบบสรุปได้
import { chromium } from "playwright";
import path from "node:path";
const BASE = process.env.JOURNEY_URL ?? "http://localhost:8101";
const FILE = process.argv[2];
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
try {
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.click("#btnUpload");
  await page.waitForTimeout(1500);
  await page.selectOption("#upCustomer", { label: "THANAKORN" }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.setInputFiles("#fileInput", FILE);
  await page.waitForTimeout(1500);
  await page.click("#upSubmit");
  let ok = false, err = "";
  for (let k = 0; k < 90; k++) {
    await page.waitForTimeout(3000);
    if (await page.evaluate(() => { const m = document.getElementById("modalDetail"); return m && getComputedStyle(m).display !== "none"; })) { ok = true; break; }
    const e = await page.locator("#upErr").innerText().catch(() => "");
    if (e.trim()) { err = e.trim(); break; }
  }
  if (!ok) { console.log("✗ อัปโหลดไม่สำเร็จ:", err.slice(0, 200)); process.exit(1); }
  await page.waitForTimeout(2500);
  const info = await page.evaluate(() => {
    const m = document.getElementById("modalDetail");
    const g = (k) => { const el = m.querySelector(`.md-edit[data-key="${k}"]`); return el ? String(el.value ?? "").trim() : "—"; };
    return {
      title: (m.querySelector(".modal-head h3")?.textContent || "").trim(),
      master: (m.querySelector("[data-master], .md-master, .tpl-name")?.textContent || "").trim(),
      f: Object.fromEntries(["invoice_no","invoice_number","consignee_name","dest_country_code","destination_country_code",
        "incoterms","term_code","currency","total_goods_amount","freight_charge","insurance_charge",
        "net_weight_kg","gross_weight_kg","released_port","release_port_code","loaded_port","loading_port_code",
        "vessel_name","voyage","voyage_number","etd","shipping_mark","consignee_street_and_no",
        "consignee_district_name","consignee_sub_province_name"].map((k) => [k, g(k)])),
      items: [...m.querySelectorAll("#itBody .item-card")].map((c) => c.innerText.replace(/\s+/g, " ").trim().slice(0, 220)),
      errs: [...m.querySelectorAll(".vld-item")].map((e) => e.innerText.replace(/\s+/g, " ").trim()),
    };
  });
  console.log("หัวข้อ:", info.title, "| Master:", info.master || "(อ่านไม่ได้จาก DOM)");
  for (const [k, v] of Object.entries(info.f)) if (v && v !== "—") console.log(`  ${k.padEnd(28)} = ${v}`);
  console.log("\nรายการสินค้า:");
  info.items.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
  console.log("\nตรวจข้อมูล:", info.errs.length ? "" : "ผ่าน");
  info.errs.forEach((e) => console.log("   •", e));
  await page.screenshot({ path: "/private/tmp/thk-detail.png", fullPage: true });
} catch (e) { console.error("✗", e.message); }
finally { await browser.close(); }
