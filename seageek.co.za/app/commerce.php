<?php
/**
 * Services an account switches on, the multi-service cart, and self-service quotes.
 * One account, one balance, one billing profile across every service.
 */
declare(strict_types=1);

final class Services
{
    /** Services a customer can switch on (planned products are listed but not sold). */
    public static function sellable(): array
    {
        return array_filter(Catalog::services(), fn($s) => $s['status'] !== 'planned');
    }

    /** @return array<string,string> service => active | pending | inactive */
    public static function all(int $orgId): array
    {
        $rows = array_column(DB::all('SELECT service, status FROM org_services WHERE org_id = ?', [$orgId]), 'status', 'service');
        $out = [];
        foreach (array_keys(self::sellable()) as $svc) $out[$svc] = $rows[$svc] ?? 'inactive';
        return $out;
    }

    public static function status(int $orgId, string $svc): string
    {
        return (string) (DB::value('SELECT status FROM org_services WHERE org_id = ? AND service = ?', [$orgId, $svc]) ?? 'inactive');
    }

    /**
     * Switch a service on. Verify waits for business verification (KYB); everything else is immediate.
     * $force is for SeaGeek staff approving a service by hand.
     */
    public static function activate(int $orgId, string $svc, bool $force = false): string
    {
        if (!isset(self::sellable()[$svc])) return 'inactive';
        $org = DB::one('SELECT * FROM orgs WHERE id = ?', [$orgId]);
        $status = (!$force && $svc === 'verify' && $org && $org['kyb_status'] !== 'approved') ? 'pending' : 'active';
        $current = DB::one('SELECT status FROM org_services WHERE org_id = ? AND service = ?', [$orgId, $svc]);
        if (!$current) {
            DB::insert('org_services', ['org_id' => $orgId, 'service' => $svc, 'status' => $status, 'activated_at' => $status === 'active' ? now() : null]);
        } elseif ($current['status'] !== 'active') {
            DB::update('org_services', ['status' => $status, 'activated_at' => $status === 'active' ? now() : null], 'org_id = ? AND service = ?', [$orgId, $svc]);
        } else {
            $status = 'active';
        }
        return $status;
    }

    /** Re-check services waiting for approval, e.g. after KYB is approved. */
    public static function refreshPending(int $orgId): void
    {
        foreach (DB::all("SELECT service FROM org_services WHERE org_id = ? AND status = 'pending'", [$orgId]) as $row) self::activate($orgId, $row['service']);
    }

    public static function deactivate(int $orgId, string $svc): void
    {
        DB::update('org_services', ['status' => 'inactive', 'activated_at' => null], 'org_id = ? AND service = ?', [$orgId, $svc]);
    }

    /** What the customer still has to do before live traffic flows, if anything. */
    public static function nextStep(array $org, string $svc): ?string
    {
        return match ($svc) {
            'verify' => $org['kyb_status'] === 'approved' ? null : ($org['kyb_status'] === 'pending' ? 'Business verification is being reviewed' : 'Submit business verification (KYB)'),
            'whatsapp' => DB::value("SELECT COUNT(*) FROM wa_numbers WHERE org_id = ? AND status = 'active'", [$org['id']]) ? null : 'Connect a WhatsApp number',
            'sms' => $org['sms_sender_status'] === 'approved' ? null : 'Optional: request a sender ID',
            'mail' => $org['mail_domain_status'] === 'verified' ? null : 'Optional: verify your sending domain',
            'ai', 'desk' => null,
            default => null,
        };
    }

