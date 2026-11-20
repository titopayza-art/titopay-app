<?php
/**
 * Single source of truth for plans, rates, partners, AI models and API documentation.
 * The docs pages, the API gateway and billing all read from here.
 */
declare(strict_types=1);

final class Catalog
{
    public static function plans(): array
    {
        $f = fn(array $x) => json_encode($x);
        return [
            ['code' => 'payg', 'name' => 'Pay as you go', 'price' => 0, 'included_credit' => 0, 'discount_pct' => 0, 'ai_monthly_cap' => 200, 'ai_max_tokens' => 1024, 'ai_rpm' => 10, 'api_rps' => 5, 'desk_agents' => 1, 'wa_numbers' => 1, 'sort' => 1, 'active' => 1,
                'features' => $f(['Sandbox and live API keys', 'Standard usage rates', 'Desk with 1 agent', 'AI spend cap R200 a month', 'Email support'])],
            ['code' => 'startup', 'name' => 'Startup', 'price' => 299, 'included_credit' => 150, 'discount_pct' => 0, 'ai_monthly_cap' => 500, 'ai_max_tokens' => 2048, 'ai_rpm' => 20, 'api_rps' => 10, 'desk_agents' => 2, 'wa_numbers' => 1, 'sort' => 2, 'active' => 1,
                'features' => $f(['R150 usage credit every month', 'Desk with 2 agents and help centre', 'AI spend cap R500 a month', 'Webhooks and delivery logs', 'Email support'])],
            ['code' => 'business', 'name' => 'Business', 'price' => 999, 'included_credit' => 600, 'discount_pct' => 5, 'ai_monthly_cap' => 2500, 'ai_max_tokens' => 4096, 'ai_rpm' => 60, 'api_rps' => 25, 'desk_agents' => 5, 'wa_numbers' => 2, 'sort' => 3, 'active' => 1,
                'features' => $f(['R600 usage credit every month', '5% off all usage', 'Desk with 5 agents and AI agent', 'AI spend cap R2,500 a month', 'Priority support'])],
            ['code' => 'growth', 'name' => 'Growth', 'price' => 2499, 'included_credit' => 1700, 'discount_pct' => 10, 'ai_monthly_cap' => 8000, 'ai_max_tokens' => 8192, 'ai_rpm' => 120, 'api_rps' => 50, 'desk_agents' => 15, 'wa_numbers' => 5, 'sort' => 4, 'active' => 1,
                'features' => $f(['R1,700 usage credit every month', '10% off all usage', 'Desk with 15 agents', 'AI spend cap R8,000 a month', 'Onboarding help'])],
            ['code' => 'enterprise', 'name' => 'Enterprise', 'price' => 7500, 'included_credit' => 5500, 'discount_pct' => 15, 'ai_monthly_cap' => 30000, 'ai_max_tokens' => 16000, 'ai_rpm' => 300, 'api_rps' => 100, 'desk_agents' => 50, 'wa_numbers' => 20, 'sort' => 5, 'active' => 1,
                'features' => $f(['R5,500 usage credit every month', '15% off all usage', 'Desk with 50 agents', 'Contracted service levels', 'Named account manager'])],
        ];
    }

    /**
     * Prepaid packages per service. Price is what the customer pays; credit is what lands in their one balance.
     * Larger packages carry bonus credit, which is how volume discounts work on a shared wallet.
     */
    public static function packages(): array
    {
        $p = fn($code, $service, $name, $description, $price, $credit, $sort) => compact('code', 'service', 'name', 'description', 'price', 'credit', 'sort') + ['active' => 1];
        return [
            $p('sms_1k', 'sms', 'SMS 1,000', 'About 1,000 single-part SMS at R0.29', 290, 290, 1),
            $p('sms_10k', 'sms', 'SMS 10,000', 'R2,900 of credit for R2,700 (R0.27 an SMS)', 2700, 2900, 2),
            $p('sms_50k', 'sms', 'SMS 50,000', 'R14,500 of credit for R12,750 (R0.255 an SMS)', 12750, 14500, 3),
            $p('mail_10k', 'mail', 'Email 10,000', 'About 10,000 emails at R0.015', 150, 150, 1),
            $p('mail_100k', 'mail', 'Email 100,000', 'R1,500 of credit for R1,300', 1300, 1500, 2),
            $p('otp_1k', 'auth', 'OTP 1,000', 'About 1,000 SMS one-time passwords', 350, 350, 1),
            $p('otp_10k', 'auth', 'OTP 10,000', 'R3,500 of credit for R3,250', 3250, 3500, 2),
            $p('wa_500', 'whatsapp', 'WhatsApp R500', 'Credit for templates and replies', 500, 500, 1),
            $p('wa_2500', 'whatsapp', 'WhatsApp R2,500', 'R2,500 of credit for R2,375', 2375, 2500, 2),
            $p('verify_100', 'verify', '100 ID checks', 'About 100 SA ID number checks', 950, 950, 1),
            $p('verify_500', 'verify', '500 ID checks', 'R4,750 of credit for R4,500', 4500, 4750, 2),
            $p('voice_500', 'voice', 'Voice 500 minutes', 'About 500 call minutes to SA numbers', 445, 445, 1),
            $p('ai_500', 'ai', 'AI R500', 'Credit for Claude and GPT usage', 500, 500, 1),
            $p('ai_2500', 'ai', 'AI R2,500', 'R2,500 of credit for R2,375', 2375, 2500, 2),
            $p('qr_10', 'qr', '10 QR codes', 'R200 of credit for R180 (R18 a code)', 180, 200, 1),
            $p('qr_50', 'qr', '50 QR codes', 'R1,000 of credit for R850 (R17 a code)', 850, 1000, 2),
            $p('store_1k', 'stores', 'Store SMS 1,000', 'About 1,000 order SMS at R0.50', 500, 500, 1),
            $p('store_5k', 'stores', 'Store SMS 5,000', 'R2,500 of credit for R2,250 (R0.45 an SMS)', 2250, 2500, 2),
        ];
    }

