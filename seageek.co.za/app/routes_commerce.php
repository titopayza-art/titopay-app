<?php
/**
 * Services, cart and checkout, payments, invoices, statements and quotes.
 * Included from routes.php; $r is the router.
 */
declare(strict_types=1);

/** @var Router $r */

// ---------------------------------------------------------------------------
// Services: pick one or many, one account, one bill
// ---------------------------------------------------------------------------

$r->add('GET|POST', '/dashboard/services', function () {
    $org = require_org();
    if (is_post()) {
        csrf_check();
        $a = (string) input('action');
        if ($a === 'select') {
            $picked = array_values(array_intersect((array) ($_POST['services'] ?? []), array_keys(Services::sellable())));
            $activated = [];
            foreach ($picked as $svc) {
                $st = Services::activate((int) $org['id'], $svc);
                $activated[] = Services::sellable()[$svc]['name'] . ($st === 'pending' ? ' (pending approval)' : '');
            }
            foreach ((array) ($_POST['package'] ?? []) as $svc => $code) {
                if ($code !== '' && in_array($svc, $picked, true)) Cart::setPackage((string) $code, max(1, (int) ($_POST['qty'][$svc] ?? 1)));
            }
            if ($activated) audit('services.activated', (int) $org['id'], implode(', ', $activated));
            if (Cart::count()) {
                flash('ok', ($activated ? 'Switched on: ' . implode(', ', $activated) . '. ' : '') . 'Review your order and pay once for everything.');
                redirect('/dashboard/cart');
            }
            flash('ok', $activated ? 'Switched on: ' . implode(', ', $activated) . '. Usage is charged from your credit balance.' : 'Select at least one service.');
        } elseif ($a === 'deactivate') {
            Services::deactivate((int) $org['id'], (string) input('service'));
            audit('services.deactivated', (int) $org['id'], (string) input('service'));
            flash('ok', 'Service switched off. Live requests for it are now refused; sandbox still works.');
        }
        redirect('/dashboard/services');
    }
    render('dash/services', ['title' => 'Services', 'org' => $org, 'status' => Services::all((int) $org['id']),
        'packages' => DB::all('SELECT * FROM packages WHERE active = 1 ORDER BY service, sort'), 'plan' => Billing::plan($org)], 'app');
});

$r->add('GET|POST', '/dashboard/cart', function () {
    $org = require_org();
    if (is_post()) {
        csrf_check();
        $a = (string) input('action');
        if ($a === 'qty') Cart::setPackage((string) input('code'), (int) input('qty'));
        elseif ($a === 'remove') Cart::setPackage((string) input('code'), 0);
        elseif ($a === 'plan') Cart::setPlan((string) input('plan') ?: null);
        elseif ($a === 'topup') Cart::setTopup((float) input('amount'));
        elseif ($a === 'clear') Cart::clear();
        elseif ($a === 'add') Cart::setPackage((string) input('code'), (int) ($_SESSION['cart']['packages'][input('code')] ?? 0) + 1);
        elseif ($a === 'checkout') {
            $lines = Cart::lines($org);
            if (!$lines) { flash('error', 'Your order is empty.'); redirect('/dashboard/cart'); }
            $names = array_map(fn($l) => $l[0] === 'plan' ? DB::value('SELECT name FROM plans WHERE code = ?', [$l[1]]) . ' plan' : ($l[0] === 'topup' ? 'credit' : $l[2]), $lines);
            $desc = 'Order: ' . implode(', ', array_slice($names, 0, 3)) . (count($names) > 3 ? ' and ' . (count($names) - 3) . ' more' : '');
            $inv = Billing::createInvoice($org, 'order', 0, $desc, null, $lines);
            Cart::clear();
            audit('order.created', (int) $org['id'], $inv['number']);
            redirect('/dashboard/pay/' . $inv['number']);
        }
        redirect('/dashboard/cart');
    }
    $lines = Cart::lines($org);
    $subtotal = round(array_sum(array_map(fn($l) => $l[3] * $l[4], $lines)), 2);
    $vat = Settings::get('vat_registered') === '1' ? round($subtotal * (float) Settings::get('vat_rate') / 100, 2) : 0.0;
    render('dash/cart', ['title' => 'Your order', 'org' => $org, 'lines' => $lines, 'subtotal' => $subtotal, 'vat' => $vat, 'total' => $subtotal + $vat,
        'plans' => DB::all('SELECT * FROM plans WHERE active = 1 AND price > 0 ORDER BY sort'), 'cartPlan' => $_SESSION['cart']['plan'] ?? null, 'cartTopup' => $_SESSION['cart']['topup'] ?? 0,
        'packages' => DB::all('SELECT * FROM packages WHERE active = 1 ORDER BY service, sort')], 'app');
});

