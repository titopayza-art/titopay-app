const { AppError } = require("../lib/errors");

function notFoundHandler(req, _res, next) {
  next(new AppError(404, "Not found"));
}

function normalizeError(error) {
  const rawMessage = String(error?.message || "");
  const technicalPublicMessage = /pricing rule not found|sql|database|stack|webrtc|dtls|srtp|exception|internal server error/i.test(rawMessage)
    ? "Unable to complete the request. Please try again."
    : null;
  if (error instanceof AppError) {
    return {
      status: error.statusCode,
      message: technicalPublicMessage || error.message,
      details: error.details,
      // AppError messages are authored deliberately, in this codebase, for the
      // person reading them — and anything technical has already been replaced
      // above. So an AppError that survived that scrub is safe to show whatever
      // its status, not only on 502/503/504.
      //
      // The old rule kept the generic replacement for 500, which threw away the
      // only useful thing the server knew. "TitoPay revenue wallet is not
      // configured" and "Card top-up is not configured yet" both reached people
      // as "Unable to complete the request. Please try again." — a sentence that
      // describes nothing, invites a pointless retry, and sent somebody hunting
      // through logs for a fault the server had already named.
      //
      // Errors that are NOT AppError still fall through to the generic message
      // below, so a raw driver or provider failure cannot ride out on a 5xx.
      clientSafe: !technicalPublicMessage,
      // The machine-readable code is a different question from the sentence.
      // It tells the customer app whether money moved — "rejected, returned"
      // against "unconfirmed, held" — and that distinction only exists for
      // provider-state errors. It stays restricted to those, unchanged.
      codeSafe: !technicalPublicMessage && [502, 503, 504].includes(error.statusCode)
    };
  }
  if (error?.type === "entity.parse.failed") {
    return { status: 400, message: "Malformed JSON payload" };
  }
  if (error?.type === "entity.too.large") {
    return { status: 413, message: "Payload too large" };
  }
  return { status: 500, message: "Internal server error" };
}

// Only an UPPER_SNAKE token this codebase wrote itself. Anything longer, lower
// case or punctuated is assumed to have come from a provider and is dropped, so
// no upstream text can ride out on a 5xx.
function safeErrorCode(details) {
  const code = String(details?.code || "");
  return /^[A-Z][A-Z0-9_]{2,47}$/.test(code) ? code : "";
}

function errorHandler(error, req, res, _next) {
  const { status, message, details, clientSafe, codeSafe } = normalizeError(error);
  console.error({
    requestId: req.requestId,
    status,
    name: error?.name || "Error",
    message: error?.message || "Unexpected error",
    stack: error?.stack
  });
  const publicMessage = status >= 500 && !clientSafe ? "Unable to complete the request. Please try again." : message;
  res.status(status).json({
    ok: false,
    error: publicMessage,
    requestId: req.requestId,
    // Never the whole details object for a 5xx: it can carry a raw upstream
    // body. A deliberate 502/503/504 still needs a machine-readable code so the
    // app can tell "rejected, money returned" from "unconfirmed, money held" —
    // that is one short token this codebase authored, never provider prose.
    ...(status < 500 && details
      ? { details }
      : (codeSafe && safeErrorCode(details) ? { details: { code: safeErrorCode(details) } } : {}))
  });
}

module.exports = { notFoundHandler, errorHandler };
