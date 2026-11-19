<h2 id="keys">API keys</h2>
<p>Every request carries one key. The prefix tells you which environment it uses:</p>
<table class="params">
  <tr><td><code>sg_test_...</code></td><td class="muted">Sandbox. Free, nothing is really sent or charged, results are simulated. Works for every product before you switch it on.</td></tr>
  <tr><td><code>sg_live_...</code></td><td class="muted">Live. Sends for real through our network partners and is charged from your credit. Only works for products switched on under Services.</td></tr>
</table>
<p>Create, name and revoke keys under <b>API keys</b> in the dashboard. A key is shown once when it is created; we keep only a hash, so we cannot show it again. If you lose it, create a new one and revoke the old one.</p>

<h2 id="header">Sending the key</h2>
<p>Put the key in the <code>Authorization</code> header with the word <code>Bearer</code>. Requests must use HTTPS.</p>
<pre class="snippet">Authorization: Bearer sg_live_6sFq...</pre>
<p>A missing, mistyped or revoked key returns <code>401 authentication_error</code>.</p>

<h2 id="safety">Keeping keys safe</h2>
<ul class="plain">
  <li>Call SeaGeek from your server only. Never put a key in a mobile app, browser JavaScript or a public repository.</li>
  <li>Store keys in environment variables or a secrets manager, not in code.</li>
  <li>Use one key per system, so you can revoke one without touching the others.</li>
  <li>Revoke a key straight away if it may have leaked. Revoking takes effect on the next request.</li>
  <li>Give teammates their own logins under <b>Settings and team</b> instead of sharing passwords.</li>
</ul>

<h2 id="live-access">Live access rules</h2>
<table class="params">
  <tr><td><code>403 live_not_enabled</code></td><td class="muted">Live switches on after your first payment, with a confirmed email and company phone number.</td></tr>
  <tr><td><code>403 service_not_active</code></td><td class="muted">The product is not switched on for your account. Switch it on under Services. Sandbox keys are not affected.</td></tr>
  <tr><td><code>402 account_locked</code></td><td class="muted">A plan invoice is more than 7 days overdue. Paying it unlocks live access automatically.</td></tr>
</table>
