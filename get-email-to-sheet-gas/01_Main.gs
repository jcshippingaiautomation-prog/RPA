/**
 * Entry point + orchestration (เทียบเท่า n8n graph / Spec §7)
 * ============================================================
 */

/**
 * Entry point — รันโดย time-driven trigger ทุก 1 นาที (หรือเรียกจาก Web App)
 * @param {string=} subjectOverride ถ้าส่งมา → ค้นอีเมลด้วย subject นี้แทน allowlist (โหมดทดสอบ)
 */
function processInbox(subjectOverride) {
  const label = getOrCreateLabel_(CONFIG.PROCESSED_LABEL);

  var query;
  if (subjectOverride && String(subjectOverride).trim()) {
    // โหมดทดสอบ: ค้นด้วย subject (มีไฟล์แนบ, ไม่จำกัด 1 วัน, ไม่เช็ค label)
    query = 'has:attachment subject:("' + String(subjectOverride).trim() + '")';
    console.log("[TEST MODE] subject query");
  } else {
    // ปกติ: กรองเฉพาะอีเมลจาก allowlist sender (ประหยัด AI quota)
    query = buildSearchQuery_();
  }
  const threads = GmailApp.search(query, 0, CONFIG.MAX_THREADS);
  console.log("query: " + query);
  console.log("found threads: " + threads.length);

  const summary = { threads: threads.length, done: 0, skip: 0, retry: 0, error: 0 };

  for (const thread of threads) {
    try {
      processThread_(thread, label, summary);
    } catch (e) {
      // อย่าให้ thread เดียวพังทั้งรอบ
      summary.error++;
      console.error("error on thread " + thread.getId() + ": " + (e.stack || e));
    }
  }

  // เก็บผลลัพธ์ล่าสุดไว้ให้ Web App อ่าน
  summary.finishedAt = new Date().toISOString();
  PropertiesService.getScriptProperties().setProperty(
    "LAST_RUN_SUMMARY", JSON.stringify(summary)
  );
  console.log("summary: " + JSON.stringify(summary));
  return summary;
}

/** ประมวลผล 1 thread (ติด label เมื่อจัดการเสร็จ = dedup) */
function processThread_(thread, label, summary) {
  const messages = thread.getMessages();
  let processedAny = false;

  for (const msg of messages) {
    const result = processMessage_(msg);
    if (summary) {
      if (result === "DONE") summary.done++;
      else if (result === "SKIP") summary.skip++;
      else if (result === "RETRY") summary.retry++;
    }
    if (result === "DONE" || result === "SKIP") processedAny = true;
    // ถ้า result === "RETRY" จะไม่ติด label → รอบหน้า query เจออีก
    if (result === "RETRY") {
      console.warn("thread จะถูกลองใหม่รอบหน้า: " + thread.getId());
      return;
    }
  }

  if (processedAny) {
    thread.addLabel(label);
    thread.markRead();
  }
}

/**
 * ประมวลผล 1 ข้อความ
 * @return {"DONE"|"SKIP"|"RETRY"}
 *   DONE  = เขียน sheet สำเร็จ
 *   SKIP  = ข้ามอย่างถูกต้อง (ไม่ใช่ลูกค้า / subject ไม่ตรง / ไม่มีไฟล์)
 *   RETRY = error ชั่วคราว (AI parse พัง) → อย่าติด label
 */
function processMessage_(msg) {
  // ระบบนี้ใช้ Supabase เป็นแหล่งข้อมูลเดียว — ต้องตั้งค่าก่อนเสมอ
  if (!supabaseEnabled_()) {
    throw new Error(
      "ยังไม่ได้ตั้งค่า Supabase (SUPABASE_URL / SUPABASE_SERVICE_KEY ใน Script Properties)"
    );
  }

  const meta = extractEmailMetadata_(msg);

  // Step 1 — ต้องแกะ sender email ได้
  if (!meta.email) {
    console.warn("ไม่พบ sender email — skip");
    return "SKIP";
  }

  // Step 2 — sender ต้องอยู่ใน allowlist (ไม่เช็ค subject แล้ว)
  if (!isSenderAllowed_(meta.email)) {
    console.log("sender ไม่อยู่ใน allowlist — skip: " + meta.email);
    return "SKIP";
  }

  // Step 3 — ต้องมีไฟล์แนบที่ใช้ได้
  const files = prepareFilesForAI_(msg.getAttachments());
  if (!files.length) {
    console.warn("ไม่มีไฟล์แนบที่ใช้ได้ — skip");
    return "SKIP";
  }

  // Step 4 — ให้ AI อ่านเอกสาร แล้วสกัดชื่อลูกค้า (keyword)
  const classification = classifyCustomer_(files);
  if (!classification || !classification.search_keyword) {
    console.error("classifier ล้มเหลว — retry รอบหน้า");
    return "RETRY";
  }
  console.log("keyword: " + classification.search_keyword);

  // Step 5 — ชื่อลูกค้าต้องตรงกับที่ลงทะเบียนใน customer_settings
  var cs = lookupCustomerByKeywordSupabase_(classification.search_keyword);
  if (!cs) {
    console.log("ไม่ใช่ลูกค้าที่ลงทะเบียน — skip: " + classification.search_keyword);
    return "SKIP"; // SKIP = ติด label กันประมวลผลซ้ำ
  }
  var rule = { Customer_Name: cs.customer_name, Extraction_Rules: cs.extraction_rules || "" };

  // Step 6 — สกัดข้อมูล declaration
  const raw = extractDeclaration_(files, rule, msg.getPlainBody() || "");

  // Step 7 — post-process
  const record = postProcess_(raw);
  if (record._has_error) {
    console.error("extractor parse พัง — retry รอบหน้า. raw=" + String(raw).slice(0, 500));
    return "RETRY";
  }

  // Step 8 — append ลง sheet
  appendDeclaration_(record);
  console.log(
    "เขียน sheet สำเร็จ: " + record.customer_name +
    " / inv " + record.invoice_number +
    (record._needs_review ? " (ต้องตรวจสอบ)" : "")
  );
  return "DONE";
}

/** หา (หรือสร้าง) Gmail label สำหรับ dedup */
function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}
