// ============================================================
//  แคปหน้าจอใบขนที่มีอยู่แล้วใน DCTK (ทดสอบบนเครื่อง)
//    CAPTURE_REF="DCTK000035766" RPA_HEADLESS=1 node dist/capture-cli.js
//  อ่านอย่างเดียว — ดู capture.ts
// ============================================================
import { captureExistingDeclaration } from "./capture.js";
import { setLogSink } from "./helpers.js";

setLogSink(null);
const ref = (process.env.CAPTURE_REF ?? "").trim();
if (!ref) { console.error("ใส่ CAPTURE_REF=<เลขอ้างอิง DCTK / เลขใบขน / เลขใบกำกับ>"); process.exit(1); }
const headless = !["0", "false", "no"].includes((process.env.RPA_HEADLESS ?? "1").toLowerCase());
const r = await captureExistingDeclaration({ ref, headless });
console.log(JSON.stringify({ pdf: r.pdf, shots: r.shots, invoice: r.invoice, notes: r.notes }, null, 1));
