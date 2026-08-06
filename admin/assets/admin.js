const ADMIN_API_BASE = (() => {
  const configured = window.TITOPAY_ADMIN_CONFIG?.apiBaseUrl;
  const withVersion = (value) => {
    const clean = String(value || "").replace(/\/$/, "");
    return /\/(v1|api)$/.test(clean) ? clean : `${clean}/v1`;
  };
  if (configured) return withVersion(configured);
  if (location.protocol === "file:") return "http://127.0.0.1:8110/v1";
  if (location.hostname === "127.0.0.1" || location.hostname === "localhost") return "http://127.0.0.1:8110/v1";
  return "https://api.titopay.co.za/v1";
})();

/* Asset version and location. `ADMIN_ASSET_URL` is the folder this script was
   served from, so the lazily imported analytics module resolves next to it
   whether the console runs at the domain root or from a local path. */
const ADMIN_ASSET_VERSION = "admin-console-v58";
const ADMIN_ASSET_URL = (() => {
  try {
    const src = document.currentScript?.src;
    if (src) return new URL(".", src);
  } catch {}
  return new URL("/assets/", location.origin);
})();

const ADMIN_AUTH_KEY = "titopay_admin_auth_v1";
const ADMIN_ALLOWED_HOSTS = new Set(["admin.titopay.co.za", "www.admin.titopay.co.za", "127.0.0.1", "localhost"]);
const IDLE_WARNING_MS = 60 * 1000;
let idleWarningTimer = null;
let idleLogoutTimer = null;
let chatMonitorRefreshTimer = null;
let supportChatSocket = null;
let supportChatReconnectTimer = null;
let supportFallbackRefreshTimer = null;

const NAV_GROUPS = [
  { title: "Operations", items: [
    ["/dashboard/", "dashboard", "Dashboard"],
    ["/alerts/", "alerts", "Alerts"],
    ["/analytics/", "analytics", "Analytics"],
    ["/search/", "search", "Global Search"],
    ["/users/", "users", "Users"],
    ["/merchants/", "merchants", "Merchants"],
    ["/transactions/", "transactions", "Transactions"],
    ["/wallets/", "wallets", "Wallets"],
    ["/beneficiaries/", "beneficiaries", "Beneficiary Management"],
    ["/chat-monitor/", "chat-monitor", "Chat Monitor"],
    ["/ticketing/", "ticketing", "Ticketing"],
    ["/enterprise-distribution/", "enterprise-distribution", "Enterprise Distribution"],
    ["/qr-management/", "qr-management", "QR Management"],
    ["/marketing/", "marketing", "Marketing"],
  ]},
  { title: "Platform", items: [
    ["/service-builder/", "service-builder", "Service Builder"],
    ["/pricing/", "pricing", "Pricing Engine"],
    ["/integrations/", "integrations", "Integration Centre"],
    ["/feature-management/", "feature-management", "Feature Management"],
    ["/api-provider-settings/", "api-provider-settings", "API Provider Settings"],
    ["/settings/", "settings", "Settings"],
  ]},
  { title: "Communications", items: [
    ["/email-centre/", "email-centre", "Email Dashboard"],
    ["/email-centre/analytics/", "email-analytics", "Analytics"],
    ["/email-centre/templates/", "email-templates", "Templates"],
    ["/email-centre/queue/", "email-queue", "Queue"],
    ["/email-centre/logs/", "email-logs", "Delivery Logs"],
    ["/email-centre/settings/", "email-settings", "Email Settings"],
    ["/email-centre/otp/", "email-otp", "Email OTP"],
  ]},
  { title: "Governance", items: [
    ["/support/", "support", "Support Desk"],
    ["/chatbot-escalations/", "chatbot-escalations", "Chatbot Escalations"],
    ["/company-documents/", "company-documents", "Company Documents"],
    ["/compliance/", "compliance", "Compliance"],
    ["/revenue/", "revenue", "Revenue"],
    ["/security/", "security", "Security"],
    ["/system-logs/", "system-logs", "System Logs"],
    ["/audit/", "audit", "Audit"],
  ]},
  { title: "Owner Tools", items: [
    ["/development-tools/", "development-tools", "Development Tools"],
    ["/engineering-tools/", "engineering-tools", "Engineering Tools"],
    ["/database-health/", "database-health", "Database / Health"],
    ["/staff-management/", "staff-management", "Staff Management"],
    ["/rbac-permissions/", "rbac-permissions", "RBAC / Permissions"],
  ]},
];

const ADMIN_PAGE_ROUTES = new Map(
  NAV_GROUPS.flatMap((group) => group.items.map(([href, slug]) => [href, slug]))
);
ADMIN_PAGE_ROUTES.set("/integrations/peach-payments/", "integration-provider");
ADMIN_PAGE_ROUTES.set("/integrations/pos-provider/", "integration-provider");
ADMIN_PAGE_ROUTES.set("/integration-centre/", "integrations");
ADMIN_PAGE_ROUTES.set("/integrations/docfox/", "integration-provider");
ADMIN_PAGE_ROUTES.set("/integrations/flash/", "integration-provider");
ADMIN_PAGE_ROUTES.set("/integrations/ott/", "integration-provider");
ADMIN_PAGE_ROUTES.set("/integrations/email-smtp/", "integration-provider");
ADMIN_PAGE_ROUTES.set("/integrations/sms-provider/", "integration-provider");

const PAGE_EXPORTS = {};

function getAuth() {
  try {
    return JSON.parse(localStorage.getItem(ADMIN_AUTH_KEY) || "null");
  } catch {
    return null;
  }
}

function setAuth(data) {
  localStorage.setItem(ADMIN_AUTH_KEY, JSON.stringify({
    ...data,
    clientLastSeenAt: Date.now(),
  }));
}

function clearAuth() {
  localStorage.removeItem(ADMIN_AUTH_KEY);
}

