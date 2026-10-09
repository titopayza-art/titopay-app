<?php
/**
 * QR encoder self-check.
 *   php php/tests/qr_check.php           -> runs PHP-side checks (version, SVG, timing)
 *   php php/tests/qr_check.php --json    -> prints JSON test cases for qr_check.js
 * Full verification: node php/tests/qr_check.js  (calls this script with --json and decodes with jsQR)
 */
require __DIR__ . '/../app/lib/qr.php';

function qc_ticket(int $seed): string
{
    mt_srand($seed);
    $a1 = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
    $a2 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
    $s = 'TR1.';
    for ($i = 0; $i < 10; $i++) $s .= $a1[mt_rand(0, strlen($a1) - 1)];
    $s .= '.' . mt_rand(1, [9, 99, 999][$seed % 3]) . '.';
    for ($i = 0; $i < 22; $i++) $s .= $a2[mt_rand(0, strlen($a2) - 1)];
    return $s;
}

function qc_cases(): array
{
    $cases = [];
    for ($i = 0; $i < 60; $i++) {
        $cases[] = ['data' => qc_ticket($i), 'ecc' => ['L', 'M', 'Q', 'H'][$i % 4]];
        $cases[] = ['data' => qc_ticket(1000 + $i), 'ecc' => 'M'];
    }
    $fixed = ['A', 'hello', 'Ticket – Soweto ✓', 'https://ticketroom.example/t/TR1.ABCDEFGHJK.12.abcdefghijklmnopqrstuv',
        'https://example.com/?q=a%20b&x=1#frag', 'Ünïcødé 日本語 🎟️', "line1\nline2\ttab"];
    foreach ($fixed as $f) foreach (['L', 'M', 'Q', 'H'] as $e) $cases[] = ['data' => $f, 'ecc' => $e];
    mt_srand(42);
    $chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .:/-_?=&';
    foreach (['L', 'M', 'Q', 'H'] as $e) {
        for ($len = 1; $len <= 300; $len += ($len < 60 ? 1 : 7)) {
            $s = '';
            for ($i = 0; $i < $len; $i++) $s .= $chars[mt_rand(0, strlen($chars) - 1)];
            $cases[] = ['data' => $s, 'ecc' => $e];
        }
    }
    // Some longer ones for higher versions (ECC L up to ~v20+).
    foreach ([400, 600, 800] as $len) $cases[] = ['data' => str_repeat('TicketRoom-', intdiv($len, 11) + 1), 'ecc' => 'L'];
    return $cases;
}

if (in_array('--json', $argv, true)) {
    $out = [];
    foreach (qc_cases() as $c) {
        $m = tr_qr_matrix($c['data'], $c['ecc']);
        $rows = array_map(fn($r) => implode('', array_map(fn($b) => $b ? '1' : '0', $r)), $m);
        $out[] = ['data_b64' => base64_encode($c['data']), 'ecc' => $c['ecc'], 'matrix' => $rows];
    }
    echo json_encode($out);
    exit(0);
}

$fail = 0;
$check = function (bool $ok, string $msg) use (&$fail) { echo ($ok ? 'PASS ' : 'FAIL ') . $msg . "\n"; if (!$ok) $fail++; };

// Version selection: 42 bytes at M -> v3 (29), 43..45 bytes -> v4 (33), 62 -> v4, 63 -> v5.
$check(count(tr_qr_matrix(str_repeat('x', 45), 'M')) === 33, '45-byte payload at M is version 4 (33x33)');
$t = qc_ticket(7);
$check(count(tr_qr_matrix($t, 'M')) === (strlen($t) <= 42 ? 29 : 33), "ticket payload (" . strlen($t) . " bytes) version");
$check(count(tr_qr_matrix(str_repeat('x', 42), 'M')) === 29, '42 bytes at M is version 3');
$check(count(tr_qr_matrix(str_repeat('x', 62), 'M')) === 33, '62 bytes at M is version 4');
$check(count(tr_qr_matrix(str_repeat('x', 63), 'M')) === 37, '63 bytes at M is version 5');
$check(count(tr_qr_matrix(str_repeat('x', 17), 'L')) === 21, '17 bytes at L is version 1');
$check(count(tr_qr_matrix(str_repeat('x', 7), 'H')) === 21, '7 bytes at H is version 1');

// SVG well-formedness.
foreach (['', 'A', $t, 'Ticket – Soweto ✓ <&>"'] as $s) {
    $svg = tr_qr_svg($s, ['margin' => 2]);
    $x = @simplexml_load_string($svg);
    $ok = $x !== false && $x->getName() === 'svg' && count($x->path) === 1 && count($x->rect) === 1
        && str_contains($svg, 'xmlns="http://www.w3.org/2000/svg"') && str_contains($svg, 'shape-rendering="crispEdges"');
    $check($ok, 'SVG parses as XML with one path for ' . json_encode($s));
}
$svg = tr_qr_svg('x', ['dark' => '"><script>', 'margin' => 0]);
$check(simplexml_load_string($svg) !== false, 'SVG colour options are escaped');
$check(str_contains(tr_qr_svg('A', ['margin' => 1]), 'viewBox="0 0 23 23"'), 'viewBox in module units incl. margin');

// Performance.
$t0 = hrtime(true);
for ($i = 0; $i < 20; $i++) tr_qr_svg(qc_ticket($i));
$ms = (hrtime(true) - $t0) / 1e6 / 20;
$check($ms < 50, sprintf('ticket payload encode+SVG avg %.2f ms', $ms));

echo $fail ? "$fail FAILED\n" : "all PHP checks passed\n";
exit($fail ? 1 : 0);
