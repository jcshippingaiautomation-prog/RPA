// ============================================================
//  CLI entry point — delegates to runImport().
//  1:1 behaviour of rpa_import.py (run all rows from the sheet).
//
//  Run:  npm start   (build แล้ว)  หรือ  npm run dev
// ============================================================
import { runImport } from "./runner.js";

// อ่าน mode จาก env (inspect ทั่วไป / inspect-edit หาหน้าค้น-แก้)
const truthy = (v?: string) => ["1", "true", "yes"].includes((v ?? "").trim().toLowerCase());
const onlyRows = (process.env.RPA_ONLY_ROWS ?? "")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n));
const opts = {
  inspect: truthy(process.env.RPA_INSPECT),
  inspectEdit: truthy(process.env.RPA_INSPECT_EDIT),
  // dry run: กรอกฟอร์มจริงทุกช่อง แต่ไม่กด Save/Finalize/Print และไม่ส่งอีเมล
  //   ใช้ทดสอบว่าตัวกรอกทำงานถูกโดยไม่สร้างใบในระบบกรมฯ
  dryRun: truthy(process.env.RPA_DRY_RUN),
  noFinalize: truthy(process.env.RPA_NO_FINALIZE),
  ...(onlyRows.length ? { onlyRows } : {}),
};
if (opts.dryRun) console.log("[RPA] 🧪 DRY RUN — กรอกจริงแต่ไม่บันทึก/ไม่พิมพ์");
else if (opts.noFinalize) console.log("[RPA] 🧪 NO-FINALIZE — บันทึกครบทุกหน้าจริง แต่ไม่ finalize/พิมพ์ (เหลือใบร่างค้างใน DCTK)");

runImport(opts)
  .then((r) => {
    console.log(
      `[RPA] สรุป: total=${r.total} done=${r.done} errors=${r.errors} ` +
        `skipped=${r.skipped}${r.stopped ? " (stopped)" : ""}`,
    );
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