function normalizeAdminRole(role) {
  return String(role || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function isSuperAdminRole(role) {
  return ["owner", "root", "ceo", "super_admin"].includes(normalizeAdminRole(role));
}

function isPlatformOwnerRole(role) {
  return ["owner", "root", "ceo", "super_admin", "developer"].includes(normalizeAdminRole(role));
}

function adminPositionLabel(role) {
  const normalized = normalizeAdminRole(role);
  return {
    ceo: "CEO",
    coo: "COO",
    cfo: "CFO",
    cto: "CTO",
    owner: "Owner",
    root: "Platform Owner",
    developer: "Developer",
    super_admin: "Super Admin",
    customer_support: "Customer Support",
    finance: "Finance",
    compliance: "Compliance",
    hr_admin: "HR Admin",
    hr_administrator: "HR Administrator",
    hr_director: "HR Director",
  }[normalized] || normalized.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function hasFullAdminAccess(me = {}) {
  const role = normalizeAdminRole(me.role || me.user?.role || me.admin?.role);
  const permissions = new Set(me.permissions || me.admin?.permissions || []);
  return isPlatformOwnerRole(role) || permissions.has("*");
}

/* Enterprise Analytics is gated on its own reporting permission. This is
   additive: it grants nothing new on any other module, and full-access roles
   keep the access they already had. */
const ADMIN_ANALYTICS_PERMISSIONS = ["analytics", "reporting", "reports", "analytics_view", "ANALYTICS_VIEW", "REPORTING_VIEW", "REPORTS_VIEW"];

/* Service Builder is gated the same additive way as Analytics: full-access
   and owner roles keep what they had, and a dedicated permission opens it for
   anyone else. No other module's rules change. */
const ADMIN_SERVICE_BUILDER_PERMISSIONS = ["service_builder", "services", "platform", "SERVICE_BUILDER", "SERVICES_MANAGE"];

function hasServiceBuilderAccess(me = {}) {
  if (hasFullAdminAccess(me)) return true;
  if (isPlatformOwnerRole(me.role || me.user?.role || me.admin?.role)) return true;
  const permissions = new Set(me.permissions || me.admin?.permissions || []);
  return ADMIN_SERVICE_BUILDER_PERMISSIONS.some((permission) => permissions.has(permission));
}

function hasAnalyticsAccess(me = {}) {
  if (hasFullAdminAccess(me)) return true;
  if (isPlatformOwnerRole(me.role || me.user?.role || me.admin?.role)) return true;
  const permissions = new Set(me.permissions || me.admin?.permissions || []);
  return ADMIN_ANALYTICS_PERMISSIONS.some((permission) => permissions.has(permission));
}

function touchAuthActivity() {
  const auth = getAuth();
  if (!auth) return;
  auth.clientLastSeenAt = Date.now();
  localStorage.setItem(ADMIN_AUTH_KEY, JSON.stringify(auth));
}

function getIdleTimeoutMs() {
  const auth = getAuth();
  return Math.max(60, Number(auth?.sessionIdleTimeoutSeconds || 900)) * 1000;
}

function stopIdleGuard() {
  clearTimeout(idleWarningTimer);
  clearTimeout(idleLogoutTimer);
}

function logoutToLogin(message = "Session ended") {
  clearAuth();
  stopIdleGuard();
  if (message) sessionStorage.setItem("titopay_admin_notice", message);
  location.href = "/";
}

function startIdleGuard() {
  stopIdleGuard();
  const auth = getAuth();
  if (!auth?.accessToken) return;
  const timeoutMs = getIdleTimeoutMs();
  idleWarningTimer = setTimeout(() => showToast("Session will expire soon due to inactivity"), Math.max(1000, timeoutMs - IDLE_WARNING_MS));
  idleLogoutTimer = setTimeout(async () => {
    try {
      await fetch(`${ADMIN_API_BASE}/admin/logout-all`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.accessToken}`,
        },
        body: JSON.stringify({ reason: "idle_timeout" }),
      });
    } catch {}
    logoutToLogin("Session expired due to inactivity");
  }, timeoutMs);
}

function registerActivityListeners() {
  ["pointerdown", "keydown", "mousemove", "touchstart", "scroll"].forEach((eventName) => {
    window.addEventListener(eventName, () => {
      touchAuthActivity();
      startIdleGuard();
    }, { passive: true });
  });
}

function validateAdminHost() {
  if (location.protocol === "file:") return true;
  if (location.hostname === "www.admin.titopay.co.za") {
    location.replace(`https://admin.titopay.co.za${location.pathname}${location.search}${location.hash}`);
    return false;
  }
  if (ADMIN_ALLOWED_HOSTS.has(location.hostname)) return true;
  // This notice is a plain document, not the console shell, so release the
  // console's scroll lock before rendering it.
  document.body.classList.remove("admin-body");
  document.body.innerHTML = `
    <main class="auth-shell">
      <section class="auth-card">
        <div class="brand">
          <div class="brand-mark">TP</div>
          <div>
            <h1>TitoPay Admin</h1>
            <p class="auth-copy">This environment is restricted to the secure TitoPay admin domain.</p>
          </div>
        </div>
      </section>
    </main>
  `;
  return false;
}

function money(value) {
  const amount = Number(value || 0);
  return new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" }).format(amount);
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function chipClass(status = "") {
  const value = String(status).toLowerCase();
  if (value.includes("active") || value.includes("verified") || value.includes("approved") || value.includes("completed")) return "green";
  if (value.includes("pending") || value.includes("review")) return "orange";
  if (value.includes("suspend") || value.includes("failed") || value.includes("lock")) return "red";
  return "blue";
}

/* Every existing caller passes a message and nothing else, so the tone is
   read from the message itself. A confirmation and a failure no longer look
   identical, and no call site had to change to get it. */
const TOAST_ERROR_PATTERN = /\b(unable|failed|failure|cannot|can't|could not|error|invalid|expired|denied|rejected|not allowed|unavailable|no longer)\b/i;
const TOAST_SUCCESS_PATTERN = /\b(saved|updated|created|added|sent|queued|approved|resolved|completed|refreshed|exported|disabled|enabled|assigned|closed|reopened|released|transferred|archived|acknowledged|reversed|verified|rotated|retried|cancelled|signed out|taken over|applied|reloaded)\b/i;

function toastTone(message) {
  const text = String(message || "");
  if (TOAST_ERROR_PATTERN.test(text)) return "error";
  if (TOAST_SUCCESS_PATTERN.test(text)) return "success";
  return "info";
}

function showToast(message, tone) {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    document.body.appendChild(toast);
  }
  const text = adminErrorMessage(message);
  toast.textContent = text;
  toast.dataset.tone = tone || toastTone(text);
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.remove(), 2600);
}

function adminErrorMessage(message) {
  const text = String(message || "Request failed").trim();
  const lower = text.toLowerCase();
  if (/bearer token required|jwt expired|token expired|unauthorized|session expired|invalid token|missing token/i.test(text)) {
    return "Your admin session has expired. Please sign in again.";
  }
  if (lower.includes("otp delivery failed")) {
    return "Sign in failed. Please check the staff email and password, then try again.";
  }
  if (isAuthModeBlockedError(text)) {
    return "Sign in failed because the API is still using an older admin authentication mode. Upload the latest API package or run the password-only migration, then try again.";
  }
  // Rate limits and account lockouts must reach the operator verbatim: they are
  // self-inflicted, temporary, and the wording tells them to wait rather than
  // retry. The generic filter below matches "try again later" and was replacing
  // them with advice to refresh, which makes the problem worse.
  if (/too many attempts|too many requests|rate limit|temporarily locked|account is locked|try again in/i.test(text)) {
    return text;
  }
  if (
    !text ||
    /something went wrong|try again later|internal server error|unexpected api response|request failed|networkerror/i.test(text) ||
    /cannot read properties|is not defined|is not a function|is not iterable|undefined|null|typeerror|referenceerror|syntaxerror|nan|\[object /i.test(text) ||
    /relation .* does not exist|column .* does not exist|syntax error|pg[_-]?pool|postgres|prisma|database/i.test(text) ||
    /node_modules|\/opt\/titopay-api|\/src\/|stack:|at\s+\w+/i.test(text)
  ) {
    return "Unable to complete this admin action. Please refresh and try again.";
  }
  return text.replace(
    "Configure the TitoPay Google Workspace email provider and retry.",
    "Please check the staff email and password, then try again."
  );
}

function isAuthModeBlockedError(message = "") {
  const text = String(message).toLowerCase();
  return text.includes("current authentication mode cannot complete") ||
    text.includes("security centre to password only") ||
    text.includes("security center to password only");
}

function hasAdminSession(payload = {}) {
  return Boolean(payload.accessToken || payload.access_token || payload.token);
}

function normalizeAdminSession(payload = {}) {
  return {
    ...payload,
    accessToken: payload.accessToken || payload.access_token || payload.token,
    refreshToken: payload.refreshToken || payload.refresh_token,
    tokenType: payload.tokenType || payload.token_type || "Bearer",
  };
}

function adminLoginPayload(data = {}) {
  const identifier = String(data.identifier || data.email || data.username || "").trim();
  const payload = {
    ...data,
    identifier,
    emailOrUsername: identifier,
    usernameOrEmail: identifier,
  };
  if (identifier.includes("@")) {
    payload.email = identifier.toLowerCase();
  } else {
    payload.username = identifier.replace(/^@/, "").toLowerCase();
  }
  return payload;
}

function downloadCsv(filename, rows) {
  if (!rows?.length) {
    showToast("Nothing to export yet");
    return;
  }
  const columns = Array.from(rows.reduce((set, row) => {
    Object.keys(row || {}).forEach((key) => set.add(key));
    return set;
  }, new Set()));
  const csv = [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => {
      const value = row?.[column] ?? "";
      const text = Array.isArray(value) ? value.join(" | ") : String(value);
      return `"${text.replaceAll("\"", "\"\"")}"`;
    }).join(",")),
  ].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function apiFetch(path, options = {}) {
  const auth = getAuth();
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (auth?.accessToken) headers.Authorization = `Bearer ${auth.accessToken}`;
  const invalidateOnAuthFailure = options.invalidateOnAuthFailure === true;
  const fetchOptions = { ...options };
  delete fetchOptions.invalidateOnAuthFailure;
  let response;
  try {
    response = await fetch(`${ADMIN_API_BASE}${path}`, {
      ...fetchOptions,
      headers,
      mode: "cors",
      cache: "no-store",
    });
  } catch (error) {
    const apiError = new Error(`Cannot reach TitoPay API at ${ADMIN_API_BASE}. Check that api.titopay.co.za is online, HTTPS is valid, and CORS allows admin.titopay.co.za.`);
    apiError.status = 0;
    throw apiError;
  }
  if (response.status === 401 && auth?.refreshToken) {
    let refreshed;
    try {
      refreshed = await fetch(`${ADMIN_API_BASE}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        mode: "cors",
        cache: "no-store",
        body: JSON.stringify({ refreshToken: auth.refreshToken, scope: "admin" }),
      });
    } catch {
      const apiError = new Error(`Cannot refresh admin session because TitoPay API is unreachable at ${ADMIN_API_BASE}.`);
      apiError.status = 0;
      throw apiError;
    }
    if (refreshed.ok) {
      const data = await refreshed.json();
      const merged = { ...auth, ...data };
      setAuth(merged);
      startIdleGuard();
      return apiFetch(path, options);
    }
    if (invalidateOnAuthFailure) clearAuth();
    const apiError = new Error("Session expired");
    apiError.status = 401;
    throw apiError;
  }
  const contentType = response.headers.get("content-type") || "";
  const payload = response.status === 204
    ? {}
    : contentType.includes("application/json")
      ? await response.json()
      : { error: await response.text() };
  if (!response.ok) {
    const message = payload.error || payload.message || `TitoPay API request failed (${response.status})`;
    const apiError = new Error(message);
    apiError.status = response.status;
    apiError.payload = payload;
    apiError.path = path;
    apiError.url = `${ADMIN_API_BASE}${path}`;
    apiError.requestId = payload.requestId || response.headers.get("x-request-id") || "";
    if (response.status === 401 && /bearer token required|jwt expired|token expired|unauthorized|session expired/i.test(message)) {
      logoutToLogin("Your admin session has expired. Please sign in again.");
    }
    throw apiError;
  }
  if (auth?.accessToken) {
    touchAuthActivity();
    startIdleGuard();
  }
  return payload;
}

function ensureAdminSupportSocket() {
  const auth = getAuth();
  if (!auth?.accessToken || supportChatSocket?.readyState === WebSocket.OPEN || supportChatSocket?.readyState === WebSocket.CONNECTING) return;
  clearTimeout(supportChatReconnectTimer);
  const base = new URL(ADMIN_API_BASE);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = "/v1/chat/socket";
  base.search = "";
  try {
    supportChatSocket = new WebSocket(base.toString(), ["titopay-chat", `bearer.${auth.accessToken}`]);
  } catch {
    // Safari can reject WebSocket creation synchronously. Live transport must
    // never prevent the REST-backed support queue from rendering or working.
    supportChatSocket = null;
    if (!supportFallbackRefreshTimer) {
      supportFallbackRefreshTimer = setInterval(() => {
        const page = document.querySelector(".admin-shell[data-page]")?.dataset.page;
        if (["support", "chatbot-escalations"].includes(page)) {
          renderSupport().catch(() => null);
        }
      }, 10000);
    }
    return;
  }
  supportChatSocket.addEventListener("open", () => {
    clearInterval(supportFallbackRefreshTimer);
    supportFallbackRefreshTimer = null;
  });
  supportChatSocket.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data || "{}");
      if (!String(payload.type || "").startsWith("support:")) return;
      const page = document.querySelector(".admin-shell[data-page]")?.dataset.page;
      if (["support", "chatbot-escalations"].includes(page)) {
        renderSupport().catch(() => null);
      }
    } catch {}
  });
  supportChatSocket.addEventListener("close", () => {
    supportChatSocket = null;
    if (!supportFallbackRefreshTimer) {
      supportFallbackRefreshTimer = setInterval(() => {
        const page = document.querySelector(".admin-shell[data-page]")?.dataset.page;
        if (["support", "chatbot-escalations"].includes(page)) {
          renderSupport().catch(() => null);
        }
      }, 10000);
    }
    supportChatReconnectTimer = setTimeout(ensureAdminSupportSocket, 3000);
  });
  supportChatSocket.addEventListener("error", () => supportChatSocket?.close());
}

/* --------------------------------------------------------------------------
   Console chrome (presentation only)

   The sidebar, topbar and page header are built once per document and then
   updated in place. Earlier builds re-created the whole shell on every
   navigation, which reset the sidebar scroll position and re-bound listeners
   on each route change.
   -------------------------------------------------------------------------- */

const NAV_ICON_PATHS = {
  dashboard: "M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm10 0h6V11h-6v9Zm0-16v5h6V4h-6Z",
  alerts: "M12 4a5 5 0 0 0-5 5v3.4l-1.7 2.9a1 1 0 0 0 .9 1.5h11.6a1 1 0 0 0 .9-1.5L17 12.4V9a5 5 0 0 0-5-5Zm-2 14.8a2 2 0 0 0 4 0",
  analytics: "M4 4v16h16M8 16l3.2-4.2 3 2.4L19 8m0 0h-3.6M19 8v3.4",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm9 16-4.2-4.2",
  users: "M16 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm11 10v-2a4 4 0 0 0-3-3.9M16 3.6a4 4 0 0 1 0 7.8",
  merchants: "M3 9.5 4.5 5h15L21 9.5M3 9.5h18M3 9.5a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0M5 12v7h14v-7",
  transactions: "M4 8h13m0 0-3-3m3 3-3 3M20 16H7m0 0 3-3m-3 3 3 3",
  wallets: "M3 7.5A2.5 2.5 0 0 1 5.5 5H18v3M3 7.5V17a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2M3 7.5V10h16a2 2 0 0 1 2 2v3m0 0h-4a2 2 0 1 1 0-4h4",
  beneficiaries: "M16 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7-1 1.5 1.5L21 7.5",
  "chat-monitor": "M20 12a8 8 0 1 1-3.2-6.4M21 4v5h-5",
  ticketing: "M4 8.5A1.5 1.5 0 0 1 5.5 7h13A1.5 1.5 0 0 1 20 8.5v2a2 2 0 0 0 0 3.9v2A1.5 1.5 0 0 1 18.5 18h-13A1.5 1.5 0 0 1 4 16.4v-2a2 2 0 0 0 0-3.9v-2ZM12 7v11",
  "enterprise-distribution": "M12 3v6m0 0-3.5 3.5M12 9l3.5 3.5M4 21v-4m0 0-1-1.5m1 1.5 1-1.5M20 21v-4m0 0-1-1.5m1 1.5 1-1.5M12 21v-4",
  "qr-management": "M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 3h3m0 0v3m0-3h3m-6-3h6",
  marketing: "M4 10v4h3l5 4V6L7 10H4Zm13-1.5a5 5 0 0 1 0 7",
  "service-builder": "M4 6.5 12 3l8 3.5-8 3.5-8-3.5Zm0 5.5 8 3.5 4-1.75M4 17.5 9 15.7M18 14v3m0 0v3m0-3h3m-3 0h-3",
  pricing: "M12 3v18M8.5 7.5h6.2a2.5 2.5 0 0 1 0 5H9.3a2.5 2.5 0 0 0 0 5h6.2",
  integrations: "M9 4v4M15 4v4M6 8h12v5a6 6 0 0 1-12 0V8Zm6 11v3",
  "integration-provider": "M9 4v4M15 4v4M6 8h12v5a6 6 0 0 1-12 0V8Zm6 11v3",
  "feature-management": "M5 8h9m2 0h3M5 16h3m2 0h9M14 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Zm-4 8a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z",
  "api-provider-settings": "M6 7h12M6 12h12M6 17h6M18 15v4m2-2h-4",
  settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm7.4 3a7.4 7.4 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7.4 7.4 0 0 0-2-1.2L14.6 3H9.4L9 5.7a7.4 7.4 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7.4 7.4 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7.4 7.4 0 0 0 2 1.2l.4 2.7h5.2l.4-2.7a7.4 7.4 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.07-.4.1-.8.1-1.2Z",
  support: "M4 12a8 8 0 0 1 16 0v5a2 2 0 0 1-2 2h-3M4 12v3a2 2 0 0 0 2 2h1v-5H4Zm16 0h-3v5h1a2 2 0 0 0 2-2v-3Z",
  "chatbot-escalations": "M5 5h14v10H9l-4 4V5Zm4 4h6m-6 3h4",
  "company-documents": "M6 3h7l5 5v13H6V3Zm7 0v5h5M9 13h6M9 17h6",
  compliance: "M12 3 5 6v5.5c0 4.2 2.9 8.1 7 9.5 4.1-1.4 7-5.3 7-9.5V6l-7-3Zm-2.6 8.8 2 2 4-4",
  revenue: "M4 18 9.5 12l3.5 3.5L20 8m0 0h-4.5M20 8v4.5",
  security: "M6 10V7.5a6 6 0 0 1 12 0V10m-13 0h14v10H5V10Zm7 4v2",
  "system-logs": "M6 3h12v18H6V3Zm3 4h6M9 11h6M9 15h4",
  audit: "M5 4h14v16H5V4Zm3 4h8M8 12h8M8 16h5m4.5-1.5 1.5 1.5-1.5 1.5",
  "development-tools": "m9 8-5 4 5 4m6-8 5 4-5 4m-2-11-2 14",
  "engineering-tools": "M14.5 4.5a4.5 4.5 0 0 0-5.9 5.7L4 14.8 6.2 17l4.6-4.6a4.5 4.5 0 0 0 5.7-5.9l-2.5 2.5-2.1-2.1 2.6-2.4ZM15 15l4 4",
  "database-health": "M12 4c4 0 7 1.1 7 2.5S16 9 12 9 5 7.9 5 6.5 8 4 12 4Zm7 2.5v11c0 1.4-3 2.5-7 2.5s-7-1.1-7-2.5v-11m14 5.5c0 1.4-3 2.5-7 2.5s-7-1.1-7-2.5",
  "staff-management": "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 8v-1a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v1",
  "rbac-permissions": "M12 3 5 6v5.5c0 4.2 2.9 8.1 7 9.5 4.1-1.4 7-5.3 7-9.5V6l-7-3Zm0 6.5a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6Zm0 3.6V16",
};

function navIcon(slug) {
  const path = NAV_ICON_PATHS[slug] || NAV_ICON_PATHS.dashboard;
  return `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`;
}

function navGroupTitleFor(page) {
  const group = NAV_GROUPS.find((entry) => entry.items.some(([, slug]) => slug === page));
  return group?.title || "Console";
}

function adminEnvironment() {
  const host = location.hostname;
  if (host === "admin.titopay.co.za" || host === "www.admin.titopay.co.za") {
    return { label: "Production", nonProd: false };
  }
  return { label: "Non-production", nonProd: true };
}

const ADMIN_RAIL_KEY = "titopay_admin_rail_v1";

/* Rail collapse. Persisted per browser so an operator who works in tables
   keeps the wide workspace across navigations and sessions. The navigation
   itself is untouched: every item keeps its route, icon and accessible name,
   and the state is ignored below the tablet breakpoint where the rail is
   already a drawer. */
function storedRailState() {
  try {
    return localStorage.getItem(ADMIN_RAIL_KEY) === "collapsed" ? "collapsed" : "expanded";
  } catch {
    return "expanded";
  }
}

function applyRailState(state) {
  const next = state === "collapsed" ? "collapsed" : "expanded";
  const shell = document.querySelector(".admin-shell");
  if (shell) {
    if (next === "collapsed") shell.dataset.rail = "collapsed";
    else delete shell.dataset.rail;
  }
  const toggle = document.querySelector("[data-rail-toggle]");
  if (toggle) {
    toggle.setAttribute("aria-expanded", next === "collapsed" ? "false" : "true");
    toggle.setAttribute("aria-label", next === "collapsed" ? "Expand navigation" : "Collapse navigation");
    toggle.title = next === "collapsed" ? "Expand navigation" : "Collapse navigation";
  }
  document.querySelectorAll("#admin-nav .nav-link").forEach((link) => {
    // Collapsed to icons, the label is the only thing that says where a link
    // goes, so it moves to the tooltip rather than disappearing.
    if (next === "collapsed") link.title = link.textContent.trim();
    else link.removeAttribute("title");
  });
  try {
    localStorage.setItem(ADMIN_RAIL_KEY, next);
  } catch {}
}

/* A 2px line under the topbar while a module's first request is in flight. */
function setRouteProgress(active) {
  const bar = document.getElementById("route-progress");
  if (bar) bar.dataset.active = active ? "true" : "false";
}

const ADMIN_THEME_KEY = "titopay_admin_theme_v1";

function applyAdminTheme(theme) {
  const next = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(ADMIN_THEME_KEY, next);
  } catch {}
}

function storedAdminTheme() {
  try {
    return localStorage.getItem(ADMIN_THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

// Applied before first paint so the console never flashes the wrong theme.
applyAdminTheme(storedAdminTheme());

function renderSidebar(page, me) {
  const role = me?.role || "admin";
  const adminName = me?.fullName || me?.full_name || me?.admin?.fullName || me?.admin?.full_name || me?.username || me?.admin?.username || "TitoPay Admin";
  const position = me?.position || me?.admin?.position || adminPositionLabel(role);
  const permissions = new Set(me?.permissions || []);
  const canSee = (slug) => {
    if (hasFullAdminAccess(me) || isPlatformOwnerRole(role)) return true;
    const map = {
      dashboard: "dashboard",
      alerts: "__everyone__",
      analytics: "__analytics__",
      "service-builder": "__service_builder__",
      users: "users",
      merchants: "merchants",
      transactions: "transactions",
      wallets: "wallets",
      beneficiaries: "__super_admin__",
      "chat-monitor": "__super_admin__",
      ticketing: "ticketing",
      "enterprise-distribution": "enterprise_distribution",
      search: "users",
      "qr-management": "analytics",
      marketing: "analytics",
      pricing: "__super_admin__",
      integrations: "__super_admin__",
      "integration-provider": "__super_admin__",
      "feature-management": "__super_admin__",
      "api-provider-settings": "__owner__",
      support: "support",
      "chatbot-escalations": "support",
      "company-documents": "__company_docs__",
      compliance: "compliance",
      revenue: "revenue",
      security: "security",
      "system-logs": "security",
      audit: "audit",
      settings: "engineering",
      "email-centre": "EMAIL_VIEW",
      "email-analytics": "EMAIL_VIEW",
      "email-templates": "EMAIL_VIEW",
      "email-queue": "EMAIL_VIEW",
      "email-logs": "EMAIL_LOG_VIEW",
      "email-settings": "EMAIL_SETTINGS_EDIT",
      "email-otp": "EMAIL_OTP_VIEW",
      "development-tools": "__owner__",
      "engineering-tools": "__owner__",
      "database-health": "__owner__",
      "staff-management": "__owner__",
      "rbac-permissions": "__owner__",
    };
    const required = map[slug] || slug;
    if (required === "__everyone__") return true;
    if (required === "__analytics__") return hasAnalyticsAccess(me);
    if (required === "__service_builder__") return hasServiceBuilderAccess(me);
    if (required === "__super_admin__") return isSuperAdminRole(role);
    if (required === "__owner__") return isPlatformOwnerRole(role);
    if (required === "__company_docs__") return isPlatformOwnerRole(role) || ["hr_admin", "hr_administrator", "hr_director"].includes(normalizeAdminRole(role));
    return permissions.has(required);
  };
  const initials = adminName.trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase() || "TP";
  return `
    <aside class="sidebar" id="admin-sidebar">
      <div class="brand">
        <div class="brand-mark">TP</div>
        <div class="brand-copy">
          <strong>TitoPay</strong>
          <small>Operations Console</small>
        </div>
      </div>
      <div class="nav-filter">
        <label class="visually-hidden" for="nav-filter-input">Filter navigation</label>
        <input id="nav-filter-input" type="search" placeholder="Filter modules" autocomplete="off" spellcheck="false">
      </div>
      <nav class="sidebar-nav" id="admin-nav" aria-label="Admin modules">
        ${NAV_GROUPS.map((group) => {
          const items = group.items.filter(([, slug]) => canSee(slug));
          if (!items.length) return "";
          return `
            <div class="nav-group">
              <span>${escapeHtml(group.title)}</span>
              ${items.map(([href, slug, label]) => `
                <a class="nav-link ${page === slug ? "active" : ""}" href="${href}" data-nav-slug="${escapeHtml(slug)}"${page === slug ? ' aria-current="page"' : ""}>${navIcon(slug)}<span>${escapeHtml(label)}</span></a>
              `).join("")}
            </div>
          `;
        }).join("")}
        <p class="nav-empty" id="nav-filter-empty" hidden>No modules match that filter.</p>
      </nav>
      <div class="sidebar-footer">
        <div class="sidebar-user">
          <span class="profile-avatar" aria-hidden="true">${escapeHtml(initials)}</span>
          <div>
            <strong>${escapeHtml(adminName)}</strong>
            <small>${escapeHtml(position)}</small>
          </div>
        </div>
        <button class="secondary-btn" id="admin-logout" type="button">Sign Out</button>
        <button class="ghost-btn" id="admin-logout-all" type="button">Sign Out All Devices</button>
      </div>
    </aside>
  `;
}

function renderTopbar(page, title) {
  const environment = adminEnvironment();
  return `
    <header class="admin-topbar">
      <div class="route-progress" id="route-progress" data-active="false" aria-hidden="true"></div>
      <button class="nav-toggle" type="button" data-nav-toggle aria-label="Open navigation" aria-controls="admin-sidebar" aria-expanded="false">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
      </button>
      <button class="rail-toggle" type="button" data-rail-toggle aria-controls="admin-sidebar" aria-expanded="true" aria-label="Collapse navigation" title="Collapse navigation">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16M4 12h9M4 19h16m6-7-4 3.5V8.5L20 12Z"/></svg>
      </button>
      <nav class="topbar-crumbs" id="admin-crumbs" aria-label="Breadcrumb">
        <span class="crumb-section">${escapeHtml(navGroupTitleFor(page))}</span>
        <span class="crumb-sep" aria-hidden="true">/</span>
        <strong>${escapeHtml(title)}</strong>
      </nav>
      <div class="topbar-meta">
        <span class="env-badge${environment.nonProd ? " env-nonprod" : ""}" title="Environment">${escapeHtml(environment.label)}</span>
        <span class="topbar-clock" id="admin-clock" title="South African Standard Time"></span>
        <div class="tp-bell-wrap">
          <button class="tp-bell" type="button" data-alert-bell aria-label="Alerts" aria-haspopup="true" aria-expanded="false" aria-controls="alert-panel">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4a5 5 0 0 0-5 5v3.4l-1.7 2.9a1 1 0 0 0 .9 1.5h11.6a1 1 0 0 0 .9-1.5L17 12.4V9a5 5 0 0 0-5-5Zm-2 14.8a2 2 0 0 0 4 0"/></svg>
            <span class="tp-bell-badge" id="alert-badge" hidden>0</span>
          </button>
          <div class="tp-bell-panel" id="alert-panel" hidden role="dialog" aria-label="Recent alerts">
            <div class="tp-bell-panel-head">
              <strong>Alerts</strong>
              <button class="link-btn" type="button" data-alert-mark-all>Mark all read</button>
            </div>
            <div class="tp-bell-panel-list" id="alert-panel-list"></div>
            <a class="tp-bell-panel-foot" href="/alerts/">View all alerts</a>
          </div>
        </div>
        <button class="theme-toggle" type="button" data-theme-toggle aria-label="Switch between light and dark appearance">
          <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.5 1.5m11.2 11.2 1.5 1.5M19.1 4.9l-1.5 1.5M6.4 17.6l-1.5 1.5"/></svg>
          <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8.2 8.2 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z"/></svg>
        </button>
      </div>
    </header>
  `;
}

function updateAdminClock() {
  const clock = document.getElementById("admin-clock");
  if (!clock) return;
  try {
    clock.textContent = `${new Intl.DateTimeFormat("en-ZA", {
      timeZone: "Africa/Johannesburg",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date())} SAST`;
  } catch {
    clock.textContent = new Date().toLocaleTimeString();
  }
}

function setNavDrawer(open) {
  const shell = document.querySelector(".admin-shell");
  if (!shell) return;
  if (open) shell.dataset.nav = "open";
  else delete shell.dataset.nav;
  document.querySelector("[data-nav-toggle]")?.setAttribute("aria-expanded", open ? "true" : "false");
}

function bindConsoleChrome() {
  document.getElementById("admin-logout")?.addEventListener("click", async () => {
    const auth = getAuth();
    try {
      if (auth?.refreshToken) {
        await apiFetch("/admin/logout", {
          method: "POST",
          body: JSON.stringify({ refreshToken: auth.refreshToken }),
        });
      }
    } catch {}
    logoutToLogin("Signed out");
  });

  document.getElementById("admin-logout-all")?.addEventListener("click", async () => {
    try {
      await apiFetch("/admin/logout-all", { method: "POST", body: JSON.stringify({ reason: "manual" }) });
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
    logoutToLogin("Signed out on all devices");
  });

  const filterInput = document.getElementById("nav-filter-input");
  filterInput?.addEventListener("input", () => {
    const query = filterInput.value.trim().toLowerCase();
    let visible = 0;
    document.querySelectorAll("#admin-nav .nav-group").forEach((group) => {
      let groupVisible = 0;
      group.querySelectorAll(".nav-link").forEach((link) => {
        const match = !query || link.textContent.toLowerCase().includes(query);
        link.hidden = !match;
        if (match) groupVisible += 1;
      });
      group.hidden = groupVisible === 0;
      visible += groupVisible;
    });
    const empty = document.getElementById("nav-filter-empty");
    if (empty) empty.hidden = visible > 0;
  });

  document.querySelector("[data-theme-toggle]")?.addEventListener("click", () => {
    applyAdminTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });

  document.querySelector("[data-rail-toggle]")?.addEventListener("click", () => {
    applyRailState(document.querySelector(".admin-shell")?.dataset.rail === "collapsed" ? "expanded" : "collapsed");
  });

  applyRailState(storedRailState());

  document.querySelector("[data-nav-toggle]")?.addEventListener("click", () => {
    setNavDrawer(document.querySelector(".admin-shell")?.dataset.nav !== "open");
  });

  document.querySelector("[data-nav-close]")?.addEventListener("click", () => setNavDrawer(false));

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.querySelector(".admin-shell")?.dataset.nav === "open") {
      setNavDrawer(false);
      document.querySelector("[data-nav-toggle]")?.focus();
    }
  });

  document.getElementById("admin-nav")?.addEventListener("click", (event) => {
    if (event.target.closest(".nav-link")) setNavDrawer(false);
  });

  updateAdminClock();
  clearInterval(bindConsoleChrome._clock);
  bindConsoleChrome._clock = setInterval(updateAdminClock, 30000);
}

/* Builds the console chrome on first use, then updates the parts that change
   between modules. `pageShell` keeps its original signature and contract:
   after it returns, `#page-content` exists and is empty. */
function pageShell(page, me, title, subtitle, controls = "") {
  const shell = document.querySelector(".admin-shell");
  if (!shell) return;
  const refreshControl = `<button class="secondary-btn admin-refresh-btn" type="button" data-admin-page-refresh="${escapeHtml(page)}">Refresh</button>`;
  const headerControls = [refreshControl, controls].filter(Boolean).join("");

  if (!shell.querySelector(".sidebar") || !shell.querySelector(".workspace")) {
    shell.innerHTML = `
      <a class="skip-link" href="#page-content">Skip to page content</a>
      ${renderSidebar(page, me)}
      <button class="sidebar-scrim" type="button" data-nav-close aria-label="Close navigation" tabindex="-1"></button>
      <div class="workspace">
        ${renderTopbar(page, title)}
        <main class="main-area" id="admin-main">
          <div class="page-header">
            <div>
              <h1>${escapeHtml(title)}</h1>
              <p>${escapeHtml(subtitle)}</p>
            </div>
            <div class="header-actions">${headerControls}</div>
          </div>
          <div id="page-content"></div>
        </main>
      </div>
    `;
    bindConsoleChrome();
    return;
  }

  shell.querySelectorAll("#admin-nav .nav-link").forEach((link) => {
    const active = link.dataset.navSlug === page;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });

  applyRailState(storedRailState());

  const crumbs = document.getElementById("admin-crumbs");
  if (crumbs) {
    crumbs.querySelector(".crumb-section").textContent = navGroupTitleFor(page);
    crumbs.querySelector("strong").textContent = title;
  }

  const header = shell.querySelector(".page-header");
  if (header) {
    header.querySelector("h1").textContent = title;
    header.querySelector("p").textContent = subtitle;
    header.querySelector(".header-actions").innerHTML = headerControls;
  }

  const content = document.getElementById("page-content");
  if (content) content.innerHTML = "";
}

/* Placeholder shown while a module's first request is in flight. */
function showModuleSkeleton() {
  const content = document.getElementById("page-content");
  if (!content) return;
  content.innerHTML = `<div class="admin-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>`;
}

function renderStandaloneModuleError(error) {
  const shell = document.querySelector(".admin-shell");
  if (!shell) return;
  // status 0 means the browser never received a response at all: the API is
  // down, unreachable, or rejecting the request before it can answer. That is a
  // different problem from the API answering with an error, and it needs a
  // different instruction, so the two are not collapsed into one message.
  const offline = error?.status === 0;
  const requestId = error?.requestId || error?.payload?.requestId || "";
  const heading = offline ? "Cannot reach the TitoPay API" : "Admin module unavailable";
  const message = offline
    ? `The console loaded, but ${ADMIN_API_BASE.replace(/^https?:\/\//, "")} did not respond.`
    : adminErrorMessage(error?.message || "Unable to load this module.");
  const detailRows = offline
    ? [
      ["API endpoint", ADMIN_API_BASE],
      ["Console origin", location.origin],
      ["Result", "No response received"]
    ]
    : [
      ["Result", `Service responded ${error?.status || "with an error"}`],
      ["Reference", requestId || "-"]
    ];
  const guidance = offline
    ? `Open <strong>${escapeHtml(ADMIN_API_BASE)}/../health</strong> in a new tab. If that does not load, the API process is not running or the domain is not resolving. If it loads but this page still fails, the API is not accepting requests from <strong>${escapeHtml(location.origin)}</strong> and its allowed-origins list needs that exact address.`
    : "Retry the module. If the same response returns, the API needs attention.";
  shell.innerHTML = `
    <main class="main-area standalone-error">
      <div class="page-header">
        <div>
          <h1>${escapeHtml(heading)}</h1>
          <p>${escapeHtml(message)}</p>
        </div>
        <div class="header-actions">
          <button class="secondary-btn admin-refresh-btn" type="button" data-window-refresh>Retry</button>
          <button class="ghost-btn" type="button" data-admin-signout-local>Sign out</button>
        </div>
      </div>
      <section class="table-card">
        <h3>What to check</h3>
        <p class="table-card-note">${guidance}</p>
        ${renderKeyValueList(detailRows)}
      </section>
    </main>
  `;
}

function renderModuleError(page, me, error) {
  const title = page ? page.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Admin Module";
  const message = adminErrorMessage(error?.message || "Unable to load this module right now.");
  const requestId = error?.requestId || error?.payload?.requestId || "";
  const detailRows = [
    ["Status", error?.status === 0 ? "Connection unavailable" : `Service response ${error?.status || "unavailable"}`],
    ["Reference", requestId || "-"]
  ];
  pageShell(page || "dashboard", me || { role: "admin", permissions: [] }, title, message);
  document.getElementById("page-content").innerHTML = `
    <section class="table-card">
      <h3>Operational notice</h3>
      <p class="table-card-note">Refresh this module first. If the same error returns, the backend API needs attention.</p>
      ${renderKeyValueList(detailRows)}
      <div class="action-row">
        <button class="secondary-btn admin-refresh-btn" type="button" data-admin-page-refresh="${escapeHtml(page || "dashboard")}">Refresh</button>
      </div>
    </section>
  `;
}

function tableCard(title, body, note = "", meta = "") {
  const noteHtml = note ? `<p class="table-card-note">${escapeHtml(note)}</p>` : "";
  const metaHtml = meta ? `<span class="table-card-meta">${escapeHtml(meta)}</span>` : "";
  return `
    <section class="table-card">
      <div class="table-card-header">
        <div>
          <h3>${escapeHtml(title)}</h3>
          ${noteHtml}
        </div>
        ${metaHtml}
      </div>
      ${body}
    </section>
  `;
}

function renderKeyValueList(rows = []) {
  return `
    <dl class="key-value-list">
      ${rows.map(([key, value]) => `
        <div class="key-value-row">
          <dt>${escapeHtml(key)}</dt>
          <dd>${escapeHtml(value === undefined || value === null || value === "" ? "-" : value)}</dd>
        </div>
      `).join("")}
    </dl>
  `;
}

/* Sign-in feedback. Same wording as before; `tone` only drives the colour so a
   failed sign-in never reads as a neutral hint. */
function setLoginStatus(message, tone = "") {
  const target = document.getElementById("login-status");
  if (!target) return;
  target.textContent = message;
  if (tone) target.dataset.tone = tone;
  else delete target.dataset.tone;
}

function setLoginPending(pending) {
  const submit = document.getElementById("admin-login-submit");
  if (!submit) return;
  submit.disabled = pending;
  if (pending) {
    submit.dataset.pending = "true";
    submit.textContent = "Signing in...";
  } else {
    delete submit.dataset.pending;
    submit.textContent = "Sign in securely";
  }
}

function bindSignInControls() {
  const environment = document.getElementById("login-environment");
  if (environment) {
    const { label, nonProd } = adminEnvironment();
    environment.textContent = label;
    environment.classList.toggle("env-nonprod", nonProd);
  }

  const password = document.getElementById("password");
  const toggle = document.querySelector("[data-password-toggle]");
  toggle?.addEventListener("click", () => {
    const reveal = password.type === "password";
    password.type = reveal ? "text" : "password";
    toggle.textContent = reveal ? "Hide" : "Show";
    toggle.setAttribute("aria-pressed", reveal ? "true" : "false");
    password.focus();
  });

  // Caps Lock silently defeats a correct password more often than anything else
  // on a staff sign-in, so say so before the request is made.
  const capsHint = document.getElementById("caps-hint");
  const trackCapsLock = (event) => {
    if (!capsHint || typeof event.getModifierState !== "function") return;
    capsHint.hidden = !event.getModifierState("CapsLock");
  };
  password?.addEventListener("keydown", trackCapsLock);
  password?.addEventListener("keyup", trackCapsLock);
  password?.addEventListener("blur", () => {
    if (capsHint) capsHint.hidden = true;
  });

  document.getElementById("identifier")?.focus();
}

function beginAdminEmailOtp(initialChallenge) {
  const card=document.getElementById("reset-card");
  if(!card)return;
  let challenge={...initialChallenge};
  card.hidden=false;
  card.innerHTML=`<form id="admin-email-otp-form" class="form-grid"><div class="field"><label for="admin-email-otp">Email verification code</label><input id="admin-email-otp" name="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,8}" maxlength="8" required aria-describedby="admin-email-otp-hint"><p class="field-hint" id="admin-email-otp-hint">Sent to ${escapeHtml(challenge.maskedDestination||"your email")}. <span id="admin-email-otp-countdown"></span> <span id="admin-email-otp-attempts"></span></p></div><button class="primary-btn" type="submit">Verify and sign in</button><button class="secondary-btn" type="button" id="admin-email-otp-resend">Resend code</button></form>`;
  let started=Date.now(),duration=Number(challenge.expiresInSeconds||300)*1000;
  const countdown=document.getElementById("admin-email-otp-countdown"),attempts=document.getElementById("admin-email-otp-attempts"),resend=document.getElementById("admin-email-otp-resend");
  const update=()=>{const elapsed=Date.now()-started,left=Math.max(0,Math.ceil((duration-elapsed)/1000)),cooldown=Math.max(0,Math.ceil((Number(challenge.resendCooldownSeconds||60)*1000-elapsed)/1000));if(countdown)countdown.textContent=left?`Expires in ${Math.floor(left/60)}:${String(left%60).padStart(2,"0")}.`:"Code expired.";if(attempts)attempts.textContent=`${Number(challenge.remainingAttempts??5)} attempts remaining.`;if(resend){resend.disabled=cooldown>0;resend.textContent=cooldown?`Resend in ${cooldown}s`:"Resend code";}};
  const timer=setInterval(update,1000);update();
  document.getElementById("admin-email-otp")?.focus();
  document.getElementById("admin-email-otp-form")?.addEventListener("submit",async(event)=>{event.preventDefault();const otp=new FormData(event.currentTarget).get("otp");setLoginStatus("Verifying email code...","pending");try{const result=await apiFetch("/auth/email-otp/verify",{method:"POST",body:JSON.stringify({challengeId:challenge.challengeId,otp,deviceName:"Admin Browser",platform:"web"})});const session=normalizeAdminSession(result);if(!hasAdminSession(session))throw new Error("Verification could not complete sign in");clearInterval(timer);setAuth(session);startIdleGuard();setLoginStatus("Verified. Opening the console...","success");location.href="/dashboard/";}catch(error){if(error.payload?.details?.remainingAttempts!==undefined)challenge.remainingAttempts=error.payload.details.remainingAttempts;update();setLoginStatus(adminErrorMessage(error.message),"error");document.getElementById("admin-email-otp")?.select();}});
  resend?.addEventListener("click",async()=>{resend.disabled=true;try{const result=await apiFetch("/auth/email-otp/resend",{method:"POST",body:JSON.stringify({challengeId:challenge.challengeId,deviceName:"Admin Browser"})});challenge={...challenge,...result};started=Date.now();duration=Number(challenge.expiresInSeconds||300)*1000;update();setLoginStatus("A new verification code has been queued.","success");}catch(error){setLoginStatus(adminErrorMessage(error.message),"error");update();}});
}

async function bootLogin() {
  if (!validateAdminHost()) return;
  const loginForm = document.getElementById("admin-login-form");
  const resetToggle = document.getElementById("show-reset");
  const resetCard = document.getElementById("reset-card");
  const resetRequestForm = document.getElementById("admin-reset-request-form");

  bindSignInControls();

  const existingAuth = getAuth();
  if (existingAuth?.accessToken) {
    try {
      await apiFetch("/admin/me");
      location.href = "/dashboard/";
      return;
    } catch {
      clearAuth();
    }
  }

  const storedNotice = sessionStorage.getItem("titopay_admin_notice");
  if (storedNotice) {
    setLoginStatus(storedNotice);
    sessionStorage.removeItem("titopay_admin_notice");
  }

  loginForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = adminLoginPayload(Object.fromEntries(new FormData(loginForm).entries()));
    setLoginStatus("Checking staff credentials...", "pending");
    setLoginPending(true);
    try {
      let result;
      try {
        result = await apiFetch("/admin/login", {
          method: "POST",
          body: JSON.stringify(data),
        });
      } catch (error) {
        if (!isAuthModeBlockedError(error.message)) throw error;
        result = await apiFetch("/auth/login", {
          method: "POST",
          body: JSON.stringify({ ...data, scope: "admin" }),
        });
      }
      if (result.otpRequired && result.authenticationMode === "email_otp" && result.challengeId) {
        beginAdminEmailOtp(result);
        setLoginPending(false);
        return;
      }
      const session = normalizeAdminSession(result);
      if (!hasAdminSession(session)) {
        setLoginStatus("Sign in failed. Please check the staff email and password, then try again.", "error");
        setLoginPending(false);
        return;
      }
      setAuth(session);
      startIdleGuard();
      setLoginStatus("Signed in. Opening the console...", "success");
      location.href = "/dashboard/";
    } catch (error) {
      setLoginStatus(adminErrorMessage(error.message), "error");
      setLoginPending(false);
      document.getElementById("password")?.focus();
    }
  });

  resetToggle?.addEventListener("click", () => {
    const open = resetCard.hidden;
    resetCard.hidden = !open;
    resetToggle.setAttribute("aria-expanded", open ? "true" : "false");
    resetToggle.textContent = open ? "Cancel password reset" : "Forgot password?";
    if (open) document.getElementById("reset-identifier")?.focus();
  });

  resetRequestForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(resetRequestForm).entries());
    setLoginStatus("Sending password reset instructions...", "pending");
    try {
      await apiFetch("/auth/password-reset", {
        method: "POST",
        body: JSON.stringify({ mode: "request", userType: "admin", identifier: data.identifier }),
      });
      setLoginStatus("If the account exists, password reset instructions have been sent.", "success");
      resetCard.hidden = true;
      resetToggle?.setAttribute("aria-expanded", "false");
      if (resetToggle) resetToggle.textContent = "Forgot password?";
      resetRequestForm.reset();
    } catch (error) {
      setLoginStatus(adminErrorMessage(error.message), "error");
    }
  });
}

function renderMetrics(metrics) {
  return `
    <section class="metrics-grid">
      ${metrics.map(([label, value]) => `
        <article class="metric-card">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(String(value))}</strong>
        </article>
      `).join("")}
    </section>
  `;
}

function renderRows(rows, columns, actions = () => "") {
  if (!rows.length) {
    return `<div class="empty"><strong>Nothing to show yet</strong><small>The TitoPay API returned no records for this view. Adjust the filters above, or refresh once the queue has activity.</small></div>`;
  }
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>${columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("")}<th>Actions</th></tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              ${columns.map((column) => `<td>${column.render ? column.render(row) : escapeHtml(row[column.key] ?? "")}</td>`).join("")}
              <td><div class="action-row">${actions(row)}</div></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function normalizeSearchText(value = "") {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function compactId(value = "") {
  const text = String(value || "");
  return text ? `${text.slice(0, 8)}...${text.slice(-4)}` : "-";
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" });
}

function pricingCategory(row = {}) {
  const text = `${row.service_code || ""} ${row.service_name || ""}`.toLowerCase();
  if (text.includes("bulk") || text.includes("distribution")) return "Enterprise Distribution";
  if (text.includes("business")) return "Business";
  if (text.includes("merchant") || text.includes("marketplace") || text.includes("ticket")) return "Merchant & Marketplace";
  if (text.includes("bank") || text.includes("withdraw") || text.includes("cash")) return "Cash-out & Bank Transfers";
  if (text.includes("wallet") || text.includes("top") || text.includes("transfer")) return "Wallet";
  if (text.includes("transaction") || text.includes("payment") || text.includes("qr")) return "Transactions";
  return "Personal";
}

function recordText(row = {}) {
  return normalizeSearchText(Object.values(row).join(" "));
}

function recordMatchesSubject(subject = {}, row = {}) {
  const subjectKeys = [
    subject.id,
    subject.user_id,
    subject.merchant_id,
    subject.wallet_id,
    subject.username,
    subject.email,
    subject.phone,
    subject.full_name,
    subject.business_name,
  ].filter(Boolean).map(normalizeSearchText);
  const rowText = recordText(row);
  return subjectKeys.some((key) => key && rowText.includes(key));
}

function profileInitials(row = {}) {
  const text = row.full_name || row.business_name || row.username || row.email || "TP";
  const parts = String(text).replace("@", "").split(/\s+|\./).filter(Boolean);
  return (parts[0]?.[0] || "T").toUpperCase() + (parts[1]?.[0] || parts[0]?.[1] || "P").toUpperCase();
}

function profileAvatarHtml(row = {}) {
  const src = row.profile_photo_url || row.business_logo_url || row.profilePhotoUrl || row.businessLogoUrl || "";
  if (src) return `<div class="profile-avatar"><img src="${escapeHtml(src)}" alt="${escapeHtml(row.full_name || row.business_name || "Profile")}"></div>`;
  return `<div class="profile-avatar">${escapeHtml(profileInitials(row))}</div>`;
}

function searchRecordLabel(type = "") {
  return {
    user: "Customer profile",
    merchant: "Merchant profile",
    wallet: "Wallet profile",
    transaction: "Transaction profile",
  }[type] || "Record profile";
}

function findSearchRecord(type, id) {
  const state = PAGE_EXPORTS.searchState || {};
  const lists = {
    user: state.users || [],
    merchant: state.merchants || [],
    wallet: state.wallets || [],
    transaction: state.transactions || [],
  };
  return (lists[type] || []).find((row) => String(row.id || row.reference) === String(id));
}

function updateSearchUserRecord(updatedUser = {}) {
  if (!updatedUser?.id) return;
  const state = PAGE_EXPORTS.searchState || {};
  state.users = (state.users || []).map((row) =>
    String(row.id) === String(updatedUser.id) ? { ...row, ...updatedUser } : row
  );
  PAGE_EXPORTS.searchState = state;
  if (Array.isArray(PAGE_EXPORTS.search)) {
    PAGE_EXPORTS.search = PAGE_EXPORTS.search.map((row) =>
      row.type === "user" && String(row.id) === String(updatedUser.id)
        ? { ...row, ...updatedUser, type: "user" }
        : row
    );
  }
}

function renderLinkedWallets(record = {}) {
  const wallets = (PAGE_EXPORTS.searchState?.wallets || []).filter((row) => recordMatchesSubject(record, row)).slice(0, 4);
  if (!wallets.length) return `<div class="empty compact-empty">No linked wallets found in the current result set.</div>`;
  return wallets.map((row) => `
    <article class="linked-record">
      <span>${escapeHtml(row.kind || row.account_type || "wallet")}</span>
      <strong>${money(row.available_balance)}</strong>
      <small>${escapeHtml(row.full_name || row.business_name || compactId(row.id))}</small>
    </article>
  `).join("");
}

function renderLinkedTransactions(record = {}) {
  const transactions = (PAGE_EXPORTS.searchState?.transactions || []).filter((row) => recordMatchesSubject(record, row)).slice(0, 5);
  if (!transactions.length) return `<div class="empty compact-empty">No linked transactions found in the current result set.</div>`;
  return transactions.map((row) => `
    <article class="linked-transaction">
      <div>
        <strong>${escapeHtml(row.service_name || row.service_code || "Transaction")}</strong>
        <small>${escapeHtml(row.reference || compactId(row.id))}</small>
      </div>
      <div>
        <strong>${money(row.amount)}</strong>
        <span class="chip ${chipClass(row.status)}">${escapeHtml(row.status || "-")}</span>
      </div>
    </article>
  `).join("");
}

function renderSearchDetail(type, id) {
  const record = findSearchRecord(type, id);
  if (!record) {
    return tableCard("Record Details", `<div class="empty">Select a search result to view profile, wallet and transaction context.</div>`);
  }
  const title = record.full_name || record.business_name || record.reference || compactId(record.id);
  const subtitle = record.username || record.email || record.phone || record.service_name || searchRecordLabel(type);
  return `
    <section class="profile-detail-card">
      <div class="profile-detail-hero">
        ${profileAvatarHtml(record)}
        <div>
          <p class="eyebrow">${escapeHtml(searchRecordLabel(type))}</p>
          <h3>${escapeHtml(title || "-")}</h3>
          <p>${escapeHtml(subtitle || "-")}</p>
        </div>
        <span class="chip ${chipClass(record.status || record.fica_status || record.verification_status)}">${escapeHtml(record.status || record.fica_status || record.verification_status || "active")}</span>
      </div>
      <div class="profile-facts">
        <span><small>Email</small><strong>${escapeHtml(record.email || "-")}</strong></span>
        <span><small>Mobile</small><strong>${escapeHtml(record.phone || "-")}</strong></span>
        <span><small>Wallet ID</small><strong>${escapeHtml(record.wallet_id || (record.kind ? record.id : "-"))}</strong></span>
        <span><small>Business</small><strong>${escapeHtml(record.business_name || "-")}</strong></span>
        <span><small>FICA / Verification</small><strong>${escapeHtml(record.fica_status || record.verification_status || "-")}</strong></span>
        <span><small>Wallet Type</small><strong>${escapeHtml(record.wallet_type || record.kind || record.account_type || "-")}</strong></span>
        <span><small>Recent Transactions</small><strong>${escapeHtml(record.recent_transactions ?? "-")}</strong></span>
        <span><small>Linked Devices</small><strong>${escapeHtml(record.linked_devices ?? "-")}</strong></span>
        <span><small>Risk Flags</small><strong>${escapeHtml(Array.isArray(record.risk_flags) && record.risk_flags.length ? record.risk_flags.join(", ") : "None")}</strong></span>
        <span><small>Reference</small><strong>${escapeHtml(record.reference || compactId(record.id))}</strong></span>
      </div>
      <div class="detail-grid">
        <article>
          <h4>Linked Wallets</h4>
          <div class="linked-record-grid">${renderLinkedWallets(record)}</div>
        </article>
        <article>
          <h4>Recent Activity</h4>
          <div class="linked-transaction-list">${renderLinkedTransactions(record)}</div>
        </article>
      </div>
    </section>
  `;
}

function providerDisplayName(key = "") {
  return {
    peach_payments: "Peach Payments",
    pos_provider: "Speedpoint / POS Provider",
    docfox: "DocFox",
    ott: "OTT",
    flash: "Flash",
    smtp: "Google Workspace SMTP",
    sms: "SMS Provider",
  }[key] || key.replaceAll("_", " ");
}

function providerSlug(key = "") {
  return {
    peach_payments: "peach-payments",
    pos_provider: "pos-provider",
    docfox: "docfox",
    flash: "flash",
    ott: "ott",
    smtp: "email-smtp",
    sms: "sms-provider",
  }[key] || String(key).replaceAll("_", "-");
}

function providerKeyFromPath() {
  const path = location.pathname.toLowerCase();
  const slug = path.split("/").filter(Boolean).at(-1);
  const map = {
    "peach-payments": "peach_payments",
    "pos-provider": "pos_provider",
    docfox: "docfox",
    flash: "flash",
    ott: "ott",
    "email-smtp": "smtp",
    "sms-provider": "sms",
  };
  return map[slug] || slug?.replaceAll("-", "_") || "";
}

function downloadText(filename, content, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function downloadDataUrl(filename, dataUrl) {
  if (!dataUrl) {
    showToast("QR asset is not ready for download");
    return;
  }
  try {
    const [header, base64] = dataUrl.split(",");
    const mime = header.match(/data:(.*?);base64/)?.[1] || "application/octet-stream";
    const bytes = atob(base64 || "");
    const buffer = new Uint8Array(bytes.length);
    for (let index = 0; index < bytes.length; index += 1) buffer[index] = bytes.charCodeAt(index);
    const blob = new Blob([buffer], { type: mime });
    downloadText(filename, blob, mime);
    return;
  } catch (_error) {
    // Fall back to a direct data URL for older browsers.
  }
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function printQrAsset(asset = {}) {
  const win = window.open("", "_blank", "noopener,noreferrer");
  if (!win) {
    showToast("Allow pop-ups to print QR assets");
    return;
  }
  win.document.write(`
    <!doctype html>
    <html><head><title>${escapeHtml(asset.label || "TitoPay QR Asset")}</title>
    <style>
      body{font-family:Inter,Arial,sans-serif;margin:0;padding:40px;color:#061a3d}
      .sheet{max-width:720px;margin:0 auto;border:1px solid #dbe6f7;border-radius:28px;padding:34px;text-align:center}
      h1{margin:0 0 8px;font-size:30px} p{color:#66748f}
      img{width:320px;max-width:80%;height:auto;margin:24px auto;display:block}
      .brand{font-weight:900;color:#0057ff;letter-spacing:.08em;text-transform:uppercase}
    </style></head><body>
      <main class="sheet">
        <div class="brand">TitoPay</div>
        <h1>${escapeHtml(asset.label || "QR Asset")}</h1>
        <p>${escapeHtml(asset.destinationUrl || "")}</p>
        <img alt="TitoPay QR" src="${asset.pngDataUrl}">
        <p>Generated ${new Date().toLocaleString("en-ZA")}</p>
      </main>
      <script>window.print();</script>
    </body></html>
  `);
  win.document.close();
}

/* Shortcuts are read back out of the rendered sidebar so they can only ever
   offer modules this signed-in role is actually permitted to open. */
function dashboardQuickLinks(limit = 6) {
  const links = Array.from(document.querySelectorAll("#admin-nav .nav-link"))
    // Alerts is excluded: the topbar bell already reaches it from every page,
    // and including it here pushed Wallets out of the six quick links.
    .filter((link) => link.dataset.navSlug !== "dashboard" && link.dataset.navSlug !== "alerts")
    .slice(0, limit)
    .map((link) => `<a href="${escapeHtml(link.getAttribute("href"))}">${escapeHtml(link.textContent.trim())}</a>`)
    .join("");
  return links ? `<div class="quick-link-grid">${links}</div>` : "";
}

/* == Dashboard ============================================================
   The operational overview an operator lands on. It keeps the four figures the
   previous build showed and the endpoint that produced them, then fills the
   rest of the board from modules that were already live. The first paint is
   driven by /admin/dashboard/overview alone, exactly as before; everything
   else arrives afterwards and never blocks it.

   A card whose source did not answer shows a dash. Nothing here is estimated.
   ======================================================================== */

function dashboardTile(label, value, meta = "", tone = "", id = "") {
  const known = value !== null && value !== undefined && value !== "";
  return `
    <article class="metric-card"${id ? ` id="${escapeHtml(id)}"` : ""}>
      ${tone ? `<span class="metric-indicator ${escapeHtml(tone)}" aria-hidden="true"></span>` : ""}
      <span>${escapeHtml(label)}</span>
      <strong>${known ? escapeHtml(String(value)) : "—"}</strong>
      <small class="metric-meta">${escapeHtml(meta)}</small>
    </article>
  `;
}

function updateDashboardTile(id, value, meta, tone = "") {
  const tile = document.getElementById(id);
  if (!tile) return;
  const known = value !== null && value !== undefined && value !== "";
  tile.querySelector("strong").textContent = known ? String(value) : "—";
  const metaNode = tile.querySelector(".metric-meta");
  if (metaNode) metaNode.textContent = meta || "";
  tile.querySelector(".metric-indicator")?.remove();
  if (tone) {
    const indicator = document.createElement("span");
    indicator.className = `metric-indicator ${tone}`;
    indicator.setAttribute("aria-hidden", "true");
    tile.prepend(indicator);
  }
}

function dashboardStatusRow(label, value, tone = "neutral", detail = "") {
  const chipTone = { ok: "green", warn: "orange", bad: "red", info: "blue", neutral: "" }[tone] || "";
  return `
    <div class="tp-health-row">
      <span class="tp-health-label">${escapeHtml(label)}</span>
      <span class="tp-health-value">
        <span class="chip ${chipTone}">${escapeHtml(value)}</span>
        ${detail ? `<small>${escapeHtml(detail)}</small>` : ""}
      </span>
    </div>
  `;
}

function dashboardActivityList(events) {
  if (!events.length) {
    return `<div class="empty"><strong>No recent activity</strong><small>Administrative actions appear here as they are written to the audit log.</small></div>`;
  }
  return `
    <ol class="tp-activity">
      ${events.map((event) => `
        <li>
          <span class="tp-activity-dot ${escapeHtml(event.tone || "")}" aria-hidden="true"></span>
          <span class="tp-activity-body">
            <strong>${escapeHtml(event.action)}</strong>
            <small>${escapeHtml(event.detail)}</small>
          </span>
          <time>${escapeHtml(event.when)}</time>
        </li>
      `).join("")}
    </ol>
  `;
}

function dashboardRelativeTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "-";
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toLocaleDateString("en-ZA", { day: "2-digit", month: "short" });
}

/* Best-effort read. A module that does not answer leaves its cards blank
   rather than taking the dashboard down with it. */
async function dashboardSource(path) {
  try {
    return { ok: true, data: await apiFetch(path) };
  } catch {
    return { ok: false, data: null };
  }
}

async function renderDashboard(me) {
  const overview = await apiFetch("/admin/dashboard/overview");
  const page = document.getElementById("page-content");
  const lockedProfiles = Number(overview.lockedProfiles || 0);
  const pendingCompliance = Number(overview.pendingCompliance || 0);
  const attention = lockedProfiles + pendingCompliance;

  page.innerHTML = `
    <section class="metrics-grid">
      ${dashboardTile("Users", overview.users, "Registered accounts")}
      ${dashboardTile("Merchants", overview.merchants, "Businesses on the platform")}
      ${dashboardTile("Transactions", overview.transactions, "Processed to date")}
      ${dashboardTile("Revenue", money(overview.revenue), "Recorded platform revenue")}
    </section>
    <section class="metrics-grid" id="dashboard-secondary">
      ${dashboardTile("Wallet Float", null, "Loading wallet balances", "", "tile-wallet-float")}
      ${dashboardTile("Active Sessions", null, "Loading session activity", "", "tile-sessions")}
      ${dashboardTile("Pending KYC", pendingCompliance, "Awaiting a compliance decision", pendingCompliance ? "orange" : "green", "tile-kyc")}
      ${dashboardTile("Open Tickets", null, "Loading support queue", "", "tile-tickets")}
    </section>
    <section class="admin-dashboard-grid">
      <article class="panel">
        <h3>Needs attention</h3>
        <p>Queues that require an operator decision before they clear.</p>
        <div class="ops-list ops-list-two">
          <span>
            <span>Locked profiles</span>
            <strong>${escapeHtml(String(lockedProfiles))}</strong>
          </span>
          <span>
            <span>Pending compliance reviews</span>
            <strong>${escapeHtml(String(pendingCompliance))}</strong>
          </span>
          <span>
            <span>Merchants awaiting verification</span>
            <strong id="dashboard-merchant-pending">—</strong>
          </span>
          <span>
            <span>Security events flagged</span>
            <strong id="dashboard-fraud-alerts">—</strong>
          </span>
        </div>
        <p class="table-card-note">${attention
          ? `${attention} item${attention === 1 ? "" : "s"} open across the review queues.`
          : "All review queues are clear."}</p>
        ${dashboardQuickLinks()}
      </article>
      <article class="panel">
        <h3>Platform health</h3>
        <p>Live status of the API, the database and the connected providers.</p>
        <div class="tp-health-list" id="dashboard-health">
          ${dashboardStatusRow("API", "Responding", "ok", "Overview request answered")}
          ${dashboardStatusRow("Database", "Checking", "info", "")}
          ${dashboardStatusRow("Providers", "Checking", "info", "")}
        </div>
        ${renderKeyValueList([
          ["Role", adminPositionLabel(me.role)],
          ["Environment", adminEnvironment().label],
          ["Access", hasFullAdminAccess(me) ? "Full platform access" : `${(me.permissions || []).length} scoped permissions`],
        ])}
        <p class="table-card-note">The customer PWA stays isolated: the admin console and the TitoPay API operate as separate layers, and every sensitive action here is written to the audit log.</p>
      </article>
    </section>
    <section class="table-card">
      <div class="table-card-header">
        <div>
          <h3>Live activity</h3>
          <p class="table-card-note">The most recent administrative actions written to the audit log.</p>
        </div>
        <a class="table-card-meta" href="/audit/">Open audit log</a>
      </div>
      <div id="dashboard-activity"><div class="admin-skeleton admin-skeleton-inline" aria-hidden="true"><span></span></div></div>
    </section>
  `;

  // Deliberately not awaited: the four primary figures are already on screen,
  // so the first paint is no slower than it was before this board existed.
  hydrateDashboard().catch(() => {
    ["tile-wallet-float", "tile-sessions", "tile-tickets"].forEach((id) => updateDashboardTile(id, null, "Module unavailable"));
    const activity = document.getElementById("dashboard-activity");
    if (activity) activity.innerHTML = dashboardActivityList([]);
  });
}

async function hydrateDashboard() {
  const [wallets, merchants, tickets, security, health, audit, providers] = await Promise.all([
    dashboardSource("/admin/wallets"),
    dashboardSource("/admin/merchants"),
    dashboardSource("/admin/support/tickets"),
    dashboardSource("/admin/security"),
    dashboardSource("/admin/module-health"),
    dashboardSource("/admin/audit"),
    dashboardSource("/admin/integrations/config"),
  ]);

  // The operator may have navigated away while these were in flight.
  if (!document.getElementById("dashboard-secondary")) return;

  const walletRows = wallets.ok ? (wallets.data.items || []) : null;
  const merchantRows = merchants.ok ? (merchants.data.items || []) : null;
  const ticketRows = tickets.ok ? (tickets.data.items || []) : null;
  const sessions = security.ok ? (security.data.adminSessions || []) : null;
  const tables = health.ok ? (health.data.tables || []) : null;
  const auditRows = audit.ok ? (audit.data.items || []) : null;
  const providerRows = providers.ok ? (providers.data.items || providers.data.providers || []) : null;

  const walletFloat = walletRows
    ? walletRows.reduce((total, row) => total + Number(row.available_balance || 0) + Number(row.reserved_balance || 0), 0)
    : null;
  const activeSessions = sessions ? sessions.filter((row) => !row.revoked_at).length : null;
  const openTickets = ticketRows
    ? ticketRows.filter((row) => ["open", "in_progress", "pending"].includes(String(row.status || "").toLowerCase())).length
    : null;
  const pendingMerchants = merchantRows
    ? merchantRows.filter((row) => String(row.verification_status || "").toLowerCase() !== "verified").length
    : null;
  const flaggedEvents = auditRows
    ? auditRows.filter((row) => /fraud|suspicious|alert|blocked|abuse|lock|revoke/i.test(String(row.action || ""))).length
    : null;

  updateDashboardTile("tile-wallet-float", walletFloat === null ? null : money(walletFloat), walletRows ? `Across ${walletRows.length} wallets` : "Wallet module unavailable");
  updateDashboardTile("tile-sessions", activeSessions, sessions ? "Staff sessions not revoked" : "Security module unavailable");
  updateDashboardTile("tile-tickets", openTickets, ticketRows ? `${ticketRows.length} tickets on record` : "Support module unavailable", openTickets ? "orange" : openTickets === 0 ? "green" : "");

  setDashboardText("dashboard-merchant-pending", pendingMerchants === null ? "—" : String(pendingMerchants));
  setDashboardText("dashboard-fraud-alerts", flaggedEvents === null ? "—" : String(flaggedEvents));

  const healthHost = document.getElementById("dashboard-health");
  if (healthHost) {
    const present = tables ? tables.filter((row) => row.exists).length : 0;
    const missing = tables ? tables.length - present : 0;
    const providersLive = providerRows
      ? providerRows.filter((row) => ["active", "enabled", "live", "connected", "ok", "configured"].includes(String(row.status || row.state || "").toLowerCase())).length
      : null;
    healthHost.innerHTML = `
      ${dashboardStatusRow("API", "Responding", "ok", "Overview request answered")}
      ${tables
        ? dashboardStatusRow("Database", missing ? `${missing} table${missing === 1 ? "" : "s"} missing` : "All tables present", missing ? "bad" : "ok", `${present} of ${tables.length} required tables`)
        : dashboardStatusRow("Database", "Not reported", "neutral", "Health module did not answer")}
      ${providerRows
        ? dashboardStatusRow("Providers", `${providersLive} of ${providerRows.length} active`, providersLive === providerRows.length ? "ok" : providersLive ? "warn" : "bad", "Third-party integrations")
        : dashboardStatusRow("Providers", "Not reported", "neutral", "Integration module did not answer")}
      ${sessions
        ? dashboardStatusRow("Sessions", `${activeSessions} active`, "info", `${sessions.length} on record`)
        : dashboardStatusRow("Sessions", "Not reported", "neutral", "Security module did not answer")}
    `;
  }

  const activityHost = document.getElementById("dashboard-activity");
  if (activityHost) {
    const events = (auditRows || []).slice(0, 8).map((row) => {
      const action = String(row.action || "action").replace(/[_-]+/g, " ");
      const critical = /fraud|suspicious|blocked|lock|revoke|delete|reverse/i.test(action);
      return {
        action: action.replace(/\b\w/g, (letter) => letter.toUpperCase()),
        detail: [row.actor_type, row.target_type, row.target_id].filter(Boolean).join(" · ") || "Platform event",
        when: dashboardRelativeTime(row.created_at),
        tone: critical ? "bad" : "ok",
      };
    });
    activityHost.innerHTML = dashboardActivityList(events);
  }
}

function setDashboardText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

const SEARCH_TABS = [
  ["people", "People"],
  ["businesses", "Businesses"],
  ["wallets", "Wallets"],
  ["transactions", "Transactions"],
];

/* Global Search has the same two modes as the Support Desk: a result list, and
   the record you picked. Showing four result tables plus a detail card at once
   meant the answer to a search was never the thing you were looking at. */
async function renderSearch() {
  const result = await apiFetch("/admin/global-search");
  PAGE_EXPORTS.searchState = {
    users: result.users || result.items?.users || [],
    merchants: result.merchants || result.items?.merchants || [],
    wallets: result.wallets || result.items?.wallets || [],
    transactions: result.transactions || result.items?.transactions || [],
  };
  PAGE_EXPORTS.searchQuery = "";
  PAGE_EXPORTS.openSearchRecord = null;
  renderSearchView();
}

function searchMatches(query) {
  const state = PAGE_EXPORTS.searchState || { users: [], merchants: [], wallets: [], transactions: [] };
  const q = normalizeSearchText(query);
  const match = (row, fields) => normalizeSearchText(fields.map((f) => row[f]).join(" ")).includes(q);
  return {
    people: !q ? state.users.slice(0, 25) : state.users.filter((row) => match(row, ["full_name", "username", "email", "phone", "wallet_id", "business_name", "fica_status", "id"])),
    businesses: !q ? state.merchants.slice(0, 25) : state.merchants.filter((row) => match(row, ["business_name", "username", "email", "phone", "id"])),
    wallets: !q ? state.wallets.slice(0, 25) : state.wallets.filter((row) => match(row, ["id", "kind", "full_name", "business_name", "username", "status"])),
    transactions: !q ? state.transactions.slice(0, 25) : state.transactions.filter((row) => match(row, ["reference", "service_name", "service_code", "status", "id"])),
  };
}

function renderSearchView() {
  const page = document.getElementById("page-content");
  if (!page) return;
  const query = PAGE_EXPORTS.searchQuery || "";
  const found = searchMatches(query);

  PAGE_EXPORTS.search = [
    ...found.people.map((row) => ({ type: "user", ...row })),
    ...found.businesses.map((row) => ({ type: "merchant", ...row })),
    ...found.wallets.map((row) => ({ type: "wallet", ...row })),
    ...found.transactions.map((row) => ({ type: "transaction", ...row })),
  ];

  const searchBar = `
    <section class="panel search-panel">
      <form id="global-search-form" class="search-form">
        <div class="field">
          <label for="global-search-input">Search customers, businesses, wallets and transactions</label>
          <input id="global-search-input" name="query" value="${escapeHtml(query)}" placeholder="Name, @username, +27 number, email, wallet ID, reference..." autocomplete="off" spellcheck="false">
        </div>
        <button class="primary-btn" type="submit">Search</button>
      </form>
    </section>
  `;

  const open = PAGE_EXPORTS.openSearchRecord;
  if (open) {
    page.innerHTML = `
      ${searchBar}
      <section class="table-card">
        <div class="action-row"><button class="secondary-btn" type="button" data-search-back>&larr; Back to results</button></div>
      </section>
      <div id="search-detail-host">${renderSearchDetail(open.type, open.id)}</div>
    `;
    bindSearchForm();
    return;
  }

  const total = found.people.length + found.businesses.length + found.wallets.length + found.transactions.length;
  const tab = SEARCH_TABS.some(([key]) => key === PAGE_EXPORTS.searchTab) ? PAGE_EXPORTS.searchTab : "people";

  const panels = {
    people: () => renderRows(found.people, [
      { label: "Customer", render: (row) => `<div class="mini-profile">${profileAvatarHtml(row)}<span><strong>${escapeHtml(row.full_name || "-")}</strong><br><small>${escapeHtml(row.username || "-")}</small></span></div>` },
      { label: "Contact", render: (row) => `${escapeHtml(row.phone || "-")}<br><small>${escapeHtml(row.email || "-")}</small>` },
      { label: "Wallet", render: (row) => `<strong>${escapeHtml(row.wallet_id ? compactId(row.wallet_id) : "-")}</strong><br><small>${escapeHtml(row.wallet_type || row.account_type || "-")}</small>` },
      { label: "Verification", render: (row) => `<span class="chip ${chipClass(row.fica_status)}">${escapeHtml(row.fica_status || "Not submitted")}</span>` },
    ], (row) => `<button data-search-detail="user" data-search-id="${escapeHtml(row.id)}">Open</button>`),

    businesses: () => renderRows(found.businesses, [
      { label: "Business", render: (row) => `<strong>${escapeHtml(row.business_name || "-")}</strong><br><small>${escapeHtml(row.username || "-")}</small>` },
      { label: "Contact", render: (row) => `${escapeHtml(row.email || "-")}<br><small>${escapeHtml(row.phone || "-")}</small>` },
      { label: "Verification", render: (row) => `<span class="chip ${chipClass(row.verification_status)}">${escapeHtml(row.verification_status || "-")}</span>` },
      { label: "Status", render: (row) => `<span class="chip ${chipClass(row.status)}">${escapeHtml(row.status || "-")}</span>` },
    ], (row) => `<button data-search-detail="merchant" data-search-id="${escapeHtml(row.id)}">Open</button>`),

    wallets: () => renderRows(found.wallets, [
      { label: "Wallet", render: (row) => `<strong>${escapeHtml(row.wallet_number || compactId(row.id))}</strong><br><small>${escapeHtml(row.kind || "-")}</small>` },
      { label: "Owner", render: (row) => `${escapeHtml(row.full_name || row.business_name || "System")}<br><small>${escapeHtml(row.username || "-")}</small>` },
      { label: "Available", render: (row) => money(row.available_balance) },
      { label: "Reserved", render: (row) => money(row.reserved_balance) },
    ], (row) => `<button data-search-detail="wallet" data-search-id="${escapeHtml(row.id)}">Open</button>`),

    transactions: () => renderRows(found.transactions, [
      { label: "Reference", render: (row) => `<strong>${escapeHtml(row.reference || "-")}</strong>` },
      { label: "Service", render: (row) => `<strong>${escapeHtml(row.service_name || "-")}</strong><br><small>${escapeHtml(row.service_code || "-")}</small>` },
      { label: "Amount", render: (row) => money(row.amount) },
      { label: "Status", render: (row) => `<span class="chip ${chipClass(row.status)}">${escapeHtml(row.status || "-")}</span>` },
    ], (row) => `<button data-search-detail="transaction" data-search-id="${escapeHtml(row.id || row.reference)}">Open</button>`),
  };

  page.innerHTML = `
    ${searchBar}
    <section class="table-card">
      <nav class="segmented" aria-label="Result types">
        ${SEARCH_TABS.map(([key, label]) => `
          <button type="button" class="segmented-btn ${tab === key ? "active" : ""}" data-search-tab="${key}" aria-pressed="${tab === key}">
            ${escapeHtml(label)}${found[key].length ? `<span class="segmented-count">${found[key].length}</span>` : ""}
          </button>
        `).join("")}
      </nav>
      ${total ? panels[tab]() : `<div class="empty">${query ? "No TitoPay record matches that search." : "Search above to find a customer, business, wallet or transaction."}</div>`}
    </section>
  `;
  bindSearchForm();
}

function bindSearchForm() {
  const form = document.getElementById("global-search-form");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    PAGE_EXPORTS.searchQuery = String(new FormData(event.currentTarget).get("query") || "");
    PAGE_EXPORTS.openSearchRecord = null;
    renderSearchView();
    document.getElementById("global-search-input")?.focus();
  });
}

async function renderUsers() {
  const result = await apiFetch("/admin/users");
  const items = result.items || [];
  PAGE_EXPORTS.users = items;
  const renderUserTable = (rows) => tableCard(
    "Customer Accounts",
    renderRows(rows, [
      { label: "User", render: (row) => `<strong>${escapeHtml(row.full_name)}</strong><br><small>${escapeHtml(row.username)}</small>` },
      { label: "Type", render: (row) => `<span class="chip blue">${escapeHtml(row.account_type)}</span>` },
      { label: "Wallet ID", render: (row) => `<strong>${escapeHtml(row.wallet_id || row.wallet_number || "-")}</strong><br><small>${escapeHtml(row.wallet_type || row.account_type || "-")}</small>` },
      { label: "Contact", render: (row) => `${escapeHtml(row.email || "-")}<br><small>${escapeHtml(row.phone || "-")}</small>` },
      { label: "FICA", render: (row) => `<span class="chip ${chipClass(row.fica_status)}">${escapeHtml(row.fica_status || "Not submitted")}</span>` },
      { label: "Authentication", render: (row) => `<strong>${escapeHtml(row.preferred_authentication_method || "PUSH")}</strong><br><small>${escapeHtml(row.authentication_verification_status || "-")}</small><br><small>Updated ${formatDate(row.authentication_method_updated_at)}</small><br><small>Success ${formatDate(row.last_successful_authentication_at)}</small><br><small>Failed ${formatDate(row.last_failed_authentication_at)}</small>` },
      { label: "Status", render: (row) => `<span class="chip ${chipClass(row.status)}">${escapeHtml(row.status)}</span>` },
      { label: "Profile Lock", render: (row) => `<span class="chip ${row.profile_locked ? "red" : "green"}">${row.profile_locked ? "Locked" : "Open"}</span>` },
    ], (row) => `
      <button data-user-refresh="${escapeHtml(row.id)}">Refresh</button>
      <button data-user-action="${row.status === "suspended" ? "activate" : "suspend"}" data-user-id="${row.id}">${row.status === "suspended" ? "Activate" : "Suspend"}</button>
      <button data-user-action="${row.profile_locked ? "unlock" : "lock"}" data-user-id="${row.id}">${row.profile_locked ? "Unlock" : "Lock"}</button>
    `)
  );
  document.getElementById("page-content").innerHTML = `
    <section class="panel search-panel">
      <h3>User Search</h3>
      <p>Search by name, username, cellphone, email, wallet ID, account type or FICA status.</p>
      <form id="user-search-form" class="search-form">
        <div class="field"><label>Search users</label><input name="query" placeholder="Name, @username, +27, email, wallet ID..." autocomplete="off"></div>
        <button class="primary-btn" type="submit">Search</button>
      </form>
    </section>
    <div id="user-results">${renderUserTable(items)}</div>
  `;
  document.getElementById("user-search-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = normalizeSearchText(new FormData(event.currentTarget).get("query"));
    const rows = !query ? items : items.filter((row) => normalizeSearchText([
      row.full_name,
      row.username,
      row.email,
      row.phone,
      row.wallet_id,
      row.wallet_number,
      row.account_type,
      row.fica_status,
      row.status,
      row.business_name
    ].join(" ")).includes(query));
    document.getElementById("user-results").innerHTML = renderUserTable(rows);
  });
}

async function renderMerchants() {
  const result = await apiFetch("/admin/merchants");
  PAGE_EXPORTS.merchants = result.items;
  document.getElementById("page-content").innerHTML = tableCard(
    "Merchants",
    renderRows(result.items, [
      { label: "Business", render: (row) => `<strong>${escapeHtml(row.business_name)}</strong><br><small>${escapeHtml(row.username)}</small>` },
      { label: "Verification", render: (row) => `<span class="chip ${chipClass(row.verification_status)}">${escapeHtml(row.verification_status)}</span>` },
      { label: "Contact", render: (row) => `${escapeHtml(row.email || "-")}<br><small>${escapeHtml(row.phone || "-")}</small>` },
      { label: "Status", render: (row) => `<span class="chip ${chipClass(row.status)}">${escapeHtml(row.status)}</span>` },
    ], (row) => row.verification_status !== "verified" ? `<button data-merchant-verify="${row.id}">Verify</button>` : "")
  );
}

function getTransactionFilterValues() {
  const form = document.getElementById("transaction-filters");
  if (!form) return {};
  const data = new FormData(form);
  return Object.fromEntries(["search", "status", "service", "from", "to", "limit"].map((key) => [key, String(data.get(key) || "").trim()]));
}

function transactionFilterQuery(filters = getTransactionFilterValues()) {
  const params = new URLSearchParams();
  ["search", "status", "service", "from", "to", "limit"].forEach((key) => {
    const value = String(filters[key] || "").trim();
    if (value) params.set(key, value);
  });
  const query = params.toString();
  return query ? `?${query}` : "";
}

function transactionFiltersHtml(rows = [], filters = {}) {
  const serviceCodes = [...new Set([...rows.map((row) => row.service_code), filters.service].filter(Boolean))].sort();
  return `
    <form id="transaction-filters" class="admin-filter-grid">
      <label>
        Search
        <input name="search" type="search" placeholder="Reference, user, wallet, phone, merchant" value="${escapeHtml(filters.search || "")}">
      </label>
      <label>
        Status
        <select name="status">
          ${["", "completed", "pending", "processing", "failed", "reversed"].map((status) => `<option value="${escapeHtml(status)}" ${String(filters.status || "") === status ? "selected" : ""}>${escapeHtml(status || "All statuses")}</option>`).join("")}
        </select>
      </label>
      <label>
        Service
        <select name="service">
          <option value="">All services</option>
          ${serviceCodes.map((code) => `<option value="${escapeHtml(code)}" ${String(filters.service || "") === code ? "selected" : ""}>${escapeHtml(code)}</option>`).join("")}
        </select>
      </label>
      <label>
        From
        <input name="from" type="date" value="${escapeHtml(filters.from || "")}">
      </label>
      <label>
        To
        <input name="to" type="date" value="${escapeHtml(filters.to || "")}">
      </label>
      <label>
        Rows
        <select name="limit">
          ${["1000", "250", "500", "2500", "5000"].map((limit) => `<option value="${limit}" ${String(filters.limit || "1000") === limit ? "selected" : ""}>${Number(limit).toLocaleString()}</option>`).join("")}
        </select>
      </label>
      <div class="admin-filter-actions">
        <button type="submit">Apply</button>
        <button class="secondary-btn" type="button" data-transaction-filter-reset>Reset</button>
      </div>
    </form>
  `;
}

async function renderTransactions() {
  const filters = getTransactionFilterValues();
  const result = await apiFetch(`/admin/transactions${transactionFilterQuery(filters)}`);
  const rows = result.items || [];
  PAGE_EXPORTS.transactions = rows;
  const totalFees = rows.reduce((sum, row) => sum + Number(row.fee || 0), 0);
  const totalRevenue = rows.reduce((sum, row) => sum + Number(row.revenue_recorded || 0), 0);
  const reviewCount = rows.filter((row) => row.reconciliation_status === "review").length;
  document.getElementById("page-content").innerHTML = tableCard(
    "All Transactions",
    `
      ${renderMetrics([
        ["Visible Rows", rows.length],
        ["Fees in View", money(totalFees)],
        ["Revenue Recorded", money(totalRevenue)],
        ["Needs Review", reviewCount],
      ])}
      ${transactionFiltersHtml(rows, filters)}
      ${renderRows(rows, [
      { label: "Reference", render: (row) => `<strong>${escapeHtml(row.reference)}</strong><br><small>${escapeHtml(new Date(row.created_at).toLocaleString())}</small>` },
      { label: "Owner", render: (row) => `<strong>${escapeHtml(row.owner_name || row.full_name || "-")}</strong><br><small>${escapeHtml(row.owner_identifier || row.wallet_number || "-")}</small>` },
      { label: "Wallet / Merchant", render: (row) => `<strong>${escapeHtml(row.wallet_number || compactId(row.wallet_id))}</strong><br><small>${escapeHtml(row.wallet_kind || row.account_type || "-")} ${row.merchant_number ? `• ${escapeHtml(row.merchant_number)}` : ""}</small>` },
      { label: "Service", render: (row) => `<strong>${escapeHtml(row.service_name || row.service_code)}</strong><br><small>${escapeHtml(row.service_code)}</small>` },
      { label: "Counterparty", render: (row) => `${escapeHtml(row.recipient_reference || "-")}<br><small>${escapeHtml(row.qr_reference || row.ticket_order_id || row.bulk_batch_id || "-")}</small>` },
      { label: "Amounts", render: (row) => `${money(row.amount)}<br><small>Fee ${money(row.fee)} • Total ${money(row.total)}</small>` },
      { label: "Revenue", render: (row) => `${money(row.revenue_recorded)}<br><small>${escapeHtml(row.financial_route || "-")}</small>` },
      { label: "Status", render: (row) => `<span class="chip ${chipClass(row.status)}">${escapeHtml(row.status)}</span>` },
      { label: "Reconciliation", render: (row) => `<span class="chip ${chipClass(row.reconciliation_status)}">${escapeHtml(row.reconciliation_status || "-")}</span>` },
    ], (row) => row.status !== "reversed" ? `<button data-transaction-reverse="${row.id}">Reverse</button>` : "")}
    `,
    "CEO and Finance can search all visible wallet, merchant, ticketing, QR and bulk-distribution transaction records from the production API.",
    `${rows.length} rows`
  );
}

async function renderWallets(me = {}) {
  const result = await apiFetch("/admin/wallets");
  const wallets = result.items || [];
  const canManageWallets = hasFullAdminAccess(me) || hasFullAdminAccess(PAGE_EXPORTS.currentMe || {});
  const personalWallets = wallets.filter((row) => row.account_type === "personal" || row.kind === "personal");
  const businessWallets = wallets.filter((row) => row.account_type === "business" || row.kind === "merchant" || row.kind === "business" || row.business_name);
  const platformWallets = wallets.filter((row) => !personalWallets.includes(row) && !businessWallets.includes(row));
  PAGE_EXPORTS.wallets = wallets;
  const walletColumns = [
    { label: "Wallet", render: (row) => `<strong>${escapeHtml(row.full_name || row.business_name || "System Wallet")}</strong><br><small>ID ${escapeHtml(row.wallet_id || row.wallet_number || compactId(row.id))}</small>` },
    { label: "Type", render: (row) => `<span class="chip blue">${escapeHtml(row.kind || row.account_type || "wallet")}</span>` },
    { label: "Balance", render: (row) => `${money(Number(row.available_balance || 0) + Number(row.reserved_balance || 0))}<br><small>Available ${money(row.available_balance)}</small>` },
    { label: "Pending / Limits", render: (row) => `${money(row.pending_balance ?? row.reserved_balance)}<br><small>${escapeHtml(row.limits || "-")}</small>` },
    { label: "Verification / Risk", render: (row) => `<span class="chip ${chipClass(row.verification)}">${escapeHtml(row.verification || "-")}</span><br><small>${escapeHtml(row.risk_rating || "low")} risk</small>` },
    { label: "Status", render: (row) => `<span class="chip ${chipClass(row.status)}">${escapeHtml(row.status || "active")}</span>` },
  ];
  const walletActions = (row) => canManageWallets ? `
    <button data-wallet-action="freeze" data-wallet-id="${escapeHtml(row.id)}">Freeze</button>
    <button data-wallet-action="suspend" data-wallet-id="${escapeHtml(row.id)}">Suspend</button>
    <button data-wallet-action="close" data-wallet-id="${escapeHtml(row.id)}">Close</button>
    <button data-wallet-action="activate" data-wallet-id="${escapeHtml(row.id)}">Activate</button>
  ` : "";
  document.getElementById("page-content").innerHTML = `
    ${renderMetrics([
      ["Personal Wallets", personalWallets.length],
      ["Business Wallets", businessWallets.length],
      ["Platform Wallets", platformWallets.length],
      ["Total Wallets", wallets.length],
    ])}
    <section class="wallet-section-stack">
      ${tableCard("Personal Wallets", renderRows(personalWallets, walletColumns, walletActions), "Customer wallets with balance, limits, verification, risk rating and status controls.")}
      ${tableCard("Business Wallets", renderRows(businessWallets, walletColumns, walletActions), "Merchant and business wallets used for payments, settlements and operational monitoring.")}
      ${tableCard("System & Revenue Wallets", renderRows(platformWallets, walletColumns, walletActions), "Internal TitoPay wallets for revenue, suspense and platform operations.")}
    </section>
  `;
}

const SUPPORT_TABS = [
  ["conversations", "Live conversations"],
  ["tickets", "Tickets"],
  ["approvals", "Profile approvals"],
];

/* The Support Desk has two modes. The queue lists work waiting to be picked up;
   opening a conversation replaces the queue entirely so the agent is
   unambiguously inside that chat, with one way back. Rendering the conversation
   below the queue meant taking over a chat left the agent still looking at the
   queue with the conversation off-screen. */
async function renderSupport() {
  captureSupportWorkspace();
  ensureAdminSupportSocket();
  const page = document.getElementById("page-content");
  if (!page) return;

  const openId = PAGE_EXPORTS.openSupportConversationId;
  if (openId) {
    try {
      const context = await apiFetch(`/admin/support/conversations/${openId}/context`);
      page.innerHTML = renderSupportConversationView(context);
      const composer = document.getElementById("support-agent-message");
      if (composer) {
        if (PAGE_EXPORTS.supportDraft) composer.value = PAGE_EXPORTS.supportDraft;
        if (PAGE_EXPORTS.supportDraftFocused !== false) {
          composer.focus({ preventScroll: true });
          const caret = Number(PAGE_EXPORTS.supportDraftCaret);
          if (Number.isFinite(caret)) composer.setSelectionRange(caret, caret);
        }
      }
      const thread = document.querySelector(".support-thread");
      if (thread) {
        const holdPosition = PAGE_EXPORTS.supportThreadPinned === false && !PAGE_EXPORTS.supportThreadForceBottom;
        if (!holdPosition) {
          // A forced jump also re-arms following, otherwise the next refresh
          // would restore the position the agent had scrolled away from.
          PAGE_EXPORTS.supportThreadPinned = true;
        }
        const target = () => {
          thread.scrollTop = holdPosition ? Number(PAGE_EXPORTS.supportThreadScroll) || 0 : thread.scrollHeight;
        };
        target();
        // Run again after layout: scrollHeight is not final in the same frame
        // the markup is written, which left the transcript sitting at the top.
        requestAnimationFrame(target);
      }
      PAGE_EXPORTS.supportThreadForceBottom = false;
      return;
    } catch (error) {
      PAGE_EXPORTS.openSupportConversationId = null;
      showToast(adminErrorMessage(error.message || "Unable to open that conversation."));
    }
  }

  const [ticketResult, conversationResult, profileChangeResult] = await Promise.all([
    apiFetch("/admin/support/tickets").catch(() => ({ items: [] })),
    apiFetch("/admin/support/conversations").catch(() => ({ items: [] })),
    apiFetch("/admin/profile-change-requests").catch(() => ({ items: [], metrics: {} })),
  ]);
  const tickets = ticketResult.items || [];
  const conversations = conversationResult.items || [];
  const counts = conversationResult.counts || {};
  const profileChanges = profileChangeResult.items || [];
  const openTickets = tickets.filter((row) => ["open", "in_progress", "pending"].includes(row.status)).length;
  const waiting = Number(counts.waiting ?? conversations.filter((row) => ["ESCALATED", "WAITING_FOR_AGENT"].includes(row.status)).length);
  const activeChats = Number(counts.active ?? conversations.filter((row) => ["AGENT_ACTIVE", "REOPENED"].includes(row.status)).length);
  const profilePending = profileChanges.filter((row) => ["pending", "in_review"].includes(row.status)).length;

  PAGE_EXPORTS.support = tickets.concat(conversations.map((row) => ({
    type: "chat",
    id: row.id,
    status: row.status,
    participant_a: row.participant_a?.username || row.participant_a?.email || row.participant_a?.phone,
    participant_b: row.participant_b?.username || row.participant_b?.email || row.participant_b?.phone,
    last_message: row.last_message,
    updated_at: row.updated_at,
  }))).concat(profileChanges.map((row) => ({
    type: "profile_change",
    id: row.id,
    status: row.status,
    user: row.user?.fullName || row.user?.username,
    fields: Object.keys(row.requestedChanges || {}).join(", "),
    due_at: row.dueAt
  })));

  const tab = SUPPORT_TABS.some(([key]) => key === PAGE_EXPORTS.supportTab)
    ? PAGE_EXPORTS.supportTab
    : "conversations";
  const tabCounts = { conversations: waiting + activeChats, tickets: openTickets, approvals: profilePending };
  const chatParticipant = (participant) => {
    if (!participant) return "-";
    const name = participant.full_name || participant.username || participant.email || participant.phone || "TitoPay user";
    const handle = participant.username ? `@${participant.username}` : participant.email || participant.phone || participant.account_type || "";
    return `<strong>${escapeHtml(name)}</strong><br><small>${escapeHtml(handle)}</small>`;
  };
  const assignedTo = (row) => row.assignedAgent?.name || row.metadata?.assigned_to || row.metadata?.assignedTo || "Unassigned";

  const panels = {
    conversations: () => renderRows(conversations, [
      { label: "Customer", render: (row) => chatParticipant(row.customer || row.participant_a) },
      { label: "Reference", render: (row) => `<strong>${escapeHtml(row.ticketRef || compactId(row.id))}</strong>` },
      { label: "Waiting", render: (row) => `<strong>${escapeHtml(monitorAge(row.waitingSeconds || 0))}</strong>` },
      { label: "Last message", render: (row) => `<small>${escapeHtml(String(row.last_message || "No messages yet").slice(0, 90))}</small>` },
      { label: "Status", render: (row) => `<span class="chip ${supportStatusClass(row.status)}">${escapeHtml(String(row.status || "WAITING_FOR_AGENT").replace(/_/g, " "))}</span><br><small>${escapeHtml(assignedTo(row))}</small>` },
    ], (row) => ["ESCALATED", "WAITING_FOR_AGENT"].includes(row.status)
      ? `<button data-support-chat-takeover="${escapeHtml(row.id)}">Take over</button>`
      : `<button data-support-chat-history="${escapeHtml(row.id)}">Open</button>`),

    tickets: () => renderRows(tickets, [
      { label: "Request", render: (row) => `<strong>${escapeHtml(row.subject)}</strong><br><small>${escapeHtml(row.category || "-")} · ${escapeHtml(new Date(row.created_at || Date.now()).toLocaleDateString("en-ZA"))}</small>` },
      { label: "Customer", render: (row) => `${escapeHtml(row.full_name || "-")}<br><small>${escapeHtml(row.username || "-")}</small>` },
      { label: "Details", render: (row) => `<small>${escapeHtml(String(row.message || "").slice(0, 120))}${String(row.message || "").length > 120 ? "..." : ""}</small>` },
      { label: "Assigned", render: (row) => escapeHtml(row.assigned_to || "Unassigned") },
      { label: "Status", render: (row) => `<span class="chip ${chipClass(row.status)}">${escapeHtml(row.status)}</span>` },
    ], (row) => `
      <button data-support-status="in_progress" data-support-id="${row.id}">Take over</button>
      <button data-support-status="resolved" data-support-id="${row.id}">Resolve</button>
    `),

    approvals: () => renderRows(profileChanges, [
      { label: "User", render: (row) => `<strong>${escapeHtml(row.user?.fullName || row.user?.username || "-")}</strong><br><small>${escapeHtml(row.user?.phone || row.user?.email || "-")}</small>` },
      { label: "Requested changes", render: (row) => Object.entries(row.requestedChanges || {}).map(([key, value]) => `<small><strong>${escapeHtml(key)}</strong>: ${escapeHtml(value)}</small>`).join("<br>") || "-" },
      { label: "SLA", render: (row) => `<strong>${escapeHtml(row.dueAt ? new Date(row.dueAt).toLocaleDateString("en-ZA") : "-")}</strong><br><small>${row.dueAt && new Date(row.dueAt).getTime() < Date.now() && ["pending", "in_review"].includes(row.status) ? "Overdue" : "72-hour review"}</small>` },
      { label: "Status", render: (row) => `<span class="chip ${chipClass(row.status)}">${escapeHtml(row.status || "pending")}</span>` },
    ], (row) => ["pending", "in_review"].includes(row.status) ? `
      <button data-profile-change-approve="${escapeHtml(row.id)}">Approve</button>
      <button data-profile-change-reject="${escapeHtml(row.id)}">Reject</button>
    ` : ""),
  };

  page.innerHTML = `
    ${renderMetrics([
      ["Waiting for an agent", waiting],
      ["Active chats", activeChats],
      ["Open tickets", openTickets],
      ["Profile approvals", profilePending],
    ])}
    <section class="table-card">
      <nav class="segmented" aria-label="Support queues">
        ${SUPPORT_TABS.map(([key, label]) => `
          <button type="button" class="segmented-btn ${tab === key ? "active" : ""}" data-support-tab="${key}" aria-pressed="${tab === key}">
            ${escapeHtml(label)}${tabCounts[key] ? `<span class="segmented-count">${tabCounts[key]}</span>` : ""}
          </button>
        `).join("")}
      </nav>
      ${panels[tab]()}
    </section>
  `;
}

function renderSupportConversationView(context = {}) {
  const conversation = context.conversation;
  if (!conversation) return `<div class="empty">This conversation is no longer available.</div>`;
  const status = String(conversation.status || "").toUpperCase();
  const canReply = ["AGENT_ACTIVE", "REOPENED"].includes(status);
  const notes = context.internalNotes || [];
  const id = escapeHtml(conversation.id);
  return `
    <section class="table-card support-workspace">
      <header class="support-workspace-head">
        <button class="secondary-btn" type="button" data-support-back>&larr; Back to queue</button>
        <div class="support-workspace-who">
          <strong>${escapeHtml(conversation.customer?.name || "Customer")}</strong>
          <small>${escapeHtml(conversation.customer?.accountIdentifier || conversation.customer?.username || "")}</small>
        </div>
        <span class="chip ${supportStatusClass(status)}">${escapeHtml(status.replace(/_/g, " "))}</span>
        <span class="support-workspace-meta">
          ${conversation.ticketRef ? `Ref <strong>${escapeHtml(conversation.ticketRef)}</strong> · ` : ""}
          Assigned to <strong>${escapeHtml(conversation.assignedAgent?.name || "nobody")}</strong>
        </span>
        <div class="action-row support-workspace-actions">
          ${["ESCALATED", "WAITING_FOR_AGENT"].includes(status) ? `<button data-support-chat-takeover="${id}">Take over</button>` : ""}
          ${canReply ? `
            <button data-support-chat-resolve="${id}">Resolve</button>
            <button data-support-chat-unassign="${id}">Release</button>
            <button data-support-chat-transfer="${id}">Transfer</button>
          ` : ""}
          ${status === "RESOLVED" ? `<button data-support-chat-reopen="${id}">Reopen</button><button data-support-chat-close="${id}">Close</button>` : ""}
          ${status === "CLOSED" ? `<button data-support-chat-reopen="${id}">Reopen</button>` : ""}
          <button data-support-chat-note="${id}">Add note</button>
        </div>
      </header>

      ${renderSupportThread(context.messages)}

      ${canReply ? `
        ${supportQuickReplyPanel()}
        <form id="support-agent-reply-form" class="support-composer" data-support-conversation-id="${id}">
          <div class="field">
            <label class="visually-hidden" for="support-agent-message">Reply to customer</label>
            <textarea id="support-agent-message" name="message" rows="3" maxlength="4000" placeholder="Type your reply. The customer sees it immediately." required></textarea>
          </div>
          <button class="primary-btn" type="submit">Send reply</button>
        </form>
      ` : `<p class="table-card-note">Take over this conversation before replying.</p>`}

      ${notes.length ? `
        <details class="support-notes">
          <summary>Internal notes (${notes.length}) — never shown to the customer</summary>
          <ul>
            ${notes.map((row) => `<li><strong>${escapeHtml(row.createdByLabel || row.createdBy || "Admin")}</strong> · ${escapeHtml(supportMessageTime(row.createdAt))}<br>${escapeHtml(row.note || "")}</li>`).join("")}
          </ul>
        </details>
      ` : ""}
    </section>
  `;
}

/* A support transcript is a conversation, not a dataset. Rendering it as a
   table forced an agent to read one message per row across four columns; this
   reads top to bottom the way the customer sees it. */
const SUPPORT_SENDER_LABELS = { CUSTOMER: "Customer", AGENT: "Support agent", BOT: "TitoPay Assistant", SYSTEM: "System" };

/* Customer Care quick replies. [Agent Name] is substituted with the signed-in
   operator's first name when the reply is inserted; the agent can still edit
   everything before sending - inserting never sends. */
const SUPPORT_QUICK_REPLIES = [
  { group: "Greeting & check-ins", title: "Greeting", text: "Welcome to TitoPay Customer Care. My name is [Agent Name], and I'll be assisting you today. How may I help you?" },
  { group: "Greeting & check-ins", title: "Inactive - 2 minutes", text: "Hi! Just checking in to see if you're still with us. I'm here and ready to assist whenever you're ready." },
  { group: "Greeting & check-ins", title: "Inactive - 4 minutes", text: "We haven't received a response yet. If you're still available, simply reply to this chat and we'll continue assisting you." },
  { group: "Greeting & check-ins", title: "Inactive - 5 minutes", text: "It looks like you've stepped away. We'll keep this conversation open for a little while longer. If you still need assistance, simply reply to this chat and we'll be happy to continue helping you." },
  { group: "Greeting & check-ins", title: "Final warning - 7 minutes", text: "As we haven't received a response, this conversation will automatically close in approximately 2 minutes. Reply to any message to keep the conversation active." },
  { group: "Greeting & check-ins", title: "Closed due to inactivity", text: "This conversation has been closed due to inactivity. If you still require assistance, simply start a new chat from the TitoPay app and one of our Customer Care Specialists will gladly assist you. Thank you for choosing TitoPay." },
  { group: "Investigation & escalation", title: "Requesting information", text: "To help us investigate your request, could you please provide the following information:\n\n\u2022 A brief description of the issue\n\u2022 The date and approximate time it occurred\n\u2022 Any relevant reference or transaction number\n\u2022 A screenshot, if available" },
  { group: "Investigation & escalation", title: "Waiting while investigating", text: "Thank you for your patience. We're currently reviewing your request. This may take a few moments, and we'll update you as soon as we have more information." },
  { group: "Investigation & escalation", title: "Unable to verify the account", text: "For your security, we're currently unable to verify your account with the information provided. Please provide the requested verification details so we can continue assisting you." },
  { group: "Investigation & escalation", title: "Escalating to another department", text: "Your request requires assistance from a specialist team. We've escalated your case, and you'll receive an update as soon as possible. Thank you for your patience." },
  { group: "Resolution & closing", title: "Issue resolved", text: "We're pleased to confirm that your request has been resolved. If you have any further questions or require additional assistance, please don't hesitate to contact us. Thank you for choosing TitoPay." },
  { group: "Resolution & closing", title: "Closing after resolution", text: "Thank you for contacting TitoPay Customer Care. We're glad we could assist you today. Have a wonderful day, and thank you for choosing TitoPay." },
];

function supportAgentFirstName() {
  const me = PAGE_EXPORTS.currentMe || {};
  const name = me.fullName || me.full_name || me.admin?.fullName || me.username || "";
  return String(name).trim().split(/\s+/)[0] || "";
}

function supportQuickReplyPanel() {
  const groups = [...new Set(SUPPORT_QUICK_REPLIES.map((reply) => reply.group))];
  return `
    <details class="support-quick-replies">
      <summary>Quick replies <span class="segmented-count">${SUPPORT_QUICK_REPLIES.length}</span></summary>
      <div class="sqr-body">
        ${groups.map((group) => `
          <div class="sqr-group">
            <span class="sqr-group-title">${escapeHtml(group)}</span>
            <div class="sqr-grid">
              ${SUPPORT_QUICK_REPLIES.map((reply, index) => reply.group === group ? `
                <button type="button" class="sqr-item" data-support-quick-reply="${index}" title="Insert into the reply box">
                  <strong>${escapeHtml(reply.title)}</strong>
                  <small>${escapeHtml(reply.text.replace(/\n/g, " ").slice(0, 84))}${reply.text.length > 84 ? "…" : ""}</small>
                </button>
              ` : "").join("")}
            </div>
          </div>
        `).join("")}
        <p class="sqr-note">Inserting fills the reply box - nothing is sent until you press Send reply, so you can adjust the wording first.</p>
      </div>
    </details>
  `;
}

function supportMessageTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("en-ZA", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function renderSupportThread(messages = []) {
  if (!messages.length) return `<div class="compact-empty">No messages in this conversation yet.</div>`;
  return `
    <ol class="support-thread">
      ${messages.map((row) => {
        const sender = String(row.senderType || row.sender_type || "SYSTEM").toUpperCase();
        const who = row.senderName || row.sender_name || SUPPORT_SENDER_LABELS[sender] || "TitoPay";
        const when = supportMessageTime(row.createdAt || row.created_at);
        return `
          <li class="support-msg" data-sender="${escapeHtml(sender.toLowerCase())}">
            <p class="support-msg-meta"><strong>${escapeHtml(who)}</strong>${when ? `<span>${escapeHtml(when)}</span>` : ""}</p>
            <p class="support-msg-body">${escapeHtml(row.body || row.message || "")}</p>
          </li>
        `;
      }).join("")}
    </ol>
  `;
}


/* The conversation workspace renders below the queue tables, so an agent who
   takes over or opens a chat would otherwise be left looking at the queue with
   the workspace off-screen. */
/* The draft reply is preserved across the re-renders that incoming support
   events trigger, so another agent's activity cannot wipe a half-typed reply. */
function captureSupportWorkspace() {
  const thread = document.querySelector(".support-thread");
  // A deliberate action (opening a chat, taking it over, sending a reply) asks
  // for the newest message and must not be overridden by wherever the agent
  // happened to be scrolled.
  if (thread && !PAGE_EXPORTS.supportThreadForceBottom) {
    // Standard chat behaviour otherwise: follow new messages only while the
    // reader is already at the bottom. Scrolling up to read earlier messages
    // must not be undone by the next incoming message or the ten-second poll.
    const distanceFromBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
    PAGE_EXPORTS.supportThreadPinned = distanceFromBottom <= 40;
    PAGE_EXPORTS.supportThreadScroll = thread.scrollTop;
  }
  const composer = document.getElementById("support-agent-message");
  if (!composer) return;
  PAGE_EXPORTS.supportDraft = composer.value;
  PAGE_EXPORTS.supportDraftCaret = composer.selectionStart;
  PAGE_EXPORTS.supportDraftFocused = document.activeElement === composer;
}

function monitorAge(seconds) {
  const value = Math.max(0, Number(seconds || 0));
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m`;
  if (value < 86400) return `${Math.floor(value / 3600)}h`;
  return `${Math.floor(value / 86400)}d`;
}

function monitorDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" });
}

function maskMonitorIp(value = "") {
  const text = String(value);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(text)) return text.replace(/\.\d+$/, ".•");
  return text.length > 12 ? `${text.slice(0, 12)}…` : text || "-";
}

async function renderChatMonitor() {
  const result = await apiFetch("/admin/chat-monitor/overview");
  const metrics = result.metrics || {};
  const onlineIds = new Set((result.onlineUsers || []).map((item) => String(item.userId)));
  PAGE_EXPORTS["chat-monitor"] = (result.conversations || []).map((row) => ({
    id: row.id,
    type: row.thread_type,
    status: row.status,
    participant_a: row.participant_a?.username || row.participant_a?.name,
    participant_b: row.participant_b?.username || row.participant_b?.name,
    messages: row.message_count,
    pending_delivery: row.pending_delivery_count,
    failed: row.failed_count,
    last_message_status: row.last_message_status,
    last_message_at: row.last_message_at
  }));
  const participant = (user = {}) => `
    <strong>${escapeHtml(user.name || user.username || "TitoPay user")}</strong><br>
    <small>${escapeHtml(user.username ? `@${user.username}` : user.accountType || "")}</small>
    ${onlineIds.has(String(user.id)) ? `<span class="monitor-online-label">Online</span>` : ""}
  `;
  const content = document.getElementById("page-content");
  if (!content) return;
  content.innerHTML = `
    <section class="monitor-toolbar">
      <div>
        <span class="monitor-live-dot" aria-hidden="true"></span>
        <strong>Live operational view</strong>
        <small>Updated ${escapeHtml(monitorDate(result.generatedAt))} · refreshes every 10 seconds</small>
      </div>
      <button class="secondary-btn" type="button" data-chat-monitor-refresh>Refresh now</button>
    </section>
    ${renderMetrics([
      ["Active conversations", metrics.activeConversations || 0],
      ["Active in 15 min", metrics.activeRecently || 0],
      ["Online users", metrics.onlineUsers || 0],
      ["Socket connections", metrics.activeConnections || 0],
      ["Failed deliveries", metrics.deliveryFailures || 0],
      ["Stale deliveries", metrics.staleDeliveries || 0],
      ["WebSocket failures (24h)", metrics.socketFailures24h || 0],
      ["Queued notifications", metrics.queuedNotifications || 0]
    ])}
    <section class="monitor-health-note">
      <strong>Privacy-safe monitoring</strong>
      <p>This view shows delivery metadata and account identity only. Message bodies are not loaded or displayed.</p>
    </section>
    ${tableCard("Active Conversations", renderRows(result.conversations || [], [
      { label: "Conversation", render: (row) => `<strong>${escapeHtml(row.thread_type || "direct")}</strong><br><small>${escapeHtml(compactId(row.id))}</small>` },
      { label: "Participant A", render: (row) => participant(row.participant_a) },
      { label: "Participant B", render: (row) => participant(row.participant_b) },
      { label: "Messages", render: (row) => escapeHtml(row.message_count || 0) },
      { label: "Delivery", render: (row) => `<span class="chip ${chipClass(row.last_message_status || "pending")}">${escapeHtml(row.last_message_status || "No messages")}</span><br><small>${escapeHtml(row.pending_delivery_count || 0)} pending · ${escapeHtml(row.failed_count || 0)} failed</small>` },
      { label: "Last activity", render: (row) => escapeHtml(monitorDate(row.last_message_at || row.updated_at)) }
    ]), "Operational metadata only; message content remains private.", `${(result.conversations || []).length} shown`)}
    <section class="panel-grid monitor-grid">
      ${tableCard("Online Users", renderRows(result.onlineUsers || [], [
        { label: "User", render: (row) => `<strong>${escapeHtml(row.name)}</strong><br><small>${escapeHtml(row.username ? `@${row.username}` : compactId(row.userId))}</small>` },
        { label: "Account", render: (row) => `<span class="chip blue">${escapeHtml(row.accountType || "personal")}</span>` },
        { label: "Verification", render: (row) => `<span class="chip ${chipClass(row.verificationStatus)}">${escapeHtml(row.verificationStatus || "unknown")}</span>` },
        { label: "Connections", key: "connections" },
        { label: "Connected", render: (row) => escapeHtml(monitorDate(row.connectedAt)) }
      ]), "Presence reflects connections on the active TitoPay API process.")}
      ${tableCard("Notification Queue", renderRows(result.queueStatus || [], [
        { label: "Status", render: (row) => `<span class="chip ${chipClass(row.status)}">${escapeHtml(row.status)}</span>` },
        { label: "Count", key: "count" },
        { label: "Oldest", render: (row) => escapeHtml(monitorDate(row.oldest_created_at)) },
        { label: "Latest update", render: (row) => escapeHtml(monitorDate(row.latest_updated_at)) }
      ]), "Sent or queued records indicate recipients that have not yet synchronized.")}
    </section>
    ${tableCard("Delivery Failures & Timeouts", renderRows(result.deliveryFailures || [], [
      { label: "Message", render: (row) => `<strong>${escapeHtml(row.failure_type === "failed" ? "Failed" : "Delivery timeout")}</strong><br><small>${escapeHtml(compactId(row.id))}</small>` },
      { label: "Conversation", render: (row) => escapeHtml(compactId(row.thread_id)) },
      { label: "Sender", render: (row) => `${escapeHtml(row.sender_name || "-")}<br><small>${escapeHtml(row.sender_username ? `@${row.sender_username}` : "")}</small>` },
      { label: "Recipient", render: (row) => `${escapeHtml(row.recipient_name || "-")}<br><small>${escapeHtml(row.recipient_username ? `@${row.recipient_username}` : "")}</small>` },
      { label: "Age", render: (row) => escapeHtml(monitorAge(row.age_seconds)) },
      { label: "Status", render: (row) => `<span class="chip red">${escapeHtml(row.status)}</span>` }
    ]), "A sent message older than 60 seconds is flagged for investigation; content is never returned.")}
    ${tableCard("Failed WebSocket Connections — Last 24 Hours", renderRows(result.socketFailures || [], [
      { label: "Time", render: (row) => escapeHtml(monitorDate(row.created_at)) },
      { label: "Failure", render: (row) => `<strong>${escapeHtml(String(row.reason || "connection_failed").replaceAll("_", " "))}</strong><br><small>${escapeHtml(row.event_type)}</small>` },
      { label: "IP", render: (row) => escapeHtml(maskMonitorIp(row.ip_address)) },
      { label: "Client", render: (row) => `<small class="monitor-client">${escapeHtml(row.user_agent || "Unknown client")}</small>` }
    ]), "Authentication and processing failure categories are logged server-side without JWTs or stack traces.")}
  `;
  clearInterval(chatMonitorRefreshTimer);
  chatMonitorRefreshTimer = setInterval(() => {
    if (document.querySelector('.admin-shell[data-page="chat-monitor"]')) {
      renderChatMonitor().catch(() => null);
    }
  }, 10000);
}

async function renderCompliance() {
  const result = await apiFetch("/admin/compliance/queue");
  PAGE_EXPORTS.compliance = result.items;
  document.getElementById("page-content").innerHTML = tableCard(
    "Compliance Queue",
    renderRows(result.items, [
      { label: "User", render: (row) => `<strong>${escapeHtml(row.full_name)}</strong><br><small>${escapeHtml(row.username)}</small>` },
      { label: "Account", render: (row) => `<span class="chip blue">${escapeHtml(row.account_type)}</span>` },
      { label: "Review", key: "review_type" },
      { label: "Status", render: (row) => `<span class="chip ${chipClass(row.status)}">${escapeHtml(row.status)}</span>` },
      { label: "Notes", key: "notes" },
    ], (row) => `
      <button data-review-status="approved" data-review-id="${row.id}">Approve</button>
      <button data-review-status="rejected" data-review-id="${row.id}">Reject</button>
      <button data-review-status="pending" data-review-id="${row.id}">Reset</button>
    `)
  );
}

async function renderRevenue() {
  const result = await apiFetch("/admin/revenue");
  PAGE_EXPORTS.revenue = [
    ...(result.byService || []).map((row) => ({ report: "by_service", ...row })),
    ...(result.daily || []).map((row) => ({ report: "daily", ...row })),
  ];
  document.getElementById("page-content").innerHTML = `
    ${renderMetrics([
      ["Revenue Wallet", money(result.wallet?.available_balance || 0)],
      ["Services", result.byService.length],
      ["Recent Days", result.daily.length],
      ["Currency", result.wallet?.currency || "ZAR"],
    ])}
    <section class="panel-grid">
      ${tableCard("Revenue by Service", renderRows(result.byService, [
        { label: "Service", key: "service_type" },
        { label: "Collected", render: (row) => money(row.total) },
      ], () => ""))}
      ${tableCard("Daily Revenue", renderRows(result.daily, [
        { label: "Day", key: "day" },
        { label: "Total", render: (row) => money(row.total) },
      ], () => ""))}
    </section>
  `;
}

async function renderSecurity(me = {}) {
  const result = await apiFetch("/admin/security");
  // Customer Email OTP is separate from the staff/admin sign-in OTP mode above.
  // Keep this request best-effort so operators without Email OTP permission can
  // still use the Security dashboard exactly as before.
  let customerOtp = null;
  try {
    const customerOtpResult = await apiFetch("/admin/email-otp/settings");
    customerOtp = customerOtpResult.settings || null;
  } catch (_error) {
    customerOtp = null;
  }
  const otpPolicy = result.otpPolicy || {};
  const smtp = result.smtp || {};
  const templates = result.emailTemplates || [];
  const auth = getAuth();
  const isSuperAdmin = hasFullAdminAccess(me) || isPlatformOwnerRole(me?.role || auth?.user?.role || auth?.role);
  const selectedMode = otpPolicy.authenticationMode || (otpPolicy.otpRequired ? "password_email_otp" : "password_only");
  const canEditCustomerOtp = isSuperAdmin && Boolean(customerOtp);
  const authenticationModeControl = isSuperAdmin ? `
    <form id="authentication-mode-form" class="security-control-list" data-current-mode="${escapeHtml(selectedMode)}">
      <fieldset class="authentication-mode-options" aria-describedby="authentication-mode-help authentication-mode-status">
        <legend>Choose how Admin Portal staff sign in</legend>
        <label class="authentication-mode-option">
          <input type="radio" name="mode" value="password_only" ${selectedMode === "password_only" ? "checked" : ""}>
          <span><strong>Password Only</strong><small>Staff sign in with their email or username and password. SMTP delivery is not required.</small></span>
          <b aria-hidden="true">Selected</b>
        </label>
        <label class="authentication-mode-option">
          <input type="radio" name="mode" value="password_email_otp" ${selectedMode === "password_email_otp" ? "checked" : ""}>
          <span><strong>Password + Email OTP</strong><small>After the password is accepted, staff must enter the one-time code sent to their registered email.</small></span>
          <b aria-hidden="true">Selected</b>
        </label>
      </fieldset>
      <p class="table-card-note" id="authentication-mode-help">This setting applies only to Admin Portal sign-in. Customer wallet-unlock authentication is configured separately.</p>
      <p class="authentication-mode-status" id="authentication-mode-status" role="status" aria-live="polite"></p>
      <button class="primary-btn" id="save-authentication-mode" type="submit">Save Authentication Mode</button>
    </form>
  ` : `
    <div class="security-control-list">
      <div class="security-control-row">
        <span>Authentication mode</span>
        <span class="chip ${otpPolicy.otpRequired ? "orange" : "green"}">${otpPolicy.otpRequired ? "Password + Email OTP" : "Password Only"}</span>
      </div>
      <p class="table-card-note">Only Super Admin can change admin authentication mode.</p>
    </div>
  `;
  const templateCards = templates.map((template) => `
    <article class="template-card">
      <strong>${escapeHtml(template.name)}</strong>
      <span>${escapeHtml(template.subject)}</span>
      <small>${escapeHtml(template.status)}</small>
    </article>
  `).join("");
  PAGE_EXPORTS.security = [
    ...(result.loginAttempts || []).map((row) => ({ bucket: "login", ...row })),
    ...(result.otpLogs || []).map((row) => ({ bucket: "otp", ...row })),
    ...(result.profileLockEvents || []).map((row) => ({ bucket: "profile_lock", ...row })),
    ...(result.adminSessions || []).map((row) => ({ bucket: "admin_session", ...row })),
  ];
  document.getElementById("page-content").innerHTML = `
    <section class="panel-grid security-admin-grid">
      ${tableCard("Admin Sign-in Authentication Mode", `
        <p class="table-card-note">${escapeHtml(otpPolicy.note || "Admin authentication mode is managed by Super Admin.")}</p>
        ${authenticationModeControl}
      `)}
      ${tableCard("SMTP Management", `
        <dl class="smtp-detail-grid">
          <div><dt>SMTP Status</dt><dd><span class="chip ${smtp.configured ? "green" : "orange"}">${smtp.configured ? "Configured" : "Not configured"}</span></dd></div>
          <div><dt>SMTP Host</dt><dd>${escapeHtml(smtp.smtpHost || "Not set")}</dd></div>
          <div><dt>SMTP Port</dt><dd>${escapeHtml(String(smtp.smtpPort || "Not set"))}</dd></div>
          <div><dt>Sender Email</dt><dd>${escapeHtml(smtp.senderEmail || "Not set")}</dd></div>
        </dl>
        <button class="secondary-btn" id="test-smtp-email" type="button">Test Email Delivery</button>
      `)}
    </section>
    ${customerOtp ? tableCard("Customer Email OTP", `
      <p class="table-card-note">These controls apply to customer verification in the PWA. They are separate from the staff sign-in setting above.</p>
      <form id="customer-email-otp-form" class="security-control-list">
        <label class="security-control-row">
          <span><strong>Enable customer Email OTP</strong><small>Required before any customer Email OTP can be selected.</small></span>
          <input type="checkbox" name="enabled" ${customerOtp.enabled ? "checked" : ""} ${canEditCustomerOtp ? "" : "disabled"}>
        </label>
        <label class="security-control-row">
          <span><strong>Wallet unlock</strong><small>Allow Email OTP as an alternative to SMS when unlocking a customer wallet.</small></span>
          <input type="checkbox" name="walletUnlock" ${(customerOtp.events || {}).wallet_unlock ? "checked" : ""} ${canEditCustomerOtp ? "" : "disabled"}>
        </label>
        ${canEditCustomerOtp ? '<button class="primary-btn" type="submit">Save customer Email OTP</button>' : '<p class="table-card-note">Only Super Admin can change customer Email OTP settings.</p>'}
      </form>
    `) : ""}
    ${tableCard("Email Template Management", `
      <div class="template-list">${templateCards || "<p class=\"table-card-note\">No email templates returned by the API.</p>"}</div>
    `)}
    <section class="panel-grid">
      ${tableCard("Login Attempts", renderRows(result.loginAttempts, [
        { label: "Actor", key: "actor_type" },
        { label: "Action", key: "action" },
        { label: "Time", key: "created_at" },
      ], () => ""))}
      ${tableCard("OTP Logs", renderRows(result.otpLogs, [
        { label: "User Type", key: "user_type" },
        { label: "Purpose", key: "purpose" },
        { label: "Expires", key: "expires_at" },
        { label: "Attempts", key: "attempt_count" },
      ], () => ""))}
    </section>
    ${tableCard("Admin Sessions", renderRows(result.adminSessions || [], [
      { label: "Admin", render: (row) => `<strong>${escapeHtml(row.full_name || "-")}</strong><br><small>${escapeHtml(row.email || "-")}</small>` },
      { label: "Device", render: (row) => `${escapeHtml(row.device_name || "Unknown")}<br><small>${escapeHtml(row.platform || "-")}</small>` },
      { label: "Last Activity", key: "last_activity_at" },
      { label: "Status", render: (row) => `<span class="chip ${row.revoked_at ? "red" : "green"}">${row.revoked_at ? "Revoked" : "Active"}</span>` },
    ], () => ""))}
    ${tableCard("Profile Lock Events", renderRows(result.profileLockEvents, [
      { label: "Actor", key: "actor_type" },
      { label: "Action", key: "action" },
      { label: "Time", key: "created_at" },
    ], () => ""))}
  `;
  const authenticationModeForm = document.getElementById("authentication-mode-form");
  const synchronizeAuthenticationModeControl = () => {
    if (!authenticationModeForm) return;
    const selected = authenticationModeForm.querySelector('input[name="mode"]:checked');
    authenticationModeForm.querySelectorAll(".authentication-mode-option").forEach((option) => {
      option.classList.toggle("is-selected", option.contains(selected));
    });
    const status = authenticationModeForm.querySelector("#authentication-mode-status");
    if (status && selected) {
      status.textContent = selected.value === "password_email_otp"
        ? "Selected: Password + Email OTP"
        : "Selected: Password Only";
    }
  };
  authenticationModeForm?.querySelectorAll('input[name="mode"]').forEach((input) => {
    input.addEventListener("change", synchronizeAuthenticationModeControl);
  });
  synchronizeAuthenticationModeControl();
  authenticationModeForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const mode = String(formData.get("mode") || "");
    if (!["password_only", "password_email_otp"].includes(mode)) {
      showToast("Choose an authentication mode before saving");
      return;
    }
    const fieldset = form.querySelector("fieldset");
    const submitButton = form.querySelector("#save-authentication-mode");
    const status = form.querySelector("#authentication-mode-status");
    if (fieldset) fieldset.disabled = true;
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Saving Authentication Mode...";
    }
    if (status) status.textContent = "Saving authentication mode...";
    try {
      await apiFetch("/admin/security/authentication-mode", {
        method: "PUT",
        body: JSON.stringify({ mode }),
      });
      showToast("Authentication mode saved");
      await renderSecurity(PAGE_EXPORTS.currentMe || me);
    } catch (error) {
      showToast(adminErrorMessage(error.message));
      if (fieldset) fieldset.disabled = false;
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = "Save Authentication Mode";
      }
      synchronizeAuthenticationModeControl();
    }
  });
  document.getElementById("customer-email-otp-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await apiFetch("/admin/email-otp/settings", {
        method: "PUT",
        body: JSON.stringify({
          enabled: data.get("enabled") === "on",
          events: { wallet_unlock: data.get("walletUnlock") === "on" },
        }),
      });
      showToast("Customer Email OTP settings updated");
      await renderSecurity(me);
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  });
  document.getElementById("test-smtp-email")?.addEventListener("click", async () => {
    try {
      const response = await apiFetch("/admin/security/smtp/test", { method: "POST", body: JSON.stringify({}) });
      showToast(`SMTP test sent to ${response.to}`);
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  });
}

async function renderAudit() {
  const result = await apiFetch("/admin/audit");
  PAGE_EXPORTS.audit = result.items;
  document.getElementById("page-content").innerHTML = tableCard(
    "Audit Logs",
    renderRows(result.items, [
      { label: "Actor", render: (row) => `${escapeHtml(row.actor_type)}<br><small>${escapeHtml(row.actor_id || "-")}</small>` },
      { label: "Action", key: "action" },
      { label: "Target", render: (row) => `${escapeHtml(row.target_type || "-")}<br><small>${escapeHtml(row.target_id || "-")}</small>` },
      { label: "Time", key: "created_at" },
    ], () => "")
  );
}

async function renderBeneficiaries(search = "") {
  const query = String(search || "").trim();
  const result = await apiFetch(`/admin/beneficiaries${query ? `?search=${encodeURIComponent(query)}` : ""}`);
  const items = result.items || [];
  PAGE_EXPORTS.beneficiaries = items;
  const active = items.filter((row) => !row.disabled_at).length;
  document.getElementById("page-content").innerHTML = `
    ${renderMetrics([
      ["Relationships", items.length],
      ["Active", active],
      ["Disabled", items.length - active],
      ["Favourites", items.filter((row) => row.favourite).length],
    ])}
    <section class="panel">
      <form id="beneficiary-admin-search" class="form-grid">
        <div class="field field-full"><label>Search owner or beneficiary</label><input name="search" type="search" value="${escapeHtml(query)}" maxlength="120" placeholder="Name, username or nickname"></div>
        <button class="primary-btn" type="submit">Search</button>
      </form>
    </section>
    ${tableCard("Saved Beneficiary Relationships", renderRows(items, [
      { label: "Owner", render: (row) => `<strong>${escapeHtml(row.owner_name || "-")}</strong><br><small>${escapeHtml(row.owner_username || "-")}</small>` },
      { label: "Beneficiary", render: (row) => `<strong>${escapeHtml(row.beneficiary_name || "-")}</strong><br><small>${escapeHtml(row.beneficiary_username || "-")}</small>` },
      { label: "Nickname / Type", render: (row) => `${escapeHtml(row.nickname || "-")}<br><small>${escapeHtml(String(row.relationship_type || "-").replaceAll("_", " "))}${row.favourite ? " · Favourite" : ""}</small>` },
      { label: "Last Paid", render: (row) => row.last_paid_at ? `${escapeHtml(new Date(row.last_paid_at).toLocaleString("en-ZA"))}<br><small>R${Number(row.last_payment_amount || 0).toFixed(2)}</small>` : "-" },
      { label: "Status", render: (row) => `<span class="chip ${row.disabled_at ? "red" : "green"}">${row.disabled_at ? "Disabled" : "Active"}</span>${row.disabled_reason ? `<br><small>${escapeHtml(row.disabled_reason)}</small>` : ""}` },
    ], (row) => row.disabled_at ? "" : `<button class="secondary-btn" type="button" data-beneficiary-disable="${escapeHtml(row.id)}">Disable</button>`),
    "Super Admins may inspect and disable abusive relationships. Customer beneficiary lists cannot be edited from the admin portal.")}
  `;
  document.getElementById("beneficiary-admin-search")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await renderBeneficiaries(new FormData(event.currentTarget).get("search"));
  });
}

function renderTicketingEventActions(row = {}) {
  const id = escapeHtml(row.id || "");
  const actions = [];
  if (["submitted", "additional_information_required"].includes(row.status)) actions.push(["under_review", "Review"]);
  if (["submitted", "under_review", "additional_information_required"].includes(row.status)) {
    actions.push(["approve", "Approve"], ["request_information", "Request Info"], ["reject", "Reject"]);
  }
  if (row.status === "approved") actions.push(["suspend", "Suspend"]);
  if (row.status === "suspended") actions.push(["reinstate", "Reinstate"]);
  actions.push(["report", "Report"]);
  if (row.status === "approved") actions.push(["settlement", "Settle"]);
  return actions.map(([action, label]) => `<button data-ticketing-action="${action}" data-ticketing-id="${id}">${escapeHtml(label)}</button>`).join(" ");
}

async function renderTicketing() {
  const [result, refundResult] = await Promise.all([
    apiFetch("/admin/ticketing/events"),
    apiFetch("/admin/ticketing/refunds").catch(() => ({ items: [] })),
  ]);
  const rows = result.items || [];
  const refunds = refundResult.items || [];
  PAGE_EXPORTS.ticketing = rows;
  PAGE_EXPORTS.ticketingRefunds = refunds;
  const counts = rows.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});
  document.getElementById("page-content").innerHTML = `
    ${renderMetrics([
      ["Events", rows.length],
      ["Pending Review", (counts.submitted || 0) + (counts.under_review || 0)],
      ["Approved", counts.approved || 0],
      ["Refunds", refunds.filter((item) => item.status === "requested").length],
    ])}
    <div id="ticketing-detail-host"></div>
    ${tableCard("Event Approval Queue", renderRows(rows, [
      { label: "Event", render: (row) => `<strong>${escapeHtml(row.eventName || "-")}</strong><br><small>${escapeHtml(row.businessName || row.businessOwnerName || "Verified business")}</small>` },
      { label: "Date", render: (row) => escapeHtml(String(row.eventDate || "-").slice(0, 10)) },
      { label: "Status", render: (row) => `<span class="chip ${row.status === "approved" ? "green" : row.status === "rejected" || row.status === "suspended" ? "red" : "blue"}">${escapeHtml(String(row.status || "draft").replaceAll("_", " "))}</span>` },
      { label: "Verification", render: (row) => `${escapeHtml(row.ownerFicaStatus || "-")}<br><small>${escapeHtml(row.merchantVerificationStatus || "-")}</small>` },
    ], renderTicketingEventActions), "Only verified TitoPay Business accounts can submit events. Approvals and settlement actions are audit logged.")}
    ${tableCard("Refund Queue", renderRows(refunds, [
      { label: "Order", render: (row) => `<strong>${escapeHtml(row.order_reference || "-")}</strong><br><small>${escapeHtml(row.event_name || "-")}</small>` },
      { label: "Requester", render: (row) => `${escapeHtml(row.requester_name || "-")}<br><small>${escapeHtml(row.requester_phone || "-")}</small>` },
      { label: "Amount", render: (row) => `R${Number(row.amount || 0).toFixed(2)}` },
      { label: "Status", render: (row) => `<span class="chip ${row.status === "approved" ? "green" : row.status === "rejected" ? "red" : "blue"}">${escapeHtml(row.status || "-")}</span>` },
    ], (row) => row.status === "requested" ? `
      <button data-ticket-refund-action="approve" data-ticket-refund-id="${escapeHtml(row.id)}">Approve</button>
      <button data-ticket-refund-action="reject" data-ticket-refund-id="${escapeHtml(row.id)}">Reject</button>
    ` : ""), "Approved refunds credit the buyer wallet and update ticket inventory.")}
  `;
}

function renderEnterpriseApplicationActions(row = {}) {
  const id = escapeHtml(row.id || "");
  const status = String(row.status || "");
  const actions = [];
  if (["submitted", "under_review"].includes(status)) actions.push(["approve", "Approve"], ["reject", "Reject"]);
  if (status === "submitted") actions.push(["review", "Mark review"]);
  if (status === "approved") actions.push(["suspend", "Suspend"], ["revoke", "Revoke"]);
  return actions.map(([action, label]) => `<button data-enterprise-action="${action}" data-enterprise-application-id="${id}">${escapeHtml(label)}</button>`).join(" ");
}

async function renderEnterpriseDistribution() {
  const [overviewResult, applicationsResult, organisationsResult, batchesResult, payoutsResult, auditResult, reportResult] = await Promise.all([
    apiFetch("/admin/enterprise-distribution/overview"),
    apiFetch("/admin/enterprise-distribution/applications"),
    apiFetch("/admin/enterprise-distribution/organisations"),
    apiFetch("/admin/enterprise-distribution/batches"),
    apiFetch("/admin/enterprise-distribution/payouts"),
    apiFetch("/admin/enterprise-distribution/audit-logs"),
    apiFetch("/admin/enterprise-distribution/report")
  ]);
  const overview = overviewResult.overview || {};
  const applications = applicationsResult.items || [];
  const organisations = organisationsResult.items || [];
  const batches = batchesResult.items || [];
  const payouts = payoutsResult.items || [];
  const auditLogs = auditResult.items || [];
  const report = reportResult.report || {};
  const applicationCounts = (overview.applications || []).reduce((acc, item) => {
    acc[item.status] = item.count;
    return acc;
  }, {});
  const batchCounts = (overview.batches || []).reduce((acc, item) => {
    acc[item.status] = item.count;
    return acc;
  }, {});
  PAGE_EXPORTS["enterprise-distribution"] = [
    ...applications.map((row) => ({ type: "application", ...row })),
    ...organisations.map((row) => ({ type: "organisation", ...row })),
    ...batches.map((row) => ({ type: "batch", ...row })),
    ...payouts.map((row) => ({ type: "payout", ...row })),
    ...auditLogs.map((row) => ({ type: "audit", ...row }))
  ];
  document.getElementById("page-content").innerHTML = `
    ${renderMetrics([
      ["Applications", applications.length],
      ["Pending Approval", (applicationCounts.submitted || 0) + (applicationCounts.under_review || 0)],
      ["Approved Organisations", organisations.filter((item) => item.status === "active" && item.licence_status === "active").length],
      ["Draft Batches", (batchCounts.draft_validated || 0) + (batchCounts.draft_validation_failed || 0)],
    ])}
    <section class="panel">
      <h3>Enterprise Distribution Control Layer</h3>
      <p>Enterprise Bulk Distribution is active for TitoPay wallet recipients. Organisations validate batches, lock funding from their business wallet, and Admin releases approved wallet batches. Bank withdrawals and external payouts must use TitoPay’s existing Withdraw/Payout service.</p>
      <div class="ops-list ops-list-two">
        <span><strong>Approval first</strong>Only approved organisations can access the Business module.</span>
        <span><strong>Funding lock</strong>Businesses must reserve funds before Admin can release a batch.</span>
        <span><strong>Payout routing</strong>Wallet payouts run here; bank payouts stay in TitoPay Payouts.</span>
        <span><strong>Audited</strong>Applications, approvals, funding locks and releases write audit records.</span>
      </div>
    </section>
    <section class="panel">
      <h3>Final Audit Report</h3>
      <div class="ops-list ops-list-two">
        <span><strong>Validated total</strong>${money(report.totals?.validated_total || 0)}</span>
        <span><strong>Locked total</strong>${money(report.totals?.locked_total || 0)}</span>
        <span><strong>Fees recorded</strong>${money(report.totals?.fee_total || 0)}</span>
        <span><strong>Audit entries</strong>${escapeHtml(String(report.auditLogs || auditLogs.length || 0))}</span>
      </div>
    </section>
    ${tableCard("Distribution Batches", renderRows(batches, [
      { label: "Batch", render: (row) => `<strong>${escapeHtml(row.batch_name || "-")}</strong><br><small>${escapeHtml(row.batch_reference || "-")}</small>` },
      { label: "Organisation", render: (row) => `${escapeHtml(row.organisation_name || "-")}<br><small>${escapeHtml(row.owner_email || row.owner_name || "-")}</small>` },
      { label: "Rows", render: (row) => `${escapeHtml(String(row.valid_rows || 0))} valid<br><small>${escapeHtml(String(row.invalid_rows || 0))} invalid · ${escapeHtml(String(row.processed_rows || 0))} processed</small>` },
      { label: "Funding", render: (row) => `${money(row.valid_total || 0)}<br><small>Fees ${money(row.fee_total || 0)} · Locked ${money(row.locked_total || 0)}</small>` },
      { label: "Status", render: (row) => `<span class="chip ${row.status === "completed" ? "green" : row.status === "failed" || row.status === "partially_failed" ? "red" : "blue"}">${escapeHtml(String(row.status || "-").replaceAll("_", " "))}</span>` },
    ], (row) => row.status === "funding_locked" ? `<button data-enterprise-batch-release="${escapeHtml(row.id)}">Release</button>` : ""), "Release only after funding, beneficiary and compliance checks pass. Wallet recipients are paid immediately. Bank payout rows must be handled through TitoPay Payouts.")}
    ${tableCard("Payout Records", renderRows(payouts, [
      { label: "Reference", render: (row) => `<strong>${escapeHtml(row.payout_reference || "-")}</strong><br><small>${escapeHtml(row.batch_reference || "-")}</small>` },
      { label: "Organisation", render: (row) => escapeHtml(row.organisation_name || "-") },
      { label: "Recipient", render: (row) => `${escapeHtml(row.recipient_name || "-")}<br><small>${escapeHtml(row.recipient_phone || "-")}</small>` },
      { label: "Amount", render: (row) => `${money(row.amount || 0)}<br><small>Fee ${money(row.fee || 0)}</small>` },
      { label: "Status", render: (row) => `<span class="chip ${row.status === "paid" ? "green" : row.status === "failed" ? "red" : "blue"}">${escapeHtml(String(row.status || "-").replaceAll("_", " "))}</span>` },
    ], () => ""), "Only TitoPay wallet payout records are processed here.")}
    ${tableCard("Organisation Applications", renderRows(applications, [
      { label: "Organisation", render: (row) => `<strong>${escapeHtml(row.organisation_name || row.business_name || "-")}</strong><br><small>${escapeHtml(row.registration_number || "-")}</small>` },
      { label: "Owner", render: (row) => `${escapeHtml(row.owner_name || "-")}<br><small>${escapeHtml(row.owner_email || row.owner_phone || "-")}</small>` },
      { label: "Type / Purpose", render: (row) => `${escapeHtml(row.institution_type || "-")}<br><small>${escapeHtml(row.funding_purpose || "-")}</small>` },
      { label: "Volume", render: (row) => `${money(row.expected_monthly_volume || 0)}<br><small>${escapeHtml(String(row.expected_beneficiaries || 0))} beneficiaries</small>` },
      { label: "Status", render: (row) => `<span class="chip ${row.status === "approved" ? "green" : row.status === "rejected" || row.status === "revoked" ? "red" : "blue"}">${escapeHtml(String(row.status || "submitted").replaceAll("_", " "))}</span>` },
    ], renderEnterpriseApplicationActions), "Approve only organisations that passed registration, bank verification, compliance document and risk checks.")}
    ${tableCard("Approved Organisations", renderRows(organisations, [
      { label: "Organisation", render: (row) => `<strong>${escapeHtml(row.organisation_name || "-")}</strong><br><small>${escapeHtml(row.organisation_code || "-")}</small>` },
      { label: "Owner", render: (row) => `${escapeHtml(row.owner_name || "-")}<br><small>${escapeHtml(row.owner_email || row.owner_phone || "-")}</small>` },
      { label: "Licence", render: (row) => `<span class="chip ${row.licence_status === "active" ? "green" : "red"}">${escapeHtml(row.licence_status || "-")}</span>` },
      { label: "Risk", render: (row) => `<span class="chip orange">${escapeHtml(row.risk_rating || "medium")}</span>` },
      { label: "Approved", render: (row) => escapeHtml(String(row.approved_at || "-").slice(0, 10)) },
    ], () => ""), "These organisations can access the hidden Business Bulk Distribution module.")}
    ${tableCard("Audit Trail", renderRows(auditLogs.slice(0, 100), [
      { label: "Action", render: (row) => `<strong>${escapeHtml(String(row.action || "-").replaceAll("_", " "))}</strong><br><small>${escapeHtml(row.organisation_name || "-")}</small>` },
      { label: "Actor", render: (row) => `${escapeHtml(row.actor_type || "-")}<br><small>${escapeHtml(row.actor_id || "-")}</small>` },
      { label: "Reason", render: (row) => escapeHtml(row.reason || "-") },
      { label: "When", render: (row) => escapeHtml(String(row.created_at || "-").slice(0, 19).replace("T", " ")) },
    ], () => ""), "Every Enterprise Distribution approval, funding lock and release is recorded here.")}
  `;
}

function renderPricingEditor(row = {}) {
  return `
    <section class="pricing-editor-card" id="pricing-editor">
      <div>
        <p class="eyebrow">Pricing Rule</p>
        <h3>Edit ${escapeHtml(row.service_name || "service pricing")}</h3>
        <p>Changes are saved to the TitoPay API and reflected wherever this pricing rule is consumed.</p>
      </div>
      <form id="pricing-edit-form" class="form-grid" data-pricing-id="${escapeHtml(row.id)}">
        <div class="field">
          <label>Service name</label>
          <input name="service_name" value="${escapeHtml(row.service_name || "")}" required>
        </div>
        <div class="field">
          <label>Flat fee</label>
          <input name="flat_fee" type="number" min="0" step="0.01" value="${escapeHtml(row.flat_fee ?? (row.fee_type === "FIXED" ? row.fee_value : 0))}" required>
        </div>
        <div class="field">
          <label>Percentage fee</label>
          <input name="percentage_fee" type="number" min="0" step="0.0001" value="${escapeHtml(row.percentage_fee ?? (row.fee_type === "PERCENTAGE" ? row.fee_value : 0))}" required>
        </div>
        <div class="field">
          <label>Minimum fee</label>
          <input name="minimum_fee" type="number" min="0" step="0.01" value="${escapeHtml(row.minimum_fee ?? 0)}">
        </div>
        <div class="field">
          <label>Maximum fee</label>
          <input name="maximum_fee" type="number" min="0" step="0.01" value="${escapeHtml(row.maximum_fee ?? 0)}">
        </div>
        <div class="field">
          <label>VAT %</label>
          <input name="vat_percentage" type="number" min="0" step="0.0001" value="${escapeHtml(row.vat_percentage ?? 0)}">
        </div>
        <div class="field">
          <label>Effective date</label>
          <input name="effective_date" type="date" value="${escapeHtml(String(row.effective_date || new Date().toISOString().slice(0, 10)).slice(0, 10))}">
        </div>
        <label class="toggle-row">
          <input name="enabled" type="checkbox" ${row.enabled !== false && row.active !== false ? "checked" : ""}>
          <span>Enabled pricing rule</span>
        </label>
        <div class="action-row">
          <button class="primary-btn" type="submit">Save Pricing Rule</button>
          <button class="secondary-btn" type="button" data-pricing-cancel>Cancel</button>
        </div>
      </form>
    </section>
  `;
}

async function renderPricing() {
  const result = await apiFetch("/pricing");
  const rows = (result.items || []).map((row) => ({ ...row, category: pricingCategory(row) }));
  const categories = Array.from(new Set(rows.map((row) => row.category)));
  PAGE_EXPORTS.pricing = rows;
  document.getElementById("page-content").innerHTML = `
    ${renderMetrics([
      ["Pricing Rules", rows.length],
      ["Enabled Rules", rows.filter((row) => row.enabled !== false && row.active !== false).length],
      ["Categories", categories.length],
      ["Currency", "ZAR"],
    ])}
    <section class="panel">
      <h3>How to update prices and fees</h3>
      <p>Click <strong>Edit rule</strong> on any service below, enter the flat fee, percentage fee, minimum fee, maximum fee, VAT-exclusive rate and effective date, then save. This Pricing Engine is the source of truth used by the TitoPay API.</p>
      <div class="ops-list ops-list-two">
        <span><strong>Flat Fee</strong>Fixed rand amount such as R0.50</span>
        <span><strong>Percentage</strong>Percentage fee such as 1.5%</span>
        <span><strong>Min / Max</strong>Controls fee floor and cap</span>
        <span><strong>Enabled</strong>Turns service pricing on or off</span>
      </div>
    </section>
    <section class="panel-grid pricing-summary-grid">
      ${categories.map((category) => {
        const categoryRows = rows.filter((row) => row.category === category);
        return `<article class="panel">
          <h3>${escapeHtml(category)}</h3>
          <p>${categoryRows.length} pricing rules configured for ${escapeHtml(category.toLowerCase())} services.</p>
          <div class="ops-list ops-list-two">
            <span><strong>${categoryRows.filter((row) => row.enabled !== false && row.active !== false).length}</strong>Enabled</span>
            <span><strong>${categoryRows.filter((row) => Number(row.percentage_fee || 0) > 0 || row.fee_type === "PERCENTAGE").length}</strong>Percentage fees</span>
          </div>
        </article>`;
      }).join("")}
    </section>
    <div id="pricing-editor-host"></div>
    ${tableCard("Pricing Management", renderRows(rows, [
      { label: "Category", render: (row) => `<span class="chip blue">${escapeHtml(row.category)}</span>` },
      { label: "Service", render: (row) => `<strong>${escapeHtml(row.service_name)}</strong><br><small>${escapeHtml(row.service_code)}</small>` },
      { label: "Flat Fee", render: (row) => money(row.flat_fee ?? (row.fee_type === "FIXED" ? row.fee_value : 0)) },
      { label: "Percentage", render: (row) => `${escapeHtml(row.percentage_fee ?? (row.fee_type === "PERCENTAGE" ? row.fee_value : 0))}%` },
      { label: "Limits", render: (row) => `${money(row.minimum_fee)} min<br><small>${money(row.maximum_fee)} max</small>` },
      { label: "VAT / Effective", render: (row) => `${escapeHtml(row.vat_percentage ?? 0)}%<br><small>${escapeHtml(String(row.effective_date || "-").slice(0, 10))}</small>` },
      { label: "Status", render: (row) => `<span class="chip ${row.enabled !== false && row.active !== false ? "green" : "red"}">${row.enabled !== false && row.active !== false ? "Enabled" : "Disabled"}</span>` },
    ], (row) => `<button data-pricing-edit="${row.id}">Edit rule</button>`), "Pricing updates are written through the TitoPay API and reflected wherever pricing rules are consumed.", "API controlled")}
  `;
}

/* Support conversation statuses are uppercase with underscores
   (WAITING_FOR_AGENT, AGENT_ACTIVE, ...) and do not match the generic
   chipClass keywords, so they were all rendering the same neutral blue. */
function supportStatusClass(status = "") {
  const value = String(status || "").toLowerCase();
  if (["agent_active", "reopened", "resolved"].includes(value)) return "green";
  if (["escalated", "waiting_for_agent"].includes(value)) return "orange";
  if (value === "closed") return "red";
  return "blue";
}

function integrationStatusClass(status = "") {
  const value = String(status || "").toLowerCase();
  if (value === "connected" || value === "ready") return "green";
  if (value === "failed") return "red";
  if (value === "not_tested") return "orange";
  // Health states reported by the API render with the same colour language, so
  // an operator can see a provider is down without reading every row.
  if (["healthy", "ok", "up", "active", "operational"].includes(value)) return "green";
  if (["degraded", "warning", "slow", "partial", "pending"].includes(value)) return "orange";
  if (["down", "error", "unavailable", "offline", "unreachable"].includes(value)) return "red";
  return "blue";
}

function integrationFieldValue(provider, fieldName) {
  if (fieldName === "environment") return provider.environment || provider.mode || "sandbox";
  if (fieldName === "enabled") return provider.enabled !== false;
  return provider[fieldName] || "";
}

function renderIntegrationField(provider, field, isSuperAdmin) {
  const disabled = isSuperAdmin && !field.readOnly ? "" : "disabled";
  const value = integrationFieldValue(provider, field.name);
  if (field.name === "enabled") {
    return `
      <label class="toggle-row integration-toggle">
        <input name="enabled" type="checkbox" ${value ? "checked" : ""} ${disabled}>
        <span>Enabled for API use</span>
      </label>
    `;
  }
  if (field.name === "environment") {
    return `
      <div class="field">
        <label>${escapeHtml(field.label)}</label>
        <select name="environment" ${disabled}>
          <option value="sandbox" ${String(value).toLowerCase() === "sandbox" ? "selected" : ""}>Sandbox</option>
          <option value="production" ${String(value).toLowerCase() === "production" ? "selected" : ""}>Production</option>
        </select>
      </div>
    `;
  }
  if (field.secret) {
    return `
      <div class="field">
        <label>${escapeHtml(field.label)}</label>
        <input name="${escapeHtml(field.name)}" type="password" placeholder="${escapeHtml(provider.secrets?.[field.name] || "Leave blank to keep current value")}" autocomplete="new-password" ${disabled}>
      </div>
    `;
  }
  return `
    <div class="field">
      <label>${escapeHtml(field.label)}</label>
      <input name="${escapeHtml(field.name)}" value="${escapeHtml(value)}" placeholder="${field.name === "callbackUrl" ? (provider.key === "pos_provider" ? "https://api.titopay.co.za/v1/webhooks/pos-provider" : "https://api.titopay.co.za/v1/webhooks/provider") : ""}" ${disabled}>
    </div>
  `;
}

function renderIntegrationHealthDashboard(providers) {
  const connected = providers.filter((provider) => ["connected", "ready"].includes(provider.health?.status)).length;
  const failed = providers.filter((provider) => provider.health?.status === "failed").length;
  const enabled = providers.filter((provider) => provider.enabled !== false).length;
  return `
    ${renderMetrics([
      ["Providers", providers.length],
      ["Enabled", enabled],
      ["Connected / Ready", connected],
      ["Failed", failed],
    ])}
    ${tableCard("Integration Health", renderRows(providers, [
      { label: "Provider", render: (row) => `<strong>${escapeHtml(row.label)}</strong><br><small>${escapeHtml(row.category || "provider")}</small>` },
      { label: "Status", render: (row) => `<span class="chip ${integrationStatusClass(row.health?.status)}">${escapeHtml(row.health?.status || "not_tested")}</span>` },
      { label: "Environment", render: (row) => escapeHtml(row.environment || row.mode || "production") },
      { label: "Response", render: (row) => row.health?.responseTimeMs === null || row.health?.responseTimeMs === undefined ? "-" : `${escapeHtml(row.health.responseTimeMs)}ms` },
      { label: "Last Success", render: (row) => escapeHtml(row.health?.lastSuccessfulConnectionAt ? new Date(row.health.lastSuccessfulConnectionAt).toLocaleString("en-ZA") : "Never") },
      { label: "Error", render: (row) => escapeHtml(row.health?.errorMessage || "-") },
    ], (row) => `<button data-integration-test="${escapeHtml(row.key)}">Test</button>`), "Provider calls are performed by TitoPay API only. The Admin Portal never calls third-party providers directly.", "API controlled")}
  `;
}

async function renderIntegrations(me = {}) {
  const [configResult, logsResult, webhooksResult, routingResult] = await Promise.all([
    apiFetch("/admin/integrations/config"),
    apiFetch("/admin/integrations/logs").catch(() => ({ logs: [] })),
    apiFetch("/admin/integrations/webhooks").catch(() => ({ webhooks: [] })),
    apiFetch("/admin/provider-routing").catch(() => ({ services: [], providers: [] })),
  ]);
  const providers = configResult.providers || [];
  const logs = logsResult.logs || [];
  const webhooks = webhooksResult.webhooks || [];
  const isSuperAdmin = hasFullAdminAccess(me);
  PAGE_EXPORTS.integrations = providers.map(({ secrets, ...row }) => row);
  PAGE_EXPORTS["integration-logs"] = logs;
  PAGE_EXPORTS["integration-webhooks"] = webhooks;
  PAGE_EXPORTS["provider-routing"] = routingResult.services || [];
  document.getElementById("page-content").innerHTML = `
    <section class="panel integration-intro">
      <h3>Integration Centre</h3>
      <p>Super Admins can configure, test and monitor third-party providers from one secure place. Credentials are encrypted by the TitoPay API and masked in every frontend response.</p>
    </section>
    ${renderIntegrationHealthDashboard(providers)}
    ${tableCard("Provider Routing", `
      <form id="provider-routing-form" class="form-grid">
        ${(routingResult.services || []).map((service) => `
          <div class="field">
            <label>${escapeHtml(service.label)}</label>
            <select name="${escapeHtml(service.key)}" ${isSuperAdmin ? "" : "disabled"}>
              ${(routingResult.providers || []).map((provider) => `<option value="${escapeHtml(provider.key)}" ${provider.key === service.provider ? "selected" : ""}>${escapeHtml(provider.label)}</option>`).join("")}
            </select>
          </div>
        `).join("")}
        ${isSuperAdmin ? `<button class="primary-btn" type="submit">Save Provider Routing</button>` : ""}
      </form>
    `, "Provider changes are stored in TitoPay API settings and do not require application code changes.", "Routing engine")}
    <section class="integration-grid">
      ${providers.map((provider) => `
        <article class="integration-card">
          <div class="integration-card-header">
            <div>
              <h3>${escapeHtml(provider.label || providerDisplayName(provider.key))}</h3>
              <p>${escapeHtml(provider.description || "TitoPay provider connection")}</p>
            </div>
            <span class="chip ${provider.enabled === false ? "red" : provider.configured ? "green" : "orange"}">${provider.enabled === false ? "Disabled" : provider.configured ? "Configured" : "Not configured"}</span>
          </div>
          <dl class="smtp-detail-grid">
            <div><dt>Environment</dt><dd>${escapeHtml(provider.environment || provider.mode || "sandbox")}</dd></div>
            <div><dt>Base URL / Host</dt><dd>${escapeHtml(provider.baseUrl || "Not set")}</dd></div>
            <div><dt>Status</dt><dd><span class="chip ${integrationStatusClass(provider.health?.status)}">${escapeHtml(provider.health?.status || "not_tested")}</span></dd></div>
            <div><dt>Updated</dt><dd>${escapeHtml(provider.updatedAt ? new Date(provider.updatedAt).toLocaleString("en-ZA") : "Never")}</dd></div>
          </dl>
          <div class="integration-status-strip">
            <span>${provider.health?.responseTimeMs === null || provider.health?.responseTimeMs === undefined ? "No response time yet" : `${escapeHtml(provider.health.responseTimeMs)}ms response`}</span>
            <span>${escapeHtml(provider.health?.lastSuccessfulConnectionAt ? `Last success ${new Date(provider.health.lastSuccessfulConnectionAt).toLocaleString("en-ZA")}` : "No successful test yet")}</span>
          </div>
          <details class="integration-config-panel">
            <summary>Configure</summary>
            <form class="form-grid integration-form" data-provider="${escapeHtml(provider.key)}">
              ${(provider.fields || []).map((field) => renderIntegrationField(provider, field, isSuperAdmin)).join("")}
              <p class="secret-note">Saved secrets remain encrypted on the API and are displayed here only as masked values.</p>
              <div class="action-row">
                ${isSuperAdmin ? `<button class="primary-btn" type="submit">Save Configuration</button>` : ""}
                <a class="secondary-btn" href="/integrations/${providerSlug(provider.key)}/">Open Page</a>
                <button class="secondary-btn" type="button" data-integration-test="${escapeHtml(provider.key)}">Test Connection</button>
                ${isSuperAdmin ? `<button class="secondary-btn" type="button" data-integration-disable="${escapeHtml(provider.key)}">Disable</button>` : ""}
                ${isSuperAdmin ? `<button class="secondary-btn" type="button" data-integration-rotate="${escapeHtml(provider.key)}">Rotate Credentials</button>` : ""}
              </div>
            </form>
          </details>
          ${provider.health?.errorMessage ? `<p class="integration-error">${escapeHtml(provider.health.errorMessage)}</p>` : ""}
        </article>
      `).join("")}
    </section>
    <section class="panel-grid integration-monitor-grid">
      ${tableCard("Integration Logs", renderRows(logs, [
        { label: "Provider", render: (row) => `<strong>${escapeHtml(row.label || providerDisplayName(row.provider))}</strong><br><small>${escapeHtml(row.environment || "-")}</small>` },
        { label: "Status", render: (row) => `<span class="chip ${integrationStatusClass(row.status)}">${escapeHtml(row.status || "-")}</span>` },
        { label: "Response", render: (row) => row.responseTimeMs === undefined ? "-" : `${escapeHtml(row.responseTimeMs)}ms` },
        { label: "Error", render: (row) => escapeHtml(row.errorMessage || "-") },
        { label: "Created", render: (row) => escapeHtml(row.createdAt ? new Date(row.createdAt).toLocaleString("en-ZA") : "-") },
      ], () => ""), "Connection tests and provider events are recorded for operational review.", "Secure logs")}
      ${tableCard("Webhook Monitor", renderRows(webhooks, [
        { label: "Provider", render: (row) => `<strong>${escapeHtml(providerDisplayName(row.provider))}</strong><br><small>${escapeHtml(row.eventType || "webhook")}</small>` },
        { label: "Status", render: (row) => `<span class="chip ${chipClass(row.status)}">${escapeHtml(row.status || "received")}</span>` },
        { label: "Attempts", render: (row) => escapeHtml(row.retryCount ?? 0) },
        { label: "Last Error", render: (row) => escapeHtml(row.errorMessage || "-") },
        { label: "Received", render: (row) => escapeHtml(row.createdAt ? new Date(row.createdAt).toLocaleString("en-ZA") : "-") },
      ], (row) => isSuperAdmin && row.retryable ? `<button data-webhook-retry="${escapeHtml(row.id)}">Retry</button>` : ""), "Verified Peach and POS callbacks are shown without exposing payloads or credentials. Retry is available only for explicitly retryable integration events.", "Signed events")}
    </section>
  `;
  document.querySelectorAll(".integration-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);
      const body = Object.fromEntries(formData.entries());
      body.enabled = formData.get("enabled") === "on";
      try {
        await apiFetch(`/admin/integrations/${event.currentTarget.dataset.provider}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        showToast("Integration configuration saved");
        await renderIntegrations(PAGE_EXPORTS.currentMe || {});
      } catch (error) {
        showToast(adminErrorMessage(error.message));
      }
    });
  });
  document.getElementById("provider-routing-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      await apiFetch("/admin/provider-routing", {
        method: "PUT",
        body: JSON.stringify(body),
      });
      showToast("Provider routing saved");
      await renderIntegrations(me);
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  });
}

