const { config } = require("../config/env");
const { AppError } = require("../lib/errors");

const COUNTRY_HEADERS = [
  "cf-ipcountry",
  "x-country-code",
  "x-vercel-ip-country",
  "cloudfront-viewer-country",
  "x-appengine-country"
];

function requestCountry(req) {
  const headers = [config.customerRegistration.countryHeader, ...COUNTRY_HEADERS];
  for (const header of headers) {
    const value = req.get(header);
    if (value && value !== "XX") return String(value).trim().toUpperCase();
  }
  return "";
}

function requireAllowedRegistrationCountry(req, _res, next) {
  if (!config.customerRegistration.geoLockEnabled) {
    next();
    return;
  }

  const country = requestCountry(req);
  if (country && config.customerRegistration.allowedCountries.includes(country)) {
    next();
    return;
  }

  next(new AppError(403, "TitoPay registration is currently available to South African users only.", {
    country: country || "unknown",
    allowedCountries: config.customerRegistration.allowedCountries
  }));
}

module.exports = { requireAllowedRegistrationCountry, requestCountry };
