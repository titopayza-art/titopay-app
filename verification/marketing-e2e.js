// MARKETING & SALES COMMAND CENTRE — end to end.
//
// Two questions this has to answer, in order of importance:
//   1. Does the new module work?
//   2. Is anything that existed before it still exactly as it was?
//
// The second is checked first and last, because a marketing feature that breaks
// a payment is not a feature.
const { Client } = require("./api/node_modules/pg");
const fs = require("fs");

const API = `http://127.0.0.1:${Number(process.argv[2] || 8110)}/v1`;
const stamp = Date.now();
const POSTGRES_URL = process.env.POSTGRES_URL
  || fs.readFileSync(`${__dirname}/local.env`, "utf8").match(/^POSTGRES_URL=(.*)$/m)[1];

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
function section(title) { console.log(`\n--- ${title} ---`); }

async function call(path, { method = "GET", body, token, headers = {} } = {}) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: r.status, payload: await r.json().catch(() => ({})) };
}

(async () => {
  console.log(`\n${"=".repeat(78)}`);
  console.log("  MARKETING & SALES COMMAND CENTRE");
  console.log(`${"=".repeat(78)}`);

  const db = new Client({ connectionString: POSTGRES_URL });
  await db.connect();

  const admin = (await call("/admin/login", {
    method: "POST", body: { identifier: "e2e@titopay.local", password: "LocalE2E!Passw0rd#2026" }
  })).payload;
  const token = admin.accessToken;
  check("admin signed in", Boolean(token));

  /* ============================================ existing system still there */
  section("0. Nothing that existed before was disturbed");
  for (const [path, label] of [
    ["/admin/marketing/announcements", "announcements"],
    ["/admin/marketing/sms-campaigns", "SMS campaigns"],
    ["/admin/marketing/email-campaigns", "email campaigns"],
    ["/admin/marketing/reviews", "customer care reviews"]
  ]) {
    const r = await call(path, { token });
    check(`the existing ${label} endpoint still answers`, r.status === 200, `HTTP ${r.status}`);
  }
  const walletsBefore = await db.query("SELECT COUNT(*)::int n, COALESCE(SUM(available_balance),0) t FROM wallets");

  /* ================================================================ audiences */
  section("1. Audiences are materialised, not scanned on every page load");
  const audience = await call("/admin/marketing/audiences", {
    method: "POST", token,
    body: { name: `New users ${stamp}`, preset: "new_users", definition: { days: 30 } }
  });
  check("audience created", audience.status === 201, `HTTP ${audience.status}`);
  const audienceId = audience.payload.audience?.id;

  const built = await call(`/admin/marketing/audiences/${audienceId}/build`, { method: "POST", token });
  check("audience builds and reports a size", built.status === 200 && typeof built.payload.size === "number",
    `${built.payload.size} member(s)`);

  const members = await db.query(
    "SELECT COUNT(*)::int n FROM marketing_audience_members WHERE audience_id=$1", [audienceId]);
  check("membership is stored, so the dashboard reads a table not the user base",
    members.rows[0].n === built.payload.size, `${members.rows[0].n} rows`);

  // The parameter-numbering bug class: a preset that takes a bound value must
  // actually use it, not silently segment on the audience id.
  const narrow = await call("/admin/marketing/audiences", {
    method: "POST", token, body: { name: `Very new ${stamp}`, preset: "new_users", definition: { days: 1 } } });
  const narrowBuilt = await call(`/admin/marketing/audiences/${narrow.payload.audience.id}/build`,
    { method: "POST", token });
  check("a tighter rule produces a smaller or equal audience",
    narrowBuilt.payload.size <= built.payload.size,
    `30 days = ${built.payload.size}, 1 day = ${narrowBuilt.payload.size}`);

  /* ================================================================ campaigns */
  section("2. Campaigns, budgets and the status machine");
  const campaign = await call("/admin/marketing/campaigns", {
    method: "POST", token,
    body: { name: `Winter acquisition ${stamp}`, type: "acquisition", objective: "Grow wallet signups",
      audienceId, channels: ["push", "email"], budget: 20000 }
  });
  check("campaign created as a draft", campaign.status === 201 && campaign.payload.campaign.status === "draft",
    `HTTP ${campaign.status}`);
  const campaignId = campaign.payload.campaign?.id;

  const badJump = await call(`/admin/marketing/campaigns/${campaignId}`, {
    method: "PATCH", token, body: { status: "completed" } });
  check("a draft cannot jump straight to completed", badJump.status === 409, `HTTP ${badJump.status}`);

  const activated = await call(`/admin/marketing/campaigns/${campaignId}`, {
    method: "PATCH", token, body: { status: "active" } });
  check("draft -> active is allowed", activated.status === 200 && activated.payload.campaign.status === "active");

  await call(`/admin/marketing/campaigns/${campaignId}/spend`, {
    method: "POST", token, body: { amount: 15500, description: "Radio spots" } });
  const spent = await call(`/admin/marketing/campaigns/${campaignId}`, { token });
  check("spend is tracked against the budget",
    spent.payload.campaign.budget.spent === 15500 && spent.payload.campaign.budget.remaining === 4500,
    `spent R${spent.payload.campaign.budget.spent}, left R${spent.payload.campaign.budget.remaining}`);
  check("crossing 75% of budget raises a warning",
    spent.payload.campaign.budget.warning === "75% of budget used",
    String(spent.payload.campaign.budget.warning));

  await call(`/admin/marketing/campaigns/${campaignId}/spend`, {
    method: "POST", token, body: { amount: 3500, description: "Print" } });
  const nearLimit = await call(`/admin/marketing/campaigns/${campaignId}`, { token });
  check("crossing 90% escalates the warning",
    nearLimit.payload.campaign.budget.warning === "90% of budget used",
    String(nearLimit.payload.campaign.budget.warning));

  /* =============================================================== promotions */
  section("3. Promotions — the money-shaped part");
  const uncapped = await call("/admin/marketing/promotions", {
    method: "POST", token,
    body: { code: `PCT${stamp}`, name: "Uncapped percentage", benefitType: "percentage_discount",
      benefitPercentage: 10 } });
  check("a percentage promotion with no cap is refused", uncapped.status === 400,
    String(uncapped.payload.error || "").slice(0, 70));

  const promo = await call("/admin/marketing/promotions", {
    method: "POST", token,
    body: { code: `WINTER${stamp}`, name: "Winter R25 off", campaignId,
      benefitType: "fixed_discount", benefitValue: 25, minTransaction: 100,
      usageLimit: 3, perUserLimit: 1, budgetTotal: 75 } });
  check("promotion created", promo.status === 201, `HTTP ${promo.status}`);
  const promoCode = promo.payload.promotion?.code;

  const dup = await call("/admin/marketing/promotions", {
    method: "POST", token,
    body: { code: promoCode, name: "Clash", benefitType: "fixed_discount", benefitValue: 5 } });
  check("a duplicate coupon code is refused", dup.status === 409, `HTTP ${dup.status}`);

  // A real customer to grant against.
  const customer = {
    fullName: "Promo Tester", email: `promo${stamp}@titopay.local`,
    phone: `+2768${String(stamp).slice(-7)}`, password: "PromoTest!2026#x", accountType: "personal"
  };
  await call("/auth/register", { method: "POST", body: customer });
  const login = await call("/auth/login", { method: "POST", body: { identifier: customer.email, password: customer.password } });
  const userId = login.payload.user?.id
    || (await db.query("SELECT id FROM users WHERE LOWER(email)=LOWER($1)", [customer.email])).rows[0].id;

  const inactive = await call("/admin/marketing/promotions/grant", {
    method: "POST", token, headers: { "idempotency-key": `k1-${stamp}` },
    body: { code: promoCode, userId, transactionAmount: 500 } });
  check("a draft promotion cannot be granted", inactive.status === 409, `HTTP ${inactive.status}`);

  await call(`/admin/marketing/promotions/${promo.payload.promotion.id}`, {
    method: "PATCH", token, body: { status: "active" } });

  const tooSmall = await call("/admin/marketing/promotions/grant", {
    method: "POST", token, headers: { "idempotency-key": `k2-${stamp}` },
    body: { code: promoCode, userId, transactionAmount: 50 } });
  check("below the minimum transaction it is refused", tooSmall.status === 409,
    String(tooSmall.payload.error || "").slice(0, 60));

  const granted = await call("/admin/marketing/promotions/grant", {
    method: "POST", token, headers: { "idempotency-key": `k3-${stamp}` },
    body: { code: promoCode, userId, transactionAmount: 500 } });
  check("a valid grant records R25", granted.status === 201 && granted.payload.benefitAmount === 25,
    `R${granted.payload.benefitAmount}`);

  const replay = await call("/admin/marketing/promotions/grant", {
    method: "POST", token, headers: { "idempotency-key": `k3-${stamp}` },
    body: { code: promoCode, userId, transactionAmount: 500 } });
  check("REPLAYING THE SAME KEY DOES NOT GRANT TWICE",
    replay.status === 200 && replay.payload.replay === true
      && replay.payload.redemptionId === granted.payload.redemptionId,
    `replay=${replay.payload.replay}`);

  const secondForUser = await call("/admin/marketing/promotions/grant", {
    method: "POST", token, headers: { "idempotency-key": `k4-${stamp}` },
    body: { code: promoCode, userId, transactionAmount: 500 } });
  check("the per-user limit of 1 is enforced", secondForUser.status === 409,
    String(secondForUser.payload.error || "").slice(0, 50));

  // Concurrency: two grants for two different customers at the same instant,
  // against a promotion with a budget that only covers two more.
  const others = [];
  for (let i = 0; i < 4; i += 1) {
    const u = { fullName: `Race ${i}`, email: `race${i}${stamp}@titopay.local`,
      phone: `+2767${String(stamp).slice(-5)}${String(i).padStart(2, "0")}`,
      password: "RaceTest!2026#x", accountType: "personal" };
    await call("/auth/register", { method: "POST", body: u });
    const row = await db.query("SELECT id FROM users WHERE LOWER(email)=LOWER($1)", [u.email]);
    others.push(row.rows[0].id);
  }
  const raced = await Promise.all(others.map((id, i) =>
    call("/admin/marketing/promotions/grant", {
      method: "POST", token, headers: { "idempotency-key": `race-${i}-${stamp}` },
      body: { code: promoCode, userId: id, transactionAmount: 500 } })));
  const succeeded = raced.filter((r) => r.status === 201).length;
  const totalGranted = await db.query(
    "SELECT COUNT(*)::int n, COALESCE(SUM(benefit_amount),0) t FROM marketing_promo_redemptions WHERE promotion_id=$1",
    [promo.payload.promotion.id]);
  check("USAGE LIMIT HOLDS UNDER CONCURRENT GRANTS",
    totalGranted.rows[0].n === 3,
    `${succeeded} of 4 concurrent grants accepted, ${totalGranted.rows[0].n} redemptions total (limit 3)`);
  check("the promotion budget was never exceeded",
    Number(totalGranted.rows[0].t) <= 75, `R${totalGranted.rows[0].t} of R75`);

  const exhausted = await call("/admin/marketing/promotions", { token });
  const thisPromo = exhausted.payload.items.find((p) => p.code === promoCode);
  check("a fully claimed promotion marks itself exhausted", thisPromo.status === "exhausted",
    thisPromo.status);

  /* ============================================================ leads and CRM */
  section("4. Leads, pipeline and activity history");
  const lead = await call("/admin/marketing/leads", {
    method: "POST", token,
    body: { businessName: `Spaza ${stamp}`, contactName: "Thandi M", email: `lead${stamp}@example.co.za`,
      businessCategory: "retail", location: "Soweto", source: "field_sales", expectedRevenue: 12000,
      campaignId } });
  check("lead created with a reference", lead.status === 201 && /^LEAD-/.test(lead.payload.lead.reference),
    lead.payload.lead?.reference);
  const leadId = lead.payload.lead?.id;

  const moved = await call(`/admin/marketing/leads/${leadId}`, {
    method: "PATCH", token, body: { status: "qualified", note: "Owner keen, needs a card machine" } });
  check("lead status moves", moved.payload.lead?.status === "qualified", moved.payload.lead?.status);

  const withHistory = await call(`/admin/marketing/leads/${leadId}`, { token });
  const statusChange = withHistory.payload.lead.activities.find((a) => a.type === "status_change");
  check("the status change is in the activity history",
    Boolean(statusChange) && statusChange.fromStatus === "new" && statusChange.toStatus === "qualified",
    `${statusChange?.fromStatus} -> ${statusChange?.toStatus}`);

  const lostNoReason = await call(`/admin/marketing/leads/${leadId}`, {
    method: "PATCH", token, body: { status: "lost" } });
  check("marking a lead lost requires a reason", lostNoReason.status === 400, `HTTP ${lostNoReason.status}`);

  const pipeline = await call("/admin/marketing/sales-pipeline", { token });
  const qualifiedStage = pipeline.payload.stages.find((s) => s.stage === "qualified");
  check("the pipeline counts and values the stage", qualifiedStage.count >= 1 && qualifiedStage.value >= 12000,
    `${qualifiedStage.count} lead(s), R${qualifiedStage.value}`);

  /* ============================================================ links & safety */
  section("5. Trackable links cannot become an open redirect");
  const evil = await call("/admin/marketing/links", {
    method: "POST", token, body: { label: "Phish", destinationUrl: "https://evil.example.com/login" } });
  check("a foreign destination is refused", evil.status === 400,
    String(evil.payload.error || "").slice(0, 60));

  const sneaky = await call("/admin/marketing/links", {
    method: "POST", token,
    body: { label: "Disguised", destinationUrl: "https://titopay.co.za@evil.example.com/" } });
  check("a userinfo-disguised host is refused", sneaky.status === 400,
    String(sneaky.payload.error || "").slice(0, 60));

  const insecure = await call("/admin/marketing/links", {
    method: "POST", token, body: { label: "Plain", destinationUrl: "http://titopay.co.za/join" } });
  check("a non-https destination is refused", insecure.status === 400, `HTTP ${insecure.status}`);

  const goodLink = await call("/admin/marketing/links", {
    method: "POST", token,
    body: { label: "Merchant onboarding", destinationUrl: "https://titopay.co.za/merchant/apply",
      campaignId, linkType: "merchant_onboarding", source: "field", medium: "qr" } });
  check("a TitoPay destination is accepted and given a slug",
    goodLink.status === 201 && /^[a-z0-9]{8}$/.test(goodLink.payload.link.slug),
    goodLink.payload.link?.slug);

  /* ============================================================== experiments */
  section("6. Experiments assign a customer once and never move them");
  const badSplit = await call("/admin/marketing/experiments", {
    method: "POST", token,
    body: { name: "Bad split", variants: [{ name: "A", allocationPercent: 60 }, { name: "B", allocationPercent: 60 }] } });
  check("allocations that do not total 100% are refused", badSplit.status === 400,
    String(badSplit.payload.error || "").slice(0, 60));

  const experiment = await call("/admin/marketing/experiments", {
    method: "POST", token,
    body: { name: `Referral bonus ${stamp}`, hypothesis: "R20 converts better than R10",
      variants: [{ name: "R10", allocationPercent: 50, cost: 10 },
        { name: "R20", allocationPercent: 50, cost: 20 }] } });
  check("experiment created with two variants",
    experiment.status === 201 && experiment.payload.experiment.variants.length === 2);

  const experimentId = experiment.payload.experiment.id;
  await db.query("UPDATE marketing_experiments SET status='running' WHERE id=$1", [experimentId]);
  const sales = require("./api/src/services/marketing-sales-service");
  const first = await sales.assignExperimentVariant(experimentId, userId);
  const second = await sales.assignExperimentVariant(experimentId, userId);
  check("THE SAME CUSTOMER IS NEVER MOVED BETWEEN OFFERS",
    first.variantId === second.variantId && second.existing === true,
    `${first.variantName} then ${second.variantName}`);

  const assignments = await db.query(
    "SELECT COUNT(*)::int n FROM marketing_experiment_assignments WHERE experiment_id=$1", [experimentId]);
  check("only one assignment row exists for them", assignments.rows[0].n === 1, `${assignments.rows[0].n} row(s)`);

  /* ========================================================= analytics and ROI */
  section("7. Analytics and ROI report only what the data supports");
  const overview = await call("/admin/marketing/overview?range=30d", { token });
  check("overview responds with cards and charts",
    overview.status === 200 && overview.payload.cards && overview.payload.charts,
    `spend R${overview.payload.cards?.marketingSpend}`);
  check("marketing spend on the overview matches what was recorded",
    overview.payload.cards.marketingSpend >= 19000, `R${overview.payload.cards.marketingSpend}`);
  check("direct, assisted and estimated revenue are separate numbers",
    "revenueAttributed" in overview.payload.cards && "revenueAssisted" in overview.payload.cards
      && "revenueEstimated" in overview.payload.cards);

  const roi = await call("/admin/marketing/roi?range=30d", { token });
  const thisRoi = roi.payload.items.find((r) => r.campaignId === campaignId);
  check("ROI shows the cost that was recorded", thisRoi.marketingCost === 19000, `R${thisRoi.marketingCost}`);
  check("ROI is negative, not invented, when no revenue is attributed",
    thisRoi.directRevenue === 0 && thisRoi.roiPercent === -100,
    `revenue R${thisRoi.directRevenue}, ROI ${thisRoi.roiPercent}%`);

  const funnel = await call("/admin/marketing/analytics?range=30d", { token });
  check("the merchant funnel never widens as it descends",
    funnel.payload.funnels.merchant.every((step, i, arr) => i === 0 || step.value <= arr[i - 1].value),
    funnel.payload.funnels.merchant.map((s) => s.value).join(" >= "));
  check("acquisition cost states its own caveat",
    typeof funnel.payload.acquisition.caveat === "string" && funnel.payload.acquisition.caveat.length > 20);

  /* ==================================================================== RBAC */
  section("8. Permissions are enforced server-side");
  const noAuth = await call("/admin/marketing/campaigns");
  check("an unauthenticated request is refused", noAuth.status === 401, `HTTP ${noAuth.status}`);

  const customerToken = login.payload.accessToken;
  const asCustomer = await call("/admin/marketing/campaigns", { token: customerToken });
  check("a CUSTOMER token cannot reach the admin marketing API",
    asCustomer.status === 403 || asCustomer.status === 401, `HTTP ${asCustomer.status}`);

  const leakCheck = await call("/admin/marketing/referrals", { token });
  const leaked = JSON.stringify(leakCheck.payload).match(/@[a-z0-9.-]+\.(com|za|local)/i);
  check("the referral list exposes no email addresses", !leaked, leaked ? leaked[0] : "none");

  /* ======================================== nothing financial moved, at all */
  section("9. The fintech core is untouched");
  const walletsAfter = await db.query("SELECT COUNT(*)::int n, COALESCE(SUM(available_balance),0) t FROM wallets");
  check("NO WALLET BALANCE CHANGED ANYWHERE",
    Number(walletsAfter.rows[0].t) === Number(walletsBefore.rows[0].t),
    `R${walletsBefore.rows[0].t} -> R${walletsAfter.rows[0].t}`);

  const drift = await db.query(
    `SELECT COUNT(*)::int n FROM (
       SELECT w.id, w.available_balance,
              COALESCE(SUM(CASE WHEN l.entry_type='credit' THEN l.amount
                                WHEN l.entry_type='debit' THEN -l.amount ELSE 0 END),0) led
         FROM wallets w LEFT JOIN wallet_ledger l ON l.wallet_id=w.id
        GROUP BY w.id, w.available_balance) x
      WHERE ABS(x.available_balance - x.led) > 0.005`);
  check("every wallet still agrees with its ledger", drift.rows[0].n === 0, `${drift.rows[0].n} drifting`);

  const ledgerRows = await db.query(
    `SELECT COUNT(*)::int n FROM wallet_ledger WHERE created_at > NOW() - INTERVAL '10 minutes'
       AND metadata::text ILIKE '%marketing%'`);
  check("no ledger entry was written by anything marketing", ledgerRows.rows[0].n === 0,
    `${ledgerRows.rows[0].n} row(s)`);

  /* ====================================================== audit trail exists */
  section("10. Sensitive actions are in the existing audit log");
  const audits = await db.query(
    `SELECT action, COUNT(*)::int n FROM audit_logs
      WHERE action LIKE 'marketing.%' AND created_at > NOW() - INTERVAL '10 minutes'
      GROUP BY action ORDER BY action`);
  const actions = audits.rows.map((r) => r.action);
  for (const expected of ["marketing.campaign.created", "marketing.promotion.created",
    "marketing.promotion.granted", "marketing.lead.created", "marketing.link.created",
    "marketing.audience.created", "marketing.experiment.created"]) {
    check(`${expected} is logged`, actions.includes(expected));
  }

  await db.end();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${"=".repeat(78)}`);
  console.log(`  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("\n  FAILED:");
    for (const f of failed) console.log(`    - ${f.name}${f.detail ? "  (" + f.detail + ")" : ""}`);
  }
  console.log(`${"=".repeat(78)}\n`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.message, e.stack); process.exit(1); });
