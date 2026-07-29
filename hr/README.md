# TitoPay HR portal — deployable bundle

These five files are the HR console exactly as it is served from
`hr.titopay.co.za`. They are the contents of `hr.zip`, unpacked.

| File | Role |
| --- | --- |
| `index.html` | Compiled React bundle with two inlined `<style>` blocks |
| `hr-session.js` | Token refresh / session shim, loaded after the bundle |
| `titopay-logo.png` | Official wordmark |
| `favicon.ico` | Tab icon |
| `.htaccess` | SPA rewrite + no-cache headers |

## What is editable here

`index.html` is a production Vite build — the React source is not in this
repository, and the bundle is minified onto a handful of very long lines. The
only maintainable surface is the CSS:

- **Line 1** ends with a `<style>` block holding the pre-render shell: the
  markup the browser paints before React mounts, plus `.runtime-error`. Its
  values are hard-coded so it still renders if the main sheet never arrives.
- **Lines 2 – 2276** are the console stylesheet: a token-driven design system
  organised into numbered sections, consumed by the class names the compiled
  bundle emits.
- **Line 2277 to EOF** is the compiled bundle and body markup. Do not edit it
  by hand. Any front-end change that cannot be expressed in CSS needs a
  rebuild from the HR portal's own source repository.

## Working on the stylesheet

Every rule consumes tokens from `:root` — colour, type scale, spacing, radius,
elevation. Change a token, not a component rule, when adjusting the system as a
whole. The legacy aliases at the end of the token block (`--blue`, `--border`,
`--muted`, …) are still referenced by older rules and must stay mapped.

Class names are dictated by the compiled bundle, so a selector cannot be
renamed or removed without breaking the element it styles. If a rule looks
dead, it is probably still being emitted by React.

## Rebuilding hr.zip

The archive is a flat zip of these five files, no wrapping directory:

```sh
cd hr
zip -X ../hr.zip hr-session.js titopay-logo.png favicon.ico index.html .htaccess
```

`*.zip` is git-ignored, so the archive is built on demand rather than tracked.

## Known issue, not fixable in CSS

`.donut` on the dashboard draws its ring from a fixed `conic-gradient`
(82% / 93% / 97%), while the figure in its centre and the legend beside it come
from live attendance data. The ring therefore does not move when the data does.
Correcting it needs a one-line change in the React source to pass the real
split in as a custom property; it cannot be done from the stylesheet.
