# Banking integration safety audit (Phase 3.5)

Audit of the Phase 3 foundation. No provider implemented, no Absa code, no
capability enabled.

**Verdict: PASS on all ten requirements**, after four corrections made during
the audit. Two of those corrections came from mutation testing and are the
substantive findings.

---

## A. Requirement results

| # | Requirement | Result | Note |
|---|---|---|---|
| 1 | Independently enforced gates | **PASS**, after correction (five at audit time; six from build 58) | Code always required five booleans; the prose said "four". Terminology corrected and each gate now proved independently. |
| 2 | Financial isolation | **PASS** | Seven structural tests. No write, no import, no primitive, no balance column, no ledger foreign key. |
| 3 | State machine | **PASS**, after correction | Per-state meanings added; they were undocumented. |
| 4 | Provider isolation | **PASS**, after correction | One comment used `absa_pay` as an example. Neutralised. |
| 5 | Provider registry | **PASS** | Unconfigured resolves to `none`, which refuses. A name in config activates nothing. |
| 6 | Database | **PASS** | Four tables, documented in section D. |
| 7 | Idempotency | **PASS** | Unique constraints, not application checks. Adversarial replay tested. |
| 8 | Reconciliation | **PASS** | Unchanged and exception-only. The banking layer adds a seam that refuses. |
| 9 | Environment safety | **PASS**, after correction | Was two negative rules with a permissive fall-through. Now an allow-list, default deny. |
| 10 | Production safety | **PASS** | Nothing on, nothing reachable, no credential required, no UI path. |

**No financial-isolation or environment-safety requirement failed.** Phase 4
remains blocked only on the Absa evidence in section H.

---

## B. Findings, in order of importance

### F1. The environment rule was fail-open in shape (CORRECTED)

`environmentDecision` was two rules describing which pairs were *wrong*, with
every unlisted pair falling through to permitted. It was correct for today's
values and would have silently permitted any value added later.

Replaced with an explicit allow-list, default deny:

```
TITOPAY_ENV=production  ->  BANKING_ENVIRONMENT must be production
TITOPAY_ENV=sandbox     ->  BANKING_ENVIRONMENT must be development or staging
anything else           ->  refused (UNKNOWN_DEPLOYMENT_ENVIRONMENT)
```

The two vocabularies genuinely differ: `TITOPAY_ENV` has two values,
`BANKING_ENVIRONMENT` has three. The mapping is now written down rather than
inferred. A test enumerates 56 combinations and asserts exactly six pass (three
pairs, times case variation on `TITOPAY_ENV`).

### F2. The gate tests were partly vacuous (CORRECTED)

The Phase 3 tests asserted "capability unavailable" against the shipped `none`
adapter, where `implemented` is false forever. That makes `available` false
regardless of the other gates, so the tests would have passed with gates deleted.

Mutation testing proved it. Deleting `gates.flagEnabled` from the availability
conjunction broke **no test**. Deleting `gates.implemented` broke none either,
because `none` shuts `implemented` and `configured` together.

Fixed by adding three test-only stub adapters that isolate the gates:

| Stub | implemented | configured | isolates |
|---|---|---|---|
| `audit_stub` | true | true | the CONTROL: proves five open gates really do open a capability |
| `audit_stub_unimplemented` | false | true | gate 1 alone |
| `audit_stub_unconfigured` | true | false | gate 2 alone |

They exist only in `test/banking-safety-audit.test.js`. No production code
registers them.

**Mutation results after the fix** (each mutation applied alone, then reverted):

| Mutation | Failures caught |
|---|---|
| Drop the implemented gate | 1 |
| Drop the configured gate | 1 |
| Drop the flag gate | 3 |
| Drop the environment gate | 2 |
| Drop the approval gate | 4 |
| Approvals ignore revocation | 2 |
| Environment allow-list falls through | 3 |
| *(restored)* | **0** |

Every gate is now load-bearing and provably so.

### F3. "Four gates" was wrong terminology (CORRECTED)

The conditional has always been:

```js
const available = gates.implemented && gates.configured && gates.flagEnabled
  && gates.environmentPermits && gates.approved;
```

Five booleans. The comments described gates 1 and 2 as one. They are different
failures: code that exists without credentials, against credentials that exist
for code nobody wrote. Corrected in `banking-service.js`,
`banking-provider.js`, `banking-flags.js` and the design document, and each is
now tested separately.

### F4. A provider name appeared in a comment (CORRECTED)

`banking-flags.js` used `absa_pay` to illustrate flag-name derivation. The
provider-boundary test strips comments by design, so it passed. Documentation is
not coupling, but a neutral example costs nothing. Now `example_bank`.

