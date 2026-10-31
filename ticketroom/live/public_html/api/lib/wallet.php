<?php
// Apple Wallet and Google Wallet tickets.
//
// TicketRoom's own wallet accounts are set up in the admin portal
// (Integrations, Apple Wallet and Google Wallet): the Apple pass type ID, team
// ID and pass certificate (.p12 and its password), and the Google Wallet
// issuer ID and service account key (.json). The certificate, its password
// and the key are secrets: encrypted in the database and never sent back to a
// browser. Until one side is set up, its button does not show and its
// endpoints answer "not available". An older setup with files in the data
// folder's config.php ('wallet' => ['apple' => [...certFile, keyFile...]])
// still works.
//
// The barcode is the same signed ticket QR the gate scanner checks, including
// its version, so a wallet pass is exactly as safe as the ticket in the
// account. Every pass handed out is recorded (wallet_passes). A transfer,
// resale, reissue, refund or revocation voids it: Apple Wallet fetches the
// voided pass through the pass web service below (after a push), and the
// Google Wallet object is set to INACTIVE. The 'wallet-updates' job does both.
declare(strict_types=1);

const WALLET_NAVY = '#0B1D3F';      // --navy-900 in tr.css
const WALLET_AMBER = '#F2A93B';     // --amber-500
const WALLET_TZ = 'Africa/Johannesburg';
const WALLET_TERMS = 'This ticket lets one person in, once. If the ticket is transferred, resold, refunded or reissued, this pass stops working. The organiser\'s event terms and the TicketRoom terms apply.';
const WALLET_SUPPORT = 'hello@ticketroom.co.za';
const WALLET_FOOTER = 'Your event. Your ticket.';

