<?php
/**
 * Local dev router for the live package (ticketroom/live/public_html) under
 * PHP's built-in server:
 *
 *   php -S 127.0.0.1:8640 -t <dir>/public_html ticketroom/live/dev/router.php
 *
 * It mirrors public_html/.htaccess (and api/.htaccess) as closely as the
 * built-in server allows:
 *   - /data, /tr-app, /tr-data and /maintenance.on are 403
 *   - /api/* and /media/* run api/index.php; nothing else in api/ is served
 *   - maintenance mode sends pages through index.php
 *   - moved addresses, /x.html, /index and trailing slashes redirect (301)
 *   - /events/<slug>[/tickets] -> event.html, /orders/<ref> -> order.html
 *   - clean addresses serve the matching .html file
 *   - hidden files, .md/.sql/.sqlite/.zip/... and START-HERE.txt are 403
 *   - the .htaccess response headers (CSP, nosniff, no-store pages, ...)
 *
 * TLS is assumed to be terminated in front of the app, so HTTPS=on is set
 * for every request (setup.php and the enforceHttps redirect need it). The
 * www and force-https redirects are therefore not reproduced.
 *
 * The data folder is ../ticketroom-data next to the served folder, exactly as
 * on the host (see api/bootstrap.php tr_data_dir()).
 */
declare(strict_types=1);

$_SERVER['HTTPS'] = 'on';
$root = rtrim((string) $_SERVER['DOCUMENT_ROOT'], '/');
$uri = (string) ($_SERVER['REQUEST_URI'] ?? '/');
$path = rawurldecode((string) (parse_url($uri, PHP_URL_PATH) ?: '/'));
$qs = (string) ($_SERVER['QUERY_STRING'] ?? '');
$rel = ltrim($path, '/');

$always = function (): void {
    header('Strict-Transport-Security: max-age=31536000; includeSubDomains');
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: strict-origin-when-cross-origin');
    header('X-Frame-Options: DENY');
    header('Cross-Origin-Opener-Policy: same-origin');
    header('X-Permitted-Cross-Domain-Policies: none');
};
$deny = function (int $code = 403) use ($always): bool {
    http_response_code($code);
    $always();
    header('Content-Type: text/html; charset=utf-8');
    echo $code === 403 ? '<h1>Forbidden</h1>' : '<h1>Bad request</h1>';
    return true;
};
$redirect = function (string $to, int $code = 301) use ($qs): bool {
    header('Location: ' . $to . ($qs !== '' ? "?$qs" : ''), true, $code);
    return true;
};
$runPhp = function (string $file, string $scriptName) use ($root): bool {
    $_SERVER['SCRIPT_FILENAME'] = "$root/$file";
    $_SERVER['SCRIPT_NAME'] = $scriptName;
    $_SERVER['PHP_SELF'] = $scriptName;
    chdir(dirname("$root/$file"));
    require "$root/$file";
    return true;
};
$types = [
    'html' => 'text/html; charset=utf-8', 'css' => 'text/css; charset=utf-8', 'js' => 'application/javascript; charset=utf-8',
    'json' => 'application/json', 'webmanifest' => 'application/manifest+json', 'png' => 'image/png', 'jpg' => 'image/jpeg',
    'jpeg' => 'image/jpeg', 'webp' => 'image/webp', 'svg' => 'image/svg+xml', 'ico' => 'image/x-icon', 'txt' => 'text/plain; charset=utf-8',
];
$serve = function (string $file, int $status = 200) use ($root, $types, $always): bool {
    $name = basename($file);
    $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
    http_response_code($status);
    $always();
    header('Content-Type: ' . ($types[$ext] ?? 'application/octet-stream'));
    if (in_array($ext, ['html', 'css', 'js', 'webmanifest'], true)) header('Cache-Control: no-cache, must-revalidate');
    if (in_array($ext, ['png', 'jpg', 'jpeg', 'webp', 'svg', 'ico'], true)) header('Cache-Control: public, max-age=86400');
    if ($ext === 'html') {
        header("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self' https://www.payfast.co.za https://sandbox.payfast.co.za; frame-ancestors 'none'");
        header('Permissions-Policy: camera=(self), microphone=(), geolocation=(self), payment=()');
    }
    if ($name === 'login-otp.html') { header('Cache-Control: no-store'); header('Referrer-Policy: no-referrer'); }
    if (preg_match('/^(admin|login-otp|order|pay|pass|signin|organisers|pos)\.html$/', $name)) {
        header('Cache-Control: no-store, max-age=0');
        header('Pragma: no-cache');
        header('X-Robots-Tag: noindex, nofollow');
    }
    readfile("$root/$file");
    return true;
};

