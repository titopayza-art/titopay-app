<?php
/**
 * Web routes and controllers. The REST API is in gateway.php.
 */
declare(strict_types=1);

final class Router
{
    private array $routes = [];

    public function add(string $methods, string $pattern, callable $handler): void
    {
        $re = '#^' . preg_replace('#\{(\w+)\}#', '(?P<$1>[^/]+)', rtrim($pattern, '/') ?: '/') . '$#';
        foreach (explode('|', $methods) as $m) $this->routes[] = [$m, $re, $handler];
    }

    public function dispatch(string $method, string $path): void
    {
        $path = rtrim($path, '/') ?: '/';
        foreach ($this->routes as [$m, $re, $h]) {
            if ($m === $method && preg_match($re, $path, $mm)) {
                $h(...array_filter($mm, 'is_string', ARRAY_FILTER_USE_KEY));
                return;
            }
        }
        http_response_code(404);
        render('site/404', ['title' => 'Page not found']);
    }
}

/** What the credit balance buys at this account's prices, e.g. ['sms' => 54275, 'store_sms' => 31480, 'qr' => 787, 'email' => ...]. */
function balance_units(array $org): array
{
    $bal = max(0.0, (float) $org['balance']);
    $out = [];
    foreach (['sms' => 'sms', 'store_sms' => 'store_sms', 'qr' => 'qr_code', 'email' => 'email', 'verify' => 'verify_id'] as $k => $unit) {
        $p = Billing::price($org, $unit)['price'];
        $out[$k] = $p > 0 ? (int) floor($bal / $p + 1e-9) : 0;
    }
    return $out;
}

function service_names(): array
{
    return array_map(fn($s) => $s['name'], Catalog::services());
}

function channel_label(string $c): string
{
    return ['chat' => 'Chat', 'whatsapp' => 'WhatsApp', 'email' => 'Email', 'web' => 'Web form', 'api' => 'API', 'system' => 'System'][$c] ?? ucfirst($c);
}

function require_org(): array
{
    Auth::requireUser();
    $org = Auth::org();
    if (!$org) redirect('/admin');
    return $org;
}

function paginate_sql(int $perPage = 50): array
{
    $page = max(1, (int) ($_GET['page'] ?? 1));
    return [$page, $perPage, ($page - 1) * $perPage];
}

function chart_series(int $orgId, string $env, int $days = 30): array
{
    $rows = DB::all("SELECT substr(created_at, 1, 10) d, service, COUNT(*) c, SUM(amount) a FROM messages WHERE org_id = ? AND env = ? AND created_at >= ? GROUP BY substr(created_at, 1, 10), service", [$orgId, $env, ts("-$days days")]);
    $byDay = [];
    for ($i = $days - 1; $i >= 0; $i--) $byDay[gmdate('Y-m-d', strtotime("-$i days"))] = ['count' => 0, 'amount' => 0.0];
    foreach ($rows as $r) {
        if (!isset($byDay[$r['d']])) continue;
        $byDay[$r['d']]['count'] += (int) $r['c'];
        $byDay[$r['d']]['amount'] += (float) $r['a'];
    }
    return $byDay;
}

$r = new Router();

// ---------------------------------------------------------------------------
// Public site
// ---------------------------------------------------------------------------

$r->add('GET', '/', fn() => render('site/home', ['title' => 'SeaGeek | Intelligence. Connected.', 'nav' => 'home']));
$r->add('GET', '/pricing', fn() => render('site/pricing', ['title' => 'Pricing', 'nav' => 'pricing',
    'plans' => DB::all('SELECT * FROM plans WHERE active = 1 ORDER BY sort'), 'rates' => DB::all('SELECT * FROM rates ORDER BY service, price')]));
$r->add('GET', '/desk', fn() => render('site/desk', ['title' => 'Desk', 'nav' => 'desk']));
$r->add('GET', '/developers', fn() => render('site/developers', ['title' => 'Developers', 'nav' => 'developers']));
$r->add('GET', '/docs', fn() => render('docs/index', ['title' => 'API documentation', 'nav' => 'developers', 'services' => Catalog::services()]));
$r->add('GET', '/docs/search.json', fn() => json_out(Docs::searchIndex()));
$r->add('GET', '/docs/openapi.json', fn() => json_out(require APP_DIR . '/openapi.php'));
$r->add('GET', '/docs/{service}', function ($service) {
    if (isset(Docs::guides()[$service])) render('docs/guide', ['title' => Docs::guides()[$service][0] . ' | SeaGeek API', 'nav' => 'developers', 'slug' => $service]);
    $all = Catalog::services();
    if (!isset($all[$service])) { http_response_code(404); render('site/404', ['title' => 'Not found']); }
    $rates = $all[$service]['units'] ? DB::all('SELECT * FROM rates WHERE unit IN (' . implode(',', array_fill(0, count($all[$service]['units']), '?')) . ')', $all[$service]['units']) : [];
    render('docs/service', ['title' => $all[$service]['name'] . ' API', 'nav' => 'developers', 'slug' => $service, 's' => $all[$service], 'services' => $all, 'rates' => $rates]);
});
$r->add('GET', '/about', fn() => render('site/about', ['title' => 'About', 'nav' => 'about']));
$r->add('GET', '/privacy', fn() => render('site/privacy', ['title' => 'Privacy notice']));
$r->add('GET', '/terms', fn() => render('site/terms', ['title' => 'Terms of service']));
$r->add('GET', '/status', function () {
    $partners = DB::all('SELECT name, service, active, last_ok_at, fail_count FROM partners WHERE active = 1 ORDER BY service, priority');
    render('site/status', ['title' => 'Service status', 'partners' => $partners, 'cron' => Settings::get('last_cron_at')]);
});
$r->add('GET|POST', '/contact', function () {
    if (is_post()) {
        csrf_check();
        if (rate_limited('contact:' . client_ip(), 5, 3600)) { flash('error', 'Too many messages from your connection. Try again later.'); redirect('/contact'); }
        $email = (string) input('email');
        if (!filter_var($email, FILTER_VALIDATE_EMAIL) || trim((string) input('message')) === '') { flash('error', 'Add your email address and a message.'); redirect('/contact'); }
        $t = Desk::createTicket((int) Desk::house()['id'], (string) (input('topic') ?: 'Website enquiry'), (string) input('message'), 'web',
            ['name' => input('name'), 'email' => $email, 'phone' => input('phone')], 'normal', [(string) input('topic')]);
        if ($t['ai_active']) Desk::aiRespond($t);
        flash('ok', "Thanks. Your request is #{$t['number']}. We've emailed you a link to follow it.");
        redirect('/contact');
    }
    render('site/contact', ['title' => 'Contact', 'nav' => 'contact']);
});

// Help centres: SeaGeek's own at /help, each customer's at /h/{slug}
$helpIndex = function (array $org) {
    $q = trim((string) ($_GET['q'] ?? ''));
    $args = [$org['id']];
    $sql = 'SELECT * FROM articles WHERE org_id = ? AND published = 1';
    if ($q !== '') { $sql .= ' AND (title LIKE ? OR body LIKE ?)'; $args[] = "%$q%"; $args[] = "%$q%"; }
    render('site/help', ['title' => ($org['is_house'] ? 'Help centre' : $org['name'] . ' help centre'), 'org' => $org, 'q' => $q, 'articles' => DB::all($sql . ' ORDER BY category, title', $args), 'nav' => 'help']);
};
$helpArticle = function (array $org, string $slug) {
    $a = DB::one('SELECT * FROM articles WHERE org_id = ? AND slug = ? AND published = 1', [$org['id'], $slug]);
    if (!$a) { http_response_code(404); render('site/404', ['title' => 'Not found']); }
    DB::run('UPDATE articles SET views = views + 1 WHERE id = ?', [$a['id']]);
    render('site/article', ['title' => $a['title'], 'org' => $org, 'a' => $a, 'related' => DB::all('SELECT title, slug FROM articles WHERE org_id = ? AND category = ? AND id <> ? AND published = 1 LIMIT 5', [$org['id'], $a['category'], $a['id']]), 'nav' => 'help']);
};
$r->add('GET', '/help', fn() => $helpIndex(Desk::house()));
$r->add('GET', '/help/{slug}', fn($slug) => $helpArticle(Desk::house(), $slug));
$r->add('GET', '/h/{org}', function ($org) use ($helpIndex) {
    $o = DB::one('SELECT * FROM orgs WHERE slug = ?', [$org]) ?? (http_response_code(404) && render('site/404', ['title' => 'Not found']));
    $helpIndex($o);
});
$r->add('GET', '/h/{org}/{slug}', function ($org, $slug) use ($helpArticle) {
    $o = DB::one('SELECT * FROM orgs WHERE slug = ?', [$org]) ?? (http_response_code(404) && render('site/404', ['title' => 'Not found']));
    $helpArticle($o, $slug);
});

// A requester's view of their ticket (link from email)
$r->add('GET|POST', '/t/{token}', function ($token) {
    $t = DB::one('SELECT * FROM tickets WHERE token = ?', [$token]);
    if (!$t) { http_response_code(404); render('site/404', ['title' => 'Not found']); }
    if (is_post()) {
        csrf_check();
        if (input('csat')) {
            DB::update('tickets', ['csat' => max(1, min(5, (int) input('csat')))], 'id = ?', [$t['id']]);
            flash('ok', 'Thanks for rating our help.');
        } elseif (trim((string) input('body')) !== '') {
            Desk::customerReply($t, (string) input('body'));
            flash('ok', 'Your reply was added.');
        }
        redirect('/t/' . $token);
    }
    render('site/ticket', ['title' => 'Request #' . $t['number'], 't' => $t, 'org' => DB::one('SELECT * FROM orgs WHERE id = ?', [$t['org_id']]), 'messages' => Desk::messages((int) $t['id'], false)]);
});

