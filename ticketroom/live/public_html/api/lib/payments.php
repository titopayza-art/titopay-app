<?php
// Card payments, refunds, organiser payouts and the money ledger.
//
// The rule everything here follows: money is only ever "in" when the payment
// provider says so, through a signed notification (webhook / ITN) or a direct
// status check from this server. The buyer's browser coming back from the
// payment page proves nothing and changes nothing.
//
// Providers (chosen and set up in Admin portal → Integrations):
//   Sandbox TicketRoom's own practice payment page: no provider account,
//           nothing real. Always test mode.
//   Yoco    Checkout API: hosted payment page, signed webhooks, refunds by API.
//   PayFast hosted form + ITN; refunds are done in the PayFast dashboard and
//           recorded here ("manual"), because PayFast's refund API needs a
//           separate approval from PayFast.
//
// Every confirmed payment, completed refund and paid payout is written to an
// append-only double-entry ledger in the same transaction, so the books
// always balance and every rand is accounted for.
//
// Test mode (the sandbox, Yoco test keys, PayFast's sandbox) is a separate
// world: its orders are test orders, their tickets never open a gate, and
// their money is booked to "test:" ledger accounts that never reach an
// organiser's balance, a payout or the sales figures.
declare(strict_types=1);

// ============================================================== settings
function pay_provider(): string
{
    $p = (string) cfg('payments.provider', 'none');
    return in_array($p, ['sandbox', 'yoco', 'payfast', 'peach'], true) ? $p : 'none';
}
// PayFast's shared test account (published by PayFast): it can never take real money.
const PAYFAST_SANDBOX_MERCHANT = '10000100';
// The sandbox is never live, and neither is PayFast's shared test account,
// whatever the Mode switch says: its payments are test money.
function pay_mode(): string
{
    $p = pay_provider();
    if ($p === 'sandbox' || cfg('payments.mode', 'test') !== 'live') return 'test';
    if ($p === 'payfast' && (string) cfg('payments.payfastMerchantId', '') === PAYFAST_SANDBOX_MERCHANT) return 'test';
    return 'live';
}
function pay_test(): bool { return pay_mode() !== 'live'; }
// Paid tickets can be sold once a provider is fully set up.
function pay_ready(): bool
{
    return match (pay_provider()) {
        'sandbox' => true,
        'yoco' => yoco_mode_ready(pay_mode()),
        'payfast' => (string) cfg('payments.payfastMerchantId', '') !== '' && (string) cfg('payments.payfastMerchantKey', '') !== '',
        'peach' => peach_checkout_ready(pay_mode()),
        default => false,
    };
}
function yoco_base(): string { return rtrim((string) cfg('payments.yocoApiBase', 'https://payments.yoco.com'), '/'); }
// The Yoco secret key for one mode. Test and live keys are kept separately, and a
// key is only ever used for its own mode (sk_test_ for test, sk_live_ for live), so
// a test payment can never be booked as real money. The older single "Yoco secret
// key" setting still works for whichever mode its prefix matches.
function yoco_key(?string $mode = null): string
{
    $mode = $mode === 'live' ? 'live' : ($mode === 'test' ? 'test' : pay_mode());
    $k = (string) cfg('payments.yoco' . ucfirst($mode) . 'SecretKey', '');
    if ($k === '') { $old = (string) cfg('payments.yocoSecretKey', ''); if (str_starts_with($old, "sk_{$mode}_")) $k = $old; }
    return str_starts_with($k, "sk_{$mode}_") ? $k : '';
}
function yoco_webhook_secret(string $mode): string
{
    $w = (string) cfg('payments.yoco' . ucfirst($mode) . 'WebhookSecret', '');
    if ($w === '' && str_starts_with((string) cfg('payments.yocoSecretKey', ''), "sk_{$mode}_")) $w = (string) cfg('payments.yocoWebhookSecret', '');
    return $w;
}
function yoco_mode_ready(string $mode): bool { return yoco_key($mode) !== '' && yoco_webhook_secret($mode) !== ''; }
// Yoco's own error text, for logs and the admin (never containing a key).
function yoco_problem(array $r): string
{
    $d = $r['json']['description'] ?? $r['json']['message'] ?? $r['json']['errorMessage'] ?? $r['json']['displayMessage'] ?? null;
    return 'HTTP ' . $r['status'] . (is_string($d) && $d !== '' ? ': ' . substr($d, 0, 160) : '');
}
// Live money only ever goes to PayFast's live host. The address override in
// the config file is for testing, so it only applies in test mode.
function payfast_host(): string
{
    if (pay_mode() === 'live') return 'https://www.payfast.co.za';
    $override = (string) cfg('payments.payfastBase', '');
    if ($override !== '') return rtrim($override, '/');
    return pay_mode() === 'live' ? 'https://www.payfast.co.za' : 'https://sandbox.payfast.co.za';
}
function pay_error(string $code, string $message): AppError { return new AppError(502, $code, $message); }

// Peach Orchestration Hosted Checkout. Credentials are environment-specific;
// payment intents never contain card data and redirects are accepted only to
// Peach-owned HTTPS hosts. The browser return is never treated as proof of pay.
function peach_checkout_ready(string $environment): bool
{
    $prefix = $environment === 'live' ? 'peachLive' : 'peachTest';
    $webhook = $environment === 'live' ? 'peachLiveWebhookSecret' : 'peachTestWebhookSecret';
    return (string) cfg("payments.{$prefix}ProfileId", '') !== '' && (string) cfg("payments.{$prefix}ApiKey", '') !== '' && (string) cfg("payments.{$webhook}", '') !== '';
}
function peach_api_base(string $environment): string
{
    return $environment === 'live' ? 'https://app.next.peachpayments.com/api' : 'https://app.sandbox-next.peachpayments.com/api';
}
function peach_checkout_api(string $method, string $path, string $environment, ?array $json = null): array
{
    $prefix = $environment === 'live' ? 'peachLive' : 'peachTest';
    $headers = ['api-key' => (string) cfg("payments.{$prefix}ApiKey"), 'Accept' => 'application/json'];
    if ($json !== null) $headers['Content-Type'] = 'application/json';
    $res = http_request($method, peach_api_base($environment) . $path, $headers, $json === null ? null : json_encode($json, JSON_UNESCAPED_SLASHES), 20);
    if ($res['status'] >= 300) throw pay_error('peach_refused', 'Peach Payments could not complete the request (HTTP ' . $res['status'] . ').');
    return $res;
}
function peach_checkout(array $payment, array $order, string $returnUrl): array
{
    $environment = (string) ($payment['environment'] ?? pay_mode());
    $prefix = $environment === 'live' ? 'peachLive' : 'peachTest';
    if (!peach_checkout_ready($environment)) throw new RuntimeException('Peach ' . ($environment === 'live' ? 'production' : 'sandbox') . ' Checkout credentials are incomplete.');
    $res = peach_checkout_api('POST', '/payments', $environment, [
        'profile_id' => (string) cfg("payments.{$prefix}ProfileId"),
        'amount' => (int) $payment['amount_cents'], 'currency' => 'ZAR', 'capture_method' => 'automatic',
        'confirm' => false, 'payment_link' => true,
        'description' => substr((string) ($order['item_name'] ?? ('TicketRoom ' . ($order['reference'] ?? 'payment'))), 0, 180),
        'return_url' => $returnUrl,
        'metadata' => ['ticketroom_payment_id' => (string) $payment['id'], 'ticketroom_reference' => (string) ($order['reference'] ?? '')],
    ]);
    $j = $res['json'] ?? [];
    $id = (string) ($j['id'] ?? $j['payment_id'] ?? '');
    $url = (string) ($j['payment_link']['url'] ?? $j['payment_link_url'] ?? $j['next_action']['redirect_to_url'] ?? '');
    $host = strtolower((string) parse_url($url, PHP_URL_HOST));
    if ($id === '' || !str_starts_with($url, 'https://') || !($host === 'peachpayments.com' || str_ends_with($host, '.peachpayments.com'))) {
        throw pay_error('peach_invalid_response', 'Peach Payments returned an invalid hosted checkout response.');
    }
    return ['paymentId' => $id, 'redirectUrl' => $url];
}
function peach_payment_status(array $p): array
{
    if (empty($p['provider_payment_id'])) return ['status' => 'unknown'];
    try { $r = peach_checkout_api('GET', '/payments/' . rawurlencode((string) $p['provider_payment_id']), (string) $p['environment']); }
    catch (Throwable $e) { return ['status' => 'unknown']; }
    $j = $r['json'] ?? [];
    $status = strtolower((string) ($j['status'] ?? ''));
    return ['status' => $status === 'succeeded' ? 'paid' : (in_array($status, ['failed', 'canceled', 'cancelled'], true) ? ($status === 'failed' ? 'failed' : 'cancelled') : 'pending'),
        'amountCents' => (int) ($j['amount'] ?? 0)];
}