async function renderIntegrationProvider(me = {}) {
  const providerKey = providerKeyFromPath();
  const [providerResult, routingResult] = await Promise.all([
    apiFetch(`/admin/integrations/config/${providerKey}`),
    apiFetch("/admin/provider-routing").catch(() => ({ services: [], providers: [] })),
  ]);
  const provider = providerResult.provider;
  const isSuperAdmin = hasFullAdminAccess(me);
  PAGE_EXPORTS["integration-provider"] = provider ? [{ ...provider, secrets: undefined }] : [];
  const poweredServices = (routingResult.services || []).filter((service) => service.provider === providerKey);
  document.getElementById("page-content").innerHTML = `
    <section class="panel integration-intro">
      <h3>${escapeHtml(provider.label || providerDisplayName(providerKey))}</h3>
      <p>${escapeHtml(provider.description || "Provider configuration")}</p>
      <div class="action-row">
        <a class="secondary-btn" href="/integrations/">Back to Integration Centre</a>
        <button class="secondary-btn" type="button" data-integration-test="${escapeHtml(providerKey)}">Test Connection</button>
        ${isSuperAdmin ? `<button class="secondary-btn" type="button" data-integration-disable="${escapeHtml(providerKey)}">Disable</button>` : ""}
        ${isSuperAdmin ? `<button class="secondary-btn" type="button" data-integration-rotate="${escapeHtml(providerKey)}">Rotate Credentials</button>` : ""}
      </div>
    </section>
    ${renderMetrics([
      ["Status", provider.health?.status || "not_tested"],
      ["Response Time", provider.health?.responseTimeMs === null || provider.health?.responseTimeMs === undefined ? "-" : `${provider.health.responseTimeMs}ms`],
      ["Environment", provider.environment || provider.mode || "production"],
      ["Powered Services", poweredServices.length],
    ])}
    <section class="panel-grid">
      ${tableCard("Configuration", `
        <form class="form-grid integration-form" data-provider="${escapeHtml(providerKey)}">
          ${(provider.fields || []).map((field) => renderIntegrationField(provider, field, isSuperAdmin)).join("")}
          <p class="secret-note">Secrets are never exposed to the browser. Masked values indicate stored encrypted credentials.</p>
          <div class="action-row">
            ${isSuperAdmin ? `<button class="primary-btn" type="submit">Save Configuration</button>` : ""}
            <button class="secondary-btn" type="button" data-integration-test="${escapeHtml(providerKey)}">Test Connection</button>
          </div>
        </form>
      `, "Only Super Admin may edit provider credentials.", "Encrypted")}
      ${tableCard("Operational Status", `
        <dl class="smtp-detail-grid">
          <div><dt>Connected</dt><dd>${escapeHtml(provider.health?.status === "connected" ? "Connected" : provider.health?.status === "ready" ? "Receiver Ready" : "Disconnected")}</dd></div>
          <div><dt>Last Successful</dt><dd>${escapeHtml(provider.health?.lastSuccessfulConnectionAt ? new Date(provider.health.lastSuccessfulConnectionAt).toLocaleString("en-ZA") : "Never")}</dd></div>
          <div><dt>Last Failed</dt><dd>${escapeHtml(provider.health?.status === "failed" ? new Date(provider.health.lastTestedAt || Date.now()).toLocaleString("en-ZA") : "Never")}</dd></div>
          <div><dt>Last Tested</dt><dd>${escapeHtml(provider.health?.lastTestedAt ? new Date(provider.health.lastTestedAt).toLocaleString("en-ZA") : "Never")}</dd></div>
          <div><dt>Current Environment</dt><dd>${escapeHtml(provider.environment || provider.mode || "production")}</dd></div>
          <div><dt>Error</dt><dd>${escapeHtml(provider.health?.errorMessage || "-")}</dd></div>
        </dl>
      `)}
    </section>
    ${tableCard("Services Powered by This Provider", renderRows(poweredServices, [
      { label: "Service", key: "label" },
      { label: "Provider", render: () => escapeHtml(provider.label || providerDisplayName(providerKey)) },
    ], () => ""), "Provider routing can be changed from the main Integration Centre.")}
  `;
  document.querySelector(".integration-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const body = Object.fromEntries(formData.entries());
    body.enabled = formData.get("enabled") === "on";
    try {
      await apiFetch(`/admin/integrations/${providerKey}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      showToast("Integration configuration saved");
      await renderIntegrationProvider(me);
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  });
}

async function renderFeatureManagement(me = {}) {
  const result = await apiFetch("/admin/features");
  const flags = result.flags || [];
  const isSuperAdmin = hasFullAdminAccess(me);
  PAGE_EXPORTS["feature-management"] = flags;
  document.getElementById("page-content").innerHTML = `
    ${renderMetrics([
      ["Features", flags.length],
      ["Enabled", flags.filter((flag) => flag.enabled).length],
      ["Disabled", flags.filter((flag) => !flag.enabled).length],
      ["Access", isSuperAdmin ? "Super Admin" : "Restricted"],
    ])}
    ${tableCard("Feature Management Console", `
      <form id="feature-management-form" class="form-grid">
        ${flags.map((flag) => `
          <label class="toggle-row">
            <input name="${escapeHtml(flag.key)}" type="checkbox" ${flag.enabled ? "checked" : ""} ${isSuperAdmin ? "" : "disabled"}>
            <span>${escapeHtml(flag.label)}</span>
          </label>
        `).join("")}
        ${isSuperAdmin ? `<button class="primary-btn" type="submit">Save Feature Settings</button>` : ""}
      </form>
    `, "Feature flags are stored server-side and can be consumed by TitoPay modules without code changes.", "Super Admin")}
  `;
  document.getElementById("feature-management-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const body = {};
    flags.forEach((flag) => {
      body[flag.key] = formData.get(flag.key) === "on";
    });
    try {
      await apiFetch("/admin/features", {
        method: "PUT",
        body: JSON.stringify(body),
      });
      showToast("Feature settings saved");
      await renderFeatureManagement(me);
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  });
}

async function renderCompanyDocuments() {
  const result = await apiFetch("/admin/company-documents");
  const categories = result.categories || [];
  const documents = result.documents || [];
  PAGE_EXPORTS["company-documents"] = documents.map((document) => ({
    title: document.title,
    category: document.category,
    version: document.version,
    status: document.status,
    fileUrl: document.fileUrl,
    acknowledgements: (document.acknowledgements || []).length,
    updatedAt: document.updatedAt
  }));
  const categoryOptions = categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("");
  const activeDocuments = documents.filter((document) => document.status !== "archived");
  const archivedDocuments = documents.filter((document) => document.status === "archived");
  const renderDocumentRows = (rows) => renderRows(rows, [
    { label: "Document", render: (row) => `<strong>${escapeHtml(row.title)}</strong><br><small>${escapeHtml(row.description || "Controlled company document")}</small>` },
    { label: "Category", key: "category" },
    { label: "Version", render: (row) => `v${escapeHtml(row.version || 1)}` },
    { label: "Status", render: (row) => `<span class="chip ${chipClass(row.status)}">${escapeHtml(row.status || "active")}</span>` },
    { label: "Acknowledgements", render: (row) => escapeHtml(String((row.acknowledgements || []).length)) },
    { label: "Updated", render: (row) => escapeHtml(row.updatedAt ? new Date(row.updatedAt).toLocaleString("en-ZA") : "-") },
  ], (row) => `
    <a class="secondary-btn" href="${escapeHtml(row.fileUrl)}" target="_blank" rel="noopener">Preview</a>
    <button class="secondary-btn" type="button" data-doc-ack="${escapeHtml(row.id)}">Acknowledge</button>
    ${row.status === "archived" ? "" : `<button class="ghost-btn" type="button" data-doc-archive="${escapeHtml(row.id)}">Archive</button>`}
  `);
  const content = document.getElementById("page-content");
  content.innerHTML = `
    <section class="panel-grid">
      <section class="panel">
        <h3>Controlled Document Library</h3>
        <p>Store official document records using approved secure storage URLs. Every create, replace, archive and acknowledgement action is written to audit logs.</p>
        <div class="ops-list ops-list-two">
          <span><strong>${activeDocuments.length}</strong>Active documents</span>
          <span><strong>${archivedDocuments.length}</strong>Archived documents</span>
          <span><strong>${categories.length}</strong>Controlled categories</span>
          <span><strong>Audit</strong>Immutable action logging</span>
        </div>
      </section>
      <section class="panel">
        <h3>Add / Replace Document</h3>
        <form id="company-document-form" class="form-grid">
          <div class="field"><label>Title</label><input name="title" placeholder="Employee Handbook" required></div>
          <div class="field"><label>Category</label><select name="category" required>${categoryOptions}</select></div>
          <div class="field"><label>Secure File URL / Storage Path</label><input name="fileUrl" placeholder="https://secure-storage.titopay.co.za/documents/file.pdf" required></div>
          <div class="field"><label>Description</label><input name="description" placeholder="Approved controlled document"></div>
          <label class="check-row"><input type="checkbox" name="requiresAcknowledgement" checked> Require employee acknowledgement</label>
          <button class="primary-btn" type="submit">Save Document Record</button>
        </form>
      </section>
    </section>
    <section class="panel-grid">
      ${tableCard("Active Documents", renderDocumentRows(activeDocuments), "Official documents visible for authorised staff acknowledgement.")}
      ${tableCard("Archive", renderDocumentRows(archivedDocuments), "Archived documents remain searchable for governance and audit history.")}
    </section>
  `;
  document.getElementById("company-document-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    try {
      await apiFetch("/admin/company-documents", {
        method: "POST",
        body: JSON.stringify({
          title: formData.get("title"),
          category: formData.get("category"),
          fileUrl: formData.get("fileUrl"),
          description: formData.get("description"),
          requiresAcknowledgement: formData.get("requiresAcknowledgement") === "on"
        })
      });
      showToast("Document record saved.");
      await renderCompanyDocuments();
    } catch (error) {
      showToast(adminErrorMessage(error.message || "Unable to save document record."));
    }
  });
}

async function renderSettings() {
  const [maintenanceState] = await Promise.all([
    apiFetch("/admin/maintenance").catch(() => ({ maintenance: {} }))
  ]);
  const maintenance = maintenanceState.maintenance || {};
  PAGE_EXPORTS.settings = [{ key: "maintenance_mode", ...maintenance }];
  const content = document.getElementById("page-content");
  content.innerHTML = `
    <section class="panel-grid">
      <section class="panel">
        <h3>Platform Maintenance Mode</h3>
        <p>Put TitoPay PWA, Admin or HR into maintenance with a visible customer/staff note and expected timeframe. Every change is audited.</p>
        <form id="maintenance-form" class="form-grid">
          ${["pwa", "admin", "hr"].map((key) => `
            <section class="panel">
              <label class="toggle-row"><input type="checkbox" name="${key}_enabled" ${maintenance[key]?.enabled ? "checked" : ""}><span>${key.toUpperCase()} maintenance</span></label>
              <div class="field"><label>${key.toUpperCase()} note</label><input name="${key}_note" value="${escapeHtml(maintenance[key]?.note || "")}" placeholder="Short maintenance message"></div>
              <div class="field"><label>Expected back</label><input name="${key}_expectedBackAt" value="${escapeHtml(maintenance[key]?.expectedBackAt || "")}" placeholder="e.g. Today 18:00 SAST"></div>
            </section>
          `).join("")}
          <button class="primary-btn" type="submit">Save Maintenance Mode</button>
        </form>
      </section>
      <section class="panel">
        <h3>Notification Billing</h3>
        <p>In-app notifications are free. Optional user-enabled SMS notifications are charged at R0.30 per SMS. Security OTP/reset SMS remain operational messages.</p>
        <div class="ops-list ops-list-two">
          <span><strong>Free</strong>In-app notifications</span>
          <span><strong>R0.30</strong>Optional SMS per message</span>
          <span><strong>Free</strong>PIN, password and OTP reset SMS</span>
          <span><strong>User opt-in</strong>Fee preview before enablement</span>
        </div>
      </section>
      <section class="panel">
        <h3>Provider Abstraction</h3>
        <p>Third-party providers are managed in the secure Integration Centre. Super Admins can configure credentials, run connection tests, review logs and monitor webhooks without exposing provider secrets to the Admin Portal frontend.</p>
        <div class="action-row">
          <a class="secondary-btn" href="/integrations/">Open Integration Centre</a>
        </div>
      </section>
    </section>
  `;
  document.getElementById("maintenance-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const target = (key) => ({
      enabled: form.get(`${key}_enabled`) === "on",
      note: form.get(`${key}_note`) || "",
      expectedBackAt: form.get(`${key}_expectedBackAt`) || ""
    });
    try {
      await apiFetch("/admin/maintenance", {
        method: "PUT",
        body: JSON.stringify({ pwa: target("pwa"), admin: target("admin"), hr: target("hr") })
      });
      showToast("Maintenance mode saved");
      await renderSettings();
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  });
}

/* RBAC editor. Reading the matrix stays available to anyone with the
   engineering permission; editing is offered only when the API says this
   session may manage roles (owner, root, super_admin or developer). The API
   enforces that independently — this only decides what is worth showing. */
async function renderRbacPermissions() {
  const result = await apiFetch("/admin/roles");
  const items = result.items || Object.entries(result.roles || {}).map(([role, permissions]) => ({
    role, permissions, builtin: true, protected: ["owner", "root", "super_admin"].includes(role), customised: false
  }));
  /* The API's availablePermissions list predates the console's newer modules,
     so granting them was impossible from this screen. The checklist is now the
     union of what the API offers, every permission already held by any role,
     and the console's own module gates - deduplicated case-sensitively, since
     permissions are matched exactly. */
  const CONSOLE_MODULE_PERMISSIONS = ["analytics", "reporting", "service_builder"];
  const available = [...new Set([
    ...(result.availablePermissions || []),
    ...items.flatMap((row) => row.permissions).filter((perm) => perm !== "*"),
    ...CONSOLE_MODULE_PERMISSIONS,
  ])].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  const canManage = Boolean(result.canManage);
  PAGE_EXPORTS["rbac-permissions"] = items.map((row) => ({
    role: row.role,
    access: row.permissions.includes("*") ? "Full platform access" : `${row.permissions.length} permissions`,
    permissions: row.permissions.join(", ")
  }));

  const editing = PAGE_EXPORTS.rbacEditing;
  const editRow = editing ? items.find((row) => row.role === editing) : null;

  const permissionChecklist = (selected, disabled) => {
    const all = selected.includes("*");
    return `
      <label class="toggle-row rbac-full">
        <input type="checkbox" name="fullAccess" ${all ? "checked" : ""} ${disabled ? "disabled" : ""}>
        <span>Full platform access (*)</span>
      </label>
      <div class="rbac-permission-grid">
        ${[...new Set([...available, ...selected.filter((perm) => perm !== "*")])].map((perm) => `
          <label class="check-row">
            <input type="checkbox" name="permissions" value="${escapeHtml(perm)}" ${selected.includes(perm) ? "checked" : ""} ${all || disabled ? "disabled" : ""}>
            <span>${escapeHtml(perm.replace(/_/g, " "))}</span>
          </label>
        `).join("")}
      </div>
      ${disabled ? "" : `
        <div class="rbac-add-permission">
          <label class="visually-hidden" for="rbac-new-permission">Add a permission by name</label>
          <input id="rbac-new-permission" placeholder="Add a permission by name, e.g. reports_export" maxlength="64" autocomplete="off" spellcheck="false">
          <button class="secondary-btn" type="button" data-rbac-add-permission>Add permission</button>
        </div>
        <p class="field-hint">Letters, numbers, underscores, dots and dashes. The API enforces what each permission actually unlocks - adding a name here only stores it on the role.</p>
      `}
    `;
  };

  document.getElementById("page-content").innerHTML = `
    ${editRow ? `
      <section class="table-card">
        <div class="table-card-header">
          <div>
            <h3>Edit role: ${escapeHtml(editRow.role)}</h3>
            <p class="table-card-note">${editRow.protected
              ? "This role must keep full access so the console cannot lock everyone out."
              : "Changes apply to every staff account with this role, immediately."}</p>
          </div>
          <button class="secondary-btn" type="button" data-rbac-cancel>Cancel</button>
        </div>
        <form id="rbac-edit-form" data-rbac-role="${escapeHtml(editRow.role)}">
          ${permissionChecklist(editRow.permissions, editRow.protected)}
          <div class="form-actions">
            <button class="primary-btn" type="submit" ${editRow.protected ? "disabled" : ""}>Save permissions</button>
            ${!editRow.builtin ? `<button class="ghost-btn" type="button" data-rbac-delete="${escapeHtml(editRow.role)}">Delete role</button>` : ""}
          </div>
        </form>
      </section>
    ` : ""}

    ${canManage && !editRow ? `
      <section class="panel">
        <h3>Create a new role</h3>
        <p>Custom roles apply immediately to any staff account assigned to them, and can be edited or deleted here later.</p>
        <form id="rbac-create-form" class="form-grid">
          <label>Role name<input name="role" required maxlength="40" pattern="[a-z0-9_]+" placeholder="reports_analyst" autocapitalize="none" spellcheck="false"></label>
          <label>Description<input name="description" maxlength="160" placeholder="What this role is for"></label>
          <div class="field-full">${permissionChecklist([], false)}</div>
          <div class="form-actions">
            <button class="primary-btn" type="submit">Create role</button>
          </div>
        </form>
      </section>
    ` : ""}

    ${tableCard("Role permissions", renderRows(items, [
      { label: "Role", render: (row) => `<strong>${escapeHtml(row.role.replace(/_/g, " "))}</strong><br><small>${row.builtin ? "Built-in" : "Custom"}${row.customised && row.builtin ? " · edited" : ""}</small>` },
      { label: "Access", render: (row) => `<span class="chip ${row.permissions.includes("*") ? "green" : "blue"}">${row.permissions.includes("*") ? "Full access" : `${row.permissions.length} permissions`}</span>` },
      { label: "Permissions", render: (row) => row.permissions.includes("*")
        ? "<small>Every module and action</small>"
        : `<small>${escapeHtml(row.permissions.map((p) => p.replace(/_/g, " ")).join(", ") || "None")}</small>` },
    ], (row) => canManage ? `<button data-rbac-edit="${escapeHtml(row.role)}">Edit</button>` : "")
    , canManage ? "" : "Only a Developer or Super Admin can change roles and permissions.")}
  `;

  document.getElementById("rbac-edit-form")?.addEventListener("change", syncRbacFullAccess);
  document.getElementById("rbac-create-form")?.addEventListener("change", syncRbacFullAccess);
}

/* Granting "*" makes the individual permissions meaningless, so they are
   disabled rather than left looking selectable. */
function syncRbacFullAccess(event) {
  const form = event.currentTarget;
  const full = form.querySelector('[name="fullAccess"]')?.checked;
  form.querySelectorAll('[name="permissions"]').forEach((box) => {
    box.disabled = Boolean(full);
  });
}

function rbacFormPermissions(form) {
  if (form.querySelector('[name="fullAccess"]')?.checked) return ["*"];
  return Array.from(form.querySelectorAll('[name="permissions"]:checked')).map((box) => box.value);
}

async function renderStaffManagement() {
  const result = await apiFetch("/admin/staff");
  const rows = result.items || [];
  const staffRoles = [
    "ceo",
    "developer",
    "super_admin",
    "coo",
    "engineering",
    "customer_support",
    "compliance",
    "finance",
    "marketing",
  ];
  PAGE_EXPORTS["staff-management"] = rows;
  document.getElementById("page-content").innerHTML = `
    ${renderMetrics([
      ["Staff Accounts", rows.length],
      ["Active", rows.filter((row) => row.status === "active").length],
      ["Locked", rows.filter((row) => row.locked_until && new Date(row.locked_until).getTime() > Date.now()).length],
      ["Roles", new Set(rows.map((row) => row.role)).size],
    ])}
    <section class="panel">
      <h3>Add Staff Member</h3>
      <p>Create real Admin Portal staff access. Only CEO, Developer, Owner, Root and Super Admin roles may create staff accounts.</p>
      <form id="staff-create-form" class="form-grid">
        <label>Full name<input name="fullName" required maxlength="160" placeholder="Staff full name"></label>
        <label>Username<input name="username" required maxlength="80" placeholder="firstname.lastname"></label>
        <label>Email<input name="email" type="email" required maxlength="180" placeholder="name@titopay.co.za"></label>
        <label>Role
          <select name="role" required>
            ${staffRoles.map((role) => `<option value="${escapeHtml(role)}">${escapeHtml(role.replace(/_/g, " "))}</option>`).join("")}
          </select>
        </label>
        <label>Status
          <select name="status">
            <option value="active">active</option>
            <option value="inactive">inactive</option>
            <option value="suspended">suspended</option>
          </select>
        </label>
        <label>Temporary password<input name="password" type="password" required minlength="8" maxlength="200" autocomplete="new-password" placeholder="Minimum 8 characters"></label>
        <div class="form-actions">
          <button class="primary-btn" type="submit">Create Staff Account</button>
        </div>
      </form>
    </section>
    ${tableCard("Admin Staff Access", renderRows(rows, [
      { label: "Staff", render: (row) => `<strong>${escapeHtml(row.full_name || row.username)}</strong><br><small>${escapeHtml(row.email || "-")}</small>` },
      { label: "Role", render: (row) => `<span class="chip blue">${escapeHtml(row.role)}</span>` },
      { label: "Status", render: (row) => `<span class="chip ${chipClass(row.status)}">${escapeHtml(row.status || "-")}</span>` },
      { label: "Failed Login", render: (row) => escapeHtml(row.failed_login_attempts || 0) },
      { label: "Last Login", render: (row) => escapeHtml(row.last_login_at ? new Date(row.last_login_at).toLocaleString("en-ZA") : "Never") },
    ], () => ""), "This page reads and creates real admin_users records only. Temporary passwords are never displayed again.")}
  `;
}

async function renderEngineeringTools() {
  const [health, integrations] = await Promise.all([
    apiFetch("/admin/module-health"),
    apiFetch("/admin/integrations/config").catch(() => ({ providers: [] }))
  ]);
  const tables = health.tables || [];
  const providers = integrations.providers || [];
  PAGE_EXPORTS["engineering-tools"] = [{ type: "module-health", ...health }, ...providers];
  document.getElementById("page-content").innerHTML = `
    ${renderMetrics([
      ["API Base", health.apiBase || "/v1"],
      ["Tables OK", tables.filter((row) => row.exists).length],
      ["Tables Missing", tables.filter((row) => !row.exists).length],
      ["Providers", providers.length],
    ])}
    ${tableCard("Required Database Tables", renderRows(tables, [
      { label: "Table", key: "table_name" },
      { label: "Status", render: (row) => `<span class="chip ${row.exists ? "green" : "red"}">${row.exists ? "Present" : "Missing"}</span>` },
    ], () => ""))}
    ${tableCard("Provider Runtime", renderRows(providers, [
      { label: "Provider", render: (row) => `<strong>${escapeHtml(row.label || row.key)}</strong><br><small>${escapeHtml(row.key || "-")}</small>` },
      { label: "Environment", render: (row) => escapeHtml(row.environment || row.mode || "-") },
      { label: "Status", render: (row) => `<span class="chip ${chipClass(row.status)}">${escapeHtml(row.status || "not_tested")}</span>` },
    ], () => ""), "Secrets remain masked and are never exposed here.")}
  `;
}

async function renderDevelopmentTools() {
  const health = await apiFetch("/admin/module-health");
  const modules = health.modules || {};
  PAGE_EXPORTS["development-tools"] = Object.entries(modules).map(([module, details]) => ({ module, ...details }));
  document.getElementById("page-content").innerHTML = `
    <section class="panel">
      <h3>Deployment Readiness</h3>
      <p>Owner-only operational route map for confirming Admin modules are backed by real API routes and required database tables.</p>
    </section>
    ${tableCard("Module Route Map", renderRows(PAGE_EXPORTS["development-tools"], [
      { label: "Module", key: "module" },
      { label: "Route", key: "route" },
      { label: "Update Route", render: (row) => escapeHtml(row.updateRoute || "-") },
      { label: "Tables", render: (row) => escapeHtml((row.requiredTables || []).join(", ")) },
    ], () => ""))}
  `;
}

async function renderDatabaseHealth() {
  const health = await apiFetch("/admin/module-health");
  const tables = health.tables || [];
  PAGE_EXPORTS["database-health"] = tables;
  document.getElementById("page-content").innerHTML = `
    ${renderMetrics([
      ["Required Tables", tables.length],
      ["Present", tables.filter((row) => row.exists).length],
      ["Missing", tables.filter((row) => !row.exists).length],
      ["API Route Prefix", health.apiBase || "/v1"],
    ])}
    ${tableCard("Database / Health", renderRows(tables, [
      { label: "Table", key: "table_name" },
      { label: "Status", render: (row) => `<span class="chip ${row.exists ? "green" : "red"}">${row.exists ? "Present" : "Missing"}</span>` },
    ], () => ""))}
  `;
}


async function renderQrManagement() {
  const content = document.getElementById("page-content");
  PAGE_EXPORTS["qr-management"] = [];
  content.innerHTML = `
    <section class="panel-grid">
      <section class="panel">
        <h3>QR Control Centre</h3>
        <p>Create branded TitoPay QR assets for website, app downloads, onboarding, campaigns, events and referrals. QR generation is routed through the TitoPay API.</p>
        <div class="ops-list ops-list-two">
          <span><strong>Live</strong>QR generation</span>
          <span><strong>Brand</strong>TitoPay output</span>
          <span><strong>Ready</strong>PNG / SVG / PDF Export</span>
          <span><strong>Print</strong>Camera-readable assets</span>
        </div>
      </section>
      <section class="panel">
        <h3>Create QR Asset</h3>
        <form id="qr-asset-form" class="form-grid">
          <div class="field"><label>QR Type</label><select name="type" required><option value="website">Website QR</option><option value="app_download">App QR</option><option value="merchant_qr">Merchant QR</option><option value="business_qr">Business QR</option><option value="referral_qr">Referral QR</option><option value="campaign">Campaign QR</option><option value="invoice_qr">Invoice QR</option><option value="product_qr">Product QR</option><option value="support_qr">Support QR</option><option value="merchant_onboarding">Merchant Onboarding</option><option value="business_registration">Business Registration</option><option value="personal_registration">Personal Registration</option><option value="marketing">Marketing QR Code</option><option value="event">Event QR Code</option><option value="dynamic_url">Dynamic URL</option></select></div>
          <div class="field"><label>Asset Label</label><input name="label" placeholder="Public launch campaign" required></div>
          <div class="field"><label>Destination URL</label><input name="destinationUrl" placeholder="https://titopay.co.za" required></div>
          <button class="primary-btn" type="submit">Create QR Asset</button>
        </form>
      </section>
    </section>
    <section id="qr-preview-host"></section>
  `;
  document.getElementById("qr-asset-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    try {
      const result = await apiFetch("/admin/qr-assets", {
        method: "POST",
        body: JSON.stringify({
          type: formData.get("type"),
          label: formData.get("label"),
          destinationUrl: formData.get("destinationUrl"),
        }),
      });
      const asset = result.asset;
      PAGE_EXPORTS["qr-management"] = [asset];
      document.getElementById("qr-preview-host").innerHTML = renderQrPreview(asset);
      showToast("QR asset generated");
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  });
}

function canApproveMarketingSms(role) {
  return ["owner", "root", "ceo", "coo", "super_admin"].includes(normalizeAdminRole(role));
}

function smsStatusChip(status = "") {
  const text = String(status || "pending_approval").replaceAll("_", " ");
  if (status === "sent") return `<span class="chip green">${escapeHtml(text)}</span>`;
  if (status === "sent_with_failures") return `<span class="chip orange">${escapeHtml(text)}</span>`;
  if (status === "failed") return `<span class="chip red">${escapeHtml(text)}</span>`;
  return `<span class="chip">${escapeHtml(text)}</span>`;
}

function renderMarketingSmsCampaigns(campaigns = [], canApprove = false) {
  if (!campaigns.length) {
    return `<p class="table-card-note">No SMS campaigns have been submitted yet.</p>`;
  }
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Campaign</th>
            <th>Audience</th>
            <th>Recipients</th>
            <th>Status</th>
            <th>Sent</th>
            <th>Failed</th>
            <th>Created</th>
            <th>Approval</th>
          </tr>
        </thead>
        <tbody>
          ${campaigns.map((campaign) => `
            <tr>
              <td>
                <strong>${escapeHtml(campaign.title)}</strong>
                <small>${escapeHtml(String(campaign.message || "").slice(0, 120))}${String(campaign.message || "").length > 120 ? "…" : ""}</small>
              </td>
              <td>${escapeHtml(campaign.audience === "specific" && campaign.targetLabel ? `Specific: ${campaign.targetLabel}` : campaign.audience)}</td>
              <td>${escapeHtml(campaign.estimatedRecipients ?? 0)}</td>
              <td>${smsStatusChip(campaign.status)}</td>
              <td>${escapeHtml(campaign.sentCount ?? 0)}</td>
              <td>${escapeHtml(campaign.failedCount ?? 0)}</td>
              <td>${escapeHtml(campaign.createdAt ? new Date(campaign.createdAt).toLocaleString("en-ZA") : "-")}</td>
              <td>
                ${campaign.status === "pending_approval" && canApprove
                  ? `<button type="button" class="secondary-btn" data-marketing-sms-approve="${escapeHtml(campaign.id)}">Approve & Send</button>`
                  : escapeHtml(campaign.approvedByRole ? `Approved by ${campaign.approvedByRole}` : "Awaiting CEO/COO")}
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderMarketingEmailCampaigns(campaigns=[],canApprove=false){if(!campaigns.length)return `<p class="table-card-note">No email productions have been submitted yet.</p>`;return `<div class="table-wrap"><table><thead><tr><th>Production</th><th>Subject</th><th>Audience</th><th>Recipients</th><th>Status</th><th>Queued</th><th>Failed</th><th>Approval</th></tr></thead><tbody>${campaigns.map((campaign)=>`<tr><td><strong>${escapeHtml(campaign.title)}</strong><small>${escapeHtml(String(campaign.textBody||"").slice(0,120))}${String(campaign.textBody||"").length>120?"…":""}</small></td><td>${escapeHtml(campaign.subject)}</td><td>${escapeHtml(campaign.audience==="specific"&&campaign.targetLabel?`Specific: ${campaign.targetLabel}`:campaign.audience)}</td><td>${escapeHtml(campaign.estimatedRecipients||0)}</td><td>${smsStatusChip(campaign.status)}</td><td>${escapeHtml(campaign.queuedCount||0)}</td><td>${escapeHtml(campaign.failedCount||0)}</td><td>${campaign.status==="pending_approval"&&canApprove?`<button type="button" class="secondary-btn" data-marketing-email-approve="${escapeHtml(campaign.id)}">Approve & Publish</button>`:escapeHtml(campaign.approvedByRole?`Approved by ${campaign.approvedByRole}`:"Awaiting CEO/COO")}</td></tr>`).join("")}</tbody></table></div>`;}

function renderInAppAnnouncements(campaigns = [], approvalRole = null) {
  if (!campaigns.length) {
    return `<p class="table-card-note">No in-app announcements have been submitted yet.</p>`;
  }
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Announcement</th>
            <th>Category</th>
            <th>Audience</th>
            <th>Recipients</th>
            <th>Status</th>
            <th>Approvals</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${campaigns.map((campaign) => {
            const approvals = Array.isArray(campaign.approvals) ? campaign.approvals : [];
            const approvedRoles = new Set(approvals.map((approval) => String(approval.role || approval.approval_role || "").toLowerCase()));
            const canApprove = campaign.status === "pending_approval" && approvalRole && !approvedRoles.has(approvalRole);
            const approvalStatus = campaign.status === "sent" ? "sent" : "Pending CEO or COO approval";
            return `
              <tr>
                <td>
                  <strong>${escapeHtml(campaign.title)}</strong>
                  <small>${escapeHtml(String(campaign.body || "").slice(0, 160))}${String(campaign.body || "").length > 160 ? "…" : ""}</small>
                </td>
                <td>${escapeHtml(campaign.category)}</td>
                <td>${escapeHtml(campaign.audience)}</td>
                <td>${escapeHtml(campaign.sent_count ?? campaign.estimated_recipients ?? 0)}</td>
                <td>${campaign.status === "sent" ? smsStatusChip("sent") : `<span class="chip">${escapeHtml(approvalStatus)}</span>`}</td>
                <td>${approvedRoles.size ? escapeHtml([...approvedRoles].map((role) => role.toUpperCase()).join(" + ")) : "Awaiting CEO or COO"}</td>
                <td>
                  ${canApprove
                    ? `<button type="button" class="secondary-btn" data-announcement-approve="${escapeHtml(campaign.id)}">Approve as ${escapeHtml(approvalRole.toUpperCase())}</button>`
                    : campaign.status === "sent"
                      ? "Delivered in app"
                      : approvalRole
                        ? `${escapeHtml(approvalRole.toUpperCase())} approval recorded`
                        : "CEO/COO approval only"}
                </td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderPwaReviews(reviews = []) {
  if (!reviews.length) {
    return `<p class="table-card-note">No PWA reviews have been submitted yet.</p>`;
  }
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Rating</th>
            <th>User</th>
            <th>Area</th>
            <th>Feedback</th>
            <th>Contact</th>
            <th>Submitted</th>
          </tr>
        </thead>
        <tbody>
          ${reviews.map((review) => `
            <tr>
              <td><strong>${escapeHtml(review.rating || 0)}/5</strong></td>
              <td>
                <strong>${escapeHtml(review.userName || "TitoPay user")}</strong>
                <small>${escapeHtml(review.username ? `@${review.username}` : review.accountType || "customer")}</small>
              </td>
              <td>${escapeHtml(String(review.category || "general").replaceAll("_", " "))}</td>
              <td><small>${escapeHtml(review.message || "")}</small></td>
              <td>${review.contactPermission ? `${escapeHtml(review.phone || "")}${review.email ? `<br><small>${escapeHtml(review.email)}</small>` : ""}` : "No contact permission"}</td>
              <td>${escapeHtml(review.createdAt ? new Date(review.createdAt).toLocaleString("en-ZA") : "-")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

async function renderMarketing(me = {}) {
  const content = document.getElementById("page-content");
  const [smsState, announcementState, reviewState, emailState] = await Promise.all([
    apiFetch("/admin/marketing/sms-campaigns"),
    apiFetch("/admin/marketing/announcements"),
    apiFetch("/admin/marketing/reviews"),
    apiFetch("/admin/marketing/email-campaigns")
  ]);
  const rows = smsState.campaigns || [];
  const announcements = announcementState.campaigns || [];
  const reviews = reviewState.reviews || [];
  const emailCampaigns = emailState.campaigns || [];
  const reviewSummary = reviewState.summary || {};
  PAGE_EXPORTS.marketing = [...announcements, ...rows, ...emailCampaigns, ...reviews];
  PAGE_EXPORTS.marketingSmsCampaigns = rows;
  PAGE_EXPORTS.marketingAnnouncements = announcements;
  PAGE_EXPORTS.marketingAnnouncementApprovalRole = announcementState.approvalRole || null;
  PAGE_EXPORTS.marketingReviews = reviews;
  PAGE_EXPORTS.marketingEmailCampaigns = emailCampaigns;
  PAGE_EXPORTS.marketingQrAssets = PAGE_EXPORTS.marketingQrAssets || [];
  const canApprove = Boolean(smsState.canApprove || canApproveMarketingSms(me.role));
  const audiences = smsState.audiences || { personal: 0, business: 0, both: 0 };
  content.innerHTML = `
    <section class="panel-grid">
      <section class="panel">
        <h3>Marketing Centre</h3>
        <p>Create PWA in-app announcements, marketing communications, campaign links, QR campaigns and controlled SMS broadcasts. In-app announcements require CEO or COO approval before delivery.</p>
        <div class="ops-list ops-list-two">
          <span><strong>${escapeHtml(audiences.personal || 0)}</strong>Personal SMS recipients</span>
          <span><strong>${escapeHtml(audiences.business || 0)}</strong>Business SMS recipients</span>
          <span><strong>CEO / COO</strong>Approval required</span>
          <span><strong>${escapeHtml(announcementState.audiences?.both || 0)}</strong>In-app recipients</span>
          <span><strong>Audit</strong>Every action logged</span>
          <span><strong>${escapeHtml(reviewSummary.total || 0)}</strong>PWA reviews</span>
          <span><strong>${escapeHtml(reviewSummary.averageRating || 0)}/5</strong>Average rating</span>
        </div>
      </section>
      <section class="panel">
        <h3>PWA In-App Announcement</h3>
        <form id="marketing-announcement-form" class="form-grid">
          <div class="field"><label>Audience</label><select name="audience" id="announcement-audience" required><option value="personal">Personal users</option><option value="business">Business users</option><option value="specific">Specific user</option><option value="both">Personal and Business users</option></select></div>
          <div class="field"><label>Category</label><select name="category" required><option value="general">General announcement</option><option value="marketing">Marketing</option><option value="service">Service update</option><option value="security">Security notice</option></select></div>
          <div class="field field-full" id="announcement-recipient-field" hidden><label>Specific TitoPay user</label><input name="recipient" maxlength="160" placeholder="Exact username, email or cellphone number"><small>Only the resolved active TitoPay user will receive this announcement.</small></div>
          <div class="field field-full"><label>Title</label><input name="title" placeholder="What customers will see" maxlength="120" required></div>
          <div class="field field-full"><label>Message</label><textarea name="body" rows="6" maxlength="1200" placeholder="Write the in-app notification exactly as customers should receive it." required></textarea></div>
          <button class="primary-btn" type="submit">Submit for CEO/COO Approval</button>
        </form>
      </section>
      <section class="panel">
        <h3>Bulk SMS Broadcast</h3>
        <form id="marketing-sms-form" class="form-grid">
          <div class="field"><label>Audience</label><select name="audience" id="sms-audience" required><option value="personal">Personal users</option><option value="business">Business users</option><option value="specific">Specific user</option><option value="both">Personal and Business users</option></select></div>
          <div class="field"><label>Campaign Title</label><input name="title" placeholder="Holiday security notice" maxlength="120" required></div>
          <div class="field field-full" id="sms-recipient-field" hidden><label>Specific TitoPay user</label><input name="recipient" maxlength="160" placeholder="Exact username, email or cellphone number"><small>The selected user must have an active TitoPay account and cellphone number.</small></div>
          <div class="field field-full"><label>SMS Message</label><textarea name="message" rows="5" maxlength="612" placeholder="Write the message exactly as customers should receive it." required></textarea></div>
          <button class="primary-btn" type="submit">Submit for CEO/COO Approval</button>
        </form>
      </section>
      <section class="panel">
        <h3>Email Production</h3>
        <p>Draft a branded email request for CEO/COO approval. Publishing places one idempotent job per recipient into the Email Centre queue.</p>
        <form id="marketing-email-form" class="form-grid">
          <div class="field"><label>Audience</label><select name="audience" id="marketing-email-audience" required><option value="personal">Personal users</option><option value="business">Business users</option><option value="specific">Specific user</option><option value="both">Personal and Business users</option></select></div>
          <div class="field"><label>Production title</label><input name="title" maxlength="120" placeholder="Monthly product update" required></div>
          <div class="field field-full" id="marketing-email-recipient-field" hidden><label>Specific TitoPay user</label><input name="recipient" maxlength="160" placeholder="Exact username or email"><small>The user must have an active TitoPay account and email address.</small></div>
          <div class="field field-full"><label>Email subject</label><input name="subject" maxlength="200" required></div>
          <div class="field field-full"><label>HTML body</label><textarea name="htmlBody" rows="8" maxlength="50000" required></textarea></div>
          <div class="field field-full"><label>Plain-text body</label><textarea name="textBody" rows="6" maxlength="20000" required></textarea></div>
          <button class="primary-btn" type="submit">Submit Email for CEO/COO Approval</button>
        </form>
      </section>
      <section class="panel">
        <h3>Create Campaign QR</h3>
        <form id="marketing-campaign-form" class="form-grid">
          <div class="field"><label>Campaign Name</label><input name="label" placeholder="Public launch campaign" required></div>
          <div class="field"><label>Destination URL</label><input name="destinationUrl" placeholder="https://titopay.co.za/app" required></div>
          <button class="primary-btn" type="submit">Create Campaign Link</button>
        </form>
      </section>
    </section>
    <section id="campaign-preview-host"></section>
    ${tableCard("PWA Announcement Approval Queue", renderInAppAnnouncements(announcements, announcementState.approvalRole || null), "Announcements are delivered to the TitoPay PWA inbox after approval by either the CEO or COO. No SMS is sent by this workflow.")}
    ${tableCard("PWA Reviews - Help us improve", renderPwaReviews(reviews), "Reviews submitted from the TitoPay PWA Profile page. Contact details are only shown where the user gave permission.")}
    ${tableCard("SMS Approval Queue", renderMarketingSmsCampaigns(rows, canApprove), "Marketing and Communications can draft SMS messages. CEO or COO approval sends the message to existing TitoPay phone numbers for the selected audience.")}
    ${tableCard("Email Production Approval Queue", renderMarketingEmailCampaigns(emailCampaigns, Boolean(emailState.canApprove || canApprove)), "Approved productions publish through the Email Centre background queue. Email notification delivery is free; configured OTP and statement prices remain separate pricing services.")}
  `;
  const announcementAudience = document.getElementById("announcement-audience");
  const announcementRecipientField = document.getElementById("announcement-recipient-field");
  const syncAnnouncementRecipient = () => {
    const specific = announcementAudience?.value === "specific";
    if (announcementRecipientField) announcementRecipientField.hidden = !specific;
    const input = announcementRecipientField?.querySelector("input");
    if (input) input.required = specific;
  };
  announcementAudience?.addEventListener("change", syncAnnouncementRecipient);
  syncAnnouncementRecipient();
  document.getElementById("marketing-announcement-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    try {
      await apiFetch("/admin/marketing/announcements", {
        method: "POST",
        body: JSON.stringify({
          audience: formData.get("audience"),
          category: formData.get("category"),
          title: formData.get("title"),
          body: formData.get("body"),
          recipient: formData.get("recipient"),
        }),
      });
      showToast("In-app announcement submitted for CEO/COO approval");
      await renderMarketing(PAGE_EXPORTS.currentMe || {});
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  });
  document.getElementById("marketing-sms-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    try {
      await apiFetch("/admin/marketing/sms-campaigns", {
        method: "POST",
        body: JSON.stringify({
          audience: formData.get("audience"),
          title: formData.get("title"),
          message: formData.get("message"),
          recipient: formData.get("recipient"),
        }),
      });
      showToast("SMS campaign submitted for CEO/COO approval");
      await renderMarketing(PAGE_EXPORTS.currentMe || {});
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  });
  const smsAudience = document.getElementById("sms-audience");
  const smsRecipientField = document.getElementById("sms-recipient-field");
  const syncSmsRecipient = () => {
    const specific = smsAudience?.value === "specific";
    if (smsRecipientField) smsRecipientField.hidden = !specific;
    const input = smsRecipientField?.querySelector("input");
    if (input) input.required = specific;
  };
  smsAudience?.addEventListener("change", syncSmsRecipient);
  syncSmsRecipient();
  const emailAudience=document.getElementById("marketing-email-audience"),emailRecipientField=document.getElementById("marketing-email-recipient-field");
  const syncEmailRecipient=()=>{const specific=emailAudience?.value==="specific";if(emailRecipientField)emailRecipientField.hidden=!specific;const input=emailRecipientField?.querySelector("input");if(input)input.required=specific;};
  emailAudience?.addEventListener("change",syncEmailRecipient);syncEmailRecipient();
  document.getElementById("marketing-email-form")?.addEventListener("submit",async(event)=>{event.preventDefault();const data=new FormData(event.currentTarget);try{await apiFetch("/admin/marketing/email-campaigns",{method:"POST",body:JSON.stringify({audience:data.get("audience"),title:data.get("title"),recipient:data.get("recipient"),subject:data.get("subject"),htmlBody:data.get("htmlBody"),textBody:data.get("textBody")})});showToast("Email production submitted for CEO/COO approval");await renderMarketing(PAGE_EXPORTS.currentMe||{});}catch(error){showToast(adminErrorMessage(error.message));}});
  document.querySelectorAll("[data-marketing-email-approve]").forEach((button)=>button.addEventListener("click",async()=>{if(!window.confirm("Approve and publish this email production to the selected audience?"))return;button.disabled=true;try{await apiFetch(`/admin/marketing/email-campaigns/${button.dataset.marketingEmailApprove}/approve`,{method:"POST",body:"{}"});showToast("Email production published to the Email Centre queue");await renderMarketing(PAGE_EXPORTS.currentMe||{});}catch(error){showToast(adminErrorMessage(error.message));button.disabled=false;}}));
  document.getElementById("marketing-campaign-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    try {
      const result = await apiFetch("/admin/qr-assets", {
        method: "POST",
        body: JSON.stringify({
          type: "campaign",
          label: formData.get("label"),
          destinationUrl: formData.get("destinationUrl"),
        }),
      });
      const asset = result.asset;
      PAGE_EXPORTS.marketingQrAssets = [asset, ...(PAGE_EXPORTS.marketingQrAssets || [])];
      document.getElementById("campaign-preview-host").innerHTML = renderQrPreview(asset);
      showToast("Campaign QR generated");
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  });
}

function renderQrPreview(asset) {
  if (!asset) return "";
  return tableCard("Generated QR Asset", `
    <div class="qr-preview-card">
      <img src="${escapeHtml(asset.pngDataUrl)}" alt="${escapeHtml(asset.label)} QR code">
      <div>
        <h4>${escapeHtml(asset.label)}</h4>
        <p>${escapeHtml(asset.destinationUrl)}</p>
        <dl class="smtp-detail-grid">
          <div><dt>Type</dt><dd>${escapeHtml(asset.type)}</dd></div>
          <div><dt>Reference</dt><dd>${escapeHtml(asset.reference)}</dd></div>
          <div><dt>Created</dt><dd>${escapeHtml(new Date(asset.createdAt).toLocaleString("en-ZA"))}</dd></div>
          <div><dt>Exports</dt><dd>PNG, SVG, PDF</dd></div>
        </dl>
        <div class="action-row">
          <button class="secondary-btn" type="button" data-qr-download-png="${escapeHtml(asset.reference)}">Download PNG</button>
          <button class="secondary-btn" type="button" data-qr-download-svg="${escapeHtml(asset.reference)}">Download SVG</button>
          <button class="secondary-btn" type="button" data-qr-print="${escapeHtml(asset.reference)}">Print / Save PDF</button>
        </div>
      </div>
    </div>
  `);
}

function emailStatusChip(status) {
  const value = String(status || "unknown").toLowerCase();
  const tone = ["delivered", "sent", "enabled"].includes(value) ? "green" : ["failed", "dead_lettered", "cancelled", "disabled"].includes(value) ? "red" : "blue";
  return `<span class="chip ${tone}">${escapeHtml(value.replaceAll("_", " "))}</span>`;
}

function hasEmailPermission(me, permission) {
  return hasFullAdminAccess(me) || new Set(me?.permissions || []).has(permission);
}

function emailChart(title, rows, labelKey, valueKey) {
  const maximum = Math.max(1, ...rows.map((row) => Number(row[valueKey] || 0)));
  return `<section class="table-card"><h3>${escapeHtml(title)}</h3><div class="email-chart">${rows.length ? rows.map((row) => `
    <div class="email-chart-row"><span>${escapeHtml(row[labelKey] || "-")}</span><div><i style="width:${Math.max(2, Math.round(Number(row[valueKey] || 0) / maximum * 100))}%"></i></div><strong>${escapeHtml(row[valueKey] || 0)}</strong></div>
  `).join("") : '<div class="empty">No email activity in this period.</div>'}</div></section>`;
}

function emailAnalyticsChart(title, rows) {
  const chartRows=(rows||[]).map((row)=>({label:String(row.period||"").slice(0,10),value:Number(row.sent||0)}));
  return emailChart(title,chartRows,"label","value");
}

function analyticsRate(value, supported) {
  return supported ? `${Number(value||0).toFixed(2)}%` : "Not available";
}

async function renderEmailAnalytics() {
  const result=await apiFetch("/admin/email/analytics?days=30");
  const summary=result.summary||{};
  const note=!summary.open_tracking_supported&&!summary.click_tracking_supported
    ? "Open and click rates become available when your email provider sends signed open/click webhook events."
    : "Open and click rates are calculated from provider webhook events; they are not estimated from delivery. ";
  document.getElementById("page-content").innerHTML=`
    ${renderMetrics([["Total emails sent",summary.total_sent||0],["Delivered",summary.delivered||0],["Open rate",analyticsRate(summary.open_rate,summary.open_tracking_supported)],["Click rate",analyticsRate(summary.click_rate,summary.click_tracking_supported)],["Bounce rate",`${Number(summary.bounce_rate||0).toFixed(2)}%`],["Spam complaints",summary.spam_complaints||0],["Average delivery",`${summary.average_delivery_seconds||0}s`]])}
    <p class="table-card-note analytics-note">${escapeHtml(note)} Reporting window: last ${Number(result.rangeDays||30)} days.</p>
    <div class="email-chart-grid">${emailAnalyticsChart("Daily emails sent",result.series?.daily||[])}${emailAnalyticsChart("Weekly emails sent",result.series?.weekly||[])}${emailAnalyticsChart("Monthly emails sent",result.series?.monthly||[])}</div>
    ${tableCard("Delivery detail",renderRows((result.series?.daily||[]).slice(-14).reverse(),[{label:"Period",render:(row)=>formatDate(row.period)},{label:"Sent",key:"sent"},{label:"Delivered",key:"delivered"},{label:"Bounced",key:"bounced"},{label:"Opened",key:"opened"},{label:"Clicked",key:"clicked"},{label:"Spam complaints",key:"spam_complaints"},{label:"Avg delivery",render:(row)=>`${row.average_delivery_seconds||0}s`}]))}`;
}

function emailPagination(total,page,limit,prefix) {
  const pages=Math.max(1,Math.ceil(Number(total||0)/Number(limit||25)));
  if(pages<=1)return "";
  return `<div class="action-row"><button class="secondary-btn" type="button" data-${prefix}-page="${page-1}" ${page<=1?"disabled":""}>Previous</button><span>Page ${page} of ${pages}</span><button class="secondary-btn" type="button" data-${prefix}-page="${page+1}" ${page>=pages?"disabled":""}>Next</button></div>`;
}

async function renderEmailDashboard() {
  const result = await apiFetch("/admin/email/dashboard");
  const metrics = result.metrics || {};
  PAGE_EXPORTS["email-centre"] = result.recentActivity || [];
  document.getElementById("page-content").innerHTML = `
    ${renderMetrics([["Sent today",metrics.sent_today||0],["Delivered today",metrics.delivered_today||0],["Failed today",metrics.failed_today||0],["Currently queued",metrics.queued||0],["Delivery rate",`${metrics.delivery_rate||0}%`],["Average delivery",`${metrics.average_delivery_seconds||0}s`]])}
    <div class="email-chart-grid">${emailChart("Emails sent per day",result.charts?.perDay||[],"day","sent")}${emailChart("Successful versus failed",result.charts?.deliveryOutcomes||[],"outcome","count")}${emailChart("Emails by template",result.charts?.byTemplate||[],"template_key","count")}${emailChart("Queue activity",result.charts?.queueActivity||[],"status","count")}</div>
    ${tableCard("Recent Activity",renderRows(result.recentActivity||[],[{label:"Recipient",key:"recipient"},{label:"Subject",key:"subject"},{label:"Template",key:"template_key"},{label:"Status",render:(row)=>emailStatusChip(row.status)},{label:"Sent time",render:(row)=>formatDate(row.sent_time)}]))}`;
}

function emailTemplateEditor(template = {}) {
  return `<section class="table-card"><h3>${template.id?"Edit template":"Create template"}</h3><p class="table-card-note">Only supported variables are interpolated. User-controlled values are escaped.</p><form id="email-template-form" class="form-grid" data-template-id="${escapeHtml(template.id||"")}">
    <label>Template name<input name="name" required maxlength="120" value="${escapeHtml(template.name||"")}"></label><label>Template key<input name="templateKey" required pattern="[a-z][a-z0-9_]{2,79}" value="${escapeHtml(template.template_key||"")}" ${template.id?"readonly":""}></label>
    <label class="field-full">Subject<input name="subject" required maxlength="300" value="${escapeHtml(template.subject||"")}"></label><label class="field-full">HTML body<textarea name="htmlBody" rows="10" required>${escapeHtml(template.html_body||"")}</textarea></label><label class="field-full">Plain-text body<textarea name="textBody" rows="8" required>${escapeHtml(template.text_body||"")}</textarea></label>
    <label class="toggle-row"><input name="enabled" type="checkbox" ${template.enabled!==false?"checked":""}>Enabled</label><div class="form-actions field-full"><button class="primary-btn" type="submit">Save template</button><button class="secondary-btn" type="button" data-email-template-cancel>Cancel</button></div></form>${template.versions?.length?`<h4>Version history</h4>${renderRows(template.versions,[{label:"Version",key:"version"},{label:"Subject",key:"subject"},{label:"Status",render:(row)=>emailStatusChip(row.enabled?"enabled":"disabled")},{label:"Created",render:(row)=>formatDate(row.created_at)},{label:"Created by",render:(row)=>compactId(row.created_by)}])}`:""}</section>`;
}

async function renderEmailTemplates(me={}) {
  const result=await apiFetch("/admin/email/templates"),items=result.items||[];let selected=null;
  const canEdit=hasEmailPermission(me,"EMAIL_TEMPLATE_EDIT"),canTest=hasEmailPermission(me,"EMAIL_TEST_SEND");
  if(PAGE_EXPORTS.emailTemplateEditing)selected=(await apiFetch(`/admin/email/templates/${encodeURIComponent(PAGE_EXPORTS.emailTemplateEditing)}`)).template;
  PAGE_EXPORTS["email-templates"]=items;
  document.getElementById("page-content").innerHTML=`<section class="email-page-actions">${canEdit?'<button class="primary-btn" type="button" data-email-template-new>Create template</button>':""}<span>Supported variables: ${escapeHtml((result.supportedVariables||[]).map((item)=>`{{${item}}}`).join(", "))}</span></section>${canEdit&&(selected||PAGE_EXPORTS.emailTemplateNew)?emailTemplateEditor(selected||{}):""}${tableCard("Transactional templates",renderRows(items,[{label:"Name",key:"name"},{label:"Key",key:"template_key"},{label:"Version",key:"current_version"},{label:"Status",render:(row)=>emailStatusChip(row.enabled?"enabled":"disabled")},{label:"Updated",render:(row)=>formatDate(row.updated_at)},{label:"Updated by",render:(row)=>escapeHtml(row.updated_by_name||"System")}],(row)=>`${canEdit?`<button data-email-template-edit="${escapeHtml(row.id)}">Edit</button>`:""}<button data-email-template-preview="${escapeHtml(row.id)}">Preview</button>${canTest?`<button data-email-template-test="${escapeHtml(row.id)}">Test send</button>`:""}`))}`;
  document.querySelector("[data-email-template-new]")?.addEventListener("click",()=>{PAGE_EXPORTS.emailTemplateNew=true;PAGE_EXPORTS.emailTemplateEditing=null;renderEmailTemplates(me);});
  document.querySelectorAll("[data-email-template-edit]").forEach((button)=>button.addEventListener("click",()=>{PAGE_EXPORTS.emailTemplateEditing=button.dataset.emailTemplateEdit;PAGE_EXPORTS.emailTemplateNew=false;renderEmailTemplates(me);}));
  document.querySelectorAll("[data-email-template-preview]").forEach((button)=>button.addEventListener("click",async()=>{const data=await apiFetch(`/admin/email/templates/${button.dataset.emailTemplatePreview}`);window.alert(`Subject: ${data.template.subject}\n\n${data.template.text_body}`);}));
  document.querySelectorAll("[data-email-template-test]").forEach((button)=>button.addEventListener("click",async()=>{const to=window.prompt("Send this test email to:");if(!to)return;try{await apiFetch(`/admin/email/templates/${button.dataset.emailTemplateTest}/test`,{method:"POST",body:JSON.stringify({to,variables:{firstName:"Test",companyName:"TitoPay",supportEmail:"support@titopay.co.za"}})});showToast("Test email queued");}catch(error){showToast(adminErrorMessage(error.message));}}));
  document.querySelector("[data-email-template-cancel]")?.addEventListener("click",()=>{PAGE_EXPORTS.emailTemplateEditing=null;PAGE_EXPORTS.emailTemplateNew=false;renderEmailTemplates(me);});
  document.getElementById("email-template-form")?.addEventListener("submit",async(event)=>{event.preventDefault();const form=event.currentTarget,data=new FormData(form),id=form.dataset.templateId;try{await apiFetch(id?`/admin/email/templates/${id}`:"/admin/email/templates",{method:id?"PUT":"POST",body:JSON.stringify({name:data.get("name"),templateKey:data.get("templateKey"),subject:data.get("subject"),htmlBody:data.get("htmlBody"),textBody:data.get("textBody"),enabled:data.get("enabled")==="on"})});PAGE_EXPORTS.emailTemplateEditing=null;PAGE_EXPORTS.emailTemplateNew=false;showToast("Email template saved");await renderEmailTemplates(me);}catch(error){showToast(adminErrorMessage(error.message));}});
}

async function renderEmailQueue(me={},pageOverride=null) {
  const previous=document.getElementById("email-queue-filters"),params=previous?new URLSearchParams(new FormData(previous)):new URLSearchParams();if(pageOverride!==null)params.set("page",String(pageOverride));const result=await apiFetch(`/admin/email/queue?${params.toString()}`);PAGE_EXPORTS["email-queue"]=result.items||[];
  const canManage=hasEmailPermission(me,"EMAIL_QUEUE_MANAGE");
  document.getElementById("page-content").innerHTML=`<section class="table-card"><form id="email-queue-filters" class="admin-filter-grid"><label>Status<select name="status"><option value="">All</option>${["queued","processing","sent","delivered","failed","cancelled","dead_lettered"].map((value)=>`<option value="${value}" ${params.get("status")===value?"selected":""}>${value}</option>`).join("")}</select></label><label>Template<input name="template" value="${escapeHtml(params.get("template")||"")}"></label><label>Recipient<input name="recipient" type="search" value="${escapeHtml(params.get("recipient")||"")}"></label><label>Provider<input name="provider" value="${escapeHtml(params.get("provider")||"")}"></label><label>From<input name="from" type="date" value="${escapeHtml(params.get("from")||"")}"></label><label>To<input name="to" type="date" value="${escapeHtml(params.get("to")||"")}"></label><input name="page" type="hidden" value="${escapeHtml(result.page||1)}"><button class="secondary-btn" type="submit">Apply filters</button></form></section>${tableCard(`Queue (${result.total||0})`,renderRows(result.items||[],[{label:"Queue ID",render:(row)=>compactId(row.id)},{label:"Recipient",key:"recipient"},{label:"Subject",key:"subject"},{label:"Template",key:"template_key"},{label:"Attempts",render:(row)=>`${row.attempt_count}/${row.maximum_attempts}`},{label:"Status",render:(row)=>emailStatusChip(row.status)},{label:"Created",render:(row)=>formatDate(row.created_at)},{label:"Last attempt",render:(row)=>formatDate(row.last_attempt_at)}],(row)=>`<button data-email-queue-view="${row.id}">View</button>${canManage?`${["failed","dead_lettered"].includes(row.status)?`<button data-email-retry="${row.id}">Retry</button>`:""}${["queued","failed"].includes(row.status)?`<button data-email-cancel="${row.id}">Cancel</button>`:""}`:""}`))}${emailPagination(result.total,result.page||1,result.limit||25,"email-queue")}`;
  document.getElementById("email-queue-filters")?.addEventListener("submit",(event)=>{event.preventDefault();renderEmailQueue(me,1);});
  document.querySelectorAll("[data-email-queue-page]").forEach((button)=>button.addEventListener("click",()=>renderEmailQueue(me,Number(button.dataset.emailQueuePage))));
  document.querySelectorAll("[data-email-queue-view]").forEach((button)=>button.addEventListener("click",async()=>{try{const data=await apiFetch(`/admin/email/queue/${button.dataset.emailQueueView}`);window.alert(JSON.stringify(data.item,null,2));}catch(error){showToast(adminErrorMessage(error.message));}}));
  document.querySelectorAll("[data-email-retry]").forEach((button)=>button.addEventListener("click",async()=>{if(!window.confirm("Retry this email job?"))return;try{await apiFetch(`/admin/email/queue/${button.dataset.emailRetry}/retry`,{method:"POST",body:"{}"});showToast("Email queued for retry");await renderEmailQueue(me);}catch(error){showToast(adminErrorMessage(error.message));}}));
  document.querySelectorAll("[data-email-cancel]").forEach((button)=>button.addEventListener("click",async()=>{if(!window.confirm("Cancel this queued email?"))return;try{await apiFetch(`/admin/email/queue/${button.dataset.emailCancel}/cancel`,{method:"POST",body:"{}"});showToast("Email cancelled");await renderEmailQueue(me);}catch(error){showToast(adminErrorMessage(error.message));}}));
}

async function renderEmailLogs(_me={},pageOverride=null) {
  const previous=document.getElementById("email-log-filters"),params=previous?new URLSearchParams(new FormData(previous)):new URLSearchParams();if(pageOverride!==null)params.set("page",String(pageOverride));const result=await apiFetch(`/admin/email/logs?${params.toString()}`);PAGE_EXPORTS["email-logs"]=result.items||[];
  document.getElementById("page-content").innerHTML=`<section class="table-card"><form id="email-log-filters" class="admin-filter-grid"><label>Status<input name="status" value="${escapeHtml(params.get("status")||"")}"></label><label>Template<input name="template" value="${escapeHtml(params.get("template")||"")}"></label><label>Recipient<input name="recipient" type="search" value="${escapeHtml(params.get("recipient")||"")}"></label><label>Provider<input name="provider" value="${escapeHtml(params.get("provider")||"")}"></label><label>From<input name="from" type="date" value="${escapeHtml(params.get("from")||"")}"></label><label>To<input name="to" type="date" value="${escapeHtml(params.get("to")||"")}"></label><input name="page" type="hidden" value="${escapeHtml(result.page||1)}"><button class="secondary-btn" type="submit">Apply filters</button></form></section>${tableCard(`Immutable delivery attempts (${result.total||0})`,renderRows(result.items||[],[{label:"Recipient",key:"recipient"},{label:"Subject",key:"subject"},{label:"Template",key:"template_key"},{label:"Status",render:(row)=>emailStatusChip(row.status)},{label:"Provider",key:"provider"},{label:"Message ID",render:(row)=>compactId(row.provider_message_id)},{label:"Attempt",key:"attempt_number"},{label:"Sent",render:(row)=>formatDate(row.sent_at)},{label:"Delivered",render:(row)=>formatDate(row.delivered_at)},{label:"Failed",render:(row)=>formatDate(row.failed_at)},{label:"Error",render:(row)=>escapeHtml(row.error_message||"-")}],(row)=>`<button data-email-log-view="${row.id}">View</button>`))}${emailPagination(result.total,result.page||1,result.limit||25,"email-log")}`;
  document.getElementById("email-log-filters")?.addEventListener("submit",(event)=>{event.preventDefault();renderEmailLogs(_me,1);});
  document.querySelectorAll("[data-email-log-page]").forEach((button)=>button.addEventListener("click",()=>renderEmailLogs(_me,Number(button.dataset.emailLogPage))));
  document.querySelectorAll("[data-email-log-view]").forEach((button)=>button.addEventListener("click",async()=>{try{const data=await apiFetch(`/admin/email/logs/${button.dataset.emailLogView}`);window.alert(JSON.stringify(data.item,null,2));}catch(error){showToast(adminErrorMessage(error.message));}}));
}

async function renderEmailSettings(me={}) {
  const result=await apiFetch("/admin/email/settings"),s=result.settings||{};
  const canEdit=hasEmailPermission(me,"EMAIL_SETTINGS_EDIT"),canTest=hasEmailPermission(me,"EMAIL_TEST_SEND"),canEditProvider=isPlatformOwnerRole(me.role);
  document.getElementById("page-content").innerHTML=`<section class="table-card"><form id="email-settings-form" class="form-grid"><label>Sender name<input name="senderName" required value="${escapeHtml(s.sender_name||"TitoPay")}" ${canEdit?"":"disabled"}></label><label>Sender email<input name="senderEmail" type="email" required value="${escapeHtml(s.sender_email||"")}" ${canEdit?"":"disabled"}></label><label>Reply-to email<input name="replyToEmail" type="email" required value="${escapeHtml(s.reply_to_email||"")}" ${canEdit?"":"disabled"}></label><label>Company name<input name="companyName" required value="${escapeHtml(s.company_name||"")}" ${canEdit?"":"disabled"}></label><label>Support email<input name="supportEmail" type="email" required value="${escapeHtml(s.support_email||"")}" ${canEdit?"":"disabled"}></label><label>Support URL<input name="supportUrl" type="url" required value="${escapeHtml(s.support_url||"")}" ${canEdit?"":"disabled"}></label><label>Website URL<input name="websiteUrl" type="url" required value="${escapeHtml(s.website_url||"")}" ${canEdit?"":"disabled"}></label><label>Tagline<input name="tagline" required value="${escapeHtml(s.tagline||"")}" ${canEdit?"":"disabled"}></label>${canEditProvider?`<label>Default provider<select name="defaultProvider">${["smtp","resend","postmark","brevo","mailgun","ses","sendgrid","api"].map((provider)=>`<option value="${provider}" ${s.default_provider===provider?"selected":""}>${provider.toUpperCase()}</option>`).join("")}</select></label>`:""}<label>Verification expiry (minutes)<input name="verificationTokenExpiryMinutes" type="number" min="5" max="10080" value="${escapeHtml(s.verification_token_expiry_minutes)}" ${canEdit?"":"disabled"}></label><label>Password reset expiry (minutes)<input name="passwordResetTokenExpiryMinutes" type="number" min="5" max="1440" value="${escapeHtml(s.password_reset_token_expiry_minutes)}" ${canEdit?"":"disabled"}></label><label>Maximum retries<input name="maximumRetryCount" type="number" min="1" max="20" value="${escapeHtml(s.maximum_retry_count)}" ${canEdit?"":"disabled"}></label><label>Daily sending limit<input name="dailySendingLimit" type="number" min="1" value="${escapeHtml(s.daily_sending_limit)}" ${canEdit?"":"disabled"}></label><label class="toggle-row"><input name="sendingEnabled" type="checkbox" ${s.sending_enabled?"checked":""} ${canEdit?"":"disabled"}>Email sending enabled</label><div class="form-actions field-full">${canEdit?'<button class="primary-btn" type="submit">Save settings</button>':""}${canEditProvider?'<button class="secondary-btn" type="button" data-email-provider-test>Test connection</button>':""}${canTest?'<button class="secondary-btn" type="button" data-email-test-send>Send test email</button>':""}</div></form><p class="table-card-note">Provider credentials remain in the existing Integration Centre and are never returned to this page.</p></section>`;
  document.getElementById("email-settings-form")?.addEventListener("submit",async(event)=>{event.preventDefault();const form=event.currentTarget,data=Object.fromEntries(new FormData(form));data.sendingEnabled=new FormData(form).get("sendingEnabled")==="on";for(const key of ["verificationTokenExpiryMinutes","passwordResetTokenExpiryMinutes","maximumRetryCount","dailySendingLimit"])data[key]=Number(data[key]);try{await apiFetch("/admin/email/settings",{method:"PUT",body:JSON.stringify(data)});if(canEditProvider&&data.defaultProvider!==s.default_provider)await apiFetch("/admin/email/provider",{method:"PUT",body:JSON.stringify({defaultProvider:data.defaultProvider})});showToast("Email settings saved");await renderEmailSettings(me);}catch(error){showToast(adminErrorMessage(error.message));}});
  document.querySelector("[data-email-provider-test]")?.addEventListener("click",async()=>{const to=window.prompt("Send the connection test to:");if(!to)return;try{await apiFetch("/admin/email/provider/test",{method:"POST",body:JSON.stringify({to})});showToast("Provider connection and send test succeeded");}catch(error){showToast(adminErrorMessage(error.message));}});
  document.querySelector("[data-email-test-send]")?.addEventListener("click",async()=>{const to=window.prompt("Send a queued test email to:");if(!to)return;try{await apiFetch("/admin/email/test",{method:"POST",body:JSON.stringify({to,templateKey:"welcome_email",variables:{firstName:"Test",accountType:"personal"}})});showToast("Test email queued");}catch(error){showToast(adminErrorMessage(error.message));}});
}

async function renderEmailOtp(me={}) {
  const [dashboardState,logsState,settingsState]=await Promise.all([apiFetch("/admin/email-otp/dashboard"),apiFetch("/admin/email-otp/logs"),apiFetch("/admin/email-otp/settings")]);
  // Keep the customer wallet-unlock channel visible even when an older API
  // omits it from the event list. The existing settings endpoint already
  // accepts this additive event without changing any routes or schema.
  const customerSignInEvents=new Set(["login","new_device","new_browser"]);
  const m=dashboardState.metrics||{},logs=logsState.items||[],s=settingsState.settings||{},events=["wallet_unlock",...(settingsState.events||[]).filter((name)=>name!=="wallet_unlock"&&!customerSignInEvents.has(name))]
  PAGE_EXPORTS["email-otp"]=logs;
  const canEdit=isPlatformOwnerRole(me.role);
  document.getElementById("page-content").innerHTML=`${renderMetrics([["OTP sent today",m.sent_today||0],["OTP delivered",m.delivered||0],["OTP verified",m.verified_today||0],["OTP expired",m.expired||0],["OTP failed",m.failed||0],["Resend requests",m.resend_requests||0],["Average delivery",`${m.average_delivery_seconds||0}s`]])}
    <section class="table-card">
      <h3>Wallet Unlock Authentication</h3>
      <p class="table-card-note">Locked wallets verify the customer's saved method. If it is unavailable, TitoPay falls back in the order Push → Email → SMS.</p>
      <div class="ops-list ops-list-two">
        <span><span>Email OTP wallet unlock</span><strong><span class="chip ${(s.events||{}).wallet_unlock&&s.enabled?"green":"orange"}">${(s.events||{}).wallet_unlock&&s.enabled?"Enabled":"Disabled"}</span></strong></span>
        <span><span>Authentication preference</span><strong>Saved per customer</strong></span>
        <span><span>Email OTP expiry</span><strong>${escapeHtml(String(s.expiryMinutes||5))} minutes</strong></span>
        <span><span>Recovery path</span><strong>Push → Email → SMS</strong></span>
      </div>
    </section>
    <section class="table-card"><h3>Email OTP Settings</h3><p class="table-card-note">Customer sign-in OTP is disabled. Admin sign-in Email OTP is controlled only from Security → Authentication Mode. Wallet-unlock Email OTP remains available here.</p><p class="table-card-note">Pricing: Email OTP and standard email notifications are free. Email Statements are R0.10.</p><form id="email-otp-settings-form" class="form-grid"><label class="toggle-row"><input name="enabled" type="checkbox" ${s.enabled?"checked":""} ${canEdit?"":"disabled"}>Enable Email OTP</label><label>OTP length<input name="otpLength" type="number" min="6" max="8" value="${escapeHtml(s.otpLength||6)}" ${canEdit?"":"disabled"}></label><label>Expiry (minutes)<input name="expiryMinutes" type="number" min="1" max="30" value="${escapeHtml(s.expiryMinutes||5)}" ${canEdit?"":"disabled"}></label><label>Maximum attempts<input name="maximumAttempts" type="number" min="1" max="10" value="${escapeHtml(s.maximumAttempts||5)}" ${canEdit?"":"disabled"}></label><label>Maximum resends<input name="maximumResends" type="number" min="0" max="10" value="${escapeHtml(s.maximumResends??3)}" ${canEdit?"":"disabled"}></label><label>Resend cooldown (seconds)<input name="resendCooldownSeconds" type="number" min="15" max="600" value="${escapeHtml(s.resendCooldownSeconds||60)}" ${canEdit?"":"disabled"}></label><div class="field-full email-otp-event-grid">${events.map((name)=>`<label class="toggle-row"><input type="checkbox" name="event:${escapeHtml(name)}" ${(s.events||{})[name]?"checked":""} ${canEdit?"":"disabled"}>${escapeHtml(name.replaceAll("_"," "))}</label>`).join("")}</div>${canEdit?'<div class="form-actions field-full"><button class="primary-btn" type="submit">Save Email OTP settings</button></div>':""}</form></section>
    ${tableCard("Email OTP Logs",renderRows(logs,[{label:"Recipient",key:"recipient"},{label:"Purpose",key:"purpose"},{label:"Status",render:(row)=>emailStatusChip(row.status)},{label:"Sent",render:(row)=>formatDate(row.sent_time)},{label:"Expiry",render:(row)=>formatDate(row.expires_at)},{label:"Used",render:(row)=>formatDate(row.used_at)},{label:"Attempts",key:"attempts"},{label:"IP address",key:"ip_address"},{label:"Device",key:"device"},{label:"Location",render:(row)=>escapeHtml(row.location||"-")}],(row)=>canEdit&&!row.used_at?`<button data-email-otp-revoke="${row.id}">Revoke</button><button data-email-otp-admin-resend="${row.id}">Resend</button>`:""))}`;
  document.getElementById("email-otp-settings-form")?.addEventListener("submit",async(event)=>{event.preventDefault();const form=event.currentTarget,data=new FormData(form),eventsValue={};for(const name of events)eventsValue[name]=data.get(`event:${name}`)==="on";try{await apiFetch("/admin/email-otp/settings",{method:"PUT",body:JSON.stringify({enabled:data.get("enabled")==="on",events:eventsValue,otpLength:Number(data.get("otpLength")),expiryMinutes:Number(data.get("expiryMinutes")),maximumAttempts:Number(data.get("maximumAttempts")),maximumResends:Number(data.get("maximumResends")),resendCooldownSeconds:Number(data.get("resendCooldownSeconds"))})});showToast("Email OTP settings saved");await renderEmailOtp(me);}catch(error){showToast(adminErrorMessage(error.message));}});
  document.querySelectorAll("[data-email-otp-revoke]").forEach((button)=>button.addEventListener("click",async()=>{if(!window.confirm("Revoke this Email OTP?"))return;try{await apiFetch(`/admin/email-otp/${button.dataset.emailOtpRevoke}/revoke`,{method:"POST",body:"{}"});showToast("Email OTP revoked");await renderEmailOtp(me);}catch(error){showToast(adminErrorMessage(error.message));}}));
  document.querySelectorAll("[data-email-otp-admin-resend]").forEach((button)=>button.addEventListener("click",async()=>{if(!window.confirm("Queue a replacement Email OTP?"))return;try{await apiFetch(`/admin/email-otp/${button.dataset.emailOtpAdminResend}/resend`,{method:"POST",body:"{}"});showToast("Replacement Email OTP queued");await renderEmailOtp(me);}catch(error){showToast(adminErrorMessage(error.message));}}));
}

/* == Alert Centre =========================================================
   The platform emails the owner on every security and operational event; the
   Alert Centre keeps those same events inside the console instead. A bell in
   the topbar carries the unread count on every page, its panel shows the most
   recent alerts, and the /alerts/ module is the full centre with severity and
   category filters, pagination and read state.

   Every alert is derived from a response the API actually returned - the same
   sources the dashboard and analytics already read. Nothing is invented, and a
   source that does not answer simply contributes no alerts. Read state is
   stored per browser (localStorage): the API has no endpoint for it, and the
   page says so rather than pretending it is shared.
   ======================================================================== */

const ADMIN_ALERT_READS_KEY = "titopay_admin_alert_reads_v1";
const ALERT_TTL_MS = 90 * 1000;
const ALERT_POLL_MS = 2 * 60 * 1000;
const ALERT_CAP = 250;
const ALERTS_PAGE_SIZE = 20;

let alertState = {
  alerts: [],
  builtAt: 0,
  inFlight: null,
  timer: null,
  sources: { answered: 0, total: 0 },
};

function alertReads() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ADMIN_ALERT_READS_KEY) || "{}");
    return { seen: parsed.seen || {}, first: parsed.first || {}, allReadAt: Number(parsed.allReadAt || 0) };
  } catch {
    return { seen: {}, first: {}, allReadAt: 0 };
  }
}

function saveAlertReads(reads) {
  try {
    localStorage.setItem(ADMIN_ALERT_READS_KEY, JSON.stringify(reads));
  } catch {}
}

function alertIsUnread(alert, reads) {
  if (reads.seen[alert.id]) return false;
  const firstSeen = Number(reads.first[alert.id] || 0);
  return firstSeen > reads.allReadAt;
}

function alertTime(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.getTime() : 0;
}

async function alertSource(path) {
  try {
    return await apiFetch(path);
  } catch {
    return null;
  }
}

/* Derives the alert list from the modules that already exist. Each alert has a
   deterministic id, so read state survives refreshes and re-derivations. */
async function buildAdminAlerts() {
  const [security, audit, compliance, conversations, tickets, transactions, health, merchants] = await Promise.all([
    alertSource("/admin/security"),
    alertSource("/admin/audit"),
    alertSource("/admin/compliance/queue"),
    alertSource("/admin/support/conversations"),
    alertSource("/admin/support/tickets"),
    alertSource("/admin/transactions?limit=300"),
    alertSource("/admin/module-health"),
    alertSource("/admin/merchants"),
  ]);
  const answered = [security, audit, compliance, conversations, tickets, transactions, health, merchants].filter(Boolean).length;

  const alerts = [];
  const push = (id, severity, category, title, detail, at, href) => {
    alerts.push({ id, severity, category, title, detail: detail || "", at: alertTime(at), href });
  };

  (security?.loginAttempts || []).slice(0, 80).forEach((row) => {
    const failed = /fail|invalid|denied|lock/i.test(String(row.action || ""));
    push(
      `sec:${row.id || row.created_at}:${row.action}`,
      failed ? "warning" : "info",
      "Security",
      failed ? "Failed sign-in attempt" : "Sign-in recorded",
      [row.actor_type, row.actor_id].filter(Boolean).join(" · "),
      row.created_at,
      "/security/"
    );
  });

  (security?.profileLockEvents || []).slice(0, 40).forEach((row) => {
    push(`lock:${row.id || row.created_at}`, "warning", "Security", "Profile lock event", String(row.action || "").replace(/_/g, " "), row.created_at, "/security/");
  });

  (audit?.items || []).slice(0, 80).forEach((row) => {
    const action = String(row.action || "");
    const critical = /fraud|suspicious|blocked|abuse/i.test(action);
    const notable = critical || /lock|revoke|reverse|suspend|delete|logout_all/i.test(action);
    if (!notable) return;
    push(
      `aud:${row.id}`,
      critical ? "critical" : "warning",
      critical ? "Fraud" : "Operations",
      action.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
      [row.actor_type, row.target_type, row.target_id].filter(Boolean).join(" · "),
      row.created_at,
      "/audit/"
    );
  });

  (compliance?.items || []).forEach((row) => {
    if (!["pending", "in_review", "submitted"].includes(String(row.status || "").toLowerCase())) return;
    push(`cmp:${row.id}`, "warning", "Compliance", `KYC review pending: ${row.full_name || row.username || row.id}`, row.review_type || "Verification review", row.created_at, "/compliance/");
  });

  (conversations?.items || []).forEach((row) => {
    if (!["ESCALATED", "WAITING_FOR_AGENT"].includes(String(row.status || ""))) return;
    push(`cnv:${row.id}`, "warning", "Support", "Customer waiting for an agent", String(row.last_message || "").slice(0, 80), row.updated_at || row.created_at, "/support/");
  });

  (tickets?.items || []).forEach((row) => {
    if (!["open", "in_progress", "pending"].includes(String(row.status || "").toLowerCase())) return;
    push(`tkt:${row.id}`, "info", "Support", `Ticket open: ${row.subject || row.id}`, [row.full_name, row.category].filter(Boolean).join(" · "), row.created_at, "/support/");
  });

  (transactions?.items || []).slice(0, 300).forEach((row) => {
    const status = String(row.status || "").toLowerCase();
    if (["failed", "declined", "rejected", "error"].includes(status)) {
      push(`txf:${row.id}`, "warning", "Transactions", `Transaction failed: ${row.reference || row.id}`, [row.owner_name, money(row.amount)].filter(Boolean).join(" · "), row.created_at, "/transactions/");
    } else if (String(row.reconciliation_status || "").toLowerCase() === "review") {
      push(`txr:${row.id}`, "critical", "Transactions", `Reconciliation review: ${row.reference || row.id}`, [row.owner_name, money(row.amount)].filter(Boolean).join(" · "), row.created_at, "/transactions/");
    }
  });

  (health?.tables || []).forEach((row) => {
    if (row.exists) return;
    push(`tbl:${row.table_name}`, "critical", "System", `Database table missing: ${row.table_name}`, "Reported by the health module", null, "/database-health/");
  });

  (merchants?.items || []).forEach((row) => {
    if (String(row.verification_status || "").toLowerCase() === "verified") return;
    push(`mer:${row.id}`, "info", "Merchants", `Merchant awaiting verification: ${row.business_name || row.id}`, row.merchant_number || "", row.created_at, "/merchants/");
  });

  alerts.sort((a, b) => b.at - a.at);
  const capped = alerts.slice(0, ALERT_CAP);

  // First-seen bookkeeping drives unread state for dated and undated alerts
  // alike, and the map is pruned to the alerts that still exist.
  const reads = alertReads();
  const now = Date.now();
  const nextFirst = {};
  const nextSeen = {};
  capped.forEach((alert) => {
    nextFirst[alert.id] = reads.first[alert.id] || now;
    if (reads.seen[alert.id]) nextSeen[alert.id] = reads.seen[alert.id];
  });
  saveAlertReads({ seen: nextSeen, first: nextFirst, allReadAt: reads.allReadAt });

  return { alerts: capped, answered, total: 8 };
}

async function refreshAdminAlerts({ force = false } = {}) {
  if (!getAuth()?.accessToken) return alertState.alerts;
  if (alertState.inFlight) return alertState.inFlight;
  if (!force && Date.now() - alertState.builtAt < ALERT_TTL_MS) return alertState.alerts;
  alertState.inFlight = buildAdminAlerts()
    .then(({ alerts, answered, total }) => {
      alertState.alerts = alerts;
      alertState.builtAt = Date.now();
      alertState.sources = { answered, total };
      updateAlertBadge();
      renderAlertPanelList();
      return alerts;
    })
    .finally(() => {
      alertState.inFlight = null;
    });
  return alertState.inFlight;
}

function unreadAlertCount() {
  const reads = alertReads();
  return alertState.alerts.filter((alert) => alertIsUnread(alert, reads)).length;
}

function updateAlertBadge() {
  const badge = document.getElementById("alert-badge");
  const bell = document.querySelector("[data-alert-bell]");
  if (!badge || !bell) return;
  const unread = unreadAlertCount();
  badge.textContent = unread > 99 ? "99+" : String(unread);
  badge.hidden = unread === 0;
  bell.setAttribute("aria-label", unread ? `Alerts, ${unread} unread` : "Alerts");
}

function markAllAlertsRead() {
  const reads = alertReads();
  saveAlertReads({ ...reads, allReadAt: Date.now(), seen: {} });
  updateAlertBadge();
  renderAlertPanelList();
  if (document.querySelector(".admin-shell[data-page]")?.dataset.page === "alerts") {
    renderAlertCentreView();
  }
}

function markAlertRead(id) {
  const reads = alertReads();
  reads.seen[id] = Date.now();
  saveAlertReads(reads);
  updateAlertBadge();
}

function alertRelativeTime(timestamp) {
  if (!timestamp) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(timestamp).toLocaleDateString("en-ZA", { day: "2-digit", month: "short" });
}

const ALERT_SEVERITY_META = {
  critical: ["Critical", "red"],
  warning: ["Warning", "orange"],
  info: ["Info", "blue"],
};

function alertRowHtml(alert, reads, compact = false) {
  const unread = alertIsUnread(alert, reads);
  return `
    <a class="tp-alert-row${unread ? " is-unread" : ""}" href="${escapeHtml(alert.href)}" data-alert-read="${escapeHtml(alert.id)}">
      <span class="tp-alert-dot ${escapeHtml(alert.severity)}" aria-hidden="true"></span>
      <span class="tp-alert-body">
        <strong>${escapeHtml(alert.title)}</strong>
        ${alert.detail && !compact ? `<small>${escapeHtml(alert.detail)}</small>` : ""}
        <small class="tp-alert-meta">${escapeHtml(alert.category)} · ${escapeHtml(alertRelativeTime(alert.at))}${unread ? " · Unread" : ""}</small>
      </span>
    </a>
  `;
}

function renderAlertPanelList() {
  const host = document.getElementById("alert-panel-list");
  if (!host) return;
  const reads = alertReads();
  const recent = alertState.alerts.slice(0, 8);
  host.innerHTML = recent.length
    ? recent.map((alert) => alertRowHtml(alert, reads, true)).join("")
    : `<p class="tp-alert-empty">No alerts right now. Platform events appear here as they happen.</p>`;
}

function setAlertPanel(open) {
  const panel = document.getElementById("alert-panel");
  const bell = document.querySelector("[data-alert-bell]");
  if (!panel || !bell) return;
  panel.hidden = !open;
  bell.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) renderAlertPanelList();
}

function bindAlertBell() {
  const bell = document.querySelector("[data-alert-bell]");
  if (!bell || bell.dataset.bound) return;
  bell.dataset.bound = "1";

  bell.addEventListener("click", () => {
    const panel = document.getElementById("alert-panel");
    setAlertPanel(panel ? panel.hidden : true);
  });

  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-alert-bell]") || event.target.closest("#alert-panel")) {
      const readLink = event.target.closest("[data-alert-read]");
      if (readLink) {
        markAlertRead(readLink.dataset.alertRead);
        setAlertPanel(false);
      }
      const markAll = event.target.closest("[data-alert-mark-all]");
      if (markAll) markAllAlertsRead();
      return;
    }
    setAlertPanel(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !document.getElementById("alert-panel")?.hidden) {
      setAlertPanel(false);
      bell.focus();
    }
  });
}