    /** Selling price and estimated wholesale cost in ZAR, excl. VAT. Costs must be confirmed against partner contracts. */
    public static function rates(): array
    {
        $r = fn($unit, $service, $label, $price, $cost, $per) => compact('unit', 'service', 'label', 'price', 'cost', 'per');
        return [
            $r('sms', 'sms', 'SMS to South African numbers', 0.29, 0.19, 'per segment'),
            $r('email', 'mail', 'Email', 0.015, 0.002, 'per email'),
            $r('otp_sms', 'auth', 'OTP by SMS', 0.35, 0.19, 'per code sent'),
            $r('otp_email', 'auth', 'OTP by email', 0.05, 0.002, 'per code sent'),
            $r('otp_whatsapp', 'auth', 'OTP by WhatsApp', 0.30, 0.15, 'per code sent'),
            $r('otp_voice', 'auth', 'OTP by voice call', 0.75, 0.40, 'per code sent'),
            $r('wa_marketing', 'whatsapp', 'WhatsApp marketing template', 0.95, 0.72, 'per message'),
            $r('wa_utility', 'whatsapp', 'WhatsApp utility template', 0.25, 0.15, 'per message'),
            $r('wa_authentication', 'whatsapp', 'WhatsApp authentication template', 0.25, 0.15, 'per message'),
            $r('wa_service', 'whatsapp', 'WhatsApp reply inside the 24-hour window', 0.02, 0.00, 'per message'),
            $r('wa_number', 'whatsapp', 'WhatsApp number', 890, 650, 'per month'),
            $r('verify_id', 'verify', 'SA ID number check', 9.50, 4.00, 'per check'),
            $r('verify_id_photo', 'verify', 'ID check with photo match', 24.00, 12.00, 'per check'),
            $r('verify_pep', 'verify', 'PEP and sanctions screening', 7.50, 3.00, 'per check'),
            $r('verify_business', 'verify', 'Company (CIPC) check', 16.00, 7.00, 'per check'),
            $r('verify_bank', 'verify', 'Bank account verification', 6.50, 2.50, 'per check'),
            $r('voice_minute', 'voice', 'Voice call to SA numbers', 0.89, 0.45, 'per started minute'),
            $r('qr_code', 'qr', 'QR code', 20.00, 0.00, 'per code'),
            $r('store_sms', 'stores', 'Store SMS (Shopify, WooCommerce and more)', 0.50, 0.19, 'per SMS'),
        ];
    }

    /** AI models offered through SeaGeek AI. Prices are the provider's USD list price per million tokens. */
    public static function aiModels(): array
    {
        $json = Settings::get('ai_models_json');
        if ($json !== '') {
            $m = json_decode($json, true);
            if (is_array($m) && $m) return $m;
        }
        return [
            ['provider' => 'anthropic', 'model' => 'claude-opus-5-5', 'label' => 'Claude Opus 5.5', 'in' => 4.00, 'out' => 20.00],
            ['provider' => 'anthropic', 'model' => 'claude-sonnet-5-5', 'label' => 'Claude Sonnet 5.5', 'in' => 2.00, 'out' => 10.00],
            ['provider' => 'anthropic', 'model' => 'claude-haiku-5-5', 'label' => 'Claude Haiku 5.5', 'in' => 0.10, 'out' => 0.50],
            ['provider' => 'openai', 'model' => 'gpt-5', 'label' => 'GPT-5', 'in' => 1.25, 'out' => 10.00],
            ['provider' => 'openai', 'model' => 'gpt-5-mini', 'label' => 'GPT-5 mini', 'in' => 0.25, 'out' => 2.00],
        ];
    }

    public static function aiModel(string $provider, string $model): ?array
    {
        foreach (self::aiModels() as $m) if ($m['provider'] === $provider && $m['model'] === $model) return $m;
        return null;
    }

    /** ZAR price per million tokens after exchange rate and markup. */
    public static function aiPrice(array $m): array
    {
        $fx = (float) Settings::get('usd_zar');
        $mk = 1 + ((float) Settings::get('ai_markup_pct')) / 100;
        return ['in' => round($m['in'] * $fx * $mk, 2), 'out' => round($m['out'] * $fx * $mk, 2), 'cost_in' => $m['in'] * $fx, 'cost_out' => $m['out'] * $fx];
    }

