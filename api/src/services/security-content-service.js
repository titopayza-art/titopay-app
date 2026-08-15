"use strict";

// ---------------------------------------------------------------------------
// Security content
//
// The security copy the customer app shows: the "Stay safe with TitoPay" tip
// card, the Security Tips list and the wording on the "Why trust TitoPay?"
// screen. It used to be hard-coded in the PWA, which meant a change of wording
// after a live scam campaign needed a code change and a deploy. It now lives in
// platform_settings so an admin with the "security" permission can rewrite it
// the same day.
//
// The defaults below are the copy that is live today, word for word. Nothing
// about what a customer reads changes until an admin actually edits something,
// so shipping this feature is not itself a copy change.
//
// Two consequences follow from that, and they are the reason for most of the
// code here:
//
//   1. Nothing may ever come back blank. A security warning that renders as an
//      empty card is worse than one that is out of date, so every missing or
//      emptied field falls back to its default rather than to "".
//   2. Nothing may ever fail hard on read. getSecurityContent swallows database
//      trouble and serves the defaults, because a public screen that a signed
//      out person can reach must not 500 when Postgres hiccups. The PWA keeps
//      its own copy of these defaults for the case where it cannot reach us at
//      all.
//
// The stored text is admin-authored and rendered in the customer app, so it is
// escaped at render time (the PWA's esc()). This service caps lengths and
// rejects unknown icons; it does not sanitise HTML, and callers must not treat
// what it returns as safe markup.
// ---------------------------------------------------------------------------

const { AppError } = require("../lib/errors");
const { boundedText } = require("../lib/validation");
const { getPlatformSetting, setPlatformSetting } = require("./platform-settings-service");

const SECURITY_CONTENT_KEY = "security_content";
const MAX_TIPS = 12;

const SECURITY_CONTENT_DEFAULTS = {
  eyebrow: "Security Tip",
  title: "Stay safe with TitoPay",
  cardHeading: "Protect your account",
  cardBody: "Never share your PIN, password or verification codes. TitoPay will never ask for those by phone, email, WhatsApp, SMS or social media.",
  acknowledgeLabel: "I understand",
  tipsEyebrow: "Security Tips",
  tips: [
    { title: "Never share codes", body: "TitoPay will never ask for your PIN, password or OTP, not by phone, SMS, email or WhatsApp.", icon: "lock" },
    { title: "Check before you pay", body: "Read the verified recipient name and the fee preview before you press Confirm.", icon: "check-circle" },
    { title: "Keep contact details current", body: "Your registered cellphone and email are how you recover access.", icon: "mail" },
    { title: "Lock your wallet fast", body: "If something feels wrong, stop everything leaving from the Security Centre. Other people can still pay you.", icon: "shield" },
    { title: "Beware of urgency", body: "Scammers rush you. TitoPay never pressures you to move money.", icon: "bell" },
    { title: "Use your device lock", body: "A device PIN, fingerprint or face unlock protects TitoPay if your phone is lost.", icon: "phone" }
  ]
};

// Exactly the names the PWA's icon() has a drawing for. An icon name it does
// not know renders as the generic grid square, which on a security tip reads as
// a broken app, so anything unrecognised becomes "shield" instead of being
// rejected. That keeps a typo in the admin console from blocking the save of
// wording that may be urgent.
const SECURITY_TIP_ICONS = new Set([
  "wallet", "card-add", "upload", "withdraw", "bank-transfer", "send", "download",
  "chevron-down", "plus", "copy", "qr", "qr-receive", "scan", "sale", "phone",
  "sim-card", "signal", "voice-bundle", "sms-bundle", "data-bundle", "zap",
  "electricity", "tag", "voucher", "gift", "bank", "bill", "bill-pay", "calendar",
  "ticket", "ticketing", "health", "star", "check-circle", "stockvel", "piggy-bank",
  "community-wallet", "learn", "tip", "tip-card", "heart", "scissors", "split-bill",
  "plane", "globe", "lock", "user", "merchant-profile", "contacts", "staff-badge",
  "shield", "home", "grid", "list", "receipt-list", "statement", "invoice", "quote",
  "document-invoice", "payment-request", "message-check", "chat", "chatbot",
  "feedback", "bell", "search", "mail", "paperclip", "share", "arrow-left",
  "arrow-right", "eye", "eye-off", "refresh", "chart", "bank-payout", "refund-card",
  "bulk-distribution", "store", "maintenance", "menu", "more-horizontal", "x", "ban"
]);

const FALLBACK_TIP_ICON = "shield";

// Caps are generous enough that today's copy fits with room to rewrite, and
// tight enough that no single field can push the tip card off a small screen.
const FIELD_LIMITS = {
  eyebrow: 40,
  title: 80,
  cardHeading: 80,
  cardBody: 400,
  acknowledgeLabel: 40,
  tipsEyebrow: 40,
  tipTitle: 80,
  tipBody: 280
};

function normalizeTipIcon(icon) {
  const name = String(icon || "").trim().toLowerCase();
  return SECURITY_TIP_ICONS.has(name) ? name : FALLBACK_TIP_ICON;
}

