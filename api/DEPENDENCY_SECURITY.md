# Dependency advisories, and the one override that keeps `npm audit` at zero

`npm audit` on this package reports **0 vulnerabilities**, and that is meant to
stay true. This page exists because one of the four findings it used to report
could not be cleared by upgrading, and the thing that clears it is a line in
`package.json` that looks arbitrary if you do not know why it is there.

## The line

```json
"overrides": {
  "qs": "^6.16.0"
}
```

**Do not remove it, and do not "fix" it by matching Express's own range.**
Removing it puts two moderate advisories straight back.

## Why it is needed

Express 4.22.2 is the newest Express 4 there is, and it depends on `qs ~6.15.1`.
Two advisories are open against every `qs` below 6.16.0:

| Advisory | What it is |
|---|---|
| GHSA-x5fp-wj9c-mxmx | array-limit bypass via bracket-key comma parsing |
| GHSA-4mjr-xmp4-gh2g | denial of service via attacker-controlled `isBuffer` |

Express parses `req.query` with `qs`, so on a public API both are reachable from
any request carrying a query string. There is no version of Express 4 that
depends on a fixed `qs`, which leaves three options:

1. **Upgrade to Express 5.** A major version, on a live payments API, to fix two
   moderate parsing bugs. The cure is bigger than the disease.
2. **Accept the findings.** Reasonable, and what most projects do. Rejected here
   only because a clean audit is worth more than the ten minutes this took: a
   report with two permanent entries is a report nobody reads, and the next real
   advisory arrives into a list people have learned to ignore.
3. **Override `qs` to 6.16.0.** What this package does.

`qs` 6.16.0 is a minor release in the same major version Express asks for, so
the override crosses a range boundary but not an API one.

## What was checked before trusting it

The override was not taken on faith that "minor means compatible". Express was
started with the overridden `qs` and `req.query` was driven with the shapes this
API actually receives — plain values, repeated keys, bracket arrays, nested
`filter[from]` objects, percent-encoded UTF-8, empty values and bare flags.
Every one parsed identically. The full test suite passes.

If you upgrade Express to 5 one day, check whether it depends on a `qs` at or
above 6.16.0. If it does, delete the override, run `npm audit`, and delete this
page with it.

## The other three findings, and why they are gone

`nodemailer` was pinned up from 9.0.3 to ^9.1.1, which clears four advisories at
once. Two of them never applied to TitoPay: they concern `disableFileAccess`,
`disableUrlAccess` and a recipient domain allow-list, and this codebase uses
none of those. The two that did matter are address-parsing flaws where a crafted
recipient can send a message somewhere other than where it was addressed. This
platform emails one-time codes and statements, so where a message actually goes
is not a detail.

`body-parser` and `express` were only ever listed because they depend on `qs`.
Both clear once `qs` does.

## Keeping it at zero

`npm audit` is part of judging a release, not a chore to run afterwards. When it
reports something new:

- Read what the advisory actually describes before believing it applies. Two of
  the four here did not, and a bundled severity is the worst of the bundle, not
  the one you have.
- Prefer a version bump. Reach for an override only when no version of a direct
  dependency resolves it, and prove the override the way this one was proved.
- Never silence a finding with `--audit-level` or by deleting the entry. A
  suppressed advisory outlives everyone who knew why it was suppressed.
