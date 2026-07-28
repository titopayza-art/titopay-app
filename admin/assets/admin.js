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
    ["/search/", "search", "Global Search"],
    ["/users/", "users", "Users"],
    ["/merchants/", "merchants", "Merchants"],
    ["/transactions/", "transactions", "Transactions"],
    ["/wallets/", "wallets", "Wallets"],
    ["/chat-monitor/", "chat-monitor", "Chat Monitor"],
    ["/ticketing/", "ticketing", "Ticketing"],
    ["/enterprise-distribution/", "enterprise-distribution", "Enterprise Distribution"],
    ["/qr-management/", "qr-management", "QR Management"],
    ["/marketing/", "marketing", "Marketing"],
  ]},
  { title: "Platform", items: [
    ["/pricing/", "pricing", "Pricing Engine"],
    ["/integrations/", "integrations", "Integration Centre"],
    ["/feature-management/", "feature-management", "Feature Management"],
    ["/api-provider-settings/", "api-provider-settings", "API Provider Settings"],
    ["/settings/", "settings", "Settings"],
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

function showToast(message) {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    document.body.appendChild(toast);
  }
  toast.textContent = adminErrorMessage(message);
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
        if (["support", "chatbot-escalations"].includes(page) && !document.querySelector("#support-agent-message:focus")) {
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
      if (["support", "chatbot-escalations"].includes(page) && !document.querySelector("#support-agent-message:focus")) {
        renderSupport().catch(() => null);
      }
    } catch {}
  });
  supportChatSocket.addEventListener("close", () => {
    supportChatSocket = null;
    if (!supportFallbackRefreshTimer) {
      supportFallbackRefreshTimer = setInterval(() => {
        const page = document.querySelector(".admin-shell[data-page]")?.dataset.page;
        if (["support", "chatbot-escalations"].includes(page) && !document.querySelector("#support-agent-message:focus")) {
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
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm9 16-4.2-4.2",
  users: "M16 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm11 10v-2a4 4 0 0 0-3-3.9M16 3.6a4 4 0 0 1 0 7.8",
  merchants: "M3 9.5 4.5 5h15L21 9.5M3 9.5h18M3 9.5a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0M5 12v7h14v-7",
  transactions: "M4 8h13m0 0-3-3m3 3-3 3M20 16H7m0 0 3-3m-3 3 3 3",
  wallets: "M3 7.5A2.5 2.5 0 0 1 5.5 5H18v3M3 7.5V17a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2M3 7.5V10h16a2 2 0 0 1 2 2v3m0 0h-4a2 2 0 1 1 0-4h4",
  "chat-monitor": "M20 12a8 8 0 1 1-3.2-6.4M21 4v5h-5",
  ticketing: "M4 8.5A1.5 1.5 0 0 1 5.5 7h13A1.5 1.5 0 0 1 20 8.5v2a2 2 0 0 0 0 3.9v2A1.5 1.5 0 0 1 18.5 18h-13A1.5 1.5 0 0 1 4 16.4v-2a2 2 0 0 0 0-3.9v-2ZM12 7v11",
  "enterprise-distribution": "M12 3v6m0 0-3.5 3.5M12 9l3.5 3.5M4 21v-4m0 0-1-1.5m1 1.5 1-1.5M20 21v-4m0 0-1-1.5m1 1.5 1-1.5M12 21v-4",
  "qr-management": "M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 3h3m0 0v3m0-3h3m-6-3h6",
  marketing: "M4 10v4h3l5 4V6L7 10H4Zm13-1.5a5 5 0 0 1 0 7",
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
      users: "users",
      merchants: "merchants",
      transactions: "transactions",
      wallets: "wallets",
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
      "development-tools": "__owner__",
      "engineering-tools": "__owner__",
      "database-health": "__owner__",
      "staff-management": "__owner__",
      "rbac-permissions": "__owner__",
    };
    const required = map[slug] || slug;
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
      <button class="nav-toggle" type="button" data-nav-toggle aria-label="Open navigation" aria-controls="admin-sidebar" aria-expanded="false">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
      </button>
      <nav class="topbar-crumbs" id="admin-crumbs" aria-label="Breadcrumb">
        <span class="crumb-section">${escapeHtml(navGroupTitleFor(page))}</span>
        <span class="crumb-sep" aria-hidden="true">/</span>
        <strong>${escapeHtml(title)}</strong>
      </nav>
      <div class="topbar-meta">
        <span class="env-badge${environment.nonProd ? " env-nonprod" : ""}" title="Environment">${escapeHtml(environment.label)}</span>
        <span class="topbar-clock" id="admin-clock" title="South African Standard Time"></span>
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

  document.querySelector("[data-nav-toggle]")?.addEventListener("click", () => {
    setNavDrawer(document.querySelector(".admin-shell")?.dataset.nav !== "open");
  });

  document.querySelector("[data-nav-close]")?.addEventListener("click", () => setNavDrawer(false));

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
  const message = adminErrorMessage(error?.message || "Unable to load this module.");
  const requestId = error?.requestId || error?.payload?.requestId || "";
  const detailRows = [
    ["Status", error?.status === 0 ? "Connection unavailable" : `Service response ${error?.status || "unavailable"}`],
    ["Reference", requestId || "-"]
  ];
  shell.innerHTML = `
    <main class="main-area standalone-error">
      <div class="page-header">
        <div>
          <h1>Admin module unavailable</h1>
          <p>${escapeHtml(message)}</p>
        </div>
        <div class="header-actions">
          <button class="secondary-btn admin-refresh-btn" type="button" data-window-refresh>Refresh</button>
        </div>
      </div>
      <section class="table-card">
        <h3>Operational notice</h3>
        <p class="table-card-note">Refresh this page first. If the issue continues, check that the latest API package is deployed and the TitoPay API process is online.</p>
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
  if (!rows.length) return `<div class="empty">No records available.</div>`;
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
    .filter((link) => link.dataset.navSlug !== "dashboard")
    .slice(0, limit)
    .map((link) => `<a href="${escapeHtml(link.getAttribute("href"))}">${escapeHtml(link.textContent.trim())}</a>`)
    .join("");
  return links ? `<div class="quick-link-grid">${links}</div>` : "";
}

async function renderDashboard(me) {
  const overview = await apiFetch("/admin/dashboard/overview");
  const page = document.getElementById("page-content");
  const lockedProfiles = Number(overview.lockedProfiles || 0);
  const pendingCompliance = Number(overview.pendingCompliance || 0);
  const attention = lockedProfiles + pendingCompliance;
  page.innerHTML = `
    ${renderMetrics([
      ["Users", overview.users],
      ["Merchants", overview.merchants],
      ["Transactions", overview.transactions],
      ["Revenue", money(overview.revenue)],
    ])}
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
        </div>
        <p class="table-card-note">${attention
          ? `${attention} item${attention === 1 ? "" : "s"} open across the review queues.`
          : "All review queues are clear."}</p>
        ${dashboardQuickLinks()}
      </article>
      <article class="panel">
        <h3>Session</h3>
        <p>Platform overview for the account you are signed in with.</p>
        ${renderKeyValueList([
          ["Role", adminPositionLabel(me.role)],
          ["Environment", adminEnvironment().label],
          ["Access", hasFullAdminAccess(me) ? "Full platform access" : `${(me.permissions || []).length} scoped permissions`],
        ])}
        <p class="table-card-note">The customer PWA stays isolated: the admin console and the TitoPay API operate as separate layers, and every sensitive action here is written to the audit log.</p>
      </article>
    </section>
  `;
}

async function renderSearch() {
  const result = await apiFetch("/admin/global-search");
  const state = {
    users: result.users || result.items?.users || [],
    merchants: result.merchants || result.items?.merchants || [],
    wallets: result.wallets || result.items?.wallets || [],
    transactions: result.transactions || result.items?.transactions || [],
  };
  PAGE_EXPORTS.searchState = state;
  const runSearch = (term = "") => {
    const query = normalizeSearchText(term);
    const userMatches = !query ? state.users.slice(0, 12) : state.users.filter((row) => normalizeSearchText([
      row.full_name,
      row.username,
      row.email,
      row.phone,
      row.wallet_id,
      row.business_name,
      row.fica_status,
      row.id,
    ].join(" ")).includes(query));
    const merchantMatches = !query ? state.merchants.slice(0, 8) : state.merchants.filter((row) => normalizeSearchText([
      row.business_name,
      row.username,
      row.email,
      row.phone,
      row.id,
    ].join(" ")).includes(query));
    const walletMatches = !query ? state.wallets.slice(0, 8) : state.wallets.filter((row) => normalizeSearchText([
      row.id,
      row.kind,
      row.full_name,
      row.business_name,
      row.username,
      row.status,
    ].join(" ")).includes(query));
    const transactionMatches = !query ? state.transactions.slice(0, 8) : state.transactions.filter((row) => normalizeSearchText([
      row.reference,
      row.service_name,
      row.service_code,
      row.status,
      row.id,
    ].join(" ")).includes(query));
    PAGE_EXPORTS.search = [
      ...userMatches.map((row) => ({ type: "user", ...row })),
      ...merchantMatches.map((row) => ({ type: "merchant", ...row })),
      ...walletMatches.map((row) => ({ type: "wallet", ...row })),
      ...transactionMatches.map((row) => ({ type: "transaction", ...row })),
    ];
    const preferredDetail = userMatches[0]
      ? { type: "user", id: userMatches[0].id }
      : merchantMatches[0]
        ? { type: "merchant", id: merchantMatches[0].id }
        : walletMatches[0]
          ? { type: "wallet", id: walletMatches[0].id }
          : transactionMatches[0]
            ? { type: "transaction", id: transactionMatches[0].id || transactionMatches[0].reference }
            : null;
    document.getElementById("search-results").innerHTML = `
      <div id="search-detail-host">
        ${preferredDetail ? renderSearchDetail(preferredDetail.type, preferredDetail.id) : tableCard("Record Details", `<div class="empty">No matching TitoPay record found for this search.</div>`)}
      </div>
      <section class="panel-grid search-result-grid">
        ${tableCard("People", renderRows(userMatches, [
          { label: "Profile", render: (row) => `<div class="mini-profile">${profileAvatarHtml(row)}<span><strong>${escapeHtml(row.full_name || "-")}</strong><br><small>${escapeHtml(row.username || "-")}</small></span></div>` },
          { label: "Contact", render: (row) => `${escapeHtml(row.phone || "-")}<br><small>${escapeHtml(row.email || "-")}</small>` },
          { label: "Wallet", render: (row) => `<strong>${escapeHtml(row.wallet_id ? compactId(row.wallet_id) : "-")}</strong><br><small>${escapeHtml(row.wallet_type || row.account_type || "-")}</small>` },
          { label: "Business", render: (row) => escapeHtml(row.business_name || "-") },
          { label: "Verification", render: (row) => `<span class="chip ${chipClass(row.fica_status)}">${escapeHtml(row.fica_status || "Not submitted")}</span>` },
          { label: "Risk / Devices", render: (row) => `${escapeHtml(Array.isArray(row.risk_flags) && row.risk_flags.length ? row.risk_flags.join(", ") : "None")}<br><small>${escapeHtml(row.linked_devices ?? 0)} linked devices</small>` },
        ], (row) => `
          <button data-search-detail="user" data-search-id="${escapeHtml(row.id)}">View</button>
          <button data-user-refresh="${escapeHtml(row.id)}">Refresh</button>
          <button data-user-action="${row.status === "suspended" ? "activate" : "suspend"}" data-user-id="${escapeHtml(row.id)}">${row.status === "suspended" ? "Activate" : "Suspend"}</button>
          <button data-user-action="${row.profile_locked ? "unlock" : "lock"}" data-user-id="${escapeHtml(row.id)}">${row.profile_locked ? "Unlock" : "Lock"}</button>
        `))}
        ${tableCard("Businesses", renderRows(merchantMatches, [
          { label: "Business", render: (row) => `<strong>${escapeHtml(row.business_name || "-")}</strong><br><small>${escapeHtml(row.username || "-")}</small>` },
          { label: "Contact", render: (row) => `${escapeHtml(row.email || "-")}<br><small>${escapeHtml(row.phone || "-")}</small>` },
          { label: "Verification", render: (row) => `<span class="chip ${chipClass(row.verification_status)}">${escapeHtml(row.verification_status || "-")}</span>` },
          { label: "Status", render: (row) => `<span class="chip ${chipClass(row.status)}">${escapeHtml(row.status || "-")}</span>` },
        ], (row) => `<button data-search-detail="merchant" data-search-id="${escapeHtml(row.id)}">View</button>`))}
      </section>
      <section class="panel-grid search-result-grid">
        ${tableCard("Wallet Summary", renderRows(walletMatches, [
          { label: "Wallet ID", render: (row) => `<strong>${escapeHtml(compactId(row.id))}</strong><br><small>${escapeHtml(row.kind || "-")}</small>` },
          { label: "Owner", render: (row) => `${escapeHtml(row.full_name || row.business_name || "System")}<br><small>${escapeHtml(row.username || "-")}</small>` },
          { label: "Available", render: (row) => money(row.available_balance) },
          { label: "Reserved", render: (row) => money(row.reserved_balance) },
        ], (row) => `<button data-search-detail="wallet" data-search-id="${escapeHtml(row.id)}">View</button>`))}
        ${tableCard("Recent Transactions", renderRows(transactionMatches, [
          { label: "Reference", key: "reference" },
          { label: "Service", render: (row) => `<strong>${escapeHtml(row.service_name || "-")}</strong><br><small>${escapeHtml(row.service_code || "-")}</small>` },
          { label: "Amount", render: (row) => money(row.amount) },
          { label: "Status", render: (row) => `<span class="chip ${chipClass(row.status)}">${escapeHtml(row.status || "-")}</span>` },
        ], (row) => `<button data-search-detail="transaction" data-search-id="${escapeHtml(row.id || row.reference)}">View</button>`))}
      </section>
    `;
  };
  document.getElementById("page-content").innerHTML = `
    <section class="panel search-panel">
      <h3>Global User Search</h3>
      <p>Search by full name, TitoPay ID, email, mobile number, business name, wallet ID, or transaction reference.</p>
      <form id="global-search-form" class="search-form">
        <div class="field">
          <label>Search TitoPay records</label>
          <input name="query" placeholder="Name, @username, +27 number, email, wallet ID..." autocomplete="off">
        </div>
        <button class="primary-btn" type="submit">Search</button>
      </form>
    </section>
    <div id="search-results"></div>
  `;
  document.getElementById("global-search-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    runSearch(new FormData(event.currentTarget).get("query"));
  });
  runSearch("");
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

async function renderSupport() {
  const [ticketResult, conversationResult, profileChangeResult] = await Promise.all([
    apiFetch("/admin/support/tickets"),
    apiFetch("/admin/support/conversations").catch(() => ({ items: [] })),
    apiFetch("/admin/profile-change-requests").catch(() => ({ items: [], metrics: {} })),
  ]);
  const tickets = ticketResult.items || [];
  const conversations = conversationResult.items || [];
  const conversationCounts = conversationResult.counts || {};
  const profileChanges = profileChangeResult.items || [];
  const open = tickets.filter((row) => ["open", "in_progress", "pending"].includes(row.status)).length;
  const escalated = tickets.filter((row) => row.status === "escalated").length;
  const resolved = tickets.filter((row) => ["resolved", "closed"].includes(row.status)).length;
  const activeChats = Number(conversationCounts.active ?? conversations.filter((row) => ["AGENT_ACTIVE", "REOPENED"].includes(row.status)).length);
  const profilePending = profileChanges.filter((row) => ["pending", "in_review"].includes(row.status)).length;
  const profileOverdue = profileChanges.filter((row) => ["pending", "in_review"].includes(row.status) && row.dueAt && new Date(row.dueAt).getTime() < Date.now()).length;
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
  const chatParticipant = (participant) => {
    if (!participant) return "-";
    const name = participant.full_name || participant.username || participant.email || participant.phone || "TitoPay user";
    const handle = participant.username ? `@${participant.username}` : participant.email || participant.phone || participant.account_type || "";
    return `<strong>${escapeHtml(name)}</strong><br><small>${escapeHtml(handle)}</small>`;
  };
  const assignedTo = (row) => row.assignedAgent?.name || row.metadata?.assigned_to || row.metadata?.assignedTo || "Customer Care Queue";
  ensureAdminSupportSocket();
  document.getElementById("page-content").innerHTML = tableCard(
    "Customer Support Centre",
    `
      ${renderMetrics([
        ["Open Queue", open],
        ["Escalated", escalated],
        ["Resolved", resolved],
        ["Active Chats", activeChats],
        ["Waiting", Number(conversationCounts.waiting || 0)],
        ["Assigned to Me", Number(conversationCounts.mine || 0)],
        ["Profile Approvals", profilePending],
        ["SLA Overdue", profileOverdue],
      ])}
      <section class="panel-grid support-grid">
        <article class="panel">
          <h3>Chatbot Escalations</h3>
          <p>Live support conversations escalated from the TitoPay chatbot enter this queue. Agents can accept, escalate, resolve or reopen cases based on RBAC permissions.</p>
          <div class="ops-list ops-list-two">
            <span><strong>${open}</strong>Waiting or active</span>
            <span><strong>${escalated}</strong>Needs specialist</span>
            <span><strong>RBAC</strong>Profile and wallet context</span>
            <span><strong>Audit</strong>Every action logged</span>
          </div>
        </article>
        <article class="panel">
          <h3>Agent Workflow</h3>
          <p>Customer Care can take ownership, transfer complex cases to Compliance, Finance or Engineering, and close cases once the user confirms resolution.</p>
        </article>
      </section>
      <h3 class="section-title">Support Tickets</h3>
      ${renderRows(tickets, [
      { label: "Request", render: (row) => `<strong>${escapeHtml(row.subject)}</strong><br><small>${escapeHtml(row.category)} · ${escapeHtml(new Date(row.created_at || Date.now()).toLocaleDateString("en-ZA"))}</small>` },
      { label: "Customer", render: (row) => `${escapeHtml(row.full_name || "-")}<br><small>${escapeHtml(row.username || "-")}</small>` },
      { label: "Details", render: (row) => `<small>${escapeHtml(String(row.message || "").slice(0, 140))}${String(row.message || "").length > 140 ? "..." : ""}</small>` },
      { label: "Assigned", render: (row) => escapeHtml(row.assigned_to || "Customer Care Queue") },
      { label: "Status", render: (row) => `<span class="chip ${chipClass(row.status)}">${escapeHtml(row.status)}</span>` },
    ], (row) => `
      <button data-support-status="in_progress" data-support-id="${row.id}">Take over</button>
      <button data-support-status="escalated" data-support-id="${row.id}">Escalate</button>
      <button data-support-status="resolved" data-support-id="${row.id}">Resolve</button>
      <button data-support-status="pending" data-support-id="${row.id}">Reopen</button>
    `)}
      <h3 class="section-title">Escalated Support Conversations</h3>
      ${renderRows(conversations, [
      { label: "Customer", render: (row) => chatParticipant(row.customer || row.participant_a) },
      { label: "Reference / Reason", render: (row) => `<strong>${escapeHtml(row.ticketRef || compactId(row.id))}</strong><br><small>${escapeHtml(String(row.escalationReason || "-").slice(0, 140))}</small>` },
      { label: "Waiting", render: (row) => `<strong>${escapeHtml(monitorAge(row.waitingSeconds || 0))}</strong><br><small>${escapeHtml(row.createdAt ? new Date(row.createdAt).toLocaleString("en-ZA") : "-")}</small>` },
      { label: "Last Message", render: (row) => `<small>${escapeHtml(String(row.last_message || "No messages yet").slice(0, 140))}</small>` },
      { label: "Assigned", render: (row) => escapeHtml(assignedTo(row)) },
      { label: "Status", render: (row) => `<span class="chip ${chipClass(row.status)}">${escapeHtml(row.status || "WAITING_FOR_AGENT")}</span>` },
    ], (row) => `
      <button data-support-chat-history="${row.id}">History</button>
      <button data-support-chat-note="${row.id}">Add note</button>
      ${["ESCALATED", "WAITING_FOR_AGENT"].includes(row.status) ? `<button data-support-chat-takeover="${row.id}">TAKE OVER CHAT</button>` : ""}
      ${["AGENT_ACTIVE", "REOPENED"].includes(row.status) ? `<button data-support-chat-reply="${row.id}">Reply</button><button data-support-chat-resolve="${row.id}">Resolve</button><button data-support-chat-unassign="${row.id}">Release</button><button data-support-chat-transfer="${row.id}">Transfer</button>` : ""}
      ${row.status === "RESOLVED" ? `<button data-support-chat-reopen="${row.id}">Reopen</button><button data-support-chat-close="${row.id}">Close</button>` : ""}
      ${row.status === "CLOSED" ? `<button data-support-chat-reopen="${row.id}">Reopen</button>` : ""}
    `)}
      <h3 class="section-title">Profile Change Approvals</h3>
      ${renderRows(profileChanges, [
      { label: "User", render: (row) => `<strong>${escapeHtml(row.user?.fullName || row.user?.username || "-")}</strong><br><small>${escapeHtml(row.user?.phone || row.user?.email || "-")}</small>` },
      { label: "Requested Changes", render: (row) => Object.entries(row.requestedChanges || {}).map(([key, value]) => `<small><strong>${escapeHtml(key)}</strong>: ${escapeHtml(value)}</small>`).join("<br>") || "-" },
      { label: "Current", render: (row) => Object.entries(row.currentSnapshot || {}).filter(([key]) => ["fullName", "username", "email", "phone", "businessName"].includes(key)).map(([key, value]) => `<small><strong>${escapeHtml(key)}</strong>: ${escapeHtml(value || "-")}</small>`).join("<br>") || "-" },
      { label: "SLA", render: (row) => `<strong>${escapeHtml(row.dueAt ? new Date(row.dueAt).toLocaleString("en-ZA") : "-")}</strong><br><small>${row.dueAt && new Date(row.dueAt).getTime() < Date.now() && ["pending", "in_review"].includes(row.status) ? "Overdue" : "72-hour review"}</small>` },
      { label: "Status", render: (row) => `<span class="chip ${chipClass(row.status)}">${escapeHtml(row.status || "pending")}</span>` },
    ], (row) => ["pending", "in_review"].includes(row.status) ? `
      <button data-profile-change-approve="${escapeHtml(row.id)}">Approve</button>
      <button data-profile-change-reject="${escapeHtml(row.id)}">Reject</button>
    ` : "")}
      <section id="support-context-host"></section>
    `
  );
}

function renderSupportContext(context = {}) {
  return tableCard("Conversation History", `
    ${context.conversation ? `
      <section class="panel">
        <h3>${escapeHtml(context.conversation.customer?.name || "Customer")}</h3>
        <p><strong>Status:</strong> ${escapeHtml(context.conversation.status)} · <strong>Assigned:</strong> ${escapeHtml(context.conversation.assignedAgent?.name || "Unassigned")}</p>
        <form id="support-agent-reply-form" data-support-conversation-id="${escapeHtml(context.conversation.id)}">
          <label for="support-agent-message">Reply to customer</label>
          <textarea id="support-agent-message" name="message" rows="3" maxlength="4000" required></textarea>
          <button type="submit">Send reply</button>
        </form>
      </section>
    ` : ""}
    <section class="panel-grid support-grid">
      ${tableCard("Live Chat History", renderRows(context.messages || [], [
        { label: "Sender", render: (row) => `<strong>${escapeHtml(row.sender_name || row.sender_username || "-")}</strong><br><small>${escapeHtml(row.sender_username || "-")}</small>` },
        { label: "Message", render: (row) => `<small>${escapeHtml(String(row.body || "").slice(0, 180))}</small>` },
        { label: "Status", render: (row) => `<span class="chip ${chipClass(row.status)}">${escapeHtml(row.status || "-")}</span>` },
        { label: "Sent", render: (row) => escapeHtml(row.created_at ? new Date(row.created_at).toLocaleString("en-ZA") : "-") },
      ], () => ""), "Conversation content is shown only to authorized support staff for resolution and audit context.")}
      ${tableCard("Voice Call History", renderRows(context.calls || [], [
        { label: "Call", render: (row) => `<strong>${escapeHtml(row.call_type || "voice")}</strong><br><small>${escapeHtml(row.id ? compactId(row.id) : "-")}</small>` },
        { label: "Status", render: (row) => `<span class="chip ${chipClass(row.status)}">${escapeHtml(row.status || "-")}</span>` },
        { label: "Duration", render: (row) => `${escapeHtml(row.duration_seconds || 0)}s` },
        { label: "Started", render: (row) => escapeHtml(row.started_at ? new Date(row.started_at).toLocaleString("en-ZA") : "-") },
      ], () => ""), "Voice call signalling history is retained for diagnosis and escalation.")}
    </section>
    ${tableCard("Internal Notes", renderRows(context.internalNotes || [], [
      { label: "Admin", render: (row) => escapeHtml(row.createdByLabel || row.createdBy || "-") },
      { label: "Note", render: (row) => `<small>${escapeHtml(row.note || "-")}</small>` },
      { label: "Created", render: (row) => escapeHtml(row.createdAt ? new Date(row.createdAt).toLocaleString("en-ZA") : "-") },
    ], () => ""), "Internal notes are not exposed to TitoPay users.")}
  `);
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
  const otpPolicy = result.otpPolicy || {};
  const smtp = result.smtp || {};
  const templates = result.emailTemplates || [];
  const auth = getAuth();
  const isSuperAdmin = hasFullAdminAccess(me) || isPlatformOwnerRole(me?.role || auth?.user?.role || auth?.role);
  const selectedMode = otpPolicy.authenticationMode || (otpPolicy.otpRequired ? "password_email_otp" : "password_only");
  const authenticationModeControl = isSuperAdmin ? `
    <form id="authentication-mode-form" class="security-control-list">
      <label class="security-control-row">
        <span>
          <strong>Enable Email OTP</strong>
          <small>Off by default. Staff sign in with email or username and password only until this is enabled.</small>
        </span>
        <input type="checkbox" name="emailOtpEnabled" ${selectedMode === "password_email_otp" ? "checked" : ""}>
      </label>
      <button class="primary-btn" type="submit">Save Security Setting</button>
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
      ${tableCard("Authentication Mode", `
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
  document.getElementById("authentication-mode-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const mode = formData.get("emailOtpEnabled") === "on" ? "password_email_otp" : "password_only";
    try {
      await apiFetch("/admin/security/authentication-mode", {
        method: "PUT",
        body: JSON.stringify({ mode }),
      });
      showToast("Authentication mode updated");
      await renderSecurity();
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

async function renderRbacPermissions() {
  const roles = await apiFetch("/admin/roles");
  const rows = Object.entries(roles.roles || {}).map(([role, permissions]) => ({
    role,
    access: permissions.includes("*") ? "Full platform access" : "Limited by listed permissions",
    permissions
  }));
  PAGE_EXPORTS["rbac-permissions"] = rows;
  document.getElementById("page-content").innerHTML = `
    <section class="panel">
      <h3>RBAC / Permissions</h3>
      <p>Owner, Root, CEO and Super Admin have full access. Operational roles are limited to the exact permissions below.</p>
    </section>
    ${tableCard("Role Permission Matrix", renderRows(rows, [
      { label: "Role", render: (row) => `<strong>${escapeHtml(row.role)}</strong>` },
      { label: "Access", render: (row) => `<span class="chip ${row.permissions.includes("*") ? "green" : "blue"}">${escapeHtml(row.access)}</span>` },
      { label: "Permissions", render: (row) => escapeHtml(row.permissions.join(", ")) },
    ], () => ""))}
  `;
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
              <td>${escapeHtml(campaign.audience)}</td>
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
  const [smsState, reviewState] = await Promise.all([
    apiFetch("/admin/marketing/sms-campaigns"),
    apiFetch("/admin/marketing/reviews")
  ]);
  const rows = smsState.campaigns || [];
  const reviews = reviewState.reviews || [];
  const reviewSummary = reviewState.summary || {};
  PAGE_EXPORTS.marketing = [...rows, ...reviews];
  PAGE_EXPORTS.marketingSmsCampaigns = rows;
  PAGE_EXPORTS.marketingReviews = reviews;
  PAGE_EXPORTS.marketingQrAssets = PAGE_EXPORTS.marketingQrAssets || [];
  const canApprove = Boolean(smsState.canApprove || canApproveMarketingSms(me.role));
  const audiences = smsState.audiences || { personal: 0, business: 0, both: 0 };
  content.innerHTML = `
    <section class="panel-grid">
      <section class="panel">
        <h3>Marketing Centre</h3>
        <p>Create campaign links, referral links, landing page links, QR campaigns and controlled SMS broadcasts. Bulk SMS messages require CEO or COO approval before anything is sent.</p>
        <div class="ops-list ops-list-two">
          <span><strong>${escapeHtml(audiences.personal || 0)}</strong>Personal SMS recipients</span>
          <span><strong>${escapeHtml(audiences.business || 0)}</strong>Business SMS recipients</span>
          <span><strong>CEO / COO</strong>Approval required</span>
          <span><strong>Audit</strong>Every action logged</span>
          <span><strong>${escapeHtml(reviewSummary.total || 0)}</strong>PWA reviews</span>
          <span><strong>${escapeHtml(reviewSummary.averageRating || 0)}/5</strong>Average rating</span>
        </div>
      </section>
      <section class="panel">
        <h3>Bulk SMS Broadcast</h3>
        <form id="marketing-sms-form" class="form-grid">
          <div class="field"><label>Audience</label><select name="audience" required><option value="personal">Personal users only</option><option value="business">Business users only</option><option value="both">Personal and Business users</option></select></div>
          <div class="field"><label>Campaign Title</label><input name="title" placeholder="Holiday security notice" maxlength="120" required></div>
          <div class="field field-full"><label>SMS Message</label><textarea name="message" rows="5" maxlength="612" placeholder="Write the message exactly as customers should receive it." required></textarea></div>
          <button class="primary-btn" type="submit">Submit for CEO/COO Approval</button>
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
    ${tableCard("PWA Reviews - Help us improve", renderPwaReviews(reviews), "Reviews submitted from the TitoPay PWA Profile page. Contact details are only shown where the user gave permission.")}
    ${tableCard("SMS Approval Queue", renderMarketingSmsCampaigns(rows, canApprove), "Marketing and Communications can draft SMS messages. CEO or COO approval sends the message to existing TitoPay phone numbers for the selected audience.")}
  `;
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
        }),
      });
      showToast("SMS campaign submitted for CEO/COO approval");
      await renderMarketing(PAGE_EXPORTS.currentMe || {});
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  });
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

function adminPageDescriptors() {
  return {
    dashboard: ["Infrastructure Dashboard", "Operational overview for the TitoPay API and admin platform."],
    users: ["User Management", "View, suspend, lock and unlock customer accounts."],
    merchants: ["Merchant Management", "Verify and monitor business merchants and payment channels."],
    transactions: ["Transaction Monitoring", "Search, review and reverse transaction activity when required."],
    wallets: ["Wallet Monitoring", "Inspect personal, business, system and revenue wallet balances."],
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
  };
}

function adminPageLoaders() {
  return {
    dashboard: renderDashboard,
    users: renderUsers,
    merchants: renderMerchants,
    transactions: renderTransactions,
    wallets: renderWallets,
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
  await loaders[page](me);
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
      const context = await apiFetch(`/admin/support/conversations/${supportReplyForm.dataset.supportConversationId}/context`);
      const host = document.getElementById("support-context-host");
      if (host) host.innerHTML = renderSupportContext(context);
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
  const windowRefresh = event.target.closest("[data-window-refresh]");
  if (windowRefresh) {
    event.preventDefault();
    window.location.reload();
    return;
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
        const detailHost = document.getElementById("search-detail-host");
        if (detailHost) detailHost.innerHTML = renderSearchDetail("user", refreshedUser.id);
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
  const searchDetail = event.target.closest("[data-search-detail]");
  if (searchDetail) {
    const host = document.getElementById("search-detail-host");
    if (host) {
      host.innerHTML = renderSearchDetail(searchDetail.dataset.searchDetail, searchDetail.dataset.searchId);
      host.scrollIntoView({ block: "start" });
    }
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
      await renderSupport();
      const context = await apiFetch(`/admin/support/conversations/${id}/context`);
      const host = document.getElementById("support-context-host");
      if (host) host.innerHTML = renderSupportContext(context);
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  }
  const supportChatHistory = event.target.closest("[data-support-chat-history]");
  if (supportChatHistory) {
    try {
      const context = await apiFetch(`/admin/support/conversations/${supportChatHistory.dataset.supportChatHistory}/context`);
      const host = document.getElementById("support-context-host");
      if (host) {
        host.innerHTML = renderSupportContext(context);
        host.scrollIntoView({ block: "start" });
      }
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
  }
  const supportChatReply = event.target.closest("[data-support-chat-reply]");
  if (supportChatReply) {
    try {
      const context = await apiFetch(`/admin/support/conversations/${supportChatReply.dataset.supportChatReply}/context`);
      const host = document.getElementById("support-context-host");
      if (host) {
        host.innerHTML = renderSupportContext(context);
        host.scrollIntoView({ block: "start" });
        host.querySelector("#support-agent-message")?.focus();
      }
    } catch (error) {
      showToast(adminErrorMessage(error.message));
    }
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
        const context = await apiFetch(`/admin/support/conversations/${supportChatNote.dataset.supportChatNote}/context`);
        const host = document.getElementById("support-context-host");
        if (host) host.innerHTML = renderSupportContext(context);
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
    bootPage();
  }
});
