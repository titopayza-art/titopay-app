const { AppError } = require("../lib/errors");
const { requirePermission } = require("../services/auth-service");

function requireAdminPermission(permission) {
  return async (req, _res, next) => {
    try {
      if (!req.auth) throw new AppError(401, "Authentication required");
      await requirePermission({
        user_type: req.auth.userType,
        role: req.auth.role
      }, permission);
      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { requireAdminPermission };
