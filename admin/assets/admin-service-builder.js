/* ==========================================================================
   TitoPay Admin — Low-Code Service Builder
   --------------------------------------------------------------------------
   Loaded on demand, exactly like the analytics module: admin.js imports this
   file only when an operator opens Service Builder, so every other console
   page keeps the payload it had before this module existed.

   What this is
     A configuration-driven builder for TitoPay service definitions: a ten-step
     wizard, a draft/publish lifecycle, version history with rollback, an
     append-only audit trail, per-service usage analytics derived from live
     transactions, and JSON export in the exact schema the platform's service
     catalogue already uses (service_code, service_name, fee, commission,
     personal_visible, business_visible, sort_order, status, ...).

   What this is not
     A code editor. No field in this module is ever executed: every value is a
     string, number, boolean or list rendered through escapeHtml. There is no
     eval, no Function, no dynamic script, no HTML passthrough. Uploaded images
     are validated by type and size, and SVGs are rejected if they carry
     script, event-handler or javascript: content.

   Persistence
     On load the module asks the API for GET /admin/service-builder/services.
     If it answers, the API is the source of truth and every change is POSTed
     back. If it does not exist yet (the current state), definitions live in
     this console's local registry, the page says so plainly, and Export JSON
     is the handoff to the API's catalogue. Nothing pretends to be deployed:
     publishing marks a definition Active in this registry, and the runtime
     rollout note states what remains server-side.
   ========================================================================== */

/*
 * Low-Code Service Builder — how this file is laid out
 *
 * An ES module, imported by admin.js only when an operator opens this page.
 * Function declarations are hoisted to the top of the module scope, so their
 * position here has no effect on behaviour and the sections below can be
 * reordered freely.
 *
 * Anything that is NOT a function declaration — the module state, the
 * constants, the lookup tables and the exported entry point — is
 * order-sensitive. Those statements live in the two banner-marked blocks at the
 * top and the bottom, in their original order. Add new constants to the top
 * block; put new functions in whichever section below they belong to.
 *
 * Entry point: renderServiceBuilder(me, host)
 *
 * Contents
 *
 *    1. Small helpers and identity           9 functions
 *    2. Service definitions and the registry   7 functions
 *    3. Validation and safety                5 functions
 *    4. Export in the catalogue schema       2 functions
 *    5. Usage analytics                      2 functions
 *    6. Shared UI pieces                    11 functions
 *    7. The service list                     2 functions
 *    8. The ten-step wizard                  4 functions
 *    9. The detail view and the draft/publish lifecycle   4 functions
 *   10. Painting and event wiring            3 functions
 *   11. Access control                       1 functions
 */
/* ==========================================================================
   MODULE STATE, THE WIZARD STEPS AND THE PICKLISTS — order matters here; do not reorder
   ========================================================================== */

let HOST = null;
let bound = false;
const REGISTRY_KEY = "titopay_admin_service_builder_v1";
const SB_API_BASE = "/admin/service-builder/services";
const IMAGE_MAX_BYTES = 400 * 1024;
const IMAGE_TYPES = { "image/png": "PNG", "image/jpeg": "JPG", "image/svg+xml": "SVG", "image/webp": "WEBP" };
const CATEGORIES = ["Payments", "Transfers", "Vouchers & VAS", "Bills & Utilities", "Financial Services", "Community", "Business Tools", "Other"];
const MENU_POSITIONS = ["Services grid", "Home quick actions", "Payments menu", "More menu"];
const AUDIENCES = [
  ["personal", "Personal users"],
  ["business", "Business users"],
  ["verified", "Verified (FICA) users only"],
  ["merchants", "Merchants"],
  ["admin", "Admin only (internal)"],
];
const COUNTRIES = ["South Africa", "Namibia", "Botswana", "Lesotho", "Eswatini", "Zimbabwe", "Mozambique"];
const PROVINCES = ["Eastern Cape", "Free State", "Gauteng", "KwaZulu-Natal", "Limpopo", "Mpumalanga", "North West", "Northern Cape", "Western Cape"];
const AUTH_TYPES = ["Wallet session (Bearer)", "Admin session (Bearer)", "None (public endpoint)"];
const STEPS = [
  ["basics", "Basic information"],
  ["branding", "Branding"],
  ["navigation", "Navigation"],
  ["permissions", "Permissions"],
  ["availability", "Availability"],
  ["api", "API configuration"],
  ["ui", "UI configuration"],
  ["fees", "Fees"],
  ["notifications", "Notifications"],
  ["review", "Review & publish"],
];
const state = {
  services: [],
  storageMode: "local", // "api" once GET /admin/service-builder/services answers
  view: "list",         // list | wizard | detail
  draft: null,
  editingId: null,
  step: 0,
  stepErrors: {},
  detailId: null,
  detailTab: "overview",
  usage: null,          // transactions snapshot for analytics
  confirm: null,        // { title, body, verb, expect, onConfirm }
  me: null,
};
/* == Utilities ============================================================ */

const esc = (value) => HOST.escapeHtml(String(value ?? ""));
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
/* == Rendering: shared pieces ============================================= */

const STATUS_CHIP = { draft: "blue", active: "green", disabled: "orange", archived: "" };
/* == Field plumbing ======================================================= */

const LIST_FIELDS = {
  tagsText: (service, value) => { service.tags = splitList(value); },
  "navigation.keywordsText": (service, value) => { service.navigation.keywords = splitList(value); },
  "permissions.rolesText": (service, value) => { service.permissions.roles = splitList(value); },
  "api.requiredParamsText": (service, value) => { service.api.requiredParams = splitList(value); },
  "api.optionalParamsText": (service, value) => { service.api.optionalParams = splitList(value); },
};
/* == Access =============================================================== */

const SB_PERMISSIONS = ["service_builder", "services", "platform", "SERVICE_BUILDER", "SERVICES_MANAGE"];

/* ==========================================================================
   1. SMALL HELPERS AND IDENTITY
   ========================================================================== */

