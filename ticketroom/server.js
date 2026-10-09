const config = require("./src/config");
const { createApp } = require("./src/app");
const migrate = require("./src/db/migrate");
const workers = require("./src/workers");

async function main() {
  if (process.env.MIGRATE_ON_START === "true") await migrate.up();
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`TicketRoom listening on :${config.port} (${config.env}) — payments: ${config.payments.provider}${config.payments.provider === "simulated" ? " [SIMULATED, no real money]" : ""}`);
  });
  const stopWorkers = process.env.WORKERS === "false" ? () => {} : workers.start();
  const shutdown = () => { stopWorkers(); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10_000).unref(); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
