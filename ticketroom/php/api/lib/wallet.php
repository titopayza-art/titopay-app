<?php
// Apple Wallet and Google Wallet tickets.
//
// Both need TicketRoom's own accounts, set in the data folder's config.php:
//   'wallet' => [
//     'apple' => ['passTypeId' => 'pass.za.co.ticketroom', 'teamId' => 'ABCDE12345',
//                 'certFile' => 'apple-pass-cert.pem', 'keyFile' => 'apple-pass-key.pem',
//                 'keyPassword' => '', 'wwdrFile' => 'apple-wwdr.pem'],
//     'google' => ['issuerId' => '3388000000012345678', 'serviceAccountFile' => 'google-wallet.json'],
//   ],
// File names are relative to the data folder. Until they are set, the
// buttons do not show and these endpoints answer "not available".
// The barcode is the same signed ticket QR the gate scanner checks, so a
// wallet pass is exactly as safe as the ticket in the account.
declare(strict_types=1);

function wallet_file(?string $name): ?string
{
    if (!$name) return null;
    $f = str_contains($name, '/') ? $name : data_dir() . '/' . $name;
    return is_file($f) ? $f : null;
}
function wallet_apple_ready(): bool
{
    $a = cfg('wallet.apple') ?: [];
    return !empty($a['passTypeId']) && !empty($a['teamId']) && wallet_file($a['certFile'] ?? null) && wallet_file($a['keyFile'] ?? null) && wallet_file($a['wwdrFile'] ?? null);
}
function wallet_google_ready(): bool
{
    $g = cfg('wallet.google') ?: [];
    return !empty($g['issuerId']) && wallet_file($g['serviceAccountFile'] ?? null) !== null;
}