function nowIso() {
  return new Date().toISOString();
}
function formatWhen(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("en-ZA", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
function operatorName() {
  const me = state.me || {};
  return me.fullName || me.full_name || me.username || "Operator";
}
function operatorRole() {
  return HOST.normalizeAdminRole ? HOST.normalizeAdminRole(state.me?.role) : String(state.me?.role || "admin");
}
function slugify(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
}
function newServiceId(name) {
  return `svc_${slugify(name) || "service"}_${Date.now().toString(36)}`;
}
function serviceCodeFor(service) {
  return (service.code || slugify(service.name)).toUpperCase();
}
function bumpVersion(version, part = "patch") {
  const parts = String(version || "1.0.0").split(".").map((piece) => Number(piece) || 0);
  while (parts.length < 3) parts.push(0);
  if (part === "minor") { parts[1] += 1; parts[2] = 0; } else parts[2] += 1;
  return parts.join(".");
}
function splitList(value) {
  return String(value || "").split(",").map((piece) => piece.trim()).filter(Boolean).slice(0, 30);
}

/* ==========================================================================
   2. SERVICE DEFINITIONS AND THE REGISTRY
   ========================================================================== */

// Where a definition lives: the API when it answers, this console's local registry when it does not.

/* == Registry ============================================================= */

function blankService(name = "") {
  return {
    sbVersion: 1,
    id: newServiceId(name),
    name,
    code: "",
    description: "",
    category: CATEGORIES[0],
    tags: [],
    version: "1.0.0",
    status: "draft", // draft | active | disabled | archived
    visibility: "both",
    branding: { icon: null, banner: null, thumbnail: null, feature: null },
    navigation: { menuPosition: MENU_POSITIONS[0], displayOrder: 100, homeTile: false, featured: false, keywords: [] },
    permissions: { audiences: ["personal", "business"], roles: [] },
    availability: { enabled: true, maintenance: false, launchDate: "", endDate: "", countries: ["South Africa"], provinces: [] },
    api: { endpoint: "", method: "GET", authType: AUTH_TYPES[0], requiredParams: [], optionalParams: [], timeoutSeconds: 15, retries: 1, lastTest: null },
    ui: { tileColour: "#1b62d6", buttonLabel: "Continue", successMessage: "Done. Your request was completed.", errorMessage: "Something went wrong. Please try again.", emptyState: "Nothing here yet." },
    fees: { fixed: "", percent: "", min: "", max: "" },
    notifications: { push: true, emailTemplate: "", smsTemplate: "", successMessage: "", failureMessage: "" },
    meta: { createdAt: nowIso(), createdBy: "", updatedAt: nowIso(), updatedBy: "", publishedAt: "", publishedBy: "" },
    versions: [],
    audit: [],
  };
}
function readLocalRegistry() {
  try {
    const parsed = JSON.parse(localStorage.getItem(REGISTRY_KEY) || "{}");
    return Array.isArray(parsed.services) ? parsed.services : [];
  } catch {
    return [];
  }
}
function writeLocalRegistry() {
  try {
    localStorage.setItem(REGISTRY_KEY, JSON.stringify({ sbVersion: 1, services: state.services }));
  } catch {
    HOST.showToast("Unable to store the service registry in this browser (storage full?)");
  }
}
async function loadRegistry() {
  try {
    const result = await HOST.apiFetch(SB_API_BASE);
    if (Array.isArray(result.services) || Array.isArray(result.items)) {
      state.services = result.services || result.items;
      state.storageMode = "api";
      writeLocalRegistry(); // local mirror, so the console degrades gracefully
      return;
    }
  } catch {
    // The endpoint does not exist yet. Local mode, stated on the page.
  }
  state.services = readLocalRegistry();
  state.storageMode = "local";
}
async function persistService(service) {
  service.meta.updatedAt = nowIso();
  service.meta.updatedBy = operatorName();
  const index = state.services.findIndex((row) => row.id === service.id);
  if (index >= 0) state.services[index] = service;
  else state.services.unshift(service);
  writeLocalRegistry();
  if (state.storageMode === "api") {
    try {
      await HOST.apiFetch(SB_API_BASE, { method: "POST", body: JSON.stringify({ service }) });
    } catch {
      HOST.showToast("Saved locally; the API did not accept the update");
    }
  }
}
/* == Actions ============================================================== */

function findService(id) {
  return state.services.find((row) => row.id === id);
}
/* Append-only within the builder. When the API endpoints arrive the entries
   are POSTed with the service, giving them server-side permanence; until then
   the trail lives with the definition and says so. The client cannot know its
   own public IP; the API's audit log records that side. */
function audit(service, action, detail = "") {
  service.audit.unshift({
    at: nowIso(),
    action,
    detail,
    user: operatorName(),
    role: operatorRole(),
    sessionId: state.me?.session?.id || "—",
    device: (navigator.userAgent.match(/\(([^)]+)\)/) || [])[1]?.split(";")[0]?.trim() || "browser",
  });
  if (service.audit.length > 300) service.audit.length = 300;
}

/* ==========================================================================
   3. VALIDATION AND SAFETY
   ========================================================================== */

// No field in this module is ever executed. Endpoints are allow-listed and uploaded SVGs are rejected if they carry script.

/* == Validation =========================================================== */

function validateStep(service, stepKey) {
  const errors = [];
  if (stepKey === "basics") {
    if (!service.name.trim()) errors.push("Service name is required.");
    if (service.name.length > 60) errors.push("Service name must be 60 characters or fewer.");
    if (!service.description.trim()) errors.push("Description is required.");
    if (!/^\d+\.\d+\.\d+$/.test(service.version)) errors.push("Version must look like 1.0.0.");
  }
  if (stepKey === "api" && service.api.endpoint) {
    if (!isAllowedEndpoint(service.api.endpoint)) errors.push("Endpoint must be a path on the TitoPay API (start with / or https://api.titopay.co.za). Other hosts are refused — and the console's security policy blocks them anyway.");
    const timeout = num(service.api.timeoutSeconds);
    if (timeout < 1 || timeout > 60) errors.push("Timeout must be between 1 and 60 seconds.");
    const retries = num(service.api.retries);
    if (retries < 0 || retries > 5) errors.push("Retries must be between 0 and 5.");
  }
  if (stepKey === "fees") {
    const { fixed, percent, min, max } = service.fees;
    [["Fixed fee", fixed], ["Percentage fee", percent], ["Minimum fee", min], ["Maximum fee", max]].forEach(([label, value]) => {
      if (value !== "" && (!Number.isFinite(Number(value)) || Number(value) < 0)) errors.push(`${label} must be a number of zero or more.`);
    });
    if (percent !== "" && Number(percent) > 100) errors.push("Percentage fee cannot exceed 100%.");
    if (min !== "" && max !== "" && Number(max) < Number(min)) errors.push("Maximum fee cannot be below the minimum fee.");
  }
  if (stepKey === "availability") {
    const { launchDate, endDate } = service.availability;
    if (launchDate && endDate && endDate < launchDate) errors.push("End date cannot be before the launch date.");
    if (!service.availability.countries.length) errors.push("Select at least one country.");
  }
  if (stepKey === "permissions" && !service.permissions.audiences.length) {
    errors.push("Select at least one audience.");
  }
  return errors;
}
function validateForPublish(service) {
  const all = [];
  ["basics", "permissions", "availability", "api", "fees"].forEach((stepKey) => {
    validateStep(service, stepKey).forEach((error) => all.push(error));
  });
  return all;
}
function isAllowedEndpoint(value) {
  const text = String(value || "").trim();
  if (text.startsWith("/")) return !/\s/.test(text);
  try {
    return new URL(text).origin === "https://api.titopay.co.za";
  } catch {
    return false;
  }
}
/* == Image intake ========================================================= */

function validateSvgText(text) {
  return !/<script|\bon\w+\s*=|javascript:/i.test(text);
}
function intakeImage(file, onDone) {
  if (!IMAGE_TYPES[file.type]) {
    HOST.showToast(`Unsupported image type. Use ${Object.values(IMAGE_TYPES).join(", ")}.`);
    return;
  }
  if (file.size > IMAGE_MAX_BYTES) {
    HOST.showToast(`Image is too large (${Math.round(file.size / 1024)}KB). The limit is ${IMAGE_MAX_BYTES / 1024}KB.`);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const dataUri = String(reader.result || "");
    if (file.type === "image/svg+xml") {
      try {
        const svgText = atob(dataUri.split(",")[1] || "");
        if (!validateSvgText(svgText)) {
          HOST.showToast("SVG rejected: it contains script or event-handler content.");
          return;
        }
      } catch {
        HOST.showToast("SVG could not be read.");
        return;
      }
    }
    onDone({ dataUri, name: file.name, size: file.size, type: file.type });
  };
  reader.readAsDataURL(file);
}

/* ==========================================================================
   4. EXPORT IN THE CATALOGUE SCHEMA
   ========================================================================== */

/* == Catalogue export ===================================================== */

/* The exact shape services-default.json and the platform catalogue use. */
function catalogueEntry(service) {
  return {
    service_code: serviceCodeFor(service),
    service_name: service.name,
    description: service.description,
    service_icon: service.branding.icon?.dataUri || "",
    fee: service.fees.fixed === "" ? 0 : Number(service.fees.fixed),
    commission: service.fees.percent === "" ? 0 : Number(service.fees.percent),
    status: service.status === "active" ? "active" : "inactive",
    personal_visible: service.visibility !== "business",
    business_visible: service.visibility !== "personal",
    sort_order: num(service.navigation.displayOrder),
    feature_badge: service.navigation.featured ? "featured" : "",
    action: service.api.endpoint || "",
  };
}
function downloadJson(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/* ==========================================================================
   5. USAGE ANALYTICS
   ========================================================================== */

// Derived from live transactions, not from anything the builder stores.

/* == Usage analytics ====================================================== */

async function loadUsage() {
  if (state.usage) return state.usage;
  try {
    const result = await HOST.apiFetch("/admin/transactions?limit=1000");
    state.usage = result.items || [];
  } catch {
    state.usage = [];
  }
  return state.usage;
}
function usageFor(service, rows) {
  const code = serviceCodeFor(service);
  const matched = rows.filter((row) => String(row.service_code || "").toUpperCase() === code);
  const success = matched.filter((row) => ["completed", "success", "settled"].includes(String(row.status || "").toLowerCase()));
  const failed = matched.filter((row) => ["failed", "declined", "rejected", "error"].includes(String(row.status || "").toLowerCase()));
  const dayMs = 86400000;
  const now = Date.now();
  const inWindow = (days) => matched.filter((row) => {
    const time = Date.parse(row.created_at || "");
    return Number.isFinite(time) && now - time <= days * dayMs;
  }).length;
  return {
    total: matched.length,
    success: success.length,
    failed: failed.length,
    daily: inWindow(1),
    weekly: inWindow(7),
    monthly: inWindow(30),
    revenue: matched.reduce((sum, row) => sum + num(row.revenue_recorded ?? row.fee), 0),
  };
}

/* ==========================================================================
   6. SHARED UI PIECES
   ========================================================================== */

function statusChip(status) {
  return `<span class="chip ${STATUS_CHIP[status] || ""}">${esc(status)}</span>`;
}
function storageBanner() {
  if (state.storageMode === "api") {
    return `<p class="sb-storage-note">Definitions are stored by the TitoPay API (<code>${esc(SB_API_BASE)}</code>). Every change is written back to it.</p>`;
  }
  return `
    <div class="sb-storage-banner">
      <strong>Definitions are stored in this console.</strong>
      <span>The API does not expose <code>${esc(SB_API_BASE)}</code> yet, so drafts and published definitions live in this browser's registry and can be exported as JSON — the export uses the platform's existing service-catalogue schema, ready for the API team to load. The builder switches to API storage automatically the moment the endpoint exists.</span>
    </div>
  `;
}
function brandingThumb(image, label) {
  if (!image?.dataUri) return `<span class="sb-thumb sb-thumb-empty">${esc(label)}</span>`;
  return `<img class="sb-thumb" src="${esc(image.dataUri)}" alt="${esc(label)}">`;
}
/* == Wizard =============================================================== */

function fieldRow(label, control, hint = "") {
  return `<div class="field"><label>${esc(label)}</label>${control}${hint ? `<p class="field-hint">${esc(hint)}</p>` : ""}</div>`;
}
function textInput(path, value, options = {}) {
  return `<input data-sb-field="${esc(path)}" type="${esc(options.type || "text")}" value="${esc(value ?? "")}"${options.placeholder ? ` placeholder="${esc(options.placeholder)}"` : ""}${options.required ? " required" : ""}${options.maxlength ? ` maxlength="${options.maxlength}"` : ""}>`;
}
function selectInput(path, value, choices) {
  return `<select data-sb-field="${esc(path)}">${choices.map((choice) => `<option value="${esc(choice)}"${choice === value ? " selected" : ""}>${esc(choice)}</option>`).join("")}</select>`;
}
function toggleInput(path, checked, label) {
  return `<label class="toggle-row"><input type="checkbox" data-sb-field="${esc(path)}"${checked ? " checked" : ""}> ${esc(label)}</label>`;
}
function checklist(path, selected, choices) {
  return `<div class="sb-checklist">${choices.map(([value, label]) => `
    <label class="check-row"><input type="checkbox" data-sb-multi="${esc(path)}" value="${esc(value)}"${selected.includes(value) ? " checked" : ""}> ${esc(label)}</label>
  `).join("")}</div>`;
}
function dropzone(slot, image, label) {
  return `
    <div class="sb-dropzone" data-sb-dropzone="${esc(slot)}">
      ${image?.dataUri
        ? `<img src="${esc(image.dataUri)}" alt="${esc(label)} preview"><span class="sb-dropzone-meta">${esc(image.name)} · ${Math.round(image.size / 1024)}KB</span><button class="link-btn" type="button" data-sb-clear-image="${esc(slot)}">Remove</button>`
        : `<span class="sb-dropzone-label">${esc(label)}</span><span class="sb-dropzone-meta">Drop an image or click to browse · PNG, JPG, SVG, WEBP · up to 400KB</span>`}
      <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" data-sb-file="${esc(slot)}" aria-label="Upload ${esc(label)}">
    </div>
  `;
}
/* == Confirmation dialog ==================================================
   Publishing, disabling, archiving and deleting go through a typed
   confirmation. Admin sign-in MFA (Security -> Authentication Mode) governs
   session strength; this adds the deliberate-action check on top. */

function confirmDialogHtml() {
  const confirm = state.confirm;
  if (!confirm) return "";
  return `
    <div class="sb-confirm-scrim" data-sb-confirm-cancel></div>
    <div class="sb-confirm" role="dialog" aria-modal="true" aria-labelledby="sb-confirm-title">
      <h3 id="sb-confirm-title">${esc(confirm.title)}</h3>
      <p>${esc(confirm.body)}</p>
      ${confirm.expect ? `
        <div class="field">
          <label for="sb-confirm-input">Type <strong>${esc(confirm.expect)}</strong> to confirm</label>
          <input id="sb-confirm-input" autocomplete="off" spellcheck="false">
        </div>
      ` : ""}
      <div class="action-row sb-confirm-actions">
        <button class="secondary-btn" type="button" data-sb-confirm-cancel>Cancel</button>
        <button class="primary-btn${confirm.danger ? " sb-danger-btn" : ""}" type="button" data-sb-confirm-go${confirm.expect ? " disabled" : ""}>${esc(confirm.verb)}</button>
      </div>
    </div>
  `;
}
function openConfirm(confirm) {
  state.confirm = confirm;
  paint();
  document.getElementById("sb-confirm-input")?.focus();
}

/* ==========================================================================
   7. THE SERVICE LIST
   ========================================================================== */

/* == List view ============================================================ */

function renderList() {
  const services = state.services.filter((service) => service.status !== "archived");
  const archived = state.services.filter((service) => service.status === "archived");
  const active = services.filter((service) => service.status === "active");
  const drafts = services.filter((service) => service.status === "draft");
  const disabled = services.filter((service) => service.status === "disabled");
  const recentPublished = [...state.services].filter((s) => s.meta.publishedAt).sort((a, b) => b.meta.publishedAt.localeCompare(a.meta.publishedAt)).slice(0, 3);
  const recentUpdated = [...state.services].sort((a, b) => b.meta.updatedAt.localeCompare(a.meta.updatedAt)).slice(0, 3);
  const healthy = active.filter((service) => !service.availability.maintenance && (service.api.lastTest?.ok !== false)).length;

  HOST.PAGE_EXPORTS["service-builder"] = state.services.map((service) => ({
    id: service.id,
    code: serviceCodeFor(service),
    name: service.name,
    status: service.status,
    version: service.version,
    visibility: service.visibility,
    updated: service.meta.updatedAt,
    published: service.meta.publishedAt || "",
  }));

  return `
    ${storageBanner()}
    <section class="metrics-grid">
      <article class="metric-card"><span>Total Services</span><strong>${services.length + archived.length}</strong><small class="metric-meta">${archived.length} archived</small></article>
      <article class="metric-card"><span class="metric-indicator green"></span><span>Active</span><strong>${active.length}</strong><small class="metric-meta">Published and enabled</small></article>
      <article class="metric-card"><span>Drafts</span><strong>${drafts.length}</strong><small class="metric-meta">Not visible until published</small></article>
      <article class="metric-card"><span class="metric-indicator ${healthy === active.length ? "green" : "orange"}"></span><span>Service Health</span><strong>${active.length ? `${healthy}/${active.length}` : "—"}</strong><small class="metric-meta">Active, not in maintenance, last test passing</small></article>
    </section>
    <section class="panel-grid">
      ${HOST.tableCard("Recently published", recentPublished.length ? recentPublished.map((service) => `
        <div class="sb-recent-row">
          <strong>${esc(service.name)}</strong>
          <small>v${esc(service.version)} · ${esc(formatWhen(service.meta.publishedAt))} by ${esc(service.meta.publishedBy || "—")}</small>
        </div>
      `).join("") : `<div class="compact-empty">Nothing published yet.</div>`, "")}
      ${HOST.tableCard("Recently updated", recentUpdated.length ? recentUpdated.map((service) => `
        <div class="sb-recent-row">
          <strong>${esc(service.name)}</strong>
          <small>${esc(service.status)} · ${esc(formatWhen(service.meta.updatedAt))} by ${esc(service.meta.updatedBy || "—")}</small>
        </div>
      `).join("") : `<div class="compact-empty">No services yet.</div>`, "")}
    </section>
    <section class="table-card">
      <div class="table-card-header">
        <div>
          <h3>Services</h3>
          <p class="table-card-note">Every definition is configuration only — nothing here is executable code, and nothing is visible to customers until it is published and the API catalogue carries it.</p>
        </div>
        <div class="header-actions">
          <button class="secondary-btn" type="button" data-sb-import>Import JSON</button>
          <button class="primary-btn" type="button" data-sb-new>New service</button>
        </div>
      </div>
      ${services.length ? `
        <div class="sb-service-grid">
          ${services.map((service) => `
            <article class="sb-service-card" data-sb-open="${esc(service.id)}">
              <div class="sb-service-head">
                ${brandingThumb(service.branding.icon, "No icon")}
                <div class="sb-service-title">
                  <strong>${esc(service.name)}</strong>
                  <small>${esc(serviceCodeFor(service))} · v${esc(service.version)} · ${esc(service.category)}</small>
                </div>
                ${statusChip(service.status)}
              </div>
              <p class="sb-service-desc">${esc(service.description || "No description yet.")}</p>
              <div class="sb-service-foot">
                <small>${esc(service.visibility)} · updated ${esc(formatWhen(service.meta.updatedAt))}</small>
                <span class="action-row">
                  <button type="button" data-sb-edit="${esc(service.id)}">Edit</button>
                  <button type="button" data-sb-duplicate="${esc(service.id)}">Duplicate</button>
                  ${service.status === "active"
                    ? `<button type="button" data-sb-disable="${esc(service.id)}">Disable</button>`
                    : `<button type="button" data-sb-publish="${esc(service.id)}">Publish</button>`}
                </span>
              </div>
            </article>
          `).join("")}
        </div>
      ` : `<div class="empty"><strong>No services yet</strong><small>Create the first service with the wizard. It stays a draft — invisible to customers — until you publish it.</small></div>`}
      ${archived.length ? `<p class="table-card-note sb-archived-note">${archived.length} archived service${archived.length === 1 ? "" : "s"} — <button class="link-btn" type="button" data-sb-show-archived>view</button></p>` : ""}
    </section>
  `;
}
function renderArchivedList() {
  const archived = state.services.filter((service) => service.status === "archived");
  return `
    ${HOST.tableCard("Archived services", archived.length ? archived.map((service) => `
      <div class="sb-recent-row">
        <strong>${esc(service.name)}</strong>
        <small>archived · v${esc(service.version)}</small>
        <span class="action-row">
          <button type="button" data-sb-restore="${esc(service.id)}">Restore to draft</button>
          <button type="button" data-sb-delete="${esc(service.id)}">Delete permanently</button>
        </span>
      </div>
    `).join("") : `<div class="compact-empty">Nothing archived.</div>`, "Archived services are hidden everywhere and keep their history until deleted.")}
    <div class="action-row"><button class="secondary-btn" type="button" data-sb-back>Back to services</button></div>
  `;
}

/* ==========================================================================
   8. THE TEN-STEP WIZARD
   ========================================================================== */

function stepBody(service, stepKey) {
  if (stepKey === "basics") {
    return `
      <div class="form-grid">
        ${fieldRow("Service name", textInput("name", service.name, { required: true, maxlength: 60, placeholder: "Electricity vouchers" }))}
        ${fieldRow("Internal service ID", `<input value="${esc(service.id)}" readonly>`, "Auto-generated and stable across versions.")}
        ${fieldRow("Service code", textInput("code", service.code, { placeholder: serviceCodeFor(service) }), "Matches transaction service_code; leave blank to derive from the name.")}
        ${fieldRow("Category", selectInput("category", service.category, CATEGORIES))}
        ${fieldRow("Version", textInput("version", service.version, { placeholder: "1.0.0" }))}
        ${fieldRow("Visibility", selectInput("visibility", service.visibility, ["personal", "business", "both"]))}
        <div class="field field-full"><label>Description</label><textarea data-sb-field="description" required placeholder="What this service does, in one or two sentences.">${esc(service.description)}</textarea></div>
        ${fieldRow("Tags", textInput("tagsText", service.tags.join(", "), { placeholder: "electricity, prepaid, voucher" }), "Comma separated.")}
      </div>
    `;
  }
  if (stepKey === "branding") {
    return `
      <div class="sb-dropzone-grid">
        ${dropzone("icon", service.branding.icon, "Icon (square)")}
        ${dropzone("thumbnail", service.branding.thumbnail, "Thumbnail")}
        ${dropzone("banner", service.branding.banner, "Banner (wide)")}
        ${dropzone("feature", service.branding.feature, "Feature image")}
      </div>
      <p class="table-card-note">Images are validated by type and size before they are accepted. SVGs carrying script or event-handler content are rejected outright.</p>
    `;
  }
  if (stepKey === "navigation") {
    return `
      <div class="form-grid">
        ${fieldRow("Menu position", selectInput("navigation.menuPosition", service.navigation.menuPosition, MENU_POSITIONS))}
        ${fieldRow("Display order", textInput("navigation.displayOrder", service.navigation.displayOrder, { type: "number" }), "Lower numbers appear first.")}
        ${fieldRow("Search keywords", textInput("navigation.keywordsText", service.navigation.keywords.join(", "), { placeholder: "electricity, power, prepaid" }), "Comma separated.")}
        <div class="field">${toggleInput("navigation.homeTile", service.navigation.homeTile, "Show as a home screen tile")}</div>
        <div class="field">${toggleInput("navigation.featured", service.navigation.featured, "Featured service (carries the featured badge)")}</div>
      </div>
    `;
  }
  if (stepKey === "permissions") {
    return `
      ${checklist("permissions.audiences", service.permissions.audiences, AUDIENCES)}
      <div class="form-grid">
        ${fieldRow("Additional role restriction (optional)", textInput("permissions.rolesText", service.permissions.roles.join(", "), { placeholder: "finance, compliance" }), "Comma-separated role names. Leave blank for no extra restriction. Enforcement happens in the API's RBAC when the definition is loaded — this console changes no access rules itself.")}
      </div>
    `;
  }
  if (stepKey === "availability") {
    return `
      <div class="form-grid">
        <div class="field">${toggleInput("availability.enabled", service.availability.enabled, "Enabled")}</div>
        <div class="field">${toggleInput("availability.maintenance", service.availability.maintenance, "Maintenance mode (visible but not usable)")}</div>
        ${fieldRow("Launch date", textInput("availability.launchDate", service.availability.launchDate, { type: "date" }), "Leave blank to launch on publish.")}
        ${fieldRow("End date", textInput("availability.endDate", service.availability.endDate, { type: "date" }), "Leave blank for no end date.")}
      </div>
      <h4 class="sb-subhead">Countries</h4>
      ${checklist("availability.countries", service.availability.countries, COUNTRIES.map((country) => [country, country]))}
      <h4 class="sb-subhead">Provinces (future ready — applies when the API enforces province availability)</h4>
      ${checklist("availability.provinces", service.availability.provinces, PROVINCES.map((province) => [province, province]))}
    `;
  }
  if (stepKey === "api") {
    const test = service.api.lastTest;
    return `
      <div class="form-grid">
        <div class="field field-full"><label>API endpoint</label><input data-sb-field="api.endpoint" value="${esc(service.api.endpoint)}" placeholder="/v1/vas/electricity or https://api.titopay.co.za/v1/...">
          <p class="field-hint">Existing TitoPay API endpoints only. Other hosts are refused, and the console's security policy blocks them at browser level.</p>
        </div>
        ${fieldRow("HTTP method", selectInput("api.method", service.api.method, ["GET", "POST", "PUT", "PATCH", "DELETE"]))}
        ${fieldRow("Authentication", selectInput("api.authType", service.api.authType, AUTH_TYPES))}
        ${fieldRow("Timeout (seconds)", textInput("api.timeoutSeconds", service.api.timeoutSeconds, { type: "number" }))}
        ${fieldRow("Retries", textInput("api.retries", service.api.retries, { type: "number" }), "0 to 5.")}
        ${fieldRow("Required parameters", textInput("api.requiredParamsText", service.api.requiredParams.join(", "), { placeholder: "meterNumber, amount" }), "Comma separated.")}
        ${fieldRow("Optional parameters", textInput("api.optionalParamsText", service.api.optionalParams.join(", "), { placeholder: "reference" }), "Comma separated.")}
      </div>
      <div class="action-row sb-test-row">
        <button class="secondary-btn" type="button" data-sb-test-connection>Test connection</button>
        <span class="sb-test-result" id="sb-test-result">${test ? `${test.ok ? "Reachable" : "Unreachable"} · HTTP ${test.status ?? "—"} · ${test.ms}ms · ${esc(formatWhen(test.at))}` : "Not tested yet"}</span>
      </div>
      <p class="table-card-note">Test connection sends one safe GET request with your admin session and reports status and latency. It never sends a body, never retries, and never changes anything — a 405 still proves the endpoint is reachable.</p>
    `;
  }
  if (stepKey === "ui") {
    return `
      <div class="sb-ui-grid">
        <div class="form-grid">
          ${fieldRow("Tile colour", `<input type="color" data-sb-field="ui.tileColour" value="${esc(service.ui.tileColour)}">`)}
          ${fieldRow("Button label", textInput("ui.buttonLabel", service.ui.buttonLabel, { maxlength: 24 }))}
          ${fieldRow("Success message", textInput("ui.successMessage", service.ui.successMessage, { maxlength: 120 }))}
          ${fieldRow("Error message", textInput("ui.errorMessage", service.ui.errorMessage, { maxlength: 120 }))}
          ${fieldRow("Empty state", textInput("ui.emptyState", service.ui.emptyState, { maxlength: 120 }))}
        </div>
        <div class="sb-preview" aria-label="Live preview">
          <span class="sb-preview-caption">Live preview</span>
          <div class="sb-preview-tile" id="sb-preview-tile">
            ${service.branding.icon?.dataUri ? `<img src="${esc(service.branding.icon.dataUri)}" alt="">` : `<span class="sb-preview-glyph">${esc((service.name || "S").slice(0, 1).toUpperCase())}</span>`}
            <strong>${esc(service.name || "Service name")}</strong>
            <small>${esc(service.description.slice(0, 48) || "Description")}</small>
            <span class="sb-preview-btn" id="sb-preview-btn">${esc(service.ui.buttonLabel || "Continue")}</span>
          </div>
          <p class="sb-preview-note">How the tile reads in the customer apps. Rendering there follows the platform's own components.</p>
        </div>
      </div>
    `;
  }
  if (stepKey === "fees") {
    return `
      <div class="form-grid">
        ${fieldRow("Fixed fee (R)", textInput("fees.fixed", service.fees.fixed, { type: "number", placeholder: "0.00" }), "Leave blank for none.")}
        ${fieldRow("Percentage fee (%)", textInput("fees.percent", service.fees.percent, { type: "number", placeholder: "0" }))}
        ${fieldRow("Minimum fee (R)", textInput("fees.min", service.fees.min, { type: "number" }))}
        ${fieldRow("Maximum fee (R)", textInput("fees.max", service.fees.max, { type: "number" }))}
      </div>
      <p class="table-card-note">These values export into the catalogue's fee and commission fields, ready for the Pricing Engine. Live fee enforcement stays with the API.</p>
    `;
  }
  if (stepKey === "notifications") {
    return `
      <div class="form-grid">
        <div class="field">${toggleInput("notifications.push", service.notifications.push, "Send a push notification on completion")}</div>
        ${fieldRow("Success message", textInput("notifications.successMessage", service.notifications.successMessage, { maxlength: 160 }))}
        ${fieldRow("Failure message", textInput("notifications.failureMessage", service.notifications.failureMessage, { maxlength: 160 }))}
        <div class="field field-full"><label>Email template</label><textarea data-sb-field="notifications.emailTemplate" placeholder="Plain-text email body. Placeholders like {{amount}} are substituted by the API at send time — they are text here, never code.">${esc(service.notifications.emailTemplate)}</textarea></div>
        <div class="field field-full"><label>SMS template</label><textarea data-sb-field="notifications.smsTemplate" maxlength="320" placeholder="SMS body, 320 characters.">${esc(service.notifications.smsTemplate)}</textarea></div>
      </div>
    `;
  }
  if (stepKey === "review") {
    const problems = validateForPublish(service);
    return `
      ${problems.length ? `
        <div class="sb-problem-list">
          <strong>Fix before publishing</strong>
          <ul>${problems.map((problem) => `<li>${esc(problem)}</li>`).join("")}</ul>
        </div>
      ` : `<p class="sb-ready-note">This definition passes every check and is ready to publish.</p>`}
      ${HOST.renderKeyValueList([
        ["Service", `${service.name} (${serviceCodeFor(service)}) v${service.version}`],
        ["Status", service.status],
        ["Visibility", service.visibility],
        ["Audiences", service.permissions.audiences.join(", ") || "—"],
        ["Countries", service.availability.countries.join(", ")],
        ["Endpoint", service.api.endpoint || "Not configured"],
        ["Fees", service.fees.fixed === "" && service.fees.percent === "" ? "None" : `Fixed R${service.fees.fixed || 0} · ${service.fees.percent || 0}%`],
      ])}
      <p class="table-card-note">Publishing marks this definition Active in the registry, snapshots it into version history and writes the audit entry. Customers see it once the API's service catalogue carries the exported entry${state.storageMode === "api" ? "" : " — in local mode, hand the exported JSON to the API team"}.</p>
    `;
  }
  return "";
}
function renderWizard() {
  const service = state.draft;
  const [stepKey, stepTitle] = STEPS[state.step];
  const errors = state.stepErrors[stepKey] || [];
  return `
    <div class="sb-wizard">
      <aside class="sb-steps" aria-label="Wizard steps">
        ${STEPS.map(([key, title], index) => `
          <button type="button" class="sb-step${index === state.step ? " active" : ""}" data-sb-step="${index}">
            <span class="sb-step-number">${index + 1}</span>
            <span>${esc(title)}</span>
          </button>
        `).join("")}
      </aside>
      <section class="sb-wizard-body">
        <div class="sb-wizard-head">
          <div>
            <h3>${esc(stepTitle)}</h3>
            <p class="table-card-note">${esc(service.name || "New service")} · ${esc(service.status)} · v${esc(service.version)}</p>
          </div>
          <div class="header-actions">
            <button class="secondary-btn" type="button" data-sb-save-draft>Save draft</button>
            <button class="ghost-btn" type="button" data-sb-cancel>Close</button>
          </div>
        </div>
        ${errors.length ? `<div class="sb-problem-list"><ul>${errors.map((error) => `<li>${esc(error)}</li>`).join("")}</ul></div>` : ""}
        <div class="sb-step-body">${stepBody(service, stepKey)}</div>
        <div class="sb-wizard-foot">
          <button class="secondary-btn" type="button" data-sb-prev${state.step === 0 ? " disabled" : ""}>Back</button>
          <span class="sb-step-count">Step ${state.step + 1} of ${STEPS.length}</span>
          ${state.step === STEPS.length - 1
            ? `<button class="primary-btn" type="button" data-sb-publish-wizard>Publish service</button>`
            : `<button class="primary-btn" type="button" data-sb-next>Next</button>`}
        </div>
      </section>
    </div>
  `;
}
function applyField(service, path, value, checked) {
  if (LIST_FIELDS[path]) {
    LIST_FIELDS[path](service, value);
    return;
  }
  const segments = path.split(".");
  let target = service;
  while (segments.length > 1) target = target[segments.shift()];
  const leaf = segments[0];
  if (typeof target[leaf] === "boolean") target[leaf] = Boolean(checked);
  else if (typeof target[leaf] === "number") target[leaf] = Number(value) || 0;
  else target[leaf] = String(value);
}
function collectWizardFields() {
  const service = state.draft;
  if (!service) return;
  document.querySelectorAll("#service-builder-root [data-sb-field]").forEach((input) => {
    applyField(service, input.dataset.sbField, input.value, input.checked);
  });
  const multi = {};
  document.querySelectorAll("#service-builder-root [data-sb-multi]").forEach((input) => {
    const path = input.dataset.sbMulti;
    if (!multi[path]) multi[path] = [];
    if (input.checked) multi[path].push(input.value);
  });
  Object.entries(multi).forEach(([path, values]) => {
    const segments = path.split(".");
    let target = service;
    while (segments.length > 1) target = target[segments.shift()];
    target[segments[0]] = values;
  });
}

/* ==========================================================================
   9. THE DETAIL VIEW AND THE DRAFT/PUBLISH LIFECYCLE
   ========================================================================== */

/* == Detail view ========================================================== */

async function renderDetail() {
  const service = state.services.find((row) => row.id === state.detailId);
  if (!service) {
    state.view = "list";
    return renderList();
  }
  const tabs = [["overview", "Overview"], ["analytics", "Analytics"], ["versions", "Version history"], ["audit", "Audit trail"]];
  let body = "";

  if (state.detailTab === "overview") {
    body = `
      ${HOST.renderKeyValueList([
        ["Service", `${service.name} (${serviceCodeFor(service)})`],
        ["Status", service.status],
        ["Version", service.version],
        ["Category", service.category],
        ["Visibility", service.visibility],
        ["Audiences", service.permissions.audiences.join(", ") || "—"],
        ["Endpoint", service.api.endpoint || "Not configured"],
        ["Created", `${formatWhen(service.meta.createdAt)} by ${service.meta.createdBy || "—"}`],
        ["Last updated", `${formatWhen(service.meta.updatedAt)} by ${service.meta.updatedBy || "—"}`],
        ["Published", service.meta.publishedAt ? `${formatWhen(service.meta.publishedAt)} by ${service.meta.publishedBy || "—"}` : "Never"],
      ])}
      <div class="action-row sb-detail-actions">
        <button class="primary-btn" type="button" data-sb-edit="${esc(service.id)}">Edit</button>
        ${service.status === "active"
          ? `<button class="secondary-btn" type="button" data-sb-disable="${esc(service.id)}">Disable</button>`
          : `<button class="secondary-btn" type="button" data-sb-publish="${esc(service.id)}">Publish</button>`}
        <button class="secondary-btn" type="button" data-sb-duplicate="${esc(service.id)}">Duplicate</button>
        <button class="secondary-btn" type="button" data-sb-export="${esc(service.id)}">Export catalogue JSON</button>
        <button class="secondary-btn" type="button" data-sb-export-full="${esc(service.id)}">Export full definition</button>
        <button class="ghost-btn" type="button" data-sb-archive="${esc(service.id)}">Archive</button>
      </div>
    `;
  }

  if (state.detailTab === "analytics") {
    const rows = await loadUsage();
    const usage = usageFor(service, rows);
    body = `
      <section class="metrics-grid">
        <article class="metric-card"><span>Total Uses</span><strong>${usage.total}</strong><small class="metric-meta">Transactions carrying ${esc(serviceCodeFor(service))}</small></article>
        <article class="metric-card"><span class="metric-indicator green"></span><span>Successful</span><strong>${usage.success}</strong><small class="metric-meta">${usage.total ? Math.round((usage.success / usage.total) * 100) + "%" : "—"}</small></article>
        <article class="metric-card"><span class="metric-indicator ${usage.failed ? "red" : "green"}"></span><span>Failed</span><strong>${usage.failed}</strong><small class="metric-meta">Declined or errored</small></article>
        <article class="metric-card"><span>Revenue</span><strong>${esc(HOST.money(usage.revenue))}</strong><small class="metric-meta">Recorded platform revenue</small></article>
      </section>
      ${HOST.renderKeyValueList([
        ["Daily usage", `${usage.daily} in the last 24 hours`],
        ["Weekly usage", `${usage.weekly} in the last 7 days`],
        ["Monthly usage", `${usage.monthly} in the last 30 days`],
      ])}
      ${usage.total === 0 ? `<p class="table-card-note">No transactions carry the code <code>${esc(serviceCodeFor(service))}</code> yet. Counts appear here automatically once the platform processes transactions for this service — nothing on this tab is simulated.</p>` : ""}
    `;
  }

  if (state.detailTab === "versions") {
    body = service.versions.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Version</th><th>Published</th><th>By</th><th>Rollback</th></tr></thead>
        <tbody>
          ${service.versions.map((entry, index) => `
            <tr>
              <td><strong>v${esc(entry.version)}</strong></td>
              <td>${esc(formatWhen(entry.publishedAt))}</td>
              <td>${esc(entry.publishedBy || "—")}</td>
              <td><div class="action-row">${index === 0 ? `<span class="chip green">current</span>` : `<button type="button" data-sb-rollback="${esc(service.id)}:${index}">Roll back to this version</button>`}</div></td>
            </tr>
          `).join("")}
        </tbody>
      </table></div>
      <p class="table-card-note">Rolling back restores that version's full configuration as the working definition and publishes it as a new version — history is never rewritten.</p>
    ` : `<div class="empty"><strong>No published versions yet</strong><small>Each publish snapshots the full configuration here for rollback.</small></div>`;
  }

  if (state.detailTab === "audit") {
    body = service.audit.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>When</th><th>Action</th><th>Operator</th><th>Session</th><th>Detail</th></tr></thead>
        <tbody>
          ${service.audit.map((entry) => `
            <tr>
              <td>${esc(formatWhen(entry.at))}</td>
              <td><strong>${esc(entry.action)}</strong></td>
              <td>${esc(entry.user)}<br><small>${esc(entry.role)} · ${esc(entry.device)}</small></td>
              <td><small>${esc(entry.sessionId)}</small></td>
              <td><small>${esc(entry.detail || "—")}</small></td>
            </tr>
          `).join("")}
        </tbody>
      </table></div>
      <p class="table-card-note">Entries are append-only in the builder and are written to the API with the definition once the service-builder endpoints exist — server-side immutability and source IP recording live there. The API's own audit log independently records every request this console makes.</p>
    ` : `<div class="empty"><strong>No actions recorded yet</strong></div>`;
  }

  return `
    <div class="sb-detail-head">
      <div class="sb-service-head">
        ${brandingThumb(service.branding.icon, "No icon")}
        <div class="sb-service-title">
          <strong>${esc(service.name)}</strong>
          <small>${esc(serviceCodeFor(service))} · v${esc(service.version)}</small>
        </div>
        ${statusChip(service.status)}
      </div>
      <button class="secondary-btn" type="button" data-sb-back>Back to services</button>
    </div>
    <nav class="segmented" aria-label="Service tabs">
      ${tabs.map(([key, label]) => `<button type="button" class="segmented-btn${state.detailTab === key ? " active" : ""}" data-sb-tab="${esc(key)}" aria-pressed="${state.detailTab === key}">${esc(label)}</button>`).join("")}
    </nav>
    <section class="table-card">${body}</section>
  `;
}
async function publishService(service) {
  const problems = validateForPublish(service);
  if (problems.length) {
    HOST.showToast(`Cannot publish: ${problems[0]}`);
    return false;
  }
  const previous = service.status;
  if (service.meta.publishedAt) service.version = bumpVersion(service.version, "minor");
  service.status = "active";
  service.meta.publishedAt = nowIso();
  service.meta.publishedBy = operatorName();
  const snapshot = JSON.parse(JSON.stringify({ ...service, versions: undefined, audit: undefined }));
  service.versions.unshift({ version: service.version, publishedAt: service.meta.publishedAt, publishedBy: service.meta.publishedBy, snapshot });
  if (service.versions.length > 25) service.versions.length = 25;
  audit(service, "Service published", `v${service.version} (was ${previous})`);
  await persistService(service);
  HOST.showToast(`${service.name} published as v${service.version}`);
  return true;
}
async function rollbackService(service, index) {
  const target = service.versions[index];
  if (!target) return;
  const restored = JSON.parse(JSON.stringify(target.snapshot));
  ["name", "code", "description", "category", "tags", "visibility", "branding", "navigation", "permissions", "availability", "api", "ui", "fees", "notifications"].forEach((key) => {
    if (restored[key] !== undefined) service[key] = restored[key];
  });
  service.version = bumpVersion(service.version, "minor");
  service.status = "active";
  service.meta.publishedAt = nowIso();
  service.meta.publishedBy = operatorName();
  const snapshot = JSON.parse(JSON.stringify({ ...service, versions: undefined, audit: undefined }));
  service.versions.unshift({ version: service.version, publishedAt: service.meta.publishedAt, publishedBy: service.meta.publishedBy, snapshot });
  audit(service, "Service rolled back", `Restored v${target.version} as v${service.version}`);
  await persistService(service);
  HOST.showToast(`Rolled back to v${target.version}, published as v${service.version}`);
}
async function testConnection(service) {
  const endpoint = service.api.endpoint.trim();
  const result = document.getElementById("sb-test-result");
  if (!isAllowedEndpoint(endpoint)) {
    if (result) result.textContent = "Endpoint must be on the TitoPay API.";
    return;
  }
  if (result) result.textContent = "Testing…";
  const path = endpoint.startsWith("/") ? endpoint : new URL(endpoint).pathname + new URL(endpoint).search;
  const apiPath = path.startsWith("/v1/") ? path.slice(3) : path;
  const started = performance.now();
  let outcome;
  try {
    await HOST.apiFetch(apiPath);
    outcome = { ok: true, status: 200, ms: Math.round(performance.now() - started), at: nowIso() };
  } catch (error) {
    const status = error?.status ?? null;
    // Any HTTP answer proves connectivity; only status 0 means unreachable.
    outcome = { ok: status !== 0 && status !== null, status, ms: Math.round(performance.now() - started), at: nowIso() };
  }
  service.api.lastTest = outcome;
  audit(service, "API connection tested", `${endpoint} · ${outcome.ok ? "reachable" : "unreachable"} · HTTP ${outcome.status ?? "—"} · ${outcome.ms}ms`);
  if (findService(service.id)) await persistService(service);
  if (result) result.textContent = `${outcome.ok ? "Reachable" : "Unreachable"} · HTTP ${outcome.status ?? "—"} · ${outcome.ms}ms · ${formatWhen(outcome.at)}`;
}

/* ==========================================================================
   10. PAINTING AND EVENT WIRING
   ========================================================================== */

/* == Paint ================================================================ */

async function paint() {
  const content = document.getElementById("page-content");
  if (!content) return;
  let body = "";
  if (state.view === "wizard") body = renderWizard();
  else if (state.view === "detail") body = await renderDetail();
  else if (state.view === "archived") body = renderArchivedList();
  else body = renderList();
  content.innerHTML = `<div class="sb-root" id="service-builder-root">${body}${confirmDialogHtml()}</div>`;
  applyPreviewColour();
}
/* Tile colour is operator-chosen, so it cannot come from the stylesheet. It is
   applied through CSSOM after render — the console's style-src 'self' policy
   forbids inline style attributes but permits CSSOM writes. */
function applyPreviewColour() {
  const tile = document.getElementById("sb-preview-tile");
  if (tile && state.draft) tile.style.background = state.draft.ui.tileColour;
  const button = document.getElementById("sb-preview-btn");
  if (button && state.draft) button.style.background = state.draft.ui.tileColour;
}
/* == Events =============================================================== */

function bindEvents() {
  if (bound) return;
  bound = true;

  document.addEventListener("click", async (event) => {
    const root = event.target.closest?.("#service-builder-root");
    if (!root) return;

    // Confirmation dialog first: while it is open it owns the page.
    if (state.confirm) {
      if (event.target.closest("[data-sb-confirm-cancel]")) {
        state.confirm = null;
        await paint();
        return;
      }
      if (event.target.closest("[data-sb-confirm-go]")) {
        const action = state.confirm.onConfirm;
        state.confirm = null;
        await action();
        await paint();
        return;
      }
      return;
    }

    const stepButton = event.target.closest("[data-sb-step]");
    if (stepButton) {
      collectWizardFields();
      state.step = Number(stepButton.dataset.sbStep) || 0;
      await paint();
      return;
    }

    if (event.target.closest("[data-sb-next]")) {
      collectWizardFields();
      const [stepKey] = STEPS[state.step];
      const errors = validateStep(state.draft, stepKey);
      state.stepErrors = { [stepKey]: errors };
      if (!errors.length) state.step = Math.min(state.step + 1, STEPS.length - 1);
      await paint();
      return;
    }

    if (event.target.closest("[data-sb-prev]")) {
      collectWizardFields();
      state.stepErrors = {};
      state.step = Math.max(0, state.step - 1);
      await paint();
      return;
    }

    if (event.target.closest("[data-sb-save-draft]")) {
      collectWizardFields();
      const isNew = !findService(state.draft.id);
      if (isNew) {
        state.draft.meta.createdBy = operatorName();
        audit(state.draft, "Service created", state.draft.name || state.draft.id);
      } else {
        audit(state.draft, "Service updated", `Draft saved at step ${state.step + 1}`);
      }
      await persistService(state.draft);
      HOST.showToast("Draft saved");
      await paint();
      return;
    }

    if (event.target.closest("[data-sb-cancel]") || event.target.closest("[data-sb-back]")) {
      state.view = "list";
      state.draft = null;
      state.stepErrors = {};
      await paint();
      return;
    }

    if (event.target.closest("[data-sb-new]")) {
      state.draft = blankService("");
      state.draft.meta.createdBy = operatorName();
      state.editingId = null;
      state.view = "wizard";
      state.step = 0;
      state.stepErrors = {};
      await paint();
      return;
    }

    const edit = event.target.closest("[data-sb-edit]");
    if (edit) {
      const service = findService(edit.dataset.sbEdit);
      if (!service) return;
      state.draft = service;
      state.editingId = service.id;
      state.view = "wizard";
      state.step = 0;
      state.stepErrors = {};
      await paint();
      return;
    }

    const duplicate = event.target.closest("[data-sb-duplicate]");
    if (duplicate) {
      const source = findService(duplicate.dataset.sbDuplicate);
      if (!source) return;
      const copy = JSON.parse(JSON.stringify(source));
      copy.id = newServiceId(`${source.name} copy`);
      copy.name = `${source.name} (copy)`;
      copy.code = "";
      copy.status = "draft";
      copy.version = "1.0.0";
      copy.versions = [];
      copy.audit = [];
      copy.meta = { createdAt: nowIso(), createdBy: operatorName(), updatedAt: nowIso(), updatedBy: operatorName(), publishedAt: "", publishedBy: "" };
      audit(copy, "Service created", `Duplicated from ${source.name}`);
      await persistService(copy);
      HOST.showToast(`Duplicated as ${copy.name}`);
      await paint();
      return;
    }

    const open = event.target.closest("[data-sb-open]");
    if (open && !event.target.closest("button")) {
      state.detailId = open.dataset.sbOpen;
      state.detailTab = "overview";
      state.view = "detail";
      await paint();
      return;
    }

    const tab = event.target.closest("[data-sb-tab]");
    if (tab) {
      state.detailTab = tab.dataset.sbTab;
      await paint();
      return;
    }

    const publish = event.target.closest("[data-sb-publish]");
    if (publish) {
      const service = findService(publish.dataset.sbPublish);
      if (!service) return;
      openConfirm({
        title: `Publish ${service.name}?`,
        body: "Publishing marks this definition Active, snapshots it into version history and writes an audit entry. Customers see it once the API catalogue carries it.",
        verb: "Publish",
        expect: service.name,
        onConfirm: async () => { await publishService(service); },
      });
      return;
    }

    if (event.target.closest("[data-sb-publish-wizard]")) {
      collectWizardFields();
      const service = state.draft;
      const problems = validateForPublish(service);
      if (problems.length) {
        state.stepErrors = { review: problems };
        await paint();
        return;
      }
      openConfirm({
        title: `Publish ${service.name}?`,
        body: "Publishing marks this definition Active, snapshots it into version history and writes an audit entry.",
        verb: "Publish",
        expect: service.name,
        onConfirm: async () => {
          if (!findService(service.id)) {
            service.meta.createdBy = operatorName();
            audit(service, "Service created", service.name);
          }
          const ok = await publishService(service);
          if (ok) {
            state.view = "detail";
            state.detailId = service.id;
            state.detailTab = "overview";
            state.draft = null;
          }
        },
      });
      return;
    }

    const disable = event.target.closest("[data-sb-disable]");
    if (disable) {
      const service = findService(disable.dataset.sbDisable);
      if (!service) return;
      openConfirm({
        title: `Disable ${service.name}?`,
        body: "The service stops being offered while it is disabled. Its configuration, versions and audit trail are kept.",
        verb: "Disable",
        danger: true,
        onConfirm: async () => {
          service.status = "disabled";
          audit(service, "Service disabled", "");
          await persistService(service);
          HOST.showToast(`${service.name} disabled`);
        },
      });
      return;
    }

    const archive = event.target.closest("[data-sb-archive]");
    if (archive) {
      const service = findService(archive.dataset.sbArchive);
      if (!service) return;
      openConfirm({
        title: `Archive ${service.name}?`,
        body: "Archived services are hidden everywhere but keep their full history. You can restore or permanently delete them later.",
        verb: "Archive",
        danger: true,
        onConfirm: async () => {
          service.status = "archived";
          audit(service, "Service archived", "");
          await persistService(service);
          state.view = "list";
          HOST.showToast(`${service.name} archived`);
        },
      });
      return;
    }

    const restore = event.target.closest("[data-sb-restore]");
    if (restore) {
      const service = findService(restore.dataset.sbRestore);
      if (!service) return;
      service.status = "draft";
      audit(service, "Service restored", "Restored from archive to draft");
      await persistService(service);
      HOST.showToast(`${service.name} restored to draft`);
      await paint();
      return;
    }

    const remove = event.target.closest("[data-sb-delete]");
    if (remove) {
      const service = findService(remove.dataset.sbDelete);
      if (!service) return;
      openConfirm({
        title: `Delete ${service.name} permanently?`,
        body: "This removes the definition, its version history and its audit trail from the registry. This cannot be undone.",
        verb: "Delete permanently",
        danger: true,
        expect: service.name,
        onConfirm: async () => {
          state.services = state.services.filter((row) => row.id !== service.id);
          writeLocalRegistry();
          if (state.storageMode === "api") {
            try {
              await HOST.apiFetch(`${SB_API_BASE}/${encodeURIComponent(service.id)}`, { method: "DELETE" });
            } catch {}
          }
          state.view = "list";
          HOST.showToast(`${service.name} deleted`);
        },
      });
      return;
    }

    const exportCatalogue = event.target.closest("[data-sb-export]");
    if (exportCatalogue) {
      const service = findService(exportCatalogue.dataset.sbExport);
      if (!service) return;
      downloadJson(`titopay-service-${serviceCodeFor(service).toLowerCase()}-catalogue.json`, catalogueEntry(service));
      audit(service, "Definition exported", "Catalogue schema");
      await persistService(service);
      HOST.showToast("Catalogue entry exported");
      return;
    }

    const exportFull = event.target.closest("[data-sb-export-full]");
    if (exportFull) {
      const service = findService(exportFull.dataset.sbExportFull);
      if (!service) return;
      downloadJson(`titopay-service-${serviceCodeFor(service).toLowerCase()}-definition.json`, service);
      HOST.showToast("Full definition exported");
      return;
    }

    if (event.target.closest("[data-sb-import]")) {
      document.getElementById("sb-import-file")?.click();
      return;
    }

    if (event.target.closest("[data-sb-show-archived]")) {
      state.view = "archived";
      await paint();
      return;
    }

    if (event.target.closest("[data-sb-test-connection]")) {
      collectWizardFields();
      await testConnection(state.draft);
      return;
    }

    const rollback = event.target.closest("[data-sb-rollback]");
    if (rollback) {
      const [id, indexText] = rollback.dataset.sbRollback.split(":");
      const service = findService(id);
      const index = Number(indexText);
      const target = service?.versions[index];
      if (!service || !target) return;
      openConfirm({
        title: `Roll back to v${target.version}?`,
        body: "The configuration from that version is restored and published as a new version. History is never rewritten.",
        verb: "Roll back and publish",
        expect: service.name,
        onConfirm: async () => { await rollbackService(service, index); },
      });
      return;
    }

    const clearImage = event.target.closest("[data-sb-clear-image]");
    if (clearImage) {
      collectWizardFields();
      state.draft.branding[clearImage.dataset.sbClearImage] = null;
      await paint();
      return;
    }
  });

  document.addEventListener("change", async (event) => {
    if (!event.target.closest?.("#service-builder-root") && event.target.id !== "sb-import-file") return;

    const file = event.target.closest("[data-sb-file]");
    if (file && file.files?.[0]) {
      collectWizardFields();
      const slot = file.dataset.sbFile;
      intakeImage(file.files[0], async (image) => {
        state.draft.branding[slot] = image;
        audit(state.draft, "Branding changed", `${slot} set to ${image.name}`);
        await paint();
      });
      return;
    }

    if (event.target.id === "sb-import-file" && event.target.files?.[0]) {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const parsed = JSON.parse(String(reader.result));
          const incoming = parsed.sbVersion ? parsed : null;
          if (!incoming || !incoming.id || !incoming.name) throw new Error("Not a service definition export");
          incoming.status = "draft";
          incoming.audit = Array.isArray(incoming.audit) ? incoming.audit : [];
          audit(incoming, "Service imported", "From JSON file");
          await persistService(incoming);
          HOST.showToast(`${incoming.name} imported as a draft`);
          await paint();
        } catch (error) {
          HOST.showToast(`Import failed: ${error.message}`);
        }
      };
      reader.readAsText(event.target.files[0]);
      event.target.value = "";
      return;
    }

    // Colour input: reflect into the preview immediately.
    if (event.target.matches('[data-sb-field="ui.tileColour"]')) {
      collectWizardFields();
      applyPreviewColour();
    }
  });

  document.addEventListener("input", (event) => {
    // Live preview text while typing on the UI step.
    if (!event.target.closest?.("#service-builder-root")) return;
    if (event.target.matches('[data-sb-field^="ui."], [data-sb-field="name"], [data-sb-field="description"]')) {
      collectWizardFields();
      const tile = document.getElementById("sb-preview-tile");
      if (tile && state.draft) {
        tile.querySelector("strong").textContent = state.draft.name || "Service name";
        tile.querySelector("small").textContent = (state.draft.description || "Description").slice(0, 48);
        const button = document.getElementById("sb-preview-btn");
        if (button) button.textContent = state.draft.ui.buttonLabel || "Continue";
      }
    }
    if (event.target.id === "sb-confirm-input" && state.confirm?.expect) {
      const go = document.querySelector("[data-sb-confirm-go]");
      if (go) go.disabled = event.target.value.trim() !== state.confirm.expect;
    }
  });

  // Drag-and-drop onto the dropzones.
  document.addEventListener("dragover", (event) => {
    const zone = event.target.closest?.("[data-sb-dropzone]");
    if (zone) {
      event.preventDefault();
      zone.classList.add("is-over");
    }
  });
  document.addEventListener("dragleave", (event) => {
    event.target.closest?.("[data-sb-dropzone]")?.classList.remove("is-over");
  });
  document.addEventListener("drop", (event) => {
    const zone = event.target.closest?.("[data-sb-dropzone]");
    if (!zone) return;
    event.preventDefault();
    zone.classList.remove("is-over");
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    collectWizardFields();
    const slot = zone.dataset.sbDropzone;
    intakeImage(file, async (image) => {
      state.draft.branding[slot] = image;
      audit(state.draft, "Branding changed", `${slot} set to ${image.name}`);
      await paint();
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.confirm) {
      state.confirm = null;
      paint();
    }
  });
}

/* ==========================================================================
   11. ACCESS CONTROL
   ========================================================================== */

function canUseServiceBuilder(me = {}) {
  if (HOST.hasFullAdminAccess(me)) return true;
  if (HOST.isPlatformOwnerRole(me.role || me.admin?.role)) return true;
  const permissions = new Set(me.permissions || me.admin?.permissions || []);
  return SB_PERMISSIONS.some((permission) => permissions.has(permission));
}

/* ==========================================================================
   THE ENTRY POINT admin.js IMPORTS
   ========================================================================== */

/* == Entry point ========================================================== */

export async function renderServiceBuilder(me, host) {
  HOST = host;
  state.me = me || {};
  bindEvents();
  if (!canUseServiceBuilder(state.me)) {
    const content = document.getElementById("page-content");
    if (content) {
      content.innerHTML = `
        <section class="table-card">
          <h3>Access restricted</h3>
          <p class="table-card-note">Service Builder is available to platform owners and operators with a service-builder permission. Every other module keeps the access your role already had.</p>
        </section>
      `;
    }
    return;
  }
  await loadRegistry();
  state.view = "list";
  state.usage = null;
  const content = document.getElementById("page-content");
  if (content && !document.getElementById("sb-import-file")) {
    const importInput = document.createElement("input");
    importInput.type = "file";
    importInput.accept = "application/json";
    importInput.id = "sb-import-file";
    importInput.hidden = true;
    document.body.appendChild(importInput);
  }
  await paint();
}
