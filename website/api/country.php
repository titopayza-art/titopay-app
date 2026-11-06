<?php
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, private');
header('X-Content-Type-Options: nosniff');
if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    http_response_code(405);
    header('Allow: GET');
    echo json_encode(['country' => null]);
    exit;
}
// Use country information supplied by the host's local GeoIP module first.
// Do not store addresses, query a third-party lookup service or use this for eligibility.
$country = strtoupper((string)($_SERVER['GEOIP_COUNTRY_CODE'] ?? $_SERVER['MM_COUNTRY_CODE'] ?? ''));
function country_in_network(string $address, string $network): bool {
    [$base, $prefix] = explode('/', $network, 2);
    $ip = @inet_pton($address);
    $net = @inet_pton($base);
    if ($ip === false || $net === false || strlen($ip) !== strlen($net)) return false;
    $bits = (int)$prefix;
    $bytes = intdiv($bits, 8);
    if (substr($ip, 0, $bytes) !== substr($net, 0, $bytes)) return false;
    $remaining = $bits % 8;
    return $remaining === 0 || ((ord($ip[$bytes]) ^ ord($net[$bytes])) & (0xff << (8 - $remaining))) === 0;
}
if ($country === '') {
    // Cloudflare ranges verified against cloudflare.com/ips-v4/ and ips-v6/.
    // Only accept the country header when the connecting proxy is trusted.
    $ranges = ['173.245.48.0/20','103.21.244.0/22','103.22.200.0/22','103.31.4.0/22','141.101.64.0/18','108.162.192.0/18','190.93.240.0/20','188.114.96.0/20','197.234.240.0/22','198.41.128.0/17','162.158.0.0/15','104.16.0.0/13','104.24.0.0/14','172.64.0.0/13','131.0.72.0/22','2400:cb00::/32','2606:4700::/32','2803:f800::/32','2405:b500::/32','2405:8100::/32','2a06:98c0::/29','2c0f:f248::/32'];
    $peer = (string)($_SERVER['CONN_REMOTE_ADDR'] ?? $_SERVER['REMOTE_ADDR'] ?? '');
    foreach ($ranges as $range) {
        if (country_in_network($peer, $range)) {
            $country = strtoupper((string)($_SERVER['HTTP_CF_IPCOUNTRY'] ?? ''));
            break;
        }
    }
}
if (!preg_match('/^[A-Z]{2}$/D', $country) || in_array($country, ['XX','T1'], true)) $country = null;
echo json_encode(['country' => $country]);
