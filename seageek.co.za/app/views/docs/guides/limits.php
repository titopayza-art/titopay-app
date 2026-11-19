<h2 id="plans">Limits by plan</h2>
<p>Limits protect your account and our partners. Your current limits are in <code>GET /v1/account</code>.</p>
<table class="params">
  <tr><td><b>Plan</b></td><td><b>Requests a second</b></td><td><b>AI requests a minute</b></td><td><b>Longest AI reply</b></td><td><b>AI cap a month</b></td></tr>
  <?php foreach (DB::all('SELECT * FROM plans WHERE active = 1 ORDER BY sort') as $p): ?>
    <tr><td><?= e($p['name']) ?></td><td class="mono"><?= (int) $p['api_rps'] ?></td><td class="mono"><?= (int) $p['ai_rpm'] ?></td><td class="mono"><?= number_format((int) $p['ai_max_tokens']) ?> tokens</td><td class="mono"><?= zar($p['ai_monthly_cap'], 0) ?></td></tr>
  <?php endforeach; ?>
</table>

<h2 id="how">How limits behave</h2>
<ul class="plain">
  <li>Request rates are averaged over a minute, so short bursts are fine.</li>
  <li>Over the limit you get <code>429 rate_limited</code> with a <code>Retry-After</code> header in seconds.</li>
  <li>The AI spending cap is checked before each AI request using the most it could cost. If it could pass the cap you get <code>429 ai_cap_reached</code> and nothing is charged.</li>
  <li>You can set a lower AI cap yourself on the AI page of the dashboard.</li>
  <li>Per request: up to 1,000 SMS recipients, 50 email recipients, and 1,530 characters (10 SMS parts).</li>
</ul>
