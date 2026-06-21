// ============================================================
//  CSS selectors — ported 1:1 from rpa_import.py
// ============================================================

// ---- Login + landing
export const SEL_USER_ID = "#UserId";
export const SEL_PASSWORD = "#Password";
export const SEL_BTN_SUBMIT = "#btnSubmit";
export const SEL_PORTFOLIO_MENU =
  "#portfolio > div > div > " +
  "div.form-group.col-md-10.col-lg-10.col-sm-10 > " +
  "div:nth-child(1) > a > img";
export const SEL_BTN_ADD = "#BtnAdd";

// ---- Page 1
export const SEL_PUR_COUNTRY = "#PurCountryCode";
export const SEL_DEST_COUNTRY = "#DestCountryCode";
export const SEL_BTN_BUYER_SEARCH =
  "#TabStrip-1 > div.col-xs-12.col-sm-8.col-md-9.col-lg-8 > " +
  "div:nth-child(3) > fieldset > div:nth-child(2) > " +
  "div.col-xs-8.col-sm-5.col-md-4.col-lg-4 > " +
  "div.col-xs-1.col-sm-1.col-md-1.col-lg-1.divBtnSearch.none-padding > button";
export const SEL_SEARCHED_WORDS = "#SearchedWords";
export const SEL_BTN_COMPANY = "#BtnCompany";
export const SEL_GRID_COMPANY_ROW =
  "#gridCompany > div.k-grid-content.k-auto-scrollable > table > " +
  "tbody > tr:first-child > td:nth-child(3)";
export const SEL_BTN_CONSIGNEE_SEARCH =
  "#TabStrip-1 > div.col-xs-12.col-sm-8.col-md-9.col-lg-8 > " +
  "div:nth-child(4) > fieldset > div > " +
  "div.col-xs-8.col-sm-5.col-md-4.col-lg-4 > " +
  "div.col-xs-1.col-sm-1.col-md-1.col-lg-1.divBtnSearch.none-padding > " +
  "button > span";
export const SEL_VESSEL_INPUT =
  "#TabStrip-1 > div.col-xs-12.col-sm-8.col-md-9.col-lg-8 > " +
  "div:nth-child(7) > fieldset > div:nth-child(3) > " +
  "div.col-xs-6.col-sm-4.col-md-4.col-lg-3 > " +
  "span.k-widget.k-combobox.k-header.k-combo-control-required" +
  ".k-dropdowngrid.k-combobox-clearable > span > input";
export const SEL_VOYAGE = "#Voyage";
export const SEL_PAPERLESS_INPUT =
  "#TabStrip-1 > div.col-xs-12.col-sm-8.col-md-9.col-lg-8 > " +
  "div:nth-child(7) > fieldset > div:nth-child(4) > " +
  "div.col-xs-12.col-sm-4.col-md-3.col-lg-3 > " +
  "div.col-xs-9.col-sm-9.col-md-9.col-lg-9-10 > " +
  "span.k-widget.k-combobox.k-header.k-combo-control-required" +
  ".k-dropdowngrid.k-combobox-clearable > span > input";
export const SEL_LOADING_INPUT =
  "#TabStrip-1 > div.col-xs-12.col-sm-8.col-md-9.col-lg-8 > " +
  "div:nth-child(7) > fieldset > div:nth-child(5) > " +
  "div.col-xs-12.col-sm-4.col-md-3.col-lg-3 > " +
  "div.col-xs-9.col-sm-9.col-md-9.col-lg-9-10 > " +
  "span.k-widget.k-combobox.k-header.k-combo-control-required" +
  ".k-dropdowngrid.k-combobox-clearable > span > input";
export const SEL_SHIPPING_MARK = "#ShippingMark";
export const SEL_DIVWATCH_LABEL =
  "#divWatching > div:nth-child(1) > fieldset > div:nth-child(3) > " +
  "div.col-xs-11.col-sm-11.col-md-11.col-lg-6 > label";
export const SEL_TAX_DROPDOWN =
  "#divWatching > div:nth-child(2) > fieldset > div:nth-child(2) > " +
  "div.col-xs-12.col-sm-12.col-md-12.col-lg-6-10 > " +
  "span.k-widget.k-dropdown.k-header.k-combo-control-required" +
  ".control-setFocus > span > span.k-input";