function startAlertEngine() {
  bindAlertBell();
  refreshAdminAlerts();
  clearInterval(alertState.timer);
  alertState.timer = setInterval(() => {
    if (!document.hidden) refreshAdminAlerts();
  }, ALERT_POLL_MS);
}

/* == Alert Centre page ==================================================== */

document.addEventListener("change", (event) => {
  const category = event.target.closest("[data-alert-category]");
  if (category) {
    const view = alertCentreFilters();
    view.category = category.value;
    view.page = 1;
    renderAlertCentreView();
  }
});

function alertCentreFilters() {
  if (!PAGE_EXPORTS.alertsView) PAGE_EXPORTS.alertsView = { severity: "", category: "", unreadOnly: false, page: 1 };
  return PAGE_EXPORTS.alertsView;
}

function renderAlertCentreView() {
  const content = document.getElementById("page-content");
  if (!content) return;
  const view = alertCentreFilters();
  const reads = alertReads();
  const categories = [...new Set(alertState.alerts.map((alert) => alert.category))].sort();

  let rows = alertState.alerts;
  if (view.severity) rows = rows.filter((alert) => alert.severity === view.severity);
  if (view.category) rows = rows.filter((alert) => alert.category === view.category);
  if (view.unreadOnly) rows = rows.filter((alert) => alertIsUnread(alert, reads));

  const totalPages = Math.max(1, Math.ceil(rows.length / ALERTS_PAGE_SIZE));
  view.page = Math.min(Math.max(1, view.page), totalPages);
  const visible = rows.slice((view.page - 1) * ALERTS_PAGE_SIZE, view.page * ALERTS_PAGE_SIZE);

  const unread = unreadAlertCount();
  const counts = { critical: 0, warning: 0, info: 0 };
  alertState.alerts.forEach((alert) => {
    counts[alert.severity] = (counts[alert.severity] || 0) + 1;
  });

  PAGE_EXPORTS.alerts = alertState.alerts.map((alert) => ({
    severity: alert.severity,
    category: alert.category,
    title: alert.title,
    detail: alert.detail,
    at: alert.at ? new Date(alert.at).toISOString() : "",
    unread: alertIsUnread(alert, reads) ? "yes" : "no",
  }));

  content.innerHTML = `
    ${renderMetrics([
      ["Open Alerts", alertState.alerts.length],
      ["Unread", unread],
      ["Critical", counts.critical],
      ["Sources Answering", `${alertState.sources.answered}/${alertState.sources.total}`],
    ])}
    <section class="tp-alert-controls">
      <nav class="segmented" aria-label="Severity">
        ${["", "critical", "warning", "info"].map((severity) => `
          <button type="button" class="segmented-btn${view.severity === severity ? " active" : ""}" data-alert-severity="${escapeHtml(severity)}" aria-pressed="${view.severity === severity}">
            ${severity ? ALERT_SEVERITY_META[severity][0] : "All"}${severity ? `<span class="segmented-count">${counts[severity] || 0}</span>` : `<span class="segmented-count">${alertState.alerts.length}</span>`}
          </button>
        `).join("")}
      </nav>
      <div class="tp-alert-actions">
        <label class="tp-filter">
          <span class="visually-hidden">Category</span>
          <select data-alert-category>
            <option value="">All categories</option>
            ${categories.map((category) => `<option value="${escapeHtml(category)}"${view.category === category ? " selected" : ""}>${escapeHtml(category)}</option>`).join("")}
          </select>
        </label>
        <button class="tp-tool-btn" type="button" data-alert-unread-toggle aria-pressed="${view.unreadOnly}">Unread only</button>
        <button class="secondary-btn" type="button" data-alert-mark-all-page>Mark all as read</button>
      </div>
    </section>
    <section class="table-card">
      <div class="tp-alert-list">
        ${visible.length
          ? visible.map((alert) => alertRowHtml(alert, reads)).join("")
          : `<div class="empty"><strong>No alerts match this view</strong><small>Change the severity or category filters, or switch off Unread only.</small></div>`}
      </div>
      ${totalPages > 1 ? `
        <div class="tp-pager">
          <button class="ghost-btn" type="button" data-alert-page="${view.page - 1}"${view.page <= 1 ? " disabled" : ""}>Previous</button>
          <span>Page ${view.page} of ${totalPages} · ${rows.length} alerts</span>
          <button class="ghost-btn" type="button" data-alert-page="${view.page + 1}"${view.page >= totalPages ? " disabled" : ""}>Next</button>
        </div>
      ` : ""}
    </section>
    ${tableCard(
      "About these alerts",
      renderKeyValueList([
        ["Source", "Live security, audit, compliance, support, transaction, system and merchant modules"],
        ["Read state", "Stored in this browser only; the API does not yet store alert reads"],
        ["Alert emails", "Sent by the TitoPay API, not by this console. To stop the sign-in emails, the API's notification sender must be updated - this page carries the same events."],
        ["Refresh", "Automatic every two minutes while the console is open"],
      ]),
      "The Alert Centre derives every entry from a live API response. Nothing here is estimated."
    )}
  `;
}