// ---------------------------------------------------------------- settings
function wallet_file(?string $name): ?string
{
    if (!$name) return null;
    $f = str_contains($name, '/') ? $name : data_dir() . '/' . $name;
    return is_file($f) ? $f : null;
}
// The Apple settings with the certificate opened: ['passTypeId', 'teamId',
// 'cert' (PEM), 'key' (OpenSSLAsymmetricKey), 'chain' (PEM list)]. Throws a
// RuntimeException in plain words when something is missing or wrong.
function wallet_apple_creds(): array
{
    static $cache = [];
    $legacy = cfg('wallet.apple') ?: [];
    $passType = trim((string) (cfg('wallet.applePassTypeId') ?? ($legacy['passTypeId'] ?? '')));
    $team = trim((string) (cfg('wallet.appleTeamId') ?? ($legacy['teamId'] ?? '')));
    $blob = (string) (cfg('wallet.appleCertificate') ?? '');
    $pass = (string) (cfg('wallet.appleCertificatePassword') ?? '');
    $ck = sha1($passType . "\0" . $team . "\0" . $blob . "\0" . $pass);
    if (isset($cache[$ck])) return $cache[$ck];
    if ($passType === '') throw new RuntimeException('Enter the Apple pass type ID (it starts with pass.).');
    if (!preg_match('/^pass\.[A-Za-z0-9.-]+$/', $passType)) throw new RuntimeException('The pass type ID should look like pass.za.co.ticketroom.ticket. Copy it from the Apple Developer site.');
    if ($team === '') throw new RuntimeException('Enter the Apple team ID (10 letters and numbers).');
    if (!preg_match('/^[A-Z0-9]{10}$/', $team)) throw new RuntimeException('The team ID is 10 capital letters and numbers, shown under Membership on the Apple Developer site.');
    $cert = null; $key = null; $chain = [];
    if ($blob !== '') {
        if (str_contains($blob, '-----BEGIN')) {
            // PEM: certificate and private key in one file.
            $cert = preg_match('/-----BEGIN CERTIFICATE-----.+?-----END CERTIFICATE-----/s', $blob, $m) ? $m[0] : null;
            $key = openssl_pkey_get_private($blob, $pass) ?: null;
            if (!$cert) throw new RuntimeException('The certificate file has no certificate in it. Export the pass certificate from Keychain Access as a .p12 file.');
            if (!$key) throw new RuntimeException('The certificate file has no private key, or the password is wrong.');
        } else {
            $p12 = base64_decode($blob, true);
            if ($p12 === false || $p12 === '') throw new RuntimeException('The certificate file could not be read. Upload the .p12 file again.');
            $out = [];
            if (!openssl_pkcs12_read($p12, $out, $pass)) {
                $why = '';
                while ($e = openssl_error_string()) $why .= $e;
                throw new RuntimeException(stripos($why, 'unsupported') !== false || stripos($why, 'RC2') !== false
                    ? 'The .p12 file uses old encryption this server cannot open. In Keychain Access export it again (macOS 13 or later), or convert it as the help below explains.'
                    : 'The .p12 file could not be opened. Check the certificate password and that you exported the certificate together with its private key.');
            }
            $cert = $out['cert'] ?? null; $key = openssl_pkey_get_private($out['pkey'] ?? '') ?: null;
            foreach ($out['extracerts'] ?? [] as $x) $chain[] = $x;
            if (!$cert || !$key) throw new RuntimeException('The .p12 file has no private key in it. In Keychain Access, open the certificate\'s arrow and export the certificate together with its key.');
        }
    } elseif (wallet_file($legacy['certFile'] ?? null) && wallet_file($legacy['keyFile'] ?? null)) {
        $cert = (string) file_get_contents(wallet_file($legacy['certFile']));
        $key = openssl_pkey_get_private((string) file_get_contents(wallet_file($legacy['keyFile'])), (string) ($legacy['keyPassword'] ?? '')) ?: null;
        if (!$key) throw new RuntimeException('The pass key file in the data folder could not be opened. Check its password.');
    } else {
        throw new RuntimeException('Upload the Apple pass certificate (.p12).');
    }
    $x = openssl_x509_parse($cert);
    if (!$x) throw new RuntimeException('The certificate could not be read.');
    if (!openssl_x509_check_private_key($cert, $key)) throw new RuntimeException('The private key does not belong to this certificate. Export them together from Keychain Access.');
    $uid = (string) ($x['subject']['UID'] ?? '');
    if ($uid !== '' && $uid !== $passType) throw new RuntimeException("This certificate is for $uid, not $passType. Use the certificate made for this pass type ID, or change the pass type ID.");
    $ou = (string) ($x['subject']['OU'] ?? '');
    if ($ou !== '' && preg_match('/^[A-Z0-9]{10}$/', $ou) && $ou !== $team) throw new RuntimeException("This certificate belongs to team $ou, not $team. Check the team ID.");
    if (($x['validTo_time_t'] ?? 0) < time()) throw new RuntimeException('The pass certificate expired on ' . gmdate('j M Y', (int) $x['validTo_time_t']) . '. Make a new one on the Apple Developer site.');
    // Apple's WWDR intermediate (G4) is shipped with TicketRoom; a different one can be set in config.php.
    $wwdr = wallet_file($legacy['wwdrFile'] ?? null) ?? TR_APP . '/wallet/apple-wwdr-g4.pem';
    array_unshift($chain, (string) file_get_contents($wwdr));
    return $cache[$ck] = ['passTypeId' => $passType, 'teamId' => $team, 'cert' => $cert, 'key' => $key, 'chain' => array_values(array_unique(array_map('trim', $chain))), 'expires' => (int) ($x['validTo_time_t'] ?? 0)];
}
function wallet_google_creds(): array
{
    static $cache = [];
    $legacy = cfg('wallet.google') ?: [];
    $issuer = trim((string) (cfg('wallet.googleIssuerId') ?? ($legacy['issuerId'] ?? '')));
    $json = (string) (cfg('wallet.googleServiceAccount') ?? '');
    if ($json === '' && wallet_file($legacy['serviceAccountFile'] ?? null)) $json = (string) file_get_contents(wallet_file($legacy['serviceAccountFile']));
    $ck = sha1($issuer . "\0" . $json);
    if (isset($cache[$ck])) return $cache[$ck];
    if ($issuer === '') throw new RuntimeException('Enter the Google Wallet issuer ID (a long number from the Google Pay and Wallet Console).');
    if (!preg_match('/^\d{10,25}$/', $issuer)) throw new RuntimeException('The issuer ID is a long number, shown at the top of the Google Pay and Wallet Console.');
    if ($json === '') throw new RuntimeException('Upload the Google service account key (.json).');
    $sa = json_decode($json, true);
    if (!is_array($sa) || ($sa['type'] ?? '') !== 'service_account' || empty($sa['client_email']) || empty($sa['private_key'])) throw new RuntimeException('That is not a service account key. In Google Cloud, open the service account, Keys, Add key, JSON, and upload the file it downloads.');
    $key = openssl_pkey_get_private((string) $sa['private_key']);
    if (!$key) throw new RuntimeException('The private key in the service account file could not be read. Download a new key.');
    return $cache[$ck] = ['issuerId' => $issuer, 'email' => (string) $sa['client_email'], 'key' => $key, 'tokenUri' => (string) ($sa['token_uri'] ?? 'https://oauth2.googleapis.com/token')];
}
function wallet_apple_ready(): bool
{
    try { wallet_apple_creds(); return true; } catch (Throwable $e) { return false; }
}
function wallet_google_ready(): bool
{
    try { wallet_google_creds(); return true; } catch (Throwable $e) { return false; }
}

