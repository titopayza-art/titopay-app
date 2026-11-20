<?php
/**
 * WhatsApp message templates: the approved formats a business sends outside the 24-hour window.
 * Headers, body with numbered values, footer, and up to three buttons (website link, phone call, quick reply).
 * Meta approves each template; until the WhatsApp connection is live they wait in "Waiting for approval".
 */
declare(strict_types=1);

final class WaTemplates
{
    public const CATEGORIES = ['utility' => 'Utility: bookings, orders, receipts, reminders', 'marketing' => 'Marketing: offers and news (needs opt-in)', 'authentication' => 'Authentication: one-time codes'];
    public const LANGUAGES = ['en' => 'English', 'en_ZA' => 'English (South Africa)', 'af' => 'Afrikaans', 'zu' => 'isiZulu', 'xh' => 'isiXhosa', 'st' => 'Sesotho'];

    /** @return array{0: array|null, 1: string|null} [clean template, error] */
    public static function validate(array $in): array
    {
        $name = strtolower(trim((string) ($in['name'] ?? '')));
        if (!preg_match('/^[a-z0-9_]{3,60}$/', $name)) return [null, 'Name the template with lowercase letters, numbers and underscores, for example order_ready.'];
        $cat = (string) ($in['category'] ?? '');
        if (!isset(self::CATEGORIES[$cat])) return [null, 'Choose a category.'];
        $lang = (string) ($in['language'] ?? 'en_ZA');
        if (!isset(self::LANGUAGES[$lang])) return [null, 'Choose a language.'];
        $body = trim((string) ($in['body'] ?? ''));
        if ($body === '' || mb_strlen($body) > 1024) return [null, 'The message body is required and can be up to 1,024 characters.'];
        $vars = self::placeholders($body);
        if ($vars && max($vars) !== count($vars)) return [null, 'Numbered values must run in order: {{1}}, then {{2}}, and so on.'];
        $samples = array_values(array_map('strval', (array) ($in['samples'] ?? [])));
        if (count($vars) !== count(array_filter($samples, fn($s) => trim($s) !== ''))) return [null, 'Give one example value for each {{number}} in the message. Meta uses these to review it.'];
        $headerType = in_array($in['header_type'] ?? 'none', ['none', 'text'], true) ? (string) $in['header_type'] : 'none';
        $headerText = $headerType === 'text' ? trim((string) ($in['header_text'] ?? '')) : '';
        if ($headerType === 'text' && ($headerText === '' || mb_strlen($headerText) > 60 || self::placeholders($headerText))) return [null, 'A text header is up to 60 characters, without numbered values.'];
        $footer = mb_substr(trim((string) ($in['footer'] ?? '')), 0, 60) ?: null;
        $buttons = [];
        foreach (array_slice((array) ($in['buttons'] ?? []), 0, 3) as $b) {
            $type = (string) ($b['type'] ?? '');
            $text = mb_substr(trim((string) ($b['text'] ?? '')), 0, 25);
            if ($text === '' && $type === '') continue;
            if ($text === '') return [null, 'Every button needs its label.'];
            if ($type === 'url') {
                $url = trim((string) ($b['url'] ?? ''));
                if (!preg_match('#^https://#i', $url) || mb_strlen($url) > 2000) return [null, 'Website buttons must start with https://.'];
                if (count(self::placeholders($url)) > 1) return [null, 'A website button can have at most one value, at the end of the link.'];
                $buttons[] = ['type' => 'url', 'text' => $text, 'url' => $url];
            } elseif ($type === 'phone') {
                $num = preg_replace('/[^\d+]/', '', (string) ($b['phone'] ?? ''));
                if (strlen(ltrim($num, '+')) < 9) return [null, 'Phone buttons need a valid number.'];
                $buttons[] = ['type' => 'phone', 'text' => $text, 'phone' => $num];
            } elseif ($type === 'quick') {
                $buttons[] = ['type' => 'quick', 'text' => $text];
            } else return [null, 'Choose a button type: website, phone or quick reply.'];
        }
        return [[
            'name' => $name, 'category' => $cat, 'language' => $lang, 'header_type' => $headerType, 'header_text' => $headerText ?: null, 'body' => $body,
            'footer' => $footer, 'buttons' => $buttons, 'samples' => array_slice($samples, 0, count($vars)), 'vars' => $vars,
        ], null];
    }

    /** Numbers used in a text, e.g. {{1}}, {{2}}. */
    public static function placeholders(string $text): array
    {
        preg_match_all('/\{\{(\d{1,2})\}\}/', $text, $m);
        return array_values(array_unique(array_map('intval', $m[1])));
    }

    /**
     * The message Meta receives. Body values fill {{1}}, {{2}}...; a website button with a value at the end of its
     * link takes its own value, because WhatsApp keeps button values separate from the body.
     */
    public static function components(array $t, array $values, ?string $buttonValue = null): array
    {
        $vals = array_values(array_map(fn($v) => mb_substr(trim((string) $v), 0, 1000), $values));
        $out = [];
        if ($vals) $out[] = ['type' => 'body', 'parameters' => array_map(fn($v) => ['type' => 'text', 'text' => $v], $vals)];
        foreach (array_values($t['buttons']) as $i => $b) {
            if ($b['type'] === 'url' && self::placeholders($b['url'])) {
                $out[] = ['type' => 'button', 'sub_type' => 'url', 'index' => (string) $i, 'parameters' => [['type' => 'text', 'text' => mb_substr(trim((string) $buttonValue), 0, 500)]]];
            }
        }
        return $out;
    }

    public static function row(int $orgId, string $name, string $lang): ?array
    {
        return DB::one('SELECT * FROM wa_templates WHERE org_id = ? AND name = ? AND language = ?', [$orgId, $name, $lang]);
    }

    /** Send an approved template to a customer through the normal WhatsApp route. */
    public static function send(array $org, array $t, string $to, array $values, string $env, ?string $buttonValue = null): array
    {
        if (self::placeholders(implode(' ', array_column(array_filter($t['buttons'], fn($b) => $b['type'] === 'url'), 'url'))) && trim((string) $buttonValue) === '') {
            return [false, 'Enter the value for the end of the website button link.'];
        }
        if ($t['status'] !== 'approved') return [false, 'This template is not approved yet. WhatsApp approves each template before it can be sent.'];
        $payload = ['to' => $to, 'type' => 'template', 'category' => $t['category'], 'reference' => 'tpl-' . $t['id'],
            'template' => ['name' => $t['name'], 'language' => ['code' => $t['language']], 'components' => self::components($t, $values, $buttonValue)]];
        [$code, $res] = Gateway::run($org, $env, 'POST', 'whatsapp/messages', $payload);
        if ($code >= 300) return [false, (string) ($res['error']['message'] ?? 'Could not send (error ' . $code . ').')];
        return [true, (string) ($res['data']['status'] ?? 'sent')];
    }
}