// Peach Payouts is a separate product with separate credentials and mode.
// The sandbox is connection-check-only here: it must never settle a real
// organiser liability or write a production payout to the ledger.
function peach_payout_environment(): string { return cfg('payouts.payoutMode', 'sandbox') === 'live' ? 'live' : 'sandbox'; }
function peach_payout_ready(string $environment): bool
{
    $p = $environment === 'live' ? 'peachPayoutLive' : 'peachPayoutTest';
    return (string) cfg("payouts.{$p}ClientId", '') !== '' && (string) cfg("payouts.{$p}ClientSecret", '') !== '' && (string) cfg("payouts.{$p}MerchantId", '') !== '';
}
function peach_payout_auth_base(string $environment): string { return $environment === 'live' ? 'https://dashboard.peachpayments.com' : 'https://sandbox-dashboard.peachpayments.com'; }
function peach_payout_api_base(string $environment): string { return $environment === 'live' ? 'https://payouts.peachpayments.com' : 'https://sandbox-payouts.peachpayments.com'; }
function peach_payout_token(string $environment): string
{
    if (!peach_payout_ready($environment)) throw new RuntimeException('Peach ' . ($environment === 'live' ? 'production' : 'sandbox') . ' Payouts credentials are incomplete.');
    $p = $environment === 'live' ? 'peachPayoutLive' : 'peachPayoutTest';
    $r = http_request('POST', peach_payout_auth_base($environment) . '/api/oauth/token', ['Content-Type' => 'application/json', 'Accept' => 'application/json'], json_encode([
        'clientId' => cfg("payouts.{$p}ClientId"), 'clientSecret' => cfg("payouts.{$p}ClientSecret"), 'merchantId' => cfg("payouts.{$p}MerchantId"),
    ], JSON_UNESCAPED_SLASHES), 20);
    if ($r['status'] !== 200 || empty($r['json']['access_token'])) throw pay_error('peach_payout_auth', 'Peach Payouts did not accept these credentials (HTTP ' . $r['status'] . ').');
    return (string) $r['json']['access_token'];
}
function peach_payout_call(string $method, string $path, string $environment, ?array $json = null): array
{
    $token = peach_payout_token($environment);
    $headers = ['Authorization' => 'Bearer ' . $token, 'Accept' => 'application/json'];
    if ($json !== null) $headers['Content-Type'] = 'application/json';
    return http_request($method, peach_payout_api_base($environment) . $path, $headers, $json === null ? null : json_encode($json, JSON_UNESCAPED_SLASHES), 25);
}
function peach_payout_bank(string $bank): ?array
{
    return match (strtolower(trim($bank))) {
        'absa' => ['ABSA', '632005'],
        'african bank' => ['AFRICAN BANK', '430000'],
        'discovery bank' => ['DISCOVERY BANK', '679000'],
        'fnb' => ['FNB', '250655'],
        'investec' => ['INVESTEC', '580105'],
        'nedbank' => ['NEDBANK', '198765'],
        'standard bank' => ['STANDARD BANK', '051001'],
        'tymebank' => ['TYMEBANK', '678910'],
        default => null,
    };
}
function peach_payout_create(array $po, string $accountNumber, string $payoutAttemptId, string $environment): array
{
    $env = $environment === 'live' ? 'live' : 'sandbox';
    $bank = peach_payout_bank((string) $po['bank_name']);
    if (!$bank) throw bad('This bank is not yet supported for Peach automated payouts. Use the existing manual EFT process.');
    if ((int) $po['amount_cents'] < 1000) throw bad('Peach payouts have a R10 minimum. Use manual EFT for smaller amounts.');
    $holder = trim((string) $po['bank_account_holder']);
    if (strlen($holder) > 50 || !preg_match('/^[a-zA-Z0-9](?:[ .-](?![ .-])|[a-zA-Z0-9]){0,48}[a-zA-Z0-9]$/', $holder)) throw bad('The account holder name does not meet Peach Payments requirements. Update the organiser’s verified bank details or use manual EFT.');
    if (strtolower($po['bank_name']) === 'tymebank' && str_starts_with($accountNumber, '53')) throw bad('Peach cannot pay TymeBank SME accounts beginning with 53. Use manual EFT.');
    $prefix = $env === 'live' ? 'peachPayoutLive' : 'peachPayoutTest';
    $merchantId = (string) cfg("payouts.{$prefix}MerchantId", '');
    $payload = ['payouts' => [[
        'payoutId' => $payoutAttemptId, 'currency' => 'ZAR', 'amount' => (int) $po['amount_cents'],
        'accountNumber' => $accountNumber, 'branchCode' => $bank[1], 'bankName' => $bank[0],
        'accountHolder' => $holder, 'reference' => substr(preg_replace('/[^A-Za-z0-9 ]/', '', (string) $po['reference']), 0, 20),
        'merchantReference' => substr(preg_replace('/[^A-Za-z0-9 ]/', '', (string) $po['reference']), 0, 20), 'payoutMethod' => 'realtime-eft',
    ]]];
    $r = peach_payout_call('POST', '/api/merchants/' . rawurlencode($merchantId) . '/payouts', $env, $payload);
    if ($r['status'] !== 201) throw pay_error('peach_payout_refused', 'Peach Payments did not accept the payout (HTTP ' . $r['status'] . ').');
    $items = $r['json']['payouts'] ?? [];
    $first = $items[0] ?? [];
    if (($first['payoutId'] ?? '') !== $payoutAttemptId) throw pay_error('peach_payout_invalid_response', 'Peach returned a payout response that did not match this transfer. Check Peach before retrying.');
    return ['requestId' => (string) ($r['json']['payoutRequestId'] ?? ''), 'status' => strtolower((string) ($first['status'] ?? 'pending')), 'lastUpdated' => $first['lastUpdated'] ?? null];
}
function peach_payout_status_by_id(string $payoutId, string $environment): array
{
    $env = $environment === 'live' ? 'live' : 'sandbox';
    $prefix = $env === 'live' ? 'peachPayoutLive' : 'peachPayoutTest';
    $merchantId = (string) cfg("payouts.{$prefix}MerchantId", '');
    $r = peach_payout_call('GET', '/api/merchants/' . rawurlencode($merchantId) . '/payouts/status?payoutId=' . rawurlencode($payoutId), $env);
    if ($r['status'] === 404) return ['found' => false];
    if ($r['status'] !== 200) throw pay_error('peach_payout_status', 'Peach could not confirm payout status (HTTP ' . $r['status'] . ').');
    foreach (($r['json']['payouts'] ?? []) as $request) foreach (($request['payouts'] ?? []) as $item) {
        if (($item['payoutId'] ?? '') === $payoutId) return ['found' => true, 'requestId' => $request['payoutRequestId'] ?? null, 'status' => strtolower((string) ($item['status'] ?? 'pending')), 'lastUpdated' => $item['lastUpdated'] ?? null];
    }
    return ['found' => false];
}
function peach_payout_verify_webhook(string $raw, array $headers, string $secret): array
{
    $id = (string) ($headers['webhook-id'] ?? '');
    $timestamp = (int) ($headers['webhook-timestamp'] ?? 0);
    $signatures = (string) ($headers['webhook-signature'] ?? '');
    if ($id === '' || !$timestamp || abs(time() - $timestamp) > 300 || $signatures === '') throw bad('Missing, expired or invalid Peach payout webhook signature.');
    $key = base64_decode(preg_replace('/^whsec_/', '', $secret), true);
    if (!$key) throw bad('Peach payout webhook signing secret is invalid.');
    $expected = base64_encode(hash_hmac('sha256', $id . '.' . $timestamp . '.' . $raw, $key, true));
    $valid = false;
    foreach (preg_split('/\s+/', trim($signatures)) as $sig) {
        [$version, $value] = array_pad(explode(',', $sig, 2), 2, '');
        if ($version === 'v1' && $value !== '' && hash_equals($expected, $value)) $valid = true;
    }
    if (!$valid) throw bad('Peach payout webhook signature does not match.');
    $payload = json_decode($raw, true);
    if (!is_array($payload)) { parse_str($raw, $payload); }
    return ['id' => $id, 'payload' => $payload];
}

