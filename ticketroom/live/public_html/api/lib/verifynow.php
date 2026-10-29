<?php
// Electronic organiser checks with VerifyNow (South African KYC/KYB), part of
// organiser verification (lib/verification.php). Set up under Admin portal →
// Integrations → VerifyNow.
//
// What runs, and when:
//   - SA ID number against Home Affairs (always, for SA IDs), sanctions and PEP
//     screening of the person and of a company or NPO, a CIPC company match for
//     registered companies, a bank account check before payouts, and an
//     optional face match. Each shows in the organiser's checklist.
//   - Only after the organiser has given POPIA consent (once per consent text
//     version, stored with the time and the exact text's hash).
//   - Never inside a page request: requests only queue a row in kyc_checks.
//     The "verification-checks" background job (bootstrap.php jobs()) calls
//     VerifyNow, retries with backoff, honours Retry-After, and polls bank jobs
//     when the webhook does not arrive.
//   - Every call carries an Idempotency-Key that stays the same across retries
//     of one check, so a retry after a timeout is replayed free by VerifyNow.
//
// Results are stored per check: status (passed / review / failed / error), plain
// reasons, the provider's reference, the idempotency key and the response with
// images and full ID and account numbers removed. Passed checks approve the
// matching ID document or CIPC certificate automatically; anything else waits
// for TicketRoom staff, who can accept, reject or re-run a check.
//
// The API key is only ever sent in the x-api-key header. It is never logged,
// stored outside integration_settings (encrypted) or shown again.
declare(strict_types=1);

const VN_BASE = 'https://www.verifynow.co.za/api/external';
const VN_CONSENT_VERSION = 'verifynow-consent-1.0';
const VN_CONSENT_TEXT = "To verify who sells tickets on TicketRoom, as FICA requires, we ask VerifyNow (a South African verification service) to check the details you gave us:\n"
    . "- your ID number and name against the Department of Home Affairs;\n"
    . "- your name, and your organisation's name, against sanctions and politically exposed persons (PEP) lists;\n"
    . "- your company's registration with CIPC, if you sell as a company;\n"
    . "- that your payout bank account is open and in your or your organisation's name, before we pay out money;\n"
    . "- if TicketRoom asks for it, a selfie compared with your Home Affairs photo.\n"
    . "We send only what each check needs. VerifyNow processes it for us under POPIA and does not use it for anything else. "
    . "We keep the results with your verification records for as long as FICA requires, then delete them. "
    . "You may refuse, but then TicketRoom staff must check your documents by hand before your events go live, which takes longer. "
    . "You can ask what we hold about you at any time.";
// Check types, the checklist item each one becomes, and the reason we give.
const VN_CHECKS = [
    'said' => ['label' => 'Identity check with Home Affairs', 'reason' => 'FICA: confirms your ID number and name with the Department of Home Affairs.'],
    'aml_person' => ['label' => 'Sanctions and PEP screening', 'reason' => 'FICA: checks the name against sanctions and politically exposed persons lists.'],
    'aml_company' => ['label' => 'Sanctions screening of the organisation', 'reason' => "FICA: checks the organisation's name against sanctions lists."],
    'cipc' => ['label' => 'Company check with CIPC', 'reason' => 'Confirms the company is registered and still in business.'],
    'bank' => ['label' => 'Bank account check', 'reason' => 'Confirms the payout account is open and in your name, so ticket money only goes to you. Needed before any payout.'],
    'face' => ['label' => 'Face match', 'reason' => 'Compares your selfie with your Home Affairs photo.'],
];
const VN_BANK_TYPES = ['current' => 'Current or cheque', 'savings' => 'Savings', 'transmission' => 'Transmission'];
const VN_OPEN = ['queued', 'running', 'waiting'];

// ============================================================== settings
function kyc_vn_on(): bool { return cfg('verifynow.enabled', 'off') === 'on' && (string) cfg('verifynow.apiKey', '') !== ''; }
function kyc_vn_mode(): string { return cfg('verifynow.mode', 'sandbox') === 'production' ? 'production' : 'sandbox'; }
function kyc_vn_base(): string { return rtrim((string) (cfg('verifynow.baseUrl') ?: VN_BASE), '/'); } // baseUrl: config.php only (tests)
function kyc_vn_check_on(string $name): bool
{
    $default = $name === 'checkFace' ? 'off' : 'on';
    return (string) (cfg("verifynow.$name") ?: $default) === 'on';
}
// A production key looks like vn_live_ followed by letters and digits.
function kyc_vn_live_key_ok(string $key): bool { return (bool) preg_match('/^vn_live_[A-Za-z0-9_-]{12,200}$/', $key); }
function kyc_vn_webhook_url(): string { return base_url() . '/api/webhooks/verifynow'; }
function kyc_vn_new_webhook_secret(): string { return rtrim(strtr(base64_encode(random_bytes(36)), '+/', '-_'), '='); }

// ============================================================== what applies
// The checks this organiser needs, with what each unlocks (needFor).
function kyc_vn_types(array $v, bool $paid): array
{
    if (!kyc_vn_on()) return [];
    $events = ['free_events', 'paid_events', 'payouts'];
    $sa = $v['nationality'] === 'sa';
    $out = [];
    if ($sa) $out['said'] = $events;
    if (kyc_vn_check_on('checkAml')) {
        $out['aml_person'] = $events;
        if ($v['entity_type'] !== 'individual') $out['aml_company'] = $events;
    }
    if (kyc_vn_check_on('checkCipc') && $v['entity_type'] === 'company') $out['cipc'] = $events;
    if ($sa && kyc_vn_check_on('checkFace')) $out['face'] = $events;
    if ($paid && kyc_vn_bank_applies($v)) $out['bank'] = ['payouts'];
    return $out;
}
// Bank checks cover SA individuals, companies and NPOs. Foreign nationals keep
// the bank confirmation letter.
function kyc_vn_bank_applies(array $v): bool
{
    return kyc_vn_on() && kyc_vn_check_on('checkBank') && ($v['entity_type'] !== 'individual' || $v['nationality'] === 'sa');
}
function kyc_vn_items(array $v, bool $paid): array
{
    $out = [];
    foreach (kyc_vn_types($v, $paid) as $type => $need) {
        $out[] = ['key' => "vn_$type", 'label' => VN_CHECKS[$type]['label'], 'kind' => 'echeck', 'reason' => VN_CHECKS[$type]['reason'], 'needFor' => $need, 'required' => true, 'checkType' => $type];
    }
    return $out;
}

