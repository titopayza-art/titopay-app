<?php
// A stand-in for Yoco's Checkout API and PayFast's validation endpoint, for
// the payment tests only. Run it with PHP's built-in server:
//   TARGET=http://127.0.0.1:8600 STATE=/tmp/mock php -S 127.0.0.1:8701 tests-ui/mocks/providers.php
// TARGET is the TicketRoom site under test: the addresses TicketRoom hands
// over (its public domain) are pointed back at it, like the real providers
// would reach the live site.
declare(strict_types=1);

$state = getenv('STATE') ?: sys_get_temp_dir() . '/tr-mock';
$target = rtrim(getenv('TARGET') ?: 'http://127.0.0.1:8600', '/');
if (!is_dir($state)) mkdir($state, 0777, true);
$file = "$state/state.json";
$load = fn() => is_file($file) ? json_decode((string) file_get_contents($file), true) : ['checkouts' => [], 'webhooks' => [], 'refunds' => [], 'idem' => []];
$save = function (array $s) use ($file) { file_put_contents($file, json_encode($s, JSON_PRETTY_PRINT)); };
$local = fn(string $url) => preg_replace('#^https?://[^/]+#', $target, $url);
$json = function ($v, int $code = 200) { http_response_code($code); header('Content-Type: application/json'); echo json_encode($v); exit; };
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$method = $_SERVER['REQUEST_METHOD'];
$raw = (string) file_get_contents('php://input');
$auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';