// ============================================================== Yoco
function yoco_call(string $method, string $path, ?array $json = null, ?string $idem = null, ?string $mode = null): array
{
    $key = yoco_key($mode);
    if ($key === '') throw pay_error('provider_not_configured', 'No Yoco ' . ($mode ?? pay_mode()) . ' secret key is saved (Admin portal → Integrations).');
    $headers = ['Authorization' => 'Bearer ' . $key, 'Accept' => 'application/json'];
    if ($json !== null) $headers['Content-Type'] = 'application/json';
    if ($idem) $headers['Idempotency-Key'] = $idem;
    return http_request($method, yoco_base() . $path, $headers, $json === null ? null : json_encode($json, JSON_UNESCAPED_SLASHES));
}
function yoco_checkout(array $payment, array $order, string $returnUrl, string $cancelUrl): array
{
    $r = yoco_call('POST', '/api/checkouts', ['amount' => (int) $payment['amount_cents'], 'currency' => 'ZAR', 'successUrl' => $returnUrl, 'cancelUrl' => $cancelUrl, 'failureUrl' => $returnUrl,
        'metadata' => ['ticketroomPaymentId' => $payment['id'], 'orderReference' => $order['reference']]], $payment['id'], (string) $payment['environment']);
    if ($r['status'] >= 300 || empty($r['json']['id']) || empty($r['json']['redirectUrl'])) throw pay_error('provider_refused', 'Yoco did not open a payment page (' . yoco_problem($r) . ').');
    // Yoco says which world the checkout lives in; it must be the one this payment is booked in.
    if (isset($r['json']['processingMode']) && $r['json']['processingMode'] !== $payment['environment']) throw pay_error('provider_refused', "Yoco opened a {$r['json']['processingMode']} checkout for a {$payment['environment']} payment. Check the keys under Integrations.");
    return ['reference' => $r['json']['id'], 'redirectUrl' => $r['json']['redirectUrl']];
}
const YOCO_STATUS = ['completed' => 'paid', 'succeeded' => 'paid', 'failed' => 'failed', 'cancelled' => 'cancelled', 'expired' => 'cancelled'];
function yoco_status(string $checkoutId, ?string $mode = null): array
{
    $r = yoco_call('GET', '/api/checkouts/' . rawurlencode($checkoutId), null, null, $mode);
    if ($r['status'] !== 200) return ['status' => 'unknown'];
    $status = YOCO_STATUS[$r['json']['status'] ?? ''] ?? 'pending';
    // Only a completed checkout in rand, in the payment's own mode, counts as paid.
    if ($status === 'paid' && (($r['json']['currency'] ?? 'ZAR') !== 'ZAR' || ($mode !== null && isset($r['json']['processingMode']) && $r['json']['processingMode'] !== $mode))) $status = 'unknown';
    return ['status' => $status, 'amountCents' => (int) ($r['json']['amount'] ?? 0)];
}
// Standard Webhooks signature: base64 HMAC-SHA256 over "id.timestamp.body",
// keyed with the base64 secret after "whsec_". Old or replayed messages fail.
function yoco_verify(string $raw, array $h): array
{
    $id = $h['webhook-id'] ?? ''; $ts = (int) ($h['webhook-timestamp'] ?? 0); $sigs = (string) ($h['webhook-signature'] ?? '');
    if ($id === '' || !$ts || $sigs === '') throw bad('Missing webhook signature.');
    if (abs(time() - $ts) > 300) throw bad('Webhook timestamp too old.');
    // Test and live each have their own notification secret; either may sign.
    $ok = false; $signedBy = null; $any = false;
    foreach (['test', 'live'] as $mode) {
        $secret = base64_decode(preg_replace('/^whsec_/', '', yoco_webhook_secret($mode)), true);
        if (!$secret) continue;
        $any = true;
        $expected = base64_encode(hash_hmac('sha256', "$id.$ts.$raw", $secret, true));
        foreach (explode(' ', $sigs) as $part) { $sig = explode(',', $part, 2)[1] ?? ''; if ($sig !== '' && hash_equals($expected, $sig)) { $ok = true; $signedBy = $mode; } }
        if ($ok) break;
    }
    if (!$any) throw bad('Webhook secret not set.');
    if (!$ok) throw bad('Webhook signature does not match.');
    $b = json_decode($raw, true) ?: [];
    $p = $b['payload'] ?? [];
    $type = (string) ($b['type'] ?? '');
    $mode = in_array($p['mode'] ?? null, ['test', 'live'], true) ? $p['mode'] : $signedBy;
    if ($mode !== $signedBy || (($p['currency'] ?? 'ZAR') !== 'ZAR')) return ['id' => (string) ($b['id'] ?? $id), 'outcome' => null, 'reference' => '', 'amountCents' => 0, 'mode' => $mode];
    $evt = ['id' => (string) ($b['id'] ?? $id), 'outcome' => $type === 'payment.succeeded' ? 'paid' : ($type === 'payment.failed' ? 'failed' : null),
        'reference' => (string) ($p['metadata']['checkoutId'] ?? ''), 'amountCents' => (int) ($p['amount'] ?? 0), 'mode' => $mode];
    // A refund, made here or in the Yoco portal: Yoco names the checkout it belongs to.
    if ($type === 'refund.succeeded') $evt['refund'] = ['id' => (string) ($p['refundId'] ?? $p['id'] ?? ''), 'amountCents' => (int) ($p['amount'] ?? 0)];
    return $evt;
}
function yoco_refund(array $payment, int $cents, string $idem): string
{
    $r = yoco_call('POST', '/api/checkouts/' . rawurlencode((string) $payment['provider_reference']) . '/refund', ['amount' => $cents], $idem, (string) ($payment['environment'] ?? pay_mode()));
    if ($r['status'] >= 300) throw pay_error('provider_refused', 'Yoco refused the refund: ' . substr((string) ($r['json']['description'] ?? $r['json']['message'] ?? "HTTP {$r['status']}"), 0, 160));
    return (string) ($r['json']['refundId'] ?? $r['json']['id'] ?? $idem);
}
// Registers TicketRoom's notification address with Yoco for one mode and returns
// its signing secret. Yoco only reveals a secret when a subscription is created,
// so if one already exists for this address in this mode (a lost secret, a new
// key), that one is removed and a fresh one made. The other mode's is never touched.
function yoco_register_webhook(?string $mode = null): string
{
    $mode = $mode ?? pay_mode();
    $url = base_url() . '/api/webhooks/yoco';
    $body = ['name' => 'TicketRoom ' . $mode, 'url' => $url];
    $r = yoco_call('POST', '/api/webhooks', $body, null, $mode);
    if (in_array($r['status'], [401, 403], true)) throw pay_error('provider_refused', "Yoco rejected the $mode secret key. Copy it again from the Yoco portal.");
    if ($r['status'] >= 300 || empty($r['json']['secret'])) {
        $list = yoco_call('GET', '/api/webhooks', null, null, $mode);
        $subs = $list['json']['subscriptions'] ?? $list['json']['data'] ?? (is_array($list['json']) && array_is_list($list['json']) ? $list['json'] : []);
        $removed = false;
        foreach ((array) $subs as $sub) {
            if (!is_array($sub) || rtrim((string) ($sub['url'] ?? ''), '/') !== $url || ($sub['mode'] ?? $mode) !== $mode || !preg_match('/^[\w-]{1,100}$/', (string) ($sub['id'] ?? ''))) continue;
            $d = yoco_call('DELETE', '/api/webhooks/' . $sub['id'], null, null, $mode);
            if ($d['status'] < 300) $removed = true;
        }
        if ($removed) $r = yoco_call('POST', '/api/webhooks', $body, null, $mode);
    }
    if ($r['status'] >= 300 || empty($r['json']['secret'])) throw pay_error('provider_refused', 'Yoco did not accept the notification address (' . yoco_problem($r) . ').');
    return (string) $r['json']['secret'];
}

// ============================================================== PayFast
// PHP's urlencode is what PayFast signs with (spaces as "+").
function payfast_string(array $fields, bool $withPass = true): string
{
    $parts = [];
    foreach ($fields as $k => $v) if ($k !== 'signature' && $v !== null && trim((string) $v) !== '') $parts[] = $k . '=' . urlencode(trim((string) $v));
    $pass = (string) cfg('payments.payfastPassphrase', '');
    if ($withPass && $pass !== '') $parts[] = 'passphrase=' . urlencode(trim($pass));
    return implode('&', $parts);
}
function payfast_form(array $payment, array $order, ?string $returnPath = null): array
{
    $first = explode(' ', trim($order['buyer_name']))[0];
    $last = trim(substr(trim($order['buyer_name']), strlen($first)));
    $k = $returnPath === null ? rawurlencode(order_key($order['id'])) : '';
    $f = [
        'merchant_id' => cfg('payments.payfastMerchantId'), 'merchant_key' => cfg('payments.payfastMerchantKey'),
        'return_url' => base_url() . ($returnPath ?? "/orders/{$order['reference']}?k=$k"), 'cancel_url' => base_url() . ($returnPath ?? "/orders/{$order['reference']}?k=$k&cancelled=1"),
        'notify_url' => base_url() . '/api/webhooks/payfast',
        'name_first' => $first, 'name_last' => $last, 'email_address' => $order['buyer_email'],
        'm_payment_id' => $payment['id'], 'amount' => number_format($payment['amount_cents'] / 100, 2, '.', ''), 'item_name' => substr($order['item_name'] ?? "TicketRoom order {$order['reference']}", 0, 100),
    ];
    $f = array_filter($f, fn($v) => $v !== null && trim((string) $v) !== '');
    $f['signature'] = md5(payfast_string($f));
    return ['action' => payfast_host() . '/eng/process', 'fields' => $f];
}
// ITN: signature, merchant, then PayFast confirms server-to-server that it sent it.
function payfast_verify(string $raw): array
{
    parse_str($raw, $f);
    if (empty($f['signature']) || empty($f['m_payment_id'])) throw bad('Missing ITN fields.');
    $ordered = [];
    foreach (explode('&', $raw) as $pair) { [$k] = explode('=', $pair, 2); $k = urldecode($k); if ($k !== '' && $k !== 'signature' && array_key_exists($k, $f)) $ordered[$k] = $f[$k]; }
    if (!hash_equals(md5(payfast_string($ordered)), (string) $f['signature'])) throw bad('ITN signature does not match.');
    if ((string) $f['merchant_id'] !== (string) cfg('payments.payfastMerchantId')) throw bad('ITN for another merchant.');
    $v = http_request('POST', payfast_host() . '/eng/query/validate', ['Content-Type' => 'application/x-www-form-urlencoded', 'Accept' => 'text/plain'], payfast_string($ordered, false));
    if (trim($v['text']) !== 'VALID') throw bad('PayFast did not confirm this notification.');
    $st = (string) ($f['payment_status'] ?? '');
    return ['id' => ($f['pf_payment_id'] ?? '') . ':' . $st, 'outcome' => $st === 'COMPLETE' ? 'paid' : ($st === 'CANCELLED' ? 'cancelled' : ($st === 'FAILED' ? 'failed' : null)),
        'reference' => (string) $f['m_payment_id'], 'amountCents' => (int) round(((float) ($f['amount_gross'] ?? 0)) * 100), 'pfPaymentId' => (string) ($f['pf_payment_id'] ?? '')];
}

// ============================================================== payments
// Opens the provider's payment page for an unpaid order. Retries reuse the
// unfinished payment ID so provider-side idempotency prevents duplicate charges.
function payment_start(array $order): array
{
    if (!pay_ready()) throw new AppError(503, 'payments_not_configured', 'Card payments are not switched on yet. Free tickets are available; paid tickets go on sale soon.');
    $now = now_iso();
    $p = tx(function () use ($order, $now) {
        $p = row("SELECT * FROM payments WHERE order_id = ? AND status IN ('initiated','pending') ORDER BY created_at DESC, id DESC LIMIT 1", [$order['id']]);
        if (!$p) $p = insert('payments', ['id' => uuid(), 'order_id' => $order['id'], 'provider' => pay_provider(), 'environment' => pay_mode(), 'amount_cents' => (int) $order['total_cents'],
            'status' => 'initiated', 'created_at' => $now, 'updated_at' => $now]);
        return $p;
    });
    // A test-mode payment makes this a test order, start to finish.
    q('UPDATE orders SET test = ?, updated_at = ? WHERE id = ?', [pay_test() ? 1 : 0, $now, $order['id']]);
    $k = rawurlencode(order_key($order['id']));
    try {
        if ($p['provider'] === 'yoco') {
            if (($p['status'] ?? '') === 'pending' && !empty($p['checkout_url'])) return ['id' => $p['id'], 'provider' => 'yoco', 'redirectUrl' => $p['checkout_url']];
            $c = yoco_checkout($p, $order, base_url() . "/orders/{$order['reference']}?k=$k", base_url() . "/orders/{$order['reference']}?k=$k&cancelled=1");
            q("UPDATE payments SET provider_reference = ?, checkout_url = ?, status = 'pending', updated_at = ? WHERE id = ? AND status IN ('initiated','pending')", [$c['reference'], $c['redirectUrl'], now_iso(), $p['id']]);
            return ['id' => $p['id'], 'provider' => 'yoco', 'redirectUrl' => $c['redirectUrl']];
        }
        if ($p['provider'] === 'peach') {
            if ($p['status'] === 'pending' && !empty($p['checkout_url']) && !empty($p['provider_payment_id'])) return ['id' => $p['id'], 'provider' => 'peach', 'redirectUrl' => $p['checkout_url']];
            $c = peach_checkout($p, ['reference' => $order['reference'], 'item_name' => $order['item_name'] ?? ('TicketRoom order ' . $order['reference'])], base_url() . "/orders/{$order['reference']}?k=$k");
            q("UPDATE payments SET provider_reference = ?, provider_payment_id = ?, checkout_url = ?, status = 'pending', updated_at = ? WHERE id = ? AND status IN ('initiated','pending')", [$p['id'], $c['paymentId'], $c['redirectUrl'], now_iso(), $p['id']]);
            return ['id' => $p['id'], 'provider' => 'peach', 'redirectUrl' => $c['redirectUrl']];
        }
        // PayFast and the sandbox: TicketRoom's own /pay page takes the buyer on.
        q("UPDATE payments SET provider_reference = ?, status = 'pending', updated_at = ? WHERE id = ? AND status IN ('initiated','pending')", [$p['id'], now_iso(), $p['id']]);
        return ['id' => $p['id'], 'provider' => $p['provider'], 'redirectUrl' => '/pay?p=' . $p['id'] . ($p['provider'] === 'sandbox' ? '&m=sandbox' : '') . '&k=' . rawurlencode(sign_link(['p' => $p['id']], 3600))];
    } catch (Throwable $e) {
        q("UPDATE payments SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?", [substr('checkout: ' . $e->getMessage(), 0, 240), now_iso(), $p['id']]);
        error_log('[payments] checkout failed: ' . $e->getMessage());
        throw pay_error('provider_unavailable', 'We could not reach the payment provider. Nothing was charged. Please try again in a moment.');
    }
}

