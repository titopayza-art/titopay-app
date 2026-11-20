<?php
// What search engines and link previews (WhatsApp, Facebook, X, iMessage)
// see. Pages are plain HTML filled in by JavaScript, which those readers do
// not run, so an event page gets its own title, description, picture and
// Google event data written into the page before it is sent; and
// /sitemap.xml lists the public pages and every event on sale.
declare(strict_types=1);

const SEO_SHARE_IMAGE = '/assets/og/ticketroom-share.png';

function seo_e(string $s): string { return htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); }
function seo_text(?string $s, int $max = 200): string
{
    $s = trim((string) preg_replace('/\s+/u', ' ', strip_tags((string) $s)));
    return mb_strlen($s) > $max ? rtrim(mb_substr($s, 0, $max - 1)) . '…' : $s;
}

// A published, public event by its address (never drafts or test events).
function seo_event(string $slug): ?array
{
    if (!preg_match('/^[a-z0-9-]{1,120}$/', $slug)) return null;
    $e = row("SELECT e.*, o.name AS organiser_name FROM events e JOIN organisers o ON o.id = e.organiser_id
               WHERE e.slug = ? AND e.status IN ('published','cancelled','completed') AND COALESCE(e.is_test, 0) = 0", [$slug]);
    if (!$e) return null;
    $t = row('SELECT MIN(price_cents) AS low, MAX(price_cents) AS high, COALESCE(SUM(quantity_total - quantity_sold - quantity_held), 0) AS left_n FROM ticket_types WHERE event_id = ?', [$e['id']]);
    $e['price_low'] = $t['low'] === null ? null : (int) $t['low'];
    $e['places_left'] = (int) ($t['left_n'] ?? 0);
    return $e;
}

function seo_event_html(string $slug, string $html): string
{
    $e = seo_event($slug);
    // Not a public event (a draft preview, a test event, a wrong address): never indexed.
    if (!$e) return (string) preg_replace('#</head>#', '<meta name="robots" content="noindex">' . "\n</head>", $html, 1);
    $base = base_url();
    $url = "$base/events/{$e['slug']}";
    $when = when_str((string) $e['starts_at']);
    $where = trim($e['venue_name'] . ($e['city'] ? ", {$e['city']}" : ''), ', ');
    $title = "{$e['title']} | Tickets | TicketRoom";
    $desc = seo_text("$when · $where. " . ($e['summary'] ?: $e['description'] ?: 'Tickets on TicketRoom.'), 200);
    $img = $base . ($e['image_upload_id'] ? '/media/' . rawurlencode((string) $e['image_upload_id']) : SEO_SHARE_IMAGE);

    $status = match ($e['status']) { 'cancelled' => 'https://schema.org/EventCancelled', default => 'https://schema.org/EventScheduled' };
    $ld = [
        '@context' => 'https://schema.org', '@type' => 'Event',
        'name' => $e['title'], 'url' => $url, 'image' => [$img],
        'description' => seo_text($e['description'] ?: $e['summary'] ?: $e['title'], 500),
        'startDate' => $e['starts_at'], 'endDate' => $e['ends_at'] ?: $e['starts_at'],
        'eventStatus' => $status, 'eventAttendanceMode' => 'https://schema.org/OfflineEventAttendanceMode',
        'location' => ['@type' => 'Place', 'name' => $e['venue_name'], 'address' => array_filter([
            '@type' => 'PostalAddress', 'streetAddress' => $e['address'] ?: null, 'addressLocality' => $e['city'] ?: null,
            'addressRegion' => $e['province'] ?: null, 'addressCountry' => 'ZA'])],
        'organizer' => ['@type' => 'Organization', 'name' => $e['organiser_name']],
    ];
    if ($e['price_low'] !== null) {
        $ld['offers'] = ['@type' => 'Offer', 'url' => $url, 'priceCurrency' => 'ZAR', 'price' => number_format($e['price_low'] / 100, 2, '.', ''),
            'availability' => $e['places_left'] <= 0 ? 'https://schema.org/SoldOut' : 'https://schema.org/InStock',
            'validFrom' => $e['sales_start_at'] ?: $e['published_at'] ?: $e['created_at']];
    }
    $json = json_encode($ld, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP);

    $head = '<link rel="canonical" href="' . seo_e($url) . '">'
        . '<meta property="og:type" content="website"><meta property="og:site_name" content="TicketRoom">'
        . '<meta property="og:title" content="' . seo_e($e['title']) . '"><meta property="og:description" content="' . seo_e($desc) . '">'
        . '<meta property="og:url" content="' . seo_e($url) . '"><meta property="og:image" content="' . seo_e($img) . '">'
        . '<meta name="twitter:card" content="summary_large_image"><meta name="twitter:site" content="@ticketroom_za">'
        . '<script type="application/ld+json">' . $json . '</script>';
    $html = (string) preg_replace('#<title>.*?</title>#s', '<title>' . seo_e($title) . '</title>', $html, 1);
    $html = (string) preg_replace('#<meta name="description" content="[^"]*">#', '<meta name="description" content="' . seo_e($desc) . '">', $html, 1);
    // The page's general share tags give way to the event's own.
    $html = (string) preg_replace('#<meta (property|name)="(og|twitter):[^"]+" content="[^"]*">#', '', $html);
    $html = (string) preg_replace('#<link rel="canonical" href="[^"]*">#', '', $html);
    return (string) preg_replace('#</head>#', $head . "\n</head>", $html, 1);
}

// Public pages and every published, upcoming event.
const SEO_PAGES = ['', 'sell', 'advertise', 'retail', 'partners', 'about', 'careers', 'help', 'safety', 'contact', 'legal/terms-of-use', 'legal/terms', 'legal/privacy', 'legal/cookies', 'legal/paia'];
function seo_sitemap(): string
{
    $base = base_url();
    $out = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
    foreach (SEO_PAGES as $p) $out[] = '<url><loc>' . seo_e($base . '/' . $p) . '</loc></url>';
    $events = rows("SELECT slug, updated_at FROM events WHERE status = 'published' AND COALESCE(is_test, 0) = 0 AND starts_at >= ? ORDER BY starts_at LIMIT 45000", [iso_in(-86400)]);
    foreach ($events as $ev) $out[] = '<url><loc>' . seo_e("$base/events/{$ev['slug']}") . '</loc><lastmod>' . seo_e(substr((string) $ev['updated_at'], 0, 10)) . '</lastmod></url>';
    $out[] = '</urlset>';
    return implode("\n", $out) . "\n";
}
