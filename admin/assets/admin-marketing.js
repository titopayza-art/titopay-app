/* ==========================================================================
   TitoPay Admin — Marketing & Sales Command Centre
   --------------------------------------------------------------------------
   Loaded on demand, exactly like the Analytics and Service Builder modules, so
   every other console page keeps the payload it had before this file existed.

   Contract with admin.js
     renderMarketing(me, host, view) — `host` carries the console helpers this
                                       module may use. Nothing here reaches into
                                       admin.js directly and nothing here alters
                                       console state beyond PAGE_EXPORTS.

   Data policy
     Every figure on these pages comes from a response the API actually
     returned. Where the API has no number, the cell shows "—". Nothing is
     estimated in the browser, and no total is assembled here from parts the
     server did not already agree on — the ROI page in particular prints direct,
     assisted and estimated revenue as three separate columns because adding
     them together would state something the attribution data cannot support.

   Content Security Policy
     Console pages declare `style-src 'self'`, so this module never emits a
     `style` attribute. Bar geometry uses a width class ladder rather than an
     inline width, which also keeps the charts on the design tokens.
   ========================================================================== */

const VIEWS = [
  ["overview", "Overview"],
  // Second, deliberately. These are the two numbers that say whether there is a
  // business here, and a metric nobody looks at changes nobody's behaviour.
  ["growth", "Activation & Retention"],
  ["campaigns", "Campaigns"],
  ["audiences", "Audiences"],
  ["promotions", "Promotions & Coupons"],
  ["referrals", "Referrals & Affiliates"],
  ["leads", "Leads / CRM"],
  ["pipeline", "Sales Pipeline"],
  ["acquisition", "Merchant Acquisition"],
  ["team", "Sales Team"],
  ["links", "Marketing Links"],
  ["experiments", "Growth Experiments"],
  ["analytics", "Analytics"],
  ["roi", "ROI & Attribution"]
];

const RANGES = [
  ["today", "Today"], ["7d", "7 days"], ["30d", "30 days"], ["month", "This month"],
  ["last_month", "Last month"], ["quarter", "This quarter"], ["year", "This year"]
];

// THE COHORT WINDOW IS A DIFFERENT THING FROM THE RANGE PICKER, and mixing them
// would be a quiet lie. Every other page's range asks "what happened in this
// period". A cohort window asks "who REGISTERED in this period", and then
// follows those same people forwards for up to twelve weeks. The API caps it at
// 120 days (activation-service.MAX_COHORT_DAYS) because a longer grid stops
// being readable before it stops being fast, so the options stop there too
// rather than offering a choice the server will refuse.
const COHORT_WINDOWS = [[30, "30 days"], [60, "60 days"], [90, "90 days"], [120, "120 days"]];

// Below this, a retention percentage is arithmetic rather than evidence. Ten
// people is still small, but it is the point where one person leaving stops
// moving the rate by a quarter. Cohorts under it are shown, never hidden, and
// marked so nobody reads 50% off two users as a trend.
const THIN_COHORT = 10;

const CAMPAIGN_TYPES = ["acquisition", "activation", "retention", "referral", "merchant_acquisition",
  "promotional", "product_launch", "re_engagement", "seasonal"];
const CHANNELS = ["push", "email", "sms", "in_app", "qr", "referral", "landing_page"];
const BENEFIT_TYPES = ["fixed_discount", "percentage_discount", "cashback", "fee_waiver",
  "first_transaction", "referral_bonus", "merchant_specific", "service_specific"];
const PIPELINE_STAGES = ["new", "contacted", "qualified", "demo", "negotiation", "kyc",
  "approved", "activated"];

let H = null;                 // console helpers, set on first render
let state = { view: "overview", range: "30d", cohortDays: 30 };