// ============================================================== consent
function kyc_vn_consent(string $orgId): ?array
{
    return row('SELECT * FROM kyc_consents WHERE organiser_id = ? AND text_version = ? AND withdrawn_at IS NULL ORDER BY created_at DESC LIMIT 1', [$orgId, VN_CONSENT_VERSION]);
}
function kyc_vn_give_consent(string $orgId, array $u, string $name): array
{
    return tx(function () use ($orgId, $u, $name) {
        if ($c = kyc_vn_consent($orgId)) return $c;
        $c = insert('kyc_consents', ['id' => uuid(), 'organiser_id' => $orgId, 'user_id' => $u['id'], 'text_version' => VN_CONSENT_VERSION, 'text_sha256' => hash('sha256', VN_CONSENT_TEXT),
            'full_name' => $name, 'ip' => client_ip(), 'created_at' => now_iso()]);
        audit('verification.consent_given', ['actor' => $u, 'entityType' => 'organiser', 'entityId' => $orgId, 'organiserId' => $orgId, 'ip' => client_ip(), 'details' => ['version' => VN_CONSENT_VERSION]]);
        return $c;
    });
}

// ============================================================== inputs
function kyc_vn_names(array $v): array
{
    $full = trim(preg_replace('/\s+/', ' ', (string) $v['legal_name']));
    $sur = trim((string) ($v['surname'] ?? ''));
    if ($sur !== '' && mb_strtolower(mb_substr($full, -mb_strlen($sur))) === mb_strtolower($sur)) {
        $first = trim(mb_substr($full, 0, mb_strlen($full) - mb_strlen($sur)));
    } elseif ($sur !== '') {
        $first = $full;
    } else {
        $parts = explode(' ', $full);
        $sur = (string) array_pop($parts);
        $first = implode(' ', $parts);
    }
    return [$first !== '' ? $first : $full, $sur];
}
// What one check sends: [path, body, extra headers] or a plain reason why it
// cannot run yet. 'subject' is what decides whether details changed.
function kyc_vn_inputs(string $type, string $orgId, string $mode, bool $full = true): array
{
    $v = kyc_profile($orgId);
    $org = row('SELECT * FROM organisers WHERE id = ?', [$orgId]);
    $id = $v['id_number_enc'] && $v['nationality'] === 'sa' ? decrypt_str((string) $v['id_number_enc']) : null;
    $company = trim((string) ($v['company_name'] ?? '')) ?: (string) $org['name'];
    $missing = fn(string $why) => ['ok' => false, 'missing' => $why];
    $h = [];
    switch ($type) {
        case 'said':
            if (!$id) return $missing('Save your SA ID number under "About you".');
            $path = '/verify'; $body = ['reportType' => 'said_verification', 'idNumber' => $id];
            $subject = [$id, (string) $v['legal_name'], (string) ($v['surname'] ?? '')];
            break;
        case 'aml_person':
            if (!$v['legal_name']) return $missing('Save your full name under "About you".');
            $path = '/aml-screening'; $body = ['name' => (string) $v['legal_name'], 'entity' => 0, 'country' => 'za', 'dataset' => 'all'];
            $subject = $body;
            break;
        case 'aml_company':
            $path = '/aml-screening'; $body = ['name' => $company, 'entity' => 1, 'country' => 'za', 'dataset' => 'all'];
            $subject = $body;
            break;
        case 'cipc':
            if (!$v['registration_number']) return $missing('Save the company registration number under "About you".');
            $path = '/cipc'; $body = ['reportType' => 'cipc_company_match', 'registration_number' => (string) $v['registration_number']];
            $subject = [$body, $company];
            break;
        case 'face':
            if (!$id) return $missing('Save your SA ID number under "About you".');
            $doc = row("SELECT * FROM verification_documents WHERE organiser_id = ? AND event_id IS NULL AND requirement = 'selfie' AND status IN ('submitted','approved') AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1", [$orgId]);
            if (!$doc) return $missing('Upload a selfie under Verification.');
            if (!in_array($doc['mime_type'], ['image/jpeg', 'image/png'], true)) return $missing('Upload the selfie as a JPG or PNG photo.');
            $path = '/facematch';
            $body = ['bundle' => 'facematch', 'id_number' => $id, 'selfie_image_base64' => $full ? base64_encode(kyc_open((string) file_get_contents(kyc_dir() . '/' . $doc['file_name']))) : ''];
            $subject = [$id, $doc['id']];
            break;
        case 'bank':
            if (!$org['bank_account_enc']) return $missing('Add your bank details under Settings.');
            $acc = decrypt_str((string) $org['bank_account_enc']);
            $atype = (string) ($v['bank_account_type'] ?? '');
            if (!isset(VN_BANK_TYPES[$atype])) return $missing('Choose the payout account type under "About you".');
            $bank = ['bankName' => (string) $org['bank_name'], 'bankAccountNumber' => $acc, 'bankBranchCode' => (string) $org['bank_branch_code'], 'bankAccountType' => $atype];
            if ($v['entity_type'] === 'individual') {
                if (!$id) return $missing('Save your SA ID number under "About you".');
                [$first, $sur] = kyc_vn_names($v);
                $path = '/bank-account-verification';
                $body = ['type' => 'Individual', 'firstName' => $first, 'surname' => $sur, 'identityNumber' => $id, 'identityType' => 'IDNumber'] + $bank;
            } else {
                if (!$v['registration_number']) return $missing('Save the registration number under "About you".');
                $secret = (string) cfg('verifynow.webhookSecret', '');
                if (strlen($secret) < 32) return $missing('TicketRoom has not finished setting up VerifyNow. We will run this check once it has.');
                $hook = ['consentConfirmed' => true, 'purpose' => 'Confirm the payout account for ticket sales on TicketRoom', 'webhookUrl' => kyc_vn_webhook_url(), 'webhookSecret' => $secret];
                if ($v['entity_type'] === 'company') {
                    $path = '/business-bank-account-verification';
                    $body = ['companyName' => $company, 'companyRegistrationNumber' => (string) $v['registration_number']] + $bank + $hook;
                } else {
                    $path = '/npo-bank-account-verification';
                    $body = ['companyName' => $company, 'idnumber' => (string) $v['registration_number']] + $bank + $hook;
                }
                // Sandbox scenarios for business bank tests (config.php only, never the portal).
                if ($mode === 'sandbox' && (string) cfg('verifynow.sandboxScenario', '') !== '') $h['x-verifynow-sandbox-scenario'] = (string) cfg('verifynow.sandboxScenario');
            }
            $subject = [$bank, $v['entity_type'], (string) $v['legal_name'], (string) ($v['surname'] ?? ''), $id, $company, (string) $v['registration_number']];
            break;
        default:
            return $missing('Unknown check.');
    }
    $body['mode'] = $mode;
    return ['ok' => true, 'path' => $path, 'body' => $body, 'headers' => $h, 'subject' => hash_hmac('sha256', json_encode([$type, $mode, $subject]), hex2bin(key_hex('data')))];
}

