// ============================================================
//  Inspect CLI — รัน RPA โหมดสำรวจ element (ไม่กรอก/ไม่ Save)
//  วิธีใช้: node dist/inspect-cli.js
//  ต้องมี config.json (url/credentials) + อย่างน้อย 1 record ใน Supabase
// ============================================================
import { runImport } from "./runner.js";

const result = await runImport({
  inspect: true,
  onLog: (line) => console.log(line),
});
console.log("\n=== inspect result ===", JSON.stringify(result));