$r->add('GET|POST', '/dashboard/pay/{number}', function ($number) {
    $org = require_org();
    $inv = DB::one('SELECT * FROM invoices WHERE number = ? AND org_id = ?', [$number, $org['id']]);
    if (!$inv) redirect('/dashboard/invoices');
    if (is_post()) {
        csrf_check();
        if (input('action') === 'credit' && $inv['status'] === 'unpaid' && !array_filter(Billing::items((int) $inv['id']), fn($i) => in_array($i['kind'], ['topup', 'package'], true))) {
            try {
                Billing::charge((int) $org['id'], (float) $inv['total'], 'invoice', $inv['number'], 'Invoice ' . $inv['number'] . ' paid from credit');
                Billing::markPaid((int) $inv['id'], 'credit', 'balance', (float) $inv['total']);
                flash('ok', 'Paid from your credit balance.');
            } catch (InsufficientFunds) {
                flash('error', 'Your balance is too low to pay this invoice from credit.');
            }
        }
        redirect('/dashboard/pay/' . $inv['number']);
    }
    render('dash/pay', ['title' => 'Pay ' . $inv['number'], 'org' => $org, 'inv' => $inv, 'items' => Billing::items((int) $inv['id']),
        'form' => $inv['status'] === 'unpaid' ? Billing::payfastForm($inv, Auth::user()) : null], 'app');
});

$r->add('GET', '/dashboard/invoices', function () {
    $org = require_org();
    render('dash/invoices', ['title' => 'Invoices and statements', 'org' => $org,
        'invoices' => DB::all("SELECT * FROM invoices WHERE org_id = ? AND status <> 'void' ORDER BY id DESC LIMIT 200", [$org['id']]),
        'months' => statement_months((int) $org['id'])], 'app');
});

/**
 * One bank statement line as [date, reference, amount], or null for headers, blanks and withdrawals.
 * Accepts CSV (quoted or not), tab-separated text copied from online banking, "R 1 149,00" style amounts
 * and references that contain commas. Column order: date, reference, amount.
 */
function eft_parse_line(string $raw): ?array
{
    $raw = trim($raw);
    if ($raw === '') return null;
    $cols = array_map('trim', str_contains($raw, "\t") ? explode("\t", $raw) : str_getcsv($raw, ',', '"', ''));
    // Re-join an unquoted thousands separator: "11,089.00" arrives as "11" and "089.00".
    while (count($cols) > 3 && preg_match('/^\d{3}(\.\d{1,2})?$/', end($cols)) && preg_match('/^-?(R\s?)?\d{1,3}$/', $cols[count($cols) - 2])) {
        $last = array_pop($cols);
        $cols[count($cols) - 1] .= $last;
    }
    if (count($cols) < 3) return null;
    $date = $cols[0];
    $amt = str_replace([' ', "\u{00A0}", 'R'], '', (string) end($cols));
    if (preg_match('/^-?\d+,\d{2}$/', $amt)) $amt = str_replace(',', '.', $amt);  // 1149,00
    $amount = (float) str_replace(',', '', $amt);
    if (!preg_match('/^\d{4}[-\/]\d{2}[-\/]\d{2}$|^\d{1,2}[-\/ ]\w{2,9}[-\/ ]\d{2,4}$/', $date) || $amount <= 0) return null;
    $ts = strtotime(str_replace('/', '-', $date));
    return [$ts ? gmdate('Y-m-d', $ts) : $date, trim(implode(' ', array_slice($cols, 1, -1))), round($amount, 2)];
}

/** Product name for a ledger usage line, used to group statements. */
function ledger_product(string $description): string
{
    $d = strtolower($description);
    return match (true) {
        str_starts_with($d, 'sms') => 'SMS',
        str_starts_with($d, 'email') => 'Email',
        str_starts_with($d, 'otp') => 'Auth (OTP)',
        str_starts_with($d, 'ai ') => 'SeaGeek AI',
        str_starts_with($d, 'voice') => 'Voice',
        str_contains($d, 'whatsapp') => 'WhatsApp',
        str_contains($d, 'check') || str_contains($d, 'screening') || str_contains($d, 'verification') => 'Verify',
        default => 'API',
    };
}

