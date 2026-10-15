<?php
// Organiser verification (FICA / KYC), the rules that decide what each
// organiser must show us, private document storage and the identity check.
//
// What is asked for depends on three things only: the kind of organiser
// (individual, company, NPO), whether they sell paid tickets, and how risky
// an event is. Nothing else is collected (POPIA: data minimisation). Every
// item says why it is needed.
//
// Documents are kept in the data folder's "private" folder (never served by
// the web server), encrypted with the site's data key, under random names.
// They are only handed out by /api/verification/documents/:id/file to the
// organisation's owners and to TicketRoom staff, and every view is audited.
declare(strict_types=1);

const KYC_TERMS_VERSION = 'organiser-terms-1.0';
const KYC_MAX_BYTES = 10 * 1024 * 1024;
const KYC_TYPES = ['application/pdf' => 'pdf', 'image/jpeg' => 'jpg', 'image/png' => 'png'];
const KYC_UPLOAD_RE = '#^/api/organiser/[0-9a-f-]{36}/verification/documents$#';
// When an event counts as large, high value or high risk.
const KYC_LARGE_CAPACITY = 2000;          // SASREA: events for 2 000 people or more need safety approval
const KYC_HIGH_CAPACITY = 5000;
const KYC_HIGH_VALUE_CENTS = 100000000;   // R1 million of tickets on sale
const KYC_NEW_ORG_VALUE_CENTS = 10000000; // R100 000 on sale by an organiser with no past events

const KYC_ENTITY_NAMES = ['individual' => 'Individual', 'company' => 'Company', 'npo' => 'NPO or community group'];

// Every document or check TicketRoom may ask for, with the reason we give.
// 'scope' => organiser-level or event-level.
const KYC_ITEMS = [
    // ---- people and organisations
    'id_document' => ['label' => 'ID document', 'kind' => 'document', 'reason' => 'FICA requires us to confirm who is selling tickets. We check it matches your name and ID number.'],
    'rep_id' => ['label' => "Representative's ID document", 'kind' => 'document', 'reason' => 'FICA requires us to confirm the person who acts for the organisation.'],
    'proof_of_address' => ['label' => 'Proof of address', 'kind' => 'document', 'reason' => 'Needed before we pay out money (FICA). A utility bill or bank statement from the last 3 months.'],
    'business_address' => ['label' => 'Proof of business address', 'kind' => 'document', 'reason' => 'Needed before we pay out money (FICA). A utility bill, lease or bank statement from the last 3 months.'],
    'bank_confirmation' => ['label' => 'Bank confirmation letter', 'kind' => 'document', 'reason' => 'Proves the payout account is yours, so ticket money only goes to you. Needed before any payout.'],
    'cipc_certificate' => ['label' => 'CIPC registration certificate', 'kind' => 'document', 'reason' => 'Confirms the company is registered and who its directors are.'],
    'authorisation_letter' => ['label' => 'Letter of authorisation', 'kind' => 'document', 'reason' => 'You are not a director, so a director must confirm you may act for the company.'],
    'npo_certificate' => ['label' => 'NPO registration certificate', 'kind' => 'document', 'reason' => 'Confirms the organisation is a registered non-profit.'],
    'constitution' => ['label' => 'Constitution', 'kind' => 'document', 'reason' => 'Shows how the organisation is run and who may act for it.'],
    'resolution' => ['label' => 'Resolution appointing the representative', 'kind' => 'document', 'reason' => 'Confirms the organisation chose you to act for it.'],
    'terms' => ['label' => 'Signed organiser terms', 'kind' => 'terms', 'reason' => 'Your agreement to run events lawfully and honour every ticket.'],
    'email' => ['label' => 'Verified email address', 'kind' => 'check', 'reason' => 'So buyers and TicketRoom can reach you.'],
    'phone' => ['label' => 'Verified mobile number', 'kind' => 'check', 'reason' => 'Phone checks are not available yet, so this does not hold anything up.'],
    // ---- per event
    'venue_agreement' => ['label' => 'Venue booking or hire agreement', 'kind' => 'document', 'event' => true, 'reason' => 'Confirms the venue is booked for your date.'],
    'event_permit' => ['label' => 'Event permit or municipal approval', 'kind' => 'document', 'event' => true, 'reason' => 'Events for 2 000 or more people, or in a public space, need approval from the municipality (Safety at Sports and Recreational Events Act).'],
    'liquor_licence' => ['label' => 'Liquor licence', 'kind' => 'document', 'event' => true, 'reason' => 'You said alcohol will be sold. A liquor licence or temporary permit is required by law.'],
    'liability_insurance' => ['label' => 'Public liability insurance', 'kind' => 'document', 'event' => true, 'reason' => 'Large and high-risk events must be insured in case someone is hurt.'],
    'artist_authorisation' => ['label' => 'Artist, promoter or owner authorisation', 'kind' => 'document', 'event' => true, 'reason' => "You said this is someone else's show. They must confirm you may sell tickets for it."],
    'safety_plan' => ['label' => 'Health and safety plan', 'kind' => 'document', 'event' => true, 'reason' => 'Required for events for 2 000 or more people.'],
    'previous_events' => ['label' => 'Proof of previous events', 'kind' => 'document', 'event' => true, 'reason' => 'High-risk event: shows you have run events like this before.'],
    'supplier_agreements' => ['label' => 'Supplier agreements', 'kind' => 'document', 'event' => true, 'reason' => 'High-risk event: shows key suppliers (stage, sound, security) are booked.'],
    'ticket_authority' => ['label' => 'Authority to sell tickets', 'kind' => 'document', 'event' => true, 'reason' => 'High-risk event: confirms you hold the right to sell tickets for it.'],
    'extra_verification' => ['label' => 'Extra identity or business verification', 'kind' => 'document', 'event' => true, 'reason' => 'High-risk event: for example a director list or a second ID document.'],
    'financial_info' => ['label' => 'Financial or operational plan', 'kind' => 'document', 'event' => true, 'reason' => 'High-risk event: a budget or run sheet showing the event can be delivered.'],
];