// Sends a signed Yoco webhook to every registered address.
$notify = function (array $s, array $evt) use ($local) {
    $body = json_encode($evt);
    foreach ($s['webhooks'] as $w) {
        $id = 'msg_' . bin2hex(random_bytes(6)); $ts = (string) time();
        $sig = base64_encode(hash_hmac('sha256', "$id.$ts.$body", base64_decode(substr($w['secret'], 6)), true));
        $c = curl_init($local($w['url']));
        curl_setopt_array($c, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json', "webhook-id: $id", "webhook-timestamp: $ts", "webhook-signature: v1,$sig"]]);
        $out = curl_exec($c);
        file_put_contents(getenv('STATE') . '/webhook.log', date('c') . ' ' . curl_getinfo($c, CURLINFO_HTTP_CODE) . " $out\n", FILE_APPEND);
        curl_close($c);
    }
};

// ---- "Your own identity provider" (FICA checks): numbers ending in 9 are
// declined, everything else verified. Needs the right key.
if ($path === '/kyc/check') {
    file_put_contents("$state/kyc.log", json_encode(['auth' => $auth, 'body' => $raw]) . "\n", FILE_APPEND);
    if ($auth !== 'Bearer kyc-test-key') $json(['error' => 'bad key'], 401);
    $in = json_decode($raw, true) ?: [];
    $no = (string) ($in['idNumber'] ?? '');
    $json(str_ends_with($no, '9') ? ['status' => 'declined', 'message' => 'Mock provider: no match', 'reference' => 'MOCK-1'] : ['status' => 'verified', 'message' => 'Mock provider: match', 'reference' => 'MOCK-2']);
}

// ---- "Your own SMS provider": records what arrives, answers like most SMS APIs.
if ($path === '/sms/send') {
    file_put_contents("$state/sms.log", json_encode(['auth' => $auth, 'type' => $_SERVER['CONTENT_TYPE'] ?? '', 'body' => $raw]) . "\n", FILE_APPEND);
    if ($auth !== 'Bearer sms-test-key') $json(['error' => 'bad key sms-test-key'], 401);
    $json(['id' => 'sms-' . bin2hex(random_bytes(4))]);
}

// ---- Yoco API (Bearer sk_test_… or sk_live_…)
if (str_starts_with($path, '/api/')) {
    if (!preg_match('/^Bearer sk_(test|live)_\w+$/', $auth)) $json(['message' => 'Unauthorised'], 401);
    $s = $load();
    if ($method === 'POST' && $path === '/api/webhooks') {
        $b = json_decode($raw, true);
        $w = ['id' => 'wh_' . bin2hex(random_bytes(4)), 'url' => $b['url'], 'secret' => 'whsec_' . base64_encode(random_bytes(24))];
        $s['webhooks'] = [$w];
        $save($s);
        $json($w, 201);
    }
    if ($method === 'POST' && $path === '/api/checkouts') {
        $idem = $_SERVER['HTTP_IDEMPOTENCY_KEY'] ?? '';
        if ($idem && isset($s['idem'][$idem])) $json($s['checkouts'][$s['idem'][$idem]], 200);
        $b = json_decode($raw, true);
        $id = 'ch_' . bin2hex(random_bytes(6));
        $host = 'http://' . $_SERVER['HTTP_HOST'];
        $s['checkouts'][$id] = ['id' => $id, 'status' => 'created', 'amount' => $b['amount'], 'currency' => $b['currency'], 'successUrl' => $b['successUrl'], 'cancelUrl' => $b['cancelUrl'],
            'metadata' => $b['metadata'] ?? [], 'redirectUrl' => "$host/pay/$id"];
        if ($idem) $s['idem'][$idem] = $id;
        $save($s);
        $json($s['checkouts'][$id], 201);
    }
    if (preg_match('#^/api/checkouts/([\w]+)/refund$#', $path, $m) && $method === 'POST') {
        $c = $s['checkouts'][$m[1]] ?? null;
        if (!$c || $c['status'] !== 'completed') $json(['description' => 'Checkout not paid'], 409);
        $b = json_decode($raw, true);
        $done = array_sum(array_column(array_filter($s['refunds'], fn($r) => $r['checkoutId'] === $m[1]), 'amount'));
        if ($done + $b['amount'] > $c['amount']) $json(['description' => 'Refund exceeds payment'], 422);
        $r = ['refundId' => 'rf_' . bin2hex(random_bytes(5)), 'checkoutId' => $m[1], 'amount' => $b['amount'], 'key' => $_SERVER['HTTP_IDEMPOTENCY_KEY'] ?? ''];
        $s['refunds'][] = $r;
        $save($s);
        $json(['refundId' => $r['refundId'], 'status' => 'succeeded'], 201);
    }
    if (preg_match('#^/api/checkouts/([\w]+)$#', $path, $m)) {
        $c = $s['checkouts'][$m[1]] ?? null;
        $c ? $json($c) : $json(['message' => 'Not found'], 404);
    }
    $json(['message' => 'Not found'], 404);
}

// ---- Yoco's hosted payment page (what the buyer sees)
if (preg_match('#^/pay/([\w]+)(/(complete|cancel))?$#', $path, $m)) {
    $s = $load();
    $c = $s['checkouts'][$m[1]] ?? null;
    if (!$c) { http_response_code(404); exit('No such checkout'); }
    if (($m[3] ?? '') === 'complete' && $method === 'POST') {
        if ($c['status'] !== 'completed') {
            $s['checkouts'][$m[1]]['status'] = 'completed';
            $save($s);
            if (empty($_POST['silent'])) $notify($s, ['id' => 'evt_' . bin2hex(random_bytes(6)), 'type' => 'payment.succeeded', 'payload' => ['amount' => $c['amount'], 'currency' => 'ZAR', 'metadata' => ['checkoutId' => $m[1]]]]);
        }
        header('Location: ' . $local($c['successUrl'])); exit;
    }
    if (($m[3] ?? '') === 'cancel') { header('Location: ' . $local($c['cancelUrl'])); exit; }
    header('Content-Type: text/html');
    echo '<!doctype html><title>Mock Yoco</title><h1>Pay R' . number_format($c['amount'] / 100, 2) . '</h1>'
        . "<form method=post action=/pay/{$m[1]}/complete><button>Pay now</button></form>"
        . "<form method=post action=/pay/{$m[1]}/complete><input type=hidden name=silent value=1><button>Pay (notification lost)</button></form>"
        . "<a href=/pay/{$m[1]}/cancel>Cancel</a>";
    exit;
}

// ---- PayFast: the server-to-server ITN check answers VALID for every ITN.
if ($path === '/eng/query/validate') { header('Content-Type: text/plain'); echo 'VALID'; exit; }
if ($path === '/eng/process') { header('Content-Type: text/plain'); echo 'PayFast mock'; exit; }
http_response_code(404);
echo 'mock: not found';