// ---------------------------------------------------------------------------
// Chat widget (SeaGeek site, and embeddable on customers' sites with data-org)
// ---------------------------------------------------------------------------

$chatOrg = function (): array {
    $slug = (string) ($_GET['org'] ?? $_POST['org'] ?? '');
    $org = $slug !== '' ? DB::one('SELECT * FROM orgs WHERE slug = ?', [$slug]) : null;
    return $org ?: Desk::house();
};
$chatPayload = function (array $t, int $after = 0): array {
    $msgs = DB::all('SELECT id, author, body, created_at FROM ticket_messages WHERE ticket_id = ? AND internal = 0 AND id > ? ORDER BY id', [$t['id'], $after]);
    return ['token' => $t['token'], 'status' => $t['status'], 'human' => !$t['ai_active'], 'messages' => array_map(fn($m) => ['id' => (int) $m['id'], 'from' => $m['author'], 'text' => $m['body']], $msgs)];
};
$r->add('POST', '/chat/send', function () use ($chatOrg, $chatPayload) {
    header('Access-Control-Allow-Origin: *');
    $text = trim((string) input('text'));
    if ($text === '' || mb_strlen($text) > 2000) json_out(['error' => 'Write a message of up to 2,000 characters.'], 422);
    if (rate_limited('chat:' . client_ip(), 20, 300)) json_out(['error' => 'You are sending messages too quickly. Wait a moment.'], 429);
    $org = $chatOrg();
    $token = (string) input('token');
    $t = $token !== '' ? DB::one('SELECT * FROM tickets WHERE token = ? AND org_id = ?', [$token, $org['id']]) : null;
    $after = (int) input('after');
    if (!$t) {
        $t = Desk::createTicket((int) $org['id'], mb_substr($text, 0, 80), $text, 'chat', ['name' => input('name'), 'email' => input('email')]);
        $t['ai_active'] ? Desk::aiRespond($t) : Desk::handover($t, 'New chat');
    } else {
        if ((input('email')) && !$t['requester_email'] && filter_var(input('email'), FILTER_VALIDATE_EMAIL)) DB::update('tickets', ['requester_email' => strtolower((string) input('email'))], 'id = ?', [$t['id']]);
        Desk::customerReply($t, $text);
    }
    json_out($chatPayload(Desk::ticket((int) $t['id']), $after));
});
$r->add('GET', '/chat/poll', function () use ($chatOrg, $chatPayload) {
    header('Access-Control-Allow-Origin: *');
    $t = DB::one('SELECT * FROM tickets WHERE token = ? AND org_id = ?', [(string) ($_GET['token'] ?? ''), $chatOrg()['id']]);
    if (!$t) json_out(['error' => 'Unknown conversation'], 404);
    json_out($chatPayload($t, (int) ($_GET['after'] ?? 0)));
});

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

$r->add('GET|POST', '/register', function () {
    if (Auth::user()) redirect('/dashboard');
    if (is_post()) {
        csrf_check();
        $_SESSION['old'] = $_POST;
        $email = strtolower((string) input('email'));
        $pw = (string) input('password');
        $problem = match (true) {
            rate_limited('register:' . client_ip(), 5, 3600) => 'Too many sign-ups from your connection. Try again later.',
            trim((string) input('name')) === '' || trim((string) input('company')) === '' => 'Add your name and company.',
            !filter_var($email, FILTER_VALIDATE_EMAIL) => 'Enter a valid email address.',
            (bool) DB::one('SELECT id FROM users WHERE email = ?', [$email]) => 'An account with that email already exists. Sign in instead.',
            !input('terms') => 'Accept the terms of service to continue.',
            default => Auth::passwordProblem($pw),
        };
        if ($problem) { flash('error', $problem); redirect('/register'); }
        DB::tx(function () use ($email, $pw) {
            $slug = slugify((string) input('company'));
            if (DB::one('SELECT id FROM orgs WHERE slug = ?', [$slug])) $slug .= '-' . strtolower(Crypto::token(3));
            $orgId = DB::insert('orgs', ['name' => mb_substr((string) input('company'), 0, 160), 'slug' => $slug, 'customer_no' => Billing::newCustomerNo(), 'phone' => mb_substr((string) input('phone'), 0, 40), 'industry' => mb_substr((string) input('industry'), 0, 60), 'low_balance' => (float) Settings::get('low_balance_default'), 'webhook_secret' => 'whsec_' . Crypto::token(24), 'created_at' => now()]);
            $uid = DB::insert('users', ['org_id' => $orgId, 'name' => mb_substr((string) input('name'), 0, 120), 'email' => $email, 'password_hash' => password_hash($pw, PASSWORD_DEFAULT), 'role' => 'owner', 'created_at' => now()]);
            DB::insert('articles', ['org_id' => $orgId, 'category' => 'General', 'title' => 'How to contact us', 'slug' => 'how-to-contact-us', 'body' => 'Use the chat button or reply to any of our emails and our team will help.', 'published' => 1, 'views' => 0, 'updated_at' => now()]);
            $token = Auth::issueToken($uid, 'verify', '+3 days');
            Mail::queue($email, 'Confirm your email for SeaGeek', 'verify', ['name' => input('name'), 'link' => app_url('/verify/' . $token)]);
            Auth::login($uid);
        });
        unset($_SESSION['old']);
        redirect('/verify-email');
    }
    render('auth/register', ['title' => 'Create your account'], 'auth');
});
$r->add('GET|POST', '/login', function () {
    if (Auth::user()) redirect(Auth::user()['is_admin'] ? '/admin' : '/dashboard');
    if (is_post()) {
        csrf_check();
        if (rate_limited('login:' . client_ip(), 20, 900)) { flash('error', 'Too many sign-in attempts. Wait 15 minutes.'); redirect('/login'); }
        $res = Auth::attempt((string) input('email'), (string) input('password'));
        if ($res !== true) { $_SESSION['old'] = ['email' => input('email')]; flash('error', $res); redirect('/login'); }
        $to = $_SESSION['after_login'] ?? (Auth::user()['is_admin'] ? '/admin' : '/dashboard');
        unset($_SESSION['after_login'], $_SESSION['old']);
        redirect(str_starts_with($to, '/') ? $to : '/dashboard');
    }
    render('auth/login', ['title' => 'Sign in'], 'auth');
});
$r->add('POST', '/logout', function () { csrf_check(); Auth::logout(); redirect('/login'); });
$r->add('GET|POST', '/verify-email', function () {
    $u = Auth::user() ?? redirect('/login');
    if ($u['email_verified_at']) redirect('/dashboard');
    if (is_post()) {
        csrf_check();
        if (!rate_limited('verify-resend:' . $u['id'], 3, 3600)) {
            Mail::queue($u['email'], 'Confirm your email for SeaGeek', 'verify', ['name' => $u['name'], 'link' => app_url('/verify/' . Auth::issueToken((int) $u['id'], 'verify', '+3 days'))]);
        }
        flash('ok', 'We sent a new link to ' . $u['email'] . '.');
        redirect('/verify-email');
    }
    render('auth/verify', ['title' => 'Confirm your email', 'u' => $u], 'auth');
});
$r->add('GET', '/verify/{token}', function ($token) {
    $uid = Auth::useToken($token, 'verify');
    if (!$uid) { flash('error', 'That link has expired. Sign in and request a new one.'); redirect('/login'); }
    DB::update('users', ['email_verified_at' => now()], 'id = ?', [$uid]);
    $u = DB::one('SELECT * FROM users WHERE id = ?', [$uid]);
    if (!DB::value("SELECT COUNT(*) FROM api_keys WHERE org_id = ? AND env = 'test'", [$u['org_id']])) {
        $_SESSION['new_test_key'] = ApiKeys::create((int) $u['org_id'], 'test');
    }
    Mail::queue($u['email'], 'Welcome to SeaGeek', 'welcome', ['user' => $u]);
    Auth::login($uid);
    flash('ok', 'Email confirmed. Your sandbox key is ready.');
    redirect('/dashboard');
});
$r->add('GET|POST', '/forgot', function () {
    if (is_post()) {
        csrf_check();
        $u = DB::one('SELECT * FROM users WHERE email = ?', [strtolower((string) input('email'))]);
        if ($u && !rate_limited('forgot:' . $u['id'], 3, 3600)) {
            Mail::queue($u['email'], 'Reset your SeaGeek password', 'reset', ['name' => $u['name'], 'link' => app_url('/reset/' . Auth::issueToken((int) $u['id'], 'reset', '+1 hour'))]);
        }
        flash('ok', 'If that email has an account, a reset link is on its way. It works for one hour.');
        redirect('/forgot');
    }
    render('auth/forgot', ['title' => 'Reset your password'], 'auth');
});
$r->add('GET|POST', '/reset/{token}', function ($token) {
    if (is_post()) {
        csrf_check();
        $pw = (string) input('password');
        if ($p = Auth::passwordProblem($pw)) { flash('error', $p); redirect('/reset/' . $token); }
        $uid = Auth::useToken($token, 'reset');
        if (!$uid) { flash('error', 'That link has expired. Request a new one.'); redirect('/forgot'); }
        DB::update('users', ['password_hash' => password_hash($pw, PASSWORD_DEFAULT), 'failed_logins' => 0, 'locked_until' => null, 'email_verified_at' => DB::value('SELECT COALESCE(email_verified_at, ?) FROM users WHERE id = ?', [now(), $uid])], 'id = ?', [$uid]);
        DB::run('DELETE FROM sessions WHERE data LIKE ?', ['%"uid";i:' . $uid . ';%']);
        Auth::login($uid);
        flash('ok', 'Password changed.');
        redirect(DB::value('SELECT is_admin FROM users WHERE id = ?', [$uid]) ? '/admin' : '/dashboard');
    }
    render('auth/reset', ['title' => 'Choose a new password', 'token' => $token], 'auth');
});

