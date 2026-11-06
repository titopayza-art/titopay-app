// Runs every background job once and exits. On shared hosting the web process
// can be put to sleep when idle, so schedule this with a cPanel Cron Job every
// 5 minutes (see AFRIHOST-SETUP). Safe to run while the app is running.
const db = require("../src/lib/db");
const { jobs } = require("../src/workers");

(async () => {
  let failed = 0;
  for (const job of jobs) {
    try { await job.run(); } catch (err) { failed++; console.error(`[jobs] ${job.name}: ${err.message}`); }
  }
  await db.close();
  process.exit(failed ? 1 : 0);
})();
