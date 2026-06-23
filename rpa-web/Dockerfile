# rpa-web — Node + LibreOffice (soffice) สำหรับแปลง Office (.xlsx/.docx) → PDF ก่อนส่ง Gemini
#
# ⚠ Build context = REPO ROOT (ไม่ใช่ rpa-web/) เพราะ rpa-web พึ่ง rpa-import-node แบบ
#   "file:../rpa-import-node" → Docker ต้องเห็นทั้ง 2 โฟลเดอร์ (เหมือน build-web.sh)
#   render.yaml ตั้ง dockerContext: . และ dockerfilePath: ./rpa-web/Dockerfile
FROM node:22-bookworm-slim

# LibreOffice (calc/writer) + ฟอนต์ไทย (จำเป็น ไม่งั้น xlsx ไทยเพี้ยน/กลายเป็นกล่อง)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libreoffice-calc \
        libreoffice-writer \
        fonts-thai-tlwg \
        fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# soffice อยู่ใน PATH ของ image — files.ts เรียก "soffice" ตรง ๆ ได้
ENV SOFFICE_BIN=soffice

WORKDIR /app

# ---- 1) build rpa-import-node ก่อน (rpa-web พึ่งพา ต้องมี dist/) ----
COPY rpa-import-node/package.json rpa-import-node/package-lock.json ./rpa-import-node/
# ข้าม postinstall (playwright) — เว็บไม่ต้องใช้ chromium
RUN cd rpa-import-node && npm ci --include=dev --ignore-scripts
COPY rpa-import-node ./rpa-import-node
RUN cd rpa-import-node && npm run build

# ---- 2) build rpa-web (อ้าง ../rpa-import-node) ----
COPY rpa-web/package.json rpa-web/package-lock.json ./rpa-web/
RUN cd rpa-web && npm ci --include=dev --ignore-scripts
COPY rpa-web ./rpa-web
RUN cd rpa-web && npm run build

# production runtime
ENV NODE_ENV=production
WORKDIR /app/rpa-web
EXPOSE 8000
CMD ["npm", "start"]
