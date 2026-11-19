<?php
/**
 * Staff permissions, QR codes, store SMS (Shopify, WooCommerce and any platform),
 * contacts and campaigns. Everything bills through the same credit balance and partners as the API.
 */
declare(strict_types=1);

// ---------------------------------------------------------------------------
// Staff: who at SeaGeek can open which part of the admin console
// ---------------------------------------------------------------------------

final class Staff
{
    public const PERMISSIONS = [
        'customers' => ['Customers', 'Customer accounts, their dashboards, locking and unlocking'],
        'billing' => ['Money', 'Invoices, payments, bank imports, quotes and balance changes'],
        'desk' => ['Support desk', 'Tickets, macros and the help centre'],
        'marketing' => ['Marketing', 'Campaigns, newsletters, contacts and QR codes'],
        'partners' => ['Wholesale partners', 'Partner connections, keys and routing'],
        'pricing' => ['Plans and pricing', 'Plans, packages and usage rates'],
        'settings' => ['Settings', 'Company details, VAT, bank, PayFast, email delivery and AI keys'],
        'system' => ['Jobs and logs', 'Scheduled jobs, webhooks and error logs'],
        'staff' => ['Staff', 'Add staff and change what they can open'],
    ];

    /** role => [label, description, permissions]. */
    public static function roles(): array
    {
        $all = array_keys(self::PERMISSIONS);
        return [
            'owner' => ['Owner', 'Everything, including staff', $all],
            'admin' => ['Administrator', 'Everything except managing staff', array_values(array_diff($all, ['staff']))],
            'developer' => ['Developer', 'Partners, settings, jobs and logs, and customer accounts', ['customers', 'partners', 'settings', 'system']],
            'support' => ['Customer support', 'Support desk and customer accounts', ['desk', 'customers']],
            'finance' => ['Finance', 'Money and customer accounts', ['billing', 'customers']],
            'marketing' => ['Marketing', 'Campaigns, newsletters and QR codes', ['marketing', 'customers']],
            'custom' => ['Custom', 'Pick permissions one by one', []],
        ];
    }

    public static function permissionsOf(?array $u): array
    {
        if (!$u || empty($u['is_admin']) || !empty($u['disabled_at'])) return [];
        $role = $u['admin_role'] ?: 'owner';
        if ($role === 'custom') return array_values(array_intersect(json_decode((string) $u['permissions'], true) ?: [], array_keys(self::PERMISSIONS)));
        return self::roles()[$role][2] ?? [];
    }

    public static function can(?array $u, string $perm): bool
    {
        return in_array($perm, self::permissionsOf($u), true);
    }

    public static function roleLabel(?string $role): string
    {
        return self::roles()[$role ?: 'owner'][0] ?? 'Staff';
    }

    public static function owners(): int
    {
        return (int) DB::value("SELECT COUNT(*) FROM users WHERE is_admin = 1 AND disabled_at IS NULL AND (admin_role = 'owner' OR admin_role IS NULL)");
    }
}

// ---------------------------------------------------------------------------
// QR codes
// ---------------------------------------------------------------------------

final class Qr
{
    private const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

    public static function newCode(): string
    {
        do {
            $c = '';
            for ($i = 0; $i < 6; $i++) $c .= self::ALPHABET[random_int(0, strlen(self::ALPHABET) - 1)];
        } while (DB::one('SELECT id FROM qr_codes WHERE code = ?', [$c]));
        return $c;
    }

    /** Validate input shared by the dashboard and the API. Returns an error message or null. */
    public static function problem(string $url, string $color): ?string
    {
        if (mb_strlen($url) > 2000 || !filter_var($url, FILTER_VALIDATE_URL) || !preg_match('#^https?://#i', $url)) return 'Enter a full link that starts with https:// or http://.';
        if (!preg_match('/^#[0-9a-fA-F]{6}$/', $color)) return 'Colour must be a hex value such as #0b1f27.';
        [$r, $g, $b] = sscanf($color, '#%02x%02x%02x');
        if ((0.299 * $r + 0.587 * $g + 0.114 * $b) > 150) return 'That colour is too light for phones to read. Pick a darker one.';
        return null;
    }

    /**
     * Create a code and charge for it (live only). Throws InsufficientFunds when the balance is too low.
     */
    public static function create(array $org, string $env, string $url, string $name = '', bool $dynamic = true, string $color = '#0b1f27', ?string $reference = null): array
    {
        $rate = Billing::price($org, 'qr_code');
        $live = $env === 'live' && empty($org['is_house']);
        $amount = $live ? (float) $rate['price'] : 0.0;
        $pid = public_id('qr');
        $name = trim($name) !== '' ? mb_substr(trim($name), 0, 120) : (parse_url($url, PHP_URL_HOST) ?: 'QR code');
        if ($env !== 'live') $name .= ' (sandbox)';
        return DB::tx(function () use ($org, $env, $url, $name, $dynamic, $color, $reference, $rate, $amount, $pid) {
            if ($amount > 0) Billing::charge((int) $org['id'], $amount, 'usage', $pid, 'QR code: ' . $name);
            DB::insert('qr_codes', [
                'public_id' => $pid, 'org_id' => $org['id'], 'code' => self::newCode(), 'name' => $name, 'target_url' => $url,
                'dynamic' => $dynamic ? 1 : 0, 'color' => strtolower($color), 'env' => $env === 'live' ? 'live' : 'test', 'amount' => $amount,
                'status' => 'active', 'scans' => 0, 'created_at' => now(), 'updated_at' => now(),
            ]);
            DB::insert('messages', [
                'public_id' => $pid, 'org_id' => $org['id'], 'env' => $env === 'live' ? 'live' : 'test', 'service' => 'qr', 'direction' => 'out', 'unit' => 'qr_code',
                'quantity' => 1, 'amount' => $amount, 'cost' => (float) $rate['cost'], 'status' => 'completed', 'to_addr' => mb_substr($url, 0, 200),
                'reference' => $reference !== null ? mb_substr($reference, 0, 120) : null, 'meta' => json_encode(['name' => $name]), 'created_at' => now(), 'updated_at' => now(),
            ]);
            return DB::one('SELECT * FROM qr_codes WHERE public_id = ?', [$pid]);
        });
    }

    /** What the code contains: the short link for dynamic codes, the destination itself for static ones. */
    public static function content(array $qr): string
    {
        return $qr['dynamic'] ? self::shortUrl($qr) : $qr['target_url'];
    }

    public static function shortUrl(array $qr): string
    {
        return app_url('/q/' . $qr['code']);
    }

    public static function imageUrl(array $qr, string $ext): string
    {
        return app_url('/qr/i/' . $qr['code'] . '.' . $ext . '?s=' . self::sig($qr['code']));
    }

