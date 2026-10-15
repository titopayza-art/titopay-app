// Shared environment for the TitoPay browser harnesses.
//
// Every harness drives the real app in Chromium against a mocked TitoPay API,
// so nothing here ever touches production and no request leaves the machine.
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const CATALOGUE = path.join(ROOT, "services-default.json");
const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:8899";

// CI installs its own Chromium; a sandboxed container may pin one via
// PLAYWRIGHT_BROWSERS_PATH. Honour an explicit path when given, otherwise let
// Playwright resolve its own download.
function launchOptions() {
  const options = { args: ["--no-sandbox"] };
  if (process.env.CHROMIUM_PATH) options.executablePath = process.env.CHROMIUM_PATH;
  return options;
}

module.exports = { ROOT, CATALOGUE, BASE_URL, launchOptions };