// ============================================================== queue
function kyc_vn_latest(string $orgId, string $type): ?array
{
    return row("SELECT * FROM kyc_checks WHERE organiser_id = ? AND check_type = ? AND status <> 'superseded' ORDER BY created_at DESC, rowid DESC LIMIT 1", [$orgId, $type]);
}
// The checks that should run now: never run, or the details (or mode) changed.
function kyc_vn_due_types(string $orgId): array
{
    if (!kyc_vn_on()) return [];
    $v = kyc_profile($orgId);
    $due = [];
    foreach (array_keys(kyc_vn_types($v, kyc_sells_paid($orgId, $v))) as $type) {
        $in = kyc_vn_inputs($type, $orgId, kyc_vn_mode(), false);
        if (!$in['ok']) continue;
        $last = kyc_vn_latest($orgId, $type);
        if (!$last || $last['subject_hash'] !== $in['subject']) $due[$type] = $in['subject'];
    }
    return $due;
}
function kyc_vn_enqueue(string $orgId, string $type, string $subject, ?string $consentId, ?string $by): array
{
    return tx(function () use ($orgId, $type, $subject, $consentId, $by) {
        $now = now_iso();
        q("UPDATE kyc_checks SET status = 'superseded', updated_at = ? WHERE organiser_id = ? AND check_type = ? AND status <> 'superseded'", [$now, $orgId, $type]);
        $id = uuid();
        insert('kyc_checks', ['id' => $id, 'organiser_id' => $orgId, 'check_type' => $type, 'status' => 'queued', 'mode' => kyc_vn_mode(), 'subject_hash' => $subject,
            'idempotency_key' => 'tr-kyc-' . $id, 'consent_id' => $consentId, 'requested_by' => $by, 'attempts' => 0, 'next_attempt_at' => $now, 'created_at' => $now, 'updated_at' => $now]);
        audit('verification.check_queued', ['actor' => $by ? ['id' => $by] : ['id' => null], 'actorRole' => $by ? null : 'system', 'entityType' => 'kyc_check', 'entityId' => $id, 'organiserId' => $orgId,
            'details' => ['type' => $type, 'mode' => kyc_vn_mode()]]);
        return row('SELECT * FROM kyc_checks WHERE id = ?', [$id]);
    });
}
// Queues whatever is due. $ask: throw 409 consent_required when consent is
// missing (submitting an event, "Run checks now"); otherwise do nothing
// without consent (details saved).
function kyc_vn_start(string $orgId, ?string $userId, bool $ask): array
{
    $due = kyc_vn_due_types($orgId);
    if (!$due) return [];
    $consent = kyc_vn_consent($orgId);
    if (!$consent) {
        if (!$ask) return [];
        $canConsent = $userId && (bool) val("SELECT 1 FROM organiser_members WHERE organiser_id = ? AND user_id = ? AND role = 'owner'", [$orgId, $userId]);
        throw conflict($canConsent ? 'Before we check your details, we need your permission.' : 'An owner of this organisation must first give permission for the identity checks, under Verification.',
            'consent_required', ['consent' => ['version' => VN_CONSENT_VERSION, 'text' => VN_CONSENT_TEXT], 'canConsent' => $canConsent]);
    }
    $out = [];
    foreach ($due as $type => $subject) $out[] = kyc_vn_enqueue($orgId, $type, $subject, $consent['id'], $userId)['id'];
    return $out;
}