    /** Same image, as a path on this site (for showing codes inside the dashboard). */
    public static function imagePath(array $qr, string $ext): string
    {
        return '/qr/i/' . $qr['code'] . '.' . $ext . '?s=' . self::sig($qr['code']);
    }

    public static function sig(string $code): string
    {
        return substr(hash_hmac('sha256', 'qr-image|' . $code, (string) config('app_key')), 0, 16);
    }

    private static function options(array $qr, bool $png, int $scale): \chillerlan\QRCode\QROptions
    {
        $dark = array_fill_keys([
            \chillerlan\QRCode\Data\QRMatrix::M_DATA_DARK, \chillerlan\QRCode\Data\QRMatrix::M_FINDER_DARK, \chillerlan\QRCode\Data\QRMatrix::M_ALIGNMENT_DARK,
            \chillerlan\QRCode\Data\QRMatrix::M_TIMING_DARK, \chillerlan\QRCode\Data\QRMatrix::M_FORMAT_DARK, \chillerlan\QRCode\Data\QRMatrix::M_VERSION_DARK,
            \chillerlan\QRCode\Data\QRMatrix::M_DARKMODULE, \chillerlan\QRCode\Data\QRMatrix::M_FINDER_DOT,
        ], $png ? sscanf($qr['color'], '#%02x%02x%02x') : $qr['color']);
        $light = $png ? array_fill_keys([
            \chillerlan\QRCode\Data\QRMatrix::M_DATA, \chillerlan\QRCode\Data\QRMatrix::M_FINDER, \chillerlan\QRCode\Data\QRMatrix::M_ALIGNMENT,
            \chillerlan\QRCode\Data\QRMatrix::M_TIMING, \chillerlan\QRCode\Data\QRMatrix::M_FORMAT, \chillerlan\QRCode\Data\QRMatrix::M_VERSION,
            \chillerlan\QRCode\Data\QRMatrix::M_QUIETZONE, \chillerlan\QRCode\Data\QRMatrix::M_SEPARATOR, \chillerlan\QRCode\Data\QRMatrix::M_LOGO,
            \chillerlan\QRCode\Data\QRMatrix::M_NULL,
        ], [255, 255, 255]) : [];
        return new \chillerlan\QRCode\QROptions([
            'outputType' => $png ? \chillerlan\QRCode\Output\QROutputInterface::GDIMAGE_PNG : \chillerlan\QRCode\Output\QROutputInterface::MARKUP_SVG,
            'outputBase64' => false, 'eccLevel' => \chillerlan\QRCode\Common\EccLevel::M, 'addQuietzone' => true, 'quietzoneSize' => 4,
            'scale' => $scale, 'bgColor' => [255, 255, 255], 'drawLightModules' => $png, 'svgAddXmlHeader' => false, 'connectPaths' => true,
            'moduleValues' => $dark + $light,
        ]);
    }

    public static function svg(array $qr): string
    {
        $svg = (new \chillerlan\QRCode\QRCode(self::options($qr, false, 1)))->render(self::content($qr));
        // White background so the file prints and scans anywhere
        return preg_replace('/(<svg[^>]*>)/', '$1<rect width="100%" height="100%" fill="#ffffff"/>', $svg, 1);
    }

    public static function png(array $qr, int $scale = 16): string
    {
        return (new \chillerlan\QRCode\QRCode(self::options($qr, true, $scale)))->render(self::content($qr));
    }

    public static function present(array $qr): array
    {
        return [
            'id' => $qr['public_id'], 'name' => $qr['name'], 'url' => $qr['target_url'], 'short_url' => $qr['dynamic'] ? self::shortUrl($qr) : null,
            'dynamic' => (bool) $qr['dynamic'], 'color' => $qr['color'], 'status' => $qr['status'], 'scans' => (int) $qr['scans'],
            'last_scan_at' => $qr['last_scan_at'] ? gmdate('c', strtotime($qr['last_scan_at'] . ' UTC')) : null,
            'amount' => round((float) $qr['amount'], 2), 'currency' => 'ZAR', 'environment' => $qr['env'] === 'live' ? 'live' : 'sandbox',
            'image_png' => self::imageUrl($qr, 'png'), 'image_svg' => self::imageUrl($qr, 'svg'),
            'created_at' => gmdate('c', strtotime($qr['created_at'] . ' UTC')),
        ];
    }

    public static function update(array $qr, array $in): array
    {
        $d = ['updated_at' => now()];
        if (isset($in['url']) && $in['url'] !== '' && $in['url'] !== $qr['target_url']) {
            if (!$qr['dynamic']) throw new ApiError(422, 'static_code', 'Static codes contain the link itself and cannot be changed. Create a dynamic code instead.');
            if ($p = self::problem((string) $in['url'], $qr['color'])) throw new ApiError(422, 'invalid_url', $p);
            $d['target_url'] = (string) $in['url'];
        }
        if (isset($in['name']) && trim((string) $in['name']) !== '') $d['name'] = mb_substr(trim((string) $in['name']), 0, 120);
        if (isset($in['status'])) {
            if (!in_array($in['status'], ['active', 'paused'], true)) throw new ApiError(422, 'invalid_status', 'status must be active or paused.');
            $d['status'] = $in['status'];
        }
        DB::update('qr_codes', $d, 'id = ?', [$qr['id']]);
        return DB::one('SELECT * FROM qr_codes WHERE id = ?', [$qr['id']]);
    }

    public static function device(string $ua): string
    {
        $ua = strtolower($ua);
        return match (true) {
            str_contains($ua, 'iphone') || str_contains($ua, 'ipad') => 'iPhone or iPad',
            str_contains($ua, 'android') => 'Android',
            str_contains($ua, 'windows') || str_contains($ua, 'macintosh') || str_contains($ua, 'linux') => 'Computer',
            default => 'Other',
        };
    }

    /** /q/{code}: count the scan and send the person on. */
    public static function scan(string $code): void
    {
        $qr = DB::one('SELECT * FROM qr_codes WHERE code = ?', [$code]);
        if (!$qr) { http_response_code(404); render('site/qr-missing', ['title' => 'QR code not found', 'paused' => false], 'auth'); }
        if ($qr['status'] !== 'active') { http_response_code(410); render('site/qr-missing', ['title' => 'QR code paused', 'paused' => true], 'auth'); }
        $ua = (string) ($_SERVER['HTTP_USER_AGENT'] ?? '');
        if (!preg_match('/bot|crawl|spider|preview|facebookexternalhit|whatsapp/i', $ua)) {
            DB::insert('qr_scans', ['qr_id' => $qr['id'], 'device' => self::device($ua), 'created_at' => now()]);
            DB::run('UPDATE qr_codes SET scans = scans + 1, last_scan_at = ? WHERE id = ?', [now(), $qr['id']]);
        }
        header('Cache-Control: no-store');
        header('Location: ' . $qr['target_url'], true, 302);
        exit;
    }

