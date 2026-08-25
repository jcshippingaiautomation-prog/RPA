// ============================================================
//  Cleanup drafts — ลบ "ใบร่าง" ใน DCTK ที่เกิดจากการทดสอบ/ทำสำเนา
//
//  ปลอดภัย 3 ชั้น:
//    1. ลบได้เฉพาะใบที่สถานะ "กำลังทำข้อมูล" (ใบร่าง) — ใบที่ยื่นกรมฯ แล้วไม่แตะ
//    2. ต้องระบุเลขอ้างอิงที่จะลบเอง (CLEAN_REFS) ไม่มีการลบเหมารวม
//    3. ค่าปริยายคือ "ดูก่อน" — ต้องใส่ CLEAN_APPLY=1 ถึงจะลบจริง
//
//  วิธีรัน:
//    set -a; . ../rpa-web/.env; set +a
//    CLEAN_REFS="DCTK000035383,DCTK000035382" node dist/cleanup-drafts-cli.js
//    CLEAN_REFS="..." CLEAN_APPLY=1 node dist/cleanup-drafts-cli.js
// ============================================================
import { chromium } from "playwright";
import { loadConfig } from "./runner.js";
import { login } from "./pages.js";
import { setLogSink, log, sleep } from "./helpers.js";

setLogSink(null);

const REFS = (process.env.CLEAN_REFS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const APPLY = process.env.CLEAN_APPLY === "1";
if (!REFS.length) { console.error('✗ ต้องระบุ CLEAN_REFS="DCTK000035383,..."'); process.exit(1); }

const cfg = await loadConfig();
const browser = await chromium.launch({ headless: process.env.CLEAN_HEADLESS !== "0" });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();
page.setDefaultTimeout(30000);

try {
  await page.goto(cfg.url!, { waitUntil: "domcontentloaded", timeout: 45000 });
  await login(page, cfg.username, cfg.password);
  const base = new URL(cfg.url!).origin;

  log(`\n${APPLY ? "🧹 ลบจริง" : "👀 ดูก่อน (ยังไม่ลบ — ใส่ CLEAN_APPLY=1 ถ้าจะลบ)"} · ${REFS.length} ใบ\n`);

  let done = 0, skipped = 0;
  for (const ref of REFS) {
    await page.goto(`${base}/DCTK/ExDec/Index`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.locator("#grid").first().waitFor({ state: "visible", timeout: 30000 });
    await sleep(2500);

    await page.evaluate((v: string) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      (window as any).$("#grid").data("kendoGrid")?.dataSource
        ?.filter({ field: "ReferenceNo", operator: "eq", value: v });
    }, ref);
    await sleep(4000);

    const t = await page.evaluate((v: string) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const view: any[] = (window as any).$("#grid").data("kendoGrid")?.dataSource?.view?.() ?? [];
      const m = view.find((x) => String(x.ReferenceNo ?? "") === v);
      if (!m) return null;
      return {
        uid: String(m.uid ?? ""), status: String(m.DeclarationStatusName ?? ""),
        invoice: String(m.InvoiceNoText ?? ""), customer: String(m.CmpNameThai ?? ""),
      };
    }, ref).catch(() => null);

    if (!t) { log(`   ⏭ ${ref}: ไม่พบ (ลบไปแล้ว?)`); skipped++; continue; }
    if (!/กำลังทำข้อมูล/.test(t.status)) {
      log(`   ⛔ ${ref}: สถานะ "${t.status}" ไม่ใช่ใบร่าง — ไม่ลบ`);
      skipped++; continue;
    }
    log(`   ${APPLY ? "🗑" : "•"} ${ref}  ${t.invoice.padEnd(24)} ${t.customer.slice(0, 32)}`);
    if (!APPLY) continue;

    await page.locator(`#grid tbody tr[data-uid="${t.uid}"]`).first().click({ timeout: 10000 });
    await sleep(1500);
    const clicked = await page.evaluate(() => {
      const b = document.querySelector("#BtnDelete") as HTMLElement | null;
      if (!b) return false;
      b.click(); return true;
    });
    if (!clicked) { log(`      ⚠ ไม่พบปุ่มลบ`); skipped++; continue; }
    await sleep(3000);
    for (let i = 0; i < 6; i++) {
      const ok = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button, input[type=button]"));
        const yes = btns.find((b) => {
          const s = ((b as HTMLElement).innerText || (b as HTMLInputElement).value || "").trim().toUpperCase();
          return s === "YES" || s === "ตกลง" || s === "OK";
        }) as HTMLElement | undefined;
        if (!yes) return false;
        yes.click(); return true;
      }).catch(() => false);
      if (ok) break;
      await sleep(1500);
    }
    await sleep(5000);
    log(`      ✓ ลบแล้ว`);
    done++;
  }

  log(`\nสรุป: ${APPLY ? `ลบ ${done} ใบ` : `จะลบ ${REFS.length - skipped} ใบ`} · ข้าม ${skipped}`);
} catch (e) {
  log(`✗ ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await browser.close();
}