// ---------------------------------------------------------------- tickets
const WALLET_TICKET_SQL = "SELECT t.id, t.code, t.qr_version, t.status, t.holder_name, t.owner_user_id, t.test, t.order_id, tt.name AS ticket_type, tt.admits, o.reference, o.buyer_name,
                     e.id AS event_id, e.title, e.slug, e.venue_name, e.address, e.city, e.starts_at, e.ends_at, e.doors_open_at, e.is_test AS test_event, org.name AS organiser
                FROM tickets t JOIN ticket_types tt ON tt.id = t.ticket_type_id JOIN orders o ON o.id = t.order_id
                JOIN events e ON e.id = t.event_id JOIN organisers org ON org.id = e.organiser_id";

// The ticket with everything a pass shows; only for its owner, only while valid.
function wallet_ticket(array $u, string $ticketId): array
{
    $t = row(WALLET_TICKET_SQL . ' WHERE t.id = ? AND t.owner_user_id = ?', [$ticketId, $u['id']]);
    if (!$t) throw not_found('Ticket not found.');
    if ($t['status'] !== 'valid') throw conflict('Only valid tickets can be added to a wallet.', 'ticket_not_valid');
    return $t;
}
// The same from an order's private link (the order page, also for guests).
function wallet_order_ticket(array $o, string $ticketId): array
{
    $t = row(WALLET_TICKET_SQL . ' WHERE t.id = ? AND t.order_id = ? AND t.owner_user_id = ?', [$ticketId, $o['id'], $o['user_id']]);
    if (!$t) throw not_found('Ticket not found.');
    if ($t['status'] !== 'valid') throw conflict('Only valid tickets can be added to a wallet.', 'ticket_not_valid');
    return $t;
}
// The ticket TicketRoom uses for the admin's Test button and the previews.
function wallet_sample_ticket(): array
{
    return ['id' => 'sample-ticket', 'code' => 'KCS6V8DTNM', 'qr_version' => 1, 'status' => 'valid', 'holder_name' => 'Test Customer', 'owner_user_id' => '', 'test' => 0, 'order_id' => '',
        'ticket_type' => 'General admission', 'admits' => 1, 'reference' => 'TR-25T23BH8', 'buyer_name' => 'Test Customer', 'event_id' => 'sample-event',
        'title' => 'Harbour Lights Live: Summer Opening', 'slug' => 'harbour-lights-live-summer-opening', 'venue_name' => 'The Old Biscuit Hall', 'address' => '375 Albert Road, Woodstock',
        'city' => 'Cape Town', 'starts_at' => '2026-11-19T17:00:00.000Z', 'ends_at' => '2026-11-19T22:00:00.000Z', 'doors_open_at' => null, 'test_event' => 0, 'organiser' => 'Harbour Lights Productions'];
}
function wallet_sast(string $iso): DateTimeImmutable { return (new DateTimeImmutable($iso))->setTimezone(new DateTimeZone(WALLET_TZ)); }
function wallet_when(string $iso): string { return wallet_sast($iso)->format('D j M Y, H:i'); }
function wallet_place(array $t): string { return trim(implode(', ', array_filter([$t['venue_name'], $t['city']]))); }
function wallet_test_label(array $t): ?string
{
    if ((int) $t['test'] === 1) return 'TEST TICKET: not valid for entry';
    if ((int) $t['test_event'] === 1) return TEST_EVENT_LABEL . ': not a real event';
    return null;
}
function wallet_serial(array $t): string { return $t['id'] . '-' . (int) $t['qr_version']; }
function wallet_hex_rgb(string $hex): string { [$r, $g, $b] = sscanf($hex, '#%02x%02x%02x'); return "rgb($r,$g,$b)"; }
// What a pass shows changes when the ticket or event does; this tells the job when to push.
function wallet_fingerprint(array $t, bool $void): string
{
    return sha1(json_encode([$void, $t['code'], $t['qr_version'], $t['holder_name'], $t['ticket_type'], $t['title'], $t['venue_name'], $t['address'], $t['city'], $t['starts_at'], $t['ends_at'], $t['test'], $t['test_event']]));
}
// Records a pass handed out, so it can be voided or updated later.
function wallet_record(string $kind, string $serial, array $t): void
{
    if (str_starts_with($t['id'], 'sample-')) return;
    $now = now_iso();
    q('INSERT INTO wallet_passes (serial, kind, ticket_id, qr_version, snapshot, state, fingerprint, expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (serial) DO NOTHING',
        [$serial, $kind, $t['id'], (int) $t['qr_version'], json_encode($t, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), 'active', wallet_fingerprint($t, false), $t['ends_at'], $now, $now]);
}
// The pass as it should look now: the ticket's current details, or the
// details it was issued with, voided, once that version no longer gets in.
function wallet_pass_state(array $p): array
{
    $snap = json_decode((string) $p['snapshot'], true) ?: [];
    $t = row(WALLET_TICKET_SQL . ' WHERE t.id = ?', [$p['ticket_id']]);
    $void = !$t || $t['status'] === 'refunded' || $t['status'] === 'revoked' || (int) $t['qr_version'] !== (int) $p['qr_version'];
    return ['ticket' => $void ? $snap : $t, 'void' => $void];
}

