/**
 * เตรียมไฟล์แนบให้ Gemini (Spec §6.4)
 * ============================================================
 *  - PDF / รูป: ส่ง Gemini ตรงๆ (อ่าน native)
 *  - DOCX/XLSX: แปลงเป็น PDF ผ่าน Google Drive (import → export)
 *  - format อื่น: ข้าม (Spec edge case #4)
 *
 * คืน array ของ { mimeType, bytesBase64 } พร้อมแนบเข้า Gemini inlineData
 */

function prepareFilesForAI_(attachments) {
  const out = [];

  for (const att of attachments) {
    const name = (att.getName() || "").toLowerCase();
    const mime = (att.getContentType() || "").toLowerCase();
    const kind = classifyAttachment_(name, mime);

    if (kind === "pdf") {
      out.push(blobToInline_(att.copyBlob(), "application/pdf"));
      continue;
    }

    if (kind === "image") {
      out.push(blobToInline_(att.copyBlob(), normalizeImageMime_(name, mime)));
      continue;
    }

    if (kind === "office") {
      const pdfBlob = convertOfficeToPdf_(att, name);
      if (pdfBlob) out.push(blobToInline_(pdfBlob, "application/pdf"));
      else console.warn("แปลง Office→PDF ไม่สำเร็จ ข้ามไฟล์: " + att.getName());
      continue;
    }

    console.warn("ไฟล์แนบไม่รองรับ ข้าม: " + att.getName() + " (" + mime + ")");
  }

  return out;
}

/** จำแนกชนิดไฟล์จากนามสกุล + MIME (Spec §6.4.1) */
function classifyAttachment_(name, mime) {
  if (name.match(/\.pdf$/) || mime === "application/pdf") return "pdf";
  if (name.match(/\.(png|jpe?g|webp|gif|bmp|tiff?)$/) || mime.indexOf("image/") === 0)
    return "image";
  if (
    name.match(/\.(docx?|xlsx?|pptx?|csv|odt|ods)$/) ||
    mime.indexOf("word") !== -1 ||
    mime.indexOf("excel") !== -1 ||
    mime.indexOf("spreadsheet") !== -1 ||
    mime.indexOf("officedocument") !== -1 ||
    mime.indexOf("opendocument") !== -1
  )
    return "office";
  return "unknown";
}

/**
 * แปลง Office (DOCX/XLSX/...) → PDF
 * วิธี: import blob เข้า Drive แบบให้ Google แปลงเป็น Google Docs/Sheets
 *       แล้ว export กลับมาเป็น PDF จากนั้นลบไฟล์ชั่วคราวทิ้ง
 * ต้องเปิด Advanced Service: Drive API (ดู README)
 */
function convertOfficeToPdf_(att, name) {
  var tempId = null;
  try {
    var googleMime = targetGoogleMime_(name);
    var blob = att.copyBlob();

    // รองรับทั้ง Drive API v3 (create) และ v2 (insert) — แล้วแต่ที่ enable
    if (Drive.Files && typeof Drive.Files.create === "function") {
      // v3
      var createdV3 = Drive.Files.create(
        { name: att.getName(), mimeType: googleMime },
        blob
      );
      tempId = createdV3.id;
    } else if (Drive.Files && typeof Drive.Files.insert === "function") {
      // v2
      var createdV2 = Drive.Files.insert(
        { title: att.getName(), mimeType: googleMime },
        blob,
        { convert: true }
      );
      tempId = createdV2.id;
    } else {
      throw new Error("Drive advanced service ไม่พร้อม (ทั้ง create และ insert ไม่มี)");
    }

    var pdfBlob = DriveApp.getFileById(tempId).getAs("application/pdf");
    // โหลด bytes มาเก็บก่อนลบไฟล์ต้นทาง
    var out = Utilities.newBlob(pdfBlob.getBytes(), "application/pdf",
      att.getName().replace(/\.[^.]+$/, ".pdf"));
    return out;
  } catch (e) {
    console.error("convertOfficeToPdf_ error: " + (e.stack || e));
    return null;
  } finally {
    if (tempId) {
      try { DriveApp.getFileById(tempId).setTrashed(true); } catch (e2) { /* ignore */ }
    }
  }
}

/** Google native MIME ปลายทางสำหรับการ import-convert */
function targetGoogleMime_(name) {
  if (name.match(/\.(xlsx?|csv|ods)$/)) return "application/vnd.google-apps.spreadsheet";
  if (name.match(/\.(pptx?)$/)) return "application/vnd.google-apps.presentation";
  return "application/vnd.google-apps.document"; // doc/docx/odt
}

/** Blob → โครงสร้าง inline สำหรับ Gemini */
function blobToInline_(blob, mimeType) {
  return {
    mimeType: mimeType,
    bytesBase64: Utilities.base64Encode(blob.getBytes()),
  };
}

function normalizeImageMime_(name, mime) {
  if (mime.indexOf("image/") === 0) return mime;
  if (name.match(/\.png$/)) return "image/png";
  if (name.match(/\.jpe?g$/)) return "image/jpeg";
  if (name.match(/\.webp$/)) return "image/webp";
  return "image/jpeg";
}
