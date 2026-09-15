"use strict";

// Remind staff about mandatory training they have not finished.
//
// This is the one HR message with no event behind it — nothing happens when a
// course becomes overdue, so something has to come looking. Run it from cron,
// once a day:
//
//     npm run hr:training-reminders
//
// It sends at most one reminder per course per person per day, so running it
// twice in a day is a no-op rather than a second nag. It sends nothing at all
// unless staff email is switched on in both places, same as every other HR
// message — running it on a box that was never configured for email is safe.

require("../src/config/env");
const { pool } = require("../src/db/pool");
const hrEmail = require("../src/services/hr-email-service");

(async () => {
  const settings = await hrEmail.getHrEmailConfig();
  if (!settings.enabled) {
    console.log(`\n  Staff email is off — nothing sent.`);
    console.log(`  environment allows: ${settings.environmentAllows}, operator switch: ${settings.operatorEnabled}\n`);
    await pool.end();
    return;
  }
  const result = await hrEmail.mandatoryTrainingReminders();
  console.log(`\n  ${result.sent} reminder(s) queued from ${result.considered} overdue enrolment(s).`);
  console.log(`  Delivery is the email worker's job; check /health if nothing arrives.\n`);
  await pool.end();
})().catch(async (error) => {
  console.error("\n  Could not send training reminders:", error.message, "\n");
  await pool.end().catch(() => {});
  process.exit(1);
});
