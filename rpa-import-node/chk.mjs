import { chromium } from "playwright";
const b = await chromium.launch({ headless: true });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
p.on("pageerror", (e) => console.log("JS ERROR:", String(e).slice(0, 140)));
await p.goto("http://localhost:8101", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(2500);
await p.click('a[data-page="masters"]'); await p.waitForTimeout(3000);
await p.locator("#mastersBody tr").first().locator("button:has-text('สร้างใบ')").first().click();
await p.waitForTimeout(4000);
const r = await p.evaluate(() => {
  const sel = document.getElementById("crTemplate");
  return {
    exists: !!sel,
    value: sel?.value ?? null,
    text: sel?.selectedOptions?.[0]?.text ?? null,
    options: sel ? sel.options.length : 0,
    note: document.getElementById("crTplNote")?.textContent ?? "",
    firstSelectId: document.querySelector("#modalCreate select")?.id ?? "(none)",
  };
});
console.log(JSON.stringify(r, null, 1));
await p.screenshot({ path: "/private/tmp/journey2/chk-create.png" });
await b.close();
