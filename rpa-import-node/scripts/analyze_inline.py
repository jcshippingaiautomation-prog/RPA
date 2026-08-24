#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
วิเคราะห์โค้ด JS ที่ฝังในหน้า DCTK → ถอด "กฎของระบบ" ออกมาเป็นข้อมูล

ที่มาไฟล์: node dist/dump-inline-cli.js
  → file download/rules/inline/page{1-edit,2-invoice,3-item}.js

ถอด 5 อย่าง:
  1. กฎเปิด/ปิดช่อง   — ฟังก์ชันไหนสั่ง enable(true/false) กับช่องไหน + เงื่อนไขที่ครอบอยู่
  2. ข้อความแจ้งผู้ใช้ — ข้อความไทยที่ระบบเด้งบอก (= กฎที่ผู้ใช้จะเจอ)
  3. ปลายทางตรวจสอบ  — endpoint ที่ระบบยิงไปถามเซิร์ฟเวอร์ + พารามิเตอร์ที่ส่ง
  4. สูตรคำนวณ       — ช่องไหนถูกคำนวณจากช่องไหน (ห้ามกรอกทับ)
  5. ตัวจุดชนวน      — ช่องไหนมี handler ผูกอยู่ (เปลี่ยนแล้วมีผลต่อช่องอื่น)