### F5. State meanings were undocumented (CORRECTED)

The eleven states had a header explaining the machine but no per-state meaning.
An adapter mapping a bank's word onto a state is asserting a meaning, so the
meaning has to be written down. Added as prose and as `STATE_MEANINGS`, with a
test that the two sets match so they cannot drift apart.

---

## C. Financial isolation, proved

Eight assertions, all structural rather than behavioural:

| Claim | How it is proved |
|---|---|
| Cannot create or modify a wallet balance | No banking source contains `available_balance`, `reserved_balance`, `applyWalletMovement`, `getPrimaryWalletForUser` or `getRevenueWallet` |
| Cannot create or modify a ledger entry | No `INSERT`/`UPDATE`/`DELETE` against `wallet_ledger` or `revenue_ledger`; no `balance_after`, no `entry_type` |
| Cannot bypass the transaction service | It is never imported; nor are `wallet-service`, `pricing-service` or any `peach-*` service |
| Cannot mark a transaction successful | No `UPDATE transactions`, no `status = 'completed'` |
| Cannot settle money | Every SQL identifier the service touches is asserted to start with `banking_` |
| No table holds a balance | `information_schema` query returns zero columns matching balance/ledger/debit/credit/entry_type |
| No table links to a ledger | `pg_constraint` query: no banking foreign key targets `wallets`, `wallet_ledger` or `revenue_ledger` |
| The amount is evidence, not authority | No `SUM(`, no `balance` anywhere in the service |

The one permitted financial link is `banking_payment_intents.transaction_id ->
transactions(id)`, a read-only reference so an intent can never be the only
trace of a payment. A test asserts it exists.

---

## D. The four tables

### `banking_capability_approvals`

**Purpose.** The record that a capability has actually been agreed, commercially
and where relevant by a regulator. Gate 6 reads it. It is the only gate
representing a decision taken outside the codebase.

| | |
|---|---|
| **Columns** | `id`, `provider`, `capability`, `environment`, `approved`, `approved_by`, `approval_reference`, `reason`, `approved_at`, `revoked_at`, `revoked_by`, `revocation_reason`, `created_at`, `updated_at` |
| **Foreign keys** | `approved_by`, `revoked_by` -> `admin_users(id) ON DELETE SET NULL` |
| **Unique** | `(provider, capability, environment)` |
| **Indexes** | partial index on `(provider, environment, capability)` where approved and not revoked |
| **Sensitive data** | None. No credential, no endpoint. |
| **Financial impact** | None directly. Necessary but never sufficient to open a rail. |
| **Mutation authority** | Server-side only. No admin route and no console page writes it (tested). |

### `banking_payment_intents`

**Purpose.** The sidecar. Where a payment sits inside a bank's lifecycle, beside
the transaction that remains the financial record.

| | |
|---|---|
| **Columns** | `id`, `transaction_id`, `user_id`, `provider`, `environment`, `capability`, `canonical_state`, `amount`, `currency`, `provider_transaction_id`, `provider_reference`, `provider_status`, `provider_created_at`, `provider_updated_at`, `idempotency_key`, `failure_reason`, `requires_review`, `metadata`, `created_at`, `updated_at` |
| **Foreign keys** | `transaction_id` -> `transactions(id) ON DELETE RESTRICT`; `user_id` -> `users(id) ON DELETE RESTRICT` |
| **Unique** | `transaction_id` (one intent per transaction); `(provider, idempotency_key)`; `(provider, environment, provider_transaction_id)` |
| **Indexes** | by state, by user, by provider reference, plus a partial index for the review queue |
| **Sensitive data** | `provider_reference` and `metadata` may carry provider identifiers. No account number, no credential, no PAN. |
| **Financial impact** | **None.** `amount` is a copy of what the server authorised, held as evidence so a provider's answer can be checked against something immutable. It is never summed, never compared to a balance, and never consulted when computing one. |
| **Mutation authority** | `banking-service` only, through `createIntent` and `transitionIntent`. State changes take `FOR UPDATE` on the row and are validated against the transition table. |

**Does it duplicate the wallet ledger?** No. The ledger records money that
moved, with a running balance. This records what a bank said about a
conversation. It has no `entry_type`, no `balance_after`, no debit/credit and no
link to a wallet.

### `banking_state_transitions`

**Purpose.** Append-only history of canonical state changes, so "how did this
reach SUCCESS?" is answerable later without the bank's logs.

