/* ══════════════════════════════════════════════════════════════
   QR-SASMS — client logic, rewired to a real Next.js + Prisma + Postgres
   backend (see /src/app/api/**). Every render/DOM function below produces
   the exact same HTML the original localStorage-only prototype did — only
   the data layer changed: instead of reading/writing localStorage arrays,
   each page load fetches fresh data from the API, and every action (submit
   a request, approve/reject, reply to a ticket, etc.) calls a real API
   endpoint. The server is the single source of truth; audit logging,
   email notifications, and in-app bell notifications are now all created
   server-side as a side effect of those calls.
══════════════════════════════════════════════════════════════ */

/* ──────────────────────────────────────────
   FETCH HELPERS
──────────────────────────────────────────── */
async function api(url, opts = {}) {
  const init = { method: opts.method || "GET", credentials: "same-origin" };
  if (opts.body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  let res, data = null;
  try {
    res = await fetch(url, init);
    data = await res.json().catch(() => null);
  } catch (e) {
    return { ok: false, status: 0, data: null, error: "Network error — is the server running?" };
  }
  return { ok: res.ok, status: res.status, data, error: data && data.error ? data.error : null };
}

/** Uploads a single <input type="file"> to /api/upload. Returns {url,fileName} or null. */
async function uploadFile(inputEl) {
  const f = inputEl.files && inputEl.files[0];
  if (!f) return { url: null, fileName: null };
  const ext = (f.name.split(".").pop() || "").toLowerCase();
  if (!["jpg", "jpeg", "png", "pdf", "doc", "docx"].includes(ext)) {
    showToast("⚠️ Allowed files: JPG, PNG, PDF, DOC(X).", "rgba(180,130,0,.85)");
    return false;
  }
  if (f.size > 1536 * 1024) {
    showToast("⚠️ File too large (max 1.5 MB).", "rgba(180,130,0,.85)");
    return false;
  }
  const fd = new FormData();
  fd.append("file", f);
  let res, data;
  try {
    res = await fetch("/api/upload", { method: "POST", credentials: "same-origin", body: fd });
    data = await res.json().catch(() => null);
  } catch (e) {
    showToast("❌ Upload failed — network error.", "rgba(155,22,22,.85)");
    return false;
  }
  if (!res.ok) {
    showToast(`❌ ${(data && data.error) || "Upload failed."}`, "rgba(155,22,22,.85)");
    return false;
  }
  return { url: data.url, fileName: data.fileName };
}

/* ──────────────────────────────────────────
   IN-MEMORY CACHES (populated from the API on navigation; every render
   function below reads from these exactly like the original read from
   localStorage-backed globals)
──────────────────────────────────────────── */
let DB = [];              // document requests
let queueData = [];       // appointment queue (admin view)
let auditLogs = [];       // audit trail (admin view)
let EMAIL_LOG = [];       // outgoing email attempts (admin view)
let EMAIL_CONFIGURED = false;
let NOTIFS = [];          // caller's own notifications
let knownNotificationIds = new Set();
let notificationPollingStarted = false;
let PENDING_ACCOUNTS = []; // accounts awaiting admin approval
let MASTERLIST_COUNT = 0;
let MOD = { referrals: [], idapps: [], bulletins: [], tickets: [], faqs: [], events2: [], complaints: [], forms: [], memos: [] };
let ADMIN_ACTIVITY = null;

async function loadRequests() { const r = await api("/api/requests"); DB = r.ok ? r.data : []; }
async function loadAdminActivity() { const r = await api("/api/admin/activity"); ADMIN_ACTIVITY = r.ok ? r.data : null; }
async function loadQueueData() { const r = await api("/api/queue"); queueData = r.ok ? r.data : []; }
async function loadAuditLog() { const r = await api("/api/audit"); auditLogs = r.ok ? r.data : []; }
async function loadEmailLog() { const r = await api("/api/emails"); EMAIL_LOG = r.ok ? r.data : []; }
async function loadEmailStatus() { const r = await api("/api/emails/status"); EMAIL_CONFIGURED = r.ok ? !!r.data.configured : false; }
async function loadNotifs() { const r = await api("/api/notifications"); NOTIFS = r.ok ? r.data : []; }
async function loadPendingAccounts() { const r = await api("/api/users/pending"); PENDING_ACCOUNTS = r.ok ? r.data : []; }
async function loadModule(key) { const r = await api(`/api/modules/${key}`); MOD[key] = r.ok ? r.data : []; }

async function refreshMasterlistStatus() {
  const r = await api("/api/masterlist");
  MASTERLIST_COUNT = r.ok ? r.data.count : 0;
  updateMasterlistStatus();
}
function updateMasterlistStatus() {
  const el = document.getElementById("masterlistStatus");
  if (!el) return;
  el.innerHTML = MASTERLIST_COUNT
    ? `<i class="fa-solid fa-circle-check" style="color:#16a34a;margin-right:4px;"></i>Masterlist loaded — ${MASTERLIST_COUNT} student${MASTERLIST_COUNT > 1 ? "s" : ""}`
    : `<i class="fa-solid fa-triangle-exclamation" style="color:#d97706;margin-right:4px;"></i>No masterlist loaded`;
}

const DOC_LABELS = { gmc: "Good Moral Certificate", coe: "Certificate of Enrollment", tor: "Transcript of Records (TOR)", auth: "Authentication", diploma: "Diploma Copy", other: "Other", ev: "Enrollment Verification" };
const DOC_HELPS = { gmc: "📄 Good Moral Certificate — Certifies your conduct as a student. Required for employment, further studies, or government transactions.", ev: "✅ Enrollment Verification — Certifies that you are officially enrolled this term, issued by the SSO for scholarships, allowances, and external requirements.", auth: "🔏 Authentication — Certifies the authenticity of PUP-issued documents for foreign use or apostille.", diploma: "🎓 Diploma Copy — A certified copy of your diploma for record purposes.", other: "📁 Other Documents — Please specify in the additional notes field." };
const DOC_REQUIREMENTS = {
  gmc: ["Valid PUP student ID", "Clear purpose for the request"],
  ev: ["Valid PUP student ID", "Current enrollment details"],
  auth: ["Original or clear copy of the document to authenticate", "Valid PUP student ID"],
  diploma: ["Valid PUP student ID", "Affidavit of Loss if the original diploma was lost"],
  other: ["Valid PUP student ID", "Describe the requested document in Additional Notes"],
};

/* ──────────────────────────────────────────
   SESSION
──────────────────────────────────────────── */
let session = null; // { id, email, name, role, course, year }
let copies = 1;
let selectedDate = null;
let selectedSlot = null;
const appointmentCalendarMonth = new Date().getMonth();
const appointmentCalendarYear = new Date().getFullYear();
const appointmentDateLabel = (day) => new Date(appointmentCalendarYear, appointmentCalendarMonth, day).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
let prevPage = null;
let appointmentAvailability = { bookedTimes: [], myAppointment: null };
let rescheduleCode = null;
let rescheduleSelectedDate = null;
let rescheduleSelectedSlot = null;
let rescheduleCalMonth = new Date().getMonth();
let rescheduleCalYear = new Date().getFullYear();
const rescheduleDateLabel = (day) => new Date(rescheduleCalYear, rescheduleCalMonth, day).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
let rescheduleAvailability = { bookedTimes: [], myAppointment: null };
let qrRenderedFor = null;
let donutChart = null;
let barChartInst = null;

async function restoreSession() {
  const r = await api("/api/auth/me");
  if (r.ok && r.data && r.data.user) {
    session = r.data.user;
    await goTo((session.role === "admin" || session.role === "super_admin") ? "page-admin" : session.role === "scanner" ? "page-scanner" : "page-student");
  }
}

/* ──────────────────────────────────────────
   AUTH
──────────────────────────────────────────── */
async function doLogin() {
  const userVal = document.getElementById("loginUser").value.trim();
  const passVal = document.getElementById("loginPass").value;
  let valid = true;

  ["loginUser", "loginPass"].forEach((id) => document.getElementById(id).classList.remove("error"));
  ["loginUserErr", "loginPassErr"].forEach((id) => document.getElementById(id).classList.remove("show"));

  if (!userVal) {
    document.getElementById("loginUser").classList.add("error");
    document.getElementById("loginUserErr").classList.add("show");
    document.getElementById("loginUserErrMsg").textContent = "Please enter your student number or email.";
    valid = false;
  }
  if (!passVal) {
    document.getElementById("loginPass").classList.add("error");
    document.getElementById("loginPassErr").classList.add("show");
    document.getElementById("loginPassErrMsg").textContent = "Please enter your password.";
    valid = false;
  }
  if (!valid) return;

  const { ok, data } = await api("/api/auth/login", { method: "POST", body: { identifier: userVal, password: passVal } });

  if (!ok) {
    const code = data && data.code;
    if (code === "NOT_APPROVED") {
      document.getElementById("loginUser").classList.add("error");
      document.getElementById("loginUserErr").classList.add("show");
      document.getElementById("loginUserErrMsg").textContent = data.error;
      showToast("⏳ Your account is awaiting admin approval.", "rgba(180,130,0,.85)");
      return;
    }
    document.getElementById("loginUser").classList.add("error");
    document.getElementById("loginPass").classList.add("error");
    document.getElementById("loginPassErr").classList.add("show");
    document.getElementById("loginPassErrMsg").textContent = (data && data.error) || "Incorrect credentials. Please try again.";
    const box = document.getElementById("loginPass").closest(".modal-box");
    box.classList.remove("shake"); void box.offsetWidth; box.classList.add("shake");
    showToast("❌ Invalid credentials.", "rgba(155,22,22,.85)");
    return;
  }

  session = data.user;
  if (session.role === "student") await goTo("page-student");
  else if (session.role === "admin" || session.role === "super_admin") await goTo("page-admin");
  else await goTo("page-scanner");
  showToast("✅ Welcome, " + session.name + "!");
}

function showRegError(msg) {
  const el = document.getElementById("regError");
  if (el) { el.innerHTML = `<i class="fa-solid fa-circle-exclamation" style="margin-right:5px;"></i>${msg}`; el.style.display = "block"; }
}
function clearRegError() { const el = document.getElementById("regError"); if (el) el.style.display = "none"; }

async function handleRegister() {
  clearRegError();
  const first = document.getElementById("regFirst").value.trim();
  const last = document.getElementById("regLast").value.trim();
  const sn = document.getElementById("regStudNum").value.trim();
  const email = document.getElementById("regEmail").value.trim();
  const pass = document.getElementById("regPass").value;
  const course = document.getElementById("regCourse").value;
  const year = document.getElementById("regYear").value;

  if (!first || !last || !sn || !email || !pass) {
    showRegError("Please complete all fields before creating your account.");
    return;
  }
  if (pass.length < 6) {
    showRegError("Password must be at least 6 characters.");
    return;
  }

  const { ok, data } = await api("/api/auth/register", { method: "POST", body: { first, last, sn, email, password: pass, course, year } });
  if (!ok) {
    showRegError((data && data.error) || "Could not create your account.");
    return;
  }

  showToast("✅ Account created! It will be reviewed by the SSO — you can sign in once approved.");
  ["regFirst", "regLast", "regStudNum", "regEmail", "regPass"].forEach((id) => { const e = document.getElementById(id); if (e) e.value = ""; });
  setTimeout(() => goTo("page-login"), 1200);
}

/* ──────────────────────────────────────────
   NAVIGATION
──────────────────────────────────────────── */
async function goTo(pageId) {
  const publicPages = ["page-login", "page-register"];
  if (!publicPages.includes(pageId) && !session) {
    showToast("⚠️ Please sign in first.", "rgba(139,26,26,.9)");
    pageId = "page-login";
  }
  if (session) {
    if (session.role === "student" && (pageId === "page-admin" || pageId === "page-manage" || pageId === "page-memo")) {
      showToast("⚠️ Access denied.", "rgba(139,26,26,.9)"); return;
    }
    if ((session.role === "admin" || session.role === "super_admin") && (pageId === "page-student" || pageId === "page-request" || pageId === "page-appointment" || pageId === "page-services")) {
      showToast("⚠️ Access denied.", "rgba(139,26,26,.9)"); return;
    }
  }
  if (document.querySelector(".page.active")?.id === "page-admin" && pageId !== "page-admin") {
    if (donutChart) { try { donutChart.destroy(); } catch (e) {} donutChart = null; }
    if (barChartInst) { try { barChartInst.destroy(); } catch (e) {} barChartInst = null; }
  }
  prevPage = document.querySelector(".page.active")?.id;
  window.__qrsPageScroll = window.__qrsPageScroll || {};
  if (prevPage && prevPage !== pageId) window.__qrsPageScroll[prevPage] = window.scrollY;
  document.querySelectorAll(".page").forEach((p) => { p.classList.remove("active"); p.style.display = "none"; });
  const p = document.getElementById(pageId);
  p.classList.add("active"); p.style.display = "block";
  const savedScroll = window.__qrsPageScroll[pageId] || 0;
  requestAnimationFrame(() => window.scrollTo({ top: savedScroll, left: 0, behavior: "auto" }));

  const noNav = ["page-login", "page-register"];
  document.getElementById("mainNav").style.display = noNav.includes(pageId) ? "none" : "block";

  // Preload whatever data this page needs, then render (mirrors the
  // original's synchronous render-from-cache functions below).
  if (pageId === "page-student") { await loadRequests(); renderStudentPage(); }
  if (pageId === "page-admin") {
    await Promise.all([loadRequests(), loadQueueData(), loadAuditLog(), loadEmailLog(), loadEmailStatus(), loadPendingAccounts(), refreshMasterlistStatus(), loadAdminActivity()]);
    renderAdminPage();
  }
  const _bp = document.getElementById("bellPanel"); if (_bp) _bp.style.display = "none";
  if (pageId === "page-appointment") buildCalendar();
  if (pageId === "page-services") renderServicesHub();
  if (pageId === "page-manage") renderManageHub();
  if (pageId === "page-referral") { await loadModule("referrals"); renderReferral(); }
  if (pageId === "page-idapp") { await loadModule("idapps"); renderIdApp(); }
  if (pageId === "page-bulletin") { await loadModule("bulletins"); renderBulletin(); }
  if (pageId === "page-helpdesk") { await Promise.all([loadModule("tickets"), loadModule("faqs")]); renderHelpdesk(); }
  if (pageId === "page-faq") { await loadModule("faqs"); renderFaq(); }
  if (pageId === "page-events2") { await loadModule("events2"); renderEvents2(); }
  if (pageId === "page-complaint") { await loadModule("complaints"); renderComplaint(); }
  if (pageId === "page-forms") { await loadModule("forms"); renderForms(); }
  if (pageId === "page-memo") { await loadModule("memos"); renderMemo(); }
  if (["page-login", "page-register"].includes(pageId)) await refreshMasterlistStatus();
  await updateNav(pageId);
}
async function goBack() { await goTo(prevPage || (isAdmin() ? "page-admin" : "page-student")); }

/* ──────────────────────────────────────────
   NAVBAR
──────────────────────────────────────────── */
async function updateNav(pageId) {
  if (!session) return;
  await loadNotifs();
  if (!knownNotificationIds.size) knownNotificationIds = new Set(NOTIFS.map((n) => n.id));
  startNotificationPolling();
  const role = session.role === "super_admin" ? "admin" : session.role;
  const links = {
    student: [{ label: "Dashboard", icon: "fa-house", page: "page-student" }, { label: "New Request", icon: "fa-plus", page: "page-request" }, { label: "Appointments", icon: "fa-calendar", page: "page-appointment" }, { label: "Services", icon: "fa-table-cells-large", page: "page-services" }],
    admin: [{ label: "Dashboard", icon: "fa-gauge", page: "page-admin" }, { label: "Manage", icon: "fa-table-cells-large", page: "page-manage" }, { label: "QR Scanner", icon: "fa-qrcode", page: "page-scanner" }],
    scanner: [{ label: "Scanner", icon: "fa-qrcode", page: "page-scanner" }],
  };
  const iconMap = { student: "fa-user-graduate", admin: "fa-shield-halved", scanner: "fa-qrcode" };
  const items = links[role] || links.student;
  const lh = items.map((l) => `<button onclick="goTo('${l.page}')" class="nav-link ${pageId === l.page ? "active" : ""}"><i class="fa-solid ${l.icon}" style="font-size:11px;"></i>${l.label}</button>`).join("");
  const ctrl = `<div style="display:flex;align-items:center;gap:6px;margin-left:8px;padding-left:8px;border-left:1px solid rgba(255,255,255,.1);">
    <button onclick="toggleBell()" class="nav-link" style="position:relative;padding:7px 11px;" aria-label="Notifications"><i class="fa-solid fa-bell"></i><span id="bellBadge" style="display:none;position:absolute;top:2px;right:3px;min-width:15px;height:15px;border-radius:99px;background:#dc2626;color:#fff;font-size:9px;font-weight:900;align-items:center;justify-content:center;padding:0 3px;line-height:15px;">0</span></button>
    <div style="display:flex;align-items:center;gap:7px;background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.18);border-top-color:rgba(255,220,220,.22);border-radius:10px;padding:5px 10px;">
      <div style="width:22px;height:22px;border-radius:50%;background:rgba(245,197,24,.15);border:1px solid rgba(245,197,24,.3);display:flex;align-items:center;justify-content:center;"><i class="fa-solid ${iconMap[role]}" style="font-size:10px;color:#F5C518;"></i></div>
      <span style="font-size:12px;font-weight:700;color:rgba(255,220,220,.95);">${session.name.split(" ")[0]}</span>
    </div>
    <button onclick="signOut()" class="nav-link" style="padding:7px 10px;color:rgba(239,68,68,.7);" aria-label="Sign out"><i class="fa-solid fa-right-from-bracket"></i></button>
  </div>`;
  document.getElementById("desktopNavLinks").innerHTML = lh + ctrl;
  updateBellBadge();
  document.getElementById("mobileMenuLinks").innerHTML =
    items.map((l) => `<button onclick="goTo('${l.page}');document.getElementById('mobileMenu').classList.remove('open');" class="nav-link" style="justify-content:flex-start;"><i class="fa-solid ${l.icon}" style="font-size:11px;color:#F5C518;"></i>${l.label}</button>`).join("") +
    `<button onclick="signOut()" class="nav-link" style="color:rgba(239,68,68,.7);justify-content:flex-start;margin-top:4px;"><i class="fa-solid fa-right-from-bracket"></i>Sign Out</button>`;
}
function toggleMobileMenu() { document.getElementById("mobileMenu").classList.toggle("open"); }
async function signOut() {
  await api("/api/auth/logout", { method: "POST" });
  session = null;
  await goTo("page-login");
  showToast("Signed out successfully.");
}

/* ──────────────────────────────────────────
   STUDENT PAGE
──────────────────────────────────────────── */
function renderStudentPage() {
  if (!session || session.role !== "student") return;
  document.getElementById("studentWelcomeName").textContent = session.name;

  const myReqs = DB.filter((r) => r.studentId === session.id).sort((a, b) => b.dateSort - a.dateSort);
  const total = myReqs.length;
  const pending = myReqs.filter((r) => r.status === "Pending").length;
  const ready = myReqs.filter((r) => r.status === "Ready to Claim").length;
  document.getElementById("kpiTotal").textContent = total;
  document.getElementById("kpiPending").textContent = pending;
  document.getElementById("kpiReady").textContent = ready;
  renderStudentAppointment();

  const searchEl = document.getElementById("studentSearch");
  if (searchEl) searchEl.value = "";
  const statusEl = document.getElementById("studentStatusFilter");
  if (statusEl) statusEl.value = "";
  renderStudentTable("");
}

async function renderStudentAppointment() {
  const card = document.getElementById("studentAppointmentCard");
  if (!card) return;
  const result = await api("/api/queue?mine=1");
  const appt = result.ok && result.data[0];
  if (!appt) {
    card.innerHTML = `<div class="input-label" style="margin-bottom:12px;"><i class="fa-solid fa-calendar-check" style="color:#D4A017;margin-right:5px;"></i>Next Appointment</div><div style="font-size:12px;color:rgba(30,5,5,.65);text-align:center;padding:12px 0;">No active appointment.</div><button onclick="goTo('page-appointment')" class="btn-ghost" style="width:100%;margin-top:8px;padding:10px;"><i class="fa-solid fa-calendar-plus" style="margin-right:6px;"></i>Book Appointment</button>`;
    return;
  }
  card.innerHTML = `<div class="input-label" style="margin-bottom:12px;"><i class="fa-solid fa-calendar-check" style="color:#D4A017;margin-right:5px;"></i>Next Appointment</div><div style="background:rgba(139,26,26,.5);border:1px solid rgba(245,197,24,.25);border-radius:14px;padding:16px;text-align:center;"><div style="font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:rgba(245,197,24,.7);">Appointment Number</div><div style="font-size:32px;font-weight:900;color:#fff;line-height:1.2;">${esc(appt.q)}</div><div style="font-size:12px;color:#fff;margin-top:5px;">${esc(appt.dateLabel)} · ${esc(appt.time)}</div></div><div style="display:flex;gap:7px;margin-top:10px;"><button onclick="rescheduleAppointment('${esc(appt.q)}')" class="btn-ghost" style="flex:1;padding:8px;font-size:11px;">Reschedule</button><button onclick="cancelAppointment('${esc(appt.q)}')" class="btn-ghost" style="flex:1;padding:8px;font-size:11px;color:#b91c1c;">Cancel</button></div>`;
}

async function cancelAppointment(code) {
  if (!confirm(`Cancel appointment ${code}?`)) return;
  const result = await api(`/api/queue/${encodeURIComponent(code)}/cancel`, { method: "DELETE" });
  showToast(result.ok ? "✅ Appointment cancelled." : `❌ ${result.error || "Could not cancel appointment."}`, result.ok ? undefined : "rgba(155,22,22,.85)");
  if (result.ok) renderStudentAppointment();
}

function renderStudentTable(query = "") {
  if (!session) return;
  const q = (query || "").toLowerCase();
  const statusFilter = document.getElementById("studentStatusFilter")?.value || "";
  const myReqs = DB.filter((r) => r.studentId === session.id).sort((a, b) => b.dateSort - a.dateSort);
  const filtered = myReqs.filter((r) => {
    const matchQuery = !q || r.doc.toLowerCase().includes(q) || r.id.toLowerCase().includes(q) || r.status.toLowerCase().includes(q) || r.purpose.toLowerCase().includes(q);
    return matchQuery && (!statusFilter || r.status === statusFilter);
  });

  const tbody = document.getElementById("studentTable");
  const empty = document.getElementById("studentTableEmpty");

  if (filtered.length === 0) { tbody.innerHTML = ""; empty.style.display = "block"; return; }
  empty.style.display = "none";

  tbody.innerHTML = filtered.map((r) => {
    const bc = badgeClass(r.status);
    const canQR = r.status === "Ready to Claim";
    let actionBtn;
    if (r.status === "Completed") {
      actionBtn = `<div style="display:inline-flex;gap:6px;">
        <button onclick="printReceipt('${r.id}')" class="btn-maroon" style="padding:6px 12px;font-size:12px;border-radius:10px;"><i class="fa-solid fa-print" style="margin-right:5px;"></i>Receipt</button>
        <button onclick="giveFeedback('${r.id}')" class="btn-gold" style="padding:6px 10px;font-size:11px;border-radius:10px;"><i class="fa-solid fa-star" style="margin-right:4px;"></i>Feedback</button>
        <button onclick="showDetail('${r.id}')" class="btn-ghost" style="padding:6px 10px;font-size:12px;border-radius:10px;"><i class="fa-solid fa-eye"></i></button>
      </div>`;
    } else if (r.status === "Rejected") {
      actionBtn = `<button onclick="reuploadRequest('${r.id}')" class="btn-gold" style="padding:6px 12px;font-size:11px;border-radius:10px;"><i class="fa-solid fa-upload" style="margin-right:5px;"></i>Re-upload</button>`;
    } else {
      actionBtn = canQR
        ? `<button onclick="showQR('${r.id}')" class="btn-maroon" style="padding:6px 14px;font-size:12px;border-radius:10px;"><i class="fa-solid fa-qrcode" style="margin-right:5px;"></i>View QR</button>`
        : `<button onclick="showDetail('${r.id}')" class="btn-ghost" style="padding:6px 14px;font-size:12px;border-radius:10px;"><i class="fa-solid fa-eye" style="margin-right:5px;"></i>Details</button>`;
    }
    return `<tr>
      <td><span style="font-family:monospace;font-size:11px;color:rgba(30,5,5,.68);">${r.id}</span></td>
      <td style="font-weight:700;color:#1a0505;">${r.doc}</td>
      <td style="font-size:12px;color:rgba(30,5,5,.68);">${r.date}</td>
      <td><span class="badge ${bc}">${r.status}</span></td>
      <td style="text-align:right;">${actionBtn}</td>
    </tr>`;
  }).join("");
}

async function reuploadRequest(id) {
  const picker = document.createElement("input");
  picker.type = "file"; picker.accept = ".jpg,.jpeg,.png,.pdf,.doc,.docx";
  picker.onchange = async () => {
    const uploaded = await uploadFile(picker);
    if (!uploaded?.url) return;
    const { ok, error } = await api(`/api/requests/${encodeURIComponent(id)}/reupload`, { method: "POST", body: { fileName: uploaded.fileName, url: uploaded.url } });
    if (!ok) { showToast(`❌ ${error || "Could not re-upload the file."}`, "rgba(155,22,22,.85)"); return; }
    showToast("✅ Corrected document submitted for review.");
    await loadRequests(); renderStudentTable();
  };
  picker.click();
}

async function giveFeedback(requestId) {
  const rating = prompt("Rate the completed service from 1 to 5:", "5"); if (rating === null) return;
  const comment = prompt("Optional comment:", ""); if (comment === null) return;
  const result = await api("/api/feedback", { method: "POST", body: { requestId, rating: Number(rating), comment } });
  showToast(result.ok ? "✅ Thank you for your feedback." : `❌ ${result.error || "Could not submit feedback."}`, result.ok ? undefined : "rgba(155,22,22,.85)");
}

/* ──────────────────────────────────────────
   QR MODAL
──────────────────────────────────────────── */
function showQR(reqId) {
  const req = DB.find((r) => r.id === reqId);
  if (!req) return;
  const qrModal = document.getElementById("qrModal");
  if (qrModal && qrModal.parentElement !== document.body) document.body.appendChild(qrModal);
  qrModal.classList.add("open");
  document.getElementById("qrDocName").textContent = req.doc;
  document.getElementById("qrRefNo").textContent = `Ref: ${req.id} · ${req.studentName}`;
  if (qrRenderedFor !== reqId) {
    const canvas = document.getElementById("qrCanvas");
    canvas.innerHTML = "";
    new QRCode(canvas, { text: `QR-SASMS:${req.id}:${req.studentName}:${req.doc}`, width: 160, height: 160, colorDark: "#8B1A1A", colorLight: "#ffffff" });
    qrRenderedFor = reqId;
  }
}
function closeQR() { document.getElementById("qrModal").classList.remove("open"); }

/* ──────────────────────────────────────────
   DETAIL MODAL
──────────────────────────────────────────── */
function showDetail(reqId) {
  const req = DB.find((r) => r.id === reqId);
  if (!req) return;
  const detailModal = document.getElementById("detailModal");
  if (detailModal && detailModal.parentElement !== document.body) document.body.appendChild(detailModal);
  const bc = badgeClass(req.status);
  document.getElementById("detailContent").innerHTML = `
    <div class="detail-row"><span class="detail-label">Ref No.</span><span class="detail-value" style="font-family:monospace;">${req.id}</span></div>
    <div class="detail-row"><span class="detail-label">Document</span><span class="detail-value">${req.doc}</span></div>
    <div class="detail-row"><span class="detail-label">Purpose</span><span class="detail-value">${req.purpose}</span></div>
    <div class="detail-row"><span class="detail-label">Copies</span><span class="detail-value">${req.copies}</span></div>
    <div class="detail-row"><span class="detail-label">Date Submitted</span><span class="detail-value">${req.date}</span></div>
    <div class="detail-row"><span class="detail-label">Status</span><span class="detail-value"><span class="badge ${bc}">${req.status}</span></span></div>
    ${req.notes ? `<div class="detail-row"><span class="detail-label">Notes</span><span class="detail-value" style="font-size:12px;color:rgba(20,4,4,.85);">${req.notes}</span></div>` : ""}
    ${req.reuploadUrl ? `<div class="detail-row"><span class="detail-label">Corrected requirement</span><span class="detail-value">${fileLink(req.reuploadName, req.reuploadUrl, "View uploaded file")}</span></div>` : ""}
    ${["Approved", "Ready to Claim", "Completed"].includes(req.status) ? `<div style="margin-top:12px;"><button onclick="printApproval('${req.id}')" class="btn-ghost" style="width:100%;padding:10px;font-size:13px;"><i class="fa-solid fa-file-signature" style="margin-right:6px;"></i>Print Approval Certificate</button></div>` : ""}
    ${req.status === "Rejected" && req.rejectReason ? `
    <div style="margin-top:10px;background:rgba(220,38,38,.07);border:1px solid rgba(220,38,38,.25);border-radius:10px;padding:10px 12px;">
      <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#b91c1c;margin-bottom:3px;"><i class="fa-solid fa-circle-info" style="margin-right:4px;"></i>Reason for Rejection</div>
      <div style="font-size:12px;color:#7f1d1d;white-space:pre-wrap;">${req.rejectReason}</div>
      <div style="font-size:9px;color:rgba(127,29,29,.6);margin-top:4px;">${req.rejectedAt || ""}${req.rejectedBy ? " · by " + req.rejectedBy : ""}</div>
    </div>` : ""}
    ${req.claimRef ? `
    <div class="detail-row"><span class="detail-label">Claiming Ref.</span><span class="detail-value" style="font-family:monospace;font-weight:800;color:#1e40af;">${req.claimRef}</span></div>
    <div class="detail-row"><span class="detail-label">Claimed On</span><span class="detail-value">${req.claimedAt}</span></div>
    <div class="detail-row"><span class="detail-label">Released By</span><span class="detail-value">${req.claimedBy}</span></div>
    <div style="margin-top:12px;"><button onclick="printReceipt('${req.id}')" class="btn-maroon" style="width:100%;padding:10px;font-size:13px;"><i class="fa-solid fa-print" style="margin-right:6px;"></i>Print Claim Receipt</button></div>` : ""}
  `;
  detailModal.classList.add("open");
}
function closeDetail() { document.getElementById("detailModal").classList.remove("open"); }

/* ──────────────────────────────────────────
   SUBMIT REQUEST
──────────────────────────────────────────── */
function quickRequest(docKey) {
  goTo("page-request");
  setTimeout(() => {
    const sel = document.getElementById("reqDocType");
    sel.value = docKey;
    updateDocHelp(docKey);
  }, 50);
}

async function submitRequest() {
  const docType = document.getElementById("reqDocType").value;
  const purpose = document.getElementById("reqPurpose").value;
  let valid = true;

  document.getElementById("reqDocType").classList.remove("error");
  document.getElementById("reqPurpose").classList.remove("error");
  document.getElementById("reqDocTypeErr").classList.remove("show");
  document.getElementById("reqPurposeErr").classList.remove("show");

  if (!docType) { document.getElementById("reqDocType").classList.add("error"); document.getElementById("reqDocTypeErr").classList.add("show"); valid = false; }
  const requirements = DOC_REQUIREMENTS[docType] || [];
  if (requirements.length && !requirements.every((_, index) => document.getElementById(`reqCheck-${index}`)?.checked)) { showToast("⚠️ Please confirm the document requirements first.", "rgba(180,130,0,.85)"); valid = false; }
  if (!purpose) { document.getElementById("reqPurpose").classList.add("error"); document.getElementById("reqPurposeErr").classList.add("show"); valid = false; }
  if (!valid) return;

  const btn = document.getElementById("submitReqBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Submitting…';

  const notes = document.getElementById("reqNotes").value.trim();
  const { ok, data, error } = await api("/api/requests", { method: "POST", body: { docKey: docType, purpose, copies, notes } });

  btn.disabled = false;
  btn.innerHTML = '<i class="fa-solid fa-paper-plane" style="margin-right:8px;"></i>Submit Request';

  if (!ok) { showToast(`❌ ${error || "Could not submit request."}`, "rgba(155,22,22,.85)"); return; }

  await loadRequests();
  const myReqs = DB.filter((r) => r.studentId === session.id);
  document.getElementById("kpiTotal").textContent = myReqs.length;
  document.getElementById("kpiPending").textContent = myReqs.filter((r) => r.status === "Pending").length;
  document.getElementById("kpiReady").textContent = myReqs.filter((r) => r.status === "Ready to Claim").length;

  document.getElementById("reqDocType").value = "";
  document.getElementById("reqPurpose").value = "";
  document.getElementById("reqNotes").value = "";
  document.getElementById("docHelp").style.display = "none";
  copies = 1;
  document.getElementById("copiesVal").textContent = "1";

  showToast(`✅ ${data.id} submitted! Processing in 3–5 days.`);
  setTimeout(() => goTo("page-student"), 900);
}

/* ──────────────────────────────────────────
   ADMIN PAGE
──────────────────────────────────────────── */
function renderAdminPage() {
  renderAdminKPIs();
  renderAdminActivity();
  renderAdminTable();
  renderQueue();
  renderAuditLog();
  renderCharts();
  updateMasterlistStatus();
  renderEmailOutbox();
  renderAcctApprovals();
}
function renderAdminActivity() {
  const el = document.getElementById("adminActivity");
  if (!el || !ADMIN_ACTIVITY) return;
  const items = [
    ["fa-file-circle-exclamation", ADMIN_ACTIVITY.pendingRequests, "Pending requests"],
    ["fa-calendar-clock", ADMIN_ACTIVITY.waitingAppointments, "Waiting appointments"],
    ["fa-shield-heart", ADMIN_ACTIVITY.openComplaints, "Open complaints"],
    ["fa-envelope-circle-check", ADMIN_ACTIVITY.emailFailures, "Email failures"],
  ];
  el.style.display = "block";
  el.innerHTML = `<div style="font-size:12px;font-weight:800;color:#1a0505;margin-bottom:10px;"><i class="fa-solid fa-bolt" style="color:#D4A017;margin-right:6px;"></i>Staff Activity</div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;">${items.map(([icon, count, label]) => `<div style="display:flex;align-items:center;gap:8px;font-size:12px;"><i class="fa-solid ${icon}" style="color:#8B1A1A;"></i><b style="font-size:18px;">${count}</b><span style="color:rgba(30,5,5,.65);">${label}</span></div>`).join("")}</div>`;
}

function renderAdminKPIs() {
  const total = DB.length;
  const pending = DB.filter((r) => r.status === "Pending").length;
  const approved = DB.filter((r) => r.status === "Approved" || r.status === "Ready to Claim" || r.status === "Completed").length;
  const rejected = DB.filter((r) => r.status === "Rejected").length;
  const clearRate = total > 0 ? Math.round((approved / total) * 100) : 0;

  document.getElementById("adminKpiTotal").textContent = total;
  document.getElementById("adminKpiPending").textContent = pending;
  document.getElementById("adminKpiApproved").textContent = approved;
  document.getElementById("adminKpiRejected").textContent = rejected;
  document.getElementById("adminKpiClearance").textContent = clearRate + "% clearance rate";
  document.getElementById("clearanceBadge").textContent = clearRate + "% Clearance";
  document.getElementById("legendApproved").textContent = approved;
  document.getElementById("legendPending").textContent = pending;
  document.getElementById("legendRejected").textContent = rejected;
}

function renderAdminTable() {
  const q = (document.getElementById("adminSearch")?.value || "").toLowerCase();
  const filter = document.getElementById("adminStatusFilter")?.value || "";
  const docSel = document.getElementById("adminDocFilter");
  let docF = "";
  if (docSel) {
    docF = docSel.value;
    const docs = [...new Set(DB.map((r) => r.doc))].sort();
    docSel.innerHTML = '<option value="">All Documents</option>' + docs.map((d) => `<option value="${d}" ${d === docF ? "selected" : ""}>${d}</option>`).join("");
    if (docF && !docs.includes(docF)) docF = "";
  }
  const sortMode = document.getElementById("adminSort")?.value || "new";
  const sorted = [...DB].sort((a, b) => {
    if (sortMode === "old") return a.dateSort - b.dateSort;
    if (sortMode === "doc") return a.doc.localeCompare(b.doc) || b.dateSort - a.dateSort;
    if (sortMode === "stu") return a.studentName.localeCompare(b.studentName) || b.dateSort - a.dateSort;
    return b.dateSort - a.dateSort;
  });
  const filtered = sorted.filter((r) => {
    const matchStatus = !filter || r.status === filter;
    const matchDoc = !docF || r.doc === docF;
    const matchQ = !q || r.studentName.toLowerCase().includes(q) || r.studentId.toLowerCase().includes(q) || r.doc.toLowerCase().includes(q) || r.id.toLowerCase().includes(q) || r.status.toLowerCase().includes(q);
    return matchStatus && matchDoc && matchQ;
  });

  const tbody = document.getElementById("adminTable");
  const empty = document.getElementById("adminTableEmpty");

  if (filtered.length === 0) { tbody.innerHTML = ""; empty.style.display = "block"; return; }
  empty.style.display = "none";

  tbody.innerHTML = filtered.map((r) => {
    const bc = badgeClass(r.status);
    const eyeBtn = `<button onclick="openAdminDetail('${r.id}')" class="btn-ghost" style="padding:5px 12px;font-size:11px;border-radius:9px;"><i class="fa-solid fa-eye"></i></button>`;
    let actions;
    if (r.status === "Pending") {
      actions = `<div style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;">
           <button onclick="adminAction('${r.id}','Approved')" style="background:rgba(34,197,94,.2);border:1px solid rgba(34,197,94,.4);color:#4ade80;font-weight:800;padding:5px 12px;border-radius:9px;font-size:11px;cursor:pointer;font-family:inherit;"><i class="fa-solid fa-check" style="margin-right:4px;"></i>Approve</button>
           <button onclick="openRejectModal('${r.id}')" style="background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.35);color:#f87171;font-weight:800;padding:5px 12px;border-radius:9px;font-size:11px;cursor:pointer;font-family:inherit;"><i class="fa-solid fa-xmark" style="margin-right:4px;"></i>Reject</button>
           ${eyeBtn}
         </div>`;
    } else if (r.status === "Approved") {
      actions = `<div style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;">
           <button onclick="adminAction('${r.id}','Ready to Claim')" style="background:rgba(245,197,24,.2);border:1px solid rgba(212,160,23,.5);color:#a16207;font-weight:800;padding:5px 12px;border-radius:9px;font-size:11px;cursor:pointer;font-family:inherit;"><i class="fa-solid fa-box-open" style="margin-right:4px;"></i>Ready to Claim</button>
           ${eyeBtn}
         </div>`;
    } else if (r.status === "Ready to Claim") {
      actions = `<div style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;">
           <button onclick="adminAction('${r.id}','Completed')" style="background:rgba(37,99,235,.15);border:1px solid rgba(37,99,235,.4);color:#1e40af;font-weight:800;padding:5px 12px;border-radius:9px;font-size:11px;cursor:pointer;font-family:inherit;"><i class="fa-solid fa-flag-checkered" style="margin-right:4px;"></i>Complete</button>
           ${eyeBtn}
         </div>`;
    } else if (r.status === "Completed") {
      actions = `<div style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;">
           <button onclick="printReceipt('${r.id}')" class="btn-maroon" style="padding:5px 12px;font-size:11px;border-radius:9px;"><i class="fa-solid fa-print" style="margin-right:4px;"></i>Receipt</button>
           ${eyeBtn}
         </div>`;
    } else {
      actions = `<button onclick="openAdminDetail('${r.id}')" class="btn-ghost" style="padding:5px 12px;font-size:11px;border-radius:9px;"><i class="fa-solid fa-eye" style="margin-right:4px;"></i>View</button>`;
    }
    return `<tr>
      <td><div style="font-weight:700;font-size:13px;color:#1a0505;">${r.studentName}</div><div style="font-size:10px;font-family:monospace;color:rgba(30,5,5,.55);">${r.studentId}</div></td>
      <td style="font-size:13px;color:#1a0505;">${r.doc}</td>
      <td style="font-size:12px;color:rgba(30,5,5,.68);">${r.date}</td>
      <td><span class="badge ${bc}">${r.status}</span></td>
      <td style="text-align:right;">${actions}</td>
    </tr>`;
  }).join("");
}

// Approve/reject/etc. — calls the API, reloads fresh state, re-renders.
async function adminAction(reqId, newStatus, reason) {
  const { ok, error } = await api(`/api/requests/${encodeURIComponent(reqId)}`, { method: "PATCH", body: { status: newStatus, reason } });
  if (!ok) { showToast(`❌ ${error || "Could not update request."}`, "rgba(155,22,22,.85)"); return; }
  showToast(`✅ ${reqId} marked as ${newStatus}.`);
  if (donutChart) { try { donutChart.destroy(); } catch (e) {} donutChart = null; }
  if (barChartInst) { try { barChartInst.destroy(); } catch (e) {} barChartInst = null; }
  await loadRequests();
  await loadAuditLog();
  await loadEmailLog();
  renderAdminPage();
}

function openAdminDetail(reqId) {
  const req = DB.find((r) => r.id === reqId);
  if (!req) return;
  const detailModal = document.getElementById("adminDetailModal");
  if (detailModal && detailModal.parentElement !== document.body) document.body.appendChild(detailModal);
  const bc = badgeClass(req.status);
  document.getElementById("adminDetailContent").innerHTML = `
    <div class="detail-row"><span class="detail-label">Ref No.</span><span class="detail-value" style="font-family:monospace;">${req.id}</span></div>
    <div class="detail-row"><span class="detail-label">Student</span><span class="detail-value">${req.studentName}</span></div>
    <div class="detail-row"><span class="detail-label">Student No.</span><span class="detail-value" style="font-family:monospace;font-size:12px;">${req.studentId}</span></div>
    <div class="detail-row"><span class="detail-label">Document</span><span class="detail-value">${req.doc}</span></div>
    <div class="detail-row"><span class="detail-label">Purpose</span><span class="detail-value">${req.purpose}</span></div>
    <div class="detail-row"><span class="detail-label">Copies</span><span class="detail-value">${req.copies}</span></div>
    <div class="detail-row"><span class="detail-label">Date Submitted</span><span class="detail-value">${req.date}</span></div>
    <div class="detail-row"><span class="detail-label">Status</span><span class="detail-value"><span class="badge ${bc}">${req.status}</span></span></div>
    ${req.notes ? `<div class="detail-row"><span class="detail-label">Notes</span><span class="detail-value" style="font-size:12px;color:rgba(20,4,4,.85);">${req.notes}</span></div>` : ""}
    ${req.reuploadUrl ? `<div class="detail-row"><span class="detail-label">Corrected requirement</span><span class="detail-value">${fileLink(req.reuploadName, req.reuploadUrl, "View uploaded file")}</span></div>` : ""}
    ${req.status === "Rejected" && req.rejectReason ? `
    <div style="margin-top:10px;background:rgba(220,38,38,.07);border:1px solid rgba(220,38,38,.25);border-radius:10px;padding:10px 12px;">
      <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#b91c1c;margin-bottom:3px;"><i class="fa-solid fa-circle-info" style="margin-right:4px;"></i>Reason for Rejection</div>
      <div style="font-size:12px;color:#7f1d1d;white-space:pre-wrap;">${req.rejectReason}</div>
      <div style="font-size:9px;color:rgba(127,29,29,.6);margin-top:4px;">${req.rejectedAt || ""}${req.rejectedBy ? " · by " + req.rejectedBy : ""}</div>
    </div>` : ""}
    ${req.claimRef ? `
    <div class="detail-row"><span class="detail-label">Claiming Ref.</span><span class="detail-value" style="font-family:monospace;font-weight:800;color:#1e40af;">${req.claimRef}</span></div>
    <div class="detail-row"><span class="detail-label">Claimed On</span><span class="detail-value">${req.claimedAt}</span></div>
    <div class="detail-row"><span class="detail-label">Released By</span><span class="detail-value">${req.claimedBy}</span></div>` : ""}
  `;
  const actDiv = document.getElementById("adminDetailActions");
  if (req.status === "Pending") {
    actDiv.innerHTML = `
      <button onclick="adminAction('${req.id}','Approved');closeAdminDetail()" style="flex:1;background:rgba(34,197,94,.2);border:1px solid rgba(34,197,94,.4);color:#4ade80;font-weight:800;padding:10px;border-radius:12px;font-size:13px;cursor:pointer;font-family:inherit;"><i class="fa-solid fa-check" style="margin-right:6px;"></i>Approve</button>
      <button onclick="closeAdminDetail();openRejectModal('${req.id}')" style="flex:1;background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.35);color:#f87171;font-weight:800;padding:10px;border-radius:12px;font-size:13px;cursor:pointer;font-family:inherit;"><i class="fa-solid fa-xmark" style="margin-right:6px;"></i>Reject</button>
      <button onclick="closeAdminDetail()" class="btn-ghost" style="padding:10px 14px;font-size:13px;">Cancel</button>`;
  } else if (req.status === "Approved") {
    actDiv.innerHTML = `
      <button onclick="adminAction('${req.id}','Ready to Claim');closeAdminDetail()" style="flex:1;background:rgba(245,197,24,.2);border:1px solid rgba(212,160,23,.5);color:#a16207;font-weight:800;padding:10px;border-radius:12px;font-size:13px;cursor:pointer;font-family:inherit;"><i class="fa-solid fa-box-open" style="margin-right:6px;"></i>Mark Ready to Claim</button>
      <button onclick="closeAdminDetail()" class="btn-ghost" style="padding:10px 14px;font-size:13px;">Close</button>`;
  } else if (req.status === "Ready to Claim") {
    actDiv.innerHTML = `
      <button onclick="adminAction('${req.id}','Completed');openAdminDetail('${req.id}')" style="flex:1;background:rgba(37,99,235,.15);border:1px solid rgba(37,99,235,.4);color:#1e40af;font-weight:800;padding:10px;border-radius:12px;font-size:13px;cursor:pointer;font-family:inherit;"><i class="fa-solid fa-flag-checkered" style="margin-right:6px;"></i>Mark Completed (Claimed)</button>
      <button onclick="closeAdminDetail()" class="btn-ghost" style="padding:10px 14px;font-size:13px;">Close</button>`;
  } else if (req.status === "Completed") {
    actDiv.innerHTML = `
      <button onclick="printReceipt('${req.id}')" class="btn-maroon" style="flex:1;padding:10px;font-size:13px;"><i class="fa-solid fa-print" style="margin-right:6px;"></i>Print Claim Receipt</button>
      <button onclick="closeAdminDetail()" class="btn-ghost" style="padding:10px 14px;font-size:13px;">Close</button>`;
  } else {
    actDiv.innerHTML = `<button onclick="closeAdminDetail()" class="btn-ghost" style="width:100%;padding:11px;">Close</button>`;
  }
  detailModal.classList.add("open");
}
function closeAdminDetail() { document.getElementById("adminDetailModal").classList.remove("open"); }

/* ──────────────────────────────────────────
   QUEUE
──────────────────────────────────────────── */
function renderQueue() {
  const servedCount = queueData.filter((q) => q.served).length;
  const qs = (document.getElementById("queueSearch")?.value || "").trim().toLowerCase();
  const list = queueData.filter((q) => !qs || q.q.toLowerCase().includes(qs) || q.name.toLowerCase().includes(qs) || q.studentId.toLowerCase().includes(qs));
  const waiting = list.filter((q) => !q.served);
  const served = list.filter((q) => q.served);
  document.getElementById("queueMeta").textContent = qs
    ? `${list.length} of ${queueData.length} appointments match "${qs}"`
    : `${queueData.length} appointments today · ${servedCount} served`;
  const item = (q) => `
    <div class="queue-item${q.served ? "" : " qi-active"}">
      <div>
        <div style="font-size:18px;font-weight:900;color:${q.served ? "rgba(30,5,5,.42)" : "#1a0505"};">${q.q}</div>
        <div style="font-size:10px;font-weight:700;color:rgba(30,5,5,.55);margin-top:1px;">${q.studentId.slice(0, 12)}… · ${q.time}</div>
      </div>
      ${q.served
        ? `<span style="font-size:11px;font-weight:700;color:rgba(30,5,5,.68);display:flex;align-items:center;gap:4px;"><i class="fa-solid fa-check-double"></i>Served</span>`
        : `<button onclick="serveQueue('${q.q}')" class="btn-maroon" style="padding:6px 14px;font-size:12px;border-radius:10px;">Serve</button>`}
    </div>`;
  document.getElementById("queueList").innerHTML = waiting.length
    ? waiting.map(item).join("")
    : '<div style="text-align:center;font-size:12px;color:rgba(30,5,5,.5);padding:14px;">No waiting appointments.</div>';
  const servedPanel = document.getElementById("servedQueuePanel");
  const servedList = document.getElementById("servedQueueList");
  document.getElementById("servedQueueCount").textContent = served.length ? `${served.length}` : "";
  servedList.innerHTML = served.length ? served.map(item).join("") : '<div style="font-size:11px;color:rgba(30,5,5,.5);padding:7px 0;">No served appointments.</div>';
  servedPanel.style.display = served.length ? "block" : "none";
}

function viewAllAppointments() {
  // The modal starts inside the dashboard markup. Move it to <body> before
  // opening so the dashboard stacking layer cannot place it under the navbar.
  const modal = document.getElementById("allQueueModal");
  if (modal && modal.parentElement !== document.body) document.body.appendChild(modal);
  renderAllAppointments();
  modal?.classList.add("open");
}

function closeAllAppointments() {
  document.getElementById("allQueueModal").classList.remove("open");
}

function renderAllAppointments() {
  const modalList = document.getElementById("allQueueModalList");
  const modalMeta = document.getElementById("allQueueModalMeta");
  if (!modalList || !modalMeta) return;
  const ordered = [...queueData.filter((q) => !q.served), ...queueData.filter((q) => q.served)];
  const servedCount = queueData.filter((q) => q.served).length;
  modalMeta.textContent = `${queueData.length} appointments · ${servedCount} served · ${queueData.length - servedCount} waiting`;
  modalList.innerHTML = ordered.length ? ordered.map((q) => `
    <div class="queue-item${q.served ? "" : " qi-active"}">
      <div>
        <div style="font-size:16px;font-weight:900;color:${q.served ? "rgba(30,5,5,.52)" : "#1a0505"};">${q.q}</div>
        <div style="font-size:11px;font-weight:700;color:rgba(30,5,5,.58);margin-top:2px;">${q.name} · ${q.studentId} · ${q.time}</div>
      </div>
      ${q.served
        ? '<span style="font-size:12px;font-weight:800;color:#15803d;"><i class="fa-solid fa-check-double" style="margin-right:4px;"></i>Served</span>'
        : `<button onclick="serveQueue('${q.q}')" class="btn-maroon" style="padding:7px 15px;font-size:12px;border-radius:10px;">Serve</button>`}
    </div>`).join("") : '<div class="empty-state" style="padding:24px;">No appointments today.</div>';
}

async function serveQueue(qNum) {
  const { ok, error } = await api(`/api/queue/${encodeURIComponent(qNum)}`, { method: "PATCH", body: { served: true } });
  if (!ok) { showToast(`❌ ${error || "Could not update the queue."}`, "rgba(155,22,22,.85)"); return; }
  const entry = queueData.find((q) => q.q === qNum);
  showToast(`✅ ${qNum} — ${entry ? entry.name : ""} marked as served.`);
  await loadQueueData();
  await loadAuditLog();
  renderQueue();
  if (document.getElementById("allQueueModal")?.classList.contains("open")) renderAllAppointments();
  renderAuditLog();
}

/* ──────────────────────────────────────────
   CHARTS
──────────────────────────────────────────── */
function renderCharts() {
  const pending = DB.filter((r) => r.status === "Pending").length;
  const approved = DB.filter((r) => r.status === "Approved" || r.status === "Ready to Claim" || r.status === "Completed").length;
  const rejected = DB.filter((r) => r.status === "Rejected").length;

  const dCtx = document.getElementById("adminChart");
  if (dCtx) {
    if (donutChart) {
      try { donutChart.data.datasets[0].data = [approved, pending, rejected]; donutChart.update(); }
      catch (e) { donutChart.destroy(); donutChart = null; }
    }
    if (!donutChart) {
      donutChart = new Chart(dCtx, {
        type: "doughnut",
        data: { labels: ["Approved/Ready", "Pending", "Rejected"], datasets: [{ data: [approved, pending, rejected], backgroundColor: ["#8B1A1A", "#D4A017", "#dc2626"], borderWidth: 2, borderColor: "rgba(255,255,255,.8)" }] },
        options: { plugins: { legend: { display: false } }, cutout: "72%" },
      });
    }
  }

  const docCounts = {};
  DB.forEach((r) => { docCounts[r.docKey] = (docCounts[r.docKey] || 0) + 1; });
  const barLabels = ["gmc", "coe", "tor", "auth", "diploma"];
  const barData = barLabels.map((k) => docCounts[k] || 0);
  const bCtx = document.getElementById("barChart");
  if (bCtx) {
    if (barChartInst) {
      try { barChartInst.data.datasets[0].data = barData; barChartInst.update(); }
      catch (e) { barChartInst.destroy(); barChartInst = null; }
    }
    if (!barChartInst) {
      barChartInst = new Chart(bCtx, {
        type: "bar",
        data: { labels: ["GMC", "COE", "TOR", "Auth", "Diploma"], datasets: [{ data: barData, backgroundColor: "#8B1A1A", borderRadius: 4 }] },
        options: { plugins: { legend: { display: false } }, scales: { y: { display: false }, x: { ticks: { color: "rgba(80,20,20,.55)", font: { size: 10, family: "Inter" } }, grid: { display: false } } } },
      });
    }
  }
}

/* ──────────────────────────────────────────
   AUDIT LOG
──────────────────────────────────────────── */
function renderAuditLog() {
  const color = { INFO: "#4ade80", WARN: "#facc15", ERROR: "#f87171" };
  document.getElementById("auditLog").innerHTML =
    [...auditLogs].reverse().map((l) => `<div><span style="color:${color[l.type] || "#fff"};">[${l.type}]</span> ${l.ts} — ${l.msg}</div>`).join("");
}

/* ──────────────────────────────────────────
   CALENDAR & APPOINTMENT
──────────────────────────────────────────── */
function buildCalendar() {
  const container = document.getElementById("calendar");
  const year = appointmentCalendarYear, month = appointmentCalendarMonth;
  const days = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const first = new Date(year, month, 1).getDay();
  const total = new Date(year, month + 1, 0).getDate();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let html = `<div style="text-align:center;margin-bottom:12px;font-size:13px;font-weight:800;color:#fff;">${new Date(year, month, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" })}</div>
  <div style="display:grid;grid-template-columns:repeat(7,1fr);text-align:center;margin-bottom:4px;">
    ${days.map((d) => `<div style="font-size:10px;font-weight:700;color:rgba(30,5,5,.55);padding:4px 0;">${d}</div>`).join("")}
  </div>
  <div style="display:grid;grid-template-columns:repeat(7,1fr);text-align:center;gap:2px;">`;
  for (let i = 0; i < first; i++) html += "<div></div>";
  for (let d = 1; d <= total; d++) {
    const date = new Date(year, month, d), avail = date >= today && date.getDay() !== 0 && date.getDay() !== 6, past = !avail, isSel = selectedDate === d;
    if (past) html += `<div class="cal-day-past">${d}</div>`;
    else if (avail) html += `<div onclick="selectDate(${d})" class="cal-day-avail${isSel ? " selected" : ""}">${d}<span class="gold-dot" style="${isSel ? "background:#fff;" : ""}"></span></div>`;
    else html += `<div class="cal-day-na">${d}</div>`;
  }
  container.innerHTML = html + "</div>";
}
async function selectDate(d) {
  selectedDate = d; selectedSlot = null;
  document.getElementById("selectedDateLabel").textContent = `June ${d}, 2026 — loading availability…`;
  document.getElementById("confirmCard").style.display = "none";
  buildCalendar();
  const { ok, data } = await api(`/api/queue?date=${encodeURIComponent(appointmentDateLabel(d))}`);
  appointmentAvailability = ok ? data : { bookedTimes: [], myAppointment: null };
  document.getElementById("selectedDateLabel").textContent = appointmentAvailability.myAppointment
    ? `You already booked ${appointmentAvailability.myAppointment.code} at ${appointmentAvailability.myAppointment.time} on this date.`
    : `June ${d}, 2026 — select an available business-hours time slot:`;
  buildSlots();
  if (!appointmentAvailability.myAppointment) document.getElementById("selectedDateLabel").textContent = `${appointmentDateLabel(d)} — select an available business-hours time slot:`;
}
function buildSlots() {
  const times = ["8:00 AM", "8:30 AM", "9:00 AM", "9:30 AM", "10:00 AM", "10:30 AM", "1:00 PM", "1:30 PM", "2:00 PM", "2:30 PM"];
  const taken = appointmentAvailability.bookedTimes || [];
  document.getElementById("timeSlots").innerHTML = times.map((t) => {
    const isT = taken.includes(t), hasOwnBooking = !!appointmentAvailability.myAppointment, isSel = selectedSlot === t;
    return `<button ${isT || hasOwnBooking ? "disabled" : ""} onclick="${isT || hasOwnBooking ? "" : "selectSlot('" + t + "')"}" class="slot-btn${isSel ? " selected" : ""}">${isT ? `<s>${t}</s> <small>Booked</small>` : hasOwnBooking ? `<s>${t}</s>` : t}</button>`;
  }).join("");
}
async function selectSlot(t) {
  selectedSlot = t; buildSlots();
  document.getElementById("confirmCard").style.display = "block";
  document.getElementById("apptDateLabel").textContent = `June ${selectedDate}, 2026 · ${t}`;
  const { ok, data } = await api("/api/queue?count=1");
  document.getElementById("queueNum").textContent = String((ok ? data.count : 0) + 1).padStart(3, "0");
  document.getElementById("apptDateLabel").textContent = `${appointmentDateLabel(selectedDate)} · ${t}`;
}
async function bookAppointment() {
  if (!selectedDate || !selectedSlot) return;
  const dateLabel = appointmentDateLabel(selectedDate);
  const { ok, data, error } = await api("/api/queue", { method: "POST", body: { dateLabel, time: selectedSlot } });
  if (!ok) { showToast(`❌ ${error || "Could not book that slot."}`, "rgba(155,22,22,.85)"); return; }
  showToast(`✅ Booked! ${data.q} on ${dateLabel} at ${selectedSlot}`);
  selectedDate = null; selectedSlot = null;
  setTimeout(() => goTo("page-student"), 1200);
}

function buildRescheduleCalendar() {
  const container = document.getElementById("rescheduleCalendar");
  if (!container) return;
  const year = rescheduleCalYear, month = rescheduleCalMonth;
  const days = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const first = new Date(year, month, 1).getDay();
  const total = new Date(year, month + 1, 0).getDate();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let html = `<div style="text-align:center;margin-bottom:12px;font-size:13px;font-weight:800;color:#2a1010;">${new Date(year, month, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" })}</div>
  <div style="display:grid;grid-template-columns:repeat(7,1fr);text-align:center;margin-bottom:4px;">
    ${days.map((d) => `<div style="font-size:10px;font-weight:700;color:rgba(30,5,5,.55);padding:4px 0;">${d}</div>`).join("")}
  </div>
  <div style="display:grid;grid-template-columns:repeat(7,1fr);text-align:center;gap:2px;">`;
  for (let i = 0; i < first; i++) html += "<div></div>";
  for (let d = 1; d <= total; d++) {
    const date = new Date(year, month, d), avail = date >= today && date.getDay() !== 0 && date.getDay() !== 6, past = !avail, isSel = rescheduleSelectedDate === d;
    if (past) html += `<div class="cal-day-past">${d}</div>`;
    else if (avail) html += `<div onclick="selectRescheduleDate(${d})" class="cal-day-avail${isSel ? " selected" : ""}">${d}<span class="gold-dot" style="${isSel ? "background:#fff;" : ""}"></span></div>`;
    else html += `<div class="cal-day-na">${d}</div>`;
  }
  container.innerHTML = html + "</div>";
}
async function selectRescheduleDate(d) {
  rescheduleSelectedDate = d; rescheduleSelectedSlot = null;
  const label = document.getElementById("rescheduleDateLabel");
  buildRescheduleCalendar();
  if (label) label.textContent = `${rescheduleDateLabel(d)} — loading availability…`;
  const { ok, data } = await api(`/api/queue?date=${encodeURIComponent(rescheduleDateLabel(d))}`);
  rescheduleAvailability = ok ? data : { bookedTimes: [], myAppointment: null };
  if (label) label.textContent = `${rescheduleDateLabel(d)} — select an available business-hours time slot:`;
  buildRescheduleSlots();
}
function buildRescheduleSlots() {
  const container = document.getElementById("rescheduleTimeSlots");
  if (!container) return;
  const times = ["8:00 AM", "8:30 AM", "9:00 AM", "9:30 AM", "10:00 AM", "10:30 AM", "1:00 PM", "1:30 PM", "2:00 PM", "2:30 PM"];
  const taken = rescheduleAvailability.bookedTimes || [];
  const isOwnDate = rescheduleAvailability.myAppointment?.code === rescheduleCode;
  container.innerHTML = times.map((t) => {
    const isOwnSlot = isOwnDate && rescheduleAvailability.myAppointment?.time === t;
    const isTaken = taken.includes(t) && !isOwnSlot;
    const isSel = rescheduleSelectedSlot === t;
    return `<button ${isTaken ? "disabled" : ""} onclick="${isTaken ? "" : "selectRescheduleSlot('" + t + "')"}" class="slot-btn${isSel ? " selected" : ""}">${isTaken ? `<s>${t}</s> <small>Booked</small>` : isOwnSlot ? `${t} <small>(current)</small>` : t}</button>`;
  }).join("");
}
function selectRescheduleSlot(t) {
  rescheduleSelectedSlot = t;
  buildRescheduleSlots();
}

/* ──────────────────────────────────────────
   SCANNER (client-side demo affordance — the real, backend-verified flow
   is "Verify by Reference" below via verifyRef())
──────────────────────────────────────────── */
function simulateScan(type) {
  document.getElementById("scanResultValid").style.display = "none";
  document.getElementById("scanResultInvalid").style.display = "none";
  if (type === "valid") { document.getElementById("scanResultValid").style.display = "block"; showToast("✅ QR Code verified!", "rgba(21,128,61,.85)"); }
  else { document.getElementById("scanResultInvalid").style.display = "block"; showToast("❌ Invalid QR code", "rgba(155,22,22,.85)"); }
}
function markClaimed() {
  document.getElementById("scanResultValid").style.display = "none";
  showToast("📦 REQ-2026-042 marked as claimed.");
}

/* ──────────────────────────────────────────
   HELPERS
──────────────────────────────────────────── */
function badgeClass(status) { return { Pending: "badge-pending", Approved: "badge-approved", "Ready to Claim": "badge-ready", Rejected: "badge-rejected", Completed: "badge-completed" }[status] || "badge-pending"; }
function togglePass(id, btn) { const el = document.getElementById(id); el.type = el.type === "password" ? "text" : "password"; btn.querySelector("i").className = el.type === "password" ? "fa-solid fa-eye" : "fa-solid fa-eye-slash"; }
function validateStudNum(el) { const valid = /^\d{4}-\d{5}-SP-\d$/.test(el.value); const h = document.getElementById("studNumHelper"); if (el.value.length > 3) { el.style.borderColor = valid ? "rgba(34,197,94,.5)" : "rgba(239,68,68,.5)"; h.innerHTML = valid ? '<i class="fa-solid fa-circle-check" style="color:#4ade80;margin-right:3px;"></i><span style="color:#4ade80;">Valid format</span>' : '<i class="fa-solid fa-triangle-exclamation" style="color:#f87171;margin-right:3px;"></i><span style="color:#f87171;">Format: 2024-00000-SP-0</span>'; } }
function checkStrength(val) { const bars = [1, 2, 3, 4].map((i) => document.getElementById("s" + i)); const label = document.getElementById("strengthLabel"); let score = 0; if (val.length >= 8) score++; if (/[A-Z]/.test(val)) score++; if (/[0-9]/.test(val)) score++; if (/[^A-Za-z0-9]/.test(val)) score++; const colors = ["rgba(239,68,68,.8)", "rgba(249,115,22,.8)", "rgba(245,197,24,.8)", "rgba(34,197,94,.8)"]; const labels = ["Weak", "Fair", "Good", "Strong"]; bars.forEach((b, i) => (b.style.background = i < score ? colors[score - 1] : "rgba(139,26,26,.1)")); label.textContent = val.length ? labels[score - 1] || "Weak" : "Password strength"; label.style.color = val.length ? colors[score - 1] : "rgba(30,5,5,.55)"; }
function changeCopies(d) { copies = Math.max(1, Math.min(10, copies + d)); document.getElementById("copiesVal").textContent = copies; }
function updateDocHelp(val) {
  const el = document.getElementById("docHelp");
  if (!val || !DOC_HELPS[val]) { el.style.display = "none"; return; }
  const requirements = DOC_REQUIREMENTS[val] || [];
  el.innerHTML = `<div>${esc(DOC_HELPS[val])}</div><div style="margin-top:10px;font-weight:800;font-size:11px;">Requirements checklist</div>${requirements.map((item, index) => `<label style="display:flex;gap:7px;align-items:flex-start;margin-top:6px;font-size:11px;cursor:pointer;"><input id="reqCheck-${index}" type="checkbox" style="margin-top:2px;accent-color:#8B1A1A;"><span>${esc(item)}</span></label>`).join("")}`;
  el.style.display = "block";
}

/* ──────────────────────────────────────────
   CSV MASTERLIST IMPORT — parsing stays client-side; the parsed rows are
   sent to the server, which replaces the masterlist table.
──────────────────────────────────────────── */
function parseCSV(text) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\r") {}
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => (c || "").trim() !== ""));
}