// ============================================================== settings
function kyc_settings(): array
{
    $s = function_exists('setting') ? (settings_all()['verification'] ?? []) : [];
    return ['retentionYears' => (int) ($s['retentionYears'] ?? 5), 'discardRejectedDays' => (int) ($s['discardRejectedDays'] ?? 90)];
}

// ============================================================== SA ID numbers
// YYMMDD SSSS C A Z: date of birth, sequence (0000-4999 female, 5000-9999
// male), citizenship (0 citizen, 1 permanent resident), a filler digit and a
// Luhn check digit. Checked here, before anything is sent anywhere.
function sa_id_check(string $raw): array
{
    $id = preg_replace('/\s+/', '', $raw);
    if (!preg_match('/^\d{13}$/', $id)) return ['ok' => false, 'error' => 'An SA ID number has 13 digits.'];
    $sum = 0;
    for ($i = 0; $i < 13; $i++) {
        $d = (int) $id[12 - $i];
        if ($i % 2 === 1) { $d *= 2; if ($d > 9) $d -= 9; }
        $sum += $d;
    }
    if ($sum % 10 !== 0) return ['ok' => false, 'error' => 'That ID number is not valid. Check the digits (the last one is a check digit).'];
    $yy = (int) substr($id, 0, 2); $mm = (int) substr($id, 2, 2); $dd = (int) substr($id, 4, 2);
    $nowYY = (int) gmdate('y');
    $year = $yy > $nowYY ? 1900 + $yy : 2000 + $yy;
    if (!checkdate($mm, $dd, $year)) return ['ok' => false, 'error' => 'The first six digits must be a real date of birth (YYMMDD).'];
    $dob = sprintf('%04d-%02d-%02d', $year, $mm, $dd);
    $age = (int) ((time() - strtotime("$dob 00:00:00 UTC")) / (365.2425 * 86400));
    if ($age < 18) return ['ok' => false, 'error' => 'Organisers must be 18 or older.'];
    $c = $id[10];
    if (!in_array($c, ['0', '1'], true)) return ['ok' => false, 'error' => 'The 11th digit must be 0 (SA citizen) or 1 (permanent resident).'];
    return ['ok' => true, 'id' => $id, 'dob' => $dob, 'citizen' => $c === '0', 'citizenship' => $c === '0' ? 'SA citizen' : 'Permanent resident',
        'sex' => (int) substr($id, 6, 4) < 5000 ? 'F' : 'M', 'sequence' => substr($id, 6, 4)];
}
function passport_check(string $raw): array
{
    $p = strtoupper(preg_replace('/\s+/', '', $raw));
    if (!preg_match('/^[A-Z0-9]{6,12}$/', $p)) return ['ok' => false, 'error' => 'A passport number has 6 to 12 letters and digits.'];
    return ['ok' => true, 'id' => $p];
}
function kyc_mask(?string $last): string { return $last ? '•••• ' . $last : ''; }

// ============================================================== private files
function kyc_dir(): string
{
    $d = data_dir() . '/private';
    if (!is_dir($d)) @mkdir($d, 0700, true);
    if (!is_file("$d/.htaccess")) @file_put_contents("$d/.htaccess", "Require all denied\n<IfModule !mod_authz_core.c>\n  Order allow,deny\n  Deny from all\n</IfModule>\n");
    if (!is_file("$d/index.html")) @file_put_contents("$d/index.html", '');
    return $d;
}
// Encrypted at rest with the site's data key (AES-256-GCM).
function kyc_seal(string $bytes): string
{
    $iv = random_bytes(12);
    $tag = '';
    $enc = openssl_encrypt($bytes, 'aes-256-gcm', hex2bin(key_hex('data')), OPENSSL_RAW_DATA, $iv, $tag);
    return 'TRK1' . $iv . $tag . $enc;
}
function kyc_open(string $blob): string
{
    if (substr($blob, 0, 4) !== 'TRK1') throw new RuntimeException('unknown document format');
    $out = openssl_decrypt(substr($blob, 32), 'aes-256-gcm', hex2bin(key_hex('data')), OPENSSL_RAW_DATA, substr($blob, 4, 12), substr($blob, 16, 16));
    if ($out === false) throw new RuntimeException('document could not be decrypted');
    return $out;
}
function kyc_sniff(string $buf): ?string
{
    if (str_starts_with($buf, '%PDF-')) return 'application/pdf';
    if (str_starts_with($buf, "\x89PNG\r\n\x1a\n")) return 'image/png';
    if (str_starts_with($buf, "\xFF\xD8\xFF")) return 'image/jpeg';
    return null;
}
function ini_bytes(string $v): int
{
    $v = trim($v);
    if ($v === '' || $v === '0' || $v === '-1') return 0;
    $n = (int) $v;
    return match (strtolower(substr($v, -1))) { 'g' => $n * 1073741824, 'm' => $n * 1048576, 'k' => $n * 1024, default => $n };
}
// The largest document this server accepts: 10 MB, or less if the host's PHP
// settings (post_max_size) are lower.
function kyc_max_bytes(): int
{
    $post = ini_bytes((string) ini_get('post_max_size'));
    return $post > 0 ? min(KYC_MAX_BYTES, $post - 1024) : KYC_MAX_BYTES;
}
function kyc_read_upload(): array
{
    $max = kyc_max_bytes();
    $len = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
    $mb = round($max / 1048576, 1);
    if ($len > $max) throw new AppError(413, 'too_large', "Documents must be $mb MB or smaller.");
    $buf = (string) file_get_contents('php://input', false, null, 0, $max + 1);
    if ($buf === '') throw bad('The file was empty. Choose the file again.');
    if (strlen($buf) > $max) throw new AppError(413, 'too_large', "Documents must be $mb MB or smaller.");
    $mime = kyc_sniff($buf);
    if (!$mime) throw new AppError(415, 'unsupported_media_type', 'Upload a PDF, JPG or PNG file.');
    $name = rawurldecode((string) ($_SERVER['HTTP_X_FILE_NAME'] ?? ''));
    $name = mb_substr(trim((string) preg_replace('/[^\p{L}\p{N} ._()-]+/u', '', $name)), 0, 120);
    return ['bytes' => $buf, 'mime' => $mime, 'name' => $name !== '' ? $name : null];
}
function kyc_store_file(string $bytes): string
{
    $name = bin2hex(random_bytes(20));
    $file = kyc_dir() . "/$name";
    file_put_contents($file, kyc_seal($bytes), LOCK_EX);
    @chmod($file, 0600);
    return $name;
}
function kyc_delete_file(?string $name): void
{
    if ($name && preg_match('/^[0-9a-f]{40}$/', $name) && is_file(kyc_dir() . "/$name")) @unlink(kyc_dir() . "/$name");
}