if (str_contains($path, "\0") || str_contains($path, '\\')) return $deny(400);

// --- Private folders
if (preg_match('#^(data|tr-app|tr-data)(/|$)#', $rel)) return $deny();

// --- Never served (FilesMatch): hidden files, notes, archives, databases.
foreach (explode('/', $rel) as $seg) if ($seg !== '' && $seg[0] === '.') return $deny();
if (preg_match('/\.(md|sql|sqlite|sqlite-wal|sqlite-shm|zip|tar|gz|bak|log|ini)$/i', $rel) || basename($rel) === 'START-HERE.txt') return $deny();

// --- The API (api/.htaccess sends everything in api/ to index.php).
if (preg_match('#^api(/|$)#', $rel) || str_starts_with($rel, 'media/')) {
    $always();
    return $runPhp('api/index.php', '/api/index.php');
}

// --- Maintenance mode
if ($rel === 'maintenance.on') return $deny();
if (is_file("$root/maintenance.on") && !preg_match('#^(admin|admin\.html|contact|contact\.html)$#', $rel)
    && preg_match('#^([^.]*|.*\.html)$#', $rel)) {
    return $runPhp('index.php', '/index.php');
}

// --- Addresses that moved
if (preg_match('#^organiser(/.*)?$#', $rel, $m)) return $redirect('/organisers' . ($m[1] ?? ''));
if (preg_match('#^(privacy|cookies|terms)/?$#', $rel, $m)) return $redirect('/legal/' . $m[1]);
if (preg_match('#^legal/refunds/?$#', $rel)) return $redirect('/legal/terms');
if (preg_match('#^browse/?$#', $rel)) return $redirect('/');

// --- One address per page: /index, /x.html and stray trailing slashes redirect.
if (preg_match('#^(.*/)?index(\.html)?$#i', $rel, $m)) return $redirect('/' . ($m[1] ?? ''));
if (preg_match('#^(.+?)\.html$#i', $rel, $m)) return $redirect('/' . $m[1]);
if ($rel !== '' && str_ends_with($rel, '/') && !is_dir("$root/$rel")) return $redirect('/' . rtrim($rel, '/'));

// Event and order pages share one page each.
if (preg_match('#^events/[^/]+(/tickets)?$#', $rel)) return $serve('event.html');
if (preg_match('#^orders/[^/]+$#', $rel)) return $serve('order.html');

// Root-level PHP scripts (setup.php, deploy-check.php, set-password.php, index.php).
if (preg_match('#^[A-Za-z0-9_-]+\.php$#', $rel) && is_file("$root/$rel")) return $runPhp($rel, "/$rel");

// DirectoryIndex index.html; Options -Indexes.
if ($rel === '' || is_dir("$root/$rel")) {
    $dir = trim($rel, '/');
    $index = ($dir === '' ? '' : "$dir/") . 'index.html';
    return is_file("$root/$index") ? $serve($index) : $deny();
}
if (is_file("$root/$rel")) return $serve($rel);
if (is_file("$root/$rel.html")) return $serve("$rel.html");

// ErrorDocument 404 /404.html
return $serve('404.html', 404);
