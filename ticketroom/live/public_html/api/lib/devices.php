<?php
// Linked devices: a handheld scanner (with its own barcode, NFC or RFID
// reader) or a phone, set up at a gate or a top-up desk for one event.
//
// The organiser adds a device and gets a pairing code (and a QR of it). On
// the device, /scan?pair=CODE (or typing the code) links it: it signs in as
// its own device account (users.device_id), so the gate and the top-up desk
// work as for any event team member, every scan and top-up carries the
// device's name, and it can reach nothing but those tools. Revoking it, or
// making a new code, signs it out at once.
declare(strict_types=1);

const DEVICE_CODE_MINUTES = 15;
// What a device may call: the gate and tag desk, the top-up desk, and the
// page basics. Anything else answers 403.
const DEVICE_PATHS = ['/api/staff/', '/api/cashdesk/', '/api/devices/me'];
const DEVICE_READ_PATHS = ['/api/auth/me', '/api/config', '/api/health', '/api/site', '/api/public/'];

function device_code_hash(string $code): string { return hash_hmac('sha256', 'devpair|' . strtoupper(preg_replace('/[\s-]/', '', $code)), hex2bin(key_hex('data'))); }
function device_new_code(): string { return random_code(8); }
function device_code_display(string $c): string { return substr($c, 0, 4) . '-' . substr($c, 4); }