// ============================================================== state
function kyc_profile(string $orgId): array
{
    $v = row('SELECT * FROM organiser_verification WHERE organiser_id = ?', [$orgId]);
    if ($v) return $v;
    return ['organiser_id' => $orgId, 'entity_type' => 'individual', 'nationality' => 'sa', 'legal_name' => null, 'id_number_enc' => null, 'id_number_last4' => null,
        'id_dob' => null, 'registration_number' => null, 'rep_is_director' => 1, 'plans_paid' => 0, 'terms_version' => null, 'terms_signed_at' => null, 'terms_signed_by' => null,
        'terms_signed_name' => null, 'terms_ip' => null, 'risk_override' => null, 'risk_note' => null, 'completed_at' => null, 'completed_scope' => null, 'closed_at' => null, 'updated_at' => null];
}
function kyc_profile_save(string $orgId, array $fields): void
{
    $cur = row('SELECT organiser_id FROM organiser_verification WHERE organiser_id = ?', [$orgId]);
    $fields['updated_at'] = now_iso();
    if (!$cur) { insert('organiser_verification', ['organiser_id' => $orgId] + $fields); return; }
    $sets = implode(', ', array_map(fn($k) => "$k = ?", array_keys($fields)));
    q("UPDATE organiser_verification SET $sets WHERE organiser_id = ?", [...array_values($fields), $orgId]);
}
// Does this organiser sell paid tickets (or say they will)?
function kyc_sells_paid(string $orgId, array $v): bool
{
    if ((int) $v['plans_paid'] === 1) return true;
    return (bool) val("SELECT 1 FROM ticket_types tt JOIN events e ON e.id = tt.event_id WHERE e.organiser_id = ? AND e.status <> 'cancelled' AND tt.price_cents > 0 LIMIT 1", [$orgId]);
}
// The latest document for each requirement (replaced ones are history).
function kyc_docs(string $orgId, ?string $eventId = null): array
{
    $list = rows('SELECT d.*, u.full_name AS reviewer_name FROM verification_documents d LEFT JOIN users u ON u.id = d.reviewed_by
                   WHERE d.organiser_id = ? AND ' . ($eventId ? 'd.event_id = ?' : 'd.event_id IS NULL') . " AND d.status <> 'replaced' ORDER BY d.created_at DESC",
        $eventId ? [$orgId, $eventId] : [$orgId]);
    $out = [];
    foreach ($list as $d) $out[$d['requirement']] ??= $d;
    return $out;
}
function kyc_doc_view(?array $d): ?array
{
    if (!$d) return null;
    return ['id' => $d['id'], 'status' => $d['status'], 'mimeType' => $d['mime_type'], 'sizeBytes' => (int) $d['size_bytes'], 'fileName' => $d['original_name'],
        'uploadedAt' => $d['created_at'], 'reviewedAt' => $d['reviewed_at'], 'reviewedBy' => $d['reviewed_by'] ? ($d['reviewer_name'] ?? 'TicketRoom') : ($d['reviewed_at'] ? 'Automatic check' : null),
        'rejectReason' => $d['reject_reason'], 'deleted' => $d['deleted_at'] !== null,
        'provider' => $d['provider'] ? ['name' => $d['provider'], 'label' => kyc_provider_label($d['provider']), 'outcome' => $d['provider_status'], 'message' => $d['provider_message'],
            'reference' => $d['provider_ref'], 'checkedAt' => $d['provider_checked_at'], 'simulated' => $d['provider'] === 'sandbox'] : null];
}

