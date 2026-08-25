#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
แปลงผลถอดเงื่อนไข DCTK (file download/rules/page{1,2,3}.json)
→ src/data/field-rules.json ที่ระบบเราเอาไปตรวจข้อมูลได้เอง

ที่มา: `node dist/rules-cli.js` (ดู src/rules.ts)
  A. data-val-*  = validation จาก model ฝั่ง server ของกรมฯ (บังคับ/ความยาว/ชนิดข้อมูล)
  C. ทดลองสลับค่า = กฎ "ถ้าช่อง X = ค่านี้ แล้วช่อง Y เปิด/ปิด/ถูกตั้งค่าให้"

ผลลัพธ์ผูกกับ key ของ field-registry.json เพื่อให้ฟอร์มและตัวตรวจใช้ร่วมกันได้

รัน: python3 scripts/gen_rules.py
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
RULES_DIR = os.path.join(PKG, "file download", "rules")
REGISTRY = os.path.join(PKG, "src", "data", "field-registry.json")
OUT = os.path.join(PKG, "src", "data", "field-rules.json")

# ข้อความ required ของ DCTK ที่เป็น template ภาษาอังกฤษ = ช่องระบบภายใน ไม่ใช่ช่องที่ผู้ใช้กรอก
GENERIC_MSG = re.compile(r"^The .+ field is required\.$")

# ช่องระบบภายใน (hidden state) — ไม่ต้องเอามาตรวจในฟอร์มเรา
INTERNAL = re.compile(
    r"^(insertWithItem|InvoiceStatus|.*Status|.*Factor|Is[A-Z].*|Use[A-Z].*|"
    r"AssessmentRequestCode|InspectionRequestCode|.*RequestCode)$"
)



