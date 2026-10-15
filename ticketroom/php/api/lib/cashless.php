<?php
// Cashless at events: wristbands and tags, event wallets, vendors and POS.
//
// How the money works:
//   - Each attendee has one balance per cashless event, held on their account
//     (cashless_wallets), never on the wristband. A lost band is blocked and a
//     new one linked; the balance simply stays where it is.
//   - Top-ups are card payments through the normal payment flow (payments with
//     purpose 'topup'): the balance only grows when the provider confirms.
//   - A sale at a vendor's till takes the money off the balance with one
//     conditional UPDATE inside one transaction, so a balance can never go
//     below zero, even with two tills charging the same band at once.
//   - Every change is booked to the ledger in the same transaction:
//       wallet:<user>:<event>       what TicketRoom owes the attendee
//       vendor:<vendor>:event:<ev>  what is owed to a vendor (settled to the organiser)
//       revenue:cashless_commission TicketRoom's commission on vendor sales
//   - Test mode works exactly like ticket orders: a top-up paid in test mode
//     is test money (test_balance_cents, "test:" ledger accounts), and a sale
//     paid from it is a test sale that never reaches a vendor's settlement.
declare(strict_types=1);

const CASHLESS_COMMISSION = 'revenue:cashless_commission';
const PIN_LIMIT = 5;
const PIN_LOCK_MINUTES = 15;
const TAG_LINK_ATTEMPTS = 5;
// Vendor staff can undo their own mistake for a short while; after that a
// refund goes to the organiser for approval.
const POS_VOID_MINUTES = 30;
const TAG_STATUS_OPEN = ['unassigned', 'assigned'];

// ============================================================== settings
function cashless_limits(): array
{
    return [
        'pinThresholdCents' => (int) cfg('cashless.pinThresholdCents', 20000),
        'minTopupCents' => (int) cfg('cashless.minTopupCents', 5000),
        'maxTopupCents' => (int) cfg('cashless.maxTopupCents', 300000),
        'maxBalanceCents' => (int) cfg('cashless.maxBalanceCents', 500000),
    ];
}
function cashless_max_sale(): int { return (int) cfg('cashless.maxSaleCents', 500000); }
// Cashless needs card payments for top-ups. The owner can also switch it off
// for the whole site in data/config.php ('cashless' => ['enabled' => false]).
function cashless_ready(): bool { return pay_ready() && (bool) cfg('cashless.enabled', true); }
function cashless_open_event(array $ev): bool { return cashless_ready() && !empty($ev['cashless_enabled']); }
// "R50" or "R50.50": for messages.
function rand_short(int $cents): string { return 'R' . number_format($cents / 100, $cents % 100 ? 2 : 0, '.', ' '); }

function wallet_account(string $userId, string $eventId): string { return "wallet:$userId:$eventId"; }
function vendor_account(array $v): string { return "vendor:{$v['id']}:event:{$v['event_id']}"; }

