// ============================================================
//  Login — Supabase Auth (email + password)
//  ดึง anonKey จาก /api/public-config (ไม่ใช้ service key)
//  เก็บ access_token ลง localStorage แล้ว redirect ไป index
// ============================================================
const msg = document.getElementById("msg");
const btn = document.getElementById("btnLogin");

function showMsg(text, kind) {
  msg.textContent = text;
  msg.className = "login-msg" + (kind ? " " + kind : "");
}

let sb = null;

async function init() {
  try {
    const res = await fetch("/api/public-config");
    const cfg = await res.json();
    if (!cfg.authEnabled || !cfg.anonKey) {
      // ระบบยังไม่ได้เปิด Auth — เข้าใช้ได้เลย
      showMsg("ระบบยังไม่ได้เปิดระบบล็อกอิน — กำลังเข้าสู่หน้าหลัก…", "ok");
      setTimeout(() => (location.href = "/"), 800);
      return;
    }
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.anonKey, {
      auth: { persistSession: false },
    });
    // ถ้ามี token เดิมและยังใช้ได้ → ข้ามไปหน้าหลัก
    const tok = localStorage.getItem("sb_access_token");
    if (tok) {
      const { data } = await sb.auth.getUser(tok);
      if (data?.user) { location.href = "/"; return; }
    }
  } catch (e) {
    showMsg("โหลดการตั้งค่าไม่สำเร็จ: " + e.message, "err");
  }
}

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!sb) { showMsg("ระบบยังไม่พร้อม", "err"); return; }
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  btn.disabled = true;
  showMsg("กำลังเข้าสู่ระบบ…");
  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    const token = data?.session?.access_token;
    if (!token) throw new Error("ไม่ได้รับ token");
    localStorage.setItem("sb_access_token", token);
    if (data.session.refresh_token) {
      localStorage.setItem("sb_refresh_token", data.session.refresh_token);
    }
    showMsg("สำเร็จ — กำลังเข้าสู่ระบบ…", "ok");
    location.href = "/";
  } catch (err) {
    showMsg("เข้าสู่ระบบไม่สำเร็จ: " + (err.message || err), "err");
    btn.disabled = false;
  }
});

init();
