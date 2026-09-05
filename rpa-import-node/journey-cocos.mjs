// ทดสอบ COCOS ตั้งแต่ต้น — อัปโหลดเอกสารจริงทีละไฟล์ผ่านหน้าเว็บ เหมือนผู้ใช้ทำ
//   ไม่เลือก Master เอง ปล่อยให้ระบบจับคู่จาก Consignee/ประเทศ (ทดสอบตรรกะจับคู่ด้วย)
import { chromium } from "playwright";
import path from "node:path";
import { mkdir } from "node:fs/promises";

const BASE = process.env.JOURNEY_URL ?? "http://localhost:8101";
const DIR = "/private/tmp/journey-cocos";
await mkdir(DIR, { recursive: true });

const ROOT = "/Users/pok/Desktop/Jobs/ScriptMappingคุณแพรว";
const FILES = [
  { file: `${ROOT}/Inv  pack list ctn _2648 OS-Dubai (Custom).xls`, expect: "AE · AL ACCAD (Dubai)" },
  { file: `${ROOT}/Inv _ pack list ctn _2612 CHI-London.xls`, expect: "GB · GIVING TREE (London)" },
  { file: `${ROOT}/Inv _ pack list ctn _2654 FFF - Rotterdam.xls`, expect: "NL · FFF (Rotterdam)" },
  { file: `${ROOT}/Inv - pack list ctn 2603(GG-NY)-Custom.xls`, expect: "US · EVERPRESS? (New York)" },
];

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
const jsErr = [];
page.on("pageerror", (e) => jsErr.push(String(e).slice(0, 140)));

const results = [];
try {
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2500);

  for (const [i, f] of FILES.entries()) {
    const name = path.basename(f.file);
    console.log(`\n═══ ${i + 1}/${FILES.length}  ${name}`);
    console.log(`    คาดว่าจะได้: ${f.expect}`);
    const t0 = Date.now();

    await page.click("#btnUpload");
    await page.waitForTimeout(1500);
    await page.selectOption("#upCustomer", { label: "COCO" }).catch(() => {});
    await page.waitForTimeout(1200);
    // ปล่อยช่อง Master ว่าง = ให้ระบบจับคู่เอง
    await page.setInputFiles("#fileInput", f.file);
    await page.waitForTimeout(1500);
    await page.click("#upSubmit");

    let ok = false, err = "";
    for (let k = 0; k < 90; k++) {
      await page.waitForTimeout(3000);
      const open = await page.evaluate(() => {
        const m = document.getElementById("modalDetail");
        return m && getComputedStyle(m).display !== "none";
      });
      if (open) { ok = true; break; }
      const e = await page.locator("#upErr").innerText().catch(() => "");
      if (e.trim()) { err = e.trim(); break; }
    }
    const secs = Math.round((Date.now() - t0) / 1000);

    if (!ok) {
      console.log(`    ✗ ไม่สำเร็จ (${secs}s): ${err.slice(0, 110)}`);
      results.push({ name, ok: false, err });
      await page.locator("#upClose").click().catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(1500);
      continue;
    }

    await page.waitForTimeout(2500);
    const info = await page.evaluate(() => {
      const m = document.getElementById("modalDetail");
      const g = (k) => { const el = m.querySelector(`.md-edit[data-key="${k}"]`); return el ? String(el.value ?? "").trim() : ""; };
      const errs = [...m.querySelectorAll(".vld-item")].map((e) => e.innerText.replace(/\s+/g, " ").trim());
      return {
        title: (m.querySelector(".modal-head h3")?.textContent || "").trim(),
        invoice: g("invoice_no"), consignee: g("consignee_name"),
        dest: g("dest_country_code"), port: g("released_port"), loaded: g("loaded_port"),
        vessel: g("vessel_name"), voyage: g("voyage"),
        items: m.querySelectorAll("#itBody .item-card").length,
        codes: [...m.querySelectorAll("#itBody .item-code")].map((c) => c.textContent.trim()),
        errs, runDisabled: document.getElementById("mdRun")?.disabled,
      };
    });
    console.log(`    ✓ ${secs}s · ${info.title}`);
    console.log(`      consignee=${info.consignee || "—"} · ปลายทาง=${info.dest || "—"} · ท่าเรือ=${info.port || "—"}→${info.loaded || "—"}`);
    console.log(`      ขนส่ง: เรือ=${info.vessel || "—"} เที่ยว=${info.voyage || "—"}`);
    console.log(`      รายการสินค้า ${info.items} · ${info.codes.slice(0, 3).join(" / ")}`);
    console.log(`      ตรวจข้อมูล: ${info.errs.length ? info.errs.length + " จุด" : "ผ่าน"} · ปุ่มนำเข้าใช้ได้=${!info.runDisabled}`);
    for (const e of info.errs.slice(0, 4)) console.log(`         • ${e.slice(0, 130)}`);
    results.push({ name, ok: true, secs, ...info });

    await page.screenshot({ path: path.join(DIR, `${i + 1}-${path.basename(f.file, ".xls").replace(/[^\w]+/g, "_").slice(0, 28)}.png`) });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(2000);
  }

  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  อัปโหลดสำเร็จ ${results.filter((r) => r.ok).length}/${FILES.length}                    ║`);
  console.log(`╚══════════════════════════════════════╝`);
  for (const r of results) {
    console.log(r.ok
      ? `  ✓ ${r.invoice || "?"} → ${r.dest || "?"} · ${r.consignee || "?"} · ${r.items} รายการ · ตรวจ ${r.errs.length} จุด`
      : `  ✗ ${r.name}`);
  }
  console.log(`\nJS errors: ${jsErr.length}`);
  console.log(`ภาพ: ${DIR}`);
} catch (e) {
  console.error(`✗ หยุดกลางคัน: ${e.message}`);
  await page.screenshot({ path: path.join(DIR, "crash.png") });
} finally { await browser.close(); }