    public static function partnerSeeds(): array
    {
        $tpl = fn(string $note) => Crypto::encrypt(json_encode(['url' => '', 'method' => 'POST', 'headers' => "Authorization: Bearer {{secret}}\nContent-Type: application/json", 'secret' => '', 'body' => '', 'id_path' => 'id', 'note' => $note]));
        return [
            ['name' => 'SMSMessenger', 'service' => 'sms', 'driver' => 'http', 'priority' => 1, 'config_enc' => $tpl('Fill in from the SMSMessenger API documentation in your account.')],
            ['name' => 'Iwin / Zephyr', 'service' => 'sms', 'driver' => 'http', 'priority' => 2, 'config_enc' => $tpl('Fill in from the Iwin / Zephyr SMS API documentation.')],
            ['name' => '360dialog', 'service' => 'whatsapp', 'driver' => 'd360', 'priority' => 1, 'config_enc' => Crypto::encrypt(json_encode(['base_url' => 'https://waba-v2.360dialog.io', 'partner_note' => 'Each WhatsApp number has its own channel API key, set on the number.']))],
            ['name' => 'ChatReach', 'service' => 'whatsapp', 'driver' => 'http', 'priority' => 2, 'config_enc' => $tpl('Fill in from the ChatReach API documentation.')],
            ['name' => 'Teruza', 'service' => 'verify', 'driver' => 'http', 'priority' => 1, 'config_enc' => $tpl('Fill in from the Teruza API documentation.')],
            ['name' => 'VerifyNow', 'service' => 'verify', 'driver' => 'http', 'priority' => 2, 'config_enc' => $tpl('Fill in from the VerifyNow API documentation.')],
            ['name' => 'Amazon SES', 'service' => 'mail', 'driver' => 'ses', 'priority' => 1, 'config_enc' => Crypto::encrypt(json_encode(['region' => 'af-south-1', 'access_key' => '', 'secret_key' => '']))],
            ['name' => 'Anthropic', 'service' => 'ai', 'driver' => 'anthropic', 'priority' => 1, 'config_enc' => Crypto::encrypt(json_encode(['api_key' => '']))],
            ['name' => 'OpenAI', 'service' => 'ai', 'driver' => 'openai', 'priority' => 2, 'config_enc' => Crypto::encrypt(json_encode(['api_key' => '', 'base_url' => 'https://api.openai.com/v1']))],
            ['name' => 'Zephyr Voice', 'service' => 'voice', 'driver' => 'http', 'priority' => 1, 'config_enc' => $tpl('Fill in from the Zephyr voice API documentation.')],
            ['name' => 'Cloud Telecoms', 'service' => 'voice', 'driver' => 'http', 'priority' => 2, 'config_enc' => $tpl('Fill in from the Cloud Telecoms API documentation.')],
        ];
    }

    // -------------------------------------------------------------------
    // API documentation
    // -------------------------------------------------------------------

    /**
     * Products with their status for this installation: a product whose partners are not set up
     * yet shows as "soon" (Coming soon) everywhere until an admin switches it on.
     */
    public static function services(): array
    {
        static $cache = null;
        if ($cache !== null) return $cache;
        $all = self::baseServices();
        try {
            foreach ($all as $k => &$s) if (in_array($s['status'], ['live', 'beta'], true) && !Services::enabled($k)) $s['status'] = 'soon';
            unset($s);
            return $cache = $all;
        } catch (Throwable) {
            return $all; // before installation there is no database to ask
        }
    }

    public static function statusLabel(string $status): ?string
    {
        return ['beta' => 'Beta', 'soon' => 'Coming soon', 'planned' => 'Planned'][$status] ?? null;
    }

