import { chromium } from "playwright";
// monkey-patch: เติม proxy ให้ทุก launch (runner จะได้วิ่งผ่าน logging proxy)
const orig = chromium.launch.bind(chromium);
chromium.launch = (opts = {}) => orig({ ...opts, proxy: { server: "http://127.0.0.1:8899" } });
const { runImport } = await import("../dist/runner.js");
const idx = Number(process.env.TEST_ROW_INDEX ?? "0");
console.log("=== รัน runImport (ผ่าน proxy) onlyRows=[" + idx + "] ===");
const res = await runImport({
  configOverrides: { headless: false },   // Mac headed (grid render ครบ)
  onlyRows: [idx],
  onLog: (l) => process.stdout.write("· " + l + "\n"),
  onDocument: async () => {},              // ไม่อัปโหลด (แค่ทดสอบ)
});
console.log("=== result:", JSON.stringify(res));
process.exit(0);
