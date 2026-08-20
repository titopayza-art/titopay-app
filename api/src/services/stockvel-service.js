"use strict";

// Stokvel groups — the server behind /v1/stockvels, which the app has been
// calling since the hub shipped. A stokvel here is a transparent register:
// the group, its members, who has contributed (read straight from the same
// transactions the wallet already recorded), a group chat for members, and
// meetings whose minutes are compiled the moment the chair closes them.
//
// Deliberately NOT here: new money paths. Contributions keep flowing through
// the existing transaction flow; withdrawals are recorded and approved here
// but paid out with a normal transfer. A stokvel holds what its members
// contribute — nothing more, and this service never invents a balance.

const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { boundedText } = require("../lib/validation");

const money = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

let schemaReady = null;
function ensureStockvelSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS stockvel_groups (
          id UUID PRIMARY KEY,
          owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          cadence TEXT NOT NULL DEFAULT 'monthly',
          contribution_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
          goal_amount NUMERIC(18,2),
          member_limit INTEGER,
          invite_code TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','closed')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS stockvel_members (
          id UUID PRIMARY KEY,
          group_id UUID NOT NULL REFERENCES stockvel_groups(id) ON DELETE CASCADE,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('chair','organiser','member')),
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed','left')),
          joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (group_id, user_id)
        )`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS stockvel_withdrawals (
          id UUID PRIMARY KEY,
          group_id UUID NOT NULL REFERENCES stockvel_groups(id) ON DELETE CASCADE,
          requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          amount NUMERIC(18,2) NOT NULL,
          reason TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','declined')),
          decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          decided_at TIMESTAMPTZ
        )`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS stockvel_messages (
          id UUID PRIMARY KEY,
          group_id UUID NOT NULL REFERENCES stockvel_groups(id) ON DELETE CASCADE,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          message TEXT NOT NULL,
          is_decision BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await pool.query(
        "CREATE INDEX IF NOT EXISTS idx_stockvel_messages_group ON stockvel_messages (group_id, created_at)"
      );
      await pool.query(`
        CREATE TABLE IF NOT EXISTS stockvel_meetings (
          id UUID PRIMARY KEY,
          group_id UUID NOT NULL REFERENCES stockvel_groups(id) ON DELETE CASCADE,
          opened_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          closed_by UUID REFERENCES users(id) ON DELETE SET NULL,
          closed_at TIMESTAMPTZ,
          title TEXT NOT NULL DEFAULT 'Stokvel meeting',
          minutes TEXT,
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed'))
        )`);
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

function mintInviteCode() {
  return `SV${String(crypto.randomInt(0, 10 ** 8)).padStart(8, "0")}`;
}

async function membership(groupId, userId) {
  const { rows } = await pool.query(
    "SELECT * FROM stockvel_members WHERE group_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1",
    [groupId, userId]
  );
  return rows[0] || null;
}

async function requireMember(groupId, userId) {
  await ensureStockvelSchema();
  const member = await membership(groupId, userId);
  if (!member) throw new AppError(404, "Savings group not found");
  return member;
}

async function requireManager(groupId, userId) {
  const member = await requireMember(groupId, userId);
  if (!["chair", "organiser"].includes(member.role)) {
    throw new AppError(403, "Only the group's organisers can do that");
  }
  return member;
}

// Contributions are the transactions the wallet already recorded — the same
// rands the member saw leave, never a parallel tally that can drift.
async function contributionRows(groupId) {
  const { rows } = await pool.query(
    `SELECT t.id, t.user_id, t.amount, t.total, t.status, t.reference, t.created_at, u.full_name, u.username
     FROM transactions t
     JOIN users u ON u.id = t.user_id
     WHERE t.service_code IN ('stockvel', 'stockvel_contribution')
       AND t.status = 'completed'
       AND (t.metadata->>'stockvelGroupId') = $1
     ORDER BY t.created_at DESC
     LIMIT 500`,
    [String(groupId)]
  );
  return rows;
}

// A TOTAL IS COUNTED IN THE DATABASE, NOT IN A PAGE OF ROWS.
//
// contributionRows is a DISPLAY query: newest first, capped at 500, which is
// right for a register a person scrolls. Summing it was not. Past 500
// contributions the cap silently dropped the OLDEST rows, so a group's recorded
// savings started going DOWN as it kept saving: 20 members contributing monthly
// cross 500 records inside 26 months, which is an ordinary stokvel, not an edge
// case. The same mistake gave each member a shrinking "your contribution".
//
// Both totals now come from SUM() over every matching row. The display query is
// unchanged and still capped, because that part was never the problem.
async function contributionTotals(groupId, userId = null) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(t.amount), 0) AS contributed,
            COALESCE(SUM(t.amount) FILTER (WHERE t.user_id = $2::uuid), 0) AS mine
       FROM transactions t
      WHERE t.service_code IN ('stockvel', 'stockvel_contribution')
        AND t.status = 'completed'
        AND (t.metadata->>'stockvelGroupId') = $1`,
    [String(groupId), userId]
  );
  return { contributed: money(rows[0].contributed), mine: money(rows[0].mine) };
}

async function groupBalance(groupId) {
  const { contributed } = await contributionTotals(groupId);
  const { rows } = await pool.query(
    "SELECT COALESCE(SUM(amount), 0) AS approved FROM stockvel_withdrawals WHERE group_id = $1 AND status = 'approved'",
    [groupId]
  );
  return { contributed, withdrawn: money(rows[0].approved), balance: money(contributed - Number(rows[0].approved)) };
}

function shapeGroup(row, extras = {}) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    cadence: row.cadence,
    contribution_amount: money(row.contribution_amount),
    goal_amount: row.goal_amount === null ? null : money(row.goal_amount),
    member_limit: row.member_limit,
    invite_code: row.invite_code,
    created_at: row.created_at,
    ...extras
  };
}

async function createGroup(userId, payload = {}) {
  await ensureStockvelSchema();
  const name = boundedText(payload.name || payload.recipient, "Group name", { min: 2, max: 120 });
  const description = payload.description ? boundedText(payload.description, "Description", { min: 1, max: 600 }) : "";
  const cadence = ["weekly", "fortnightly", "monthly"].includes(String(payload.cadence || payload.frequency).toLowerCase())
    ? String(payload.cadence || payload.frequency).toLowerCase() : "monthly";
  const contributionAmount = money(payload.contributionAmount ?? payload.amount);
  if (contributionAmount < 0 || contributionAmount > 1000000) throw new AppError(400, "Contribution amount must be between R0 and R1,000,000");
  const goalAmount = payload.goalAmount === undefined || payload.goalAmount === null || payload.goalAmount === "" ? null : money(payload.goalAmount);
  const memberLimit = payload.memberLimit ? Math.min(Math.max(Number(payload.memberLimit) || 0, 2), 200) : null;
  const status = payload.status === "draft" ? "draft" : "active";
  const id = uuidv4();
  let inviteCode = mintInviteCode();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { rows } = await pool.query("SELECT 1 FROM stockvel_groups WHERE invite_code = $1", [inviteCode]);
    if (!rows[0]) break;
    inviteCode = mintInviteCode();
  }
  const { rows } = await pool.query(
    `INSERT INTO stockvel_groups (id, owner_user_id, name, description, cadence, contribution_amount, goal_amount, member_limit, invite_code, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [id, userId, name, description, cadence, contributionAmount, goalAmount, memberLimit, inviteCode, status]
  );
  await pool.query(
    "INSERT INTO stockvel_members (id, group_id, user_id, role) VALUES ($1,$2,$3,'chair')",
    [uuidv4(), id, userId]
  );
  return shapeGroup(rows[0], { role: "chair", can_manage: true, member_count: 1 });
}