export const SEL_ETD_DATEPICKER =
  "#frmExDecCreate > " +
  "div.col-xs-12.col-sm-12.col-md-12.col-lg-12.group-focus > " +
  "div.col-xs-6.col-sm-8.col-md-8.col-lg-8 > div:nth-child(1) > " +
  "div:nth-child(4) > span.k-widget.k-maskedtextbox > " +
  "span.k-widget.k-datepicker.k-header.form-control-DateTime-required > " +
  "span > span > span";
export const SEL_BTN_SAVE = "#BtnSave";

// ---- Page 1 (ช่องเพิ่มเติม จาก inspect) ----
export const SEL_MAWB = "#Mawb";                       // text
export const SEL_HAWB = "#Hawb";                       // text (HAWB/BL)
export const SEL_REFERENCE_NO = "#ReferenceNoCommon";  // text (เลขอ้างอิงขนส่ง)
export const SEL_TRANSPORT_MODE = "#TransportMode";    // dropdown(kendo) — วิธีขนส่ง
export const SEL_EXDEC_DOC_TYPE = "#ExDecDocType";     // dropdown(kendo) — ชนิดเอกสารใบขน

// ---- Page 2
export const SEL_TAB2 = "#TabStrip > ul > li:nth-child(2) > span.k-link";
export const SEL_BTN_INVOICE_ADD = "#BtnExInvoiceAdd > div.visibility-lg";
export const SEL_INVOICE_NO = "#InvoiceNo";
export const SEL_INVOICE_DATE =
  "#frmExInvoiceCreate > div.row > div:nth-child(3) > div > " +
  "div.col-xs-12.col-sm-7.col-md-7.col-lg-7 > " +
  "span.k-widget.k-maskedtextbox > " +
  "span.k-widget.k-datepicker.k-header.form-control-DateTime-required > " +
  "span > span > span";
export const SEL_CONSIGNEE_INPUT =
  "#TabStrip-1 > div:nth-child(2) > div:nth-child(2) > fieldset > " +
  "div:nth-child(2) > div.col-xs-3.col-sm-3.col-md-3.col-lg-2 > " +
  "div.col-xs-9.col-sm-9.col-md-9.col-lg-10-5 > " +
  "span.k-widget.k-combobox.k-header.k-combo-control-required" +
  ".k-dropdowngrid.k-combobox-clearable > span > input";
export const SEL_TERM_DROPDOWN =
  "#TabStrip-1 > div.row.col-lg-8 > fieldset > " +
  "div.form-group.Invoice.DecDtl > " +
  "div.col-xs-2.col-sm-2.col-md-2.col-lg-1-5 > " +
  "span > span > span.k-input";
export const SEL_CURRENCY_INPUT =
  "#TabStrip-1 > div.row.col-lg-8 > fieldset > div:nth-child(6) > " +
  "div.col-xs-1.col-sm-1-5.col-md-1-5.col-lg-1-5" +
  ".currencyCode.padding-left-right > span > span > input";
export const SEL_AMOUNT = "#_AmountForeign";
export const SEL_FREIGHT =
  "#TabStrip-1 > div.row.col-lg-8 > fieldset > div:nth-child(8) > " +
  "div.col-xs-2.col-sm-2.col-md-2.col-lg-2.termForeign.padding-left-right > " +
  "span > span > input.k-formatted-value.right-numeric.k-input";
export const SEL_FREIGHT_CURRENCY =
  "#TabStrip-1 > div.row.col-lg-8 > fieldset > div:nth-child(8) > " +
  "div.col-xs-1.col-sm-1-5.col-md-1-5.col-lg-1-5" +
  ".currencyCode.padding-left-right > span > span > input";
export const SEL_INSURANCE =
  "#TabStrip-1 > div.row.col-lg-8 > fieldset > div:nth-child(9) > " +
  "div.col-xs-2.col-sm-2.col-md-2.col-lg-2.termForeign.padding-left-right > " +
  "span > span > input.k-formatted-value.right-numeric.k-input";
export const SEL_INSURANCE_CURRENCY =
  "#TabStrip-1 > div.row.col-lg-8 > fieldset > div:nth-child(9) > " +
  "div.col-xs-1.col-sm-1-5.col-md-1-5.col-lg-1-5" +
  ".currencyCode.padding-left-right > span > span > input";
