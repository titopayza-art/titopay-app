const { pool } = require("../src/db/pool");
const { hashPassword } = require("../src/lib/passwords");

async function upsertHrUser({ name, email, role, password }) {
  const passwordHash = await hashPassword(password);
  await pool.query(
    `INSERT INTO hr_users (name, email, role, password_hash, status)
     VALUES ($1, $2, $3, $4, 'active')
     ON CONFLICT (email)
     DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, password_hash = EXCLUDED.password_hash, status = 'active', updated_at = NOW()`,
    [name, email, role, passwordHash]
  );
}

async function main() {
  await upsertHrUser({
    name: process.env.HR_CEO_NAME || "Thuso Tshiloane",
    email: process.env.HR_CEO_EMAIL || "ceo@titopay.co.za",
    role: process.env.HR_CEO_ROLE || "CEO",
    password: process.env.HR_CEO_PASSWORD || "TitoPayCEO!2026"
  });

  await upsertHrUser({
    name: process.env.HR_HEAD_NAME || "HR Head Officer",
    email: process.env.HR_HEAD_EMAIL || "hr@titopay.co.za",
    role: process.env.HR_HEAD_ROLE || "HR Administrator",
    password: process.env.HR_HEAD_PASSWORD || "TitoPayHRHead!2026"
  });

  await pool.query(
    `INSERT INTO hr_departments (name, status)
     VALUES ('Engineering','active'), ('Product','active'), ('Operations','active'), ('Finance','active'), ('Compliance','active'), ('People','active')
     ON CONFLICT (name) DO NOTHING`
  );

  await pool.query(
    `INSERT INTO hr_audit_logs (user_email, action, entity, detail)
     VALUES ('system', 'Seeded HR access', 'authentication', 'CEO and HR Head accounts are ready')
     ON CONFLICT DO NOTHING`
  );

  console.log("TitoPay HR seed complete:");
  console.log(`- ${process.env.HR_CEO_EMAIL || "ceo@titopay.co.za"} (${process.env.HR_CEO_ROLE || "CEO"})`);
  console.log(`- ${process.env.HR_HEAD_EMAIL || "hr@titopay.co.za"} (${process.env.HR_HEAD_ROLE || "HR Administrator"})`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
