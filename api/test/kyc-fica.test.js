"use strict";

// FICA SUBMISSION WORKS — FOR PERSONAL AND BUSINESS — AND BUSINESS INCLUDES CIPC.
//
// The PWA's FICA modal used to send the select's human label ("South African
// ID") as documentType. The server's enum check refused it, so EVERY submission
// — personal and business alike — failed with "Document type is invalid".
// These tests drive the real HTTP endpoint with real sessions against the real
// database and hold it to the fixed contract:
//   - a personal account can submit (identity_document category + kind in
//     metadata)
//   - a business account MUST attach CIPC company registration documents, and
//     can submit once it does
//   - the old broken payload stays refused, so the enum is still enforced.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { app } = require("../src/app");
const { pool } = require("../src/db/pool");
const { signAccessToken } = require("../src/lib/jwt");

const TAG = "ficakyc";
const personal = { id: randomUUID(), session: randomUUID(), jti: randomUUID() };
const business = { id: randomUUID(), session: randomUUID(), jti: randomUUID() };

async function seedUser(user, accountType, suffix) {
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
     VALUES ($1,$2,$3,$4,$5,$6,'x','active',FALSE,'pending')`,
    [user.id, accountType, `${TAG} ${suffix}`, `${TAG}_${suffix}`, `${TAG}_${suffix}@example.invalid`, `2711000${Math.floor(1000 + Math.random() * 8999)}`]
  );
  await pool.query(
    `INSERT INTO sessions (id, user_type, user_id, scope, refresh_token_hash, access_jti, expires_at)
     VALUES ($1,'customer',$2,'customer','x',$3, NOW() + INTERVAL '1 hour')`,
    [user.session, user.id, user.jti]
  );
  user.token = signAccessToken({ sub: user.id, sid: user.session, jti: user.jti, typ: "customer" });
}

async function cleanup() {
  for (const u of [personal, business]) {
    await pool.query("DELETE FROM kyc_reviews WHERE user_id = $1", [u.id]).catch(() => {});
    await pool.query("DELETE FROM audit_logs WHERE actor_id = $1", [u.id]).catch(() => {});
    await pool.query("DELETE FROM sessions WHERE user_id = $1", [u.id]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id = $1", [u.id]).catch(() => {});
  }
}

test.before(async () => {
  await cleanup();
  await seedUser(personal, "personal", "person");
  await seedUser(business, "business", "company");
});
test.after(async () => { await cleanup(); await pool.end(); });

async function withServer(run) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function post(baseUrl, token, body) {
  return fetch(`${baseUrl}/v1/kyc/fica`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
}

test("a PERSONAL account can submit FICA, and the old broken payload stays refused", async () => {
  await withServer(async (baseUrl) => {
    // The exact payload the PWA used to send: the human label as documentType.
    // It must still be refused — the enum is the contract.
    const broken = await post(baseUrl, personal.token, {
      documentType: "South African ID",
      documentReference: "id.pdf"
    });
    assert.equal(broken.status, 400, "the human label is not a document category");

    // Missing the typed ID number and address: refused with a clear reason.
    const noNumber = await post(baseUrl, personal.token, {
      documentType: "identity_document",
      documentReference: "id.pdf",
      metadata: { identityKind: "South African ID", identityDocument: { name: "id.pdf", size: 1234, type: "application/pdf" } }
    });
    assert.equal(noNumber.status, 400, "an identity submission without the typed ID number is refused");

    // The fixed payload: category + kind + typed identifiers in metadata.
    const response = await post(baseUrl, personal.token, {
      documentType: "identity_document",
      documentReference: "id.pdf",
      metadata: {
        identityKind: "South African ID",
        idNumber: "8001015009087",
        address: "12 Test Street, Johannesburg, 2000",
        identityDocument: { name: "id.pdf", size: 1234, type: "application/pdf" },
        proofOfAddress: { name: "address.pdf", size: 2222, type: "application/pdf" },
        companyRegistration: null
      }
    });
    assert.equal(response.status, 201, `personal FICA submission should succeed, got ${response.status}`);
    const payload = await response.json();
    assert.equal(payload.ficaStatus, "submitted");
    const { rows } = await pool.query("SELECT status, notes FROM kyc_reviews WHERE user_id = $1", [personal.id]);
    assert.equal(rows.length, 1, "one review row is created");
    assert.equal(rows[0].status, "pending");
    const notes = JSON.parse(rows[0].notes);
    assert.equal(notes.documentType, "identity_document");
    assert.equal(notes.metadata.identityKind, "South African ID", "the chosen kind is preserved for the reviewer");
    assert.equal(notes.metadata.idNumber, "8001015009087", "the typed ID number is on the review");
    assert.equal(notes.metadata.address, "12 Test Street, Johannesburg, 2000", "the typed address is on the review");
  });
});

test("a BUSINESS account is refused without CIPC documents, and succeeds with them", async () => {
  await withServer(async (baseUrl) => {
    // Without CIPC company registration documents: refused with a clear reason.
    const missing = await post(baseUrl, business.token, {
      documentType: "identity_document",
      documentReference: "director-id.pdf",
      metadata: { identityKind: "Passport", idNumber: "AB1234567", address: "1 Factory Road, Pretoria, 0001", companyRegistrationNumber: "2020/123456/07", identityDocument: { name: "director-id.pdf", size: 999, type: "application/pdf" } }
    });
    assert.equal(missing.status, 400);
    const missingBody = await missing.json();
    assert.match(String(missingBody.error || ""), /CIPC company registration/i,
      "the error names exactly what is missing");

    // With CIPC documents attached: accepted, and the reviewer can see them.
    const response = await post(baseUrl, business.token, {
      documentType: "identity_document",
      documentReference: "director-id.pdf",
      metadata: {
        identityKind: "Passport",
        idNumber: "AB1234567",
        address: "1 Factory Road, Pretoria, 0001",
        companyRegistrationNumber: "2020/123456/07",
        identityDocument: { name: "director-id.pdf", size: 999, type: "application/pdf" },
        proofOfAddress: { name: "premises.pdf", size: 500, type: "application/pdf" },
        companyRegistration: { name: "cipc-cor14.3.pdf", size: 4321, type: "application/pdf" }
      }
    });
    assert.equal(response.status, 201, `business FICA submission should succeed, got ${response.status}`);
    const payload = await response.json();
    assert.equal(payload.ficaStatus, "submitted");
    const { rows } = await pool.query("SELECT notes FROM kyc_reviews WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1", [business.id]);
    const notes = JSON.parse(rows[0].notes);
    assert.equal(notes.metadata.companyRegistration.name, "cipc-cor14.3.pdf",
      "the CIPC document is recorded on the review for the compliance team");
    assert.equal(notes.metadata.companyRegistrationNumber, "2020/123456/07",
      "the typed registration number is on the review");
    const { rows: userRows } = await pool.query("SELECT fica_status FROM users WHERE id = $1", [business.id]);
    assert.equal(userRows[0].fica_status, "submitted", "the business account moves to submitted");
  });
});

test("the PWA sends the fixed payload shape", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { pwaFile } = require("./pwa-path");
  const source = fs.readFileSync(pwaFile("app.js"), "utf8");
  const fn = source.match(/async function submitFica\([\s\S]*?\n\}/)[0];
  assert.match(fn, /documentType: "identity_document"/, "the PWA sends the category, not the human label");
  assert.match(fn, /identityKind: data\.get\("identityKind"\)/, "the chosen kind travels in metadata");
  assert.match(fn, /companyRegistration/, "business submissions carry the CIPC document");
  assert.match(fn, /Upload your CIPC company registration documents/, "the client explains the missing CIPC file before posting");
  // And the form itself offers the CIPC input to business accounts only.
  assert.match(source, /\$\{isBusiness \? `\s*\n\s*<div class="field"><label>CIPC company registration documents<\/label>/,
    "the CIPC upload is rendered for business accounts");
});
