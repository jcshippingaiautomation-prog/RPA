import { chromium } from "playwright";
const b = await chromium.launch({ headless: true, proxy: { server: "http://127.0.0.1:8899" } });
const p = await b.newPage();
await p.goto("http://203.154.140.105/DCTK/Account/Login", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(e=>console.log("goto:",e.message));
await new Promise(r=>setTimeout(r,1000));
await b.close();
console.log("done");