// Applies a provider outcome. Safe to call twice: a second "paid" does nothing.
// Returns confirmed | duplicate | mismatch | failed | cancelled | ignored.
function payment_apply(string $provider, string $reference, string $outcome, int $amountCents, ?string $mode = null): string
{
    return tx(function () use ($provider, $reference, $outcome, $amountCents, $mode) {
        $p = row('SELECT * FROM payments WHERE provider = ? AND provider_reference = ?', [$provider, $reference]);
        if (!$p) {
            // A Promote purchase (lib/promote.php): same providers, its own records.
            $pp = row('SELECT * FROM promotion_payments WHERE provider = ? AND provider_reference = ?', [$provider, $reference]);
            if ($pp && $mode !== null && $pp['environment'] !== $mode) return 'ignored';
            if ($pp) return promo_payment_apply($pp, $outcome, $amountCents);
            throw not_found('Unknown payment reference.');
        }
        // A test-mode Yoco notification never touches a live payment, and the other way round.
        if ($mode !== null && $p['environment'] !== $mode) return 'ignored';
        if ($outcome === 'paid') {
            if (in_array($p['status'], ['confirmed', 'refunded', 'partially_refunded'], true)) return 'duplicate';
            if ($amountCents !== (int) $p['amount_cents']) {
                q("UPDATE payments SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?", ["amount mismatch: provider $amountCents, expected {$p['amount_cents']}", now_iso(), $p['id']]);
            if (($p['purpose'] ?? 'order') === 'topup') topup_closed($p, 'failed');
                audit('payment.amount_mismatch', ['entityType' => 'payment', 'entityId' => $p['id'], 'details' => ['providerAmount' => $amountCents, 'expected' => (int) $p['amount_cents']]]);
                return 'mismatch';
            }
            $now = now_iso();
            q("UPDATE payments SET status = 'confirmed', confirmed_at = ?, failure_reason = NULL, updated_at = ? WHERE id = ?", [$now, $now, $p['id']]);
            // A cashless top-up: the money goes on the attendee's event balance.
            if (($p['purpose'] ?? 'order') === 'topup') {
                topup_confirm($p);
                audit('payment.confirmed', ['entityType' => 'payment', 'entityId' => $p['id'], 'details' => ['purpose' => 'topup', 'amount' => (int) $p['amount_cents']]]);
                return 'confirmed';
            }
            if ($p['environment'] !== 'live') q('UPDATE orders SET test = 1 WHERE id = ?', [$p['order_id']]);
            $order = row('SELECT * FROM orders WHERE id = ?', [$p['order_id']]);
            // A different checkout may complete after the order was already
            // settled. Keep the provider charge visible for reconciliation,
            // but never book it as a second sale or issue another ticket.
            if (!in_array($order['status'], ['pending_payment', 'expired', 'cancelled'], true)) {
                $test = $p['environment'] !== 'live';
                ledger_post('payment_overpayment', $p['id'], [['provider:' . $p['provider'], (int) $p['amount_cents']], ['liability:overpayments', -(int) $p['amount_cents']]], $test);
                q("UPDATE payments SET failure_reason = ?, updated_at = ? WHERE id = ?", ['Additional successful charge; refund initiated or awaiting finance.', now_iso(), $p['id']]);
                $now = now_iso();
                $rf = insert('refunds', ['id' => uuid(), 'reference' => reference('RF'), 'order_id' => $order['id'], 'payment_id' => $p['id'],
                    'amount_cents' => 0, 'fee_refund_cents' => (int) $p['amount_cents'], 'kind' => 'goodwill',
                    'reason' => 'Automatic refund of an additional successful payment for an already-paid order.',
                    'ticket_ids' => '[]', 'status' => 'requested', 'note' => 'system:overpayment:' . $p['id'], 'created_at' => $now, 'updated_at' => $now]);
                audit('payment.overpayment', ['entityType' => 'payment', 'entityId' => $p['id'], 'details' => ['order' => $order['reference'], 'amount' => (int) $p['amount_cents']]]);
                $GLOBALS['TR_AFTER_COMMIT'][] = fn() => refund_process_safe($rf['id']);
                return 'overpayment';
            }
            // A TicketRoom Exchange purchase (lib/exchange.php): a new ticket for the buyer, the seller's is voided.
            if (!empty($order['resale_listing_id'])) {
                resale_payment_confirmed($order, $p);
                audit('payment.confirmed', ['entityType' => 'payment', 'entityId' => $p['id'], 'details' => ['order' => $order['reference'], 'amount' => (int) $p['amount_cents'], 'resale' => true]]);
                return 'confirmed';
            }
            ledger_payment($order, $p);
            payment_fulfil($order, $p);
            if ((int) $order['test'] === 1) q('UPDATE tickets SET test = 1 WHERE order_id = ?', [$order['id']]);
            audit('payment.confirmed', ['entityType' => 'payment', 'entityId' => $p['id'], 'details' => ['order' => $order['reference'], 'amount' => (int) $p['amount_cents']]]);
            return 'confirmed';
        }
        if ($outcome === 'failed' || $outcome === 'cancelled') {
            if (in_array($p['status'], ['confirmed', 'refunded', 'partially_refunded'], true)) return 'ignored';
            q('UPDATE payments SET status = ?, updated_at = ? WHERE id = ?', [$outcome, now_iso(), $p['id']]);
            if (($p['purpose'] ?? 'order') === 'topup') topup_closed($p, $outcome);
            return $outcome;
        }
        return 'ignored';
    });
}

// Issues the tickets for a paid order. If the payment came in after the
// reservation lapsed, the tickets are taken again if they're still there;
// if they've sold out, the order is marked "paid, not fulfilled" and a full
// refund goes out straight away. The same happens when the event was
// cancelled while the buyer was paying: no tickets for a cancelled event.
function payment_fulfil(array $order, array $payment): void
{
    if (!in_array($order['status'], ['pending_payment', 'expired', 'cancelled'], true)) return;
    if (val('SELECT status FROM events WHERE id = ?', [$order['event_id']]) === 'cancelled') {
        if ($order['status'] === 'pending_payment') release_holds($order);
        payment_unfulfilled($order, 'Payment arrived after the event was cancelled.');
        return;
    }
    if ($order['status'] === 'pending_payment') { fulfil_order($order['id']); return; }
    $items = rows('SELECT * FROM order_items WHERE order_id = ?', [$order['id']]);
    $got = [];
    foreach ($items as $it) {
        if (affected('UPDATE ticket_types SET quantity_held = quantity_held + ? WHERE id = ? AND quantity_sold + quantity_held + ? <= quantity_total', [$it['quantity'], $it['ticket_type_id'], $it['quantity']]) === 0) break;
        $got[] = $it;
    }
    if (count($got) === count($items)) {
        q("UPDATE orders SET status = 'pending_payment', updated_at = ? WHERE id = ?", [now_iso(), $order['id']]);
        fulfil_order($order['id']);
        return;
    }
    foreach ($got as $it) q('UPDATE ticket_types SET quantity_held = MAX(quantity_held - ?, 0) WHERE id = ?', [$it['quantity'], $it['ticket_type_id']]);
    payment_unfulfilled($order, 'Payment arrived after the reservation expired and the tickets had sold out.');
}
// Paid, but there is nothing to issue: "paid, not fulfilled", and a full
// refund goes out straight away (to the provider once this transaction commits).
function payment_unfulfilled(array $order, string $reason): void
{
    q("UPDATE orders SET status = 'paid_unfulfilled', paid_at = ?, updated_at = ? WHERE id = ?", [now_iso(), now_iso(), $order['id']]);
    $order = row('SELECT * FROM orders WHERE id = ?', [$order['id']]);
    $rf = refund_create($order, null, [], true, 'unfulfilled', $reason, null, 'processing');
    $GLOBALS['TR_AFTER_COMMIT'][] = fn() => refund_process_safe($rf['id']);
}

// Asks the provider directly. Used by the order page while it waits,
// before a reservation expires, and by the admin "Re-check" button.
function payment_sync(string $paymentId): string
{
    $p = row('SELECT * FROM payments WHERE id = ?', [$paymentId]) ?: row('SELECT * FROM promotion_payments WHERE id = ?', [$paymentId]);
    if (!$p) throw not_found('Payment not found.');
    if (!$p['provider_reference'] || !in_array($p['status'], ['pending', 'failed', 'cancelled'], true)) return $p['status'];
    if ($p['provider'] === 'peach') {
        $s = peach_payment_status($p);
        if ($s['status'] === 'paid') return payment_apply('peach', $p['provider_reference'], 'paid', $s['amountCents']);
        if (in_array($s['status'], ['failed', 'cancelled'], true) && $p['status'] === 'pending') return payment_apply('peach', $p['provider_reference'], $s['status'], 0);
        return $p['status'];
    }
    if ($p['provider'] !== 'yoco') return $p['status'];
    $s = yoco_status($p['provider_reference'], (string) $p['environment']);
    if ($s['status'] === 'paid') return payment_apply('yoco', $p['provider_reference'], 'paid', $s['amountCents']);
    if (in_array($s['status'], ['failed', 'cancelled'], true) && $p['status'] === 'pending') return payment_apply('yoco', $p['provider_reference'], $s['status'], 0);
    return $p['status'];
}