function statement_months(int $orgId): array
{
    $first = DB::value('SELECT MIN(created_at) FROM ledger WHERE org_id = ?', [$orgId]) ?: now();
    $months = [];
    for ($t = strtotime(gmdate('Y-m-01')); $t >= strtotime(substr($first, 0, 7) . '-01') && count($months) < 24; $t = strtotime('-1 month', $t)) $months[] = gmdate('Y-m', $t);
    return $months;
}

$statementView = function (array $org) {
    $month = preg_match('/^\d{4}-\d{2}$/', (string) ($_GET['month'] ?? '')) ? $_GET['month'] : gmdate('Y-m');
    render('dash/statement', ['title' => 'Statement ' . $month, 'org' => $org, 'month' => $month, 'st' => Billing::statement((int) $org['id'], $month)], 'print');
};
$r->add('GET', '/dashboard/statement', fn() => $statementView(require_org()));
$r->add('GET', '/admin/orgs/{id}/statement', function ($id) use ($statementView) {
    Auth::requireAdmin();
    $org = DB::one('SELECT * FROM orgs WHERE id = ?', [(int) $id]) ?? redirect('/admin/orgs');
    $statementView($org);
});

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

$r->add('GET|POST', '/quote', function () {
    $in = Quotes::clean(is_post() ? $_POST : $_GET);
    if (is_post()) {
        csrf_check();
        $org = Auth::user() ? Auth::org() : null;
        if ($org && Auth::user()['email_verified_at']) {
            $q = Quotes::create($org, $in, (string) input('plan') ?: null);
            redirect('/dashboard/quotes/' . $q['number']);
        }
        $_SESSION['quote_inputs'] = ['in' => $in, 'plan' => (string) input('plan')];
        flash('ok', 'Create your free account to save this quote. It will be waiting in your dashboard.');
        redirect('/register');
    }
    $calc = Quotes::calculate($in);
    if (isset($_GET['fragment'])) { echo view('partials/quote_result', ['in' => $in, 'calc' => $calc, 'saveUrl' => '/quote', 'saveLabel' => Auth::user() ? 'Save quote' : 'Save quote and create my free account']); exit; }
    render('site/quote', ['title' => 'Get a quote', 'nav' => 'pricing', 'in' => $in, 'calc' => $calc], 'site');
});

$r->add('GET|POST', '/dashboard/quotes', function () {
    $org = require_org();
    if (!empty($_SESSION['quote_inputs'])) {
        $s = $_SESSION['quote_inputs'];
        unset($_SESSION['quote_inputs']);
        $q = Quotes::create($org, $s['in'], $s['plan'] ?: null);
        flash('ok', 'Your quote is saved.');
        redirect('/dashboard/quotes/' . $q['number']);
    }
    $in = Quotes::clean(is_post() ? $_POST : $_GET);
    if (is_post()) {
        csrf_check();
        $q = Quotes::create($org, $in, (string) input('plan') ?: null);
        audit('quote.created', (int) $org['id'], $q['number']);
        redirect('/dashboard/quotes/' . $q['number']);
    }
    if (isset($_GET['fragment'])) { echo view('partials/quote_result', ['in' => $in, 'calc' => Quotes::calculate($in), 'saveUrl' => '/dashboard/quotes', 'saveLabel' => 'Save quote']); exit; }
    render('dash/quotes', ['title' => 'Quotes', 'org' => $org, 'in' => $in, 'calc' => Quotes::calculate($in),
        'quotes' => DB::all('SELECT * FROM quotes WHERE org_id = ? ORDER BY id DESC LIMIT 50', [$org['id']])], 'app');
});

$r->add('GET|POST', '/dashboard/quotes/{number}', function ($number) {
    $org = require_org();
    $q = DB::one('SELECT * FROM quotes WHERE number = ? AND org_id = ?', [$number, $org['id']]);
    if (!$q) redirect('/dashboard/quotes');
    if (is_post()) {
        csrf_check();
        if (input('action') === 'accept' && $q['status'] === 'open') {
            $res = Quotes::accept($org, $q);
            audit('quote.accepted', (int) $org['id'], $q['number']);
            if ($res['invoice']) redirect('/dashboard/pay/' . $res['invoice']['number']);
            flash('ok', 'Quote accepted and services switched on.');
        }
        redirect('/dashboard/quotes/' . $q['number']);
    }
    render('dash/quote', ['title' => 'Quote ' . $q['number'], 'org' => $org, 'q' => $q, 'items' => json_decode($q['items'], true) ?: [],
        'in' => json_decode($q['inputs'], true) ?: [], 'plan' => DB::one('SELECT * FROM plans WHERE code = ?', [$q['plan_code']])], 'print');
});