async function renderAlertCentre() {
  await refreshAdminAlerts({ force: alertState.builtAt === 0 });
  renderAlertCentreView();
}

/* Enterprise Analytics ----------------------------------------------------
   The module lives in its own file and is imported the first time an operator
   opens the Analytics page, so every other console page loads exactly the
   payload it loaded before this module existed. The host object below is the
   only surface the module is given: it can read data through apiFetch and draw
   with the console's own primitives, and it cannot reach anything else. */

const ANALYTICS_HOST = {
  apiFetch,
  escapeHtml,
  money,
  chipClass,
  formatDate,
  showToast,
  adminErrorMessage,
  tableCard,
  renderKeyValueList,
  renderMetrics,
  renderRows,
  downloadCsv,
  hasFullAdminAccess,
  isPlatformOwnerRole,
  normalizeAdminRole,
  adminEnvironment,
  PAGE_EXPORTS,
};

let analyticsModulePromise = null;

function loadAnalyticsModule() {
  if (!analyticsModulePromise) {
    const moduleUrl = new URL(`admin-analytics.js?v=${ADMIN_ASSET_VERSION}`, ADMIN_ASSET_URL).href;
    analyticsModulePromise = import(moduleUrl).catch((error) => {
      // Allow a retry: a failed import must not pin the page to the failure.
      analyticsModulePromise = null;
      const failure = new Error("The analytics module did not load. Confirm assets/admin-analytics.js was uploaded with this build.");
      failure.status = 0;
      failure.cause = error;
      throw failure;
    });
  }
  return analyticsModulePromise;
}