// ---------------------------------------------------------------- Apple
function wallet_apple_token(string $serial): string { return substr(b64url(hmac_raw(key_hex('qr'), "W|$serial")), 0, 32); }
function wallet_web_service_url(): ?string
{
    $u = (string) (cfg('wallet.webServiceUrl') ?? (base_url() . '/api/passkit'));
    // Apple only talks to HTTPS (http is allowed for local development only).
    return str_starts_with($u, 'https://') || str_starts_with($u, 'http://localhost') || str_starts_with($u, 'http://127.0.0.1') ? $u : null;
}
// pass.json: the TicketRoom ticket, as Apple Wallet lays out an event ticket.
function wallet_pass_json(array $t, array $a, bool $void = false): array
{
    $starts = wallet_sast($t['starts_at']);
    $test = wallet_test_label($t);
    $back = [
        ['key' => 'order', 'label' => 'Order', 'value' => (string) $t['reference']],
        ['key' => 'code', 'label' => 'Ticket code', 'value' => (string) $t['code']],
        ['key' => 'venue', 'label' => 'Venue', 'value' => trim(implode(', ', array_filter([$t['venue_name'], $t['address'], $t['city']])))],
        ['key' => 'organiser', 'label' => 'Organiser', 'value' => (string) $t['organiser']],
        ['key' => 'terms', 'label' => 'Terms', 'value' => WALLET_TERMS . ' ' . base_url() . '/terms'],
        ['key' => 'support', 'label' => 'Help', 'value' => 'Email ' . WALLET_SUPPORT . ' or visit ' . base_url() . '/contact'],
        ['key' => 'footer', 'label' => 'TicketRoom', 'value' => WALLET_FOOTER],
    ];
    if ($test) array_unshift($back, ['key' => 'test', 'label' => 'TEST', 'value' => $test]);
    $aux = [['key' => 'type', 'label' => 'TICKET', 'value' => (string) $t['ticket_type']], ['key' => 'holder', 'label' => 'HOLDER', 'value' => (string) ($t['holder_name'] ?: $t['buyer_name'] ?: 'Not set')]];
    if ((int) ($t['admits'] ?? 1) > 1) $aux[] = ['key' => 'admits', 'label' => 'ADMITS', 'value' => (int) $t['admits'] . ' people'];
    $serial = wallet_serial($t);
    $pass = [
        'formatVersion' => 1,
        'passTypeIdentifier' => $a['passTypeId'],
        'teamIdentifier' => $a['teamId'],
        'serialNumber' => $serial,
        'organizationName' => 'TicketRoom',
        'description' => 'TicketRoom ticket for ' . $t['title'],
        'logoText' => 'TICKETROOM',
        'backgroundColor' => wallet_hex_rgb(WALLET_NAVY),
        'foregroundColor' => 'rgb(255,255,255)',
        'labelColor' => wallet_hex_rgb(WALLET_AMBER),
        'relevantDate' => $starts->format('Y-m-d\TH:i:sP'),
        'expirationDate' => wallet_sast($t['ends_at'])->modify('+6 hours')->format('Y-m-d\TH:i:sP'),
        'sharingProhibited' => true,
        'barcodes' => [['format' => 'PKBarcodeFormatQR', 'message' => qr_payload($t), 'messageEncoding' => 'iso-8859-1', 'altText' => (string) $t['code']]],
        'eventTicket' => [
            'headerFields' => [$test ? ['key' => 'test', 'label' => 'NOT VALID', 'value' => 'TEST'] : ['key' => 'date', 'label' => strtoupper($starts->format('D')), 'value' => $starts->format('j M')]],
            'primaryFields' => [['key' => 'event', 'label' => 'TICKETROOM TICKET', 'value' => (string) $t['title']]],
            'secondaryFields' => [['key' => 'when', 'label' => 'DATE', 'value' => $starts->format('D j M Y, H:i')], ['key' => 'where', 'label' => 'VENUE', 'value' => wallet_place($t)]],
            'auxiliaryFields' => $aux,
            'backFields' => $back,
        ],
    ];
    // Events have no map position yet; a venue with one gets lock-screen reminders there.
    if (isset($t['lat'], $t['lng']) && $t['lat'] !== null && $t['lng'] !== null) $pass['locations'] = [['latitude' => (float) $t['lat'], 'longitude' => (float) $t['lng'], 'relevantText' => 'Your ticket for ' . $t['title']]];
    if ($ws = wallet_web_service_url()) { $pass['webServiceURL'] = $ws; $pass['authenticationToken'] = wallet_apple_token($serial); }
    if ($void) $pass['voided'] = true;
    return $pass;
}
function wallet_apple_pkpass(array $t, bool $void = false): string
{
    $a = wallet_apple_creds();
    $files = ['pass.json' => json_encode(wallet_pass_json($t, $a, $void), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT)];
    foreach (['icon.png', 'icon@2x.png', 'icon@3x.png', 'logo.png', 'logo@2x.png', 'logo@3x.png'] as $img) $files[$img] = (string) file_get_contents(TR_APP . "/wallet/$img");
    $manifest = [];
    foreach ($files as $name => $data) $manifest[$name] = sha1($data);
    $files['manifest.json'] = json_encode($manifest, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    $files['signature'] = wallet_apple_sign($files['manifest.json'], $a);
    return wallet_zip($files);
}
// Detached PKCS#7 (CMS) signature of manifest.json in DER, with Apple's WWDR
// intermediate included, as Apple requires.
function wallet_apple_sign(string $manifest, array $a): string
{
    $tmp = sys_get_temp_dir() . '/trpass-' . bin2hex(random_bytes(8));
    $chainFile = "$tmp.c";
    file_put_contents("$tmp.m", $manifest);
    file_put_contents($chainFile, implode("\n", $a['chain']) . "\n");
    @chmod($chainFile, 0600);
    try {
        $ok = openssl_pkcs7_sign("$tmp.m", "$tmp.s", $a['cert'], $a['key'], [], PKCS7_BINARY | PKCS7_DETACHED, $chainFile);
        $smime = $ok ? (string) file_get_contents("$tmp.s") : '';
    } finally {
        @unlink("$tmp.m"); @unlink("$tmp.s"); @unlink($chainFile);
    }
    if (!$ok) throw new RuntimeException('Apple Wallet signing failed: check the pass certificate and its password.');
    // The S/MIME output carries the signature as base64 in its smime.p7s part.
    if (!preg_match('/filename="?smime\.p7s"?\s*\r?\n\r?\n([A-Za-z0-9+\/=\r\n]+)/', $smime, $m)) throw new RuntimeException('Apple Wallet signature not found.');
    return base64_decode(preg_replace('/\s+/', '', $m[1]));
}
// A plain (stored) zip, so no zip extension is needed on the host.
function wallet_zip(array $files): string
{
    $out = ''; $dir = ''; $n = 0;
    foreach ($files as $name => $data) {
        $crc = crc32($data); $len = strlen($data); $off = strlen($out);
        $head = pack('VvvvvvVVVvv', 0x04034b50, 20, 0, 0, 0, 0x21, $crc, $len, $len, strlen($name), 0);
        $out .= $head . $name . $data;
        $dir .= pack('VvvvvvvVVVvvvvvVV', 0x02014b50, 20, 20, 0, 0, 0, 0x21, $crc, $len, $len, strlen($name), 0, 0, 0, 0, 0, $off) . $name;
        $n++;
    }
    return $out . $dir . pack('VvvvvVVv', 0x06054b50, 0, 0, $n, $n, strlen($dir), strlen($out), 0);
}
// The download: a new pass for this ticket version, recorded for later voiding.
function wallet_apple_download(array $t): Response
{
    $body = wallet_apple_pkpass($t);
    wallet_record('apple', wallet_serial($t), $t);
    return raw_out($body, 'application/vnd.apple.pkpass', 200, ['Content-Disposition' => 'attachment; filename="ticketroom-' . $t['code'] . '.pkpass"', 'Cache-Control' => 'no-store']);
}

// ---------------------------------------------------------------- Google
function wallet_b64url(string $s): string { return rtrim(strtr(base64_encode($s), '+/', '-_'), '='); }
function wallet_google_ids(array $t, string $issuer): array
{
    $safe = fn($s) => preg_replace('/[^A-Za-z0-9._-]/', '_', $s);
    return ["$issuer." . $safe('event-' . $t['event_id']), "$issuer." . $safe('ticket-' . $t['id'] . '-' . (int) $t['qr_version'])];
}
function wallet_google_logo_url(): string { return base_url() . '/api/wallet/logo.png'; }
// The event (class) and ticket (object), as Google Wallet's EventTicket types.
function wallet_google_payload(array $t, string $issuer, bool $void = false): array
{
    [$classId, $objectId] = wallet_google_ids($t, $issuer);
    $text = fn($v) => ['defaultValue' => ['language' => 'en-ZA', 'value' => (string) $v]];
    $starts = wallet_sast($t['starts_at']);
    $test = wallet_test_label($t);
    $modules = [
        ['id' => 'order', 'header' => 'Order', 'body' => (string) $t['reference']],
        ['id' => 'when', 'header' => 'Date', 'body' => $starts->format('D j M Y, H:i') . ' (SAST)'],
        ['id' => 'terms', 'header' => 'Terms', 'body' => WALLET_TERMS . ' ' . base_url() . '/terms'],
        ['id' => 'support', 'header' => 'Help', 'body' => 'Email ' . WALLET_SUPPORT . '. ' . WALLET_FOOTER],
    ];
    if ($test) array_unshift($modules, ['id' => 'test', 'header' => 'TEST', 'body' => $test]);
    $logo = ['sourceUri' => ['uri' => wallet_google_logo_url()], 'contentDescription' => $text('TicketRoom')];
    return [
        'eventTicketClasses' => [[
            'id' => $classId, 'issuerName' => 'TicketRoom', 'reviewStatus' => 'UNDER_REVIEW',
            'eventName' => $text($t['title']),
            'eventId' => (string) $t['event_id'],
            'logo' => $logo,
            'venue' => ['name' => $text($t['venue_name']), 'address' => $text(trim(implode(', ', array_filter([$t['address'], $t['city']]))))],
            'dateTime' => ['start' => $starts->format('Y-m-d\TH:i:sP'), 'end' => wallet_sast($t['ends_at'])->format('Y-m-d\TH:i:sP')]
                + ($t['doors_open_at'] ? ['doorsOpen' => wallet_sast($t['doors_open_at'])->format('Y-m-d\TH:i:sP')] : []),
            'hexBackgroundColor' => WALLET_NAVY,
            'homepageUri' => ['uri' => base_url() . '/events/' . $t['slug'], 'description' => 'Event page'],
        ]],
        'eventTicketObjects' => [[
            'id' => $objectId, 'classId' => $classId, 'state' => $void ? 'INACTIVE' : 'ACTIVE',
            'ticketHolderName' => (string) ($t['holder_name'] ?: $t['buyer_name'] ?: ''),
            'ticketNumber' => (string) $t['code'],
            'ticketType' => $text($t['ticket_type']),
            'reservationInfo' => ['confirmationCode' => (string) $t['reference']],
            'barcode' => ['type' => 'QR_CODE', 'value' => qr_payload($t), 'alternateText' => (string) $t['code']],
            'hexBackgroundColor' => WALLET_NAVY,
            'logo' => $logo,
            'textModulesData' => $modules,
            'validTimeInterval' => ['end' => ['date' => wallet_sast($t['ends_at'])->modify('+6 hours')->format('Y-m-d\TH:i:sP')]],
        ]],
    ];
}
function wallet_jwt(array $claims, $key): string
{
    $header = wallet_b64url(json_encode(['alg' => 'RS256', 'typ' => 'JWT']));
    $body = wallet_b64url(json_encode($claims, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    if (!openssl_sign("$header.$body", $sig, $key, OPENSSL_ALGO_SHA256)) throw new RuntimeException('Google Wallet signing failed.');
    return "$header.$body." . wallet_b64url($sig);
}
function wallet_google_url(array $t): string
{
    $g = wallet_google_creds();
    $jwt = wallet_jwt(['iss' => $g['email'], 'aud' => 'google', 'typ' => 'savetowallet', 'iat' => time(), 'origins' => [base_url()], 'payload' => wallet_google_payload($t, $g['issuerId'])], $g['key']);
    wallet_record('google', wallet_google_ids($t, $g['issuerId'])[1], $t);
    return 'https://pay.google.com/gp/v/save/' . $jwt;
}
function wallet_google_api(): string { return rtrim((string) (cfg('wallet.googleApiBase') ?? 'https://walletobjects.googleapis.com'), '/'); }
// An access token for the Google Wallet API (to set voided tickets INACTIVE).
function wallet_google_token(array $g): string
{
    $now = time();
    $url = (string) (cfg('wallet.googleTokenUrl') ?? $g['tokenUri']);
    $jwt = wallet_jwt(['iss' => $g['email'], 'scope' => 'https://www.googleapis.com/auth/wallet_object.issuer', 'aud' => $url, 'iat' => $now, 'exp' => $now + 3600], $g['key']);
    $r = http_request('POST', $url, ['Content-Type' => 'application/x-www-form-urlencoded'], http_build_query(['grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer', 'assertion' => $jwt]), 10);
    if ($r['status'] !== 200 || empty($r['json']['access_token'])) throw new RuntimeException('Google did not accept the service account (' . ($r['json']['error_description'] ?? $r['json']['error'] ?? 'HTTP ' . $r['status']) . ').');
    return (string) $r['json']['access_token'];
}

// ---------------------------------------------------------------- updates
// The 'wallet-updates' job: passes whose ticket changed. Apple devices that
// registered the pass get a push and fetch it again (voided, or with the new
// details); Google objects of void tickets are set to INACTIVE.
function wallet_sync(): int
{
    $n = 0;
    $list = rows("SELECT * FROM wallet_passes WHERE state = 'active' AND expires_at > ? ORDER BY updated_at LIMIT 500", [iso_in(-2 * 86400)]);
    $gToken = null;
    foreach ($list as $p) {
        $s = wallet_pass_state($p);
        $fp = wallet_fingerprint($s['ticket'], $s['void']);
        if ($fp === $p['fingerprint']) continue;
        $n++;
        if ($p['kind'] === 'apple') {
            q('UPDATE wallet_passes SET state = ?, fingerprint = ?, updated_at = ? WHERE serial = ?', [$s['void'] ? 'void' : 'active', $fp, now_iso(), $p['serial']]);
            try { wallet_apns_push($p['serial']); } catch (Throwable $e) { error_log('[wallet] push: ' . integration_scrub($e->getMessage())); }
            continue;
        }
        // Google: only a void ticket needs a change (its details are fixed at saving).
        if ($s['void'] && !wallet_google_ready()) { $n--; continue; } // tried again once Google Wallet is set up
        if (!$s['void']) { q('UPDATE wallet_passes SET fingerprint = ?, updated_at = ? WHERE serial = ?', [$fp, now_iso(), $p['serial']]); continue; }
        try {
            $g = wallet_google_creds();
            $gToken ??= wallet_google_token($g);
            $r = http_request('PATCH', wallet_google_api() . '/walletobjects/v1/eventTicketObject/' . rawurlencode($p['serial']), ['Authorization' => "Bearer $gToken", 'Content-Type' => 'application/json'], json_encode(['state' => 'INACTIVE']), 10);
            // 404: the buyer never saved it to Google Wallet, so there is nothing to switch off.
            if ($r['status'] >= 300 && $r['status'] !== 404) throw new RuntimeException('Google Wallet answered HTTP ' . $r['status']);
            q("UPDATE wallet_passes SET state = 'void', fingerprint = ?, updated_at = ? WHERE serial = ?", [$fp, now_iso(), $p['serial']]);
        } catch (Throwable $e) {
            error_log('[wallet] google: ' . integration_scrub($e->getMessage()));
        }
    }
    // Personal details on passes are kept for a month after the event.
    $old = rows('SELECT serial FROM wallet_passes WHERE expires_at < ?', [iso_in(-30 * 86400)]);
    foreach ($old as $o) { q('DELETE FROM wallet_devices WHERE serial = ?', [$o['serial']]); q('DELETE FROM wallet_passes WHERE serial = ?', [$o['serial']]); }
    return $n;
}
// Apple Push Notification service: an empty push tells each device holding
// the pass to ask the web service for the new version. HTTP/2 with the pass
// certificate.
function wallet_apns_push(string $serial): int
{
    $devices = rows('SELECT DISTINCT push_token FROM wallet_devices WHERE serial = ?', [$serial]);
    if (!$devices || !function_exists('curl_init')) return 0;
    $a = wallet_apple_creds();
    $base = rtrim((string) (cfg('wallet.apnsBase') ?? 'https://api.push.apple.com'), '/');
    $tmp = sys_get_temp_dir() . '/trapns-' . bin2hex(random_bytes(8));
    openssl_pkey_export($a['key'], $keyPem);
    file_put_contents("$tmp.pem", $a['cert'] . "\n" . $keyPem);
    @chmod("$tmp.pem", 0600);
    $sent = 0;
    try {
        foreach ($devices as $d) {
            $c = curl_init("$base/3/device/" . rawurlencode($d['push_token']));
            curl_setopt_array($c, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => '{}', CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 10, CURLOPT_CONNECTTIMEOUT => 5,
                CURLOPT_HTTPHEADER => ['apns-topic: ' . $a['passTypeId'], 'apns-push-type: background', 'Content-Type: application/json'],
                CURLOPT_HTTP_VERSION => str_starts_with($base, 'http://') ? CURL_HTTP_VERSION_2_PRIOR_KNOWLEDGE : CURL_HTTP_VERSION_2_0,
                CURLOPT_SSLCERT => "$tmp.pem", CURLOPT_SSLKEY => "$tmp.pem"]);
            curl_exec($c);
            $status = (int) curl_getinfo($c, CURLINFO_HTTP_CODE);
            curl_close($c);
            if ($status === 200) $sent++;
            // 410: the device no longer has the pass.
            elseif ($status === 410) q('DELETE FROM wallet_devices WHERE push_token = ? AND serial = ?', [$d['push_token'], $serial]);
        }
    } finally {
        @unlink("$tmp.pem");
    }
    return $sent;
}

// ---------------------------------------------------------------- admin test
// Builds a sample pass on each configured side and says, in plain words, what
// is wrong. Nothing is saved and nothing is sent to a customer.
function wallet_selftest(): array
{
    $lines = []; $ok = true; $any = false;
    $hasApple = cfg('wallet.applePassTypeId') !== null || cfg('wallet.appleCertificate') !== null || cfg('wallet.apple') !== null;
    $hasGoogle = cfg('wallet.googleIssuerId') !== null || cfg('wallet.googleServiceAccount') !== null || cfg('wallet.google') !== null;
    if ($hasApple) {
        $any = true;
        try {
            $a = wallet_apple_creds();
            $zip = wallet_apple_pkpass(wallet_sample_ticket());
            $days = (int) floor(($a['expires'] - time()) / 86400);
            $lines[] = 'Apple Wallet: ready. A sample pass was built and signed (' . round(strlen($zip) / 1024) . ' KB). The certificate is valid until ' . gmdate('j M Y', $a['expires']) . ($days < 30 ? ", only $days days from now: renew it soon." : '.');
        } catch (Throwable $e) { $ok = false; $lines[] = 'Apple Wallet: ' . integration_scrub($e->getMessage()); }
    }
    if ($hasGoogle) {
        $any = true;
        try {
            $g = wallet_google_creds();
            wallet_jwt(['iss' => $g['email'], 'aud' => 'google', 'typ' => 'savetowallet', 'payload' => wallet_google_payload(wallet_sample_ticket(), $g['issuerId'])], $g['key']);
            wallet_google_token($g);
            $lines[] = "Google Wallet: ready. A sample ticket was signed and Google accepted the service account {$g['email']}. Make sure that account is added as a user in the Google Pay and Wallet Console.";
        } catch (Throwable $e) { $ok = false; $lines[] = 'Google Wallet: ' . integration_scrub($e->getMessage()); }
    }
    if (!$any) return ['ok' => false, 'detail' => 'Nothing is set up yet. Enter the Apple or Google details above and save first.'];
    return ['ok' => $ok, 'detail' => implode(' ', $lines), 'apple' => $hasApple ? wallet_apple_ready() : null, 'google' => $hasGoogle ? wallet_google_ready() : null];
}