async function updateGroup(userId, groupId, payload = {}) {
  await requireManager(groupId, userId);
  const { rows: current } = await pool.query("SELECT * FROM stockvel_groups WHERE id = $1", [groupId]);
  const group = current[0];
  if (!group) throw new AppError(404, "Savings group not found");
  const name = payload.name !== undefined ? boundedText(payload.name, "Group name", { min: 2, max: 120 }) : group.name;
  const description = payload.description !== undefined ? String(payload.description).slice(0, 600) : group.description;
  const contributionAmount = payload.contributionAmount !== undefined ? money(payload.contributionAmount) : money(group.contribution_amount);
  let status = group.status;
  if (payload.status !== undefined) {
    if (!["draft", "active", "closed"].includes(String(payload.status))) throw new AppError(400, "Status must be draft, active or closed");
    status = String(payload.status);
  }
  const { rows } = await pool.query(
    `UPDATE stockvel_groups SET name=$2, description=$3, contribution_amount=$4, status=$5, updated_at=NOW()
     WHERE id=$1 RETURNING *`,
    [groupId, name, description, contributionAmount, status]
  );
  return shapeGroup(rows[0]);
}

async function listGroups(userId) {
  await ensureStockvelSchema();
  const { rows } = await pool.query(
    `SELECT g.*, m.role,
            (SELECT COUNT(*)::int FROM stockvel_members sm WHERE sm.group_id = g.id AND sm.status = 'active') AS member_count
     FROM stockvel_groups g
     JOIN stockvel_members m ON m.group_id = g.id AND m.user_id = $1 AND m.status = 'active'
     ORDER BY g.created_at DESC
     LIMIT 50`,
    [userId]
  );
  const items = [];
  for (const row of rows) {
    const totals = row.status === "draft" ? { contributed: 0, withdrawn: 0, balance: 0 } : await groupBalance(row.id);
    items.push(shapeGroup(row, {
      role: row.role,
      can_manage: ["chair", "organiser"].includes(row.role),
      member_count: Number(row.member_count),
      balance: totals.balance,
      total_contributed: totals.contributed
    }));
  }
  return items;
}

