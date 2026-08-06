# TitoPay Admin — Enterprise Analytics

Build `admin-console-v52`. This document covers what the Analytics module does,
where every number comes from, and what an API change would add to it.

## What was added

| File | Change |
| --- | --- |
| `analytics/index.html` | New entry page, `data-page="analytics"` |
| `assets/admin-analytics.js` | New module, imported on demand |
| `assets/admin.js` | Additive only: nav entry, icon, permission branch, page descriptor, loader, host bridge. No line was removed or rewritten. |
| `assets/admin.css` | Additive only: chart palette tokens, one module block, matching responsive/dark/print rules. No existing selector changed. |
| every other `index.html` | Asset query string `?v=admin-console-v50` → `?v=admin-console-v52`. Nothing else. |

No authentication, permission model, API contract, database structure, payment,
wallet, KYC, chat, HR, notification, QR, marketplace or existing admin module
behaviour was touched.

## Loading

`assets/admin.js` imports `assets/admin-analytics.js` the first time an operator
opens Analytics. Any other console page loads exactly the JavaScript it loaded
in v50. If the module file is missing, Analytics shows the console's standard
module error and every other page is unaffected.

The module is handed a fixed host object (`apiFetch`, `escapeHtml`, `money`,
`chipClass`, `tableCard`, `renderRows`, `downloadCsv`, `showToast`,
`PAGE_EXPORTS` and the two access helpers). It reaches nothing else in the
console.

## Access

Visible to any operator who already has full platform access or a platform
owner role, and to any operator whose permission set carries one of:

```
analytics · reporting · reports · analytics_view
ANALYTICS_VIEW · REPORTING_VIEW · REPORTS_VIEW
```

Operators without one of those do not see the sidebar entry, and opening
`/analytics/` directly shows "Access restricted". Every other module's access
rules are exactly as they were.

## Sections

| Section | Contents |
| --- | --- |
| Executive | 28 KPI cards with period-on-period growth, revenue and volume trends, settlement outcome, top revenue services |
| Financial | Revenue by day, month and year, transaction volume, wallet growth, merchant growth, top revenue services, settlement trends, refund trends, cash-flow overview |
| Users | Growth, daily signups, retention by cohort, returning users, device types, browsers, operating systems, geography, province, city, language, age groups |
| Transactions | Per minute, hourly, daily, monthly, success against failure, payment methods, QR / wallet / merchant / withdrawal / deposit mix, average processing time |
| Merchants | Top merchants, merchant revenue, growth, activity, QR usage, store visits, smart queue usage, marketplace sales, ratings, payouts |
| Fraud & Security | Failed logins, locked accounts, suspicious devices, multi-device logins, risk score trend, high-risk transactions, fraud alerts, remote logouts, active sessions, login heat map |
| Support | Tickets open and closed, average resolution time, satisfaction, AI resolution rate, human escalations, average response time, chat volume |
| System | API health and measured latency, CPU, RAM, disk, network, database health, queue processing, webhook deliveries, background jobs, cache performance |

Filters: Today, Yesterday, Last 7 / 30 / 90 Days, This Month, Last Month, This
Year, Custom Range, plus Province, Merchant, User, Payment Method, Transaction
Type and Status. Filter options are built from the data the API returned, so a
dimension the API does not carry is shown as unavailable rather than as an empty
list.

Export: PDF (the browser's print pipeline against the module's print
stylesheet — choose "Save as PDF"), Excel (a real `.xlsx` written in the
browser, one sheet per dataset) and CSV.

## Where the numbers come from

Analytics reads endpoints that were already live. Nothing new is required.

Loaded on every visit:

```
/admin/dashboard/overview     /admin/users            /admin/merchants
/admin/wallets                /admin/transactions     /admin/revenue
/admin/compliance/queue       /admin/support/tickets  /admin/support/conversations
/admin/security               /admin/module-health
```

Loaded only when the section that needs them is opened:

```
Fraud & Security  /admin/audit
Merchants         /admin/marketing/reviews · /admin/qr-assets
Support           /admin/chat-monitor/overview
System            /admin/maintenance · /admin/integrations/webhooks · /admin/email/dashboard
```

`/admin/transactions` is called with `from`, `to` and `limit`. The window starts
at the previous comparable period so growth percentages are computed from real
rows rather than estimated. Every request is best-effort: an endpoint that does
not answer is listed under "Modules that did not answer" and the metrics it
feeds show a dash.

## The dash

A metric renders `—` when the API response did not carry the field it needs.
Nothing on this page is estimated, extrapolated or sampled. Each section ends
with a **Data coverage** card naming every unavailable metric and the exact
field or endpoint that would supply it.

Common examples on a stock API:

| Metric | Needs |
| --- | --- |
| Active users | `last_seen_at` on `GET /admin/users` (falls back to distinct transacting identities, and says so) |
| Device, browser, OS, language, age | the matching field on `GET /admin/users` |
| Province and city | `province` / `city` on users, merchants or transactions |
| Payment method | `payment_method` or `financial_route` on transactions |
| Average processing time | `completed_at` or `processing_ms` on transactions |
| Risk score trend | `risk_score` on transactions |
| CPU, RAM, disk, network, cache | the matching field on `GET /admin/maintenance` |
| Store visits, smart queue | `store_visits` / `smart_queue_sessions` on merchants |
| Customer satisfaction, AI resolution | `satisfaction` / `resolved_by_bot` on tickets and conversations |

Adding any of those fields to an existing response is additive: the metric
starts rendering with no console change.

## Optional endpoint

`GET /admin/analytics/overview?from&to&limit` is requested on every load and is
entirely optional. If it answers, the module uses it. If it 404s, nothing is
affected — this is the state the module was built and tested in.

## Performance

- The module is imported only when Analytics is opened.
- Aggregates are cached in memory for 60 seconds per range and filter set, so
  moving between the eight sections does not refetch.
- Section-specific endpoints are fetched on first use and cached with the
  snapshot.
- The transaction pull is bounded by the selected range and a 5 000 row limit.
- Aggregation is a single pass per series; tables paginate at 10 rows.

## Content Security Policy

The console pages declare `style-src 'self'`, so the module emits no `style`
attribute anywhere. Chart geometry uses SVG attributes and every colour comes
from a class backed by a `--tp-chart-*` token, which is also what makes the
charts follow the light and dark themes and print correctly.
