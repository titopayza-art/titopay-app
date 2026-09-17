"use strict";

const { AppError } = require("./errors");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireUuid(value, label = "ID") {
  const text = String(value || "").trim();
  if (!UUID_PATTERN.test(text)) {
    throw new AppError(400, `${label} is invalid`);
  }
  return text;
}

function requireEnum(value, allowedValues, label = "Value") {
  const text = String(value || "").trim().toLowerCase();
  if (!allowedValues.includes(text)) {
    throw new AppError(400, `${label} is invalid`);
  }
  return text;
}

function boundedText(value, label, { min = 0, max = 500 } = {}) {
  const text = String(value || "").trim();
  if (text.length < min) throw new AppError(400, `${label} is required`);
  if (text.length > max) throw new AppError(400, `${label} is too long`);
  return text;
}

module.exports = {
  boundedText,
  requireEnum,
  requireUuid
};
