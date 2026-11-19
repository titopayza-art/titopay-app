<ol class="docs-steps">
  <li id="account"><h2>Create your account</h2>
    <p><a class="link" href="/register">Sign up</a> with your work email and confirm it. Your <b>sandbox key</b> (it starts with <code>sg_test_</code>) is shown once on the dashboard. Copy it somewhere safe. You can make more keys any time under <b>API keys</b>.</p></li>
  <li id="first-request"><h2>Send your first SMS</h2>
    <p>Sandbox requests are free and nothing is really sent, but you get real responses, IDs and status changes.</p>
    <?php $codeTabs = [
      'cURL' => "curl -X POST https://www.seageek.co.za/api/v1/sms/messages \\\n  -H \"Authorization: Bearer \$SEAGEEK_KEY\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{\"to\": \"0821234567\", \"body\": \"Hello from SeaGeek\"}'",
      'PHP' => "\$ch = curl_init('https://www.seageek.co.za/api/v1/sms/messages');\ncurl_setopt_array(\$ch, [\n    CURLOPT_RETURNTRANSFER => true,\n    CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . getenv('SEAGEEK_KEY'), 'Content-Type: application/json'],\n    CURLOPT_POSTFIELDS => json_encode(['to' => '0821234567', 'body' => 'Hello from SeaGeek']),\n]);\n\$result = json_decode(curl_exec(\$ch), true);\necho \$result['data'][0]['id'];",
      'Node.js' => "const res = await fetch(\"https://www.seageek.co.za/api/v1/sms/messages\", {\n  method: \"POST\",\n  headers: {\n    Authorization: `Bearer \${process.env.SEAGEEK_KEY}`,\n    \"Content-Type\": \"application/json\",\n  },\n  body: JSON.stringify({ to: \"0821234567\", body: \"Hello from SeaGeek\" }),\n});\nconst { data } = await res.json();\nconsole.log(data[0].id);",
      'Python' => "import os, requests\n\nres = requests.post(\n    \"https://www.seageek.co.za/api/v1/sms/messages\",\n    headers={\"Authorization\": f\"Bearer {os.environ['SEAGEEK_KEY']}\"},\n    json={\"to\": \"0821234567\", \"body\": \"Hello from SeaGeek\"},\n)\nprint(res.json()[\"data\"][0][\"id\"])",
    ]; require __DIR__ . '/../_code.php'; ?>
    <p class="snippet-label">Response (202 Accepted)</p>
    <pre class="snippet">{
  "data": [
    { "id": "msg_8Kq2vXr1Pz", "to": "+27821234567", "status": "sent", "segments": 1, "amount": 0 }
  ],
  "total_amount": 0,
  "currency": "ZAR"
}</pre></li>
  <li id="status"><h2>Check what happened</h2>
    <p>Fetch the message, or let us tell you with a <a class="link" href="/docs/webhooks">webhook</a>. In sandbox the status moves to <code>delivered</code> after a few seconds. Numbers ending in <code>0000</code> fail on purpose so you can test errors.</p>
    <pre class="snippet">curl https://www.seageek.co.za/api/v1/sms/messages/msg_8Kq2vXr1Pz \
  -H "Authorization: Bearer $SEAGEEK_KEY"</pre></li>
  <li id="services"><h2>Switch on the services you need</h2>
    <p>Open <b>Services</b> in the dashboard and tick every product you will use. Switching on is free; you pay per use from one credit balance. Some products need one more step before live traffic, such as business verification for Verify or a WhatsApp number. Each product page lists its requirements.</p></li>
  <li id="live"><h2>Go live</h2>
    <p>Add your company phone number and make your first payment (card, Instant EFT or bank transfer with your 6-digit customer number as reference). Live access switches on automatically and a <b>live key</b> (<code>sg_live_</code>) appears once on your dashboard. Swap it in for the sandbox key. That is the only change in your code.</p></li>
</ol>
<div class="callout"><b>Next:</b> read <a class="link" href="/docs/errors">Errors</a> and <a class="link" href="/docs/idempotency">Idempotency</a> before you ship, so retries never send twice.</div>
