<?php
/**
 * Structure of the developer documentation: navigation, guide pages, per-product requirements,
 * webhook payload examples and the search index. Page bodies live in app/views/docs.
 */
declare(strict_types=1);

final class Docs
{
    /** Guide pages: slug => [title, group, one-line summary]. Order here is reading order. */
    public static function guides(): array
    {
        return [
            'quickstart' => ['Quickstart', 'Get started', 'Send your first request in five minutes, then go live.'],
            'authentication' => ['Authentication', 'Get started', 'API keys, the Authorization header, and keeping keys safe.'],
            'environments' => ['Sandbox and live', 'Get started', 'What the sandbox simulates, test values per product, and the go-live checklist.'],
            'errors' => ['Errors', 'Using the API', 'The error format, every error type, and which ones to retry.'],
            'limits' => ['Rate limits', 'Using the API', 'Requests per second, AI caps and reply lengths for each plan.'],
            'idempotency' => ['Idempotency', 'Using the API', 'Retry safely without sending or charging twice.'],
            'webhooks' => ['Webhooks', 'Using the API', 'Events, payloads, signatures and retries.'],
            'billing' => ['Credit and billing', 'Using the API', 'Prepaid credit, services, packages, invoices and your customer number.'],
            'account' => ['Account endpoints', 'Reference', 'Account, balance, usage and message lookup.'],
            'changelog' => ['Changelog', 'Reference', 'What changed in the API, newest first.'],
        ];
    }

    /** Sidebar: group => [[title, href, slug, badge]]. */
    public static function nav(): array
    {
        $nav = ['Get started' => [['Overview', '/docs', 'overview', null]]];
        foreach (self::guides() as $slug => [$title, $group]) {
            if ($group === 'Reference') continue;
            $nav[$group][] = [$title, '/docs/' . $slug, $slug, null];
        }
        foreach (Catalog::services() as $k => $s) {
            $nav['Products'][] = [$s['name'], '/docs/' . $k, $k, Catalog::statusLabel($s['status'])];
        }
        foreach (self::guides() as $slug => [$title, $group]) if ($group === 'Reference') $nav['Reference'][] = [$title, '/docs/' . $slug, $slug, null];
        $nav['Reference'][] = ['OpenAPI spec', '/docs/openapi.json', 'openapi', 'JSON'];
        $nav['Reference'][] = ['How it connects', '/developers', 'developers', null];
        $nav['Reference'][] = ['Service status', '/status', 'status', null];
        return $nav;
    }

    /** Every docs page in reading order, for previous and next links. */
    public static function sequence(): array
    {
        $out = [];
        foreach (self::nav() as $group => $items) {
            foreach ($items as [$title, $href, $slug]) {
                if (!str_starts_with($href, '/docs') || $slug === 'openapi') continue;
                if (isset(Catalog::services()[$slug]) && Catalog::services()[$slug]['status'] === 'planned') continue;
                $out[] = ['title' => $title, 'href' => $href, 'slug' => $slug, 'group' => $group];
            }
        }
        return $out;
    }

    public static function neighbours(string $slug): array
    {
        $seq = self::sequence();
        foreach ($seq as $i => $p) if ($p['slug'] === $slug) return [$seq[$i - 1] ?? null, $seq[$i + 1] ?? null];
        return [null, null];
    }

    public static function groupOf(string $slug): string
    {
        foreach (self::nav() as $group => $items) foreach ($items as $it) if ($it[2] === $slug) return $group;
        return 'Docs';
    }

    /** What has to be true before live traffic flows for a product. */
    public static function requirements(string $svc): array
    {
        $common = ['Switch the product on under Services in your dashboard. Sandbox keys work without this.'];
        return match ($svc) {
            'sms' => [...$common, 'Optional: register a sender ID (up to 11 characters) under SMS in the dashboard. Until it is approved, messages use a shared sender.', 'Marketing SMS must include an opt-out and respect the hours set by the Consumer Protection Act.'],
            'mail' => [...$common, 'Optional: verify your sending domain (SPF and DKIM records) so email comes from your own address. Until then, email is sent from a shared SeaGeek domain.'],
            'auth' => [...$common, 'Nothing else: codes are sent from SeaGeek senders with your brand name in the message.'],
            'whatsapp' => [...$common, 'Connect a WhatsApp Business number under WhatsApp in the dashboard. We register it with Meta through our partner.', 'Templates (utility, marketing, authentication) must be approved by Meta before you can send them.', 'Each connected number costs ' . zar(890, 0) . ' a month, charged from your credit.'],
            'verify' => [...$common, 'Business verification (KYB): submit your company registration number and use case. We review it within one working day.', 'You must have a lawful reason under POPIA to check a person, and you must tell them you are doing so.'],
            'ai' => [...$common, 'Nothing else. Spending is capped every month by your plan, and you can set a lower cap yourself.'],
            'voice' => [...$common, 'Voice is in beta: calls go to South African numbers only.'],
            'desk' => ['Desk is included in every plan. Seats depend on your plan.'],
            default => [],
        };
    }