# ── กฎข้ามช่องที่ถอดจากโค้ดในหน้า DCTK แล้ว "ยืนยันว่ายังเปิดใช้อยู่" ──
#    ยืนยันด้วย scripts/analyze_inline.py (ตัดคอมเมนต์ก่อนตรวจ)
#    (ไม่ใส่ invoice_no_len / need_items เพราะซ้ำกับ maxLength จาก data-val
#     และกฎ "ต้องมีรายการสินค้า" ใน validate-declaration.ts อยู่แล้ว)
#    ⚠ ที่ไม่ใส่เพราะ DCTK คอมเมนต์ปิดไว้แล้ว — ห้ามเอามาใช้ ไม่งั้นบล็อกใบที่ถูกต้อง:
#       · "น้ำหนักรวมหีบห่อ ต้องไม่น้อยกว่า น้ำหนักสุทธิ" (หน้า 3)
#       · "เงินต่างประเทศ <ค่าใช้จ่าย> ไม่สามารถเป็น 0 ได้" (ทั้งชุด หน้า 1)
CROSS_FIELD = [
    {
        "id": "pay_customs_fee_method",
        "scope": "header",
        "level": "warn",
        "message": "ติ๊ก \"ชำระค่าธรรมเนียม\" แล้ว วิธีชำระภาษีอากรต้องเป็น A หรือ H — DCTK จะถามยืนยันก่อนบันทึก",
        "when": {"field": "is_pay_customs_fee", "isTrue": True},
        "require": {"field": "payment_method", "oneOf": ["A", "H"]},
        "source": "page1 SaveAndClosePopup_Click",
    },
    {
        "id": "invoice_date_le_etd",
        "scope": "header",
        "level": "error",
        "message": "วันที่ใบกำกับฯ ต้องไม่เกินวันที่ส่งออก (ETD) — DCTK ตรวจฝั่งเซิร์ฟเวอร์และไม่ให้บันทึก",
        "when": {"bothNotEmpty": ["invoice_date", "departure_date"]},
        "require": {"dateNotAfter": ["invoice_date", "departure_date"]},
        "source": "ยิงทดลอง ExInvoice/CheckValidateSave",
    },
    {
        "id": "buyer_country_match",
        "scope": "header",
        "level": "warn",
        "message": "รหัสประเทศผู้ซื้อต้องเป็นรหัส 2 ตัวที่กรมฯ รู้จัก — ถ้าไม่ตรงกับที่ระบุในใบขน DCTK จะฟ้อง \"ระหว่างใบขนกับใบกำกับสินค้าไม่ตรงกัน\"",
        "when": {"field": "pur_country_code", "notEmpty": True},
        "require": {"field": "pur_country_code", "matches": "^[A-Za-z]{2}$"},
        "source": "ยิงทดลอง ExInvoice/CheckValidateSave (ZZ / V → ฟ้อง)",
    },
    {
        "id": "avg_by_weight_needs_gross",
        "scope": "header",
        "level": "error",
        "message": "ถ้าเฉลี่ยค่าใช้จ่ายตามน้ำหนัก น้ำหนักรวมหีบห่อต้องมากกว่า 0",
        "when": {"anyFieldEquals": {"field": "freight_average_by", "contains": "น้ำหนัก"}},
        "require": {"field": "total_gross_weight", "greaterThan": 0},
        "source": "page1 (IsAvgFormNetWeight)",
    },
    {
        "id": "permit_group",
        "scope": "item",
        "level": "error",
        "message": "กรอกใบอนุญาตแล้วต้องกรอกให้ครบทั้ง 3 ช่อง (เลขที่ใบอนุญาต · วันที่ออก · เลขประจำตัวผู้เสียภาษีของหน่วยงาน)",
        "when": {"anyNotEmpty": ["permit_no", "permit_issue_date", "permit_authority"]},
        "require": {"allNotEmpty": ["permit_no", "permit_issue_date", "permit_authority"]},
        "source": "page3 BtnAddPermit_click",
    },
    {
        "id": "bis19_group",
        "scope": "item",
        "level": "error",
        "message": "ติ๊กใช้สิทธิ์สูตรขอคืนอากร (ม.19 ทวิ) แล้วต้องกรอกเลขที่สูตรการผลิต · เลขประจำตัวผู้เสียภาษี · เวอร์ชั่น ให้ครบ",
        "when": {"field": "chk_use_bis19", "isTrue": True},
        "require": {"allNotEmpty": ["txt_model_no", "model_cmp_tax_no", "model_version"]},
        "source": "page3 BtnSaveAndAdd_Click (validate == chkUseBis19)",
    },
    {
        "id": "boi_group",
        "scope": "item",
        "level": "error",
        "message": "ติ๊กใช้สิทธิ์ BOI แล้วต้องกรอกเลขที่บัตรส่งเสริม BOI",
        "when": {"field": "chk_use_boi", "isTrue": True},
        "require": {"allNotEmpty": ["txt_boi_license_no"]},
        "source": "page3 switchUseBoi",
    },
]



# ── รายการค่าที่ถูกต้องของกรมฯ (จาก combo-lists.json) ────────────────────
#    รูปแบบที่ดึงมา: แถวแรกเป็นหัวตาราง ("รหัสหน่วยของสินค้า ชื่อหน่วย...")
#    แถวถัดไปเป็น "CODE  คำอธิบาย" → เอา token แรกเป็นรหัส
#    บางช่อง (ประเทศ) เป็นรหัสล้วนไม่มีคำอธิบาย
CODE_RE = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._\-]{0,11})(?:\s|$)")


def parse_codes(items):
    """แปลงรายการที่ดึงจากหน้าจอ → ชุดรหัสที่ใช้ได้จริง"""
    codes = []
    for i, raw in enumerate(items):
        t = (raw or "").strip()
        if not t:
            continue
        # แถวหัวตาราง = มีภาษาไทยตั้งแต่ต้นบรรทัด
        if re.match(r"^[ก-๙]", t):
            continue
        m = CODE_RE.match(t)
        if not m:
            continue
        code = m.group(1)
        # กันคำอังกฤษธรรมดาที่ไม่ใช่รหัส (ยาวเกินและมีตัวพิมพ์เล็กปน)
        if len(code) > 12:
            continue
        codes.append((code, t[m.end():].strip()))
    # คงลำดับ + ตัดซ้ำ
    seen, out = set(), []
    for c, _n in codes:
        if c not in seen:
            seen.add(c); out.append(c)
    return out


