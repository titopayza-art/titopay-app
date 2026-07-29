# What the HR console reads from the API

Extracted from the compiled bundle in `index.html`, not from the API itself.
This is the shape the **front end** expects. Where the live API returns
something different, the field renders blank — the page will not error, so a
mismatch shows up as an empty cell rather than a crash. That is the most
likely cause of a page that "looks broken" while the console itself is fine.

Base URL: `https://api.titopay.co.za/api/v1/hr`

## Auth and session

| Endpoint | Notes |
| --- | --- |
| `GET /health` | `{ database: "ok" }` drives the sign-in status chip. Anything else reads "degraded"; an unreachable host reads "offline". |
| `POST /auth/login` | Body `{ email, password }`. **Response must include `token`** — the bundle stores `d.token`, not `accessToken`. Also return `refreshToken` and `user { name, email, role }`. |
| `POST /auth/refresh` | Body `{ refreshToken }`. Called by `hr-session.js` after a 401. |
| `POST /auth/reset` | Body `{ email }`. |
| `POST /auth/logout` | Clears the stored session. |

`user.role` gates what is visible. `Employee` collapses the console to
self-service; salary and disciplinary data are role-restricted.

## Dashboard

`GET /dashboard` must return all of:

```jsonc
{
  "metrics":   { "totalEmployees": 0, "activeEmployees": 0, "onLeave": 0, "pendingApprovals": 0 },
  "leaveTrend":  [0, 0, 0, 0, 0, 0, 0],   // 7 numbers, oldest first
  "attendance":  { "present": 0, "remote": 0, "onLeave": 0, "absent": 0 },
  "departments": [{ "name": "", "value": 0 }],
  "onboarding":  { "complete": 0, "inProgress": 0, "overdue": 0 },
  "activities":  [{ "id": "", "action": "", "user": "", "detail": "", "createdAt": "" }]
}
```

`onboarding` and `metrics` are read without a guard — if either is missing the
dashboard hits its error boundary and shows "We couldn't load this page".
Every other page tolerates a missing field.

Returning `{ "staff": true, ... }` switches the dashboard to the employee
self-service variant.

## Collections

Every list endpoint returns `{ "data": [ … ] }`. Field names below are what the
table columns and the add/edit form read.

| Endpoint | Row fields the console reads |
| --- | --- |
| `/employees` | `employeeNumber, name, jobTitle, department, employmentType, startDate, status` — plus `firstName, lastName, email, phone, managerId, salary, workLocation, emergencyContact` for the record page and edit form |
| `/onboarding` | `employee, title, category, dueDate, status` |
| `/leave` | `employee, type, startDate, endDate, days, status, reason` |
| `/attendance` | `employee, workDate, clockIn, clockOut, workMode, status, minutesLate` |
| `/payroll` | `employee, period, baseSalary, allowances, deductions, bonuses, netPay, status` |
| `/expenses` | `employee, type, amount, currency, receiptUrl, description, managerStatus, financeStatus, paymentStatus, status` |
| `/performance` | `employee, period, kpis, score, selfReview, managerFeedback, improvementPlan, status` |
| `/disciplinary` | `caseNumber, employee, type, incidentDate, hearingDate, description, outcome, status` |
| `/documents` | `title, category, department, rolePermission, version, fileUrl, description, requiresSignature, requiredReading, updatedAt, status` |
| `/tickets` | `requester, type, subject, description, priority, createdAt, status` |
| `/help` | `title, category, summary, body, updatedAt, status` |
| `/learning` | `title, category, format, mandatory, status` — plus `description, overview, durationMinutes, level, tags, courseUrl, videoUrl, pdfUrl, passMark, certificateEnabled, assessmentRequired` |
| `/projects` | `projectName, owner, department, progress, dueDate, startDate, currentMilestone, latestUpdate, blockers, status` |
| `/meetings` | `title, meetingDate, meetingTime, chair, department, attendees, apologies, agenda, previousMinutes, outcomes, status` |
| `/announcements` | `title, body, audience, priority, status, publishedAt, submittedAt, createdAt` |
| `/jobs` | `title, department, location, closingDate, status` |
| `/candidates` | `name, email, jobTitle, stage, notes, status` |
| `/audit` | `user, action, entity, detail, createdAt` |
| `/notifications` | `title, body, createdAt, read` |

Field-name traps worth checking against the live API:

- **Projects** use `projectName`, not `name`.
- **Employees** need both `name` (for the register column) and
  `firstName` / `lastName` (for the record page and the edit form).
- `emergencyContact` is written by the form as free text but read on the
  record page as an object with `.name` and `.phone`.
- `priority` on an announcement should be `normal`, `important` or `urgent`;
  it is used directly as a CSS class, so an unknown value renders grey.
- Any field named `status` is used directly as a CSS class. Values outside the
  known set (`active, approved, complete, completed, processed, open,
  published, pending, in_progress, manager_review, review, investigation,
  pending_ceo_approval, important, draft, planning, scheduled, suspended,
  rejected, terminated, urgent, at_risk, cancelled, archived, paused, normal`)
  render as a neutral grey pill.

## Writes

| Endpoint | Notes |
| --- | --- |
| `POST /<resource>` | Create, body keyed by the form fields above |
| `PUT /<resource>/:id` | Update |
| `DELETE /<resource>/:id` | Delete |
| `POST /leave/:id/decision` | Body `{ decision }` — the approve/reject buttons |
| `POST /attendance/clock` | Toggles. Body `{ workMode, timezone, location? }`, header `X-Timezone`. **Response must include `action: "clocked_in"` or `"clocked_out"`**, plus `message` and `data` (the attendance row). The button label is driven by `action`. |
| `POST /attendance/break/:action` | `:action` is `start` or `end` |
| `POST /uploads` | Multipart. Returns `{ fileUrl }` or `{ storageKey }` |
| `GET /export/<resource>.csv \| .pdf` | Bearer-authenticated download |

## Behaviour worth knowing

Clock-in asks the browser for geolocation before it posts, with a 2.5 second
timeout. On a real device the user sees a location prompt and the request can
take up to ~2.5s to leave the page. Denying location does not block the clock;
it just posts without coordinates.
