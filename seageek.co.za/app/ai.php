<?php
/**
 * SeaGeek AI: Anthropic (official PHP SDK) and OpenAI, spending limits, and the support agent with human handover.
 */
declare(strict_types=1);

use Anthropic\Client as AnthropicClient;

final class AiError extends RuntimeException
{
    public function __construct(public int $status, public string $type, string $message)
    {
        parent::__construct($message);
    }
}

final class Ai
{
    public const HANDOVER_TOOL = 'handover_to_human';

    private static function key(string $provider): string
    {
        $p = DB::one("SELECT * FROM partners WHERE service = 'ai' AND driver = ? AND active = 1 ORDER BY priority LIMIT 1", [$provider]);
        $k = $p ? (string) (Partners::config($p)['api_key'] ?? '') : '';
        return $k !== '' ? $k : Settings::get($provider . '_api_key');
    }

    public static function configured(string $provider): bool
    {
        return self::key($provider) !== '';
    }

    /**
     * One model call. Returns text, token usage and whether the model asked to hand over to a person.
     * @param array<int, array{role:string, content:string}> $messages
     */
    public static function complete(string $provider, string $model, string $system, array $messages, int $maxTokens, bool $allowHandover = false): array
    {
        $key = self::key($provider);
        if ($key === '') throw new AiError(503, 'ai_not_configured', "The $provider provider is not configured.");
        $handoverSchema = ['type' => 'object', 'properties' => ['reason' => ['type' => 'string', 'description' => 'One sentence for the human agent explaining why.']], 'required' => ['reason']];
        $handoverDesc = 'Hand the conversation to a human support agent. Use when the customer asks for a person, is upset, raises a billing dispute, refund, legal or account-security matter, or when the knowledge provided does not answer the question.';

        if ($provider === 'anthropic') {
            $client = new AnthropicClient(apiKey: $key);
            $tools = $allowHandover ? [['name' => self::HANDOVER_TOOL, 'description' => $handoverDesc, 'inputSchema' => $handoverSchema]] : null;
            try {
                $msg = $client->beta->messages->create(
                    maxTokens: $maxTokens,
                    messages: $messages,
                    model: $model,
                    system: $system !== '' ? $system : null,
                    outputConfig: ['effort' => 'low'],
                    tools: $tools,
                    fallbacks: 'default',
                    betas: ['server-side-fallback-2026-07-01'],
                );
            } catch (\Anthropic\Core\Exceptions\RateLimitException $e) {
                throw new AiError(429, 'provider_rate_limited', 'The AI provider is busy. Try again shortly.');
            } catch (\Anthropic\Core\Exceptions\AuthenticationException $e) {
                throw new AiError(503, 'ai_not_configured', 'The AI provider key was rejected.');
            } catch (\Anthropic\Core\Exceptions\BadRequestException $e) {
                throw new AiError(400, 'invalid_request', 'The AI provider rejected the request: ' . mb_substr($e->getMessage(), 0, 200));
            } catch (\Anthropic\Core\Exceptions\APIStatusException $e) {
                throw new AiError(502, 'provider_error', 'The AI provider returned an error.');
            } catch (\Anthropic\Core\Exceptions\APIConnectionException $e) {
                throw new AiError(504, 'provider_unreachable', 'Could not reach the AI provider.');
            }
            $text = '';
            $handover = null;
            foreach ($msg->content as $block) {
                if ($block->type === 'text') $text .= $block->text;
                if ($block->type === 'tool_use' && $block->name === self::HANDOVER_TOOL) {
                    $input = is_array($block->input) ? $block->input : (array) $block->input;
                    $handover = (string) ($input['reason'] ?? 'Customer needs a person');
                }
            }
            if ($msg->stopReason === 'refusal') $handover ??= 'The AI could not help with this request';
            return ['text' => trim($text), 'input_tokens' => (int) $msg->usage->inputTokens, 'output_tokens' => (int) $msg->usage->outputTokens, 'handover' => $handover, 'model' => (string) $msg->model];
        }

        if ($provider === 'openai') {
            $p = DB::one("SELECT * FROM partners WHERE service = 'ai' AND driver = 'openai' LIMIT 1");
            $base = rtrim((string) (($p ? Partners::config($p)['base_url'] ?? '' : '') ?: 'https://api.openai.com/v1'), '/');
            $body = ['model' => $model, 'max_completion_tokens' => $maxTokens, 'messages' => array_merge($system !== '' ? [['role' => 'system', 'content' => $system]] : [], $messages)];
            if ($allowHandover) {
                $body['tools'] = [['type' => 'function', 'function' => ['name' => self::HANDOVER_TOOL, 'description' => $handoverDesc, 'parameters' => $handoverSchema]]];
            }
            $res = Http::request('POST', $base . '/chat/completions', ['Authorization' => 'Bearer ' . $key], $body, 60);
            if ($res['error']) throw new AiError(504, 'provider_unreachable', 'Could not reach the AI provider.');
            if ($res['status'] === 429) throw new AiError(429, 'provider_rate_limited', 'The AI provider is busy. Try again shortly.');
            if ($res['status'] === 401) throw new AiError(503, 'ai_not_configured', 'The AI provider key was rejected.');
            if ($res['status'] !== 200) throw new AiError($res['status'] >= 500 ? 502 : 400, 'provider_error', 'The AI provider returned an error: ' . mb_substr((string) ($res['json']['error']['message'] ?? $res['body']), 0, 200));
            $choice = $res['json']['choices'][0]['message'] ?? [];
            $handover = null;
            foreach ($choice['tool_calls'] ?? [] as $call) {
                if (($call['function']['name'] ?? '') === self::HANDOVER_TOOL) {
                    $handover = (string) (json_decode($call['function']['arguments'] ?? '{}', true)['reason'] ?? 'Customer needs a person');
                }
            }
            return ['text' => trim((string) ($choice['content'] ?? '')), 'input_tokens' => (int) ($res['json']['usage']['prompt_tokens'] ?? 0), 'output_tokens' => (int) ($res['json']['usage']['completion_tokens'] ?? 0), 'handover' => $handover, 'model' => $model];
        }
        throw new AiError(400, 'invalid_provider', 'provider must be anthropic or openai.');
    }

