// ============================================================
//  POC — Direct HTTP: login + POST /ExDec/Create ตรง ๆ (ไม่ใช้เบราว์เซอร์)
//  พิสูจน์ว่าสร้างใบขนได้ด้วย HTTP ล้วน ๆ + วัดเวลา (user อนุมัติสร้างใบทดสอบ 1 ใบ)
// ============================================================
import { readFileSync } from "node:fs";
const cfg = JSON.parse(readFileSync(new URL("../config.json", import.meta.url)));
const BASE = "http://203.154.140.105/DCTK";
const OUT = process.env.OUT || ".";

let jar = {};
const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
function absorb(res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of sc) { const [kv] = c.split(";"); const i = kv.indexOf("="); jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); }
}
async function req(method, path, body, extraHeaders = {}) {
  const res = await fetch(BASE + path, { method, redirect: "manual",
    headers: { "Cookie": cookieHeader(), "User-Agent": "Mozilla/5.0", ...extraHeaders }, body });
  absorb(res);
  return res;
}
const tokenFrom = (html) => (html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/) || [])[1] || "";
const t0 = Date.now();
const T = () => ((Date.now() - t0) / 1000).toFixed(2) + "s";

// 1) GET login → token
let r = await req("GET", "/Account/Login");
let html = await r.text();
const loginTok = tokenFrom(html);
console.log(`[${T()}] GET login: ${r.status} | token=${loginTok ? "✓" : "✗"}`);

// 2) POST login
const loginBody = new URLSearchParams({ __RequestVerificationToken: loginTok, UserId: cfg.username, Password: cfg.password, RememberMe: "false" }).toString();
r = await req("POST", "/Account/Login", loginBody, { "Content-Type": "application/x-www-form-urlencoded" });
console.log(`[${T()}] POST login: ${r.status} ${r.status === 302 ? "(login OK)" : ""}`);

// 3) GET create form → fresh token
r = await req("GET", "/ExDec/Create/");
html = await r.text();
const formTok = tokenFrom(html);
console.log(`[${T()}] GET ExDec/Create: ${r.status} | formToken=${formTok ? "✓" : "✗"}`);

// 4) POST /ExDec/Create ด้วย template (สลับ token เป็นของ session ปัจจุบัน)
let body = readFileSync(OUT + "/page1-template.txt", "utf8");
body = body.replace(/__RequestVerificationToken=[^&]*/, "__RequestVerificationToken=" + encodeURIComponent(formTok));
r = await req("POST", "/ExDec/Create", body, { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" });
const respText = await r.text();
console.log(`[${T()}] POST ExDec/Create: ${r.status} | ct=${r.headers.get("content-type")} | respLen=${respText.length}`);
console.log("  resp[:500]:", respText.slice(0, 500).replace(/\s+/g, " "));
const ref = (respText.match(/DCTK0\d{9}/) || [])[0];
console.log(`\n${ref ? "✅ สร้างใบขนสำเร็จ! เลข = " + ref : "⚠ ไม่เห็นเลขใบขนในผลลัพธ์ (ดู resp ด้านบน — อาจติด validation/token)"}  | รวมเวลา ${T()}`);
