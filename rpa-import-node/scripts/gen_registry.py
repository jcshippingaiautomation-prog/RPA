#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
สร้าง field-registry.json จากผลสำรวจจริงของ DCTK (file download/survey/page{1,2,3}.json)

ที่มาของข้อมูล: `node dist/survey-cli.js` (ดู src/survey.ts)
  → เปิดใบขนจริงใน DCTK แล้วอ่านทุก element ของทั้ง 3 หน้า ครบทุกแท็บ
  → ได้ name/label/กลุ่ม/ชนิด/บังคับ/อ่านอย่างเดียว/selector/ตัวเลือก ครบ

สิ่งที่สคริปต์นี้ทำเพิ่มจากข้อมูลดิบ:
  1. ตั้ง key ที่เสถียร (มาจาก name จริงของ DCTK ไม่ใช่เดา)
  2. ปะป้ายชื่อไทยให้ช่องที่ label ว่าง โดยเฉพาะ "ตารางราคา" ที่ชื่อช่องเป็นแพตเทิร์น
     _<แถว><คอลัมน์> เช่น _FreightForeign = ค่าระวาง — เงินต่างประเทศ
  3. ผูกกับคอลัมน์จริงใน Supabase (ตาราง COLUMN_MAP) — ที่เหลือเก็บใน extra_fields
  4. ทำเครื่องหมาย computed (DCTK เติม/คำนวณเอง) จาก readonly/disabled + รายการที่รู้ว่า auto
  5. ทำเครื่องหมาย fill (มี logic กรอกเฉพาะทางใน pages.ts อยู่แล้ว)