function handleCSV(input) {
  if (!input.files.length) return;
  const file = input.files[0];
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const rows = parseCSV(e.target.result);
      if (!rows.length) { showToast("⚠️ The CSV file is empty.", "rgba(180,130,0,.85)"); return; }

      const norm = (s) => (s || "").toLowerCase().replace(/[\s_-]/g, "");
      const SN = ["studentnumber", "studentno", "studentid", "studno", "studnum", "srcode", "idnumber", "id", "number"];
      const NM = ["name", "fullname", "studentname", "completename"];
      const FN = ["firstname", "fname", "givenname"];
      const LN = ["lastname", "lname", "surname", "familyname"];
      const EM = ["email", "emailaddress", "pupemail", "mail"];
      const CR = ["course", "program", "degree", "curriculum"];
      const YR = ["year", "yearlevel", "yearlvl", "level"];

      const header = rows[0].map(norm);
      const has = (arr) => header.some((h) => arr.includes(h));
      const idxOf = (arr) => header.findIndex((h) => arr.includes(h));
      const hasHeader = has(SN) || has(NM) || has(EM) || has(FN) || has(LN) || has(CR) || has(YR);

      let iSN, iNM, iFN, iLN, iEM, iCR, iYR, dataRows;
      if (hasHeader) {
        iSN = idxOf(SN); iNM = idxOf(NM); iFN = idxOf(FN); iLN = idxOf(LN); iEM = idxOf(EM); iCR = idxOf(CR); iYR = idxOf(YR);
        if (iSN === -1) iSN = 0;
        dataRows = rows.slice(1);
      } else {
        iSN = 0; iNM = 1; iEM = 2; iFN = -1; iLN = -1; iCR = -1; iYR = -1;
        dataRows = rows;
      }

      const list = [];
      const seen = new Set();
      dataRows.forEach((r) => {
        const sn = (r[iSN] || "").toString().trim().toUpperCase();
        if (!sn || seen.has(sn)) return;
        seen.add(sn);
        let name = iNM > -1 ? (r[iNM] || "").trim() : "";
        if (!name && (iFN > -1 || iLN > -1)) name = `${iFN > -1 ? (r[iFN] || "").trim() : ""} ${iLN > -1 ? (r[iLN] || "").trim() : ""}`.trim();
        const email = iEM > -1 ? (r[iEM] || "").trim() : "";
        const course = iCR > -1 ? (r[iCR] || "").trim() : "";
        const year = iYR > -1 ? (r[iYR] || "").trim() : "";
        list.push({ sn, name, email, course, year });
      });

      if (!list.length) { showToast("⚠️ No valid student numbers found in the CSV.", "rgba(180,130,0,.85)"); return; }

      const { ok, data, error } = await api("/api/masterlist/import", { method: "POST", body: { rows: list, fileName: file.name } });
      if (!ok) { showToast(`❌ ${error || "Could not import the masterlist."}`, "rgba(155,22,22,.85)"); return; }
      await refreshMasterlistStatus();
      showToast(`✅ Masterlist loaded — ${data.count} students imported.`);
    } catch (err) {
      showToast("❌ Could not read that CSV file.", "rgba(155,22,22,.85)");
    }
    input.value = "";
  };
  reader.onerror = () => showToast("❌ Failed to read the file.", "rgba(155,22,22,.85)");
  reader.readAsText(file);
}