    /** Scans per day for the last N days. */
    public static function daily(int $qrId, int $days = 30): array
    {
        $since = gmdate('Y-m-d 00:00:00', strtotime('-' . ($days - 1) . ' days'));
        $rows = DB::all('SELECT created_at, device FROM qr_scans WHERE qr_id = ? AND created_at >= ?', [$qrId, $since]);
        $out = [];
        for ($i = $days - 1; $i >= 0; $i--) $out[gmdate('Y-m-d', strtotime("-$i days"))] = 0;
        $devices = [];
        foreach ($rows as $r) {
            $d = substr($r['created_at'], 0, 10);
            if (isset($out[$d])) $out[$d]++;
            $devices[$r['device'] ?: 'Other'] = ($devices[$r['device'] ?: 'Other'] ?? 0) + 1;
        }
        arsort($devices);
        return ['days' => $out, 'devices' => $devices];
    }
}

// ---------------------------------------------------------------------------
// Store SMS: Shopify, WooCommerce and any platform, no code
// ---------------------------------------------------------------------------

final class Stores
{
    public const PLATFORMS = ['shopify' => 'Shopify', 'woocommerce' => 'WooCommerce', 'wix' => 'Wix', 'other' => 'Any other platform'];

    /** event => [label, default template, on by default, when it is sent]. */
    public static function events(): array
    {
        return [
            'order_created' => ['Order placed', 'Hi {first_name}, thanks for your order {order_number} at {store}. Total {total}. We will SMS you when it ships.', true, 'As soon as the order is placed'],
            'order_paid' => ['Payment received', '{store}: payment received for order {order_number}. Thank you, {first_name}!', false, 'When payment clears (useful for EFT orders)'],
            'order_shipped' => ['Order shipped', 'Good news {first_name}! Order {order_number} from {store} is on its way. Track it: {tracking_url}', true, 'When you mark the order as fulfilled or completed'],
            'order_cancelled' => ['Order cancelled', '{store}: order {order_number} has been cancelled. Reply to this SMS if you have questions.', true, 'When the order is cancelled'],
            'order_refunded' => ['Refund issued', '{store}: we have refunded {refund_amount} for order {order_number}. It can take 3 to 5 working days to show.', true, 'When you issue a refund'],
            'checkout_abandoned' => ['Abandoned cart reminder', 'Hi {first_name}, you left something in your cart at {store}. Finish your order here: {checkout_url}', false, 'An hour after a checkout is started and not finished (Shopify and the generic hook)'],
        ];
    }

    public static function placeholders(): array
    {
        return ['{first_name}' => 'Customer first name', '{store}' => 'Your store name', '{order_number}' => 'Order number', '{total}' => 'Order total, e.g. R899.00',
            '{tracking_url}' => 'Tracking link', '{tracking_number}' => 'Tracking number', '{refund_amount}' => 'Refund amount', '{checkout_url}' => 'Link to finish checkout'];
    }

    public static function settings(array $store): array
    {
        $s = json_decode((string) $store['settings'], true) ?: [];
        foreach (self::events() as $k => [$label, $text, $on]) {
            $s['events'][$k] = ($s['events'][$k] ?? []) + ['on' => $on, 'text' => $text];
        }
        $s['abandoned_delay_hours'] = max(1, min(48, (int) ($s['abandoned_delay_hours'] ?? 1)));
        return $s;
    }

    public static function connect(array $org, string $platform, string $name, string $domain): array
    {
        if (!isset(self::PLATFORMS[$platform])) $platform = 'other';
        $name = mb_substr(trim($name), 0, 120) ?: self::PLATFORMS[$platform] . ' store';
        $listId = DB::insert('contact_lists', ['org_id' => $org['id'], 'name' => $name . ' customers', 'kind' => 'static', 'created_at' => now()]);
        $secret = $platform === 'shopify' ? null : 'sgs_' . Crypto::token(24);
        $pid = public_id('sto');
        DB::insert('stores', [
            'public_id' => $pid, 'org_id' => $org['id'], 'platform' => $platform, 'name' => $name,
            'domain' => mb_substr(preg_replace('#^https?://#', '', trim($domain)), 0, 190) ?: null,
            'token' => Crypto::token(24), 'secret_enc' => $secret ? Crypto::encrypt($secret) : null, 'status' => 'active',
            'settings' => json_encode(['events' => []]), 'list_id' => $listId, 'created_at' => now(),
        ]);
        Services::activate((int) $org['id'], 'stores');
        return DB::one('SELECT * FROM stores WHERE public_id = ?', [$pid]);
    }

    public static function hookUrl(array $store): string
    {
        return app_url('/api/v1/stores/hooks/' . $store['token']);
    }

    public static function secret(array $store): ?string
    {
        return $store['secret_enc'] ? Crypto::decrypt($store['secret_enc']) : null;
    }

    public static function render(string $template, array $vars): string
    {
        $out = strtr($template, array_combine(array_map(fn($k) => '{' . $k . '}', array_keys($vars)), array_map('strval', array_values($vars))));
        $out = preg_replace('/\{[a-z_]+\}/', '', $out);
        return trim(preg_replace('/[ ]{2,}/', ' ', $out));
    }

    /** Webhook entry point: /api/v1/stores/hooks/{token}. Always answers quickly with JSON. */
    public static function receive(string $token): never
    {
        header('Content-Type: application/json');
        $store = DB::one('SELECT * FROM stores WHERE token = ?', [$token]);
        if (!$store) json_out(['error' => 'unknown store link'], 404);
        $raw = (string) file_get_contents('php://input');
        $h = fn(string $n) => (string) ($_SERVER['HTTP_' . strtoupper(str_replace('-', '_', $n))] ?? '');
        $secret = self::secret($store);
        $sig = fn(string $given, bool $b64) => $secret !== null && hash_equals($b64 ? base64_encode(hash_hmac('sha256', $raw, $secret, true)) : hash_hmac('sha256', $raw, $secret), $given);

        if ($h('X-Shopify-Topic') !== '') {
            if ($secret === null) json_out(['error' => 'Paste your Shopify webhook signing secret in SeaGeek first'], 401);
            if (!$sig($h('X-Shopify-Hmac-Sha256'), true)) json_out(['error' => 'bad signature'], 401);
            $topic = $h('X-Shopify-Topic');
            $deliveryId = $h('X-Shopify-Webhook-Id');
            $data = json_decode($raw, true) ?: [];
            $ev = self::fromShopify($topic, $data);
        } elseif ($h('X-WC-Webhook-Topic') !== '' || str_starts_with($raw, 'webhook_id=')) {
            if (str_starts_with($raw, 'webhook_id=')) json_out(['received' => true, 'status' => 'ping']); // WooCommerce test ping
            if (!$sig($h('X-WC-Webhook-Signature'), true)) json_out(['error' => 'bad signature'], 401);
            $deliveryId = $h('X-WC-Webhook-Delivery-ID');
            $data = json_decode($raw, true) ?: [];
            $ev = self::fromWoo($h('X-WC-Webhook-Topic'), $data);
        } else {
            $given = preg_replace('/^sha256=/', '', $h('X-SeaGeek-Signature'));
            if ($given !== '' && !$sig($given, false)) json_out(['error' => 'bad signature'], 401);
            $deliveryId = '';
            $data = json_decode($raw, true);
            if (!is_array($data)) json_out(['error' => 'Send JSON. See https://www.seageek.co.za/docs/stores'], 400);
            $ev = self::fromGeneric($data);
        }
        DB::run('UPDATE stores SET events_received = events_received + 1, last_event_at = ? WHERE id = ?', [now(), $store['id']]);
        if (!$ev) json_out(['received' => true, 'status' => 'ignored']);
        if ($store['status'] !== 'active') json_out(['received' => true, 'status' => 'paused']);
        $res = self::handle($store, $ev, 'live', $deliveryId);
        json_out(['received' => true] + $res);
    }

