# TitoPay HR API deployment

The HR module is isolated from the existing TitoPay customer/admin API. It adds routes under:

- `https://api.titopay.co.za/api/v1/hr`
- `/api/hr`
- `/v1/hr`

## Required deployment steps

1. Upload this API package to the `api.titopay.co.za` backend environment.
2. Copy `.env.example` to `.env` and set production secrets.
3. Ensure `CORS_ORIGINS=https://hr.titopay.co.za`.
4. Run:

```bash
npm install --omit=dev
npm run db:migrate
npm run hr:seed
pm2 start deploy/ecosystem.config.cjs
```

## HR frontend API setting

Build the cPanel frontend with:

```bash
VITE_API_BASE_URL=https://api.titopay.co.za/api/v1/hr npm run build
```

## Seeded HR access

- CEO: `ceo@titopay.co.za` / `TitoPayCEO!2026`
- HR Head Officer: `hr@titopay.co.za` / `TitoPayHRHead!2026`

Change these passwords after first login or override the `HR_*_PASSWORD` variables before seeding.

## Main HR endpoints

- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `POST /auth/reset`
- `GET /dashboard`
- `GET /notifications`
- `GET|POST /employees`
- `GET|POST /onboarding`
- `GET|POST /leave`
- `POST /leave/:id/decision`
- `GET|POST /attendance`
- `POST /attendance/clock`
- `GET|POST /payroll`
- `GET|POST /performance`
- `GET|POST /disciplinary`
- `GET|POST /documents`
- `GET|POST /tickets`
- `GET|POST /jobs`
- `GET|POST /candidates`
- `GET /audit`
- `GET /export/:resource.csv`
- `GET /export/:resource.pdf`

All protected endpoints require:

```http
Authorization: Bearer <HR_ACCESS_TOKEN>
```
