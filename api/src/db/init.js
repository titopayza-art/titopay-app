const fs = require("fs");
const path = require("path");
const { pool } = require("./pool");
const { syncApprovedPricingSchedule } = require("../services/pricing-service");

async function main() {
  const schemaPath = path.join(__dirname, "schema.sql");
  const schemaFiles = [
    schemaPath,
    path.join(__dirname, "email-centre-schema.sql"),
    path.join(__dirname, "hr-schema.sql")
  ];
  for (const filePath of schemaFiles) {
    if (!fs.existsSync(filePath)) continue;
    const sql = fs.readFileSync(filePath, "utf8");
    if (sql.trim()) await pool.query(sql);
  }
  await syncApprovedPricingSchedule();
  console.log("TitoPay API schema initialized");
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