    /** Normalised event: event, order_id, order_number, total, first_name, phone, accepts_marketing, tracking_url, tracking_number, checkout_url, checkout_token, refund_amount. */
    public static function fromShopify(string $topic, array $d): ?array
    {
        $money = fn($v, $cur = 'ZAR') => $v === null || $v === '' ? '' : ($cur === 'ZAR' ? zar((float) $v) : number_format((float) $v, 2) . ' ' . $cur);
        $customer = $d['customer'] ?? [];
        $ship = $d['shipping_address'] ?? [];
        $bill = $d['billing_address'] ?? [];
        $phone = $d['phone'] ?? $customer['phone'] ?? $ship['phone'] ?? $bill['phone'] ?? $d['destination']['phone'] ?? null;
        $consent = ($d['buyer_accepts_marketing'] ?? false) || ($customer['accepts_marketing'] ?? false) || (($customer['sms_marketing_consent']['state'] ?? '') === 'subscribed');
        $base = [
            'order_id' => (string) ($d['order_id'] ?? $d['id'] ?? ''), 'order_number' => (string) ($d['name'] ?? $d['order_number'] ?? ''),
            'total' => $money($d['total_price'] ?? null, $d['currency'] ?? 'ZAR'), 'first_name' => (string) ($customer['first_name'] ?? $ship['first_name'] ?? $bill['first_name'] ?? $d['destination']['first_name'] ?? ''),
            'phone' => $phone ? (string) $phone : null, 'accepts_marketing' => (bool) $consent, 'email' => (string) ($d['email'] ?? $customer['email'] ?? ''),
            'checkout_token' => (string) ($d['checkout_token'] ?? $d['token'] ?? ''),
        ];
        $f = $d['fulfillments'][0] ?? $d;
        return match ($topic) {
            'orders/create' => ['event' => 'order_created'] + $base,
            'orders/paid' => ['event' => 'order_paid'] + $base,
            'orders/cancelled' => ['event' => 'order_cancelled'] + $base,
            'orders/fulfilled' => ['event' => 'order_shipped', 'tracking_url' => (string) ($f['tracking_url'] ?? ($f['tracking_urls'][0] ?? '')), 'tracking_number' => (string) ($f['tracking_number'] ?? '')] + $base,
            'fulfillments/create' => ['event' => 'order_shipped', 'tracking_url' => (string) ($d['tracking_url'] ?? ($d['tracking_urls'][0] ?? '')), 'tracking_number' => (string) ($d['tracking_number'] ?? ''), 'order_number' => preg_replace('/\.\d+$/', '', (string) ($d['name'] ?? ''))] + $base,
            'refunds/create' => ['event' => 'order_refunded', 'refund_amount' => $money(array_sum(array_map(fn($t) => (float) ($t['amount'] ?? 0), $d['transactions'] ?? [])))] + $base,
            'checkouts/create', 'checkouts/update' => ['event' => 'checkout_abandoned', 'checkout_url' => (string) ($d['abandoned_checkout_url'] ?? '')] + $base,
            default => null,
        };
    }

    public static function fromWoo(string $topic, array $d): ?array
    {
        $bill = $d['billing'] ?? [];
        $ship = $d['shipping'] ?? [];
        $base = [
            'order_id' => (string) ($d['id'] ?? ''), 'order_number' => (string) ($d['number'] ?? $d['id'] ?? ''),
            'total' => isset($d['total']) ? (($d['currency'] ?? 'ZAR') === 'ZAR' ? zar((float) $d['total']) : $d['total'] . ' ' . $d['currency']) : '',
            'first_name' => (string) ($bill['first_name'] ?? $ship['first_name'] ?? ''), 'phone' => ($bill['phone'] ?? $ship['phone'] ?? '') ?: null,
            'accepts_marketing' => false, 'email' => (string) ($bill['email'] ?? ''), 'checkout_token' => '',
        ];
        $status = (string) ($d['status'] ?? '');
        if ($topic === 'order.created') return ['event' => 'order_created'] + $base;
        if ($topic !== 'order.updated') return null;
        return match ($status) {
            'processing' => ['event' => 'order_paid'] + $base,
            'completed' => ['event' => 'order_shipped', 'tracking_url' => self::wooMeta($d, ['_tracking_url', 'tracking_url']), 'tracking_number' => self::wooMeta($d, ['_tracking_number', 'tracking_number'])] + $base,
            'cancelled' => ['event' => 'order_cancelled'] + $base,
            'refunded' => ['event' => 'order_refunded', 'refund_amount' => $base['total']] + $base,
            default => null,
        };
    }

    private static function wooMeta(array $d, array $keys): string
    {
        foreach ($d['meta_data'] ?? [] as $m) if (in_array($m['key'] ?? '', $keys, true) && is_string($m['value'] ?? null)) return $m['value'];
        return '';
    }

