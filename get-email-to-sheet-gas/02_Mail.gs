/**
 * แตก metadata จากอีเมล (Spec §6.2)
 * ============================================================
 */

/**
 * @return {{email: string|null, subject: string, shipper: string|null}}
 */
function extractEmailMetadata_(msg) {
  return {
    email: parseSenderEmail_(msg.getFrom()),
    subject: msg.getSubject() || "",
    shipper: parseShipper_(msg.getPlainBody() || "", msg.getSubject() || ""),
  };
}

/** "Name <email@x.com>" → "email@x.com"; bare address ผ่านได้ */
function parseSenderEmail_(from) {
  if (!from) return null;
  const angle = from.match(/<([^>]+)>/);
  if (angle) return angle[1].trim().toLowerCase();
  if (from.indexOf("@") !== -1) return from.trim().toLowerCase();
  return null;
}

/**
 * shipper:
 *   1) body pattern  "Shipper: X"
 *   2) fallback subject pattern  "SP.X //"
 */
function parseShipper_(body, subject) {
  const fromBody = body.match(/Shipper\s*[:\-]\s*([^\n]+)/i);
  if (fromBody) return fromBody[1].trim();
  const fromSubject = subject.match(/SP\.([^/]+)/i);
  if (fromSubject) return fromSubject[1].trim();
  return null;
}
