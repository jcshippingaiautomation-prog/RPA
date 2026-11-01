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

function setBusy(on) {
  btn.disabled = on;
  btn.classList.toggle("busy", on);
  btn.querySelector(".label").textContent = on ? "กำลังตรวจสอบ…" : "เข้าสู่ระบบ";
}

// แปลข้อความ error ของ Supabase เป็นภาษาไทยที่ผู้ใช้เข้าใจ
function thaiError(err) {
  const m = String((err && err.message) || err || "");
  if (/invalid login credentials/i.test(m)) return "อีเมลหรือรหัสผ่านไม่ถูกต้อง";
  if (/email not confirmed/i.test(m)) return "บัญชียังไม่ได้ยืนยันอีเมล กรุณาติดต่อผู้ดูแลระบบ";
  if (/failed to fetch|network/i.test(m)) return "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่";
  if (/rate limit|too many/i.test(m)) return "พยายามเข้าสู่ระบบบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่";
  return "เข้าสู่ระบบไม่สำเร็จ: " + m;
}

// ปุ่มแสดง/ซ่อนรหัสผ่าน
const pw = document.getElementById("password");
const togglePw = document.getElementById("togglePw");
togglePw.addEventListener("click", () => {
  const show = pw.type === "password";
  pw.type = show ? "text" : "password";
  const label = show ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน";
  togglePw.setAttribute("aria-label", label);
  togglePw.title = label;
  togglePw.innerHTML = window.svgIcon(show ? "eye-off" : "eye", 18);
  pw.focus();
});

// เตือนเมื่อเปิด Caps Lock
const capsWarn = document.getElementById("capsWarn");
["keydown", "keyup"].forEach((ev) =>
  pw.addEventListener(ev, (e) => {
    if (e.getModifierState) capsWarn.classList.toggle("on", e.getModifierState("CapsLock"));
  })
);
pw.addEventListener("blur", () => capsWarn.classList.remove("on"));

// ปีลิขสิทธิ์เป็น พ.ศ.
document.getElementById("copy").textContent =
  "© " + (new Date().getFullYear() + 543) + " JC Shipping · DCTK Automation";

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
    showMsg("โหลดการตั้งค่าระบบไม่สำเร็จ กรุณารีเฟรชหน้านี้ (" + e.message + ")", "err");
  }
}

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!sb) { showMsg("ระบบยังไม่พร้อม", "err"); return; }
  const email = document.getElementById("email").value.trim();
  const password = pw.value;
  if (!email || !password) {
    showMsg("กรุณากรอกอีเมลและรหัสผ่าน", "err");
    (email ? pw : document.getElementById("email")).focus();
    return;
  }
  setBusy(true);
  showMsg("");
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
    showMsg(thaiError(err), "err");
    setBusy(false);
  }
});

init();
