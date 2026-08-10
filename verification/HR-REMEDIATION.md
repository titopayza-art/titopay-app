# HR System — Remediation Report

Against the HR PRODUCTION HARDENING audit (`hr_2.zip`).

Commits: `d6a9392`, `0d2c923`, `9cf97be`, `8c91f38` on `claude/peach-payments-403-fix-6sv7cy`.

Evidence for everything below is reproducible:

```
npm test                                  # from api/  — 328/330
node verification/hr-remediation.js 8110  # 79 checks
node verification/hr-data-isolation.js    # 17 checks
```

---

## 1. Fixed

**F-02 — Attendance clock in.** `/attendance/clock` took the employee name from
the request body and looked the employment contract up by it, so posting a
colleague's name recorded the working day against them, from an ordinary
employee account. Identity now comes from the session — the employee id the
login resolved, or failing that the account's own email address. A name in the
body is treated as a signature, which is what the signature column is for.
Verified: correct person identified, server-side timestamp, Johannesburg work
date, duplicate clock-in refused with 409, clock-out and double clock-out,
one record per day, and a forged name creating no record against its target.

**F-03 / F-19 — Payroll zero and blank values.** `next[field] ?? 0` only caught
null and undefined, so the empty string an untouched form field sends reached
`asNumber("")`, came back `undefined`, and was rejected as "must be a
non-negative amount". Blank now means zero. Verified against all six scenarios
the audit listed — all zero, salary only, salary + allowance, salary +
deductions, salary + allowance + deductions, decimals — each checked for the
correct net pay, not just for saving. `"abc"` and `-100` are still refused.

**F-04 — Disciplinary permissions.** `disciplinary` was the one module an HR
Administrator held no grant on, so the page answered 403 for the role that runs
the process. Granted. An ordinary employee is still refused. See §3 for the
part of this finding that is a business decision, not a bug.

**F-06 — Employee database integrity.** Records now resolve the person against
the staff list by id, employee number, work email or full name, and store the
link. `hr_expense_claims` was the only employee-linked table with no
`employee_id` column at all — added and backfilled. Naming *someone else* has to
resolve to a real member of staff; naming *yourself* does not, so an HR user
with no employee record of their own can still clock in and claim, as before.
Verified across claims, leave and payroll: "hh" is refused with a message that
says what to do.

**F-07 — Claim status.** An expense claim carried four independent status
columns with nothing keeping them in step, which is how one record showed
"Payment Scheduled" and "Manager Review" at once. The displayed status is now
derived from the three decisions rather than supplied, and the ladder runs
manager → finance → payment, so nothing is marked paid on a claim nobody
approved. A status sent by the frontend is ignored.

**F-08 — Claim self-approval.** There was no normalisation block for expenses at
all: every status field was written straight from the request body, so a
claimant could approve and pay their own claim by PATCHing it. The three
decisions are now writable only by a role holding the whole expenses module, and
nobody — including a manager — may approve a claim filed in their own name. A
decision a PATCH does not mention keeps its stored value, which a naive fix
would have overwritten.

**N-06 — Internal request exposure.** Fixed in `d6a9392`. The permission strings
already said `leave:self`, `tickets:self`, `expenses:self`, but nothing read the
`:self` suffix, so it was treated as blanket write over the whole module. One
employee could list, edit and delete another's claims, leave, tickets and
performance reviews. Row-level ownership now applies to every self-scoped
resource on read, write and delete.

**N-04 / N-05 — Record deletion.** Not a server defect: deletion works for both
announcements and recruitment candidates, is a soft delete, refuses an
unauthorised user, removes the record from lists, and answers 404 on a second
attempt. Twelve checks now hold that in place. The missing part is the button —
see §3.

**N-02 — Learning Hub resource links (server-side half).** A course could be
published with a link nothing can open: a bare word, a host with no scheme, or a
`javascript:`/`data:` URL aimed at whoever clicked. Links are now validated on
create and edit. The root cause of the three broken mandatory courses is in §3.

**Audit log attribution.** Every Login — and every action taken through the
login path — was recorded with no actor at all. `audit()` reads `auth.userId`,
but the login path holds the raw `hr_users` row, where the field is `id`, so the
insert stored null. Both shapes are read now, and each entry also records the
role the person acted under. All 27 entries in a harness run are attributed;
before, the logins were not.

