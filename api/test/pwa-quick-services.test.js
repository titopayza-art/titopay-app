"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { pwaDir } = require("./pwa-path");
const appRoot = pwaDir();
const read = (file) => fs.readFileSync(path.join(appRoot, file), "utf8");

test("Personal and Business Quick Services are independently account-scoped", () => {
  const app = read("app.js");
  assert.match(app, /QUICK_SERVICES_STORAGE_PREFIX = "titopay_quick_services_v1"/);
  assert.match(app, /QUICK_SERVICES_LIMIT = 6/);
  assert.match(app, /`\$\{QUICK_SERVICES_STORAGE_PREFIX\}:\$\{state\.accountType\}:\$\{identity\}`/);
  assert.match(app, /Personal and Business layouts are saved separately/);
});

test("customers can select, reorder, reset and save Quick Services", () => {
  const app = read("app.js");
  assert.match(app, /data-action="customize-quick-services"/);
  assert.match(app, /data-quick-service-toggle/);
  assert.match(app, /data-quick-service-move="up"/);
  assert.match(app, /data-quick-service-move="down"/);
  assert.match(app, /action === "save-quick-services"/);
  assert.match(app, /action === "reset-quick-services"/);
  assert.match(app, /writeJson\(quickServiceStorageKey\(\), selected\)/);
  assert.match(app, /Choose at least one Quick Service/);
  assert.match(app, /Choose up to \$\{QUICK_SERVICES_LIMIT\} Quick Services/);
});

test("saved Quick Services drive the Home grid and remain limited to active services", () => {
  const app = read("app.js");
  assert.match(app, /function quickServiceCandidates\(\)/);
  assert.match(app, /hideDuplicateAirtimeDataTiles\(activeServices\(\)\)/);
  assert.match(app, /function homeQuickServices\(\)/);
  assert.match(app, /saved\.map\(\(id\) => byId\.get\(id\)\)\.filter\(Boolean\)/);
  assert.match(app, /quickServices\.map\(\(service\) => serviceTile\(service, true\)\)/);
});

test("login alerts use the Notification Centre and an allowed device notification", () => {
  const app = read("app.js");
  const worker = read("service-worker.js");
  assert.match(app, /item\.notification_type === "login_notification"/);
  assert.match(app, /Notification\.permission !== "granted"/);
  assert.match(app, /registration\.showNotification/);
  assert.match(worker, /notificationclick/);
  assert.match(worker, /clients\.openWindow\(destination\)/);
});
