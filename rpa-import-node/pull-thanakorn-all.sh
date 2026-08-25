#!/usr/bin/env bash
# ดึง Master ของ THANAKORN ให้ครบทุกกรณี (1 กรณี = 1 consignee/สินค้า)
#   ใช้ใบล่าสุดของแต่ละกรณี · ทำผ่าน "สำเนา" แล้วลบสำเนาทิ้งอัตโนมัติ
#   DCTK ล่มเป็นพัก ๆ → ลองซ้ำได้ 4 ครั้งต่อใบ
#
# รัน:  set -a; . ../rpa-web/.env; set +a; bash pull-thanakorn-all.sh
set -u
cd "$(dirname "$0")"

INVOICES=(
  "DKN 24(A)/2025"
  "VNT 35(B)/2024"
  "SAVO 05(B)/2025"
  "TVOP-IM 010/2024"
  "TSS 11(A)/2025"
  "HPP 02(B)/2025"
  "ITJ 02/2024"
  "MFM 03(A)/2024"
  "ANS 04(B)/2024"
)

ok=0; fail=0; failed=""
for inv in "${INVOICES[@]}"; do
  echo "════ $inv ════"
  got=0
  for try in 1 2 3 4; do
    OUT=$(PULL_INVOICE="$inv" PULL_CUSTOMER=THANAKORN PULL_VIA_COPY=1 PULL_HEADLESS=1 \
          node dist/pull-master-cli.js 2>&1)
    if echo "$OUT" | grep -q "บันทึก Master"; then
      echo "$OUT" | grep -E "Consignee:|รหัสสินค้า:|ช่องหัวใบ:|✓ ลบใบสำเนา|⚠ เหลือ"
      got=1; ok=$((ok+1)); break
    fi
    echo "   ครั้งที่ $try ไม่สำเร็จ: $(echo "$OUT" | grep -E '^\[RPA\]   ✗|✗ error' | tail -1 | cut -c1-90)"
    sleep 30
  done
  [ $got -eq 0 ] && { fail=$((fail+1)); failed="$failed\n   - $inv"; }
  sleep 5
done

echo
echo "═══════════════════════════════════"
echo "สำเร็จ $ok · ไม่สำเร็จ $fail"
[ -n "$failed" ] && echo -e "ใบที่ยังไม่ได้:$failed"
