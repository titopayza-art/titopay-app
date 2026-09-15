# TitoPay HR targeted repair deployment

This repair is additive. It does not alter HR login, password, session, or existing
user records. It does not delete or rewrite production data.

## Required backup

Before running the schema initializer in production, create a database backup:

```sh
pg_dump "$POSTGRES_URL" --format=custom --file=titopay-before-hr-repair.dump
```

Keep the backup outside the public web root and verify it with:

```sh
pg_restore --list titopay-before-hr-repair.dump
```

## Apply

Deploy the API files, then run:

```sh
npm run db:migrate
npm test
pm2 restart titopay-api
```

The migration only creates `hr_projects`, `hr_meetings`, and supporting indexes
when absent. Existing ticket, announcement, employee, payroll, attendance,
recruitment, audit, authentication, and session records remain unchanged.

## Rollback

For an application-only rollback, restore the previous API and HR frontend
packages and restart the API. The two new tables can safely remain unused.

Only after confirming that no production records were created in the new tables,
an operator may remove them manually. Do not automate table deletion:

```sql
SELECT COUNT(*) FROM hr_projects;
SELECT COUNT(*) FROM hr_meetings;
```

If either count is non-zero, preserve the tables or restore through the approved
database recovery process.