// น้ำหนัก: CSS path เดิมจาก Python ที่รันสำเร็จ (rpa_import.py SEL_TOTAL_NET/GROSS)
//   ⚠ อย่าเปลี่ยนเป็น input[name="TotalNetWeight"] — name ชี้ hidden input → กรอกไม่ติด
export const SEL_TOTAL_NET =
  "#TabStrip-1 > div.row.lg-2 > fieldset > div:nth-child(2) > " +
  "div.col-xs-4.col-sm-4.col-md-4.col-lg-4 > " +
  "span.k-widget.k-numerictextbox.k-numeric-control-required.right-numeric > " +
  "span > input.k-formatted-value.k-numeric-control-required.right-numeric.k-input";
export const SEL_TOTAL_GROSS =
  "#TabStrip-1 > div.row.lg-2 > fieldset > div:nth-child(3) > " +
  "div.col-xs-4.col-sm-4.col-md-4.col-lg-4 > " +
  "span.k-widget.k-numerictextbox.k-numeric-control-required.right-numeric > " +
  "span > input.k-formatted-value.k-numeric-control-required.right-numeric.k-input";

// ---- Page 3
export const SEL_DESC_INPUT =
  "#divSender > div > div > " +
  "div.col-xs-10.col-sm-10.col-md-10.col-lg-10 > " +
  "span.k-widget.k-combobox.k-header.form-control-dropdown-required" +
  ".FirstFocus.k-dropdowngrid > span > input";
export const SEL_NET_TON_1 =
  "#TabStrip-1 > div > div > div:nth-child(3) > div > " +
  "div.col-xs-5-10.col-sm-4.col-md-4.col-lg-4 > fieldset > " +
  "div:nth-child(2) > div.col-xs-12.col-sm-12.col-md-7.col-lg-12 > " +
  "div.col-xs-7.col-sm-7.col-md-7.col-lg-7 > " +
  "span.k-widget.k-numerictextbox.k-numeric-control-required.right-numeric > " +
  "span > input.k-formatted-value.k-numeric-control-required" +
  ".right-numeric.k-input";
export const SEL_UNIT_1 =
  "#TabStrip-1 > div > div > div:nth-child(3) > div > " +
  "div.col-xs-5-10.col-sm-4.col-md-4.col-lg-4 > fieldset > " +
  "div:nth-child(2) > div.col-xs-12.col-sm-12.col-md-7.col-lg-12 > " +
  "div.col-xs-4.col-sm-4.col-md-4.col-lg-4-5 > span > span > input";
export const SEL_NET_TON_2 =
  "#TabStrip-1 > div > div > div:nth-child(3) > div > " +
  "div.col-xs-5-10.col-sm-4.col-md-4.col-lg-4 > fieldset > " +
  "div:nth-child(3) > div.col-xs-12.col-sm-12.col-md-7.col-lg-12 > " +
  "div.col-xs-7.col-sm-7.col-md-7.col-lg-7 > " +
  "span.k-widget.k-numerictextbox.k-numeric-control-required.right-numeric > " +
  "span > input.k-formatted-value.k-numeric-control-required" +
  ".right-numeric.k-input";
export const SEL_UNIT_2 =
  "#TabStrip-1 > div > div > div:nth-child(3) > div > " +
  "div.col-xs-5-10.col-sm-4.col-md-4.col-lg-4 > fieldset > " +
  "div:nth-child(3) > div.col-xs-12.col-sm-12.col-md-7.col-lg-12 > " +
  "div.col-xs-4.col-sm-4.col-md-4.col-lg-4-5 > span > span > input";
export const SEL_NET_KG =
  "#TabStrip-1 > div > div > div:nth-child(3) > div > " +
  "div.col-xs-5-10.col-sm-4.col-md-4-5.col-lg-4 > fieldset > " +
  "div:nth-child(2) > div.col-xs-12.col-sm-12.col-md-7.col-lg-12 > " +
  "div.col-xs-7.col-sm-7.col-md-7.col-lg-7 > " +
  "span.k-widget.k-numerictextbox.k-numeric-control-required.right-numeric > " +
  "span > input.k-formatted-value.k-numeric-control-required" +
  ".right-numeric.k-input";