// Organiser-level requirements. 'needFor' says what each one unlocks:
// free_events / paid_events (submit and go live) and payouts.
function kyc_org_items(array $v, bool $paid): array
{
    $type = $v['entity_type'];
    $events = ['free_events', 'paid_events', 'payouts'];
    $keys = [];
    if ($type === 'individual') {
        $keys = ['id_document' => $events];
    } elseif ($type === 'company') {
        $keys = ['cipc_certificate' => $events, 'rep_id' => $events];
        if (!(int) $v['rep_is_director']) $keys['authorisation_letter'] = $events;
    } else {
        $keys = ['npo_certificate' => $events, 'constitution' => $events, 'rep_id' => $events, 'resolution' => $events];
    }
    $keys['terms'] = $events;
    $keys['email'] = $events;
    $keys['phone'] = [];
    if ($paid) {
        if ($type === 'individual') $keys['proof_of_address'] = ['payouts'];
        if ($type === 'company') $keys['business_address'] = ['payouts'];
        $keys['bank_confirmation'] = ['payouts'];
    }
    $out = [];
    foreach ($keys as $k => $need) {
        $label = KYC_ITEMS[$k]['label'];
        if ($k === 'id_document' && $v['nationality'] === 'foreign') $label = 'Passport';
        if ($k === 'id_document' && $v['nationality'] !== 'foreign') $label = 'SA ID or Smart ID card';
        if ($k === 'bank_confirmation' && $type !== 'individual') $label = 'Business bank confirmation letter';
        $out[] = ['key' => $k, 'label' => $label, 'kind' => KYC_ITEMS[$k]['kind'], 'reason' => KYC_ITEMS[$k]['reason'], 'needFor' => $need, 'required' => $need !== []];
    }
    return $out;
}

// How risky an event is, and why. TicketRoom can override it either way.
function kyc_event_risk(array $ev, array $v, ?array $er = null): array
{
    $er ??= row('SELECT * FROM event_risk WHERE event_id = ?', [$ev['id']]) ?? [];
    $reasons = [];
    $value = (int) val('SELECT COALESCE(SUM(price_cents * quantity_total),0) FROM ticket_types WHERE event_id = ?', [$ev['id']]);
    if ((int) $ev['capacity'] >= KYC_HIGH_CAPACITY) $reasons[] = 'Large event (5 000 people or more)';
    if (($ev['category'] ?? '') === 'festival') $reasons[] = 'Festival';
    if ($value >= KYC_HIGH_VALUE_CENTS) $reasons[] = 'High value (R1 million or more in tickets on sale)';
    $past = (int) val("SELECT count(*) FROM events WHERE organiser_id = ? AND id <> ? AND status IN ('published','completed') AND ends_at < ?", [$ev['organiser_id'], $ev['id'], now_iso()]);
    if ($past === 0 && $value >= KYC_NEW_ORG_VALUE_CENTS) $reasons[] = 'New organiser selling a lot (R100 000 or more in tickets)';
    $override = $er['risk_override'] ?? null;
    $orgOverride = $v['risk_override'] ?? null;
    $level = $reasons ? 'high' : 'normal';
    if ($orgOverride === 'high') { $level = 'high'; $reasons[] = 'Organiser marked high risk by TicketRoom'; }
    if ($override === 'high') { $level = 'high'; $reasons[] = 'Event marked high risk by TicketRoom'; }
    if ($override === 'normal' || ($orgOverride === 'normal' && $override !== 'high')) { $level = 'normal'; $reasons[] = 'Extra checks waived by TicketRoom'; }
    return ['level' => $level, 'reasons' => $reasons, 'override' => $override, 'valueCents' => $value,
        'declared' => ['sellsAlcohol' => (bool) ($er['sells_alcohol'] ?? false), 'publicSpace' => (bool) ($er['public_space'] ?? false), 'thirdParty' => (bool) ($er['third_party'] ?? false)]];
}
function kyc_event_paid(array $ev): bool
{
    return !$ev['is_free'] && (bool) val('SELECT 1 FROM ticket_types WHERE event_id = ? AND price_cents > 0 LIMIT 1', [$ev['id']]);
}
// Per-event documents. 'required' items block submitting and going live;
// 'recommended' ones never block.
function kyc_event_items(array $ev, array $risk): array
{
    $high = $risk['level'] === 'high';
    $big = (int) $ev['capacity'] >= KYC_LARGE_CAPACITY;
    $d = $risk['declared'];
    $paid = kyc_event_paid($ev);
    $want = [];
    if ($high) $want['venue_agreement'] = 'required';
    elseif ($paid) $want['venue_agreement'] = 'recommended';
    if ($big || $d['publicSpace']) $want['event_permit'] = 'required';
    if ($d['sellsAlcohol']) $want['liquor_licence'] = 'required';
    if ($big || $high) $want['liability_insurance'] = 'required';
    if ($d['thirdParty']) $want['artist_authorisation'] = 'required';
    if ($big) $want['safety_plan'] = 'required';
    if ($high) foreach (['previous_events', 'supplier_agreements', 'ticket_authority', 'extra_verification', 'financial_info'] as $k) $want[$k] = 'required';
    $out = [];
    foreach ($want as $k => $need) {
        $reason = KYC_ITEMS[$k]['reason'];
        if ($k === 'venue_agreement') $reason = $high ? 'High-risk event: confirms the venue is booked for your date.' : 'Recommended for paid events: buyers trust events with a confirmed venue.';
        if ($k === 'event_permit' && !$big) $reason = 'You said the event is in a public space (park, street or beach), which needs municipal approval.';
        if ($k === 'liability_insurance' && !$big) $reason = 'High-risk event: it must be insured in case someone is hurt.';
        $out[] = ['key' => $k, 'label' => KYC_ITEMS[$k]['label'], 'kind' => 'document', 'reason' => $reason, 'needFor' => $need === 'required' ? ['publish'] : [], 'required' => $need === 'required', 'recommended' => $need === 'recommended'];
    }
    return $out;
}