async function deleteMasterlist() {
  if (!MASTERLIST_COUNT) {
    showToast("⚠️ There is no imported masterlist to delete.", "rgba(180,130,0,.85)");
    return;
  }
  const confirmed = window.confirm(
    `Delete the current imported masterlist (${MASTERLIST_COUNT} student${MASTERLIST_COUNT === 1 ? "" : "s"})?\n\nRegistered user accounts will not be deleted.`
  );
  if (!confirmed) return;

  const { ok, data, error } = await api("/api/masterlist", { method: "DELETE" });
  if (!ok) {
    showToast(`❌ ${error || "Could not delete the masterlist."}`, "rgba(155,22,22,.85)");
    return;
  }
  await refreshMasterlistStatus();
  showToast(`✅ Masterlist deleted — ${data.count} imported student${data.count === 1 ? "" : "s"} removed.`);
}
function showToast(msg, bg) { const t = document.createElement("div"); t.className = "toast"; t.style.background = bg || "rgba(139,26,26,.85)"; t.style.pointerEvents = "auto"; t.innerHTML = msg; document.getElementById("toastContainer").appendChild(t); setTimeout(() => { t.style.transition = ".3s"; t.style.opacity = "0"; t.style.transform = "translateY(8px)"; setTimeout(() => t.remove(), 300); }, 3200); }

