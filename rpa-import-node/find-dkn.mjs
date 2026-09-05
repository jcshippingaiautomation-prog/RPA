// ค้นใบขนของ DK&N ใน DCTK ด้วยการกรองฝั่งเซิร์ฟเวอร์ (วิธีเดียวกับที่ openDeclarationForEdit ใช้ได้ผล)
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
const { login } = await import("./dist/pages.js");
const { setLogSink, sleep } = await import("./dist/helpers.js");
const S = await import("./dist/selectors.js");
setLogSink(null);
const cfg = JSON.parse(await readFile("config.json", "utf-8"));
const NEEDLE = process.env.FIND ?? "DKN";
const b = await chromium.launch({ headless: true });
const page = await (await b.newContext({ viewport: { width: 1900, height: 1000 } })).newPage();
page.setDefaultTimeout(45000);
try {
  await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await login(page, cfg.username, cfg.password);
  await page.click(S.SEL_PORTFOLIO_MENU);
  await sleep(9000);
  // เอาติ๊ก "เฉพาะผู้ใช้งานนี้" ออก เพื่อเห็นใบที่คนอื่นในทีมทำด้วย
  await page.evaluate(() => {
    const cb = document.getElementById("SearchIsSpecificallyUser");
    if (cb && cb.checked) cb.click();
  }).catch(() => {});
  await sleep(1500);
  // อ่านรูปแบบวันที่ที่ DCTK ใช้อยู่ในช่องค้นหา แล้วขยายช่วงตามรูปแบบเดิม
  const cur = await page.evaluate(() => ({
    from: document.getElementById("SearchStartDate")?.value ?? "(ไม่มีช่อง)",
    to: document.getElementById("SearchFinishDate")?.value ?? "(ไม่มีช่อง)",
  }));
  console.log(`ช่วงวันที่ปัจจุบันในหน้าค้นหา: ${cur.from} ถึง ${cur.to}`);
  const FROM = process.env.FROM || "", TO = process.env.TO || "";
  if (FROM || TO) {
    await page.evaluate(({ f, t }) => {
      const set = (id, v) => {
        if (!v) return;
        const el = document.getElementById(id);
        if (!el) return;
        const w = window.$(el).data("kendoDatePicker");
        if (w) { w.value(v); w.trigger("change"); return; }
        el.value = v;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      set("SearchStartDate", f); set("SearchFinishDate", t);
    }, { f: FROM, t: TO });
    await sleep(1000);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button,a,input[type=button],input[type=submit]")]
        .find((x) => /ค้นหา/.test(x.innerText || x.value || ""));
      if (b) b.click();
    });
    console.log(`ขยายช่วงเป็น ${FROM} ถึง ${TO} แล้วกดค้นหา`);
    await sleep(15000);
  }
  const rows = await page.evaluate(async (needle) => {
    const g = window.$("#grid").data("kendoGrid");
    if (!g) return "ไม่พบตาราง";
    g.dataSource.pageSize(200);
    if (needle) g.dataSource.filter({ field: "InvoiceNoText", operator: "contains", value: needle });
    else g.dataSource.filter([]);
    await new Promise((r) => setTimeout(r, 12000));
    return g.dataSource.view().map((r) => ({
      inv: String(r.InvoiceNoText ?? ""), ref: String(r.ReferenceNo ?? ""),
      dec: String(r.DeclarationNo ?? ""), cmp: String(r.CmpNameThai ?? "").slice(0, 26),
      dep: r.DepartureDate ? String(r.DepartureDate).slice(0, 15) : "",
      st: String(r.DeclarationStatusName ?? ""), cur: String(r.TotalFobCurrencyCode ?? ""),
      fob: String(r.TotalFobForeign ?? ""), dest: String(r.DestCountryCode ?? ""),
    }));
  }, NEEDLE);
  if (typeof rows === "string") throw new Error(rows);
  console.log(`พบ ${rows.length} ใบ${NEEDLE ? ` ที่เลขใบกำกับมี "${NEEDLE}"` : ""}\n`);
  if (process.env.GROUP) {
    const by = new Map();
    for (const r of rows) {
      const k = process.env.GROUPBY === "seg"
        ? (r.inv.match(/^[A-Za-z]+-[A-Za-z]+/) || [r.inv.slice(0, 8)])[0].toUpperCase()
        : (r.inv.match(/^[A-Za-z-]+/) || ["(อื่น ๆ)"])[0].toUpperCase();
      const g = by.get(k) ?? { n: 0, last: "", dest: new Set() };
      g.n++; if (!g.last) g.last = `${r.inv} (${r.ref})`; g.dest.add(r.dest);
      by.set(k, g);
    }
    console.log(`${"คำนำหน้าเลขใบกำกับ".padEnd(22)}${"จำนวนใบ".padEnd(10)}${"ปลายทาง".padEnd(12)}ใบล่าสุด`);
    console.log("─".repeat(96));
    for (const [k, g] of [...by].sort((a, b) => b[1].n - a[1].n)) {
      console.log(`${k.padEnd(22)}${String(g.n).padEnd(10)}${[...g.dest].join(",").padEnd(12)}${g.last}`);
    }
    process.exit(0);
  }
  console.log(`${"เลขใบกำกับ".padEnd(20)}${"เลขอ้างอิง".padEnd(16)}${"ส่งออก".padEnd(17)}${"ปท".padEnd(4)}${"มูลค่า".padEnd(16)}สถานะ`);
  console.log("─".repeat(112));
  for (const r of rows) {
    console.log(`${r.inv.padEnd(20)}${r.ref.padEnd(16)}${r.dep.padEnd(17)}${r.dest.padEnd(4)}${(r.cur + " " + r.fob).padEnd(16)}${r.st}`);
  }
} catch (e) { console.log("✗", e.message); }
finally { await b.close(); }