    /** "From R0.29 per segment" for listings. */
    public static function fromPrice(array $org, string $svc): string
    {
        if ($svc === 'ai') {
            $cheapest = min(array_map(fn($m) => Catalog::aiPrice($m)['in'], Catalog::aiModels()));
            return 'From ' . zar($cheapest) . ' per million tokens';
        }
        if ($svc === 'desk') return 'Included in every plan';
        $units = Catalog::services()[$svc]['units'] ?? [];
        $best = null;
        foreach ($units as $u) {
            $p = Billing::price($org, $u);
            $r = DB::one('SELECT per FROM rates WHERE unit = ?', [$u]);
            if ($u === 'wa_number') continue;
            if ($best === null || $p['price'] < $best[0]) $best = [$p['price'], $r['per'] ?? ''];
        }
        return $best ? 'From ' . zar($best[0], $best[0] < 1 ? 3 : 2) . ' ' . $best[1] : '';
    }
}

final class Cart
{
    private static function &bag(): array
    {
        if (!isset($_SESSION['cart']) || !is_array($_SESSION['cart'])) $_SESSION['cart'] = ['packages' => [], 'plan' => null, 'topup' => 0];
        return $_SESSION['cart'];
    }

    public static function setPackage(string $code, int $qty): void
    {
        $b = &self::bag();
        if ($qty <= 0) unset($b['packages'][$code]);
        elseif (DB::one('SELECT code FROM packages WHERE code = ? AND active = 1', [$code])) $b['packages'][$code] = min(100, $qty);
    }

    public static function setPlan(?string $code): void
    {
        $b = &self::bag();
        $b['plan'] = $code && DB::one('SELECT code FROM plans WHERE code = ? AND active = 1 AND price > 0', [$code]) ? $code : null;
    }

    public static function setTopup(float $amount): void
    {
        $b = &self::bag();
        $b['topup'] = max(0, round($amount, 2));
    }

    public static function clear(): void { $_SESSION['cart'] = ['packages' => [], 'plan' => null, 'topup' => 0]; }

    public static function count(): int
    {
        $b = $_SESSION['cart'] ?? [];
        return array_sum($b['packages'] ?? []) + (!empty($b['plan']) ? 1 : 0) + (!empty($b['topup']) ? 1 : 0);
    }

    /** Invoice-ready lines: [kind, ref, description, quantity, unit_price]. */
    public static function lines(array $org): array
    {
        $b = $_SESSION['cart'] ?? [];
        $lines = [];
        if (!empty($b['plan'])) {
            $p = DB::one('SELECT * FROM plans WHERE code = ?', [$b['plan']]);
            if ($p && $p['code'] !== $org['plan_code']) $lines[] = ['plan', $p['code'], $p['name'] . ' plan, first month (includes ' . zar($p['included_credit'], 0) . ' credit)', 1, (float) $p['price']];
        }
        foreach ($b['packages'] ?? [] as $code => $qty) {
            $p = DB::one('SELECT * FROM packages WHERE code = ? AND active = 1', [$code]);
            if ($p) $lines[] = ['package', $p['code'], $p['name'] . ' package', (int) $qty, (float) $p['price']];
        }
        if (!empty($b['topup'])) $lines[] = ['topup', null, 'Prepaid credit (any service)', 1, (float) $b['topup']];
        return $lines;
    }
}

final class Quotes
{
    /** Volume inputs the quote form asks for, mapped to rate units. */
    public static function inputs(): array
    {
        return [
            'sms' => ['SMS messages', 'sms', 'sms', 'a month'],
            'email' => ['Emails', 'email', 'mail', 'a month'],
            'otp_sms' => ['OTP codes by SMS', 'otp_sms', 'auth', 'a month'],
            'otp_email' => ['OTP codes by email', 'otp_email', 'auth', 'a month'],
            'wa_utility' => ['WhatsApp utility templates', 'wa_utility', 'whatsapp', 'a month'],
            'wa_marketing' => ['WhatsApp marketing templates', 'wa_marketing', 'whatsapp', 'a month'],
            'wa_service' => ['WhatsApp replies in the 24-hour window', 'wa_service', 'whatsapp', 'a month'],
            'wa_number' => ['WhatsApp numbers', 'wa_number', 'whatsapp', 'numbers'],
            'verify_id' => ['SA ID checks', 'verify_id', 'verify', 'a month'],
            'verify_pep' => ['PEP and sanctions checks', 'verify_pep', 'verify', 'a month'],
            'voice_minute' => ['Voice call minutes', 'voice_minute', 'voice', 'a month'],
            'ai_requests' => ['AI requests', null, 'ai', 'a month'],
            'desk_agents' => ['Desk agents', null, 'desk', 'people'],
        ];
    }

