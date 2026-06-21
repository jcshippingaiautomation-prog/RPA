// ============================================================
//  Gmail API (REST) ผ่าน OAuth refresh token
//  แทน GmailApp ของ GAS — list threads, ดึง attachment, label dedup
// ============================================================
import { config } from "../config.js";
import type { RawAttachment } from "./files.js";

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  plainBody: string;
  attachments: RawAttachment[];
}

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

let cachedToken: { token: string; exp: number } | null = null;

/** แลก refresh token → access token (cache จนเกือบหมดอายุ) */
async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.exp) return cachedToken.token;
  const body = new URLSearchParams({
    client_id: config.gmail.clientId,
    client_secret: config.gmail.clientSecret,
    refresh_token: config.gmail.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Gmail OAuth HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, exp: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

async function gapi(pathAndQuery: string): Promise<unknown> {
  const token = await getAccessToken();
  const res = await fetch(`${API}${pathAndQuery}`, {
    headers: { Authorization: "Bearer " + token },
  });
  if (!res.ok) throw new Error(`Gmail API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** ค้นหา message ids ตาม query (จำกัด maxResults) */
export async function searchMessages(query: string, maxResults: number): Promise<string[]> {
  const data = (await gapi(
    `/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
  )) as { messages?: { id: string }[] };
  return (data.messages ?? []).map((m) => m.id);
}

interface GmailHeader { name: string; value: string }
interface GmailPart {
  filename?: string;
  mimeType?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
  headers?: GmailHeader[];
}

function header(headers: GmailHeader[], name: string): string {
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

function b64urlToBuffer(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** เดิน part tree เก็บ plain body + attachment ids */
function walkParts(
  part: GmailPart,
  acc: { body: string; atts: { filename: string; mimeType: string; attachmentId: string }[] },
): void {
  if (!part) return;
  const mime = part.mimeType || "";
  if (mime === "text/plain" && part.body?.data) {
    acc.body += b64urlToBuffer(part.body.data).toString("utf-8");
  }
  if (part.filename && part.body?.attachmentId) {
    acc.atts.push({
      filename: part.filename,
      mimeType: mime,
      attachmentId: part.body.attachmentId,
    });
  }
  if (part.parts) for (const p of part.parts) walkParts(p, acc);
}

/** ดึง message เต็ม (header + body + attachments bytes) */
export async function getMessage(id: string): Promise<GmailMessage> {
  const data = (await gapi(`/messages/${id}?format=full`)) as {
    id: string;
    threadId: string;
    payload: GmailPart;
  };
  const headers = data.payload.headers ?? [];
  const acc = { body: "", atts: [] as { filename: string; mimeType: string; attachmentId: string }[] };
  walkParts(data.payload, acc);

  // ดึง bytes ของแต่ละ attachment
  const attachments: RawAttachment[] = [];
  for (const a of acc.atts) {
    const att = (await gapi(`/messages/${id}/attachments/${a.attachmentId}`)) as { data?: string };
    if (att.data) {
      attachments.push({ filename: a.filename, mimeType: a.mimeType, bytes: b64urlToBuffer(att.data) });
    }
  }

  return {
    id: data.id,
    threadId: data.threadId,
    from: header(headers, "From"),
    subject: header(headers, "Subject"),
    plainBody: acc.body,
    attachments,
  };
}

/** ดึงทุก message ใน thread (ครบทั้ง reply chain — ไม่พึ่ง search ที่อาจกรอง has:attachment) */
export async function getThreadMessages(threadId: string): Promise<GmailMessage[]> {
  const data = (await gapi(`/threads/${threadId}?format=full`)) as {
    messages?: { id: string; threadId: string; payload: GmailPart }[];
  };
  const out: GmailMessage[] = [];
  for (const m of data.messages ?? []) {
    const headers = m.payload.headers ?? [];
    const acc = { body: "", atts: [] as { filename: string; mimeType: string; attachmentId: string }[] };
    walkParts(m.payload, acc);
    const attachments: RawAttachment[] = [];
    for (const a of acc.atts) {
      const att = (await gapi(`/messages/${m.id}/attachments/${a.attachmentId}`)) as { data?: string };
      if (att.data) {
        attachments.push({ filename: a.filename, mimeType: a.mimeType, bytes: b64urlToBuffer(att.data) });
      }
    }
    out.push({
      id: m.id,
      threadId: m.threadId,
      from: header(headers, "From"),
      subject: header(headers, "Subject"),
      plainBody: acc.body,
      attachments,
    });
  }
  return out;
}

/** หา (หรือสร้าง) label → คืน labelId */
export async function getOrCreateLabelId(name: string): Promise<string> {
  const token = await getAccessToken();
  const list = (await gapi(`/labels`)) as { labels?: { id: string; name: string }[] };
  const found = (list.labels ?? []).find((l) => l.name === name);
  if (found) return found.id;
  const res = await fetch(`${API}/labels`, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }),
  });
  if (!res.ok) throw new Error(`Gmail create label HTTP ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

/** ติด label + mark read ให้ message (dedup) */
export async function labelMessage(id: string, labelId: string): Promise<void> {
  const token = await getAccessToken();
  await fetch(`${API}/messages/${id}/modify`, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ addLabelIds: [labelId], removeLabelIds: ["UNREAD"] }),
  });
}

/** parse "Name <email@x>" → email ตัวพิมพ์เล็ก */
export function parseSenderEmail(from: string): string {
  const m = from.match(/<([^>]+)>/);
  const email = (m ? m[1] : from).trim().toLowerCase();
  return email;
}

export function gmailEnabled(): boolean {
  return config.gmail.enabled;
}
