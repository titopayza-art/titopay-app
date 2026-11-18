<?php $h1 = 'How customers connect'; $meta = 'For developers'; $lead = 'Your server talks to one API. SeaGeek handles keys, limits, billing, routing to wholesale partners and the status updates that come back.'; $sharks = true; require APP_DIR . '/views/site/_pagehero.php'; ?>
<section class="section" style="padding-top:56px"><div class="wrap">
  <?php require APP_DIR . '/views/site/_integration.php'; ?>
  <div class="grid cols-2" style="margin-top:56px;align-items:start">
    <div>
      <h2>Five minutes to your first message</h2>
      <ul class="feature-list">
        <li><b>1. Create an account</b><span>Confirm your email and your sandbox key appears in the dashboard.</span></li>
        <li><b>2. Send a sandbox request</b><span>Use the code on the right or the "Try it" console in the dashboard. Nothing is sent or charged.</span></li>
        <li><b>3. Add a webhook URL</b><span>Receive delivered, read, inbound and result events, signed with your secret.</span></li>
        <li><b>4. Add credit and go live</b><span>Your live key switches on automatically when the payment clears. Change one line of config.</span></li>
      </ul>
      <div style="margin-top:20px;display:flex;gap:10px;flex-wrap:wrap"><a class="btn btn-primary" href="/register">Get a sandbox key</a><a class="btn btn-ghost" href="/docs">API reference</a></div>
    </div>
    <div class="code-window" data-tabs>
      <div class="code-head"><div class="tabs" role="tablist"><button class="tab" role="tab" data-lang="curl" aria-selected="true">cURL</button><button class="tab" role="tab" data-lang="php" aria-selected="false">PHP</button><button class="tab" role="tab" data-lang="node" aria-selected="false">Node.js</button></div><button class="copy-btn" type="button">Copy</button></div>
      <div class="code-body">
<pre data-lang="curl"><span class="tok-c"># Send an OTP, then check the code the user typed</span>
<span class="tok-f">curl</span> https://www.seageek.co.za/api/v1/auth/otp \
  -H <span class="tok-s">"Authorization: Bearer $SEAGEEK_KEY"</span> \
  -H <span class="tok-s">"Idempotency-Key: signup-7731"</span> \
  -d <span class="tok-s">'{"to":"+27821234567","channel":"sms","brand":"Acme"}'</span>

<span class="tok-f">curl</span> https://www.seageek.co.za/api/v1/auth/otp/otp_Vb7Kp2Wq9e/check \
  -H <span class="tok-s">"Authorization: Bearer $SEAGEEK_KEY"</span> \
  -d <span class="tok-s">'{"code":"482913"}'</span></pre>
<pre data-lang="php" hidden><span class="tok-k">function</span> <span class="tok-f">seageek</span>(<span class="tok-k">string</span> $path, <span class="tok-k">array</span> $body): <span class="tok-k">array</span> {
    $ch = <span class="tok-f">curl_init</span>(<span class="tok-s">'https://www.seageek.co.za/api/v1/'</span> . $path);
    <span class="tok-f">curl_setopt_array</span>($ch, [
        CURLOPT_RETURNTRANSFER => <span class="tok-k">true</span>,
        CURLOPT_HTTPHEADER => [<span class="tok-s">'Authorization: Bearer '</span> . <span class="tok-f">getenv</span>(<span class="tok-s">'SEAGEEK_KEY'</span>), <span class="tok-s">'Content-Type: application/json'</span>],
        CURLOPT_POSTFIELDS => <span class="tok-f">json_encode</span>($body),
    ]);
    <span class="tok-k">return</span> <span class="tok-f">json_decode</span>(<span class="tok-f">curl_exec</span>($ch), <span class="tok-k">true</span>);
}

$otp = <span class="tok-f">seageek</span>(<span class="tok-s">'auth/otp'</span>, [<span class="tok-s">'to'</span> => <span class="tok-s">'+27821234567'</span>, <span class="tok-s">'channel'</span> => <span class="tok-s">'sms'</span>]);
$check = <span class="tok-f">seageek</span>(<span class="tok-s">"auth/otp/{$otp['id']}/check"</span>, [<span class="tok-s">'code'</span> => $_POST[<span class="tok-s">'code'</span>]]);
<span class="tok-k">if</span> ($check[<span class="tok-s">'valid'</span>]) { <span class="tok-c">/* signed in */</span> }</pre>
<pre data-lang="node" hidden><span class="tok-k">const</span> api = (path, body) => <span class="tok-f">fetch</span>(<span class="tok-s">`https://www.seageek.co.za/api/v1/${path}`</span>, {
  method: <span class="tok-s">"POST"</span>,
  headers: { Authorization: <span class="tok-s">`Bearer ${process.env.SEAGEEK_KEY}`</span>, <span class="tok-s">"Content-Type"</span>: <span class="tok-s">"application/json"</span> },
  body: JSON.<span class="tok-f">stringify</span>(body),
}).<span class="tok-f">then</span>(r => r.<span class="tok-f">json</span>());

<span class="tok-k">const</span> otp = <span class="tok-k">await</span> <span class="tok-f">api</span>(<span class="tok-s">"auth/otp"</span>, { to: <span class="tok-s">"+27821234567"</span>, channel: <span class="tok-s">"sms"</span> });
<span class="tok-k">const</span> { valid } = <span class="tok-k">await</span> <span class="tok-f">api</span>(<span class="tok-s">`auth/otp/${otp.id}/check`</span>, { code: userInput });</pre>
      </div>
      <div class="code-foot"><span>Sandbox code is always 000000</span><span>JSON · TLS 1.2+</span></div>
    </div>
  </div>
</div></section>
