/**
 * จับคู่ subject ลูกค้า (Spec §6.3.2)
 * ============================================================
 */

/**
 * เทียบ subject ขาเข้ากับ pattern ที่ลงทะเบียน แบบ substring สองทาง
 * (case-insensitive)
 * @return {"A"|"B"}  A = ประมวลผล, B = ข้าม
 */
function matchSubject_(incoming, registered) {
  if (!incoming || !registered) return "B";
  const a = String(incoming).trim().toLowerCase();
  const b = String(registered).trim().toLowerCase();
  return (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) ? "A" : "B";
}
