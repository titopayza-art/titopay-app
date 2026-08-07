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
      // AppError messages are authored deliberately for the customer and are
      // already scrubbed above. Provider-state codes (502/503/504) must survive
      // the generic 5xx replacement below, otherwise a precise explanation such
      // as "Withdraw is not enabled for live processing yet. No wallet debit was
      // made." reaches the user as "Unable to complete the request", which reads
      // as a payment glitch and invites a retry.
      clientSafe: !technicalPublicMessage && [502, 503, 504].includes(error.statusCode)
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

function errorHandler(error, req, res, _next) {
  const { status, message, details, clientSafe } = normalizeError(error);
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
    // Never for 5xx: provider error details can carry a raw upstream body.
    ...(status < 500 && details ? { details } : {})
  });
}

module.exports = { notFoundHandler, errorHandler };
