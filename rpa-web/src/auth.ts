// ============================================================
//  Auth — Supabase Auth (email+password) + role (user/admin)
//  - ตรวจ JWT จาก header "Authorization: Bearer <jwt>" หรือ query ?token=
//    (EventSource/SSE แนบ header ไม่ได้ จึงรองรับ query param ด้วย)
//  - role อ่านจากตาราง profiles ผ่าน service client (bypass RLS)
//  ถ้า authEnabled=false จะปล่อยผ่าน (dev/รันในเครื่อง) แบบ graceful
// ============================================================
import type { Request, Response, NextFunction } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config.js";

export interface AuthUser {
  id: string;
  email: string;
  role: "user" | "admin";
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// service client (bypass RLS) สำหรับ lookup role — แยกจาก client หลักใน supabase.ts ได้
let svc: SupabaseClient | null = null;
export function serviceClient(): SupabaseClient | null {
  if (!config.supabase.enabled) return null;
  if (!svc) {
    svc = createClient(config.supabase.url, config.supabase.serviceKey, {
      auth: { persistSession: false },
    });
  }
  return svc;
}

// anon client สำหรับ verify JWT ของผู้ใช้
let anon: SupabaseClient | null = null;
function anonClient(): SupabaseClient | null {
  if (!config.supabase.authEnabled) return null;
  if (!anon) {
    anon = createClient(config.supabase.url, config.supabase.anonKey, {
      auth: { persistSession: false },
    });
  }
  return anon;
}

export function authEnabled(): boolean {
  return config.supabase.authEnabled;
}

/** ดึง JWT จาก request: header Bearer ก่อน ไม่งั้น query ?token= (สำหรับ SSE) */
function extractToken(req: Request): string | null {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  const q = req.query.token;
  if (typeof q === "string" && q.trim()) return q.trim();
  return null;
}

/**
 * verify token → คืน AuthUser (พร้อม role จาก profiles) หรือ null
 */
export async function resolveUser(req: Request): Promise<AuthUser | null> {
  const token = extractToken(req);
  if (!token) return null;
  const ac = anonClient();
  if (!ac) return null;
  try {
    const { data, error } = await ac.auth.getUser(token);
    if (error || !data?.user) return null;
    const uid = data.user.id;
    const email = data.user.email ?? "";
    // lookup role จาก profiles (service client bypass RLS)
    let role: "user" | "admin" = "user";
    const sc = serviceClient();
    if (sc) {
      const { data: prof } = await sc
        .from("profiles")
        .select("role")
        .eq("id", uid)
        .maybeSingle();
      if (prof?.role === "admin") role = "admin";
    }
    return { id: uid, email, role };
  } catch {
    return null;
  }
}

/** middleware: ต้อง login (role ใดก็ได้) */
/**
 * ถ้า auth ปิด (ไม่มี ANON_KEY) แต่อยู่ production → ปฏิเสธ (กันเปิดสิทธิ์ admin ให้ทุกคน)
 *   ต้องตั้ง RPA_ALLOW_NO_AUTH=1 ชัดเจน ถึงจะยอมให้ bypass บน production
 */
function noAuthBlocked(): boolean {
  const isProd = process.env.NODE_ENV === "production";
  const allowed = ["1", "true", "yes"].includes((process.env.RPA_ALLOW_NO_AUTH ?? "").toLowerCase());
  return isProd && !allowed;
}

export async function requireUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // ถ้ายังไม่ได้ตั้ง Auth (dev) → ปล่อยผ่าน (แต่บน production ปฏิเสธ กันเปิด admin ให้ทุกคน)
  if (!authEnabled()) {
    if (noAuthBlocked()) {
      res.status(503).json({ ok: false, error: "ระบบยังไม่ได้ตั้งค่า Auth (ต้องตั้ง SUPABASE_ANON_KEY บน production)" });
      return;
    }
    req.user = { id: "dev", email: "dev@local", role: "admin" };
    next();
    return;
  }
  const user = await resolveUser(req);
  if (!user) {
    res.status(401).json({ ok: false, error: "ต้องเข้าสู่ระบบก่อน" });
    return;
  }
  req.user = user;
  next();
}

/** middleware: ต้องเป็น admin */
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!authEnabled()) {
    if (noAuthBlocked()) {
      res.status(503).json({ ok: false, error: "ระบบยังไม่ได้ตั้งค่า Auth (ต้องตั้ง SUPABASE_ANON_KEY บน production)" });
      return;
    }
    req.user = { id: "dev", email: "dev@local", role: "admin" };
    next();
    return;
  }
  const user = await resolveUser(req);
  if (!user) {
    res.status(401).json({ ok: false, error: "ต้องเข้าสู่ระบบก่อน" });
    return;
  }
  if (user.role !== "admin") {
    res.status(403).json({ ok: false, error: "ต้องเป็นผู้ดูแลระบบ (admin)" });
    return;
  }
  req.user = user;
  next();
}
