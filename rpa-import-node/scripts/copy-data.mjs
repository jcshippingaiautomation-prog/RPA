// ก๊อปไฟล์ข้อมูล (ทะเบียนช่อง/กฎ) เข้า dist หลังคอมไพล์
//
// ⚠ ต้องเป็นสคริปต์ node ไม่ใช่คำสั่ง shell
//   เดิม build script ใช้ `mkdir -p` + `cp -f` ซึ่งใช้ไม่ได้บน Windows
//   worker บน VM (Windows) จึงรันได้แค่ `npx tsc` แล้วไฟล์ JSON ไม่ถูกก๊อป
//   → dist/data ค้างของเก่า worker ใช้ทะเบียนช่องคนละรุ่นกับที่ push ขึ้นไป
import { mkdir, copyFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, "src", "data");
const dst = path.join(root, "dist", "data");
await mkdir(dst, { recursive: true });
let n = 0;
for (const f of await readdir(src)) {
  if (!f.endsWith(".json")) continue;
  await copyFile(path.join(src, f), path.join(dst, f));
  n++;
}
console.log(`[build] ก๊อปไฟล์ข้อมูล ${n} ไฟล์ → dist/data`);