export const SEL_GROSS_KG =
  "#TabStrip-1 > div > div > div:nth-child(3) > div > " +
  "div.col-xs-5-10.col-sm-4.col-md-4-5.col-lg-4 > fieldset > " +
  "div:nth-child(3) > div.col-xs-12.col-sm-12.col-md-7.col-lg-12 > " +
  "div.col-xs-7.col-sm-7.col-md-7.col-lg-7 > " +
  "span.k-widget.k-numerictextbox.k-numeric-control-required.right-numeric > " +
  "span > input.k-formatted-value.k-numeric-control-required" +
  ".right-numeric.k-input";
export const SEL_VOLUME =
  "#TabStrip-1 > div > div > div:nth-child(3) > div > " +
  "div.col-xs-5-10.col-sm-3-5.col-md-3-5.col-lg-2 > fieldset > div > " +
  "div.col-xs-12.col-sm-12.col-md-7.col-lg-12 > " +
  "div.col-xs-7.col-sm-7.col-md-7.col-lg-7 > " +
  "span.k-widget.k-numerictextbox.k-numeric-control-required.right-numeric > " +
  "span > input.k-formatted-value.k-numeric-control-required" +
  ".right-numeric.k-input";
export const SEL_CONTAINER_UNIT =
  "#TabStrip-1 > div > div > div:nth-child(3) > div > " +
  "div.col-xs-5-10.col-sm-3-5.col-md-3-5.col-lg-2 > fieldset > div > " +
  "div.col-xs-12.col-sm-12.col-md-7.col-lg-12 > " +
  "div.col-xs-4.col-sm-4.col-md-4.col-lg-4-5 > span > span > input";
// ⚠ หมายเหตุ: input[name="_Amount_input"] / _Freight_input / _UnitPrice_input
//   คือช่อง "สกุลเงิน" (combo USD) — ไม่ใช่ช่องตัวเลข!
//   ช่องตัวเลข "เงินต่างประเทศ" ไม่มี id/name → ต้องระบุด้วยตำแหน่ง div ในตารางราคา
//   ตารางราคา Page 3: แต่ละแถว = [สกุลเงิน][อัตรา][เงินตปท][เงินบาท]
//   ราคา/หน่วย(แถว1), ราคา/FOB(แถว2), ค่าขนส่ง(3), ค่าระวาง(4), ค่าประกัน(5)...
const TERM_BASE =
  "#TabStrip-1 > div > div > div:nth-child(4) > " +
  "div.col-xs-12.col-sm-12.col-md-7.col-lg-7.NonePadding > fieldset > ";
const TERM_NUM_TAIL =
  " > div.col-xs-2.col-sm-2.col-md-2.col-lg-2.termForeign.padding-left-right" +
  " > span > span > input.k-formatted-value.right-numeric.k-input";
// ช่องตัวเลข "เงินต่างประเทศ" (เดิม) — ราคา FOB = แถวที่ DCTK เรียก "ราคา"
export const SEL_TERM_AMOUNT =
  TERM_BASE + "div:nth-child(7)" + TERM_NUM_TAIL.replace("right-numeric.k-input", "k-numeric-control-required.right-numeric.k-input");
export const SEL_TERM_INSURANCE = TERM_BASE + "div:nth-child(10)" + TERM_NUM_TAIL;
// ช่องสกุลเงิน (combo) — มี name ชัด
export const SEL_TERM_AMOUNT_CURRENCY = 'input[name="_Amount_input"]';
export const SEL_TERM_FREIGHT_CURRENCY = 'input[name="_Freight_input"]';
export const SEL_TERM_INSURANCE_CURRENCY = 'input[name="_Insurance_input"]';
// ช่องตัวเลข "ค่าระวาง" (เงินต่างประเทศ) Page 3 — แถวค่าระวาง (div:nth-child 8 หรือ 9)
// ⚠ ไม่ใช่ _Freight_input (นั่นคือช่องสกุลเงิน) — ช่องตัวเลขระบุด้วยตำแหน่ง
export const SEL_TERM_FREIGHT_CANDIDATES: string[] = [
  ...((process.env.RPA_SEL_TERM_FREIGHT ?? "").trim()
    ? [(process.env.RPA_SEL_TERM_FREIGHT as string).trim()]
    : []),
  TERM_BASE + "div:nth-child(9)" + TERM_NUM_TAIL,
  TERM_BASE + "div:nth-child(8)" + TERM_NUM_TAIL,
];
// ช่องบังคับ Page 3 (DCTK ฟ้องถ้าว่าง) — จาก inspect/field-catalog
export const SEL_BRAND = "#Brand";                            // ยี่ห้อสินค้า (text)
export const SEL_DESC_THAI = "#ProductDescriptionThai";       // คำอธิบายสินค้าภาษาไทย (text)
export const SEL_DESC_ENG = "#ProductDescriptionEng";         // คำอธิบายสินค้าภาษาอังกฤษ (text)
export const SEL_EXPORT_TARIFF = '[name="ExportTariff_input"]'; // ประเภทพิกัดขาออก (combo) — override env RPA_SEL_EXPORT_TARIFF
export const SEL_EXPORT_TARIFF_INPUT =
  (process.env.RPA_SEL_EXPORT_TARIFF ?? "").trim() || SEL_EXPORT_TARIFF;