// ---------------------------------------------------------------------------
// Customer dashboard
// ---------------------------------------------------------------------------

$r->add('GET', '/dashboard', function () {
    $org = require_org();
    $env = $_GET['env'] ?? 'test';
    $env = $env === 'live' ? 'live' : 'test';
    $month = gmdate('Y-m-01 00:00:00');
    $byService = DB::all('SELECT service, COUNT(*) c, SUM(amount) a FROM messages WHERE org_id = ? AND env = ? AND created_at >= ? GROUP BY service', [$org['id'], $env, $month]);
    render('dash/overview', ['title' => 'Overview', 'org' => $org, 'env' => $env, 'series' => chart_series((int) $org['id'], $env), 'byService' => array_column($byService, null, 'service'),
        'plan' => Billing::plan($org), 'aiSpent' => Billing::aiSpentThisMonth((int) $org['id']), 'aiCap' => Billing::aiCap($org), 'desk' => Desk::stats((int) $org['id']),
        'unpaid' => DB::all("SELECT * FROM invoices WHERE org_id = ? AND status = 'unpaid' ORDER BY due_at", [$org['id']]),
        'keys' => DB::value('SELECT COUNT(*) FROM api_keys WHERE org_id = ? AND revoked_at IS NULL', [$org['id']]),
        'recent' => DB::all('SELECT * FROM messages WHERE org_id = ? AND env = ? ORDER BY id DESC LIMIT 8', [$org['id'], $env])], 'app');
});
$r->add('GET|POST', '/dashboard/keys', function () {
    $org = require_org();
    if (is_post()) {
        csrf_check();
        if (input('action') === 'create') {
            $env = input('env') === 'live' ? 'live' : 'test';
            if ($env === 'live' && !$org['live_enabled']) { flash('error', 'Live keys turn on after your first payment.'); redirect('/dashboard/keys'); }
            $_SESSION['new_key'] = ApiKeys::create((int) $org['id'], $env, (string) input('label'));
            audit('key.created', (int) $org['id'], $env);
        } elseif (input('action') === 'revoke') {
            DB::update('api_keys', ['revoked_at' => now()], 'id = ? AND org_id = ?', [(int) input('id'), $org['id']]);
            audit('key.revoked', (int) $org['id'], (string) input('id'));
            flash('ok', 'Key revoked. Requests using it now fail.');
        }
        redirect('/dashboard/keys');
    }
    render('dash/keys', ['title' => 'API keys', 'org' => $org, 'keys' => DB::all('SELECT * FROM api_keys WHERE org_id = ? ORDER BY revoked_at IS NOT NULL, id DESC', [$org['id']])], 'app');
});
$r->add('GET|POST', '/dashboard/service/{svc}', function ($svc) {
    $org = require_org();
    $services = Catalog::services();
    if (!isset($services[$svc])) redirect('/dashboard');
    if (is_post()) {
        csrf_check();
        $a = (string) input('action');
        if ($a === 'sender' && preg_match('/^[A-Za-z0-9 ]{3,11}$/', (string) input('sender'))) {
            DB::update('orgs', ['sms_sender' => input('sender'), 'sms_sender_status' => 'pending'], 'id = ?', [$org['id']]);
            Desk::createTicket((int) Desk::house()['id'], 'Sender ID request: ' . input('sender'), "Organisation {$org['name']} (#{$org['id']}) asked for sender ID " . input('sender'), 'system', ['name' => Auth::user()['name'], 'email' => Auth::user()['email']], 'normal', ['sender-id']);
            flash('ok', 'Sender ID submitted. Approval with the networks usually takes 1 to 3 working days.');
        } elseif ($a === 'domain' && preg_match('/^[a-z0-9.-]+\.[a-z]{2,}$/i', (string) input('domain'))) {
            DB::update('orgs', ['mail_domain' => strtolower((string) input('domain')), 'mail_domain_status' => 'pending'], 'id = ?', [$org['id']]);
            flash('ok', 'Domain saved. Add the DNS records below, then we verify it automatically.');
        } elseif ($a === 'wa_number') {
            $phone = Gateway::phone((string) input('phone'));
            if (!$phone) { flash('error', 'Enter the number in international format, e.g. +27105550123.'); redirect("/dashboard/service/$svc"); }
            $plan = Billing::plan($org);
            if ((int) DB::value('SELECT COUNT(*) FROM wa_numbers WHERE org_id = ?', [$org['id']]) >= (int) $plan['wa_numbers']) { flash('error', "Your plan allows {$plan['wa_numbers']} WhatsApp number(s). Upgrade to add more."); redirect("/dashboard/service/$svc"); }
            DB::insert('wa_numbers', ['org_id' => $org['id'], 'phone' => $phone, 'display_name' => mb_substr((string) input('display_name'), 0, 80), 'status' => 'pending', 'created_at' => now()]);
            Desk::createTicket((int) Desk::house()['id'], 'WhatsApp number to onboard: ' . $phone, "{$org['name']} (#{$org['id']}) wants to connect $phone as \"" . input('display_name') . '"', 'system', ['name' => Auth::user()['name'], 'email' => Auth::user()['email']], 'high', ['whatsapp-onboarding']);
            flash('ok', 'Number submitted. We register it with Meta and email you when it is live.');
        } elseif ($a === 'kyb') {
            DB::update('orgs', ['company_reg' => mb_substr((string) input('company_reg'), 0, 40), 'address' => mb_substr((string) input('address'), 0, 300), 'use_case' => mb_substr((string) input('use_case'), 0, 500), 'kyb_status' => 'pending'], 'id = ?', [$org['id']]);
            Desk::createTicket((int) Desk::house()['id'], 'KYB review: ' . $org['name'], 'Reg: ' . input('company_reg') . "\nUse case: " . input('use_case'), 'system', ['name' => Auth::user()['name'], 'email' => Auth::user()['email']], 'high', ['kyb']);
            flash('ok', 'Thanks. We review business verifications within one working day.');
        } elseif ($a === 'ai_limits') {
            $cap = input('ai_monthly_cap') === '' ? null : max(0, (float) input('ai_monthly_cap'));
            $tok = input('ai_max_tokens') === '' ? null : max(16, (int) input('ai_max_tokens'));
            DB::update('orgs', ['ai_monthly_cap' => $cap, 'ai_max_tokens' => $tok], 'id = ?', [$org['id']]);
            flash('ok', 'AI limits saved.');
        } elseif ($a === 'agent') {
            $prov = input('provider') === 'openai' ? 'openai' : 'anthropic';
            $model = (string) input('model');
            if (!Catalog::aiModel($prov, $model)) { flash('error', 'Pick a model from the list.'); redirect("/dashboard/service/$svc"); }
            $data = ['name' => mb_substr((string) input('name'), 0, 80) ?: 'Support agent', 'provider' => $prov, 'model' => $model, 'instructions' => mb_substr((string) input('instructions'), 0, 8000), 'knowledge' => mb_substr((string) input('knowledge'), 0, 60000), 'handover' => input('handover') ? 1 : 0, 'active' => input('active') ? 1 : 0];
            if ($id = (int) input('id')) DB::update('ai_agents', $data, 'id = ? AND org_id = ?', [$id, $org['id']]);
            else DB::insert('ai_agents', $data + ['public_id' => public_id('agt'), 'org_id' => $org['id'], 'created_at' => now()]);
            flash('ok', 'Agent saved.');
        } elseif ($a === 'try') {
            $body = json_decode((string) input('payload'), true);
            [$m, $p] = explode(' ', (string) input('endpoint'), 2) + [1 => ''];
            $res = is_array($body) || $m === 'GET' ? Gateway::internal($org, $m, ltrim(str_replace('/v1/', '', $p), '/'), $body ?: []) : [400, ['error' => ['type' => 'invalid_json', 'message' => 'The request body is not valid JSON.']]];
            $_SESSION['playground'] = ['endpoint' => input('endpoint'), 'payload' => (string) input('payload'), 'status' => $res[0], 'response' => json_encode($res[1], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)];
        }
        redirect("/dashboard/service/$svc");
    }
    $env = $_GET['env'] ?? 'test';
    render('dash/service', ['title' => $services[$svc]['name'], 'org' => $org, 'svc' => $svc, 's' => $services[$svc], 'env' => $env === 'live' ? 'live' : 'test',
        'recent' => DB::all('SELECT * FROM messages WHERE org_id = ? AND service = ? ORDER BY id DESC LIMIT 25', [$org['id'], $svc]),
        'rates' => $services[$svc]['units'] ? array_map(fn($u) => ['unit' => $u] + Billing::price($org, $u), $services[$svc]['units']) : [],
        'numbers' => DB::all('SELECT * FROM wa_numbers WHERE org_id = ? ORDER BY id', [$org['id']]),
        'agents' => DB::all('SELECT * FROM ai_agents WHERE org_id = ? ORDER BY id', [$org['id']]),
        'inbound' => $svc === 'whatsapp' ? DB::all("SELECT * FROM messages WHERE org_id = ? AND service = 'whatsapp' AND direction = 'in' ORDER BY id DESC LIMIT 20", [$org['id']]) : [],
        'aiSpent' => Billing::aiSpentThisMonth((int) $org['id']), 'plan' => Billing::plan($org)], 'app');
});
$r->add('GET', '/dashboard/usage', function () {
    $org = require_org();
    [$page, $per, $off] = paginate_sql(50);
    $env = ($_GET['env'] ?? 'live') === 'test' ? 'test' : 'live';
    $svc = (string) ($_GET['service'] ?? '');
    $where = 'org_id = ? AND env = ?';
    $args = [$org['id'], $env];
    if ($svc !== '') { $where .= ' AND service = ?'; $args[] = $svc; }
    if (($_GET['format'] ?? '') === 'csv') {
        header('Content-Type: text/csv');
        header('Content-Disposition: attachment; filename="seageek-usage-' . gmdate('Y-m-d') . '.csv"');
        $out = fopen('php://output', 'w');
        fputcsv($out, ['id', 'created_at', 'service', 'to', 'status', 'quantity', 'amount_zar', 'reference']);
        foreach (DB::all("SELECT * FROM messages WHERE $where ORDER BY id DESC LIMIT 50000", $args) as $m) fputcsv($out, [$m['public_id'], $m['created_at'], $m['service'], $m['to_addr'], $m['status'], $m['quantity'], $m['amount'], $m['reference']]);
        exit;
    }
    render('dash/usage', ['title' => 'Usage', 'org' => $org, 'env' => $env, 'svc' => $svc, 'page' => $page,
        'rows' => DB::all("SELECT * FROM messages WHERE $where ORDER BY id DESC LIMIT $per OFFSET $off", $args),
        'total' => (int) DB::value("SELECT COUNT(*) FROM messages WHERE $where", $args)], 'app');
});
$r->add('GET|POST', '/dashboard/billing', function () {
    $org = require_org();
    $user = Auth::user();
    if (is_post()) {
        csrf_check();
        $a = (string) input('action');
        if ($a === 'topup') {
            $amt = round((float) input('amount'), 2);
            if ($amt < (float) Settings::get('min_topup') || $amt > 200000) { flash('error', 'Top up between ' . zar(Settings::get('min_topup'), 0) . ' and R200,000.'); redirect('/dashboard/billing'); }
            $inv = Billing::createInvoice($org, 'topup', $amt, 'Prepaid credit ' . zar($amt));
            redirect('/dashboard/pay/' . $inv['number']);
        } elseif ($a === 'plan') {
            $plan = DB::one('SELECT * FROM plans WHERE code = ? AND active = 1', [(string) input('plan')]);
            if (!$plan) redirect('/dashboard/billing');
            if ((float) $plan['price'] <= 0) {
                DB::update('orgs', ['plan_code' => $plan['code'], 'plan_renews_at' => null], 'id = ?', [$org['id']]);
                flash('ok', 'You are now on ' . $plan['name'] . '.');
            } else {
                DB::run("UPDATE invoices SET status = 'void' WHERE org_id = ? AND kind = 'plan' AND status = 'unpaid' AND plan_code <> ?", [$org['id'], $plan['code']]);
                $inv = DB::one("SELECT * FROM invoices WHERE org_id = ? AND kind = 'plan' AND status = 'unpaid' AND plan_code = ?", [$org['id'], $plan['code']])
                    ?? Billing::createInvoice($org, 'plan', (float) $plan['price'], $plan['name'] . ' plan, first month', $plan['code']);
                if (input('from_credit') && (float) $org['balance'] >= (float) $inv['total']) {
                    Billing::charge((int) $org['id'], (float) $inv['total'], 'plan', $inv['number'], $plan['name'] . ' plan paid from credit');
                    Billing::markPaid((int) $inv['id'], 'credit', 'balance', (float) $inv['total']);
                    flash('ok', 'Plan changed to ' . $plan['name'] . '. Included credit has been added.');
                } else {
                    redirect('/dashboard/pay/' . $inv['number']);
                }
            }
        } elseif ($a === 'pay') {
            $inv = DB::one('SELECT number FROM invoices WHERE id = ? AND org_id = ?', [(int) input('invoice'), $org['id']]);
            if ($inv) redirect('/dashboard/pay/' . $inv['number']);
        } elseif ($a === 'auto_pay') {
            DB::update('orgs', ['auto_pay' => input('auto_pay') ? 1 : 0], 'id = ?', [$org['id']]);
            flash('ok', 'Saved.');
        }
        redirect('/dashboard/billing');
    }
    render('dash/billing', ['title' => 'Billing and credit', 'org' => $org, 'plan' => Billing::plan($org),
        'plans' => DB::all('SELECT * FROM plans WHERE active = 1 ORDER BY sort'),
        'invoices' => DB::all("SELECT * FROM invoices WHERE org_id = ? AND status <> 'void' ORDER BY id DESC LIMIT 8", [$org['id']]),
        'ledger' => DB::all('SELECT * FROM ledger WHERE org_id = ? ORDER BY id DESC LIMIT 30', [$org['id']])], 'app');
});
$r->add('GET', '/dashboard/invoice/{number}', function ($number) {
    $org = require_org();
    $inv = DB::one('SELECT * FROM invoices WHERE number = ? AND org_id = ?', [$number, $org['id']]);
    if (!$inv) redirect('/dashboard/billing');
    render('dash/invoice', ['title' => 'Invoice ' . $inv['number'], 'inv' => $inv, 'org' => $org, 'items' => Billing::items((int) $inv['id']), 'payments' => DB::all('SELECT * FROM payments WHERE invoice_id = ?', [$inv['id']])], 'print');
});
$r->add('GET|POST', '/dashboard/webhooks', function () {
    $org = require_org();
    if (is_post()) {
        csrf_check();
        if (input('action') === 'save') {
            $url = (string) input('url');
            if ($url !== '' && (!filter_var($url, FILTER_VALIDATE_URL) || !str_starts_with($url, 'https://'))) { flash('error', 'Use an https:// URL.'); redirect('/dashboard/webhooks'); }
            DB::update('orgs', ['webhook_url' => $url ?: null], 'id = ?', [$org['id']]);
            flash('ok', 'Webhook URL saved.');
        } elseif (input('action') === 'rotate') {
            DB::update('orgs', ['webhook_secret' => 'whsec_' . Crypto::token(24)], 'id = ?', [$org['id']]);
            flash('ok', 'New signing secret created. Update your endpoint.');
        } elseif (input('action') === 'test') {
            Webhooks::queue((int) $org['id'], 'ping', ['message' => 'Test event from the SeaGeek dashboard']);
            Webhooks::deliver(5);
            flash('ok', 'Test event sent. See the result below.');
        }
        redirect('/dashboard/webhooks');
    }
    render('dash/webhooks', ['title' => 'Webhooks', 'org' => $org, 'deliveries' => DB::all('SELECT * FROM webhook_deliveries WHERE org_id = ? ORDER BY id DESC LIMIT 30', [$org['id']])], 'app');
});
$r->add('GET|POST', '/dashboard/settings', function () {
    $org = require_org();
    $u = Auth::user();
    if (is_post()) {
        csrf_check();
        if (input('action') === 'org') {
            DB::update('orgs', ['name' => mb_substr((string) input('name'), 0, 160) ?: $org['name'], 'phone' => mb_substr((string) input('phone'), 0, 40), 'vat_no' => mb_substr((string) input('vat_no'), 0, 40), 'website' => mb_substr((string) input('website'), 0, 200), 'address' => mb_substr((string) input('address'), 0, 300), 'low_balance' => max(0, (float) input('low_balance'))], 'id = ?', [$org['id']]);
            Billing::maybeEnableLive((int) $org['id']);
            flash('ok', 'Company details saved.');
        } elseif (input('action') === 'password') {
            if (!password_verify((string) input('current'), $u['password_hash'])) { flash('error', 'Your current password is not right.'); redirect('/dashboard/settings'); }
            if ($p = Auth::passwordProblem((string) input('new'))) { flash('error', $p); redirect('/dashboard/settings'); }
            DB::update('users', ['password_hash' => password_hash((string) input('new'), PASSWORD_DEFAULT)], 'id = ?', [$u['id']]);
            flash('ok', 'Password changed.');
        } elseif (input('action') === 'invite' && $u['role'] === 'owner') {
            $email = strtolower((string) input('email'));
            if (!filter_var($email, FILTER_VALIDATE_EMAIL) || DB::one('SELECT id FROM users WHERE email = ?', [$email])) { flash('error', 'That email is invalid or already has an account.'); redirect('/dashboard/settings'); }
            $role = in_array(input('role'), ['agent', 'developer', 'billing'], true) ? input('role') : 'agent';
            if ($role === 'agent' && (int) DB::value("SELECT COUNT(*) FROM users WHERE org_id = ? AND role IN ('owner','agent')", [$org['id']]) >= (int) Billing::plan($org)['desk_agents']) {
                flash('error', 'Your plan has no free Desk agent seats. Upgrade to add more.'); redirect('/dashboard/settings');
            }
            $uid = DB::insert('users', ['org_id' => $org['id'], 'name' => mb_substr((string) input('name'), 0, 120) ?: $email, 'email' => $email, 'password_hash' => password_hash(Crypto::token(), PASSWORD_DEFAULT), 'role' => $role, 'email_verified_at' => now(), 'created_at' => now()]);
            Mail::queue($email, "You've been added to {$org['name']} on SeaGeek", 'invite', ['org' => $org, 'by' => $u, 'link' => app_url('/reset/' . Auth::issueToken($uid, 'reset', '+3 days'))]);
            flash('ok', "Invitation sent to $email.");
        } elseif (input('action') === 'remove_user' && $u['role'] === 'owner' && (int) input('id') !== (int) $u['id']) {
            DB::run('DELETE FROM users WHERE id = ? AND org_id = ?', [(int) input('id'), $org['id']]);
            flash('ok', 'User removed.');
        }
        redirect('/dashboard/settings');
    }
    render('dash/settings', ['title' => 'Settings', 'org' => $org, 'u' => $u, 'team' => DB::all('SELECT * FROM users WHERE org_id = ? ORDER BY id', [$org['id']]), 'plan' => Billing::plan($org)], 'app');
});

