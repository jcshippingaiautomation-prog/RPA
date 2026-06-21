# Get Email to System — Full Technical Specification

**Version:** 1.0 **Target Stack:** Node.js (Express / NestJS) **Source:** n8n workflow `Get Email to System` (id: AdyspHpJlz2k0Fos) **Vendor APIs:** Gmail API, Google Sheets API, ConvertAPI, Google Gemini 2.5 Pro

---

## 1\. Overview

ระบบรับอีเมลที่มีเอกสารแนบ (Invoice, Booking Confirmation) จากลูกค้าผู้ส่งออก (Shipper/Exporter) โดยอัตโนมัติ แล้วใช้ AI สกัดข้อมูลสำคัญตามรูปแบบใบขนสินค้าขาออก (Export Declaration) แล้วบันทึกลง Google Sheets เพื่อให้ทีม Operation นำไปสร้างใบขนต่อใน Customs e-Service

### 1.1 Business Goal

- ลดเวลา manual data entry จาก \~15 นาที/ใบ เหลือ \~30 วินาที  
- รับเอกสารหลายฟอร์แมต (PDF, Word, Excel)  
- รองรับกฎสกัดข้อมูลเฉพาะแต่ละลูกค้า (Customer-specific extraction rules)  
- ป้องกันข้อมูลผิดด้วย fallback logic (เช่น น้ำหนัก ton↔kg, port code mapping)

### 1.2 High-Level Components

| Component | Responsibility |
| :---- | :---- |
| **Mail Ingest** | Poll Gmail ทุก 1 นาที, ดึงอีเมล \+ attachments |
| **Customer Filter** | ตรวจสอบว่าอีเมลมาจากลูกค้าที่ลงทะเบียน |
| **Document Converter** | แปลง PDF/DOCX/XLSX → JPG ผ่าน ConvertAPI |
| **AI Classifier** | สกัดชื่อลูกค้าจากภาพเอกสาร (AI Agent 1\) |
| **Rule Engine** | ดึงกฎสกัดข้อมูลเฉพาะลูกค้าจาก Google Sheets |
| **AI Extractor** | สกัดข้อมูล Export Declaration จากภาพ (AI Agent 2\) |
| **Post-processor** | Parse JSON \+ fallback logic \+ unit conversion |
| **Persistence** | Append row ลง Google Sheets |

---

## 2\. End-to-End Sequence Diagram

sequenceDiagram

    autonumber

    participant GM as Gmail

    participant API as Backend Service

    participant GS as Google Sheets

    participant CV as ConvertAPI

    participant AI1 as AI Agent (Classifier)

    participant AI2 as AI Agent (Extractor)

    GM-\>\>API: New email (polling 1 min)

    API-\>\>API: Extract sender email, subject, shipper name

    API-\>\>GS: Lookup email in Customer\_Rule sheet

    GS--\>\>API: Customer record (or empty)

    API-\>\>API: Compare subject vs registered subject pattern

    alt result \= "A" (valid customer \+ subject match)

        API-\>\>API: Iterate binary attachments, classify by extension

        loop For each attachment

            API-\>\>CV: POST convert {pdf|docx|xlsx}/to/jpg

            CV--\>\>API: Base64 JPG file(s)

        end

        API-\>\>API: Merge all JPGs into single item (file\_1..file\_N)

        API-\>\>AI1: Send images → extract customer keyword

        AI1--\>\>API: { search\_keyword, confidence\_score }

        API-\>\>GS: Lookup keyword in Identify\_Customer sheet

        GS--\>\>API: Customer-specific extraction rules

        API-\>\>AI2: Send images \+ rules → extract declaration data

        AI2-\>\>GS: (tool) Get\_Customer\_Rules

        GS--\>\>AI2: Rules JSON

        AI2--\>\>API: Export declaration JSON (25 fields)

        API-\>\>API: Parse JSON, apply fallback logic

        API-\>\>GS: Append row to "รายการ" sheet

        GS--\>\>API: Success

    else result \= "B" (not matching)

        API-\>\>API: Skip

    end

---

## 3\. Data Flow Diagram

flowchart LR

    A\[Gmail Trigger\] \--\> B\[Extract Email\]

    B \--\> C\[Customer Check\<br/\>Sheets lookup\]

    C \--\> D\[Merge1\]

    B \--\> D

    D \--\> E\[Compare Subject\<br/\>JS Code\]

    E \--\> F{If result==A?}

    F \--\>|Yes| G\[Get Message \+ Attachments\]

    F \--\>|No| X\[Stop\]

    G \--\> H\[Classify Attachment Type\<br/\>A=PDF, B=DOCX, C=XLSX\]

    H \--\> I{Switch routing\_type}

    I \--\>|A| J1\[PDF → JPG\]

    I \--\>|B| J2\[DOCX → JPG\]

    I \--\>|C| J3\[XLSX → JPG\]

    J1 \--\> K1\[Base64 → Binary\]

    J2 \--\> K2\[Base64 → Binary\]

    J3 \--\> K3\[Base64 → Binary\]

    K1 \--\> L\[Merge files\]

    K2 \--\> L

    K3 \--\> L

    L \--\> M\[Consolidate to single item\<br/\>file\_1..file\_N\]

    M \--\> N\[AI Agent: Classify Customer\]

    M \--\> P\[Merge2\]

    N \--\> O\[Parse keyword JSON\]

    O \--\> Q\[Lookup Customer Rules\]

    Q \--\> P

    P \--\> R\[Consolidate JSON \+ Binary\]

    R \--\> S\[AI Agent: Extract Declaration\<br/\>+ tool: Get\_Customer\_Rules\]

    S \--\> T\[Parse \+ Fallback Logic\]

    T \--\> U\[Append row to Sheet\]

