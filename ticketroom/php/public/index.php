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
    (bool) preg_match('#^events/[^/]+$#', $key) => 'event.html',
    (bool) preg_match('#^orders/[^/]+$#', $key) => 'order.html',
    default => null,
};
$candidates = $file ? [$file] : [$key, "$key.html"];

$types = [
    'html' => 'text/html; charset=utf-8', 'css' => 'text/css; charset=utf-8', 'js' => 'application/javascript; charset=utf-8',
    'json' => 'application/json', 'webmanifest' => 'application/manifest+json', 'png' => 'image/png', 'jpg' => 'image/jpeg',
    'jpeg' => 'image/jpeg', 'webp' => 'image/webp', 'svg' => 'image/svg+xml', 'ico' => 'image/x-icon', 'txt' => 'text/plain; charset=utf-8',
];
foreach ($candidates as $rel) {
    $full = realpath("$root/$rel");
    if ($full === false || !is_file($full) || !str_starts_with($full, $root . DIRECTORY_SEPARATOR)) continue;
    // Check the real location too, so /./data/… or /x/../api/… cannot slip past.
    if (preg_match('#^(data|api|tr-app|tr-data)(/|$)#', substr($full, strlen($root) + 1))) break;
    $name = basename($full);
    $ext = strtolower(pathinfo($full, PATHINFO_EXTENSION));
    // Only web files: never PHP source, notes, archives or hidden files.
    if ($name[0] === '.' || !isset($types[$ext]) || $name === 'START-HERE.txt') break;
    header('Content-Type: ' . $types[$ext]);
    header('X-Content-Type-Options: nosniff');
    if ($ext === 'html') {
        header("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
        header('X-Frame-Options: DENY');
    }
    header('Cache-Control: ' . (in_array($ext, ['html', 'css', 'js', 'webmanifest'], true) ? 'no-cache' : 'public, max-age=86400'));
    readfile($full);
    exit;
}

http_response_code(404);
header('Content-Type: text/html; charset=utf-8');
readfile("$root/404.html");
