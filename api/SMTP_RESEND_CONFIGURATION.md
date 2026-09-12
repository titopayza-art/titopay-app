# TitoPay SMTP and Resend Configuration

This guide configures production OTP email delivery for the TitoPay API.

## Provider

Use Resend as TitoPay's production transactional email provider for OTP delivery.

Resend is preferred for OTP and system email because it is designed for application email delivery, supports API-key based SMTP authentication, and avoids using staff mailbox credentials for automated security messages.

## Required DNS Setup

Before enabling production OTP email:

1. Verify `titopay.co.za` in Resend.
2. Add the DNS records supplied by Resend.
3. Confirm the domain status is verified.
4. Create a production API key in Resend.

## Required Environment Variables

Add these values to the production API `.env` file:

```bash
EMAIL_PROVIDER=smtp
EMAIL_FROM_ADDRESS="TitoPay <no-reply@titopay.co.za>"

SMTP_HOST=smtp.resend.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=resend
SMTP_PASSWORD=re_YOUR_RESEND_API_KEY_HERE
SMTP_REJECT_UNAUTHORIZED=true

ADMIN_OTP_REQUIRED=false
```

When using Resend SMTP, keep these blank:

```bash
EMAIL_API_URL=
EMAIL_API_KEY=
```

## Install Dependencies

After uploading the API package:

```bash
cd /var/www/titopay/api
npm install
```

## Restart API

```bash
pm2 restart titopay-api --update-env
pm2 save
```

## Verify API Health

```bash
curl -sS https://api.titopay.co.za/health
```

Expected:

```json
{"status":"ok","service":"titopay-api","database":"ok"}
```

## Verify OTP Email Delivery

```bash
cd /var/www/titopay/api
TEST_OTP_EMAIL=ceo@titopay.co.za npm run email:verify
```

Expected:

```json
{
  "ok": true,
  "provider": "smtp",
  "recipient": "ceo@titopay.co.za",
  "messageId": "...",
  "accepted": ["ceo@titopay.co.za"],
  "rejected": []
}
```

## Verify Admin Login OTP Challenge

```bash
curl -i -X POST https://api.titopay.co.za/v1/admin/login \
  -H "Content-Type: application/json" \
  -H "Origin: https://admin.titopay.co.za" \
  --data '{"identifier":"ceo@titopay.co.za","password":"YOUR_ADMIN_PASSWORD"}'
```

Expected:

```json
{
  "ok": true,
  "otpRequired": true,
  "challengeId": "...",
  "maskedDestination": "ce***@titopay.co.za"
}
```

## Notes

- Do not commit real SMTP passwords or Resend API keys.
- Keep `ADMIN_OTP_REQUIRED=false` during UAT to preserve the Password Only default while SMTP is configured and tested in the Admin Security Centre. A Super Admin can then enable Email OTP from the Security Dashboard; the saved portal setting controls runtime behavior.
- Set `ADMIN_OTP_REQUIRED=true` when a Password + Email OTP default is preferred for new installations.
