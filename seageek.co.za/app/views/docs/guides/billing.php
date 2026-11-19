<h2 id="credit">One credit balance</h2>
<p>SeaGeek is prepaid. Every product draws from the same balance in rand, so one top-up covers SMS, email, WhatsApp, checks, AI, QR codes and store SMS. Check it with <code>GET /v1/balance</code>.</p>
<pre class="snippet">{ "balance": 15740, "credit_limit": 0, "currency": "ZAR", "ai_spent_this_month": 0, "ai_monthly_cap": 8000 }</pre>

<h2 id="services">Services</h2>
<p>Switch on the products you use under <b>Services</b>. Switching on is free. Live requests to a product that is not switched on return <code>403 service_not_active</code>; sandbox works for everything.</p>

<h2 id="pricing">What things cost</h2>
<table class="params">
  <?php foreach (DB::all('SELECT * FROM rates ORDER BY service, price') as $r): ?><tr><td><?= e($r['label']) ?></td><td class="mono"><?= zar($r['price'], $r['price'] < 1 ? 3 : 2) ?> <span class="muted"><?= e($r['per']) ?></span></td></tr><?php endforeach; ?>
</table>
<p class="muted small">Standard rates, excl. VAT. Business, Growth and Enterprise plans get 5 to 15% off every rate. AI prices are on the <a class="link" href="/docs/ai">AI page</a>.</p>

<h2 id="paying">Paying</h2>
<ul class="plain">
  <li><b>Card, Instant EFT, SnapScan or Zapper</b> through PayFast. Credit is added within a minute.</li>
  <li><b>Bank transfer (EFT)</b> with your <b>6-digit customer number</b> as the reference. We match it automatically within one working day. If the amount matches an unpaid invoice, that invoice is paid; anything else becomes credit.</li>
  <li><b>Packages</b> under Services add credit, and the larger ones add bonus credit.</li>
</ul>

<h2 id="documents">Invoices, statements and quotes</h2>
<p>Every payment has an invoice with line items. A monthly statement shows every credit and charge with opening and closing balances. You can build a quote for your expected volumes at <a class="link" href="/quote">seageek.co.za/quote</a>; accepting it switches on the services and raises one invoice.</p>

<h2 id="automation">If an invoice is not paid</h2>
<p>Plan invoices are due 7 days after issue. We send reminders on the due date and 3 and 6 days later. After 7 days overdue, live access pauses (sandbox keeps working) and comes back by itself as soon as the payment clears.</p>