    public static function fromGeneric(array $d): ?array
    {
        $map = ['order.created' => 'order_created', 'order.paid' => 'order_paid', 'order.shipped' => 'order_shipped', 'order.cancelled' => 'order_cancelled', 'order.refunded' => 'order_refunded', 'checkout.abandoned' => 'checkout_abandoned'];
        $event = $map[$d['event'] ?? ''] ?? null;
        if (!$event) return null;
        $o = $d['order'] ?? [];
        $c = $d['customer'] ?? [];
        $cur = (string) ($o['currency'] ?? 'ZAR');
        $amt = fn($v) => $v === null || $v === '' ? '' : ($cur === 'ZAR' ? zar((float) $v) : $v . ' ' . $cur);
        return [
            'event' => $event, 'order_id' => (string) ($o['id'] ?? $o['number'] ?? ''), 'order_number' => (string) ($o['number'] ?? $o['id'] ?? ''),
            'total' => $amt($o['total'] ?? null), 'first_name' => (string) ($c['first_name'] ?? ''), 'phone' => ($c['phone'] ?? '') ?: null,
            'accepts_marketing' => !empty($c['accepts_marketing']), 'email' => (string) ($c['email'] ?? ''), 'tracking_url' => (string) ($o['tracking_url'] ?? ''),
            'tracking_number' => (string) ($o['tracking_number'] ?? ''), 'refund_amount' => $amt($o['refund_amount'] ?? null), 'checkout_url' => (string) ($d['checkout_url'] ?? ''),
            'checkout_token' => (string) ($d['checkout_id'] ?? ''),
        ];
    }

    /** Record the event once, add marketing consent, and send or schedule the SMS. */
    public static function handle(array $store, array $ev, string $env = 'live', string $deliveryId = ''): array
    {
        $key = $ev['event'] === 'checkout_abandoned' ? 'checkout:' . ($ev['checkout_token'] ?: $ev['order_id']) : $ev['event'] . ':' . ($ev['order_id'] ?: $deliveryId ?: bin2hex(random_bytes(6)));
        if ($env !== 'live') $key = 'test:' . bin2hex(random_bytes(6));
        if (DB::one('SELECT id FROM store_events WHERE store_id = ? AND dedupe = ?', [$store['id'], mb_substr($key, 0, 160)])) return ['status' => 'duplicate'];
        $phone = $ev['phone'] ? Gateway::phone((string) $ev['phone']) : null;
        $settings = self::settings($store);
        $cfg = $settings['events'][$ev['event']];
        $row = ['store_id' => $store['id'], 'topic' => $ev['event'], 'dedupe' => mb_substr($key, 0, 160), 'order_ref' => mb_substr((string) $ev['order_number'], 0, 60),
            'phone' => $phone, 'status' => 'received', 'payload' => json_encode($ev, JSON_UNESCAPED_UNICODE), 'created_at' => now()];
        if ($ev['event'] === 'order_created' && $ev['checkout_token'] !== '') {
            DB::run("UPDATE store_events SET status = 'skipped', note = 'Customer finished the order' WHERE store_id = ? AND dedupe = ? AND status = 'scheduled'", [$store['id'], 'checkout:' . $ev['checkout_token']]);
        }
        if ($phone && $ev['accepts_marketing'] && $store['list_id'] && $env === 'live') {
            Contacts::add((int) $store['org_id'], (int) $store['list_id'], trim($ev['first_name']), $phone, $ev['email'] ?: null, 'store');
        }
        if (empty($cfg['on'])) { $row = ['status' => 'skipped', 'note' => 'This message is switched off'] + $row; }
        elseif (!$phone) { $row = ['status' => 'skipped', 'note' => 'The order has no valid phone number'] + $row; }
        elseif ($ev['event'] === 'checkout_abandoned' && $env === 'live') {
            $row = ['status' => 'scheduled', 'note' => 'Sends in ' . $settings['abandoned_delay_hours'] . ' hour(s) unless the order is finished', 'send_at' => ts('+' . $settings['abandoned_delay_hours'] . ' hours')] + $row;
        }
        $id = DB::insert('store_events', $row);
        if ($row['status'] !== 'received') return ['status' => $row['status'], 'note' => $row['note'] ?? null];
        return self::send($store, $id, $ev, $phone, $cfg['text'], $env);
    }

    public static function send(array $store, int $eventId, array $ev, string $phone, string $template, string $env): array
    {
        $org = DB::one('SELECT * FROM orgs WHERE id = ?', [$store['org_id']]);
        $body = self::render($template, ['store' => $store['name']] + array_map(fn($v) => is_scalar($v) ? (string) $v : '', $ev));
        if ($env === 'live' && ($org['status'] !== 'active' || !$org['live_enabled'])) {
            DB::update('store_events', ['status' => 'failed', 'note' => 'Live access is off on your SeaGeek account'], 'id = ?', [$eventId]);
            return ['status' => 'failed', 'note' => 'live access off'];
        }
        [$code, $res] = Gateway::run($org, $env, 'POST', 'sms/messages', ['to' => [$phone], 'body' => $body, 'reference' => 'store:' . $store['public_id']], ['sms_unit' => 'store_sms']);
        if ($code >= 300) {
            $note = $code === 402 ? 'Your SeaGeek balance is too low' : ($res['error']['message'] ?? 'Could not send');
            DB::update('store_events', ['status' => 'failed', 'note' => mb_substr($note, 0, 255)], 'id = ?', [$eventId]);
            return ['status' => 'failed', 'note' => $note];
        }
        $msg = $res['data'][0] ?? [];
        DB::update('store_events', ['status' => $env === 'live' ? 'sent' : 'simulated', 'message_id' => $msg['id'] ?? null, 'note' => mb_substr($body, 0, 255)], 'id = ?', [$eventId]);
        if ($env === 'live') DB::run('UPDATE stores SET sms_sent = sms_sent + 1 WHERE id = ?', [$store['id']]);
        return ['status' => $env === 'live' ? 'sent' : 'simulated', 'message_id' => $msg['id'] ?? null, 'body' => $body];
    }

    /** Cron: send abandoned-cart reminders that are due. */
    public static function runScheduled(): int
    {
        $n = 0;
        foreach (DB::all("SELECT * FROM store_events WHERE status = 'scheduled' AND send_at <= ? ORDER BY id LIMIT 200", [now()]) as $e) {
            $store = DB::one('SELECT * FROM stores WHERE id = ?', [$e['store_id']]);
            if (!$store || $store['status'] !== 'active') { DB::update('store_events', ['status' => 'skipped', 'note' => 'Store paused'], 'id = ?', [$e['id']]); continue; }
            $ev = json_decode((string) $e['payload'], true) ?: [];
            $cfg = self::settings($store)['events']['checkout_abandoned'];
            if (empty($cfg['on'])) { DB::update('store_events', ['status' => 'skipped', 'note' => 'This message is switched off'], 'id = ?', [$e['id']]); continue; }
            self::send($store, (int) $e['id'], $ev, (string) $e['phone'], $cfg['text'], 'live');
            $n++;
        }
        return $n;
    }

