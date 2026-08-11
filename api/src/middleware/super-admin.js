"use strict";

const { AppError } = require("../lib/errors");
const { isRootAdminRole, normalizeAdminRole } = require("../services/auth-service");

function isSuperAdminRole(role) {
  return isRootAdminRole(role) || normalizeAdminRole(role) === "developer";
}

function requireSuperAdmin(req, _res, next) {
  if (req.auth?.userType !== "admin" || !isSuperAdminRole(req.auth?.role)) {
    next(new AppError(403, "Super Admin access required"));
    return;
  }
  next();
}

module.exports = { requireSuperAdmin, isSuperAdminRole };
