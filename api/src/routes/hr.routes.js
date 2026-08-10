const express = require("express");
const { requireHrAuth, requireHrPermission } = require("../middleware/hr-auth");
const { AppError } = require("../lib/errors");
const hr = require("../services/hr-service");
const hrEmail = require("../services/hr-email-service");

const router = express.Router();

function requestMeta(req) {
  return {
    ip: req.ip,
    userAgent: req.get("user-agent") || "",
    trustedDevice: req.body?.trustedDevice === true
  };
}

router.get("/health", async (_req, res, next) => {
  try {
    await hr.health();
    res.json({
      ok: true,
      service: "titopay-hr",
      status: "ready",
      database: "ok",
      basePath: "/api/v1/hr"
    });
  } catch (error) {
    next(error);
  }
});

router.post("/auth/login", async (req, res, next) => {
  try {
    res.json(await hr.login(req.body || {}, requestMeta(req)));
  } catch (error) {
    next(error);
  }
});

router.post("/auth/refresh", async (req, res, next) => {
  try {
    res.json(await hr.refresh(req.body?.refreshToken));
  } catch (error) {
    next(error);
  }
});

router.post("/auth/reset", async (req, res, next) => {
  try {
    res.json(await hr.passwordReset(req.body || {}));
  } catch (error) {
    next(error);
  }
});