/* ══════════════════════════════════════════════════════════════
   OSS SERVICE MODULES (referrals, ID applications, bulletin, help desk,
   FAQ, event requests, complaints, downloadable forms, email blast)
   Every render* function below is unchanged from the original — it reads
   from MOD[key], populated by loadModule(key) in goTo() above. Submit /
   update actions call the API, then reload + re-render.
══════════════════════════════════════════════════════════════ */
const APP_VERSION = "3.2.1-nextjs";

function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function fnow() { return new Date().toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }); }
function isAdmin() { return session && (session.role === "admin" || session.role === "super_admin"); }
function isSuperAdmin() { return session && session.role === "super_admin"; }
function pill(status) {
  const s = (status || "").toLowerCase();
  let bg = "rgba(180,130,0,.14)", fg = "#a16207", bd = "rgba(180,130,0,.3)";
  if (/(approved|completed|resolved|published|answered|ready|verified|claimed|sent)/.test(s)) { bg = "rgba(22,163,74,.12)"; fg = "#15803d"; bd = "rgba(22,163,74,.3)"; }
  else if (/(review|investigation|ongoing|processing|open)/.test(s)) { bg = "rgba(37,99,235,.10)"; fg = "#1d4ed8"; bd = "rgba(37,99,235,.3)"; }
  else if (/(rejected|dismissed|failed)/.test(s)) { bg = "rgba(220,38,38,.10)"; fg = "#b91c1c"; bd = "rgba(220,38,38,.3)"; }
  else if (/(closed|archived)/.test(s)) { bg = "rgba(107,114,128,.12)"; fg = "#4b5563"; bd = "rgba(107,114,128,.3)"; }
  else if (/revision/.test(s)) { bg = "rgba(234,88,12,.12)"; fg = "#c2410c"; bd = "rgba(234,88,12,.3)"; }
  return `<span style="font-size:10px;font-weight:800;padding:3px 9px;border-radius:99px;background:${bg};color:${fg};border:1px solid ${bd};white-space:nowrap;">${esc(status)}</span>`;
}
function fileLink(name, data, label) {
  if (!data) return '<span style="color:rgba(30,5,5,.4);font-size:11px;">No file</span>';
  return `<a href="${data}" download="${esc(name)}" style="font-size:11px;font-weight:700;color:#8B1A1A;"><i class="fa-solid fa-paperclip" style="margin-right:4px;"></i>${esc(label || name)}</a>`;
}

const STUDENT_SERVICES = [
  { page: "page-referral", icon: "fa-hand-holding-heart", t: "Referral & Intervention", d: "Request support or refer a concern" },
  { page: "page-idapp", icon: "fa-id-card", t: "ID Application", d: "New ID or replacement (OR required)" },
  { page: "page-helpdesk", icon: "fa-robot", t: "Student Service Help", d: "Ask the FAQ chatbot" },
  { page: "page-complaint", icon: "fa-shield-heart", t: "Complaints", d: "Confidential reports & concerns" },
  { page: "page-events2", icon: "fa-calendar-star,fa-calendar-check", t: "Event Request", d: "For student organizations" },
  { page: "page-bulletin", icon: "fa-bullhorn", t: "Student Bulletin", d: "Announcements & advisories" },
  { page: "page-faq", icon: "fa-circle-question", t: "FAQ", d: "Frequently asked questions" },
  { page: "page-forms", icon: "fa-file-arrow-down", t: "Downloadable Forms", d: "Official OSS forms" },
];
const ADMIN_SERVICES = [
  { page: "page-referral", icon: "fa-hand-holding-heart", t: "Referrals", d: "Review & manage interventions" },
  { page: "page-idapp", icon: "fa-id-card", t: "ID Applications", d: "Verify ORs & update statuses" },
  { page: "page-helpdesk", icon: "fa-headset", t: "Help Desk", d: "Respond to student tickets" },
  { page: "page-complaint", icon: "fa-shield-heart", t: "Complaints", d: "Investigate & resolve" },
  { page: "page-events2", icon: "fa-calendar-check", t: "Event Requests", d: "Approve, reject, or revise" },
  { page: "page-bulletin", icon: "fa-bullhorn", t: "Bulletin Manager", d: "Publish, edit, archive posts" },
  { page: "page-faq", icon: "fa-circle-question", t: "FAQ Manager", d: "Maintain FAQ content" },
  { action: "viewFaqAnalytics", icon: "fa-chart-simple", t: "FAQ Usage", d: "View chatbot usage analytics" },
  { page: "page-forms", icon: "fa-file-arrow-down", t: "Forms Manager", d: "Upload & manage forms" },
  { page: "page-memo", icon: "fa-envelopes-bulk", t: "Email Blast", d: "Send memos to student groups" },
  { action: "openReports", icon: "fa-chart-column", t: "Reports & Analytics", d: "Export CSV reports and view service trends" },
  { action: "reviewProfileChanges", icon: "fa-user-check", t: "Profile Verification", d: "Approve or reject student profile updates" },
  { action: "sendReminders", icon: "fa-bell", t: "Send Reminders", d: "Email appointment and document-ready reminders" },
];
function hubCard(x) {
  const icon = x.icon.split(",").pop();
  const action = x.action ? `${x.action}()` : `goTo('${x.page}')`;
  return `<button onclick="${action}" class="glass-card" style="text-align:left;padding:18px;cursor:pointer;border:1px solid rgba(139,26,26,.12);">
    <div style="width:38px;height:38px;border-radius:10px;background:rgba(139,26,26,.09);display:flex;align-items:center;justify-content:center;margin-bottom:10px;">
      <i class="fa-solid ${icon}" style="color:#8B1A1A;font-size:15px;"></i></div>
    <div style="font-size:14px;font-weight:800;color:#1a0505;">${esc(x.t)}</div>
    <div style="font-size:11px;color:rgba(30,5,5,.6);margin-top:3px;">${esc(x.d)}</div>
  </button>`;
}
function renderServicesHub() { document.getElementById("servicesGrid").innerHTML = STUDENT_SERVICES.map(hubCard).join(""); }
function renderManageHub() {
  const superTools = isSuperAdmin() ? [
    { action: "manageSystemSettings", icon: "fa-sliders", t: "System Settings", d: "Business hours, holidays, capacity, and cutoff" },
    { action: "manageStaffAccounts", icon: "fa-user-shield", t: "Staff Accounts", d: "Create and review Admin and Scanner accounts" },
    { action: "downloadBackup", icon: "fa-database", t: "Database Backup", d: "Download a secure JSON backup export" },
    { action: "restoreBackup", icon: "fa-clock-rotate-left", t: "Restore Configuration", d: "Restore masterlist, settings, and FAQs from backup" },
  ] : [];
  document.getElementById("manageGrid").innerHTML = [...ADMIN_SERVICES, ...superTools].map(hubCard).join("");
}

function downloadBackup() {
  if (!confirm("Download a database backup file? Keep it in a secure location.")) return;
  window.open("/api/backup", "_blank");
}

function restoreBackup() {
  if (!confirm("Restore masterlist, system settings, and FAQs from a backup? Current values will be replaced. Requests and accounts will not be changed.")) return;
  const picker = document.createElement("input"); picker.type = "file"; picker.accept = ".json,application/json";
  picker.onchange = () => {
    const file = picker.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const result = await api("/api/backup", { method: "POST", body: JSON.parse(String(reader.result)) });
        showToast(result.ok ? `✅ Restored ${result.data.masterlist} masterlist records, ${result.data.settings} settings, and ${result.data.faqs} FAQs.` : `❌ ${result.error || "Could not restore backup."}`, result.ok ? undefined : "rgba(155,22,22,.85)");
      } catch { showToast("❌ The selected file is not a valid JSON backup.", "rgba(155,22,22,.85)"); }
    };
    reader.readAsText(file);
  };
  picker.click();
}

function closeAppModal() { document.getElementById("appModal")?.remove(); }
function openAppModal({ title, subtitle = "", icon = "fa-circle-info", content = "", wide = false }) {
  closeAppModal();
  const modal = document.createElement("div");
  modal.id = "appModal"; modal.className = "modal-overlay open app-modal";
  modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true");
  modal.innerHTML = `<div class="modal-box" style="max-width:${wide ? "880px" : "680px"};"><div class="app-modal-head"><div><div class="app-modal-title"><i class="fa-solid ${icon}"></i><span>${esc(title)}</span></div>${subtitle ? `<p class="app-modal-subtitle">${esc(subtitle)}</p>` : ""}</div><button class="app-modal-close" onclick="closeAppModal()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div><div class="app-modal-body">${content}</div></div>`;
  modal.addEventListener("click", (event) => { if (event.target === modal) closeAppModal(); });
  document.body.appendChild(modal); return modal;
}
function modalField(label, id, value = "", extra = "") { return `<div class="app-field ${extra}"><label for="${id}">${esc(label)}</label><input id="${id}" class="glass-input" value="${esc(value)}"></div>`; }

async function requestProfileEdit() {
  const current = await api("/api/profile"); if (!current.ok) return showToast("❌ Could not load profile.", "rgba(155,22,22,.85)");
  if (current.data.pending) return showToast("⚠️ Your profile update is already awaiting staff verification.", "rgba(180,130,0,.85)");
  const u = current.data.user || session;
  openAppModal({ title: "Update Profile", subtitle: "Your changes will be reviewed by Student Services before they are applied.", icon: "fa-user-pen", content: `<div class="app-modal-grid">${modalField("Full name", "profileName", u.name)}${modalField("Email", "profileEmail", u.email)}${modalField("Course", "profileCourse", u.course || "")}${modalField("Year level", "profileYear", u.year || "")}</div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Cancel</button><button class="btn-maroon" onclick="saveProfileEdit()"><i class="fa-solid fa-paper-plane"></i> Submit for review</button></div>` });
  return;
  const name = prompt("Full name:", u.name); if (name === null) return;
  const email = prompt("Email:", u.email); if (email === null) return;
  const course = prompt("Course:", u.course || ""); if (course === null) return;
  const year = prompt("Year level:", u.year || ""); if (year === null) return;
  const result = await api("/api/profile", { method: "POST", body: { name, email, course, year } });
  showToast(result.ok ? "✅ Profile update submitted for staff verification." : `❌ ${result.error || "Could not submit profile update."}`, result.ok ? undefined : "rgba(155,22,22,.85)");
}

async function saveProfileEdit() {
  const name = document.getElementById("profileName")?.value.trim(), email = document.getElementById("profileEmail")?.value.trim(), course = document.getElementById("profileCourse")?.value.trim(), year = document.getElementById("profileYear")?.value.trim();
  if (!name || !email) return showToast("Name and email are required.", "rgba(180,130,0,.85)");
  const result = await api("/api/profile", { method: "POST", body: { name, email, course, year } });
  if (result.ok) closeAppModal();
  showToast(result.ok ? "Profile update submitted for staff verification." : (result.error || "Could not submit profile update."), result.ok ? undefined : "rgba(155,22,22,.85)");
}

async function reviewProfileChanges() {
  const list = await api("/api/profile"); if (!list.ok) return showToast("❌ Could not load profile updates.", "rgba(155,22,22,.85)");
  if (!list.data.length) return showToast("No profile updates awaiting review.");
  const first = list.data[0];
  const decision = prompt(`Review ${first.name} (${first.studentId})\nEmail: ${first.email}\nCourse/Year: ${first.course || "-"} / ${first.year || "-"}\n\nType APPROVED or REJECTED:`, "APPROVED");
  if (!decision) return;
  const status = decision.trim().toLowerCase() === "approved" ? "Approved" : decision.trim().toLowerCase() === "rejected" ? "Rejected" : "";
  if (!status) return showToast("⚠️ Type APPROVED or REJECTED.", "rgba(180,130,0,.85)");
  const result = await api(`/api/profile/${encodeURIComponent(first.id)}`, { method: "PATCH", body: { status } });
  showToast(result.ok ? `✅ Profile update ${status.toLowerCase()}.` : `❌ ${result.error || "Could not update profile."}`, result.ok ? undefined : "rgba(155,22,22,.85)");
}

async function sendReminders() {
  if (!confirm("Send reminders for appointments within 24 hours and all ready-to-claim documents?")) return;
  const result = await api("/api/reminders", { method: "POST" });
  showToast(result.ok ? `✅ Sent ${result.data.appointmentEmails} appointment and ${result.data.readyEmails} document reminders.` : `❌ ${result.error || "Could not send reminders."}`, result.ok ? undefined : "rgba(155,22,22,.85)");
}


async function openReports() {
  const analytics = await api("/api/reports/analytics");
  if (!analytics.ok) { showToast("❌ Could not load analytics.", "rgba(155,22,22,.85)"); return; }
  const a = analytics.data;
  const summarize = (items) => (items || []).map((x) => `${x.label}: ${x.count}`).join("\n") || "No data";
  const choice = prompt(`Analytics\n\nMost requested services:\n${summarize(a.services)}\n\nPeak appointment times:\n${summarize(a.peakTimes)}\n\nType requests, appointments, or complaints to download its CSV report:`, "requests");
  if (!choice) return;
  const type = choice.trim().toLowerCase();
  if (!["requests", "appointments", "complaints"].includes(type)) { showToast("⚠️ Choose requests, appointments, or complaints.", "rgba(180,130,0,.85)"); return; }
  window.open(`/api/reports/export?type=${encodeURIComponent(type)}`, "_blank");
}

async function viewFaqAnalytics() {
  const result = await api("/api/faq-analytics");
  showToast(result.ok ? `FAQ chatbot queries recorded: ${result.data.totalQueries}` : "❌ Could not load FAQ analytics.", result.ok ? undefined : "rgba(155,22,22,.85)");
}

async function openReports() {
  const analytics = await api("/api/reports/analytics");
  if (!analytics.ok) return showToast("Could not load analytics.", "rgba(155,22,22,.85)");
  const a = analytics.data;
  const summarize = (items) => (items || []).map((x) => `${x.label}: ${x.count}`).join("\n") || "No data";
  const choice = prompt(`Analytics\n\nStudents by course:\n${summarize(a.byCourse)}\n\nStudents by year level:\n${summarize(a.byYear)}\n\nMost requested services:\n${summarize(a.services)}\n\nPeak appointment times:\n${summarize(a.peakTimes)}\n\nType requests, appointments, complaints for CSV, or PDF for a printable analytics report:`, "requests");
  if (!choice) return;
  const type = choice.trim().toLowerCase();
  if (type === "pdf") return printAnalyticsReport(a);
  if (!["requests", "appointments", "complaints"].includes(type)) return showToast("Choose requests, appointments, or complaints.", "rgba(180,130,0,.85)");
  window.open(`/api/reports/export?type=${encodeURIComponent(type)}`, "_blank");
}

function printAnalyticsReport(data) {
  const rows = (items) => (items || []).map((x) => `<tr><td>${esc(x.label)}</td><td>${esc(x.count)}</td></tr>`).join("") || "<tr><td colspan='2'>No data</td></tr>";
  const section = (title, items) => `<h2>${esc(title)}</h2><table><thead><tr><th>Category</th><th>Count</th></tr></thead><tbody>${rows(items)}</tbody></table>`;
  const html = `<!doctype html><html><head><title>QR-SASMS Analytics Report</title><style>body{font-family:Arial,sans-serif;padding:32px;color:#1a0505}h1{color:#8B1A1A}h2{margin-top:24px;font-size:16px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #bbb;padding:8px;text-align:left}th{background:#8B1A1A;color:#fff}.foot{font-size:10px;color:#666;margin-top:24px}@media print{body{padding:0}.noprint{display:none}}</style></head><body><h1>QR-SASMS Analytics Report</h1><p>PUP San Pedro Student Services Office</p>${section("Students by Course",data.byCourse)}${section("Students by Year Level",data.byYear)}${section("Most Requested Services",data.services)}${section("Peak Appointment Times",data.peakTimes)}<div class="foot">Generated ${esc(fnow())} · QR-SASMS</div><div class="noprint"><button onclick="window.print()">Print / Save as PDF</button></div><script>setTimeout(()=>window.print(),300);<\/script></body></html>`;
  const w = window.open("", "_blank"); if (!w) return showToast("Please allow pop-ups to save the PDF.", "rgba(180,130,0,.85)"); w.document.write(html); w.document.close();
}

async function viewFaqAnalytics() {
  const result = await api("/api/faq-analytics");
  if (!result.ok) return showToast("Could not load FAQ analytics.", "rgba(155,22,22,.85)");
  const details = (result.data.matches || []).map((x, i) => `${i + 1}. ${x.question}: ${x.count}`).join("\n") || "No chatbot questions recorded yet.";
  alert(`FAQ Chatbot Analytics\n\nTotal queries: ${result.data.totalQueries}\n\nTop matched/unmatched questions:\n${details}`);
}

async function manageSystemSettings() {
  const current = await api("/api/settings"); if (!current.ok) { showToast("❌ Could not load settings.", "rgba(155,22,22,.85)"); return; }
  const data = current.data;
  const businessHours = prompt("Business hours (comma-separated time slots):", (data.businessHours || []).join(", ")); if (businessHours === null) return;
  const capacity = prompt("Appointment capacity per slot:", data.appointmentCapacity); if (capacity === null) return;
  const cutoff = prompt("Cancellation/reschedule cutoff in hours:", data.cancellationCutoffHours); if (cutoff === null) return;
  const holidays = prompt("Closed dates (comma-separated, e.g. December 25, 2026):", (data.holidays || []).join(", ")); if (holidays === null) return;
  const emailTemplate = prompt("Email template. You may use {{name}}, {{title}}, and {{message}}:", data.emailTemplate || "{{message}}\n\n— QR-SASMS"); if (emailTemplate === null) return;
  const result = await api("/api/settings", { method: "PUT", body: { businessHours: businessHours.split(",").map((x) => x.trim()).filter(Boolean), appointmentCapacity: Number(capacity), cancellationCutoffHours: Number(cutoff), holidays: holidays.split(",").map((x) => x.trim()).filter(Boolean), emailTemplate } });
  showToast(result.ok ? "✅ System settings saved." : `❌ ${result.error || "Could not save settings."}`, result.ok ? undefined : "rgba(155,22,22,.85)");
}

async function manageStaffAccounts() {
  const list = await api("/api/users/staff"); if (!list.ok) { showToast("❌ Could not load staff accounts.", "rgba(155,22,22,.85)"); return; }
  const summary = list.data.map((u) => `${u.name} — ${u.role}`).join("\n") || "No staff accounts yet.";
  if (!confirm(`${summary}\n\nCreate a new staff account?`)) return;
  const name = prompt("Staff name:"); const email = prompt("Staff email:"); const password = prompt("Temporary password (minimum 10 characters):"); const role = prompt("Role: ADMIN or SCANNER", "ADMIN");
  if (!name || !email || !password || !role) return;
  const created = await api("/api/users/staff", { method: "POST", body: { name, email, password, role: role.toUpperCase() } });
  showToast(created.ok ? "✅ Staff account created." : `❌ ${created.error || "Could not create staff account."}`, created.ok ? undefined : "rgba(155,22,22,.85)");
}

/* ---------- admin search helper (pure client-side filter over already-loaded MOD[key]) ---------- */
function matchQ(q, fields) { if (!q) return true; q = q.toLowerCase(); return fields.some((f) => (f == null ? "" : String(f)).toLowerCase().includes(q)); }
let refAdminQ = "", idaAdminQ = "", hdAdminQ = "", evtAdminQ = "", cmpAdminQ = "";
// Super Admin staff controls: create, edit role/name, or deactivate an account.
async function manageStaffAccounts() {
  const list = await api("/api/users/staff");
  if (!list.ok) return showToast("Could not load staff accounts.", "rgba(155,22,22,.85)");
  const summary = list.data.map((u) => `${u.name} (${u.email}) — ${u.role} · ${u.active ? "Active" : "Deactivated"}`).join("\n") || "No staff accounts yet.";
  const action = prompt(`${summary}\n\nType CREATE to add staff, or enter a staff email to edit/deactivate:`, "CREATE");
  if (!action) return;
  const target = list.data.find((u) => u.email.toLowerCase() === action.trim().toLowerCase());
  if (target) {
    const name = prompt("Staff name:", target.name); if (name === null) return;
    const role = prompt("Role: ADMIN or SCANNER", target.role); if (role === null) return;
    const active = confirm("Keep this account active? Click Cancel to deactivate it.");
    const updated = await api(`/api/users/staff/${encodeURIComponent(target.id)}`, { method: "PATCH", body: { name, role: role.toUpperCase(), active } });
    return showToast(updated.ok ? "Staff account updated." : (updated.error || "Could not update account."), updated.ok ? undefined : "rgba(155,22,22,.85)");
  }
  if (action.trim().toUpperCase() !== "CREATE") return showToast("Enter CREATE or an email from the list.", "rgba(180,130,0,.85)");
  const name = prompt("Staff name:"), email = prompt("Staff email:"), password = prompt("Temporary password (minimum 10 characters):"), role = prompt("Role: ADMIN or SCANNER", "ADMIN");
  if (!name || !email || !password || !role) return;
  const created = await api("/api/users/staff", { method: "POST", body: { name, email, password, role: role.toUpperCase() } });
  showToast(created.ok ? "Staff account created." : (created.error || "Could not create staff account."), created.ok ? undefined : "rgba(155,22,22,.85)");
}
function adminSearchBox(id, varName, renderFn, placeholder, currentVal) {
  return `<div style="position:relative;margin-bottom:12px;">
    <i class="fa-solid fa-magnifying-glass" style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:rgba(30,5,5,.4);font-size:12px;"></i>
    <input id="${id}" class="glass-input" style="padding-left:34px;" placeholder="${placeholder}" value="${esc(currentVal)}"
      oninput="${varName}=this.value;${renderFn}();(function(){var e=document.getElementById('${id}');if(e){e.focus();e.setSelectionRange(e.value.length,e.value.length);}})();">
  </div>`;
}
function emptyState(msg) { return `<div class="glass-card" style="padding:26px;text-align:center;color:rgba(30,5,5,.5);font-size:12px;"><i class="fa-solid fa-inbox" style="font-size:20px;display:block;margin-bottom:8px;color:rgba(139,26,26,.35);"></i>${esc(msg)}</div>`; }