async function renderAnalytics(me = {}) {
  const module = await loadAnalyticsModule();
  await module.renderAnalytics(me, ANALYTICS_HOST);
}

let serviceBuilderModulePromise = null;

function loadServiceBuilderModule() {
  if (!serviceBuilderModulePromise) {
    const moduleUrl = new URL(`admin-service-builder.js?v=${ADMIN_ASSET_VERSION}`, ADMIN_ASSET_URL).href;
    serviceBuilderModulePromise = import(moduleUrl).catch((error) => {
      serviceBuilderModulePromise = null;
      const failure = new Error("The Service Builder module did not load. Confirm assets/admin-service-builder.js was uploaded with this build.");
      failure.status = 0;
      failure.cause = error;
      throw failure;
    });
  }
  return serviceBuilderModulePromise;
}

async function renderServiceBuilder(me = {}) {
  const module = await loadServiceBuilderModule();
  await module.renderServiceBuilder(me, ANALYTICS_HOST);
}

/* == Table enhancement layer ==============================================
   Every table the console renders gains sorting, a row filter, bulk selection,
   export and column resizing. The layer works on the table that is already on
   screen: it reorders, hides and reads rows, and never refetches, never calls
   an endpoint and never changes what a module rendered. Modules were not
   modified to receive it — a MutationObserver picks up each table as it
   appears, including the ones modules re-render internally.
   ======================================================================== */

