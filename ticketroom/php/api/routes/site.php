<?php
// /api/site/* — banner, hours, posters, callback requests, assistant, unsubscribe-by-email.
declare(strict_types=1);

route('GET', '/api/site', function () {
    $s = settings_all();
    $posters = rows('SELECT id, title, subtitle, image_upload_id, link_url, placement FROM ad_posters
                      WHERE active = 1 AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at > ?) ORDER BY sort_order, created_at DESC LIMIT 12', [now_iso(), now_iso()]);
    $today = gmdate('Y-m-d');
    return [
        'banner' => $s['banner']['enabled'] ? ['text' => $s['banner']['text'], 'linkText' => $s['banner']['linkText'] ?? null, 'linkUrl' => $s['banner']['linkUrl'] ?? null] : null,
        'maintenance' => $s['maintenance']['enabled'] ? ['message' => $s['maintenance']['message']] : null,
        'hours' => hours_status($s['hours']) + ['week' => $s['hours']['week'], 'note' => $s['hours']['note'],
            'upcomingHolidays' => array_slice(array_values(array_filter($s['hours']['holidays'], fn($h) => $h['date'] >= $today)), 0, 5)],
        'support' => $s['support'], 'legal' => $s['legal'],
        'chatbot' => ['enabled' => $s['chatbot']['enabled'], 'greeting' => $s['chatbot']['greeting']],
        'posters' => $posters, 'cardPaymentsEnabled' => false,
    ];
});

const CB_CATEGORIES = ['tickets', 'refund', 'tag', 'payment', 'account', 'organiser', 'advertising', 'callback', 'other'];
route('POST', '/api/site/callback', function () {
    limit('callback', 5, 3600);
    $b = check(body(), ['fullName' => R::str(['min' => 2, 'max' => 120]), 'phone' => R::contactPhone(), 'email' => R::email(),
        'topic' => R::oneOf(CB_CATEGORIES, ['optional' => true, 'fallback' => 'callback']), 'message' => R::text(['max' => 2000]),
        'preferredTime' => R::str(['optional' => true, 'max' => 60]), 'source' => R::oneOf(['web', 'chat'], ['optional' => true, 'fallback' => 'web'])]);
    if ($b['message'] === '') throw invalid(['message' => 'This field is required.']);
    $s = settings_all();
    $ref = reference('CB');
    tx(function () use ($b, $s, $ref) {
        $now = now_iso();
        insert('support_cases', ['id' => uuid(), 'reference' => $ref, 'user_id' => user()['id'] ?? null, 'email' => $b['email'], 'category' => $b['topic'],
            'subject' => "Callback request: {$b['topic']}", 'body' => $b['message'], 'status' => 'open', 'full_name' => $b['fullName'], 'phone' => $b['phone'],
            'preferred_time' => $b['preferredTime'] ?? null, 'source' => $b['source'], 'due_at' => iso_in(48 * 3600), 'created_at' => $now, 'updated_at' => $now]);
        outbox_enqueue(['to' => $s['support']['email'], 'subject' => "[TicketRoom] Callback $ref — {$b['topic']}",
            'body' => "New callback request $ref\n\nName: {$b['fullName']}\nPhone: {$b['phone']}\nEmail: {$b['email']}\nTopic: {$b['topic']}\nPreferred time: " . ($b['preferredTime'] ?? 'any') . "\nVia: {$b['source']}\n\n{$b['message']}\n\nRespond within {$s['support']['responseTime']}. Manage it in Admin portal → Support."]);
        outbox_enqueue(['to' => $b['email'], 'userId' => user()['id'] ?? null] + tpl('callbackReceived', ['name' => $b['fullName'], 'reference' => $ref,
            'responseTime' => $s['support']['responseTime'], 'email' => $s['support']['email'], 'hoursNote' => $s['hours']['note']]));
    });
    return json_out(['reference' => $ref, 'responseTime' => $s['support']['responseTime']], 201);
});

route('POST', '/api/site/chat', function () {
    limit('chat', 20, 60);
    limit('chatday', 200, 86400);
    if (!setting('chatbot')['enabled']) throw new AppError(503, 'assistant_off', 'The assistant is offline. Please request a callback or email us.');
    $b = check(body(), ['message' => R::str(['min' => 1, 'max' => 500]), 'conversation' => R::str(['optional' => true, 'max' => 40, 'pattern' => '/^[A-Za-z0-9_-]+$/']),
        'history' => R::arr(R::obj(['role' => R::oneOf(['user', 'assistant']), 'text' => R::str(['max' => 2000])]), ['optional' => true, 'max' => 12])]);
    return assistant_reply($b['message'], $b['history'] ?? [], $b['conversation'] ?? random_token(9));
});

