// Organiser verification (FICA) for the PHP test suites: does through the API
// what an organiser's owner and TicketRoom staff do in the portals, so tests
// that publish events or pay out can get past the rules without weakening them.
//   const { verifyOrganiser } = require("./kyc-helper");
//   await verifyOrganiser(orgPage.request, adminPage.request, BASE, orgId, { paid: true });

// A 1x1 PNG and a minimal PDF: real file signatures, tiny bodies.
const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const TINY_PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");

// A valid South African ID number: YYMMDD + 4-digit sequence + citizenship + 8 + Luhn digit.
function saId(dob = "880412", seq = "5123", citizen = "0") {
  const body = `${dob}${seq}${citizen}8`;
  for (let z = 0; z <= 9; z++) {
    const id = body + z;
    let sum = 0;
    for (let i = 0; i < 13; i++) { let d = Number(id[12 - i]); if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; } sum += d; }
    if (sum % 10 === 0) return id;
  }
  throw new Error("no check digit");
}

function client(request, base) {
  let token;
  const call = async (method, url, data, headers = {}) => {
    token ??= (await (await request.get(`${base}/api/auth/me`)).json()).csrfToken;
    const r = await request.fetch(`${base}${url}`, { method, data, headers: { "x-csrf-token": token, ...headers } });
    let body = null; try { body = await r.json(); } catch { /* not JSON */ }
    return { status: r.status(), body };
  };
  return {
    get: (u) => call("GET", u), post: (u, d) => call("POST", u, d ?? {}), put: (u, d) => call("PUT", u, d),
    upload: (u, buf, type = "image/png") => call("POST", u, buf, { "content-type": type, "x-file-name": "test-document" }),
  };
}

async function must(r, what) {
  if (r.status >= 300) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

// Identity details, signed terms and an ID document (plus, with paid: proof of
// address, bank details if none are on file, and a bank confirmation letter);
// then staff approve every document of this organiser that is waiting.
async function verifyOrganiser(orgRequest, adminRequest, base, orgId, { paid = false, legalName = "Naledi Dlamini", idNumber = saId(), bank = null } = {}) {
  const o = client(orgRequest, base);
  const a = client(adminRequest, base);
  const v = (await must(await o.get(`/api/organiser/${orgId}/verification`), "read verification")).verification;
  if (v.profile.entityType !== "individual" || !v.profile.hasIdNumber || (paid && !v.profile.plansPaid && !v.sellsPaid)) {
    await must(await o.put(`/api/organiser/${orgId}/verification/profile`, { entityType: "individual", nationality: "sa", legalName, idNumber, plansPaid: paid || v.profile.plansPaid }), "save identity details");
  }
  if (!v.requirements.find((i) => i.key === "terms" && i.status === "approved")) {
    await must(await o.post(`/api/organiser/${orgId}/verification/terms`, { fullName: legalName, accept: true }), "sign terms");
  }
  const needs = (await must(await o.get(`/api/organiser/${orgId}/verification`), "read verification")).verification;
  if (paid && !needs.bank.last4) {
    await must(await o.put(`/api/organiser/${orgId}/bank`, bank || { bankName: "FNB", accountHolder: legalName, accountNumber: "62812345678", branchCode: "250655" }), "bank details");
  }
  for (const it of needs.requirements) {
    if (it.kind !== "document" || ["approved", "submitted"].includes(it.status)) continue;
    await must(await o.upload(`/api/organiser/${orgId}/verification/documents?requirement=${it.key}`, it.key === "id_document" ? TINY_PNG : TINY_PDF, it.key === "id_document" ? "image/png" : "application/pdf"), `upload ${it.key}`);
  }
  const queue = (await must(await a.get("/api/admin/verification"), "review queue")).documents.filter((d) => d.organiser_id === orgId && !d.event_id);
  for (const d of queue) await must(await a.post(`/api/admin/verification/documents/${d.id}/decide`, { approve: true }), `approve ${d.requirement}`);
  return (await must(await o.get(`/api/organiser/${orgId}/verification`), "read verification")).verification;
}

module.exports = { verifyOrganiser, saId, client, TINY_PNG, TINY_PDF };