def parse_code_names(items):
    """รหัส → ชื่อเต็มตามที่ DCTK แสดง (เช่น TNE → "TONNE (METRIC TON)")

    ใช้จับค่าที่ AI อ่านมาผิดรูปให้เข้ารหัสที่ถูก โดยไม่ต้องเขียนตารางเดาเอง
    (เจอจริง: AI อ่าน "TON" เป็น "TO" ซึ่งกรมฯ ไม่รับ แต่ตรงกับชื่อ TONNE)
    """
    out = {}
    for raw in items:
        t = (raw or "").strip()
        if not t or re.match(r"^[ก-๙]", t):
            continue
        m = CODE_RE.match(t)
        if not m:
            continue
        code = m.group(1)
        if len(code) > 12:
            continue
        name = t[m.end():].strip()
        if code not in out and name:
            out[code] = name
    return out



# ── กฎกระทบยอด "ส่วนควบคุม vs ส่วนรายละเอียด" ────────────────────────────
#    ที่มา: หน้ารายงาน ExDec/ExCheckDiff ("ตรวจสอบรายละเอียดค่าคำนวนต่าง ๆ")
#    กรมฯ เทียบยอดระดับใบกำกับ (ส่วนควบคุม) กับผลรวมของรายการสินค้า (ส่วนรายละเอียด)
#    แล้วแสดง "ผลต่าง" — ถ้าไม่ตรง ใบขนจะติดตอนส่งกรมฯ
#    เทียบทั้งหมด: เงิน 9 รายการ (ราคา/ค่าขนส่ง/ค่าระวาง/ค่าประกัน/ค่าบรรจุ/Inland/Landing/อื่นๆ1-2)
#                  + น้ำหนักและปริมาณ 5 รายการ
#    ที่นี่ใส่เฉพาะรายการที่ "ระบบเรามีข้อมูลทั้ง 2 ฝั่ง" จึงเทียบได้จริง
RECONCILE = [
    # ── เงิน 9 รายการ (key ฝั่งหัวใบกับฝั่งรายการชื่อเดียวกัน คนละ scope) ──
    {"id": "amount", "label": "ราคาสินค้า", "headerKey": "amount_foreign", "itemKey": "amount_foreign", "tolerance": 1, "level": "warn"},
    {"id": "forward", "label": "ค่าขนส่ง", "headerKey": "forward_foreign", "itemKey": "forward_foreign", "tolerance": 1, "level": "warn"},
    {"id": "freight", "label": "ค่าระวาง", "headerKey": "freight_foreign", "itemKey": "freight_foreign", "tolerance": 1, "level": "warn"},
    {"id": "insurance", "label": "ค่าประกัน", "headerKey": "insurance_foreign", "itemKey": "insurance_foreign", "tolerance": 1, "level": "warn"},
    {"id": "pack", "label": "ค่าบรรจุ", "headerKey": "pack_foreign", "itemKey": "pack_foreign", "tolerance": 1, "level": "warn"},
    {"id": "inland", "label": "Inland", "headerKey": "inland_foreign", "itemKey": "inland_foreign", "tolerance": 1, "level": "warn"},
    {"id": "landing", "label": "Landing", "headerKey": "landing_foreign", "itemKey": "landing_foreign", "tolerance": 1, "level": "warn"},
    {"id": "extra1", "label": "ค่าใช้จ่ายอื่น 1", "headerKey": "extra1_foreign", "itemKey": "extra1_foreign", "tolerance": 1, "level": "warn"},
    {"id": "extra2", "label": "ค่าใช้จ่ายอื่น 2", "headerKey": "extra2_foreign", "itemKey": "extra2_foreign", "tolerance": 1, "level": "warn"},
    # ── น้ำหนักและปริมาณ 4 รายการ (ชื่อ key คนละแบบระหว่างหัวใบกับรายการ) ──
    {"id": "net_weight", "label": "น้ำหนักสุทธิ", "headerKey": "total_net_weight", "itemKey": "net_weight", "tolerance": 1, "level": "warn"},
    {"id": "gross_weight", "label": "น้ำหนักรวมหีบห่อ", "headerKey": "total_gross_weight", "itemKey": "gross_weight", "tolerance": 1, "level": "warn"},
    {"id": "package", "label": "จำนวนหีบห่อรวม", "headerKey": "total_package", "itemKey": "package", "tolerance": 0, "level": "warn"},
    {"id": "quantity", "label": "ปริมาณในใบขน", "headerKey": "total_quantity", "itemKey": "quantity", "tolerance": 0.01, "level": "warn"},
]