// Desk (shared by customers and SeaGeek staff)
function desk_inbox(array $org, string $base): never
{
    $view = (string) ($_GET['view'] ?? 'open');
    $views = ['open' => "status IN ('new','open')", 'mine' => "status IN ('new','open') AND assignee_id = " . (int) Auth::id(), 'pending' => "status = 'pending'", 'ai' => "ai_active = 1 AND status IN ('new','open')", 'breached' => "tags LIKE '%sla-breach%' AND status IN ('new','open')", 'solved' => "status IN ('solved','closed')", 'all' => '1=1'];
    $where = $views[$view] ?? $views['open'];
    $q = trim((string) ($_GET['q'] ?? ''));
    $args = [$org['id']];
    if ($q !== '') { $where .= ' AND (subject LIKE ? OR requester_email LIKE ? OR requester_name LIKE ?)'; array_push($args, "%$q%", "%$q%", "%$q%"); }
    $counts = [];
    foreach ($views as $k => $w) $counts[$k] = (int) DB::value("SELECT COUNT(*) FROM tickets WHERE org_id = ? AND $w", [$org['id']]);
    render('dash/desk', ['title' => 'Desk', 'org' => $org, 'base' => $base, 'view' => $view, 'q' => $q, 'counts' => $counts, 'stats' => Desk::stats((int) $org['id']),
        'tickets' => DB::all("SELECT t.*, u.name assignee FROM tickets t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.org_id = ? AND $where ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.updated_at DESC LIMIT 200", $args)], 'app');
}
function desk_ticket(array $org, string $base, int $number): never
{
    $t = DB::one('SELECT * FROM tickets WHERE org_id = ? AND number = ?', [$org['id'], $number]);
    if (!$t) redirect($base);
    if (is_post()) {
        csrf_check();
        $a = (string) input('action');
        if ($a === 'reply' && trim((string) input('body')) !== '') {
            Desk::agentReply($t, (int) Auth::id(), (string) input('body'), (bool) input('internal'), (string) input('status'));
            flash('ok', input('internal') ? 'Note added.' : 'Reply sent.');
        } elseif ($a === 'update') {
            DB::update('tickets', ['priority' => in_array(input('priority'), Desk::PRIORITIES, true) ? input('priority') : $t['priority'], 'assignee_id' => (int) input('assignee_id') ?: null, 'tags' => mb_substr((string) input('tags'), 0, 255), 'status' => in_array(input('status'), Desk::STATUSES, true) ? input('status') : $t['status']], 'id = ?', [$t['id']]);
            flash('ok', 'Ticket updated.');
        } elseif ($a === 'ai_draft') {
            $agent = Desk::agentFor((int) $org['id']);
            if ($agent) {
                try {
                    $hist = [];
                    foreach (Desk::messages((int) $t['id'], false) as $m) $hist[] = ($m['author'] === 'customer' ? 'Customer: ' : 'Support: ') . $m['body'];
                    $msg = [['role' => 'user', 'content' => "Draft the next reply from support to this conversation. Reply with the message text only.\n\n" . implode("\n\n", array_slice($hist, -12))]];
                    $res = !empty($agent['house']) ? Ai::complete($agent['provider'], $agent['model'], Ai::agentSystemPrompt($org, null), $msg, 800) : Ai::meteredChat($org, 'live', $agent['provider'], $agent['model'], Ai::agentSystemPrompt($org, $agent), $msg, 800);
                    $_SESSION['draft'][$t['id']] = $res['text'];
                } catch (Throwable $e) { flash('error', 'The AI could not draft a reply: ' . $e->getMessage()); }
            } else flash('error', 'Set up an AI agent first.');
        }
        redirect("$base/$number");
    }
    $draft = $_SESSION['draft'][$t['id']] ?? '';
    unset($_SESSION['draft'][$t['id']]);
    render('dash/ticket', ['title' => '#' . $t['number'] . ' ' . $t['subject'], 'org' => $org, 'base' => $base, 't' => $t, 'messages' => Desk::messages((int) $t['id']), 'draft' => $draft,
        'agents' => DB::all("SELECT id, name FROM users WHERE org_id = ? OR (is_admin = 1 AND ? = 1)", [$org['id'], (int) $org['is_house']]),
        'macros' => DB::all('SELECT * FROM macros WHERE org_id = ?', [$org['id']]),
        'history' => $t['requester_email'] ? DB::all('SELECT number, subject, status FROM tickets WHERE org_id = ? AND requester_email = ? AND id <> ? ORDER BY id DESC LIMIT 5', [$org['id'], $t['requester_email'], $t['id']]) : []], 'app');
}
function help_admin(array $org, string $base): never
{
    if (is_post()) {
        csrf_check();
        if (input('action') === 'delete') {
            DB::run('DELETE FROM articles WHERE id = ? AND org_id = ?', [(int) input('id'), $org['id']]);
        } elseif (input('action') === 'macro') {
            DB::insert('macros', ['org_id' => $org['id'], 'title' => mb_substr((string) input('title'), 0, 120), 'body' => (string) input('body'), 'set_status' => in_array(input('set_status'), Desk::STATUSES, true) ? input('set_status') : null]);
        } else {
            $data = ['category' => mb_substr((string) input('category'), 0, 80) ?: 'General', 'title' => mb_substr((string) input('title'), 0, 200), 'slug' => slugify((string) input('title')), 'body' => (string) input('body'), 'published' => input('published') ? 1 : 0, 'updated_at' => now()];
            if ($id = (int) input('id')) DB::update('articles', $data, 'id = ? AND org_id = ?', [$id, $org['id']]);
            else DB::insert('articles', $data + ['org_id' => $org['id'], 'views' => 0]);
        }
        flash('ok', 'Saved.');
        redirect($base);
    }
    $edit = isset($_GET['edit']) ? DB::one('SELECT * FROM articles WHERE id = ? AND org_id = ?', [(int) $_GET['edit'], $org['id']]) : null;
    render('dash/help', ['title' => 'Help centre', 'org' => $org, 'base' => $base, 'edit' => $edit, 'articles' => DB::all('SELECT * FROM articles WHERE org_id = ? ORDER BY category, title', [$org['id']]), 'macros' => DB::all('SELECT * FROM macros WHERE org_id = ?', [$org['id']])], 'app');
}
$r->add('GET', '/dashboard/desk', fn() => desk_inbox(require_org(), '/dashboard/desk'));
$r->add('GET|POST', '/dashboard/desk/{n}', fn($n) => desk_ticket(require_org(), '/dashboard/desk', (int) $n));
$r->add('GET|POST', '/dashboard/help-centre', fn() => help_admin(require_org(), '/dashboard/help-centre'));

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