    /** "Send a test order": runs the templates against a sample order in sandbox. */
    public static function simulate(array $store, string $event, string $phone): array
    {
        $sample = ['event' => $event, 'order_id' => (string) random_int(1000, 9999), 'order_number' => '#' . random_int(1001, 1999), 'total' => zar(899), 'first_name' => 'Thandi',
            'phone' => $phone, 'accepts_marketing' => false, 'email' => '', 'tracking_url' => 'https://track.example.co.za/SG1042', 'tracking_number' => 'SG1042ZA',
            'refund_amount' => zar(899), 'checkout_url' => 'https://' . ($store['domain'] ?: 'yourstore.co.za') . '/checkout', 'checkout_token' => ''];
        return self::handle($store, $sample, 'test');
    }

    public static function sampleBody(array $store, string $event): string
    {
        $cfg = self::settings($store)['events'][$event];
        return self::render($cfg['text'], ['store' => $store['name'], 'first_name' => 'Thandi', 'order_number' => '#1042', 'total' => zar(899), 'tracking_url' => 'https://track.example.co.za/SG1042',
            'tracking_number' => 'SG1042ZA', 'refund_amount' => zar(899), 'checkout_url' => 'https://' . ($store['domain'] ?: 'yourstore.co.za') . '/checkout']);
    }
}

// ---------------------------------------------------------------------------
// Contacts and opt-outs
// ---------------------------------------------------------------------------

final class Contacts
{
    public static function lists(int $orgId): array
    {
        return DB::all("SELECT l.*, (SELECT COUNT(*) FROM contacts c WHERE c.list_id = l.id) total,
            (SELECT COUNT(*) FROM contacts c WHERE c.list_id = l.id AND c.phone IS NOT NULL) phones,
            (SELECT COUNT(*) FROM contacts c WHERE c.list_id = l.id AND c.email IS NOT NULL) emails
            FROM contact_lists l WHERE l.org_id = ? ORDER BY l.id", [$orgId]);
    }

    public static function add(int $orgId, int $listId, string $name, ?string $phone, ?string $email, string $source = 'manual'): string
    {
        $phone = $phone ? Gateway::phone($phone) : null;
        $email = $email && filter_var(trim($email), FILTER_VALIDATE_EMAIL) ? strtolower(trim($email)) : null;
        if (!$phone && !$email) return 'invalid';
        $existing = $phone ? DB::one('SELECT id FROM contacts WHERE list_id = ? AND phone = ?', [$listId, $phone]) : null;
        $existing ??= $email ? DB::one('SELECT id FROM contacts WHERE list_id = ? AND email = ?', [$listId, $email]) : null;
        if ($existing) {
            DB::update('contacts', array_filter(['name' => mb_substr($name, 0, 160) ?: null, 'phone' => $phone, 'email' => $email]), 'id = ?', [$existing['id']]);
            return 'updated';
        }
        DB::insert('contacts', ['org_id' => $orgId, 'list_id' => $listId, 'name' => mb_substr(trim($name), 0, 160) ?: null, 'phone' => $phone, 'email' => $email, 'source' => $source, 'created_at' => now()]);
        return 'added';
    }

    /** Import pasted or uploaded CSV. Columns are found by their heading (name, phone, email); without headings the order is name, phone, email. */
    public static function import(int $orgId, int $listId, string $csv): array
    {
        $lines = array_values(array_filter(preg_split('/\r?\n/', trim($csv)), fn($l) => trim($l) !== ''));
        $res = ['added' => 0, 'updated' => 0, 'invalid' => 0];
        if (!$lines) return $res;
        $delim = substr_count($lines[0], ';') > substr_count($lines[0], ',') ? ';' : (str_contains($lines[0], "\t") ? "\t" : ',');
        $first = array_map(fn($v) => strtolower(trim($v)), str_getcsv($lines[0], $delim, '"', ''));
        $col = ['name' => null, 'phone' => null, 'email' => null];
        foreach ($first as $i => $h) {
            if ($col['name'] === null && preg_match('/^(name|full name|first name|first_name|customer)$/', $h)) $col['name'] = $i;
            if ($col['phone'] === null && preg_match('/(phone|mobile|cell|number|msisdn)/', $h)) $col['phone'] = $i;
            if ($col['email'] === null && preg_match('/e-?mail/', $h)) $col['email'] = $i;
        }
        $hasHeader = $col['phone'] !== null || $col['email'] !== null;
        if (!$hasHeader) $col = ['name' => 0, 'phone' => 1, 'email' => 2];
        foreach (array_slice($lines, $hasHeader ? 1 : 0, 50000) as $line) {
            $v = array_map('trim', str_getcsv($line, $delim, '"', ''));
            $r = self::add($orgId, $listId, (string) ($v[$col['name'] ?? -1] ?? ''), ($v[$col['phone'] ?? -1] ?? '') ?: null, ($v[$col['email'] ?? -1] ?? '') ?: null, 'import');
            $res[$r]++;
        }
        return $res;
    }

    public static function optOut(int $orgId, string $channel, string $address, string $reason): void
    {
        $address = strtolower(trim($address));
        if (!DB::one('SELECT org_id FROM opt_outs WHERE org_id = ? AND channel = ? AND address = ?', [$orgId, $channel, $address])) {
            DB::insert('opt_outs', ['org_id' => $orgId, 'channel' => $channel, 'address' => $address, 'reason' => mb_substr($reason, 0, 60), 'created_at' => now()]);
        }
    }

    public static function optedOut(int $orgId, string $channel): array
    {
        return array_flip(array_column(DB::all('SELECT address FROM opt_outs WHERE org_id = ? AND channel = ?', [$orgId, $channel]), 'address'));
    }

    public static function csvTemplate(): string
    {
        return "name,phone,email\nThandi Mokoena,0821234567,thandi@example.co.za\nSipho Dlamini,+27831112222,\nAyesha Patel,,ayesha@example.co.za\n";
    }
}

// ---------------------------------------------------------------------------
// Campaigns: bulk SMS and email newsletters
// ---------------------------------------------------------------------------

final class Campaigns
{
    /** Ready-made messages. {name} and {first_name} are filled per person. */
    public static function library(): array
    {
        return [
            ['sms', 'Promotion', 'Weekend sale', null, 'Hi {first_name}, our weekend sale is on: 20% off everything until Sunday. Shop now at {link}'],
            ['sms', 'Promotion', 'New stock', null, 'Hi {first_name}, new stock just landed. Be the first to see it: {link}'],
            ['sms', 'Reminder', 'Appointment reminder', null, 'Hi {first_name}, a reminder of your appointment on {date} at {time}. Reply YES to confirm or call us to change it.'],
            ['sms', 'Reminder', 'Payment due', null, 'Hi {first_name}, your account payment of {amount} is due on {date}. Pay here: {link}. Thank you.'],
            ['sms', 'Update', 'Delivery update', null, 'Hi {first_name}, your order is out for delivery today between {time}. Track it: {link}'],
            ['sms', 'Update', 'Service notice', null, 'Hi {first_name}, our offices will be closed on {date}. Online orders still go out as normal.'],
            ['sms', 'Event', 'Event invitation', null, 'Hi {first_name}, you are invited to {event} on {date} at {place}. RSVP here: {link}'],
            ['sms', 'Feedback', 'How did we do?', null, 'Hi {first_name}, thanks for choosing us. How did we do? Tell us in one minute: {link}'],
            ['email', 'Newsletter', 'Monthly newsletter', 'What is new this month', "Hi {first_name},\n\nHere is what changed this month.\n\nNew: tell your readers about your newest product or service in two or three short sentences.\n\nTip: share one practical tip your customers can use today.\n\nThank you for being with us."],
            ['email', 'Promotion', 'Special offer', 'A special offer for you, {first_name}', "Hi {first_name},\n\nFor this week only, you get 20% off your next order.\n\nThe offer ends on Sunday at midnight."],
            ['email', 'Update', 'Product update', 'Something new for you', "Hi {first_name},\n\nWe have just released something new.\n\nWhat it does: describe it in one sentence.\n\nWhy it matters: describe the benefit in one sentence."],
        ];
    }

