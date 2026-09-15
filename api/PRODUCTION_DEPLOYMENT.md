# TitoPay API Production Deployment

Target:

- Domain: `api.titopay.co.za`
- OS: Ubuntu 24.04 LTS
- Runtime: Node.js 20+
- Database: PostgreSQL
- Process manager: PM2
- Reverse proxy: Nginx

## 1. Server Packages

```bash
sudo apt update
sudo apt install -y nginx postgresql postgresql-contrib unzip git curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

## 2. Database

Create the production database and user:

```bash
sudo -u postgres psql
```

```sql
CREATE USER titopay_api WITH PASSWORD 'REPLACE_WITH_STRONG_DATABASE_PASSWORD';
CREATE DATABASE titopay OWNER titopay_api;
\c titopay
CREATE EXTENSION IF NOT EXISTS pgcrypto;
GRANT CONNECT ON DATABASE titopay TO titopay_api;
GRANT USAGE ON SCHEMA public TO titopay_api;
GRANT CREATE ON SCHEMA public TO titopay_api;
```

## 3. Deploy Files

Upload and extract the API package to:

```text
/var/www/titopay/api
```

Expected structure:

```text
/var/www/titopay/api/
├── package.json
├── package-lock.json
├── .env.example
├── README.md
├── API_DOCUMENTATION.md
├── PRODUCTION_DEPLOYMENT.md
├── deploy/
│   ├── ecosystem.config.cjs
│   ├── nginx-api.titopay.co.za.conf
│   └── create-production-database.sql
├── scripts/
│   ├── create-admin-user.js
│   ├── seed-pricing-rules.js
│   └── verify-infrastructure.js
└── src/
```

## 4. Environment

```bash
cd /var/www/titopay/api
cp .env.example .env
nano .env
```

Set real values for:

- `POSTGRES_URL`
- `JWT_ACCESS_SECRET`
- `JWT_REFRESH_SECRET`
- Email provider credentials
- SMS provider credentials
- Peach Payments credentials
- DocFox credentials
- OTT credentials

Do not leave required secrets blank.

## 5. Install Dependencies

```bash
npm install --omit=dev
```

Run this on the Ubuntu server with Node.js 20+. It installs production dependencies and verifies `package-lock.json` against the runtime package manager.

## 6. Run Schema Migration

```bash
npm run db:migrate
```

This creates tables only. It does not seed demo users.

## 7. Seed Pricing Rules

```bash
npm run pricing:seed
```

Pricing rules are operational configuration and can later be managed by the Admin Portal.

## 8. Create First Super Admin

Use a real staff email and a strong password:

```bash
ADMIN_FULL_NAME="TitoPay Super Admin" \
ADMIN_USERNAME="superadmin" \
ADMIN_EMAIL="real.staff.email@titopay.co.za" \
ADMIN_PASSWORD="REPLACE_WITH_REAL_STRONG_PASSWORD" \
ADMIN_ROLE="super_admin" \
npm run admin:create
```

Password policy: at least 14 characters with uppercase, lowercase, number and symbol.

## 9. Start API with PM2

```bash
sudo mkdir -p /var/log/titopay-api
sudo chown -R $USER:$USER /var/log/titopay-api
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup systemd
```

## 10. Configure Nginx

```bash
sudo cp deploy/nginx-api.titopay.co.za.conf /etc/nginx/sites-available/api.titopay.co.za
sudo ln -s /etc/nginx/sites-available/api.titopay.co.za /etc/nginx/sites-enabled/api.titopay.co.za
sudo nginx -t
sudo systemctl reload nginx
```

Install TLS with Certbot or your hosting provider before enabling live traffic.

## 11. Verify Health

```bash
curl https://api.titopay.co.za/
curl https://api.titopay.co.za/health
```

Expected `/health` response:

```json
{
  "status": "ok",
  "service": "titopay-api",
  "database": "ok"
}
```

## 12. Verify Infrastructure

Create a real test customer through the public registration endpoint or Admin operations, then run:

```bash
VERIFY_CUSTOMER_IDENTIFIER="customer@example.com" \
VERIFY_CUSTOMER_PASSWORD="REAL_CUSTOMER_PASSWORD" \
VERIFY_ADMIN_IDENTIFIER="real.staff.email@titopay.co.za" \
VERIFY_ADMIN_PASSWORD="REAL_ADMIN_PASSWORD" \
npm run verify:infra
```

The verifier checks database tables, JWT auth, admin OTP/RBAC, QR generation/payment and audit logs when credentials are supplied.

For admin OTP verification, submit the OTP delivered by the configured email/SMS provider:

```bash
VERIFY_ADMIN_OTP="123456" npm run verify:infra
```

## 13. Security Requirements

- Keep `api.titopay.co.za` behind HTTPS.
- Do not expose PostgreSQL to the public internet.
- Use firewall rules to allow SSH only from trusted IPs.
- Rotate admin bootstrap password after first login.
- Ensure email/SMS OTP providers are connected before public launch.
- Keep `app.titopay.co.za` and `admin.titopay.co.za` as separate deployments.
