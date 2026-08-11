const { pool } = require("../src/db/pool");
const { syncApprovedPricingSchedule } = require("../src/services/pricing-service");

async function main() {
  const rows = await syncApprovedPricingSchedule();
  console.log(`Seeded ${rows.length} TitoPay approved pricing rules`);
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