**Salary and bank details in the staff directory** (not in the audit — found
while testing F-06). Listing employees ran `SELECT *`, so every role holding
`employees:read` — a team lead, an auditor, a read-only account — received
salary, hourly rate, tax number, bank account, medical notes and next of kin for
all staff, and the CSV and PDF exports carried it too. The directory now returns
names, job titles and contact details; pay data goes to roles that run payroll;
medical and emergency details to full holders of the module; and your own record
is always yours in full.

**F-14 — Data hygiene mechanism.** `npm run hr:hygiene` reports records that
look like test or placeholder data across seventeen HR modules, says why it
suspects each one, and deletes nothing. See §3 for why it stops there.

---

## 2. Partially fixed

**F-14 — Placeholder data.** The mechanism is built and, run against the
development database, it found exactly the "hh" records the audit reported.
Removing the specific records the audit saw ("Team dinner", "STRATEGISING",
"tyui", "yui") needs the production database, and the spec is explicit that
records must not be deleted on text matching alone. Run the report against
production, read the list, and delete the confirmed leftovers through the
portal — that path is a soft delete and records who did it.

**F-16 — Name capitalisation.** The structural half is done, and it is the half
the finding asked for: records now store the employee id and take their name
from the Employees record rather than copying free text between modules. Names
already stored inconsistently are production data; nothing was mutated, per the
instruction not to force case onto legal names.

**N-02 — Learning Hub "Open resource".** The cause is identified:
`ensureLearningDefaults()` seeds every course with `course_url = 'hr-learning'`
— a placeholder, not an address — and no video, PDF or presentation. The course
material itself exists as handbook content and lessons in the database, so
nothing is lost; what is broken is a button pointed at a string that is not a
link. Fixing what that button does needs the frontend source (§3).

---

## 3. Not fixed, and why

**The HR portal frontend is a minified React bundle with no source and no source
map.** `hr/index.html` is 433 KB of compiled output. These findings are all in
it, and hand-editing minified output would be unmaintainable and unsafe:

- **N-03** — scrolling. Needs the layout CSS.
- **N-04 / N-05** — the delete buttons. The API is proven; the controls are missing.
- **F-13** — Company Documents version field showing the statute title. The
  server stores whatever it is given; the form is putting the title in both
  fields.
- **F-15** — announcement approval counter. There is no counter in the API — it
  is computed in the bundle. The spec says not to guess what it should mean, and
  I cannot see the current definition to correct it.
- **F-20 / F-21 / F-22** — "Super Adminstrator". The string is not in the API, the
  database, or the bundle's readable text. It is most likely a job title on a
  production employee record, which is a one-field edit in the portal.
- **N-02** — making "Open resource" render in-app material instead of following a
  URL.

**What I need:** the HR frontend source repository. With it, all of the above are
ordinary work.

**A decision, not a defect (F-04).** Who signs a disciplinary case *off* —
records the outcome and closes it — is a business rule I will not invent. My
recommendation: HR Administrator runs the process (now granted); Compliance
Officer keeps the outcome and closure; Department Manager gets read on their own
team, which needs a team-scoping rule that does not exist yet. Say the word and
I will implement whichever split you want.

---

## 4. Security findings

| | |
|---|---|
| **Cross-employee access** | One employee could read, edit and delete another's claims, leave, tickets and performance reviews. Fixed, `d6a9392`. |
| **Self-approval of money** | A claimant could approve and pay their own expense claim through the API. Fixed, `0d2c923`. |
| **Salary and bank data disclosure** | The staff directory and its CSV export returned salary, tax number, bank account and medical notes to every read-only role. Fixed, `9cf97be`. Not in the audit. |
| **Attendance impersonation** | Any account could clock in as any colleague by putting their name in the request body. Fixed, `8c91f38`. Not in the audit. |
| **Unattributed audit trail** | Logins and login-path actions were recorded with no actor. Fixed, `8c91f38`. |
| **Record-existence oracle** | A request aimed at another person's record answered "no valid HR fields supplied", confirming the record exists. Now answers 404. Fixed, `0d2c923`. |
| **Employee-name overwrite** | A PATCH that did not mention an employee overwrote the record's employee name with whoever was editing it. Fixed, `0d2c923`. |
| **Unsafe resource links** | Courses could publish `javascript:` and `data:` URLs aimed at whoever clicked. Fixed, `8c91f38`. |