---

## 4\. External Services & Credentials

| Service | Purpose | Auth | Notes |
| :---- | :---- | :---- | :---- |
| Gmail API | Read inbox, download attachments | OAuth2 (`JCOfficial`, `JcshiipngAi`) | Scope: `gmail.readonly` \+ `gmail.modify` |
| Google Sheets API | Customer registry, rules, results | OAuth2 (`JCai`) | Spreadsheet ID: `1-hR-Q_b01E6Ci_EB3Si9Pq8WiJ7j_UBwudzV9sVrFd8` |
| ConvertAPI | Document → JPG | Bearer token | Endpoint: `https://v2.convertapi.com/convert/{src}/to/jpg` |
| Google Gemini | LLM | API key (`Paid` credential) | Model: `models/gemini-2.5-pro` |

### 4.1 Environment Variables (Recommended)

GMAIL\_CLIENT\_ID=...

GMAIL\_CLIENT\_SECRET=...

GMAIL\_REFRESH\_TOKEN=...

GMAIL\_POLL\_INTERVAL\_MS=60000

GOOGLE\_SHEETS\_CREDENTIALS\_PATH=./creds/sheets-sa.json

SHEET\_ID=1-hR-Q\_b01E6Ci\_EB3Si9Pq8WiJ7j\_UBwudzV9sVrFd8

CONVERTAPI\_TOKEN=lfjq1ZrKVl8SdVcYaOAmI9yqPPNg2v8r

CONVERTAPI\_BASE=https://v2.convertapi.com

GEMINI\_API\_KEY=...

GEMINI\_MODEL=models/gemini-2.5-pro

---

## 5\. Google Sheets Schema

Spreadsheet: **Task and Data Management** (`1-hR-Q_b01E6Ci_EB3Si9Pq8WiJ7j_UBwudzV9sVrFd8`)

### 5.1 Sheet: `Customer_Rule` (gid=994808218)

ตารางลงทะเบียนลูกค้าและ subject pattern ที่ใช้กรองอีเมล

| Column | Type | Description |
| :---- | :---- | :---- |
| `Email` | string | อีเมลลูกค้า (ใช้ lookup) |
| `Subject` | string | Subject pattern ที่ระบบจะเทียบกับอีเมลขาเข้า |
| ... | ... | คอลัมน์อื่นๆ ของลูกค้า |

### 5.2 Sheet: `Identify_Customer` (gid=343836870)

ตารางจับคู่ keyword → กฎสกัดข้อมูลของลูกค้า

| Column | Type | Description |
| :---- | :---- | :---- |
| `Keyword_To_Search` | string | Keyword จาก AI Classifier (uppercase) |
| `Customer_Name` | string | ชื่อลูกค้าเต็ม |
| `Extraction_Rules` | JSON/text | กฎสกัดข้อมูลเฉพาะลูกค้า (ใช้โดย AI Extractor) |
| ... | ... | คอลัมน์เสริม |

### 5.3 Sheet: `รายการ` (gid=0) — Output Sheet

ผลลัพธ์สุดท้าย 25 คอลัมน์

| \# | Column | Type | Description |
| :---- | :---- | :---- | :---- |
| 1 | `customer_name` | string | ชื่อลูกค้า (เฉพาะแบรนด์ ไม่มี Co.,Ltd.) |
| 2 | `consignee_name` | string | ชื่อผู้ซื้อปลายทาง |
| 3 | `buyer_country_code` | string(2) | ISO 3166-1 alpha-2 |
| 4 | `destination_country_code` | string(2) | ISO 3166-1 alpha-2 |
| 5 | `invoice_number` | string | เลขที่ใบกำกับ |
| 6 | `invoice_date` | date (YYYY-MM-DD) | วันที่ใบกำกับ |
| 7 | `tax_payment_method_code` | string | ค่าคงที่ `"A"` |
| 8 | `vessel_name` | string | ชื่อเรือ |
| 9 | `voyage_number` | string | เที่ยวเรือ |
| 10 | `etd` | date (YYYY-MM-DD) | Estimated Time of Departure |
| 11 | `release_port_code` | string | รหัสสถานที่ตรวจปล่อย |
| 12 | `loading_port_code` | string | รหัสสถานที่รับบรรทุก |
| 13 | `incoterms` | string | CIF, FOB, CFR, ... |
| 14 | `currency` | string(3) | USD, EUR, ... |
| 15 | `total_goods_amount` | number | มูลค่าสินค้ารวม |
| 16 | `freight_charge` | number | ค่าระวาง |
| 17 | `insurance_charge` | number | ค่าประกัน |
| 18 | `shipping_mark` | string | เลขหมายหีบห่อ (ใต้คำว่า Mark) |
| 19 | `description_eng` | string | ชื่อสินค้าภาษาอังกฤษ |
| 20 | `net_weight_kg` | number | น้ำหนักสุทธิ (kg) |
| 21 | `gross_weight_kg` | number | น้ำหนักรวม (kg) |
| 22 | `net_weight_ton` | number | น้ำหนักสุทธิ (ton) |
| 23 | `net_weight_unit_code` | string | ค่าคงที่ `"TO"` |
| 24 | `container_or_volume_qty` | string/number | ตัวเลขก่อน "x" ใน volume |
| 25 | `container_unit_code` | string | รหัสหน่วยตู้ |

คอลัมน์เสริม (กรอกภายหลังโดยทีม Operation): `สถานะการสร้างเอกสาร`, `ลิงค์เอกสาร`, `ลิงค์แคปหน้าจอ`, `ชื่อผู้ตรวจสอบ`, `สถานะการอนุมัติ`, `สถานะต้องแก้ไข`, `สถานะการส่งข้อมูลให้ลูกค้า`