    public static function baseServices(): array
    {
        $p = fn($name, $type, $req, $desc) => compact('name', 'type', 'req', 'desc');
        return [
            'sms' => [
                'name' => 'SMS', 'icon' => 'sms', 'status' => 'live', 'units' => ['sms'],
                'summary' => 'Send bulk, transactional and scheduled SMS to South African numbers, with delivery receipts.',
                'intro' => 'Messages longer than 160 GSM-7 characters (or 70 characters if they contain emoji or other Unicode) are split into segments. You are charged per segment per recipient. Use an approved sender ID for live traffic; until it is approved, messages go out from a shared short code.',
                'endpoints' => [
                    ['POST', '/v1/sms/messages', 'Send a message', 'Send one message to up to 1,000 recipients. Each recipient gets its own message ID.',
                        [$p('to', 'string | string[]', true, 'Recipient number in international format, e.g. +27821234567. Up to 1,000.'),
                         $p('body', 'string', true, 'Message text. Up to 1,530 characters (10 segments).'),
                         $p('from', 'string', false, 'Approved sender ID, up to 11 characters.'),
                         $p('reference', 'string', false, 'Your own reference, returned in webhooks. Up to 120 characters.'),
                         $p('schedule_at', 'string', false, 'ISO 8601 time to send, up to 30 days ahead.')],
                        ['to' => '+27821234567', 'body' => 'Your order #10294 has shipped.', 'reference' => 'order-10294'],
                        ['data' => [['id' => 'msg_8Kq2vXr1Pz', 'to' => '+27821234567', 'status' => 'queued', 'segments' => 1, 'amount' => 0.29]], 'total_amount' => 0.29, 'currency' => 'ZAR']],
                    ['GET', '/v1/sms/messages/{id}', 'Get a message', 'Current status of one message.', [], null,
                        ['id' => 'msg_8Kq2vXr1Pz', 'service' => 'sms', 'status' => 'delivered', 'to' => '+27821234567', 'amount' => 0.29, 'created_at' => '2027-03-02T09:14:11Z']],
                ],
                'events' => ['message.delivered', 'message.failed'],
                'sandbox' => 'Numbers ending in 0000 fail with "undeliverable". All other numbers move to delivered after a few seconds. Nothing is sent and nothing is charged.',
            ],
            'mail' => [
                'name' => 'Mail', 'icon' => 'mail', 'status' => 'live', 'units' => ['email'],
                'summary' => 'Transactional and bulk email with HTML, plain-text fallback, bounces and delivery events.',
                'intro' => 'Messages are sent from your verified domain. Until your domain is verified (SPF and DKIM records added from the dashboard), mail is sent from mail.seageek.co.za on your behalf with your name and reply-to address.',
                'endpoints' => [
                    ['POST', '/v1/mail/messages', 'Send an email', 'Send to up to 50 recipients per request.',
                        [$p('to', 'string[]', true, 'Recipient addresses, up to 50.'),
                         $p('subject', 'string', true, 'Subject line.'),
                         $p('html', 'string', false, 'HTML body. Either html or text is required.'),
                         $p('text', 'string', false, 'Plain-text body.'),
                         $p('from_name', 'string', false, 'Display name. Defaults to your organisation name.'),
                         $p('from_email', 'string', false, 'Address on your verified domain.'),
                         $p('reply_to', 'string', false, 'Reply-to address.'),
                         $p('reference', 'string', false, 'Your own reference.')],
                        ['to' => ['thandi@example.co.za'], 'subject' => 'Your invoice', 'html' => '<p>Hi Thandi, your invoice is attached.</p>', 'from_name' => 'Acme Stores'],
                        ['data' => [['id' => 'msg_3Lm9TqP0aa', 'to' => 'thandi@example.co.za', 'status' => 'queued', 'amount' => 0.015]], 'total_amount' => 0.015, 'currency' => 'ZAR']],
                    ['GET', '/v1/mail/messages/{id}', 'Get an email', 'Current status of one email.', [], null,
                        ['id' => 'msg_3Lm9TqP0aa', 'service' => 'mail', 'status' => 'sent', 'to' => 'thandi@example.co.za', 'amount' => 0.015]],
                ],
                'events' => ['message.delivered', 'message.failed'],
                'sandbox' => 'Addresses at bounce.test fail; others are marked sent. No email leaves the platform.',
            ],
            'auth' => [
                'name' => 'Auth', 'icon' => 'auth', 'status' => 'live', 'units' => ['otp_sms', 'otp_email', 'otp_whatsapp', 'otp_voice'],
                'summary' => 'One-time passwords over SMS, email, WhatsApp or voice, with expiry, attempt limits and fraud protection built in.',
                'intro' => 'Start a verification, let SeaGeek generate and deliver the code, then check what the user typed. Codes are stored hashed, expire after 10 minutes by default and lock after 5 wrong attempts. You never handle the code yourself.',
                'endpoints' => [
                    ['POST', '/v1/auth/otp', 'Send a code', 'Generates a code and sends it on the chosen channel.',
                        [$p('to', 'string', true, 'Phone number (+27...) or email address.'),
                         $p('channel', 'string', true, 'sms, email, whatsapp or voice.'),
                         $p('length', 'integer', false, '4 to 8 digits. Default 6.'),
                         $p('ttl', 'integer', false, 'Seconds the code is valid, 60 to 1800. Default 600.'),
                         $p('brand', 'string', false, 'Name shown in the message, e.g. "Acme". Defaults to your organisation name.')],
                        ['to' => '+27821234567', 'channel' => 'sms', 'brand' => 'Acme'],
                        ['id' => 'otp_Vb7Kp2Wq9e', 'status' => 'pending', 'channel' => 'sms', 'expires_at' => '2027-03-02T09:24:11Z', 'amount' => 0.35]],
                    ['POST', '/v1/auth/otp/{id}/check', 'Check a code', 'Returns valid: true once. Further checks of the same code return already_used.',
                        [$p('code', 'string', true, 'The code the user entered.')],
                        ['code' => '482913'],
                        ['id' => 'otp_Vb7Kp2Wq9e', 'valid' => true, 'status' => 'approved']],
                ],
                'events' => [],
                'sandbox' => 'The code is always 000000 and is returned in the response as sandbox_code. Nothing is sent.',
            ],
            'whatsapp' => [
                'name' => 'WhatsApp', 'icon' => 'whatsapp', 'status' => 'live', 'units' => ['wa_marketing', 'wa_utility', 'wa_authentication', 'wa_service', 'wa_number'],
                'summary' => 'WhatsApp Business Platform messaging: approved templates, free-form replies inside the 24-hour window, and inbound messages to your webhook.',
                'intro' => 'Each organisation connects its own WhatsApp number from the dashboard (WhatsApp section). Once Meta approves the number, send templates to start conversations and free-form messages to reply within 24 hours of the customer\'s last message. Inbound messages are forwarded to your webhook and appear in Desk.',
                'endpoints' => [
                    ['POST', '/v1/whatsapp/messages', 'Send a message', 'Send a template or a text reply.',
                        [$p('to', 'string', true, 'Recipient number, e.g. +27821234567.'),
                         $p('type', 'string', true, 'template or text.'),
                         $p('template', 'object', false, 'Required for type=template: name, language (e.g. en), components (Meta format).'),
                         $p('category', 'string', false, 'Required for type=template: marketing, utility or authentication. Must match the category Meta approved.'),
                         $p('text', 'string', false, 'Required for type=text. Only allowed inside the 24-hour customer service window.'),
                         $p('number_id', 'integer', false, 'Which of your WhatsApp numbers to send from. Defaults to your first active number.'),
                         $p('reference', 'string', false, 'Your own reference.')],
                        ['to' => '+27821234567', 'type' => 'template', 'category' => 'utility', 'template' => ['name' => 'order_update', 'language' => 'en', 'components' => [['type' => 'body', 'parameters' => [['type' => 'text', 'text' => '10294']]]]]],
                        ['id' => 'msg_Wn4Rk8Yt2s', 'status' => 'queued', 'amount' => 0.25, 'currency' => 'ZAR']],
                    ['GET', '/v1/whatsapp/messages/{id}', 'Get a message', 'Current status: queued, sent, delivered, read or failed.', [], null,
                        ['id' => 'msg_Wn4Rk8Yt2s', 'service' => 'whatsapp', 'status' => 'read', 'to' => '+27821234567']],
                    ['GET', '/v1/whatsapp/numbers', 'List your numbers', 'Your WhatsApp numbers and their approval status.', [], null,
                        ['data' => [['id' => 7, 'phone' => '+27105550123', 'display_name' => 'Acme Stores', 'status' => 'active']]]],
                ],
                'events' => ['message.delivered', 'message.read', 'message.failed', 'whatsapp.inbound'],
                'sandbox' => 'Messages are simulated and move through sent, delivered and read. Send a text to +27000000001 to receive a simulated inbound reply on your webhook.',
            ],
            'verify' => [
                'name' => 'Verify', 'icon' => 'verify', 'status' => 'live', 'units' => ['verify_id', 'verify_id_photo', 'verify_pep', 'verify_business', 'verify_bank'],
                'summary' => 'KYC and KYB checks: SA ID numbers, photo match, PEP and sanctions screening, CIPC company lookups and bank account verification.',
                'intro' => 'Live checks need an approved business verification (KYB) on your account and a lawful reason to process the person\'s information under POPIA. SA ID numbers are validated locally (date of birth and checksum) before any paid lookup, so typos are rejected free of charge.',
                'endpoints' => [
                    ['POST', '/v1/verify/checks', 'Run a check', 'Runs one check and returns the result. Most checks complete in under 5 seconds.',
                        [$p('type', 'string', true, 'id, id_photo, pep, business or bank.'),
                         $p('id_number', 'string', false, 'SA ID number. Required for id, id_photo and pep.'),
                         $p('first_name', 'string', false, 'Required for pep. Improves id matching.'),
                         $p('last_name', 'string', false, 'Required for pep. Improves id matching.'),
                         $p('selfie', 'string', false, 'Base64 JPEG. Required for id_photo.'),
                         $p('company_reg', 'string', false, 'CIPC number, e.g. 2027/123456/07. Required for business.'),
                         $p('account_number', 'string', false, 'Required for bank, with branch_code and id_number.'),
                         $p('branch_code', 'string', false, 'Universal branch code. Required for bank.'),
                         $p('reference', 'string', false, 'Your own reference.')],
                        ['type' => 'id', 'id_number' => '9001015009086', 'first_name' => 'Thandi', 'last_name' => 'Nkosi'],
                        ['id' => 'chk_Hy6Pd3Qa1m', 'type' => 'id', 'status' => 'completed', 'result' => ['match' => true, 'deceased' => false, 'date_of_birth' => '1990-01-01', 'gender' => 'male', 'citizen' => true], 'amount' => 9.50]],
                    ['GET', '/v1/verify/checks/{id}', 'Get a check', 'Result of an earlier check. Results are kept for 90 days.', [], null,
                        ['id' => 'chk_Hy6Pd3Qa1m', 'service' => 'verify', 'status' => 'completed']],
                ],
                'events' => ['verify.completed'],
                'sandbox' => 'Any valid SA ID number returns a match. ID numbers starting with 00 return match: false. PEP checks for the last name "Testpep" return a hit.',
            ],
            'ai' => [
                'name' => 'AI', 'icon' => 'ai', 'status' => 'live', 'units' => [],
                'summary' => 'Anthropic Claude and OpenAI models through one API, billed in rand, with spending limits you control, plus hosted AI agents with human handover.',
                'intro' => 'Choose the provider and model per request. Usage is metered per token at the provider\'s price converted to rand plus a service fee. Every account has a monthly AI spending cap (set by your plan, and you can lower it), a maximum response length and a requests-per-minute limit, so a bug in your code can\'t run up a large bill.',
                'endpoints' => [
                    ['POST', '/v1/ai/chat', 'Create a response', 'Send a conversation and get the model\'s reply.',
                        [$p('provider', 'string', true, 'anthropic or openai.'),
                         $p('model', 'string', true, 'A model from GET /v1/ai/models.'),
                         $p('messages', 'object[]', true, 'Conversation so far: [{role: "user" | "assistant", content: "..."}].'),
                         $p('system', 'string', false, 'Instructions for the model.'),
                         $p('max_tokens', 'integer', false, 'Longest reply allowed. Capped by your plan.')],
                        ['provider' => 'anthropic', 'model' => 'claude-opus-5-5', 'system' => 'You answer questions about our store.', 'messages' => [['role' => 'user', 'content' => 'Do you deliver to Polokwane?']]],
                        ['id' => 'ai_Qz2Lr7Bn5k', 'provider' => 'anthropic', 'model' => 'claude-opus-5-5', 'content' => 'Yes, we deliver to Polokwane in 2 to 4 working days.', 'usage' => ['input_tokens' => 38, 'output_tokens' => 21], 'amount' => 0.0129, 'limits' => ['month_spent' => 41.20, 'month_cap' => 2500]]],
                    ['GET', '/v1/ai/models', 'List models', 'Models you can use and their price per million tokens in rand.', [], null,
                        ['data' => [['provider' => 'anthropic', 'model' => 'claude-opus-5-5', 'price_per_million' => ['input' => 103.60, 'output' => 518.00]]]]],
                    ['POST', '/v1/ai/agents/{id}/messages', 'Talk to an AI agent', 'Agents are created in the dashboard with your instructions and knowledge. The agent answers from what you gave it and hands over to a person when it should.',
                        [$p('message', 'string', true, 'The customer\'s message.'),
                         $p('conversation_id', 'string', false, 'Continue an existing conversation. Omit to start a new one.'),
                         $p('customer', 'object', false, 'name, email and phone, used if the conversation is handed over.')],
                        ['message' => 'I was charged twice for my order', 'customer' => ['name' => 'Thandi', 'email' => 'thandi@example.co.za']],
                        ['conversation_id' => 'tkt_9f2Kx', 'reply' => 'I\'m sorry about that. I\'ve passed this to our billing team and someone will email you today.', 'handover' => true, 'ticket' => 1042]],
                ],
                'events' => ['desk.handover'],
                'sandbox' => 'Sandbox keys return a fixed reply and are not charged, so you can build without spending money.',
            ],
            'voice' => [
                'name' => 'Voice', 'icon' => 'voice', 'status' => 'beta', 'units' => ['voice_minute'],
                'summary' => 'Outbound text-to-speech calls for notifications and voice OTP to South African numbers.',
                'intro' => 'Calls are billed per started minute once answered. Unanswered calls are free.',
                'endpoints' => [
                    ['POST', '/v1/voice/calls', 'Place a call', 'Calls the number and reads the message aloud.',
                        [$p('to', 'string', true, 'Recipient number.'),
                         $p('text', 'string', true, 'What to say. Up to 1,000 characters.'),
                         $p('language', 'string', false, 'en-ZA (default), af-ZA or zu-ZA where supported by the route.'),
                         $p('repeat', 'integer', false, 'Times to repeat the message, 1 to 3. Default 2.'),
                         $p('reference', 'string', false, 'Your own reference.')],
                        ['to' => '+27821234567', 'text' => 'Your delivery will arrive between 2 and 4 pm today.'],
                        ['id' => 'msg_Cv1Np5Ds8h', 'status' => 'queued', 'amount' => 0.89]],
                    ['GET', '/v1/voice/calls/{id}', 'Get a call', 'Call status and duration.', [], null,
                        ['id' => 'msg_Cv1Np5Ds8h', 'service' => 'voice', 'status' => 'completed', 'meta' => ['duration_seconds' => 23]]],
                ],
                'events' => ['message.delivered', 'message.failed'],
                'sandbox' => 'Calls are simulated and complete after a few seconds with a 20-second duration.',
            ],
            'desk' => [
                'name' => 'Desk', 'icon' => 'desk', 'status' => 'live', 'units' => [],
                'summary' => 'Customer service in one inbox: tickets from your website, email, WhatsApp and AI agent handovers, plus a public help centre.',
                'intro' => 'Desk is included in every plan (agent seats depend on the plan). Use these endpoints to create tickets from your own systems and keep them in sync.',
                'endpoints' => [
                    ['POST', '/v1/desk/tickets', 'Create a ticket', 'Opens a ticket in your Desk inbox and emails the requester a confirmation.',
                        [$p('subject', 'string', true, 'Short summary.'),
                         $p('body', 'string', true, 'The customer\'s message.'),
                         $p('requester', 'object', true, 'name and email; phone optional.'),
                         $p('priority', 'string', false, 'low, normal, high or urgent. Default normal.'),
                         $p('tags', 'string[]', false, 'Labels for routing and reporting.')],
                        ['subject' => 'Refund request', 'body' => 'Order 10294 arrived damaged.', 'requester' => ['name' => 'Thandi', 'email' => 'thandi@example.co.za'], 'priority' => 'high'],
                        ['id' => 1042, 'status' => 'new', 'url' => 'https://www.seageek.co.za/t/Kp3...']],
                    ['GET', '/v1/desk/tickets', 'List tickets', 'Newest first. Filter with ?status=open.', [], null,
                        ['data' => [['id' => 1042, 'subject' => 'Refund request', 'status' => 'open', 'priority' => 'high']]]],
                    ['POST', '/v1/desk/tickets/{id}/replies', 'Add a reply', 'Adds a public reply (emailed to the requester) or an internal note.',
                        [$p('body', 'string', true, 'Reply text.'), $p('internal', 'boolean', false, 'true for an internal note.'), $p('status', 'string', false, 'Set status: open, pending or solved.')],
                        ['body' => 'We have sent a replacement.', 'status' => 'solved'],
                        ['id' => 1042, 'status' => 'solved']],
                ],
                'events' => ['desk.ticket_created', 'desk.handover'],
                'sandbox' => 'Sandbox tickets are created in your inbox with a "sandbox" tag and no email is sent.',
            ],
            'qr' => [
                'name' => 'QR Codes', 'icon' => 'qr', 'status' => 'live', 'units' => ['qr_code'],
                'summary' => 'Paste a link, get a QR code for print, packaging and signage. Change where it points later and see how often it is scanned.',
                'intro' => 'Each code costs R20 once, charged from your credit when it is created. Dynamic codes point to a short seageek.co.za link, so you can change the destination without reprinting and every scan is counted. Static codes hold the link itself and can never change.',
                'endpoints' => [
                    ['POST', '/v1/qr/codes', 'Create a QR code', 'Creates the code and returns links to PNG and SVG images you can download or embed.',
                        [$p('url', 'string', true, 'Where the code should send people. Must start with https:// or http://.'),
                         $p('name', 'string', false, 'Your label, e.g. "Menu table cards".'),
                         $p('dynamic', 'boolean', false, 'true (default) for an editable short link with scan counts; false to encode the URL itself.'),
                         $p('color', 'string', false, 'Dark colour as a hex value. Default #0b1f27. Keep it dark on a light background so phones can read it.'),
                         $p('reference', 'string', false, 'Your own reference.')],
                        ['url' => 'https://kasibites.co.za/menu', 'name' => 'Table cards', 'dynamic' => true],
                        ['id' => 'qr_7Hc2Lp9Wd4', 'name' => 'Table cards', 'url' => 'https://kasibites.co.za/menu', 'short_url' => 'https://www.seageek.co.za/q/K7d2Pq', 'dynamic' => true, 'scans' => 0, 'amount' => 20, 'currency' => 'ZAR', 'image_png' => 'https://www.seageek.co.za/qr/i/K7d2Pq.png?s=...', 'image_svg' => 'https://www.seageek.co.za/qr/i/K7d2Pq.svg?s=...']],
                    ['GET', '/v1/qr/codes', 'List QR codes', 'Newest first, up to 100.', [], null,
                        ['data' => [['id' => 'qr_7Hc2Lp9Wd4', 'name' => 'Table cards', 'scans' => 412, 'status' => 'active']]]],
                    ['GET', '/v1/qr/codes/{id}', 'Get a QR code', 'The code, its destination and scan count.', [], null,
                        ['id' => 'qr_7Hc2Lp9Wd4', 'url' => 'https://kasibites.co.za/menu', 'scans' => 412, 'last_scan_at' => '2026-11-18T19:02:11+00:00']],
                    ['POST', '/v1/qr/codes/{id}', 'Update a QR code', 'Change the destination of a dynamic code, rename it, or pause it. Free.',
                        [$p('url', 'string', false, 'New destination (dynamic codes only).'), $p('name', 'string', false, 'New label.'), $p('status', 'string', false, 'active or paused. Paused codes show a short notice instead of redirecting.')],
                        ['url' => 'https://kasibites.co.za/summer-menu'],
                        ['id' => 'qr_7Hc2Lp9Wd4', 'url' => 'https://kasibites.co.za/summer-menu', 'status' => 'active']],
                ],
                'events' => [],
                'sandbox' => 'Sandbox codes work and redirect like live ones but are free and say "sandbox" in their name. Use them to test your print workflow.',
            ],
            'stores' => [
                'name' => 'Store SMS', 'icon' => 'store', 'status' => 'live', 'units' => ['store_sms'],
                'summary' => 'Order updates by SMS for Shopify, WooCommerce and any online store, with no code. Connect your store and pick which messages to send.',
                'intro' => 'You connect a store once by pasting a SeaGeek link into your store settings. From then on your customers get an SMS when they order, when payment clears, when the parcel ships and if they leave items in their cart. Each SMS costs R0.50. Customers who agree to marketing are added to a contact list you can send campaigns to.',
                'endpoints' => [
                    ['POST', '/hooks/store/{token}', 'Send a store event (any platform)', 'For platforms other than Shopify and WooCommerce. Your store calls this link when something happens to an order. The link is shown when you connect the store and already identifies your account, so no API key is needed. Sign the body with your store secret if your platform can.',
                        [$p('event', 'string', true, 'order.created, order.paid, order.shipped, order.cancelled, order.refunded or checkout.abandoned.'),
                         $p('order', 'object', true, 'number (shown to the customer), total and currency. tracking_url for order.shipped. refund_amount for order.refunded.'),
                         $p('customer', 'object', true, 'first_name and phone. accepts_marketing true adds them to your marketing list.'),
                         $p('checkout_url', 'string', false, 'For checkout.abandoned: where the customer finishes their order.')],
                        ['event' => 'order.shipped', 'order' => ['number' => '1042', 'total' => '899.00', 'currency' => 'ZAR', 'tracking_url' => 'https://track.example.co.za/1042'], 'customer' => ['first_name' => 'Thandi', 'phone' => '0821234567', 'accepts_marketing' => true]],
                        ['received' => true, 'status' => 'sent', 'message_id' => 'msg_2Rf7Kd1Lm9']],
                ],
                'events' => [],
                'sandbox' => 'Use "Send a test order" on the store page. It runs your templates against a sample order and shows the SMS without sending or charging.',
            ],
            'notify' => [
                'name' => 'Notify', 'icon' => 'notify', 'status' => 'planned', 'units' => [],
                'summary' => 'Web and mobile push notifications with fallback to SMS or email. Planned for 2028.',
                'intro' => 'Notify is not available yet. Register interest from the dashboard and we will tell you when it opens.',
                'endpoints' => [], 'events' => [], 'sandbox' => '',
            ],
            'sign' => [
                'name' => 'Sign', 'icon' => 'sign', 'status' => 'planned', 'units' => [],
                'summary' => 'Electronic signatures with identity-checked signers and audit trails. Planned for 2028.',
                'intro' => 'Sign is not available yet. It needs a legal review of the ECT Act requirements for each signing workflow before launch.',
                'endpoints' => [], 'events' => [], 'sandbox' => '',
            ],
        ];
    }