    public static function render(string $text, array $vars): string
    {
        $first = trim(explode(' ', trim((string) ($vars['name'] ?? '')))[0] ?? '');
        $out = strtr($text, ['{name}' => trim((string) ($vars['name'] ?? '')) ?: 'there', '{first_name}' => $first !== '' ? $first : 'there']);
        return trim($out);
    }

    /** Audiences: a contact list, or for SeaGeek itself, every customer account owner. */
    public static function audiences(array $org): array
    {
        $out = [];
        foreach (Contacts::lists((int) $org['id']) as $l) $out['list:' . $l['id']] = $l['name'] . ' (' . number_format((int) $l['total']) . ')';
        if (!empty($org['is_house'])) {
            $n = (int) DB::value("SELECT COUNT(*) FROM users u JOIN orgs o ON o.id = u.org_id WHERE o.is_house = 0 AND u.role IN ('owner','billing') AND u.email_verified_at IS NOT NULL");
            $out['customers'] = 'All SeaGeek customers, owners and billing contacts (' . number_format($n) . ')';
        }
        return $out;
    }

    /** People a campaign goes to: [[name, address]], minus opt-outs, duplicates and missing addresses. */
    public static function recipients(array $org, string $audience, string $channel): array
    {
        $rows = [];
        if ($audience === 'customers' && !empty($org['is_house'])) {
            $rows = DB::all("SELECT u.name, u.email, o.phone FROM users u JOIN orgs o ON o.id = u.org_id WHERE o.is_house = 0 AND u.role IN ('owner','billing') AND u.email_verified_at IS NOT NULL");
        } elseif (preg_match('/^list:(\d+)$/', $audience, $m)) {
            $rows = DB::all('SELECT name, email, phone FROM contacts WHERE org_id = ? AND list_id = ?', [$org['id'], (int) $m[1]]);
        }
        $out = [];
        $skipped = 0;
        $blocked = Contacts::optedOut((int) $org['id'], $channel);
        foreach ($rows as $r) {
            $addr = $channel === 'sms' ? ($r['phone'] ? Gateway::phone((string) $r['phone']) : null) : ($r['email'] ? strtolower((string) $r['email']) : null);
            if (!$addr || isset($out[$addr]) || isset($blocked[strtolower($addr)])) { $skipped++; continue; }
            $out[$addr] = [(string) $r['name'], $addr];
        }
        return ['list' => array_values($out), 'skipped' => $skipped];
    }

    /** Cost estimate in rand before anything is sent. */
    public static function estimate(array $org, string $channel, string $body, int $count): array
    {
        if ($channel === 'sms') {
            $seg = Gateway::segments(self::render($body, ['name' => 'Thandeka']));
            $price = Billing::price($org, 'sms')['price'];
            return ['segments' => $seg, 'each' => round($price * $seg, 4), 'total' => !empty($org['is_house']) ? 0.0 : round($price * $seg * $count, 2)];
        }
        $price = Billing::price($org, 'email')['price'];
        return ['segments' => 1, 'each' => $price, 'total' => !empty($org['is_house']) ? 0.0 : round($price * $count, 2)];
    }

    public static function create(array $org, array $in, int $userId): array
    {
        $channel = ($in['channel'] ?? 'sms') === 'email' ? 'email' : 'sms';
        $pid = public_id('cmp');
        DB::insert('campaigns', [
            'public_id' => $pid, 'org_id' => $org['id'], 'name' => mb_substr(trim((string) ($in['name'] ?? '')) ?: 'Campaign ' . gmdate('j M'), 0, 160), 'channel' => $channel,
            'audience' => (string) ($in['audience'] ?? ''), 'subject' => $channel === 'email' ? mb_substr(trim((string) ($in['subject'] ?? '')), 0, 255) : null,
            'body' => mb_substr((string) ($in['body'] ?? ''), 0, $channel === 'sms' ? 1530 : 20000), 'button_label' => mb_substr(trim((string) ($in['button_label'] ?? '')), 0, 60) ?: null,
            'button_url' => filter_var($in['button_url'] ?? '', FILTER_VALIDATE_URL) ? mb_substr((string) $in['button_url'], 0, 500) : null,
            'status' => 'draft', 'created_by' => $userId, 'created_at' => now(),
        ]);
        return DB::one('SELECT * FROM campaigns WHERE public_id = ?', [$pid]);
    }

    /** Snapshot the audience and start sending (now or at a set time). Returns an error message or null. */
    public static function launch(array $org, array $c, ?string $at = null): ?string
    {
        if ($c['status'] !== 'draft') return 'This campaign has already been sent or scheduled.';
        if (trim((string) $c['body']) === '') return 'Write a message first.';
        if ($c['channel'] === 'email' && trim((string) $c['subject']) === '') return 'Add a subject line.';
        if (preg_match_all('/\{(?!first_name\}|name\})[a-z_]+\}/', $c['body'] . ' ' . $c['subject'], $mm)) {
            return 'Replace ' . implode(', ', array_unique($mm[0])) . ' with your own details before sending. Only {first_name} and {name} are filled in automatically.';
        }
        $r = self::recipients($org, (string) $c['audience'], $c['channel']);
        if (!$r['list']) return 'Nobody in this audience can receive ' . ($c['channel'] === 'sms' ? 'SMS' : 'email') . '. Add contacts with ' . ($c['channel'] === 'sms' ? 'phone numbers' : 'email addresses') . ' first.';
        if (empty($org['is_house'])) {
            $svc = $c['channel'] === 'sms' ? 'sms' : 'mail';
            if (Services::status((int) $org['id'], $svc) !== 'active') return 'Switch on ' . ($svc === 'sms' ? 'SMS' : 'Mail') . ' under Services first.';
            if (!$org['live_enabled'] || $org['status'] !== 'active') return 'Live access is off on your account. Pay your first invoice or settle overdue invoices to send campaigns.';
            $est = self::estimate($org, $c['channel'], (string) $c['body'], count($r['list']));
            if ($est['total'] > Billing::available($org)) return 'This campaign costs about ' . zar($est['total']) . ' and your available credit is ' . zar(Billing::available($org)) . '. Add credit first.';
        }
        DB::tx(function () use ($c, $r, $at) {
            foreach ($r['list'] as [$name, $addr]) DB::insert('campaign_recipients', ['campaign_id' => $c['id'], 'name' => mb_substr($name, 0, 160), 'address' => $addr, 'status' => 'pending', 'updated_at' => now()]);
            DB::update('campaigns', ['status' => $at ? 'scheduled' : 'sending', 'scheduled_at' => $at, 'started_at' => $at ? null : now(), 'total' => count($r['list']), 'skipped' => $r['skipped']], 'id = ?', [$c['id']]);
        });
        return null;
    }