// Puts a status on each item: missing, submitted, approved, rejected
// (and not_verified for the phone, recommended for optional event items).
function kyc_with_status(array $items, array $docs, array $v, string $orgId): array
{
    $emailOk = (bool) val("SELECT 1 FROM organiser_members m JOIN users u ON u.id = m.user_id WHERE m.organiser_id = ? AND m.role = 'owner' AND u.email_verified_at IS NOT NULL LIMIT 1", [$orgId]);
    foreach ($items as &$it) {
        $doc = $docs[$it['key']] ?? null;
        $it['document'] = kyc_doc_view($doc);
        $it['status'] = match ($it['kind']) {
            'terms' => ($v['terms_signed_at'] && $v['terms_version'] === KYC_TERMS_VERSION) ? 'approved' : 'missing',
            'check' => $it['key'] === 'email' ? ($emailOk ? 'approved' : 'missing') : 'not_verified',
            default => $doc && !$doc['deleted_at'] ? $doc['status'] : 'missing',
        };
        $it['rejectReason'] = $it['status'] === 'rejected' ? ($doc['reject_reason'] ?? null) : null;
        if ($it['kind'] === 'terms' && $it['status'] === 'approved') $it['signed'] = ['name' => $v['terms_signed_name'], 'at' => $v['terms_signed_at'], 'version' => $v['terms_version']];
    }
    return $items;
}
function kyc_state(string $orgId): array
{
    $org = row('SELECT * FROM organisers WHERE id = ?', [$orgId]);
    if (!$org) throw not_found('Organiser not found.');
    $v = kyc_profile($orgId);
    $paid = kyc_sells_paid($orgId, $v);
    $items = kyc_with_status(kyc_org_items($v, $paid), kyc_docs($orgId), $v, $orgId);
    return ['org' => $org, 'v' => $v, 'paid' => $paid, 'items' => $items];
}
function kyc_event_state(array $ev, array $state): array
{
    $risk = kyc_event_risk($ev, $state['v']);
    $items = kyc_with_status(kyc_event_items($ev, $risk), kyc_docs($ev['organiser_id'], $ev['id']), $state['v'], $ev['organiser_id']);
    return ['risk' => $risk, 'items' => $items, 'paid' => kyc_event_paid($ev)];
}
// Labels of the items still holding something up. $level 'submitted' lets
// documents waiting for review through (submitting an event); 'approved'
// needs them reviewed (going live, payouts).
function kyc_missing(array $items, string $need, string $level): array
{
    $out = [];
    foreach ($items as $it) {
        if (!in_array($need, $it['needFor'], true)) continue;
        $ok = $it['status'] === 'approved' || ($level === 'submitted' && $it['status'] === 'submitted');
        if (!$ok) $out[] = $it['label'];
    }
    return $out;
}
function kyc_overall(array $items): string
{
    $req = array_filter($items, fn($i) => $i['required']);
    if (!array_filter($req, fn($i) => $i['status'] !== 'approved')) return 'complete';
    if (!array_filter($req, fn($i) => in_array($i['status'], ['missing', 'rejected'], true))) return 'in_review';
    return 'action_needed';
}
function kyc_gates(array $state): array
{
    $it = $state['items'];
    $g = fn(string $need, string $level) => ['ok' => !($m = kyc_missing($it, $need, $level)), 'missing' => $m];
    return [
        'freeSubmit' => $g('free_events', 'submitted'), 'freePublish' => $g('free_events', 'approved'),
        'paidSubmit' => $g('paid_events', 'submitted'), 'paidPublish' => $g('paid_events', 'approved'),
        'payouts' => $state['paid'] ? $g('payouts', 'approved') : ['ok' => false, 'missing' => ['Bank confirmation letter']],
    ];
}
function kyc_list_text(array $labels): string
{
    if (count($labels) <= 1) return $labels[0] ?? '';
    return implode(', ', array_slice($labels, 0, -1)) . ' and ' . end($labels);
}

// ============================================================== enforcement
// Called when an organiser submits an event ('submitted') and when TicketRoom
// publishes it ('approved').
function kyc_require_for_event(array $ev, string $level): void
{
    $state = kyc_state($ev['organiser_id']);
    $paid = kyc_event_paid($ev);
    $missing = kyc_missing($state['items'], $paid ? 'paid_events' : 'free_events', $level);
    $es = kyc_event_state($ev, $state);
    $evMissing = kyc_missing($es['items'], 'publish', $level);
    if (!$missing && !$evMissing) return;
    $who = $level === 'submitted' ? 'Before you submit this event, add' : "This organiser's verification is not approved yet:";
    $what = kyc_list_text(array_merge($missing, $evMissing));
    $msg = $level === 'submitted'
        ? "$who: $what. Open Verification" . ($evMissing ? ' and the event\'s Permits & checks tab' : '') . ' to upload them.'
        : "$who $what. Review them under Verification first.";
    throw conflict($msg, 'verification_required', ['missing' => $missing, 'eventMissing' => $evMissing, 'paid' => $paid]);
}
function kyc_require_for_payout(string $orgId): void
{
    $state = kyc_state($orgId);
    $missing = $state['paid'] ? kyc_missing($state['items'], 'payouts', 'approved') : ['Bank confirmation letter'];
    if (!$missing) return;
    $bank = in_array('Bank confirmation letter', $missing, true) || in_array('Business bank confirmation letter', $missing, true);
    throw conflict(($bank ? 'Payouts start once your bank account is verified. ' : '') . 'Still needed: ' . kyc_list_text($missing) . '. Upload them under Verification.',
        $bank ? 'bank_not_verified' : 'verification_required', ['missing' => $missing]);
}

