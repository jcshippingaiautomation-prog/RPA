#!/usr/bin/env bash
# ดึง Master ของ COCOS เพิ่มอีก 3 ประเทศที่ยังไม่มี (US · IT · DE)
#   เลือกใบล่าสุดของแต่ละประเทศ
set -u
cd "$(dirname "$0")"
INVOICES=("CTN2613" "CTN2628" "CTN2322")
ok=0; fail=0; failed=""
for inv in "${INVOICES[@]}"; do
  echo "════ $inv ════"
  got=0
  for try in 1 2 3 4; do
    OUT=$(PULL_INVOICE="$inv" PULL_CUSTOMER=COCO PULL_VIA_COPY=1 PULL_HEADLESS=1 \
          node dist/pull-master-cli.js 2>&1)
    if echo "$OUT" | grep -q "บันทึก Master"; then
      echo "$OUT" | grep -E "ได้ใบสำเนา|Consignee:|รหัสสินค้า:|ช่องหัวใบ:|✓ ลบใบสำเนา|⚠ เหลือ"
      got=1; ok=$((ok+1)); break
    fi
    echo "   ครั้งที่ $try ไม่สำเร็จ: $(echo "$OUT" | grep -E '✗' | tail -1 | cut -c1-100)"
    sleep 30
  done
  [ $got -eq 0 ] && { fail=$((fail+1)); failed="$failed\n   - $inv"; }
  sleep 5
done
echo; echo "═══ สำเร็จ $ok · ไม่สำเร็จ $fail ═══"
[ -n "$failed" ] && echo -e "ใบที่ยังไม่ได้:$failed"
