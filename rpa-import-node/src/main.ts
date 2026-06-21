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
  ...(onlyRows.length ? { onlyRows } : {}),
};

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