// Webhook / ITN entry point: verify, record (once), apply.
function payment_webhook(string $provider, string $raw, array $headers): array
{
    try {
        $evt = $provider === 'yoco' ? yoco_verify($raw, $headers) : payfast_verify($raw);
    } catch (Throwable $e) {
        // Kept for finance to see, but not without limit: junk can't fill the database.
        if (limit_ok('webhookreject', 100, 3600)) q('INSERT INTO webhook_events (provider, event_id, status, error, received_at) VALUES (?,?,?,?,?)', [$provider, 'rejected:' . bin2hex(random_bytes(8)), 'rejected', substr($e->getMessage(), 0, 200), now_iso()]);
        throw $e instanceof AppError ? $e : bad('Invalid notification.');
    }
    $existing = row('SELECT * FROM webhook_events WHERE provider = ? AND event_id = ?', [$provider, $evt['id']]);
    if ($existing) {
        q('UPDATE webhook_events SET attempts = attempts + 1 WHERE id = ?', [$existing['id']]);
        if (in_array($existing['status'], ['processed', 'ignored'], true)) return ['duplicate' => true];
        $wid = (int) $existing['id'];
    } else {
        q('INSERT INTO webhook_events (provider, event_id, status, received_at) VALUES (?,?,?,?)', [$provider, $evt['id'], 'received', now_iso()]);
        $wid = (int) db()->lastInsertId();
    }
    try {
        if (!empty($evt['refund'])) $result = payment_refund_notice($provider, $evt);
        else $result = $evt['outcome'] && $evt['reference'] !== '' ? payment_apply($provider, $evt['reference'], $evt['outcome'], (int) $evt['amountCents'], $evt['mode'] ?? null) : 'ignored';
        q('UPDATE webhook_events SET status = ?, result = ?, processed_at = ?, error = NULL WHERE id = ?', [$result === 'ignored' ? 'ignored' : 'processed', $result, now_iso(), $wid]);
        if ($provider === 'payfast' && !empty($evt['pfPaymentId']) && $result === 'confirmed') {
            q("UPDATE payments SET failure_reason = NULL, updated_at = ? WHERE provider = 'payfast' AND provider_reference = ?", [now_iso(), $evt['reference']]);
            q("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)", ['payfast_pf:' . $evt['reference'], $evt['pfPaymentId']]);
        }
        return ['result' => $result];
    } catch (Throwable $e) {
        q("UPDATE webhook_events SET status = 'failed', error = ? WHERE id = ?", [substr($e->getMessage(), 0, 300), $wid]);
        throw $e;
    }
}

// The provider reports a refund. Ours are already recorded (refunds, resale
// payouts and Promote refunds keep the provider's refund reference or our own
// idempotency key). One made in the provider's own portal is not: nothing is
// changed automatically, but finance sees it under Reconciliation and in the
// audit log, to record it against the order.
function payment_refund_notice(string $provider, array $evt): string
{
    $id = (string) $evt['refund']['id'];
    $known = $id !== '' && (val('SELECT 1 FROM refunds WHERE provider_reference = ? OR id = ?', [$id, $id]) || val('SELECT 1 FROM resale_payouts WHERE provider_reference = ? OR id = ?', [$id, $id])
        || val('SELECT 1 FROM event_promotions WHERE refund_provider_reference = ? OR refund_reference = ?', [$id, $id]));
    if ($known) return 'refund_recorded';
    $p = $evt['reference'] !== '' ? (row('SELECT id, order_id, environment FROM payments WHERE provider = ? AND provider_reference = ?', [$provider, $evt['reference']])
        ?: row('SELECT id, NULL AS order_id, environment FROM promotion_payments WHERE provider = ? AND provider_reference = ?', [$provider, $evt['reference']])) : null;
    audit('payment.refund_unmatched', ['actorRole' => 'system', 'entityType' => 'payment', 'entityId' => $p['id'] ?? null, 'details' => ['provider' => $provider, 'refund' => $id, 'checkout' => $evt['reference'],
        'amount' => (int) $evt['refund']['amountCents'], 'order' => $p && $p['order_id'] ? val('SELECT reference FROM orders WHERE id = ?', [$p['order_id']]) : null, 'mode' => $evt['mode'] ?? null]]);
    return 'refund_unmatched';
}

// ============================================================== refunds
// A refund of some tickets (or the whole order). $includeFees adds the
// booking fee for those tickets. Amounts come from what was actually paid.
function refund_create(array $order, ?array $actor, array $ticketIds, bool $includeFees, string $kind, string $reason, ?string $note = null, string $status = 'requested'): array
{
    $p = row("SELECT * FROM payments WHERE order_id = ? AND status IN ('confirmed','partially_refunded') ORDER BY created_at DESC LIMIT 1", [$order['id']]);
    if (!$p) throw conflict('This order has no card payment to refund.', 'order_not_refundable');
    if ($kind === 'unfulfilled') {
        $amount = (int) $order['total_cents'] - (int) $order['fee_cents']; $fee = (int) $order['fee_cents']; $ids = [];
    } else {
        $open = rows("SELECT id, price_cents, fee_cents FROM tickets WHERE order_id = ? AND status IN ('valid','used')" . ($ticketIds ? ' AND id IN (' . placeholders($ticketIds) . ')' : ''), array_merge([$order['id']], $ticketIds));
        if ($ticketIds && count($open) !== count(array_unique($ticketIds))) throw conflict('Some of those tickets are already refunded or not in this order.', 'ticket_not_refundable');
        if (!$open) throw conflict('Nothing left to refund on this order.', 'order_not_refundable');
        // A failed provider refund can still have an uncertain outcome. Do not
        // create a second refund ID until finance retries or reconciles it;
        // otherwise both provider requests could return money for one ticket.
        $pending = (int) val("SELECT count(*) FROM refunds WHERE order_id = ? AND status IN ('requested','processing','manual_pending','failed')", [$order['id']]);
        if ($pending) throw conflict('A refund for this order is still unresolved. Retry or reconcile it before creating another refund.', 'refund_in_progress');
        // Discounts are shared across tickets in proportion to price. The share
        // is worked out on everything refunded so far plus these tickets, less
        // what was already worked out, so rounding never adds up to more than
        // the order's ticket money however the tickets are split.
        $gross = (int) $order['subtotal_cents'];
        $share = fn(int $price) => $gross > 0 ? (int) round($price * ((int) $order['subtotal_cents'] - (int) $order['discount_cents']) / $gross) : 0;
        $before = (int) val("SELECT COALESCE(SUM(price_cents),0) FROM tickets WHERE order_id = ? AND status = 'refunded'", [$order['id']]);
        $amount = $share($before + array_sum(array_map(fn($t) => (int) $t['price_cents'], $open))) - $share($before);
        $fee = $includeFees ? array_sum(array_map(fn($t) => (int) $t['fee_cents'], $open)) : 0;
        $ids = array_column($open, 'id');
    }
    $left = (int) $order['total_cents'] - (int) $order['refunded_cents'];
    if ($amount + $fee > $left) { $fee = max(0, $left - $amount); $amount = min($amount, $left); }
    if ($amount + $fee <= 0) throw conflict('Nothing left to refund on this order.', 'order_not_refundable');
    $now = now_iso();
    $r = insert('refunds', ['id' => uuid(), 'reference' => reference('RF'), 'order_id' => $order['id'], 'payment_id' => $p['id'], 'amount_cents' => $amount, 'fee_refund_cents' => $fee,
        'kind' => $kind, 'reason' => $reason, 'ticket_ids' => json_encode($ids), 'status' => $status, 'note' => $note, 'requested_by' => $actor['id'] ?? null, 'created_at' => $now, 'updated_at' => $now]);
    // Tickets being refunded come off TicketRoom Exchange straight away: nobody
    // can buy a ticket whose money is on its way back. (A listing someone is
    // paying for right now stays held; resale_payment_confirmed refunds that buyer.)
    if ($ids) foreach (rows("SELECT * FROM resale_listings WHERE ticket_id IN (" . placeholders($ids) . ") AND status IN ('active','offered')", $ids) as $l) resale_close_listing($l, 'closed', 'refund_pending');
    audit('refund.requested', ['actor' => $actor, 'entityType' => 'refund', 'entityId' => $r['id'], 'details' => ['order' => $order['reference'], 'amount' => $amount + $fee, 'kind' => $kind]]);
    return $r;
}
// A ticket in a refund that is not settled yet (asked for, on its way, or
// failed and waiting for finance). It is about to stop working, so it cannot
// be sold or passed on in the meantime.
function ticket_has_open_refund(string $ticketId): bool
{
    $orderId = val('SELECT order_id FROM tickets WHERE id = ?', [$ticketId]);
    if (!$orderId) return false;
    foreach (rows("SELECT ticket_ids FROM refunds WHERE order_id = ? AND status IN ('requested','processing','manual_pending','failed') AND COALESCE(note, '') NOT LIKE 'system:overpayment:%'", [$orderId]) as $r) {
        $ids = json_decode((string) $r['ticket_ids'], true) ?: [];
        if (!$ids || in_array($ticketId, $ids, true)) return true;
    }
    return false;
}
// At a cancelled event every paid ticket is refunded. An order that already
// had a refund on its way when the event was cancelled gets the rest raised
// for finance as soon as that refund is settled (paid or turned down).
function refund_cancelled_event_rest(?string $orderId, ?array $actor): ?array
{
    if (!$orderId) return null;
    $o = row('SELECT * FROM orders WHERE id = ?', [$orderId]);
    $ev = $o ? row('SELECT status, status_reason FROM events WHERE id = ?', [$o['event_id']]) : null;
    if (!$ev || $ev['status'] !== 'cancelled' || !in_array($o['status'], ['paid', 'partially_refunded'], true) || (int) $o['total_cents'] <= (int) $o['refunded_cents']) return null;
    try { return refund_create($o, $actor, [], true, 'event_cancelled', 'Event cancelled: ' . ($ev['status_reason'] ?: 'by TicketRoom')); }
    catch (AppError $e) { return null; } // nothing left, or another refund still open
}