// The ticket with everything a pass shows; only for its owner.
function wallet_ticket(array $u, string $ticketId): array
{
    $t = row("SELECT t.id, t.code, t.qr_version, t.status, t.holder_name, tt.name AS ticket_type, o.reference,
                     e.title, e.slug, e.venue_name, e.address, e.city, e.starts_at, e.ends_at, e.doors_open_at, org.name AS organiser
                FROM tickets t JOIN ticket_types tt ON tt.id = t.ticket_type_id JOIN orders o ON o.id = t.order_id
                JOIN events e ON e.id = t.event_id JOIN organisers org ON org.id = e.organiser_id
               WHERE t.id = ? AND t.owner_user_id = ?", [$ticketId, $u['id']]);
    if (!$t) throw not_found('Ticket not found.');
    if ($t['status'] !== 'valid') throw conflict('Only valid tickets can be added to a wallet.', 'ticket_not_valid');
    return $t;
}
function wallet_when(string $iso): string
{
    return (new DateTimeImmutable($iso))->setTimezone(new DateTimeZone('Africa/Johannesburg'))->format('D j M Y, H:i');
}

// ---------------------------------------------------------------- Apple
function wallet_apple_pkpass(array $t): string
{
    $a = cfg('wallet.apple');
    $pass = [
        'formatVersion' => 1,
        'passTypeIdentifier' => $a['passTypeId'],
        'teamIdentifier' => $a['teamId'],
        'serialNumber' => $t['id'] . '-' . $t['qr_version'],
        'organizationName' => 'TicketRoom',
        'description' => 'Ticket for ' . $t['title'],
        'logoText' => 'TicketRoom',
        'foregroundColor' => 'rgb(255,255,255)',
        'backgroundColor' => 'rgb(2,28,65)',
        'labelColor' => 'rgb(242,169,59)',
        'relevantDate' => gmdate('Y-m-d\TH:i:s\Z', (int) to_unix($t['starts_at'])),
        'expirationDate' => gmdate('Y-m-d\TH:i:s\Z', (int) to_unix($t['ends_at']) + 6 * 3600),
        'barcodes' => [['format' => 'PKBarcodeFormatQR', 'message' => qr_payload($t), 'messageEncoding' => 'iso-8859-1', 'altText' => $t['code']]],
        'eventTicket' => [
            'primaryFields' => [['key' => 'event', 'label' => 'EVENT', 'value' => $t['title']]],
            'secondaryFields' => [['key' => 'when', 'label' => 'WHEN', 'value' => wallet_when($t['starts_at'])], ['key' => 'where', 'label' => 'WHERE', 'value' => $t['venue_name'] . ', ' . $t['city']]],
            'auxiliaryFields' => [['key' => 'type', 'label' => 'TICKET', 'value' => $t['ticket_type']], ['key' => 'holder', 'label' => 'NAME', 'value' => (string) ($t['holder_name'] ?: '')]],
            'backFields' => [
                ['key' => 'code', 'label' => 'Ticket code', 'value' => $t['code']],
                ['key' => 'order', 'label' => 'Order', 'value' => $t['reference']],
                ['key' => 'organiser', 'label' => 'Organiser', 'value' => $t['organiser']],
                ['key' => 'address', 'label' => 'Venue', 'value' => trim(implode(', ', array_filter([$t['venue_name'], $t['address'], $t['city']])))],
                ['key' => 'help', 'label' => 'Help', 'value' => 'This ticket gets one person in, once. If you transfer it, this pass stops working and the new holder gets their own. Questions: hello@ticketroom.co.za'],
            ],
        ],
    ];
    $files = ['pass.json' => json_encode($pass, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)];
    foreach (['icon.png', 'icon@2x.png', 'icon@3x.png', 'logo.png', 'logo@2x.png', 'logo@3x.png'] as $img) $files[$img] = (string) file_get_contents(TR_APP . "/wallet/$img");
    $manifest = [];
    foreach ($files as $name => $data) $manifest[$name] = sha1($data);
    $files['manifest.json'] = json_encode($manifest, JSON_UNESCAPED_SLASHES);
    $files['signature'] = wallet_apple_sign($files['manifest.json'], $a);
    return wallet_zip($files);
}
// Detached PKCS#7 signature of manifest.json, as Apple requires.
function wallet_apple_sign(string $manifest, array $a): string
{
    $tmp = sys_get_temp_dir() . '/trpass-' . bin2hex(random_bytes(6));
    file_put_contents("$tmp.m", $manifest);
    $ok = openssl_pkcs7_sign("$tmp.m", "$tmp.s", 'file://' . wallet_file($a['certFile']), ['file://' . wallet_file($a['keyFile']), (string) ($a['keyPassword'] ?? '')], [], PKCS7_BINARY | PKCS7_DETACHED, wallet_file($a['wwdrFile']));
    $smime = $ok ? (string) file_get_contents("$tmp.s") : '';
    @unlink("$tmp.m"); @unlink("$tmp.s");
    if (!$ok) throw new RuntimeException('Apple Wallet signing failed: check the pass certificate, key and password.');
    // The S/MIME output carries the signature as base64 after the last blank line of the signature part.
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

// ---------------------------------------------------------------- Google
function wallet_b64url(string $s): string { return rtrim(strtr(base64_encode($s), '+/', '-_'), '='); }
function wallet_google_url(array $t): string
{
    $g = cfg('wallet.google');
    $sa = json_decode((string) file_get_contents(wallet_file($g['serviceAccountFile'])), true);
    if (empty($sa['client_email']) || empty($sa['private_key'])) throw new RuntimeException('The Google Wallet service account file is not valid.');
    $issuer = preg_replace('/[^0-9]/', '', (string) $g['issuerId']);
    $safe = fn($s) => preg_replace('/[^A-Za-z0-9._-]/', '_', $s);
    $classId = "$issuer." . $safe('event-' . $t['slug']);
    $objectId = "$issuer." . $safe('ticket-' . $t['id'] . '-' . $t['qr_version']);
    $text = fn($v) => ['defaultValue' => ['language' => 'en-ZA', 'value' => $v]];
    $claims = [
        'iss' => $sa['client_email'], 'aud' => 'google', 'typ' => 'savetowallet', 'iat' => time(),
        'origins' => [base_url()],
        'payload' => [
            'eventTicketClasses' => [[
                'id' => $classId, 'issuerName' => 'TicketRoom', 'reviewStatus' => 'UNDER_REVIEW',
                'eventName' => $text($t['title']),
                'venue' => ['name' => $text($t['venue_name']), 'address' => $text(trim(implode(', ', array_filter([$t['address'], $t['city']]))))],
                'dateTime' => ['start' => gmdate('c', (int) to_unix($t['starts_at'])), 'end' => gmdate('c', (int) to_unix($t['ends_at']))],
                'hexBackgroundColor' => '#021C41',
            ]],
            'eventTicketObjects' => [[
                'id' => $objectId, 'classId' => $classId, 'state' => 'ACTIVE',
                'ticketHolderName' => (string) ($t['holder_name'] ?: ''),
                'ticketNumber' => $t['code'],
                'ticketType' => $text($t['ticket_type']),
                'barcode' => ['type' => 'QR_CODE', 'value' => qr_payload($t), 'alternateText' => $t['code']],
                'validTimeInterval' => ['end' => ['date' => gmdate('c', (int) to_unix($t['ends_at']) + 6 * 3600)]],
            ]],
        ],
    ];
    $header = wallet_b64url(json_encode(['alg' => 'RS256', 'typ' => 'JWT']));
    $body = wallet_b64url(json_encode($claims, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    if (!openssl_sign("$header.$body", $sig, $sa['private_key'], OPENSSL_ALGO_SHA256)) throw new RuntimeException('Google Wallet signing failed.');
    return 'https://pay.google.com/gp/v/save/' . "$header.$body." . wallet_b64url($sig);
}