route('POST', '/api/site/chat/:id/feedback', function ($a) {
    limit('chatfb', 30, 60);
    $b = check(body(), ['helpful' => R::bool()]);
    q('UPDATE chat_messages SET helpful = ? WHERE id = ?', [$b['helpful'] ? 1 : 0, (int) $a['id']]);
    return ['ok' => true];
});

route('POST', '/api/site/posters/:id/click', function ($a) {
    limit('adclick', 60, 60);
    if (preg_match('/^[0-9a-f-]{36}$/', $a['id'])) q('UPDATE ad_posters SET clicks = clicks + 1 WHERE id = ?', [$a['id']]);
    return ['ok' => true];
});

// Always answers the same way; only sends a signed link to the address itself.
route('POST', '/api/site/unsubscribe-request', function () {
    limit('unsubreq', 5, 3600);
    $b = check(body(), ['email' => R::email()]);
    $u = row("SELECT id, full_name FROM users WHERE lower(email) = ? AND status = 'active'", [$b['email']]);
    $n = row("SELECT id FROM newsletter_subscribers WHERE lower(email) = ? AND status <> 'unsubscribed'", [$b['email']]);
    if ($u || $n) {
        $url = base_url() . '/unsubscribe?t=' . sign_link($u ? ['u' => $u['id'], 'all' => true] : ['n' => $n['id']], 7 * 86400);
        outbox_enqueue(['to' => $b['email'], 'userId' => $u['id'] ?? null] + tpl('unsubscribeLink', ['name' => $u['full_name'] ?? null, 'url' => $url]));
    }
    return ['ok' => true, 'message' => "If that email is on any TicketRoom list, we've sent it a link to unsubscribe from all marketing."];
});

// ---- TicketRoom updates (newsletter). Double opt-in: a subscription only
// counts once the person clicks the link in the confirmation email.
const NEWS_CONFIRM_TTL = 7 * 86400;
route('POST', '/api/site/subscribe', function () {
    limit('subscribe', 10, 3600);
    $b = check(body(), ['email' => R::email(), 'source' => R::str(['optional' => true, 'max' => 40])]);
    $email = $b['email'];
    $done = ['ok' => true, 'status' => 'pending', 'message' => "Nearly done. We've sent an email to $email: click the link in it to confirm."];
    $row = row('SELECT * FROM newsletter_subscribers WHERE lower(email) = ?', [$email]);
    if ($row && $row['status'] === 'subscribed') return ['ok' => true, 'status' => 'subscribed', 'message' => "You're already subscribed. Updates go to $email."];
    $now = now_iso();
    // A signed-in person whose email is already confirmed needs no second email.
    $u = user();
    $direct = $u && strtolower($u['email']) === $email && $u['emailVerified'];
    $id = $row['id'] ?? uuid();
    tx(function () use ($row, $id, $email, $now, $direct, $b) {
        if ($row) q('UPDATE newsletter_subscribers SET status = ?, source = ?, updated_at = ?, confirmed_at = ?, unsubscribed_at = NULL WHERE id = ?', [$direct ? 'subscribed' : 'pending', $b['source'] ?? 'web', $now, $direct ? $now : null, $id]);
        else insert('newsletter_subscribers', ['id' => $id, 'email' => $email, 'status' => $direct ? 'subscribed' : 'pending', 'source' => $b['source'] ?? 'web', 'created_at' => $now, 'updated_at' => $now, 'confirmed_at' => $direct ? $now : null]);
    });
    if ($direct) return ['ok' => true, 'status' => 'subscribed', 'message' => "You're subscribed. Updates go to $email."];
    // Only one confirmation email per address every 10 minutes.
    if (!$row || $row['status'] !== 'pending' || to_unix($row['updated_at']) < microtime(true) - 600) {
        outbox_enqueue(['to' => $email] + tpl('newsletterConfirm', ['url' => base_url() . '/subscribe?t=' . sign_link(['n' => $id, 'confirm' => true], NEWS_CONFIRM_TTL)]));
    }
    return $done;
});
route('POST', '/api/site/subscribe/confirm', function () {
    limit('subconfirm', 30, 3600);
    $b = check(body(), ['token' => R::str(['max' => 600])]);
    $d = verify_link($b['token']);
    $row = $d && !empty($d['n']) && !empty($d['confirm']) ? row('SELECT * FROM newsletter_subscribers WHERE id = ?', [$d['n']]) : null;
    if (!$row) throw bad('This confirmation link is invalid or has expired. Subscribe again and we will send a new one.');
    if ($row['status'] !== 'subscribed') q("UPDATE newsletter_subscribers SET status = 'subscribed', confirmed_at = ?, updated_at = ?, unsubscribed_at = NULL WHERE id = ?", [now_iso(), now_iso(), $row['id']]);
    return ['ok' => true, 'email' => $row['email']];
});