// Sends an approved refund to the provider. Yoco refunds by API; PayFast
// refunds wait for finance to do them in the PayFast dashboard.
function refund_process(string $refundId, ?array $actor = null): array
{
    $r = row('SELECT * FROM refunds WHERE id = ?', [$refundId]);
    if (!$r || !in_array($r['status'], ['requested', 'processing', 'failed'], true)) throw conflict('This refund cannot be processed now.', 'bad_transition');
    // A vendor sale refund goes back on the attendee's balance: no provider involved.
    if ($r['kind'] === 'pos_sale') {
        return tx(function () use ($r, $actor) {
            q('UPDATE refunds SET decided_by = COALESCE(decided_by, ?), updated_at = ? WHERE id = ?', [$actor['id'] ?? null, now_iso(), $r['id']]);
            return pos_refund_complete($r['id'], $actor);
        });
    }
    $p = row('SELECT * FROM payments WHERE id = ?', [$r['payment_id']]);
    // Only a refund still in one of those states moves on: one turned down a
    // moment ago (by someone else) stays turned down.
    if (affected("UPDATE refunds SET status = 'processing', decided_by = COALESCE(decided_by, ?), failure_reason = NULL, updated_at = ? WHERE id = ? AND status IN ('requested','processing','failed')", [$actor['id'] ?? null, now_iso(), $r['id']]) !== 1) {
        throw conflict('This refund cannot be processed now.', 'bad_transition');
    }
    // Sandbox money goes back at once: there is nobody to ask.
    if ($p['provider'] === 'sandbox') return tx(fn() => refund_complete($r['id'], 'SANDBOX-' . $r['reference'], $actor));
    if ($p['provider'] !== 'yoco') {
        q("UPDATE refunds SET status = 'manual_pending', updated_at = ? WHERE id = ?", [now_iso(), $r['id']]);
        return row('SELECT * FROM refunds WHERE id = ?', [$r['id']]);
    }
    try {
        $ref = yoco_refund($p, (int) $r['amount_cents'] + (int) $r['fee_refund_cents'], $r['id']);
    } catch (Throwable $e) {
        q("UPDATE refunds SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?", [substr($e->getMessage(), 0, 240), now_iso(), $r['id']]);
        audit('refund.failed', ['actor' => $actor, 'entityType' => 'refund', 'entityId' => $r['id'], 'details' => ['error' => substr($e->getMessage(), 0, 120)]]);
        return row('SELECT * FROM refunds WHERE id = ?', [$r['id']]);
    }
    return tx(fn() => refund_complete($r['id'], $ref, $actor));
}
function refund_process_safe(string $refundId): void
{
    try { refund_process($refundId); } catch (Throwable $e) { error_log("[refunds] $refundId: " . $e->getMessage()); }
}

// Money has gone back: tickets stop working, the order and payment record it,
// the ledger moves it, and the buyer gets an email.
function refund_complete(string $refundId, string $providerRef, ?array $actor): array
{
    $r = row('SELECT * FROM refunds WHERE id = ?', [$refundId]);
    if ($r['status'] === 'completed') return $r;
    $now = now_iso();
    $total = (int) $r['amount_cents'] + (int) $r['fee_refund_cents'];
    q("UPDATE refunds SET status = 'completed', provider_reference = ?, completed_at = ?, updated_at = ? WHERE id = ?", [$providerRef, $now, $now, $r['id']]);
    if (str_starts_with((string) ($r['note'] ?? ''), 'system:overpayment:')) {
        $p = row('SELECT * FROM payments WHERE id = ?', [$r['payment_id']]);
        if (!$p || $total !== (int) $p['amount_cents'] - (int) $p['refunded_cents']) throw conflict('Overpayment refund amount does not match the remaining charge.', 'refund_amount_mismatch');
        q("UPDATE payments SET refunded_cents = ?, status = 'refunded', updated_at = ? WHERE id = ?", [(int) $p['refunded_cents'] + $total, $now, $p['id']]);
        ledger_post('overpayment_refund', $r['reference'], [['provider:' . $p['provider'], -$total], ['liability:overpayments', $total]], $p['environment'] !== 'live');
        audit('refund.completed', ['actor' => $actor, 'entityType' => 'refund', 'entityId' => $r['id'], 'details' => ['kind' => 'overpayment', 'amount' => $total, 'providerReference' => $providerRef]]);
        return row('SELECT * FROM refunds WHERE id = ?', [$r['id']]);
    }
    if ($r['kind'] === 'wallet_balance') {
        $p = row('SELECT * FROM payments WHERE id = ?', [$r['payment_id']]);
        $pr = (int) $p['refunded_cents'] + $total;
        q('UPDATE payments SET refunded_cents = ?, status = ?, updated_at = ? WHERE id = ?', [$pr, $pr >= (int) $p['amount_cents'] ? 'refunded' : 'partially_refunded', $now, $p['id']]);
        wallet_refund_completed($r, $p);
        audit('refund.completed', ['actor' => $actor, 'entityType' => 'refund', 'entityId' => $r['id'], 'details' => ['kind' => 'wallet_balance', 'amount' => $total, 'providerReference' => $providerRef]]);
        return row('SELECT * FROM refunds WHERE id = ?', [$r['id']]);
    }
    $ids = json_decode((string) $r['ticket_ids'], true) ?: [];
    if ($ids) q("UPDATE tickets SET status = 'refunded', updated_at = ? WHERE id IN (" . placeholders($ids) . ") AND status IN ('valid','used')", array_merge([$now], $ids));
    if ($ids) {
        // A refunded ticket comes off TicketRoom Exchange, and its place goes to the waitlist.
        foreach (rows("SELECT * FROM resale_listings WHERE ticket_id IN (" . placeholders($ids) . ") AND status IN ('active','offered')", $ids) as $l) resale_close_listing($l, 'closed', 'refunded');
        waitlist_tickets_returned($ids, $r['kind']);
    }
    $order = row('SELECT * FROM orders WHERE id = ?', [$r['order_id']]);
    $refunded = (int) $order['refunded_cents'] + $total;
    $status = $order['status'] === 'paid_unfulfilled' || $refunded >= (int) $order['total_cents'] ? ($order['status'] === 'paid_unfulfilled' ? 'paid_unfulfilled' : 'refunded') : 'partially_refunded';
    q('UPDATE orders SET refunded_cents = ?, status = ?, updated_at = ? WHERE id = ?', [$refunded, $status, $now, $order['id']]);
    $p = row('SELECT * FROM payments WHERE id = ?', [$r['payment_id']]);
    $pr = (int) $p['refunded_cents'] + $total;
    q('UPDATE payments SET refunded_cents = ?, status = ?, updated_at = ? WHERE id = ?', [$pr, $pr >= (int) $p['amount_cents'] ? 'refunded' : 'partially_refunded', $now, $p['id']]);
    ledger_refund($order, $p, $r);
    $event = row('SELECT * FROM events WHERE id = ?', [$order['event_id']]);
    outbox_enqueue(['to' => $order['buyer_email'], 'userId' => $order['user_id']] + tpl('refundDone', ['order' => $order, 'event' => $event, 'amountCents' => $total]));
    audit('refund.completed', ['actor' => $actor, 'entityType' => 'refund', 'entityId' => $r['id'], 'details' => ['amount' => $total, 'providerReference' => $providerRef]]);
    if ($r['kind'] !== 'event_cancelled') refund_cancelled_event_rest($order['id'], $actor);
    return row('SELECT * FROM refunds WHERE id = ?', [$r['id']]);
}