$r->add('GET', '/admin', function () {
    Auth::requireAdmin();
    $month = gmdate('Y-m-01 00:00:00');
    $kpi = [
        'customers' => (int) DB::value('SELECT COUNT(*) FROM orgs WHERE is_house = 0'),
        'live' => (int) DB::value('SELECT COUNT(*) FROM orgs WHERE is_house = 0 AND live_enabled = 1'),
        'locked' => (int) DB::value("SELECT COUNT(*) FROM orgs WHERE status = 'locked'"),
        'mrr' => (float) DB::value("SELECT COALESCE(SUM(p.price),0) FROM orgs o JOIN plans p ON p.code = o.plan_code WHERE o.is_house = 0 AND o.status <> 'closed'"),
        'usage_month' => (float) DB::value("SELECT COALESCE(SUM(amount),0) FROM messages WHERE env = 'live' AND created_at >= ?", [$month]),
        'cost_month' => (float) DB::value("SELECT COALESCE(SUM(cost),0) FROM messages WHERE env = 'live' AND created_at >= ?", [$month]),
        'cash_month' => (float) DB::value("SELECT COALESCE(SUM(amount),0) FROM payments WHERE status = 'complete' AND gateway <> 'credit' AND created_at >= ?", [$month]),
        'balances' => (float) DB::value('SELECT COALESCE(SUM(balance),0) FROM orgs WHERE is_house = 0'),
        'overdue' => (int) DB::value("SELECT COUNT(*) FROM invoices WHERE status = 'unpaid' AND due_at < ?", [now()]),
    ];
    $byService = DB::all("SELECT service, COUNT(*) c, SUM(amount) a, SUM(cost) k FROM messages WHERE env = 'live' AND created_at >= ? GROUP BY service ORDER BY a DESC", [$month]);
    $series = [];
    for ($i = 29; $i >= 0; $i--) $series[gmdate('Y-m-d', strtotime("-$i days"))] = ['count' => 0, 'amount' => 0.0];
    foreach (DB::all("SELECT substr(created_at,1,10) d, COUNT(*) c, SUM(amount) a FROM messages WHERE env = 'live' AND created_at >= ? GROUP BY substr(created_at,1,10)", [ts('-30 days')]) as $row) {
        if (isset($series[$row['d']])) $series[$row['d']] = ['count' => (int) $row['c'], 'amount' => (float) $row['a']];
    }
    render('admin/overview', ['title' => 'Admin', 'kpi' => $kpi, 'byService' => $byService, 'series' => $series,
        'partners' => DB::all('SELECT * FROM partners ORDER BY service, priority'), 'desk' => Desk::stats((int) Desk::house()['id']),
        'queue' => ['email' => (int) DB::value("SELECT COUNT(*) FROM email_outbox WHERE status = 'queued'"), 'webhooks' => (int) DB::value("SELECT COUNT(*) FROM webhook_deliveries WHERE status = 'pending'"), 'messages' => (int) DB::value("SELECT COUNT(*) FROM messages WHERE status = 'queued' AND env = 'live'")],
        'cron' => Settings::get('last_cron_at'),
        'pendingReviews' => DB::all("SELECT id, name, 'KYB' what FROM orgs WHERE kyb_status = 'pending' UNION ALL SELECT id, name, 'Sender ID' FROM orgs WHERE sms_sender_status = 'pending' UNION ALL SELECT o.id, o.name, 'WhatsApp number' FROM wa_numbers w JOIN orgs o ON o.id = w.org_id WHERE w.status = 'pending' UNION ALL SELECT id, name, 'Mail domain' FROM orgs WHERE mail_domain_status = 'pending'"),
        'signups' => DB::all('SELECT o.*, (SELECT email FROM users WHERE org_id = o.id ORDER BY id LIMIT 1) email FROM orgs o WHERE is_house = 0 ORDER BY id DESC LIMIT 6')], 'app');
});
$r->add('GET', '/admin/orgs', function () {
    Auth::requireAdmin('customers');
    $q = trim((string) ($_GET['q'] ?? ''));
    $st = (string) ($_GET['status'] ?? '');
    $where = 'o.is_house = 0';
    $args = [];
    if ($q !== '') { $where .= ' AND (o.name LIKE ? OR o.slug LIKE ? OR o.customer_no = ? OR EXISTS (SELECT 1 FROM users u WHERE u.org_id = o.id AND u.email LIKE ?))'; array_push($args, "%$q%", "%$q%", $q, "%$q%"); }
    if ($st !== '') { $where .= ' AND o.status = ?'; $args[] = $st; }
    render('admin/orgs', ['title' => 'Customers', 'q' => $q, 'st' => $st, 'orgs' => DB::all("SELECT o.*, (SELECT email FROM users WHERE org_id = o.id ORDER BY id LIMIT 1) email, (SELECT COALESCE(SUM(amount),0) FROM messages m WHERE m.org_id = o.id AND m.env = 'live' AND m.created_at >= ?) month_usage FROM orgs o WHERE $where ORDER BY o.id DESC LIMIT 300", array_merge([gmdate('Y-m-01 00:00:00')], $args))], 'app');
});
$r->add('GET|POST', '/admin/orgs/{id}', function ($id) {
    Auth::requireAdmin('customers');
    $org = DB::one('SELECT * FROM orgs WHERE id = ?', [(int) $id]);
    if (!$org) redirect('/admin/orgs');
    if (is_post()) {
        csrf_check();
        $a = (string) input('action');
        if (in_array($a, ['adjust', 'eft', 'limits'], true) && !Auth::can('billing')) { flash('error', 'Changing balances, limits and payments needs the Money permission.'); redirect('/admin/orgs/' . $org['id']); }
        $set = fn(array $d, string $msg) => [DB::update('orgs', $d, 'id = ?', [$org['id']]), audit('admin.' . $a, (int) $org['id'], json_encode($d)), flash('ok', $msg)];
        match ($a) {
            'lock' => $set(['status' => 'locked', 'locked_reason' => mb_substr((string) input('reason'), 0, 200) ?: 'Paused by SeaGeek'], 'Account locked.'),
            'unlock' => $set(['status' => 'active', 'locked_reason' => null], 'Account unlocked.'),
            'close' => $set(['status' => 'closed'], 'Account closed.'),
            'live_on' => $set(['live_enabled' => 1], 'Live access on.'),
            'live_off' => $set(['live_enabled' => 0], 'Live access off.'),
            'kyb' => [$set(['kyb_status' => input('value') === 'approved' ? 'approved' : 'rejected'], input('value') === 'approved' ? 'KYB approved. Services waiting for it are now active.' : 'KYB rejected.'), Services::refreshPending((int) $org['id'])],
            'sender' => $set(['sms_sender_status' => input('value') === 'approved' ? 'approved' : 'rejected'], 'Sender ID updated.'),
            'domain' => $set(['mail_domain_status' => input('value') === 'verified' ? 'verified' : 'rejected'], 'Mail domain updated.'),
            'limits' => $set(['credit_limit' => max(0, (float) input('credit_limit')), 'ai_monthly_cap' => input('ai_monthly_cap') === '' ? null : (float) input('ai_monthly_cap'), 'plan_code' => (string) input('plan_code')], 'Limits saved.'),
            'adjust' => (function () use ($org) {
                $amt = round((float) input('amount'), 2);
                $amt >= 0 ? Billing::credit((int) $org['id'], $amt, 'adjustment', 'admin', (string) input('note') ?: 'Adjustment') : DB::tx(fn() => [DB::update('orgs', ['balance' => (float) DB::value('SELECT balance FROM orgs WHERE id = ?', [$org['id']]) + $amt], 'id = ?', [$org['id']]), DB::insert('ledger', ['org_id' => $org['id'], 'type' => 'adjustment', 'amount' => $amt, 'balance_after' => (float) DB::value('SELECT balance FROM orgs WHERE id = ?', [$org['id']]), 'ref' => 'admin', 'description' => (string) input('note') ?: 'Adjustment', 'created_at' => now()])]);
                audit('admin.adjust', (int) $org['id'], (string) $amt);
                flash('ok', 'Balance adjusted by ' . zar($amt) . '.');
            })(),
            'eft' => (function () use ($org) {
                $inv = DB::one("SELECT * FROM invoices WHERE id = ? AND org_id = ? AND status = 'unpaid'", [(int) input('invoice'), $org['id']]);
                if ($inv) { Billing::markPaid((int) $inv['id'], 'eft', mb_substr((string) input('ref'), 0, 120), (float) $inv['total']); audit('admin.eft', (int) $org['id'], $inv['number']); flash('ok', $inv['number'] . ' marked paid.'); }
            })(),
            'wa' => (function () use ($org) {
                $n = DB::one('SELECT * FROM wa_numbers WHERE id = ? AND org_id = ?', [(int) input('number'), $org['id']]);
                if ($n) {
                    $d = ['status' => in_array(input('status'), ['pending', 'active', 'rejected'], true) ? input('status') : $n['status'], 'partner_id' => (int) input('partner_id') ?: null];
                    if (input('channel_key') !== '') $d['channel_key_enc'] = Crypto::encrypt((string) input('channel_key'));
                    DB::update('wa_numbers', $d, 'id = ?', [$n['id']]);
                    flash('ok', 'WhatsApp number updated.');
                }
            })(),
            'act_as' => (function () use ($org) { $_SESSION['act_as_org'] = (int) $org['id']; audit('admin.act_as', (int) $org['id']); redirect('/dashboard'); })(),
            'service_on' => [Services::activate((int) $org['id'], (string) input('service'), true), audit('admin.service_on', (int) $org['id'], (string) input('service')), flash('ok', 'Service switched on.')],
            'service_off' => [Services::deactivate((int) $org['id'], (string) input('service')), audit('admin.service_off', (int) $org['id'], (string) input('service')), flash('ok', 'Service switched off.')],
            default => null,
        };
        redirect('/admin/orgs/' . $org['id']);
    }
    render('admin/org', ['title' => $org['name'], 'org' => $org, 'plan' => Billing::plan($org), 'plans' => DB::all('SELECT * FROM plans ORDER BY sort'),
        'users' => DB::all('SELECT * FROM users WHERE org_id = ?', [$org['id']]),
        'invoices' => DB::all('SELECT * FROM invoices WHERE org_id = ? ORDER BY id DESC LIMIT 20', [$org['id']]),
        'ledger' => DB::all('SELECT * FROM ledger WHERE org_id = ? ORDER BY id DESC LIMIT 20', [$org['id']]),
        'numbers' => DB::all('SELECT * FROM wa_numbers WHERE org_id = ?', [$org['id']]),
        'waPartners' => DB::all("SELECT id, name FROM partners WHERE service = 'whatsapp'"),
        'usage' => DB::all("SELECT service, COUNT(*) c, SUM(amount) a, SUM(cost) k FROM messages WHERE org_id = ? AND env = 'live' AND created_at >= ? GROUP BY service", [$org['id'], gmdate('Y-m-01 00:00:00')]),
        'audit' => DB::all('SELECT * FROM audit_log WHERE org_id = ? ORDER BY id DESC LIMIT 15', [$org['id']]),
        'services' => Services::all((int) $org['id'])], 'app');
});
$r->add('POST', '/admin/stop-acting', function () { csrf_check(); unset($_SESSION['act_as_org']); redirect('/admin'); });
$r->add('GET', '/admin/partners', function () {
    Auth::requireAdmin('partners');
    render('admin/partners', ['title' => 'Partners', 'partners' => DB::all("SELECT p.*, (SELECT COUNT(*) FROM messages m WHERE m.partner_id = p.id AND m.created_at >= ?) month_count, (SELECT COALESCE(SUM(cost),0) FROM messages m WHERE m.partner_id = p.id AND m.created_at >= ?) month_cost FROM partners p ORDER BY service, priority", [gmdate('Y-m-01 00:00:00'), gmdate('Y-m-01 00:00:00')])], 'app');
});
$r->add('GET|POST', '/admin/partners/{id}', function ($id) {
    Auth::requireAdmin('partners');
    $p = $id === 'new' ? ['id' => 0, 'name' => '', 'service' => 'sms', 'driver' => 'http', 'priority' => 10, 'active' => 0, 'config_enc' => null, 'last_error' => null, 'last_ok_at' => null, 'fail_count' => 0] : DB::one('SELECT * FROM partners WHERE id = ?', [(int) $id]);
    if (!$p) redirect('/admin/partners');
    if (is_post()) {
        csrf_check();
        if (input('action') === 'test') {
            $sample = ['to' => (string) input('test_to'), 'body' => 'SeaGeek partner test', 'subject' => 'SeaGeek partner test', 'html' => '<p>SeaGeek partner test</p>', 'text' => 'SeaGeek partner test', 'from' => Settings::get('mail_from_name') . ' <' . Settings::get('mail_from_address') . '>', 'type' => 'text', 'id' => 'test', 'reference' => 'partner-test'];
            if ($p['service'] === 'mail') $sample['to'] = [(string) input('test_to')];
            try { $res = Adapters::send($p, $p['service'], $sample); } catch (Throwable $e) { $res = ['ok' => false, 'error' => $e->getMessage()]; }
            flash($res['ok'] ? 'ok' : 'error', $res['ok'] ? 'Partner accepted the test. Reference: ' . ($res['external_id'] ?? 'none') : 'Test failed: ' . ($res['error'] ?? 'unknown'));
            redirect('/admin/partners/' . $p['id']);
        }
        $cfg = $p['id'] ? Partners::config($p) : [];
        foreach ((array) ($_POST['cfg'] ?? []) as $k => $v) {
            if (in_array($k, ['secret', 'secret_key', 'api_key'], true) && $v === '') continue; // blank keeps the stored secret
            $cfg[$k] = is_string($v) ? trim($v) : $v;
        }
        $data = ['name' => mb_substr((string) input('name'), 0, 80), 'service' => (string) input('service'), 'driver' => (string) input('driver'), 'priority' => (int) input('priority'), 'active' => input('active') ? 1 : 0, 'config_enc' => Crypto::encrypt(json_encode($cfg))];
        if ($p['id']) DB::update('partners', $data, 'id = ?', [$p['id']]);
        else $p['id'] = DB::insert('partners', $data + ['created_at' => now()]);
        audit('admin.partner_saved', null, $data['name']);
        flash('ok', 'Partner saved.');
        redirect('/admin/partners/' . $p['id']);
    }
    render('admin/partner', ['title' => $p['name'] ?: 'New partner', 'p' => $p, 'cfg' => $p['id'] ? Partners::config($p) : []], 'app');
});
$r->add('GET|POST', '/admin/pricing', function () {
    Auth::requireAdmin('pricing');
    if (is_post()) {
        csrf_check();
        foreach ((array) ($_POST['rate'] ?? []) as $unit => $v) DB::update('rates', ['price' => max(0, (float) $v['price']), 'cost' => max(0, (float) $v['cost'])], 'unit = ?', [$unit]);
        foreach ((array) ($_POST['plan'] ?? []) as $code => $v) {
            DB::update('plans', ['price' => (float) $v['price'], 'included_credit' => (float) $v['included_credit'], 'discount_pct' => (int) $v['discount_pct'], 'ai_monthly_cap' => (float) $v['ai_monthly_cap'], 'ai_max_tokens' => (int) $v['ai_max_tokens'], 'ai_rpm' => (int) $v['ai_rpm'], 'api_rps' => (int) $v['api_rps'], 'desk_agents' => (int) $v['desk_agents'], 'wa_numbers' => (int) $v['wa_numbers'], 'active' => !empty($v['active']) ? 1 : 0], 'code = ?', [$code]);
        }
        foreach ((array) ($_POST['pkg'] ?? []) as $code => $v) {
            DB::update('packages', ['price' => max(0, (float) $v['price']), 'credit' => max(0, (float) $v['credit']), 'active' => !empty($v['active']) ? 1 : 0], 'code = ?', [$code]);
        }
        foreach (['usd_zar', 'ai_markup_pct'] as $k) if (input($k) !== null) Settings::set($k, (string) (float) input($k));
        foreach ((array) ($_POST['svcswitch'] ?? []) as $svc => $v) {
            if (isset(Catalog::baseServices()[$svc]) && in_array($v, ['auto', 'on', 'off'], true)) Settings::set('service_switch_' . $svc, $v === 'auto' ? '' : $v);
        }
        audit('admin.pricing_saved');
        flash('ok', 'Pricing saved. New prices apply to the next request.');
        redirect('/admin/pricing');
    }
    render('admin/pricing', ['title' => 'Plans and pricing', 'plans' => DB::all('SELECT * FROM plans ORDER BY sort'), 'rates' => DB::all('SELECT * FROM rates ORDER BY service, unit'), 'models' => Catalog::aiModels(), 'packages' => DB::all('SELECT * FROM packages ORDER BY service, sort')], 'app');
});
$r->add('GET', '/admin/billing', function () {
    Auth::requireAdmin('billing');
    $st = (string) ($_GET['status'] ?? 'unpaid');
    render('admin/billing', ['title' => 'Invoices and payments', 'st' => $st,
        'invoices' => DB::all('SELECT i.*, o.name org FROM invoices i JOIN orgs o ON o.id = i.org_id' . ($st !== 'all' ? ' WHERE i.status = ?' : '') . ' ORDER BY i.id DESC LIMIT 200', $st !== 'all' ? [$st] : []),
        'payments' => DB::all('SELECT p.*, o.name org FROM payments p JOIN orgs o ON o.id = p.org_id ORDER BY p.id DESC LIMIT 50')], 'app');
});
$r->add('GET', '/admin/desk', function () { Auth::requireAdmin('desk'); desk_inbox(Desk::house(), '/admin/desk'); });
$r->add('GET|POST', '/admin/desk/{n}', function ($n) { Auth::requireAdmin('desk'); desk_ticket(Desk::house(), '/admin/desk', (int) $n); });
$r->add('GET|POST', '/admin/help-centre', function () { Auth::requireAdmin('desk'); help_admin(Desk::house(), '/admin/help-centre'); });
$r->add('GET|POST', '/admin/settings', function () {
    $me = Auth::requireAdmin('settings');
    if (is_post()) {
        csrf_check();
        if (input('action') === 'test_ai') {
            foreach (Ai::selfTest() as $prov => $r) flash($r['ok'] ? 'ok' : 'error', ucfirst($prov) . ': ' . ($r['ok'] ? 'working, ' . $r['ms'] . ' ms. ' : 'not working. ') . $r['detail']);
            redirect('/admin/settings#ai');
        }
        if (input('action') === 'test_email') {
            $to = filter_var(input('to'), FILTER_VALIDATE_EMAIL) ? (string) input('to') : $me['email'];
            $html = view('emails/test', ['subject' => 'SeaGeek test email'], 'email');
            [$ok, $err] = Mail::send($to, 'SeaGeek test email', $html, Mail::text($html));
            $ok ? flash('ok', 'Test email sent to ' . $to . ' using ' . strtoupper(Mail::driver()) . '. Check the inbox and spam folder.') : flash('error', 'Sending failed (' . strtoupper(Mail::driver()) . '): ' . $err);
            redirect('/admin/settings#email');
        }
        foreach (array_keys(Settings::DEFAULTS) as $k) {
            if (!array_key_exists($k, $_POST) || $k === 'last_cron_at') continue;
            if (in_array($k, Settings::SECRET_KEYS, true) && $_POST[$k] === '') continue;
            Settings::set($k, trim((string) $_POST[$k]));
        }
        if (isset($_POST['ai_models_json'])) {
            $j = json_decode((string) $_POST['ai_models_json'], true);
            if ($_POST['ai_models_json'] === '' || is_array($j)) Settings::set('ai_models_json', (string) $_POST['ai_models_json']);
            else flash('error', 'AI models JSON is not valid, so it was not saved.');
        }
        audit('admin.settings_saved');
        flash('ok', 'Settings saved.');
        redirect('/admin/settings');
    }
    render('admin/settings', ['title' => 'Settings'], 'app');
});
$r->add('GET', '/admin/system', function () {
    Auth::requireAdmin('system');
    render('admin/system', ['title' => 'System', 'jobs' => DB::all('SELECT * FROM jobs ORDER BY name'), 'outbox' => DB::all('SELECT id, to_addr, subject, status, attempts, last_error, created_at FROM email_outbox ORDER BY id DESC LIMIT 25'),
        'audit' => DB::all('SELECT a.*, u.email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 40'),
        'webhooks' => DB::all("SELECT d.*, o.name org FROM webhook_deliveries d JOIN orgs o ON o.id = d.org_id WHERE d.status <> 'delivered' ORDER BY d.id DESC LIMIT 20"),
        'db' => DB::driver(), 'php' => PHP_VERSION, 'cronUrl' => app_url('/cron/' . config('cron_token'))], 'app');
});