async function getGroup(userId, groupId) {
  const member = await requireMember(groupId, userId);
  const { rows } = await pool.query("SELECT * FROM stockvel_groups WHERE id = $1", [groupId]);
  const group = rows[0];
  if (!group) throw new AppError(404, "Savings group not found");
  const { rows: memberRows } = await pool.query(
    `SELECT sm.user_id AS id, sm.role, sm.status, sm.joined_at, u.full_name AS name, u.username
     FROM stockvel_members sm
     JOIN users u ON u.id = sm.user_id
     WHERE sm.group_id = $1 AND sm.status = 'active'
     ORDER BY sm.joined_at ASC`,
    [groupId]
  );
  const contributions = await contributionRows(groupId);
  const totals = await groupBalance(groupId);
  const { rows: withdrawalRows } = await pool.query(
    `SELECT w.*, u.full_name AS requester_name
     FROM stockvel_withdrawals w JOIN users u ON u.id = w.requested_by
     WHERE w.group_id = $1 ORDER BY w.created_at DESC LIMIT 50`,
    [groupId]
  );
  const { rows: meetingRows } = await pool.query(
    "SELECT * FROM stockvel_meetings WHERE group_id = $1 ORDER BY opened_at DESC LIMIT 20",
    [groupId]
  );
  // Counted in the database for the same reason the group total is: filtering
  // the capped display page would under-report a long-standing member.
  const { mine: myContribution } = await contributionTotals(groupId, userId);
  return shapeGroup(group, {
    role: member.role,
    can_manage: ["chair", "organiser"].includes(member.role),
    member_count: memberRows.length,
    balance: totals.balance,
    total_contributed: totals.contributed,
    my_contribution: myContribution,
    members: memberRows.map((row) => ({
      id: row.id, name: row.name, username: row.username, role: row.role, status: row.status, joined_at: row.joined_at
    })),
    contributions: contributions.map((row) => ({
      id: row.id, member: row.full_name, username: row.username, amount: money(row.amount),
      status: "paid", reference: row.reference, created_at: row.created_at
    })),
    withdrawals: withdrawalRows.map((row) => ({
      id: row.id, requester: row.requester_name, amount: money(row.amount), reason: row.reason,
      status: row.status, created_at: row.created_at
    })),
    meetings: meetingRows.map((row) => ({
      id: row.id, title: row.title, status: row.status, opened_at: row.opened_at, closed_at: row.closed_at, minutes: row.minutes
    })),
    activity: []
  });
}

