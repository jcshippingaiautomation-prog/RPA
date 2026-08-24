// logging HTTP forward proxy (สำหรับ HTTP เท่านั้น — DCTK เป็น http) — บันทึก POST body ทุก request
import http from "node:http";
import net from "node:net";
import { writeFileSync, appendFileSync } from "node:fs";
const OUT = process.env.OUT || ".";
const LOG = OUT + "/proxy-capture.jsonl";
writeFileSync(LOG, "");
let n = 0;

const server = http.createServer((creq, cres) => {
  const target = creq.url; // absolute-form (http://host/path)
  let u; try { u = new URL(target); } catch { cres.writeHead(400); return cres.end(); }
  const chunks = [];
  creq.on("data", (d) => chunks.push(d));
  creq.on("end", () => {
    const body = Buffer.concat(chunks);
    // log เฉพาะ DCTK POST/GET ที่มี body หรือเป็น endpoint สำคัญ
    if (u.hostname.includes("203.154.140.105")) {
      n++;
      appendFileSync(LOG, JSON.stringify({ i: n, t: Date.now(), method: creq.method, url: target,
        ct: creq.headers["content-type"] || "", bodyLen: body.length,
        body: body.toString("utf8").slice(0, 20000) }) + "\n");
    }
    const opt = { hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: creq.method, headers: creq.headers };
    const preq = http.request(opt, (pres) => { cres.writeHead(pres.statusCode, pres.headers); pres.pipe(cres); });
    preq.on("error", (e) => { cres.writeHead(502); cres.end(String(e)); });
    preq.end(body);
  });
});
// รองรับ HTTPS tunnel (ไม่ log) เผื่อมี traffic อื่น
server.on("connect", (req, clientSocket, head) => {
  const [host, port] = req.url.split(":");
  const s = net.connect(port || 443, host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    s.write(head); s.pipe(clientSocket); clientSocket.pipe(s);
  });
  s.on("error", () => clientSocket.end());
});
const PORT = process.env.PROXY_PORT || 8899;
server.listen(PORT, () => console.log(`[proxy] listening :${PORT} → log ${LOG}`));
