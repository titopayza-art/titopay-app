const { ADMIN_ROLE_PERMISSIONS } = require("../src/services/auth-service");

const requiredOwnerModules = [
  "dashboard",
  "users",
  "merchants",
  "wallets",
  "transactions",
  "pricing",
  "integrations",
  "qr-management",
  "support",
  "compliance",
  "security",
  "audit",
  "engineering",
  "settings"
];

const ownerRoles = ["super_admin", "ceo", "developer"];
const failures = [];

for (const role of ownerRoles) {
  const permissions = ADMIN_ROLE_PERMISSIONS[role] || [];
  if (!permissions.includes("*")) {
    failures.push(`${role} does not have wildcard permissions`);
  }
}

for (const role of ["customer_support", "compliance", "finance", "marketing", "engineering"]) {
  const permissions = ADMIN_ROLE_PERMISSIONS[role] || [];
  if (permissions.includes("*")) {
    failures.push(`${role} unexpectedly has wildcard permissions`);
  }
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  ownerRoles,
  requiredOwnerModules,
  ownerAccess: "wildcard",
  lowerRolesRestricted: true
}, null, 2));