None of these could be reached by hiding a button; each was tested against the
API directly, as a signed-in person, with a token the system issued.

---

## 5. Database changes

Additive only. No table, column or record was dropped, and no `.down.sql` was run.

- `20260810_hr_claim_employee_link.up.sql` — adds `hr_expense_claims.employee_id`
  (UUID, nullable, `REFERENCES hr_employees(id) ON DELETE SET NULL`), a partial
  index on it, and a backfill that links only claims whose employee name matches
  exactly one person. Ambiguous names are left for a human.
- `hr-schema.sql` — the same column and index, so a fresh install matches.

A reversing migration exists but is not run by the deploy script.

---

## 6. API changes

No endpoint was added or removed. Behaviour changed on:

- `GET /v1/hr/employees` and `GET /v1/hr/export/employees.*` — pay, bank, tax,
  medical and emergency fields are omitted for roles that should not see them.
- `POST|PATCH /v1/hr/expenses` — approval fields are role-gated; status derived;
  self-approval returns 403; out-of-order approval returns 400.
- `POST|PATCH /v1/hr/{payroll,leave,attendance,onboarding,performance,disciplinary,expenses}`
  — an employee named must exist; the record stores the link.
- `POST /v1/hr/attendance/clock` — identity from the session, not the body.
- `POST|PATCH /v1/hr/learning` — resource links validated.
- `PATCH /v1/hr/:resource/:id` — 404 rather than 400 when the record is not the
  requester's to see.
- `GET /v1/hr/disciplinary` and writes — reachable by HR Administrator.

---

## 7. Frontend changes

None. `hr/` is now under version control — it never was, which is why
`api/test/hr-session.test.js` could not find `hr-session.js` and the whole file
failed. That test now runs and passes (4/4).

---

## 8. Tests executed

| Suite | Result |
|---|---|
| `api` unit and structure suite | **328 / 330** — the two failures are the Peach Checkout sandbox tests, which need an external service, and fail identically before these changes |
| `verification/hr-remediation.js` | **79 / 79** |
| `verification/hr-data-isolation.js` | **17 / 17** |
| Mutation testing | 6 mutants, each killed by the matching assertion |

The mutants: self-approval check removed; claim status derived from the payload
instead of the stored row; employee resolution never refusing; clock-in identity
taken from the request body again; audit reading only `auth.userId`; salary
redaction disabled. Two of them exposed assertions that were weaker than they
looked, and those assertions were strengthened before the mutant was reverted.

Two existing tests were updated rather than removed, both because the
requirement changed and both made stronger in the process: the payroll stub now
answers the employee lookup, and the clock-in test now asserts the record
carries the employee foreign key and that no lookup by a body-supplied name ever
happens.

---

## 9. Remaining risks

1. **The frontend is unchanged and unsourced.** Every hardening here is
   server-side. That is the right place for it, but a user still sees the old
   screens — including the broken "Open resource" and the missing delete
   buttons.
2. **Requiring a real employee is a behaviour change.** Writing a record against
   a person who is not in the Employees list now fails where it used to succeed.
   If production has payroll or leave written against names never added as
   employees, editing those records will refuse until the person is added. This
   is the intended effect of F-06; it is worth knowing before the first support
   call.
3. **The salary redaction draws a line somebody has to agree with.** Payroll
   roles see pay; everyone else sees the directory. If an auditor is expected to
   see salaries, that is one line in `PAY_FIELDS` and a decision I would rather
   you make than assume.
4. **The approval ladder is enforced strictly.** Finance cannot approve before a
   manager, and nothing is paid before finance. If a real workflow skips the
   manager for small amounts, that rule needs a threshold.
5. **Production data was not touched.** The hygiene report, the misspelled job
   title and the document version fields all need someone with production access
   to act.
6. **`hr_expense_claims.employee_id` is nullable and partly backfilled.** Claims
   whose name matched two employees, or nobody, are still linked by text only.
