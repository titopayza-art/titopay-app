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

if (str_starts_with($path, '/api/v1/')) {
    Gateway::handle($_SERVER['REQUEST_METHOD'] ?? 'GET', substr($path, 8));
}

header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: strict-origin-when-cross-origin');
header('X-Frame-Options: SAMEORIGIN');
header('Permissions-Policy: camera=(), microphone=(), geolocation=()');

start_session();
$router = require APP_DIR . '/routes.php';
$router->dispatch($_SERVER['REQUEST_METHOD'] ?? 'GET', $path);