| | |
|---|---|
| **Columns** | `id`, `intent_id`, `from_state`, `to_state`, `source`, `provider_status`, `actor_type`, `actor_id`, `request_id`, `metadata`, `created_at` |
| **Foreign keys** | `intent_id` -> `banking_payment_intents(id) ON DELETE RESTRICT` |
| **Unique** | None. It is a log; repetition is data. |
| **Indexes** | `(intent_id, created_at)` |
| **Sensitive data** | None beyond the provider's own status word. |
| **Financial impact** | None. Audit only. |
| **Mutation authority** | Insert only, by `recordTransition`. Nothing updates or deletes it. |

### `banking_provider_events`

**Purpose.** Every inbound callback, recorded once. This is where webhook
idempotency lives, replacing the `platform_settings` habit that left the sandbox
database with 234 settings rows against a fresh one's 4.

| | |
|---|---|
| **Columns** | `id`, `provider`, `environment`, `event_id`, `event_type`, `signature_verified`, `payload`, `intent_id`, `status`, `attempts`, `last_error`, `request_id`, `source_ip`, `received_at`, `processed_at` |
| **Foreign keys** | `intent_id` -> `banking_payment_intents(id) ON DELETE SET NULL` |
| **Unique** | `(provider, event_id)` — the whole duplicate-delivery defence |
| **Indexes** | partial index on unprocessed events; `(intent_id, received_at DESC)` |
| **Sensitive data** | `payload` holds the provider's body. Headers are deliberately NOT stored, so no signature or bearer token is persisted. `source_ip` is operational. |
| **Financial impact** | **None.** A row here is not evidence money moved. It records that something arrived and whether its signature checked out. |
| **Mutation authority** | `recordProviderEvent` inserts; `markProviderEventProcessed` closes off and counts attempts. A replay cannot rewrite a stored payload (tested). |

---

## E. Idempotency, proved

| Duplicate | Defence | Test |
|---|---|---|
| Provider callback delivered N times | `UNIQUE (provider, event_id)` | 4 sequential redeliveries -> 1 row |
| Callbacks delivered concurrently | the same constraint | 10 concurrent -> exactly 1 non-duplicate |
| Replay with a tampered body | insert is `ON CONFLICT DO NOTHING` | a replay claiming amount 999999 and state SUCCESS leaves the original body intact |
| Repeated create request | `UNIQUE (provider, idempotency_key)` | a retry returns the original intent, `created: false` |
| Concurrent create requests | the same constraint | 8 concurrent -> exactly 1 created, 1 row |
| A second intent on one transaction | `UNIQUE (transaction_id)` | refused by the database |
| A late or duplicate state report | transition table + `FOR UPDATE` | same-state report is a no-op; illegal move throws and changes nothing |

Every defence is a database constraint, not an application check, so all of them
hold under concurrency and across processes.

---

## F. Files

**Inspected:** `src/providers/` (all 5), `src/services/banking-service.js`,
`src/lib/banking-state.js`, `src/config/banking-flags.js`,
`src/config/deployment-safety.js`, both migration files, `src/db/schema.sql`,
all 41 route modules, `src/routes/admin.routes.js`, `admin/admin.js`,
`pwa/app.js`, `src/services/money-integrity-service.js`,
`test/provider-boundary.test.js`, `test/banking-integration.test.js`.

**Changed:**

| File | Change |
|---|---|
| `src/services/banking-service.js` | Environment allow-list replaces the fall-through; five-gate terminology |
| `src/lib/banking-state.js` | Per-state meanings, in prose and as `STATE_MEANINGS` |
| `src/config/banking-flags.js` | Five-gate terminology; the `absa_pay` example neutralised |
| `src/providers/banking-provider.js` | Five-gate terminology (comment) |
| `test/banking-safety-audit.test.js` | **New.** 49 tests |
| `test/banking-integration.test.js` | Unchanged |

No route, no schema, no migration and no production behaviour changed.

---

## G. Test results

| Suite | Result |
|---|---|
| Full API suite | **880 pass, 0 fail** (was 831) |
| `banking-safety-audit.test.js` | 49 pass |
| `banking-integration.test.js` | 39 pass |
| `provider-boundary.test.js` | 8 pass |
| Mutation battery | 7 mutations, 7 caught, 0 survivors |

---

## H2. Build 58: stored environment binding (the sixth gate)

Weakness 1 below is now closed. The change is recorded here because it altered
the gate count and the availability conjunction.

**The hazard.** TitoPay resolves integration credentials stored-config-first: a
`platform_settings.integration_*` row beats the environment variable. Every
environment check written before build 58 reads the VARIABLE. A sandbox
configuration restored or copied into a production database would therefore have
passed all of them, used sandbox credentials against real customers, and
reported nothing wrong, because from their point of view nothing was.

