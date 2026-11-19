<h2 id="format">Error format</h2>
<p>Every error has the same shape, with an HTTP status, a stable <code>type</code> you can code against, a message you can show or log, and a request ID.</p>
<pre class="snippet">HTTP/1.1 422 Unprocessable Entity
X-Request-Id: req_ZPZksQJyMrBW

{
  "error": { "type": "invalid_number", "message": "\"12\" is not a valid phone number. Use +27821234567." },
  "request_id": "req_ZPZksQJyMrBW"
}</pre>

<h2 id="retry">Which errors to retry</h2>
<table class="params">
  <tr><td><code>4xx</code></td><td class="muted">Fix the request first. Retrying the same request gives the same answer. Nothing was charged.</td></tr>
  <tr><td><code>429</code></td><td class="muted">Wait and retry. Respect the <code>Retry-After</code> header when present.</td></tr>
  <tr><td><code>5xx</code></td><td class="muted">Retry with the same <code>Idempotency-Key</code>, with a growing pause (1, 2, 4, 8 seconds). Failed sends are refunded automatically.</td></tr>
</table>

<h2 id="types">Every error type</h2>
<?php
$errors = [
    ['400', 'invalid_json', 'The body is not valid JSON.'], ['400', 'invalid_request', 'The request is missing something the endpoint needs.'], ['400', 'invalid_provider', 'AI: provider must be anthropic or openai.'], ['400', 'invalid_model', 'AI: that model is not offered. See GET /v1/ai/models.'],
    ['401', 'authentication_error', 'Missing, invalid or revoked API key.'],
    ['402', 'insufficient_balance', 'Not enough credit for this request. Add credit in the dashboard.'], ['402', 'account_locked', 'Live access is paused for an unpaid invoice.'],
    ['403', 'live_not_enabled', 'Live access switches on after your first payment.'], ['403', 'service_not_active', 'This product is not switched on for your account.'], ['403', 'kyb_required', 'Verify needs approved business verification for live checks.'], ['403', 'account_closed', 'The account is closed.'],
    ['404', 'not_found', 'No such endpoint, or no such object on your account.'], ['405', 'method_not_allowed', 'Wrong HTTP method for this path.'],
    ['422', 'missing_parameter', 'A required field is missing.'], ['422', 'invalid_parameter', 'A field has the wrong format or value.'], ['422', 'invalid_number', 'Not a valid phone number.'], ['422', 'invalid_email', 'Not a valid email address.'],
    ['422', 'too_many_recipients', 'Too many recipients in one request (1,000 SMS or 50 emails).'], ['422', 'body_too_long', 'SMS body over 1,530 characters.'], ['422', 'text_too_long', 'Voice or WhatsApp text over its limit.'], ['422', 'sender_not_approved', 'The SMS sender ID is not approved on your account.'],
    ['422', 'domain_not_verified', 'from_email must be on your verified domain.'], ['422', 'invalid_schedule', 'schedule_at must be within the next 30 days.'], ['422', 'invalid_channel', 'Auth: channel must be sms, email, whatsapp or voice.'], ['422', 'invalid_template', 'WhatsApp: the template is missing or not approved.'],
    ['422', 'invalid_category', 'WhatsApp: template category must be marketing, utility or authentication.'], ['422', 'outside_service_window', 'WhatsApp: free text is only allowed within 24 hours of the customer\'s last message.'], ['422', 'no_whatsapp_number', 'Connect a WhatsApp number first.'],
    ['422', 'invalid_type', 'The type field has an unknown value.'], ['422', 'invalid_id_number', 'Not a valid South African ID number. Not charged.'], ['422', 'invalid_company_reg', 'Company number must look like 2027/123456/07.'],
    ['422', 'invalid_messages', 'AI: messages must alternate user and assistant.'], ['422', 'invalid_recipient', 'Desk or Auth: recipient details are missing or wrong.'], ['422', 'invalid_requester', 'Desk: requester needs a name and email.'], ['422', 'invalid_status', 'Status must be one of the listed values.'],
    ['422', 'invalid_url', 'QR: the destination must start with https:// or http://.'], ['422', 'static_code', 'QR: static codes cannot change their destination.'],
    ['429', 'rate_limited', 'Too many requests for your plan. Slow down or upgrade.'], ['429', 'too_many_codes', 'Auth: too many codes sent to this recipient. Wait before sending another.'], ['429', 'ai_rate_limited', 'AI requests per minute reached for your plan.'], ['429', 'ai_cap_reached', 'This request could pass your monthly AI spending cap. Nothing was charged.'], ['429', 'provider_rate_limited', 'The AI provider asked us to slow down. Retry shortly.'],
    ['500', 'api_error', 'A problem on our side. Safe to retry with the same Idempotency-Key.'], ['502', 'provider_error', 'A network partner or AI provider returned an error.'], ['502', 'check_failed', 'Verify: the data source could not complete the check. Refunded.'],
    ['503', 'ai_not_configured', 'AI is not available on this platform right now.'], ['504', 'provider_unreachable', 'A partner did not answer in time. Safe to retry.'],
];
?>
<table class="params">
  <?php foreach ($errors as [$code, $type, $desc]): ?><tr><td><code><?= $code ?></code> <span class="type"><?= e($type) ?></span></td><td class="muted"><?= e($desc) ?></td></tr><?php endforeach; ?>
</table>