// รายการของแถม (FOC) — dropdown Kendo; ปกติ "11-ไม่ใช่ของแถม", FOC = ค่าอื่น
export const SEL_NATURE_TRANS = "#NatureTrans";

export const SEL_CHK_LAST_ENTRY = "#chkIsLastEntry";
export const SEL_BTN_SAVE_CLOSE = "#BtnSaveAndClose";

// ---- Page 3 (multi-item) ----
// ปุ่ม "บันทึกและเพิ่มใหม่" — บันทึกรายการปัจจุบัน + เปิดฟอร์มรายการถัดไป (ปุ่มเดียวจบ)
// ใช้กับทุกรายการ "ที่ไม่ใช่รายการสุดท้าย"; override ได้ผ่าน env: RPA_SEL_GOODS_SAVE_ADD
export const SEL_BTN_SAVE_AND_ADD =
  (process.env.RPA_SEL_GOODS_SAVE_ADD ?? "").trim() || "#BtnSaveAndAdd";
// modal แจ้งเตือน (บางลูกค้าเด้งหลังบันทึก) — กดปุ่ม "Yes" เพื่อยืนยัน (optional, ไม่ใช่ทุกราย)
export const SEL_MODAL_ALERT = "#myModalAlert";
export const SEL_MODAL_ALERT_YES =
  (process.env.RPA_SEL_MODAL_YES ?? "").trim() ||
  "#myModalAlert > div > div > div.modal-footer > div > div:nth-child(2) > button";

// ---- Page 4 (finalize)
export const SEL_BTN_DONE_INVOICE = "#BtnDoneExInvoice > div.visibility-lg";
export const SEL_DIALOG_OK = "#dialogboxfoot:visible > button:visible";
export const SEL_GRID_FIRST_ROW =
  "#grid > div.k-grid-content.k-auto-scrollable > table > tbody > " +
  "tr:nth-child(1) > td:nth-child(2)";
export const SEL_BTN_PRINT = "#BtnPrint";
export const SEL_REPORT_SAVE_BTN =
  "#Report_JsViewerMainPanel > div:nth-child(4) > div > table > tbody > " +
  "tr > td:nth-child(1) > table > tbody > tr > td:nth-child(1) > div > " +
  "table > tbody > tr > td:nth-child(2)";

// ---- หน้าค้น/แก้ใบขนเดิม (map จาก inspect-edit: portfolio + grid-filters.json) ----
// DCTK ใช้ Kendo grid filter ต่อคอลัมน์ — filter input ของ "เลขที่ใบขนฯ" ระบุด้วย aria-label
export const SEL_DECL_SEARCH_INPUT =
  (process.env.RPA_SEL_DECL_SEARCH ?? "").trim() ||
  'input[aria-label*="เลขที่ใบขนฯ"]'; // filter cell คอลัมน์ DeclarationNo
// ปุ่มค้นหา (มีในหน้า portfolio)
export const SEL_DECL_SEARCH_BTN =
  (process.env.RPA_SEL_DECL_SEARCH_BTN ?? "").trim() || "#btnSearch";
// แถวผลค้นแถวแรก (double-click เปิดใบเพื่อแก้) — grid content แถวแรก
export const SEL_DECL_GRID_ROW =
  (process.env.RPA_SEL_DECL_ROW ?? "").trim() ||
  "#grid > div.k-grid-content.k-auto-scrollable > table > tbody > tr:nth-child(1)";
// ปุ่ม save หน้าแก้ (default = save เดิม)
export const SEL_BTN_EDIT_SAVE =
  (process.env.RPA_SEL_EDIT_SAVE ?? "").trim() || SEL_BTN_SAVE;