router.post("/auth/logout", requireHrAuth, async (req, res, next) => {
  try {
    await hr.logout(req.hrAuth);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.post("/public/career-application", async (req, res, next) => {
  try {
    const configuredToken = process.env.HR_WEBSITE_TOKEN || "";
    if (configuredToken) {
      const suppliedToken = req.get("x-titopay-website-token") || "";
      if (suppliedToken !== configuredToken) {
        return res.status(401).json({ ok: false, error: "Website application token required" });
      }
    }
    res.status(201).json(await hr.receiveWebsiteApplication(req.body || {}, requestMeta(req)));
  } catch (error) {
    next(error);
  }
});

router.get("/me", requireHrAuth, (req, res) => {
  res.json({ user: req.hrAuth });
});

router.get("/dashboard", requireHrAuth, requireHrPermission("dashboard"), async (req, res, next) => {
  try {
    res.json(await hr.dashboard(req.hrAuth));
  } catch (error) {
    next(error);
  }
});

router.get("/notifications", requireHrAuth, async (req, res, next) => {
  try {
    res.json(await hr.notifications(req.hrAuth));
  } catch (error) {
    next(error);
  }
});

router.post("/uploads", requireHrAuth, async (req, res, next) => {
  try {
    res.json(await hr.upload(req.hrAuth, req.body || {}, requestMeta(req)));
  } catch (error) {
    next(error);
  }
});

// Who may turn staff email on, and choose what it sends.
//
// Deliberately narrower than "can write announcements": this decides whether
// the system mails every member of staff, which is not a thing a module
// permission should imply. It sits above the module grants, with the roles that
// answer for the company.
const EMAIL_SETTING_ROLES = new Set(["CEO", "Super Admin", "HR Director"]);
function requireEmailSettingsRole(req, _res, next) {
  if (!req.hrAuth) return next(new AppError(401, "Authentication required"));
  if (!EMAIL_SETTING_ROLES.has(req.hrAuth.role)) {
    return next(new AppError(403, "Only the CEO, a Super Admin or the HR Director can change staff email settings"));
  }
  next();
}

router.get("/email/settings", requireHrAuth, requireEmailSettingsRole, async (_req, res, next) => {
  try {
    res.json({ ok: true, settings: await hrEmail.getHrEmailConfig() });
  } catch (error) {
    next(error);
  }
});

router.post("/email/settings", requireHrAuth, requireEmailSettingsRole, async (req, res, next) => {
  try {
    const before = await hrEmail.getHrEmailConfig();
    const settings = await hrEmail.setHrEmailConfig(req.body || {}, null);
    await hr.recordEmailSettingChange(req.hrAuth, before, settings, requestMeta(req));
    res.json({ ok: true, settings });
  } catch (error) {
    next(error);
  }
});

// What a send would reach, without sending anything. An operator should be able
// to see "this would email 84 people" before turning it on.
router.get("/email/preview-audience", requireHrAuth, requireEmailSettingsRole, async (req, res, next) => {
  try {
    const staff = await hrEmail.activeStaff({ audience: req.query?.audience });
    res.json({ ok: true, recipients: staff.length,
      sample: staff.slice(0, 5).map((person) => person.email) });
  } catch (error) {
    next(error);
  }
});

router.get("/export/:resource.:kind", requireHrAuth, async (req, res, next) => {
  try {
    const result = await hr.exportResource(req.params.resource, req.params.kind, req.hrAuth);
    res.type(result.contentType);
    res.send(result.body);
  } catch (error) {
    next(error);
  }
});

router.post("/leave/:id/decision", requireHrAuth, async (req, res, next) => {
  try {
    res.json(await hr.leaveDecision(req.params.id, req.hrAuth, req.body?.decision, req.body?.comment, requestMeta(req)));
  } catch (error) {
    next(error);
  }
});

router.post("/attendance/clock", requireHrAuth, async (req, res, next) => {
  try {
    res.json(await hr.clock(req.hrAuth, req.body || {}, requestMeta(req)));
  } catch (error) {
    next(error);
  }
});

router.post("/attendance/break/:action", requireHrAuth, async (req, res, next) => {
  try {
    const action = req.params.action === "start" ? "break_start" : req.params.action === "end" ? "break_end" : "";
    if (!action) return res.status(400).json({ ok: false, error: "Break action must be start or end" });
    res.json(await hr.clock(req.hrAuth, { ...(req.body || {}), action }, requestMeta(req)));
  } catch (error) {
    next(error);
  }
});

router.get("/learning/dashboard", requireHrAuth, async (req, res, next) => {
  try {
    res.json(await hr.learningDashboard(req.hrAuth));
  } catch (error) {
    next(error);
  }
});

router.post("/learning/:id/enrol", requireHrAuth, async (req, res, next) => {
  try {
    res.json(await hr.enrolLearning(req.params.id, req.hrAuth, requestMeta(req)));
  } catch (error) {
    next(error);
  }
});

router.post("/learning/:id/progress", requireHrAuth, async (req, res, next) => {
  try {
    res.json(await hr.updateLearningProgress(req.params.id, req.hrAuth, req.body || {}, requestMeta(req)));
  } catch (error) {
    next(error);
  }
});

router.post("/learning/:id/certificate", requireHrAuth, async (req, res, next) => {
  try {
    res.json(await hr.issueLearningCertificate(req.params.id, req.hrAuth, req.body || {}, requestMeta(req)));
  } catch (error) {
    next(error);
  }
});

router.post("/learning/:id/bookmark", requireHrAuth, async (req, res, next) => {
  try {
    res.json(await hr.toggleLearningBookmark(req.params.id, req.hrAuth));
  } catch (error) {
    next(error);
  }
});

router.get("/:resource", requireHrAuth, async (req, res, next) => {
  try {
    res.json(await hr.list(req.params.resource, req.hrAuth, req.query));
  } catch (error) {
    next(error);
  }
});

router.post("/:resource", requireHrAuth, async (req, res, next) => {
  try {
    res.status(201).json(await hr.create(req.params.resource, req.hrAuth, req.body || {}, requestMeta(req)));
  } catch (error) {
    next(error);
  }
});

router.put("/:resource/:id", requireHrAuth, async (req, res, next) => {
  try {
    res.json(await hr.update(req.params.resource, req.params.id, req.hrAuth, req.body || {}, requestMeta(req)));
  } catch (error) {
    next(error);
  }
});

router.patch("/:resource/:id", requireHrAuth, async (req, res, next) => {
  try {
    res.json(await hr.update(req.params.resource, req.params.id, req.hrAuth, req.body || {}, requestMeta(req)));
  } catch (error) {
    next(error);
  }
});

router.delete("/:resource/:id", requireHrAuth, async (req, res, next) => {
  try {
    res.json(await hr.remove(req.params.resource, req.params.id, req.hrAuth, requestMeta(req)));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
