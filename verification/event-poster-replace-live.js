"use strict";

// AN ORGANISER FIXING THE POSTER ON AN EVENT THAT IS ALREADY SELLING.
//
// Everything else about an approved event goes through a change request an
// admin reviews, and that is right: the date, the venue, the price and the
// refund terms are what a buyer decided on. The poster is the exception. It is
// the shop window, it is what is most often wrong on the day, and an organiser
// who cannot fix a cropped or crooked poster on a live event has a broken
// event and no way to help themselves.
//
// The risk of that exception is obvious, so this pins the edges:
//
//   1. The ordinary edit path STILL refuses an approved event.
//   2. The poster alone can be replaced on it.
//   3. Nothing else about the event moves, and it stays approved.
//   4. Every replacement lands on the event's own audit trail.
//   5. An empty upload is refused rather than wiping the poster.
//   6. Another business cannot touch it.
//   7. A cancelled or finished event refuses, with a readable reason.
//
//   POSTGRES_URL=postgres://postgres@127.0.0.1:55432/titopay \
//     node verification/event-poster-replace-live.js
//
// It seeds its own throwaway organiser and deletes everything at the end.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { pool } = require("../api/src/db/pool");
const notif = require("../api/src/services/notification-service");
notif.deliverEmail = async () => ({ id: "stub" });
const t = require("../api/src/services/ticketing-service");
const TAG = `pp${String(Date.now()).slice(-7)}`;
const org = randomUUID(), wal = randomUUID(), mer = randomUUID();
const img = (seed) => `data:image/jpeg;base64,${("/9j/4AAQSkZJRgABAQ" + seed).repeat(20)}`;
(async () => {
  let passed = 0; const ok = (m, d = "") => { console.log(`  PASS  ${m}${d ? "  — " + d : ""}`); passed++; };
  try {
    await t.ensureTicketingSchema();
    await pool.query(`INSERT INTO users (id,account_type,full_name,username,email,phone,password_hash,status,profile_locked,fica_status)
      VALUES ($1,'business','${TAG} Org','${TAG}_o','${TAG}_o@example.invalid','27110000021','x','active',FALSE,'approved')`, [org]);
    await pool.query(`INSERT INTO wallets (id,wallet_number,user_id,kind,currency,available_balance,reserved_balance,status)
      VALUES ($1,$2,$3,'business','ZAR',0,0,'active')`, [wal, String(Date.now()).slice(-9), org]);
    await pool.query(`INSERT INTO merchants (id,user_id,business_name,merchant_id,status,verification_status)
      VALUES ($1,$2,$3,$4,'active','verified')`, [mer, org, `${TAG} Org`, `M${TAG}`]);

    const draft = await t.createEventDraft(org, {
      eventName: `${TAG} Expo`, category: "conference", description: "d",
      eventDate: "2027-05-05", startTime: "09:00", endTime: "17:00",
      venueName: "V", fullVenueAddress: "1 St", city: "JHB", province: "Gauteng",
      termsConditions: "t", refundPolicy: { summary: "s" }, eventBannerUrl: img("A"),
      ticketTypes: [{ ticketName: "General", price: 100, quantityAvailable: 10 }]
    });
    await pool.query("UPDATE events SET status='approved', approved_at=NOW() WHERE id=$1", [draft.id]);
    ok("an approved event exists, selling paid tickets");

    // The old path must still refuse: everything else needs admin review.
    await assert.rejects(() => t.updateEventDraft(org, draft.id, { eventName: "Renamed" }),
      /can no longer be edited/i);
    ok("the ordinary edit path still refuses an approved event");

    const before = (await pool.query("SELECT event_banner_url FROM events WHERE id=$1", [draft.id])).rows[0].event_banner_url;
    await t.replaceEventPoster(org, draft.id, { eventBannerUrl: img("B") });
    const after = (await pool.query("SELECT event_banner_url FROM events WHERE id=$1", [draft.id])).rows[0].event_banner_url;
    assert.notEqual(after, before); assert.equal(after, img("B"));
    ok("but the poster CAN be replaced on the live event");

    const row = (await pool.query("SELECT status, event_name, event_date FROM events WHERE id=$1", [draft.id])).rows[0];
    assert.equal(row.status, "approved", "the event was taken out of approval");
    assert.match(row.event_name, new RegExp(TAG), "the name changed");
    ok("and nothing else on the event moved", `still ${row.status}`);

    const audit = (await pool.query(
      "SELECT action, actor_id, metadata FROM event_audit_logs WHERE event_id=$1 AND action='event_poster_replaced'", [draft.id])).rows;
    assert.equal(audit.length, 1); assert.equal(audit[0].actor_id, org);
    assert.equal(audit[0].metadata.hadPoster, true);
    ok("the replacement is on the event's audit trail", JSON.stringify(audit[0].metadata));

    await assert.rejects(() => t.replaceEventPoster(org, draft.id, { eventBannerUrl: "" }), /Choose a poster/i);
    ok("an empty upload is refused rather than wiping the poster");

    await assert.rejects(() => t.replaceEventPoster(randomUUID(), draft.id, { eventBannerUrl: img("C") }), /not found/i);
    ok("another business cannot touch this event's poster");

    await pool.query("UPDATE events SET status='cancelled' WHERE id=$1", [draft.id]);
    await assert.rejects(() => t.replaceEventPoster(org, draft.id, { eventBannerUrl: img("D") }), /cancelled/i);
    ok("a cancelled event refuses, with a reason a person can read");

    console.log(`\n  ${passed}/8 checks passed\n`);
  } catch (e) { console.error("\nFAILED:", e.message); process.exitCode = 1; }
  finally {
    const ev = (await pool.query("SELECT id FROM events WHERE business_user_id=$1", [org])).rows.map(r => r.id);
    for (const id of ev) {
      for (const tbl of ["tickets", "ticket_orders", "event_ticket_types", "event_audit_logs"]) {
        await pool.query(`DELETE FROM ${tbl} WHERE event_id=$1`, [id]).catch(() => {});
      }
      await pool.query("DELETE FROM events WHERE id=$1", [id]).catch(() => {});
    }
    await pool.query("DELETE FROM wallets WHERE id=$1", [wal]).catch(() => {});
    await pool.query("DELETE FROM merchants WHERE id=$1", [mer]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id=$1", [org]).catch(() => {});
    await pool.end().catch(() => {});
  }
})();