    public static function platformEndpoints(): array
    {
        return [
            ['GET', '/v1/account', 'Your organisation, plan, environment and limits.'],
            ['GET', '/v1/balance', 'Credit balance in rand and this month\'s AI spend.'],
            ['GET', '/v1/usage', 'Usage records. Filters: service, from, to (YYYY-MM-DD), limit (max 500).'],
            ['GET', '/v1/messages/{id}', 'Any message, call or check by ID.'],
        ];
    }

    public static function helpArticles(): array
    {
        $a = fn($category, $title, $body) => ['category' => $category, 'title' => $title, 'slug' => trim(preg_replace('/[^a-z0-9]+/', '-', strtolower($title)), '-'), 'body' => $body];
        return [
            $a('Getting started', 'Create your account and get API keys', "Register at seageek.co.za/register and confirm your email address. Your sandbox key is created straight away so you can start building.\n\nTo use live keys, complete your company profile and add credit from Billing. Live keys are enabled automatically once your first payment clears."),
            $a('Getting started', 'Sandbox and live environments', "Every account has two environments. Sandbox keys start with sg_test_ and never send real messages or charge your balance. Live keys start with sg_live_ and use real networks.\n\nUse the same code for both: only the key changes."),
            $a('Billing', 'How credit and billing work', "SeaGeek is prepaid. Add credit from Billing by card or Instant EFT through PayFast, or by bank transfer using your account reference.\n\nEach API request is charged from your balance at your plan's rates. Monthly plans include usage credit that is added on each renewal date."),
            $a('Billing', 'What happens if an invoice is not paid', "We email a reminder when an invoice is issued, on its due date and 3 days later. If a plan invoice is still unpaid 7 days after the due date, live API access is paused and the dashboard shows a payment banner.\n\nAccess comes back automatically as soon as payment clears. Sandbox keys keep working the whole time."),
            $a('Billing', 'Low balance alerts', "We email you when your balance drops below your alert level (R50 by default). Change it under Settings."),
            $a('SeaGeek AI', 'AI spending limits', "Every account has a monthly AI spending cap set by its plan. You can set a lower cap under AI. When the cap is reached, AI requests return 429 ai_cap_reached until the next month or until you raise the cap.\n\nThere is also a maximum reply length and a requests-per-minute limit per plan."),
            $a('WhatsApp', 'Connect a WhatsApp number', "Open WhatsApp in the dashboard and add the number you want to use. It must not be active on the WhatsApp app. We register it with Meta through our partner and email you when it is approved, usually within 2 working days."),
            $a('Desk', 'How Desk and the AI agent work together', "Messages from your help centre form, email, WhatsApp and website chat arrive as tickets. If the AI agent is on, it answers first from your help centre articles. When it can't help, or the customer asks for a person, the ticket is handed to your agents with the conversation so far."),
        ];
    }

    public static function macros(): array
    {
        return [
            ['title' => 'Payment received', 'body' => "Thanks, your payment has cleared and your account is active again.", 'set_status' => 'solved'],
            ['title' => 'Need more detail', 'body' => "Thanks for getting in touch. Could you send the message ID (it starts with msg_) and the time you sent it? That lets us trace it with the network.", 'set_status' => 'pending'],
            ['title' => 'Sender ID approved', 'body' => "Your SMS sender ID has been approved and is ready to use on live messages.", 'set_status' => 'solved'],
        ];
    }
}

/** Product names by key, for labels in pages, emails and scheduled jobs. */
function service_names(): array
{
    return array_map(fn($s) => $s['name'], Catalog::services());
}

/** Desk channel names. */
function channel_label(string $c): string
{
    return ['chat' => 'Chat', 'whatsapp' => 'WhatsApp', 'email' => 'Email', 'web' => 'Web form', 'api' => 'API', 'system' => 'System'][$c] ?? ucfirst($c);
}