    /** Example webhook payloads, exactly as delivered (the "data" object varies by event). */
    public static function eventExample(string $event): array
    {
        $msg = fn(string $svc, string $status, array $extra = []) => ['id' => 'msg_8Kq2vXr1Pz', 'service' => $svc, 'direction' => 'outbound', 'status' => $status, 'to' => '+27821234567', 'amount' => 0.29, 'currency' => 'ZAR', 'reference' => 'order-1042', 'environment' => 'live', 'created_at' => '2026-11-18T09:15:02+00:00', 'updated_at' => '2026-11-18T09:15:06+00:00'] + $extra;
        $ticket = ['id' => 1042, 'subject' => 'Where is my order?', 'status' => 'open', 'priority' => 'normal', 'channel' => 'chat', 'requester' => ['name' => 'Sipho Dlamini', 'email' => 'sipho@example.co.za', 'phone' => null], 'url' => 'https://www.seageek.co.za/t/3f9c1a7e', 'created_at' => '2026-11-18T09:15:02+00:00'];
        $data = match ($event) {
            'message.delivered' => $msg('sms', 'delivered'),
            'message.read' => $msg('whatsapp', 'read', ['amount' => 0.25]),
            'message.failed' => $msg('sms', 'failed', ['amount' => 0, 'error' => 'undeliverable']),
            'whatsapp.inbound' => ['id' => 'msg_3Hw9cLp2Tq', 'from' => '+27821234567', 'to' => '+27105550100', 'text' => 'Yes, please deliver on Friday.'],
            'verify.completed' => ['id' => 'chk_6Tr4yVm8Na', 'service' => 'verify', 'status' => 'completed', 'amount' => 9.5, 'currency' => 'ZAR', 'environment' => 'live', 'meta' => ['type' => 'id', 'result' => ['match' => true, 'deceased' => false, 'first_names' => 'THANDI', 'last_name' => 'MOKOENA']], 'created_at' => '2026-11-18T09:15:02+00:00'],
            'desk.ticket_created' => $ticket,
            'desk.handover' => $ticket + ['reason' => 'Customer asked for a person'],
            default => ['message' => 'Test event from the SeaGeek dashboard'],
        };
        return ['id' => 'evt_5Ga1sXe7Rk', 'type' => $event, 'created_at' => '2026-11-18T09:15:06+00:00', 'data' => $data];
    }

    public static function events(): array
    {
        return [
            'message.delivered' => 'An SMS, email, WhatsApp message or call reached the recipient.',
            'message.read' => 'A WhatsApp message was read.',
            'message.failed' => 'A message could not be delivered. The charge has been refunded to your credit.',
            'whatsapp.inbound' => 'Someone sent a WhatsApp message to one of your numbers.',
            'verify.completed' => 'An identity or business check finished.',
            'desk.ticket_created' => 'A ticket was created from chat, WhatsApp, email, the web or the API.',
            'desk.handover' => 'An AI agent handed a conversation to your team.',
            'ping' => 'A test event you sent from the dashboard.',
        ];
    }

    public static function changelog(): array
    {
        return [
            ['2026-11-18', 'Services and billing', ['GET /v1/account now returns your customer_no and which services are switched on.', 'Live requests to a product that is not switched on return 403 service_not_active. Sandbox keys are not affected.', 'Every payment now has an invoice with line items, and monthly statements are available in the dashboard.']],
            ['2026-10-01', 'SeaGeek AI', ['Monthly AI spending caps per plan, checked before every request.', 'Hosted AI agents with handover to Desk.']],
            ['2026-09-01', 'WhatsApp', ['Inbound messages are delivered to your webhook as whatsapp.inbound.', 'Message status now includes read.']],
            ['2026-08-01', 'First release', ['SMS, Mail, Auth, WhatsApp, Verify and Desk APIs.', 'Idempotency keys on every POST.', 'Signed webhooks with automatic retries.']],
        ];
    }

    /** Search index for the docs search box: pages and every endpoint. */
    public static function searchIndex(): array
    {
        $idx = [];
        foreach (self::guides() as $slug => [$title, $group, $summary]) $idx[] = ['t' => $title, 'h' => '/docs/' . $slug, 'g' => $group, 'd' => $summary];
        foreach (Catalog::services() as $k => $s) {
            $idx[] = ['t' => $s['name'] . ' API', 'h' => '/docs/' . $k, 'g' => 'Products', 'd' => $s['summary']];
            foreach ($s['endpoints'] as $i => $ep) $idx[] = ['t' => $ep[2], 'h' => '/docs/' . $k . '#ep-' . $i, 'g' => $s['name'], 'd' => $ep[0] . ' /api' . $ep[1]];
        }
        foreach (Catalog::platformEndpoints() as [$m, $p, $d]) $idx[] = ['t' => $d, 'h' => '/docs/account', 'g' => 'Account', 'd' => $m . ' /api' . $p];
        foreach (self::events() as $e => $d) $idx[] = ['t' => $e, 'h' => '/docs/webhooks#' . str_replace('.', '-', $e), 'g' => 'Webhook event', 'd' => $d];
        return $idx;
    }
}