/* ══════════ 1. REFERRAL & INTERVENTION ══════════ */
const REF_STATUSES = ["Pending", "Under Review", "Approved", "Ongoing Intervention", "Completed", "Rejected"];
function renderReferral() {
  const el = document.getElementById("referralBody");
  if (isAdmin()) {
    const rows = [...MOD.referrals].reverse().filter((r) => matchQ(refAdminQ, [r.name, r.sn, r.id, r.category, r.status])).map((r) => `
      <div class="glass-card" style="padding:14px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;">
          <div><span style="font-weight:800;font-size:13px;color:#1a0505;">${esc(r.name)}</span>
            <span style="font-size:11px;color:rgba(30,5,5,.55);margin-left:6px;">${esc(r.sn)} · ${esc(r.category)} · ${esc(r.ts)}</span></div>
          ${pill(r.status)}
        </div>
        <div style="font-size:12px;color:rgba(30,5,5,.8);margin:8px 0;white-space:pre-wrap;">${esc(r.details)}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <select id="refst-${r.id}" class="glass-input" style="max-width:210px;padding:8px;font-size:12px;">
            ${REF_STATUSES.map((s) => `<option ${s === r.status ? "selected" : ""}>${s}</option>`).join("")}
          </select>
          <input id="refrm-${r.id}" class="glass-input" style="flex:1;min-width:160px;padding:8px;font-size:12px;" placeholder="Remarks (optional)" value="${esc(r.remarks || "")}">
          <button onclick="refUpdate('${r.id}')" class="btn-maroon" style="padding:8px 14px;font-size:12px;">Update</button>
        </div>
        ${r.history && r.history.length ? `<div style="margin-top:8px;font-size:10px;color:rgba(30,5,5,.5);font-family:monospace;">${r.history.map((h) => `${esc(h.ts)} — ${esc(h.status)} by ${esc(h.by)}`).join("<br>")}</div>` : ""}
      </div>`).join("");
    el.innerHTML = adminSearchBox("refAdminQBox", "refAdminQ", "renderReferral", "Search by name or student ID…", refAdminQ)
      + (rows || emptyState(refAdminQ ? "No referrals match your search." : "No referrals submitted yet."));
  } else {
    const mine = MOD.referrals.filter((r) => r.sn === session.id).reverse();
    el.innerHTML = `
      <div class="glass-card" style="padding:18px;margin-bottom:16px;">
        <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:10px;"><i class="fa-solid fa-plus" style="color:#8B1A1A;margin-right:6px;"></i>New Referral / Intervention Request</div>
        <div style="display:grid;gap:10px;">
          <div><span class="input-label">Category</span>
            <select id="refCat" class="glass-input"><option>Academic Concern</option><option>Personal / Emotional</option><option>Behavioral</option><option>Financial Assistance</option><option>Health &amp; Wellness</option><option>Others</option></select></div>
          <div><span class="input-label">Details</span>
            <textarea id="refDetails" class="glass-input" rows="4" placeholder="Describe the concern or the support you need…"></textarea></div>
          <button onclick="refSubmit()" class="btn-gold" style="padding:11px;"><i class="fa-solid fa-paper-plane" style="margin-right:6px;"></i>Submit Request</button>
        </div>
      </div>
      <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:8px;">My Referrals</div>
      ${mine.length ? mine.map((r) => `
        <div class="glass-card" style="padding:14px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
            <div style="font-size:12px;font-weight:700;color:#1a0505;">${esc(r.category)} <span style="color:rgba(30,5,5,.5);font-weight:400;">· ${esc(r.ts)}</span></div>
            ${pill(r.status)}
          </div>
          <div style="font-size:12px;color:rgba(30,5,5,.75);margin-top:6px;white-space:pre-wrap;">${esc(r.details)}</div>
          ${r.remarks ? `<div style="font-size:11px;color:#8B1A1A;margin-top:6px;"><b>OSS remarks:</b> ${esc(r.remarks)}</div>` : ""}
        </div>`).join("") : emptyState("You have not submitted any referrals yet.")}
    `;
  }
}
async function refSubmit() {
  const cat = document.getElementById("refCat").value;
  const det = document.getElementById("refDetails").value.trim();
  if (!det) { showToast("⚠️ Please describe your concern.", "rgba(180,130,0,.85)"); return; }
  const { ok, error } = await api("/api/modules/referrals", { method: "POST", body: { category: cat, details: det } });
  if (!ok) { showToast(`❌ ${error || "Could not submit."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ Referral submitted.");
  await loadModule("referrals"); renderReferral();
}
async function refUpdate(id) {
  const st = document.getElementById("refst-" + id).value;
  const rm = document.getElementById("refrm-" + id).value.trim();
  const { ok, error } = await api(`/api/modules/referrals/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: st, remarks: rm } });
  if (!ok) { showToast(`❌ ${error || "Could not update."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ Updated and student notified.");
  await loadModule("referrals"); renderReferral();
}

/* ══════════ 2. ID APPLICATION ══════════ */
const ID_STATUSES = ["Pending", "OR Verified", "Approved", "Processing", "Ready for Claiming", "Claimed", "Rejected"];
function renderIdApp() {
  const el = document.getElementById("idappBody");
  if (isAdmin()) {
    const rows = [...MOD.idapps].reverse().filter((a) => matchQ(idaAdminQ, [a.name, a.sn, a.id, a.type, a.status])).map((a) => `
      <div class="glass-card" style="padding:14px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;">
          <div><span style="font-weight:800;font-size:13px;color:#1a0505;">${esc(a.name)}</span>
            <span style="font-size:11px;color:rgba(30,5,5,.55);margin-left:6px;">${esc(a.sn)} · ${esc(a.type)} · ${esc(a.ts)}</span></div>
          ${pill(a.status)}
        </div>
        <div style="font-size:12px;color:rgba(30,5,5,.8);margin:6px 0;">${esc(a.reason)}</div>
        <div style="margin-bottom:8px;display:flex;gap:12px;flex-wrap:wrap;">${fileLink(a.orName, a.orUrl, "View Official Receipt")}${a.affidavitUrl ? fileLink(a.affidavitName, a.affidavitUrl, "View Affidavit of Loss") : ""}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <select id="idst-${a.id}" class="glass-input" style="max-width:210px;padding:8px;font-size:12px;">
            ${ID_STATUSES.map((s) => `<option ${s === a.status ? "selected" : ""}>${s}</option>`).join("")}
          </select>
          <input id="idrm-${a.id}" class="glass-input" style="flex:1;min-width:160px;padding:8px;font-size:12px;" placeholder="Remarks (optional)" value="${esc(a.remarks || "")}">
          <button onclick="idUpdate('${a.id}')" class="btn-maroon" style="padding:8px 14px;font-size:12px;">Update</button>
        </div>
      </div>`).join("");
    el.innerHTML = adminSearchBox("idaAdminQBox", "idaAdminQ", "renderIdApp", "Search by name or student ID…", idaAdminQ)
      + (rows || emptyState(idaAdminQ ? "No applications match your search." : "No ID applications yet."));
  } else {
    const mine = MOD.idapps.filter((a) => a.sn === session.id).reverse();
    el.innerHTML = `
      <div class="glass-card" style="padding:18px;margin-bottom:16px;">
        <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:10px;"><i class="fa-solid fa-plus" style="color:#8B1A1A;margin-right:6px;"></i>New ID Application</div>
        <div style="display:grid;gap:10px;">
          <div><span class="input-label">Application Type</span>
            <select id="idType" class="glass-input" onchange="toggleAffidavitField()"><option>New ID</option><option>ID Replacement — Lost</option><option>ID Replacement — Damaged</option></select></div>
          <div><span class="input-label">Reason / Details</span>
            <textarea id="idReason" class="glass-input" rows="3" placeholder="e.g., Lost my ID on campus last week…"></textarea></div>
          <div><span class="input-label">Official Receipt (OR) — required</span>
            <input id="idOr" type="file" accept=".jpg,.jpeg,.png,.pdf" class="glass-input" style="padding:9px;">
            <div style="font-size:10px;color:rgba(30,5,5,.55);margin-top:4px;">Pay at the cashier first, then upload a photo/scan of your OR (JPG, PNG, or PDF, max 1.5 MB).</div></div>
          <div id="affidavitField" style="display:none;"><span class="input-label">Affidavit of Loss — required for a lost ID</span>
            <input id="idAffidavit" type="file" accept=".jpg,.jpeg,.png,.pdf" class="glass-input" style="padding:9px;">
            <div style="font-size:10px;color:rgba(30,5,5,.55);margin-top:4px;">Upload the signed Affidavit of Loss (JPG, PNG, or PDF, max 1.5 MB).</div></div>
          <button onclick="idSubmit()" class="btn-gold" style="padding:11px;"><i class="fa-solid fa-paper-plane" style="margin-right:6px;"></i>Submit Application</button>
        </div>
      </div>
      <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:8px;">My Applications</div>
      ${mine.length ? mine.map((a) => `
        <div class="glass-card" style="padding:14px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
            <div style="font-size:12px;font-weight:700;color:#1a0505;">${esc(a.type)} <span style="color:rgba(30,5,5,.5);font-weight:400;">· ${esc(a.ts)}</span></div>
            ${pill(a.status)}
          </div>
          <div style="margin-top:6px;display:flex;gap:12px;flex-wrap:wrap;">${fileLink(a.orName, a.orUrl, "My uploaded OR")}${a.affidavitUrl ? fileLink(a.affidavitName, a.affidavitUrl, "My Affidavit of Loss") : ""}</div>
          ${a.remarks ? `<div style="font-size:11px;color:#8B1A1A;margin-top:6px;"><b>OSS remarks:</b> ${esc(a.remarks)}</div>` : ""}
        </div>`).join("") : emptyState("No applications yet.")}
    `;
  }
}
async function idSubmit() {
  const type = document.getElementById("idType").value;
  const reason = document.getElementById("idReason").value.trim();
  const orInput = document.getElementById("idOr");
  const affidavitInput = document.getElementById("idAffidavit");
  if (!reason) { showToast("⚠️ Please provide the reason/details.", "rgba(180,130,0,.85)"); return; }
  if (!orInput.files.length) { showToast("⚠️ Official Receipt upload is required.", "rgba(180,130,0,.85)"); return; }
  const uploaded = await uploadFile(orInput);
  if (uploaded === false) return;
  if (!uploaded.url) { showToast("⚠️ Official Receipt upload is required.", "rgba(180,130,0,.85)"); return; }
  let affidavit = { fileName: "", url: "" };
  if (type === "ID Replacement — Lost") {
    if (!affidavitInput.files.length) { showToast("⚠️ An Affidavit of Loss is required for a lost ID.", "rgba(180,130,0,.85)"); return; }
    affidavit = await uploadFile(affidavitInput);
    if (affidavit === false || !affidavit.url) return;
  }
  const { ok, error } = await api("/api/modules/idapps", { method: "POST", body: { type, reason, orName: uploaded.fileName, orUrl: uploaded.url, affidavitName: affidavit.fileName, affidavitUrl: affidavit.url } });
  if (!ok) { showToast(`❌ ${error || "Could not submit."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ Application submitted with OR.");
  await loadModule("idapps"); renderIdApp();
}
function toggleAffidavitField() {
  const field = document.getElementById("affidavitField");
  if (field) field.style.display = document.getElementById("idType").value === "ID Replacement — Lost" ? "block" : "none";
}
async function idUpdate(id) {
  const st = document.getElementById("idst-" + id).value;
  const rm = document.getElementById("idrm-" + id).value.trim();
  const { ok, error } = await api(`/api/modules/idapps/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: st, remarks: rm } });
  if (!ok) { showToast(`❌ ${error || "Could not update."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ Updated and student notified.");
  await loadModule("idapps"); renderIdApp();
}

/* ══════════ 3. MONTHLY BULLETIN ══════════ */
let bulletinEditingId = null;
function renderBulletin() {
  const el = document.getElementById("bulletinBody");
  const now = Date.now();
  const visible = MOD.bulletins.filter((b) => b.status === "Published" && (!b.publishAt || b.publishAt <= now));
  const featured = visible.filter((b) => b.featured);
  const normal = visible.filter((b) => !b.featured);
  const postCard = (b) => `
    <div class="glass-card" style="padding:16px;margin-bottom:10px;${b.featured ? "border:1px solid rgba(245,197,24,.5);" : ""}">
      <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;">
        <div style="font-size:14px;font-weight:800;color:#1a0505;">${b.featured ? '<i class="fa-solid fa-star" style="color:#C9A227;margin-right:6px;"></i>' : ""}${esc(b.title)}</div>
        ${pill(b.category)}
      </div>
      <div style="font-size:10px;color:rgba(30,5,5,.5);margin:4px 0 8px;">${esc(b.ts)}${b.updatedTs ? " · edited " + esc(b.updatedTs) : ""}</div>
      <div style="font-size:12px;color:rgba(30,5,5,.85);white-space:pre-wrap;">${esc(b.body)}</div>
    </div>`;
  let adminPanel = "";
  if (isAdmin()) {
    adminPanel = `
      <div class="glass-card" style="padding:18px;margin-bottom:16px;">
        <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:10px;"><i class="fa-solid fa-pen-nib" style="color:#8B1A1A;margin-right:6px;"></i><span id="bulFormTitle">${bulletinEditingId ? "Edit Post" : "Publish New Post"}</span></div>
        <div style="display:grid;gap:10px;">
          <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px;">
            <div><span class="input-label">Title</span><input id="bulTitle" class="glass-input" placeholder="Post title"></div>
            <div><span class="input-label">Category</span><select id="bulCat" class="glass-input"><option>Announcement</option><option>Advisory</option><option>Org Event</option><option>Reminder</option></select></div>
          </div>
          <div><span class="input-label">Content</span><textarea id="bulBody" class="glass-input" rows="4" placeholder="Write the announcement…"></textarea></div>
          <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
            <label style="font-size:12px;color:#1a0505;display:flex;align-items:center;gap:6px;"><input id="bulFeat" type="checkbox"> Featured</label>
            <div style="display:flex;align-items:center;gap:6px;"><span style="font-size:12px;color:#1a0505;">Schedule:</span><input id="bulSched" type="datetime-local" class="glass-input" style="padding:7px;font-size:12px;max-width:210px;"></div>
          </div>
          <div style="display:flex;gap:8px;">
            <button onclick="bulSave()" class="btn-gold" style="padding:10px 18px;">${bulletinEditingId ? "Save Changes" : "Publish"}</button>
            ${bulletinEditingId ? '<button onclick="bulCancelEdit()" class="btn-ghost" style="padding:10px 14px;">Cancel</button>' : ""}
          </div>
        </div>
      </div>
      <div style="font-size:13px;font-weight:800;color:#1a0505;margin:14px 0 8px;">All Posts (manage)</div>
      ${MOD.bulletins.length ? [...MOD.bulletins].reverse().map((b) => `
        <div class="glass-card" style="padding:12px;margin-bottom:8px;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;">
          <div style="min-width:200px;flex:1;">
            <div style="font-size:12px;font-weight:800;color:#1a0505;">${b.featured ? "⭐ " : ""}${esc(b.title)}</div>
            <div style="font-size:10px;color:rgba(30,5,5,.5);">${esc(b.category)} · ${esc(b.ts)}${b.publishAt && b.publishAt > now ? " · scheduled " + new Date(b.publishAt).toLocaleString() : ""}</div>
          </div>
          ${pill(b.status)}
          <div style="display:flex;gap:6px;">
            <button onclick="bulEdit('${b.id}')" class="btn-ghost" style="padding:7px 10px;font-size:11px;">Edit</button>
            <button onclick="bulToggleArchive('${b.id}')" class="btn-ghost" style="padding:7px 10px;font-size:11px;">${b.status === "Archived" ? "Unarchive" : "Archive"}</button>
            <button onclick="bulDelete('${b.id}')" class="btn-ghost" style="padding:7px 10px;font-size:11px;color:#b91c1c;">Delete</button>
          </div>
        </div>`).join("") : emptyState("No posts yet.")}
      <div style="font-size:13px;font-weight:800;color:#1a0505;margin:18px 0 8px;">Live Preview (what students see)</div>`;
  }
  el.innerHTML = adminPanel
    + (featured.length ? `<div style="font-size:12px;font-weight:800;color:#C9A227;margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em;">Featured</div>${featured.map(postCard).join("")}` : "")
    + (normal.length ? normal.map(postCard).join("") : (featured.length ? "" : emptyState("No announcements right now. Check back soon!")));
}
async function bulSave() {
  const t = document.getElementById("bulTitle").value.trim();
  const c = document.getElementById("bulCat").value;
  const b = document.getElementById("bulBody").value.trim();
  const f = document.getElementById("bulFeat").checked;
  const s = document.getElementById("bulSched").value;
  if (!t || !b) { showToast("⚠️ Title and content are required.", "rgba(180,130,0,.85)"); return; }
  const publishAt = s ? new Date(s).toISOString() : null;
  let res;
  if (bulletinEditingId) {
    res = await api(`/api/modules/bulletins/${encodeURIComponent(bulletinEditingId)}`, { method: "PATCH", body: { title: t, category: c, body: b, featured: f, publishAt } });
    bulletinEditingId = null;
  } else {
    res = await api("/api/modules/bulletins", { method: "POST", body: { title: t, category: c, body: b, featured: f, publishAt } });
  }
  if (!res.ok) { showToast(`❌ ${res.error || "Could not save."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ Saved.");
  await loadModule("bulletins"); renderBulletin();
}
function bulEdit(id) {
  const p = MOD.bulletins.find((x) => x.id === id); if (!p) return;
  bulletinEditingId = id; renderBulletin();
  document.getElementById("bulTitle").value = p.title;
  document.getElementById("bulCat").value = p.category;
  document.getElementById("bulBody").value = p.body;
  document.getElementById("bulFeat").checked = !!p.featured;
  if (p.publishAt) document.getElementById("bulSched").value = new Date(p.publishAt).toISOString().slice(0, 16);
  window.scrollTo(0, 0);
}
function bulCancelEdit() { bulletinEditingId = null; renderBulletin(); }
async function bulToggleArchive(id) {
  const { ok, error } = await api(`/api/modules/bulletins/${encodeURIComponent(id)}/archive`, { method: "POST" });
  if (!ok) { showToast(`❌ ${error || "Could not update."}`, "rgba(155,22,22,.85)"); return; }
  await loadModule("bulletins"); renderBulletin();
}
async function bulDelete(id) {
  const p = MOD.bulletins.find((x) => x.id === id); if (!p) return;
  if (!confirm("Delete this post permanently?")) return;
  const { ok, error } = await api(`/api/modules/bulletins/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!ok) { showToast(`❌ ${error || "Could not delete."}`, "rgba(155,22,22,.85)"); return; }
  await loadModule("bulletins"); renderBulletin();
}

/* ══════════ 4. HELP DESK ══════════ */
let chatbotMessages = [];
function renderHelpdesk() {
  const el = document.getElementById("helpdeskBody");
  const thread = (t) => `
    <div style="background:rgba(255,255,255,.55);border:1px solid rgba(139,26,26,.08);border-radius:10px;padding:10px;margin-top:8px;max-height:220px;overflow-y:auto;">
      ${t.msgs.map((m) => `
        <div style="margin-bottom:8px;${m.from === "admin" ? "text-align:right;" : ""}">
          <div style="display:inline-block;max-width:85%;text-align:left;background:${m.from === "admin" ? "rgba(139,26,26,.08)" : "rgba(245,197,24,.12)"};border-radius:10px;padding:7px 10px;">
            <div style="font-size:9px;font-weight:800;color:rgba(30,5,5,.5);">${esc(m.by)} · ${esc(m.ts)}</div>
            <div style="font-size:12px;color:#1a0505;white-space:pre-wrap;">${esc(m.text)}</div>
          </div>
        </div>`).join("")}
    </div>`;
  const replyBox = (t, who) => t.status === "Closed" ? "" : `
    <div style="display:flex;gap:8px;margin-top:8px;">
      <input id="hdrep-${t.id}" class="glass-input" style="flex:1;padding:8px;font-size:12px;" placeholder="Type a ${who === "admin" ? "response" : "reply"}…">
      <button onclick="hdReply('${t.id}')" class="btn-maroon" style="padding:8px 14px;font-size:12px;">Send</button>
      ${who === "admin" ? `<button onclick="hdClose('${t.id}')" class="btn-ghost" style="padding:8px 12px;font-size:12px;">Close</button>` : ""}
    </div>`;
  if (isAdmin()) {
    const rows = [...MOD.tickets].reverse().filter((t) => matchQ(hdAdminQ, [t.name, t.sn, t.id, t.subject, t.category, t.status])).map((t) => `
      <div class="glass-card" style="padding:14px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;">
          <div><span style="font-weight:800;font-size:13px;color:#1a0505;">${esc(t.subject)}</span>
            <span style="font-size:11px;color:rgba(30,5,5,.55);margin-left:6px;">${esc(t.name)} (${esc(t.sn)}) · ${esc(t.category)} · ${esc(t.ts)}</span></div>
          ${pill(t.status)}
        </div>
        ${thread(t)}${replyBox(t, "admin")}
      </div>`).join("");
    el.innerHTML = adminSearchBox("hdAdminQBox", "hdAdminQ", "renderHelpdesk", "Search by name or student ID…", hdAdminQ)
      + (rows || emptyState(hdAdminQ ? "No tickets match your search." : "No tickets yet."));
  } else {
    if (!chatbotMessages.length) chatbotMessages = [{ from: "bot", text: "Hi! I can answer questions using the Student Services FAQ. Ask about documents, enrollment, ID concerns, events, or other listed services." }];
    el.innerHTML = `
      <div class="glass-card" style="padding:18px;max-width:820px;margin:0 auto;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;"><div style="width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:#8B1A1A;color:#F5C518;"><i class="fa-solid fa-robot"></i></div><div><div style="font-size:15px;font-weight:900;color:#1a0505;">Student Service Help</div><div style="font-size:11px;color:rgba(30,5,5,.6);">FAQ chatbot · Answers are based on approved FAQs</div></div></div>
        <div id="chatbotMessages" style="height:420px;overflow-y:auto;padding:14px;background:rgba(255,255,255,.48);border:1px solid rgba(139,26,26,.12);border-radius:14px;display:flex;flex-direction:column;gap:10px;">
          ${chatbotMessages.map((m) => `<div style="display:flex;justify-content:${m.from === "user" ? "flex-end" : "flex-start"};"><div style="max-width:82%;padding:10px 12px;border-radius:12px;background:${m.from === "user" ? "rgba(139,26,26,.14)" : "rgba(245,197,24,.16)"};font-size:13px;color:#1a0505;line-height:1.5;white-space:pre-wrap;">${esc(m.text)}</div></div>`).join("")}
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;"><input id="chatbotInput" class="glass-input" style="flex:1" placeholder="Ask a question about Student Services…" onkeydown="if(event.key==='Enter')chatbotAsk()"><button onclick="chatbotAsk()" class="btn-maroon" style="padding:10px 16px;"><i class="fa-solid fa-paper-plane"></i> Send</button></div>
      </div>`;
    requestAnimationFrame(() => { const box = document.getElementById("chatbotMessages"); if (box) box.scrollTop = box.scrollHeight; });
  }
}
function chatbotAsk() {
  const input = document.getElementById("chatbotInput");
  const question = input.value.trim();
  if (!question) return;
  chatbotMessages.push({ from: "user", text: question });
  const words = question.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  const scored = MOD.faqs.map((faq) => ({ faq, score: words.reduce((n, word) => n + ((faq.q + " " + faq.a + " " + faq.cat).toLowerCase().includes(word) ? 1 : 0), 0) })).sort((a, b) => b.score - a.score);
  const best = scored[0];
  api("/api/faq-analytics", { method: "POST", body: { faqId: best?.score ? best.faq.id : "unmatched" } });
  chatbotMessages.push({ from: "bot", text: best?.score ? `${best.faq.a}\n\nSource: ${best.faq.q}` : "I couldn't find a matching FAQ yet. Try different keywords or check the FAQ service for the full list." });
  renderHelpdesk();
}
async function hdSubmit() {
  const cat = document.getElementById("hdCat").value;
  const subj = document.getElementById("hdSubj").value.trim();
  const msg = document.getElementById("hdMsg").value.trim();
  if (!subj || !msg) { showToast("⚠️ Subject and message are required.", "rgba(180,130,0,.85)"); return; }
  const { ok, error } = await api("/api/modules/tickets", { method: "POST", body: { category: cat, subject: subj, message: msg } });
  if (!ok) { showToast(`❌ ${error || "Could not submit."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ Ticket submitted.");
  await loadModule("tickets"); renderHelpdesk();
}
async function hdReply(id) {
  const inp = document.getElementById("hdrep-" + id);
  const txt = inp.value.trim(); if (!txt) return;
  const { ok, error } = await api(`/api/modules/tickets/${encodeURIComponent(id)}/reply`, { method: "POST", body: { text: txt } });
  if (!ok) { showToast(`❌ ${error || "Could not send reply."}`, "rgba(155,22,22,.85)"); return; }
  await loadModule("tickets"); renderHelpdesk();
}
async function hdClose(id) {
  const { ok, error } = await api(`/api/modules/tickets/${encodeURIComponent(id)}/close`, { method: "POST" });
  if (!ok) { showToast(`❌ ${error || "Could not close ticket."}`, "rgba(155,22,22,.85)"); return; }
  await loadModule("tickets"); renderHelpdesk();
}

/* ══════════ 5. FAQ ══════════ */
let faqQuery = "";
function renderFaq() {
  const el = document.getElementById("faqBody");
  const q = faqQuery.toLowerCase();
  const list = MOD.faqs.filter((f) => !q || f.q.toLowerCase().includes(q) || f.a.toLowerCase().includes(q) || f.cat.toLowerCase().includes(q));
  const cats = [...new Set(list.map((f) => f.cat))];
  let adminForm = "";
  if (isAdmin()) {
    adminForm = `
      <div class="glass-card" style="padding:16px;margin-bottom:14px;">
        <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:10px;"><i class="fa-solid fa-plus" style="color:#8B1A1A;margin-right:6px;"></i>Add FAQ</div>
        <div style="display:grid;gap:8px;">
          <input id="faqCat" class="glass-input" placeholder="Category (e.g., Document Requests)">
          <input id="faqQ" class="glass-input" placeholder="Question">
          <textarea id="faqA" class="glass-input" rows="2" placeholder="Answer"></textarea>
          <button onclick="faqAdd()" class="btn-gold" style="padding:10px;">Add FAQ</button>
        </div>
      </div>`;
  }
  el.innerHTML = adminForm + `
    <div style="position:relative;margin-bottom:14px;">
      <i class="fa-solid fa-magnifying-glass" style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:rgba(30,5,5,.4);font-size:12px;"></i>
      <input class="glass-input" style="padding-left:34px;" placeholder="Search FAQs…" value="${esc(faqQuery)}" oninput="faqQuery=this.value;renderFaq();this.focus();this.setSelectionRange(this.value.length,this.value.length);">
    </div>
    ${cats.length ? cats.map((c) => `
      <div style="font-size:12px;font-weight:800;color:#8B1A1A;text-transform:uppercase;letter-spacing:.05em;margin:14px 0 6px;">${esc(c)}</div>
      ${list.filter((f) => f.cat === c).map((f) => `
        <details class="glass-card" style="padding:12px 14px;margin-bottom:8px;">
          <summary style="font-size:13px;font-weight:700;color:#1a0505;cursor:pointer;display:flex;justify-content:space-between;gap:8px;align-items:center;">
            <span>${esc(f.q)}</span>
            ${isAdmin() ? `<button onclick="event.preventDefault();faqDelete('${f.id}')" class="btn-ghost" style="padding:5px 9px;font-size:10px;color:#b91c1c;">Delete</button>` : ""}
          </summary>
          <div style="font-size:12px;color:rgba(30,5,5,.8);margin-top:8px;white-space:pre-wrap;">${esc(f.a)}</div>
        </details>`).join("")}`).join("") : emptyState("No FAQs match your search.")}
  `;
}
async function faqAdd() {
  const c = document.getElementById("faqCat").value.trim() || "General";
  const q = document.getElementById("faqQ").value.trim();
  const a = document.getElementById("faqA").value.trim();
  if (!q || !a) { showToast("⚠️ Question and answer are required.", "rgba(180,130,0,.85)"); return; }
  const { ok, error } = await api("/api/modules/faqs", { method: "POST", body: { cat: c, q, a } });
  if (!ok) { showToast(`❌ ${error || "Could not add FAQ."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ FAQ added.");
  await loadModule("faqs"); renderFaq();
}
async function faqDelete(id) {
  if (!confirm("Delete this FAQ?")) return;
  const { ok, error } = await api(`/api/modules/faqs/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!ok) { showToast(`❌ ${error || "Could not delete."}`, "rgba(155,22,22,.85)"); return; }
  await loadModule("faqs"); renderFaq();
}

/* ══════════ 6. EVENT REQUESTS (student orgs) ══════════ */
const EVT_STATUSES = ["Pending", "Under Review", "Approved", "Rejected", "Needs Revision", "Completed"];
let evtEditingId = null;
function renderEvents2() {
  const el = document.getElementById("events2Body");
  if (isAdmin()) {
    const rows = [...MOD.events2].reverse().filter((e) => matchQ(evtAdminQ, [e.name, e.sn, e.id, e.title, e.org, e.status])).map((e) => `
      <div class="glass-card" style="padding:14px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;">
          <div><span style="font-weight:800;font-size:13px;color:#1a0505;">${esc(e.title)}</span>
            <span style="font-size:11px;color:rgba(30,5,5,.55);margin-left:6px;">${esc(e.org)} · filed by ${esc(e.name)} · ${esc(e.ts)}</span></div>
          ${pill(e.status)}
        </div>
        <div style="font-size:11px;color:rgba(30,5,5,.75);margin:6px 0;line-height:1.6;">
          <b>Type:</b> ${esc(e.type)} · <b>Date:</b> ${esc(e.date)} ${esc(e.time)} · <b>Venue:</b> ${esc(e.venue)} · <b>Participants:</b> ${esc(e.participants)}${e.budget ? ` · <b>Budget:</b> ₱${esc(e.budget)}` : ""}<br>
          <b>Adviser:</b> ${esc(e.adviser)}<br>
          <b>Objectives:</b> ${esc(e.desc)}
        </div>
        <div style="margin-bottom:8px;">${fileLink(e.docName, e.docUrl, "Supporting document")}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <select id="evst-${e.id}" class="glass-input" style="max-width:190px;padding:8px;font-size:12px;">
            ${EVT_STATUSES.map((s) => `<option ${s === e.status ? "selected" : ""}>${s}</option>`).join("")}
          </select>
          <input id="evnt-${e.id}" class="glass-input" style="flex:1;min-width:160px;padding:8px;font-size:12px;" placeholder="Note / revision request (optional)">
          <button onclick="evtUpdate('${e.id}')" class="btn-maroon" style="padding:8px 14px;font-size:12px;">Update</button>
        </div>
        ${e.history.length ? `<div style="margin-top:8px;font-size:10px;color:rgba(30,5,5,.5);font-family:monospace;">${e.history.map((h) => `${esc(h.ts)} — ${esc(h.status)}${h.note ? ": " + esc(h.note) : ""} (${esc(h.by)})`).join("<br>")}</div>` : ""}
      </div>`).join("");
    el.innerHTML = adminSearchBox("evtAdminQBox", "evtAdminQ", "renderEvents2", "Search by name, student ID, or org…", evtAdminQ)
      + (rows || emptyState(evtAdminQ ? "No event requests match your search." : "No event requests yet."));
  } else {
    const mine = MOD.events2.filter((e) => e.sn === session.id).reverse();
    const editing = evtEditingId ? MOD.events2.find((e) => e.id === evtEditingId) : null;
    el.innerHTML = `
      <div class="glass-card" style="padding:18px;margin-bottom:16px;">
        <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:10px;"><i class="fa-solid fa-plus" style="color:#8B1A1A;margin-right:6px;"></i>${editing ? "Revise Event Request" : "New Event Request"}</div>
        <div style="display:grid;gap:10px;">
          <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px;">
            <div><span class="input-label">Event Title</span><input id="evTitle" class="glass-input" value="${editing ? esc(editing.title) : ""}"></div>
            <div><span class="input-label">Event Type</span><select id="evType" class="glass-input"><option ${editing && editing.type === "Inside Campus" ? "selected" : ""}>Inside Campus</option><option ${editing && editing.type === "Outside Campus" ? "selected" : ""}>Outside Campus</option></select></div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div><span class="input-label">Organization</span><input id="evOrg" class="glass-input" value="${editing ? esc(editing.org) : ""}"></div>
            <div><span class="input-label">Adviser Name</span><input id="evAdv" class="glass-input" value="${editing ? esc(editing.adviser) : ""}"></div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;">
            <div><span class="input-label">Date</span><input id="evDate" type="date" class="glass-input" value="${editing ? esc(editing.date) : ""}"></div>
            <div><span class="input-label">Time</span><input id="evTime" type="time" class="glass-input" value="${editing ? esc(editing.time) : ""}"></div>
            <div><span class="input-label">Expected Participants</span><input id="evPart" type="number" min="1" class="glass-input" value="${editing ? esc(editing.participants) : ""}"></div>
          </div>
          <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px;">
            <div><span class="input-label">Venue</span><input id="evVenue" class="glass-input" value="${editing ? esc(editing.venue) : ""}"></div>
            <div><span class="input-label">Budget (₱, optional)</span><input id="evBudget" type="number" min="0" class="glass-input" value="${editing ? esc(editing.budget) : ""}"></div>
          </div>
          <div><span class="input-label">Objectives / Description</span><textarea id="evDesc" class="glass-input" rows="3">${editing ? esc(editing.desc) : ""}</textarea></div>
          <div><span class="input-label">Supporting Document (adviser endorsement, program flow…) ${editing && editing.docName ? "— current: " + esc(editing.docName) : ""}</span>
            <input id="evDoc" type="file" accept=".jpg,.jpeg,.png,.pdf,.doc,.docx" class="glass-input" style="padding:9px;"></div>
          <div style="display:flex;gap:8px;">
            <button onclick="evtSubmit()" class="btn-gold" style="padding:11px 18px;">${editing ? "Resubmit for Review" : "Submit Request"}</button>
            ${editing ? '<button onclick="evtEditingId=null;renderEvents2()" class="btn-ghost" style="padding:11px 14px;">Cancel</button>' : ""}
          </div>
        </div>
      </div>
      <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:8px;">My Event Requests</div>
      ${mine.length ? mine.map((e) => `
        <div class="glass-card" style="padding:14px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;">
            <div style="font-size:12px;font-weight:700;color:#1a0505;">${esc(e.title)} <span style="color:rgba(30,5,5,.5);font-weight:400;">· ${esc(e.org)} · ${esc(e.date)}</span></div>
            <div style="display:flex;gap:6px;align-items:center;">
              ${pill(e.status)}
              ${e.status === "Needs Revision" ? `<button onclick="evtEditingId='${e.id}';renderEvents2();window.scrollTo(0,0);" class="btn-maroon" style="padding:6px 10px;font-size:11px;">Revise</button>` : ""}
            </div>
          </div>
          ${e.history.length ? `<div style="margin-top:6px;font-size:10px;color:rgba(30,5,5,.55);font-family:monospace;">${e.history.map((h) => `${esc(h.ts)} — ${esc(h.status)}${h.note ? ": " + esc(h.note) : ""}`).join("<br>")}</div>` : ""}
        </div>`).join("") : emptyState("No event requests yet.")}
    `;
  }
}
async function evtSubmit() {
  const g = (id) => document.getElementById(id).value.trim();
  const title = g("evTitle"), org = g("evOrg"), adviser = g("evAdv"), date = g("evDate"), time = g("evTime"),
    venue = g("evVenue"), participants = g("evPart"), budget = g("evBudget"), desc = g("evDesc"),
    type = document.getElementById("evType").value;
  if (!title || !org || !adviser || !date || !venue || !participants || !desc) { showToast("⚠️ Please complete all required fields.", "rgba(180,130,0,.85)"); return; }

  const docInput = document.getElementById("evDoc");
  let docName = "", docUrl = "";
  if (docInput.files.length) {
    const uploaded = await uploadFile(docInput);
    if (uploaded === false) return;
    docName = uploaded.fileName || ""; docUrl = uploaded.url || "";
  }

  const body = { title, org, adviser, date, time, venue, participants, budget, desc, type, docName, docUrl };
  const res = evtEditingId
    ? await api(`/api/modules/events2/${encodeURIComponent(evtEditingId)}/resubmit`, { method: "POST", body })
    : await api("/api/modules/events2", { method: "POST", body });

  if (!res.ok) { showToast(`❌ ${res.error || "Could not submit."}`, "rgba(155,22,22,.85)"); return; }
  evtEditingId = null;
  showToast("✅ Event request submitted.");
  await loadModule("events2"); renderEvents2();
}
async function evtUpdate(id) {
  const st = document.getElementById("evst-" + id).value;
  const note = document.getElementById("evnt-" + id).value.trim();
  const { ok, error } = await api(`/api/modules/events2/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: st, note } });
  if (!ok) { showToast(`❌ ${error || "Could not update."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ Updated and requester notified.");
  await loadModule("events2"); renderEvents2();
}

/* ══════════ 7. COMPLAINTS (confidential) ══════════ */
const CMP_STATUSES = ["Submitted", "Under Investigation", "Resolved", "Dismissed"];
function renderComplaint() {
  const el = document.getElementById("complaintBody");
  if (isAdmin()) {
    const rows = [...MOD.complaints].reverse().filter((c) => matchQ(cmpAdminQ, [c.name, c.sn, c.id, c.category, c.status])).map((c) => `
      <div class="glass-card" style="padding:14px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;">
          <div><span style="font-weight:800;font-size:13px;color:#1a0505;">${esc(c.id)}</span>
            <span style="font-size:11px;color:rgba(30,5,5,.55);margin-left:6px;">${esc(c.category)} · ${esc(c.ts)}</span></div>
          ${pill(c.status)}
        </div>
        <div style="font-size:10px;color:#8B1A1A;margin:4px 0;"><i class="fa-solid fa-lock" style="margin-right:4px;"></i>CONFIDENTIAL — Complainant: ${esc(c.name)} (${esc(c.sn)})</div>
        <div style="font-size:12px;color:rgba(30,5,5,.8);margin:6px 0;white-space:pre-wrap;">${esc(c.details)}</div>
        <div style="margin-bottom:8px;">${fileLink(c.attName, c.attUrl, "Attachment")}</div>
        <div style="font-size:11px;color:#8B1A1A;margin:0 0 8px;"><i class="fa-solid fa-user-shield" style="margin-right:4px;"></i>${esc(c.confidentiality || "Standard")}${c.assignedTo ? ` · Assigned: ${esc(c.assignedTo)}` : ""}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <select id="cmst-${c.id}" class="glass-input" style="max-width:210px;padding:8px;font-size:12px;">
            ${CMP_STATUSES.map((s) => `<option ${s === c.status ? "selected" : ""}>${s}</option>`).join("")}
          </select>
          <input id="cmnt-${c.id}" class="glass-input" style="flex:1;min-width:160px;padding:8px;font-size:12px;" placeholder="Resolution note (visible to student)" value="${esc(c.note || "")}">
          <input id="cmassign-${c.id}" class="glass-input" style="flex:1;min-width:130px;padding:8px;font-size:12px;" placeholder="Assigned staff" value="${esc(c.assignedTo || "")}">
          <select id="cmconf-${c.id}" class="glass-input" style="max-width:170px;padding:8px;font-size:12px;">${["Standard", "Restricted", "Strictly Confidential"].map((level) => `<option ${level === (c.confidentiality || "Standard") ? "selected" : ""}>${level}</option>`).join("")}</select>
          <input id="cmstaff-${c.id}" class="glass-input" style="flex-basis:100%;padding:8px;font-size:12px;" placeholder="Internal staff notes (never visible to student)" value="${esc(c.staffNotes || "")}">
          <button onclick="cmpUpdate('${c.id}')" class="btn-maroon" style="padding:8px 14px;font-size:12px;">Update</button>
        </div>
      </div>`).join("");
    el.innerHTML = adminSearchBox("cmpAdminQBox", "cmpAdminQ", "renderComplaint", "Search by name, student ID, or ref code…", cmpAdminQ)
      + (rows || emptyState(cmpAdminQ ? "No complaints match your search." : "No complaints filed."));
  } else {
    const mine = MOD.complaints.filter((c) => c.sn === session.id).reverse();
    el.innerHTML = `
      <div class="glass-card" style="padding:14px;margin-bottom:14px;background:rgba(139,26,26,.06);border:1px solid rgba(139,26,26,.15);">
        <div style="font-size:12px;color:#1a0505;"><i class="fa-solid fa-lock" style="color:#8B1A1A;margin-right:6px;"></i><b>Confidentiality notice:</b> Your complaint is visible only to authorized OSS personnel. Your identity will not be disclosed to other parties without your consent.</div>
      </div>
      <div class="glass-card" style="padding:18px;margin-bottom:16px;">
        <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:10px;"><i class="fa-solid fa-plus" style="color:#8B1A1A;margin-right:6px;"></i>File a Complaint</div>
        <div style="display:grid;gap:10px;">
          <div><span class="input-label">Category</span>
            <select id="cmCat" class="glass-input"><option>Facilities</option><option>Staff Conduct</option><option>Academic Concern</option><option>Harassment / Bullying</option><option>Safety &amp; Security</option><option>Others</option></select></div>
          <div><span class="input-label">Confidentiality</span><select id="cmConf" class="glass-input"><option>Standard</option><option>Restricted</option><option>Strictly Confidential</option></select></div>
          <div><span class="input-label">Details</span><textarea id="cmDet" class="glass-input" rows="4" placeholder="Describe what happened, when, and where…"></textarea></div>
          <div><span class="input-label">Supporting document (optional)</span>
            <input id="cmAtt" type="file" accept=".jpg,.jpeg,.png,.pdf,.doc,.docx" class="glass-input" style="padding:9px;"></div>
          <button onclick="cmpSubmit()" class="btn-gold" style="padding:11px;"><i class="fa-solid fa-paper-plane" style="margin-right:6px;"></i>Submit Confidentially</button>
        </div>
      </div>
      <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:8px;">My Complaints</div>
      ${mine.length ? mine.map((c) => `
        <div class="glass-card" style="padding:14px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;">
            <div style="font-size:12px;font-weight:700;color:#1a0505;">${esc(c.id)} <span style="color:rgba(30,5,5,.5);font-weight:400;">· ${esc(c.category)} · ${esc(c.ts)}</span></div>
            ${pill(c.status)}
          </div>
          ${c.note ? `<div style="font-size:11px;color:#8B1A1A;margin-top:6px;"><b>OSS resolution note:</b> ${esc(c.note)}</div>` : ""}
        </div>`).join("") : emptyState("No complaints filed.")}
    `;
  }
}
async function cmpSubmit() {
  const cat = document.getElementById("cmCat").value;
  const det = document.getElementById("cmDet").value.trim();
  if (!det) { showToast("⚠️ Please describe the complaint.", "rgba(180,130,0,.85)"); return; }
  const attInput = document.getElementById("cmAtt");
  let attName = "", attUrl = "";
  if (attInput.files.length) {
    const uploaded = await uploadFile(attInput);
    if (uploaded === false) return;
    attName = uploaded.fileName || ""; attUrl = uploaded.url || "";
  }
  const confidentiality = document.getElementById("cmConf").value;
  const { ok, error } = await api("/api/modules/complaints", { method: "POST", body: { category: cat, details: det, attName, attUrl, confidentiality } });
  if (!ok) { showToast(`❌ ${error || "Could not submit."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ Complaint filed confidentially.");
  await loadModule("complaints"); renderComplaint();
}
async function cmpUpdate(id) {
  const st = document.getElementById("cmst-" + id).value;
  const note = document.getElementById("cmnt-" + id).value.trim();
  const assignedTo = document.getElementById("cmassign-" + id).value.trim();
  const confidentiality = document.getElementById("cmconf-" + id).value;
  const staffNotes = document.getElementById("cmstaff-" + id).value.trim();
  const { ok, error } = await api(`/api/modules/complaints/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: st, note, assignedTo, confidentiality, staffNotes } });
  if (!ok) { showToast(`❌ ${error || "Could not update."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ Updated and complainant notified.");
  await loadModule("complaints"); renderComplaint();
}

/* ══════════ 8. DOWNLOADABLE FORMS ══════════ */
function renderForms() {
  const el = document.getElementById("formsBody");
  let adminForm = "";
  if (isAdmin()) {
    adminForm = `
      <div class="glass-card" style="padding:16px;margin-bottom:14px;">
        <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:10px;"><i class="fa-solid fa-upload" style="color:#8B1A1A;margin-right:6px;"></i>Upload a Form</div>
        <div style="display:grid;gap:8px;">
          <div style="display:grid;grid-template-columns:2fr 1fr;gap:8px;">
            <input id="frmTitle" class="glass-input" placeholder="Form title (e.g., Good Moral Request Form)">
            <input id="frmCat" class="glass-input" placeholder="Category (e.g., Documents)">
          </div>
          <input id="frmFile" type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" class="glass-input" style="padding:9px;">
          <button onclick="frmUpload()" class="btn-gold" style="padding:10px;">Upload Form</button>
        </div>
      </div>`;
  }
  const cats = [...new Set(MOD.forms.map((f) => f.cat))];
  el.innerHTML = adminForm + (MOD.forms.length ? cats.map((c) => `
    <div style="font-size:12px;font-weight:800;color:#8B1A1A;text-transform:uppercase;letter-spacing:.05em;margin:14px 0 6px;">${esc(c)}</div>
    ${MOD.forms.filter((f) => f.cat === c).map((f) => `
      <div class="glass-card" style="padding:12px 14px;margin-bottom:8px;display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;">
        <div>
          <div style="font-size:13px;font-weight:700;color:#1a0505;"><i class="fa-solid fa-file-lines" style="color:#8B1A1A;margin-right:6px;"></i>${esc(f.title)}</div>
          <div style="font-size:10px;color:rgba(30,5,5,.5);">${esc(f.fileName)} · uploaded ${esc(f.ts)}</div>
        </div>
        <div style="display:flex;gap:6px;">
          <a href="${f.url}" download="${esc(f.fileName)}" class="btn-maroon" style="padding:8px 14px;font-size:12px;text-decoration:none;"><i class="fa-solid fa-download" style="margin-right:5px;"></i>Download</a>
          ${isAdmin() ? `<button onclick="frmDelete('${f.id}')" class="btn-ghost" style="padding:8px 10px;font-size:12px;color:#b91c1c;">Remove</button>` : ""}
        </div>
      </div>`).join("")}`).join("") : emptyState(isAdmin() ? "No forms uploaded yet — add the first one above." : "No forms available yet. Please check back soon."));
}
async function frmUpload() {
  const t = document.getElementById("frmTitle").value.trim();
  const c = document.getElementById("frmCat").value.trim() || "General";
  const inp = document.getElementById("frmFile");
  if (!t) { showToast("⚠️ Form title is required.", "rgba(180,130,0,.85)"); return; }
  if (!inp.files.length) { showToast("⚠️ Please choose a file.", "rgba(180,130,0,.85)"); return; }
  const uploaded = await uploadFile(inp);
  if (uploaded === false || !uploaded.url) return;
  const { ok, error } = await api("/api/modules/forms", { method: "POST", body: { title: t, cat: c, fileName: uploaded.fileName, url: uploaded.url } });
  if (!ok) { showToast(`❌ ${error || "Could not upload."}`, "rgba(155,22,22,.85)"); return; }
  showToast("✅ Form uploaded.");
  await loadModule("forms"); renderForms();
}
async function frmDelete(id) {
  const f = MOD.forms.find((x) => x.id === id); if (!f) return;
  if (!confirm(`Remove "${f.title}"?`)) return;
  const { ok, error } = await api(`/api/modules/forms/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!ok) { showToast(`❌ ${error || "Could not remove."}`, "rgba(155,22,22,.85)"); return; }
  await loadModule("forms"); renderForms();
}

/* ══════════ 9. EMAIL BLAST / MEMO (admin) ══════════ */
function renderMemo() {
  const el = document.getElementById("memoBody");
  const courses = ["BSCS", "BSIT", "BSBA", "BSA", "BEED"];
  const years = ["1st Year", "2nd Year", "3rd Year", "4th Year"];
  el.innerHTML = `
    <div class="glass-card" style="padding:18px;margin-bottom:16px;">
      <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:10px;"><i class="fa-solid fa-envelopes-bulk" style="color:#8B1A1A;margin-right:6px;"></i>Compose Memo</div>
      <div style="display:grid;gap:10px;">
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px;">
          <div><span class="input-label">Subject</span><input id="memoSubj" class="glass-input" placeholder="e.g., MEMO: Enrollment Schedule for 1st Semester"></div>
          <div><span class="input-label">Recipients</span>
            <select id="memoSource" class="glass-input" onchange="memoRecipientOptions()">
              <option value="REGISTERED">Registered Students</option>
              <option value="MASTERLIST">CSV Masterlist Unregistered</option>
            </select></div>
        </div>
        <div style="padding:11px 12px;border:1px solid rgba(139,26,26,.12);background:rgba(255,255,255,.3);border-radius:12px;">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:9px;"><div><span class="input-label">Course</span><select id="memoCourse" class="glass-input"><option value="">All courses</option>${courses.map((c) => `<option value="${c}">${c}</option>`).join("")}</select></div><div><span class="input-label">Year Level</span><select id="memoYear" class="glass-input"><option value="">All year levels</option>${years.map((y) => `<option value="${y}">${y}</option>`).join("")}</select></div></div>
          <label id="memoIncludeUnregisteredLabel" style="display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700;color:#1a0505;cursor:pointer;margin-top:10px;"><input id="memoIncludeUnregistered" type="checkbox" style="accent-color:#8B1A1A;"> Include matching CSV Masterlist unregistered students</label>
          <div style="font-size:10px;color:rgba(30,5,5,.58);margin-top:6px;">Example: choose BSIT + 1st Year, then check the box to also email unregistered BSIT 1st Year students from the CSV masterlist.</div>
        </div>
        <div><span class="input-label">Message</span><textarea id="memoBodyTxt" class="glass-input" rows="5" placeholder="Write the memorandum…"></textarea></div>
        <button onclick="memoSend()" class="btn-gold" style="padding:11px;"><i class="fa-solid fa-paper-plane" style="margin-right:6px;"></i>Send Blast</button>
        <div style="font-size:10px;color:rgba(30,5,5,.55);">For CSV filtering, import a masterlist with <b>Course</b> and <b>Year Level</b> columns. ${EMAIL_CONFIGURED ? '<b style="color:#15803d;">LIVE mode</b> — real emails will be sent.' : '<b style="color:#a16207;">SIMULATED mode</b> — logged to the outbox only (set SMTP_* in .env to send for real).'}</div>
      </div>
    </div>
    <div style="font-size:13px;font-weight:800;color:#1a0505;margin-bottom:8px;">Blast History</div>
    ${MOD.memos.length ? [...MOD.memos].reverse().map((m) => `
      <div class="glass-card" style="padding:12px 14px;margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;">
          <div style="font-size:12px;font-weight:700;color:#1a0505;">${esc(m.subject)}</div>
          ${pill(m.mode)}
        </div>
        <div style="font-size:10px;color:rgba(30,5,5,.55);margin-top:3px;">${esc(m.audienceLabel)} · ${m.recipients} recipient(s) · ${esc(m.ts)} · by ${esc(m.by)}</div>
      </div>`).join("") : emptyState("No memos sent yet.")}
  `;
}
async function memoSend() {
  const subj = document.getElementById("memoSubj").value.trim();
  const body = document.getElementById("memoBodyTxt").value.trim();
  const source = document.getElementById("memoSource").value;
  const includeUnregistered = document.getElementById("memoIncludeUnregistered").checked;
  const course = document.getElementById("memoCourse").value;
  const year = document.getElementById("memoYear").value;
  const sourceLabel = document.getElementById("memoSource").selectedOptions[0].textContent;
  const filterLabel = [course, year].filter(Boolean).join(" · ") || "All courses and year levels";
  const audLabel = source === "REGISTERED" && includeUnregistered ? `${sourceLabel} + CSV Masterlist Unregistered (${filterLabel})` : `${sourceLabel} (${filterLabel})`;
  if (!subj || !body) { showToast("⚠️ Subject and message are required.", "rgba(180,130,0,.85)"); return; }
  const { ok, error } = await api("/api/modules/memos", { method: "POST", body: { subject: subj, body, recipientSource: source, includeUnregistered, course, year, audienceLabel: audLabel } });
  if (!ok) { showToast(`❌ ${error || "Could not send memo."}`, "rgba(155,22,22,.85)"); return; }
  showToast(`📧 Memo ${EMAIL_CONFIGURED ? "sent" : "simulated"}.`);
  await loadModule("memos"); renderMemo();
}
function memoRecipientOptions() {
  const source = document.getElementById("memoSource")?.value;
  const check = document.getElementById("memoIncludeUnregistered");
  const label = document.getElementById("memoIncludeUnregisteredLabel");
  if (!check || !label) return;
  const isMasterlistOnly = source === "MASTERLIST";
  if (isMasterlistOnly) check.checked = false;
  check.disabled = isMasterlistOnly;
  label.style.opacity = isMasterlistOnly ? ".55" : "1";
  label.title = isMasterlistOnly ? "CSV Masterlist Unregistered is already selected." : "";
}

/* ══════════ v3.1 — CLAIM REFS, RECEIPTS, VERIFY ══════════ */
function printReceipt(reqId) {
  const req = DB.find((r) => r.id === reqId);
  if (!req) return;
  if (!req.claimRef) { showToast("⚠️ No claim record yet — transaction must be Completed first.", "rgba(180,130,0,.85)"); return; }
  const html = `<!DOCTYPE html><html><head><title>Claim Receipt — ${esc(req.claimRef)}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box;font-family:'Segoe UI',Arial,sans-serif;}
    body{padding:28px;color:#1a0505;}
    .rc{max-width:420px;margin:0 auto;border:2px solid #8B1A1A;border-radius:10px;overflow:hidden;}
    .hd{background:#8B1A1A;color:#fff;text-align:center;padding:16px 12px;}
    .hd h1{font-size:15px;letter-spacing:.08em;} .hd p{font-size:10px;opacity:.85;margin-top:2px;}
    .ttl{text-align:center;padding:12px;border-bottom:1px dashed #c9a227;}
    .ttl b{font-size:13px;letter-spacing:.14em;color:#8B1A1A;}
    .clm{text-align:center;padding:14px 12px;background:#fdf6e3;border-bottom:1px dashed #c9a227;}
    .clm .ref{font-family:'Courier New',monospace;font-size:21px;font-weight:900;letter-spacing:.06em;color:#1e40af;}
    .clm .lbl{font-size:9px;text-transform:uppercase;letter-spacing:.12em;color:#7a4f00;margin-bottom:3px;}
    table{width:100%;border-collapse:collapse;font-size:12px;}
    td{padding:7px 14px;vertical-align:top;} td:first-child{color:#666;width:38%;font-size:11px;} td:last-child{font-weight:700;}
    .mono{font-family:'Courier New',monospace;}
    .sig{display:flex;gap:20px;padding:26px 14px 14px;}
    .sig div{flex:1;text-align:center;font-size:10px;color:#555;}
    .sig div span{display:block;border-top:1px solid #999;margin-top:26px;padding-top:4px;}
    .ft{text-align:center;font-size:9px;color:#888;padding:10px;border-top:1px dashed #c9a227;}
    @media print{ body{padding:0;} .noprint{display:none;} }
  </style></head><body>
  <div class="rc">
    <div class="hd"><h1>POLYTECHNIC UNIVERSITY OF THE PHILIPPINES</h1><p>San Pedro Campus · Student Services Office · QR-SASMS</p></div>
    <div class="ttl"><b>DOCUMENT CLAIM RECEIPT</b></div>
    <div class="clm"><div class="lbl">Claiming Reference No.</div><div class="ref">${esc(req.claimRef)}</div></div>
    <table>
      <tr><td>Request Ref No.</td><td class="mono">${esc(req.id)}</td></tr>
      <tr><td>Student Name</td><td>${esc(req.studentName)}</td></tr>
      <tr><td>Student Number</td><td class="mono">${esc(req.studentId)}</td></tr>
      <tr><td>Document</td><td>${esc(req.doc)}</td></tr>
      <tr><td>Copies</td><td>${esc(req.copies)}</td></tr>
      <tr><td>Purpose</td><td>${esc(req.purpose)}</td></tr>
      <tr><td>Date Requested</td><td>${esc(req.date)}</td></tr>
      <tr><td>Date &amp; Time Claimed</td><td>${esc(req.claimedAt)}</td></tr>
      <tr><td>Released By</td><td>${esc(req.claimedBy)}</td></tr>
      <tr><td>Status</td><td>COMPLETED — TRANSACTION CLOSED</td></tr>
    </table>
    <div class="sig">
      <div><span>Released by (SSO)</span></div>
      <div><span>Received by (Student)</span></div>
    </div>
    <div class="ft"><b>Digitally issued by QR-SASMS · PUP San Pedro Student Services Office</b><br>System-generated receipt · Verify anytime at the SSO using the claiming reference above.<br>Printed: ${esc(fnow())} · QR-SASMS v${APP_VERSION}</div>
  </div>
  <div class="noprint" style="text-align:center;margin-top:16px;">
    <button onclick="window.print()" style="background:#8B1A1A;color:#fff;border:none;padding:10px 22px;border-radius:8px;font-weight:800;cursor:pointer;">Print</button>
    <button onclick="window.close()" style="background:#eee;border:1px solid #ccc;padding:10px 18px;border-radius:8px;font-weight:700;cursor:pointer;margin-left:6px;">Close</button>
  </div>
  <script>setTimeout(function(){ try{window.print();}catch(e){} }, 400);<\/script>
  </body></html>`;
  const w = window.open("", "_blank", "width=520,height=720");
  if (!w) { showToast("⚠️ Pop-up blocked — please allow pop-ups to print the receipt.", "rgba(180,130,0,.85)"); return; }
  w.document.write(html);
  w.document.close();
}

function printApproval(reqId) {
  const req = DB.find((r) => r.id === reqId);
  if (!req || !["Approved", "Ready to Claim", "Completed"].includes(req.status)) return showToast("⚠️ This request has not been approved yet.", "rgba(180,130,0,.85)");
  const html = `<!DOCTYPE html><html><head><title>Approval Certificate — ${esc(req.id)}</title><style>*{box-sizing:border-box;font-family:Segoe UI,Arial,sans-serif}body{padding:32px;color:#1a0505}.card{max-width:650px;margin:auto;border:2px solid #8B1A1A;padding:32px;text-align:center}.seal{color:#8B1A1A;font-weight:900;letter-spacing:.08em}.title{font-size:25px;font-weight:900;margin:30px 0 12px}.body{font-size:15px;line-height:1.75;text-align:left}.ref{font-family:monospace;color:#1e40af;font-weight:900}.signature{margin-top:42px;border-top:1px solid #555;padding-top:6px;width:240px;margin-left:auto;text-align:center;font-size:12px}.foot{margin-top:30px;font-size:10px;color:#666}@media print{body{padding:0}.noprint{display:none}}</style></head><body><div class="card"><div class="seal">POLYTECHNIC UNIVERSITY OF THE PHILIPPINES<br><small>San Pedro Campus · Student Services Office</small></div><div class="title">DOCUMENT APPROVAL CERTIFICATE</div><div class="body">This certifies that the document request <span class="ref">${esc(req.id)}</span> submitted by <b>${esc(req.studentName)}</b> (${esc(req.studentId)}) for <b>${esc(req.doc)}</b> has been approved by the Student Services Office.<br><br><b>Purpose:</b> ${esc(req.purpose)}<br><b>Copies:</b> ${esc(req.copies)}<br><b>Current status:</b> ${esc(req.status)}<br><b>Date submitted:</b> ${esc(req.date)}</div><div class="signature">Server-signed by QR-SASMS<br>Student Services Office</div><div class="foot">Verification reference: ${esc(req.id)}<br>Integrity signature: ${esc(req.signature || "Issued before signing was enabled")}<br>Generated ${esc(fnow())}.</div></div><div class="noprint" style="text-align:center;margin-top:16px"><button onclick="window.print()">Print / Save as PDF</button></div><script>setTimeout(()=>window.print(),400);<\/script></body></html>`;
  const w = window.open("", "_blank", "width=760,height=780");
  if (!w) return showToast("⚠️ Please allow pop-ups to print the certificate.", "rgba(180,130,0,.85)");
  w.document.write(html); w.document.close();
}

/** Verify a REQ or CLM reference (admin/scanner side) — real backend lookup. */
async function verifyRef() {
  const q = (document.getElementById("verifyRefInput").value || "").trim();
  const box = document.getElementById("verifyRefResult");
  if (!q) { box.innerHTML = ""; return; }

  const { ok, data } = await api(`/api/requests/verify?ref=${encodeURIComponent(q)}`);
  if (!ok || !data || !data.found) {
    box.innerHTML = `<div class="glass-card" style="padding:16px;border:1px solid rgba(220,38,38,.4);">
      <div style="font-size:13px;font-weight:800;color:#991b1b;"><i class="fa-solid fa-circle-xmark" style="margin-right:6px;"></i>NOT FOUND</div>
      <div style="font-size:12px;color:rgba(30,5,5,.7);margin-top:4px;">No record matches "<span style="font-family:monospace;">${esc(q.toUpperCase())}</span>". The reference may be mistyped or the document was not issued by this office.</div>
    </div>`;
    showToast("❌ Reference not found.", "rgba(155,22,22,.85)");
    return;
  }

  const req = data.request;
  const bc = badgeClass(req.status);
  const claimBlock = req.claimRef ? `
      <div class="detail-row"><span class="detail-label">Claiming Ref.</span><span class="detail-value" style="font-family:monospace;font-weight:800;color:#1e40af;">${req.claimRef}</span></div>
      <div class="detail-row"><span class="detail-label">Claimed On</span><span class="detail-value">${req.claimedAt}</span></div>
      <div class="detail-row"><span class="detail-label">Released By</span><span class="detail-value">${req.claimedBy}</span></div>` : "";
  const action = req.status === "Ready to Claim"
    ? `<button onclick="adminAction('${req.id}','Completed').then(verifyRef)" class="btn-maroon" style="width:100%;margin-top:12px;padding:11px;font-size:13px;"><i class="fa-solid fa-flag-checkered" style="margin-right:6px;"></i>Mark as Claimed — Complete Transaction</button>`
    : (req.status === "Completed"
      ? `<button onclick="printReceipt('${req.id}')" class="btn-maroon" style="width:100%;margin-top:12px;padding:11px;font-size:13px;"><i class="fa-solid fa-print" style="margin-right:6px;"></i>Print Claim Receipt</button>`
      : "");
  box.innerHTML = `<div class="glass-card" style="padding:16px;border:1px solid rgba(34,197,94,.4);">
    <div style="font-size:13px;font-weight:800;color:#166534;margin-bottom:10px;"><i class="fa-solid fa-circle-check" style="margin-right:6px;"></i>RECORD VERIFIED — AUTHENTIC</div>
    <div class="detail-row"><span class="detail-label">Request Ref.</span><span class="detail-value" style="font-family:monospace;">${req.id}</span></div>
    <div class="detail-row"><span class="detail-label">Student</span><span class="detail-value">${req.studentName}</span></div>
    <div class="detail-row"><span class="detail-label">Student No.</span><span class="detail-value" style="font-family:monospace;font-size:12px;">${req.studentId}</span></div>
    <div class="detail-row"><span class="detail-label">Document</span><span class="detail-value">${req.doc}</span></div>
    <div class="detail-row"><span class="detail-label">Purpose</span><span class="detail-value">${req.purpose}</span></div>
    <div class="detail-row"><span class="detail-label">Copies</span><span class="detail-value">${req.copies}</span></div>
    <div class="detail-row"><span class="detail-label">Date Requested</span><span class="detail-value">${req.date}</span></div>
    <div class="detail-row"><span class="detail-label">Status</span><span class="detail-value"><span class="badge ${bc}">${req.status}</span></span></div>
    ${claimBlock}
    <div style="margin-top:10px;font-size:11px;font-weight:700;color:#166534;background:rgba(22,163,74,.08);border:1px solid rgba(22,163,74,.25);border-radius:9px;padding:8px 10px;"><i class="fa-solid fa-file-circle-check" style="margin-right:5px;"></i>Matches the student's request receipt on file — details above are exactly as submitted.</div>
    ${action}
  </div>`;
  showToast("✅ Record verified.", "rgba(21,128,61,.85)");
}

/* ══════════ v3.2 — NOTIFICATION BELL ══════════ */
function myNotifs() { return NOTIFS; } // server already scopes this to the caller
function updateBellBadge() {
  const b = document.getElementById("bellBadge");
  if (!b) return;
  const unread = myNotifs().filter((n) => !n.read).length;
  if (unread > 0) { b.textContent = unread > 9 ? "9+" : unread; b.style.display = "flex"; }
  else b.style.display = "none";
}
function playNotificationSound() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const context = new AudioCtx();
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.045, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.32);
    gain.connect(context.destination);
    [660, 880].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, context.currentTime + index * 0.1);
      oscillator.connect(gain);
      oscillator.start(context.currentTime + index * 0.1);
      oscillator.stop(context.currentTime + 0.32);
    });
  } catch (_) { /* Browser audio is optional. */ }
}
function startNotificationPolling() {
  if (notificationPollingStarted) return;
  notificationPollingStarted = true;
  window.setInterval(async () => {
    if (!session) return;
    await loadNotifs();
    const newItems = NOTIFS.filter((n) => !knownNotificationIds.has(n.id));
    if (newItems.length) playNotificationSound();
    NOTIFS.forEach((n) => knownNotificationIds.add(n.id));
    updateBellBadge();
  }, 15000);
}
function notificationDestination(notification) {
  const text = `${notification.title} ${notification.body}`.toLowerCase();
  if (text.includes("complaint")) return "page-complaint";
  if (text.includes("appointment")) return isAdmin() ? "page-admin" : "page-appointment";
  if (text.includes("document request") || text.includes("claim")) return isAdmin() ? "page-admin" : "page-student";
  if (text.includes("account approval") || text.includes("new student account")) return "page-admin";
  if (text.includes("id application")) return "page-idapp";
  if (text.includes("ticket") || text.includes("help desk")) return "page-helpdesk";
  if (text.includes("announcement") || text.includes("bulletin")) return "page-bulletin";
  return isAdmin() ? "page-admin" : "page-student";
}
async function openNotification(id) {
  const notification = NOTIFS.find((n) => n.id === id);
  if (!notification) return;
  notification.read = true;
  updateBellBadge();
  await api(`/api/notifications/${encodeURIComponent(id)}/read`, { method: "POST" });
  const panel = document.getElementById("bellPanel"); if (panel) panel.style.display = "none";
  await goTo(notificationDestination(notification));
}
async function toggleBell() {
  const p = document.getElementById("bellPanel");
  if (!p) return;
  if (p.style.display === "block") { p.style.display = "none"; return; }
  await loadNotifs();
  const mine = [...myNotifs()].reverse();
  p.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid rgba(139,26,26,.12);">
      <span style="font-size:13px;font-weight:800;color:#1a0505;"><i class="fa-solid fa-bell" style="color:#8B1A1A;margin-right:6px;"></i>Notifications</span>
      <button onclick="clearMyNotifs()" class="btn-ghost" style="padding:4px 9px;font-size:10px;">Clear all</button>
    </div>
    <div style="max-height:320px;overflow-y:auto;">
      ${mine.length ? mine.map((n) => `
        <button data-notification-id="${n.id}" onclick="openNotification('${n.id}')" style="width:100%;text-align:left;border:0;background:${n.read ? "transparent" : "rgba(245,197,24,.08)"};padding:10px 14px;border-bottom:1px solid rgba(139,26,26,.06);cursor:pointer;font-family:inherit;transition:opacity .5s ease;${n.read ? "opacity:.52;" : ""}">
          <div style="font-size:12px;font-weight:800;color:#1a0505;">${n.read ? "" : '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#8B1A1A;margin-right:5px;"></span>'}${esc(n.title)}</div>
          <div style="font-size:11px;color:rgba(30,5,5,.75);margin-top:2px;">${esc(n.body)}</div>
          <div style="font-size:9px;color:rgba(30,5,5,.45);margin-top:3px;">${esc(n.ts)}</div>
        </button>`).join("")
      : '<div style="padding:22px;text-align:center;font-size:12px;color:rgba(30,5,5,.5);">No notifications yet.</div>'}
    </div>`;
  p.style.display = "block";
  // Notifications that are not acted on stay unread but soften after 7 seconds.
  window.setTimeout(() => p.querySelectorAll("button[data-notification-id]").forEach((item) => {
    if (!NOTIFS.find((n) => n.id === item.dataset.notificationId)?.read) item.style.opacity = ".62";
  }), 7000);
}
async function clearMyNotifs() {
  if (!session) return;
  await api("/api/notifications", { method: "DELETE" });
  NOTIFS = [];
  updateBellBadge();
  const p = document.getElementById("bellPanel"); if (p) p.style.display = "none";
}

/* ══════════ v3.2 — STUDENT ACCOUNT APPROVALS (admin) ══════════ */
function renderAcctApprovals() {
  const wrap = document.getElementById("acctApprovalsWrap");
  if (!wrap) return;
  const pending = PENDING_ACCOUNTS;
  if (!pending.length) { wrap.innerHTML = ""; return; }
  wrap.innerHTML = `
    <div class="glass-card" style="overflow:hidden;border:1px solid rgba(245,197,24,.45);">
      <div style="padding:16px 20px;border-bottom:1px solid rgba(139,26,26,.1);display:flex;align-items:center;gap:8px;">
        <span style="font-size:15px;font-weight:800;color:#1a0505;"><i class="fa-solid fa-user-clock" style="color:#C8890F;margin-right:8px;"></i>Account Approvals</span>
        <span style="font-size:10px;font-weight:800;background:rgba(245,197,24,.2);border:1px solid rgba(212,160,23,.5);color:#7a4f00;border-radius:99px;padding:3px 9px;">${pending.length} pending</span>
      </div>
      <div style="padding:8px 20px 14px;">
        ${pending.map((u) => `
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid rgba(139,26,26,.06);">
            <div>
              <div style="font-size:13px;font-weight:800;color:#1a0505;">${esc(u.name)}</div>
              <div style="font-size:11px;font-family:monospace;color:rgba(30,5,5,.6);">${esc(u.id)} · ${esc(u.email)} · ${esc(u.course || "")} ${esc(u.year || "")}</div>
            </div>
            <div style="display:flex;gap:6px;">
              <button onclick="acctApprove('${esc(u.id)}')" style="background:rgba(34,197,94,.2);border:1px solid rgba(34,197,94,.4);color:#15803d;font-weight:800;padding:7px 14px;border-radius:9px;font-size:12px;cursor:pointer;font-family:inherit;"><i class="fa-solid fa-check" style="margin-right:4px;"></i>Approve</button>
              <button onclick="acctReject('${esc(u.id)}')" style="background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.35);color:#b91c1c;font-weight:800;padding:7px 14px;border-radius:9px;font-size:12px;cursor:pointer;font-family:inherit;"><i class="fa-solid fa-xmark" style="margin-right:4px;"></i>Reject</button>
            </div>
          </div>`).join("")}
      </div>
    </div>`;
}
async function acctApprove(sn) {
  const { ok, error } = await api(`/api/users/${encodeURIComponent(sn)}/approve`, { method: "PATCH", body: { approve: true } });
  if (!ok) { showToast(`❌ ${error || "Could not approve."}`, "rgba(155,22,22,.85)"); return; }
  showToast(`✅ Account approved.`);
  await loadPendingAccounts(); await loadAuditLog();
  renderAcctApprovals(); renderAuditLog();
}
async function acctReject(sn) {
  if (!confirm(`Reject and remove the account of ${sn}?`)) return;
  const { ok, error } = await api(`/api/users/${encodeURIComponent(sn)}/approve`, { method: "PATCH", body: { approve: false } });
  if (!ok) { showToast(`❌ ${error || "Could not reject."}`, "rgba(155,22,22,.85)"); return; }
  showToast(`Account rejected and removed.`);
  await loadPendingAccounts(); await loadAuditLog();
  renderAcctApprovals(); renderAuditLog();
}

/* ══════════ v3.2 — email outbox ══════════ */
function renderEmailOutbox() {
  const badge = document.getElementById("emailModeBadge");
  if (badge) {
    badge.innerHTML = EMAIL_CONFIGURED
      ? '<span style="color:#16a34a;">● LIVE — real emails</span>'
      : '<span style="color:#d97706;">● SIMULATED — set SMTP_* in .env to send for real</span>';
  }
  const el = document.getElementById("emailOutbox");
  if (!el) return;
  if (!EMAIL_LOG.length) {
    el.innerHTML = '<div style="color:rgba(30,5,5,.5);padding:6px 0;">No notifications yet. Approving or rejecting a request will email the student automatically.</div>';
    return;
  }
  const tag = (m) => ({
    SENT: '<span style="color:#16a34a;font-weight:800;">SENT</span>',
    SIMULATED: '<span style="color:#d97706;font-weight:800;">SIMULATED</span>',
    FAILED: '<span style="color:#dc2626;font-weight:800;">FAILED</span>',
    NO_EMAIL: '<span style="color:#dc2626;font-weight:800;">NO EMAIL</span>',
  }[m] || m);
  el.innerHTML = [...EMAIL_LOG].reverse().map((e) => `
    <div style="padding:8px 10px;margin-bottom:6px;background:rgba(255,255,255,.55);border:1px solid rgba(139,26,26,.1);border-radius:10px;">
      <div style="display:flex;justify-content:space-between;gap:8px;">
        <span style="font-weight:700;color:#1a0505;">${e.name} · ${e.status}</span><span>${tag(e.mode)}</span>
      </div>
      <div style="font-size:11px;color:rgba(30,5,5,.6);margin-top:2px;">${e.to ? "✉ " + e.to : "⚠ no email on file"} · ${e.ref} · ${e.doc}</div>
      <div style="font-size:10px;color:rgba(30,5,5,.45);font-family:monospace;margin-top:2px;">${e.ts}${e.error ? " · " + e.error : ""}</div>
    </div>`).join("");
}

/* ══════════ v3.2.1 — REASON FOR REJECTION ══════════ */
let rejectTargetId = null;
function openRejectModal(reqId) {
  const req = DB.find((r) => r.id === reqId);
  if (!req) return;
  const rejectModal = document.getElementById("rejectModal");
  if (rejectModal && rejectModal.parentElement !== document.body) document.body.appendChild(rejectModal);
  rejectTargetId = reqId;
  document.getElementById("rejectModalMeta").innerHTML = `<b>${esc(req.studentName)}</b> · ${esc(req.doc)} · <span style="font-family:monospace;">${esc(req.id)}</span>`;
  document.getElementById("rejectReasonInput").value = "";
  document.getElementById("rejectReasonErr").style.display = "none";
  rejectModal.classList.add("open");
  setTimeout(() => { const t = document.getElementById("rejectReasonInput"); if (t) t.focus(); }, 80);
}
function closeRejectModal() { rejectTargetId = null; document.getElementById("rejectModal").classList.remove("open"); }
function confirmReject() {
  const reason = document.getElementById("rejectReasonInput").value.trim();
  if (!reason) { document.getElementById("rejectReasonErr").style.display = "block"; return; }
  const id = rejectTargetId;
  closeRejectModal();
  if (id) adminAction(id, "Rejected", reason);
}

/* ---------- version badge ---------- */
function mountVersionBadge() {
  const vb = document.createElement("div");
  vb.style.cssText = "position:fixed;bottom:8px;right:12px;font-size:10px;font-weight:800;color:rgba(30,5,5,.45);z-index:60;pointer-events:none;letter-spacing:.04em;";
  vb.textContent = "QR-SASMS v" + APP_VERSION;
  document.body.appendChild(vb);
}

/* ──────────────────────────────────────────
   INIT
──────────────────────────────────────────── */
(async function init() {
  mountVersionBadge();
  await refreshMasterlistStatus();
  try {
    await restoreSession(); // silently signs the user back in if their cookie is still valid
  } finally {
    const overlay = document.getElementById("authLoadingOverlay");
    if (overlay) overlay.style.display = "none";
  }

window.doForgotPassword = function doForgotPassword() {
  window.location.assign("/forgot-password");
}

})();

/* Themed controls for recently added management features. */
async function openReports() {
  const result = await api("/api/reports/analytics");
  if (!result.ok) return showToast("Could not load analytics.", "rgba(155,22,22,.85)");
  const a = result.data;
  const group = (title, items) => `<div class="app-field"><label>${esc(title)}</label><div class="app-list">${(items || []).length ? items.map((x) => `<div class="app-row"><span class="app-row-title">${esc(x.label)}</span><b style="color:#8B1A1A">${esc(x.count)}</b></div>`).join("") : `<div class="app-row"><span class="app-row-meta">No data yet.</span></div>`}</div></div>`;
  openAppModal({ title: "Reports & Analytics", subtitle: "View service trends or export an official CSV report.", icon: "fa-chart-column", wide: true, content: `<div class="app-modal-grid">${group("Students by course", a.byCourse)}${group("Students by year level", a.byYear)}${group("Most requested services", a.services)}${group("Peak appointment times", a.peakTimes)}</div><div class="app-modal-actions"><button class="btn-soft" onclick="window.open('/api/reports/export?type=requests','_blank')">Requests CSV</button><button class="btn-soft" onclick="window.open('/api/reports/export?type=appointments','_blank')">Appointments CSV</button><button class="btn-soft" onclick="window.open('/api/reports/export?type=complaints','_blank')">Complaints CSV</button><button class="btn-maroon" onclick="printAnalyticsReport(window.__qrsAnalytics);">Print / Save PDF</button></div>` });
  window.__qrsAnalytics = a;
}

async function viewFaqAnalytics() {
  const result = await api("/api/faq-analytics");
  if (!result.ok) return showToast("Could not load FAQ analytics.", "rgba(155,22,22,.85)");
  const items = result.data.matches || [];
  openAppModal({ title: "FAQ Chatbot Usage", subtitle: "Questions recorded from the Student Service Help chatbot.", icon: "fa-chart-simple", content: `<div class="app-metric"><span class="app-row-meta">Total chatbot queries</span><b>${esc(result.data.totalQueries)}</b></div><div class="app-list" style="margin-top:16px;">${items.length ? items.map((x) => `<div class="app-row"><div><div class="app-row-title">${esc(x.question)}</div><div class="app-row-meta">Matched or unmatched FAQ query</div></div><b style="color:#8B1A1A">${esc(x.count)}</b></div>`).join("") : `<div class="app-row"><span class="app-row-meta">No chatbot questions recorded yet.</span></div>`}</div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Close</button></div>` });
}

async function manageSystemSettings() {
  const result = await api("/api/settings");
  if (!result.ok) return showToast("Could not load settings.", "rgba(155,22,22,.85)");
  const s = result.data;
  openAppModal({ title: "System Settings", subtitle: "Control appointment availability and outgoing email content.", icon: "fa-sliders", wide: true, content: `<div class="app-modal-grid">${modalField("Business hours (comma-separated)", "setHours", (s.businessHours || []).join(", "), "full")}${modalField("Capacity per appointment slot", "setCapacity", s.appointmentCapacity)}${modalField("Cancellation / reschedule cutoff (hours)", "setCutoff", s.cancellationCutoffHours)}${modalField("Closed dates / holidays", "setHolidays", (s.holidays || []).join(", "), "full")}<div class="app-field full"><label for="setEmailTemplate">Email template</label><textarea id="setEmailTemplate" class="glass-input">${esc(s.emailTemplate || "{{message}}\n\n— QR-SASMS")}</textarea><span class="app-row-meta">Available placeholders: {{name}}, {{title}}, {{message}}</span></div></div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Cancel</button><button class="btn-maroon" onclick="saveSystemSettings()"><i class="fa-solid fa-floppy-disk"></i> Save settings</button></div>` });
}
async function saveSystemSettings() {
  const hours = document.getElementById("setHours")?.value.split(",").map((x) => x.trim()).filter(Boolean) || [];
  const result = await api("/api/settings", { method: "PUT", body: { businessHours: hours, appointmentCapacity: Number(document.getElementById("setCapacity")?.value), cancellationCutoffHours: Number(document.getElementById("setCutoff")?.value), holidays: (document.getElementById("setHolidays")?.value || "").split(",").map((x) => x.trim()).filter(Boolean), emailTemplate: document.getElementById("setEmailTemplate")?.value || "" } });
  if (result.ok) closeAppModal();
  showToast(result.ok ? "System settings saved." : (result.error || "Could not save settings."), result.ok ? undefined : "rgba(155,22,22,.85)");
}

async function manageStaffAccounts() {
  const result = await api("/api/users/staff");
  if (!result.ok) return showToast("Could not load staff accounts.", "rgba(155,22,22,.85)");
  window.__qrsStaff = result.data;
  const list = result.data;
  openAppModal({ title: "Staff Accounts", subtitle: "Super Admin controls for Admin and Scanner accounts.", icon: "fa-user-shield", wide: true, content: `<div class="app-list">${list.length ? list.map((u) => `<div class="app-row"><div><div class="app-row-title">${esc(u.name)} ${pill(u.role)}</div><div class="app-row-meta">${esc(u.email)} · ${u.active ? "Active" : "Deactivated"}</div></div><button class="btn-soft" onclick="openStaffEditor('${esc(u.id)}')">Edit</button></div>`).join("") : `<div class="app-row"><span class="app-row-meta">No staff accounts yet.</span></div>`}</div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Close</button><button class="btn-maroon" onclick="openStaffEditor()"><i class="fa-solid fa-user-plus"></i> Add staff account</button></div>` });
}
function openStaffEditor(id) {
  const u = id ? (window.__qrsStaff || []).find((x) => x.id === id) : null;
  openAppModal({ title: u ? "Edit Staff Account" : "Create Staff Account", subtitle: u ? "Update access role or deactivate this account." : "Create an Admin or Scanner account with a temporary password.", icon: "fa-user-gear", content: `<div class="app-modal-grid">${modalField("Full name", "staffName", u?.name || "")}${modalField("Email", "staffEmail", u?.email || "")}<div class="app-field"><label for="staffRole">Role</label><select id="staffRole" class="glass-input"><option value="ADMIN" ${u?.role === "ADMIN" ? "selected" : ""}>Admin</option><option value="SCANNER" ${u?.role === "SCANNER" ? "selected" : ""}>Scanner</option></select></div>${u ? `<div class="app-field"><label for="staffActive">Account status</label><select id="staffActive" class="glass-input"><option value="true" ${u.active ? "selected" : ""}>Active</option><option value="false" ${!u.active ? "selected" : ""}>Deactivated</option></select></div>` : `<div class="app-field"><label for="staffPassword">Temporary password</label><input id="staffPassword" class="glass-input" type="password" placeholder="At least 10 characters"></div>`}</div><div class="app-modal-actions"><button class="btn-soft" onclick="manageStaffAccounts()">Back</button><button class="btn-maroon" onclick="saveStaffAccount('${u?.id || ""}')">${u ? "Save changes" : "Create account"}</button></div>` });
}
async function saveStaffAccount(id) {
  const name = document.getElementById("staffName")?.value.trim(), email = document.getElementById("staffEmail")?.value.trim(), role = document.getElementById("staffRole")?.value;
  const result = id ? await api(`/api/users/staff/${encodeURIComponent(id)}`, { method: "PATCH", body: { name, role, active: document.getElementById("staffActive")?.value === "true" } }) : await api("/api/users/staff", { method: "POST", body: { name, email, role, password: document.getElementById("staffPassword")?.value } });
  if (result.ok) return manageStaffAccounts();
  showToast(result.error || "Could not save staff account.", "rgba(155,22,22,.85)");
}

async function giveFeedback(requestId) {
  openAppModal({ title: "Service Feedback", subtitle: "Your feedback helps Student Services improve completed services.", icon: "fa-star", content: `<div class="app-modal-grid"><div class="app-field"><label for="feedbackRating">Rating</label><select id="feedbackRating" class="glass-input"><option value="5">5 — Excellent</option><option value="4">4 — Very good</option><option value="3">3 — Good</option><option value="2">2 — Needs improvement</option><option value="1">1 — Poor</option></select></div><div class="app-field full"><label for="feedbackComment">Optional comment</label><textarea id="feedbackComment" class="glass-input" placeholder="Tell us about your experience..."></textarea></div></div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Cancel</button><button class="btn-gold" onclick="submitFeedback('${esc(requestId)}')"><i class="fa-solid fa-star"></i> Submit feedback</button></div>` });
}
async function submitFeedback(requestId) {
  const result = await api("/api/feedback", { method: "POST", body: { requestId, rating: Number(document.getElementById("feedbackRating")?.value), comment: document.getElementById("feedbackComment")?.value.trim() || "" } });
  if (result.ok) closeAppModal();
  showToast(result.ok ? "Thank you for your feedback." : (result.error || "Could not submit feedback."), result.ok ? undefined : "rgba(155,22,22,.85)");
}


async function cancelAppointment(code) {
  openAppModal({ title: "Cancel Appointment", subtitle: `Cancel appointment ${code}? This action follows the cancellation cutoff in System Settings.`, icon: "fa-calendar-xmark", content: `<div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Keep appointment</button><button class="btn-maroon" onclick="confirmCancelAppointment('${esc(code)}')">Cancel appointment</button></div>` });
}
async function confirmCancelAppointment(code) {
  const result = await api(`/api/queue/${encodeURIComponent(code)}/cancel`, { method: "DELETE" });
  if (result.ok) { closeAppModal(); await renderStudentAppointment(); }
  showToast(result.ok ? "Appointment cancelled." : (result.error || "Could not cancel appointment."), result.ok ? undefined : "rgba(155,22,22,.85)");
}
async function rescheduleAppointment(code) {
  rescheduleCode = code; rescheduleSelectedDate = null; rescheduleSelectedSlot = null;
  rescheduleCalMonth = new Date().getMonth(); rescheduleCalYear = new Date().getFullYear();
  rescheduleAvailability = { bookedTimes: [], myAppointment: null };
  openAppModal({ title: "Reschedule Appointment", subtitle: "Choose a new date and available business-hours time slot.", icon: "fa-calendar-days", wide: true, content: `<div class="app-modal-grid"><div class="app-field full"><label>New date</label><div style="background:rgba(139,26,26,.05);border-radius:14px;padding:16px;margin-top:6px;"><div id="rescheduleCalendar"></div></div></div><div class="app-field full"><label>New time</label><div id="rescheduleDateLabel" style="font-size:11px;color:rgba(30,5,5,.62);margin:6px 0 10px;">Select a date first.</div><div id="rescheduleTimeSlots" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;"></div></div></div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Cancel</button><button class="btn-maroon" onclick="confirmRescheduleAppointment()">Save new schedule</button></div>` });
  buildRescheduleCalendar();
}
async function confirmRescheduleAppointment() {
  if (!rescheduleSelectedDate || !rescheduleSelectedSlot) return showToast("Select both a new date and time.", "rgba(180,130,0,.85)");
  const dateLabel = rescheduleDateLabel(rescheduleSelectedDate);
  const result = await api(`/api/queue/${encodeURIComponent(rescheduleCode)}/reschedule`, { method: "POST", body: { dateLabel, time: rescheduleSelectedSlot } });
  if (result.ok) { closeAppModal(); await renderStudentAppointment(); }
  showToast(result.ok ? "Appointment rescheduled." : (result.error || "Could not reschedule appointment."), result.ok ? undefined : "rgba(155,22,22,.85)");
}

function restoreBackup() {
  openAppModal({ title: "Restore Configuration", subtitle: "Restore a previously downloaded JSON backup. Accounts, requests, and appointments will not be changed.", icon: "fa-clock-rotate-left", content: `<div class="app-row"><div><div class="app-row-title">What will be restored</div><div class="app-row-meta">CSV masterlist, System Settings, and FAQs.</div></div></div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Cancel</button><button class="btn-maroon" onclick="pickBackupFile()"><i class="fa-solid fa-file-arrow-up"></i> Choose backup file</button></div>` });
}
function pickBackupFile() {
  const picker = document.createElement("input"); picker.type = "file"; picker.accept = ".json,application/json";
  picker.onchange = () => { const file = picker.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = async () => { try { const result = await api("/api/backup", { method: "POST", body: JSON.parse(String(reader.result)) }); if (result.ok) closeAppModal(); showToast(result.ok ? `Restored ${result.data.masterlist} masterlist records, ${result.data.settings} settings, and ${result.data.faqs} FAQs.` : (result.error || "Could not restore backup."), result.ok ? undefined : "rgba(155,22,22,.85)"); } catch { showToast("The selected file is not a valid JSON backup.", "rgba(155,22,22,.85)"); } }; reader.readAsText(file); };
  picker.click();
}

async function sendReminders() {
  openAppModal({ title: "Send Email Reminders", subtitle: "This will email students with appointments within 24 hours and documents ready to claim.", icon: "fa-bell", content: `<div class="app-row"><div><div class="app-row-title">Email delivery</div><div class="app-row-meta">Messages are sent through the configured SMTP account. Already-sent reminders are skipped.</div></div></div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Cancel</button><button class="btn-maroon" onclick="confirmSendReminders()"><i class="fa-solid fa-paper-plane"></i> Send reminders</button></div>` });
}
async function confirmSendReminders() {
  const result = await api("/api/reminders", { method: "POST" });
  if (result.ok) closeAppModal();
  showToast(result.ok ? `Sent ${result.data.appointmentEmails} appointment and ${result.data.readyEmails} document reminders.` : (result.error || "Could not send reminders."), result.ok ? undefined : "rgba(155,22,22,.85)");
}

async function deleteMasterlist() {
  if (!MASTERLIST_COUNT) return showToast("There is no imported masterlist to delete.", "rgba(180,130,0,.85)");
  openAppModal({ title: "Delete CSV Masterlist", subtitle: "This removes imported CSV records only. Registered student accounts will remain active.", icon: "fa-trash-can", content: `<div class="app-row"><div><div class="app-row-title">${MASTERLIST_COUNT} imported student${MASTERLIST_COUNT === 1 ? "" : "s"}</div><div class="app-row-meta">This action cannot be undone without a backup.</div></div></div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Keep masterlist</button><button class="btn-maroon" onclick="confirmDeleteMasterlist()">Delete masterlist</button></div>` });
}
async function confirmDeleteMasterlist() {
  const { ok, data, error } = await api("/api/masterlist", { method: "DELETE" });
  if (ok) { closeAppModal(); await refreshMasterlistStatus(); }
  showToast(ok ? `Masterlist deleted — ${data.count} imported student${data.count === 1 ? "" : "s"} removed.` : (error || "Could not delete the masterlist."), ok ? undefined : "rgba(155,22,22,.85)");
}

async function reviewProfileChanges() {
  const result = await api("/api/profile");
  if (!result.ok) return showToast("Could not load profile updates.", "rgba(155,22,22,.85)");
  const list = result.data || [];
  openAppModal({ title: "Profile Verification", subtitle: "Approve or reject student updates before their profile is changed.", icon: "fa-user-check", wide: true, content: `<div class="app-list">${list.length ? list.map((p) => `<div class="app-row"><div><div class="app-row-title">${esc(p.name)} <span class="app-row-meta">(${esc(p.studentId)})</span></div><div class="app-row-meta">${esc(p.email)} · ${esc(p.course || "No course")} · ${esc(p.year || "No year level")}</div></div><div style="display:flex;gap:7px"><button class="btn-soft" onclick="resolveProfileChange('${esc(p.id)}','Rejected')">Reject</button><button class="btn-maroon" onclick="resolveProfileChange('${esc(p.id)}','Approved')">Approve</button></div></div>`).join("") : `<div class="app-row"><span class="app-row-meta">No profile updates awaiting review.</span></div>`}</div><div class="app-modal-actions"><button class="btn-soft" onclick="closeAppModal()">Close</button></div>` });
}
async function resolveProfileChange(id, status) {
  const result = await api(`/api/profile/${encodeURIComponent(id)}`, { method: "PATCH", body: { status } });
  if (!result.ok) return showToast(result.error || "Could not update profile.", "rgba(155,22,22,.85)");
  showToast(`Profile update ${status.toLowerCase()}.`); reviewProfileChanges();
}
