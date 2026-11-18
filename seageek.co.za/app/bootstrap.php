<?php
declare(strict_types=1);

$autoload = __DIR__ . '/../vendor/autoload.php';
if (is_file($autoload)) require $autoload;

require __DIR__ . '/core.php';
require __DIR__ . '/auth.php';
require __DIR__ . '/schema.php';
require __DIR__ . '/catalog.php';
require __DIR__ . '/partners.php';
require __DIR__ . '/billing.php';
require __DIR__ . '/ai.php';
require __DIR__ . '/desk.php';
require __DIR__ . '/gateway.php';

date_default_timezone_set('UTC');
mb_internal_encoding('UTF-8');

$debug = (bool) config('debug', false);
ini_set('display_errors', $debug ? '1' : '0');
error_reporting(E_ALL);
set_exception_handler(function (Throwable $e) use ($debug) {
    log_line('error', $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    if (PHP_SAPI === 'cli') { fwrite(STDERR, $e . "\n"); exit(1); }
    http_response_code(500);
    echo $debug ? '<pre>' . htmlspecialchars((string) $e) . '</pre>' : 'Something went wrong. It has been logged and we will look into it.';
});
