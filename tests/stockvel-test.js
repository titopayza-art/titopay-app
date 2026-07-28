const { launchOptions, BASE_URL, CATALOGUE, ROOT } = require("./lib/env");
const { chromium, devices } = require("playwright");
const fs = require("fs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.SHOT_DIR || "tests/artifacts";

// MODE: ready | notprovisioned | empty | offline
const MODE = process.argv[2] || "ready";

const MEMBERS = [
  { id: "m1", name: "Naledi Mokoena", username: "naledi", verified: true, role: "Organiser", joinedAt: "2026-01-12", status: "paid", lastContributionAt: "2026-07-25", lastContributionAmount: 500, totalContributed: 3500, streak: 7 },
  { id: "m2", name: "Thabo Dlamini", username: "thabo", verified: true, role: "Member", joinedAt: "2026-01-14", status: "outstanding", lastContributionAt: "2026-06-25", lastContributionAmount: 500, outstandingAmount: 500 },
  { id: "m3", name: "Zanele Khumalo", username: "zanele", verified: false, role: "Member", joinedAt: "2026-02-02", status: "missed" },
  { id: "m4", name: "Sipho Ndlovu", username: "sipho", verified: true, role: "Member", joinedAt: "2026-02-20", status: "paid", lastContributionAt: "2026-07-24" }
];

const GROUP = {
  id: "stk-1", name: "Ubuntu Family Savings", description: "Saving together for December groceries and school fees.",
  role: "Organiser", cadence: "Monthly", contributionDay: "25th", contributionAmount: 500,
  balance: 14000, goalAmount: 24000, totalContributed: 14000, myContribution: 3500,
  memberCount: 4, memberLimit: 12, membersPaid: 2, membersOutstanding: 2,
  nextContributionAt: "2026-08-25", nextContributionAmount: 500, myStatus: "paid", myStreak: 7,
  myOutstanding: 500, outstandingTotal: 1000, canManage: true,
  inviteCode: "TP-STK-4471", inviteUrl: "https://app.titopay.co.za/stokvel/join/TP-STK-4471",
  startDate: "2026-01-12", members: MEMBERS,
  contributions: [
    { id: "c1", memberName: "Naledi Mokoena", amount: 500, dueDate: "2026-07-25", paidAt: "2026-07-25", status: "paid", reference: "STK-0725-N" },
    { id: "c2", memberName: "Sipho Ndlovu", amount: 500, dueDate: "2026-07-25", paidAt: "2026-07-24", status: "paid", reference: "STK-0725-S" },
    { id: "c3", memberName: "Thabo Dlamini", amount: 500, dueDate: "2026-07-25", status: "outstanding" },
    { id: "c4", memberName: "Zanele Khumalo", amount: 500, dueDate: "2026-06-25", status: "missed" },
    { id: "c5", memberName: "Naledi Mokoena", amount: 500, dueDate: "2026-06-25", paidAt: "2026-06-25", status: "paid" }
  ],
  activity: [
    { id: "a1", kind: "contribution", title: "Naledi contributed R 500.00", actor: "Naledi Mokoena", amount: 500, at: "2026-07-25T09:12:00Z" },
    { id: "a2", kind: "member_joined", title: "Sipho Ndlovu joined the group", actor: "Sipho Ndlovu", at: "2026-02-20T08:00:00Z" },
    { id: "a3", kind: "withdrawal", title: "Withdrawal requested for school fees", actor: "Naledi Mokoena", amount: 4000, at: "2026-07-20T14:30:00Z" },
    { id: "a4", kind: "vote", title: "Approval needed for the July withdrawal", at: "2026-07-20T14:31:00Z" },
    { id: "a5", kind: "announcement", title: "Contribution day moves to the 25th", actor: "Naledi Mokoena", at: "2026-03-01T10:00:00Z" },
    { id: "a6", kind: "contribution", title: "Thabo missed the June contribution", actor: "Thabo Dlamini", at: "2026-06-26T06:00:00Z" }
  ],
  withdrawals: [
    { id: "w1", amount: 4000, requestedBy: "Naledi Mokoena", reason: "School fees for the January term", status: "pending", approvals: 2, approvalsRequired: 3, requestedAt: "2026-07-20", approvedBy: ["Sipho Ndlovu", "Zanele Khumalo"] },
    { id: "w2", amount: 1200, requestedBy: "Thabo Dlamini", reason: "Emergency medical expense", status: "paid", approvals: 3, approvalsRequired: 3, requestedAt: "2026-05-11" }
  ]
};

(async () => {
  const cat = JSON.parse(fs.readFileSync(CATALOGUE, "utf8"));
  // Stockvel is hidden in the shipped catalogue until its backend exists. The
  // feature itself is still built and still has to keep working, so this
  // harness serves a catalogue with it switched on -- exactly what the live
  // catalogue will look like on the day it is enabled.
  (cat.items || []).forEach((row) => {
    if (row.service_code === "stockvel") row.personal_visible = true;
  });
  const browser = await chromium.launch({ ...launchOptions() });
  const ctx = await browser.newContext(devices["iPhone 13"]);
  await ctx.addInitScript(() => localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({ accessToken: "t", refreshToken: "r" })));

  let txPosts = 0, lastTxBody = null, memberCalls = [], inviteCalls = [], inviteSends = [], withdrawalRequests = [], voteCalls = [], closeCalls = [];
  await ctx.route("https://api.titopay.co.za/**", async (route) => {
    const u = new URL(route.request().url());
    const m = route.request().method();
    const J = (st, b) => route.fulfill({ status: st, contentType: "application/json", body: JSON.stringify(b) });

    if (u.pathname.startsWith("/v1/stockvels")) {
      if (MODE === "notprovisioned") return J(404, { error: "Not found" });
      if (MODE === "offline") return route.abort("failed");
      if (u.pathname === "/v1/stockvels/invitations") {
        return J(200, { items: MODE === "empty" ? [] : [{ id: "inv-1", stockvelId: "stk-9", stockvelName: "Church Building Fund", invitedBy: "Pastor Mokoena", contributionAmount: 300, cadence: "Monthly", memberCount: 18 }] });
      }
      if (/\/invitations\/[^/]+\/(accept|decline)$/.test(u.pathname)) {
        inviteCalls.push(u.pathname);
        return J(200, { stockvel: GROUP });
      }
      if (/\/invitations$/.test(u.pathname) && m === "POST") {
        inviteSends.push(route.request().postDataJSON());
        return J(200, { invited: 2 });
      }
      if (/\/withdrawals$/.test(u.pathname) && m === "POST") {
        withdrawalRequests.push(route.request().postDataJSON());
        return J(200, { withdrawal: { id: "w9", status: "pending" } });
      }
      if (/\/withdrawals\/[^/]+\/(approve|decline)$/.test(u.pathname)) {
        voteCalls.push(u.pathname);
        return J(200, { ok: true });
      }
      if (u.pathname === "/v1/stockvels/stk-1" && m === "DELETE") {
        closeCalls.push("DELETE");
        return J(200, { ok: true });
      }
      if (u.pathname === "/v1/stockvels") {
        await sleep(160);
        return J(200, { items: MODE === "empty" ? [] : [GROUP] });
      }
      if (/\/members\/[^/]+\/(promote|demote)$/.test(u.pathname) || (m === "DELETE" && /\/members\//.test(u.pathname))) {
        memberCalls.push(`${m} ${u.pathname}`);
        return J(404, { error: "Not found" });
      }
      await sleep(140);
      return J(200, { stockvel: GROUP });
    }
    if (u.pathname === "/v1/transactions/fee-preview") {
      const a = Number((route.request().postDataJSON() || {}).amount || 0);
      return J(200, { preview: { amount: a, fee: 0, thirdPartyFee: 0, total: a, recipientAmount: a } });
    }
    if (u.pathname === "/v1/transactions" && m === "POST") {
      txPosts += 1; lastTxBody = route.request().postDataJSON(); await sleep(140);
      return J(200, { transaction: { id: "t1", reference: "STK-1", status: "completed", amount: 500, total: 500 } });
    }
    if (u.pathname.includes("/recipient/verify")) return J(200, { registered: true, user: { fullName: "Naledi Mokoena", username: "naledi" } });
    let body = { ok: true, items: [] };
    if (u.pathname === "/health") body = { status: "ok" };
    else if (u.pathname === "/v1/maintenance/public") body = { maintenance: { pwa: { enabled: false } } };
    else if (u.pathname === "/v1/services") body = cat;
    else if (u.pathname === "/v1/auth/me") body = { user: { id: "u1", fullName: "QA User", username: "qa", accountType: "personal", status: "active", walletId: "81234567", ficaStatus: "approved", phone: "+27821234567" } };
    else if (u.pathname === "/v1/wallets") body = { items: [{ wallet_id: "81234567", available_balance: 12847.5 }] };
    J(200, body);
  });

  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + String(e).slice(0, 170)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|frame-ancestors|WebSocket/.test(m.text())) errs.push("console: " + m.text().slice(0, 130)); });
  await page.goto(`${BASE_URL}/index.html#services`, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(3400);

  const R = { mode: MODE };
  const openHub = async () => {
    // Dismiss whatever modal is open first; several Stockvel actions correctly
    // keep their sheet open after reporting a problem.
    for (let i = 0; i < 4; i += 1) {
      const open = await page.evaluate(() => !!document.querySelector(".modal-backdrop"));
      if (!open) break;
      await page.evaluate(() => document.querySelector(".modal-card [data-close]")?.click());
      await page.waitForTimeout(300);
    }
    await page.evaluate(() => { location.hash = "services"; });
    await page.waitForTimeout(450);
    const t = await page.$('[data-service="stockvel"]');
    if (!t) return false;
    await t.click();
    await page.waitForTimeout(1500);
    return true;
  };
  const close = async () => { await page.evaluate(() => document.querySelector(".modal-card [data-close]")?.click()); await page.waitForTimeout(330); };

  // ---- 1. HUB ----
  R.hubOpened = await openHub();
  R.hub = await page.evaluate(() => {
    const card = document.querySelector(".modal-card");
    return card && {
      heading: card.querySelector("h2")?.textContent.trim(),
      lead: card.querySelector(".lead")?.textContent.trim().slice(0, 90),
      groupCards: card.querySelectorAll("[data-stockvel-open]").length,
      groupName: card.querySelector(".sv-card-body strong")?.textContent.trim(),
      progressLabel: card.querySelector(".sv-progress")?.getAttribute("aria-label"),
      emptyHead: card.querySelector(".sv-empty strong")?.textContent.trim() || null,
      noticeHead: card.querySelector(".sv-notice-head")?.textContent.trim() || null,
      createCta: !!card.querySelector('[data-action="stockvel-create"]'),
      joinCta: !!card.querySelector('[data-action="stockvel-join"]')
    };
  });
  await page.screenshot({ path: `${OUT}/sv-hub-${MODE}.png` });

  if (MODE === "ready") {
    // ---- 2. DASHBOARD OVERVIEW ----
    await page.click("[data-stockvel-open]");
    await page.waitForTimeout(1600);
    R.overview = await page.evaluate(() => {
      const card = document.querySelector(".modal-card");
      return {
        title: card.querySelector("h2")?.textContent.trim(),
        avatar: !!card.querySelector(".sv-avatar"),
        tabs: [...card.querySelectorAll("[data-stockvel-section]")].map((t) => t.textContent.trim()),
        activeTab: card.querySelector(".sv-tab.is-active")?.textContent.trim(),
        goalLabel: card.querySelector(".sv-progress")?.getAttribute("aria-label"),
        stats: [...card.querySelectorAll(".sv-stat")].map((s) => `${s.querySelector("span")?.textContent.trim()}=${s.querySelector("strong")?.textContent.trim()}`),
        nextAmount: card.querySelector(".sv-next strong")?.textContent.trim(),
        nextWhen: card.querySelector(".sv-next small")?.textContent.trim(),
        cycles: card.querySelectorAll(".sv-cycle").length,
        recentActivity: card.querySelectorAll(".activity-list .activity-item").length,
        actions: [...card.querySelectorAll(".tx-detail-actions button")].map((b) => b.textContent.trim())
      };
    });
    await page.screenshot({ path: `${OUT}/sv-overview.png` });

    // ---- 3. MEMBERS + SEARCH ----
    await page.click('[data-stockvel-section="members"]');
    await page.waitForTimeout(600);
    R.members = await page.evaluate(() => {
      const card = document.querySelector(".modal-card");
      return {
        count: card.querySelectorAll(".sv-member").length,
        verifiedBadges: card.querySelectorAll(".sv-verified").length,
        names: [...card.querySelectorAll(".sv-member-body strong")].map((e) => e.textContent.trim()),
        statuses: [...card.querySelectorAll(".sv-member .sv-chip")].map((e) => e.textContent.trim()),
        manageButtons: card.querySelectorAll("[data-stockvel-member-menu]").length,
        hasSearch: !!card.querySelector("[data-stockvel-search]")
      };
    });
    await page.fill("[data-stockvel-search]", "thabo");
    await page.waitForTimeout(500);
    R.memberSearch = await page.evaluate(() => ({
      shown: [...document.querySelectorAll(".sv-member-body strong")].map((e) => e.textContent.trim()),
      searchKept: document.querySelector("[data-stockvel-search]")?.value,
      focused: document.activeElement?.hasAttribute?.("data-stockvel-search")
    }));
    await page.screenshot({ path: `${OUT}/sv-members.png` });

    // member sheet -> action reports honestly when unavailable
    await page.fill("[data-stockvel-search]", "");
    await page.waitForTimeout(400);
    await page.click("[data-stockvel-member-menu]");
    await page.waitForTimeout(700);
    R.memberSheet = await page.evaluate(() => [...document.querySelectorAll("[data-stockvel-member-action]")].map((b) => b.dataset.stockvelMemberAction));
    await page.click('[data-stockvel-member-action="promote"]');
    await page.waitForTimeout(900);
    R.memberActionToast = await page.evaluate(() => document.querySelector(".toast")?.textContent.trim().slice(0, 80));
    R.memberCallsMade = memberCalls.length;
    await page.waitForTimeout(3600);

    // ---- 4. CONTRIBUTIONS ----
    await openHub();
    await page.click("[data-stockvel-open]");
    await page.waitForTimeout(1500);
    await page.click('[data-stockvel-section="contributions"]');
    await page.waitForTimeout(600);
    R.contributions = await page.evaluate(() => {
      const card = document.querySelector(".modal-card");
      return {
        stats: [...card.querySelectorAll(".sv-stat")].map((s) => `${s.querySelector("span")?.textContent.trim()}=${s.querySelector("strong")?.textContent.trim()}`),
        rows: card.querySelectorAll(".activity-list .activity-item").length,
        statuses: [...card.querySelectorAll(".activity-item .sv-chip")].map((e) => e.textContent.trim()),
        contributeCta: !!card.querySelector("[data-stockvel-contribute]")
      };
    });
    // contribution goes through review-before-confirm
    await page.click("[data-stockvel-contribute]");
    await page.waitForTimeout(900);
    R.contributeForm = await page.evaluate(() => {
      const f = document.querySelector(".modal-card form[data-form]");
      return { form: f?.dataset.form, amount: f?.querySelector('[name="amount"]')?.value, groupId: f?.querySelector('[name="stockvelGroupId"]')?.value };
    });
    R.postsBeforeSubmit = txPosts;
    await page.click(".modal-card form[data-form] button[type=submit]");
    await page.waitForTimeout(2100);
    R.contributeReview = await page.evaluate(() => ({
      reviewOpen: !!document.querySelector('[data-action="confirm-transaction-review"]'),
      rows: [...document.querySelectorAll(".review-transaction-list .activity-item")].map((e) => e.textContent.replace(/\s+/g, " ").trim()).filter((t) => /Amount|Total/.test(t))
    }));
    R.postsAtReview = txPosts;
    const conf = await page.$('[data-action="confirm-transaction-review"]');
    if (conf) {
      txPosts = 0;
      await conf.click();
      await conf.click({ force: true }).catch(() => {});
      await page.waitForTimeout(2300);
      R.contributeConfirm = { posts: txPosts, metadata: lastTxBody ? Object.keys(lastTxBody.metadata || {}).filter((k) => k.startsWith("stockvel")).sort() : null };
    }
    await page.screenshot({ path: `${OUT}/sv-contributions.png` });

    // ---- 5. ACTIVITY FILTERS ----
    await openHub();
    await page.click("[data-stockvel-open]");
    await page.waitForTimeout(1500);
    await page.click('[data-stockvel-section="activity"]');
    await page.waitForTimeout(600);
    R.activityAll = await page.evaluate(() => ({
      filters: [...document.querySelectorAll("[data-stockvel-activity-filter]")].map((b) => b.textContent.trim()),
      items: document.querySelectorAll(".sv-timeline .activity-item").length
    }));
    await page.click('[data-stockvel-activity-filter="withdrawal"]');
    await page.waitForTimeout(500);
    R.activityFiltered = await page.evaluate(() => ({
      items: [...document.querySelectorAll(".sv-timeline .activity-item strong")].map((e) => e.textContent.trim()),
      pressed: document.querySelector('[data-stockvel-activity-filter="withdrawal"]')?.getAttribute("aria-pressed")
    }));
    await page.screenshot({ path: `${OUT}/sv-activity.png` });

    // ---- 6. WITHDRAWALS ----
    await page.click('[data-stockvel-section="withdrawals"]');
    await page.waitForTimeout(600);
    R.withdrawals = await page.evaluate(() => ({
      count: document.querySelectorAll(".sv-withdrawal").length,
      amounts: [...document.querySelectorAll(".sv-withdrawal-head strong")].map((e) => e.textContent.trim()),
      approvalLabels: [...document.querySelectorAll(".sv-withdrawal .sv-progress")].map((e) => e.getAttribute("aria-label")),
      remaining: [...document.querySelectorAll(".sv-withdrawal .sv-goal-head strong")].map((e) => e.textContent.trim()),
      reasons: [...document.querySelectorAll(".sv-withdrawal-reason")].map((e) => e.textContent.trim().slice(0, 40))
    }));
    await page.screenshot({ path: `${OUT}/sv-withdrawals.png` });

    // ---- 7. SETTINGS + DANGER ZONE ----
    await page.click('[data-stockvel-section="settings"]');
    await page.waitForTimeout(600);
    R.settings = await page.evaluate(() => {
      const card = document.querySelector(".modal-card");
      return {
        sectionLabels: [...card.querySelectorAll(".sv-section-label")].map((e) => e.textContent.trim()),
        notificationRows: [...card.querySelectorAll(".activity-list .activity-item strong")].map((e) => e.textContent.trim()),
        dangerZone: !!card.querySelector(".sv-danger"),
        leaveButton: !!card.querySelector("[data-stockvel-leave]")
      };
    });
    await page.click("[data-stockvel-leave]");
    await page.waitForTimeout(700);
    R.leaveConfirm = await page.evaluate(() => ({
      heading: document.querySelector(".modal-card h2")?.textContent.trim(),
      warns: document.querySelector(".failure-message")?.textContent.trim().slice(0, 60),
      hasConfirm: !!document.querySelector("[data-stockvel-leave-confirm]"),
      hasStay: !!document.querySelector(".modal-card .btn.secondary[data-close]")
    }));
    await page.screenshot({ path: `${OUT}/sv-settings.png` });
    await close();

    // ---- 8. STATEMENT + INVITE ----
    await openHub();
    await page.click("[data-stockvel-open]");
    await page.waitForTimeout(1500);
    await page.click("[data-stockvel-statement]");
    await page.waitForTimeout(800);
    R.statement = await page.evaluate(() => ({
      card: !!document.querySelector(".sv-statement"),
      rows: document.querySelectorAll(".sv-statement dl > div").length,
      note: document.querySelector(".sv-statement-note")?.textContent.trim().slice(0, 70),
      logo: !!document.querySelector(".receipt-logo")
    }));
    await page.screenshot({ path: `${OUT}/sv-statement.png` });
    await close();
    await openHub();
    await page.click("[data-stockvel-open]");
    await page.waitForTimeout(1500);
    await page.click("[data-stockvel-add-members]");
    await page.waitForTimeout(800);
    await page.click("[data-stockvel-invite]");
    await page.waitForTimeout(800);
    R.invite = await page.evaluate(() => ({
      code: document.querySelector(".vas-credential-value")?.textContent.trim(),
      copyButtons: document.querySelectorAll("[data-vas-copy]").length,
      shareButton: !!document.querySelector("[data-invite-share]")
    }));
    await close();
  }

  // ---- 9. CREATE WIZARD (all modes) ----
  await openHub();
  await page.click('[data-action="stockvel-create"]');
  await page.waitForTimeout(900);
  R.wizardStep0 = await page.evaluate(() => {
    const card = document.querySelector(".modal-card");
    return {
      title: card.querySelector("[data-stockvel-step-title]")?.textContent.trim(),
      steps: [...card.querySelectorAll(".sv-step-label")].map((e) => e.textContent.trim()),
      activeStep: card.querySelector(".sv-step.is-active .sv-step-label")?.textContent.trim(),
      visiblePanels: [...card.querySelectorAll("[data-stockvel-step]")].filter((p) => !p.hidden).map((p) => p.dataset.stockvelStep),
      backHidden: card.querySelector("[data-stockvel-back]")?.hidden,
      submitHidden: card.querySelector("[data-stockvel-submit]")?.hidden,
      fields: [...card.querySelectorAll("[data-stockvel-step='0'] [name]")].map((e) => e.name)
    };
  });
  // validation blocks an empty required field
  await page.click("[data-stockvel-next]");
  await page.waitForTimeout(400);
  R.wizardBlocked = await page.evaluate(() => document.querySelector(".sv-step.is-active .sv-step-label")?.textContent.trim());
  await page.fill('[name="recipient"]', "Ubuntu Family Savings");
  await page.fill('[name="stockvelSavingsGoal"]', "24000");
  await page.click("[data-stockvel-next]");
  await page.waitForTimeout(500);
  await page.fill('[name="amount"]', "500");
  await page.fill('[name="stockvelContributionDay"]', "25th");
  await page.click("[data-stockvel-next]");
  await page.waitForTimeout(500);
  await page.fill('[name="members"]', "@naledi\n@thabo");
  await page.click("[data-stockvel-next]");
  await page.waitForTimeout(600);
  R.wizardStep3 = await page.evaluate(() => {
    const card = document.querySelector(".modal-card");
    return {
      title: card.querySelector("[data-stockvel-step-title]")?.textContent.trim(),
      summaryRows: [...card.querySelectorAll("[data-stockvel-summary] .activity-item")].map((e) => e.textContent.replace(/\s+/g, " ").trim()),
      submitVisible: !card.querySelector("[data-stockvel-submit]")?.hidden,
      nextHidden: card.querySelector("[data-stockvel-next]")?.hidden
    };
  });
  // going back preserves everything
  await page.click("[data-stockvel-back]");
  await page.waitForTimeout(500);
  await page.click("[data-stockvel-back]");
  await page.waitForTimeout(500);
  await page.click("[data-stockvel-back]");
  await page.waitForTimeout(500);
  R.wizardBackPreserved = await page.evaluate(() => {
    const f = document.querySelector("[data-stockvel-wizard]");
    return { step: f.querySelector(".sv-panel:not([hidden])")?.dataset.stockvelStep, name: f.querySelector('[name="recipient"]')?.value, goal: f.querySelector('[name="stockvelSavingsGoal"]')?.value, amount: f.querySelector('[name="amount"]')?.value, day: f.querySelector('[name="stockvelContributionDay"]')?.value, members: f.querySelector('[name="members"]')?.value };
  });
  await page.screenshot({ path: `${OUT}/sv-wizard-${MODE}.png` });

  // ---- 9b. NEWLY CLOSED GAPS ----
  if (MODE === "ready") {
    await openHub();
    R.invitationCard = await page.evaluate(() => {
      const inv = document.querySelector(".sv-invite");
      return inv && { name: inv.querySelector("strong")?.textContent.trim(), meta: inv.querySelector("small")?.textContent.trim(), accept: !!inv.querySelector("[data-stockvel-invite-accept]"), decline: !!inv.querySelector("[data-stockvel-invite-decline]") };
    });
    // invite members into an existing group
    await page.click("[data-stockvel-open]");
    await page.waitForTimeout(1500);
    R.overviewActions = await page.evaluate(() => [...document.querySelectorAll(".tx-detail-actions button")].map((b) => b.textContent.trim()));
    await page.click("[data-stockvel-add-members]");
    await page.waitForTimeout(800);
    await page.fill('[name="members"]', "@lerato\n+27715550001");
    await page.click('.modal-card form[data-form="stockvel-add-members"] button[type=submit]');
    await page.waitForTimeout(1400);
    R.inviteSent = { calls: inviteSends.length, members: inviteSends[0] ? inviteSends[0].members : null };
    // withdrawal request
    await openHub();
    await page.click("[data-stockvel-open]");
    await page.waitForTimeout(1500);
    await page.click("[data-stockvel-withdraw]");
    await page.waitForTimeout(800);
    await page.fill('[name="amount"]', "2500");
    await page.fill('[name="reason"]', "December groceries for the group");
    await page.click('.modal-card form[data-form="stockvel-withdrawal"] button[type=submit]');
    await page.waitForTimeout(1500);
    R.withdrawalRequested = { calls: withdrawalRequests.length, body: withdrawalRequests[0] || null };
    // approve a pending withdrawal
    await openHub();
    await page.click("[data-stockvel-open]");
    await page.waitForTimeout(1500);
    await page.click('[data-stockvel-section="withdrawals"]');
    await page.waitForTimeout(600);
    R.voteButtons = await page.evaluate(() => ({
      approve: document.querySelectorAll("[data-stockvel-withdrawal-approve]").length,
      decline: document.querySelectorAll("[data-stockvel-withdrawal-decline]").length,
      requestCta: !!document.querySelector("[data-stockvel-withdraw]")
    }));
    const approve = await page.$("[data-stockvel-withdrawal-approve]");
    if (approve) { await approve.click(); await page.waitForTimeout(1400); }
    R.voteRecorded = voteCalls.length;
    // outstanding balances surfaced
    await openHub();
    await page.click("[data-stockvel-open]");
    await page.waitForTimeout(1500);
    R.outstandingStats = await page.evaluate(() => [...document.querySelectorAll(".sv-stat")].map((s) => `${s.querySelector("span")?.textContent.trim()}=${s.querySelector("strong")?.textContent.trim()}`).filter((t) => /Outstanding|owe/i.test(t)));
    await page.click('[data-stockvel-section="members"]');
    await page.waitForTimeout(600);
    R.memberOwed = await page.evaluate(() => [...document.querySelectorAll(".sv-owed")].map((e) => e.textContent.trim()));
    // contribute CTA present even with no contribution history
    R.contributeAlwaysAvailable = await page.evaluate(async () => {
      state.stockvel.detail.contributions = [];
      renderStockvelSection();
      document.querySelector('[data-stockvel-section="contributions"]').click();
      await new Promise((r) => setTimeout(r, 400));
      return { cta: !!document.querySelector("[data-stockvel-contribute]"), notice: !!document.querySelector(".sv-notice-head") };
    });
    // close group requires the exact name
    await openHub();
    await page.click("[data-stockvel-open]");
    await page.waitForTimeout(1500);
    await page.click('[data-stockvel-section="settings"]');
    await page.waitForTimeout(600);
    R.closeAvailable = await page.evaluate(() => !!document.querySelector("[data-stockvel-close]"));
    await page.click("[data-stockvel-close]");
    await page.waitForTimeout(800);
    await page.fill('[name="confirmName"]', "Wrong Name");
    await page.click('.modal-card form[data-form="stockvel-close"] button[type=submit]');
    await page.waitForTimeout(900);
    R.closeWrongName = { calls: closeCalls.length, toast: await page.evaluate(() => document.querySelector(".toast")?.textContent.trim().slice(0, 60)) };
    await page.fill('[name="confirmName"]', "Ubuntu Family Savings");
    await page.click('.modal-card form[data-form="stockvel-close"] button[type=submit]');
    await page.waitForTimeout(1600);
    R.closeRightName = { calls: closeCalls.length };
    // notification recorded for a contribution the client witnessed
    R.notificationRecorded = await page.evaluate(() => (state.notifications || []).some((n) => /Contribution recorded/i.test(n.title || "")));
  }

  // ---- 10. NO REGULATED LANGUAGE ANYWHERE ----
  R.regulatedLanguage = await page.evaluate(() => {
    const text = document.body.textContent || "";
    const banned = ["interest", "invest", "portfolio", "return on", "wealth", "risk profile", "asset allocation", "insurance", "loan", "credit score", "buy now pay later"];
    return banned.filter((word) => new RegExp(word, "i").test(text));
  });

  R.txPosts = txPosts;
  R.errors = errs;
  R.overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  console.log(JSON.stringify(R, null, 1));
  await browser.close();
})();
