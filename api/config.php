<?php
/**
 * Ligcabho Le'Africa Residences, configuration.
 *
 * Everything an installation needs to change lives in this one file.
 */

return [
    /* ------------------------------------------------------------------
     * Database
     *
     * 'sqlite' needs nothing set up: the file is created on first run and
     * is the right choice on Afrihost shared hosting. Switch to 'mysql' if
     * you would rather use a cPanel database.
     * ------------------------------------------------------------------ */
    'db' => [
        'driver' => 'sqlite',
        'sqlite' => ['path' => __DIR__ . '/../data/ligcabho.sqlite'],
        'mysql'  => [
            'host'    => 'localhost',
            'name'    => 'ligcabho',
            'user'    => '',
            'pass'    => '',
            'charset' => 'utf8mb4',
        ],
    ],

    /* ------------------------------------------------------------------
     * Staff accounts created on first run.
     *
     * Passwords are hashed before they are stored and are never kept in
     * plain text. Every account is flagged to force a password change at
     * first sign-in.
     *
     * Roles: owner   — everything, including staff accounts
     *        manager — all records, may delete
     *        staff   — read records, set status, add notes
     * ------------------------------------------------------------------ */
    'staff' => [
        'temporary_password' => '#47LigcabhoRes',
        'accounts' => [
            ['email' => 'admin@ligcabhoresidences.co.za',      'name' => 'Administrator',      'role' => 'owner'],
            ['email' => 'ceo@ligcabhoresidences.co.za',        'name' => 'Chief Executive',    'role' => 'owner'],
            ['email' => 'e.director@ligcabhoresidences.co.za', 'name' => 'Executive Director', 'role' => 'owner'],
            ['email' => 'manager@ligcabhoresidences.co.za',    'name' => 'Residence Manager',  'role' => 'manager'],
            ['email' => 'support@ligcabhoresidences.co.za',    'name' => 'Student Support',    'role' => 'staff'],
        ],
    ],

    /* ------------------------------------------------------------------
     * Email
     *
     * These are only the starting values. Everything here can be changed
     * from the admin portal (Messages -> Setup) without touching this
     * file, and what is saved there wins.
     *
     * 'transport' is how mail leaves this server:
     *
     *   'auto'  use SMTP when a host is filled in below, else mail()
     *   'smtp'  sign in to a real mailbox and send through it  <- reliable
     *   'php'   hand it to the host's own mail server with mail()
     *
     * SMTP is worth the two minutes it takes to set up: mail() is refused
     * by many hosts, and what does get out is often filed as spam because
     * nothing proves the message came from this domain.
     *
     * For the domain's own mailbox (cPanel):
     *     host mail.ligcabhoresidences.co.za, port 587, security 'tls',
     *     username the full address, password the mailbox password.
     * For Gmail or Google Workspace:
     *     host smtp.gmail.com, port 587, security 'tls', username the
     *     address, password an APP PASSWORD (not the account password).
     *
     * Submissions are saved whether or not email gets out, and every
     * attempt is listed under Messages -> Delivery.
     * ------------------------------------------------------------------ */
    'mail' => [
        'enabled'   => true,
        'transport' => 'auto',
        'to'        => ['admin@ligcabhoresidences.co.za', 'ligcabho.residences@gmail.com'],
        'from'      => 'admin@ligcabhoresidences.co.za',
        'from_name' => "Ligcabho Le'Africa Residences",
        'reply_to'  => 'admin@ligcabhoresidences.co.za',
        'send_applicant_confirmation' => true,
        'smtp' => [
            'host'     => '',        // e.g. mail.ligcabhoresidences.co.za
            'port'     => 587,       // 587 with 'tls', 465 with 'ssl'
            'security' => 'tls',     // 'tls', 'ssl' or 'none'
            'username' => '',        // usually the full email address
            'password' => '',
            'verify'   => true,      // false if the host's certificate is for another name
            'timeout'  => 20,
            'helo'     => '',        // leave empty: the domain is used
        ],
    ],

    /* ------------------------------------------------------------------
     * The lease agreement
     * ------------------------------------------------------------------ */
    'lease' => [
        'landlord_entity'  => "LIGCABHO LE'AFRICA PROPERTIES",
        'landlord_address' => "No 11 Liza's Court, 28 Van Rensburg Street, Nelspruit 1200",
        'landlord_email'   => 'ligcabho.residences@gmail.com',
        'signatory_name'   => '',   // who counter-signs for the landlord
        'bank' => [
            'account_type'   => 'Business Account',
            'bank_name'      => 'FNB',
            'account_number' => '62653880552',
            'account_name'   => 'Ligcabho Properties',
        ],
    ],

    'site' => [
        'name'     => "Ligcabho Le'Africa Residences",
        'url'      => 'https://ligcabhoresidences.co.za',
        'phone'    => '013 752 4161',
        'whatsapp' => '27716401574',
        'address'  => "No 11 Liza's Court, 28 Van Rensburg Street, Nelspruit 1200",
    ],

    'uploads' => [
        'dir'       => __DIR__ . '/../data/uploads',
        'max_bytes' => 32 * 1024 * 1024,
        'allowed'   => ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'doc', 'docx'],
    ],

    'security' => [
        'session_name'       => 'ligcabho_admin',
        'session_lifetime'   => 60 * 60 * 8,   // 8 hours
        'max_login_attempts' => 8,             // per IP per window
        'login_window'       => 60 * 15,       // 15 minutes
    ],
];
