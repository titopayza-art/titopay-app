# TitoPay API Afrihost Replacement Package

This ZIP is a complete replacement deployment package for `api.titopay.co.za`.

It includes the password-only admin login patch, `/v1/health`, and the required admin recovery scripts.

## Included Admin Scripts

```bash
npm run admin:create
npm run admin:reset-super
npm run admin:diagnose-login
npm run admin:password-only
```

## Required Environment Behaviour

When these values are present:

```bash
ADMIN_OTP_REQUIRED=false
VERIFY_ADMIN_OTP=false
```

Admin login returns a JWT/session immediately after a valid email/username and password. OTP generation, OTP delivery, OTP verification, and existing OTP challenges are bypassed.

## Afrihost Deployment Steps

This archive is intentionally flat: `package.json`, `src/`, `deploy/`, and the other API files are at the ZIP root. Extract it inside `/var/www/titopay/api`, not in its parent directory.

1. Upload `api.zip` to `/var/www/titopay/api`.
2. From `/var/www/titopay/api`, extract it with overwrite enabled.
3. Confirm that `/var/www/titopay/api/package.json` exists and that no nested `/var/www/titopay/api/api` release is being used.
4. Install production dependencies:

```bash
npm install --omit=dev
```

5. Ensure the Super Admin exists and has the expected password:

```bash
ADMIN_PASSWORD='REPLACE_WITH_A_STRONG_PRIVATE_PASSWORD' npm run admin:create
ADMIN_PASSWORD='REPLACE_WITH_A_STRONG_PRIVATE_PASSWORD' npm run admin:reset-super
```

6. Force Password Only mode in PostgreSQL:

```bash
npm run admin:password-only
```

7. Restart the API with current environment variables:

```bash
pm2 restart titopay-api --update-env
```

8. Confirm versioned health is live:

```bash
curl -sS https://api.titopay.co.za/v1/health
```

9. Confirm admin login:

```bash
ADMIN_PASSWORD='REPLACE_WITH_THE_PRIVATE_ADMIN_PASSWORD' npm run admin:diagnose-login
```

## Expected Admin Login

Username: `ceo`

Email: `ceo@titopay.co.za`

Role: `super_admin`

Authentication mode: `PASSWORD_ONLY`
