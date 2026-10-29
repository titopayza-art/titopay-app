<?php
/**
 * Front door.
 *
 * The pages are plain .html files and the server shows them without any PHP;
 * .htaccess maps the clean addresses (/sell, /events/…, /legal/privacy) to them.
 *
 * This file is here for hosts that send every request to index.php (or that
 * ignore .htaccess). It does the same job as the .htaccess rules, so the site
 * works either way. Uploading it also replaces any index.php left over from
 * an earlier site.
 */
declare(strict_types=1);

$root = __DIR__;
$requestUri = (string) ($_SERVER['REQUEST_URI'] ?? '/');
if (str_contains($requestUri, "\r") || str_contains($requestUri, "\n")) { http_response_code(400); exit; }
$https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['SERVER_PORT'] ?? '') === '443');
// This fallback is used on hosts that ignore .htaccess, so it must enforce the
// same transport guarantee without trusting a client-supplied Host header.
if (!$https) {
    $defaults = require $root . '/api/config.php';
    if (($defaults['security']['enforceHttps'] ?? true) === true) {
        $base = rtrim((string) ($defaults['baseUrl'] ?? 'https://ticketroom.co.za'), '/');
        $rawPath = (string) (parse_url($requestUri, PHP_URL_PATH) ?: '/');
        $rawQuery = parse_url($requestUri, PHP_URL_QUERY);
        header('Location: ' . $base . $rawPath . ($rawQuery !== null ? '?' . $rawQuery : ''), true, 308);
        exit;
    }
}
$path = rawurldecode((string) (parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH) ?: '/'));
$key = trim($path, '/');
// Backslashes and NUL bytes have no place in an address here; refusing them
// keeps every redirect below on this site (browsers read /\x.com as //x.com).
if (str_contains($path, '\\') || str_contains($path, "\0")) { http_response_code(400); exit; }
$qs = (string) ($_SERVER['QUERY_STRING'] ?? '');
$go = function (string $to, int $code = 301) use ($qs) { header('Location: ' . $to . ($qs !== '' ? "?$qs" : ''), true, $code); exit; };

// The API and uploaded images.
if ($key === 'api' || str_starts_with($key, 'api/') || str_starts_with($key, 'media/')) {
    require $root . '/api/index.php';
    exit;
}

// Private folders.
if (preg_match('#^(data|tr-app|tr-data)(/|$)#', $key)) { http_response_code(403); exit; }

// Addresses that moved.
if (preg_match('#^organiser(/.*)?$#', $key, $m)) $go('/organisers' . ($m[1] ?? ''));
if (in_array($key, ['privacy', 'cookies', 'terms'], true)) $go("/legal/$key");
if ($key === 'legal/refunds') $go('/legal/terms');
if ($key === 'browse') $go('/');

// One address per page: /sell, not /sell.html or /sell/.
if ($key === 'index.php' || $key === 'index.html' || $key === 'index') $go('/');
if (str_ends_with($key, '.html')) $go('/' . preg_replace('#(^|/)index$#', '', substr($key, 0, -5)));
if ($key !== '' && str_ends_with($path, '/') && !is_dir("$root/$key")) $go("/$key");

$file = match (true) {
    $key === '' => 'index.html',
    (bool) preg_match('#^events/[^/]+(/tickets)?$#', $key) => 'event.html',
    (bool) preg_match('#^orders/[^/]+$#', $key) => 'order.html',
    default => null,
};
$candidates = $file ? [$file] : [$key, "$key.html"];

$types = [
    'html' => 'text/html; charset=utf-8', 'css' => 'text/css; charset=utf-8', 'js' => 'application/javascript; charset=utf-8',
    'json' => 'application/json', 'webmanifest' => 'application/manifest+json', 'png' => 'image/png', 'jpg' => 'image/jpeg',
    'jpeg' => 'image/jpeg', 'webp' => 'image/webp', 'svg' => 'image/svg+xml', 'ico' => 'image/x-icon', 'txt' => 'text/plain; charset=utf-8',
];
// Maintenance mode (switched on in the admin portal, Site settings): visitors
// get the notice from the server, TicketRoom staff get the site. The admin
// portal itself stays open so staff can sign in and switch it off.
$maintenance = function () use ($root): ?string {
    if (!is_file("$root/maintenance.on")) return null;
    try {
        require_once $root . '/api/bootstrap.php';
        tr_load();
        load_session();
        $m = settings_all()['maintenance'];
        if (!$m['enabled']) { maintenance_flag_sync(false); return null; }
        return (user()['platformRoles'] ?? []) ? null : (string) $m['message'];
    } catch (Throwable $e) {
        return "We're making a few improvements to TicketRoom and will be back shortly.";
    }
};
$maintenancePage = function (string $message): void {
    http_response_code(503);
    header('Retry-After: 900');
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store');
    header("Content-Security-Policy: default-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'");
    $e = fn($s) => htmlspecialchars($s, ENT_QUOTES, 'UTF-8');
    echo '<!doctype html><html lang="en-ZA"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">'
        . '<title>TicketRoom | Back soon</title><link rel="icon" href="/assets/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/assets/tr.css"></head>'
        . '<body class="maint-on"><div class="maint-screen"><main class="maint-card"><img src="/assets/ticketroom-logo.png" alt="TicketRoom" width="520" height="260">'
        . '<h1>We\'ll be right back</h1><p>' . $e($message) . '</p><p class="small">Need help? <a href="/contact">Use our contact form</a>; we\'ll email you a reference.</p></main></div></body></html>';
};

foreach ($candidates as $rel) {
    $full = realpath("$root/$rel");
    if ($full === false || !is_file($full) || !str_starts_with($full, $root . DIRECTORY_SEPARATOR)) continue;
    // Check the real location too, so /./data/… or /x/../api/… cannot slip past.
    if (preg_match('#^(data|api|tr-app|tr-data)(/|$)#', substr($full, strlen($root) + 1))) break;
    $name = basename($full);
    $ext = strtolower(pathinfo($full, PATHINFO_EXTENSION));
    // Only web files: never PHP source, notes, archives or hidden files.
    if ($name[0] === '.' || !isset($types[$ext]) || $name === 'START-HERE.txt') break;
    if ($ext === 'html' && !in_array($name, ['admin.html', 'contact.html'], true) && ($msg = $maintenance()) !== null) { $maintenancePage($msg); exit; }
    header('Content-Type: ' . $types[$ext]);
    header('X-Content-Type-Options: nosniff');
    if ($ext === 'html') {
        header("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self' https://www.payfast.co.za https://sandbox.payfast.co.za; frame-ancestors 'none'");
        header('X-Frame-Options: DENY');
    }
    header('Cache-Control: ' . (in_array($ext, ['html', 'css', 'js', 'webmanifest'], true) ? 'no-cache' : 'public, max-age=86400'));
    readfile($full);
    exit;
}

http_response_code(404);
header('Content-Type: text/html; charset=utf-8');
readfile("$root/404.html");
