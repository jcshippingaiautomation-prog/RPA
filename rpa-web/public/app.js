// ============================================================
//  Frontend — ระบบใบขนสินค้า DCTK (รายการเดียวรวมทุก source)
// ============================================================
const $ = (id) => document.getElementById(id);

// ---- Auth ----
function authToken() { return localStorage.getItem("sb_access_token") || ""; }
function goLogin() { location.href = "/login.html"; }

async function api(path, method = "GET", body) {
  const headers = body ? { "Content-Type": "application/json" } : {};
  const tok = authToken();
  if (tok) headers["Authorization"] = "Bearer " + tok;
  const res = await fetch(path, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { goLogin(); throw new Error("ต้องเข้าสู่ระบบก่อน"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function dlUrl(storagePath, publicUrl) {
  let u = `/api/documents/download?path=${encodeURIComponent(storagePath)}`;
  if (publicUrl) u += `&url=${encodeURIComponent(publicUrl)}`;
  const tok = authToken();
  if (tok) u += `&token=${encodeURIComponent(tok)}`;
  return u;
}

// ---- utils ----
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso); const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return iso; }
}
let toastTimer = null;
function toast(msg, kind = "info") {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast t-" + kind;
  t.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.style.display = "none"), 3500);
}

// ---- Confirm dialog (Promise) — แทน confirm() ของ browser ----
let _confirmResolve = null;
function confirmDialog(message, title = "ยืนยันการลบ", okLabel = "ลบ") {
  $("cfTitle").textContent = title;
  $("cfMsg").innerHTML = message; // อนุญาต <b> ในข้อความ
  $("cfOk").innerHTML = svgIcon("trash", 16) + " " + escapeHtml(okLabel);
  $("modalConfirm").style.display = "flex";
  return new Promise((resolve) => { _confirmResolve = resolve; });
}
function closeConfirm(result) {
  $("modalConfirm").style.display = "none";
  if (_confirmResolve) { _confirmResolve(result); _confirmResolve = null; }
}
$("cfClose").onclick = () => closeConfirm(false);
$("cfCancel").onclick = () => closeConfirm(false);
$("cfOk").onclick = () => closeConfirm(true);
$("modalConfirm").onclick = (e) => { if (e.target === $("modalConfirm")) closeConfirm(false); };

// ---- สถานะ (badge) ----
const STATUS_META = {
  new: ["ใหม่ · ต้องตรวจ", "st-new"],
  ready: ["พร้อมรัน", "st-ready"],
  queued: ["รอคิว", "st-queued"],
  running: ["กำลังรัน", "st-running"],
  done: ["เสร็จ · ได้ใบขนแล้ว", "st-done"],
  partial: ["สร้างใบแล้ว · รอพิมพ์", "st-partial"],
  edited: ["แก้แล้ว", "st-edited"],
  error: ["ผิดพลาด", "st-error"],
};
function statusBadge(status, message, docStatus, opts) {
  // ไม่ใช้ "new" (ใหม่·ต้องตรวจ) — แปลงเป็น "ready" (พร้อมรัน)
  let eff = (status === "new" || !status) ? "ready" : status;
  // ⚠ ไม่ override เป็น "done" จาก docStatus อีกต่อไป — เพราะ docStatus=true ได้แม้มีแค่ capture
  //   (ทำให้สถานะโกหกว่า "เสร็จ" ทั้งที่ยังไม่ได้ใบขนจริง) → เชื่อ status จริงที่ worker set เท่านั้น
  //   (worker set "done" เฉพาะเมื่อได้ใบขนจริง, "partial" เมื่อได้แค่ capture)
  const [label, cls] = STATUS_META[eff] || STATUS_META.ready;
  // badge error ที่คลิกได้ → เปิด modal ดูสาเหตุ (มีไอคอน + ใส่ data-id)
  if (opts && opts.clickable && eff === "error") {
    const tip = ` title="${escapeHtml(message || "คลิกเพื่อดูสาเหตุที่ไม่สำเร็จ")}"`;
    return `<span class="st ${cls} st-clickable errBadge" data-id="${escapeHtml(opts.id || "")}"${tip}>${label} ⓘ</span>`;
  }
  // badge partial ที่คลิกได้ → เปิด modal ดูไฟล์ (มีปุ่มพิมพ์ใบขนซ้ำ)
  if (opts && opts.clickable && eff === "partial") {
    const tip = ` title="${escapeHtml(message || "ใบสร้างใน DCTK แล้ว — คลิกเพื่อพิมพ์ใบขนซ้ำ")}"`;
    return `<span class="st ${cls} st-clickable partialBadge" data-id="${escapeHtml(opts.id || "")}"${tip}>${label} ⓘ</span>`;
  }
  const tip = message ? ` title="${escapeHtml(message)}"` : "";
  return `<span class="st ${cls}"${tip}>${label}</span>`;
}
const SOURCE_META = {
  "get-email": ["อีเมล", "src-email"],
  upload: ["อัปโหลด", "src-upload"],
  manual: ["สร้างเอง", "src-manual"],
};
function sourceBadge(src) {
  const [label, cls] = SOURCE_META[src] || ["—", "src-manual"];
  return `<span class="src ${cls}">${label}</span>`;
}

// ============================================================
//  หน้ารายการใบขน
// ============================================================
// ช่องที่แสดง/แก้ไขในรายละเอียด (key, label) — ครอบคลุมช่องหลัก RPA กรอก
// ป้ายชื่อฟิลด์ = คำที่ปรากฏจริงบนเว็บ DCTK (ยืนยันจากภาพแคปหน้าจอ page 1/2/3). วงเล็บ = อังกฤษกำกับ
const DECL_FIELDS = [
  ["declaration_no", "เลขที่ใบขนฯ (ใช้ค้นเพื่อแก้)"],
  ["customer_name", "ผู้ส่งออก (ลูกค้า)"], ["consignee_name", "ชื่อผู้ซื้อ"],
  ["buyer_country_code", "รหัสประเทศผู้ซื้อ"], ["destination_country_code", "รหัสประเทศปลายทาง"],
  ["invoice_number", "เลขที่ใบกำกับฯ (Invoice)"], ["invoice_date", "วันที่ใบกำกับฯ"],
  ["vessel_name", "ชื่อยานพาหนะ"], ["voyage_number", "เที่ยวเรือ"],
  ["etd", "วันที่ส่งออก (ETD)"], ["release_port_code", "สถานที่ตรวจปล่อย"], ["loading_port_code", "สถานที่รับบรรทุก"],
  ["incoterms", "เงื่อนไข (Incoterms)"], ["currency", "สกุลเงิน"], ["total_goods_amount", "ราคา FOB รวม"],
  ["freight_charge", "ค่าระวาง"], ["insurance_charge", "ค่าประกัน"],
  ["shipping_mark", "เลขหมายหีบห่อ"], ["description_eng", "รายละเอียดสินค้า"],
  ["net_weight_kg", "น้ำหนักสุทธิรวม"], ["gross_weight_kg", "น้ำหนักรวมหีบห่อรวม"],
  ["net_weight_ton", "น้ำหนักสุทธิ (ตัน)"], ["container_or_volume_qty", "จำนวนหีบห่อรวม"],
  ["container_unit_code", "หน่วยหีบห่อรวม"], ["tax_payment_method_code", "รหัสวิธีการชำระภาษีอากร"],
];

let DECLS = [];      // รายการทั้งหมด (จาก /api/declarations)
let selected = new Set();

// สถานะที่ใช้จริง: new→ready (ไม่มีใหม่·ต้องตรวจ), doc_status=true → done
function effStatus(d) {
  const s = (d.status === "new" || !d.status) ? "ready" : d.status;
  if (d.doc_status && s !== "running" && s !== "queued" && s !== "edited") return "done";
  return s;
}
function filteredDecls() {
  const cust = $("filterCustomer").value;
  const st = $("filterStatus").value;
  return DECLS.filter((d) => {
    if (st && effStatus(d) !== st) return false;
    if (cust && (d.customer_name || "") !== cust) return false;
    return true;
  });
}

