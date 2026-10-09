<?php
// Local testing only (php -S): emulates public_html/.htaccess.
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$docroot = $_SERVER['DOCUMENT_ROOT'];
if (preg_match('#^/(tr-app|tr-data)(/|$)#', $path) || preg_match('#\.(sqlite|txt|json|sql|log|zip)$#i', $path)) { http_response_code(404); return true; }
if ($path !== '/' && is_file($docroot . $path)) return false;
require $docroot . '/index.php';
