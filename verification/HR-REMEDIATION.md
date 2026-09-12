# HR System — Remediation Report

Against the HR PRODUCTION HARDENING audit (`hr_2.zip`).

Commits: `d6a9392`, `0d2c923`, `9cf97be`, `8c91f38`, `08dbdd9` on
`claude/peach-payments-403-fix-6sv7cy`.

Evidence for everything below is reproducible:

```
npm test                                  # from api/  — 328/330
node verification/hr-remediation.js 8110  # 79 checks
node verification/hr-data-isolation.js    # 17 checks
node verification/hr-portal.spec.js       # 47 checks, in a real browser
```

The portal harness needs the sandbox copy: `bash verification/sync-hrserve.sh`
then `node verification/hr-static.js`.

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

**N-02 — Learning Hub "Open resource".** The button was not broken; it was
aimed at a placeholder. Every seeded course was written with
`course_url = 'hr-learning'`, and the portal renders the link whenever that
field has a value, so all fifteen courses offered a link to a relative path that
does not exist — including the three mandatory ones the audit named. The
material was never missing: it is the course's handbook content and lessons,
read in the app. The placeholder is cleared, the seed no longer writes one, and
a course can no longer be saved with a link a browser cannot open (a bare word,
a host with no scheme, or a `javascript:`/`data:` URL aimed at whoever clicked).
Verified in the browser: no course offers a dead link, and all three mandatory
courses are on screen with working controls.

**N-04 / N-05 — Deleting candidates and announcements.** Both render as cards,
and only table rows were given the edit and delete controls the rest of the
portal has. The API supported deletion the whole time. Both lists now carry a
delete control that goes through the ordinary endpoint — soft delete, audit
entry naming the actor, server free to refuse. A card carries no record id, so
the record is matched on what the card shows; if that matches more than one
record nothing is deleted and it says why. Verified end to end in the browser
for both, including that the row survives as a soft delete.

**Announcement approval decisions were being discarded.** The portal sends
`submittedBy`/`submittedAt` on submission and `approvedBy`/`publishedAt` on
approval. None of those columns existed, so all four were dropped on the way in:
an approved announcement could not say when it went live or who allowed it.
Added and backfilled. Not in the audit.

**Misleading deletion copy.** The confirmation said "This action cannot be
undone" and offered "Delete permanently". Neither was true — the record is
retained for the audit trail. It now says what actually happens.

**The page scrolled behind the open mobile menu**, because the scroll lock has
to go on `<html>`, which is what scrolls here, not `<body>`. Not in the audit.

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

**N-03 — Scrolling does not reproduce.** Tested signed in, at 1440, 1280, 820,
390 and 360 wide. The Learning Hub renders twenty courses over 8500px and
scrolls to the last one at every size; the menu opens, closes from its own X and
from a tap outside, and the page scrolls again afterwards. The one thing that
did fail was reloading a route — and that was the test sandbox, not the product:
`hr/.htaccess` carries the SPA rewrite, and `verification/hr-static.js` now
gives the sandbox the same rule. If the tester can say which screen and which
device, I will chase it; there is nothing to fix from the report as written.

**F-13 — Company Documents version field.** The server stores what it is given,
and the form is putting the document title into both Version and Description.
Correcting the form needs the React source; correcting the affected rows needs
production data. Both are listed in §2 and §9.

**F-20 / F-21 / F-22 — "Super Adminstrator".** Not in the API, the database or
the portal's text — it is a job title typed onto an employee record in
production. One field edit in Employees. Recruitment, Reports and the Audit log
all load: Recruitment opens on its Jobs tab, and candidates are behind the
"Candidate pipeline" tab beside it, which is worth knowing if the tester
concluded the module was empty.

**Still needs the React source.** `hr/index.html` is a 444 KB compiled bundle
with no source map. Everything above was repaired either server-side or by an
additive script against the rendered DOM — the pattern this file already used
for three earlier fixes. That approach has a limit: changing what a form *field*
does (F-13), or how the Learning Hub renders in-app material rather than
following a link, wants the component. With the frontend repository those become
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

`hr/` is now under version control — it never was, which is why
`api/test/hr-session.test.js` could not find `hr-session.js` and the whole file
failed. That test now runs and passes (4/4).

- `hr/index.html` — an additive repair script (delete controls for the candidate
  and announcement lists; the mobile scroll lock), and two corrected strings in
  the deletion confirmation. The compiled bundle is otherwise untouched. The
  file already carried three scripts of this kind; this is the fourth, written
  the same way and marked for removal once the fix exists in source.
- `hr/hr-session.js` — publishes the API base it already knew, so the repair
  script calls the same address this bridge authenticates instead of carrying
  its own copy.

The readable source of the repair script is kept at
`verification/hr-portal-repairs.source.js` so it can be reviewed without
reading it out of a 444 KB file.

---

## 8. Tests executed

| Suite | Result |
|---|---|
| `api` unit and structure suite | **328 / 330** — the two failures are the Peach Checkout sandbox tests, which need an external service, and fail identically before these changes |
| `verification/hr-remediation.js` | **79 / 79** |
| `verification/hr-data-isolation.js` | **17 / 17** |
| `verification/hr-portal.spec.js` | **47 / 47** — a real browser, five screen sizes |
| Mutation testing | 9 mutants, each killed by the matching assertion |

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