const TABLE_TOOLS_MIN_ROWS = 6;

function tableBodyRows(table) {
  return Array.from(table.tBodies?.[0]?.rows || []);
}

function tableHeaderCells(table) {
  return Array.from(table.tHead?.rows?.[0]?.cells || []);
}

function tableCellText(row, index) {
  return (row.cells?.[index]?.textContent || "").replace(/\s+/g, " ").trim();
}

/* Reads a cell as a figure. Handles the two decimal conventions the console
   emits — "R 1,234.56" from Intl and "1 234,56" from a locale that groups with
   spaces — and returns null for anything that is not predominantly a number. */
function tableNumericValue(text) {
  if (!/\d/.test(text)) return null;
  if (!/^[^\d]{0,4}[\d\s.,-]+[^\d]{0,4}$/.test(text)) return null;
  let digits = text.replace(/[^\d.,-]/g, "");
  if (!digits || !/\d/.test(digits)) return null;
  const lastComma = digits.lastIndexOf(",");
  const lastDot = digits.lastIndexOf(".");
  digits = lastComma > lastDot ? digits.replace(/\./g, "").replace(",", ".") : digits.replace(/,/g, "");
  const value = Number(digits);
  return Number.isFinite(value) ? value : null;
}

function tableDateValue(text) {
  if (!/\d{4}|\d{1,2}[/-]\d{1,2}/.test(text)) return null;
  const time = Date.parse(text);
  return Number.isNaN(time) ? null : time;
}

function compareTableCells(left, right) {
  const leftNumber = tableNumericValue(left);
  const rightNumber = tableNumericValue(right);
  if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber;
  const leftDate = tableDateValue(left);
  const rightDate = tableDateValue(right);
  if (leftDate !== null && rightDate !== null) return leftDate - rightDate;
  // Blanks sort last in both directions rather than clustering at the top.
  if (!left && right) return 1;
  if (left && !right) return -1;
  return left.localeCompare(right, "en-ZA", { numeric: true, sensitivity: "base" });
}

function sortTableBy(table, index, direction) {
  const body = table.tBodies?.[0];
  if (!body) return;
  const rows = tableBodyRows(table);
  if (direction === "none") {
    rows
      .slice()
      .sort((a, b) => Number(a.dataset.tpRow || 0) - Number(b.dataset.tpRow || 0))
      .forEach((row) => body.appendChild(row));
  } else {
    const factor = direction === "descending" ? -1 : 1;
    rows
      .slice()
      .sort((a, b) => factor * compareTableCells(tableCellText(a, index), tableCellText(b, index)))
      .forEach((row) => body.appendChild(row));
  }
  tableHeaderCells(table).forEach((cell, cellIndex) => {
    const active = cellIndex === index && direction !== "none";
    if (active) cell.setAttribute("aria-sort", direction);
    else cell.removeAttribute("aria-sort");
    const mark = cell.querySelector(".tp-sort-mark");
    if (mark) mark.textContent = active ? (direction === "ascending" ? "▲" : "▼") : "↕";
  });
}

/* Locks the current column widths in pixels before the first drag so the
   dragged column is the only one that moves. Written through CSSOM, never as a
   style attribute, so the console's `style-src 'self'` policy still holds. */
function lockTableLayout(table) {
  if (table.dataset.tpLocked) return;
  const cells = tableHeaderCells(table);
  const widths = cells.map((cell) => cell.getBoundingClientRect().width);
  cells.forEach((cell, index) => {
    const width = `${Math.round(widths[index])}px`;
    cell.style.width = width;
    cell.style.minWidth = width;
    cell.style.maxWidth = width;
  });
  table.style.tableLayout = "fixed";
  table.dataset.tpLocked = "1";
}

function bindColumnResize(table, cell) {
  const handle = document.createElement("span");
  handle.className = "tp-col-resize";
  handle.setAttribute("aria-hidden", "true");
  cell.appendChild(handle);

  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    lockTableLayout(table);
    const startX = event.clientX;
    const startWidth = cell.getBoundingClientRect().width;
    handle.classList.add("is-active");
    handle.setPointerCapture(event.pointerId);

    const move = (moveEvent) => {
      const width = `${Math.max(64, Math.round(startWidth + (moveEvent.clientX - startX)))}px`;
      cell.style.width = width;
      cell.style.minWidth = width;
      cell.style.maxWidth = width;
    };
    const stop = () => {
      handle.classList.remove("is-active");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  });
}

function tableVisibleRows(table) {
  return tableBodyRows(table).filter((row) => !row.hidden);
}

function tableSelectedRows(table) {
  return tableBodyRows(table).filter((row) => row.dataset.tpSelected === "1");
}

function updateTableCount(table) {
  const tools = table.tpTools;
  if (!tools) return;
  const total = tableBodyRows(table).length;
  const visible = tableVisibleRows(table).length;
  tools.count.textContent = visible === total
    ? `${total} row${total === 1 ? "" : "s"}`
    : `${visible} of ${total} rows`;
}

function updateSelectionBar(table) {
  const tools = table.tpTools;
  if (!tools?.selectBar) return;
  const selected = tableSelectedRows(table).length;
  tools.selectBar.hidden = selected === 0;
  if (selected) tools.selectLabel.textContent = `${selected} row${selected === 1 ? "" : "s"} selected`;
  const selectAll = table.querySelector("th.tp-select-cell input");
  if (selectAll) {
    const visible = tableVisibleRows(table).length;
    selectAll.checked = selected > 0 && selected === visible;
    selectAll.indeterminate = selected > 0 && selected < visible;
  }
}

function setRowSelected(row, selected) {
  if (selected) row.dataset.tpSelected = "1";
  else delete row.dataset.tpSelected;
  const box = row.querySelector("td.tp-select-cell input");
  if (box) box.checked = selected;
}

function setTableSelectionMode(table, enabled) {
  const headRow = table.tHead?.rows?.[0];
  if (!headRow) return;
  if (enabled) {
    if (headRow.querySelector("th.tp-select-cell")) return;
    const headCell = document.createElement("th");
    headCell.className = "tp-select-cell";
    const selectAll = document.createElement("input");
    selectAll.type = "checkbox";
    selectAll.setAttribute("aria-label", "Select all visible rows");
    selectAll.addEventListener("change", () => {
      tableVisibleRows(table).forEach((row) => setRowSelected(row, selectAll.checked));
      updateSelectionBar(table);
    });
    headCell.appendChild(selectAll);
    headRow.insertBefore(headCell, headRow.firstElementChild);

    tableBodyRows(table).forEach((row) => {
      const cell = row.insertCell(0);
      cell.className = "tp-select-cell";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.setAttribute("aria-label", "Select row");
      box.addEventListener("change", () => {
        setRowSelected(row, box.checked);
        updateSelectionBar(table);
      });
      cell.appendChild(box);
    });
  } else {
    headRow.querySelector("th.tp-select-cell")?.remove();
    tableBodyRows(table).forEach((row) => {
      row.querySelector("td.tp-select-cell")?.remove();
      delete row.dataset.tpSelected;
    });
  }
  updateSelectionBar(table);
}

/* Exports what is on screen, in the order it is on screen: the current sort,
   the current filter and, when rows are ticked, only those rows. */
function exportTableRows(table, onlySelected) {
  const headers = tableHeaderCells(table)
    .map((cell) => cell.textContent.replace(/[▲▼↕]/g, "").replace(/\s+/g, " ").trim())
    .map((label, index) => label || `Column ${index + 1}`);
  const source = onlySelected ? tableSelectedRows(table) : tableVisibleRows(table);
  const rows = source.map((row) => {
    const record = {};
    Array.from(row.cells).forEach((cell, index) => {
      const key = headers[index] || `Column ${index + 1}`;
      if (key === "Actions" || cell.classList.contains("tp-select-cell")) return;
      record[key] = (cell.textContent || "").replace(/\s+/g, " ").trim();
    });
    return record;
  });
  const page = document.querySelector(".admin-shell[data-page]")?.dataset.page || "table";
  downloadCsv(`titopay-${page}-${new Date().toISOString().slice(0, 10)}.csv`, rows);
}

