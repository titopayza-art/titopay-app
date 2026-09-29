"use strict";

/* CLEARED MEANS CLEARED, ON EVERY DEVICE.
 *
 * The user's screenshot: login notifications from 3 and 6 days ago, back in
 * the inbox after clearing. The app's local cleared marker (v373+) protects
 * one browser; the server feed kept returning read notifications, so a new
 * phone, a reinstall or a cleared browser got the whole history back.
 *
 * This boots the real API and replays the scenario end to end:
 *   1. Old login notifications are served to the app.
 *   2. The app clears (POST /notifications/read with empty ids, exactly what
 *      the Clear inbox button sends).
 *   3. The same account on a FRESH DEVICE (no local storage, brand-new
 *      session) fetches the feed: nothing from before the clear comes back.
 *   4. A login notification created AFTER the clear IS served: clearing the
 *      past must never silence the future.
 *   5. Marking a single id read does NOT stamp the clear marker, so ordinary
 *      read-tracking cannot accidentally wipe an inbox.
 *
 * Run: node verification/notification-clears-live.js
 */

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

const API = path.join(__dirname, "..", "api");
const { pool } = require(path.join(API, "src", "db", "pool.js"));
const { signAccessToken } = require(path.join(API, "src", "lib", "jwt.js"));

const TAG = crypto.randomUUID().slice(0, 8);
let passed = 0;
const ok = (m) => { passed += 1; console.log("  PASS  " + m); };

async function seedSession(userId) {
  const sessionId = crypto.randomUUID();
  const jti = crypto.randomUUID();
  await pool.query(
    `INSERT INTO sessions (id, user_type, user_id, scope, refresh_token_hash, access_jti, expires_at)
     VALUES ($1,'customer',$2,'customer','x',$3, NOW() + INTERVAL '1 hour')`,
    [sessionId, userId, jti]);
  return { sessionId, token: signAccessToken({ sub: userId, sid: sessionId, jti, typ: "customer" }) };
}

async function seedLoginNotice(userId, daysAgo, label) {
  await pool.query(
    `INSERT INTO notifications (id, user_id, channel, notification_type, title, body, status, provider, metadata, created_at, sent_at)
     VALUES ($1,$2,'in_app','login_notification','New TitoPay login',$3,'sent','titopay','{}'::JSONB,
             NOW() - ($4 || ' days')::INTERVAL, NOW() - ($4 || ' days')::INTERVAL)`,
    [crypto.randomUUID(), userId, label, String(daysAgo)]);
}

(async () => {
  const { app } = require(path.join(API, "src", "app.js"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const userId = crypto.randomUUID();
  const sessions = [];

  const feed = async (token) => {
    const r = await fetch(`${base}/v1/chat/notifications`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 200, `feed answered ${r.status}`);
    return (await r.json()).notifications || [];
  };

  try {
    await pool.query(
      `INSERT INTO users (id, account_type, full_name, username, email, password_hash, status, fica_status)
       VALUES ($1,'personal','Clear Harness',$2,$3,'x','active','verified')`,
      [userId, `clr_${TAG}`, `clr-${TAG}@example.test`]);

    await seedLoginNotice(userId, 6, `old login six days ago ${TAG}`);
    await seedLoginNotice(userId, 3, `old login three days ago ${TAG}`);

    const phone = await seedSession(userId);
    sessions.push(phone.sessionId);

    const before = await feed(phone.token);
    assert.equal(before.filter((n) => String(n.body).includes(TAG)).length, 2,
      "both old login notices are served before the clear");
    ok("the old login notifications are in the feed, exactly like the screenshot");

    // The Clear inbox button.
    const cleared = await fetch(`${base}/v1/chat/notifications/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${phone.token}` },
      body: JSON.stringify({ ids: [] })
    });
    assert.equal(cleared.status, 200, await cleared.text());
    assert.equal((await feed(phone.token)).filter((n) => String(n.body).includes(TAG)).length, 0,
      "the same device sees nothing after clearing");
    ok("clearing empties the feed on the device that cleared");

    // A brand-new device: new session, no local storage, nothing client-side.
    const newPhone = await seedSession(userId);
    sessions.push(newPhone.sessionId);
    assert.equal((await feed(newPhone.token)).filter((n) => String(n.body).includes(TAG)).length, 0,
      "a fresh device must not be handed the cleared history");
    ok("a brand-new device gets NOTHING from before the clear: cleared is server-side now");

    // The future is untouched.
    await seedLoginNotice(userId, 0, `new login after the clear ${TAG}`);
    const after = (await feed(newPhone.token)).filter((n) => String(n.body).includes(TAG));
    assert.equal(after.length, 1, "exactly the new notice is served");
    assert.match(after[0].body, /after the clear/);
    ok("a login AFTER the clear still arrives: clearing the past never silences the future");

    // Ordinary single-id read must not stamp the clear marker.
    await seedLoginNotice(userId, 0, `single read test ${TAG}`);
    const list = (await feed(newPhone.token)).filter((n) => String(n.body).includes(TAG));
    const target = list.find((n) => String(n.body).includes("single read test"));
    await fetch(`${base}/v1/chat/notifications/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${newPhone.token}` },
      body: JSON.stringify({ ids: [target.id] })
    });
    const still = (await feed(newPhone.token)).filter((n) => String(n.body).includes(TAG));
    assert.equal(still.length, 2, "reading one notice must not clear the inbox");
    ok("marking a single notice read does not act as a clear");

    console.log(`\n${passed}/5 checks passed. Cleared means cleared, everywhere.`);
    process.exit(0);
  } catch (error) {
    console.error("\nFAILED:", error.message);
    process.exit(1);
  } finally {
    server.close();
    await pool.query("DELETE FROM notification_clears WHERE user_id = $1", [userId]).catch(() => {});
    await pool.query("DELETE FROM notifications WHERE user_id = $1", [userId]).catch(() => {});
    for (const id of sessions) await pool.query("DELETE FROM sessions WHERE id = $1", [id]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id = $1", [userId]).catch(() => {});
  }
})();