    /**
     * Metered AI call for a customer, enforcing every limit before money is spent:
     * requests per minute, longest reply, monthly spend cap, and available credit.
     */
    public static function meteredChat(array $org, string $env, string $provider, string $model, string $system, array $messages, ?int $maxTokens, bool $allowHandover = false, string $reference = ''): array
    {
        $m = Catalog::aiModel($provider, $model);
        if (!$m) throw new AiError(400, 'invalid_model', 'Unknown model. See GET /v1/ai/models.');
        $plan = Billing::plan($org);
        $cap = $org['ai_max_tokens'] ? min((int) $org['ai_max_tokens'], (int) $plan['ai_max_tokens']) : (int) $plan['ai_max_tokens'];
        $maxTokens = max(16, min($maxTokens ?: $cap, $cap));
        if (rate_limited('ai:' . $org['id'], (int) $plan['ai_rpm'], 60)) {
            throw new AiError(429, 'ai_rate_limited', "Your plan allows {$plan['ai_rpm']} AI requests a minute.");
        }
        $price = Catalog::aiPrice($m);
        $inputChars = mb_strlen($system) + array_sum(array_map(fn($x) => mb_strlen(is_string($x['content']) ? $x['content'] : json_encode($x['content'])), $messages));
        $estimate = (($inputChars / 3) * $price['in'] + $maxTokens * $price['out']) / 1_000_000;

        if ($env === 'test') {
            $text = $allowHandover && preg_match('/\b(human|person|agent|refund|complain)/i', (string) end($messages)['content'])
                ? "Sandbox reply: I'll pass you to a person." : 'Sandbox reply: this is a simulated response. Use a live key for real model output.';
            return ['id' => public_id('ai'), 'text' => $text, 'input_tokens' => 0, 'output_tokens' => 0, 'amount' => 0.0, 'handover' => str_contains($text, 'person') ? 'Sandbox handover' : null, 'model' => $model, 'spent' => 0.0, 'cap' => Billing::aiCap($org)];
        }

        $capZar = Billing::aiCap($org);
        $spent = Billing::aiSpentThisMonth((int) $org['id']);
        if ($spent + $estimate > $capZar) {
            throw new AiError(429, 'ai_cap_reached', sprintf('This request could take your AI spend past your monthly cap of %s (spent so far %s). Raise the cap in the dashboard or wait until next month.', zar($capZar), zar($spent)));
        }
        if (Billing::available($org) < $estimate) throw new AiError(402, 'insufficient_balance', 'Add credit to use AI.');

        $res = self::complete($provider, $model, $system, $messages, $maxTokens, $allowHandover);
        $amount = round(($res['input_tokens'] * $price['in'] + $res['output_tokens'] * $price['out']) / 1_000_000, 4);
        $cost = round(($res['input_tokens'] * $price['cost_in'] + $res['output_tokens'] * $price['cost_out']) / 1_000_000, 4);
        $id = public_id('ai');
        try {
            Billing::charge((int) $org['id'], $amount, 'usage', $id, "AI $model, {$res['input_tokens']} in / {$res['output_tokens']} out tokens");
        } catch (InsufficientFunds) {
            // The provider already ran; record the debt rather than lose it.
            DB::update('orgs', ['balance' => (float) DB::value('SELECT balance FROM orgs WHERE id = ?', [$org['id']]) - $amount], 'id = ?', [$org['id']]);
        }
        $partner = DB::one("SELECT id FROM partners WHERE service = 'ai' AND driver = ? LIMIT 1", [$provider]);
        DB::insert('messages', [
            'public_id' => $id, 'org_id' => $org['id'], 'env' => $env, 'service' => 'ai', 'unit' => 'ai_tokens',
            'quantity' => $res['input_tokens'] + $res['output_tokens'], 'amount' => $amount, 'cost' => $cost, 'partner_id' => $partner['id'] ?? null,
            'status' => 'completed', 'reference' => mb_substr($reference, 0, 120),
            'meta' => json_encode(['provider' => $provider, 'model' => $model, 'input_tokens' => $res['input_tokens'], 'output_tokens' => $res['output_tokens']]),
            'created_at' => now(), 'updated_at' => now(),
        ]);
        return ['id' => $id] + $res + ['amount' => $amount, 'spent' => $spent + $amount, 'cap' => $capZar];
    }