**The gate.** `configEnvironmentBound`. An adapter reads its own stored
configuration, runs it through `src/config/banking-config-contract.js`, and
returns the DECISION, never the configuration, so no credential crosses the
provider boundary. The declared environment must EQUAL the resolved
`BANKING_ENVIRONMENT`. The runtime pairing against `TITOPAY_ENV` remains a
separate gate; both must pass.

**Nothing is inferred.** Not from a URL, a hostname, a key format, a credential
name or a provider name. The contract reads one explicit `environment` field.
Tests assert that a configuration full of production URLs, `live_` client ids
and `sk_live_` secrets with no declaration still returns MISSING, and that the
contract module contains no URL parsing, no hostname inspection and no
key-prefix matching. A guess that happens to be right would teach everyone that
guessing works.

**Fail closed in six directions:** missing config, malformed config, missing
environment, unknown environment, ambiguous environment (a config that declares
two and disagrees with itself is never resolved in favour of either), and
mismatch. An adapter that omits `configEnvironment()` entirely, or throws while
reading its own configuration, is refused too, so the gate cannot be skipped by
omission.

**The seven required scenarios**, all proved against the real gate with
test-only fixtures that implement no operation and hold no credential:

| Scenario | Result |
|---|---|
| sandbox config + sandbox runtime | permitted |
| production config + production runtime | permitted |
| sandbox config + production runtime | **denied** (`STORED_ENVIRONMENT_MISMATCH`) |
| production config + sandbox runtime | **denied** (`STORED_ENVIRONMENT_MISMATCH`) |
| missing stored environment | **denied** (`STORED_ENVIRONMENT_MISSING`) |
| unknown stored environment | **denied** (`STORED_ENVIRONMENT_UNKNOWN`) |
| unknown runtime environment | **denied** |

**Mutation testing, ten mutations applied one at a time:**

| Mutation | Failures caught |
|---|---|
| Drop the implemented gate | 2 |
| Drop the configured gate | 2 |
| Drop the flag gate | 4 |
| Drop the runtime environment gate | 3 |
| Drop the stored-config gate | 9 |
| Drop the approval gate | 5 |
| Treat an unreadable declaration as bound | 2 |
| Contract infers environment from a URL | 2 |
| Ambiguity picks a winner | 2 |
| Binding accepts a mismatch | 1 |
| *(restored)* | **0** |

One mutation initially survived and was a real finding, though not a hole: a
`typeof bankingProvider.configEnvironment === "function"` guard was dead code,
because the module export always exists and an adapter that omits the method
makes the REGISTRY throw instead. Mutating dead code changes nothing, which is
how it was found. The guard is gone; every failure now takes the one throwing
path. Dead code around a safety check is worse than no code, because it reads
like a second defence that is not there.

---

## H. Remaining weaknesses and recommendations

1. ~~**The environment gate cannot see stored integration config.**~~ **CLOSED
   in build 58.** A sixth gate, `configEnvironmentBound`, now requires a
   provider's stored configuration to declare its own environment and refuses
   unless it EQUALS the running one. Nothing is inferred from a URL, hostname,
   key format, credential name or provider name; missing, unknown, ambiguous,
   unreadable and undeclared all refuse. See `banking-config-contract.js` and
   `test/banking-config-binding.test.js`.

2. **`pos_payment_intents.provider` and `pos_terminals.provider` still hard-code
   four bank names in `CHECK` constraints**, including ABSA. Pre-existing, out of
   scope by instruction, and not replicated by the new tables. **Recommendation:
   a separate migration, separately approved.**

3. **The approval record has no signature.** Anyone with database write access
   can insert one. It is one gate of SIX and the other five live outside the
   database, so this is not a single point of failure: database access alone
   cannot set a server environment variable, make an adapter exist, or make a
   stored configuration declare the environment that is running. It remains the
   weakest of the six. Now documented in `banking-service.js` with a five-point
   architectural TODO: attributable `approved_by`, an `approval_reference`
   pointing at a document outside the system, tamper evidence, attributable
   revocation, and a two-person rule for production. **Deliberately not
   redesigned while no provider exists**, because that would be designing
   against an imagined workflow.

4. **Nothing consumes the banking layer yet**, by design. The gates are proved
   by tests rather than by traffic. That remains true until Phase 4.

**Phase 4 stays blocked.** Still absent from this repository: Absa Pay
documentation of any kind (no OpenAPI specification has been supplied),
authentication requirements, sandbox credentials, callback and status
requirements, limits, reconciliation requirements, production onboarding
requirements, and written confirmation of the use cases TitoPay is approved for.

Every Absa capability remains at **NOT CONFIRMED**, the first of the five states
`NOT READY -> CONFIRMED -> SANDBOX READY -> INTEGRATION READY -> PRODUCTION
APPROVED`. None can advance without the evidence above.