รัน: python3 scripts/analyze_inline.py
"""
import json, os, re, sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
INLINE = os.path.join(PKG, "file download", "rules", "inline")
OUT = os.path.join(PKG, "file download", "rules", "inline-analysis.json")

FILES = [("page1-edit.js", 1), ("page2-invoice.js", 2), ("page3-item.js", 3)]


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


def extract_fn(src: str, name: str):
    """ตัดตัวฟังก์ชันออกมาทั้งก้อน (นับวงเล็บปีกกา + ข้าม string)"""
    m = re.search(r"function\s+" + re.escape(name) + r"\s*\([^)]*\)\s*\{", src)
    if not m:
        return None
    i, depth = m.end(), 1
    while i < len(src) and depth > 0:
        c = src[i]
        if c in "\"'":
            q, i = c, i + 1
            while i < len(src) and src[i] != q:
                i += 2 if src[i] == "\\" else 1
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        i += 1
    return src[m.start():i]


def all_functions(src: str):
    return sorted(set(re.findall(r"function\s+([A-Za-z_$][\w$]*)\s*\(", src)))


# ── 1) กฎเปิด/ปิดช่อง ──────────────────────────────────────────────────
ENABLE_RE = re.compile(r"""\$\(\s*["']#([A-Za-z_][\w]*)["']\s*\)\s*\.data\([^)]*\)\s*\.enable\(\s*(true|false|!0|!1)\s*\)""")
READONLY_RE = re.compile(r"""\$\(\s*["']#([A-Za-z_][\w]*)["']\s*\)\s*\.(?:attr|prop)\(\s*["']readonly["']\s*,\s*(true|false|!0|!1)""")
VALUE_SET_RE = re.compile(r"""\$\(\s*["']#([A-Za-z_][\w]*)["']\s*\)\s*\.data\([^)]*\)\s*\.value\(\s*([^)]{0,40})\)""")


def truthy(tok: str) -> bool:
    return tok in ("true", "!0")


def analyze_enable(fnname: str, body: str):
    """หา 'ช่องไหนถูกเปิด/ปิด' พร้อมเงื่อนไข if ที่ครอบอยู่บรรทัดนั้น"""
    out = []
    lines = body.split("\n")
    cond_stack = []          # [(indent, condition text)]
    for ln in lines:
        stripped = ln.strip()
        indent = len(ln) - len(ln.lstrip())
        while cond_stack and indent <= cond_stack[-1][0]:
            cond_stack.pop()
        mif = re.match(r"(?:\}\s*else\s+)?if\s*\((.+?)\)\s*\{?\s*$", stripped)
        if mif:
            cond_stack.append((indent, mif.group(1).strip()[:120]))
            continue
        if re.match(r"\}\s*else\s*\{", stripped) and cond_stack:
            cond_stack[-1] = (cond_stack[-1][0], "NOT(" + cond_stack[-1][1] + ")")
            continue
        for m in ENABLE_RE.finditer(ln):
            out.append({"field": m.group(1), "action": "enable" if truthy(m.group(2)) else "disable",
                        "when": " และ ".join(c for _, c in cond_stack), "fn": fnname})
        for m in READONLY_RE.finditer(ln):
            out.append({"field": m.group(1), "action": "readonly" if truthy(m.group(2)) else "editable",
                        "when": " และ ".join(c for _, c in cond_stack), "fn": fnname})
        for m in VALUE_SET_RE.finditer(ln):
            v = m.group(2).strip()
            out.append({"field": m.group(1), "action": "setvalue", "value": v[:40],
                        "when": " และ ".join(c for _, c in cond_stack), "fn": fnname})
    return out


def main() -> int:
    if not os.path.isdir(INLINE):
        print(f"✗ ไม่พบ {INLINE} — รัน `node dist/dump-inline-cli.js` ก่อน")
        return 1

    result = {"pages": [], "endpoints": [], "messages": []}
    endpoints = defaultdict(set)
    messages = defaultdict(set)

    for fname, page in FILES:
        p = os.path.join(INLINE, fname)
        if not os.path.exists(p):
            print(f"   ⚠ ไม่มี {fname} — ข้าม")
            continue
        src = strip_comments(open(p, encoding="utf-8", errors="ignore").read())
        fns = all_functions(src)

        # 1) กฎเปิด/ปิด/ตั้งค่า
        field_rules = []
        for fn in fns:
            body = extract_fn(src, fn)
            if not body:
                continue
            if ".enable(" in body or "readonly" in body or ".value(" in body:
                field_rules.extend(analyze_enable(fn, body))

        # 3) ปลายทางตรวจสอบ + พารามิเตอร์
        for m in re.finditer(r"""\$urlBase\s*\+\s*["']([\w/]+)["'](?:\s*\+\s*["']/["']\s*\+\s*["']([\w]+)["'])?""", src):
            ep = m.group(1) + ("/" + m.group(2) if m.group(2) else "")
            endpoints[ep].add(page)
        for m in re.finditer(r"""url\s*:\s*url\s*,\s*data\s*:\s*\{([^}]{0,400})\}""", src):
            pass  # เก็บ raw ไว้ในไฟล์ผลลัพธ์แทน

        # 2) ข้อความที่ระบบบอกผู้ใช้
        for m in re.finditer(r"""["']([^"']*(?:ไม่|กรุณา|ต้อง|โปรด|เกิน|ซ้ำ|ผิด)[^"']{0,90})["']""", src):
            t = m.group(1).strip()
            if 6 <= len(t) <= 140 and not t.startswith("//"):
                messages[t].add(page)

        # 5) ตัวจุดชนวน — ช่องที่มี handler ผูก
        triggers = sorted(set(re.findall(r"""(?:change|select|blur|spin)\s*:\s*([A-Za-z_$][\w$]*)""", src)))

        result["pages"].append({
            "page": page, "file": fname,
            "functionCount": len(fns),
            "fieldRules": field_rules,
            "triggers": triggers,
        })
        print(f"   หน้า {page}: ฟังก์ชัน {len(fns)} · กฎเปิด/ปิด/ตั้งค่า {len(field_rules)} · handler {len(triggers)}")

    result["endpoints"] = [{"path": k, "pages": sorted(v)} for k, v in sorted(endpoints.items())]
    result["messages"] = [{"text": k, "pages": sorted(v)} for k, v in sorted(messages.items())]

    json.dump(result, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    total = sum(len(p["fieldRules"]) for p in result["pages"])
    print(f"✓ เขียน {OUT}")
    print(f"   กฎเปิด/ปิด/ตั้งค่ารวม {total} ข้อ · ปลายทางตรวจสอบ {len(result['endpoints'])} · ข้อความ {len(result['messages'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