async function joinByCode(userId, inviteCode) {
  await ensureStockvelSchema();
  const code = String(inviteCode || "").trim().toUpperCase();
  if (!code) throw new AppError(400, "Enter the group's invite code");
  const { rows } = await pool.query("SELECT * FROM stockvel_groups WHERE UPPER(invite_code) = $1 LIMIT 1", [code]);
  const group = rows[0];
  if (!group) throw new AppError(404, "No savings group matches that code. Check it with the person who invited you.");
  if (group.status === "closed") throw new AppError(409, "That group has been closed");
  if (group.status === "draft") throw new AppError(409, "That group is still being set up. Ask the organiser to activate it first");
  if (group.member_limit) {
    const { rows: countRows } = await pool.query(
      "SELECT COUNT(*)::int AS count FROM stockvel_members WHERE group_id = $1 AND status = 'active'", [group.id]);
    if (countRows[0].count >= group.member_limit) throw new AppError(409, "That group is full");
  }
  await pool.query(
    `INSERT INTO stockvel_members (id, group_id, user_id, role)
     VALUES ($1,$2,$3,'member')
     ON CONFLICT (group_id, user_id) DO UPDATE SET status = 'active', joined_at = CASE WHEN stockvel_members.status <> 'active' THEN NOW() ELSE stockvel_members.joined_at END`,
    [uuidv4(), group.id, userId]
  );
  return shapeGroup(group, { role: "member", member_count: undefined });
}

async function changeMemberRole(actorId, groupId, targetUserId, direction) {
  await requireManager(groupId, actorId);
  const target = await membership(groupId, targetUserId);
  if (!target) throw new AppError(404, "That person is not in the group");
  if (target.role === "chair") throw new AppError(409, "The chair's role cannot be changed here");
  const role = direction === "promote" ? "organiser" : "member";
  await pool.query("UPDATE stockvel_members SET role = $3 WHERE group_id = $1 AND user_id = $2", [groupId, targetUserId, role]);
  return { role };
}

async function removeMember(actorId, groupId, targetUserId) {
  await requireManager(groupId, actorId);
  const target = await membership(groupId, targetUserId);
  if (!target) throw new AppError(404, "That person is not in the group");
  if (target.role === "chair") throw new AppError(409, "The chair cannot be removed. Transfer the group first");
  await pool.query("UPDATE stockvel_members SET status = 'removed' WHERE group_id = $1 AND user_id = $2", [groupId, targetUserId]);
  return { removed: true };
}

async function leaveGroup(userId, groupId) {
  const member = await requireMember(groupId, userId);
  if (member.role === "chair") throw new AppError(409, "The chair cannot leave. Close the group or hand it to another organiser first");
  await pool.query("UPDATE stockvel_members SET status = 'left' WHERE group_id = $1 AND user_id = $2", [groupId, userId]);
  return { left: true };
}

async function deleteGroup(userId, groupId) {
  const member = await requireMember(groupId, userId);
  if (member.role !== "chair") throw new AppError(403, "Only the chair can delete the group");
  const totals = await groupBalance(groupId);
  if (totals.balance > 0) {
    throw new AppError(409, `The group still holds ${totals.balance.toFixed(2)} of members' money. Record the payout withdrawals first, then delete.`);
  }
  await pool.query("UPDATE stockvel_groups SET status = 'closed', updated_at = NOW() WHERE id = $1", [groupId]);
  return { closed: true };
}

async function requestWithdrawal(userId, groupId, payload = {}) {
  await requireMember(groupId, userId);
  const amount = money(payload.amount);
  if (!(amount > 0)) throw new AppError(400, "Enter the withdrawal amount");
  const totals = await groupBalance(groupId);
  if (amount > totals.balance) throw new AppError(409, `The group holds R${totals.balance.toFixed(2)}, and a withdrawal cannot exceed it`);
  const reason = payload.reason ? boundedText(payload.reason, "Reason", { min: 1, max: 300 }) : "";
  const id = uuidv4();
  await pool.query(
    "INSERT INTO stockvel_withdrawals (id, group_id, requested_by, amount, reason) VALUES ($1,$2,$3,$4,$5)",
    [id, groupId, userId, amount, reason]
  );
  return { id, status: "requested" };
}