function device_view(array $d): array
{
    return ['id' => $d['id'], 'name' => $d['name'], 'canScan' => (int) $d['can_scan'] === 1, 'canTopup' => (int) $d['can_topup'] === 1, 'gate' => $d['gate'],
        'readerFormat' => $d['reader_format'], 'readerReverse' => (int) $d['reader_reverse'] === 1, 'status' => $d['status'],
        'pairedAt' => $d['paired_at'], 'lastSeenAt' => $d['last_seen_at'], 'userAgent' => $d['user_agent'], 'createdAt' => $d['created_at'],
        'scans' => (int) ($d['scans'] ?? 0), 'topups' => (int) ($d['topups'] ?? 0)];
}
function device_list(string $eventId): array
{
    return array_map('device_view', rows("SELECT d.*, (SELECT count(*) FROM admission_log a WHERE a.event_id = d.event_id AND a.scanned_by = d.user_id) AS scans,
        (SELECT count(*) FROM desk_topups t WHERE t.event_id = d.event_id AND t.staff_id = d.user_id AND t.status = 'confirmed') AS topups
        FROM event_devices d WHERE d.event_id = ? AND d.status <> 'revoked' ORDER BY d.created_at", [$eventId]));
}
// Event staff rights follow the device's roles.
function device_staff_sync(array $d, ?string $actorId): void
{
    q('DELETE FROM event_staff WHERE event_id = ? AND user_id = ?', [$d['event_id'], $d['user_id']]);
    if ($d['status'] === 'revoked' || (!(int) $d['can_scan'] && !(int) $d['can_topup'])) return;
    insert('event_staff', ['event_id' => $d['event_id'], 'user_id' => $d['user_id'], 'can_scan' => (int) $d['can_scan'], 'can_manage_tags' => (int) $d['can_topup'],
        'can_sell_tickets' => 0, 'added_by' => $actorId, 'created_at' => now_iso()]);
}
function device_signout(string $userId): void
{
    q('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [now_iso(), $userId]);
}
// A new device with its first pairing code.
function device_create(array $actor, array $event, array $b): array
{
    return tx(function () use ($actor, $event, $b) {
        if ((int) val("SELECT count(*) FROM event_devices WHERE event_id = ? AND status <> 'revoked'", [$event['id']]) >= 200) throw conflict('An event can have up to 200 linked devices.', 'limit_exceeded');
        $id = uuid(); $uid = uuid(); $now = now_iso();
        insert('users', ['id' => $uid, 'email' => "device.$id@devices.ticketroom.invalid", 'full_name' => $b['name'], 'password_hash' => '!', 'status' => 'active',
            'account_type' => 'customer', 'email_verified_at' => $now, 'created_at' => $now, 'updated_at' => $now, 'device_id' => $id]);
        $code = device_new_code();
        insert('event_devices', ['id' => $id, 'event_id' => $event['id'], 'name' => $b['name'], 'can_scan' => !empty($b['canScan']) ? 1 : 0, 'can_topup' => !empty($b['canTopup']) ? 1 : 0,
            'gate' => $b['gate'] ?? null, 'reader_format' => $b['readerFormat'] ?? 'hex', 'reader_reverse' => !empty($b['readerReverse']) ? 1 : 0, 'user_id' => $uid, 'status' => 'pending',
            'pair_code_hash' => device_code_hash($code), 'pair_expires_at' => iso_in(DEVICE_CODE_MINUTES * 60), 'created_by' => $actor['id'], 'created_at' => $now, 'updated_at' => $now]);
        $d = row('SELECT * FROM event_devices WHERE id = ?', [$id]);
        device_staff_sync($d, $actor['id']);
        audit('device.created', ['actor' => $actor, 'entityType' => 'event_device', 'entityId' => $id, 'organiserId' => $event['organiser_id'], 'details' => ['name' => $b['name'], 'gate' => (int) $d['can_scan'], 'topup' => (int) $d['can_topup']]]);
        return ['device' => device_view($d), 'code' => device_code_display($code), 'expiresAt' => $d['pair_expires_at']];
    });
}
// A fresh code: to link a replacement handset, or after a reset. Whatever
// is linked now is signed out.
function device_recode(array $actor, array $d): array
{
    $code = device_new_code();
    q("UPDATE event_devices SET pair_code_hash = ?, pair_expires_at = ?, status = CASE WHEN status = 'revoked' THEN status ELSE 'pending' END, updated_at = ? WHERE id = ?",
        [device_code_hash($code), iso_in(DEVICE_CODE_MINUTES * 60), now_iso(), $d['id']]);
    device_signout($d['user_id']);
    audit('device.code_made', ['actor' => $actor, 'entityType' => 'event_device', 'entityId' => $d['id']]);
    return ['code' => device_code_display($code), 'expiresAt' => iso_in(DEVICE_CODE_MINUTES * 60)];
}
function device_revoke(array $actor, array $d): void
{
    q("UPDATE event_devices SET status = 'revoked', pair_code_hash = NULL, pair_expires_at = NULL, updated_at = ? WHERE id = ?", [now_iso(), $d['id']]);
    q("UPDATE users SET status = 'suspended', updated_at = ? WHERE id = ?", [now_iso(), $d['user_id']]);
    device_signout($d['user_id']);
    device_staff_sync(['status' => 'revoked'] + $d, null);
    audit('device.revoked', ['actor' => $actor, 'entityType' => 'event_device', 'entityId' => $d['id'], 'details' => ['name' => $d['name']]]);
}
// On the device: the code links it. The session lasts until the day after
// the event (never more than 30 days), with no idle timeout.
function device_pair(string $code): array
{
    return tx(function () use ($code) {
        $d = row("SELECT d.*, e.ends_at, e.title, e.status AS event_status FROM event_devices d JOIN events e ON e.id = d.event_id
                   WHERE d.pair_code_hash = ? AND d.status <> 'revoked'", [device_code_hash($code)]);
        if (!$d || !$d['pair_expires_at'] || $d['pair_expires_at'] < now_iso()) throw new AppError(400, 'pair_code_invalid', 'That code is not valid or has expired. Ask the organiser for a new one.');
        if (in_array($d['event_status'], ['cancelled', 'completed'], true)) throw conflict('This event is over.', 'event_locked');
        $until = (int) min((int) floor(to_unix($d['ends_at']) ?? time()) + 86400, time() + 30 * 86400);
        if ($until <= time()) throw conflict('This event is over.', 'event_locked');
        device_signout($d['user_id']);
        q("UPDATE event_devices SET status = 'active', pair_code_hash = NULL, pair_expires_at = NULL, paired_at = ?, last_seen_at = ?, user_agent = ?, updated_at = ? WHERE id = ?",
            [now_iso(), now_iso(), substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 200), now_iso(), $d['id']]);
        $token = random_token(32);
        insert('sessions', ['id' => uuid(), 'token_hash' => sha256($token), 'user_id' => $d['user_id'], 'csrf_token' => random_token(24),
            'created_at' => now_iso(), 'expires_at' => iso_at($until), 'user_agent' => substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 200), 'ip' => client_ip()]);
        header('Set-Cookie: ' . cookie_header($token, $until), false);
        audit('device.linked', ['actor' => ['id' => $d['user_id']], 'entityType' => 'event_device', 'entityId' => $d['id'], 'details' => ['name' => $d['name']]]);
        return ['device' => device_view(row('SELECT * FROM event_devices WHERE id = ?', [$d['id']])), 'event' => ['id' => $d['event_id'], 'title' => $d['title']]];
    });
}
// For load_session(): the device behind a device account, or null when it
// was revoked (then the session counts for nothing).
function device_for_user(string $deviceId): ?array
{
    $d = row("SELECT * FROM event_devices WHERE id = ? AND status = 'active'", [$deviceId]);
    if (!$d) return null;
    if (!$d['last_seen_at'] || to_unix($d['last_seen_at']) < time() - 60) q('UPDATE event_devices SET last_seen_at = ? WHERE id = ?', [now_iso(), $d['id']]);
    return device_view($d) + ['eventId' => $d['event_id']];
}
// Request guard: a device reaches its own tools and nothing else.
function device_guard(string $method, string $path): void
{
    $u = user();
    if (!$u || empty($u['device'])) return;
    foreach (DEVICE_PATHS as $p) if (str_starts_with($path, $p)) return;
    if ($method === 'GET') foreach (DEVICE_READ_PATHS as $p) if ($path === $p || str_starts_with($path, rtrim($p, '/') . '/')) return;
    if ($method === 'POST' && $path === '/api/auth/logout') return;
    throw forbidden('This device is linked for scanning and top-ups only.');
}