// ============================================================== upgrade 11
// Adds only cashless's own columns and tables. Two tables need a constraint
// relaxed, which SQLite can only do by rebuilding the table: payments (a
// top-up has no order) and refunds (a wallet or POS refund has no order).
function tr_upgrade_cashless(): void
{
    $add = [
        'users' => ['spending_pin_hash' => 'TEXT', 'pin_failed_attempts' => 'INTEGER NOT NULL DEFAULT 0', 'pin_locked_until' => 'TEXT'],
        'payments' => ['purpose' => "TEXT NOT NULL DEFAULT 'order' CHECK (purpose IN ('order','topup'))", 'topup_id' => 'TEXT REFERENCES wallet_topups(id)'],
        'refunds' => ['event_id' => 'TEXT REFERENCES events(id)', 'user_id' => 'TEXT REFERENCES users(id)', 'pos_sale_id' => 'TEXT REFERENCES pos_sales(id)'],
        'payouts' => ['vendor_id' => 'TEXT REFERENCES vendors(id)'],
    ];
    foreach ($add as $table => $cols) {
        $have = array_column(rows("PRAGMA table_info($table)"), 'name');
        foreach ($cols as $c => $def) if (!in_array($c, $have, true)) db()->exec("ALTER TABLE $table ADD COLUMN $c $def");
    }
    $nullableOrder = fn(string $s) => (string) preg_replace('/\border_id(\s+)TEXT\s+NOT NULL\b/i', 'order_id$1TEXT', $s, 1);
    tr_rebuild_table('payments', $nullableOrder);
    tr_rebuild_table('refunds', function (string $s) use ($nullableOrder) {
        return (string) preg_replace_callback('/CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)\s*\)/i', function ($m) {
            $kinds = $m[1];
            foreach (["'wallet_balance'", "'pos_sale'"] as $k) if (!str_contains($kinds, $k)) $kinds .= ",$k";
            return "CHECK (kind IN ($kinds))";
        }, $nullableOrder($s), 1);
    });
    $sql = (string) file_get_contents(TR_APP . '/schema.sql');
    if (!preg_match('/-- cashless:begin\n(.*)-- cashless:end/s', $sql, $m)) throw new RuntimeException('schema.sql has no cashless block. Upload the complete TicketRoom package.');
    db()->exec($m[1]);
}
// Rebuilds a table with an edited definition, keeping every row, column,
// index and trigger. Runs inside the upgrade's transaction with foreign keys
// on: checks are deferred while the old table is gone and pass again once
// its rows are back.
function tr_rebuild_table(string $table, callable $edit): void
{
    $sql = (string) val("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [$table]);
    if ($sql === '') return;
    $new = $edit($sql);
    if ($new === $sql) return;
    $extra = array_column(rows("SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL", [$table]), 'sql');
    $pdo = db();
    $pdo->exec('PRAGMA defer_foreign_keys = ON');
    $pdo->exec("CREATE TEMP TABLE tr_rebuild_copy AS SELECT * FROM \"$table\"");
    $pdo->exec("DROP TABLE \"$table\"");
    $pdo->exec($new);
    $pdo->exec("INSERT INTO \"$table\" SELECT * FROM temp.tr_rebuild_copy");
    $pdo->exec('DROP TABLE temp.tr_rebuild_copy');
    foreach ($extra as $x) $pdo->exec($x);
}

// ============================================================== tags
// What a reader or a person can give us:
//   "TRT1.<token>"           QR tag, or an NFC tag carrying a TicketRoom token
//   "UID:04A1B2C3D4E5F6"     an NFC chip's serial number (what phones read)
//   "ABCD-EFGH"              the code printed on the band
// Tokens and UIDs are never stored, only an HMAC of them, so the database
// cannot be used to clone bands.
function tag_normalise(?string $input): ?array
{
    $s = trim((string) $input);
    if (preg_match('/^TRT1\.([A-Za-z0-9_-]{16,64})$/', $s, $m)) return ['kind' => 'token', 'value' => $m[1]];
    $uidPrefix = (bool) preg_match('/^UID:/i', $s);
    $code = '[' . CODE_ALPHABET . ']';
    if (!$uidPrefix && preg_match("/^($code{4})-($code{4})$/", strtoupper($s), $m)) return ['kind' => 'code', 'value' => $m[1] . $m[2]];
    $uid = strtoupper((string) preg_replace('/[:\s-]/', '', (string) preg_replace('/^UID:/i', '', $s)));
    if (preg_match('/^([0-9A-F]{8}|[0-9A-F]{14}|[0-9A-F]{20})$/', $uid)) return ['kind' => 'uid', 'value' => $uid, 'maybeCode' => !$uidPrefix && preg_match("/^$code{8}$/", $uid)];
    if (!$uidPrefix && preg_match("/^$code{8}$/", $uid)) return ['kind' => 'code', 'value' => $uid];
    return null;
}
function tag_hash(array $n): string { return hash_hmac('sha256', "tag|{$n['kind']}:{$n['value']}", hex2bin(key_hex('data'))); }
function tag_activation_hash(string $tagId, string $code): string { return hash_hmac('sha256', "tagact|$tagId|" . strtoupper($code), hex2bin(key_hex('data'))); }
function tag_display(string $code): string { return substr($code, 0, 4) . '-' . substr($code, 4); }
function tag_resolve(?string $input): ?array
{
    $n = tag_normalise($input);
    if (!$n) return null;
    if ($n['kind'] === 'code') return row('SELECT * FROM tags WHERE display_code = ?', [$n['value']]);
    $t = row('SELECT * FROM tags WHERE token_hash = ?', [tag_hash($n)]);
    // Eight characters typed without the dash can look like a short chip UID.
    if (!$t && !empty($n['maybeCode'])) $t = row('SELECT * FROM tags WHERE display_code = ?', [$n['value']]);
    return $t;
}
function tag_log(string $tagId, string $action, ?array $actor, array $details = []): void
{
    q('INSERT INTO tag_events (tag_id, action, actor_id, details, occurred_at) VALUES (?,?,?,?,?)',
        [$tagId, $action, $actor['id'] ?? null, json_encode(audit_scrub($details), JSON_UNESCAPED_SLASHES) ?: '{}', now_iso()]);
}
function tag_new_display_code(): string
{
    do { $c = random_code(8); } while (val('SELECT 1 FROM tags WHERE display_code = ?', [$c]));
    return $c;
}
// Inserts one tag. Returns what is printed or encoded (shown once only).
function tag_insert(array $n, string $type, ?string $batchId, ?string $eventId, ?array $actor): array
{
    if (val('SELECT 1 FROM tags WHERE token_hash = ?', [tag_hash($n)])) throw conflict('This tag is already registered with TicketRoom.', 'tag_exists');
    $id = uuid();
    $display = tag_new_display_code();
    $activation = random_code(6);
    $now = now_iso();
    $level = $n['kind'] === 'uid' ? 'uid_only' : 'random_token';
    insert('tags', ['id' => $id, 'tag_type' => $type, 'token_hash' => tag_hash($n), 'display_code' => $display, 'activation_code_hash' => tag_activation_hash($id, $activation),
        'security_level' => $level, 'batch_id' => $batchId, 'event_id' => $eventId, 'status' => $eventId ? 'assigned' : 'unassigned', 'created_at' => $now, 'updated_at' => $now]);
    tag_log($id, 'created', $actor, ['batch' => $batchId]);
    return ['tagId' => $id, 'payload' => $n['kind'] === 'uid' ? "UID:{$n['value']}" : "TRT1.{$n['value']}", 'displayCode' => tag_display($display), 'activationCode' => $activation, 'securityLevel' => $level];
}
// A batch of tags: "generate" mints random tokens (QR printing or NDEF
// encoding); "import" registers factory chip UIDs read off the bands.
function tag_create_batch(array $actor, array $o): array
{
    $mode = $o['mode'];
    if ($mode === 'import' && $o['tagType'] === 'qr_tag') throw bad('QR tags are generated, not imported.');
    $uids = $o['uids'] ?? [];
    $count = $mode === 'import' ? count($uids) : (int) ($o['quantity'] ?? 0);
    if ($count < 1) throw bad($mode === 'import' ? 'Paste at least one chip UID.' : 'Enter a quantity.');
    return tx(function () use ($actor, $o, $mode, $uids, $count) {
        $batchId = uuid();
        insert('tag_batches', ['id' => $batchId, 'tag_type' => $o['tagType'], 'mode' => $mode, 'event_id' => $o['eventId'] ?? null, 'organiser_id' => $o['organiserId'] ?? null,
            'quantity' => $count, 'notes' => $o['notes'] ?? null, 'created_by' => $actor['id'], 'created_at' => now_iso()]);
        $out = [];
        $seen = [];
        for ($i = 0; $i < $count; $i++) {
            if ($mode === 'import') {
                $n = tag_normalise('UID:' . $uids[$i]);
                if (!$n || $n['kind'] !== 'uid') throw invalid(['uids' => 'Line ' . ($i + 1) . ': not a chip UID (8, 14 or 20 hexadecimal characters).']);
                if (isset($seen[$n['value']])) throw invalid(['uids' => 'Line ' . ($i + 1) . ': this UID is listed twice.']);
                $seen[$n['value']] = true;
                if (val('SELECT 1 FROM tags WHERE token_hash = ?', [tag_hash($n)])) throw invalid(['uids' => 'Line ' . ($i + 1) . ': this band is already registered.']);
            } else {
                $n = ['kind' => 'token', 'value' => random_token(18)];
            }
            $out[] = tag_insert($n, $o['tagType'], $batchId, $o['eventId'] ?? null, $actor);
        }
        audit('tags.batch_created', ['actor' => $actor, 'entityType' => 'tag_batch', 'entityId' => $batchId, 'organiserId' => $o['organiserId'] ?? null,
            'details' => ['tagType' => $o['tagType'], 'count' => $count, 'eventId' => $o['eventId'] ?? null, 'mode' => $mode]]);
        return ['batchId' => $batchId, 'tags' => $out];
    });
}
// Inside a transaction. Links a tag to an attendee and one of their tickets.
function tag_activate(array $tag, string $userId, string $eventId, string $ticketId, ?array $actor, string $via): void
{
    if (!in_array($tag['status'], TAG_STATUS_OPEN, true)) throw conflict('This tag cannot be linked. It is ' . $tag['status'] . '.', 'tag_unavailable');
    if ($tag['event_id'] && $tag['event_id'] !== $eventId) throw conflict('This tag belongs to a different event.', 'tag_wrong_event');
    if (val("SELECT 1 FROM tags WHERE event_id = ? AND user_id = ? AND status = 'active'", [$eventId, $userId])) {
        throw conflict('There is already an active tag for this event on this account. Report it lost first if you are replacing it.', 'tag_already_linked');
    }
    if (val("SELECT 1 FROM tags WHERE ticket_id = ? AND status = 'active'", [$ticketId])) throw conflict('That ticket already has an active tag.', 'tag_already_linked');
    $now = now_iso();
    if (affected("UPDATE tags SET status = 'active', user_id = ?, event_id = ?, ticket_id = ?, linked_at = ?, updated_at = ? WHERE id = ? AND status IN ('unassigned','assigned') AND user_id IS NULL",
        [$userId, $eventId, $ticketId, $now, $now, $tag['id']]) !== 1) throw conflict('This tag was just linked by someone else.', 'tag_unavailable');
    tag_log($tag['id'], 'linked', $actor, ['eventId' => $eventId, 'ticketId' => $ticketId, 'via' => $via]);
}
function tag_ticket_for(string $userId, string $eventId): string
{
    $id = val("SELECT t.id FROM tickets t WHERE t.owner_user_id = ? AND t.event_id = ? AND t.status IN ('valid','used')
                 AND NOT EXISTS (SELECT 1 FROM tags g WHERE g.ticket_id = t.id AND g.status = 'active') ORDER BY t.created_at LIMIT 1", [$userId, $eventId]);
    if (!$id) throw conflict('You need a ticket for this event before linking a tag.', 'no_ticket');
    return (string) $id;
}
// The attendee types the code printed on the band and the activation code
// from its card. Same answer for an unknown code and a wrong activation code;
// five wrong tries lock the tag for an hour.
function tag_link_by_attendee(array $u, string $displayCode, string $activationCode, string $eventId): array
{
    $code = strtoupper((string) preg_replace('/[\s-]/', '', $displayCode));
    $tag = row('SELECT * FROM tags WHERE display_code = ?', [$code]);
    if ($tag && (int) val("SELECT count(*) FROM tag_events WHERE tag_id = ? AND action = 'link_failed' AND occurred_at > ?", [$tag['id'], iso_in(-3600)]) >= TAG_LINK_ATTEMPTS) {
        throw conflict('Too many wrong attempts on this tag. Try again in an hour or visit the registration desk.', 'tag_locked');
    }
    if (!$tag || !$tag['activation_code_hash'] || !hash_equals((string) $tag['activation_code_hash'], tag_activation_hash($tag['id'], trim($activationCode)))) {
        if ($tag) tag_log($tag['id'], 'link_failed', $u, ['reason' => 'bad_activation']);
        throw conflict('That tag code and activation code do not match.', 'tag_code_mismatch');
    }
    return tx(function () use ($u, $tag, $eventId) {
        $ev = row('SELECT id, status, ends_at FROM events WHERE id = ?', [$eventId]);
        if (!$ev || $ev['status'] !== 'published' || to_unix($ev['ends_at']) < microtime(true)) throw conflict('This event is not open for linking tags.', 'event_closed');
        $tag = row('SELECT * FROM tags WHERE id = ?', [$tag['id']]);
        $ticketId = tag_ticket_for($u['id'], $eventId);
        tag_activate($tag, $u['id'], $eventId, $ticketId, $u, 'attendee');
        audit('tag.linked', ['actor' => $u, 'entityType' => 'tag', 'entityId' => $tag['id'], 'details' => ['eventId' => $eventId]]);
        return ['tagId' => $tag['id']];
    });
}
// A band nobody registered yet, tapped at the registration desk: staff who
// may manage tags register it for this event on the spot.
function tag_resolve_or_register(string $input, array $ev, array $actor): array
{
    $tag = tag_resolve($input);
    if ($tag) return $tag;
    $n = tag_normalise($input);
    if (!$n) throw bad('That is not a TicketRoom tag. Scan or tap it again.');
    if ($n['kind'] === 'code') throw not_found('No tag has that code.');
    $batch = uuid();
    insert('tag_batches', ['id' => $batch, 'tag_type' => $n['kind'] === 'uid' ? 'nfc_wristband' : 'qr_tag', 'mode' => 'desk', 'event_id' => $ev['id'], 'organiser_id' => $ev['organiser_id'],
        'quantity' => 1, 'notes' => 'Registered at the desk', 'created_by' => $actor['id'], 'created_at' => now_iso()]);
    $made = tag_insert($n, $n['kind'] === 'uid' ? 'nfc_wristband' : 'qr_tag', $batch, $ev['id'], $actor);
    audit('tag.registered_at_desk', ['actor' => $actor, 'entityType' => 'tag', 'entityId' => $made['tagId'], 'organiserId' => $ev['organiser_id'], 'details' => ['eventId' => $ev['id']]]);
    return row('SELECT * FROM tags WHERE id = ?', [$made['tagId']]);
}
// Registration desk: staff scan the attendee's ticket, then tap the band.
function tag_link_by_staff(array $staff, array $ev, string $ticketPayload, string $tagInput): array
{
    return tx(function () use ($staff, $ev, $ticketPayload, $tagInput) {
        $p = qr_parse($ticketPayload);
        if (!$p) throw bad("Scan the attendee's ticket QR code.");
        $t = row('SELECT * FROM tickets WHERE code = ? AND event_id = ?', [$p['code'], $ev['id']]);
        if (!$t || !in_array($t['status'], ['valid', 'used'], true) || ($p['signed'] && $p['version'] !== (int) $t['qr_version'])) throw conflict('That ticket is not valid for this event.', 'ticket_not_valid');
        $tag = tag_resolve_or_register($tagInput, $ev, $staff);
        tag_activate($tag, $t['owner_user_id'], $ev['id'], $t['id'], $staff, 'desk');
        audit('tag.linked_by_staff', ['actor' => $staff, 'entityType' => 'tag', 'entityId' => $tag['id'], 'organiserId' => $ev['organiser_id'], 'details' => ['eventId' => $ev['id'], 'ticketId' => $t['id']]]);
        return ['tagId' => $tag['id'], 'holderName' => $t['holder_name']];
    });
}
// Lost, stolen or broken: the old band stops working and the new one takes
// over the same attendee and ticket. The balance is on the account, so it
// carries over by itself.
function tag_replace(array $staff, array $ev, string $oldTagId, string $newInput): array
{
    return tx(function () use ($staff, $ev, $oldTagId, $newInput) {
        $old = row('SELECT * FROM tags WHERE id = ? AND event_id = ?', [$oldTagId, $ev['id']]);
        if (!$old || !$old['user_id'] || !in_array($old['status'], ['active', 'lost', 'blocked'], true)) throw conflict('That tag cannot be replaced.', 'bad_transition');
        $new = tag_resolve_or_register($newInput, $ev, $staff);
        if ($new['id'] === $old['id']) throw conflict('Tap the new tag, not the old one.', 'same_tag');
        q("UPDATE tags SET status = 'replaced', status_reason = 'replaced at the desk', replaced_by_tag_id = ?, updated_at = ? WHERE id = ?", [$new['id'], now_iso(), $old['id']]);
        tag_activate($new, $old['user_id'], $ev['id'], (string) $old['ticket_id'], $staff, 'replacement');
        tag_log($old['id'], 'replaced', $staff, ['newTagId' => $new['id']]);
        audit('tag.replaced', ['actor' => $staff, 'entityType' => 'tag', 'entityId' => $old['id'], 'organiserId' => $ev['organiser_id'], 'details' => ['newTagId' => $new['id']]]);
        return ['newTagId' => $new['id']];
    });
}
// Lost or stolen, reported by the attendee: blocked at once, for every till and gate.
function tag_report_lost(array $u, string $tagId): void
{
    tx(function () use ($u, $tagId) {
        if (affected("UPDATE tags SET status = 'lost', status_reason = 'reported lost by the attendee', updated_at = ? WHERE id = ? AND user_id = ? AND status = 'active'", [now_iso(), $tagId, $u['id']]) !== 1) {
            throw not_found('Active tag not found.');
        }
        tag_log($tagId, 'reported_lost', $u);
        audit('tag.reported_lost', ['actor' => $u, 'entityType' => 'tag', 'entityId' => $tagId]);
    });
}
function tag_set_status(array $actor, string $tagId, string $status, string $reason): void
{
    $allowed = ['blocked' => ['active', 'assigned', 'unassigned'], 'revoked' => ['active', 'assigned', 'unassigned', 'blocked', 'lost'], 'active' => ['blocked']];
    tx(function () use ($actor, $tagId, $status, $reason, $allowed) {
        $tag = row('SELECT * FROM tags WHERE id = ?', [$tagId]);
        if (!$tag) throw not_found('Tag not found.');
        if (!in_array($tag['status'], $allowed[$status] ?? [], true)) throw conflict("A {$tag['status']} tag cannot be changed to $status.", 'bad_transition');
        if ($status === 'active') {
            if (!$tag['user_id']) throw conflict('Only a linked tag can be unblocked.', 'bad_transition');
            if (val("SELECT 1 FROM tags WHERE event_id = ? AND user_id = ? AND status = 'active' AND id <> ?", [$tag['event_id'], $tag['user_id'], $tag['id']])) throw conflict('The attendee already has another active tag.', 'tag_already_linked');
        }
        q('UPDATE tags SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?', [$status, $reason, now_iso(), $tagId]);
        tag_log($tagId, "status:$status", $actor, ['reason' => $reason]);
        audit("tag.$status", ['actor' => $actor, 'entityType' => 'tag', 'entityId' => $tagId, 'details' => ['reason' => $reason, 'from' => $tag['status']]]);
    });
}
function tags_for_user(string $userId): array
{
    $list = rows('SELECT t.id, t.tag_type, t.display_code, t.status, t.security_level, t.linked_at, t.last_used_at, e.id AS event_id, e.title AS event_title, e.starts_at
                    FROM tags t LEFT JOIN events e ON e.id = t.event_id WHERE t.user_id = ? ORDER BY t.linked_at DESC', [$userId]);
    foreach ($list as &$t) $t['display_code'] = tag_display($t['display_code']);
    return $list;
}

// ============================================================== wallets
function cashless_event(string $eventId): array
{
    $ev = row('SELECT * FROM events WHERE id = ?', [$eventId]);
    if (!$ev) throw not_found('Event not found.');
    if (!cashless_open_event($ev)) throw conflict('Cashless payments are not enabled for this event.', 'cashless_disabled');
    return $ev;
}
function wallet_get(string $userId, string $eventId): array
{
    return row('SELECT balance_cents, test_balance_cents FROM cashless_wallets WHERE user_id = ? AND event_id = ?', [$userId, $eventId]) ?? ['balance_cents' => 0, 'test_balance_cents' => 0];
}
function wallet_total(string $userId, string $eventId): int { $w = wallet_get($userId, $eventId); return (int) $w['balance_cents'] + (int) $w['test_balance_cents']; }
// Inside a transaction.
function wallet_credit(string $userId, string $eventId, int $cents, bool $test): void
{
    $now = now_iso();
    q('INSERT INTO cashless_wallets (user_id, event_id, balance_cents, test_balance_cents, created_at, updated_at) VALUES (?,?,0,0,?,?) ON CONFLICT (user_id, event_id) DO NOTHING', [$userId, $eventId, $now, $now]);
    $col = $test ? 'test_balance_cents' : 'balance_cents';
    q("UPDATE cashless_wallets SET $col = $col + ?, updated_at = ? WHERE user_id = ? AND event_id = ?", [$cents, $now, $userId, $eventId]);
}
// Inside a transaction. Takes the money only if it is there: one statement,
// so two tills charging the same band at once can never overdraw it.
function wallet_debit(string $userId, string $eventId, int $cents, bool $test): bool
{
    $col = $test ? 'test_balance_cents' : 'balance_cents';
    return affected("UPDATE cashless_wallets SET $col = $col - ?, updated_at = ? WHERE user_id = ? AND event_id = ? AND $col >= ?", [$cents, now_iso(), $userId, $eventId, $cents]) === 1;
}
function wallets_for(string $userId): array
{
    $list = rows("SELECT e.id, e.title, e.slug, e.starts_at, e.ends_at, e.status, e.cashless_enabled FROM events e
                   WHERE (e.cashless_enabled = 1 AND EXISTS (SELECT 1 FROM tickets t WHERE t.event_id = e.id AND t.owner_user_id = ? AND t.status IN ('valid','used')))
                      OR EXISTS (SELECT 1 FROM cashless_wallets w WHERE w.event_id = e.id AND w.user_id = ?)
                   ORDER BY e.starts_at", [$userId, $userId]);
    foreach ($list as &$e) $e['balanceCents'] = wallet_total($userId, $e['id']);
    return $list;
}
function wallet_history(string $userId, string $eventId): array
{
    return array_map(function ($r) { $r['amount_cents'] = (int) $r['amount_cents']; $r['test'] = (int) $r['test'] === 1; return $r; }, rows(
        "SELECT * FROM (
           SELECT 'topup' AS kind, reference, amount_cents, status, created_at, NULL AS vendor, test FROM wallet_topups WHERE user_id = ? AND event_id = ?
           UNION ALL
           SELECT 'purchase', s.reference, -s.total_cents, s.status, s.created_at, v.name, s.test FROM pos_sales s JOIN vendors v ON v.id = s.vendor_id WHERE s.user_id = ? AND s.event_id = ?
           UNION ALL
           SELECT 'refund', r.reference, CASE WHEN r.kind = 'pos_sale' THEN r.amount_cents ELSE -r.amount_cents END, r.status, r.created_at, NULL,
                  CASE WHEN r.kind = 'pos_sale' THEN (SELECT s.test FROM pos_sales s WHERE s.id = r.pos_sale_id) ELSE (SELECT p.environment <> 'live' FROM payments p WHERE p.id = r.payment_id) END
             FROM refunds r WHERE r.user_id = ? AND r.event_id = ? AND r.kind IN ('pos_sale','wallet_balance')
         ) ORDER BY created_at DESC LIMIT 200", [$userId, $eventId, $userId, $eventId, $userId, $eventId]));
}

// ============================================================== top-ups
// Starts a card top-up. The balance only grows when the provider confirms
// the payment (payment_apply → topup_confirm), never from the browser.
function topup_start(array $u, string $eventId, int $amount, string $idem): array
{
    $lim = cashless_limits();
    if ($amount < $lim['minTopupCents'] || $amount > $lim['maxTopupCents']) {
        throw conflict('Top-ups must be between ' . rand_short($lim['minTopupCents']) . ' and ' . rand_short($lim['maxTopupCents']) . '.', 'topup_limits', ['amount' => 'Choose an amount in that range.']);
    }
    $made = tx(function () use ($u, $eventId, $amount, $idem, $lim) {
        $prior = row('SELECT * FROM wallet_topups WHERE user_id = ? AND idempotency_key = ?', [$u['id'], $idem]);
        if ($prior) return ['topup' => $prior, 'replay' => true];
        $ev = cashless_event($eventId);
        if ($ev['status'] !== 'published' || to_unix($ev['ends_at']) < microtime(true)) throw conflict('Top-ups are closed for this event.', 'event_closed');
        if (!val("SELECT 1 FROM tickets WHERE owner_user_id = ? AND event_id = ? AND status IN ('valid','used') LIMIT 1", [$u['id'], $eventId])) {
            throw conflict('You need a ticket for this event to top up.', 'no_ticket');
        }
        // Top-ups still waiting at the provider count against the cap.
        $pending = (int) val("SELECT COALESCE(SUM(amount_cents),0) FROM wallet_topups WHERE user_id = ? AND event_id = ? AND status = 'pending' AND created_at > ?", [$u['id'], $eventId, iso_in(-3600)]);
        if (wallet_total($u['id'], $eventId) + $pending + $amount > $lim['maxBalanceCents']) {
            throw conflict('An event balance cannot go over ' . rand_short($lim['maxBalanceCents']) . '.', 'balance_cap', ['amount' => 'Choose a smaller amount.']);
        }
        $now = now_iso();
        $t = insert('wallet_topups', ['id' => uuid(), 'reference' => reference('TU'), 'user_id' => $u['id'], 'event_id' => $eventId, 'amount_cents' => $amount, 'status' => 'pending',
            'idempotency_key' => $idem, 'test' => pay_test() ? 1 : 0, 'created_at' => $now]);
        $p = insert('payments', ['id' => uuid(), 'order_id' => null, 'purpose' => 'topup', 'topup_id' => $t['id'], 'provider' => pay_provider(), 'environment' => pay_mode(),
            'amount_cents' => $amount, 'status' => 'initiated', 'created_at' => $now, 'updated_at' => $now]);
        audit('wallet.topup_started', ['actor' => $u, 'entityType' => 'wallet_topup', 'entityId' => $t['id'], 'organiserId' => $ev['organiser_id'],
            'details' => ['reference' => $t['reference'], 'amount' => $amount, 'eventId' => $eventId, 'test' => pay_test()]]);
        return ['topup' => $t, 'payment' => $p, 'event' => $ev];
    });
    if (!empty($made['replay'])) {
        $p = row('SELECT * FROM payments WHERE topup_id = ? ORDER BY created_at DESC LIMIT 1', [$made['topup']['id']]);
        $again = $p && $p['status'] === 'pending' && $p['provider'] !== 'yoco';
        return ['topup' => $made['topup'], 'replay' => true, 'payment' => ['status' => $p['status'] ?? null, 'method' => 'card', 'redirectUrl' => $again ? topup_pay_url($p) : null, 'awaitingApproval' => false]];
    }
    return ['topup' => $made['topup'], 'payment' => topup_checkout($made['topup'], $made['payment'], $made['event'])];
}
function topup_return_url(string $eventId): string { return '/account#/wallet/' . $eventId; }
function topup_pay_url(array $p): string
{
    return '/pay?p=' . $p['id'] . ($p['provider'] === 'sandbox' ? '&m=sandbox' : '') . '&k=' . rawurlencode(sign_link(['p' => $p['id']], 3600));
}
// Opens the provider's payment page, like payment_start() does for orders.
function topup_checkout(array $t, array $p, array $ev): array
{
    try {
        if ($p['provider'] === 'yoco') {
            $back = base_url() . topup_return_url($ev['id']);
            $c = yoco_checkout($p, ['reference' => $t['reference']], $back, $back);
            q("UPDATE payments SET provider_reference = ?, status = 'pending', updated_at = ? WHERE id = ?", [$c['reference'], now_iso(), $p['id']]);
            return ['status' => 'pending', 'method' => 'card', 'redirectUrl' => $c['redirectUrl'], 'awaitingApproval' => false];
        }
        // PayFast and the sandbox: TicketRoom's own /pay page takes the buyer on.
        q("UPDATE payments SET provider_reference = ?, status = 'pending', updated_at = ? WHERE id = ?", [$p['id'], now_iso(), $p['id']]);
        return ['status' => 'pending', 'method' => 'card', 'redirectUrl' => topup_pay_url($p), 'awaitingApproval' => false];
    } catch (Throwable $e) {
        q("UPDATE payments SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?", [substr('checkout: ' . $e->getMessage(), 0, 240), now_iso(), $p['id']]);
        q("UPDATE wallet_topups SET status = 'failed' WHERE id = ? AND status = 'pending'", [$t['id']]);
        error_log('[cashless] top-up checkout failed: ' . $e->getMessage());
        throw pay_error('provider_unavailable', 'We could not reach the payment provider. Nothing was charged. Please try again in a moment.');
    }
}
// What the /pay page and PayFast's form need to know about a top-up.
function topup_pay_details(array $p): array
{
    $t = row('SELECT t.*, e.title, u.full_name, u.email FROM wallet_topups t JOIN events e ON e.id = t.event_id JOIN users u ON u.id = t.user_id WHERE t.id = ?', [$p['topup_id']]);
    return ['id' => $t['id'], 'reference' => $t['reference'], 'buyer_name' => $t['full_name'], 'buyer_email' => $t['email'], 'total_cents' => (int) $t['amount_cents'],
        'title' => 'Cashless top-up: ' . $t['title'], 'event_id' => $t['event_id'], 'item_name' => "TicketRoom top-up {$t['reference']}"];
}
// Called from payment_apply() inside its transaction, only on a verified
// provider confirmation (or the sandbox's answer). Safe to call twice.
function topup_confirm(array $p): void
{
    $t = row('SELECT * FROM wallet_topups WHERE id = ?', [$p['topup_id']]);
    if (!$t || $t['status'] === 'confirmed') return;
    $test = $p['environment'] !== 'live';
    $amount = (int) $t['amount_cents'];
    q("UPDATE wallet_topups SET status = 'confirmed', confirmed_at = ?, test = ? WHERE id = ?", [now_iso(), $test ? 1 : 0, $t['id']]);
    wallet_credit($t['user_id'], $t['event_id'], $amount, $test);
    ledger_post('wallet_topup', $t['reference'], [['provider:' . $p['provider'], $amount], [wallet_account($t['user_id'], $t['event_id']), -$amount]], $test);
    $u = row('SELECT email, full_name FROM users WHERE id = ?', [$t['user_id']]);
    $ev = row('SELECT id, title, organiser_id FROM events WHERE id = ?', [$t['event_id']]);
    outbox_enqueue(['to' => $u['email'], 'userId' => $t['user_id']] + tpl('topupConfirmed', ['name' => $u['full_name'], 'event' => $ev, 'amountCents' => $amount, 'test' => $test,
        'balanceCents' => wallet_total($t['user_id'], $t['event_id'])]));
    audit('wallet.topup_confirmed', ['entityType' => 'wallet_topup', 'entityId' => $t['id'], 'organiserId' => $ev['organiser_id'], 'details' => ['reference' => $t['reference'], 'amount' => $amount, 'test' => $test]]);
}
// A payment that failed or was cancelled at the provider.
function topup_closed(array $p, string $outcome): void
{
    q("UPDATE wallet_topups SET status = ? WHERE id = ? AND status = 'pending'", [$outcome === 'cancelled' ? 'cancelled' : 'failed', $p['topup_id']]);
}

// ============================================================== wallet refunds
// After the event the attendee asks for their unused balance back. The money
// leaves the balance straight away (so it can't be spent twice) and waits as
// refund requests, one per top-up payment it goes back to, newest first.
// Finance approves them through the normal refunds flow; a rejected request
// puts the money back on the balance.
function wallet_refund_request(array $u, string $eventId, string $reason = 'Unused cashless balance'): array
{
    return tx(function () use ($u, $eventId, $reason) {
        $ev = row('SELECT * FROM events WHERE id = ?', [$eventId]);
        if (!$ev) throw not_found('Event not found.');
        if (to_unix($ev['ends_at']) > microtime(true) && $ev['status'] !== 'cancelled') throw conflict('You can ask for your unused balance back once the event is over.', 'event_not_ended');
        $w = wallet_get($u['id'], $eventId);
        if ((int) $w['balance_cents'] + (int) $w['test_balance_cents'] <= 0) throw conflict('There is no balance to refund.', 'nothing_to_refund');
        $made = [];
        foreach ([false, true] as $test) {
            $amount = (int) ($test ? $w['test_balance_cents'] : $w['balance_cents']);
            if ($amount <= 0) continue;
            if (!wallet_debit($u['id'], $eventId, $amount, $test)) throw conflict('Your balance just changed. Please try again.', 'balance_changed');
            $left = $amount;
            $pays = rows("SELECT p.* FROM payments p JOIN wallet_topups t ON t.id = p.topup_id
                           WHERE t.user_id = ? AND t.event_id = ? AND p.purpose = 'topup' AND p.status IN ('confirmed','partially_refunded') AND (p.environment <> 'live') = ?
                           ORDER BY p.confirmed_at DESC, p.created_at DESC", [$u['id'], $eventId, $test ? 1 : 0]);
            foreach ($pays as $p) {
                $held = (int) val("SELECT COALESCE(SUM(amount_cents),0) FROM refunds WHERE payment_id = ? AND status IN ('requested','processing','manual_pending','failed')", [$p['id']]);
                $take = min($left, (int) $p['amount_cents'] - (int) $p['refunded_cents'] - $held);
                if ($take <= 0) continue;
                $now = now_iso();
                $made[] = insert('refunds', ['id' => uuid(), 'reference' => reference('RF'), 'order_id' => null, 'payment_id' => $p['id'], 'amount_cents' => $take, 'fee_refund_cents' => 0,
                    'kind' => 'wallet_balance', 'reason' => $reason, 'status' => 'requested', 'requested_by' => $u['id'], 'event_id' => $eventId, 'user_id' => $u['id'],
                    'created_at' => $now, 'updated_at' => $now]);
                $left -= $take;
                if ($left === 0) break;
            }
            if ($left > 0) throw new RuntimeException("wallet refund: {$left} cents not covered by top-ups for {$u['id']} / $eventId");
        }
        audit('refund.requested', ['actor' => $u, 'entityType' => 'refund', 'entityId' => $made[0]['id'], 'organiserId' => $ev['organiser_id'],
            'details' => ['kind' => 'wallet_balance', 'amount' => array_sum(array_column($made, 'amount_cents')), 'refunds' => array_column($made, 'reference')]]);
        return $made;
    });
}
// Nobody has to remember: a few days after a cashless event ends, every
// balance still left is put up for refund automatically (background job).
function cashless_auto_refunds(): int
{
    $days = (int) cfg('cashless.autoRefundAfterDays', 2);
    if ($days < 0) return 0;
    $n = 0;
    $due = rows("SELECT w.user_id, w.event_id FROM cashless_wallets w JOIN events e ON e.id = w.event_id JOIN users u ON u.id = w.user_id
                  WHERE (w.balance_cents > 0 OR w.test_balance_cents > 0) AND e.ends_at < ? AND u.status <> 'deleted' LIMIT 200", [iso_in(-$days * 86400)]);
    foreach ($due as $w) {
        try {
            wallet_refund_request(['id' => $w['user_id'], 'primaryRole' => 'system'], $w['event_id'], 'Unused cashless balance (automatic after the event)');
            $n++;
        } catch (Throwable $e) { error_log("[cashless] auto refund {$w['user_id']}/{$w['event_id']}: " . $e->getMessage()); }
    }
    return $n;
}
// Inside refund_complete()'s transaction: the money went back to the card.
function wallet_refund_completed(array $r, array $p): void
{
    $amount = (int) $r['amount_cents'];
    ledger_post('wallet_refund', $r['reference'], [[wallet_account($r['user_id'], $r['event_id']), $amount], ['provider:' . $p['provider'], -$amount]], $p['environment'] !== 'live');
    $u = row('SELECT email, full_name FROM users WHERE id = ?', [$r['user_id']]);
    $ev = row('SELECT title FROM events WHERE id = ?', [$r['event_id']]);
    outbox_enqueue(['to' => $u['email'], 'userId' => $r['user_id']] + tpl('walletRefundDone', ['name' => $u['full_name'], 'event' => $ev, 'reference' => $r['reference'], 'amountCents' => $amount]));
}
// A wallet refund that finance turned down: the money goes back on the balance.
function wallet_refund_rejected(array $r): void
{
    $env = (string) val('SELECT environment FROM payments WHERE id = ?', [$r['payment_id']]);
    wallet_credit($r['user_id'], $r['event_id'], (int) $r['amount_cents'], $env !== 'live');
}

// ============================================================== spending PIN
function pin_set(array $u, string $pin, string $password): void
{
    if (preg_match('/^(\d)\1+$/', $pin) || str_contains('0123456789', $pin) || str_contains('9876543210', $pin)) {
        throw bad('Choose a PIN that is not a sequence or a repeated digit.', ['pin' => 'Too easy to guess.']);
    }
    if (!verify_secret($password, val('SELECT password_hash FROM users WHERE id = ?', [$u['id']]))) throw new AppError(401, 'bad_credentials', 'Password is incorrect.');
    q('UPDATE users SET spending_pin_hash = ?, pin_failed_attempts = 0, pin_locked_until = NULL, updated_at = ? WHERE id = ?', [hash_secret($pin), now_iso(), $u['id']]);
    audit('user.pin_set', ['actor' => $u, 'entityType' => 'user', 'entityId' => $u['id']]);
}

// ============================================================== vendors & POS
const DECLINE_TEXT = [
    'tag_unknown' => 'Tag not recognised.',
    'tag_blocked' => 'This tag is blocked.',
    'tag_lost' => 'This tag was reported lost.',
    'tag_revoked' => 'This tag was revoked.',
    'tag_replaced' => 'This tag was replaced. Use the new tag.',
    'tag_unassigned' => 'This tag is not linked to anyone.',
    'tag_assigned' => 'This tag is not linked to anyone yet.',
    'tag_wrong_event' => 'This tag is for a different event.',
    'account_inactive' => "The attendee's account is not active.",
    'pin_not_set' => 'Purchases of this size need a spending PIN. The attendee can set one in their TicketRoom account.',
    'pin_required' => 'Ask the attendee to enter their spending PIN.',
    'pin_incorrect' => 'Incorrect PIN.',
    'pin_locked' => 'Too many wrong PINs. Try again in 15 minutes.',
    'insufficient_funds' => 'Insufficient balance.',
];

// A terminal and the signed-in cashier, together. Both must be valid and belong
// to the same vendor: a stolen key alone, or a cashier alone, cannot charge.
function terminal_context(array $u, ?string $key): array
{
    $key = (string) $key;
    if ($key === '' || strlen($key) > 80) throw new AppError(401, 'terminal_required', 'This device is not registered as a till.');
    $t = row("SELECT t.*, v.name AS vendor_name, v.status AS vendor_status, v.commission_bps, v.organiser_id, v.event_id AS vendor_event_id,
                     e.title AS event_title, e.status AS event_status, e.cashless_enabled, e.ends_at, vm.role AS member_role, om.role AS org_role
                FROM terminals t JOIN vendors v ON v.id = t.vendor_id JOIN events e ON e.id = t.event_id
                LEFT JOIN vendor_members vm ON vm.vendor_id = v.id AND vm.user_id = ?
                LEFT JOIN organiser_members om ON om.organiser_id = v.organiser_id AND om.user_id = ?
               WHERE t.key_hash = ?", [$u['id'], $u['id'], sha256($key)]);
    if (!$t) throw new AppError(401, 'terminal_unknown', 'This till key is not recognised.');
    if (account_type($u) === 'staff' || (!$t['member_role'] && !in_array($t['org_role'], ['owner', 'manager'], true))) throw new AppError(403, 'terminal_wrong_vendor', 'You are not on the team for this vendor.');
    if ($t['status'] !== 'active') throw new AppError(403, 'terminal_suspended', 'This till has been suspended.');
    if ($t['vendor_status'] !== 'active') throw new AppError(403, 'vendor_suspended', 'This vendor is suspended.');
    q('UPDATE terminals SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)', [now_iso(), $t['id'], iso_in(-60)]);
    $t['vendor'] = ['id' => $t['vendor_id'], 'event_id' => $t['event_id'], 'commission_bps' => (int) $t['commission_bps'], 'organiser_id' => $t['organiser_id']];
    return $t;
}
function terminal_register(array $actor, array $vendor, string $label): array
{
    $key = 'trk_' . random_token(30);
    $id = uuid();
    insert('terminals', ['id' => $id, 'vendor_id' => $vendor['id'], 'event_id' => $vendor['event_id'], 'label' => $label, 'key_hash' => sha256($key), 'status' => 'active',
        'registered_by' => $actor['id'], 'created_at' => now_iso()]);
    audit('terminal.registered', ['actor' => $actor, 'entityType' => 'terminal', 'entityId' => $id, 'organiserId' => $vendor['organiser_id'], 'details' => ['vendorId' => $vendor['id']]]);
    return ['id' => $id, 'label' => $label, 'status' => 'active', 'created_at' => now_iso(), 'terminalKey' => $key];
}
// Vendor managers (and the organiser's owners and managers) look after the
// product list; cashiers can see it.
function vendor_access(array $u, string $vendorId, array $roles): array
{
    $v = row('SELECT v.*, vm.role AS member_role, om.role AS org_role FROM vendors v
                LEFT JOIN vendor_members vm ON vm.vendor_id = v.id AND vm.user_id = ?
                LEFT JOIN organiser_members om ON om.organiser_id = v.organiser_id AND om.user_id = ? WHERE v.id = ?', [$u['id'], $u['id'], $vendorId]);
    if (!$v || account_type($u) === 'staff') throw not_found('Vendor not found.');
    if (in_array($v['org_role'], ['owner', 'manager'], true)) return ['vendor' => $v, 'role' => 'organiser'];
    if (!$v['member_role']) throw not_found('Vendor not found.');
    if (!in_array($v['member_role'], $roles, true)) throw forbidden('Your role at this vendor does not allow that.');
    return ['vendor' => $v, 'role' => $v['member_role']];
}

function pos_request_hash(array $items, string $tagInput): string
{
    $lines = array_map(fn($i) => "{$i['productId']}:{$i['quantity']}", $items);
    sort($lines, SORT_STRING);
    return sha256(implode(',', $lines) . '|' . sha256(trim($tagInput)));
}
function pos_sale_view(array $s): array
{
    $items = rows('SELECT product_id, name, unit_price_cents, quantity FROM pos_sale_items WHERE sale_id = ?', [$s['id']]);
    $out = ['id' => $s['id'], 'reference' => $s['reference'], 'status' => $s['status'], 'totalCents' => (int) $s['total_cents'], 'declineReason' => $s['decline_reason'],
        'message' => $s['status'] === 'confirmed' ? 'Approved' : ($s['status'] === 'reversed' ? 'Reversed' : (DECLINE_TEXT[$s['decline_reason']] ?? 'Declined')),
        'createdAt' => $s['created_at'], 'idempotencyKey' => $s['idempotency_key'], 'items' => $items, 'test' => (int) $s['test'] === 1];
    // The till may show what is left on the band after a sale, or when there
    // isn't enough. Never a name or anything else about the attendee.
    if ($s['user_id'] && ($s['status'] === 'confirmed' || $s['decline_reason'] === 'insufficient_funds')) $out['balanceCents'] = wallet_total($s['user_id'], $s['event_id']);
    return $out;
}
// Charges a band for a basket. Returns the sale (approved or declined). The
// same request key always returns the same sale and never charges twice.
function pos_charge(array $u, array $t, array $b): array
{
    if (!cashless_open_event(['cashless_enabled' => $t['cashless_enabled']]) || $t['event_status'] !== 'published') throw conflict('Cashless payments are not open for this event.', 'cashless_closed');
    $hash = pos_request_hash($b['items'], $b['tagInput']);
    return tx(function () use ($u, $t, $b, $hash) {
        $prior = row('SELECT * FROM pos_sales WHERE terminal_id = ? AND idempotency_key = ?', [$t['id'], $b['idempotencyKey']]);
        if ($prior) {
            if (!hash_equals($prior['request_hash'], $hash)) throw conflict('This request key was already used for a different sale.', 'idempotency_mismatch');
            return pos_sale_view($prior) + ['replay' => true];
        }
        // Prices come from the database only.
        $lines = [];
        $seen = [];
        foreach ($b['items'] as $it) {
            if (isset($seen[$it['productId']])) throw bad('Each product may appear once in a sale.');
            $seen[$it['productId']] = true;
            $p = row('SELECT * FROM products WHERE id = ? AND vendor_id = ? AND active = 1', [$it['productId'], $t['vendor_id']]);
            if (!$p) throw bad('A product in this sale is not available at this stall.');
            $lines[] = ['product' => $p, 'quantity' => (int) $it['quantity']];
        }
        $total = array_sum(array_map(fn($l) => (int) $l['product']['price_cents'] * $l['quantity'], $lines));
        if ($total <= 0 || $total > cashless_max_sale()) throw conflict('That sale is over the limit for one tap (' . rand_short(cashless_max_sale()) . ').', 'sale_limit');
        $ref = reference('PS');
        $now = now_iso();
        $record = function (string $status, ?string $reason, ?array $tag, int $commission = 0, bool $test = false) use ($t, $u, $b, $hash, $total, $ref, $now) {
            $s = insert('pos_sales', ['id' => uuid(), 'reference' => $ref, 'event_id' => $t['event_id'], 'vendor_id' => $t['vendor_id'], 'terminal_id' => $t['id'], 'cashier_id' => $u['id'],
                'tag_id' => $tag['id'] ?? null, 'user_id' => $tag['user_id'] ?? null, 'total_cents' => $total, 'commission_cents' => $commission, 'status' => $status, 'decline_reason' => $reason,
                'idempotency_key' => $b['idempotencyKey'], 'request_hash' => $hash, 'test' => $test ? 1 : 0, 'created_at' => $now]);
            return $s;
        };
        $decline = fn(string $reason, ?array $tag = null) => pos_sale_view($record('declined', $reason, $tag));

        $tag = tag_resolve($b['tagInput']);
        if (!$tag) return $decline('tag_unknown');
        if ($tag['status'] !== 'active') return $decline('tag_' . $tag['status'], ['id' => $tag['id']]);
        if ($tag['event_id'] !== $t['event_id']) return $decline('tag_wrong_event', ['id' => $tag['id']]);
        $who = row('SELECT id, status, spending_pin_hash, pin_failed_attempts, pin_locked_until FROM users WHERE id = ?', [$tag['user_id']]);
        if (!$who || $who['status'] !== 'active') return $decline('account_inactive', $tag);
        if ($total >= cashless_limits()['pinThresholdCents']) {
            if (!$who['spending_pin_hash']) return $decline('pin_not_set', $tag);
            if ($who['pin_locked_until'] && to_unix($who['pin_locked_until']) > microtime(true)) return $decline('pin_locked', $tag);
            if (empty($b['pin'])) return $decline('pin_required', $tag);
            if (!verify_secret((string) $b['pin'], $who['spending_pin_hash'])) {
                $n = (int) $who['pin_failed_attempts'] + 1;
                q('UPDATE users SET pin_failed_attempts = ?, pin_locked_until = ? WHERE id = ?', [$n >= PIN_LIMIT ? 0 : $n, $n >= PIN_LIMIT ? iso_in(PIN_LOCK_MINUTES * 60) : $who['pin_locked_until'], $who['id']]);
                if ($n >= PIN_LIMIT) audit('user.pin_locked', ['actor' => $u, 'entityType' => 'user', 'entityId' => $who['id'], 'details' => ['terminal' => $t['id']]]);
                return $decline($n >= PIN_LIMIT ? 'pin_locked' : 'pin_incorrect', $tag);
            }
            if ((int) $who['pin_failed_attempts'] > 0) q('UPDATE users SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = ?', [$who['id']]);
        }
        // Real money first; a band that only has test money pays a test sale.
        $test = false;
        if (!wallet_debit($tag['user_id'], $t['event_id'], $total, false)) {
            if (!wallet_debit($tag['user_id'], $t['event_id'], $total, true)) return $decline('insufficient_funds', $tag);
            $test = true;
        }
        $commission = bps_of($total, (int) $t['commission_bps']);
        ledger_post('pos_sale', $ref, [
            [wallet_account($tag['user_id'], $t['event_id']), $total],
            [vendor_account($t['vendor']), -($total - $commission)],
            [CASHLESS_COMMISSION, -$commission],
        ], $test);
        $s = $record('confirmed', null, $tag, $commission, $test);
        foreach ($lines as $l) insert('pos_sale_items', ['sale_id' => $s['id'], 'product_id' => $l['product']['id'], 'name' => $l['product']['name'], 'unit_price_cents' => (int) $l['product']['price_cents'], 'quantity' => $l['quantity']]);
        q('UPDATE tags SET last_used_at = ? WHERE id = ?', [$now, $tag['id']]);
        audit('pos.sale', ['actor' => $u, 'entityType' => 'pos_sale', 'entityId' => $s['id'], 'organiserId' => $t['organiser_id'], 'details' => ['reference' => $ref, 'amount' => $total, 'vendorId' => $t['vendor_id'], 'test' => $test]]);
        return pos_sale_view($s);
    });
}
// Inside a transaction: puts a sale's money back on the band and reverses its ledger entries.
function pos_reverse_sale(array $s, string $journalRef): void
{
    if (affected("UPDATE pos_sales SET status = 'reversed', reversed_at = ? WHERE id = ? AND status = 'confirmed'", [now_iso(), $s['id']]) !== 1) throw conflict('This sale was already reversed.', 'sale_not_refundable');
    $v = row('SELECT * FROM vendors WHERE id = ?', [$s['vendor_id']]);
    $total = (int) $s['total_cents'];
    $commission = (int) $s['commission_cents'];
    $test = (int) $s['test'] === 1;
    wallet_credit($s['user_id'], $s['event_id'], $total, $test);
    ledger_post('pos_refund', $journalRef, [[vendor_account($v), $total - $commission], [CASHLESS_COMMISSION, $commission], [wallet_account($s['user_id'], $s['event_id']), -$total]], $test);
}
function pos_vendor_settled(string $vendorId): bool
{
    return (bool) val("SELECT 1 FROM payouts WHERE vendor_id = ? AND status IN ('requested','approved','paid')", [$vendorId]);
}
function pos_check_refundable(array $s): void
{
    if ($s['status'] !== 'confirmed') throw conflict('Only approved sales can be refunded.', 'sale_not_refundable');
    if (val("SELECT 1 FROM refunds WHERE pos_sale_id = ? AND kind = 'pos_sale' AND status IN ('requested','processing','completed')", [$s['id']])) throw conflict('A refund for this sale is already in progress.', 'refund_in_progress');
    if (pos_vendor_settled($s['vendor_id'])) throw conflict('This vendor has been settled, so its sales can no longer be refunded here. Ask TicketRoom support.', 'vendor_settled');
}
// A refund asked for at the till. The organiser (or TicketRoom finance) approves it.
function pos_refund_request(array $actor, array $sale, string $reason): array
{
    return tx(function () use ($actor, $sale, $reason) {
        $s = row('SELECT * FROM pos_sales WHERE id = ?', [$sale['id']]);
        pos_check_refundable($s);
        $now = now_iso();
        $r = insert('refunds', ['id' => uuid(), 'reference' => reference('RF'), 'order_id' => null, 'payment_id' => null, 'amount_cents' => (int) $s['total_cents'], 'fee_refund_cents' => 0,
            'kind' => 'pos_sale', 'reason' => $reason, 'status' => 'requested', 'requested_by' => $actor['id'], 'event_id' => $s['event_id'], 'user_id' => $s['user_id'], 'pos_sale_id' => $s['id'],
            'created_at' => $now, 'updated_at' => $now]);
        audit('refund.requested', ['actor' => $actor, 'entityType' => 'refund', 'entityId' => $r['id'], 'details' => ['kind' => 'pos_sale', 'sale' => $s['reference'], 'amount' => (int) $s['total_cents']]]);
        return $r;
    });
}
// Undoing a sale straight away (wrong item, double tap): vendor managers and
// the organiser can, within POS_VOID_MINUTES, without waiting for approval.
function pos_void(array $actor, array $sale, string $reason): array
{
    return tx(function () use ($actor, $sale, $reason) {
        $s = row('SELECT * FROM pos_sales WHERE id = ?', [$sale['id']]);
        pos_check_refundable($s);
        if (to_unix($s['created_at']) < microtime(true) - POS_VOID_MINUTES * 60) throw conflict('Sales can only be voided within ' . POS_VOID_MINUTES . ' minutes. Ask for a refund instead.', 'void_window_passed');
        $now = now_iso();
        $r = insert('refunds', ['id' => uuid(), 'reference' => reference('RF'), 'order_id' => null, 'payment_id' => null, 'amount_cents' => (int) $s['total_cents'], 'fee_refund_cents' => 0,
            'kind' => 'pos_sale', 'reason' => "Voided: $reason", 'status' => 'completed', 'provider_reference' => 'VOID', 'requested_by' => $actor['id'], 'decided_by' => $actor['id'],
            'event_id' => $s['event_id'], 'user_id' => $s['user_id'], 'pos_sale_id' => $s['id'], 'created_at' => $now, 'updated_at' => $now, 'completed_at' => $now]);
        pos_reverse_sale($s, $r['reference']);
        audit('pos.sale_voided', ['actor' => $actor, 'entityType' => 'pos_sale', 'entityId' => $s['id'], 'details' => ['sale' => $s['reference'], 'amount' => (int) $s['total_cents'], 'reason' => $reason]]);
        return $r;
    });
}
// Inside refund_process(): an approved POS refund goes straight back to the band.
function pos_refund_complete(string $refundId, ?array $actor): array
{
    $r = row('SELECT * FROM refunds WHERE id = ?', [$refundId]);
    if ($r['status'] === 'completed') return $r;
    $s = row('SELECT * FROM pos_sales WHERE id = ?', [$r['pos_sale_id']]);
    pos_reverse_sale($s, $r['reference']);
    $now = now_iso();
    q("UPDATE refunds SET status = 'completed', provider_reference = 'WALLET', completed_at = ?, updated_at = ? WHERE id = ?", [$now, $now, $r['id']]);
    audit('refund.completed', ['actor' => $actor, 'entityType' => 'refund', 'entityId' => $r['id'], 'details' => ['kind' => 'pos_sale', 'amount' => (int) $r['amount_cents']]]);
    return row('SELECT * FROM refunds WHERE id = ?', [$r['id']]);
}
function pos_vendor_sales(string $vendorId, int $limit = 100): array
{
    return rows("SELECT s.id, s.reference, s.status, s.total_cents, s.decline_reason, s.created_at, s.test, t.label AS terminal,
                        (SELECT r.status FROM refunds r WHERE r.pos_sale_id = s.id ORDER BY r.created_at DESC LIMIT 1) AS refund_status
                   FROM pos_sales s JOIN terminals t ON t.id = s.terminal_id WHERE s.vendor_id = ? ORDER BY s.created_at DESC LIMIT $limit", [$vendorId]);
}
// Sales figures count real money only, like ticket sales; test sales are counted apart.
function pos_vendor_summary(array $v): array
{
    $tot = row("SELECT COALESCE(SUM(CASE WHEN status = 'confirmed' AND test = 0 THEN 1 ELSE 0 END),0) AS confirmed_count,
                       COALESCE(SUM(CASE WHEN status = 'confirmed' AND test = 0 THEN total_cents ELSE 0 END),0) AS gross_cents,
                       COALESCE(SUM(CASE WHEN status = 'confirmed' AND test = 0 THEN commission_cents ELSE 0 END),0) AS commission_cents,
                       COALESCE(SUM(CASE WHEN status = 'declined' THEN 1 ELSE 0 END),0) AS declined_count,
                       COALESCE(SUM(CASE WHEN status = 'reversed' AND test = 0 THEN total_cents ELSE 0 END),0) AS reversed_cents,
                       COALESCE(SUM(CASE WHEN status = 'confirmed' AND test = 1 THEN 1 ELSE 0 END),0) AS test_count,
                       COALESCE(SUM(CASE WHEN status = 'confirmed' AND test = 1 THEN total_cents ELSE 0 END),0) AS test_gross_cents
                  FROM pos_sales WHERE vendor_id = ?", [$v['id']]);
    $tot = array_map('intval', $tot);
    $byProduct = array_map(fn($r) => ['name' => $r['name'], 'qty' => (int) $r['qty'], 'cents' => (int) $r['cents']], rows(
        "SELECT i.name, SUM(i.quantity) AS qty, SUM(i.quantity * i.unit_price_cents) AS cents FROM pos_sale_items i JOIN pos_sales s ON s.id = i.sale_id
          WHERE s.vendor_id = ? AND s.status = 'confirmed' AND s.test = 0 GROUP BY i.name ORDER BY cents DESC LIMIT 20", [$v['id']]));
    return $tot + ['byProduct' => $byProduct, 'payableCents' => -ledger_balance(vendor_account($v))];
}
// What each vendor sold and is owed, for the organiser and TicketRoom finance.
function vendor_settlement_rows(string $where, array $p): array
{
    $list = rows("SELECT v.id, v.name, v.status, v.commission_bps, v.event_id, v.organiser_id, e.title AS event_title, e.ends_at, o.name AS organiser_name,
                         COALESCE(SUM(CASE WHEN s.status = 'confirmed' AND s.test = 0 THEN 1 ELSE 0 END),0) AS sales,
                         COALESCE(SUM(CASE WHEN s.status = 'confirmed' AND s.test = 0 THEN s.total_cents ELSE 0 END),0) AS gross_cents,
                         COALESCE(SUM(CASE WHEN s.status = 'confirmed' AND s.test = 0 THEN s.commission_cents ELSE 0 END),0) AS commission_cents,
                         COALESCE(SUM(CASE WHEN s.status = 'confirmed' AND s.test = 1 THEN s.total_cents ELSE 0 END),0) AS test_gross_cents
                    FROM vendors v JOIN events e ON e.id = v.event_id JOIN organisers o ON o.id = v.organiser_id LEFT JOIN pos_sales s ON s.vendor_id = v.id
                   WHERE $where GROUP BY v.id ORDER BY e.starts_at DESC, v.created_at", $p);
    foreach ($list as &$v) {
        foreach (['sales', 'gross_cents', 'commission_cents', 'test_gross_cents', 'commission_bps'] as $k) $v[$k] = (int) $v[$k];
        $v['payable_cents'] = -ledger_balance(vendor_account($v));
        $v['in_flight_cents'] = (int) val("SELECT COALESCE(SUM(amount_cents),0) FROM payouts WHERE vendor_id = ? AND status IN ('requested','approved')", [$v['id']]);
        $v['paid_cents'] = (int) val("SELECT COALESCE(SUM(amount_cents),0) FROM payouts WHERE vendor_id = ? AND status = 'paid'", [$v['id']]);
    }
    return $list;
}
// The organiser asks for a vendor's takings to be paid out (to the
// organiser's bank account; the organiser settles with the vendor).
function vendor_payout_request(array $actor, array $org, array $vendor): array
{
    return tx(function () use ($actor, $org, $vendor) {
        $ev = row('SELECT ends_at, status FROM events WHERE id = ?', [$vendor['event_id']]);
        if (to_unix($ev['ends_at']) > microtime(true)) throw conflict('Vendor settlements open after the event ends.', 'event_not_ended');
        if ($org['status'] !== 'approved') throw conflict('Your organiser account must be approved first.', 'organiser_not_approved');
        if (!$org['bank_account_last4']) throw conflict('Add your bank details in Settings first.', 'no_bank_details');
        if (val("SELECT 1 FROM refunds WHERE kind = 'pos_sale' AND status IN ('requested','processing') AND pos_sale_id IN (SELECT id FROM pos_sales WHERE vendor_id = ?)", [$vendor['id']])) {
            throw conflict('Decide the open sale refunds for this vendor first.', 'refunds_open');
        }
        $owed = -ledger_balance(vendor_account($vendor)) - (int) val("SELECT COALESCE(SUM(amount_cents),0) FROM payouts WHERE vendor_id = ? AND status IN ('requested','approved')", [$vendor['id']]);
        if ($owed <= 0) throw conflict('Nothing is owed to this vendor.', 'nothing_owed');
        $now = now_iso();
        $po = insert('payouts', ['id' => uuid(), 'reference' => reference('PO'), 'organiser_id' => $org['id'], 'vendor_id' => $vendor['id'], 'amount_cents' => $owed, 'status' => 'requested',
            'bank_name' => $org['bank_name'], 'bank_account_holder' => $org['bank_account_holder'], 'bank_account_last4' => $org['bank_account_last4'], 'bank_branch_code' => $org['bank_branch_code'],
            'note' => "Vendor settlement: {$vendor['name']}", 'requested_by' => $actor['id'], 'created_at' => $now, 'updated_at' => $now]);
        audit('payout.requested', ['actor' => $actor, 'entityType' => 'payout', 'entityId' => $po['id'], 'organiserId' => $org['id'], 'details' => ['vendorId' => $vendor['id'], 'amount' => $owed]]);
        return $po;
    });
}

// The organiser switches cashless on or off for an event. On needs card
// payments (top-ups are card payments); off is refused while attendees still
// have money on the event's wallets.
function cashless_guard_switch(?array $event, array $b): void
{
    if (!array_key_exists('cashlessEnabled', $b) || $b['cashlessEnabled'] === null) return;
    $on = (bool) $b['cashlessEnabled'];
    $was = $event ? !empty($event['cashless_enabled']) : false;
    if ($on && !$was && !cashless_ready()) throw conflict('Cashless events need card payments, which are not switched on yet.', 'cashless_unavailable', ['cashlessEnabled' => 'Not available yet.']);
    if (!$on && $was && (int) val('SELECT COALESCE(SUM(balance_cents + test_balance_cents),0) FROM cashless_wallets WHERE event_id = ?', [$event['id']]) > 0) {
        throw conflict('Attendees still have money on their wallets for this event, so cashless cannot be switched off. Their balances are refunded after the event.', 'cashless_balances');
    }
}
// Figures for the organiser's event analytics (real money only).
function cashless_event_analytics(array $event): array
{
    $t = row("SELECT COALESCE(SUM(CASE WHEN test = 0 THEN amount_cents ELSE 0 END),0) AS topups_cents, COUNT(DISTINCT CASE WHEN test = 0 THEN user_id END) AS wallets,
                     COALESCE(SUM(CASE WHEN test = 1 THEN amount_cents ELSE 0 END),0) AS test_topups_cents
                FROM wallet_topups WHERE event_id = ? AND status = 'confirmed'", [$event['id']]);
    $vendors = array_map(fn($v) => ['id' => $v['id'], 'name' => $v['name'], 'sales' => $v['sales'], 'gross_cents' => $v['gross_cents'], 'commission_cents' => $v['commission_cents'], 'payable_cents' => $v['payable_cents']],
        vendor_settlement_rows('v.event_id = ?', [$event['id']]));
    return ['vendors' => $vendors, 'cashless' => ['topups_cents' => (int) $t['topups_cents'], 'wallets' => (int) $t['wallets'], 'test_topups_cents' => (int) $t['test_topups_cents'],
        'outstanding_cents' => (int) val('SELECT COALESCE(SUM(balance_cents),0) FROM cashless_wallets WHERE event_id = ?', [$event['id']])]];
}

// ============================================================== checks
// Every rand on an attendee balance is in the ledger: live balances, plus
// money waiting in wallet refund requests, equal the wallet: accounts.
function cashless_ledger_check(): array
{
    $ledger = -(int) val("SELECT COALESCE(SUM(amount_cents),0) FROM ledger_entries WHERE account LIKE 'wallet:%'");
    $held = (int) val("SELECT COALESCE(SUM(r.amount_cents),0) FROM refunds r JOIN payments p ON p.id = r.payment_id
                        WHERE r.kind = 'wallet_balance' AND p.environment = 'live' AND r.status IN ('requested','processing','manual_pending','failed')");
    $expected = (int) val('SELECT COALESCE(SUM(balance_cents),0) FROM cashless_wallets') + $held;
    return ['account' => 'wallets', 'ledgerCents' => $ledger, 'expectedCents' => $expected, 'ok' => $ledger === $expected];
}