async function decideWithdrawal(actorId, groupId, withdrawalId, approve) {
  await requireManager(groupId, actorId);
  const { rows } = await pool.query(
    "SELECT * FROM stockvel_withdrawals WHERE id = $1 AND group_id = $2 LIMIT 1", [withdrawalId, groupId]);
  const withdrawal = rows[0];
  if (!withdrawal) throw new AppError(404, "Withdrawal request not found");
  if (withdrawal.status !== "requested") throw new AppError(409, `That request is already ${withdrawal.status}`);
  if (withdrawal.requested_by === actorId && approve) {
    throw new AppError(409, "You cannot approve your own withdrawal. Another organiser must");
  }
  if (approve) {
    const totals = await groupBalance(groupId);
    if (money(withdrawal.amount) > totals.balance) throw new AppError(409, "The group no longer holds enough to approve this");
  }
  await pool.query(
    "UPDATE stockvel_withdrawals SET status = $3, decided_by = $4, decided_at = NOW() WHERE id = $1 AND group_id = $2",
    [withdrawalId, groupId, approve ? "approved" : "declined", actorId]
  );
  return { status: approve ? "approved" : "declined" };
}

/* ---- Group chat and meeting minutes ---------------------------------- */

async function listMessages(userId, groupId, { limit = 100 } = {}) {
  await requireMember(groupId, userId);
  const { rows } = await pool.query(
    `SELECT sm.id, sm.user_id, sm.message, sm.is_decision, sm.created_at, u.full_name AS name, u.username
     FROM stockvel_messages sm JOIN users u ON u.id = sm.user_id
     WHERE sm.group_id = $1
     ORDER BY sm.created_at DESC
     LIMIT $2`,
    [groupId, Math.min(Math.max(Number(limit) || 100, 1), 200)]
  );
  return rows.reverse().map((row) => ({
    id: row.id, userId: row.user_id, name: row.name, username: row.username,
    message: row.message, isDecision: row.is_decision, createdAt: row.created_at
  }));
}

async function postMessage(userId, groupId, payload = {}) {
  await requireMember(groupId, userId);
  const message = boundedText(payload.message, "Message", { min: 1, max: 1000 });
  const id = uuidv4();
  await pool.query(
    "INSERT INTO stockvel_messages (id, group_id, user_id, message) VALUES ($1,$2,$3,$4)",
    [id, groupId, userId, message]
  );
  return { id };
}

// Organisers pin what the group agreed: a marked message becomes a decision,
// and decisions are the backbone of the minutes.
async function markDecision(actorId, groupId, messageId, isDecision) {
  await requireManager(groupId, actorId);
  const { rows } = await pool.query(
    "UPDATE stockvel_messages SET is_decision = $3 WHERE id = $1 AND group_id = $2 RETURNING id",
    [messageId, groupId, isDecision !== false]
  );
  if (!rows[0]) throw new AppError(404, "Message not found");
  return { ok: true };
}

async function openMeeting(actorId, groupId, payload = {}) {
  await requireManager(groupId, actorId);
  const { rows: openRows } = await pool.query(
    "SELECT id FROM stockvel_meetings WHERE group_id = $1 AND status = 'open' LIMIT 1", [groupId]);
  if (openRows[0]) throw new AppError(409, "A meeting is already open. Close it first");
  const title = payload.title ? boundedText(payload.title, "Meeting title", { min: 2, max: 120 }) : `Meeting ${new Date().toISOString().slice(0, 10)}`;
  const id = uuidv4();
  await pool.query(
    "INSERT INTO stockvel_meetings (id, group_id, opened_by, title) VALUES ($1,$2,$3,$4)",
    [id, groupId, actorId, title]
  );
  return { id, title, status: "open" };
}

