<?php
declare(strict_types=1);

return [
    'admin_password_salt' => '',
    'admin_password_hash' => '',
    'admin_users' => [],
    'admin_pbkdf2_iterations' => 200000,
    'max_upload_bytes' => 4 * 1024 * 1024,
    'session_name' => 'titopay_admin_session',
    'mail_enabled' => true,
    'mail_from' => 'support@titopay.co.za',
    'mail_from_name' => 'TitoPay Support',
    // TitoPay Events ships as a public service page and waitlist first. The
    // financial functionality stays switched off until it is tested and
    // approved for production. Override any of these in config.local.php.
    'features' => [
        'events_public_page' => true,
        'events_waitlist' => true,
        'event_wallets' => false,
        'event_payments' => false,
        'event_rfid' => false,
        'event_vendor_settlements' => false,
    ],
    'database' => [
        'driver' => 'sqlite',
        'mysql' => [
            'host' => 'localhost',
            'database' => '',
            'username' => '',
            'password' => '',
            'charset' => 'utf8mb4',
        ],
    ],
];
