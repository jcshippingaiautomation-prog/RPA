// POC ปลอดภัย: พิสูจน์ login + session + scrape token ผ่าน HTTP ล้วน — ไม่ POST สร้างใบ (read-only)
import { readFileSync } from "node:fs";
const cfg = JSON.parse(readFileSync(new URL("../config.json", import.meta.url)));
const BASE = "http://203.154.140.105/DCTK";
let jar = {};
const cookieHeader = () => Object.entries(jar).map(([k,v])=>`${k}=${v}`).join("; ");
function absorb(res){const sc=res.headers.getSetCookie?res.headers.getSetCookie():[];for(const c of sc){const[kv]=c.split(";");const i=kv.indexOf("=");jar[kv.slice(0,i).trim()]=kv.slice(i+1).trim();}}
async function req(m,p,b,h={}){const res=await fetch(BASE+p,{method:m,redirect:"manual",headers:{"Cookie":cookieHeader(),"User-Agent":"Mozilla/5.0",...h},body:b});absorb(res);return res;}
const tok=(html)=>(html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)||[])[1]||"";
const t0=Date.now(); const T=()=>((Date.now()-t0)/1000).toFixed(2)+"s";

let r=await req("GET","/Account/Login"); let html=await r.text(); const lt=tok(html);
console.log(`[${T()}] GET login: ${r.status} | token=${lt?"✓":"✗"}`);
const lb=new URLSearchParams({__RequestVerificationToken:lt,UserId:cfg.username,Password:cfg.password,RememberMe:"false"}).toString();
r=await req("POST","/Account/Login",lb,{"Content-Type":"application/x-www-form-urlencoded"});
const loc=r.headers.get("location")||"";
console.log(`[${T()}] POST login: ${r.status} ${r.status===302?"→ "+loc.slice(0,40):""} | auth cookies: ${Object.keys(jar).join(", ")}`);
// ตาม 302 ไปหน้าแรก (ยืนยัน session ใช้ได้)
r=await req("GET","/ExDec/Create/"); html=await r.text(); const ft=tok(html);
const loggedIn = !html.includes('id="UserId"'); // ถ้ายังเจอช่อง UserId = ยังไม่ login
console.log(`[${T()}] GET ExDec/Create: ${r.status} | เข้าระบบสำเร็จ=${loggedIn?"✓ ใช่":"✗ (ยังเป็นหน้า login)"} | form token=${ft?"✓":"✗"} | htmlLen=${html.length}`);
console.log(`\n${loggedIn&&ft?"✅ login + session + token ผ่าน HTTP ล้วนได้! (พร้อมยิง Save)":"⚠ ยังไม่ครบ"}  | เวลารวม ${T()}`);