// ============================================================== calling VerifyNow
// One request. Returns status, json and Retry-After; throws only when
// VerifyNow could not be reached (timeouts included).
function kyc_vn_call(string $method, string $path, ?array $body, ?string $idemKey, array $extra = []): array
{
    $headers = ['x-api-key' => (string) cfg('verifynow.apiKey', ''), 'Accept' => 'application/json'] + $extra;
    if ($body !== null) $headers['Content-Type'] = 'application/json';
    if ($idemKey !== null) $headers['Idempotency-Key'] = $idemKey;
    $timeout = max(2, (int) cfg('verifynow.timeout', 25));
    $r = http_request($method, kyc_vn_base() . $path, $headers, $body === null ? null : json_encode($body, JSON_UNESCAPED_SLASHES), $timeout, !cfg('verifynow.allowPrivateHosts', false));
    $ra = $r['headers']['retry-after'] ?? null;
    $r['retryAfter'] = $ra === null ? null : (ctype_digit(trim($ra)) ? (int) trim($ra) : max(1, (int) (strtotime($ra) - time())));
    return $r;
}
function kyc_vn_problem_text(int $status, $json): string
{
    $m = is_array($json) ? (string) ($json['error']['message'] ?? $json['message'] ?? (is_string($json['error'] ?? null) ? $json['error'] : '')) : '';
    $m = mb_substr(kyc_vn_mask_text(integration_scrub($m)), 0, 200);
    return match ($status) {
        400 => 'VerifyNow could not accept the details' . ($m ? ": $m" : '.'),
        401, 403 => 'VerifyNow refused the API key. Check it under Admin portal → Integrations → VerifyNow, then re-run the check.',
        402 => 'The VerifyNow account has no credits left. Top up in the VerifyNow portal, then re-run the check.',
        409 => 'VerifyNow refused a repeat of this request with different details. Re-run the check.',
        413 => 'The request was too large for VerifyNow (the selfie may be too big). Upload a smaller photo, then re-run the check.',
        default => "VerifyNow answered HTTP $status" . ($m ? ": $m" : '.'),
    };
}
// Health check for the Integrations card: GET /my_credits (free).
function kyc_vn_health(): array
{
    if ((string) cfg('verifynow.apiKey', '') === '') return ['ok' => false, 'detail' => 'Enter the VerifyNow API key and save first.'];
    $test = kyc_vn_mode() === 'sandbox' ? 'TEST (sandbox): results are synthetic and nothing real is checked. ' : '';
    try { $r = kyc_vn_call('GET', '/my_credits', null, null); }
    catch (Throwable $e) { return ['ok' => false, 'detail' => 'This server could not reach VerifyNow: ' . integration_scrub($e->getMessage())]; }
    if ($r['status'] !== 200) return ['ok' => false, 'detail' => kyc_vn_problem_text($r['status'], $r['json'])];
    $credits = kyc_vn_find_number(is_array($r['json']) ? $r['json'] : [], ['credits', 'remainingCredits', 'remaining_credits', 'balance', 'credit_balance']);
    q("INSERT INTO meta (key, value) VALUES ('verifynow_credits', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [json_encode(['credits' => $credits, 'at' => now_iso()])]);
    q("DELETE FROM meta WHERE key = 'verifynow_problem'");
    return ['ok' => true, 'credits' => $credits, 'detail' => $test . 'VerifyNow accepted the key.' . ($credits !== null ? " Credits: $credits." : '')];
}
function kyc_vn_problem(?string $text): void
{
    if ($text === null) { q("DELETE FROM meta WHERE key = 'verifynow_problem'"); return; }
    q("INSERT INTO meta (key, value) VALUES ('verifynow_problem', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [json_encode(['text' => $text, 'at' => now_iso()])]);
}

// ============================================================== the worker
// Background job: runs due checks for up to ~8 seconds.
function kyc_vn_work(int $max = 10): int
{
    $n = 0;
    $end = microtime(true) + 8;
    $now = now_iso();
    $due = rows("SELECT * FROM kyc_checks WHERE status IN ('queued','waiting','running') AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT $max", [$now]);
    foreach ($due as $c) {
        if (microtime(true) > $end) break;
        // Claim it (a crashed run's lease runs out after two minutes).
        $from = $c['status'] === 'running' ? 'running' : $c['status'];
        $ok = affected("UPDATE kyc_checks SET status = 'running', attempts = attempts + 1, next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = ? AND next_attempt_at <= ?",
            [iso_in(120), now_iso(), $c['id'], $from, $now]);
        if (!$ok) continue;
        $c = row('SELECT * FROM kyc_checks WHERE id = ?', [$c['id']]);
        try { $c['job_id'] && $from !== 'queued' ? kyc_vn_poll($c) : kyc_vn_run($c); }
        catch (Throwable $e) {
            error_log('[ticketroom] verifynow check ' . $c['id'] . ': ' . kyc_vn_mask_text(integration_scrub($e->getMessage())));
            kyc_vn_retry($c, 'TicketRoom could not finish this check: ' . mb_substr(kyc_vn_mask_text(integration_scrub($e->getMessage())), 0, 160));
        }
        $n++;
    }
    return $n;
}
// Try again later, or give up with a plain reason after the last attempt.
function kyc_vn_retry(array $c, string $why, ?int $after = null, bool $counts = true): void
{
    $max = max(1, (int) cfg('verifynow.maxAttempts', 6));
    if ($counts && (int) $c['attempts'] >= $max) { kyc_vn_finish($c, 'error', [$why . ' We tried ' . $c['attempts'] . ' times. Re-run the check when it is fixed.'], null); return; }
    $base = max(1, (int) cfg('verifynow.retryBaseSeconds', 30));
    $wait = $after ?? min(3600, $base * (2 ** max(0, (int) $c['attempts'] - 1)));
    q("UPDATE kyc_checks SET status = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ? AND status = 'running'",
        [$c['job_id'] ? 'waiting' : 'queued', iso_in($wait), mb_substr($why, 0, 300), now_iso(), $c['id']]);
}
function kyc_vn_run(array $c): void
{
    if (!kyc_vn_on()) { kyc_vn_retry($c, 'VerifyNow is switched off under Integrations.', 300, false); return; }
    $in = kyc_vn_inputs($c['check_type'], $c['organiser_id'], $c['mode']);
    // Details changed since this was queued: start a fresh check (a new key, so
    // VerifyNow never sees one key with two different bodies).
    if (!$in['ok'] || $in['subject'] !== $c['subject_hash'] || $c['mode'] !== kyc_vn_mode()) {
        q("UPDATE kyc_checks SET status = 'superseded', updated_at = ? WHERE id = ?", [now_iso(), $c['id']]);
        if ($in['ok'] && $c['consent_id']) {
            $fresh = kyc_vn_inputs($c['check_type'], $c['organiser_id'], kyc_vn_mode(), false);
            if ($fresh['ok']) kyc_vn_enqueue($c['organiser_id'], $c['check_type'], $fresh['subject'], $c['consent_id'], null);
        }
        return;
    }
    try { $r = kyc_vn_call('POST', $in['path'], $in['body'], $c['idempotency_key'], $in['headers']); }
    catch (Throwable $e) { kyc_vn_retry($c, 'VerifyNow did not answer in time.'); return; }
    kyc_vn_handle($c, $r);
}
function kyc_vn_handle(array $c, array $r): void
{
    $s = $r['status'];
    $j = is_array($r['json']) ? $r['json'] : [];
    q('UPDATE kyc_checks SET http_status = ? WHERE id = ?', [$s, $c['id']]);
    if ($s === 429) { kyc_vn_retry($c, 'VerifyNow asked us to slow down.', max(1, (int) ($r['retryAfter'] ?? 2)), false); return; }
    if ($s === 202 && in_array($c['check_type'], ['bank'], true) && ($jobId = (string) ($j['jobId'] ?? $j['job_id'] ?? '')) !== '') {
        q("UPDATE kyc_checks SET status = 'waiting', job_id = ?, provider_ref = ?, next_attempt_at = ?, last_error = NULL, response_json = ?, updated_at = ? WHERE id = ?",
            [$jobId, $jobId, iso_in(max(2, (int) cfg('verifynow.pollSeconds', 120))), kyc_vn_redact_json($j), now_iso(), $c['id']]);
        return;
    }
    if ($s === 202) { kyc_vn_retry($c, 'VerifyNow is still working on it.', max(2, (int) ($r['retryAfter'] ?? 5)), false); return; }
    if ($s >= 500 || $s === 0) { kyc_vn_retry($c, $s === 502 || $s === 503 ? 'VerifyNow could not process the check right now.' : "VerifyNow answered HTTP $s."); return; }
    if ($s < 200 || $s >= 300) {
        $why = kyc_vn_problem_text($s, $j);
        if (in_array($s, [401, 402, 403], true)) kyc_vn_problem($why);
        kyc_vn_finish($c, 'error', [$why], $j);
        return;
    }
    kyc_vn_problem(null);
    $res = kyc_vn_interpret($c, $j);
    kyc_vn_finish($c, $res['status'], $res['reasons'], $j, $res['ref'] ?? null);
}
// Bank job polling: the fallback when the webhook does not come.
function kyc_vn_poll(array $c): void
{
    $kind = kyc_profile($c['organiser_id'])['entity_type'] === 'npo' ? 'npo' : 'business';
    try { $r = kyc_vn_call('GET', "/$kind-bank-account-verification/jobs/" . rawurlencode((string) $c['job_id']), null, null); }
    catch (Throwable $e) { kyc_vn_retry($c, 'VerifyNow did not answer in time.', null, false); return; }
    $j = is_array($r['json']) ? $r['json'] : [];
    if ($r['status'] === 429) { kyc_vn_retry($c, 'VerifyNow asked us to slow down.', max(1, (int) ($r['retryAfter'] ?? 2)), false); return; }
    if ($r['status'] !== 200) {
        if ($r['status'] >= 500) { kyc_vn_retry($c, 'VerifyNow could not report on the bank check right now.', null, false); return; }
        kyc_vn_finish($c, 'error', [kyc_vn_problem_text($r['status'], $j)], $j);
        return;
    }
    $data = $j['data'] ?? $j;
    $st = strtolower((string) ($data['status'] ?? ''));
    if (!isset($data['result']) && !in_array($st, ['completed', 'failed'], true)) {
        // Still with the bank: look again later, slowing down to every 30 minutes.
        $base = max(2, (int) cfg('verifynow.pollSeconds', 120));
        q("UPDATE kyc_checks SET status = 'waiting', next_attempt_at = ?, updated_at = ? WHERE id = ?", [iso_in(min(1800, $base * (2 ** min(6, max(0, (int) $c['attempts'] - 1))))), now_iso(), $c['id']]);
        return;
    }
    $res = kyc_vn_bank_result($data['result'] ?? [], $st);
    kyc_vn_finish($c, $res['status'], $res['reasons'], $j);
}

// ============================================================== reading results
// Response shapes are read defensively: VerifyNow documents the main fields
// (said_verification, business bank outcome and checks) but not every one, so
// anything not recognised goes to staff review rather than passing.
function kyc_vn_find(array $a, array $keys, int $depth = 0)
{
    foreach ($keys as $k) if (array_key_exists($k, $a)) return $a[$k];
    if ($depth > 4) return null;
    foreach ($a as $v) if (is_array($v) && ($f = kyc_vn_find($v, $keys, $depth + 1)) !== null) return $f;
    return null;
}
function kyc_vn_find_number(array $a, array $keys): ?int
{
    $v = kyc_vn_find($a, $keys);
    return is_numeric($v) ? (int) $v : null;
}
function kyc_vn_norm(string $s): string
{
    $s = mb_strtolower($s);
    $s = preg_replace('/\b(pty|ltd|limited|proprietary|npc|inc|cc|rf|soc)\b|[^\p{L}\p{N} ]+/u', ' ', $s);
    return trim(preg_replace('/\s+/', ' ', (string) $s));
}
function kyc_vn_interpret(array $c, array $j): array
{
    $unknown = ['status' => 'review', 'reasons' => ['VerifyNow answered in a way TicketRoom did not recognise. Look it up in the VerifyNow portal.']];
    $ref = (string) ($j['requestId'] ?? $j['request_id'] ?? kyc_vn_find($j, ['transaction_id', 'requestId', 'reference']) ?? '');
    $ref = mb_substr($ref, 0, 80) ?: null;
    $v = kyc_profile($c['organiser_id']);
    $out = match ($c['check_type']) {
        'said' => (function () use ($j, $v, $unknown) {
            $rt = $j['results']['said_verification']['realTimeResults'] ?? null;
            if (!is_array($rt)) return $unknown;
            $st = mb_strtolower((string) ($rt['Status'] ?? ''));
            $ver = is_array($rt['Verification'] ?? null) ? $rt['Verification'] : [];
            if (str_contains($st, 'deceased') || mb_strtolower((string) ($ver['DeceasedStatus'] ?? '')) === 'deceased') return ['status' => 'failed', 'reasons' => ['Home Affairs records this ID number as belonging to someone who has died.']];
            if (!str_contains($st, 'valid') || str_contains($st, 'invalid') || str_contains($st, 'not valid')) return ['status' => 'failed', 'reasons' => ['Home Affairs could not confirm this ID number. Check the number under "About you".']];
            [, $sur] = kyc_vn_names($v);
            $last = (string) ($ver['Lastname'] ?? $ver['Surname'] ?? '');
            if ($last !== '' && kyc_vn_norm($last) !== kyc_vn_norm($sur) && !str_contains(kyc_vn_norm((string) $v['legal_name']), kyc_vn_norm($last))) {
                return ['status' => 'review', 'reasons' => ['The surname at Home Affairs does not match the name we have. TicketRoom will compare it with the ID document.']];
            }
            return ['status' => 'passed', 'reasons' => ['Home Affairs confirmed the ID number and name.']];
        })(),
        'aml_person', 'aml_company' => (function () use ($j, $unknown) {
            $list = kyc_vn_find($j, ['matches', 'hits', 'results_list']);
            $count = kyc_vn_find_number($j, ['total_hits', 'totalHits', 'hit_count', 'hitCount', 'matchCount', 'match_count']);
            if ($count === null && is_array($list)) $count = count($list);
            if ($count === null) return $unknown;
            if ($count === 0) return ['status' => 'passed', 'reasons' => ['No match on sanctions or PEP lists.']];
            $names = [];
            foreach (is_array($list) ? array_slice($list, 0, 3) : [] as $m) {
                if (!is_array($m)) continue;
                $ds = $m['datasets'] ?? $m['dataset'] ?? $m['lists'] ?? null;
                $names[] = trim((string) ($m['name'] ?? $m['caption'] ?? 'a listed person') . ($ds ? ' (' . (is_array($ds) ? implode(', ', array_map('strval', $ds)) : (string) $ds) . ')' : ''));
            }
            return ['status' => 'review', 'reasons' => ["Possible match on a sanctions or PEP list ($count): " . ($names ? implode('; ', $names) : 'see the VerifyNow report') . '. TicketRoom will check whether it is the same person or organisation.']];
        })(),
        'cipc' => (function () use ($j, $v, $c, $unknown) {
            $m = kyc_vn_find($j, ['match', 'matched', 'found']);
            $status = (string) (kyc_vn_find($j, ['company_status', 'enterprise_status', 'companyStatus', 'enterpriseStatus']) ?? '');
            $name = (string) (kyc_vn_find($j, ['company_name', 'enterprise_name', 'companyName', 'enterpriseName', 'name']) ?? '');
            if ($m === false || $m === 'false' || $m === 0) return ['status' => 'failed', 'reasons' => ['CIPC has no company with this registration number. Check the number under "About you".']];
            if ($m === null && $name === '') return $unknown;
            $reasons = [];
            if ($status !== '' && !preg_match('/in business|active|registered/i', $status)) $reasons[] = "CIPC lists the company as \"$status\", not in business.";
            $ours = trim((string) ($v['company_name'] ?? '')) ?: (string) val('SELECT name FROM organisers WHERE id = ?', [$c['organiser_id']]);
            if ($name !== '' && kyc_vn_norm($name) !== kyc_vn_norm($ours)) $reasons[] = "The registered name at CIPC (\"$name\") differs from the name we have (\"$ours\").";
            return $reasons ? ['status' => 'review', 'reasons' => $reasons] : ['status' => 'passed', 'reasons' => ['CIPC confirmed the company is registered and in business.']];
        })(),
        'face' => (function () use ($j, $unknown) {
            $fm = $j['results']['face_match'] ?? null;
            if (!is_array($fm)) return $unknown;
            $st = mb_strtolower((string) ($fm['status'] ?? ''));
            $score = isset($fm['score']) && is_numeric($fm['score']) ? (float) $fm['score'] : null;
            if (in_array($st, ['match', 'matched', 'success', 'verified', 'pass', 'passed'], true)) return ['status' => 'passed', 'reasons' => ['The selfie matches the Home Affairs photo' . ($score !== null ? " (score $score)" : '') . '.']];
            if (in_array($st, ['no_match', 'no match', 'not_matched', 'mismatch', 'failed', 'fail'], true)) return ['status' => 'failed', 'reasons' => ['The selfie does not match the Home Affairs photo. Upload a clear, recent selfie.']];
            return ['status' => 'review', 'reasons' => ['The face match was not conclusive' . ($score !== null ? " (score $score)" : '') . '. TicketRoom will compare the photos.']];
        })(),
        'bank' => kyc_vn_bank_result(is_array($j['result'] ?? null) ? $j['result'] : (is_array($j['results'] ?? null) ? ($j['results']['bank_account_verification'] ?? $j['results']) : $j), strtolower((string) ($j['status'] ?? ''))),
        default => $unknown,
    };
    return $out + ['ref' => $ref];
}
const VN_BANK_CHECK_TEXT = [
    'accountFound' => ['The bank could not find this account.', 'The bank could not say whether the account exists.'],
    'accountOpen' => ['The account is closed.', 'The bank could not say whether the account is open.'],
    'accountTypeMatch' => ['The account type does not match what you chose.', 'The bank could not confirm the account type.'],
    'companyRegistrationMatch' => ["The account is not held under the organisation's registration number.", "The bank could not confirm the organisation's registration number."],
    'identityMatch' => ['The account is not held under this ID number.', 'The bank could not confirm the ID number.'],
    'surnameMatch' => ['The account holder name does not match.', 'The bank could not confirm the account holder name.'],
    'initialsMatch' => ['The account holder initials do not match.', null],
    'acceptsCredits' => ['The account does not accept payments in, so payouts would fail.', null],
];
function kyc_vn_bank_result(array $res, string $jobStatus = ''): array
{
    $outcome = strtolower((string) ($res['outcome'] ?? ''));
    $checks = is_array($res['checks'] ?? null) ? $res['checks'] : [];
    $err = is_array($res['error'] ?? null) ? $res['error'] : null;
    $reasons = [];
    foreach (VN_BANK_CHECK_TEXT as $k => [$no, $unsure]) {
        if (!array_key_exists($k, $checks)) continue;
        if ($checks[$k] === false) $reasons[] = $no;
        elseif ($checks[$k] === null && $unsure) $reasons[] = $unsure;
    }
    if ($outcome === '' && $err) $outcome = 'failed';
    if ($outcome === '' && $checks) {
        $need = ['accountFound', 'accountOpen'];
        $outcome = array_filter($need, fn($k) => ($checks[$k] ?? null) !== true) ? 'review' : ($reasons ? 'review' : 'verified');
    }
    if ($outcome === 'verified') return ['status' => 'passed', 'reasons' => array_merge(['The bank confirmed the account is open and in the right name.'], $reasons)];
    if ($outcome === 'failed' || $jobStatus === 'failed') {
        $code = (string) ($err['code'] ?? '');
        $msg = $code === 'verification_timed_out' ? 'The bank did not answer in time.' : ($code === 'verification_failed' ? 'The bank could not verify the account.' : mb_substr(kyc_vn_mask_text((string) ($err['message'] ?? 'The bank check failed.')), 0, 160));
        return ['status' => 'failed', 'reasons' => array_merge([$msg . ' Check the bank details under Settings, or ask TicketRoom to re-run the check.'], $reasons)];
    }
    if ($outcome === 'review') return ['status' => 'review', 'reasons' => $reasons ?: ['The bank could not confirm everything. TicketRoom will look at it.']];
    return ['status' => 'review', 'reasons' => ['VerifyNow answered in a way TicketRoom did not recognise. Look it up in the VerifyNow portal.']];
}

// ============================================================== redaction
// Never stored: images, full ID numbers, full account numbers, secrets.
function kyc_vn_mask_text(string $s): string
{
    return (string) preg_replace_callback('/\d{7,}/', fn($m) => str_repeat('•', max(0, strlen($m[0]) - 4)) . substr($m[0], -4), $s);
}
function kyc_vn_redact($v, string $key = '', int $depth = 0)
{
    if ($depth > 8) return '[removed]';
    if (preg_match('/image|base64|photo|portrait|selfie|signature|secret|api_?key|token/i', $key)) return '[removed]';
    if (is_array($v)) { $o = []; foreach ($v as $k => $x) $o[$k] = kyc_vn_redact($x, (string) $k, $depth + 1); return $o; }
    if (is_string($v)) return mb_substr(kyc_vn_mask_text($v), 0, 500);
    return $v;
}
function kyc_vn_redact_json($j): ?string
{
    if (!is_array($j) || !$j) return null;
    $s = json_encode(kyc_vn_redact($j), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    return strlen((string) $s) > 20000 ? substr((string) $s, 0, 20000) : $s;
}

// ============================================================== outcomes
function kyc_vn_finish(array $c, string $status, array $reasons, $json, ?string $ref = null): void
{
    tx(function () use ($c, $status, $reasons, $json, $ref) {
        $now = now_iso();
        $n = affected("UPDATE kyc_checks SET status = ?, reasons = ?, response_json = COALESCE(?, response_json), provider_ref = COALESCE(?, provider_ref), last_error = NULL, next_attempt_at = NULL, completed_at = ?, updated_at = ?
                        WHERE id = ? AND status IN ('running','waiting','queued')",
            [$status, json_encode(array_values($reasons), JSON_UNESCAPED_UNICODE), kyc_vn_redact_json($json), $ref, $now, $now, $c['id']]);
        if (!$n) return;
        audit('verification.check_completed', ['actor' => ['id' => null], 'actorRole' => 'system', 'entityType' => 'kyc_check', 'entityId' => $c['id'], 'organiserId' => $c['organiser_id'],
            'details' => ['type' => $c['check_type'], 'outcome' => $status, 'mode' => $c['mode']]]);
        if ($status === 'passed') kyc_vn_approve_docs($c['organiser_id'], $c['check_type']);
        else kyc_vn_tell_staff($c, $status, $reasons);
        kyc_check_complete($c['organiser_id']);
    });
}
// A passed Home Affairs or CIPC check approves the matching document waiting for review.
function kyc_vn_approve_docs(string $orgId, string $type): void
{
    $reqs = ['said' => ['id_document', 'rep_id'], 'cipc' => ['cipc_certificate']][$type] ?? [];
    if (!$reqs) return;
    $in = implode(',', array_fill(0, count($reqs), '?'));
    foreach (rows("SELECT id FROM verification_documents WHERE organiser_id = ? AND event_id IS NULL AND status = 'submitted' AND requirement IN ($in)", [$orgId, ...$reqs]) as $d) {
        q("UPDATE verification_documents SET provider = 'verifynow', provider_status = 'verified', provider_message = ?, provider_checked_at = ? WHERE id = ?",
            [$type === 'said' ? 'Home Affairs confirmed the ID number and name.' : 'CIPC confirmed the company.', now_iso(), $d['id']]);
        kyc_decide($d['id'], true, null, null);
    }
}
// Called when an ID document or CIPC certificate is uploaded: if the matching
// check already passed for these details, the document is approved straight away.
function kyc_vn_doc_uploaded(array $doc): bool
{
    $type = ['id_document' => 'said', 'rep_id' => 'said', 'cipc_certificate' => 'cipc'][$doc['requirement']] ?? null;
    if (!$type || $doc['event_id'] || !kyc_vn_on()) return false;
    $last = kyc_vn_latest($doc['organiser_id'], $type);
    $in = kyc_vn_inputs($type, $doc['organiser_id'], kyc_vn_mode(), false);
    if (!$last || !$in['ok'] || $last['subject_hash'] !== $in['subject'] || kyc_vn_effective($last) !== 'approved') return false;
    kyc_vn_approve_docs($doc['organiser_id'], $type);
    return true;
}
function kyc_vn_tell_staff(array $c, string $status, array $reasons): void
{
    $org = row('SELECT name FROM organisers WHERE id = ?', [$c['organiser_id']]);
    $support = settings_all()['support']['email'] ?? null;
    if (!$support || !$org) return;
    $label = VN_CHECKS[$c['check_type']]['label'] ?? $c['check_type'];
    outbox_enqueue(['to' => $support, 'subject' => "[TicketRoom] Verification check needs a look: {$org['name']}",
        'body' => "The $label for {$org['name']} came back as \"$status\"" . ($c['mode'] === 'sandbox' ? ' (TEST, sandbox)' : '') . ".\n\n- " . implode("\n- ", $reasons)
            . "\n\nReview it in Admin portal → Verification: " . base_url() . "/admin#/organisers/{$c['organiser_id']}"]);
}

// ============================================================== status for the checklist
// What a check means for the checklist: approved, rejected or submitted (being
// checked or waiting for TicketRoom). Staff decisions win.
function kyc_vn_effective(array $c): string
{
    if ($c['override'] === 'accepted') return 'approved';
    if ($c['override'] === 'rejected') return 'rejected';
    return match ($c['status']) { 'passed' => 'approved', 'failed' => 'rejected', default => 'submitted' };
}
function kyc_vn_item_status(array &$it, string $orgId): void
{
    $type = $it['checkType'];
    $last = kyc_vn_latest($orgId, $type);
    $in = kyc_vn_inputs($type, $orgId, kyc_vn_mode(), false);
    $it['check'] = $last ? kyc_vn_check_view($last, false) : null;
    if (!$in['ok']) { $it['status'] = 'missing'; $it['detail'] = $in['missing']; return; }
    if (!$last || $last['subject_hash'] !== $in['subject']) {
        $it['status'] = 'not_started';
        $it['detail'] = $last ? 'Your details changed, so this check runs again when you submit your next event or press "Run checks now".' : 'Runs when you submit an event for review, or press "Run checks now".';
        return;
    }
    $it['status'] = kyc_vn_effective($last);
    $reasons = json_decode((string) $last['reasons'], true) ?: [];
    $it['detail'] = match (true) {
        in_array($last['status'], VN_OPEN, true) => 'Checking now. This usually takes a minute' . ($type === 'bank' ? ', or longer for a bank' : '') . '.',
        $last['override'] === 'accepted' => 'Accepted by TicketRoom.' . ($last['decision_note'] ? ' ' . $last['decision_note'] : ''),
        $last['override'] === 'rejected' => 'Not accepted by TicketRoom: ' . ($last['decision_note'] ?: implode(' ', $reasons)),
        $last['status'] === 'error' => 'TicketRoom is looking at a problem with this check. You do not need to do anything.',
        $last['status'] === 'review' => 'TicketRoom is looking at the result: ' . implode(' ', $reasons),
        default => implode(' ', $reasons),
    };
    if ($it['status'] === 'rejected') $it['rejectReason'] = $it['detail'];
}

// ============================================================== views
function kyc_vn_check_view(array $c, bool $staff): array
{
    $out = ['id' => $c['id'], 'type' => $c['check_type'], 'label' => VN_CHECKS[$c['check_type']]['label'] ?? $c['check_type'], 'status' => $c['status'], 'effective' => kyc_vn_effective($c),
        'mode' => $c['mode'], 'test' => $c['mode'] === 'sandbox', 'reasons' => json_decode((string) $c['reasons'], true) ?: [], 'override' => $c['override'], 'decisionNote' => $c['decision_note'],
        'createdAt' => $c['created_at'], 'completedAt' => $c['completed_at']];
    if ($staff) {
        $out += ['providerRef' => $c['provider_ref'], 'idempotencyKey' => $c['idempotency_key'], 'jobId' => $c['job_id'], 'attempts' => (int) $c['attempts'], 'httpStatus' => $c['http_status'] === null ? null : (int) $c['http_status'],
            'lastError' => $c['last_error'], 'nextAttemptAt' => $c['next_attempt_at'], 'decidedBy' => $c['decided_by_name'] ?? null, 'decidedAt' => $c['decided_at'],
            'response' => $c['response_json'] ? json_decode((string) $c['response_json'], true) : null];
    }
    return $out;
}
function kyc_vn_checks_view(string $orgId): array
{
    return array_map(fn($c) => kyc_vn_check_view($c, true), rows('SELECT k.*, u.full_name AS decided_by_name FROM kyc_checks k LEFT JOIN users u ON u.id = k.decided_by WHERE k.organiser_id = ? ORDER BY k.created_at DESC, k.rowid DESC LIMIT 100', [$orgId]));
}
// For the Verification page: is it on, test mode, consent.
function kyc_vn_summary(string $orgId): array
{
    $c = kyc_vn_on() ? kyc_vn_consent($orgId) : null;
    return ['on' => kyc_vn_on(), 'test' => kyc_vn_mode() === 'sandbox', 'consent' => ['given' => (bool) $c, 'at' => $c['created_at'] ?? null, 'version' => VN_CONSENT_VERSION, 'text' => VN_CONSENT_TEXT],
        'bankTypes' => VN_BANK_TYPES, 'due' => kyc_vn_on() ? count(kyc_vn_due_types($orgId)) : 0];
}

// ============================================================== staff actions
function kyc_vn_rerun(string $checkId, array $u): array
{
    $c = row('SELECT * FROM kyc_checks WHERE id = ?', [$checkId]);
    if (!$c) throw not_found('Check not found.');
    if (!kyc_vn_on()) throw conflict('VerifyNow is switched off under Integrations.', 'verifynow_off');
    if (in_array($c['status'], VN_OPEN, true)) throw conflict('This check is still running.', 'check_running');
    $consent = kyc_vn_consent($c['organiser_id']);
    if (!$consent) throw conflict('The organiser has not given permission for the checks yet.', 'consent_required');
    $in = kyc_vn_inputs($c['check_type'], $c['organiser_id'], kyc_vn_mode(), false);
    if (!$in['ok']) throw conflict('This check cannot run yet: ' . $in['missing'], 'check_inputs_missing');
    $n = kyc_vn_enqueue($c['organiser_id'], $c['check_type'], $in['subject'], $consent['id'], $u['id']);
    audit('verification.check_rerun', ['actor' => $u, 'entityType' => 'kyc_check', 'entityId' => $n['id'], 'organiserId' => $c['organiser_id'], 'details' => ['type' => $c['check_type'], 'previous' => $c['id']]]);
    return $n;
}
function kyc_vn_decide(string $checkId, bool $accept, ?string $note, array $u): array
{
    return tx(function () use ($checkId, $accept, $note, $u) {
        $c = row('SELECT * FROM kyc_checks WHERE id = ?', [$checkId]);
        if (!$c) throw not_found('Check not found.');
        if ($c['status'] === 'superseded' || in_array($c['status'], VN_OPEN, true)) throw conflict('Only a finished, current check can be decided.', 'bad_transition');
        q('UPDATE kyc_checks SET override = ?, decision_note = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?', [$accept ? 'accepted' : 'rejected', $note, $u['id'], now_iso(), now_iso(), $c['id']]);
        audit($accept ? 'verification.check_accepted' : 'verification.check_rejected', ['actor' => $u, 'entityType' => 'kyc_check', 'entityId' => $c['id'], 'organiserId' => $c['organiser_id'],
            'details' => ['type' => $c['check_type'], 'outcome' => $c['status'], 'note' => $note]]);
        if ($accept) kyc_vn_approve_docs($c['organiser_id'], $c['check_type']);
        kyc_check_complete($c['organiser_id']);
        return row('SELECT * FROM kyc_checks WHERE id = ?', [$c['id']]);
    });
}

// ============================================================== webhook
// POST /api/webhooks/verifynow. Signed: x-verifynow-signature "v1=<hex>" is
// HMAC-SHA256 of timestamp + "." + raw body with our webhook secret. Stale
// (more than 5 minutes off) or bad signatures are refused; each event id is
// handled once.
function kyc_vn_webhook(): Response|array
{
    limit('webhook', 600, 60);
    $raw = (string) $GLOBALS['TR_REQ']['raw'];
    $sig = trim((string) ($_SERVER['HTTP_X_VERIFYNOW_SIGNATURE'] ?? ''));
    $ts = trim((string) ($_SERVER['HTTP_X_VERIFYNOW_TIMESTAMP'] ?? ''));
    $secret = (string) cfg('verifynow.webhookSecret', '');
    $reject = function (string $why, int $status = 401) {
        if (limit_ok('webhookreject', 100, 3600)) q("INSERT INTO webhook_events (provider,event_id,status,error,received_at) VALUES ('verifynow',?,'rejected',?,?)", ['rejected:' . bin2hex(random_bytes(8)), $why, now_iso()]);
        throw new AppError($status, 'bad_signature', $why);
    };
    if ($secret === '') $reject('VerifyNow notifications are not set up.', 503);
    $when = ctype_digit($ts) ? (int) $ts : (int) strtotime($ts);
    if ($when > 100000000000) $when = intdiv($when, 1000); // milliseconds
    if (!$when || abs(time() - $when) > 300) $reject('Stale or missing timestamp.');
    $want = hash_hmac('sha256', $ts . '.' . $raw, $secret);
    $ok = false;
    foreach (explode(',', $sig) as $part) {
        $part = trim($part);
        if (str_starts_with($part, 'v1=') && hash_equals($want, strtolower(substr($part, 3)))) $ok = true;
    }
    if (!$ok) $reject('Bad signature.');
    $evt = json_decode($raw, true);
    if (!is_array($evt) || !is_string($evt['id'] ?? null) || $evt['id'] === '') throw bad('Missing event id.');
    $eid = mb_substr($evt['id'], 0, 120);
    $seen = row("SELECT * FROM webhook_events WHERE provider = 'verifynow' AND event_id = ?", [$eid]);
    if ($seen && in_array($seen['status'], ['processed', 'ignored'], true)) { q('UPDATE webhook_events SET attempts = attempts + 1 WHERE id = ?', [$seen['id']]); return ['received' => true, 'duplicate' => true]; }
    if (!$seen) { q("INSERT INTO webhook_events (provider,event_id,status,received_at) VALUES ('verifynow',?,'received',?)", [$eid, now_iso()]); $wid = (int) db()->lastInsertId(); }
    else { $wid = (int) $seen['id']; q('UPDATE webhook_events SET attempts = attempts + 1 WHERE id = ?', [$wid]); }
    $type = (string) ($evt['type'] ?? '');
    $data = is_array($evt['data'] ?? null) ? $evt['data'] : [];
    if (!preg_match('/^(business|npo)_bank\.verification\.(completed|failed)$/', $type)) {
        q("UPDATE webhook_events SET status = 'ignored', result = ?, processed_at = ? WHERE id = ?", ['unknown type', now_iso(), $wid]);
        return ['received' => true];
    }
    $c = row('SELECT * FROM kyc_checks WHERE job_id = ?', [(string) ($data['jobId'] ?? '')]);
    if (!$c) {
        // Possibly faster than our own record of the job: VerifyNow tries again later.
        q("UPDATE webhook_events SET status = 'failed', error = 'unknown job', processed_at = ? WHERE id = ?", [now_iso(), $wid]);
        throw not_found('Unknown job.');
    }
    if (!in_array($c['status'], ['waiting', 'running', 'queued'], true)) {
        q("UPDATE webhook_events SET status = 'ignored', result = ?, processed_at = ? WHERE id = ?", ['check already ' . $c['status'], now_iso(), $wid]);
        return ['received' => true];
    }
    $res = kyc_vn_bank_result(is_array($data['result'] ?? null) ? $data['result'] : [], str_ends_with($type, '.failed') ? 'failed' : strtolower((string) ($data['status'] ?? '')));
    kyc_vn_finish($c, $res['status'], $res['reasons'], $evt);
    q("UPDATE webhook_events SET status = 'processed', result = ?, processed_at = ? WHERE id = ?", [$res['status'], now_iso(), $wid]);
    return ['received' => true];
}
