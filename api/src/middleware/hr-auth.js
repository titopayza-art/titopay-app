const crypto = require("crypto");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { verifyAccessToken } = require("../lib/jwt");

const roleAliases = {
  "hr admin": "HR Administrator",
  "hr administrator": "HR Administrator",
  manager: "Department Manager",
  "department manager": "Department Manager",
  compliance: "Compliance Officer",
  "compliance officer": "Compliance Officer",
  finance: "Finance",
  accountant: "Finance",
  "payroll officer": "Payroll Officer",
  recruiter: "Recruiter",
  employee: "Employee",
  auditor: "Auditor",
  "read only": "Read Only",
  ceo: "CEO",
  "super admin": "Super Admin"
};

function canonicalHrRole(role) {
  const normalized = String(role || "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return roleAliases[normalized] || String(role || "").trim();
}

const fullAccessRoles = new Set(["CEO", "Super Admin"]);

const permissions = {
  "HR Director": ["*"],
  // "disciplinary" was the one module an HR Administrator held no grant on, so
  // the page answered 403 for the role that runs the process (F-04). Who signs
  // OFF a case — records the outcome and closes it — is a separate question
  // this grant does not settle; Compliance Officer keeps its own grant.
  "HR Administrator": ["dashboard", "employees", "onboarding", "leave", "attendance", "payroll", "performance", "disciplinary", "documents", "tickets", "projects", "meetings", "recruitment", "reports", "learning", "assets", "expenses", "announcements", "organisation", "audit"],
  Finance: ["dashboard", "employees:read", "payroll", "tickets:read", "reports", "expenses"],
  "Payroll Officer": ["dashboard", "employees:read", "payroll", "reports"],
  "Compliance Officer": ["dashboard", "employees:read", "disciplinary", "documents", "tickets:read", "reports", "audit"],
  "Department Manager": ["dashboard", "employees:read", "leave", "attendance", "performance", "tickets", "projects", "meetings:read", "recruitment", "reports"],
  "Team Lead": ["dashboard", "employees:read", "leave", "attendance", "performance", "tickets", "recruitment:read"],
  Recruiter: ["dashboard", "recruitment", "documents:read"],
  Employee: ["dashboard", "employees:self", "onboarding:self", "leave:self", "attendance:self", "performance:self", "documents:read", "tickets:self", "learning:self", "expenses:self"],
  Auditor: ["dashboard", "employees:read", "payroll:read", "disciplinary:read", "documents:read", "reports", "audit"],
  "Read Only": ["dashboard", "employees:read", "documents:read", "reports:read"]
};

function tokenHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

// Is this role's access to a module limited to its OWN records?
//
// The permission strings already say so — "leave:self" means self — but nothing
// read that suffix back, so `:self` was treated as blanket write on the whole
// module. This is what the row-level scoping keys off, so any future role given
// a `:self` grant is scoped automatically rather than by name.
function hrGrantScope(role, moduleName) {
  const canonical = canonicalHrRole(role);
  if (fullAccessRoles.has(canonical)) return "full";
  const grants = permissions[canonical] || [];
  if (grants.includes("*") || grants.includes(moduleName)) return "full";
  if (grants.includes(`${moduleName}:self`)) return "self";
  if (grants.includes(`${moduleName}:write`)) return "full";
  if (grants.includes(`${moduleName}:read`)) return "read";
  return null;
}

function hasHrPermission(role, moduleName, action = "read") {
  role = canonicalHrRole(role);
  if (fullAccessRoles.has(role)) return true;
  const grants = permissions[role] || [];
  if (grants.includes("*") || grants.includes(moduleName)) return true;
  if (grants.includes(`${moduleName}:${action}`)) return true;
  if ((action === "read" || action === "write") && grants.includes(`${moduleName}:self`)) return true;
  return false;
}

async function requireHrAuth(req, _res, next) {
  try {
    const header = req.get("authorization") || "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) throw new AppError(401, "Missing HR access token");

    const token = match[1];
    const decoded = verifyAccessToken(token);
    if (decoded.typ !== "hr" && decoded.scope !== "hr") {
      throw new AppError(401, "Invalid HR token scope");
    }

    const result = await pool.query(
      `UPDATE hr_sessions AS s
          SET last_seen_at = NOW()
         FROM hr_users AS u
        WHERE s.user_id = u.id
          AND s.access_jti = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > NOW()
      RETURNING s.id AS session_id, s.expires_at, s.revoked_at,
                u.id, u.email, u.name, u.role, u.status, u.employee_id`,
      [decoded.jti]
    );
    const row = result.rows[0];
    if (!row) {
      throw new AppError(401, "HR session expired");
    }
    if (row.status !== "active") {
      throw new AppError(403, "HR account is not active");
    }

    req.hrAuth = {
      sessionId: row.session_id,
      userId: row.id,
      employeeId: row.employee_id,
      email: row.email,
      name: row.name,
      role: canonicalHrRole(row.role)
    };
    next();
  } catch (error) {
    next(error.statusCode ? error : new AppError(401, "Invalid HR access token"));
  }
}

function requireHrPermission(moduleName, action = "read") {
  return (req, _res, next) => {
    if (!req.hrAuth) return next(new AppError(401, "Authentication required"));
    if (!hasHrPermission(req.hrAuth.role, moduleName, action)) {
      return next(new AppError(403, `You do not have permission to ${action} ${moduleName} records`));
    }
    next();
  };
}

module.exports = {
  hrGrantScope,
  requireHrAuth,
  requireHrPermission,
  hasHrPermission,
  canonicalHrRole,
  tokenHash
};
