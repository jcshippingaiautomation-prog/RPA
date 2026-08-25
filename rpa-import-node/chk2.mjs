import { chromium } from "playwright";
const b = await chromium.launch({ headless: true });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await p.goto("http://localhost:8101", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(2500);
await p.locator("#listBody tr").first().click();
await p.waitForTimeout(3500);
const r = await p.evaluate(() => {
  const m = document.getElementById("modalDetail");
  const errs = [...m.querySelectorAll(".vld-item")].map((e) => e.innerText.replace(/\s+/g, " ").trim());
  const g = (k) => { const el = m.querySelector(`.md-edit[data-key="${k}"]`); return el ? String(el.value ?? "").trim() : "(ไม่มีช่อง)"; };
  return {
    title: (m.querySelector(".modal-head h3")?.textContent || "").trim(),
    errs,
    master: {
      dest: g("dest_country_code"), buyer: g("pur_country_code"),
      port: g("released_port"), pay: g("payment_method"), term: g("term_code"),
    },
    runDisabled: document.getElementById("mdRun")?.disabled,
  };
});
console.log(`หัวข้อ: ${r.title}`);
console.log(`ค่าจาก Master ในฟอร์ม: ปลายทาง=${r.master.dest} ผู้ซื้อ=${r.master.buyer} ท่าเรือ=${r.master.port} ชำระ=${r.master.pay} เงื่อนไข=${r.master.term}`);
console.log(`ปุ่ม "รัน RPA" ถูกปิด: ${r.runDisabled}`);
console.log(`\nรายการที่ต้องแก้ (${r.errs.length}):`);
for (const e of r.errs) console.log(`   • ${e}`);
await p.screenshot({ path: "/private/tmp/journey3/final-review.png" });
await b.close();