// ---------------------------------------------------------------------------
// Admin: bank statement import (EFT), quotes, services per customer
// ---------------------------------------------------------------------------

$r->add('GET|POST', '/admin/eft', function () {
    Auth::requireAdmin();
    $results = [];
    if (is_post()) {
        csrf_check();
        if (input('action') === 'import') {
            $seen = [];
            foreach (preg_split('/\r?\n/', trim((string) input('csv'))) as $raw) {
                $row = eft_parse_line($raw);
                if (!$row) continue; // header, blank line or withdrawal
                // The n-th identical deposit in one import keeps its own identity, so a customer can pay the same
                // amount twice in a day, while pasting the same statement again (in any order) is skipped.
                $key = implode('|', $row);
                $seen[$key] = ($seen[$key] ?? 0) + 1;
                $results[] = Billing::applyBankLine($row[0], $row[1], $row[2], $seen[$key] - 1) + ['raw' => $raw];
            }
            audit('admin.eft_import', null, count($results) . ' lines');
            $_SESSION['eft_results'] = $results;
        } elseif (input('action') === 'assign') {
            $line = DB::one("SELECT * FROM bank_lines WHERE id = ? AND status = 'unmatched'", [(int) input('line')]);
            $org = DB::one('SELECT * FROM orgs WHERE customer_no = ?', [trim((string) input('customer_no'))]);
            if ($line && $org) {
                DB::run('DELETE FROM bank_lines WHERE id = ?', [$line['id']]);
                $res = Billing::applyBankLine((string) $line['posted_on'], (string) $line['reference'], (float) $line['amount'], 0, (int) $org['id']);
                audit('admin.eft_assigned', (int) $org['id'], $res['note'] ?? '');
                flash('ok', 'Payment assigned to ' . $org['name'] . ': ' . ($res['note'] ?? ''));
            } else {
                flash('error', 'Unknown customer number.');
            }
        }
        redirect('/admin/eft');
    }
    $results = $_SESSION['eft_results'] ?? [];
    unset($_SESSION['eft_results']);
    render('admin/eft', ['title' => 'Bank payments (EFT)', 'results' => $results,
        'unmatched' => DB::all("SELECT * FROM bank_lines WHERE status = 'unmatched' ORDER BY id DESC LIMIT 100"),
        'recent' => DB::all("SELECT b.*, o.name org, o.customer_no, i.number inv FROM bank_lines b LEFT JOIN orgs o ON o.id = b.org_id LEFT JOIN invoices i ON i.id = b.invoice_id WHERE b.status = 'matched' ORDER BY b.id DESC LIMIT 50")], 'app');
});

$r->add('GET', '/admin/quotes', function () {
    Auth::requireAdmin();
    render('admin/quotes', ['title' => 'Quotes', 'quotes' => DB::all('SELECT q.*, o.name org, o.customer_no FROM quotes q LEFT JOIN orgs o ON o.id = q.org_id ORDER BY q.id DESC LIMIT 200')], 'app');
});

$r->add('GET', '/admin/quotes/{number}', function ($number) {
    Auth::requireAdmin();
    $q = DB::one('SELECT * FROM quotes WHERE number = ?', [$number]) ?? redirect('/admin/quotes');
    $org = DB::one('SELECT * FROM orgs WHERE id = ?', [$q['org_id']]) ?? redirect('/admin/quotes');
    render('dash/quote', ['title' => 'Quote ' . $q['number'], 'org' => $org, 'q' => $q, 'items' => json_decode($q['items'], true) ?: [],
        'in' => json_decode($q['inputs'], true) ?: [], 'plan' => DB::one('SELECT * FROM plans WHERE code = ?', [$q['plan_code']])], 'print');
});

$r->add('GET', '/admin/invoices/{number}', function ($number) {
    Auth::requireAdmin();
    $inv = DB::one('SELECT * FROM invoices WHERE number = ?', [$number]) ?? redirect('/admin/billing');
    $org = DB::one('SELECT * FROM orgs WHERE id = ?', [$inv['org_id']]);
    render('dash/invoice', ['title' => 'Invoice ' . $inv['number'], 'inv' => $inv, 'org' => $org, 'items' => Billing::items((int) $inv['id']),
        'payments' => DB::all('SELECT * FROM payments WHERE invoice_id = ?', [$inv['id']]), 'back' => '/admin/orgs/' . (int) $org['id']], 'print');
});
