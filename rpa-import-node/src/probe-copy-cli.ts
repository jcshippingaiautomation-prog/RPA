// สำรวจปุ่มแถบเครื่องมือของหน้ารายการใบขน — หาปุ่ม "สำเนา" และดูว่ากดแล้วเกิดอะไร
//   อ่าน/สำรวจเท่านั้น: ค่าปริยายจะ "ไม่กด" ปุ่มสำเนา (ต้องใส่ PROBE_CLICK=1)
import path from "node:path";
import { chromium } from "playwright";
import { loadConfig, PROJECT_ROOT } from "./runner.js";
import { login } from "./pages.js";
import { setLogSink, log, sleep } from "./helpers.js";
import * as S from "./selectors.js";

setLogSink(null);
const INV = process.env.PROBE_INVOICE ?? "MEK 19(H)/2025";
const DO_CLICK = process.env.PROBE_CLICK === "1";

const cfg = await loadConfig();
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();
page.setDefaultTimeout(30000);
const out = path.join(PROJECT_ROOT, "file download", "survey");

try {
  await page.goto(cfg.url!, { waitUntil: "domcontentloaded", timeout: 45000 });
  await login(page, cfg.username, cfg.password);
  await page.click(S.SEL_PORTFOLIO_MENU);
  await sleep(6000);

  await page.evaluate((v: string) => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (window as any).$("#grid").data("kendoGrid").dataSource
      .filter({ field: "InvoiceNoText", operator: "contains", value: v });
  }, INV);
  await sleep(5000);

  const uid = await page.evaluate(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const v: any[] = (window as any).$("#grid").data("kendoGrid").dataSource.view();
    return v[0]?.uid ?? null;
  });
  if (!uid) { log("✗ กรองแล้วไม่เจอแถว"); process.exit(1); }

  // เลือกแถว (คลิกครั้งเดียว) — ปุ่มสำเนามักต้องมีแถวถูกเลือกก่อน
  await page.locator(`#grid tbody tr[data-uid="${uid}"]`).first().click();
  await sleep(1500);

  const btns = await page.evaluate(() => {
    const vis = (e: Element) => {
      const r = (e as HTMLElement).getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    return Array.from(document.querySelectorAll("a, button, input[type=button]"))
      .filter(vis)
      .map((b) => ({
        tag: b.tagName, id: (b as HTMLElement).id || "",
        cls: ((b as HTMLElement).className || "").toString().slice(0, 40),
        text: ((b as HTMLElement).innerText || (b as HTMLInputElement).value || "").replace(/\s+/g, " ").trim().slice(0, 26),
        onclick: ((b as HTMLElement).getAttribute("onclick") || "").slice(0, 60),
        href: ((b as HTMLAnchorElement).getAttribute("href") || "").slice(0, 60),
      }))
      .filter((b) => b.text || b.id);
  });
  log(`ปุ่มบนแถบเครื่องมือ (${btns.length}):`);
  for (const b of btns.slice(0, 30)) {
    log(`   <${b.tag}> id="${b.id}" text="${b.text}" class="${b.cls}"`);
    if (b.onclick) log(`         onclick=${b.onclick}`);
    if (b.href && b.href !== "#") log(`         href=${b.href}`);
  }

  if (DO_CLICK) {
    log(`\n▶ กดปุ่ม "สำเนา"`);
    const ok = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll("a, button")).find(
        (b) => ((b as HTMLElement).innerText || "").replace(/\s+/g, "").includes("สำเนา"),
      ) as HTMLElement | undefined;
      if (!el) return false;
      el.click(); return true;
    });
    log(`   กดได้: ${ok}`);
    await sleep(8000);
    const st = await page.evaluate(() => ({
      tabstrip: !!document.querySelector("#TabStrip"),
      depDate: !!document.querySelector("#DepartureDate"),
      refNo: (document.querySelector("#ReferenceNo") as HTMLInputElement)?.value || "",
      invNo: (document.querySelector("#InvoiceNo") as HTMLInputElement)?.value || "",
      buttons: Array.from(document.querySelectorAll("button")).map((b) => (b as HTMLElement).innerText.trim()).filter((t) => /YES|NO|CANCEL|ตกลง|ยกเลิก/i.test(t)),
    }));
    log(`   หลังกด: TabStrip=${st.tabstrip} DepartureDate=${st.depDate} refNo="${st.refNo}" invNo="${st.invNo}"`);
    if (st.buttons.length) log(`   มีกล่องถาม ปุ่ม: ${st.buttons.join(", ")}`);
    await page.screenshot({ path: path.join(out, "probe-copy.png") });
    log(`   ภาพ: ${out}/probe-copy.png`);
  } else {
    log(`\n(ยังไม่กดปุ่มสำเนา — ใส่ PROBE_CLICK=1 ถ้าจะให้กด)`);
  }
} catch (e) {
  log(`✗ ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await browser.close();
}
