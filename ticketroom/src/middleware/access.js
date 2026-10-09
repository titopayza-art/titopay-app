// Object-level authorisation helpers. Every organiser, vendor and event lookup
// goes through these so tenancy is enforced in one place. Out-of-tenancy
// objects return 404, not 403, so their existence is not disclosed.
const db = require("../lib/db");
const { notFound, forbidden } = require("../lib/errors");

const isAdmin = (user) => user?.platformRoles?.has("admin");
const isStaffRole = (user, ...roles) => roles.some((r) => user?.platformRoles?.has(r));

// Returns { organiser, role } or throws. roles = allowed organiser member roles.
async function organiserAccess(user, organiserId, roles = ["owner", "manager", "marketing", "finance", "viewer"], q = db) {
  const { rows } = await q.query(
    `SELECT o.*, m.role AS member_role FROM organisers o
       LEFT JOIN organiser_members m ON m.organiser_id = o.id AND m.user_id = $2
      WHERE o.id = $1`, [organiserId, user.id]);
  const org = rows[0];
  if (!org) throw notFound("Organiser not found.");
  if (isAdmin(user)) return { organiser: org, role: org.member_role || "admin" };
  if (!org.member_role) throw notFound("Organiser not found.");
  if (!roles.includes(org.member_role)) throw forbidden("Your role in this organisation does not allow that.");
  return { organiser: org, role: org.member_role };
}

async function eventAccess(user, organiserId, eventId, roles, q = db) {
  const access = await organiserAccess(user, organiserId, roles, q);
  const { rows } = await q.query("SELECT * FROM events WHERE id = $1 AND organiser_id = $2", [eventId, organiserId]);
  if (!rows[0]) throw notFound("Event not found.");
  return { ...access, event: rows[0] };
}

// Staff scanning/tag rights for an event: explicit event staff, or organiser
// owner/manager, or platform admin/support.
async function eventStaffAccess(user, eventId, capability = "can_scan", q = db) {
  const { rows } = await q.query(
    `SELECT e.*, s.can_scan, s.can_manage_tags, m.role AS member_role
       FROM events e
       LEFT JOIN event_staff s ON s.event_id = e.id AND s.user_id = $2
       LEFT JOIN organiser_members m ON m.organiser_id = e.organiser_id AND m.user_id = $2
      WHERE e.id = $1`, [eventId, user.id]);
  const ev = rows[0];
  if (!ev) throw notFound("Event not found.");
  if (isStaffRole(user, "admin", "support")) return ev;
  if (["owner", "manager"].includes(ev.member_role)) return ev;
  if (ev[capability]) return ev;
  throw notFound("Event not found.");
}

async function vendorAccess(user, vendorId, roles = ["manager", "cashier"], q = db) {
  const { rows } = await q.query(
    `SELECT v.*, vm.role AS member_role, om.role AS org_role, e.title AS event_title, e.status AS event_status,
            e.cashless_enabled, e.starts_at, e.ends_at
       FROM vendors v JOIN events e ON e.id = v.event_id
       LEFT JOIN vendor_members vm ON vm.vendor_id = v.id AND vm.user_id = $2
       LEFT JOIN organiser_members om ON om.organiser_id = v.organiser_id AND om.user_id = $2
      WHERE v.id = $1`, [vendorId, user.id]);
  const v = rows[0];
  if (!v) throw notFound("Vendor not found.");
  if (isAdmin(user)) return { vendor: v, role: "admin" };
  if (v.member_role && roles.includes(v.member_role)) return { vendor: v, role: v.member_role };
  if (["owner", "manager"].includes(v.org_role) && roles.includes("manager")) return { vendor: v, role: "organiser" };
  throw notFound("Vendor not found.");
}

module.exports = { isAdmin, isStaffRole, organiserAccess, eventAccess, eventStaffAccess, vendorAccess };