---

## 6\. Module-by-Module Specification

โครงสร้าง project ที่แนะนำ

src/

  modules/

    mail/              \# Gmail polling \+ parsing

    customer/          \# Customer registry \+ subject matching

    conversion/        \# ConvertAPI integration

    ai/                \# Gemini calls (classifier \+ extractor)

    sheets/            \# Google Sheets read/write

    pipeline/          \# Orchestration

  shared/

    dto/, types/, utils/

  main.ts

### 6.1 Module: `mail`

**Service:** `GmailPollingService`

**Responsibility:** Poll Gmail inbox ทุก `GMAIL_POLL_INTERVAL_MS` มิลลิวินาที, ดึงอีเมลใหม่พร้อมไฟล์แนบ

**Input:** none (cron-driven)

**Output:** `EmailMessage`

interface EmailMessage {

  id: string;

  threadId: string;

  from: string;          // Raw "Name \<email@x.com\>"

  subject: string;

  snippet: string;

  receivedAt: Date;

  attachments: Attachment\[\];

}

interface Attachment {

  filename: string;

  mimeType: string;

  data: Buffer;          // Decoded binary

}

**Implementation Notes:**

- ใช้ `googleapis` package (`google.gmail('v1')`)  
- เรียก `users.messages.list({ q: 'has:attachment newer_than:1d', userId: 'me' })`  
- เก็บ `lastProcessedHistoryId` ใน DB/Redis เพื่อ resume หลัง restart  
- Download attachment: `users.messages.attachments.get({ id, messageId, userId })`

**Equivalent n8n node:** `Gmail Trigger`

---

### 6.2 Module: `mail` — Extract metadata

**Function:** `extractEmailMetadata(email: EmailMessage): ExtractedEmailMeta`

**Logic:**

interface ExtractedEmailMeta {

  extracted\_email: string | null;   // From "\<email\>" tag in From header

  subject: string;

  shipper: string | null;           // From snippet pattern "Shipper: X" or Subject "SP.X"

}

**Algorithm:**

1. Parse `From` ด้วย regex `/<([^>]+)>/` หรือถ้าไม่มี `<>` ให้ใช้ทั้ง string ถ้ามี `@`  
2. ดึง `subject` ตรงๆ  
3. Shipper extraction:  
   - Try snippet regex: `/Shipper\s*[:\-]\s*([^\n]+)/i`  
   - Fallback subject regex: `/SP\.([^\/]+)/i` (รูปแบบ `SP.ZECK TSE //`)

**Equivalent n8n node:** `Extract Email`

---

### 6.3 Module: `customer`

#### 6.3.1 `CustomerRegistryService.lookupByEmail(email: string)`

- Sheet: `Customer_Rule`  
- Lookup column: `Email`  
- Returns: row object or `null`

**Equivalent n8n node:** `Customer Check`

#### 6.3.2 `SubjectMatcher.match(incoming: string, registered: string): 'A' | 'B'`

**Logic:**

function match(incoming: string, registered: string): 'A' | 'B' {

  if (\!incoming || \!registered) return 'B';

  const a \= incoming.trim().toLowerCase();

  const b \= registered.trim().toLowerCase();

  return (a.includes(b) || b.includes(a)) ? 'A' : 'B';

}

**Behavior:** case-insensitive substring match (สองทาง)

**Equivalent n8n node:** `Code in JavaScript8`

---

### 6.4 Module: `conversion`

**Service:** `DocumentConverterService`

**Responsibility:** แปลง PDF/DOCX/XLSX → JPG ผ่าน ConvertAPI

#### 6.4.1 Classification

type RoutingType \= 'A' | 'B' | 'C' | 'Unknown';

function classifyAttachment(att: Attachment): RoutingType {

  const name \= att.filename.toLowerCase();

  const mime \= att.mimeType.toLowerCase();

  if (name.endsWith('.pdf') || mime \=== 'application/pdf')           return 'A';

  if (/\\.(doc|docx)$/.test(name) || mime.includes('word'))           return 'B';

  if (/\\.(xls|xlsx|csv)$/.test(name) ||

      mime.includes('excel') || mime.includes('spreadsheet'))        return 'C';

  return 'Unknown';

}

**Equivalent n8n node:** `Code in JavaScript` (after Get a message3)

#### 6.4.2 Conversion call

