<?php
/**
 * SeaGeek front controller. Every request that is not a static file comes here.
 */
declare(strict_types=1);

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
if (PHP_SAPI === 'cli-server' && $path !== '/' && is_file(__DIR__ . $path) && !preg_match('#^/(app|storage|vendor|docker|guides)/|\.(md|lock|json)$|^/cli\.php$#', $path)) {
    return false; // let the built-in server serve assets
}

require __DIR__ . '/app/bootstrap.php';

if (!installed()) {
    require APP_DIR . '/install.php';
    exit;
}

Shield::gate($path);
if (installed() && PHP_SAPI !== "cli") { try { Ops::watchdog(); } catch (Throwable) {} }

// Store webhooks (Shopify, WooCommerce, any platform) authenticate with the link and a signature, not an API key
if (preg_match('#^/api/v1/stores/hooks/([A-Za-z0-9_-]{16,64})$#', $path, $m)) {
    Stores::receive($m[1]);
}
if (str_starts_with($path, '/api/v1/')) {
    Gateway::handle($_SERVER['REQUEST_METHOD'] ?? 'GET', substr($path, 8));
}

header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: strict-origin-when-cross-origin');
header('X-Frame-Options: SAMEORIGIN');
header('Permissions-Policy: camera=(), microphone=(), geolocation=()');
header('Cross-Origin-Opener-Policy: same-origin');
if (str_starts_with(app_url(), 'https://')) header('Strict-Transport-Security: max-age=31536000; includeSubDomains');

start_session();
$router = require APP_DIR . '/routes.php';
$router->dispatch($_SERVER['REQUEST_METHOD'] ?? 'GET', $path);
