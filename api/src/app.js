const express = require("express");
const path = require("path");
const cors = require("cors");
const helmet = require("helmet");
const { config } = require("./config/env");
const routes = require("./routes");
const hrRoutes = require("./routes/hr.routes");
const providerWebhookRoutes = require("./routes/provider-webhook.routes");
const payoutWebhookRoutes = require("./routes/payout-webhook.routes");
const paymentReturnRoutes = require("./routes/payment-return.routes");
const emailWebhookRoutes = require("./routes/email-webhook.routes");
const { requestIdMiddleware } = require("./middleware/request-id");
const { generalLimiter } = require("./middleware/rate-limits");
const { securityHeaders, validateJsonContentType } = require("./middleware/security");
const { notFoundHandler, errorHandler } = require("./middleware/error-handler");

const app = express();
const corsOptions = {
  origin(origin, callback) {
    if (!origin || config.allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type", "Authorization", "X-Requested-With", "X-Request-Id",
    "X-TitoPay-Website-Token", "Idempotency-Key", "X-TitoPay-Terminal-Id",
    "X-TitoPay-Timestamp", "X-TitoPay-Nonce", "X-TitoPay-Signature"
  ],
  credentials: false,
  maxAge: 86400,
  optionsSuccessStatus: 204
};

// Behind Cloudflare/Nginx, trust only the local reverse proxy by default.
// Do not use boolean true: express-rate-limit rejects it because it lets
// clients spoof X-Forwarded-For and bypass IP-based limits.
app.set("trust proxy", config.trustProxy);
app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'none'"],
      "base-uri": ["'none'"],
      "frame-ancestors": ["'none'"],
      "form-action": ["'self'"],
      "connect-src": ["'self'", config.appOrigin, config.adminOrigin, config.hrOrigin],
      "img-src": ["'self'", "data:"],
      "script-src": ["'self'"],
      "style-src": ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: "no-referrer" },
  hsts: config.env === "production"
    ? { maxAge: 31536000, includeSubDomains: true, preload: true }
    : false
}));
app.use(securityHeaders);
app.options("*", cors(corsOptions));
app.use(cors(corsOptions));
app.use(requestIdMiddleware);
app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (durationMs > 200) {
      console.warn("[slow-api-request]", {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
        requestId: req.id || null
      });
    }
  });
  next();
});

// Public browser-tab icon only. This serves one bundled image and exposes no
// configuration, credentials, filesystem paths, or API resources.
app.get("/favicon.ico", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.type("image/x-icon").sendFile(path.join(__dirname, "assets", "favicon.ico"));
});

app.use(validateJsonContentType);
// The Service Builder saves a whole service definition in one POST, and a
// definition legitimately carries up to four branding images as data URIs
// (each capped at 400KB before base64 grows them). That one admin-only,
// permission-gated path gets a larger parser; every other route keeps the
// 768kb ceiling below, so nothing else on the API loosens.
const serviceBuilderJsonParser = express.json({ limit: "4mb", strict: true });
app.use((req, res, next) => {
  const requestPath = String(req.originalUrl || req.url || "").split("?")[0];
  if (req.method === "POST" && requestPath === "/v1/admin/service-builder/services") {
    return serviceBuilderJsonParser(req, res, next);
  }
  next();
});
app.use(express.json({
  limit: "768kb",
  strict: true,
  verify(req, _res, buffer) {
    const requestPath = String(req.originalUrl || req.url || "").split("?")[0];
    if (
      req.method === "POST" &&
      (
        requestPath === "/v1/webhooks/provider" ||
        requestPath === "/v1/webhooks/pos-provider" ||
        requestPath.startsWith("/v1/webhooks/email/") ||
        requestPath.startsWith("/v1/pos/") ||
        requestPath.startsWith("/api/pos/")
      )
    ) {
      req.rawBody = Buffer.from(buffer);
    }
  },
}));
app.use(express.urlencoded({
  extended: false,
  limit: "768kb",
  verify(req, _res, buffer) {
    const requestPath = String(req.originalUrl || req.url || "").split("?")[0];
    if (req.method === "POST" && requestPath === "/v1/webhooks/provider") {
      req.rawBody = Buffer.from(buffer);
    }
  }
}));
app.use(generalLimiter);

// Peach Payments authenticates this one route with its signed webhook headers.
// Mount it before the versioned route stack so it can never fall through to a
// router-level JWT middleware. Every other API route keeps its existing auth.
app.use("/v1/webhooks/provider", providerWebhookRoutes);
// Peach Payouts status notifications. Public by necessity and unsigned by
// Peach's own specification, so it decides nothing — TitoPay re-queries Peach
// before any money moves.
app.use("/v1/webhooks/peach-payouts", payoutWebhookRoutes);
// Peach Checkout POSTs the customer's browser here after payment. Public by
// necessity — it is a redirect target, and it never decides a payment outcome.
app.use("/v1/payments/topup/return", paymentReturnRoutes);
app.use("/v1/webhooks/email", emailWebhookRoutes);

// Mount HR before the main route stack so public HR auth/application endpoints
// are never intercepted by customer/admin bearer-token middleware.
app.use("/api/v1/hr", hrRoutes);
app.use("/v1/hr", hrRoutes);
app.use("/api/hr", hrRoutes);
app.use("/hr", hrRoutes);

app.use(routes);
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = { app };