// Reads never throw on bad stored data. A value that was hand-edited in the
// database, or written by an older shape of this feature, degrades field by
// field to the default rather than taking the whole screen down.
function readText(value, fallback, max) {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  return text.slice(0, max);
}

function readTips(value) {
  if (!Array.isArray(value)) return SECURITY_CONTENT_DEFAULTS.tips;
  const tips = value
    .slice(0, MAX_TIPS)
    .map((tip) => ({
      title: String(tip?.title ?? "").trim().slice(0, FIELD_LIMITS.tipTitle),
      body: String(tip?.body ?? "").trim().slice(0, FIELD_LIMITS.tipBody),
      icon: normalizeTipIcon(tip?.icon)
    }))
    .filter((tip) => tip.title && tip.body);
  return tips.length ? tips : SECURITY_CONTENT_DEFAULTS.tips;
}

function mergeWithDefaults(stored) {
  const value = stored && typeof stored === "object" ? stored : {};
  return {
    eyebrow: readText(value.eyebrow, SECURITY_CONTENT_DEFAULTS.eyebrow, FIELD_LIMITS.eyebrow),
    title: readText(value.title, SECURITY_CONTENT_DEFAULTS.title, FIELD_LIMITS.title),
    cardHeading: readText(value.cardHeading, SECURITY_CONTENT_DEFAULTS.cardHeading, FIELD_LIMITS.cardHeading),
    cardBody: readText(value.cardBody, SECURITY_CONTENT_DEFAULTS.cardBody, FIELD_LIMITS.cardBody),
    acknowledgeLabel: readText(value.acknowledgeLabel, SECURITY_CONTENT_DEFAULTS.acknowledgeLabel, FIELD_LIMITS.acknowledgeLabel),
    tipsEyebrow: readText(value.tipsEyebrow, SECURITY_CONTENT_DEFAULTS.tipsEyebrow, FIELD_LIMITS.tipsEyebrow),
    tips: readTips(value.tips)
  };
}

// fallbackOnError is right for the customer-facing read and wrong for the admin
// one. Serving a customer today's defaults during a database wobble costs
// nothing, because the words are the same. Showing an admin the defaults after
// a failed read is dangerous: they would be looking at a form that appears to
// hold the live copy, and saving it would overwrite whatever was really there.
// The admin console gets the error instead.
async function getSecurityContent({ fallbackOnError = true } = {}) {
  try {
    const setting = await getPlatformSetting(SECURITY_CONTENT_KEY, {});
    return mergeWithDefaults(setting.value);
  } catch (error) {
    if (!fallbackOnError) throw error;
    return mergeWithDefaults(null);
  }
}

// Writes are strict where reads are forgiving. An admin who pastes copy that is
// too long is told so and can shorten it, rather than discovering later that a
// warning was silently cut off mid-sentence. Blanking a field is still allowed
// and means "put the default back".
function normalizeForSave(payload) {
  const value = payload && typeof payload === "object" ? payload : {};
  const text = (field, label) => {
    const trimmed = boundedText(value[field], label, { min: 0, max: FIELD_LIMITS[field] });
    return trimmed || SECURITY_CONTENT_DEFAULTS[field];
  };

  let tips = SECURITY_CONTENT_DEFAULTS.tips;
  if (value.tips !== undefined && value.tips !== null) {
    if (!Array.isArray(value.tips)) throw new AppError(400, "Security tips must be a list");
    if (value.tips.length > MAX_TIPS) throw new AppError(400, `Security tips are limited to ${MAX_TIPS}`);
    const normalized = value.tips
      .map((tip, index) => ({
        title: boundedText(tip?.title, `Security tip ${index + 1} title`, { min: 0, max: FIELD_LIMITS.tipTitle }),
        body: boundedText(tip?.body, `Security tip ${index + 1} body`, { min: 0, max: FIELD_LIMITS.tipBody }),
        icon: normalizeTipIcon(tip?.icon)
      }))
      // A row with nothing in it is how an admin console deletes a tip, so an
      // empty pair is a removal rather than an error. A half-filled row is
      // dropped too: a heading with no advice, or advice with no heading, is
      // not a tip a customer can act on.
      .filter((tip) => tip.title && tip.body);
    if (normalized.length) tips = normalized;
  }

  return {
    eyebrow: text("eyebrow", "Security eyebrow"),
    title: text("title", "Security title"),
    cardHeading: text("cardHeading", "Security card heading"),
    cardBody: text("cardBody", "Security card body"),
    acknowledgeLabel: text("acknowledgeLabel", "Security acknowledge label"),
    tipsEyebrow: text("tipsEyebrow", "Security tips eyebrow"),
    tips
  };
}

async function saveSecurityContent(payload, updatedBy = null) {
  const value = normalizeForSave(payload);
  const saved = await setPlatformSetting(SECURITY_CONTENT_KEY, value, updatedBy || null);
  // Read the stored row back through the same merge the public route uses, so
  // what the admin sees confirmed is exactly what a customer will be served.
  return mergeWithDefaults(saved.value);
}

module.exports = {
  SECURITY_CONTENT_KEY,
  SECURITY_CONTENT_DEFAULTS,
  SECURITY_TIP_ICONS,
  MAX_TIPS,
  getSecurityContent,
  saveSecurityContent
};