// ============================================================== identity check
function kyc_provider(): string { $p = (string) (cfg('kyc.provider') ?? 'manual'); return in_array($p, ['manual', 'sandbox', 'http'], true) ? $p : 'manual'; }
function kyc_provider_label(string $p): string
{
    return ['manual' => 'TicketRoom staff review', 'sandbox' => 'Identity sandbox (simulated)', 'http' => 'Your identity provider'][$p] ?? $p;
}
function kyc_http_url_ok(string $url): bool
{
    $p = parse_url($url);
    if (cfg('kyc.allowPrivateHosts', false)) return !empty($p['host']); // test setups only (config file)
    if (($p['scheme'] ?? '') !== 'https' || empty($p['host']) || isset($p['user'])) return false;
    $ips = @gethostbynamel($p['host']) ?: [];
    if (!$ips) return false;
    foreach ($ips as $ip) if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) return false;
    return true;
}
// The sandbox decides by a published test rule, never by a real check:
//   SA ID numbers: 7th to 10th digits 0000 = declined, 0001 = referred to
//   staff, anything else that passes the local checks = verified.
//   Passports: ending in 000 = declined, 001 = referred, else verified.
const KYC_SANDBOX_RULE = 'Simulated, nothing real is checked. SA ID numbers whose 7th to 10th digits are 0000 are declined, 0001 are sent to staff review, and any other valid number is verified. Passport numbers ending in 000 are declined, 001 sent to staff review, others verified.';
function kyc_sandbox_decide(string $type, string $number): array
{
    $tail = $type === 'sa_id' ? substr($number, 6, 4) : substr($number, -3);
    $declined = $type === 'sa_id' ? '0000' : '000';
    $refer = $type === 'sa_id' ? '0001' : '001';
    if ($tail === $declined) return ['status' => 'declined', 'message' => 'Simulated: the identity could not be confirmed (sandbox test rule).', 'reference' => 'SBX-' . random_code(8)];
    if ($tail === $refer) return ['status' => 'refer', 'message' => 'Simulated: referred to staff for a manual look (sandbox test rule).', 'reference' => 'SBX-' . random_code(8)];
    return ['status' => 'verified', 'message' => 'Simulated: identity confirmed (sandbox test rule).', 'reference' => 'SBX-' . random_code(8)];
}
// Asks the configured provider. Returns status verified / declined / refer / error.
function kyc_identity_check(array $subject): array
{
    $p = kyc_provider();
    if ($p === 'manual') return ['provider' => 'manual', 'status' => 'manual', 'message' => 'TicketRoom staff will check this document.', 'reference' => null];
    if ($p === 'sandbox') return ['provider' => 'sandbox'] + kyc_sandbox_decide($subject['type'], $subject['number']);
    $url = (string) cfg('kyc.httpUrl', '');
    if (!kyc_http_url_ok($url)) return ['provider' => 'http', 'status' => 'error', 'message' => 'The provider address must start with https:// and be on the public internet.', 'reference' => null];
    $headers = ['Content-Type' => 'application/json', 'Accept' => 'application/json'];
    if ((string) cfg('kyc.httpAuth', '') !== '') $headers['Authorization'] = (string) cfg('kyc.httpAuth');
    try {
        $r = http_request('POST', $url, $headers, json_encode(['reference' => $subject['reference'], 'documentType' => $subject['type'], 'idNumber' => $subject['number'],
            'fullName' => $subject['name'], 'dateOfBirth' => $subject['dob'] ?? null, 'country' => $subject['type'] === 'sa_id' ? 'ZA' : null]), 20);
    } catch (Throwable $e) {
        return ['provider' => 'http', 'status' => 'error', 'message' => mb_substr(integration_scrub($e->getMessage()), 0, 200), 'reference' => null];
    }
    $j = is_array($r['json']) ? $r['json'] : [];
    if ($r['status'] < 200 || $r['status'] >= 300) return ['provider' => 'http', 'status' => 'error', 'message' => "The provider answered HTTP {$r['status']}.", 'reference' => null];
    $s = strtolower((string) ($j['status'] ?? $j['result'] ?? ''));
    $status = in_array($s, ['verified', 'pass', 'passed', 'match', 'approved'], true) ? 'verified' : (in_array($s, ['declined', 'fail', 'failed', 'no_match', 'rejected'], true) ? 'declined' : 'refer');
    return ['provider' => 'http', 'status' => $status, 'message' => mb_substr(integration_scrub((string) ($j['message'] ?? $j['reason'] ?? '')), 0, 200) ?: null,
        'reference' => mb_substr((string) ($j['reference'] ?? $j['id'] ?? ''), 0, 80) ?: null];
}
// Runs the identity check on an uploaded ID document. Verified: approved
// automatically. Declined by the sandbox: rejected (it is a test). Declined
// by a real provider, referred or failed: left for staff, with the outcome shown.
function kyc_run_identity(array $doc): void
{
    if (!in_array($doc['requirement'], ['id_document', 'rep_id'], true) || $doc['status'] !== 'submitted') return;
    $v = kyc_profile($doc['organiser_id']);
    if (!$v['id_number_enc'] || kyc_provider() === 'manual') return;
    $number = decrypt_str((string) $v['id_number_enc']);
    $type = $v['nationality'] === 'foreign' ? 'passport' : 'sa_id';
    $r = kyc_identity_check(['reference' => $doc['id'], 'type' => $type, 'number' => $number, 'name' => (string) $v['legal_name'], 'dob' => $v['id_dob']]);
    tx(function () use ($doc, $r) {
        q('UPDATE verification_documents SET provider = ?, provider_status = ?, provider_message = ?, provider_ref = ?, provider_checked_at = ? WHERE id = ?',
            [$r['provider'], $r['status'], $r['message'], $r['reference'], now_iso(), $doc['id']]);
        audit('verification.identity_checked', ['actor' => ['id' => null, 'primaryRole' => 'system'], 'actorRole' => 'system', 'entityType' => 'verification_document', 'entityId' => $doc['id'],
            'organiserId' => $doc['organiser_id'], 'details' => ['provider' => $r['provider'], 'outcome' => $r['status']]]);
        if ($r['status'] === 'verified') kyc_decide($doc['id'], true, null, null);
        elseif ($r['status'] === 'declined' && $r['provider'] === 'sandbox') kyc_decide($doc['id'], false, 'The identity check could not confirm this ID (sandbox test). Check your ID number and upload a clear copy.', null);
    });
}