def load(name):
    p = os.path.join(RULES_DIR, name)
    return json.load(open(p, encoding="utf-8")) if os.path.exists(p) else None


def main() -> int:
    if not os.path.exists(REGISTRY):
        print("✗ ไม่พบ field-registry.json — รัน scripts/gen_registry.py ก่อน")
        return 1
    registry = json.load(open(REGISTRY, encoding="utf-8"))
    # dctkName → นิยามช่องในทะเบียน (แยกตามหน้า เพราะชื่อซ้ำข้ามหน้าได้)
    by_name = {}
    for f in registry:
        by_name.setdefault(f["dctkName"], []).append(f)

    fields = {}          # key ของ registry → กฎ
    deps = []            # กฎความสัมพันธ์
    unmapped = set()     # ช่องที่ DCTK มีกฎ แต่ทะเบียนเราไม่มี (เผื่อไว้ดู)

    for fname, page in (("page1.json", 1), ("page2.json", 2), ("page3.json", 3)):
        data = load(fname)
        if not data:
            print(f"   ⚠ ไม่มี {fname} — ข้ามหน้า {page}")
            continue

        for r in data["rules"]:
            name = r["name"]
            cands = [f for f in by_name.get(name, []) if f["page"] == page] or by_name.get(name, [])
            if not cands:
                if r["raw"] and not INTERNAL.match(name):
                    unmapped.add(f"p{page}:{name}")
                continue
            f = cands[0]
            msg = r.get("requiredMessage") or ""
            rule = {}
            # ⚠ "บังคับ" ที่เอามาตรวจได้ ต้องเป็นช่องที่ "ผู้ใช้กรอกเอง" เท่านั้น
            #   DCTK ตั้ง required ให้ช่องที่ตัวเองคำนวณด้วย (อัตราแลกเปลี่ยน/เงินบาท/ราคาประเมิน)
            #   ถ้าเอามาตรวจ จะขึ้นแดงทั้งใบทั้งที่ไม่ใช่หน้าที่ผู้ใช้
            user_fills = not f["computed"]
            if user_fills:
                if msg and not GENERIC_MSG.match(msg):
                    rule["required"] = True
                    rule["requiredMessage"] = msg
                elif r.get("required") and not INTERNAL.match(name):
                    rule["required"] = True
            mx = r.get("maxLength", -1)
            if isinstance(mx, int) and 0 < mx < 100000:
                rule["maxLength"] = mx
            if r.get("dataType"):
                rule["dataType"] = r["dataType"]
            if r.get("regex"):
                rule["regex"] = r["regex"]
                rule["regexMessage"] = r.get("regexMessage") or ""
            if r.get("rangeMin") or r.get("rangeMax"):
                rule["rangeMin"] = r.get("rangeMin")
                rule["rangeMax"] = r.get("rangeMax")
            if r.get("cascadeFrom"):
                rule["cascadeFrom"] = r["cascadeFrom"]
            if not rule:
                continue
            key = f"{f['scope']}:{f['key']}"
            # ช่องเดียวกันอาจเจอหลายหน้า → รวมกฎ (เอาที่เข้มกว่า)
            cur = fields.setdefault(key, {"key": f["key"], "scope": f["scope"], "label": f["label"], "dctkName": name})
            for k, v in rule.items():
                if k == "maxLength" and "maxLength" in cur:
                    cur[k] = min(cur[k], v)
                else:
                    cur.setdefault(k, v)

        # ── กฎความสัมพันธ์ ──
        for d in data.get("dependencies", []):
            drv = [f for f in by_name.get(d["driver"], []) if f["page"] == page] or by_name.get(d["driver"], [])
            if not drv:
                continue
            effects = []
            for e in d["effects"]:
                tgt = [f for f in by_name.get(e["field"], []) if f["page"] == page] or by_name.get(e["field"], [])
                if not tgt:
                    continue                    # ช่องระบบภายใน ไม่ต้องบอกผู้ใช้
                t = tgt[0]
                ch = e["change"]
                kind = ("disable" if "ปิด" in ch or "อ่านอย่างเดียว" in ch
                        else "enable" if "เปิด" in ch or "แก้ไขได้" in ch
                        else "require" if "บังคับ" in ch
                        else "autofill")
                effects.append({
                    "key": t["key"], "scope": t["scope"], "label": t["label"],
                    "change": ch, "kind": kind, "from": e["from"], "to": e["to"],
                })
            # เหลือเฉพาะผลที่ผู้ใช้ต้องรู้: ช่องถูกปิด/เปิด/บังคับ หรือค่าถูกเขียนทับ
            effects = [e for e in effects if e["kind"] != "autofill"
                       or not any(f["key"] == e["key"] and f["computed"] for f in registry)]
            if not effects:
                continue
            deps.append({
                "page": page,
                "driverKey": drv[0]["key"], "driverScope": drv[0]["scope"], "driverLabel": drv[0]["label"],
                "value": d["value"], "valueLabel": d["valueLabel"],
                "effects": effects,
            })

    # ── ตารางเงื่อนไข Incoterms (จาก endpoint Term/GetFactor ของกรมฯ) ──
    #    Factor = 0 → DCTK ปิดช่องค่าใช้จ่ายนั้น + ล้างค่าเป็น 0
    #    นี่คือกฎ "ทางการ" ที่แม่นที่สุด — แม่นกว่าการทดลองสลับทีละค่า
    terms = []
    tf = load("term-factors.json")
    if tf and tf.get("table"):
        for t in tf["table"]:
            terms.append({
                "term": t["term"],
                "allowed": t["allowed"],
                "blocked": t["blocked"],
                "blockedKeys": sorted(set(t["blockedKeys"])),
            })

    # ── รายการค่าที่ถูกต้อง (หน่วย/สกุลเงิน/ประเทศ/ท่าเรือ/พิกัด) ──
    #    ช่องหลายช่องใช้ "รายการเดียวกัน" (เช่นสกุลเงินทุกแถวในตารางราคา)
    #    → รวมรหัสข้ามช่องที่เป็นชนิดเดียวกัน จะได้รายการที่ครบที่สุด
    LIST_TYPE = [
        ("currency", "สกุลเงิน", re.compile(r"^_[A-Za-z0-9]+_input$")),
        ("weight_unit", "หน่วยน้ำหนัก", re.compile(r"^(Net|Gross)WeightUnitCode_input$")),
        ("quantity_unit", "หน่วยปริมาณ", re.compile(r"^(InvQuantity|Quantity)UnitCode_input$")),
        ("package_unit", "หน่วยหีบห่อ", re.compile(r"^PackageUnitCode_input$")),
        ("country", "รหัสประเทศ", re.compile(r"^(Pur|Dest|Origin)CountryCode$")),
        ("port", "รหัสสถานที่", re.compile(r"^(Released|Loaded)Port_input$")),
        ("export_tariff", "ประเภทพิกัดขาออก", re.compile(r"^ExportTariff_input$")),
        ("tariff", "พิกัดศุลกากร", re.compile(r"^TariffCode$")),
        ("privilege", "รหัสสิทธิพิเศษ", re.compile(r"^PrivilegeCode_input$")),
    ]
    # ชนิดที่ "เชื่อได้ว่าครบ" — กวาดทุกตัวอักษรแล้วจำนวนสมเหตุสมผล
    #   ประเทศ/พิกัด/สินค้า ไม่ใส่ เพราะ popup แสดงทีละไม่กี่รายการ (virtualized) → ได้ไม่ครบ
    #   country: กวาดครบได้ 253 ค่า = จำนวนประเทศจริงตาม ISO → เชื่อได้
    RELIABLE = {"currency", "weight_unit", "quantity_unit", "package_unit", "export_tariff", "country"}

    merged: dict = {}
    cl = load("combo-lists.json") or []
    for c in cl:
        codes = parse_codes(c.get("items") or [])
        if len(codes) < 2:
            continue
        for tid, tlabel, rx in LIST_TYPE:
            if not rx.match(c["dctkName"]):
                continue
            m = merged.setdefault(tid, {"id": tid, "label": tlabel, "codes": [], "names": {}, "deep": False, "fromFields": []})
            m["names"].update(parse_code_names(c.get("items") or []))
            for x in codes:
                if x not in m["codes"]:
                    m["codes"].append(x)
            m["deep"] = m["deep"] or str(c.get("seedUsed", "")).startswith("กวาดลึก")
            # รายการที่ "ชนเพดาน" ของรอบที่ดึง = ยังไม่ครบ → ห้ามเอาไปตัดสินว่าค่าผิด
            #   เพดานอ่านจากไฟล์ผลเอง (COMBO_MAX ที่ใช้ตอนดึง) ไม่ hard-code
            cap = c.get("cap") or 400
            if len(c.get("items") or []) >= cap:
                m["truncated"] = True
            if c["dctkName"] not in m["fromFields"]:
                m["fromFields"].append(c["dctkName"])
            break

    # ผูกชนิดรายการเข้ากับช่องในทะเบียน
    value_lists = []
    for tid, tlabel, rx in LIST_TYPE:
        m = merged.get(tid)
        if not m:
            continue
        fields_using = [
            {"key": f["key"], "scope": f["scope"], "column": f["column"], "label": f["label"]}
            for f in registry if rx.match(f["dctkName"]) and not f["computed"]
        ]
        value_lists.append({
            "id": tid, "label": tlabel,
            "codes": sorted(m["codes"]), "count": len(m["codes"]),
            "names": {c: m["names"][c] for c in sorted(m["codes"]) if c in m.get("names", {})},
            "deepSwept": m["deep"],
            "reliable": tid in RELIABLE and m["deep"] and not m.get("truncated"),
            "truncated": bool(m.get("truncated")),
            "fields": fields_using,
        })

    out = {"fields": list(fields.values()), "dependencies": deps, "incoterms": terms,
           "valueLists": value_lists,
           "incotermsToTerm": (tf or {}).get("toTermCode", "FOB"),
           "crossField": CROSS_FIELD, "reconcile": RECONCILE}
    json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    kinds = {}
    for d_ in deps:
        for e in d_["effects"]:
            kinds[e["kind"]] = kinds.get(e["kind"], 0) + 1
    req = sum(1 for f in out["fields"] if f.get("required"))
    mxl = sum(1 for f in out["fields"] if f.get("maxLength"))
    print(f"✓ เขียน {OUT}")
    print(f"   ช่องที่มีกฎ {len(out['fields'])} · บังคับกรอก {req} · จำกัดความยาว {mxl}")
    print(f"   กฎความสัมพันธ์ (ถ้า X แล้ว Y) {len(deps)} ข้อ · ผลกระทบ {kinds}")
    print(f"   ตารางเงื่อนไข Incoterms {len(terms)} แบบ (แปลงราคาไป {out['incotermsToTerm']})")
    print(f"   กฎข้ามช่องที่ยืนยันแล้ว {len(CROSS_FIELD)} ข้อ")
    print(f"   กฎกระทบยอด (ควบคุม vs รายละเอียด) {len(RECONCILE)} รายการ")
    rel = [v for v in value_lists if v["reliable"]]
    print(f"   รายการค่าที่ถูกต้อง {len(value_lists)} ชนิด (เชื่อได้ว่าครบ {len(rel)} ชนิด)")
    for v in value_lists:
        mark = "✓ ใช้ตรวจได้" if v["reliable"] else ("  ยังไม่ครบ (ถูกตัด)" if v.get("truncated") else "  อ้างอิงเท่านั้น")
        print(f"      {mark} {v['label']:<18} {v['count']:>4} ค่า · ใช้กับ {len(v['fields'])} ช่อง")
    if unmapped:
        print(f"   ℹ ช่องที่ DCTK มีกฎแต่ทะเบียนเราไม่มี {len(unmapped)} ช่อง (ส่วนใหญ่เป็นช่องระบบ)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
