"use strict";

const { POSProviderAdapter } = require("./base");

const providers = new Map(
  ["STANDARD_BANK", "ABSA", "NEDBANK", "CAPITEC", "OTHER"]
    .map((provider) => [provider, new POSProviderAdapter(provider)])
);

function providerAdapter(provider) {
  return providers.get(String(provider || "").toUpperCase()) || providers.get("OTHER");
}

module.exports = { providerAdapter, POSProviderAdapter };