async function convertToJpg(file: Attachment, type: RoutingType): Promise\<JpgFile\[\]\> {

  const endpoint \= {

    A: '/convert/pdf/to/jpg',

    B: '/convert/docx/to/jpg',

    C: '/convert/xlsx/to/jpg',

  }\[type\];

  const form \= new FormData();

  form.append('File', file.data, { filename: file.filename });

  const res \= await axios.post(\`${CONVERTAPI\_BASE}${endpoint}\`, form, {

    headers: {

      Authorization: \`Bearer ${CONVERTAPI\_TOKEN}\`,

      ...form.getHeaders(),

    },

    timeout: 120\_000,

  });

  // Response shape:

  // { ConversionCost: N, Files: \[{ FileName, FileExt, FileSize, FileData (base64) }\] }

  return res.data.Files.map(f \=\> ({

    filename: f.FileName,

    data: Buffer.from(f.FileData, 'base64'),

  }));

}

**Equivalent n8n nodes:** `PDF to JPG`, `Docs to JPG`, `Excel to JPG` \+ `Code in JavaScript 1/2/3`

#### 6.4.3 File merging

PDF/XLSX หลายหน้าจะได้ JPG หลายไฟล์ ต้อง consolidate เป็น 1 item พร้อม map key `file_1`, `file_2`, ...

interface ConvertedDocument {

  files: JpgFile\[\];        // ทุก JPG ที่แปลงได้

  filenames: string\[\];     // metadata

}

**Equivalent n8n node:** `Code in JavaScript4`

---

### 6.5 Module: `ai` — Classifier (AI Agent 1\)

**Service:** `CustomerClassifierAgent`

**Responsibility:** อ่านชื่อบริษัทผู้ส่งออกจากเอกสาร แล้วสกัดเป็น keyword สำหรับค้นหา

**Model:** `models/gemini-2.5-pro`

**Input:** ภาพ JPG ทุกหน้าจาก attachments

**System Prompt (ฉบับเต็ม):**

คุณคือ "Document Classifier AI" มีหน้าที่วิเคราะห์ชื่อบริษัทผู้ส่งออก (Shipper/Exporter)

เพื่อสกัดเป็น Keyword สำหรับค้นหาในระบบ

\[คำสั่งของคุณ (Instructions)\]

1\. ตรวจสอบข้อมูลชื่อบริษัทที่เป็นผู้ส่งออก ซึ่งระบบได้อ่านและส่งมาจากตำแหน่ง "Cell A1"

   ของเอกสาร

2\. \[สำคัญ\] กฎการสกัดชื่อ Keyword (Strict Rules): เมื่อคุณได้รับชื่อบริษัทแล้ว

   ให้ทำตามกฎเหล่านี้อย่างเคร่งครัด

   \- Rule 1: ลบคำสร้อยบริษัทและคำขยายความออกให้หมด เช่น CO., LTD., COMPANY,

     LIMITED, INC., CORP., INTERNATIONAL, GLOBAL, LOGISTICS, PUBLIC, PRODUCTS

   \- Rule 2: ลบเครื่องหมายวรรคตอนที่อยู่ท้ายชื่อ เช่น เครื่องหมายจุลภาค (,) หรือจุด (.)

   \- Rule 3: ผลลัพธ์สุดท้ายต้องเป็นตัวพิมพ์ใหญ่ทั้งหมด (UPPERCASE)

3\. คืนค่ากลับมาเป็นรูปแบบ JSON เท่านั้น ห้ามมีข้อความอธิบาย นำหน้า หรือต่อท้าย

   โครงสร้าง JSON เด็ดขาด

\[ตัวอย่างการสกัด Keyword\]

\- Input: "ZECK TSE INTERNATIONAL LTD."        \-\> "ZECK TSE"

\- Input: "THANAKORN VEGETABLE OIL PRODUCTS"   \-\> "THANAKORN"

\- Input: "ICONS GLOBAL LOGISTICS CO., LTD."   \-\> "ICONS"

\- Input: "SIAM CEMENT PUBLIC COMPANY LIMITED" \-\> "SIAM CEMENT"

\[Output Schema\]

{

  "search\_keyword": "ชื่อหลักของลูกค้าที่สกัดได้ (UPPERCASE)",

  "confidence\_score": 100,

  "found\_in\_document": "ระบุว่าดึงข้อมูลมาจากเอกสารประเภทใด"

}

**Output Parser (ถอด markdown fence):**

function parseClassifierOutput(raw: string): ClassifierResult {

  const cleaned \= raw

    .replace(/^\`\`\`json\\s\*/i, '')

    .replace(/\`\`\`\\s\*$/i, '')

    .trim();

  try {

    return JSON.parse(cleaned);

  } catch (err) {

    return {

      error\_message: 'Parse Failed: ข้อมูลที่ AI ส่งมาไม่ใช่ JSON ที่ถูกต้อง',

      raw\_output: raw,

    };

  }

}

**Equivalent n8n nodes:** `AI Agent4`, `AI1`, `Code in JavaScript5`

---

### 6.6 Module: `sheets` — Customer rule lookup

**Function:** `lookupCustomerRule(keyword: string)`

- Sheet: `Identify_Customer`  
- Lookup column: `Keyword_To_Search`  
- Lookup value: `search_keyword` จาก Classifier  
- Returns: full row (รวม `Customer_Name`, `Extraction_Rules`, ...)

**Equivalent n8n node:** `Get row(s) in sheet`

---

### 6.7 Module: `ai` — Extractor (AI Agent 2\)

**Service:** `DeclarationExtractorAgent`

**Responsibility:** สกัดข้อมูล Export Declaration 25 ฟิลด์จากเอกสาร

**Model:** `models/gemini-2.5-pro`

**Input:**

- ภาพ JPG ทุกหน้า (binary)  
- Customer rules (JSON จาก Sheet)

**Tool (function calling):** `Get_Customer_Rules`

- Description: ดึงคู่มือการสกัดข้อมูลเฉพาะลูกค้า  
- Sheet: `Customer_Rule` (gid=994808218)  
- Lookup: `Customer_Name`

**System Prompt (ฉบับเต็ม):**

คุณคือ "Export Declaration AI" ผู้เชี่ยวชาญด้านการสกัดข้อมูลและแปลงรหัสมาตรฐานสากล

เพื่อเตรียมข้อมูลส่งต่อให้ระบบ RPA

\[ข้อมูลนำเข้า (Input)\]

\- ไฟล์เอกสาร (รูปภาพ/PDF) เช่น Invoice, Booking Confirmation

\[กฎพื้นฐานที่ต้องปฏิบัติเสมอ (Global Standard Config)\]

\- การแปลงรหัสประเทศ (Country Code): หากในเอกสารเป็นชื่อประเทศเต็ม

  ให้แปลงเป็นรหัสย่อ 2 ตัวอักษร (ISO 3166-1 alpha-2) เสมอ

  เช่น THAILAND \-\> TH, VIETNAM \-\> VN, INDONESIA \-\> ID

\- รูปแบบวันที่: ต้องเป็น YYYY-MM-DD เสมอ

\- รูปแบบตัวเลข: ห้ามมีคอมม่า (,) ให้ใช้จุดทศนิยมปกติเท่านั้น

\[ขั้นตอนการทำงาน (Chain of Thought)\]

1\. \[Identify Customer\]: อ่านเอกสารเพื่อระบุชื่อบริษัทลูกค้า (Shipper/Exporter)

2\. \[Get Rules\]: เรียกใช้ tool "Get\_Customer\_Rules" โดยส่งชื่อลูกค้าที่พบ

   เพื่อดึง "คู่มือการสกัดข้อมูลเฉพาะลูกค้า" มาใช้งาน

3\. \[Extract & Map\]: สกัดข้อมูลจากเอกสารโดยทำตามกฎในคู่มือ (Rules)

   และกฎ Global Standard อย่างเคร่งครัด

4\. \[Logic Check\]: ตรวจสอบเงื่อนไขพิเศษ (เช่น การ Mapping รหัสท่าเรือ

   loading\_port\_code ตาม release\_port\_code) ตามที่ระบุใน Rules

5\. \[Output\]: ส่งออกเป็น JSON ตาม Schema ที่กำหนดเท่านั้น ห้ามมีข้อความอื่นเจือปน

\[โครงสร้าง JSON Output ที่ต้องการ (Schema)\]

{

  "buyer\_country\_code":       "รหัสประเทศผู้ซื้อ (ย่อ 2 ตัว)",

  "destination\_country\_code": "รหัสประเทศปลายทาง (ย่อ 2 ตัว)",

  "customer\_name":            "ชื่อบริษัทลูกค้า เอามาแค่ชื่อ ไม่ต้องเอาคำต่อท้ายมา

                               เช่น THANAKORN ไม่ต้องเอา International หรือ Co.,LTD มา",

  "vessel\_name":              "ชื่อเรือ",

  "voyage\_number":            "เที่ยวเรือ",

  "release\_port\_code":        "รหัสสถานที่ตรวจปล่อย",

  "loading\_port\_code":        "รหัสสถานที่รับบรรทุก",

  "shipping\_mark":            "เลขหมายหีบห่อ อยู่ใต้คำว่า Mark",

  "tax\_payment\_method\_code":  "รหัสชำระภาษี เป็น A เสมอ",

  "etd":                      "YYYY-MM-DD",

  "invoice\_number":           "เลขที่ใบกำกับ",

  "invoice\_date":             "YYYY-MM-DD",

  "consignee\_name":           "ชื่อผู้ซื้อ",

  "incoterms":                "เงื่อนไข (เช่น CIF)",

  "currency":                 "สกุลเงิน (เช่น USD)",

  "total\_goods\_amount":       0.00,

  "freight\_charge":           0.00,

  "insurance\_charge":         0.00,

  "net\_weight\_kg":            0.00,

  "gross\_weight\_kg":          0.00,

  "description\_eng":          "ชื่อสินค้าภาษาอังกฤษ",

  "net\_weight\_ton":           0.000,

  "net\_weight\_unit\_code":     "TO",

  "container\_or\_volume\_qty":  "ตัวเลขแรกของ Volume อยู่หน้าตัว X",

  "container\_unit\_code":      "รหัสหน่วยตู้"

}

**Equivalent n8n nodes:** `AI Agent3`, `AI` (lmChatGoogleGemini), `Get_Customer_Rules` (tool)

---

### 6.8 Module: `pipeline` — Post-processing & Fallback

**Function:** `postProcess(rawOutput: string): DeclarationRecord`

**Responsibilities:**

1. Extract JSON ออกจากข้อความ (รองรับ markdown fence \+ ข้อความเจือปน)  
2. คำนวณ kg ↔ ton อัตโนมัติ  
3. Mapping `loading_port_code` ตาม `release_port_code`  
4. บังคับ `buyer_country_code` \= `destination_country_code`

**Algorithm (จาก `Code in JavaScript7`):**

function postProcess(rawText: string): DeclarationRecord {

  // 1\. Extract JSON ด้วย regex (greedy match { ... })

  const m \= rawText.match(/\\{\[\\s\\S\]\*\\}/);

  const jsonStr \= m ? m\[0\] : '{}';

  let parsed: any \= {};

  try {

    parsed \= JSON.parse(jsonStr);

    // 2\. Weight conversion fallback

    if (parsed.weight\_and\_volume) {

      const w \= parsed.weight\_and\_volume;

      if (w.net\_weight\_ton \> 0 && (\!w.net\_weight\_kg || w.net\_weight\_kg \=== 0)) {

        w.net\_weight\_kg \= parseFloat((w.net\_weight\_ton \* 1000).toFixed(2));

      }

      w.gross\_weight\_kg \= parseFloat(w.gross\_weight\_kg) || 0;

    }

    // 3\. Port code mapping (ตัวอย่าง: รหัสขึ้นต้น "28" → loading "2801")

    if (parsed.shipping\_info?.release\_port\_code) {

      const rp \= String(parsed.shipping\_info.release\_port\_code);

      if (rp.startsWith('28') && \!parsed.shipping\_info.loading\_port\_code) {

        parsed.shipping\_info.loading\_port\_code \= '2801';

      }

    }

    // 4\. Force buyer \= destination country

    if (parsed.country\_info?.destination\_country\_code) {

      parsed.country\_info.buyer\_country\_code \=

        parsed.country\_info.destination\_country\_code;

    }

  } catch (err) {

    parsed \= {

      \_has\_error: true,

      \_error\_message: 'Parse Failed',

      raw\_output: rawText,

      system\_error: err.message,

    };

  }

  return parsed;

}

**หมายเหตุ:** code เดิมใน n8n อ้างถึง nested objects (`weight_and_volume`, `shipping_info`, `country_info`) แต่ schema ของ AI Agent3 ส่งออกมาแบบ flat ดังนั้นในการ port ไป Node.js ควรปรับให้ตรงกัน (ดูใน §10 Known Issues)

**Equivalent n8n node:** `Code in JavaScript7`

---

### 6.9 Module: `sheets` — Append result

**Function:** `appendDeclaration(record: DeclarationRecord)`

- Sheet: `รายการ` (gid=0)  
- Operation: `append`  
- Mapping: 25 ฟิลด์ตาม §5.3

**Implementation:**

await sheets.spreadsheets.values.append({

  spreadsheetId: SHEET\_ID,

  range: 'รายการ\!A1',

  valueInputOption: 'USER\_ENTERED',

  insertDataOption: 'INSERT\_ROWS',

  requestBody: { values: \[\[

    record.customer\_name,

    record.consignee\_name,

    record.buyer\_country\_code,

    record.destination\_country\_code,

    record.invoice\_number,

    record.invoice\_date,

    record.tax\_payment\_method\_code,

    record.vessel\_name,

    record.voyage\_number,

    record.etd,

    record.release\_port\_code,

    record.loading\_port\_code,

    record.incoterms,

    record.currency,

    record.total\_goods\_amount,

    record.freight\_charge,

    record.insurance\_charge,

    record.shipping\_mark,

    record.description\_eng,

    record.net\_weight\_kg,

    record.gross\_weight\_kg,

    record.net\_weight\_ton,

    record.net\_weight\_unit\_code,

    record.container\_or\_volume\_qty,

    record.container\_unit\_code,

  \]\] },

});

**Equivalent n8n node:** `Append row in sheet`

---

## 7\. Orchestration Pseudocode

class EmailProcessingPipeline {

  async processEmail(email: EmailMessage): Promise\<void\> {

    // Step 1: Extract metadata

    const meta \= extractEmailMetadata(email);

    if (\!meta.extracted\_email) return;

    // Step 2: Customer \+ subject check

    const customer \= await this.customerRegistry.lookupByEmail(meta.extracted\_email);

    if (\!customer) return;

    if (this.subjectMatcher.match(meta.subject, customer.Subject) \!== 'A') return;

    // Step 3: Convert attachments → JPG

    const jpgFiles: JpgFile\[\] \= \[\];

    for (const att of email.attachments) {

      const type \= classifyAttachment(att);

      if (type \=== 'Unknown') continue;

      const converted \= await this.converter.convertToJpg(att, type);

      jpgFiles.push(...converted);

    }

    if (jpgFiles.length \=== 0\) return;

    // Step 4: Classify customer keyword

    const classification \= await this.classifier.classify(jpgFiles);

    if (classification.error\_message) {

      this.logger.error('Classifier failed', classification);

      return;

    }

    // Step 5: Lookup customer rules

    const rule \= await this.sheetsService.lookupCustomerRule(

      classification.search\_keyword,

    );

    // Step 6: Extract declaration

    const rawOutput \= await this.extractor.extract(jpgFiles, rule);

    // Step 7: Post-process

    const record \= postProcess(rawOutput);

    if (record.\_has\_error) {

      this.logger.error('Extractor parse failed', record);

      await this.deadLetterQueue.push({ email, record });

      return;

    }

    // Step 8: Append to sheet

    await this.sheetsService.appendDeclaration(record);

    this.logger.info('Processed', { emailId: email.id, customer: record.customer\_name });

  }

}

---

## 8\. AI Tool Definition (Gemini function calling)

const getCustomerRulesTool: Tool \= {

  functionDeclarations: \[{

    name: 'Get\_Customer\_Rules',

    description: 'ดึงคู่มือการสกัดข้อมูลเฉพาะลูกค้าจาก Google Sheets',

    parameters: {

      type: 'object',

      properties: {

        Customer\_Name: {

          type: 'string',

          description: 'ชื่อลูกค้าที่สกัดได้จากเอกสาร (UPPERCASE keyword)',

        },

      },

      required: \['Customer\_Name'\],

    },

  }\],

};

// Handler

async function handleToolCall(call: FunctionCall) {

  if (call.name \=== 'Get\_Customer\_Rules') {

    const row \= await sheetsService.lookupCustomerRule(call.args.Customer\_Name);

    return { customer\_rules: row };

  }

}

---

## 9\. Error Handling & Edge Cases

| \# | Scenario | Trigger | Handling |
| :---- | :---- | :---- | :---- |
| 1 | Email มาจากบุคคลที่ไม่ใช่ลูกค้า | `Customer_Rule` lookup คืนค่าว่าง | Skip silently, log to monitor channel |
| 2 | Subject ไม่ตรงกับ registered pattern | `SubjectMatcher.match() === 'B'` | Skip, ไม่นับเป็น error |
| 3 | อีเมลไม่มี attachment | `email.attachments.length === 0` | Skip \+ log warning |
| 4 | ไฟล์แนบเป็น format ที่ไม่รู้จัก (.zip, .png) | `classifyAttachment === 'Unknown'` | ข้ามไฟล์นั้น แต่ทำต่อกับไฟล์อื่น |
| 5 | ConvertAPI ตอบ 5xx / timeout | axios error | Retry 3 ครั้ง (exponential backoff 2s, 4s, 8s) แล้วโยน DLQ |
| 6 | ConvertAPI quota หมด | 402/429 | Alert ไป channel `#ops-alerts`, pause pipeline |
| 7 | Gemini ตอบไม่ใช่ JSON | `JSON.parse` throw | Regex extract `\{[\s\S]*\}` ใหม่; ถ้ายังพังให้ใส่ `_has_error: true` แล้วส่ง DLQ |
| 8 | Gemini ตอบ JSON แต่ฟิลด์ขาด | Missing required fields | Apply default values (เช่น `tax_payment_method_code = 'A'`, `net_weight_unit_code = 'TO'`); flag เป็น `needs_review` |
| 9 | Gemini ใส่ markdown fence | ```` ```json ... ``` ```` | Regex strip ก่อน parse |
| 10 | Net weight มีแต่ ton ไม่มี kg | `net_weight_kg <= 0 && net_weight_ton > 0` | Auto-calc `kg = ton * 1000` |
| 11 | Release port code ขึ้นต้น "28" แต่ไม่มี loading port | conditional | Set `loading_port_code = '2801'` |
| 12 | `buyer_country_code` ขัดแย้งกับ `destination_country_code` | mismatch | Force `buyer = destination` |
| 13 | Number มี comma (เช่น "1,234.56") | string with `,` | Strip commas ก่อน `parseFloat` |
| 14 | Date format อื่น (DD/MM/YYYY) | regex mismatch | ใช้ `dayjs.parse` พร้อม fallback formats |
| 15 | Google Sheets quota (429) | API limit | Retry with backoff; cache `Customer_Rule` ใน memory 5 นาที |
| 16 | Gmail polling overlap | คนเดียวกันรันซ้ำ | ใช้ `lastHistoryId` \+ distributed lock (Redis) |
| 17 | Same email ถูกประมวลผลซ้ำ | restart / duplicate poll | Idempotency key \= `email.id`; เก็บใน DB ก่อน append |
| 18 | Attachment ใหญ่เกิน 10 MB | ConvertAPI limit | Pre-check ขนาด; ถ้าใหญ่ → ส่ง alert ให้แยกไฟล์ |
| 19 | OAuth token หมดอายุ | 401 | Auto-refresh; ถ้า refresh token หมด → ส่ง critical alert |
| 20 | AI Agent3 ไม่เรียก tool | ตอบทันทีโดยไม่ใช้ context rule | ตรวจสอบ output; ถ้าฟิลด์สำคัญหายให้ retry พร้อม forced rule injection ใน prompt |

### 9.1 Dead Letter Queue

interface DLQItem {

  emailId: string;

  stage: 'classify' | 'extract' | 'parse' | 'sheets';

  error: string;

  payload: any;

  createdAt: Date;

  retryCount: number;

}

- Persist ใน DB (Postgres/Mongo)  
- Worker แยกเพื่อ manual review หรือ replay

---

## 10\. Known Issues / Improvements ที่พบจาก n8n source

| \# | Issue | ผลกระทบ | แนะนำให้แก้เมื่อ port |
| :---- | :---- | :---- | :---- |
| 1 | `Code in JavaScript7` อ้าง nested keys (`weight_and_volume`, `shipping_info`) แต่ AI Agent3 schema เป็น flat | Fallback logic ไม่ทำงาน | ปรับ post-process ให้ตรงกับ flat schema |
| 2 | Tool `Get_Customer_Rules` ใช้ `gid=994808218` (= `Customer_Rule`) แต่ `cachedResultName` เป็น `Get_Customer_Rule` | Lookup ผิด sheet | ตรวจสอบและตั้งชื่อ/gid ให้ตรงกัน |
| 3 | `Code in JavaScript4` ส่ง 2 ทาง: → AI Agent4 และ → Merge2 ทำให้ Merge2 ต้องรอ binary มาก่อน customer rule | Possible race / ลำดับเพี้ยน | ใช้ explicit `await Promise.all([classify, lookupRule])` |
| 4 | `Customer Check` lookup ที่ `Customer_Rule` แต่ comment เรียกเป็น `Get_Customer_Rule` (ชื่อ cached) | Confuse maintainer | Rename sheet ให้ชัดเจน |
| 5 | ConvertAPI token hard-coded ใน workflow | Security risk | ย้ายไป env / secrets manager |
| 6 | Polling 1 นาที \= 1,440 calls/day | Quota | ใช้ Gmail Push notification (pub/sub) แทน |
| 7 | ไม่มี dedup ระดับอีเมล | Process ซ้ำได้ถ้า restart | เพิ่ม `processed_email_ids` table |
| 8 | Switch รองรับเฉพาะ A/B/C ไฟล์อื่น (image, zip) ตกหมด | Lose data | เพิ่ม fallback route หรือ alert |
| 9 | AI prompts มีคำว่า "Cell A1" ซึ่งไม่จริงในภาพ | AI งง | แก้เป็น "หน้าแรกของเอกสาร" |
| 10 | `simple: false` ใน Gmail node ทำให้ payload ใหญ่มาก | Memory | parse เอาเฉพาะที่ใช้ |

---

## 11\. Testing Strategy

### 11.1 Unit Tests

| Module | Test cases |
| :---- | :---- |
| `extractEmailMetadata` | (a) From มี `<>`, (b) From ไม่มี, (c) Subject pattern `SP.X`, (d) Snippet pattern `Shipper: X`, (e) ทั้งคู่ไม่มี |
| `SubjectMatcher` | (a) ตรงเป๊ะ, (b) substring, (c) case mismatch, (d) ค่าว่าง |
| `classifyAttachment` | (a) .pdf, (b) .docx, (c) .xls, (d) .csv, (e) .png (unknown) |
| `postProcess` | (a) JSON สมบูรณ์, (b) มี markdown fence, (c) มีข้อความเจือปน, (d) net\_weight\_ton only, (e) port code 28xx, (f) JSON พัง |
| `parseClassifierOutput` | (a) clean JSON, (b) markdown fence, (c) invalid |

### 11.2 Integration Tests

- Mock Gmail \+ ConvertAPI \+ Gemini ด้วย nock  
- End-to-end ด้วยอีเมลตัวอย่าง 1 ชุด (PDF, DOCX, XLSX)  
- Verify append ใน Sheets test spreadsheet

### 11.3 Sample test fixture

Subject ตัวอย่างจริงจาก workflow:

แจ้งทำ ใบขน+FORM CO // SP.ZECK TSE //INV.2604034//BKG.GOSUBKK80447666 // Durban, South Africa // SO-250213///ZO457-101225

Expected extracted:

- `shipper` \= `"ZECK TSE"`  
- `search_keyword` (จาก AI) \= `"ZECK TSE"`  
- `destination_country_code` \= `"ZA"` (South Africa)

---

## 12\. Deployment & Operations

### 12.1 Runtime

- Node.js 20 LTS  
- NestJS recommended (DI \+ scheduler module)  
- PM2 หรือ Docker

### 12.2 Scheduler

- ใช้ `@nestjs/schedule` → `@Cron(CronExpression.EVERY_MINUTE)` สำหรับ polling  
- หรือ Gmail Push Notifications \+ Cloud Pub/Sub สำหรับ near-real-time

### 12.3 Monitoring

- Metrics: `emails_received_total`, `emails_processed_total`, `convertapi_failures_total`, `ai_parse_failures_total`, `processing_duration_seconds`  
- Log structured JSON ทุก stage  
- Alert: ConvertAPI quota, OAuth refresh failure, DLQ count \> threshold

### 12.4 Secrets

- Google Secret Manager / AWS Secrets Manager  
- Rotate ConvertAPI token ทุก 90 วัน

---

## 13\. Appendix A — Sample Payloads

### 13.1 Gmail message (parsed)

{

  "id": "19d755b9e2fe60ca",

  "threadId": "19d755b9e2fe60ca",

  "from": "Ops \<ops@customer.com\>",

  "subject": "แจ้งทำ ใบขน+FORM CO // SP.ZECK TSE //INV.2604034//...",

  "snippet": "Shipper: ZECK TSE INTERNATIONAL ...",

  "attachments": \[

    { "filename": "INV2604034.pdf", "mimeType": "application/pdf", "data": "\<Buffer\>" }

  \]

}

### 13.2 ConvertAPI response

{

  "ConversionCost": 1,

  "Files": \[

    {

      "FileName": "INV2604034.jpg",

      "FileExt": "jpg",

      "FileSize": 245760,

      "FileData": "\<base64...\>"

    }

  \]

}

### 13.3 Classifier output

{

  "search\_keyword": "ZECK TSE",

  "confidence\_score": 100,

  "found\_in\_document": "Commercial Invoice"

}

### 13.4 Extractor output (clean)

{

  "buyer\_country\_code": "ZA",

  "destination\_country\_code": "ZA",

  "customer\_name": "ZECK TSE",

  "vessel\_name": "MAERSK SENTOSA",

  "voyage\_number": "445S",

  "release\_port\_code": "2801",

  "loading\_port\_code": "2801",

  "shipping\_mark": "ZECK TSE/DURBAN/...",

  "tax\_payment\_method\_code": "A",

  "etd": "2026-03-15",

  "invoice\_number": "2604034",

  "invoice\_date": "2026-02-28",

  "consignee\_name": "ZECK TSE TRADING (PTY) LTD",

  "incoterms": "CIF",

  "currency": "USD",

  "total\_goods\_amount": 45230.50,

  "freight\_charge": 1850.00,

  "insurance\_charge": 120.00,

  "net\_weight\_kg": 18500.00,

  "gross\_weight\_kg": 19200.00,

  "description\_eng": "REFINED PALM OIL",

  "net\_weight\_ton": 18.500,

  "net\_weight\_unit\_code": "TO",

  "container\_or\_volume\_qty": "1",

  "container\_unit\_code": "20FT"

}

---

## 14\. Appendix B — n8n Node → Module Mapping

| n8n Node | Type | Node.js Module/Function |
| :---- | :---- | :---- |
| Gmail Trigger | trigger | `mail.GmailPollingService` |
| Extract Email | code | `mail.extractEmailMetadata()` |
| Customer Check | sheets | `customer.CustomerRegistryService.lookupByEmail()` |
| Merge1 | merge | (inline) |
| Code in JavaScript8 | code | `customer.SubjectMatcher.match()` |
| If | branching | `if (result === 'A')` |
| Get a message3 | gmail | `mail.GmailClient.getMessage()` |
| Code in JavaScript | code | `conversion.classifyAttachment()` |
| จัดการไฟล์ (Switch) | switch | `switch(routingType)` |
| PDF/Docs/Excel to JPG | http | `conversion.DocumentConverterService.convertToJpg()` |
| Code in JavaScript 1/2/3 | code | (inline base64 decode) |
| Merge | merge | (inline) |
| Code in JavaScript4 | code | `conversion.consolidateFiles()` |
| AI Agent4 \+ AI1 | langchain | `ai.CustomerClassifierAgent.classify()` |
| Code in JavaScript5 | code | `ai.parseClassifierOutput()` |
| Get row(s) in sheet | sheets | `sheets.lookupCustomerRule()` |
| Merge2 | merge | (inline) |
| Code in JavaScript6 | code | (inline consolidation) |
| AI Agent3 \+ AI | langchain | `ai.DeclarationExtractorAgent.extract()` |
| Get\_Customer\_Rules (tool) | sheets tool | Gemini function calling handler |
| Code in JavaScript7 | code | `pipeline.postProcess()` |
| Append row in sheet | sheets | `sheets.appendDeclaration()` |
| **(test only)** Get many messages, Get a message2/4, Manual Trigger | n/a | ไม่ port (เป็น test fixture) |

---

*End of Specification*  
