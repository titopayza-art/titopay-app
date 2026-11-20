<?php
/**
 * Once-off build services: websites, shops, apps, chatbots and systems. Prices exclude VAT and exclude
 * hosting, which is a separate monthly fee. Every price here is a proposal and can be changed in one place.
 */
declare(strict_types=1);

final class Build
{
    public const HOSTING_FROM = 199; // R per month, excl. VAT. Domain names are charged at cost.

    /** key => [name, from price R, what is included, how long to go live (working days), best for]. */
    public static function offers(): array
    {
        return [
            'landing' => ['One-page website', 1000, 'One page, mobile-friendly, contact form, WhatsApp button, Google Maps link.', 3, 'Launching a service, a single product or an event'],
            'basic' => ['Basic website', 1500, 'Up to 5 pages, mobile-friendly, contact form, WhatsApp button, basic search engine setup.', 5, 'Small businesses that need a clear online presence'],
            'backend' => ['Website with back end', 3500, 'Up to 10 pages, a login area to edit your own content, enquiries and quotes saved and emailed, and your Desk inbox.', 7, 'Businesses that update their site themselves or take enquiries online'],
            'shop' => ['Online shop', 4500, 'Product catalogue, stock levels, PayFast checkout, order emails and SMS updates through SeaGeek.', 7, 'Selling products online in South Africa'],
            'chatbot' => ['Your own chatbot', 6500, 'An AI assistant trained on your documents, live on your website, with handover to your team and a monthly spending cap.', 7, 'Answering customer questions day and night'],
            'system' => ['Your own system', 9000, 'A tailored system for your business: your workflows, your users and roles, reports, and your own admin area.', 15, 'Running your business processes in one place'],
            'app' => ['Mobile app', 25000, 'Android and iPhone app (or an installable web app) for up to 5 screens, with sign-in and notifications. Final price after a short scoping call.', 20, 'Customers or staff who need an app on their phone'],
            'integration' => ['Connect your systems', 2500, 'Connect SeaGeek to Xero, Shopify, WooCommerce or your own system through our API, with testing and handover.', 5, 'Keeping invoices, orders and messages in step'],
        ];
    }

    /** Pick what suits the answers to three plain questions. */
    public static function recommend(string $need, string $size, string $extra): array
    {
        $o = self::offers();
        $pick = match (true) {
            $need === 'sell' => 'shop',
            $need === 'app' => 'app',
            $need === 'answer' => $extra === 'system' ? 'system' : 'chatbot',
            $need === 'run' => 'system',
            $need === 'connect' => 'integration',
            $size === 'one' => 'landing',
            $extra === 'login' || $size === 'many' => 'backend',
            default => 'basic',
        };
        $alt = $pick === 'basic' ? 'backend' : ($pick === 'backend' ? 'basic' : null);
        return ['key' => $pick, 'offer' => $o[$pick], 'alt' => $alt ? $o[$alt] : null, 'alt_key' => $alt];
    }

    /** Keep a request as a support ticket, so the team sees it in the same inbox as everything else. */
    public static function request(string $key, array $contact, string $brief): int
    {
        $o = self::offers()[$key] ?? null;
        if (!$o) throw new RuntimeException('Unknown offer.');
        $t = Desk::createTicket((int) Desk::house()['id'], 'Build request: ' . $o[0], "Offer: {$o[0]} (from R" . number_format($o[1]) . " excl. VAT, hosting excluded)\n\nWhat they want:\n$brief",
            'web', ['name' => $contact['name'], 'email' => $contact['email'], 'phone' => $contact['phone'] ?? null], 'normal', ['build-request', 'build-' . $key]);
        return (int) $t['number'];
    }
}