    public const AI_IN = 1000;   // tokens per request assumed in estimates
    public const AI_OUT = 400;

    public static function clean(array $raw): array
    {
        $in = [];
        foreach (array_keys(self::inputs()) as $k) $in[$k] = max(0, min(100000000, (int) str_replace([',', ' '], '', (string) ($raw[$k] ?? 0))));
        $models = array_map(fn($m) => $m['provider'] . ':' . $m['model'], Catalog::aiModels());
        $in['ai_model'] = in_array($raw['ai_model'] ?? '', $models, true) ? $raw['ai_model'] : $models[0];
        return $in;
    }

    /** Price the volumes on every plan and recommend the cheapest one that fits. */
    public static function calculate(array $in): array
    {
        [$prov, $model] = explode(':', $in['ai_model'], 2);
        $ai = Catalog::aiModel($prov, $model);
        $aiPrice = $ai ? Catalog::aiPrice($ai) : ['in' => 0, 'out' => 0];
        $aiEach = (self::AI_IN * $aiPrice['in'] + self::AI_OUT * $aiPrice['out']) / 1_000_000;
        $plans = DB::all('SELECT * FROM plans WHERE active = 1 ORDER BY sort');
        $result = [];
        foreach ($plans as $p) {
            $fakeOrg = ['plan_code' => $p['code']];
            $lines = [];
            $usage = 0.0;
            foreach (self::inputs() as $key => [$label, $unit, $svc]) {
                $qty = (int) $in[$key];
                if (!$qty || !$unit) continue;
                $price = Billing::price($fakeOrg, $unit)['price'];
                $amount = round($qty * $price, 2);
                $usage += $amount;
                $lines[] = ['key' => $key, 'service' => $svc, 'label' => $label, 'qty' => $qty, 'unit_price' => $price, 'amount' => $amount];
            }
            $aiTotal = 0.0;
            if ($in['ai_requests']) {
                $aiTotal = round($in['ai_requests'] * $aiEach, 2);
                $usage += $aiTotal;
                $lines[] = ['key' => 'ai_requests', 'service' => 'ai', 'label' => 'AI requests (' . ($ai['label'] ?? $model) . ', about ' . number_format(self::AI_IN) . ' in / ' . self::AI_OUT . ' out tokens each)', 'qty' => (int) $in['ai_requests'], 'unit_price' => round($aiEach, 4), 'amount' => $aiTotal];
            }
            $reasons = [];
            if ($in['desk_agents'] > (int) $p['desk_agents']) $reasons[] = 'needs ' . $in['desk_agents'] . ' Desk agents (plan has ' . $p['desk_agents'] . ')';
            if ($in['wa_number'] > (int) $p['wa_numbers']) $reasons[] = 'needs ' . $in['wa_number'] . ' WhatsApp numbers (plan allows ' . $p['wa_numbers'] . ')';
            if ($aiTotal > (float) $p['ai_monthly_cap']) $reasons[] = 'AI estimate ' . zar($aiTotal, 0) . ' is above the plan AI cap of ' . zar($p['ai_monthly_cap'], 0);
            $included = min($usage, (float) $p['included_credit']);
            $monthly = round((float) $p['price'] + $usage - $included, 2);
            $result[$p['code']] = ['plan' => $p, 'lines' => $lines, 'usage' => round($usage, 2), 'fee' => (float) $p['price'], 'included' => round($included, 2), 'monthly' => $monthly, 'eligible' => !$reasons, 'reasons' => $reasons];
        }
        $eligible = array_filter($result, fn($r) => $r['eligible']);
        uasort($eligible, fn($a, $b) => $a['monthly'] <=> $b['monthly']);
        return ['plans' => $result, 'recommended' => array_key_first($eligible) ?? 'enterprise', 'any_volume' => (bool) array_filter(array_diff_key($in, ['ai_model' => 1, 'desk_agents' => 1]))];
    }

