<h2 id="why">Why it matters</h2>
<p>Networks drop connections. If your request times out you cannot tell whether we received it. Retrying without protection could send a message twice and charge twice.</p>

<h2 id="how">How to use it</h2>
<p>Add an <code>Idempotency-Key</code> header to any POST. Use a value that is unique to the action, such as your order ID plus the message type.</p>
<pre class="snippet">curl -X POST https://www.seageek.co.za/api/v1/sms/messages \
  -H "Authorization: Bearer $SEAGEEK_KEY" \
  -H "Idempotency-Key: order-1042-shipped" \
  -H "Content-Type: application/json" \
  -d '{"to": "0821234567", "body": "Your order has shipped"}'</pre>
<ul class="plain">
  <li>If we have seen the key before on your account, we return the first response again with the header <code>Idempotent-Replayed: true</code>. Nothing is sent or charged twice.</li>
  <li>Keys are kept for 24 hours and can be up to 120 characters.</li>
  <li>Responses with a 5xx status are not stored, so a retry after a server error runs again.</li>
  <li>GET requests never change anything and do not need a key.</li>
</ul>
