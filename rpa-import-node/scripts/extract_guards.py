#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ถอด "กฎที่ทำให้บันทึกไม่ผ่าน" จากโค้ดในหน้า DCTK

วิธี: หาข้อความที่ระบบเด้งบอกผู้ใช้ แล้วไล่ย้อนขึ้นไปหา `if (...)` ที่ครอบอยู่
      → ได้กฎในรูป "ถ้า <เงื่อนไข> ระบบจะบอกว่า <ข้อความ>"

รัน: python3 scripts/extract_guards.py
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
INLINE = os.path.join(PKG, "file download", "rules", "inline")
OUT = os.path.join(PKG, "file download", "rules", "guards.json")

FILES = [("page1-edit.js", 1), ("page2-invoice.js", 2), ("page3-item.js", 3)]

# ข้อความที่เป็น "กฎ" จริง ๆ (ไม่ใช่ป้ายชื่อช่อง/ข้อความยืนยันทั่วไป)
RULE_HINT = re.compile(r"ต้อง|ไม่สามารถ|กรุณากรอก|กรุณาระบุ|กรุณาเลือก|ไม่เกิน|ไม่น้อยกว่า|ไม่พบข้อมูลใบอนุญาต|ให้ครบถ้วน")
SKIP = re.compile(r"ต้องการลบ|ต้องการบันทึก|ต้องการปรับ|ต้องการ Copy|ที่ต้องการ|ไม่มีสิทธิ|ไม่พบข้อมูลที่ต้องการพิมพ์")


def strip_comments(src: str) -> str:
    """
    ตัดคอมเมนต์ JS ออกก่อนวิเคราะห์ — สำคัญมาก
    DCTK มีกฎที่ "เขียนไว้แล้วปิดทิ้ง" เยอะ (เช่น เช็ค 'เงินต่างประเทศ ... ไม่สามารถเป็น 0 ได้'
    ถูก // ปิดไว้ทั้งชุด) ถ้าไม่ตัดออก จะได้กฎผีที่ระบบจริงไม่ได้บังคับ
    """
    out, i, n = [], 0, len(src)
    while i < n:
        c = src[i]
        if c in "\"'`":                                   # string — คัดลอกทั้งก้อน
            q = c; out.append(c); i += 1
            while i < n and src[i] != q:
                if src[i] == "\\" and i + 1 < n:
                    out.append(src[i]); i += 1
                out.append(src[i]); i += 1
            if i < n: out.append(src[i]); i += 1
        elif c == "/" and i + 1 < n and src[i + 1] == "/":   # คอมเมนต์บรรทัดเดียว
            while i < n and src[i] != "\n": i += 1
        elif c == "/" and i + 1 < n and src[i + 1] == "*":   # คอมเมนต์หลายบรรทัด
            i += 2
            while i + 1 < n and not (src[i] == "*" and src[i + 1] == "/"): i += 1
            i += 2
        else:
            out.append(c); i += 1
    return "".join(out)


def enclosing_conditions(src: str, pos: int, back: int = 2500):
    """ไล่ย้อนจากตำแหน่งข้อความ หา if(...) ที่ยัง 'เปิดอยู่' ครอบบรรทัดนี้"""
    start = max(0, pos - back)
    chunk = src[start:pos]
    conds = []
    # ไล่จากท้ายมาหน้า: เก็บ if ที่ยังไม่ถูกปิดด้วย }
    depth = 0
    i = len(chunk) - 1
    while i >= 0:
        c = chunk[i]
        if c == "}":
            depth += 1
        elif c == "{":
            if depth > 0:
                depth -= 1
            else:
                # เจอ { ที่เปิดค้างอยู่ → ดูว่าเป็นของ if ไหม
                head = chunk[max(0, i - 300):i]
                m = re.search(r"(?:else\s+)?if\s*\(([^{]{1,250})\)\s*$", head.strip())
                if m:
                    conds.append(re.sub(r"\s+", " ", m.group(1)).strip())
        i -= 1
    return list(reversed(conds))[:3]


def main() -> int:
    if not os.path.isdir(INLINE):
        print(f"✗ ไม่พบ {INLINE} — รัน `node dist/dump-inline-cli.js` ก่อน")
        return 1

    guards = []
    for fname, page in FILES:
        p = os.path.join(INLINE, fname)
        if not os.path.exists(p):
            continue
        src = strip_comments(open(p, encoding="utf-8", errors="ignore").read())
        seen = set()
        for m in re.finditer(r"""["']([^"']{6,140})["']""", src):
            text = m.group(1).strip()
            if not RULE_HINT.search(text) or SKIP.search(text):
                continue
            if text in seen:
                continue
            seen.add(text)
            conds = enclosing_conditions(src, m.start())
            # ชื่อฟังก์ชันที่ครอบอยู่ (ดูย้อนหลังหาตัวล่าสุด)
            head = src[max(0, m.start() - 6000):m.start()]
            fm = list(re.finditer(r"function\s+([A-Za-z_$][\w$]*)\s*\(", head))
            guards.append({
                "page": page,
                "message": text,
                "conditions": conds,
                "fn": fm[-1].group(1) if fm else "",
            })

    json.dump(guards, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"✓ เขียน {OUT} — กฎ {len(guards)} ข้อ")
    for g in guards:
        cond = " และ ".join(g["conditions"]) if g["conditions"] else "(ไม่มีเงื่อนไขห่อ — ตรวจตอนกดปุ่ม)"
        print(f"\n  หน้า {g['page']} · {g['fn']}")
        print(f"     ถ้า: {cond[:160]}")
        print(f"     → {g['message'][:110]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
