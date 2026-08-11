"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const { pwaFile } = require("./pwa-path");

test("beneficiary schema enforces ownership, uniqueness and soft-delete indexes", () => {
  const schema = read("src/db/schema.sql");
  assert.match(schema, /CREATE TABLE IF NOT EXISTS beneficiaries/);
  assert.match(schema, /owner_user_id UUID NOT NULL REFERENCES users/);
  assert.match(schema, /UNIQUE \(owner_user_id, beneficiary_user_id\)/);
  assert.match(schema, /WHERE deleted_at IS NULL AND disabled_at IS NULL/);
});

test("customer beneficiary routes are authenticated and ownership-scoped", () => {
  const routes = read("src/routes/beneficiaries.routes.js");
  const service = read("src/services/beneficiary-service.js");
  assert.match(routes, /router\.use\(requireAuth\)/);
  assert.match(routes, /router\.get\("\/search"/);
  assert.match(routes, /router\.post\("\/"/);
  assert.match(routes, /router\.patch\("\/:id"/);
  assert.match(routes, /router\.delete\("\/:id"/);
  assert.match(service, /b\.owner_user_id = \$1 AND b\.deleted_at IS NULL/);
  assert.match(service, /owner_user_id=\$2 AND deleted_at IS NULL/);
});

test("beneficiary maintenance cannot move money and payment recording only updates metadata", () => {
  const service = read("src/services/beneficiary-service.js");
  assert.doesNotMatch(service, /UPDATE wallets|INSERT INTO transactions|balance\s*=/i);
  assert.match(service, /SET last_paid_at=NOW\(\), last_payment_amount=\$3/);
});

test("admin management is Super Admin-only and disable-only", () => {
  const routes = read("src/routes/admin.routes.js");
  assert.match(routes, /router\.get\("\/beneficiaries", requireSuperAdmin/);
  assert.match(routes, /router\.post\("\/beneficiaries\/:id\/disable", requireSuperAdmin/);
  assert.doesNotMatch(routes, /router\.(?:put|patch|delete)\("\/beneficiaries/);
});

test("completed wallet transfers only refresh existing beneficiary recency metadata", () => {
  const transactions = read("src/services/transaction-service.js");
  assert.match(transactions, /recordBeneficiaryPayment\(/);
  assert.match(transactions, /recipientWallet\?\.user_id/);
});

test("saved beneficiaries remain payable by username or wallet number", () => {
  const security = read("src/services/security-service.js");
  const transactions = read("src/services/transaction-service.js");
  assert.match(security, /LOWER\(COALESCE\(w\.wallet_number, ''\)\) = ANY/);
  assert.match(transactions, /LOWER\(COALESCE\(w\.wallet_number, ''\)\) = ANY/);
});

test("PWA beneficiary management supports bank-style ordering, search and safe removal", () => {
  const app = fs.readFileSync(pwaFile("app.js"), "utf8");
  assert.match(app, /\/v1\/beneficiaries\?limit=100/);
  assert.match(app, /new Date\(b\.lastPaidAt \|\| b\.last_paid_at \|\| 0\)/);
  assert.match(app, /No beneficiaries match your search/);
  assert.match(app, /No money will move and past transactions will remain in Activity/);
  assert.match(app, /setButtonBusy\(actionElement, true\)/);
});