// ---------------------------------------------------------------------------
// Machine endpoints
// ---------------------------------------------------------------------------

$r->add('POST', '/webhooks/payfast', function () {
    $result = Billing::payfastItn($_POST);
    log_line('payfast', $result, ['m_payment_id' => $_POST['m_payment_id'] ?? null, 'pf_payment_id' => $_POST['pf_payment_id'] ?? null]);
    http_response_code(200);
    exit('OK');
});
// 360dialog / Meta webhook per WhatsApp number: statuses and inbound messages
$r->add('POST', '/webhooks/whatsapp/{id}/{token}', function ($id, $token) {
    $num = DB::one('SELECT * FROM wa_numbers WHERE id = ?', [(int) $id]);
    if (!$num || !hash_equals(substr(hash_hmac('sha256', 'wa' . $num['id'], (string) config('app_key')), 0, 32), $token)) { http_response_code(403); exit; }
    $payload = json_decode(file_get_contents('php://input') ?: '{}', true) ?: [];
    foreach ($payload['entry'] ?? [] as $entry) foreach ($entry['changes'] ?? [] as $ch) {
        $v = $ch['value'] ?? [];
        foreach ($v['statuses'] ?? [] as $s) {
            $m = DB::one('SELECT * FROM messages WHERE external_id = ? AND org_id = ?', [(string) $s['id'], $num['org_id']]);
            if (!$m) continue;
            $status = ['sent' => 'sent', 'delivered' => 'delivered', 'read' => 'read', 'failed' => 'failed'][$s['status']] ?? $m['status'];
            DB::update('messages', ['status' => $status, 'updated_at' => now(), 'error' => $status === 'failed' ? mb_substr((string) ($s['errors'][0]['title'] ?? 'failed'), 0, 500) : null], 'id = ?', [$m['id']]);
            Webhooks::queue((int) $m['org_id'], 'message.' . $status, Gateway::present(DB::one('SELECT * FROM messages WHERE id = ?', [$m['id']])));
        }
        foreach ($v['messages'] ?? [] as $in) {
            $from = '+' . ltrim((string) $in['from'], '+');
            $text = (string) ($in['text']['body'] ?? $in['button']['text'] ?? $in['interactive']['button_reply']['title'] ?? '[' . ($in['type'] ?? 'message') . ']');
            $pid = public_id('msg');
            DB::insert('messages', ['public_id' => $pid, 'org_id' => $num['org_id'], 'env' => 'live', 'service' => 'whatsapp', 'direction' => 'in', 'status' => 'received', 'from_addr' => $from, 'to_addr' => $num['phone'], 'external_id' => (string) ($in['id'] ?? ''), 'meta' => json_encode(['text' => $text, 'name' => $v['contacts'][0]['profile']['name'] ?? null]), 'created_at' => now(), 'updated_at' => now()]);
            Webhooks::queue((int) $num['org_id'], 'whatsapp.inbound', ['id' => $pid, 'from' => $from, 'to' => $num['phone'], 'text' => $text]);
            $t = DB::one("SELECT * FROM tickets WHERE org_id = ? AND channel = 'whatsapp' AND requester_phone = ? AND status IN ('new','open','pending') ORDER BY id DESC LIMIT 1", [$num['org_id'], $from]);
            if ($t) Desk::customerReply($t, $text);
            else { $t = Desk::createTicket((int) $num['org_id'], 'WhatsApp from ' . $from, $text, 'whatsapp', ['name' => $v['contacts'][0]['profile']['name'] ?? null, 'phone' => $from]); if ($t['ai_active']) Desk::aiRespond($t); }
        }
    }
    json_out(['ok' => true]);
});
// Delivery reports from HTTP-template partners. Configure the paths in Admin > Partners.
$r->add('POST|GET', '/webhooks/partner/{id}/{token}', function ($id, $token) {
    $p = DB::one('SELECT * FROM partners WHERE id = ?', [(int) $id]);
    if (!$p || !hash_equals(substr(hash_hmac('sha256', 'dlr' . $p['id'], (string) config('app_key')), 0, 32), $token)) { http_response_code(403); exit; }
    $c = Partners::config($p);
    $data = json_decode(file_get_contents('php://input') ?: '', true) ?: ($_POST ?: $_GET);
    $get = function ($path) use ($data) { foreach (explode('.', (string) $path) as $k) { if (!is_array($data) || !array_key_exists($k, $data)) return null; $data = $data[$k]; } return $data; };
    $ext = (string) $get($c['dlr_id_path'] ?? 'id');
    $raw = strtolower((string) $get($c['dlr_status_path'] ?? 'status'));
    $okWords = array_map('trim', explode(',', strtolower((string) ($c['dlr_delivered'] ?? 'delivered,delivrd,success'))));
    $status = in_array($raw, $okWords, true) ? 'delivered' : (in_array($raw, ['failed', 'undeliv', 'undelivered', 'rejected', 'expired'], true) ? 'failed' : null);
    $m = $ext !== '' ? DB::one('SELECT * FROM messages WHERE external_id = ? AND partner_id = ?', [$ext, $p['id']]) : null;
    if ($m && $status) {
        DB::update('messages', ['status' => $status, 'updated_at' => now()], 'id = ?', [$m['id']]);
        Webhooks::queue((int) $m['org_id'], 'message.' . $status, Gateway::present(DB::one('SELECT * FROM messages WHERE id = ?', [$m['id']])));
    }
    json_out(['ok' => true]);
});
// Inbound email to Desk (point an email-forwarding service or SES receipt rule here)
$r->add('POST', '/webhooks/inbound-email/{slug}/{token}', function ($slug, $token) {
    $org = DB::one('SELECT * FROM orgs WHERE slug = ?', [$slug]);
    if (!$org || !hash_equals(substr(hash_hmac('sha256', 'mail' . $org['id'], (string) config('app_key')), 0, 32), $token)) { http_response_code(403); exit; }
    $d = json_decode(file_get_contents('php://input') ?: '', true) ?: $_POST;
    $from = strtolower((string) ($d['from'] ?? ''));
    if (preg_match('/<([^>]+)>/', $from, $m)) $from = $m[1];
    $subject = (string) ($d['subject'] ?? 'Email');
    $body = trim((string) ($d['text'] ?? strip_tags((string) ($d['html'] ?? ''))));
    if (preg_match('/\[#(\d+)\]/', $subject, $m) && ($t = DB::one('SELECT * FROM tickets WHERE org_id = ? AND number = ? AND requester_email = ?', [$org['id'], (int) $m[1], $from]))) {
        Desk::customerReply($t, $body);
    } else {
        $t = Desk::createTicket((int) $org['id'], $subject, $body, 'email', ['name' => $d['from_name'] ?? null, 'email' => $from]);
        if ($t['ai_active']) Desk::aiRespond($t);
    }
    json_out(['ok' => true]);
});
$r->add('GET|POST', '/cron/{token}', function ($token) {
    if (!hash_equals((string) config('cron_token'), $token)) { http_response_code(403); exit; }
    json_out(Cron::run());
});
$r->add('GET', '/sitemap.xml', function () {
    header('Content-Type: application/xml; charset=utf-8');
    $urls = ['/', '/pricing', '/desk', '/developers', '/docs', '/about', '/contact', '/help', '/status', '/privacy', '/terms'];
    foreach (array_keys(Catalog::services()) as $k) $urls[] = '/docs/' . $k;
    foreach (array_keys(Docs::guides()) as $k) $urls[] = '/docs/' . $k;
    $urls[] = '/quote';
    foreach (DB::all('SELECT slug FROM articles WHERE org_id = ? AND published = 1', [Desk::house()['id']]) as $a) $urls[] = '/help/' . $a['slug'];
    echo '<?xml version="1.0" encoding="UTF-8"?>' . "\n" . '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
    foreach ($urls as $u) echo '<url><loc>' . e(app_url($u)) . '</loc></url>';
    echo '</urlset>';
    exit;
});
$r->add('GET', '/health', function () {
    try { DB::value('SELECT 1'); $db = 'ok'; } catch (Throwable) { $db = 'down'; }
    $cron = Settings::get('last_cron_at');
    $cronOk = $cron !== '' && strtotime($cron . ' UTC') > time() - 600;
    json_out(['status' => $db === 'ok' && $cronOk ? 'ok' : 'degraded', 'database' => $db, 'cron_last_run' => $cron ?: null, 'time' => gmdate('c')], $db === 'ok' ? 200 : 503);
});

require APP_DIR . '/routes_commerce.php';
require APP_DIR . '/routes_growth.php';

return $r;