function buildTableTools(table) {
  const tools = document.createElement("div");
  tools.className = "tp-table-tools";

  const main = document.createElement("div");
  main.className = "tp-table-tools-main";

  const searchLabel = document.createElement("label");
  searchLabel.className = "tp-table-search";
  searchLabel.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg>`;
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Filter rows on this page";
  search.setAttribute("aria-label", "Filter the rows shown in this table");
  searchLabel.appendChild(search);

  const count = document.createElement("span");
  count.className = "tp-table-count";
  count.setAttribute("role", "status");

  main.append(searchLabel, count);

  const actions = document.createElement("div");
  actions.className = "tp-table-tools-actions";

  const selectToggle = document.createElement("button");
  selectToggle.type = "button";
  selectToggle.className = "tp-tool-btn";
  selectToggle.setAttribute("aria-pressed", "false");
  selectToggle.textContent = "Select rows";

  const exportButton = document.createElement("button");
  exportButton.type = "button";
  exportButton.className = "tp-tool-btn";
  exportButton.textContent = "Export table";

  actions.append(selectToggle, exportButton);
  tools.append(main, actions);

  const selectBar = document.createElement("div");
  selectBar.className = "tp-select-bar";
  selectBar.hidden = true;
  const selectLabel = document.createElement("strong");
  const exportSelected = document.createElement("button");
  exportSelected.type = "button";
  exportSelected.className = "tp-tool-btn";
  exportSelected.textContent = "Export selected";
  const clearSelection = document.createElement("button");
  clearSelection.type = "button";
  clearSelection.className = "tp-tool-btn";
  clearSelection.textContent = "Clear selection";
  selectBar.append(selectLabel, exportSelected, clearSelection);

  table.tpTools = { count, selectBar, selectLabel };

  search.addEventListener("input", () => {
    const query = search.value.trim().toLowerCase();
    tableBodyRows(table).forEach((row) => {
      row.hidden = Boolean(query) && !row.textContent.toLowerCase().includes(query);
    });
    updateTableCount(table);
    updateSelectionBar(table);
  });

  selectToggle.addEventListener("click", () => {
    const enabled = selectToggle.getAttribute("aria-pressed") !== "true";
    selectToggle.setAttribute("aria-pressed", enabled ? "true" : "false");
    selectToggle.textContent = enabled ? "Done selecting" : "Select rows";
    setTableSelectionMode(table, enabled);
  });

  exportButton.addEventListener("click", () => {
    exportTableRows(table, false);
    showToast("Table exported", "success");
  });

  exportSelected.addEventListener("click", () => {
    exportTableRows(table, true);
    showToast("Selected rows exported", "success");
  });

  clearSelection.addEventListener("click", () => {
    tableBodyRows(table).forEach((row) => setRowSelected(row, false));
    updateSelectionBar(table);
  });

  return { tools, selectBar };
}

function enhanceTable(table) {
  if (table.dataset.tpEnhanced) return;
  table.dataset.tpEnhanced = "1";

  const headerCells = tableHeaderCells(table);
  const rows = tableBodyRows(table);
  if (!headerCells.length) return;

  rows.forEach((row, index) => {
    row.dataset.tpRow = String(index);
  });

  // renderRows() closes every table it builds with an Actions column. Sorting
  // or resizing that column means nothing, so it is left alone.
  const lastIndex = headerCells.length - 1;
  const actionsColumn = headerCells[lastIndex]?.textContent.trim().toLowerCase() === "actions";

  headerCells.forEach((cell, index) => {
    if (actionsColumn && index === lastIndex) return;
    cell.dataset.tpSortable = "1";
    cell.tabIndex = 0;
    cell.setAttribute("role", "columnheader");
    const mark = document.createElement("span");
    mark.className = "tp-sort-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = "↕";
    cell.appendChild(mark);

    const cycle = () => {
      const current = cell.getAttribute("aria-sort");
      const next = current === "ascending" ? "descending" : current === "descending" ? "none" : "ascending";
      sortTableBy(table, index, next);
    };
    cell.addEventListener("click", (event) => {
      if (event.target.closest(".tp-col-resize")) return;
      cycle();
    });
    cell.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        cycle();
      }
    });

    if (index !== lastIndex) bindColumnResize(table, cell);
  });

  if (rows.length >= TABLE_TOOLS_MIN_ROWS) {
    const { tools, selectBar } = buildTableTools(table);
    const anchor = table.closest(".table-wrap") || table;
    anchor.parentNode?.insertBefore(tools, anchor);
    anchor.parentNode?.insertBefore(selectBar, anchor);
    updateTableCount(table);
  }
}

let tableEnhancementQueued = false;

function queueTableEnhancement() {
  if (tableEnhancementQueued) return;
  tableEnhancementQueued = true;
  requestAnimationFrame(() => {
    tableEnhancementQueued = false;
    document.querySelectorAll("#page-content table:not([data-tp-enhanced])").forEach((table) => {
      try {
        enhanceTable(table);
      } catch {
        // A table that cannot be enhanced stays exactly as the module rendered
        // it. The console must never lose a table to a presentation helper.
        table.dataset.tpEnhanced = "1";
      }
    });
  });
}

function startTableEnhancement() {
  queueTableEnhancement();
  new MutationObserver(queueTableEnhancement).observe(document.body, { childList: true, subtree: true });
}

function adminPageDescriptors() {
  return {
    dashboard: ["Infrastructure Dashboard", "Operational overview for the TitoPay API and admin platform."],
    alerts: ["Alert Centre", "Platform alerts kept inside the console: security, compliance, support, transactions and system events."],
    analytics: ["Enterprise Analytics", "Executive, financial, user, transaction, merchant, risk, support and system reporting."],
    "service-builder": ["Service Builder", "Create, configure and publish TitoPay service definitions. Configuration only - never code."],
    users: ["User Management", "View, suspend, lock and unlock customer accounts."],
    merchants: ["Merchant Management", "Verify and monitor business merchants and payment channels."],
    transactions: ["Transaction Monitoring", "Search, review and reverse transaction activity when required."],
    wallets: ["Wallet Monitoring", "Inspect personal, business, system and revenue wallet balances."],
    beneficiaries: ["Beneficiary Management", "Inspect saved beneficiary relationships and disable abusive entries."],
    "chat-monitor": ["Chat Monitor", "Diagnose conversation, presence, delivery, WebSocket and queue health without viewing message content."],
    ticketing: ["Ticketing", "Approve events, monitor ticket sales, refunds, scanner activity and settlements."],
    "enterprise-distribution": ["Enterprise Distribution", "Approve organisations, monitor licences, validation batches and enterprise distribution readiness."],
    support: ["Support Desk", "Track support requests and customer assistance queues."],
    compliance: ["Compliance Dashboard", "Monitor FICA, KYC and verification workflows."],
    "company-documents": ["Company Documents", "Manage controlled policies, contracts, compliance documents and staff acknowledgements."],
    revenue: ["Revenue Dashboard", "Review fee income and the TitoPay revenue wallet."],
    security: ["Security Dashboard", "Track OTP, login and profile lock events."],
    audit: ["Audit Dashboard", "Review immutable platform and admin actions."],
    search: ["Global Search", "Search customers, businesses, wallets and transactions from one operational view."],
    pricing: ["Pricing Engine", "Single source of truth for all TitoPay fees, VAT, effective dates and service pricing."],
    integrations: ["Integration Centre", "Securely configure third-party providers for payments, compliance, VAS, email and SMS."],
    "integration-provider": ["Provider Configuration", "Configure, test, disable and rotate one provider connection."],
    "feature-management": ["Feature Management", "Enable or disable TitoPay platform modules from one Super Admin console."],
    "api-provider-settings": ["API Provider Settings", "Configure, test and monitor third-party providers through the TitoPay API."],
    settings: ["Platform Settings", "Review notification billing, provider abstraction and role visibility."],
    "qr-management": ["QR Management", "Create, export and monitor website, app, campaign and referral QR assets."],
    marketing: ["Marketing Centre", "Create campaign links, referral links, QR campaigns and conversion tracking."],
    "chatbot-escalations": ["Chatbot Escalations", "Review support escalations created from TitoPay chatbot and live assistance flows."],
    "system-logs": ["System Logs", "Review security events, login activity, profile lock events and operational logs."],
    "development-tools": ["Development Tools", "Owner-only operational controls for deployment, diagnostics and system readiness."],
    "engineering-tools": ["Engineering Tools", "Owner-only infrastructure, provider and platform configuration tools."],
    "database-health": ["Database / Health Monitoring", "Monitor TitoPay API, database and operational health indicators."],
    "staff-management": ["Staff Management", "Owner-only staff access, sessions and role visibility controls."],
    "rbac-permissions": ["RBAC / Permissions", "Review role-based access permissions and owner-level access coverage."],
    "email-centre": ["Email Centre", "Monitor TitoPay transactional email delivery and queue health."],
    "email-analytics": ["Email Analytics", "Review delivery, engagement, bounce and complaint trends."],
    "email-templates": ["Email Templates", "Manage versioned transactional email content and safe variables."],
    "email-queue": ["Email Queue", "Review, retry and cancel background email jobs."],
    "email-logs": ["Email Delivery Logs", "Inspect immutable provider delivery attempts."],
    "email-settings": ["Email Settings", "Configure sender identity, limits, expiry periods and the active provider."],
    "email-otp": ["Email OTP", "Configure, monitor and audit queued Email OTP authentication."],
  };
}

function adminPageLoaders() {
  return {
    dashboard: renderDashboard,
    alerts: renderAlertCentre,
    analytics: renderAnalytics,
    "service-builder": renderServiceBuilder,
    users: renderUsers,
    merchants: renderMerchants,
    transactions: renderTransactions,
    wallets: renderWallets,
    beneficiaries: renderBeneficiaries,
    "chat-monitor": renderChatMonitor,
    ticketing: renderTicketing,
    "enterprise-distribution": renderEnterpriseDistribution,
    support: renderSupport,
    "company-documents": renderCompanyDocuments,
    compliance: renderCompliance,
    revenue: renderRevenue,
    security: renderSecurity,
    audit: renderAudit,
    search: renderSearch,
    pricing: renderPricing,
    integrations: renderIntegrations,
    "integration-provider": renderIntegrationProvider,
    "feature-management": renderFeatureManagement,
    "api-provider-settings": renderIntegrations,
    settings: renderSettings,
    "qr-management": renderQrManagement,
    marketing: renderMarketing,
    "chatbot-escalations": renderSupport,
    "system-logs": renderSecurity,
    "development-tools": renderDevelopmentTools,
    "engineering-tools": renderEngineeringTools,
    "database-health": renderDatabaseHealth,
    "staff-management": renderStaffManagement,
    "rbac-permissions": renderRbacPermissions,
    "email-centre": renderEmailDashboard,
    "email-analytics": renderEmailAnalytics,
    "email-templates": renderEmailTemplates,
    "email-queue": renderEmailQueue,
    "email-logs": renderEmailLogs,
    "email-settings": renderEmailSettings,
    "email-otp": renderEmailOtp,
  };
}

async function renderAdminPage(page, me, options = {}) {
  const descriptors = adminPageDescriptors();
  const loaders = adminPageLoaders();
  if (!descriptors[page] || !loaders[page]) throw new Error(`Admin page not configured: ${page}`);
  if (page === "chat-monitor" && !isSuperAdminRole(me.role)) {
    pageShell(page, me, "Chat Monitor", "Super Admin-only operational monitoring.");
    document.getElementById("page-content").innerHTML = `
      <section class="table-card">
        <h3>Access restricted</h3>
        <p class="table-card-note">The Chat Monitor is available only to the TitoPay Super Admin.</p>
      </section>
    `;
    return;
  }
  const [title, subtitle] = descriptors[page];
  const controls = page !== "dashboard"
    ? `<button class="secondary-btn" type="button" data-export-page="${page}">Export CSV</button>`
    : "";
  const root = document.querySelector(".admin-shell[data-page]");
  if (root) root.dataset.page = page;
  pageShell(page, me, title, subtitle, controls);
  showModuleSkeleton();
  setRouteProgress(true);
  try {
    await loaders[page](me);
  } finally {
    setRouteProgress(false);
  }
  if (!options.preserveScroll) {
    document.querySelector(".main-area")?.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }
}

function internalAdminRouteFromHref(href) {
  try {
    const url = new URL(href, location.origin);
    if (url.origin !== location.origin) return null;
    const pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
    return ADMIN_PAGE_ROUTES.get(pathname) ? { page: ADMIN_PAGE_ROUTES.get(pathname), path: pathname } : null;
  } catch {
    return null;
  }
}

async function bootPage() {
  if (!validateAdminHost()) return;
  const root = document.querySelector(".admin-shell[data-page]");
  if (!root) return;
  if (!getAuth()?.accessToken) {
    clearAuth();
    if (location.pathname !== "/" && !location.pathname.endsWith("/index.html")) location.href = "/";
    return;
  }
  try {
    const me = await apiFetch("/admin/me", { invalidateOnAuthFailure: true });
    PAGE_EXPORTS.currentMe = me;
    const auth = { ...(getAuth() || {}), session: me.session };
    setAuth(auth);
    startIdleGuard();
    const page = root.dataset.page;
    await renderAdminPage(page, me, { preserveScroll: true });
    startAlertEngine();
  } catch (error) {
    if (error?.status === 401) {
      clearAuth();
      if (location.pathname !== "/" && !location.pathname.endsWith("/index.html")) {
        location.href = "/";
        return;
      }
    }
    const page = root.dataset.page;
    const me = PAGE_EXPORTS.currentMe || { role: "admin", permissions: [] };
    if (PAGE_EXPORTS.currentMe) renderModuleError(page, me, error);
    else renderStandaloneModuleError(error);
    showToast(adminErrorMessage(error.message || "Unable to load module."));
  }
}

document.addEventListener("submit", async (event) => {
  const supportReplyForm = event.target.closest("#support-agent-reply-form");
  if (supportReplyForm) {
    event.preventDefault();
    const message = String(new FormData(supportReplyForm).get("message") || "").trim();
    if (!message) return;
    try {
      await apiFetch(`/admin/support/conversations/${supportReplyForm.dataset.supportConversationId}/messages`, {
        method: "POST",
        body: JSON.stringify({
          message,
          clientMessageId: `admin-${Date.now()}-${Math.random().toString(36).slice(2)}`
        })
      });
      supportReplyForm.reset();
      PAGE_EXPORTS.supportDraft = "";
      PAGE_EXPORTS.supportThreadForceBottom = true;
      PAGE_EXPORTS.openSupportConversationId = supportReplyForm.dataset.supportConversationId;
      await renderSupport();
      showToast("Reply sent");
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
    return;
  }

  const transactionFilters = event.target.closest("#transaction-filters");
  if (transactionFilters) {
    event.preventDefault();
    await renderTransactions();
    return;
  }

  const rbacEditForm = event.target.closest("#rbac-edit-form");
  if (rbacEditForm) {
    event.preventDefault();
    try {
      await apiFetch(`/admin/roles/${encodeURIComponent(rbacEditForm.dataset.rbacRole)}`, {
        method: "PUT",
        body: JSON.stringify({ permissions: rbacFormPermissions(rbacEditForm) }),
      });
      PAGE_EXPORTS.rbacEditing = null;
      showToast("Role permissions updated");
      await renderRbacPermissions();
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
    return;
  }

  const rbacCreateForm = event.target.closest("#rbac-create-form");
  if (rbacCreateForm) {
    event.preventDefault();
    const data = new FormData(rbacCreateForm);
    try {
      await apiFetch("/admin/roles", {
        method: "POST",
        body: JSON.stringify({
          role: data.get("role"),
          description: data.get("description"),
          permissions: rbacFormPermissions(rbacCreateForm),
        }),
      });
      showToast("Role created");
      await renderRbacPermissions();
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
    return;
  }

  const staffForm = event.target.closest("#staff-create-form");
  if (staffForm) {
    event.preventDefault();
    const formData = new FormData(staffForm);
    const body = {
      fullName: formData.get("fullName"),
      username: formData.get("username"),
      email: formData.get("email"),
      role: formData.get("role"),
      status: formData.get("status"),
      password: formData.get("password"),
    };
    try {
      await apiFetch("/admin/staff", {
        method: "POST",
        body: JSON.stringify(body),
      });
      staffForm.reset();
      showToast("Staff account created");
      await renderStaffManagement();
    } catch (error) {
      showToast(adminErrorMessage(error.message || "Unable to create staff account."));
    }
    return;
  }

  const pricingForm = event.target.closest("#pricing-edit-form");
  if (pricingForm) {
    event.preventDefault();
    const formData = new FormData(pricingForm);
    const flatFee = Number(formData.get("flat_fee") || 0);
    const percentageFee = Number(formData.get("percentage_fee") || 0);
    const body = {
      service_name: formData.get("service_name"),
      fee_type: percentageFee > 0 ? "PERCENTAGE" : flatFee > 0 ? "FIXED" : "FREE",
      fee_value: percentageFee > 0 ? percentageFee : flatFee,
      flat_fee: flatFee,
      percentage_fee: percentageFee,
      minimum_fee: Number(formData.get("minimum_fee") || 0),
      maximum_fee: Number(formData.get("maximum_fee") || 0),
      vat_percentage: Number(formData.get("vat_percentage") || 0),
      effective_date: formData.get("effective_date"),
      enabled: formData.get("enabled") === "on",
      active: formData.get("enabled") === "on",
    };
    try {
      await apiFetch(`/pricing/${pricingForm.dataset.pricingId}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      showToast("Pricing rule updated");
      await renderPricing();
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  }
});

document.addEventListener("click", async (event) => {
  const beneficiaryDisable = event.target.closest("[data-beneficiary-disable]");
  if (beneficiaryDisable) {
    const reason = window.prompt("Reason for disabling this beneficiary relationship:");
    if (!reason || !reason.trim()) return;
    beneficiaryDisable.disabled = true;
    try {
      await apiFetch(`/admin/beneficiaries/${beneficiaryDisable.dataset.beneficiaryDisable}/disable`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim() }),
      });
      showToast("Beneficiary relationship disabled");
      await renderBeneficiaries();
    } catch (error) {
      showToast(adminErrorMessage(error.message));
      beneficiaryDisable.disabled = false;
    }
    return;
  }
  const windowRefresh = event.target.closest("[data-window-refresh]");
  if (windowRefresh) {
    event.preventDefault();
    window.location.reload();
    return;
  }
  // Escape hatch when the API is unreachable: the normal Sign Out calls the API
  // to revoke the session, which cannot succeed while it is down.
  const localSignOut = event.target.closest("[data-admin-signout-local]");
  if (localSignOut) {
    event.preventDefault();
    logoutToLogin("Signed out on this device");
    return;
  }
  const alertSeverity = event.target.closest("[data-alert-severity]");
  if (alertSeverity) {
    const view = alertCentreFilters();
    view.severity = alertSeverity.dataset.alertSeverity;
    view.page = 1;
    renderAlertCentreView();
    return;
  }
  const alertUnreadToggle = event.target.closest("[data-alert-unread-toggle]");
  if (alertUnreadToggle) {
    const view = alertCentreFilters();
    view.unreadOnly = !view.unreadOnly;
    view.page = 1;
    renderAlertCentreView();
    return;
  }
  const alertMarkAllPage = event.target.closest("[data-alert-mark-all-page]");
  if (alertMarkAllPage) {
    markAllAlertsRead();
    showToast("All alerts marked as read");
    return;
  }
  const alertPage = event.target.closest("[data-alert-page]");
  if (alertPage) {
    alertCentreFilters().page = Number(alertPage.dataset.alertPage) || 1;
    renderAlertCentreView();
    return;
  }
  const alertRead = event.target.closest("#page-content [data-alert-read]");
  if (alertRead) {
    markAlertRead(alertRead.dataset.alertRead);
    // Navigation continues through the internal-route handler below.
  }
  const adminPageRefresh = event.target.closest("[data-admin-page-refresh]");
  if (adminPageRefresh) {
    event.preventDefault();
    adminPageRefresh.disabled = true;
    const page = adminPageRefresh.dataset.adminPageRefresh || document.querySelector(".admin-shell[data-page]")?.dataset.page || "dashboard";
    try {
      await renderAdminPage(page, PAGE_EXPORTS.currentMe || { role: "admin", permissions: [] }, { preserveScroll: true });
      showToast("Admin page refreshed");
    } catch (error) {
      const me = PAGE_EXPORTS.currentMe || { role: "admin", permissions: [] };
      renderModuleError(page, me, error);
      showToast(adminErrorMessage(error.message || "Unable to refresh module."));
    } finally {
      adminPageRefresh.disabled = false;
    }
    return;
  }
  const internalLink = event.target.closest("a[href]");
  const internalRoute = internalLink ? internalAdminRouteFromHref(internalLink.getAttribute("href")) : null;
  if (internalRoute && PAGE_EXPORTS.currentMe) {
    event.preventDefault();
    try {
      history.pushState({ page: internalRoute.page }, "", internalRoute.path);
      await renderAdminPage(internalRoute.page, PAGE_EXPORTS.currentMe);
    } catch (error) {
      const me = PAGE_EXPORTS.currentMe || { role: "admin", permissions: [] };
      renderModuleError(internalRoute.page, me, error);
      showToast(adminErrorMessage(error.message || "Unable to load module."));
    }
    return;
  }
  const chatMonitorRefresh = event.target.closest("[data-chat-monitor-refresh]");
  if (chatMonitorRefresh) {
    chatMonitorRefresh.disabled = true;
    try {
      await renderChatMonitor();
      showToast("Chat Monitor refreshed");
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    } finally {
      chatMonitorRefresh.disabled = false;
    }
    return;
  }
  const ticketingAction = event.target.closest("[data-ticketing-action]");
  if (ticketingAction) {
    const action = ticketingAction.dataset.ticketingAction;
    const eventId = ticketingAction.dataset.ticketingId;
    const host = document.getElementById("ticketing-detail-host");
    try {
      if (action === "report") {
        const result = await apiFetch(`/admin/ticketing/events/${eventId}/report`);
        if (host) {
          const report = result.report || {};
          host.innerHTML = tableCard("Ticketing Report", renderKeyValueList([
            ["Event", report.event_name || eventId],
            ["Orders", report.orders ?? 0],
            ["Tickets Sold", report.tickets_sold ?? 0],
            ["Scanned Tickets", report.scanned_tickets ?? 0],
            ["Gross Sales", `R${Number(report.gross_sales || 0).toFixed(2)}`],
            ["Buyer Fees", `R${Number(report.buyer_fees || 0).toFixed(2)}`],
            ["Commission", `R${Number(report.commission || 0).toFixed(2)}`],
            ["Refunds", `R${Number(report.refunds || 0).toFixed(2)}`],
            ["Net Revenue", `R${Number(report.net_revenue || 0).toFixed(2)}`],
          ]));
          host.scrollIntoView({ block: "start" });
        }
        return;
      }
      if (action === "settlement") {
        if (!window.confirm("Create settlement record for this event?")) return;
        const result = await apiFetch(`/admin/ticketing/events/${eventId}/settlement`, { method: "POST", body: JSON.stringify({}) });
        showToast(`Settlement created: ${result.settlement?.settlement_reference || "done"}`);
        await renderTicketing();
        return;
      }
      const noteActions = new Set(["reject", "request_information", "suspend"]);
      const note = noteActions.has(action) ? window.prompt("Add a note for this event action:") : "";
      if (noteActions.has(action) && !note) return;
      await apiFetch(`/admin/ticketing/events/${eventId}/action`, {
        method: "POST",
        body: JSON.stringify({ action, note })
      });
      showToast(`Ticketing event ${action.replaceAll("_", " ")} completed`);
      await renderTicketing();
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
    return;
  }
  const ticketRefundAction = event.target.closest("[data-ticket-refund-action]");
  if (ticketRefundAction) {
    const action = ticketRefundAction.dataset.ticketRefundAction;
    const refundId = ticketRefundAction.dataset.ticketRefundId;
    const note = action === "reject" ? window.prompt("Reason for rejecting this refund:") : "";
    if (action === "reject" && !note) return;
    if (action === "approve" && !window.confirm("Approve this refund and credit the buyer wallet?")) return;
    try {
      await apiFetch(`/admin/ticketing/refunds/${refundId}/action`, {
        method: "POST",
        body: JSON.stringify({ action, note })
      });
      showToast(`Refund ${action} completed`);
      await renderTicketing();
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
    return;
  }
  const enterpriseAction = event.target.closest("[data-enterprise-action]");
  if (enterpriseAction) {
    const action = enterpriseAction.dataset.enterpriseAction;
    const applicationId = enterpriseAction.dataset.enterpriseApplicationId;
    const noteActions = new Set(["reject", "suspend", "revoke"]);
    const note = noteActions.has(action) ? window.prompt("Add a reason for this Enterprise Distribution action:") : "";
    if (noteActions.has(action) && !note) return;
    if (action === "approve" && !window.confirm("Approve this organisation for Enterprise Bulk Distribution Phase 1 access?")) return;
    try {
      await apiFetch(`/admin/enterprise-distribution/applications/${applicationId}/action`, {
        method: "POST",
        body: JSON.stringify({ action, note })
      });
      showToast(`Enterprise Distribution ${action.replaceAll("_", " ")} completed`);
      await renderEnterpriseDistribution();
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
    return;
  }
  const enterpriseBatchRelease = event.target.closest("[data-enterprise-batch-release]");
  if (enterpriseBatchRelease) {
    const batchId = enterpriseBatchRelease.dataset.enterpriseBatchRelease;
    if (!window.confirm("Release this funded Enterprise Distribution batch now? Wallet payouts will be processed immediately.")) return;
    try {
      await apiFetch(`/admin/enterprise-distribution/batches/${batchId}/release`, { method: "POST" });
      showToast("Enterprise Distribution batch release completed");
      await renderEnterpriseDistribution();
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
    return;
  }
  const userAction = event.target.closest("[data-user-action]");
  if (userAction) {
    try {
      await apiFetch(`/admin/users/${userAction.dataset.userId}/${userAction.dataset.userAction}`, { method: "POST" });
      showToast(`User ${userAction.dataset.userAction} completed`);
      const page = document.querySelector(".admin-shell[data-page]")?.dataset.page;
      if (page === "search") await renderSearch();
      else await renderUsers();
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
    return;
  }
  const userRefresh = event.target.closest("[data-user-refresh]");
  if (userRefresh) {
    try {
      const result = await apiFetch("/admin/users");
      const refreshedUser = (result.items || []).find(
        (row) => String(row.id) === String(userRefresh.dataset.userRefresh)
      );
      if (!refreshedUser) throw new Error("User not found");
      const page = document.querySelector(".admin-shell[data-page]")?.dataset.page;
      if (page === "search") {
        updateSearchUserRecord(refreshedUser);
        renderSearchView();
      } else {
        await renderUsers();
      }
      showToast("User profile refreshed");
    } catch (error) {
      showToast(adminErrorMessage(error.message || "Unable to refresh this user profile."));
    }
    return;
  }
  const merchantVerify = event.target.closest("[data-merchant-verify]");
  if (merchantVerify) {
    try {
      await apiFetch(`/merchants/${merchantVerify.dataset.merchantVerify}/verify`, { method: "POST" });
      showToast("Merchant verified");
      await renderMerchants();
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  }
  const reverseTx = event.target.closest("[data-transaction-reverse]");
  if (reverseTx) {
    try {
      await apiFetch(`/transactions/${reverseTx.dataset.transactionReverse}/reverse`, { method: "POST" });
      showToast("Transaction reversed");
      await renderTransactions();
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  }
  const pricingEdit = event.target.closest("[data-pricing-edit]");
  if (pricingEdit) {
    const row = (PAGE_EXPORTS.pricing || []).find((item) => String(item.id) === String(pricingEdit.dataset.pricingEdit));
    const host = document.getElementById("pricing-editor-host");
    if (row && host) {
      host.innerHTML = renderPricingEditor(row);
      host.scrollIntoView({ block: "start" });
    }
  }
  const pricingCancel = event.target.closest("[data-pricing-cancel]");
  if (pricingCancel) {
    const host = document.getElementById("pricing-editor-host");
    if (host) host.innerHTML = "";
  }
  const rbacAddPermission = event.target.closest("[data-rbac-add-permission]");
  if (rbacAddPermission) {
    const form = rbacAddPermission.closest("form");
    const input = form?.querySelector("#rbac-new-permission, input[id^='rbac-new-permission']") || document.getElementById("rbac-new-permission");
    const name = String(input?.value || "").trim();
    if (!/^[A-Za-z0-9_.:-]{2,64}$/.test(name)) {
      showToast("Permission names use letters, numbers, underscores, dots or dashes (2-64 characters).");
      return;
    }
    const grid = form.querySelector(".rbac-permission-grid");
    const existing = form.querySelector(`[name="permissions"][value="${CSS.escape(name)}"]`);
    if (existing) {
      existing.checked = true;
      showToast("That permission is already in the list - it is now ticked.");
    } else if (grid) {
      const row = document.createElement("label");
      row.className = "check-row";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.name = "permissions";
      box.value = name;
      box.checked = true;
      const label = document.createElement("span");
      label.textContent = name.replace(/_/g, " ");
      row.append(box, label);
      grid.appendChild(row);
      showToast(`"${name}" added - save to apply it to the role`);
    }
    if (input) input.value = "";
    return;
  }
  const rbacEdit = event.target.closest("[data-rbac-edit]");
  if (rbacEdit) {
    PAGE_EXPORTS.rbacEditing = rbacEdit.dataset.rbacEdit;
    await renderRbacPermissions();
    document.getElementById("rbac-edit-form")?.scrollIntoView({ block: "start" });
    return;
  }
  const rbacCancel = event.target.closest("[data-rbac-cancel]");
  if (rbacCancel) {
    PAGE_EXPORTS.rbacEditing = null;
    await renderRbacPermissions();
    return;
  }
  const rbacDelete = event.target.closest("[data-rbac-delete]");
  if (rbacDelete) {
    const role = rbacDelete.dataset.rbacDelete;
    if (!window.confirm(`Delete the "${role}" role? Staff accounts using it must be moved first.`)) return;
    try {
      await apiFetch(`/admin/roles/${encodeURIComponent(role)}`, { method: "DELETE" });
      PAGE_EXPORTS.rbacEditing = null;
      showToast("Role deleted");
      await renderRbacPermissions();
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
    return;
  }

  const searchDetail = event.target.closest("[data-search-detail]");
  if (searchDetail) {
    PAGE_EXPORTS.openSearchRecord = { type: searchDetail.dataset.searchDetail, id: searchDetail.dataset.searchId };
    renderSearchView();
    return;
  }
  const searchBack = event.target.closest("[data-search-back]");
  if (searchBack) {
    PAGE_EXPORTS.openSearchRecord = null;
    renderSearchView();
    return;
  }
  const searchTab = event.target.closest("[data-search-tab]");
  if (searchTab) {
    PAGE_EXPORTS.searchTab = searchTab.dataset.searchTab;
    renderSearchView();
    return;
  }
  const integrationTest = event.target.closest("[data-integration-test]");
  if (integrationTest) {
    try {
      const result = await apiFetch(`/admin/integrations/${integrationTest.dataset.integrationTest}/test`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      showToast(result.result?.status === "connected" ? "Integration connected" : result.result?.errorMessage || "Integration status checked");
      if (location.pathname.includes("/integrations")) await renderIntegrations(PAGE_EXPORTS.currentMe || {});
      if (document.querySelector('.admin-shell[data-page="integration-provider"]')) await renderIntegrationProvider(PAGE_EXPORTS.currentMe || {});
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  }
  const integrationDisable = event.target.closest("[data-integration-disable]");
  if (integrationDisable) {
    try {
      await apiFetch(`/admin/integrations/${integrationDisable.dataset.integrationDisable}/disable`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      showToast("Integration disabled");
      if (document.querySelector('.admin-shell[data-page="integration-provider"]')) await renderIntegrationProvider(PAGE_EXPORTS.currentMe || {});
      else if (location.pathname.includes("/integrations")) await renderIntegrations(PAGE_EXPORTS.currentMe || {});
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  }
  const integrationRotate = event.target.closest("[data-integration-rotate]");
  if (integrationRotate) {
    try {
      await apiFetch(`/admin/integrations/${integrationRotate.dataset.integrationRotate}/rotate`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      showToast("Credentials rotated. Re-test this provider before production use.");
      if (document.querySelector('.admin-shell[data-page="integration-provider"]')) await renderIntegrationProvider(PAGE_EXPORTS.currentMe || {});
      else if (location.pathname.includes("/integrations")) await renderIntegrations(PAGE_EXPORTS.currentMe || {});
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  }
  const marketingSmsApprove = event.target.closest("[data-marketing-sms-approve]");
  if (marketingSmsApprove) {
    const campaignId = marketingSmsApprove.dataset.marketingSmsApprove;
    const campaign = (PAGE_EXPORTS.marketingSmsCampaigns || []).find((item) => item.id === campaignId);
    const label = campaign?.title || "this SMS campaign";
    const recipients = campaign?.estimatedRecipients ?? "all selected";
    if (!window.confirm(`Approve and send "${label}" to ${recipients} TitoPay user(s)?`)) return;
    marketingSmsApprove.disabled = true;
    try {
      await apiFetch(`/admin/marketing/sms-campaigns/${campaignId}/approve`, {
        method: "POST",
        body: JSON.stringify({})
      });
      showToast("SMS campaign approved and sent");
      await renderMarketing(PAGE_EXPORTS.currentMe || {});
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    } finally {
      marketingSmsApprove.disabled = false;
    }
    return;
  }
  const announcementApprove = event.target.closest("[data-announcement-approve]");
  if (announcementApprove) {
    const campaignId = announcementApprove.dataset.announcementApprove;
    const campaign = (PAGE_EXPORTS.marketingAnnouncements || []).find((item) => item.id === campaignId);
    const approvalRole = PAGE_EXPORTS.marketingAnnouncementApprovalRole || "executive";
    if (!window.confirm(`Approve and deliver "${campaign?.title || "this announcement"}" as ${approvalRole.toUpperCase()}?`)) return;
    announcementApprove.disabled = true;
    try {
      const result = await apiFetch(`/admin/marketing/announcements/${campaignId}/approve`, {
        method: "POST",
        body: JSON.stringify({})
      });
      showToast(result.status === "sent" ? `Announcement delivered to ${result.sentCount} PWA user(s)` : `${approvalRole.toUpperCase()} approval recorded`);
      await renderMarketing(PAGE_EXPORTS.currentMe || {});
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    } finally {
      announcementApprove.disabled = false;
    }
    return;
  }
  const webhookRetry = event.target.closest("[data-webhook-retry]");
  if (webhookRetry) {
    try {
      await apiFetch(`/admin/integrations/webhooks/${webhookRetry.dataset.webhookRetry}/retry`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      showToast("Webhook retry queued");
      if (location.pathname.includes("/integrations")) await renderIntegrations(PAGE_EXPORTS.currentMe || {});
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  }
  const qrDownloadPng = event.target.closest("[data-qr-download-png]");
  if (qrDownloadPng) {
    const asset = [...(PAGE_EXPORTS["qr-management"] || []), ...(PAGE_EXPORTS.marketingQrAssets || [])].find((item) => item.reference === qrDownloadPng.dataset.qrDownloadPng);
    if (asset?.pngDataUrl) downloadDataUrl(`${asset.reference}.png`, asset.pngDataUrl);
  }
  const qrDownloadSvg = event.target.closest("[data-qr-download-svg]");
  if (qrDownloadSvg) {
    const asset = [...(PAGE_EXPORTS["qr-management"] || []), ...(PAGE_EXPORTS.marketingQrAssets || [])].find((item) => item.reference === qrDownloadSvg.dataset.qrDownloadSvg);
    if (asset?.svg) downloadText(`${asset.reference}.svg`, asset.svg, "image/svg+xml");
  }
  const qrPrint = event.target.closest("[data-qr-print]");
  if (qrPrint) {
    const asset = [...(PAGE_EXPORTS["qr-management"] || []), ...(PAGE_EXPORTS.marketingQrAssets || [])].find((item) => item.reference === qrPrint.dataset.qrPrint);
    if (asset) printQrAsset(asset);
  }
  const exportPage = event.target.closest("[data-export-page]");
  if (exportPage) {
    downloadCsv(`titopay-${exportPage.dataset.exportPage}-${new Date().toISOString().slice(0, 10)}.csv`, PAGE_EXPORTS[exportPage.dataset.exportPage] || []);
  }
  const transactionFilterReset = event.target.closest("[data-transaction-filter-reset]");
  if (transactionFilterReset) {
    document.getElementById("transaction-filters")?.reset();
    await renderTransactions();
  }
  const documentArchive = event.target.closest("[data-doc-archive]");
  if (documentArchive) {
    try {
      await apiFetch(`/admin/company-documents/${documentArchive.dataset.docArchive}/archive`, {
        method: "POST",
        body: JSON.stringify({})
      });
      showToast("Document archived.");
      await renderCompanyDocuments();
    } catch (error) {
      showToast(adminErrorMessage(error.message || "Unable to archive document."));
    }
  }
  const documentAck = event.target.closest("[data-doc-ack]");
  if (documentAck) {
    try {
      await apiFetch(`/admin/company-documents/${documentAck.dataset.docAck}/acknowledge`, {
        method: "POST",
        body: JSON.stringify({})
      });
      showToast("Document acknowledged.");
      await renderCompanyDocuments();
    } catch (error) {
      showToast(adminErrorMessage(error.message || "Unable to acknowledge document."));
    }
  }
  const supportStatus = event.target.closest("[data-support-status]");
  if (supportStatus) {
    try {
      await apiFetch(`/admin/support/tickets/${supportStatus.dataset.supportId}/status`, {
        method: "POST",
        body: JSON.stringify({ status: supportStatus.dataset.supportStatus }),
      });
      showToast("Support ticket updated");
      await renderSupport();
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  }
  const supportChatAssign = event.target.closest("[data-support-chat-assign]");
  if (supportChatAssign) {
    try {
      await apiFetch(`/admin/support/conversations/${supportChatAssign.dataset.supportChatAssign}/assign`, {
        method: "POST",
      });
      showToast("Chat conversation assigned");
      await renderSupport();
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  }
  const supportChatTakeover = event.target.closest("[data-support-chat-takeover]");
  if (supportChatTakeover) {
    try {
      const id = supportChatTakeover.dataset.supportChatTakeover;
      await apiFetch(`/admin/support/conversations/${id}/takeover`, {
        method: "POST",
        body: JSON.stringify({})
      });
      showToast("Support chat taken over");
      PAGE_EXPORTS.supportThreadForceBottom = true;
      PAGE_EXPORTS.openSupportConversationId = id;
      await renderSupport();
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  }
  const supportQuickReply = event.target.closest("[data-support-quick-reply]");
  if (supportQuickReply) {
    const reply = SUPPORT_QUICK_REPLIES[Number(supportQuickReply.dataset.supportQuickReply)];
    const composer = document.getElementById("support-agent-message");
    if (reply && composer) {
      const firstName = supportAgentFirstName();
      const text = firstName ? reply.text.replaceAll("[Agent Name]", firstName) : reply.text;
      composer.value = composer.value.trim() ? `${composer.value.replace(/\s+$/, "")}\n\n${text}` : text;
      PAGE_EXPORTS.supportDraft = composer.value;
      composer.focus();
      composer.setSelectionRange(composer.value.length, composer.value.length);
      PAGE_EXPORTS.supportDraftCaret = composer.value.length;
    }
    return;
  }
  const supportChatHistory = event.target.closest("[data-support-chat-history]");
  if (supportChatHistory) {
    PAGE_EXPORTS.supportThreadForceBottom = true;
    PAGE_EXPORTS.openSupportConversationId = supportChatHistory.dataset.supportChatHistory;
    await renderSupport();
    return;
  }
  const supportBack = event.target.closest("[data-support-back]");
  if (supportBack) {
    PAGE_EXPORTS.openSupportConversationId = null;
    PAGE_EXPORTS.supportDraft = "";
    await renderSupport();
    return;
  }
  const supportTab = event.target.closest("[data-support-tab]");
  if (supportTab) {
    PAGE_EXPORTS.supportTab = supportTab.dataset.supportTab;
    await renderSupport();
    return;
  }
  const supportChatReply = event.target.closest("[data-support-chat-reply]");
  if (supportChatReply) {
    PAGE_EXPORTS.openSupportConversationId = supportChatReply.dataset.supportChatReply;
    await renderSupport();
    return;
  }
  const supportChatResolve = event.target.closest("[data-support-chat-resolve]");
  if (supportChatResolve) {
    try {
      await apiFetch(`/admin/support/conversations/${supportChatResolve.dataset.supportChatResolve}/resolve`, {
        method: "POST", body: JSON.stringify({})
      });
      showToast("Support conversation resolved");
      await renderSupport();
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  }
  const supportChatReopen = event.target.closest("[data-support-chat-reopen]");
  if (supportChatReopen) {
    try {
      await apiFetch(`/admin/support/conversations/${supportChatReopen.dataset.supportChatReopen}/reopen`, {
        method: "POST", body: JSON.stringify({})
      });
      showToast("Support conversation reopened");
      await renderSupport();
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  }
  const supportChatUnassign = event.target.closest("[data-support-chat-unassign]");
  if (supportChatUnassign) {
    try {
      await apiFetch(`/admin/support/conversations/${supportChatUnassign.dataset.supportChatUnassign}/unassign`, {
        method: "POST", body: JSON.stringify({})
      });
      showToast("Support conversation released");
      await renderSupport();
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  }
  const supportChatTransfer = event.target.closest("[data-support-chat-transfer]");
  if (supportChatTransfer) {
    const agentId = window.prompt("Enter the authorised support agent ID:");
    if (agentId) {
      try {
        await apiFetch(`/admin/support/conversations/${supportChatTransfer.dataset.supportChatTransfer}/transfer`, {
          method: "POST", body: JSON.stringify({ agentId: agentId.trim() })
        });
        showToast("Support conversation transferred");
        await renderSupport();
      } catch (error) {
        showToast(adminErrorMessage(error.message));
      }
    }
  }
  const supportChatNote = event.target.closest("[data-support-chat-note]");
  if (supportChatNote) {
    const note = window.prompt("Internal note for support staff only:");
    if (note && note.trim()) {
      try {
        await apiFetch(`/admin/support/conversations/${supportChatNote.dataset.supportChatNote}/notes`, {
          method: "POST",
          body: JSON.stringify({ note }),
        });
        showToast("Internal note saved");
        PAGE_EXPORTS.openSupportConversationId = supportChatNote.dataset.supportChatNote;
        await renderSupport();
      } catch (error) {
        showToast(adminErrorMessage(error.message));
      }
    }
  }
  const walletAction = event.target.closest("[data-wallet-action]");
  if (walletAction) {
    try {
      await apiFetch(`/admin/wallets/${walletAction.dataset.walletId}/${walletAction.dataset.walletAction}`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      showToast(`Wallet ${walletAction.dataset.walletAction} completed`);
      await renderWallets(PAGE_EXPORTS.currentMe || {});
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  }
  const supportChatClose = event.target.closest("[data-support-chat-close]");
  if (supportChatClose) {
    try {
      await apiFetch(`/admin/support/conversations/${supportChatClose.dataset.supportChatClose}/close`, {
        method: "POST",
      });
      showToast("Chat conversation closed");
      await renderSupport();
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  }
  const profileChangeApprove = event.target.closest("[data-profile-change-approve]");
  if (profileChangeApprove) {
    if (!window.confirm("Approve this profile update and apply the changes to the user account?")) return;
    try {
      await apiFetch(`/admin/profile-change-requests/${profileChangeApprove.dataset.profileChangeApprove}/approve`, {
        method: "POST",
        body: JSON.stringify({})
      });
      showToast("Profile update approved");
      await renderSupport();
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  }
  const profileChangeReject = event.target.closest("[data-profile-change-reject]");
  if (profileChangeReject) {
    const notes = window.prompt("Reason for rejecting this profile update:");
    if (!notes) return;
    try {
      await apiFetch(`/admin/profile-change-requests/${profileChangeReject.dataset.profileChangeReject}/reject`, {
        method: "POST",
        body: JSON.stringify({ notes })
      });
      showToast("Profile update rejected");
      await renderSupport();
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  }
  const reviewStatus = event.target.closest("[data-review-status]");
  if (reviewStatus) {
    try {
      await apiFetch(`/admin/compliance/reviews/${reviewStatus.dataset.reviewId}/status`, {
        method: "POST",
        body: JSON.stringify({ status: reviewStatus.dataset.reviewStatus }),
      });
      showToast("Compliance review updated");
      await renderCompliance();
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  }
});

window.addEventListener("popstate", async () => {
  if (!PAGE_EXPORTS.currentMe) return;
  const path = location.pathname.endsWith("/") ? location.pathname : `${location.pathname}/`;
  const page = ADMIN_PAGE_ROUTES.get(path) || document.querySelector(".admin-shell[data-page]")?.dataset.page || "dashboard";
  try {
    await renderAdminPage(page, PAGE_EXPORTS.currentMe);
  } catch (error) {
    renderModuleError(page, PAGE_EXPORTS.currentMe, error);
    showToast(adminErrorMessage(error.message || "Unable to load module."));
  }
});

window.addEventListener("unhandledrejection", (event) => {
  const message = event.reason?.message || event.reason || "Unable to complete this admin action.";
  showToast(adminErrorMessage(message));
});

window.addEventListener("error", (event) => {
  showToast(adminErrorMessage(event.message || "Unable to complete this admin action."));
});

window.addEventListener("DOMContentLoaded", () => {
  registerActivityListeners();
  if (document.body.dataset.page === "login") {
    bootLogin();
  } else {
    // Locks the document to the console's own scroll regions (rail + workspace).
    document.body.classList.add("admin-body");
    startTableEnhancement();
    bootPage();
  }
});