    public static function unsubscribeUrl(array $c, string $address): string
    {
        $payload = rtrim(strtr(base64_encode(json_encode([(int) $c['org_id'], $c['channel'], $address])), '+/', '-_'), '=');
        return app_url('/u/' . $payload . '.' . substr(hash_hmac('sha256', $payload, (string) config('app_key')), 0, 20));
    }

    public static function readUnsubscribe(string $token): ?array
    {
        [$payload, $sig] = array_pad(explode('.', $token, 2), 2, '');
        if (!hash_equals(substr(hash_hmac('sha256', $payload, (string) config('app_key')), 0, 20), $sig)) return null;
        $d = json_decode((string) base64_decode(strtr($payload, '-_', '+/')), true);
        return is_array($d) && count($d) === 3 ? ['org_id' => (int) $d[0], 'channel' => (string) $d[1], 'address' => (string) $d[2]] : null;
    }

    public static function emailHtml(array $org, array $c, string $name, string $address): string
    {
        return view('emails/campaign', [
            'subject' => self::render((string) $c['subject'], ['name' => $name]), 'body' => self::render((string) $c['body'], ['name' => $name]),
            'button_label' => $c['button_label'], 'button_url' => $c['button_url'], 'brand' => !empty($org['is_house']) ? null : $org['name'],
            'unsubscribe' => self::unsubscribeUrl($c, $address), 'org' => $org,
        ], 'email');
    }

    /** Cron and worker: send the next batch of every running campaign. */
    public static function process(int $limit = 200): int
    {
        DB::run("UPDATE campaigns SET status = 'sending', started_at = ? WHERE status = 'scheduled' AND scheduled_at <= ?", [now(), now()]);
        $n = 0;
        foreach (DB::all("SELECT * FROM campaigns WHERE status = 'sending' ORDER BY id") as $c) {
            $org = DB::one('SELECT * FROM orgs WHERE id = ?', [$c['org_id']]);
            foreach (DB::all("SELECT * FROM campaign_recipients WHERE campaign_id = ? AND status = 'pending' ORDER BY id LIMIT " . (int) $limit, [$c['id']]) as $rc) {
                [$ok, $mid, $err] = self::sendOne($org, $c, $rc);
                DB::update('campaign_recipients', ['status' => $ok ? 'sent' : 'failed', 'message_id' => $mid, 'error' => $err ? mb_substr($err, 0, 255) : null, 'updated_at' => now()], 'id = ?', [$rc['id']]);
                $n++;
                if (!$ok && str_contains((string) $err, 'balance')) {
                    DB::run("UPDATE campaign_recipients SET status = 'failed', error = ? WHERE campaign_id = ? AND status = 'pending'", ['Not sent: balance too low', $c['id']]);
                    break;
                }
            }
            self::refresh((int) $c['id']);
        }
        return $n;
    }

    private static function sendOne(array $org, array $c, array $rc): array
    {
        if ($c['channel'] === 'sms') {
            $body = self::render((string) $c['body'], ['name' => $rc['name']]);
            [$code, $res] = Gateway::run($org, 'live', 'POST', 'sms/messages', ['to' => [$rc['address']], 'body' => $body, 'reference' => $c['public_id']]);
            return $code < 300 ? [true, $res['data'][0]['id'] ?? null, null] : [false, null, $res['error']['message'] ?? 'failed'];
        }
        $html = self::emailHtml($org, $c, (string) $rc['name'], $rc['address']);
        $subject = self::render((string) $c['subject'], ['name' => $rc['name']]);
        if (!empty($org['is_house'])) {
            DB::insert('email_outbox', ['to_addr' => $rc['address'], 'subject' => $subject, 'html' => $html, 'text_body' => Mail::text($html),
                'headers' => json_encode(['List-Unsubscribe' => '<' . self::unsubscribeUrl($c, $rc['address']) . '>']), 'status' => 'queued', 'attempts' => 0, 'created_at' => now()]);
            return [true, null, null];
        }
        [$code, $res] = Gateway::run($org, 'live', 'POST', 'mail/messages', ['to' => [$rc['address']], 'subject' => $subject, 'html' => $html, 'text' => Mail::text($html), 'reference' => $c['public_id']]);
        return $code < 300 ? [true, $res['data'][0]['id'] ?? null, null] : [false, null, $res['error']['message'] ?? 'failed'];
    }

    public static function refresh(int $campaignId): void
    {
        $c = DB::one('SELECT * FROM campaigns WHERE id = ?', [$campaignId]);
        $counts = array_column(DB::all('SELECT status, COUNT(*) n FROM campaign_recipients WHERE campaign_id = ? GROUP BY status', [$campaignId]), 'n', 'status');
        $cost = (float) DB::value('SELECT COALESCE(SUM(amount), 0) FROM messages WHERE org_id = ? AND reference = ?', [$c['org_id'], $c['public_id']]);
        $d = ['sent' => (int) ($counts['sent'] ?? 0), 'failed' => (int) ($counts['failed'] ?? 0), 'cost' => $cost];
        if ($c['status'] === 'sending' && empty($counts['pending'])) { $d['status'] = 'sent'; $d['finished_at'] = now(); }
        DB::update('campaigns', $d, 'id = ?', [$campaignId]);
    }

    /** Delivery numbers from the message records. */
    public static function delivery(array $c): array
    {
        $rows = DB::all('SELECT status, COUNT(*) n FROM messages WHERE org_id = ? AND reference = ? GROUP BY status', [$c['org_id'], $c['public_id']]);
        return array_column($rows, 'n', 'status');
    }
}