// Closing the meeting compiles the minutes right then: attendance from who
// spoke, the decisions the organisers pinned, contributions recorded during
// the meeting, and the discussion count — then the minutes go to every
// member by email. Deterministic on purpose: minutes must say what happened,
// not what a model guesses happened.
async function closeMeeting(actorId, groupId, meetingId) {
  await requireManager(groupId, actorId);
  const { rows } = await pool.query(
    "SELECT * FROM stockvel_meetings WHERE id = $1 AND group_id = $2 LIMIT 1", [meetingId, groupId]);
  const meeting = rows[0];
  if (!meeting) throw new AppError(404, "Meeting not found");
  if (meeting.status !== "open") throw new AppError(409, "That meeting is already closed");

  const { rows: groupRows } = await pool.query("SELECT * FROM stockvel_groups WHERE id = $1", [groupId]);
  const group = groupRows[0];
  const { rows: messageRows } = await pool.query(
    `SELECT sm.message, sm.is_decision, sm.created_at, u.full_name AS name
     FROM stockvel_messages sm JOIN users u ON u.id = sm.user_id
     WHERE sm.group_id = $1 AND sm.created_at >= $2
     ORDER BY sm.created_at ASC`,
    [groupId, meeting.opened_at]
  );
  const { rows: memberRows } = await pool.query(
    `SELECT u.full_name AS name, u.email FROM stockvel_members sm JOIN users u ON u.id = sm.user_id
     WHERE sm.group_id = $1 AND sm.status = 'active'`,
    [groupId]
  );
  const speakers = [...new Set(messageRows.map((row) => row.name))];
  const decisions = messageRows.filter((row) => row.is_decision);
  const { rows: contributionRowsInWindow } = await pool.query(
    `SELECT u.full_name AS name, t.amount FROM transactions t JOIN users u ON u.id = t.user_id
     WHERE t.service_code IN ('stockvel','stockvel_contribution') AND t.status = 'completed'
       AND (t.metadata->>'stockvelGroupId') = $1 AND t.created_at >= $2`,
    [String(groupId), meeting.opened_at]
  );
  const totals = await groupBalance(groupId);
  const closedAt = new Date();
  const line = (label, value) => `${label}: ${value}`;
  const minutes = [
    `MINUTES: ${meeting.title}`,
    line("Group", group.name),
    line("Opened", new Date(meeting.opened_at).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" })),
    line("Closed", closedAt.toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" })),
    line("Members", `${memberRows.length}`),
    line("Took part in the discussion", speakers.length ? speakers.join(", ") : "No messages during this meeting"),
    "",
    "DECISIONS AGREED",
    ...(decisions.length
      ? decisions.map((row, index) => `${index + 1}. ${row.message} (noted by ${row.name})`)
      : ["No decisions were pinned this meeting."]),
    "",
    "CONTRIBUTIONS DURING THE MEETING",
    ...(contributionRowsInWindow.length
      ? contributionRowsInWindow.map((row) => `${row.name}: R${money(row.amount).toFixed(2)}`)
      : ["None recorded during the meeting window."]),
    "",
    line("Messages exchanged", `${messageRows.length}`),
    line("Group balance at close", `R${totals.balance.toFixed(2)} (contributed R${totals.contributed.toFixed(2)}, withdrawn R${totals.withdrawn.toFixed(2)})`),
    "",
    "Compiled automatically by TitoPay when the meeting was closed."
  ].join("\n");

  await pool.query(
    "UPDATE stockvel_meetings SET status = 'closed', closed_by = $3, closed_at = NOW(), minutes = $4 WHERE id = $1 AND group_id = $2",
    [meetingId, groupId, actorId, minutes]
  );

  // Minutes go to every member by email — best-effort, never blocking.
  try {
    const emailCentre = require("./email-centre-service");
    for (const member of memberRows) {
      if (!member.email) continue;
      await emailCentre.queueRawEmail({
        recipient: member.email,
        subject: `Minutes: ${meeting.title} · ${group.name}`,
        textBody: `Hi ${member.name || "there"},\n\nThe meeting has been closed and the minutes are below. They are also saved in the group on TitoPay.\n\n${minutes.replace(/[{}]/g, "")}`,
        htmlBody: `<p>Hi ${emailCentre.escapeHtml(member.name || "there")},</p><p>The meeting has been closed and the minutes are below. They are also saved in the group on TitoPay.</p><pre style="white-space:pre-wrap;font-family:inherit">${emailCentre.escapeHtml(minutes)}</pre>`,
        idempotencyKey: `stockvel-minutes:${meetingId}:${member.email}`,
        metadata: { groupId, meetingId }
      });
    }
  } catch (error) {
    console.error("[stockvel] minutes email failed", { meetingId, message: error.message });
  }

  return { id: meetingId, status: "closed", minutes };
}

// A CONTRIBUTION IS A TRANSFER TO THE TREASURER, ON THE NORMAL RAILS.
//
// A stokvel's money has to live in a real wallet someone answers for. Here
// that is the chair (the group's creator) — the treasurer, exactly as in a
// traditional stokvel. A contribution is therefore an ordinary
// wallet-to-wallet transfer from the member to the chair, executed by
// createTransaction with everything that implies: balance check, wallet
// locks, ledger entries, idempotency, receipt. The stokvelGroupId in the
// metadata is what makes the transfer count on the group's register, which
// is derived from these transactions and never kept as a separate tally.
async function contributionTreasurer(groupId) {
  const { rows } = await pool.query(
    `SELECT g.id, g.name, g.status, u.id AS treasurer_id, u.username, u.email, u.full_name
     FROM stockvel_groups g
     JOIN users u ON u.id = g.owner_user_id
     WHERE g.id = $1`,
    [groupId]
  );
  const group = rows[0];
  if (!group) throw new AppError(404, "Savings group not found");
  if (group.status === "draft") throw new AppError(409, "This group is still a draft. The organiser must activate it before contributions start.");
  if (group.status === "closed") throw new AppError(409, "This group has been closed. No further contributions are taken.");
  return group;
}

async function previewContribution(userId, groupId, amount) {
  await requireMember(groupId, userId);
  const group = await contributionTreasurer(groupId);
  const value = money(amount);
  if (!Number.isFinite(value) || value <= 0) throw new AppError(400, "Enter a contribution amount greater than zero.");
  const { calculateFee } = require("./pricing-service");
  const fee = await calculateFee("stockvel_contribution", value);
  return {
    amount: fee.amount,
    fee: fee.fee,
    total: fee.total,
    groupName: group.name,
    treasurer: group.full_name || `@${group.username}`
  };
}

async function contribute(actor, groupId, payload = {}) {
  await requireMember(groupId, actor.userId);
  const group = await contributionTreasurer(groupId);
  const value = money(payload.amount);
  if (!Number.isFinite(value) || value <= 0) throw new AppError(400, "Enter a contribution amount greater than zero.");
  const { createTransaction } = require("./transaction-service");
  const transfer = await createTransaction(actor, {
    serviceCode: "stockvel_contribution",
    amount: value,
    recipient: group.username || group.email,
    idempotencyKey: String(payload.idempotencyKey || "").trim().slice(0, 120) || undefined,
    metadata: {
      stockvelGroupId: String(groupId),
      stockvelGroupName: group.name,
      cycle: String(payload.cycle || payload.reference || "").trim().slice(0, 80) || null
    }
  });
  return { ...transfer, groupId, groupName: group.name };
}

// INVITING MEMBERS ACTUALLY REACHES THEM.
//
// Joining stays code-based — nobody can be pulled into a money group without
// entering the code themselves — but the wizard's member list now does what
// it promises: each registered person named there gets the invitation, with
// the code, in their app and their email. Anyone not on TitoPay yet is
// reported back so the organiser knows to share the code another way.
async function inviteMembers(userId, groupId, identifiers = []) {
  await requireManager(groupId, userId);
  const { rows: groupRows } = await pool.query(
    "SELECT g.*, u.full_name AS owner_name FROM stockvel_groups g JOIN users u ON u.id = g.owner_user_id WHERE g.id = $1",
    [groupId]
  );
  const group = groupRows[0];
  if (!group) throw new AppError(404, "Savings group not found");
  const { rows: inviterRows } = await pool.query("SELECT full_name, username FROM users WHERE id = $1", [userId]);
  const inviterName = inviterRows[0]?.full_name || `@${inviterRows[0]?.username || "a TitoPay user"}`;
  const { verifyRecipient } = require("./security-service");
  const { createNotification } = require("./notification-service");
  const list = [...new Set(identifiers.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 50);
  const invited = [];
  const notRegistered = [];
  for (const identifier of list) {
    const status = await verifyRecipient({ userType: "customer", userId }, { recipient: identifier }).catch(() => null);
    const person = status?.registered ? status.recipient : null;
    if (!person?.userId || person.userId === userId) {
      if (!person?.userId) notRegistered.push(identifier);
      continue;
    }
    await createNotification({
      user: { id: person.userId, user_type: "customer" },
      channel: "in_app", notificationType: "stockvel_invite", provider: "in_app",
      title: `${inviterName} invited you to the "${group.name}" stokvel`,
      body: `Join with invite code ${group.invite_code}: open Stokvel in the app, choose Join with a code, and enter it. The group contributes ${Number(group.contribution_amount) > 0 ? `R${Number(group.contribution_amount).toFixed(2)} ${group.cadence}` : "on the schedule the group agreed"}. Nothing joins you to the group until you enter the code yourself.`,
      metadata: { stockvelGroupId: String(groupId), inviteCode: group.invite_code, clientNotificationId: `stockvel-invite-${groupId}-${person.userId}` }
    }).catch(() => {});
    if (person.email) {
      try {
        const emailCentre = require("./email-centre-service");
        const esc = emailCentre.escapeHtml;
        await emailCentre.queueRawEmail({
          recipient: person.email,
          subject: `${inviterName} invited you to the "${group.name}" stokvel on TitoPay`,
          textBody: [
            `Hi ${person.fullName || "there"},`,
            "",
            `${inviterName} has invited you to join "${group.name}", a savings group on TitoPay.`,
            "",
            `Your invite code: ${group.invite_code}`,
            "",
            "To join:",
            "1. Open the TitoPay app ({{appUrl}}) and sign in.",
            "2. Open Services and choose Stokvel.",
            "3. Choose Join with a code and enter the code above.",
            "",
            "Nothing happens to your account until you enter the code yourself, and you can see the group's full contribution record from the day you join.",
            "",
            "If you were not expecting this, you can simply ignore this email.",
            "",
            "TitoPay"
          ].join("\n"),
          htmlBody: [
            `<p>Hi ${esc(person.fullName || "there")},</p>`,
            `<p><strong>${esc(inviterName)}</strong> has invited you to join <strong>${esc(group.name)}</strong>, a savings group on TitoPay.</p>`,
            `<p>Your invite code: <strong>${esc(group.invite_code)}</strong></p>`,
            "<p><strong>To join:</strong></p>",
            "<ol>",
            '<li>Open the <a href="{{appUrl}}">TitoPay app</a> and sign in.</li>',
            "<li>Open <strong>Services</strong> and choose <strong>Stokvel</strong>.</li>",
            "<li>Choose <strong>Join with a code</strong> and enter the code above.</li>",
            "</ol>",
            "<p>Nothing happens to your account until you enter the code yourself, and you can see the group's full contribution record from the day you join.</p>",
            "<p>If you were not expecting this, you can simply ignore this email.</p>",
            "<p>TitoPay</p>"
          ].join("\n"),
          userId: person.userId,
          idempotencyKey: `stockvel-invite-${groupId}-${person.userId}`,
          metadata: { groupId }
        });
      } catch (error) {
        console.error("[stockvel] invite email failed", { groupId, message: error.message });
      }
    }
    invited.push(person.username ? `@${person.username}` : identifier);
  }
  return { inviteCode: group.invite_code, invited, notRegistered };
}

module.exports = {
  ensureStockvelSchema,
  createGroup,
  previewContribution,
  contribute,
  inviteMembers,
  updateGroup,
  listGroups,
  getGroup,
  joinByCode,
  changeMemberRole,
  removeMember,
  leaveGroup,
  deleteGroup,
  requestWithdrawal,
  decideWithdrawal,
  listMessages,
  postMessage,
  markDecision,
  openMeeting,
  closeMeeting
};
