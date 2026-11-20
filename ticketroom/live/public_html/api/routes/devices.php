<?php
// Linked devices: organisers add and manage them; a device links itself
// with its pairing code (lib/devices.php).
declare(strict_types=1);

function dev_event(array $a, bool $edit = true): array
{
    $u = require_auth();
    ['event' => $event] = event_access($u, $a['orgId'], $a['eventId'], $edit ? ['owner', 'manager'] : ['owner', 'manager', 'finance', 'viewer']);
    if ($edit && in_array($event['status'], ['cancelled', 'completed'], true)) throw conflict('This event is over.', 'event_locked');
    return [$u, $event];
}
function dev_shape(bool $optional = false): array
{
    $o = $optional ? ['optional' => true] : [];
    return ['name' => R::str(['min' => 2, 'max' => 60] + $o), 'canScan' => R::bool(['optional' => true]), 'canTopup' => R::bool(['optional' => true]),
        'gate' => R::str(['max' => 40, 'optional' => true]), 'readerFormat' => R::oneOf(['hex', 'decimal'], ['optional' => true]), 'readerReverse' => R::bool(['optional' => true])];
}
// The link a device opens to pair (also as a QR code to scan with it).
function dev_pairing(array $r): array
{
    $url = base_url() . '/scan?pair=' . str_replace('-', '', $r['code']);
    return $r + ['pairUrl' => $url, 'qrSvg' => tr_qr_svg($url, ['ecc' => 'M', 'margin' => 2])];
}
function dev_row(array $event, string $id): array
{
    $d = row("SELECT * FROM event_devices WHERE id = ? AND event_id = ? AND status <> 'revoked'", [$id, $event['id']]);
    if (!$d) throw not_found('Device not found.');
    return $d;
}

route('GET', '/api/organiser/:orgId/events/:eventId/devices', function ($a) {
    [, $event] = dev_event($a, false);
    return ['devices' => device_list($event['id']), 'pairUrl' => base_url() . '/scan?pair='];
});
route('POST', '/api/organiser/:orgId/events/:eventId/devices', function ($a) {
    [$u, $event] = dev_event($a);
    limit('devicecreate', 60, 3600, $u['id']);
    $b = check(body(), dev_shape());
    if (empty($b['canScan']) && empty($b['canTopup'])) throw invalid(['canScan' => 'Choose what the device is for: the gate, top-ups or both.']);
    if (!empty($b['canTopup']) && !cashless_open_event($event)) throw conflict('Top-ups need cashless switched on for this event.', 'cashless_closed');
    $r = device_create($u, $event, $b);
    return json_out(dev_pairing($r), 201);
});
route('PATCH', '/api/organiser/:orgId/events/:eventId/devices/:id', function ($a) {
    [$u, $event] = dev_event($a);
    $d = dev_row($event, $a['id']);
    $b = check(body(), dev_shape(true));
    $cols = ['name' => 'name', 'canScan' => 'can_scan', 'canTopup' => 'can_topup', 'gate' => 'gate', 'readerFormat' => 'reader_format', 'readerReverse' => 'reader_reverse'];
    $next = $d;
    foreach ($b as $k => $v) $next[$cols[$k]] = is_bool($v) ? ($v ? 1 : 0) : $v;
    if (!(int) $next['can_scan'] && !(int) $next['can_topup']) throw invalid(['canScan' => 'Choose what the device is for: the gate, top-ups or both.']);
    if ((int) $next['can_topup'] && !(int) $d['can_topup'] && !cashless_open_event($event)) throw conflict('Top-ups need cashless switched on for this event.', 'cashless_closed');
    return tx(function () use ($u, $d, $next, $b) {
        q('UPDATE event_devices SET name = ?, can_scan = ?, can_topup = ?, gate = ?, reader_format = ?, reader_reverse = ?, updated_at = ? WHERE id = ?',
            [$next['name'], (int) $next['can_scan'], (int) $next['can_topup'], $next['gate'], $next['reader_format'], (int) $next['reader_reverse'], now_iso(), $d['id']]);
        q('UPDATE users SET full_name = ?, updated_at = ? WHERE id = ?', [$next['name'], now_iso(), $d['user_id']]);
        device_staff_sync($next, $u['id']);
        audit('device.updated', ['actor' => $u, 'entityType' => 'event_device', 'entityId' => $d['id'], 'details' => array_keys($b)]);
        return ['device' => device_view(row('SELECT * FROM event_devices WHERE id = ?', [$d['id']]))];
    });
});
route('POST', '/api/organiser/:orgId/events/:eventId/devices/:id/code', function ($a) {
    [$u, $event] = dev_event($a);
    $r = tx(fn() => device_recode($u, dev_row($event, $a['id'])));
    return dev_pairing($r);
});
route('POST', '/api/organiser/:orgId/events/:eventId/devices/:id/revoke', function ($a) {
    [$u, $event] = dev_event($a);
    tx(fn() => device_revoke($u, dev_row($event, $a['id'])));
    return ['ok' => true];
});

// On the device. Open to anyone with the code; tight limits per address.
route('POST', '/api/devices/pair', function () {
    limit('devicepair', 10, 900);
    $b = check(body(), ['code' => R::str(['min' => 8, 'max' => 12, 'pattern' => '/^[A-Za-z0-9 -]+$/'])]);
    return device_pair($b['code']);
});
route('GET', '/api/devices/me', function () {
    $u = require_auth();
    if (empty($u['device'])) throw not_found('This is not a linked device.');
    return ['device' => $u['device']];
});