// ============================================================== review
// Approve or reject one document. $actor null = an automatic check.
function kyc_decide(string $docId, bool $approve, ?string $reason, ?array $actor): array
{
    return tx(function () use ($docId, $approve, $reason, $actor) {
        $d = row('SELECT * FROM verification_documents WHERE id = ?', [$docId]);
        if (!$d) throw not_found('Document not found.');
        if ($d['status'] !== 'submitted') throw conflict('This document has already been reviewed or replaced.', 'bad_transition');
        $now = now_iso();
        q('UPDATE verification_documents SET status = ?, reject_reason = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?',
            [$approve ? 'approved' : 'rejected', $approve ? null : $reason, $actor['id'] ?? null, $now, $d['id']]);
        audit($approve ? 'verification.document_approved' : 'verification.document_rejected', ['actor' => $actor ?? ['id' => null], 'actorRole' => $actor ? null : 'system',
            'entityType' => 'verification_document', 'entityId' => $d['id'], 'organiserId' => $d['organiser_id'], 'details' => ['requirement' => $d['requirement'], 'eventId' => $d['event_id'], 'reason' => $reason]]);
        $label = kyc_item_label($d['requirement'], $d['organiser_id']);
        $ev = $d['event_id'] ? row('SELECT title FROM events WHERE id = ?', [$d['event_id']]) : null;
        foreach (kyc_owners($d['organiser_id']) as $o) {
            outbox_enqueue(['to' => $o['email'], 'userId' => $o['id']] + tpl($approve ? 'verificationApproved' : 'verificationRejected',
                ['name' => $o['full_name'], 'organiser' => $o['org_name'], 'document' => $label, 'event' => $ev['title'] ?? null, 'reason' => $reason]));
        }
        kyc_check_complete($d['organiser_id']);
        return row('SELECT * FROM verification_documents WHERE id = ?', [$d['id']]);
    });
}
function kyc_item_label(string $key, string $orgId): string
{
    $v = kyc_profile($orgId);
    foreach (kyc_org_items($v, true) as $it) if ($it['key'] === $key) return $it['label'];
    return KYC_ITEMS[$key]['label'] ?? $key;
}
function kyc_owners(string $orgId): array
{
    return rows("SELECT u.id, u.email, u.full_name, o.name AS org_name FROM organiser_members m JOIN users u ON u.id = m.user_id JOIN organisers o ON o.id = m.organiser_id
                  WHERE m.organiser_id = ? AND m.role = 'owner' AND u.status = 'active'", [$orgId]);
}
// "Verification complete" goes out once each time everything the organiser
// needs (for what they do now) has been approved.
function kyc_check_complete(string $orgId): void
{
    $state = kyc_state($orgId);
    $scope = $state['v']['entity_type'] . ($state['paid'] ? ':paid' : ':free');
    if (kyc_overall($state['items']) !== 'complete') return;
    if (($state['v']['completed_scope'] ?? null) === $scope) return;
    kyc_profile_save($orgId, ['completed_at' => now_iso(), 'completed_scope' => $scope]);
    audit('verification.completed', ['actor' => ['id' => null], 'actorRole' => 'system', 'entityType' => 'organiser', 'entityId' => $orgId, 'organiserId' => $orgId, 'details' => ['scope' => $scope]]);
    foreach (kyc_owners($orgId) as $o) {
        outbox_enqueue(['to' => $o['email'], 'userId' => $o['id']] + tpl('verificationComplete', ['name' => $o['full_name'], 'organiser' => $o['org_name'], 'paid' => $state['paid']]));
    }
}

// ============================================================== retention (POPIA)
// FICA records are kept for the set number of years after an organiser
// closes (default 5, the period FICA requires), then deleted. Replaced and
// rejected documents are not needed as records and go after a shorter time.
function kyc_retention(): int
{
    $s = kyc_settings();
    $n = 0;
    $cut = iso_in(-$s['discardRejectedDays'] * 86400);
    foreach (rows("SELECT id, file_name, organiser_id FROM verification_documents WHERE deleted_at IS NULL AND status IN ('rejected','replaced') AND COALESCE(reviewed_at, replaced_at, created_at) < ? LIMIT 200", [$cut]) as $d) {
        kyc_delete_file($d['file_name']);
        q('UPDATE verification_documents SET deleted_at = ? WHERE id = ?', [now_iso(), $d['id']]);
        $n++;
    }
    $closedCut = iso_at(time() - $s['retentionYears'] * 365.25 * 86400);
    foreach (rows('SELECT organiser_id FROM organiser_verification WHERE closed_at IS NOT NULL AND closed_at < ?', [$closedCut]) as $o) {
        $docs = rows('SELECT id, file_name FROM verification_documents WHERE organiser_id = ? AND deleted_at IS NULL', [$o['organiser_id']]);
        foreach ($docs as $d) { kyc_delete_file($d['file_name']); q('UPDATE verification_documents SET deleted_at = ? WHERE id = ?', [now_iso(), $d['id']]); $n++; }
        $had = val('SELECT id_number_enc FROM organiser_verification WHERE organiser_id = ?', [$o['organiser_id']]);
        if ($docs || $had) {
            q('UPDATE organiser_verification SET id_number_enc = NULL, id_number_last4 = NULL, id_dob = NULL, updated_at = ? WHERE organiser_id = ?', [now_iso(), $o['organiser_id']]);
            audit('verification.retention_deleted', ['actor' => ['id' => null], 'actorRole' => 'system', 'entityType' => 'organiser', 'entityId' => $o['organiser_id'], 'organiserId' => $o['organiser_id'], 'details' => ['documents' => count($docs)]]);
        }
    }
    return $n;
}

// ============================================================== views
function kyc_profile_view(array $v): array
{
    return ['entityType' => $v['entity_type'], 'nationality' => $v['nationality'], 'legalName' => $v['legal_name'], 'idNumberMasked' => kyc_mask($v['id_number_last4']),
        'hasIdNumber' => (bool) $v['id_number_enc'], 'dateOfBirth' => $v['id_dob'], 'registrationNumber' => $v['registration_number'], 'repIsDirector' => (bool) $v['rep_is_director'],
        'plansPaid' => (bool) $v['plans_paid'], 'riskOverride' => $v['risk_override'], 'riskNote' => $v['risk_note'], 'closedAt' => $v['closed_at'], 'completedAt' => $v['completed_at']];
}
// Everything the Verification page shows. $full: owners and staff (documents,
// what is held, who looked); other team members get the checklist only.
function kyc_view(string $orgId, bool $full): array
{
    $state = kyc_state($orgId);
    $events = [];
    foreach (rows("SELECT * FROM events WHERE organiser_id = ? AND status NOT IN ('cancelled','completed') ORDER BY starts_at", [$orgId]) as $ev) {
        $es = kyc_event_state($ev, $state);
        $events[] = ['id' => $ev['id'], 'ref' => $ev['ref'], 'title' => $ev['title'], 'status' => $ev['status'], 'startsAt' => $ev['starts_at'], 'capacity' => (int) $ev['capacity'], 'paid' => $es['paid'],
            'risk' => $es['risk'], 'requirements' => $full ? $es['items'] : array_map(fn($i) => array_diff_key($i, ['document' => 1]), $es['items']),
            'status_overall' => kyc_overall($es['items'])];
    }
    $s = kyc_settings();
    $out = [
        'overall' => kyc_overall($state['items']), 'sellsPaid' => $state['paid'], 'entityNames' => KYC_ENTITY_NAMES,
        'requirements' => $full ? $state['items'] : array_map(fn($i) => array_diff_key($i, ['document' => 1]), $state['items']),
        'gates' => kyc_gates($state), 'events' => $events,
        'provider' => ['name' => kyc_provider(), 'label' => kyc_provider_label(kyc_provider()), 'simulated' => kyc_provider() === 'sandbox', 'rule' => kyc_provider() === 'sandbox' ? KYC_SANDBOX_RULE : null],
        'limits' => ['maxBytes' => kyc_max_bytes(), 'types' => array_keys(KYC_TYPES)], 'termsVersion' => KYC_TERMS_VERSION,
        'retention' => ['years' => $s['retentionYears'], 'discardRejectedDays' => $s['discardRejectedDays']],
        'bank' => ['last4' => $state['org']['bank_account_last4'], 'bankName' => $state['org']['bank_name']],
    ];
    if ($full) {
        $out['profile'] = kyc_profile_view($state['v']);
        $out['held'] = array_map(function ($d) use ($orgId) {
            return ['id' => $d['id'], 'label' => kyc_item_label($d['requirement'], $orgId), 'event' => $d['event_title'], 'status' => $d['status'], 'uploadedAt' => $d['created_at'],
                'sizeBytes' => (int) $d['size_bytes'], 'deletedAt' => $d['deleted_at']];
        }, rows('SELECT d.*, e.title AS event_title FROM verification_documents d LEFT JOIN events e ON e.id = d.event_id WHERE d.organiser_id = ? ORDER BY d.created_at DESC LIMIT 200', [$orgId]));
        $out['accessLog'] = array_map(fn($r) => ['at' => $r['occurred_at'], 'who' => $r['actor_role'] === 'user' || $r['actor_role'] === 'owner' ? 'Your team' : 'TicketRoom ' . $r['actor_role'],
            'action' => ['verification.document_viewed' => 'Viewed a document', 'verification.id_revealed' => 'Viewed your ID number', 'verification.bank_revealed' => 'Viewed your bank account number'][$r['action']] ?? $r['action']],
            rows("SELECT occurred_at, action, actor_role FROM audit_log WHERE organiser_id = ? AND action IN ('verification.document_viewed','verification.id_revealed','verification.bank_revealed') ORDER BY id DESC LIMIT 50", [$orgId]));
    }
    return $out;
}
