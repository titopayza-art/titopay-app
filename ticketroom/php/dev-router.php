<?php
// Local testing only (php -S … php/dev-router.php): behaves like public_html/.htaccess.
$path = rawurldecode((string) parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH));
$docroot = $_SERVER['DOCUMENT_ROOT'];
if (preg_match('#^/(data|tr-app|tr-data)(/|$)#', $path) || preg_match('#(^|/)\.|\.(md|sql|sqlite|zip|log)$|^/START-HERE\.txt$#', $path)) { http_response_code(403); return true; }
// Real files are served as they are, except inside api/ (all of it goes through api/index.php).
if (!str_starts_with($path, '/api') && $path !== '/' && is_file($docroot . $path)) return false;
require $docroot . '/index.php';