// เติมรายชื่อลูกค้าใน dropdown filter (จากข้อมูลจริง) — คงค่าที่เลือกไว้
function populateCustomerFilter() {
  const sel = $("filterCustomer");
  const cur = sel.value;
  const names = [...new Set(DECLS.map((d) => d.customer_name).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">ทุกลูกค้า</option>' +
    names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
  if (names.includes(cur)) sel.value = cur;
}

function updateStats() {
  // นับจากรายการที่แสดงจริง (หลัง filter/search) → ตัวเลขตรงกับตารางเสมอ
  const rows = filteredDecls();
  $("cTotal").textContent = rows.length;
  $("cReady").textContent = rows.filter((d) => effStatus(d) === "ready").length;
  $("cDone").textContent = rows.filter((d) => effStatus(d) === "done").length;
}

function renderList() {
  const rows = filteredDecls();
  const body = $("listBody");
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="9" class="empty">ยังไม่มีรายการ — กด "ดึงอีเมล" / "อัปโหลดไฟล์" / "สร้างรายการ"</td></tr>`;
    updateStats(); updateBulkBar();
    return;
  }
  body.innerHTML = rows.map((d) => {
    const running = d.status === "running" || d.status === "queued";
    const checked = selected.has(d.id) ? "checked" : "";
    return `<tr data-id="${d.id}">
      <td class="w-chk"><input type="checkbox" class="rowChk" data-id="${d.id}" ${checked} /></td>
      <td><div class="cust">${escapeHtml(d.customer_name || "—")}</div></td>
      <td class="muted-cell">${escapeHtml(d.consignee_name || "—")}</td>
      <td class="muted-cell">${escapeHtml(d.invoice_number || "—")}</td>
      <td class="muted-cell">${escapeHtml(d.etd || "—")}</td>
      <td class="muted-cell">${escapeHtml(fmtMoney(d.total_goods_amount, d.currency))}</td>
      <td>${sourceBadge(d.source)}</td>
      <td>${statusBadge(d.status, d.status_message, d.doc_status, { clickable: effStatus(d) === "error" || effStatus(d) === "partial", id: d.id })}</td>
      <td class="ta-right">
        <div class="row-actions">
          <button class="btn btn-ghost btn-xs actDetail" data-id="${d.id}" title="ดู/แก้ไขรายละเอียด">${svgIcon("list", 13)} รายละเอียด</button>
          <button class="btn btn-ghost btn-xs icon-only actCopy" data-id="${d.id}" title="สร้างสำเนา">${svgIcon("copy", 14)}</button>
          <button class="btn btn-ghost btn-xs icon-only actDelete" data-id="${d.id}" title="ลบรายการ">${svgIcon("trash", 14)}</button>
          <span class="row-actions-sep"></span>
          <button class="btn btn-dark btn-xs actRun" data-id="${d.id}" ${running ? "disabled" : ""}>${svgIcon("play", 13)} รัน</button>
          <button class="btn btn-ghost btn-xs actFiles ${d.doc_status ? "" : "is-empty"}" data-id="${d.id}" ${d.doc_status ? "" : "disabled"} title="${d.doc_status ? "ดูไฟล์ใบขน PDF + แคปหน้าจอ" : "ยังไม่มีไฟล์ (ต้องรัน RPA ก่อน)"}">${svgIcon("file", 13)} ดูไฟล์</button>
        </div>
      </td>
    </tr>`;
  }).join("");
  // events
  body.querySelectorAll(".actDetail").forEach((b) => (b.onclick = () => openDetail(b.dataset.id)));
  body.querySelectorAll(".errBadge").forEach((b) => (b.onclick = () => openDetail(b.dataset.id)));
  body.querySelectorAll(".partialBadge").forEach((b) => (b.onclick = () => openFiles(b.dataset.id)));
  body.querySelectorAll(".actFiles").forEach((b) => (b.onclick = () => openFiles(b.dataset.id)));
  body.querySelectorAll(".actRun").forEach((b) => (b.onclick = () => runDeclaration(b.dataset.id)));
  body.querySelectorAll(".actCopy").forEach((b) => (b.onclick = () => copyDeclaration(b.dataset.id)));
  body.querySelectorAll(".actDelete").forEach((b) => (b.onclick = () => deleteDeclarationRow(b.dataset.id)));
  body.querySelectorAll(".rowChk").forEach((c) => (c.onchange = () => {
    if (c.checked) selected.add(c.dataset.id); else selected.delete(c.dataset.id);
    updateBulkBar();
  }));
  updateStats(); updateBulkBar();
}

function fmtMoney(v, cur) {
  const n = Number(v);
  if (!v || isNaN(n) || n === 0) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 }) + (cur ? " " + cur : "");
}

function updateBulkBar() {
  const n = selected.size;
  $("bulkBar").style.display = n ? "flex" : "none";
  $("bulkCount").textContent = n;
  const all = $("checkAll");
  const visible = filteredDecls();
  all.checked = visible.length > 0 && visible.every((d) => selected.has(d.id));
}

async function loadDecls() {
  try {
    const d = await api("/api/declarations");
    DECLS = d.declarations || [];
    // ลบ selected ที่ไม่มีแล้ว
    const ids = new Set(DECLS.map((x) => x.id));
    selected = new Set([...selected].filter((id) => ids.has(id)));
    populateCustomerFilter();
    renderList();
  } catch (e) { toast("โหลดรายการไม่ได้: " + e.message, "error"); }
}

// ---- รัน RPA ต่อใบ ----
async function runDeclaration(id) {
  const d = DECLS.find((x) => x.id === id);
  const name = d ? `${d.customer_name || ""} / ${d.invoice_number || ""}` : "";
  const est = estImportMinutes(d);
  if (!confirm(`รัน RPA กรอกใบขนนี้เข้าระบบ DCTK?\n\n${name}\n\n⏱ ใช้เวลาประมาณ ${est} — ระบบจะกรอกให้อัตโนมัติ (ถ้ามีงานในคิวก่อนหน้าอาจนานกว่านี้)`)) return;
  try {
    await api(`/api/declarations/${encodeURIComponent(id)}/run`, "POST", {});
    toast(`ส่งเข้าคิว RPA แล้ว — กำลังรัน (⏱ ประมาณ ${est})`, "info");
    setDeclStatusLocal(id, "queued", `ส่งเข้าคิว RPA แล้ว (⏱ ประมาณ ${est})`);
  } catch (e) { toast("รันไม่สำเร็จ: " + e.message, "error"); }
}

// ประเมินเวลานำเข้า (RPA) คร่าว ๆ — ฐาน ~3 นาที + ~1 นาที/รายการสินค้าเพิ่ม
function estImportMinutes(d) {
  const items = Array.isArray(d && d._items) ? d._items.length : 1;
  if (items <= 1) return "3–5 นาที";
  const lo = Math.max(3, Math.round(3 + (items - 1) * 0.7));
  const hi = lo + 2;
  return `${lo}–${hi} นาที`;
}

// สร้างสำเนาใบขน
async function copyDeclaration(id) {
  const d = DECLS.find((x) => x.id === id);
  const name = d ? `${d.customer_name || ""} / ${d.invoice_number || ""}` : "";
  if (!confirm(`สร้างสำเนาของรายการนี้?\n\n${name}`)) return;
  try {
    await api(`/api/declarations/${encodeURIComponent(id)}/copy`, "POST", {});
    toast("สร้างสำเนาแล้ว", "success");
    await loadDecls();
  } catch (e) { toast("สร้างสำเนาไม่สำเร็จ: " + e.message, "error"); }
}

// ลบใบขนจากแถวรายการ
async function deleteDeclarationRow(id) {
  const d = DECLS.find((x) => x.id === id);
  const name = d ? `${escapeHtml(d.customer_name || "")} / ${escapeHtml(d.invoice_number || "")}` : "";
  const ok = await confirmDialog(`ต้องการลบรายการนี้ถาวร?<br><b>${name}</b>`, "ลบรายการ");
  if (!ok) return;
  try {
    await api(`/api/declarations/${encodeURIComponent(id)}`, "DELETE");
    DECLS = DECLS.filter((x) => x.id !== id);
    selected.delete(id);
    renderList();
    toast("ลบแล้ว", "success");
  } catch (e) { toast("ลบไม่สำเร็จ: " + e.message, "error"); }
}

// ลบหลายรายการที่เลือก
async function deleteSelected() {
  const ids = [...selected];
  if (!ids.length) return;
  const ok = await confirmDialog(`ต้องการลบ <b>${ids.length} รายการ</b> ที่เลือกถาวร?`, "ลบหลายรายการ");
  if (!ok) return;
  let done = 0;
  for (const id of ids) {
    try { await api(`/api/declarations/${encodeURIComponent(id)}`, "DELETE"); done++; } catch { /* ต่อ */ }
  }
  DECLS = DECLS.filter((x) => !selected.has(x.id) || !ids.includes(x.id));
  selected.clear();
  await loadDecls();
  toast(`ลบ ${done} รายการแล้ว`, "success");
}

async function runSelected() {
  const ids = [...selected];
  if (!ids.length) return;
  const totalEst = `${ids.length * 3}–${ids.length * 5} นาที`;
  if (!confirm(`รัน RPA ${ids.length} รายการที่เลือก?\n\n⏱ ใช้เวลารวมประมาณ ${totalEst} (ทำทีละใบต่อกัน)`)) return;
  for (const id of ids) {
    try {
      await api(`/api/declarations/${encodeURIComponent(id)}/run`, "POST", {});
      setDeclStatusLocal(id, "queued", "ส่งเข้าคิว RPA แล้ว");
    } catch (e) { /* ต่อ */ }
  }
  selected.clear();
  toast(`ส่ง ${ids.length} รายการเข้าคิวแล้ว (⏱ ประมาณ ${totalEst})`, "info");
  renderList();
}

function setDeclStatusLocal(id, status, message) {
  const d = DECLS.find((x) => x.id === id);
  if (d) { d.status = status; if (message !== undefined) d.status_message = message; }
  renderList();
}

// ============================================================
//  Modal: รายละเอียด / แก้ไข
// ============================================================
let detailId = null;
let detailJobId = null;   // job ล่าสุดของใบที่เปิดอยู่ (ใช้ดู log เต็ม)
let detailValidation = null;   // ผลตรวจข้อมูลก่อนรัน (validateDeclaration)
let detailWizard = false;      // true = เปิดจากการอัปโหลด (ขั้นที่ 3 ตรวจสอบ) → โชว์แบนเนอร์ wizard
async function openDetail(id, opts) {
  detailId = id;
  detailWizard = !!(opts && opts.wizard);
  const box = $("mdBody");
  box.innerHTML = '<p class="muted">กำลังโหลด…</p>';
  $("modalDetail").style.display = "flex";
  try {
    const r = await api(`/api/declarations/${encodeURIComponent(id)}`);
    const d = r.declaration || {};
    detailJobId = d.last_job_id || null;        // เก็บไว้ให้ปุ่ม "ดู log เต็ม" ใช้
    $("mdTitle").textContent = `${detailWizard ? "ตรวจสอบ — " : ""}${d.customer_name || "ใบขน"} ${d.invoice_number ? "/ " + d.invoice_number : ""}`;
    detailValidation = r.validation || null;     // เก็บผลตรวจข้อมูลก่อนรัน
    renderDetailForm(d, r.errorSummary, r.validation);
    loadDetailDocs(d.customer_name, d.invoice_number);
    loadDetailDocImages(d.customer_name, d.invoice_number);   // โชว์เอกสารต้นฉบับเป็นภาพ (ตรวจเทียบ)
    // ปุ่มรันใน modal — disable ถ้าข้อมูลไม่ครบ (validation.ok=false) เพื่อกันรันแล้วไม่ผ่าน
    const running = d.status === "running" || d.status === "queued";
    const invalid = r.validation && r.validation.ok === false;
    $("mdRun").disabled = running || invalid;
    $("mdRun").title = invalid ? "ข้อมูลไม่ครบ — แก้ไขตามรายการ 'ข้อมูลที่ต้องแก้ก่อนรัน' ด้านบน" : "";
    // ปุ่ม "แก้ไขและรัน RPA" — เปิดเฉพาะเมื่อมีเลขใบขน DCTK (ใช้ค้นใบเดิม)
    const hasDeclNo = !!String(d.declaration_no ?? "").trim();
    const mdEdit = $("mdEdit");
    mdEdit.disabled = running || !hasDeclNo;
    mdEdit.title = hasDeclNo ? "ค้นใบใน DCTK ด้วยเลขใบขน แล้วแก้ไข" : "ต้องกรอกเลขใบขน DCTK ก่อน";
  } catch (e) { box.innerHTML = `<p class="note">โหลดไม่ได้: ${escapeHtml(e.message)}</p>`; }
}

// คอลัมน์รายการสินค้า (items) ที่แก้ได้ในตาราง [key, label, width]
// ป้ายชื่อคอลัมน์รายการสินค้า = ตามหน้า "ส่วนรายละเอียด" (Page 3) ของ DCTK (ยืนยันจากภาพแคป)
const ITEM_FIELDS = [
  ["description_eng", "รหัสสถิติสินค้า", "150"],
  ["description_eng_field", "คำอธิบายสินค้าภาษาอังกฤษ", "200"],
  ["product_description_thai", "คำอธิบายสินค้าภาษาไทย", "150"],
  ["brand_name", "ยี่ห้อสินค้า", "90"],
  ["export_tariff", "พิกัดศุลกากร", "90"],
  ["customs_unit_code", "หน่วยหลังพิกัด", "90"],
  ["container_or_volume_qty", "ปริมาณในใบขน", "80"],
  ["container_unit_code", "หน่วยหีบห่อ", "80"],
  ["net_weight_kg", "น้ำหนักสุทธิ", "90"],
  ["gross_weight_kg", "น้ำหนักรวมหีบห่อ", "100"],
  ["net_weight_ton", "น้ำหนักสุทธิ (ตัน)", "80"],
  ["net_weight_unit_code", "หน่วยน้ำหนัก", "80"],
  ["amount", "ราคา (FOB)", "90"],
  ["insurance", "ค่าประกัน", "80"],
];

// state ของ items ที่กำลังแก้ (mutable) — sync กับตารางในหน้า detail
let editItems = [];

function renderItemRow(it, idx) {
  const cells = ITEM_FIELDS.map(([k, , w]) =>
    `<td><input class="inp inp-xs it-edit" data-i="${idx}" data-key="${k}" style="width:${w}px" value="${escapeHtml(it[k] != null ? String(it[k]) : "")}" /></td>`).join("");
  const foc = `<td class="ta-center"><input type="checkbox" class="it-foc" data-i="${idx}" ${it.is_foc ? "checked" : ""} title="ของแถม FOC" /></td>`;
  return `<tr><td class="muted-cell">${idx + 1}</td>${cells}${foc}<td><button class="btn btn-ghost btn-xs icon-only it-del" data-i="${idx}" title="ลบรายการ">${svgIcon("trash", 13)}</button></td></tr>`;
}

function renderItemsTable() {
  const head = `<th>#</th>${ITEM_FIELDS.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join("")}<th>FOC</th><th></th>`;
  const rows = editItems.map((it, i) => renderItemRow(it, i)).join("");
  return `<div class="md-section">
    <div class="md-section-title">รายการสินค้า (${editItems.length}) <button class="btn btn-ghost btn-xs" id="itAdd">${svgIcon("plus", 12)} เพิ่มรายการ</button></div>
    <div class="items-scroll"><table class="dt sub items-edit"><thead><tr>${head}</tr></thead><tbody id="itBody">${rows}</tbody></table></div>
    <button class="btn btn-primary btn-sm" id="itSave" style="margin-top:8px">${svgIcon("save", 13)} บันทึกรายการสินค้า</button>
    <span id="itSaved" class="saved" style="display:none">${svgIcon("check", 13)} บันทึกแล้ว</span>
  </div>`;
}

function bindItemsEvents() {
  const body = $("itBody");
  if (!body) return;
  body.querySelectorAll(".it-edit").forEach((el) => (el.oninput = () => { editItems[+el.dataset.i][el.dataset.key] = el.value; }));
  body.querySelectorAll(".it-foc").forEach((el) => (el.onchange = () => { editItems[+el.dataset.i].is_foc = el.checked; }));
  body.querySelectorAll(".it-del").forEach((b) => (b.onclick = () => { editItems.splice(+b.dataset.i, 1); refreshItemsTable(); }));
  if ($("itAdd")) $("itAdd").onclick = () => { editItems.push({ description_eng: "", brand_name: "NO BRAND", is_foc: false }); refreshItemsTable(); };
  if ($("itSave")) $("itSave").onclick = saveItems;
}
function refreshItemsTable() {
  const sec = document.querySelector(".items-edit")?.closest(".md-section");
  if (sec) { sec.outerHTML = renderItemsTable(); bindItemsEvents(); }
}
async function saveItems() {
  if (!detailId) return;
  $("itSave").disabled = true;
  try {
    await api(`/api/declarations/${encodeURIComponent(detailId)}/items`, "PUT", { items: editItems });
    const sv = $("itSaved"); if (sv) { sv.style.display = "inline"; setTimeout(() => (sv.style.display = "none"), 2000); }
    toast("บันทึกรายการสินค้าแล้ว", "success");
  } catch (e) { toast("บันทึกไม่สำเร็จ: " + e.message, "error"); }
  finally { $("itSave").disabled = false; }
}

// ช่องที่ต้องกรอกได้หลายบรรทัด (textarea) — ให้ตรงกับเอกสารจริง เช่น เลขหมายหีบห่อ
const MULTILINE_FIELDS = { shipping_mark: 4, description_eng: 2 };
function renderFieldCell(k, label, d) {
  const val = d[k] != null ? String(d[k]) : "";
  const rows = MULTILINE_FIELDS[k];
  if (rows) {
    return `<div class="fld fld-full">
      <label>${escapeHtml(label)}</label>
      <textarea class="inp md-edit" data-key="${k}" rows="${rows}" placeholder="ใส่ได้หลายบรรทัดตามเอกสาร">${escapeHtml(val)}</textarea>
    </div>`;
  }
  return `<div class="fld">
    <label>${escapeHtml(label)}</label>
    <input class="inp md-edit" data-key="${k}" value="${escapeHtml(val)}" />
  </div>`;
}
function renderDetailForm(d, errorSummary, validation) {
  const cells = DECL_FIELDS.map(([k, label]) => renderFieldCell(k, label, d)).join("");
  editItems = Array.isArray(d._items) ? d._items.map((it) => ({ ...it })) : [];
  // แบนเนอร์ขั้น wizard (แสดงเฉพาะตอนเข้ามาจากการอัปโหลด → ขั้นที่ 3 ตรวจสอบ)
  const wizardBanner = detailWizard
    ? `<div class="eta-note" style="width:100%;box-sizing:border-box;margin-bottom:14px">
         ✓ AI สกัดข้อมูลเสร็จแล้ว — <b>&nbsp;ขั้นที่ 3/3: ตรวจข้อมูลขวาให้ตรงกับเอกสารซ้าย</b>&nbsp; แล้วกด "บันทึก" → "รัน RPA"
       </div>`
    : "";
  // ซ้าย = เอกสารต้นฉบับ (ภาพ) · ขวา = ข้อมูลที่สกัด (ตรวจ/แก้)
  $("mdBody").innerHTML = `
    <div class="md-review">
      <div class="md-pane md-docs-col">
        <div class="md-pane-title">📄 เอกสารต้นฉบับ <span class="muted" style="font-weight:400">— เลื่อนดูทุกไฟล์ทุกหน้า</span></div>
        <div id="mdDocsPane" class="doc-viewer"><div class="doc-empty">กำลังโหลดเอกสาร…</div></div>
      </div>
      <div class="md-pane md-form-col">
        <div class="md-pane-title">✏️ ข้อมูลที่สกัดได้ <span class="muted" style="font-weight:400">— ตรวจ/แก้ก่อนรัน</span></div>
        ${wizardBanner}
        <div class="md-status">สถานะ: ${statusBadge(d.status, d.status_message, d.doc_status)} ${d.status_message ? `<span class="muted">${escapeHtml(d.status_message)}</span>` : ""}</div>
        ${renderValidationBox(validation)}
        ${renderErrorBox(errorSummary, detailJobId)}
        <div class="md-grid">${cells}</div>
        ${renderItemsTable()}
        <div class="md-section"><div class="md-section-title">📎 ไฟล์ผลลัพธ์ (ใบขน/แคปหน้าจอ)</div><div id="mdDocs" class="att-list muted">กำลังโหลด…</div></div>
      </div>
    </div>
  `;
  bindItemsEvents();
  bindErrorBox(detailJobId);
}

// ---- กล่อง "ข้อมูลที่ต้องแก้ก่อนรัน" (ตรวจก่อนรัน — กันรันแล้วไม่ผ่าน) ----
// validation มาจาก backend (validateDeclaration): { ok, issues:[{level,field,message,itemLine}] }
function renderValidationBox(validation) {
  if (!validation || !Array.isArray(validation.issues) || !validation.issues.length) return "";
  const errs = validation.issues.filter((i) => i.level === "error");
  const warns = validation.issues.filter((i) => i.level === "warn");
  if (!errs.length && !warns.length) return "";
  const li = (it) => {
    const icon = it.level === "error" ? "✗" : "⚠";
    return `<li class="vld-item vld-${it.level}"><span class="vld-ic">${icon}</span> ${escapeHtml(it.message)}</li>`;
  };
  const headClass = errs.length ? "vld-box-err" : "vld-box-warn";
  const title = errs.length
    ? `${svgIcon("x", 14)} ข้อมูลไม่ครบ — ต้องแก้ ${errs.length} จุดก่อนรัน`
    : `${svgIcon("list", 14)} ตรวจสอบข้อมูล (${warns.length} จุด)`;
  return `<div class="vld-box ${headClass}">
    <div class="vld-title">${title}</div>
    <ul class="vld-list">${errs.map(li).join("")}${warns.map(li).join("")}</ul>
    ${errs.length ? `<div class="vld-foot">แก้ไขในฟอร์ม/ตารางด้านล่าง แล้วกด "บันทึก" — ปุ่มรันจะเปิดเมื่อข้อมูลครบ</div>` : ""}
  </div>`;
}

// ---- กล่อง "สาเหตุที่ไม่สำเร็จ" (แสดงเฉพาะใบที่ error) ----
// summary มาจาก backend (summarizeJobError) — สรุปอ่านง่าย + ปุ่มดู log เต็ม
function renderErrorBox(summary, jobId) {
  if (!summary || !summary.failed) return "";
  // เด้งแดงช่องข้อมูลที่มีปัญหา (affectedFields จาก backend)
  if (Array.isArray(summary.affectedFields) && summary.affectedFields.length) {
    setTimeout(() => highlightFields(summary.affectedFields), 50);
  }
  // รายการเทคนิค (ซ่อนใต้ "รายละเอียดทางเทคนิค" — ลูกค้าไม่ต้องอ่าน)
  const issuesHtml = (summary.issues || []).map((it) => {
    const icon = it.level === "error" ? "✗" : "⚠";
    const where = it.where ? `<span class="err-where">${escapeHtml(it.where)}</span>` : "";
    return `<li class="err-item err-${it.level}"><span class="err-ic">${icon}</span> ${escapeHtml(it.text)} ${where}</li>`;
  }).join("");
  // คำแนะนำภาษาคน (humanHint) — เด่นสุด บอกว่าต้องทำอะไร
  const hint = summary.humanHint
    ? `<div class="err-hint">💡 ${escapeHtml(summary.humanHint)}</div>`
    : `<div class="err-hint">💡 แก้ไขข้อมูลตามที่แจ้ง แล้วกด "รัน" ใหม่อีกครั้ง</div>`;
  const logBtn = jobId
    ? `<button class="btn btn-ghost btn-xs" id="errLogBtn">${svgIcon("list", 12)} รายละเอียดทางเทคนิค</button>`
    : "";
  // กล่องสรุปสำหรับลูกค้า: พาดหัวภาษาคน + คำแนะนำ + (รายละเอียดเทคนิคซ่อนไว้)
  return `<div class="err-box">
    <div class="err-head">
      <span class="err-title">${svgIcon("x", 14)} ทำรายการไม่สำเร็จ</span>
    </div>
    <div class="err-headline">${escapeHtml(summary.headline || "")}</div>
    ${hint}
    <div class="err-foot">${logBtn}</div>
    <div id="errLogWrap" class="err-log-wrap" style="display:none">
      ${issuesHtml ? `<ul class="err-list">${issuesHtml}</ul>` : ""}
      <pre id="errLogPre" class="err-log">กำลังโหลด log…</pre>
    </div>
  </div>`;
}

// เด้งแดงช่องข้อมูลที่มีปัญหา (เพิ่ม class .fld-error ที่ input / ตารางรายการ)
function highlightFields(fields) {
  // เคลียร์ของเดิมก่อน
  document.querySelectorAll(".fld-error").forEach((el) => el.classList.remove("fld-error"));
  for (const f of fields) {
    if (f === "รายการสินค้า") {
      // เด้งแดงตารางรายการสินค้าทั้งบล็อก
      const tbl = document.querySelector("table.items-edit");
      if (tbl) tbl.classList.add("fld-error");
      continue;
    }
    // เด้งแดง input ที่ data-key ตรงกับ field
    const inp = document.querySelector(`.md-edit[data-key="${f}"]`);
    if (inp) inp.closest(".fld")?.classList.add("fld-error");
  }
}

function bindErrorBox(jobId) {
  const btn = $("errLogBtn");
  if (!btn || !jobId) return;
  let loaded = false;
  btn.onclick = async () => {
    const wrap = $("errLogWrap");
    const open = wrap.style.display !== "none";
    wrap.style.display = open ? "none" : "block";
    if (open || loaded) return;
    loaded = true;
    try {
      const r = await api(`/api/jobs/${encodeURIComponent(jobId)}/logs`);
      const lines = r.lines || [];
      $("errLogPre").textContent = lines.length ? lines.join("\n") : "ไม่มี log";
    } catch (e) {
      $("errLogPre").textContent = "โหลด log ไม่ได้: " + e.message;
      loaded = false;
    }
  };
}

async function loadDetailDocs(customer, invoice) {
  const box = $("mdDocs");
  if (!box) return;
  try {
    const res = await api(`/api/declaration-documents?customer=${encodeURIComponent(customer || "")}&invoice=${encodeURIComponent(invoice || "")}`);
    const docs = res.documents || [];
    // ไฟล์ผลลัพธ์เท่านั้น (ใบขน/แคป) — ไม่รวม source (source โชว์เป็นภาพในแผงขวาแล้ว)
    const out = docs.filter((doc) => doc.kind !== "source");
    box.innerHTML = out.length
      ? out.map((doc) => `<a href="${dlUrl(doc.storage_path, doc.public_url)}" target="_blank" rel="noopener" class="att">${svgIcon("file", 14)} ${escapeHtml(doc.filename)}</a>`).join("")
      : '<span class="muted">ยังไม่มีไฟล์ผลลัพธ์ (รัน RPA เพื่อสร้างใบขน)</span>';
  } catch { box.textContent = "โหลดเอกสารไม่ได้"; }
}

// โชว์ "เอกสารต้นฉบับ" (kind=source) เป็นภาพ/PDF ทุกไฟล์ทุกหน้า — ให้ user ตรวจเทียบข้อมูลที่ AI สกัด
//   รูป → <img>, PDF → <iframe> (เบราว์เซอร์เรนเดอร์ทุกหน้าให้เอง), อื่น ๆ → ลิงก์เปิด/ดาวน์โหลด
async function loadDetailDocImages(customer, invoice) {
  const pane = $("mdDocsPane");
  if (!pane) return;
  try {
    const res = await api(`/api/declaration-documents?customer=${encodeURIComponent(customer || "")}&invoice=${encodeURIComponent(invoice || "")}`);
    let sources = (res.documents || []).filter((doc) => doc.kind === "source");
    // dedupe ตามชื่อไฟล์ — เก็บอันล่าสุด (กันซ้ำจากการอัปโหลด invoice เดิมหลายรอบ)
    const byName = new Map();
    for (const doc of sources) {
      const key = (doc.filename || "").trim().toLowerCase();
      const prev = byName.get(key);
      if (!prev || String(doc.created_at || "") > String(prev.created_at || "")) byName.set(key, doc);
    }
    sources = [...byName.values()];
    if (!sources.length) { pane.innerHTML = '<div class="doc-empty">ไม่มีเอกสารต้นฉบับแนบมากับใบนี้</div>'; return; }
    pane.innerHTML = sources.map((doc) => {
      const url = dlUrl(doc.storage_path, doc.public_url);
      const name = doc.filename || "เอกสาร";
      const lower = name.toLowerCase();
      let inner;
      if (/\.(png|jpe?g|gif|webp)$/i.test(lower)) {
        inner = `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" class="doc-img" alt="${escapeHtml(name)}" loading="lazy"></a>`;
      } else if (lower.endsWith(".pdf")) {
        // ซ่อน toolbar/navpane ของ PDF viewer ให้สะอาด + fit ความกว้าง (เลื่อนดูทุกหน้าในเฟรม)
        inner = `<iframe class="doc-frame" src="${url}#toolbar=0&navpanes=0&statusbar=0&view=FitH" title="${escapeHtml(name)}" loading="lazy"></iframe>`;
      } else {
        inner = `<div class="doc-other">${svgIcon("file", 28)}<div style="margin:8px 0">ไฟล์นี้เปิดดูเป็นภาพไม่ได้ (${escapeHtml(name.split(".").pop() || "")})</div>
          <a class="btn btn-ghost btn-xs" href="${url}" target="_blank" rel="noopener">${svgIcon("file", 13)} เปิด/ดาวน์โหลด</a></div>`;
      }
      return `<div class="doc-file"><div class="doc-file-name">${svgIcon("file", 13)} ${escapeHtml(name)} <a href="${url}" target="_blank" rel="noopener" class="muted" style="margin-left:auto;text-decoration:none" title="เปิดเต็มจอ">↗</a></div>${inner}</div>`;
    }).join("");
  } catch (e) {
    pane.innerHTML = `<div class="doc-empty">โหลดเอกสารต้นฉบับไม่ได้: ${escapeHtml(e.message)}</div>`;
  }
}

function closeDetail() { $("modalDetail").style.display = "none"; detailId = null; }
$("mdClose").onclick = closeDetail;

// ---- Modal ดูไฟล์ (ใบขน PDF + แคปหน้าจอ) จากหน้ารายการเลย ----
const isImgFile = (name) => /\.(png|jpe?g|gif|webp)$/i.test(name || "");
function closeFiles() { $("modalFiles").style.display = "none"; }
$("filesClose").onclick = closeFiles;
$("filesCloseBtn").onclick = closeFiles;

// เปิดไฟล์ใบขน PDF ล่าสุดตรงๆ จากหน้ารายการ (ไม่ต้องเปิด modal)
async function openLatestPdf(id) {
  const d = DECLS.find((x) => x.id === id);
  if (!d) return;
  try {
    const res = await api(`/api/declaration-documents?customer=${encodeURIComponent(d.customer_name || "")}&invoice=${encodeURIComponent(d.invoice_number || "")}`);
    const docs = res.documents || [];
    // เลือกใบขน PDF (declaration) ล่าสุด; ถ้าไม่มีก็ใบล่าสุดอะไรก็ได้
    const pdf = docs.find((x) => x.kind === "declaration") || docs[0];
    if (!pdf) { toast("ยังไม่มีไฟล์ใบขนสำหรับใบนี้", "error"); return; }
    window.open(dlUrl(pdf.storage_path, pdf.public_url), "_blank", "noopener");
  } catch (e) {
    toast("เปิดไฟล์ไม่ได้: " + e.message, "error");
  }
}

async function openFiles(id) {
  const d = DECLS.find((x) => x.id === id);
  if (!d) return;
  $("filesTitle").textContent = `ไฟล์เอกสาร — ${d.customer_name || "—"} (${d.invoice_number || "—"})`;
  const body = $("filesBody");
  body.innerHTML = '<p class="muted">กำลังโหลด…</p>';
  $("modalFiles").style.display = "flex";
  try {
    const res = await api(`/api/declaration-documents?customer=${encodeURIComponent(d.customer_name || "")}&invoice=${encodeURIComponent(d.invoice_number || "")}`);
    const docs = res.documents || [];
    if (!docs.length) { body.innerHTML = '<p class="muted">ยังไม่มีไฟล์เอกสารสำหรับใบนี้</p>'; return; }
    // แยก 2 กลุ่ม: ใบขน PDF (declaration) · แคปหน้าจอ PDF รวม (capture)
    //   (ไม่แสดง screenshot PNG แยกอีกแล้ว — รวมเป็น PDF เดียวพอ)
    const pdfs = docs.filter((x) => x.kind === "declaration");
    const captures = docs.filter((x) => x.kind === "capture");
    const fileRow = (doc) => {
      const url = dlUrl(doc.storage_path, doc.public_url);
      const img = isImgFile(doc.filename);
      return `<div class="file-card">
        ${img ? `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" class="file-thumb" alt="${escapeHtml(doc.filename)}" loading="lazy"></a>`
              : `<div class="file-pdf">${svgIcon("file", 32)}</div>`}
        <div class="file-meta">
          <div class="file-name" title="${escapeHtml(doc.filename)}">${escapeHtml(doc.filename)}</div>
          <div class="file-actions">
            <a class="btn btn-ghost btn-xs" href="${url}" target="_blank" rel="noopener">${svgIcon("file", 13)} ดู</a>
            <a class="btn btn-dark btn-xs" href="${url}" download>${svgIcon("download", 13)} ดาวน์โหลด</a>
          </div>
        </div>
      </div>`;
    };
    // ถ้ามีเลขใบขนแล้ว แต่ยังไม่มีไฟล์ใบขนจริง (declaration) — เสนอ "พิมพ์ใบขนซ้ำ"
    //   (เกิดตอน finalize พลาดเพราะ DCTK ค้าง: ใบสร้างใน DCTK แล้ว ได้แต่ capture)
    const hasDeclNo = !!String(d.declaration_no ?? "").trim();
    const needsReprint = hasDeclNo && !pdfs.length;
    const reprintBox = needsReprint
      ? `<div class="files-section">
           <p class="muted" style="margin:0 0 8px">⚠ ยังไม่มีไฟล์ใบขนจริง (มีแต่แคปหน้าจอ) — ใบขน ${escapeHtml(String(d.declaration_no))} ถูกสร้างใน DCTK แล้ว กดพิมพ์ใบขนจริงออกมาได้</p>
           <button class="btn btn-dark btn-xs actReprint" data-id="${d.id}">${svgIcon("play", 13)} พิมพ์ใบขนซ้ำ (ดึง PDF จริงจาก DCTK)</button>
         </div>`
      : "";
    body.innerHTML = `
      ${reprintBox}
      ${pdfs.length ? `<div class="files-section"><div class="files-section-title">📄 ใบขนสินค้า (PDF)</div><div class="files-grid">${pdfs.map(fileRow).join("")}</div></div>` : ""}
      ${captures.length ? `<div class="files-section"><div class="files-section-title">📸 แคปหน้าจอ (PDF รวมทุกหน้า)</div><div class="files-grid">${captures.map(fileRow).join("")}</div></div>` : ""}
    ` || '<p class="muted">ยังไม่มีไฟล์</p>';
    const reBtn = body.querySelector(".actReprint");
    if (reBtn) reBtn.onclick = () => reprintDeclaration(reBtn.dataset.id);
  } catch (e) {
    body.innerHTML = `<p class="muted">โหลดไฟล์ไม่ได้: ${escapeHtml(e.message)}</p>`;
  }
}

// พิมพ์ใบขนซ้ำ — ส่ง RPA ไปค้นใบเดิมใน DCTK แล้วพิมพ์ PDF จริง (ไม่สร้างใบใหม่)
async function reprintDeclaration(id) {
  const d = DECLS.find((x) => x.id === id);
  if (!d) return;
  if (!confirm(`พิมพ์ใบขนซ้ำ?\n\n${d.customer_name || ""} — เลขใบขน ${d.declaration_no || ""}\n\nRPA จะเข้า DCTK ค้นใบนี้แล้วพิมพ์ PDF จริง (ไม่สร้างใบใหม่)`)) return;
  try {
    await api(`/api/declarations/${encodeURIComponent(id)}/reprint`, "POST", {});
    closeFiles();
    toast("ส่งเข้าคิวพิมพ์ใบขนซ้ำแล้ว — รอ worker พิมพ์ (ดูสถานะที่รายการ)", "success");
    setDeclStatusLocal(id, "queued", "ส่งเข้าคิวพิมพ์ใบขนซ้ำ");
  } catch (e) {
    toast("ส่งคำสั่งพิมพ์ซ้ำไม่สำเร็จ: " + e.message, "error");
  }
}

$("mdSave").onclick = async () => {
  if (!detailId) return;
  const patch = {};
  $("mdBody").querySelectorAll(".md-edit").forEach((inp) => (patch[inp.dataset.key] = inp.value.trim()));
  $("mdSave").disabled = true;
  try {
    await api(`/api/declarations/${encodeURIComponent(detailId)}`, "POST", patch);
    const ok = $("mdSaved"); ok.style.display = "inline";
    setTimeout(() => (ok.style.display = "none"), 2500);
    // sync local
    const d = DECLS.find((x) => x.id === detailId);
    if (d) Object.assign(d, patch);
    renderList();
    toast("บันทึกแล้ว", "success");
  } catch (e) { toast("บันทึกไม่สำเร็จ: " + e.message, "error"); }
  finally { $("mdSave").disabled = false; }
};

$("mdRun").onclick = async () => {
  if (!detailId) return;
  const id = detailId;
  closeDetail();
  await runDeclaration(id);
};

// แก้ไขและรัน RPA: บันทึก patch + ส่ง RPA ไปแก้ใบเดิมใน DCTK
$("mdEdit").onclick = async () => {
  if (!detailId) return;
  const id = detailId;
  const patch = {};
  $("mdBody").querySelectorAll(".md-edit").forEach((inp) => (patch[inp.dataset.key] = inp.value.trim()));
  const d = DECLS.find((x) => x.id === id);
  const name = d ? `${d.customer_name || ""} / ${d.invoice_number || ""}` : "";
  if (!confirm(`ส่ง RPA ไปแก้ไขใบเดิมใน DCTK?\n\n${name}\nเลขใบขน: ${patch.declaration_no || (d && d.declaration_no) || ""}`)) return;
  closeDetail();
  try {
    await api(`/api/declarations/${encodeURIComponent(id)}/edit`, "POST", patch);
    toast("ส่งเข้าคิวแก้ไข RPA แล้ว", "info");
    setDeclStatusLocal(id, "queued", "ส่งเข้าคิวแก้ไข RPA");
  } catch (e) { toast("แก้ไขไม่สำเร็จ: " + e.message, "error"); }
};

$("mdDelete").onclick = async () => {
  if (!detailId) return;
  const ok = await confirmDialog("ต้องการลบรายการนี้ถาวร?", "ลบรายการ");
  if (!ok) return;
  try {
    await api(`/api/declarations/${encodeURIComponent(detailId)}`, "DELETE");
    DECLS = DECLS.filter((x) => x.id !== detailId);
    closeDetail(); renderList();
    toast("ลบแล้ว", "success");
  } catch (e) { toast("ลบไม่สำเร็จ: " + e.message, "error"); }
};

// ============================================================
//  Modal: อัปโหลดไฟล์ → AI
// ============================================================
let uploadFiles = [];
let customerNames = []; // รายชื่อลูกค้าจาก customer_settings (cache)
async function loadCustomerNames() {
  try {
    const d = await api("/api/customer-settings");
    customerNames = (d.settings || []).map((s) => s.customer_name).filter(Boolean).sort();
  } catch { customerNames = []; }
  const sel = $("upCustomer");
  if (sel) sel.innerHTML = '<option value="">— ให้ AI ระบุเอง —</option>' +
    customerNames.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
}
// ---- จัดการขั้นตอน wizard ของ modal อัปโหลด ----
function setUploadStep(n) {
  // สลับหน้า step 1/2
  $("upStep1").style.display = n === 1 ? "" : "none";
  $("upStep2").style.display = n === 2 ? "" : "none";
  $("upFoot1").style.display = n === 1 ? "" : "none";
  // ไฮไลต์ตัวบอกขั้นตอน
  document.querySelectorAll("#upSteps .wz-step").forEach((el) => {
    const s = Number(el.dataset.step);
    el.classList.toggle("active", s === n);
    el.classList.toggle("done", s < n);
  });
}
function openUpload() {
  uploadFiles = []; renderFileList(); $("upProgress").textContent = "";
  setUploadStep(1); loadCustomerNames(); $("modalUpload").style.display = "flex";
}
function closeUpload() { $("modalUpload").style.display = "none"; }
$("btnUpload").onclick = openUpload;
$("upClose").onclick = closeUpload;
$("upCancel").onclick = closeUpload;
$("dropzone").onclick = () => $("fileInput").click();
$("fileInput").onchange = (e) => { addFiles(e.target.files); e.target.value = ""; };
$("dropzone").ondragover = (e) => { e.preventDefault(); $("dropzone").classList.add("drag"); };
$("dropzone").ondragleave = () => $("dropzone").classList.remove("drag");
$("dropzone").ondrop = (e) => { e.preventDefault(); $("dropzone").classList.remove("drag"); addFiles(e.dataTransfer.files); };

function addFiles(fileList) {
  for (const f of fileList) uploadFiles.push(f);
  renderFileList();
}
function renderFileList() {
  $("fileList").innerHTML = uploadFiles.map((f, i) =>
    `<div class="file-item">${svgIcon("file", 14)} <span>${escapeHtml(f.name)}</span> <span class="muted">(${(f.size / 1024).toFixed(0)} KB)</span>
     <button class="fi-del" data-i="${i}">${svgIcon("x", 13)}</button></div>`).join("");
  $("fileList").querySelectorAll(".fi-del").forEach((b) => (b.onclick = () => { uploadFiles.splice(Number(b.dataset.i), 1); renderFileList(); }));
  // โชว์ ETA เมื่อมีไฟล์แล้ว (เวลาสกัดคร่าว ๆ)
  const eta = $("upEta");
  if (eta) eta.style.display = uploadFiles.length ? "inline-flex" : "none";
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
$("upSubmit").onclick = async () => {
  if (!uploadFiles.length) { toast("เลือกไฟล์ก่อน", "error"); return; }
  $("upSubmit").disabled = true;
  // → ขั้นที่ 2: กำลังประมวลผล
  setUploadStep(2);
  $("upProcTitle").textContent = "กำลังอ่านไฟล์…";
  $("upProgress").textContent = "";
  $("upErr").textContent = "";
  try {
    const files = [];
    for (const f of uploadFiles) {
      files.push({ filename: f.name, mimeType: f.type, dataBase64: await fileToBase64(f) });
    }
    $("upProcTitle").textContent = "AI กำลังอ่านและสกัดข้อมูลจากเอกสาร…";
    const customer = $("upCustomer").value || "";
    const r = await api("/api/upload", "POST", { files, customer });
    await loadDecls();
    closeUpload();
    // → ขั้นที่ 3: เปิดหน้าตรวจสอบ (detail modal + เอกสารต้นฉบับเป็นภาพ)
    if (r && r.id) {
      openDetail(r.id, { wizard: true });
    } else {
      toast(`สร้างรายการแล้ว: ${r.customer || ""} ${r.invoice ? "/ " + r.invoice : ""}`, "success");
    }
  } catch (e) {
    // กลับไปขั้นที่ 1 ให้แก้ไฟล์/ลองใหม่ พร้อมข้อความ error
    setUploadStep(1);
    $("upErr").textContent = "✗ " + e.message;
    toast("สกัดข้อมูลไม่สำเร็จ: " + e.message, "error");
  } finally { $("upSubmit").disabled = false; }
};

// ============================================================
//  Modal: สร้างรายการเอง
// ============================================================
function openCreate() {
  $("crBody").innerHTML = `<div class="md-grid">${DECL_FIELDS.map(([k, label]) => {
    const rows = MULTILINE_FIELDS[k];
    return rows
      ? `<div class="fld fld-full"><label>${escapeHtml(label)}</label><textarea class="inp cr-edit" data-key="${k}" rows="${rows}" placeholder="ใส่ได้หลายบรรทัดตามเอกสาร"></textarea></div>`
      : `<div class="fld"><label>${escapeHtml(label)}</label><input class="inp cr-edit" data-key="${k}" /></div>`;
  }).join("")}</div>`;
  $("modalCreate").style.display = "flex";
}
function closeCreate() { $("modalCreate").style.display = "none"; }
$("btnCreate").onclick = openCreate;
$("crClose").onclick = closeCreate;
$("crCancel").onclick = closeCreate;
$("crSubmit").onclick = async () => {
  const rec = {};
  $("crBody").querySelectorAll(".cr-edit").forEach((inp) => { const v = inp.value.trim(); if (v) rec[inp.dataset.key] = v; });
  if (!rec.customer_name) { toast("กรอกชื่อลูกค้าก่อน", "error"); return; }
  $("crSubmit").disabled = true;
  try {
    await api("/api/declarations", "POST", rec);
    closeCreate();
    toast("สร้างรายการแล้ว", "success");
    await loadDecls();
  } catch (e) { toast("สร้างไม่สำเร็จ: " + e.message, "error"); }
  finally { $("crSubmit").disabled = false; }
};

// ---- ดึงอีเมล (เปิด modal เลือก subject) ----
function closePoll() { $("modalPoll").style.display = "none"; }
$("btnPollEmail").onclick = () => { $("pollSubject").value = ""; $("modalPoll").style.display = "flex"; setTimeout(() => $("pollSubject").focus(), 50); };
$("pollClose").onclick = closePoll;
$("pollCancel").onclick = closePoll;

$("pollSubmit").onclick = async () => {
  const subject = $("pollSubject").value.trim();
  const b = $("pollSubmit"); b.disabled = true;
  closePoll();
  toast(subject ? `กำลังดึงอีเมล subject: "${subject}"…` : "กำลังดึงอีเมล…", "info");
  try {
    const r = await api("/api/gas/run", "POST", subject ? { subject } : {});
    if (r.ok) {
      const s = r.summary || {};
      toast(`ดึงอีเมลเสร็จ — ใหม่ ${s.done ?? 0} · ข้าม ${s.skip ?? 0}`, "success");
      await loadDecls();
    } else toast("ดึงอีเมลล้มเหลว: " + (r.error || ""), "error");
  } catch (e) { toast("ดึงอีเมลล้มเหลว: " + e.message, "error"); }
  finally { b.disabled = false; }
};

// ---- toolbar ----
$("btnRefresh").onclick = loadDecls;
$("filterCustomer").onchange = renderList;
$("filterStatus").onchange = renderList;
$("checkAll").onchange = () => {
  const visible = filteredDecls();
  if ($("checkAll").checked) visible.forEach((d) => selected.add(d.id));
  else visible.forEach((d) => selected.delete(d.id));
  renderList();
};
$("btnRunSel").onclick = runSelected;
$("btnDeleteSel").onclick = deleteSelected;
$("btnClearSel").onclick = () => { selected.clear(); renderList(); };

// ============================================================
//  Page routing
// ============================================================
const PAGE_META = {
  list: { title: "รายการใบขน", sub: "จัดการใบขนสินค้าทั้งหมดในที่เดียว" },
  history: { title: "ประวัติงาน", sub: "ประวัติการรัน RPA + เอกสารที่สร้าง" },
  settings: { title: "ตั้งค่า", sub: "Allowlist · AI · ตารางเวลา · RPA · ลูกค้า" },
};
function isAdmin() { return CURRENT_USER && CURRENT_USER.role === "admin"; }
function showPage(page) {
  const target = document.querySelector(`.nav-item[data-page="${page}"]`);
  if (target && target.dataset.admin === "true" && !isAdmin()) page = "list";
  document.querySelectorAll(".page").forEach((p) => (p.style.display = "none"));
  const el = $("page-" + page); if (el) el.style.display = "";
  document.querySelectorAll(".nav-item[data-page]").forEach((n) => n.classList.toggle("active", n.dataset.page === page));
  const meta = PAGE_META[page] || PAGE_META.list;
  $("pageTitle").textContent = meta.title; $("pageSubtitle").textContent = meta.sub;
  if (page === "list") loadDecls();
  if (page === "history") { loadJobs(); }
  if (page === "settings") { loadRules(); loadEmailSchedule(); loadModel(); loadEmailRules(); loadConfig(); }
}
document.querySelectorAll(".nav-item[data-page]").forEach((n) => (n.onclick = (e) => { e.preventDefault(); showPage(n.dataset.page); }));

// ---- Settings sub-tabs ----
function showTab(tab) {
  document.querySelectorAll(".tab[data-tab]").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  document.querySelectorAll(".tab-panel[data-panel]").forEach((p) => (p.style.display = p.dataset.panel === tab ? "" : "none"));
  if (tab === "users") loadUsers();
}
document.querySelectorAll(".tab[data-tab]").forEach((t) => (t.onclick = () => showTab(t.dataset.tab)));

// ============================================================
//  ตั้งค่า — จัดการผู้ใช้ (admin)
// ============================================================
const ROLE_LABEL = { admin: "ผู้ดูแล", user: "ผู้ใช้ทั่วไป" };
async function loadUsers() {
  const body = $("usersBody");
  if (!body) return;
  try {
    const d = await api("/api/users");
    const users = d.users || [];
    if (!users.length) { body.innerHTML = '<tr><td colspan="5" class="empty">ยังไม่มีผู้ใช้</td></tr>'; return; }
    body.innerHTML = users.map((u) => `<tr>
      <td>${escapeHtml(u.email)}</td>
      <td><span class="st ${u.role === "admin" ? "st-edited" : "st-ready"}">${ROLE_LABEL[u.role] || u.role}</span></td>
      <td class="muted-cell">${u.confirmed ? "ใช้งานได้" : "รอยืนยัน"}</td>
      <td class="muted-cell">${fmtDate(u.created_at)}</td>
      <td class="ta-right"><button class="btn btn-ghost btn-xs icon-only delUser" data-id="${u.id}" data-email="${escapeHtml(u.email)}" title="ลบผู้ใช้">${svgIcon("trash", 14)}</button></td>
    </tr>`).join("");
    body.querySelectorAll(".delUser").forEach((b) => (b.onclick = () => deleteUser(b.dataset.id, b.dataset.email)));
  } catch (e) {
    $("userNote").textContent = "โหลดผู้ใช้ไม่ได้: " + e.message;
  }
}

async function addUser() {
  const email = $("newUserEmail").value.trim();
  const password = $("newUserPass").value;
  const role = $("newUserRole").value;
  if (!email || !password) { toast("กรอกอีเมลและรหัสผ่าน", "error"); return; }
  if (password.length < 6) { toast("รหัสผ่านต้องอย่างน้อย 6 ตัว", "error"); return; }
  $("btnAddUser").disabled = true;
  try {
    await api("/api/users", "POST", { email, password, role });
    $("newUserEmail").value = ""; $("newUserPass").value = ""; $("newUserRole").value = "user";
    toast("สร้างผู้ใช้แล้ว", "success");
    loadUsers();
  } catch (e) { toast("สร้างไม่สำเร็จ: " + e.message, "error"); }
  finally { $("btnAddUser").disabled = false; }
}

async function deleteUser(id, email) {
  const ok = await confirmDialog(`ต้องการลบผู้ใช้นี้ถาวร?<br><b>${escapeHtml(email)}</b>`, "ลบผู้ใช้");
  if (!ok) return;
  try {
    await api(`/api/users/${encodeURIComponent(id)}`, "DELETE");
    toast("ลบผู้ใช้แล้ว", "success");
    loadUsers();
  } catch (e) { toast("ลบไม่สำเร็จ: " + e.message, "error"); }
}

if ($("btnAddUser")) $("btnAddUser").onclick = addUser;

// ============================================================
//  ตั้งค่า — AI setup ลูกค้าใหม่ (subject → AI ร่าง logic → แก้ → บันทึก)
// ============================================================
let aiLastSampleCount = 0;
async function aiDraftRun(isRevise) {
  const customer = $("aiCustName").value.trim();
  const subject = $("aiSubject").value.trim();
  if (!subject) { toast("ใส่ Subject อีเมลตัวอย่างก่อน", "error"); return; }
  const note = $("aiSetupNote");
  const btn = isRevise ? $("btnAiRevise") : $("btnAiDraft");
  btn.disabled = true;
  note.textContent = "🤖 AI กำลังดึงอีเมล + วิเคราะห์… (อาจใช้เวลาสักครู่)";
  try {
    const payload = { customer_name: customer, subject };
    if (isRevise) { payload.comment = $("aiComment").value.trim(); payload.previousDraft = $("aiDraftText").value; }
    const r = await api("/api/customer-settings/ai-draft", "POST", payload);
    $("aiDraftText").value = r.rules || "";
    $("aiDraftBox").style.display = "block";
    aiLastSampleCount = r.sampleCount || 0;
    $("aiSampleInfo").textContent = `วิเคราะห์จาก ${aiLastSampleCount} อีเมลตัวอย่าง`;
    if (isRevise) $("aiComment").value = "";
    note.textContent = "";
    toast(isRevise ? "AI ปรับคู่มือแล้ว" : "AI ร่างคู่มือเสร็จ — ตรวจ/แก้ได้", "success");
  } catch (e) {
    note.textContent = "✗ " + e.message;
    toast("AI วิเคราะห์ไม่สำเร็จ: " + e.message, "error");
  } finally { btn.disabled = false; }
}

async function aiSaveCustomer() {
  const customer = $("aiCustName").value.trim();
  const rules = $("aiDraftText").value.trim();
  if (!customer) { toast("ใส่ชื่อลูกค้าก่อน", "error"); return; }
  if (!rules) { toast("ยังไม่มีคู่มือให้บันทึก", "error"); return; }
  $("btnAiSave").disabled = true;
  try {
    // บันทึกเฉพาะ extraction_rules (allowed_fields/presets default ว่าง — ตั้งเพิ่มในตารางด้านล่างได้)
    await api("/api/customer-settings", "POST", { customer_name: customer, extraction_rules: rules });
    toast(`บันทึกลูกค้า "${customer}" แล้ว`, "success");
    // reset + โหลดตาราง field rules ใหม่ (ลูกค้าจะโผล่ในรายการด้านล่าง)
    $("aiDraftBox").style.display = "none";
    $("aiCustName").value = ""; $("aiSubject").value = ""; $("aiDraftText").value = "";
    if (typeof loadRules === "function") loadRules();
  } catch (e) { toast("บันทึกไม่สำเร็จ: " + e.message, "error"); }
  finally { $("btnAiSave").disabled = false; }
}

if ($("btnAiDraft")) $("btnAiDraft").onclick = () => aiDraftRun(false);
if ($("btnAiRevise")) $("btnAiRevise").onclick = () => aiDraftRun(true);
if ($("btnAiSave")) $("btnAiSave").onclick = aiSaveCustomer;

// ============================================================
//  ประวัติงาน + เอกสาร
// ============================================================
// ---- ประวัติงาน: filter ประเภท + แบ่งหน้า 10 รายการ/หน้า ----
const JOBS_PER_PAGE = 10;
let JOBS_ALL = [];     // ทุก job ที่โหลดมา (กรองแล้วตามประเภท)
let jobsPage = 1;
const JOB_TYPE_MAP = { rpa_import: "นำเข้าข้อมูล", rpa_edit: "แก้ไขใบเดิม", get_email: "ดึงอีเมล" };
const JOB_STATUS_MAP = { pending: "รอคิว", processing: "กำลังทำ", done: "เสร็จ", error: "ผิดพลาด", cancel: "ยกเลิก" };

async function loadJobs() {
  const type = ($("jobFilterType") && $("jobFilterType").value) || "";
  try {
    const d = await api(`/api/jobs${type ? `?type=${encodeURIComponent(type)}` : ""}`);
    JOBS_ALL = d.jobs || [];
    jobsPage = 1;
    renderJobs();
  } catch { /* ignore */ }
}

function renderJobs() {
  const body = $("jobsBody");
  if (!JOBS_ALL.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">ยังไม่มีประวัติ</td></tr>';
    $("jobsPager").innerHTML = "";
    return;
  }
  const totalPages = Math.max(1, Math.ceil(JOBS_ALL.length / JOBS_PER_PAGE));
  if (jobsPage > totalPages) jobsPage = totalPages;
  const start = (jobsPage - 1) * JOBS_PER_PAGE;
  const pageJobs = JOBS_ALL.slice(start, start + JOBS_PER_PAGE);
  body.innerHTML = pageJobs.map((j) => {
    const hasErr = j.status === "error" || (j.result && (j.result.errors ?? 0) > 0);
    const r = j.result
      ? `เสร็จ ${j.result.done ?? 0} · ผิด ${j.result.errors ?? 0}`
      : (j.error ? `<span class="job-err" title="${escapeHtml(String(j.error))}">${escapeHtml(String(j.error).slice(0, 50))}</span>` : "—");
    const by = j.trigger_source === "schedule" ? "ตั้งเวลา" : "ผู้ใช้";
    const stCls = j.status === "done" ? "st-done" : j.status === "error" ? "st-error" : j.status === "processing" ? "st-running" : "st-queued";
    return `<tr class="job-row${hasErr ? " job-row-err" : ""}" data-id="${j.id}" title="คลิกดู log ของงานนี้">
      <td class="muted-cell">${fmtDate(j.created_at)}</td>
      <td>${JOB_TYPE_MAP[j.type] || j.type}</td>
      <td><span class="st ${stCls}">${JOB_STATUS_MAP[j.status] || j.status}</span></td>
      <td>${r}</td>
      <td class="muted-cell">${by}</td>
    </tr>`;
  }).join("");
  body.querySelectorAll(".job-row").forEach((tr) => (tr.onclick = () => openJobLog(tr.dataset.id)));
  // pager
  renderJobsPager(totalPages);
}

// ---- Modal: ดู log + สรุปสาเหตุของงาน 1 งาน (จากประวัติงาน) ----
async function openJobLog(jobId) {
  if (!jobId) return;
  $("modalJobLog").style.display = "flex";
  const body = $("jlBody");
  body.innerHTML = '<p class="muted">กำลังโหลด log…</p>';
  try {
    const r = await api(`/api/jobs/${encodeURIComponent(jobId)}/logs`);
    const s = r.summary || {};
    const lines = r.lines || [];
    const summaryHtml = s.failed ? renderErrorBox(s, null) : "";
    const logHtml = lines.length
      ? `<pre class="err-log">${escapeHtml(lines.join("\n"))}</pre>`
      : '<p class="muted">ไม่มี log สำหรับงานนี้</p>';
    body.innerHTML = `
      ${summaryHtml}
      <div class="md-section-title" style="margin-top:14px">📜 Log ทั้งหมด (${lines.length} บรรทัด)</div>
      ${logHtml}
    `;
  } catch (e) {
    body.innerHTML = `<p class="note">โหลด log ไม่ได้: ${escapeHtml(e.message)}</p>`;
  }
}
function closeJobLog() { $("modalJobLog").style.display = "none"; }
if ($("jlClose")) $("jlClose").onclick = closeJobLog;
if ($("jlCloseBtn")) $("jlCloseBtn").onclick = closeJobLog;
if ($("modalJobLog")) $("modalJobLog").onclick = (e) => { if (e.target === $("modalJobLog")) closeJobLog(); };

function renderJobsPager(totalPages) {
  const pager = $("jobsPager");
  if (totalPages <= 1) { pager.innerHTML = `<span class="pager-info">${JOBS_ALL.length} รายการ</span>`; return; }
  const btn = (label, page, disabled, active) =>
    `<button class="pager-btn${active ? " active" : ""}" ${disabled ? "disabled" : ""} data-page="${page}">${label}</button>`;
  let html = `<span class="pager-info">${JOBS_ALL.length} รายการ · หน้า ${jobsPage}/${totalPages}</span><div class="pager-btns">`;
  html += btn("‹ ก่อนหน้า", jobsPage - 1, jobsPage <= 1, false);
  // เลขหน้า (ย่อถ้าเยอะ)
  for (let p = 1; p <= totalPages; p++) {
    if (totalPages > 7 && p > 2 && p < totalPages - 1 && Math.abs(p - jobsPage) > 1) {
      if (p === 3 || p === totalPages - 2) html += `<span class="pager-dots">…</span>`;
      continue;
    }
    html += btn(String(p), p, false, p === jobsPage);
  }
  html += btn("ถัดไป ›", jobsPage + 1, jobsPage >= totalPages, false);
  html += `</div>`;
  pager.innerHTML = html;
  pager.querySelectorAll(".pager-btn[data-page]").forEach((b) => (b.onclick = () => {
    const p = parseInt(b.dataset.page, 10);
    if (p >= 1 && p <= totalPages) { jobsPage = p; renderJobs(); }
  }));
}

$("btnRefreshJobs").onclick = loadJobs;
if ($("jobFilterType")) $("jobFilterType").onchange = loadJobs;

// (loadDocuments ถูกย้ายไป modal "ดูไฟล์" ต่อใบในหน้ารายการแล้ว — ดู openFiles)

// ============================================================
//  ตั้งค่า — Email schedule
// ============================================================
// 🔒 ดึงอีเมลอัตโนมัติถูกล็อกไว้ — แสดงได้แต่เปิดไม่ได้
const EMAIL_POLL_LOCKED = true;
async function loadEmailSchedule() {
  try {
    const s = await api("/api/email-schedule");
    $("epEnabled").checked = !!s.enabled;
    // แปลงเป็นนาทีเสมอ (ถ้าค่าเก่าเป็น hours → คูณ 60)
    $("epEvery").value = s.mode === "hours" ? (s.every || 1) * 60 : (s.every || 5);
    if (EMAIL_POLL_LOCKED) {
      $("epEnabled").checked = false;
      $("epEnabled").disabled = true;
      $("epEvery").disabled = true;
      $("btnSaveEmailSch").disabled = true;
      $("epStatus").textContent = "สถานะ: 🔒 ล็อกไว้ — ปิดดึงอีเมลอัตโนมัติ";
      return;
    }
    let status = s.enabled ? "เปิด — " + (s.human || "") : "ปิดอยู่";
    if (!s.ready) status += " (⚠ ยังไม่ได้ตั้ง Gmail/Gemini)";
    if (s.lastRunAt) status += " · ล่าสุด " + fmtDate(new Date(s.lastRunAt).toISOString());
    $("epStatus").textContent = "สถานะ: " + status;
  } catch (e) { $("epStatus").textContent = "โหลดไม่ได้: " + e.message; }
}
$("btnSaveEmailSch").onclick = async () => {
  if (EMAIL_POLL_LOCKED) { toast("ฟังก์ชันดึงอีเมลอัตโนมัติถูกล็อกไว้ ยังเปิดใช้งานไม่ได้", "error"); return; }
  const body = { enabled: $("epEnabled").checked, mode: "minutes", every: Math.max(1, Number($("epEvery").value) || 5) };
  try {
    const s = await api("/api/email-schedule", "POST", body);
    $("epStatus").textContent = "สถานะ: " + (s.enabled ? "เปิด — " + (s.human || "") : "ปิดอยู่");
    const sv = $("epSaved"); sv.style.display = "inline"; setTimeout(() => (sv.style.display = "none"), 2000);
    updatePollStatus();
  } catch (e) { toast("บันทึกไม่สำเร็จ: " + e.message, "error"); }
};

// ---- Allowlist ----
let emailRules = [];
function renderEmailRules() {
  const body = $("emailRulesBody");
  if (!emailRules.length) { body.innerHTML = '<tr><td colspan="2" class="empty">ยังไม่มีผู้ส่ง</td></tr>'; return; }
  body.innerHTML = emailRules.map((r, i) => `<tr><td>${escapeHtml(r.sender)}</td>
    <td><button class="btn btn-ghost btn-xs erDel" data-i="${i}">ลบ</button></td></tr>`).join("");
  body.querySelectorAll(".erDel").forEach((b) => (b.onclick = async () => {
    const r = emailRules[Number(b.dataset.i)];
    if (!(await confirmDialog(`ลบผู้ส่ง <b>${escapeHtml(r.sender)}</b>?`, "ลบผู้ส่ง"))) return;
    try { await api(`/api/email-rules?sender=${encodeURIComponent(r.sender)}`, "DELETE"); emailRules.splice(Number(b.dataset.i), 1); renderEmailRules(); }
    catch (e) { toast("ลบไม่สำเร็จ: " + e.message, "error"); }
  }));
}
async function loadEmailRules() {
  const note = $("emailRulesNote");
  try {
    const data = await api("/api/email-rules");
    if (!data.enabled) { note.textContent = "⚠ ยังไม่ได้ตั้งค่า Supabase"; emailRules = []; renderEmailRules(); return; }
    note.textContent = ""; emailRules = data.rules || []; renderEmailRules();
  } catch (e) { note.textContent = "โหลดไม่ได้: " + e.message; }
}
$("btnReloadEmailRules").onclick = loadEmailRules;
$("btnAddEmailRule").onclick = async () => {
  const sender = $("erSender").value.trim();
  if (!sender) { toast("ใส่อีเมลผู้ส่งก่อน", "error"); return; }
  try { await api("/api/email-rules", "POST", { sender, subject: "" }); $("erSender").value = ""; await loadEmailRules(); }
  catch (e) { toast("บันทึกไม่สำเร็จ: " + e.message, "error"); }
};

// ---- AI Model ----
const MODEL_PRESETS = ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"];
async function loadModel() {
  try {
    const d = await api("/api/model");
    const sel = $("modelSel"), custom = $("modelCustom");
    if (MODEL_PRESETS.includes(d.model)) { sel.value = d.model; custom.style.display = "none"; }
    else { sel.value = "__custom__"; custom.style.display = ""; custom.value = d.model || ""; }
    if (!d.enabled) $("modelNote").textContent = "⚠ ยังไม่ได้ตั้งค่า Supabase";
  } catch { /* ignore */ }
}
$("modelSel").onchange = () => { $("modelCustom").style.display = $("modelSel").value === "__custom__" ? "" : "none"; };
$("btnSaveModel").onclick = async () => {
  const sel = $("modelSel").value;
  const model = sel === "__custom__" ? $("modelCustom").value.trim() : sel;
  if (!model) { toast("ใส่ชื่อ model ก่อน", "error"); return; }
  try { await api("/api/model", "POST", { model }); const sv = $("modelSaved"); sv.style.display = "inline"; setTimeout(() => (sv.style.display = "none"), 2000); }
  catch (e) { toast("บันทึกไม่สำเร็จ: " + e.message, "error"); }
};

// ---- RPA config ----
async function loadConfig() {
  try {
    const c = await api("/api/config");
    $("cfgUrl").value = c.url || ""; $("cfgUser").value = c.username || ""; $("cfgPass").value = "";
    $("cfgSlow").value = c.slow_mo_ms ?? 0; $("cfgTimeout").value = c.default_timeout_ms ?? 30000;
    $("cfgHeadless").checked = !!c.headless;
    $("cfgEmail").checked = !!(c.email && c.email.enabled); $("cfgRecipient").value = (c.email && c.email.recipient) || "";
  } catch { /* ignore */ }
}
$("btnSaveCfg").onclick = async () => {
  const body = {
    url: $("cfgUrl").value, username: $("cfgUser").value,
    slow_mo_ms: Number($("cfgSlow").value), default_timeout_ms: Number($("cfgTimeout").value),
    headless: $("cfgHeadless").checked,
    email: { enabled: $("cfgEmail").checked, recipient: $("cfgRecipient").value },
  };
  if ($("cfgPass").value) body.password = $("cfgPass").value;
  try { await api("/api/config", "POST", body); const sv = $("cfgSaved"); sv.style.display = "inline"; setTimeout(() => (sv.style.display = "none"), 1800); }
  catch (e) { toast("บันทึก config ไม่สำเร็จ: " + e.message, "error"); }
};

// ---- Customer field rules (config/AI per field) ----
let ruleFields = [], catalogFields = [], custSettings = [];
const PAGE_NAMES = { 1: "หน้า 1 — หัวใบขน", 2: "หน้า 2 — ใบกำกับ/Invoice", 3: "หน้า 3 — รายละเอียดสินค้า" };
// โหมดของช่อง: ai = ใช้ค่า AI, config = กำหนดเอง, off = ไม่ใช้งาน(ไม่กรอก)
function fieldMode(s, key) {
  if (!s.allowed.has(key)) return "off";
  // "กำหนดเอง" = key อยู่ใน presets (แม้ค่าว่าง = ตั้งใจให้ช่องว่าง); ไม่อยู่ = "จาก AI"
  const hasPreset = Object.prototype.hasOwnProperty.call(s.presets, key);
  return hasPreset ? "config" : "ai";
}
// นับช่องที่ "ใช้งาน" (ai+config) ในกลุ่ม → โชว์ "ใช้ x/y"
function countActive(s, fields) {
  const on = fields.filter((f) => s.allowed.has(f.key)).length;
  return `${on}/${fields.length}`;
}

function renderCustomerSettings() {
  const c = $("rulesContainer");
  if (!custSettings.length) { c.innerHTML = '<p class="empty" style="padding:20px">ยังไม่มีลูกค้า — เพิ่มด้านบน</p>'; return; }

  const rowHtml = (f, si, s) => {
    const mode = fieldMode(s, f.key);
    const preset = (s.presets[f.key] != null) ? String(s.presets[f.key]) : "";
    return `<div class="cs-row ${mode === "off" ? "is-off" : ""}">
      <span class="cs-flabel">${escapeHtml(f.label)}</span>
      <select class="csMode sel sel-sm" data-s="${si}" data-f="${f.key}">
        <option value="ai" ${mode === "ai" ? "selected" : ""}>จาก AI</option>
        <option value="config" ${mode === "config" ? "selected" : ""}>กำหนดเอง</option>
        <option value="off" ${mode === "off" ? "selected" : ""}>ไม่ใช้งาน</option>
      </select>
      <input class="csPreset inp" data-s="${si}" data-f="${f.key}" placeholder="ค่าที่กำหนด" value="${escapeHtml(preset)}" style="display:${mode === "config" ? "" : "none"}" /></div>`;
  };

  // จัดช่องเป็นกลุ่มตามหน้า
  const byPage = {};
  ruleFields.forEach((f) => { const pg = f.page || 0; (byPage[pg] = byPage[pg] || []).push(f); });
  const pages = Object.keys(byPage).sort();

  c.innerHTML = custSettings.map((s, si) => {
    const pagesHtml = pages.map((pg) => {
      const fields = byPage[pg];
      const rows = fields.map((f) => rowHtml(f, si, s)).join("");
      return `<details class="cs-page">
        <summary><span class="cs-page-name">${escapeHtml(PAGE_NAMES[pg] || (pg == 0 ? "ทั่วไป" : "หน้า " + pg))}</span>
          <span class="cs-count">ใช้ ${countActive(s, fields)}</span></summary>
        <div class="cs-grid">${rows}</div></details>`;
    }).join("");
    return `<details class="cs-cust">
      <summary class="cs-cust-sum">
        <span class="cs-name">${escapeHtml(s.customer_name)}</span>
        <span class="cs-cust-meta">ใช้ ${countActive(s, ruleFields)} ช่อง</span>
        <span class="cs-cust-actions">
          <label class="chk-inline" onclick="event.stopPropagation()"><input type="checkbox" class="csCapture" data-s="${si}" ${s.request_screenshot ? "checked" : ""}/> ขอภาพหน้าจอ</label>
          <button class="btn btn-ghost btn-xs csDel" data-s="${si}" onclick="event.stopPropagation()">ลบ</button>
        </span>
      </summary>
      <div class="cs-cust-body">
        ${pagesHtml}
        <details class="cs-rules"><summary>กฎสกัด AI (Extraction Rules)</summary>
          <textarea class="csRules inp" data-s="${si}" rows="5">${escapeHtml(s.extraction_rules || "")}</textarea></details>
      </div>
    </details>`;
  }).join("");

  // dropdown 3 ค่า: ai / config / off
  c.querySelectorAll(".csMode").forEach((sel) => (sel.onchange = () => {
    const s = custSettings[+sel.dataset.s], f = sel.dataset.f;
    const row = sel.closest(".cs-row");
    const input = row.querySelector(".csPreset");
    if (sel.value === "off") {
      // ปิดใช้งาน: ออกจาก allowed + ลบ preset → RPA ไม่แตะช่องนี้
      s.allowed.delete(f); delete s.presets[f];
      if (input) { input.style.display = "none"; }
      row.classList.add("is-off");
    } else {
      s.allowed.add(f);
      row.classList.remove("is-off");
      if (sel.value === "config") {
        // กำหนดเอง: ต้องมี key ใน presets (แม้ค่าว่าง = ตั้งใจให้ว่าง)
        if (!Object.prototype.hasOwnProperty.call(s.presets, f)) s.presets[f] = "";
        if (input) input.style.display = "";
      } else {
        // จาก AI: ลบ preset ออก
        delete s.presets[f];
        if (input) { input.style.display = "none"; input.value = ""; }
      }
    }
  }));
  // เก็บค่า preset (รวมค่าว่าง — "กำหนดเอง ว่าง" = ตั้งใจล้างช่อง, ไม่ลบ key)
  c.querySelectorAll(".csPreset").forEach((el) => (el.oninput = () => {
    const s = custSettings[+el.dataset.s];
    s.presets[el.dataset.f] = el.value;
  }));
  c.querySelectorAll(".csRules").forEach((el) => (el.oninput = () => { custSettings[+el.dataset.s].extraction_rules = el.value; }));
  c.querySelectorAll(".csCapture").forEach((el) => (el.onchange = () => { custSettings[+el.dataset.s].request_screenshot = el.checked; }));
  c.querySelectorAll(".csDel").forEach((b) => (b.onclick = async () => {
    const s = custSettings[+b.dataset.s];
    if (!(await confirmDialog(`ลบการตั้งค่าของ <b>${escapeHtml(s.customer_name)}</b>?`, "ลบลูกค้า"))) return;
    try { await api(`/api/customer-settings?customer=${encodeURIComponent(s.customer_name)}`, "DELETE"); custSettings.splice(+b.dataset.s, 1); renderCustomerSettings(); }
    catch (e) { toast("ลบไม่สำเร็จ: " + e.message, "error"); }
  }));
}
// จัด 25 ช่องหลักเข้า 3 หน้า DCTK (key → page)
const FIELD_PAGE = {
  // หน้า 1 — หัวใบขน
  customer_name: 1, consignee_name: 1, buyer_country_code: 1, destination_country_code: 1,
  vessel_name: 1, voyage_number: 1, release_port_code: 1, loading_port_code: 1,
  tax_payment_method_code: 1, etd: 1, transport_mode: 1, mawb: 1, hawb: 1, reference_no: 1, exdec_doc_type: 1,
  // หน้า 2 — ใบกำกับ/Invoice
  invoice_number: 2, invoice_date: 2, incoterms: 2, currency: 2, total_goods_amount: 2,
  freight_charge: 2, insurance_charge: 2, shipping_mark: 2, freight_alloc: 2,
  // หน้า 3 — รายละเอียดสินค้า
  description_eng: 3, net_weight_kg: 3, gross_weight_kg: 3, net_weight_ton: 3, net_weight_unit_code: 3,
  container_or_volume_qty: 3, container_unit_code: 3, customs_unit_code: 3, export_tariff: 3,
};

async function loadRules() {
  const note = $("rulesNote");
  try {
    const data = await api("/api/customer-settings");
    // ใช้ 25 ช่องหลัก (RULE_FIELDS จาก backend) ที่ RPA กรอกได้จริง + ใส่หน้า
    ruleFields = (data.fields || []).map((f) => ({ ...f, page: FIELD_PAGE[f.key] || 1 }));
    if (!data.enabled) { note.textContent = "⚠ ยังไม่ได้ตั้งค่า Supabase"; custSettings = []; renderCustomerSettings(); return; }
    note.textContent = "";
    const allKeys = ruleFields.map((f) => f.key);
    custSettings = (data.settings || []).map((s) => ({
      customer_name: s.customer_name,
      // default = จาก AI: ถ้าลูกค้ายังไม่เคยตั้ง allowed_fields → เปิดทุกช่อง (จาก AI)
      allowed: new Set((s.allowed_fields && s.allowed_fields.length) ? s.allowed_fields : allKeys),
      presets: { ...(s.presets || {}) }, extraction_rules: s.extraction_rules || "", request_screenshot: !!s.request_screenshot,
    }));
    renderCustomerSettings();
  } catch (e) { note.textContent = "โหลดไม่ได้: " + e.message; }
}
$("btnAddCustomer").onclick = () => {
  const inp = $("newCustomer"), name = inp.value.trim();
  if (!name) { toast("ใส่ชื่อลูกค้าก่อน", "error"); return; }
  if (custSettings.some((s) => s.customer_name.toUpperCase() === name.toUpperCase())) { toast("มีลูกค้านี้แล้ว", "error"); return; }
  custSettings.unshift({ customer_name: name, allowed: new Set(ruleFields.map((f) => f.key)), presets: {}, extraction_rules: "", request_screenshot: false });
  inp.value = ""; renderCustomerSettings();
};
$("btnReloadRules").onclick = loadRules;
$("btnSaveRules").onclick = async () => {
  try {
    for (const s of custSettings)
      await api("/api/customer-settings", "POST", { customer_name: s.customer_name, allowed_fields: [...s.allowed], presets: s.presets, extraction_rules: s.extraction_rules || "", request_screenshot: !!s.request_screenshot });
    const sv = $("rulesSaved"); sv.style.display = "inline"; setTimeout(() => (sv.style.display = "none"), 2000);
    toast("บันทึกการตั้งค่าลูกค้าแล้ว", "success");
  } catch (e) { toast("บันทึกไม่สำเร็จ: " + e.message, "error"); }
};

// ============================================================
//  SSE — อัปเดตสถานะแบบ real-time
// ============================================================
function connectSSE() {
  const tok = authToken();
  const url = tok ? `/api/events?token=${encodeURIComponent(tok)}` : "/api/events";
  const es = new EventSource(url);
  es.addEventListener("decl-status", (e) => {
    const r = JSON.parse(e.data);
    setDeclStatusLocal(r.id, r.status, r.message);
  });
  es.addEventListener("decl-changed", () => { loadDecls(); });
  es.addEventListener("decl-meta", (e) => {
    // RPA capture เลขใบขน DCTK → อัปเดต local
    const r = JSON.parse(e.data);
    const d = DECLS.find((x) => x.id === r.id);
    if (d) d.declaration_no = r.declaration_no;
  });
  es.addEventListener("document", () => { /* เอกสารใหม่ — ถ้าเปิดหน้าประวัติอยู่ค่อยโหลด */ });
  es.onerror = () => { /* browser reconnect เอง */ };
}

// ============================================================
//  init
// ============================================================
let CURRENT_USER = null;
function applyRoleUI() {
  const admin = isAdmin();
  document.querySelectorAll('.nav-item[data-admin="true"]').forEach((n) => (n.style.display = admin ? "" : "none"));
  const badge = $("userBadge");
  if (CURRENT_USER && badge) badge.textContent = `${CURRENT_USER.email} · ${CURRENT_USER.role === "admin" ? "ผู้ดูแล" : "ผู้ใช้"}`;
  $("btnLogout").onclick = () => { localStorage.removeItem("sb_access_token"); localStorage.removeItem("sb_refresh_token"); location.href = "/login.html"; };
}

async function updatePollStatus() {
  try {
    const s = await api("/api/email-schedule");
    const el = $("pollStatus");
    if (s.enabled && s.ready) el.innerHTML = `${svgIcon("refresh", 13)} ดึงอีเมลอัตโนมัติ: ${escapeHtml(s.human || "")}`;
    else if (!s.ready) el.innerHTML = `${svgIcon("alert-circle", 13)} ยังไม่ได้ตั้ง Gmail/Gemini`;
    else el.innerHTML = `${svgIcon("circle", 13)} ดึงอีเมลอัตโนมัติ: ปิด`;
  } catch { /* ignore */ }
}

async function bootstrap() {
  try { const me = await api("/api/me"); CURRENT_USER = me.user || null; }
  catch { return; }
  applyRoleUI();
  showPage("list");
  connectSSE();
  updatePollStatus();
}
bootstrap();
