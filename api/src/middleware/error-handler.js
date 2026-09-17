const { AppError } = require("../lib/errors");

function notFoundHandler(req, _res, next) {
  next(new AppError(404, "Not found"));
}

const GENERIC_5XX = "Unable to complete the request. Please try again.";
const TECHNICAL = /pricing rule not found|sql|database|stack|webrtc|dtls|srtp|exception|internal server error/i;

// A sentence the throw site wrote FOR the customer, opted in explicitly:
//
//   throw new AppError(500, "TitoPay revenue wallet is not configured", {
//     publicMessage: "Statement request unavailable. Please try again later."
//   });
//
// The first argument stays as it is — it is what goes in the log, beside the
// requestId the response already carries. Only the second one is ever shown.
// Scrubbed as well, so a careless author cannot opt technical wording in.
function authoredForCustomer(details) {
  const text = typeof details?.publicMessage === "string" ? details.publicMessage.trim() : "";
  return text && !TECHNICAL.test(text) ? text : "";
}

function normalizeError(error) {
  const rawMessage = String(error?.message || "");
  const technicalPublicMessage = TECHNICAL.test(rawMessage) ? GENERIC_5XX : null;
  if (error instanceof AppError) {
    const authored = authoredForCustomer(error.details);
    const providerState = [502, 503, 504].includes(error.statusCode);
    return {
      status: error.statusCode,
      message: authored || technicalPublicMessage || error.message,
      details: error.details,
      // A 5xx says nothing specific to a customer unless somebody decided it
      // should. "Authored in this codebase" and "safe for the person paying"
      // are different questions, and a previous version of this file treated
      // them as one: every AppError message survived at any status, so
      // "TitoPay revenue wallet is not configured" — TitoPay's internal wallet
      // architecture and a configuration state — was what a customer saw when
      // they pressed Confirm on an Email Statement. It named a fault they
      // cannot act on and cannot understand.
      //
      // The cause is not lost. It is logged below against the requestId that
      // goes back in the response, which is how an operator finds it.
      //
      // 502/503/504 keep their sentence, as they always have. Those describe a
      // provider being unreachable or slow, which is a state the customer is
      // genuinely in and can act on by waiting.
      clientSafe: Boolean(authored) || (!technicalPublicMessage && providerState),
      // The machine-readable code is a different question from the sentence.
      // It tells the customer app whether money moved — "rejected, returned"
      // against "unconfirmed, held" — and that distinction only exists for
      // provider-state errors. It stays restricted to those, unchanged.
      codeSafe: !technicalPublicMessage && providerState
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
  const publicMessage = status >= 500 && !clientSafe ? GENERIC_5XX : message;
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
