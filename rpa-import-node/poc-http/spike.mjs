// ============================================================
//  POC — แนวทาง A: สังเกต HTTP requests ของ DCTK (read-only, ไม่แตะระบบเดิม)
//  ทำ: login → portfolio → เปิดฟอร์มสร้างใบขน → dump network + token + form
//  ไม่กด Save/submit ใบจริง (ไม่สร้างข้อมูลใน DCTK)
// ============================================================
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync(new URL("../config.json", import.meta.url)));
const OUT = process.env.OUT || ".";
const net = [];             // network log
const CAP_BODIES = [];      // POST bodies ที่น่าสนใจ

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext();
const p = await ctx.newPage();

// ---- log ทุก request/response ----
p.on("request", (req) => {
  const m = req.method(); const u = req.url();
  const rec = { t: Date.now(), method: m, url: u, type: req.resourceType() };
  if (m === "POST") {
    const pd = req.postData();
    rec.postDataLen = pd ? pd.length : 0;
    rec.postSample = pd ? pd.slice(0, 400) : "";
    if (pd && (u.includes("Login") || u.includes("Save") || u.includes("ExDec") || u.includes("Create"))) {
      CAP_BODIES.push({ url: u, contentType: req.headers()["content-type"] || "", body: pd.slice(0, 4000) });
    }
  }
  net.push(rec);
});
p.on("response", (res) => {
  const r = net.find((x) => x.url === res.url() && !x.status);
  if (r) { r.status = res.status(); r.ct = (res.headers()["content-type"] || "").slice(0, 40); }
});

const T0 = Date.now();
const step = (m) => console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`);

try {
  step("เปิดหน้า login: " + cfg.url);
  await p.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await p.fill("#UserId", cfg.username);
  await p.fill("#Password", cfg.password);

  // ดู anti-forgery token + form action ในหน้า login (ก่อนกด)
  const loginForm = await p.evaluate(() => {
    const f = document.querySelector("form");
    const tok = document.querySelector('input[name="__RequestVerificationToken"]');
    return { action: f?.getAttribute("action") || "", method: f?.getAttribute("method") || "",
             hasAntiForgery: !!tok, hiddenCount: document.querySelectorAll('input[type=hidden]').length };
  });
  step("form login: action=" + loginForm.action + " method=" + loginForm.method + " antiForgery=" + loginForm.hasAntiForgery + " hidden=" + loginForm.hiddenCount);

  step("กด login…");
  await p.click("#btnSubmit");
  // รอ portfolio (login สำเร็จ) สูงสุด 90s
  const start = Date.now();
  let inOk = false;
  while (Date.now() - start < 90000) {
    if (await p.locator("#portfolio").count().catch(() => 0)) { inOk = true; break; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  step("login " + (inOk ? "สำเร็จ ✓" : "ยังไม่เห็น portfolio ⚠") + " (" + ((Date.now()-start)/1000).toFixed(0) + "s)");
  const cookies = await ctx.cookies();
  step("cookies หลัง login: " + cookies.map(c => c.name).join(", "));

  // เปิดฟอร์มสร้างใบขน (portfolio → BtnAdd) — read-only (ไม่กด Save)
  try {
    await p.click("#portfolio > div > div > div.form-group.col-md-10.col-lg-10.col-sm-10 > div:nth-child(1) > a > img", { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 4000));
    await p.click("#BtnAdd", { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 5000));
    step("เปิดฟอร์มสร้างใบขนแล้ว");
  } catch (e) { step("เปิดฟอร์มสร้างใบขนไม่ครบ: " + (e.message||"").slice(0,60)); }

  // dump โครงสร้างฟอร์มสร้างใบขน (token, hidden fields, kendo)
  const createForm = await p.evaluate(() => {
    const forms = [...document.querySelectorAll("form")].map(f => ({ id: f.id, action: f.getAttribute("action")||"", method: f.getAttribute("method")||"" }));
    const tok = document.querySelector('input[name="__RequestVerificationToken"]');
    return {
      url: location.href, forms,
      hasAntiForgery: !!tok,
      hiddenInputs: document.querySelectorAll('input[type=hidden]').length,
      totalInputs: document.querySelectorAll('input,select,textarea').length,
      kendoWidgets: document.querySelectorAll('.k-widget').length,
    };
  }).catch(() => ({ err: "eval fail" }));
  step("ฟอร์มสร้างใบขน: " + JSON.stringify(createForm));

  // สรุป endpoints (unique)
  const posts = net.filter(n => n.method === "POST");
  const xhr = net.filter(n => n.type === "xhr" || n.type === "fetch");
  writeFileSync(OUT + "/poc-network.json", JSON.stringify({ createForm, loginForm, posts, xhrCount: xhr.length, bodies: CAP_BODIES, allCount: net.length }, null, 1));
  console.log("\n===== สรุป =====");
  console.log("POST endpoints ที่เห็น:");
  [...new Set(posts.map(x => x.method + " " + x.url.replace(/\?.*/, "") + " → " + (x.status||"?")))].forEach(u => console.log("  " + u));
  console.log("\nPOST bodies ที่จับได้: " + CAP_BODIES.length + " (ดูเต็มใน poc-network.json)");
  CAP_BODIES.slice(0,3).forEach(bd => console.log("  " + bd.url.slice(0,70) + "\n    ct=" + bd.contentType + "\n    body[:200]=" + bd.body.slice(0,200).replace(/\n/g," ")));
  console.log("\nไฟล์เต็ม: " + OUT + "/poc-network.json");
} catch (e) {
  console.log("ERROR:", e.message);
} finally {
  await b.close();
}
