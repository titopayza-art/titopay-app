# TitoPay Production API

Production-ready Node.js 20+ API for `api.titopay.co.za`.

This package contains backend services only. It does not contain customer PWA code or Admin Portal frontend code.

## Stack

- Node.js 20+
- Express
- PostgreSQL
- JWT access and refresh tokens
- OTP challenge flow
- RBAC admin permissions
- PM2 process management
- Nginx reverse proxy

## Production Principles

- No demo users are seeded.
- No default admin credentials are embedded.
- No seeded passwords are stored in code.
- All secrets must come from environment variables.
- The database is the source of truth.
- `/app` and `/admin` must access data only through this API.

## Core Modules

- Authentication and session management
- OTP challenge, resend and verification
- Role-based access control
- Wallet balances and wallet ledger
- Transaction processing and reversals
- Merchant registration and verification
- QR generation and QR payments
- Pricing rules and fee preview
- TitoPay revenue wallet and revenue ledger
- Audit logs and security logs

## Setup Summary

```bash
cp .env.example .env
npm install --omit=dev
npm run db:migrate
npm run pricing:seed
ADMIN_FULL_NAME="TitoPay Super Admin" \
ADMIN_USERNAME="superadmin" \
ADMIN_EMAIL="you@titopay.co.za" \
ADMIN_PASSWORD="use-a-real-strong-password" \
ADMIN_ROLE="super_admin" \
npm run admin:create
pm2 start deploy/ecosystem.config.cjs
```

Read `PRODUCTION_DEPLOYMENT.md` before deployment.
