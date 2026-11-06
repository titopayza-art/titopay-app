// TicketRoom entry point. Also the "Application startup file" for cPanel's
// Setup Node.js App (Phusion Passenger), which provides the port itself.
const config = require("./src/config");
const { createApp } = require("./src/app");
const workers = require("./src/workers");
const startup = require("./src/startup");

async function main() {
  await startup.run();
  const app = createApp();
  const port = process.env.PORT || config.port;
  const server = app.listen(port, () => {
    console.log(`TicketRoom listening on ${port} (${config.env}) — payments: ${config.payments.provider}${config.payments.provider === "simulated" ? " [SIMULATED, no real money]" : ""}`);
  });
  const stopWorkers = process.env.WORKERS === "false" ? () => {} : workers.start();
  const shutdown = () => { stopWorkers(); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10_000).unref(); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => { console.error(`TicketRoom failed to start: ${err.message}`); process.exit(1); });