// ============================================================== ledger
// Accounts:  provider:<name>            money held at the payment provider
//            organiser:<org>:event:<ev> owed to an organiser for an event
//            organiser:<org>:payouts    paid out to the organiser
//            revenue:booking_fees       TicketRoom's booking fees
//            revenue:commission         TicketRoom's commission
//            revenue:promotions         Promote packages (lib/promote.php)
//            organiser:<org>:deductions what an organiser paid TicketRoom from their balance
//            bank:payouts               money sent to organisers by EFT
//            wallet:<user>:<event>      an attendee's cashless balance (lib/cashless.php)
//            vendor:<vendor>:event:<ev> owed for a vendor's cashless sales
//            revenue:cashless_commission TicketRoom's commission on vendor sales
// Debits are positive, credits negative; every journal sums to zero.
function ledger_post(string $kind, string $reference, array $lines, bool $test = false): void
{
    $lines = array_values(array_filter($lines, fn($l) => (int) $l[1] !== 0));
    // Test-mode money lives in its own accounts, never mixed with real money.
    if ($test) $lines = array_map(fn($l) => ['test:' . $l[0], $l[1]], $lines);
    if (!$lines) return;
    if (array_sum(array_map(fn($l) => (int) $l[1], $lines)) !== 0) throw new RuntimeException("ledger: journal $reference does not balance");
    q('INSERT INTO ledger_journals (kind, reference, created_at) VALUES (?,?,?)', [$kind, $reference, now_iso()]);
    $jid = (int) db()->lastInsertId();
    foreach ($lines as [$acct, $cents]) q('INSERT INTO ledger_entries (journal_id, account, amount_cents) VALUES (?,?,?)', [$jid, $acct, (int) $cents]);
}
function ledger_org_account(array $order): string
{
    $org = val('SELECT organiser_id FROM events WHERE id = ?', [$order['event_id']]);
    return "organiser:$org:event:{$order['event_id']}";
}
function ledger_payment(array $order, array $payment): void
{
    $net = (int) $order['subtotal_cents'] - (int) $order['discount_cents'];
    $commission = (int) $order['organiser_fee_cents'];
    $organiserServiceFee = (int) ($order['organiser_service_fee_cents'] ?? 0);
    ledger_post('payment', $order['reference'], [
        ['provider:' . $payment['provider'], (int) $payment['amount_cents']],
        [ledger_org_account($order), -($net - $commission - $organiserServiceFee)],
        ['revenue:commission', -$commission],
        ['revenue:service_fees', -$organiserServiceFee],
        ['revenue:booking_fees', -((int) $payment['amount_cents'] - $net)],
        ...retail_ledger_lines($order),
    ], $payment['environment'] !== 'live');
}
function ledger_refund(array $order, array $payment, array $refund): void
{
    $net = (int) $order['subtotal_cents'] - (int) $order['discount_cents'];
    $amount = (int) $refund['amount_cents'];
    $ticketIds = json_decode((string) ($refund['ticket_ids'] ?? '[]'), true) ?: [];
    $totalCommission = (int) $order['organiser_fee_cents'];
    $fixedPerTicket = (int) ($order['organiser_commission_fixed_cents'] ?? 0);
    $fixedTotal = $fixedPerTicket * (int) val('SELECT COALESCE(SUM(quantity),0) FROM order_items WHERE order_id = ? AND unit_price_cents > 0', [$order['id']]);
    $percentageCommission = max(0, $totalCommission - $fixedTotal);
    $percentageRefund = $net > 0 ? (int) round($amount * $percentageCommission / $net) : 0;
    if ($amount >= $net) $fixedCommissionRefund = $fixedTotal;
    elseif ($fixedPerTicket > 0 && $ticketIds) {
        $ids = array_values(array_filter($ticketIds, 'is_string'));
        $ticketCount = 0;
        if ($ids) {
            $marks = implode(',', array_fill(0, count($ids), '?'));
            $ticketCount = (int) val("SELECT count(*) FROM tickets WHERE id IN ($marks) AND price_cents > 0", $ids);
        }
        $fixedCommissionRefund = $fixedPerTicket * $ticketCount;
    } else $fixedCommissionRefund = $net > 0 ? (int) round($amount * $fixedTotal / $net) : 0;
    $commission = min($amount, $percentageRefund + $fixedCommissionRefund);
    $organiserServiceFee = (int) ($order['organiser_service_fee_cents'] ?? 0);
    if ($organiserServiceFee > 0) {
        if ($amount >= $net) $serviceFeeRefund = $organiserServiceFee;
        elseif ($ticketIds) {
            $ids = array_values(array_filter($ticketIds, 'is_string'));
            $serviceFeeRefund = 0;
            if ($ids) {
                $marks = implode(',', array_fill(0, count($ids), '?'));
                $serviceFeeRefund = (int) val("SELECT COALESCE(SUM(oi.unit_organiser_service_fee_cents),0) FROM tickets t JOIN order_items oi ON oi.id = t.order_item_id WHERE t.id IN ($marks)", $ids);
            }
        } else $serviceFeeRefund = $net > 0 ? (int) round($amount * $organiserServiceFee / $net) : 0;
    } else $serviceFeeRefund = 0;
    $retailCommissionRefund = 0; $retailServiceRefund = 0;
    if (!empty($order['retail_partner_id'])) {
        $retailCommissionRefund = $net > 0 ? min((int) $order['retail_commission_share_cents'], (int) round((int) $order['retail_commission_share_cents'] * min($amount, $net) / $net)) : 0;
        if ((int) ($order['organiser_service_fee_cents'] ?? 0) > 0) {
            $serviceBase = (int) $order['organiser_service_fee_cents'];
            $retailServiceRefund = $serviceBase > 0 ? min((int) $order['retail_service_share_cents'], (int) round((int) $order['retail_service_share_cents'] * min($serviceFeeRefund, $serviceBase) / $serviceBase)) : 0;
        } else {
            // A buyer keeps the ticket-room share if their service fee was not
            // refunded; reverse it only with the actual refunded booking fee.
            $feeBase = (int) $order['fee_cents'];
            $retailServiceRefund = $feeBase > 0 ? min((int) $order['retail_service_share_cents'], (int) round((int) $order['retail_service_share_cents'] * min((int) $refund['fee_refund_cents'], $feeBase) / $feeBase)) : 0;
        }
    }
    // A resale order never paid the organiser anything: its refunds come back
    // from what was set aside for sellers (resale clearing). The one exception
    // is a cancelled event: the organiser still holds the money for that seat
    // from its first sale (the seller's own ticket was resold, not refunded),
    // so that refund comes off the organiser like every other ticket's.
    $from = !empty($order['resale_listing_id']) && $refund['kind'] !== 'event_cancelled' ? RESALE_SELLERS : ledger_org_account($order);
    $tenderAccount = 'provider:' . $payment['provider'];
    if (($payment['environment'] ?? '') === 'door') {
        $tender = row('SELECT method,event_id FROM door_tenders WHERE payment_id = ?', [$payment['id']]);
        if (!$tender) throw new RuntimeException('Door tender is missing its reconciliation record.');
        // These tenders were paid directly to the organiser. Refunds for them
        // are settled manually by TicketRoom finance, so charge the refund to
        // TicketRoom's bank account and leave the original door takings in the
        // organiser-held account; finance then recovers that amount from the
        // organiser's future settlement.
        $tenderAccount = 'bank:refunds';
    }
    ledger_post('refund', $refund['reference'], [
        [$from, $amount - $commission - $serviceFeeRefund],
        ['revenue:commission', $commission],
        ['revenue:service_fees', $serviceFeeRefund],
        ['revenue:booking_fees', (int) $refund['fee_refund_cents']],
        [$tenderAccount, -($amount + (int) $refund['fee_refund_cents'])],
        ...retail_ledger_lines($order, -$retailCommissionRefund, -$retailServiceRefund),
    ], $payment['environment'] !== 'live' && $payment['environment'] !== 'door');
}
function ledger_balance(string $account): int { return (int) val('SELECT COALESCE(SUM(amount_cents),0) FROM ledger_entries WHERE account = ?', [$account]); }
function ledger_check(): array
{
    $bad = rows('SELECT journal_id, SUM(amount_cents) AS s FROM ledger_entries GROUP BY journal_id HAVING SUM(amount_cents) <> 0 LIMIT 20');
    $clearing = [];
    // Real money only: test-mode payments are booked to test: accounts.
    foreach (rows("SELECT DISTINCT provider FROM payments WHERE environment = 'live' UNION SELECT DISTINCT provider FROM promotion_payments WHERE environment = 'live' AND provider <> 'balance'") as $p) {
        $expected = (int) val("SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE provider = ? AND environment = 'live' AND status IN ('confirmed','partially_refunded','refunded')", [$p['provider']])
            - (int) val("SELECT COALESCE(SUM(r.amount_cents + r.fee_refund_cents),0) FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE p.provider = ? AND p.environment = 'live' AND r.status = 'completed'", [$p['provider']])
            + (int) val("SELECT COALESCE(SUM(amount_cents - refunded_cents),0) FROM promotion_payments WHERE provider = ? AND environment = 'live' AND status IN ('confirmed','refunded')", [$p['provider']])
            - (int) val("SELECT COALESCE(SUM(amount_cents),0) FROM resale_payouts WHERE provider = ? AND method = 'card' AND test = 0 AND status = 'paid'", [$p['provider']]);
        $ledger = ledger_balance("provider:{$p['provider']}");
        $clearing[] = ['account' => "provider:{$p['provider']}", 'ledgerCents' => $ledger, 'expectedCents' => $expected, 'ok' => $ledger === $expected];
    }
    $clearing[] = cashless_ledger_check();
    $clearing[] = resale_ledger_check();
    $exceptions = ledger_exceptions();
    $ok = !$bad && !array_filter($clearing, fn($c) => !$c['ok']) && !array_filter($exceptions, fn($x) => $x['severity'] === 'error');
    return ['entries' => (int) val("SELECT count(*) FROM ledger_entries WHERE account NOT LIKE 'test:%'"), 'sumCents' => (int) val('SELECT COALESCE(SUM(amount_cents),0) FROM ledger_entries'),
        'testEntries' => (int) val("SELECT count(*) FROM ledger_entries WHERE account LIKE 'test:%'"),
        'balanced' => $ok, 'unbalancedJournals' => array_column($bad, 'journal_id'), 'clearing' => $clearing, 'exceptions' => $exceptions];
}
// Money problems that balanced journals cannot show (real money only).
// "error": the records are wrong and must be put right. "action": money
// someone still has to send back or collect.
function ledger_exceptions(): array
{
    $out = [];
    $add = function (string $kind, string $severity, string $ref, int $cents, string $text) use (&$out) { if (count($out) < 200) $out[] = ['kind' => $kind, 'severity' => $severity, 'reference' => $ref, 'cents' => $cents, 'text' => $text]; };
    // An order paid more than once. A second charge that came in after the order
    // was settled is booked apart (payment_overpayment) and refunded by itself;
    // it is listed until that refund has gone through.
    $extra = "SELECT reference FROM ledger_journals WHERE kind = 'payment_overpayment'";
    foreach (rows("SELECT o.reference, COUNT(*) AS n FROM payments p JOIN orders o ON o.id = p.order_id
                    WHERE p.environment = 'live' AND p.status IN ('confirmed','partially_refunded','refunded') AND p.id NOT IN ($extra)
                    GROUP BY o.id HAVING COUNT(*) > 1 LIMIT 50") as $r) {
        $add('paid_twice', 'error', $r['reference'], 0, "Order {$r['reference']} has {$r['n']} payments counted as its sale. Refund the extra one and correct the books.");
    }
    foreach (rows("SELECT o.reference, p.amount_cents - p.refunded_cents AS open FROM payments p JOIN orders o ON o.id = p.order_id
                    WHERE p.environment = 'live' AND p.id IN ($extra) AND p.status IN ('confirmed','partially_refunded') AND p.amount_cents > p.refunded_cents LIMIT 50") as $r) {
        $add('paid_twice', 'action', $r['reference'], (int) $r['open'], "Order {$r['reference']} was paid twice. The second payment of " . format_zar((int) $r['open']) . ' has not gone back to the buyer yet. Check its refund under Refunds.');
    }
    // More refunded than was paid, on an order or a payment.
    foreach (rows('SELECT reference, refunded_cents - total_cents AS over FROM orders WHERE test = 0 AND refunded_cents > total_cents LIMIT 50') as $r) {
        $add('over_refunded', 'error', $r['reference'], (int) $r['over'], "Order {$r['reference']} was refunded " . format_zar((int) $r['over']) . ' more than was paid.');
    }
    foreach (rows("SELECT p.id, p.refunded_cents - p.amount_cents AS over, o.reference FROM payments p LEFT JOIN orders o ON o.id = p.order_id
                    WHERE p.environment = 'live' AND p.refunded_cents > p.amount_cents LIMIT 50") as $r) {
        $add('over_refunded', 'error', (string) ($r['reference'] ?? $r['id']), (int) $r['over'], 'A payment' . ($r['reference'] ? " for order {$r['reference']}" : '') . ' was refunded ' . format_zar((int) $r['over']) . ' more than its amount.');
    }
    foreach (rows("SELECT o.reference, SUM(r.amount_cents + r.fee_refund_cents) - o.total_cents AS over FROM refunds r JOIN orders o ON o.id = r.order_id
                    WHERE o.test = 0 AND r.status = 'completed' AND COALESCE(r.note, '') NOT LIKE 'system:overpayment:%' GROUP BY o.id HAVING SUM(r.amount_cents + r.fee_refund_cents) > o.total_cents LIMIT 50") as $r) {
        $add('over_refunded', 'error', $r['reference'], (int) $r['over'], "The refunds paid on order {$r['reference']} come to " . format_zar((int) $r['over']) . ' more than the order.');
    }
    // Organisers who hold more of the money than they are owed, and event
    // desk money that was not covered by what the event earned.
    foreach (rows("SELECT * FROM organisers WHERE id IN (SELECT DISTINCT substr(account, 11, instr(substr(account, 11), ':') - 1) FROM ledger_entries WHERE account LIKE 'organiser:%')") as $org) {
        $m = organiser_money($org);
        if ($m['totalCents'] < 0) $add('organiser_negative', 'action', (string) ($org['ref'] ?? $org['id']), -$m['totalCents'], "{$org['name']} owes TicketRoom " . format_zar(-$m['totalCents']) . ': the money they hold (desk top-ups, door sales) is more than their sales came to. Collect it, or hold it back from their next payout.');
        foreach ($m['events'] as $e) {
            $held = $e['desk_cash_cents'] + $e['desk_card_cents'];
            if ($e['balance_cents'] >= 0 || $held <= 0) continue;
            $short = min($held, -$e['balance_cents']);
            $vendors = (int) val("SELECT COALESCE(SUM(po.amount_cents),0) FROM payouts po JOIN vendors v ON v.id = po.vendor_id WHERE v.event_id = ? AND po.status IN ('requested','approved','paid')", [$e['event_id']]);
            $add('desk_not_netted', 'action', $e['title'], $short, "At {$e['title']} the organiser holds " . format_zar($held) . ' of top-up desk money, ' . format_zar($short) . ' more than the event earned them'
                . ($vendors ? ', while ' . format_zar($vendors) . ' of vendor settlements is paid or on its way from TicketRoom' : '') . '. Collect it from the organiser or take it off a settlement.');
        }
    }
    // Refunds made in the provider's own portal, not in TicketRoom.
    foreach (rows("SELECT event_id, received_at FROM webhook_events WHERE result = 'refund_unmatched' ORDER BY id DESC LIMIT 50") as $w) {
        $add('provider_refund', 'action', (string) $w['event_id'], 0, 'The payment provider reports a refund that was not made in TicketRoom (' . substr((string) $w['received_at'], 0, 10) . '). Find it in the audit log (payment.refund_unmatched) and record it against the order.');
    }
    return $out;
}

// ============================================================== organiser money
// What an organiser is owed, event by event. Money from an event can be paid
// out once the event is over and the hold period has passed, less refunds
// still being processed and payouts already asked for. $exceptPayout leaves
// one payout out of "asked for" (to check that payout itself still fits).
function organiser_money(array $org, ?string $exceptPayout = null): array
{
    $hold = (int) $org['payout_hold_days'];
    $now = microtime(true);
    $events = [];
    $releasable = 0;
    $eventDebt = 0;
    $total = 0;
    foreach (rows('SELECT id, title, status, ends_at FROM events WHERE organiser_id = ? ORDER BY ends_at', [$org['id']]) as $e) {
        // Cashless desk top-ups and walk-up ticket tenders are already in the
        // organiser's hands: they come off the amount TicketRoom owes them.
        $deskCash = ledger_balance("organiser:{$org['id']}:event:{$e['id']}:desk_cash");
        $deskCard = ledger_balance("organiser:{$org['id']}:event:{$e['id']}:desk_card");
        $doorCash = ledger_balance("organiser:{$org['id']}:event:{$e['id']}:door_cash");
        $doorCard = ledger_balance("organiser:{$org['id']}:event:{$e['id']}:door_card");
        $bal = -ledger_balance("organiser:{$org['id']}:event:{$e['id']}") - $deskCash - $deskCard - $doorCash - $doorCard;
        $ok = !in_array($e['status'], ['cancelled', 'suspended'], true) && to_unix($e['ends_at']) + $hold * 86400 < $now;
        $events[] = ['event_id' => $e['id'], 'title' => $e['title'], 'status' => $e['status'], 'ends_at' => $e['ends_at'], 'payout_hold_days' => $hold, 'balance_cents' => $bal, 'releasable' => $ok, 'code' => null,
            'desk_cash_cents' => $deskCash, 'desk_card_cents' => $deskCard, 'door_cash_cents' => $doorCash, 'door_card_cents' => $doorCard,
            'door_fees_due_cents' => max(0, -$bal)];
        $total += $bal;
        if ($bal < 0) $eventDebt += -$bal;
        if ($ok && $bal > 0) $releasable += $bal;
    }
    // Paid out by EFT, plus anything paid to TicketRoom from the balance (Promote).
    $paid = ledger_balance("organiser:{$org['id']}:payouts") + ledger_balance("organiser:{$org['id']}:deductions");
    $inFlight = (int) val("SELECT COALESCE(SUM(amount_cents),0) FROM payouts WHERE organiser_id = ? AND vendor_id IS NULL AND status IN ('requested','approved') AND id <> ?", [$org['id'], $exceptPayout ?? '']);
    // Refunds that will come off the organiser: a resale order's only when its event was cancelled (ledger_refund).
    $pendingRefunds = (int) val("SELECT COALESCE(SUM(r.amount_cents),0) FROM refunds r JOIN orders o ON o.id = r.order_id JOIN events e ON e.id = o.event_id
                                  WHERE e.organiser_id = ? AND o.test = 0 AND (o.resale_listing_id IS NULL OR r.kind = 'event_cancelled')
                                    AND COALESCE(r.note, '') NOT LIKE 'system:overpayment:%' AND r.status IN ('requested','processing','manual_pending','failed')", [$org['id']]);
    return ['events' => $events, 'totalCents' => $total - $paid, 'availableCents' => max(0, $releasable - $paid - $inFlight - $pendingRefunds - $eventDebt),
        'inFlightCents' => $inFlight, 'pendingRefundsCents' => $pendingRefunds, 'doorFeesDueCents' => $eventDebt,
        'promoteFromBalanceCents' => ledger_balance("organiser:{$org['id']}:deductions")];
}

// ============================================================== sandbox
// TicketRoom's own practice payment page (/pay). The buyer chooses what the
// "bank" says; the answer goes through exactly the same path as a real
// provider's notification, so the whole flow can be tried end to end with
// nothing real involved.
function sandbox_payment(string $paymentId, ?string $key): array
{
    $d = verify_link($key);
    if (!$d || ($d['p'] ?? '') !== $paymentId) throw not_found('This payment link has expired. Go back to your order and try again.');
    $p = row("SELECT * FROM payments WHERE id = ? AND provider = 'sandbox'", [$paymentId])
        ?: row("SELECT * FROM promotion_payments WHERE id = ? AND provider = 'sandbox'", [$paymentId]);
    if (!$p) throw not_found('Payment not found.');
    return $p;
}
function sandbox_answer(array $p, string $outcome): array
{
    if ($p['status'] !== 'pending') throw conflict('This payment is no longer open.', 'payment_closed');
    $result = payment_apply('sandbox', $p['provider_reference'], $outcome, $outcome === 'paid' ? (int) $p['amount_cents'] : 0);
    audit('payment.sandbox', ['entityType' => 'payment', 'entityId' => $p['id'], 'details' => ['outcome' => $outcome, 'result' => $result]]);
    return ['result' => $result];
}

// Before going live: test orders are cancelled, their tickets stop working and
// the places they held go back on sale. Test ledger entries stay, as history.
function clear_test_orders(array $actor): array
{
    return tx(function () use ($actor) {
        $now = now_iso();
        $freed = 0;
        foreach (rows("SELECT ticket_type_id, count(*) AS n FROM tickets WHERE test = 1 AND status IN ('valid','used') GROUP BY ticket_type_id") as $r) {
            q('UPDATE ticket_types SET quantity_sold = MAX(quantity_sold - ?, 0) WHERE id = ?', [(int) $r['n'], $r['ticket_type_id']]);
            $freed += (int) $r['n'];
        }
        q("UPDATE tickets SET status = 'revoked', revoked_reason = 'test order cleared', updated_at = ? WHERE test = 1 AND status IN ('valid','used')", [$now]);
        $orders = affected("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE test = 1 AND status <> 'cancelled'", [$now]);
        // Practice cashless money goes too (its test: ledger entries stay, as history).
        $wallets = affected('UPDATE cashless_wallets SET test_balance_cents = 0, updated_at = ? WHERE test_balance_cents > 0', [$now]);
        q("UPDATE wallet_topups SET status = 'cancelled' WHERE test = 1 AND status = 'pending'");
        // Practice cash-outs not paid yet are never paid out for real.
        q("UPDATE wallet_cashouts SET status = 'cancelled', note = 'test money cleared', updated_at = ? WHERE test = 1 AND status IN ('requested','approved_once','approved')", [$now]);
        // Test top-ups taken at an event's desk: if real cash or card money changed
        // hands while testing, the organiser has to give it back. Listed for the admin.
        $desk = array_map(fn($r) => ['event' => $r['title'], 'cents' => (int) $r['cents']], rows("SELECT e.title, SUM(d.amount_cents) AS cents FROM desk_topups d JOIN events e ON e.id = d.event_id
                                                                                                WHERE d.test = 1 AND d.status = 'confirmed' GROUP BY e.id ORDER BY e.title LIMIT 50"));
        // Practice resale listings close with their tickets.
        foreach (rows("SELECT * FROM resale_listings WHERE test = 1 AND status IN ('active','offered')") as $l) resale_close_listing($l, 'closed', 'test_cleared');
        // TEST Promote purchases stop too: no free promotion carries over into live.
        $promos = affected("UPDATE event_promotions SET status = 'cancelled', updated_at = ? WHERE test = 1 AND status IN ('pending_payment','active')", [$now]);
        audit('payments.test_cleared', ['actor' => $actor, 'details' => ['orders' => $orders, 'tickets' => $freed, 'wallets' => $wallets, 'promotions' => $promos, 'deskTopups' => $desk]]);
        return ['orders' => $orders, 'tickets' => $freed, 'wallets' => $wallets, 'promotions' => $promos, 'deskTopups' => $desk];
    });
}