const title = (value) => String(value || "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const dash = (value) => (value === null || value === undefined || value === "" ? "—" : value);

// Percentages are rendered through a fixed ladder of classes because the pages
// forbid inline styles. Ten steps is enough resolution for a bar to be read
// and keeps the stylesheet small.
function barClass(percent) {
  const step = Math.max(0, Math.min(10, Math.round((Number(percent) || 0) / 10)));
  return `mk-bar-fill mk-bar-${step * 10}`;
}

function statusChip(status) {
  const good = ["active", "activated", "qualified", "approved", "ready", "running", "rewarded", "completed"];
  const warn = ["paused", "scheduled", "pending", "draft", "demo", "negotiation", "building", "contacted"];
  const bad = ["lost", "rejected", "failed", "expired", "exhausted", "archived"];
  const key = String(status || "").toLowerCase();
  const tone = good.includes(key) ? "ok" : warn.includes(key) ? "warn" : bad.includes(key) ? "bad" : "";
  return `<span class="mk-chip ${tone}">${H.escapeHtml(title(status))}</span>`;
}

function emptyState(message, hint = "") {
  return `<div class="mk-empty"><p>${H.escapeHtml(message)}</p>${hint ? `<small>${H.escapeHtml(hint)}</small>` : ""}</div>`;
}

function errorState(error) {
  return `<div class="mk-empty mk-empty-error"><p>${H.escapeHtml(H.adminErrorMessage(error))}</p>
    <small>Nothing was changed. Try again, or check your permissions for this section.</small></div>`;
}

function loadingState(what) {
  return `<div class="mk-empty"><p>Loading ${H.escapeHtml(what)}…</p></div>`;
}

function metricCards(cards) {
  return `<div class="mk-cards">${cards.map(([label, value, note]) => `
    <div class="mk-card">
      <span class="mk-card-label">${H.escapeHtml(label)}</span>
      <strong class="mk-card-value">${H.escapeHtml(String(dash(value)))}</strong>
      ${note ? `<small class="mk-card-note">${H.escapeHtml(note)}</small>` : ""}
    </div>`).join("")}</div>`;
}

function table(columns, rows, emptyMessage) {
  if (!rows.length) return emptyState(emptyMessage);
  return `<div class="table-wrap"><table>
    <thead><tr>${columns.map((c) => `<th>${H.escapeHtml(c)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>
  </table></div>`;
}

/* ------------------------------------------------------------------- shell */

function shell(body) {
  return `
    <section class="mk-shell">
      <nav class="mk-tabs" aria-label="Marketing sections">
        ${VIEWS.map(([key, label]) => `
          <button type="button" class="mk-tab${state.view === key ? " is-active" : ""}"
                  data-mk-view="${key}"${state.view === key ? ' aria-current="page"' : ""}>${H.escapeHtml(label)}</button>`).join("")}
      </nav>
      <div class="mk-body" data-mk-body>${body}</div>
    </section>`;
}

function rangePicker() {
  return `<div class="mk-range" role="group" aria-label="Date range">
    ${RANGES.map(([key, label]) => `
      <button type="button" class="mk-range-btn${state.range === key ? " is-active" : ""}"
              data-mk-range="${key}">${H.escapeHtml(label)}</button>`).join("")}
  </div>`;
}

/* ---------------------------------------------------------------- overview */

async function viewOverview(root) {
  root.innerHTML = loadingState("the marketing overview");
  try {
    const data = await H.apiFetch(`/admin/marketing/overview?range=${encodeURIComponent(state.range)}`);
    const c = data.cards || {};
    const charts = data.charts || {};
    root.innerHTML = `
      ${rangePicker()}
      ${metricCards([
        ["Active campaigns", c.activeCampaigns],
        ["Total leads", c.totalLeads],
        ["New leads", c.newLeads],
        ["Qualified leads", c.qualifiedLeads],
        ["Merchants acquired", c.merchantsAcquired],
        ["New customers", c.newUsers],
        ["Campaign conversion", `${c.campaignConversionRate ?? 0}%`],
        ["Referral conversions", c.referralConversions],
        ["Marketing spend", H.money(c.marketingSpend)],
        ["Revenue attributed", H.money(c.revenueAttributed), "Direct only"],
        ["Marketing ROI", c.marketingRoiPercent === null ? "—" : `${c.marketingRoiPercent}%`,
          c.marketingRoiPercent === null ? "No spend recorded" : ""]
      ])}
      <div class="mk-split">
        ${sparkCard("Customer acquisition", charts.userAcquisition || [])}
        ${sparkCard("Merchant acquisition", charts.merchantAcquisition || [])}
      </div>
      <div class="mk-note">
        <strong>Attribution:</strong> the headline figure counts only revenue
        recorded as directly attributable. Assisted ${H.money(c.revenueAssisted)} and
        estimated ${H.money(c.revenueEstimated)} are reported separately on ROI &amp; Attribution
        and are never added into the total.
      </div>`;
  } catch (error) {
    root.innerHTML = errorState(error);
  }
}

// A minimal bar series. Deliberately not a charting library: the console has no
// bundler and a CDN script would be blocked by the page's CSP.
function sparkCard(heading, series) {
  if (!series.length) return `<div class="mk-panel"><h3>${H.escapeHtml(heading)}</h3>${emptyState("No activity in this period.")}</div>`;
  const max = Math.max(...series.map((point) => Number(point.value) || 0), 1);
  return `<div class="mk-panel">
    <h3>${H.escapeHtml(heading)}</h3>
    <div class="mk-spark" role="img" aria-label="${H.escapeHtml(heading)} by day">
      ${series.map((point) => `
        <div class="mk-spark-col" title="${H.escapeHtml(String(point.day))}: ${Number(point.value)}">
          <span class="${barClass((Number(point.value) / max) * 100)}"></span>
        </div>`).join("")}
    </div>
    <small class="mk-card-note">${series.length} day(s) · peak ${max}</small>
  </div>`;
}

/* --------------------------------------------------------------- campaigns */

async function viewCampaigns(root) {
  root.innerHTML = loadingState("campaigns");
  try {
    const [data, audiences] = await Promise.all([
      H.apiFetch("/admin/marketing/campaigns"),
      H.apiFetch("/admin/marketing/audiences").catch(() => ({ items: [] }))
    ]);
    const rows = (data.items || []).map((campaign) => [
      `<strong>${H.escapeHtml(campaign.name)}</strong><small>${H.escapeHtml(title(campaign.type))}</small>`,
      statusChip(campaign.status),
      H.escapeHtml(dash(campaign.audienceName)),
      `${H.money(campaign.budget.spent)} / ${H.money(campaign.budget.allocated)}
       ${campaign.budget.warning ? `<small class="mk-warn">${H.escapeHtml(campaign.budget.warning)}</small>` : ""}`,
      H.money(campaign.attributedRevenue),
      campaign.roiPercent === null ? "—" : `${campaign.roiPercent}%`,
      `<button type="button" class="secondary-btn" data-mk-campaign-spend="${campaign.id}">Record spend</button>`
    ]);
    root.innerHTML = `
      ${campaignForm(audiences.items || [])}
      ${table(["Campaign", "Status", "Audience", "Budget", "Attributed revenue", "ROI", ""], rows,
        "No campaigns yet. Create the first one above.")}`;
    H.PAGE_EXPORTS.marketing = () => H.downloadCsv("marketing-campaigns.csv",
      ["Campaign", "Type", "Status", "Budget", "Spent", "Attributed revenue", "ROI %"],
      (data.items || []).map((c) => [c.name, c.type, c.status, c.budget.allocated,
        c.budget.spent, c.attributedRevenue, c.roiPercent ?? ""]));
  } catch (error) {
    root.innerHTML = errorState(error);
  }
}

function campaignForm(audiences) {
  return `<details class="mk-form-wrap"><summary>New campaign</summary>
    <form class="mk-form" data-mk-form="campaign">
      <div class="field"><label for="mk-c-name">Campaign name</label>
        <input id="mk-c-name" name="name" required minlength="3" maxlength="120"></div>
      <div class="field"><label for="mk-c-type">Type</label>
        <select id="mk-c-type" name="type">${CAMPAIGN_TYPES.map((t) => `<option value="${t}">${H.escapeHtml(title(t))}</option>`).join("")}</select></div>
      <div class="field"><label for="mk-c-objective">Objective</label>
        <input id="mk-c-objective" name="objective" maxlength="500"></div>
      <div class="field"><label for="mk-c-audience">Audience</label>
        <select id="mk-c-audience" name="audienceId"><option value="">Not targeted</option>
          ${audiences.map((a) => `<option value="${a.id}">${H.escapeHtml(a.name)} (${a.size})</option>`).join("")}</select></div>
      <div class="field"><label for="mk-c-budget">Budget (R)</label>
        <input id="mk-c-budget" name="budget" type="number" min="0" step="0.01" value="0"></div>
      <div class="field"><label for="mk-c-start">Starts</label>
        <input id="mk-c-start" name="startsAt" type="date"></div>
      <div class="field"><label for="mk-c-end">Ends</label>
        <input id="mk-c-end" name="endsAt" type="date"></div>
      <fieldset class="field mk-checks"><legend>Channels</legend>
        ${CHANNELS.map((ch) => `<label class="mk-check"><input type="checkbox" name="channels" value="${ch}"> ${H.escapeHtml(title(ch))}</label>`).join("")}
      </fieldset>
      <button type="submit" class="primary-btn">Create campaign</button>
      <p class="mk-form-note">Campaigns are created as a draft. Nothing is sent to a customer from
        here — messages still go out through the existing Announcements, SMS and Email approval flow.</p>
    </form></details>`;
}

/* --------------------------------------------------------------- audiences */

async function viewAudiences(root) {
  root.innerHTML = loadingState("audiences");
  try {
    const data = await H.apiFetch("/admin/marketing/audiences");
    const rows = (data.items || []).map((audience) => [
      `<strong>${H.escapeHtml(audience.name)}</strong><small>${H.escapeHtml(audience.description)}</small>`,
      H.escapeHtml(title(audience.preset)),
      String(audience.size),
      statusChip(audience.buildStatus),
      audience.lastBuiltAt ? H.formatDate(audience.lastBuiltAt) : "Never",
      `<button type="button" class="secondary-btn" data-mk-audience-build="${audience.id}">Rebuild</button>`
    ]);
    root.innerHTML = `
      <details class="mk-form-wrap"><summary>New audience</summary>
        <form class="mk-form" data-mk-form="audience">
          <div class="field"><label for="mk-a-name">Audience name</label>
            <input id="mk-a-name" name="name" required minlength="3" maxlength="120"></div>
          <div class="field"><label for="mk-a-preset">Segment</label>
            <select id="mk-a-preset" name="preset">
              ${(data.presets || []).map((p) => `<option value="${p.key}">${H.escapeHtml(p.label)} — ${H.escapeHtml(p.description)}</option>`).join("")}
            </select></div>
          <div class="field"><label for="mk-a-days">Days (where the segment uses one)</label>
            <input id="mk-a-days" name="days" type="number" min="1" max="365" value="30"></div>
          <div class="field"><label for="mk-a-threshold">Value threshold (R, high-value only)</label>
            <input id="mk-a-threshold" name="threshold" type="number" min="0" step="1" value="5000"></div>
          <button type="submit" class="primary-btn">Create audience</button>
          <p class="mk-form-note">Membership is built in the background and stored, so opening a
            marketing page never scans the customer base.</p>
        </form></details>
      ${table(["Audience", "Segment", "Members", "Build", "Last built", ""], rows,
        "No audiences yet.")}`;
  } catch (error) {
    root.innerHTML = errorState(error);
  }
}

/* -------------------------------------------------------------- promotions */

async function viewPromotions(root) {
  root.innerHTML = loadingState("promotions");
  try {
    const [data, campaigns] = await Promise.all([
      H.apiFetch("/admin/marketing/promotions"),
      H.apiFetch("/admin/marketing/campaigns").catch(() => ({ items: [] }))
    ]);
    const rows = (data.items || []).map((promo) => [
      `<strong>${H.escapeHtml(promo.code)}</strong><small>${H.escapeHtml(promo.name)}</small>`,
      H.escapeHtml(title(promo.benefitType)),
      promo.benefitPercentage > 0
        ? `${promo.benefitPercentage}%${promo.maxBenefit ? ` (max ${H.money(promo.maxBenefit)})` : ""}`
        : H.money(promo.benefitValue),
      `${promo.redemptions}${promo.usageLimit ? ` / ${promo.usageLimit}` : ""}`,
      promo.budgetTotal === null ? "—" : `${H.money(promo.budgetSpent)} / ${H.money(promo.budgetTotal)}`,
      promo.expiresAt ? H.formatDate(promo.expiresAt) : "—",
      statusChip(promo.status),
      promo.status === "active"
        ? `<button type="button" class="secondary-btn" data-mk-promo-status="${promo.id}" data-mk-status="paused">Pause</button>`
        : promo.status === "draft" || promo.status === "paused"
          ? `<button type="button" class="secondary-btn" data-mk-promo-status="${promo.id}" data-mk-status="active">Activate</button>`
          : ""
    ]);
    root.innerHTML = `
      <details class="mk-form-wrap"><summary>New promotion</summary>
        <form class="mk-form" data-mk-form="promotion">
          <div class="field"><label for="mk-p-code">Coupon code</label>
            <input id="mk-p-code" name="code" required maxlength="32" pattern="[A-Za-z0-9][A-Za-z0-9_-]{2,31}"></div>
          <div class="field"><label for="mk-p-name">Name</label>
            <input id="mk-p-name" name="name" required minlength="3" maxlength="120"></div>
          <div class="field"><label for="mk-p-type">Benefit</label>
            <select id="mk-p-type" name="benefitType">${BENEFIT_TYPES.map((t) => `<option value="${t}">${H.escapeHtml(title(t))}</option>`).join("")}</select></div>
          <div class="field"><label for="mk-p-value">Fixed value (R)</label>
            <input id="mk-p-value" name="benefitValue" type="number" min="0" step="0.01" value="0"></div>
          <div class="field"><label for="mk-p-pct">Percentage (%)</label>
            <input id="mk-p-pct" name="benefitPercentage" type="number" min="0" max="100" step="0.1" value="0"></div>
          <div class="field"><label for="mk-p-max">Maximum benefit (R)</label>
            <input id="mk-p-max" name="maxBenefit" type="number" min="0" step="0.01"></div>
          <div class="field"><label for="mk-p-min">Minimum transaction (R)</label>
            <input id="mk-p-min" name="minTransaction" type="number" min="0" step="0.01" value="0"></div>
          <div class="field"><label for="mk-p-limit">Total uses</label>
            <input id="mk-p-limit" name="usageLimit" type="number" min="1"></div>
          <div class="field"><label for="mk-p-peruser">Uses per customer</label>
            <input id="mk-p-peruser" name="perUserLimit" type="number" min="1" value="1"></div>
          <div class="field"><label for="mk-p-budget">Total budget (R)</label>
            <input id="mk-p-budget" name="budgetTotal" type="number" min="0" step="0.01"></div>
          <div class="field"><label for="mk-p-expiry">Expires</label>
            <input id="mk-p-expiry" name="expiresAt" type="date"></div>
          <div class="field"><label for="mk-p-campaign">Campaign</label>
            <select id="mk-p-campaign" name="campaignId"><option value="">None</option>
              ${(campaigns.items || []).map((c) => `<option value="${c.id}">${H.escapeHtml(c.name)}</option>`).join("")}</select></div>
          <button type="submit" class="primary-btn">Create promotion</button>
          <p class="mk-form-note">A percentage promotion must have a maximum benefit, so its cost is
            capped. Promotions are created paused as a draft and record an entitlement only — money
            still moves through the existing payment logic.</p>
        </form></details>
      ${table(["Code", "Type", "Benefit", "Used", "Budget", "Expires", "Status", ""], rows,
        "No promotions yet.")}`;
  } catch (error) {
    root.innerHTML = errorState(error);
  }
}

/* --------------------------------------------------------------- referrals */

async function viewReferrals(root) {
  root.innerHTML = loadingState("referrals");
  try {
    const [referrals, affiliates] = await Promise.all([
      H.apiFetch("/admin/marketing/referrals"),
      H.apiFetch("/admin/marketing/affiliates").catch(() => ({ items: [] }))
    ]);
    const rows = (referrals.items || []).map((r) => [
      H.escapeHtml(dash(r.referrerUsername)),
      H.escapeHtml(dash(r.referredUsername)),
      r.kycCompletedAt ? "Yes" : "No",
      r.firstTransactionAt ? H.formatDate(r.firstTransactionAt) : "—",
      H.money(r.qualifyingVolume),
      H.money(r.rewardAmount),
      statusChip(r.status),
      `<button type="button" class="secondary-btn" data-mk-referral-eval="${r.id}">Re-check</button>`
    ]);
    const affiliateRows = (affiliates.items || []).map((a) => [
      `<strong>${H.escapeHtml(a.name)}</strong><small>${H.escapeHtml(a.code)}</small>`,
      H.escapeHtml(title(a.commissionType)),
      a.commissionType === "percentage" ? `${a.commissionValue}%` : H.money(a.commissionValue),
      String(a.referred),
      statusChip(a.status)
    ]);
    root.innerHTML = `
      <div class="mk-note"><strong>Qualification rule:</strong> a referral is never rewarded for a
        registration alone. It becomes qualified only once the referred customer has completed KYC
        <em>and</em> settled a first transaction.</div>
      <h3 class="mk-heading">Referrals</h3>
      ${table(["Referrer", "Referred", "KYC", "First transaction", "Volume", "Reward", "Status", ""],
        rows, "No referrals recorded yet.")}
      <h3 class="mk-heading">Affiliates</h3>
      <div class="mk-note">
        <strong>How an affiliate earns.</strong> An affiliate is paid on the same rule as a
        referral, not on sign-ups: the person they brought in must complete KYC
        <em>and</em> settle a first transaction before anything is owed.
        A <em>fixed</em> commission pays that rand amount once per qualified customer.
        A <em>percentage</em> commission pays that share of the revenue TitoPay earns from
        that customer. Commission is <strong>recorded here and paid through the normal
        payout process</strong> — this page never moves money by itself.
      </div>
      <details class="mk-form-wrap"><summary>New affiliate</summary>
        <form class="mk-form" data-mk-form="affiliate">
          <div class="field"><label for="mk-f-name">Affiliate name</label>
            <input id="mk-f-name" name="name" required minlength="2" maxlength="120"></div>
          <div class="field"><label for="mk-f-code">Affiliate code</label>
            <input id="mk-f-code" name="code" required maxlength="32" pattern="[A-Za-z0-9][A-Za-z0-9_-]{2,31}"></div>
          <div class="field"><label for="mk-f-email">Contact email</label>
            <input id="mk-f-email" name="contactEmail" type="email" maxlength="160"></div>
          <div class="field"><label for="mk-f-phone">Contact phone</label>
            <input id="mk-f-phone" name="contactPhone" maxlength="32"></div>
          <div class="field"><label for="mk-f-type">Commission type</label>
            <select id="mk-f-type" name="commissionType">
              <option value="fixed">Fixed rand amount per qualified customer</option>
              <option value="percentage">Percentage of revenue from that customer</option>
            </select></div>
          <div class="field"><label for="mk-f-value">Commission value (R or %)</label>
            <input id="mk-f-value" name="commissionValue" type="number" min="0.01" step="0.01" required></div>
          <button type="submit" class="primary-btn">Add affiliate</button>
          <p class="mk-form-note">A percentage commission cannot exceed 100%. Codes are unique.</p>
        </form></details>
      ${table(["Affiliate", "Commission", "Value", "Qualified customers", "Status"], affiliateRows,
        "No affiliates yet. Add one above.")}`;
  } catch (error) {
    root.innerHTML = errorState(error);
  }
}

/* ------------------------------------------------------------- leads / CRM */

async function viewLeads(root) {
  root.innerHTML = loadingState("leads");
  try {
    const data = await H.apiFetch("/admin/marketing/leads?limit=100");
    const rows = (data.items || []).map((lead) => [
      `<strong>${H.escapeHtml(lead.businessName)}</strong><small>${H.escapeHtml(lead.reference)}</small>`,
      H.escapeHtml(dash(lead.contactName)),
      H.escapeHtml(dash(lead.businessCategory)),
      H.escapeHtml(dash(lead.location)),
      H.escapeHtml(dash(lead.assignedTo)),
      H.money(lead.expectedRevenue),
      lead.nextFollowUpAt ? H.formatDate(lead.nextFollowUpAt) : "—",
      statusChip(lead.status)
    ]);
    root.innerHTML = `
      <details class="mk-form-wrap"><summary>New lead</summary>
        <form class="mk-form" data-mk-form="lead">
          <div class="field"><label for="mk-l-business">Business name</label>
            <input id="mk-l-business" name="businessName" required minlength="2" maxlength="160"></div>
          <div class="field"><label for="mk-l-contact">Contact name</label>
            <input id="mk-l-contact" name="contactName" maxlength="120"></div>
          <div class="field"><label for="mk-l-email">Email</label>
            <input id="mk-l-email" name="email" type="email" maxlength="160"></div>
          <div class="field"><label for="mk-l-phone">Phone</label>
            <input id="mk-l-phone" name="phone" maxlength="32"></div>
          <div class="field"><label for="mk-l-category">Category</label>
            <input id="mk-l-category" name="businessCategory" maxlength="80"></div>
          <div class="field"><label for="mk-l-location">Location</label>
            <input id="mk-l-location" name="location" maxlength="120"></div>
          <div class="field"><label for="mk-l-source">Source</label>
            <input id="mk-l-source" name="source" maxlength="60" value="manual"></div>
          <div class="field"><label for="mk-l-revenue">Expected revenue (R)</label>
            <input id="mk-l-revenue" name="expectedRevenue" type="number" min="0" step="0.01" value="0"></div>
          <div class="field"><label for="mk-l-followup">Next follow-up</label>
            <input id="mk-l-followup" name="nextFollowUpAt" type="date"></div>
          <button type="submit" class="primary-btn">Create lead</button>
        </form></details>
      <div class="mk-toolbar">
        <label class="mk-search"><span class="visually-hidden">Search leads</span>
          <input type="search" data-mk-lead-search placeholder="Search by business, contact, email or reference">
        </label>
      </div>
      ${table(["Business", "Contact", "Category", "Location", "Owner", "Expected", "Follow-up", "Status"],
        rows, "No leads yet. Add the first one above.")}
      <p class="mk-form-note">${data.total || 0} lead(s) in total.</p>`;
  } catch (error) {
    root.innerHTML = errorState(error);
  }
}

/* ------------------------------------------------------------ sales pipeline */

async function viewPipeline(root) {
  root.innerHTML = loadingState("the sales pipeline");
  try {
    const [pipeline, leads] = await Promise.all([
      H.apiFetch("/admin/marketing/sales-pipeline"),
      H.apiFetch("/admin/marketing/leads?limit=200")
    ]);
    const byStage = new Map(PIPELINE_STAGES.map((stage) => [stage, []]));
    for (const lead of leads.items || []) {
      if (byStage.has(lead.status)) byStage.get(lead.status).push(lead);
    }
    root.innerHTML = `
      ${metricCards([
        ["Pipeline value", H.money(pipeline.totalPipelineValue)],
        ["Open leads", (pipeline.stages || []).reduce((sum, s) => sum + s.count, 0)],
        ["Lost", pipeline.lost]
      ])}
      <div class="mk-kanban">
        ${(pipeline.stages || []).map((stage) => `
          <section class="mk-column" aria-label="${H.escapeHtml(title(stage.stage))}">
            <header class="mk-column-head">
              <strong>${H.escapeHtml(title(stage.stage))}</strong>
              <span class="mk-chip">${stage.count}</span>
              <small>${H.money(stage.value)}</small>
            </header>
            <div class="mk-column-body">
              ${(byStage.get(stage.stage) || []).slice(0, 25).map((lead) => `
                <article class="mk-lead-card">
                  <strong>${H.escapeHtml(lead.businessName)}</strong>
                  <small>${H.escapeHtml(dash(lead.assignedTo))} · ${H.money(lead.expectedRevenue)}</small>
                  <label class="visually-hidden" for="mk-move-${lead.id}">Move ${H.escapeHtml(lead.businessName)}</label>
                  <select class="mk-move" id="mk-move-${lead.id}" data-mk-lead-move="${lead.id}">
                    ${PIPELINE_STAGES.map((s) => `<option value="${s}"${s === lead.status ? " selected" : ""}>${H.escapeHtml(title(s))}</option>`).join("")}
                    <option value="lost">Lost</option>
                  </select>
                </article>`).join("") || `<p class="mk-column-empty">Empty</p>`}
            </div>
          </section>`).join("")}
      </div>`;
  } catch (error) {
    root.innerHTML = errorState(error);
  }
}

/* ------------------------------------------------------- merchant acquisition */

async function viewAcquisition(root) {
  root.innerHTML = loadingState("merchant acquisition");
  try {
    const [links, pipeline] = await Promise.all([
      H.apiFetch("/admin/marketing/links"),
      H.apiFetch("/admin/marketing/sales-pipeline")
    ]);
    const onboarding = (links.items || []).filter((l) =>
      ["merchant_onboarding", "lead_capture", "qr"].includes(l.linkType));
    const rows = onboarding.map((link) => [
      `<strong>${H.escapeHtml(link.label || link.slug)}</strong><small>${H.escapeHtml(link.url)}</small>`,
      H.escapeHtml(title(link.linkType)),
      H.escapeHtml(dash(link.campaignName)),
      H.escapeHtml(dash(link.salespersonName)),
      String(link.funnel.clicks),
      String(link.funnel.merchantsActivated),
      H.money(link.funnel.revenue)
    ]);
    root.innerHTML = `
      ${metricCards([
        ["Onboarding links", onboarding.length],
        ["Clicks", onboarding.reduce((n, l) => n + l.funnel.clicks, 0)],
        ["Merchants activated", onboarding.reduce((n, l) => n + l.funnel.merchantsActivated, 0)],
        ["Leads in pipeline", (pipeline.stages || []).reduce((n, s) => n + s.count, 0)],
        ["Pipeline value", H.money(pipeline.totalPipelineValue)]
      ])}
      <div class="mk-note">The journey each link tracks:
        <strong>salesperson → campaign → landing page → merchant application → KYC → approved → activated</strong>.
        Create onboarding links on the Marketing Links tab.</div>
      ${table(["Link", "Type", "Campaign", "Salesperson", "Clicks", "Activated", "Revenue"], rows,
        "No merchant onboarding links yet.")}`;
  } catch (error) {
    root.innerHTML = errorState(error);
  }
}

/* -------------------------------------------------------------- sales team */

async function viewTeam(root) {
  root.innerHTML = loadingState("sales team performance");
  try {
    const data = await H.apiFetch("/admin/marketing/sales-team");
    const rows = (data.items || []).map((person) => [
      `<strong>${H.escapeHtml(person.name)}</strong><small>${H.escapeHtml(title(person.role))}</small>`,
      String(person.assigned),
      String(person.contacted),
      String(person.qualified),
      String(person.approved),
      String(person.activated),
      `${person.conversionRate}%`,
      H.money(person.pipelineValue)
    ]);
    root.innerHTML = `
      <div class="mk-note">Sales staff are the existing admin users — this page reads the leads
        assigned to them and stores nothing else about a person.</div>
      ${table(["Salesperson", "Assigned", "Contacted", "Qualified", "Approved", "Activated",
        "Conversion", "Pipeline value"], rows, "No leads have been assigned yet.")}`;
  } catch (error) {
    root.innerHTML = errorState(error);
  }
}

/* ------------------------------------------------------------------- links */

async function viewLinks(root) {
  root.innerHTML = loadingState("marketing links");
  try {
    const [data, campaigns] = await Promise.all([
      H.apiFetch("/admin/marketing/links"),
      H.apiFetch("/admin/marketing/campaigns").catch(() => ({ items: [] }))
    ]);
    const rows = (data.items || []).map((link) => [
      `<strong>${H.escapeHtml(link.label || link.slug)}</strong><small>${H.escapeHtml(link.url)}</small>`,
      H.escapeHtml(dash(link.campaignName)),
      `${H.escapeHtml(dash(link.source))} / ${H.escapeHtml(dash(link.medium))}`,
      String(link.funnel.clicks),
      String(link.funnel.registrations),
      String(link.funnel.kycCompletions),
      String(link.funnel.firstTransactions),
      H.money(link.funnel.revenue),
      statusChip(link.status)
    ]);
    root.innerHTML = `
      <details class="mk-form-wrap"><summary>New tracked link</summary>
        <form class="mk-form" data-mk-form="link">
          <div class="field"><label for="mk-k-label">Label</label>
            <input id="mk-k-label" name="label" maxlength="120"></div>
          <div class="field"><label for="mk-k-dest">Destination</label>
            <input id="mk-k-dest" name="destinationUrl" required placeholder="https://titopay.co.za/…"></div>
          <div class="field"><label for="mk-k-type">Link type</label>
            <select id="mk-k-type" name="linkType">
              ${["generic", "merchant_onboarding", "lead_capture", "referral", "qr", "landing_page"]
    .map((t) => `<option value="${t}">${H.escapeHtml(title(t))}</option>`).join("")}
            </select></div>
          <div class="field"><label for="mk-k-campaign">Campaign</label>
            <select id="mk-k-campaign" name="campaignId"><option value="">None</option>
              ${(campaigns.items || []).map((c) => `<option value="${c.id}">${H.escapeHtml(c.name)}</option>`).join("")}</select></div>
          <div class="field"><label for="mk-k-source">Source</label>
            <input id="mk-k-source" name="source" maxlength="60"></div>
          <div class="field"><label for="mk-k-medium">Medium</label>
            <input id="mk-k-medium" name="medium" maxlength="60"></div>
          <button type="submit" class="primary-btn">Create link</button>
          <p class="mk-form-note">Links may only point at TitoPay addresses
            (${H.escapeHtml((data.allowedHosts || []).join(", "))}). Anything else is refused, so a
            tracked link can never become an open redirect.</p>
        </form></details>
      ${table(["Link", "Campaign", "Source / medium", "Clicks", "Registrations", "KYC",
        "First transaction", "Revenue", "Status"], rows, "No tracked links yet.")}`;
  } catch (error) {
    root.innerHTML = errorState(error);
  }
}

/* ------------------------------------------------------------- experiments */

async function viewExperiments(root) {
  root.innerHTML = loadingState("growth experiments");
  try {
    const data = await H.apiFetch("/admin/marketing/experiments");
    const body = (data.items || []).map((experiment) => `
      <section class="mk-panel">
        <header class="mk-panel-head">
          <div><h3>${H.escapeHtml(experiment.name)}</h3>
            <small>${H.escapeHtml(experiment.hypothesis || "No hypothesis recorded")}</small></div>
          ${statusChip(experiment.status)}
        </header>
        ${table(["Variant", "Assigned", "Converted", "Conversion", "Cost", "Revenue", "Net", "ROI"],
    experiment.variants.map((v) => [
      `<strong>${H.escapeHtml(v.name)}</strong>`,
      String(v.assigned), String(v.converted), `${v.conversionRate}%`,
      H.money(v.cost), H.money(v.revenue), H.money(v.netRevenue),
      v.roiPercent === null ? "—" : `${v.roiPercent}%`
    ]), "This experiment has no variants.")}
      </section>`).join("");
    root.innerHTML = `
      <details class="mk-form-wrap"><summary>New experiment</summary>
        <form class="mk-form" data-mk-form="experiment">
          <div class="field"><label for="mk-x-name">Experiment name</label>
            <input id="mk-x-name" name="name" required minlength="3" maxlength="120"></div>
          <div class="field"><label for="mk-x-hypothesis">Hypothesis</label>
            <input id="mk-x-hypothesis" name="hypothesis" maxlength="500"></div>
          <div class="field"><label for="mk-x-a">Variant A name</label>
            <input id="mk-x-a" name="variantAName" required value="A"></div>
          <div class="field"><label for="mk-x-acost">Variant A cost per customer (R)</label>
            <input id="mk-x-acost" name="variantACost" type="number" min="0" step="0.01" value="0"></div>
          <div class="field"><label for="mk-x-b">Variant B name</label>
            <input id="mk-x-b" name="variantBName" required value="B"></div>
          <div class="field"><label for="mk-x-bcost">Variant B cost per customer (R)</label>
            <input id="mk-x-bcost" name="variantBCost" type="number" min="0" step="0.01" value="0"></div>
          <div class="field"><label for="mk-x-split">Variant A share (%)</label>
            <input id="mk-x-split" name="split" type="number" min="1" max="99" value="50"></div>
          <button type="submit" class="primary-btn">Create experiment</button>
          <p class="mk-form-note">A customer is assigned to one variant, once, and is never moved
            between offers while the experiment runs.</p>
        </form></details>
      ${body || emptyState("No experiments yet.")}`;
  } catch (error) {
    root.innerHTML = errorState(error);
  }
}

/* --------------------------------------------------------------- analytics */

async function viewAnalytics(root) {
  root.innerHTML = loadingState("marketing analytics");
  try {
    const data = await H.apiFetch(`/admin/marketing/analytics?range=${encodeURIComponent(state.range)}`);
    const acq = data.acquisition || {};
    root.innerHTML = `
      ${rangePicker()}
      ${metricCards([
        ["Marketing spend", H.money(acq.marketingSpend)],
        ["New customers", acq.newUsers],
        ["New merchants", acq.newMerchants],
        ["Cost per customer", acq.customerAcquisitionCost === null ? "—" : H.money(acq.customerAcquisitionCost)],
        ["Cost per merchant", acq.merchantAcquisitionCost === null ? "—" : H.money(acq.merchantAcquisitionCost)],
        ["Lead → merchant", `${acq.leadToMerchantConversion ?? 0}%`]
      ])}
      <div class="mk-split">
        ${funnelPanel("Customer funnel", data.funnels?.customer || [])}
        ${funnelPanel("Merchant funnel", data.funnels?.merchant || [])}
      </div>
      <div class="mk-note"><strong>Read this carefully:</strong> ${H.escapeHtml(acq.caveat || "")}</div>`;
  } catch (error) {
    root.innerHTML = errorState(error);
  }
}

function funnelPanel(heading, steps) {
  const top = Math.max(...steps.map((s) => Number(s.value) || 0), 1);
  return `<div class="mk-panel"><h3>${H.escapeHtml(heading)}</h3>
    <ol class="mk-funnel">
      ${steps.map((step) => `
        <li class="mk-funnel-step">
          <span class="mk-funnel-label">${H.escapeHtml(step.step)}</span>
          <span class="mk-funnel-track"><span class="${barClass((Number(step.value) / top) * 100)}"></span></span>
          <span class="mk-funnel-value">${Number(step.value)}</span>
        </li>`).join("")}
    </ol></div>`;
}

/* ----------------------------------------------- activation and retention */

// THE PAGE THIS CONSOLE DID NOT HAVE.
//
// Everything else under Marketing measures a CAMPAIGN. This measures the
// PRODUCT, off every user, attributed or not. The two questions it exists to
// answer are the ones registrations cannot: of the people who registered, how
// many ever transacted, and of those, how many came back.
//
// It is deliberately hard to misread. Where the data is thin it says so, where
// a number is not what it looks like it says that too, and nothing on the page
// is computed here — every figure is one the API already returned.

function cohortPicker() {
  return `<div class="mk-range" role="group" aria-label="Registration window">
    ${COHORT_WINDOWS.map(([days, label]) => `
      <button type="button" class="mk-range-btn${state.cohortDays === days ? " is-active" : ""}"
              data-mk-cohort="${days}">${H.escapeHtml(label)}</button>`).join("")}
  </div>`;
}

// EVERYTHING THE API RETURNS IS TREATED AS TEXT ON THE WAY INTO innerHTML,
// including the figures. Every one of these is a number today — the service
// coerces with Number() before it answers — so nothing here is exploitable as
// written. It is done anyway because "this field happens to be numeric" is a
// property of today's service, not of this page, and a console that renders
// API values into markup should not depend on the other end staying careful.
// A non-finite value renders as an em dash rather than as the word NaN.
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : "—";
}

// The heat ladder for the cohort grid, in the same ten steps the bars use, and
// for the same reason: the page CSP forbids an inline style.
function heatClass(percent) {
  const step = Math.max(0, Math.min(10, Math.round((Number(percent) || 0) / 10)));
  return `mk-heat mk-heat-${step * 10}`;
}

const weekLabel = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toISOString().slice(0, 10);
};

// The activation stages. NOT drawn as a nesting funnel, because they do not
// nest — the service says so at length and it was learned twice. Tier 0 carries
// a monthly allowance, so a user transacts without verifying; several services
// are free, so a user transacts without ever being funded. Each stage is
// therefore measured against Registered and shown on its own terms.
function stagesPanel(steps) {
  return `<div class="mk-panel">
    <div class="mk-panel-head">
      <div>
        <h3>Activation stages</h3>
        <small>Each measured against everyone who registered in the window.</small>
      </div>
    </div>
    <ol class="mk-funnel">
      ${steps.map((step) => `
        <li class="mk-funnel-step">
          <span class="mk-funnel-label">${H.escapeHtml(step.step)}</span>
          <span class="mk-funnel-track"><span class="${barClass(step.rate)}"></span></span>
          <span class="mk-funnel-value">${num(step.value)}<small>${num(step.rate)}%</small></span>
        </li>`).join("")}
    </ol>
    <p class="mk-form-note">These are stages, not a funnel that narrows. A customer can
      transact without being funded (several services are free) and without verifying
      (the entry level carries its own monthly allowance), so each is counted
      independently rather than as a share of the step above.</p>
  </div>`;
}

// The retention grid. Week 0 is the registration week, so week 0 is activation
// and weeks 1 and beyond are the only real retention on the page.
function retentionPanel(cohorts) {
  if (!cohorts.length) {
    return `<div class="mk-panel"><h3>Weekly retention</h3>
      ${emptyState("Nobody registered in this window.",
        "Widen the registration window, or come back once there are cohorts to follow.")}</div>`;
  }
  const weeks = cohorts[0].retention.map((r) => r.week);
  return `<div class="mk-panel">
    <div class="mk-panel-head">
      <div>
        <h3>Weekly retention</h3>
        <small>Grouped by the week each customer registered, then followed forwards.</small>
      </div>
    </div>
    <div class="table-wrap"><table class="mk-cohort">
      <thead><tr>
        <th scope="col">Registered week</th>
        <th scope="col">Size</th>
        ${weeks.map((w) => `<th scope="col">W${num(w)}</th>`).join("")}
      </tr></thead>
      <tbody>
        ${cohorts.map((c) => `<tr${c.size < THIN_COHORT ? ' class="mk-thin"' : ""}>
          <th scope="row">${H.escapeHtml(weekLabel(c.cohortWeek))}</th>
          <td>${num(c.size)}${c.size < THIN_COHORT ? '<small class="mk-warn">too small to read as a rate</small>' : ""}</td>
          ${c.retention.map((cell) => `
            <td class="${heatClass(cell.rate)}" title="${num(cell.retained)} of ${num(c.size)}">
              ${cell.retained === 0 ? "—" : `${num(cell.rate)}%`}
            </td>`).join("")}
        </tr>`).join("")}
      </tbody>
    </table></div>
    <p class="mk-form-note">Week 0 is the week they registered, so week 0 is activation and
      weeks 1 onwards are retention. A percentage on a cohort of a handful of people is
      arithmetic, not evidence — those rows carry the size and are marked.</p>
  </div>`;
}

async function viewGrowth(root) {
  root.innerHTML = loadingState("activation and retention");
  try {
    // One call. The three figures are only meaningful together — activation
    // without retention is a leaky bucket, retention without frequency is a
    // dormant balance — and the API composes them in one round trip.
    const data = await H.apiFetch(`/admin/marketing/growth?days=${encodeURIComponent(state.cohortDays)}`);
    const funnel = data.funnel || {};
    const first = funnel.firstTransaction || {};
    const verification = funnel.verification || {};
    const freq = data.frequency || {};
    const cohorts = (data.cohorts || {}).cohorts || [];
    const registered = funnel.steps?.[0]?.value ?? 0;
    const activated = funnel.steps?.find((s) => s.step === "Transacted once")?.value ?? 0;

    root.innerHTML = `
      ${cohortPicker()}
      <div class="mk-note"><strong>This page measures the product, not a campaign.</strong>
        Every customer who registered in the window is counted, however they arrived —
        the Campaigns and ROI pages count only customers a tracked campaign brought in.
        Registrations on their own are a vanity number; these are the two that decide
        whether there is a business here.</div>
      ${metricCards([
        ["Registered", registered, `in the last ${state.cohortDays} days`],
        ["Ever transacted", activated, `${funnel.steps?.find((s) => s.step === "Transacted once")?.rate ?? 0}% of them`],
        ["Day 1 activation", `${first.dayOneRate ?? 0}%`, "transacted within 24 hours"],
        ["Week 1 activation", `${first.weekOneRate ?? 0}%`, "transacted within 7 days"],
        ["Transactions per active", freq.averagePerActivePerWeek ?? 0, "per active customer, per week"],
        ["Funded, never spent", funnel.fundedNeverSpent ?? 0, "money in, nothing bought"]
      ])}
      <div class="mk-growth-split">
        ${stagesPanel(funnel.steps || [])}
        <div class="mk-panel">
          <div class="mk-panel-head"><div>
            <h3>Verification</h3>
            <small>Reported beside the stages, not inside them.</small>
          </div></div>
          ${metricCards([
            ["Verified", verification.verified ?? 0, `${verification.rate ?? 0}% of the cohort`]
          ])}
          <p class="mk-form-note">${H.escapeHtml(verification.note
            || "Verification raises the monthly limit. It is not required to transact.")}
            It is a measure of how much headroom this cohort has before limits start
            refusing them, not a step they must pass to become a customer.</p>
        </div>
      </div>
      <div class="mk-panel">
        <div class="mk-panel-head"><div>
          <h3>Weekly frequency</h3>
          <small>How often an active customer actually transacts — the habit metric.</small>
        </div></div>
        ${table(["Week", "Actives", "Transactions", "Per active"],
          (freq.series || []).map((w) => [
            H.escapeHtml(weekLabel(w.week)), num(w.actives), num(w.transactions), num(w.perActive)
          ]),
          "No completed transactions in this window.")}
        <p class="mk-form-note">Counted per active customer, not per registered one. A wallet
          whose actives transact once a week is something people remember when a bill is due;
          one whose actives transact four times a week is where their money lives.</p>
      </div>
      ${retentionPanel(cohorts)}`;

    // Exported as the cohort grid, because that is the artefact somebody takes
    // into a meeting. One row per cohort, one column per week.
    H.PAGE_EXPORTS.marketing = () => H.downloadCsv("activation-retention.csv",
      ["Registered week", "Cohort size", ...(cohorts[0]?.retention || []).map((r) => `Week ${r.week} %`)],
      cohorts.map((c) => [weekLabel(c.cohortWeek), c.size, ...c.retention.map((r) => r.rate)]));
  } catch (error) {
    root.innerHTML = errorState(error);
  }
}

/* --------------------------------------------------------------------- ROI */

async function viewRoi(root) {
  root.innerHTML = loadingState("ROI and attribution");
  try {
    const data = await H.apiFetch(`/admin/marketing/roi?range=${encodeURIComponent(state.range)}`);
    const rows = (data.items || []).map((item) => [
      `<strong>${H.escapeHtml(item.name)}</strong><small>${H.escapeHtml(title(item.type))}</small>`,
      statusChip(item.status),
      H.money(item.marketingCost),
      H.money(item.directRevenue),
      H.money(item.assistedRevenue),
      H.money(item.estimatedRevenue),
      H.money(item.netReturn),
      item.roiPercent === null
        ? `—${item.note ? `<small class="mk-warn">${H.escapeHtml(item.note)}</small>` : ""}`
        : `${item.roiPercent}%`
    ]);
    root.innerHTML = `
      ${rangePicker()}
      <div class="mk-note"><strong>Three different numbers, never added together.</strong>
        <em>Direct</em> is revenue we can tie to the campaign. <em>Assisted</em> is revenue a
        campaign touched but did not close. <em>Estimated</em> is modelled. Only direct revenue
        feeds net return and ROI.</div>
      ${table(["Campaign", "Status", "Cost", "Direct revenue", "Assisted", "Estimated",
        "Net return", "ROI"], rows, "No campaigns with activity in this period.")}`;
    H.PAGE_EXPORTS.marketing = () => H.downloadCsv("marketing-roi.csv",
      ["Campaign", "Status", "Cost", "Direct revenue", "Assisted", "Estimated", "Net return", "ROI %"],
      (data.items || []).map((i) => [i.name, i.status, i.marketingCost, i.directRevenue,
        i.assistedRevenue, i.estimatedRevenue, i.netReturn, i.roiPercent ?? ""]));
  } catch (error) {
    root.innerHTML = errorState(error);
  }
}

/* -------------------------------------------------------------- dispatch */

const RENDERERS = {
  overview: viewOverview, growth: viewGrowth, campaigns: viewCampaigns, audiences: viewAudiences,
  promotions: viewPromotions, referrals: viewReferrals, leads: viewLeads,
  pipeline: viewPipeline, acquisition: viewAcquisition, team: viewTeam,
  links: viewLinks, experiments: viewExperiments, analytics: viewAnalytics, roi: viewRoi
};

async function renderCurrentView(container) {
  const body = container.querySelector("[data-mk-body]");
  if (!body) return;
  const renderer = RENDERERS[state.view] || viewOverview;
  await renderer(body);
}

function formValues(form) {
  const data = {};
  for (const [key, value] of new FormData(form).entries()) {
    if (key === "channels") {
      data.channels = data.channels || [];
      data.channels.push(value);
    } else if (value !== "") {
      data[key] = value;
    }
  }
  return data;
}

// One delegated listener for the whole module. Re-rendering a view replaces its
// markup, so per-element listeners would leak; delegation survives every
// re-render and keeps the console's single-listener convention.
function wire(container) {
  container.addEventListener("click", async (event) => {
    const tab = event.target.closest("[data-mk-view]");
    if (tab) {
      state.view = tab.dataset.mkView;
      container.innerHTML = shell(loadingState("this section"));
      await renderCurrentView(container);
      return;
    }
    const range = event.target.closest("[data-mk-range]");
    if (range) {
      state.range = range.dataset.mkRange;
      await renderCurrentView(container);
      return;
    }
    // The cohort window is its own control, not the range picker: it selects
    // WHO is being followed, not WHEN the activity happened.
    const cohort = event.target.closest("[data-mk-cohort]");
    if (cohort) {
      state.cohortDays = Number(cohort.dataset.mkCohort) || 30;
      await renderCurrentView(container);
      return;
    }
    const build = event.target.closest("[data-mk-audience-build]");
    if (build) {
      build.disabled = true;
      try {
        const result = await H.apiFetch(`/admin/marketing/audiences/${build.dataset.mkAudienceBuild}/build`,
          { method: "POST" });
        H.showToast(`Audience rebuilt — ${result.size} member(s).`, "success");
        await renderCurrentView(container);
      } catch (error) {
        H.showToast(H.adminErrorMessage(error), "error");
        build.disabled = false;
      }
      return;
    }
    const promoStatus = event.target.closest("[data-mk-promo-status]");
    if (promoStatus) {
      const next = promoStatus.dataset.mkStatus;
      if (next === "active" && !window.confirm("Activate this promotion? Customers will be able to redeem it.")) return;
      try {
        await H.apiFetch(`/admin/marketing/promotions/${promoStatus.dataset.mkPromoStatus}`,
          { method: "PATCH", body: { status: next } });
        H.showToast(`Promotion ${next}.`, "success");
        await renderCurrentView(container);
      } catch (error) { H.showToast(H.adminErrorMessage(error), "error"); }
      return;
    }
    const referralEval = event.target.closest("[data-mk-referral-eval]");
    if (referralEval) {
      try {
        const result = await H.apiFetch(`/admin/marketing/referrals/${referralEval.dataset.mkReferralEval}/evaluate`,
          { method: "POST" });
        H.showToast(result.reason, result.status === "qualified" ? "success" : "info");
        await renderCurrentView(container);
      } catch (error) { H.showToast(H.adminErrorMessage(error), "error"); }
      return;
    }
    const spend = event.target.closest("[data-mk-campaign-spend]");
    if (spend) {
      const amount = window.prompt("Spend amount in Rand");
      if (!amount) return;
      const description = window.prompt("What was it for?") || "";
      try {
        await H.apiFetch(`/admin/marketing/campaigns/${spend.dataset.mkCampaignSpend}/spend`,
          { method: "POST", body: { amount: Number(amount), description } });
        H.showToast("Spend recorded.", "success");
        await renderCurrentView(container);
      } catch (error) { H.showToast(H.adminErrorMessage(error), "error"); }
    }
  });

  container.addEventListener("change", async (event) => {
    const move = event.target.closest("[data-mk-lead-move]");
    if (!move) return;
    const status = move.value;
    let lostReason = null;
    if (status === "lost") {
      lostReason = window.prompt("Why was this lead lost?");
      if (!lostReason) { await renderCurrentView(container); return; }
    }
    try {
      await H.apiFetch(`/admin/marketing/leads/${move.dataset.mkLeadMove}`,
        { method: "PATCH", body: { status, lostReason } });
      H.showToast(`Lead moved to ${title(status)}.`, "success");
      await renderCurrentView(container);
    } catch (error) {
      H.showToast(H.adminErrorMessage(error), "error");
      await renderCurrentView(container);
    }
  });

  container.addEventListener("submit", async (event) => {
    const form = event.target.closest("[data-mk-form]");
    if (!form) return;
    event.preventDefault();
    const kind = form.dataset.mkForm;
    const values = formValues(form);
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      if (kind === "campaign") {
        await H.apiFetch("/admin/marketing/campaigns", { method: "POST", body: {
          ...values, budget: Number(values.budget || 0) } });
        H.showToast("Campaign created as a draft.", "success");
      } else if (kind === "audience") {
        await H.apiFetch("/admin/marketing/audiences", { method: "POST", body: {
          name: values.name, preset: values.preset,
          definition: { days: Number(values.days) || undefined, threshold: Number(values.threshold) || undefined } } });
        H.showToast("Audience created. Rebuild it to populate membership.", "success");
      } else if (kind === "promotion") {
        await H.apiFetch("/admin/marketing/promotions", { method: "POST", body: values });
        H.showToast("Promotion created as a draft.", "success");
      } else if (kind === "lead") {
        await H.apiFetch("/admin/marketing/leads", { method: "POST", body: values });
        H.showToast("Lead created.", "success");
      } else if (kind === "affiliate") {
        await H.apiFetch("/admin/marketing/affiliates", { method: "POST", body: {
          ...values, commissionValue: Number(values.commissionValue || 0) } });
        H.showToast("Affiliate added.", "success");
      } else if (kind === "link") {
        await H.apiFetch("/admin/marketing/links", { method: "POST", body: values });
        H.showToast("Tracked link created.", "success");
      } else if (kind === "experiment") {
        const share = Number(values.split) || 50;
        await H.apiFetch("/admin/marketing/experiments", { method: "POST", body: {
          name: values.name, hypothesis: values.hypothesis,
          variants: [
            { name: values.variantAName, allocationPercent: share, cost: Number(values.variantACost || 0) },
            { name: values.variantBName, allocationPercent: 100 - share, cost: Number(values.variantBCost || 0) }
          ] } });
        H.showToast("Experiment created.", "success");
      }
      form.reset();
      await renderCurrentView(container);
    } catch (error) {
      H.showToast(H.adminErrorMessage(error), "error");
    } finally {
      if (submit) submit.disabled = false;
    }
  });

  container.addEventListener("input", (event) => {
    const search = event.target.closest("[data-mk-lead-search]");
    if (!search) return;
    // Filters the rows already on screen. Deliberately not a refetch: typing
    // must not put a query per keystroke on the database.
    const needle = search.value.trim().toLowerCase();
    for (const row of container.querySelectorAll("tbody tr")) {
      row.hidden = Boolean(needle) && !row.textContent.toLowerCase().includes(needle);
    }
  });
}

export async function renderMarketing(me, host, view = "overview") {
  H = host;
  // #page-content is the region admin.js clears for each page. Writing into
  // .admin-shell instead would replace the sidebar and header along with the
  // page, which is exactly what happened the first time this was wired up.
  const container = document.getElementById("page-content");
  if (!container) return;
  if (RENDERERS[view]) state.view = view;
  container.innerHTML = shell(loadingState("the marketing overview"));
  if (!container.dataset.mkWired) {
    wire(container);
    container.dataset.mkWired = "1";
  }
  await renderCurrentView(container);
}