    public static function create(array $org, array $in, ?string $planCode = null): array
    {
        $calc = self::calculate($in);
        $code = $planCode && isset($calc['plans'][$planCode]) ? $planCode : $calc['recommended'];
        $c = $calc['plans'][$code];
        $items = [];
        if ($c['fee'] > 0) $items[] = ['label' => $c['plan']['name'] . ' plan (monthly)', 'qty' => 1, 'unit_price' => $c['fee'], 'amount' => $c['fee']];
        foreach ($c['lines'] as $l) $items[] = $l;
        if ($c['included'] > 0) $items[] = ['label' => 'Less usage covered by included plan credit', 'qty' => 1, 'unit_price' => -$c['included'], 'amount' => -$c['included']];
        $subtotal = $c['monthly'];
        $vat = Settings::get('vat_registered') === '1' ? round($subtotal * (float) Settings::get('vat_rate') / 100, 2) : 0.0;
        $seq = (int) DB::value('SELECT COUNT(*) FROM quotes WHERE org_id = ?', [$org['id']]) + 1;
        $id = DB::insert('quotes', [
            'number' => 'Q' . $org['customer_no'] . '-' . str_pad((string) $seq, 3, '0', STR_PAD_LEFT), 'org_id' => $org['id'], 'inputs' => json_encode($in), 'items' => json_encode($items),
            'plan_code' => $code, 'subtotal' => $subtotal, 'vat' => $vat, 'total' => round($subtotal + $vat, 2), 'status' => 'open', 'valid_until' => ts('+30 days'), 'created_at' => now(),
        ]);
        return DB::one('SELECT * FROM quotes WHERE id = ?', [$id]);
    }

    /**
     * Accepting a quote switches on its services and raises one invoice:
     * the plan's first month (if any) plus prepaid credit for the usage the plan doesn't include.
     */
    public static function accept(array $org, array $quote): array
    {
        $in = json_decode($quote['inputs'], true) ?: [];
        $calc = self::calculate($in)['plans'][$quote['plan_code']] ?? null;
        foreach (self::inputs() as $key => [, , $svc]) if (!empty($in[$key])) Services::activate((int) $org['id'], $svc);
        $lines = [];
        if ($calc && $calc['fee'] > 0 && $quote['plan_code'] !== $org['plan_code']) {
            $lines[] = ['plan', $calc['plan']['code'], $calc['plan']['name'] . ' plan, first month (includes ' . zar($calc['plan']['included_credit'], 0) . ' credit)', 1, $calc['fee']];
        }
        $credit = $calc ? max(0, $calc['usage'] - ($quote['plan_code'] !== $org['plan_code'] ? $calc['included'] : 0)) : 0;
        if ($credit > 0) $lines[] = ['topup', null, 'Prepaid credit for the first month of usage (quote ' . $quote['number'] . ')', 1, max((float) Settings::get('min_topup'), ceil($credit / 10) * 10)];
        if (!$lines) {
            DB::update('quotes', ['status' => 'accepted'], 'id = ?', [$quote['id']]);
            return ['invoice' => null];
        }
        $inv = Billing::createInvoice($org, 'order', 0, 'Order from quote ' . $quote['number'], null, $lines);
        DB::update('quotes', ['status' => 'accepted', 'invoice_id' => $inv['id']], 'id = ?', [$quote['id']]);
        return ['invoice' => $inv];
    }
}