รัน: python3 scripts/gen_registry.py
"""
import json, os, re, sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)                       # rpa-import-node
SURVEY = os.path.join(PKG, "file download", "survey")
OUT = os.path.join(PKG, "src", "data", "field-registry.json")

# ── ตารางราคา: ชื่อช่องเป็นแพตเทิร์น _<แถว><คอลัมน์> ────────────────────
PRICE_ROWS = {
    "UnitPrice": "ราคา/หน่วย", "Amount": "ราคา", "Forward": "ค่าขนส่ง",
    "Freight": "ค่าระวาง", "Insurance": "ค่าประกัน", "Pack": "ค่าบรรจุ",
    "Inland": "Inland", "Landing": "Landing",
    "Extra1": "ค่าใช้จ่ายอื่น 1", "Extra2": "ค่าใช้จ่ายอื่น 2",
}
PRICE_COLS = {
    "_input": "สกุลเงิน", "ExchangeRate": "อัตราแลกเปลี่ยน",
    "Foreign": "เงินต่างประเทศ", "Baht": "เงินบาท",
    "AverageBy": "วิธีเฉลี่ยค่าใช้จ่าย", "TermFactor": "ปัจจัยเงื่อนไข",
    "ChargeCode": "ประเภทค่าใช้จ่าย",
}
PRICE_RE = re.compile(r"^_(" + "|".join(PRICE_ROWS) + r")(" + "|".join(re.escape(c) for c in PRICE_COLS) + r")$")

# ── ชื่อ DCTK → คอลัมน์จริงใน Supabase ──────────────────────────────────
#   ไม่มีในตารางนี้ = เก็บใน extra_fields jsonb (เพิ่มช่องใหม่ไม่ต้อง migrate DB)
COLUMN_MAP_HEADER = {
    "DeclarationNo": "declaration_no",
    "DepartureDate": "etd",
    "ExDecDocType": "exdec_doc_type",
    "CmpNameThai": "customer_name",
    "TransportMode": "transport_mode",
    "VesselName_input": "vessel_name",
    "Voyage": "voyage_number",
    "ReleasedPort_input": "release_port_code",
    "LoadedPort_input": "loading_port_code",
    "Mawb": "mawb",
    "Hawb": "hawb",
    "ReferenceNoCommon": "reference_no",
    "ShippingMark": "shipping_mark",
    "PaymentMethod": "tax_payment_method_code",
    "DestCountryCode": "destination_country_code",
    "TotalPackage": "container_or_volume_qty",
    "TotalPackageUnitCode": "container_unit_code",
    # หน้า 2 (ใบกำกับ)
    "InvoiceNo": "invoice_number",
    "InvoiceDate": "invoice_date",
    "_TermCode": "incoterms",
    "ConsigneeName_input": "consignee_name",
    "PurCountryCode": "buyer_country_code",
    "_Amount_input": "currency",
    "_AmountForeign": "total_goods_amount",
    "_FreightForeign": "freight_charge",
    "_InsuranceForeign": "insurance_charge",
    "TotalNetWeight": "net_weight_kg",
    "TotalGrossWeight": "gross_weight_kg",
    "TotalQuantity": "net_weight_ton",
}
COLUMN_MAP_ITEM = {
    "ProductCode_input": "description_eng",
    "ProductDescriptionEng": "description_eng_field",
    "ProductDescriptionThai": "product_description_thai",
    "Brand": "brand_name",
    "ExportTariff_input": "export_tariff",
    "InvQuantity": "net_weight_ton",
    "InvQuantityUnitCode_input": "net_weight_unit_code",
    "QuantityUnitCode_input": "customs_unit_code",
    "NetWeight": "net_weight_kg",
    "GrossWeight": "gross_weight_kg",
    "Package": "container_or_volume_qty",
    "PackageUnitCode_input": "container_unit_code",
    "_AmountForeign": "amount",
    "_InsuranceForeign": "insurance",
    # ⚠ ไม่ผูก NatureTrans → is_foc: NatureTrans เป็นรหัส (11/21/90) แต่ is_foc เป็น boolean
    #   ของแถมมีติ๊ก "ของแถม (FOC)" ในการ์ดรายการอยู่แล้ว → NatureTrans เก็บเป็นช่องเสริม
}

# ── ช่องที่ RPA มี logic กรอกเฉพาะทางอยู่แล้วใน pages.ts ────────────────
FILLED_HEADER = {
    "PurCountryCode", "DestCountryCode", "VesselName_input", "Voyage",
    "ReleasedPort_input", "LoadedPort_input", "ShippingMark", "Mawb", "Hawb",
    "ReferenceNoCommon", "TransportMode", "ExDecDocType", "PaymentMethod",
    "DepartureDate", "CmpNameThai", "InvoiceNo", "InvoiceDate", "_TermCode",
    "ConsigneeName_input", "_Amount_input", "_AmountForeign", "_FreightForeign",
    "_InsuranceForeign", "TotalNetWeight", "TotalGrossWeight",
}
FILLED_ITEM = {
    "ProductCode_input", "InvQuantity", "InvQuantityUnitCode_input", "Quantity",
    "QuantityUnitCode_input", "NetWeight", "GrossWeight", "Package",
    "PackageUnitCode_input", "_AmountForeign", "_InsuranceForeign", "_Freight_input",
    "NatureTrans", "Brand", "ProductDescriptionThai", "ProductDescriptionEng",
    "ExportTariff_input",
}

# ── ช่องที่ DCTK เติม/คำนวณให้เอง (ห้ามกรอกทับ) นอกเหนือจาก readonly ────
FORCE_COMPUTED = {
    "ReferenceNo", "DeclarationNo", "CustomsCheckingStatusName", "PaymentNo",
    "ItemNo", "InvItemNo", "CmpTaxNo", "CmpNameThai", "CmpBrnNo",
    "PurCountryName", "DestCountryName", "OriginCountryName",
    "ReleasedPortName", "LoadedPortName", "TariffSeqDescription", "GoodsUnitCode",
    "FobCurrencyCode", "FobExchangeRate", "FobForeign", "FobBaht", "FobAssess",
    "TotalFobCurrencyCode", "TotalFobExchangeRate", "TotalFobForeign",
    "TotalFobBaht", "TotalFobAssess",
    "ExDutyAmount", "ExDutyAmountPay", "DepositAmount",
    # ช่อง "สาขา" — DCTK เติมให้เองหลังเลือกเลขประจำตัวผู้เสียภาษี
    #   ถ้าปล่อยให้ตัวกรอกทั่วไปพยายามกรอก จะ timeout ทุกใบ (เจอจริงตอน dry run)
    "CmpBrnNo", "BrkBrnNo", "SubBrkBrnNo", "TradingCmpBrnNo", "ExportFromAuthorityBrnNo",
    # โปรไฟล์ที่จะบันทึก = ตัวเลือกของระบบ ไม่ใช่ข้อมูลใบขน
    "defaultReferenceNo",
    # ประเภทการบรรจุ — DCTK ตั้งให้เองตามวิธีขนส่ง (ยืนยันจากการทดลองสลับค่า)
    "CargoPackingType",
}
# "ปัจจัยเงื่อนไข" (…TermFactor) — DCTK คำนวณจากตาราง Incoterms (Term/GetFactor)
# "วิธีเฉลี่ยค่าใช้จ่าย" (…AverageBy) — DCTK เปิดให้เฉพาะใบหลายรายการ
# ทั้งสองกลุ่มกรอกไม่ได้จริง (ยืนยันจากการรันจริง: ข้ามทั้ง 20 ช่อง) → ไม่ต้องพยายามกรอก
COMPUTED_SUFFIXES = ("TermFactor", "AverageBy")

# ช่อง "สถานะ/ประวัติการรับส่งข้อมูล" ของ DCTK — เป็นผลลัพธ์หลังยื่น ไม่ใช่ข้อมูลที่คนกรอก
#   เช่น วัน/เวลาที่ส่งข้อมูลไปกรมฯ · รหัสข้อผิดพลาดจากกรมฯ · จำนวนครั้งที่ส่ง
#   DCTK มาร์คว่า required (เพราะตอน submit มันเติมค่าเอง) เลยไม่โดนตัดด้วย computed
#   → ติดธง system เพื่อ "ซ่อนจากฟอร์ม" อย่างเดียว ข้อมูลยังอยู่ครบและ RPA ยังกรอกเหมือนเดิม
SYSTEM_LABEL_RE = re.compile(
    r"(สถานะ|วัน/เวลา|จำนวนครั้ง|ข้อความจาก|รหัสข้อผิดพลาด|รหัสผู้ใช้ที่เลือก"
    r"|เลขที่ชำระอากร|เลขที่รับงาน|ลงลายเซ็นโดย|แนบไฟล์)"
)
# ยกเว้น: readonly แต่ผู้ใช้ควรตั้งค่าได้จริง (DCTK ปลดล็อกเมื่อเลือกเงื่อนไขบางอย่าง)
#   + 2 ช่องที่ DCTK ล็อก แต่ "ระบบเรา" ต้องให้ผู้ใช้กรอกเอง:
#     DeclarationNo = ผู้ใช้วางเลขใบขนเพื่อให้ RPA ไปค้นใบเดิมมาแก้
#     CmpNameThai   = ชื่อผู้ส่งออก ใช้เป็นคำค้นบริษัทใน DCTK [[customer-name-is-dctk-search]]
NOT_COMPUTED = {
    "TotalPackage", "TotalPackageUnitCode", "TotalQuantity",
    "TotalNetWeightUnitCode", "TotalGrossWeightUnitCode",
    "DeclarationNo", "CmpNameThai",
}

# ── ช่องที่อยากให้ AI สกัดจากเอกสาร ────────────────────────────────────
AI_FIELDS = set(COLUMN_MAP_HEADER) | set(COLUMN_MAP_ITEM) | {
    "PoNumber", "TermPayment", "ConsigneeStreetAndNo", "ConsigneeDistrictName",
    "ConsigneeSubProvinceName", "ConsigneeProvinceName", "ConsigneePostCode",
    "ConsigneeEmailAddress", "OriginCountryCode", "TariffCode", "ProductYear",
}



# ── ป้ายชื่อไทยที่ต้องเขียนเอง ─────────────────────────────────────────
#    ช่องพวกนี้ DCTK ไม่มี label ข้าง ๆ (หรือ label เป็นค่าของช่องเอง)
#    ตัวสร้างอัตโนมัติจึงได้แค่ชื่อ field ภาษาอังกฤษ
LABEL_OVERRIDE = {
    "defaultReferenceNo": "โปรไฟล์ที่จะบันทึก",
    "TotalFobExchangeRate": "อัตราแลกเปลี่ยน (FOB รวม)",
    "TotalQuantity": "ปริมาณในใบขน (รวม)",
    "Note1": "หมายเหตุ",
    "PurCountryCode": "รหัสประเทศผู้ซื้อ",
    "PurCountryName": "ชื่อประเทศผู้ซื้อ",
    "DestCountryCode": "รหัสประเทศปลายทาง",
    "DestCountryName": "ชื่อประเทศปลายทาง",
    "CmpBrnNo": "สาขา (ผู้ส่งออก)",
    "CmpTaxNo": "เลขประจำตัวผู้เสียภาษี (ผู้ส่งออก)",
    "CmpNameThai": "ชื่อผู้ส่งออก",
    "ManagerCardNo": "บัตรผู้จัดการ",
    "ExportFromAuthorityBrnNo": "สาขาผู้ส่งออกในนาม",
    "BrkBrnNo": "สาขา (ตัวแทนออกของ)",
    "Mawb": "MAWB (เลขขนส่งทางอากาศหลัก)",
    "Hawb": "HAWB / B/L (ใบตราส่ง)",
    "ShippingMark": "เลขหมายหีบห่อ",
    "ExportTaxIncentivesId": "สิทธิประโยชน์ทางภาษี (รหัส)",
    "TradingCmpBrnNo": "สาขา (ผู้ขาย)",
    "TotalCustomsFee": "ค่าธรรมเนียมศุลกากรรวม",
    "UseAeosNoOf": "ใช้เลข AEO ของ",
    "upload": "แนบไฟล์",
    "_TermCode": "เงื่อนไขการส่งมอบ (Incoterms)",
    "ProductCode": "รหัสสินค้า",
    "CustomsProductCode": "Part No / Product Code",
    "RtcProductCode": "รหัสสินค้ากรมศุลกากร",
    "ListModelNo": "รายการสูตรการผลิต",
    "ListBis19TransferNo": "รายการตารางโอนสิทธิ",
    "ListBoiLicenseNo": "รายการบัตรส่งเสริม BOI",
    "_IncreasedUnitPrice": "ราคาเพิ่ม/หน่วย — สกุลเงิน",
    "_IncreasedUnitPriceExchangeRate": "ราคาเพิ่ม/หน่วย — อัตราแลกเปลี่ยน",
    "_IncreasedUnitPriceForeign": "ราคาเพิ่ม/หน่วย — เงินต่างประเทศ",
    "_IncreasedUnitPriceBaht": "ราคาเพิ่ม/หน่วย — เงินบาท",
    "_IncreasedUnitPriceBy": "ราคาเพิ่ม/หน่วย — วิธีเฉลี่ย",
    "_IncreasedTermFactor": "ราคาเพิ่ม/หน่วย — ปัจจัยเงื่อนไข",
}



# ── หน้าในฟอร์มของเรา (formPage) แยกจากหน้าใน DCTK (page) ───────────────
#    ที่ประชุมตกลงว่า "จะจบอยู่ที่หน้า 3 ไม่ได้ ต้องมีหน้า 4"
#    ในระบบกรมฯ สิทธิประโยชน์เป็น "แท็บที่ 2 ของหน้า 3" แต่ผู้ใช้มองว่าเป็นอีกหน้า
#    → ฟอร์มเราแยกเป็นหน้า 4 ให้ตรงกับที่ผู้ใช้เข้าใจ ส่วน page ยังเป็น 3 เพื่อให้ RPA กรอกถูกที่
FORM_PAGE_4_GROUPS = {
    "สิทธิประโยชน์ต่าง ๆ",
    "สิทธิประโยชน์ทางภาษี",
    "การรับรองถิ่นกำเนิดสินค้าด้วยตนเอง",
    "เลขที่ใบอนุญาต",
    "ภาษีอากร/การวางประกัน",
}


def to_key(name: str) -> str:
    """name ของ DCTK → key แบบ snake_case ที่อ่านง่ายและเสถียร"""
    n = name
    if n.endswith("_input"):
        n = n[:-6]
    n = n.lstrip("_")
    n = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", n)
    return n.lower()


def nice_label(f: dict) -> str:
    """ป้ายชื่อไทยที่อ่านรู้เรื่อง — ปะให้ช่องที่ label ว่าง/กำกวม"""
    name = f["name"]
    if name in LABEL_OVERRIDE:
        return LABEL_OVERRIDE[name]
    m = PRICE_RE.match(name)
    if m:
        return f"{PRICE_ROWS[m.group(1)]} — {PRICE_COLS[m.group(2)]}"
    lab = (f.get("label") or "").strip().rstrip("*").strip()
    # label ที่เป็น "ค่าปัจจุบันของช่อง" ไม่ใช่ชื่อช่อง (เช่น "CIF", "0") → ทิ้ง
    if lab and lab == (f.get("value") or "").strip():
        lab = ""
    if not lab or len(lab) < 2:
        lab = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", name.lstrip("_")).replace("_input", "").strip()
    return lab



def disambiguate(rows: list) -> int:
    """
    ป้ายชื่อซ้ำในกลุ่มเดียวกัน → เติมคำขยายจากชนิดของช่อง
    DCTK วางหลายช่องไว้ใต้ป้ายเดียว (เช่น "รหัสธนาคารค้ำประกัน" = รหัส + สาขา + ชื่อ)
    ผู้ใช้ต้องแยกออกว่าช่องไหนคืออะไร
    """
    from collections import defaultdict
    groups = defaultdict(list)
    for r in rows:
        groups[(r["page"], r["group"], r["label"])].append(r)

    def qualifier(name: str) -> str:
        if "UnitCode" in name:                              return "— หน่วย"
        if "BranchCode" in name or name.endswith("BrnNo"):  return "(สาขา)"
        if name.endswith(("Name", "NameThai", "Description")): return "(ชื่อ)"
        if name.startswith("chk"):                          return "(ตัวเลือก)"
        if name.endswith(("Code", "No", "Id")):             return "(รหัส)"
        return ""

    fixed = 0
    for rs in groups.values():
        if len(rs) < 2:
            continue
        for r in rs:
            q = qualifier(r["dctkName"])
            if not q:
                continue
            r["label"] = f"{r['label']} {q}"
            fixed += 1
        # ยังซ้ำอยู่ (คำขยายเหมือนกัน) → ต่อท้ายด้วยชื่อจริงใน DCTK ให้แยกออกแน่ ๆ
        seen_lab = {}
        for r in rs:
            if r["label"] in seen_lab:
                r["label"] = f"{r['label']} [{r['dctkName']}]"
                fixed += 1
            else:
                seen_lab[r["label"]] = True
    return fixed


def main() -> int:
    files = [("page1.json", 1), ("page2.json", 2), ("page3.json", 3)]
    missing = [f for f, _ in files if not os.path.exists(os.path.join(SURVEY, f))]
    if missing:
        print(f"✗ ไม่พบไฟล์สำรวจ {missing} ใน {SURVEY}")
        print("  รันสำรวจก่อน:  set -a; . ../rpa-web/.env; set +a; SURVEY_DECL_NO=<เลขใบขน> node dist/survey-cli.js")
        return 1

    out, seen = [], set()
    for fname, page in files:
        raw = json.load(open(os.path.join(SURVEY, fname), encoding="utf-8"))
        scope = "item" if page == 3 else "header"
        colmap = COLUMN_MAP_ITEM if scope == "item" else COLUMN_MAP_HEADER
        filled = FILLED_ITEM if scope == "item" else FILLED_HEADER

        for f in raw:
            if f["inGrid"]:
                continue                       # ช่อง filter ในตาราง ไม่ใช่ช่องกรอก
            name = f["name"]
            if not name:
                continue                       # อ้างอิงไม่ได้ → ข้าม
            key = to_key(name)

            # ⚠ ห้ามใช้ readonly ตัดสินว่า "DCTK เติมเอง"
            #   เพราะผลสำรวจหน้า 2/3 มาจากการเปิด "ใบเก่า" ซึ่ง DCTK ล็อกหลายช่องไว้
            #   ทั้งที่ตอนสร้างใบใหม่กรอกได้ → ถ้าเชื่อ readonly จะซ่อนช่องที่ผู้ใช้ต้องกรอกจริง
            #   ใช้เฉพาะ disabled + รายชื่อที่ยืนยันแล้วว่า DCTK คำนวณให้เอง
            computed = (
                f["disabled"]
                or name in FORCE_COMPUTED
                or name.endswith(COMPUTED_SUFFIXES)
            ) and name not in NOT_COMPUTED
            out.append({
                "key": key,
                "label": nice_label(f),
                "page": page,
                "formPage": 4 if (f["group"] or "") in FORM_PAGE_4_GROUPS else page,
                "group": f["group"] or "อื่น ๆ",
                "type": f["kind"],
                "selector": f["selector"],
                "selectorConst": None,
                "column": colmap.get(name),
                "scope": scope,
                "fill": name in filled,
                "computed": computed,
                "system": bool(SYSTEM_LABEL_RE.search(nice_label(f))),
                "ai": name in AI_FIELDS,
                "required": f["required"],
                "readonlyInDctk": f["readonly"],
                "dctkName": name,              # ชื่อจริงใน DCTK (ใช้ debug/จับคู่)
                "options": f["options"][:100],
                "catalogKey": None,
            })

    # ── ตัดช่องซ้ำ ────────────────────────────────────────────────────────
    #   ช่องเดียวกันโผล่ได้หลายหน้า (เช่น InvoiceNo อยู่ทั้งหน้า 1 และหน้า 2)
    #   เลือกตัวที่ "ใช้กรอกจริง" ไว้: ไม่ computed ก่อน → มี logic กรอกแล้ว → ผูกคอลัมน์ DB → หน้าน้อยกว่า
    best: dict = {}
    for x in out:
        k = (x["scope"], x["key"])
        rank = (not x["computed"], x["fill"], bool(x["column"]), -x["page"])
        if k not in best or rank > best[k][0]:
            best[k] = (rank, x)
    out = [v[1] for v in best.values()]

    # จัดลำดับ: หน้า → ตามที่พบจริงบนหน้าจอ (order ใน survey เรียงบนลงล่างอยู่แล้ว)
    out.sort(key=lambda x: x["page"])

    n_fixed = disambiguate(out)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    print(f"✓ เขียน {OUT} — {len(out)} ช่อง (แก้ป้ายชื่อซ้ำ {n_fixed} ช่อง)")
    for pg in (1, 2, 3):
        fs = [x for x in out if x["page"] == pg]
        print(f"   หน้า {pg}: {len(fs):>3} ช่อง | กรอกได้ {sum(1 for x in fs if x['fill']):>2} "
              f"| DCTK เติมเอง {sum(1 for x in fs if x['computed']):>3} "
              f"| บังคับ {sum(1 for x in fs if x['required']):>2} "
              f"| มีคอลัมน์ DB {sum(1 for x in fs if x['column']):>2} "
              f"| มีตัวเลือก {sum(1 for x in fs if x['options']):>2}")
    for pg in (1, 2, 3, 4):
        n = sum(1 for x in out if x.get("formPage") == pg)
        if n: print(f"   ฟอร์มหน้า {pg}: {n} ช่อง")
    # เตือนถ้ามี column ที่ map ไม่เจอ (พิมพ์ชื่อผิด)
    mapped = {x['dctkName'] for x in out}
    for label, m in (("header", COLUMN_MAP_HEADER), ("item", COLUMN_MAP_ITEM)):
        bad = [k for k in m if k not in mapped]
        if bad:
            print(f"   ⚠ COLUMN_MAP_{label.upper()} ชี้ชื่อที่ไม่มีในผลสำรวจ: {bad}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