    /** System prompt for an organisation's support agent, grounded in its help centre articles. */
    public static function agentSystemPrompt(array $org, ?array $agent): string
    {
        $articles = DB::all('SELECT title, body FROM articles WHERE org_id = ? AND published = 1 ORDER BY id LIMIT 40', [$org['id']]);
        $kb = implode("\n\n", array_map(fn($a) => "## {$a['title']}\n{$a['body']}", $articles));
        $isHouse = !empty($org['is_house']);
        $intro = $isHouse
            ? "You are the support assistant for SeaGeek, a South African company selling SMS, email, WhatsApp, identity verification, voice, AI and help desk APIs, billed in rand. Support hours: " . Settings::get('support_hours') . '.'
            : "You are the support assistant for {$org['name']}.";
        $extra = $isHouse ? Settings::get('chat_extra_knowledge') . "\n\n" . self::houseFacts() : '';
        $custom = $agent ? trim((string) $agent['instructions'] . "\n\n" . (string) $agent['knowledge']) : '';
        return trim(<<<TXT
        $intro

        Answer using only the knowledge below. Keep replies short and plain: two to four sentences, no headings, no lists unless the customer asks for steps. Use South African English.
        If the knowledge doesn't cover the question, say you'll pass it to the team and use the handover tool. Never invent prices, dates, features or policies. Never ask for passwords, card numbers or API keys.

        $custom

        # Knowledge
        $kb

        $extra
        TXT);
    }

    private static function houseFacts(): string
    {
        $lines = ['# Plans (monthly, excl. VAT)'];
        foreach (DB::all('SELECT * FROM plans WHERE active = 1 ORDER BY sort') as $p) {
            $lines[] = "- {$p['name']}: " . zar($p['price'], 0) . ' a month, includes ' . zar($p['included_credit'], 0) . " usage credit, {$p['discount_pct']}% off usage, AI cap " . zar($p['ai_monthly_cap'], 0) . '.';
        }
        $lines[] = '# Usage rates (excl. VAT)';
        foreach (DB::all('SELECT * FROM rates ORDER BY service, unit') as $r) $lines[] = "- {$r['label']}: " . zar($r['price'], $r['price'] < 1 ? 3 : 2) . " {$r['per']}";
        return implode("\n", $lines);
    }
}
