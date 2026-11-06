<?php
// Organiser verification (FICA / KYC): the organiser's checklist, uploads and
// signed terms; the private document download; and TicketRoom's review queue.
// Rules and storage: lib/verification.php.
declare(strict_types=1);

const KYC_REVIEW_ROLES = ['admin', 'support'];
// Finance may also decide the money documents.
const KYC_FINANCE_ITEMS = ['bank_confirmation', 'proof_of_address', 'business_address'];
const KYC_REG_PATTERNS = ['company' => '#^\d{4}/\d{6}/\d{2}$#', 'npo' => '#^\d{3}-\d{3}( NPO)?$#i'];

function kyc_owner(string $orgId): array
{
    $u = require_auth();
    ['organiser' => $org] = organiser_access($u, $orgId, ['owner']);
    return [$u, $org];
}

// ============================================================== organiser
route('GET', '/api/organiser/:orgId/verification', function ($a) {
    ['role' => $role] = organiser_access(require_auth(), $a['orgId'], ORG_ALL);
    return ['verification' => kyc_view($a['orgId'], $role === 'owner') + ['canManage' => $role === 'owner']];
});

// Who the organiser is. Only what the rules need: the kind of organiser, the
// person's name and ID or passport number, and a registration number for
// companies and NPOs. The ID number is checked here and stored encrypted.
route('PUT', '/api/organiser/:orgId/verification/profile', function ($a) {
    [$u] = kyc_owner($a['orgId']);
    limit('kycprofile', 30, 3600, $u['id']);
    $b = check(body(), [
        'entityType' => R::oneOf(array_keys(KYC_ENTITY_NAMES)), 'nationality' => R::oneOf(['sa', 'foreign']),
        'legalName' => R::str(['min' => 2, 'max' => 120]), 'idNumber' => R::str(['optional' => true, 'max' => 20]),
        'registrationNumber' => R::str(['optional' => true, 'max' => 20]), 'repIsDirector' => org_bool(['optional' => true, 'fallback' => true]),
        'plansPaid' => org_bool(['optional' => true, 'fallback' => false]),
    ]);
    $cur = kyc_profile($a['orgId']);
    $fields = ['entity_type' => $b['entityType'], 'nationality' => $b['nationality'], 'legal_name' => $b['legalName'],
        'rep_is_director' => $b['entityType'] === 'company' ? ($b['repIsDirector'] ? 1 : 0) : 1, 'plans_paid' => $b['plansPaid'] ? 1 : 0];
    $newId = false;
    if (($b['idNumber'] ?? '') !== '') {
        $c = $b['nationality'] === 'foreign' ? passport_check($b['idNumber']) : sa_id_check($b['idNumber']);
        if (!$c['ok']) throw invalid(['idNumber' => $c['error']]);
        $newId = !$cur['id_number_enc'] || decrypt_str((string) $cur['id_number_enc']) !== $c['id'];
        $fields += ['id_number_enc' => encrypt_str($c['id']), 'id_number_last4' => substr($c['id'], -4), 'id_dob' => $c['dob'] ?? null];
    } elseif (!$cur['id_number_enc']) {
        throw invalid(['idNumber' => $b['nationality'] === 'foreign' ? 'Enter your passport number.' : 'Enter your ID number.']);
    } elseif ($cur['nationality'] !== $b['nationality']) {
        throw invalid(['idNumber' => 'Enter the number again for the new document type.']);
    }
    if ($b['entityType'] !== 'individual') {
        $reg = strtoupper(trim($b['registrationNumber'] ?? ''));
        if (!preg_match(KYC_REG_PATTERNS[$b['entityType']], $reg)) {
            throw invalid(['registrationNumber' => $b['entityType'] === 'company' ? 'Use the CIPC format, for example 2019/123456/07.' : 'Use the NPO format, for example 123-456 NPO.']);
        }
        $fields['registration_number'] = $reg;
    } else {
        $fields['registration_number'] = null;
    }
    tx(function () use ($a, $u, $fields, $cur, $newId) {
        kyc_profile_save($a['orgId'], $fields);
        $v = kyc_profile($a['orgId']);
        $now = now_iso();
        // Documents for another kind of organiser are no longer needed, and a new
        // ID number needs a new ID document.
        $keep = array_column(kyc_org_items($v, true), 'key');
        $old = rows("SELECT id, requirement FROM verification_documents WHERE organiser_id = ? AND event_id IS NULL AND status IN ('submitted','approved')", [$a['orgId']]);
        foreach ($old as $d) {
            $drop = !in_array($d['requirement'], $keep, true) || ($newId && $cur['id_number_enc'] && in_array($d['requirement'], ['id_document', 'rep_id'], true));
            if ($drop) q("UPDATE verification_documents SET status = 'replaced', replaced_at = ? WHERE id = ?", [$now, $d['id']]);
        }
        audit('verification.profile_saved', ['actor' => $u, 'entityType' => 'organiser', 'entityId' => $a['orgId'], 'organiserId' => $a['orgId'],
            'details' => ['entityType' => $fields['entity_type'], 'nationality' => $fields['nationality'], 'idChanged' => $newId, 'plansPaid' => (bool) $fields['plans_paid']]]);
    });
    // An ID document waiting for a number can be checked now.
    if ($newId) foreach (rows("SELECT * FROM verification_documents WHERE organiser_id = ? AND event_id IS NULL AND requirement IN ('id_document','rep_id') AND status = 'submitted'", [$a['orgId']]) as $d) kyc_run_identity($d);
    return ['verification' => kyc_view($a['orgId'], true) + ['canManage' => true]];
});

// Signing the organiser terms: the typed full name, the time, the account and
// the IP address are the signature record.
route('POST', '/api/organiser/:orgId/verification/terms', function ($a) {
    [$u] = kyc_owner($a['orgId']);
    $b = check(body(), ['fullName' => R::str(['min' => 2, 'max' => 120]), 'accept' => R::bool()]);
    if (!$b['accept']) throw invalid(['accept' => 'Tick the box to accept the terms.']);
    tx(function () use ($a, $u, $b) {
        kyc_profile_save($a['orgId'], ['terms_version' => KYC_TERMS_VERSION, 'terms_signed_at' => now_iso(), 'terms_signed_by' => $u['id'], 'terms_signed_name' => $b['fullName'], 'terms_ip' => client_ip()]);
        audit('verification.terms_signed', ['actor' => $u, 'entityType' => 'organiser', 'entityId' => $a['orgId'], 'organiserId' => $a['orgId'], 'ip' => client_ip(), 'details' => ['version' => KYC_TERMS_VERSION]]);
        kyc_check_complete($a['orgId']);
    });
    return ['verification' => kyc_view($a['orgId'], true) + ['canManage' => true]];
});

// One document: ?requirement=id_document (and &eventId=… for an event's
// permits). The body is the file itself (PDF, JPG or PNG, up to 10 MB).
route('POST', '/api/organiser/:orgId/verification/documents', function ($a) {
    [$u, $org] = kyc_owner($a['orgId']);
    limit('kycupload', 60, 3600, $u['id']);
    $req = (string) qs('requirement', '');
    $eventId = qs('eventId');
    $state = kyc_state($org['id']);
    $v = $state['v'];
    if ($eventId) {
        $ev = row('SELECT * FROM events WHERE id = ? AND organiser_id = ?', [$eventId, $org['id']]);
        if (!$ev) throw not_found('Event not found.');
        if (in_array($ev['status'], ['cancelled', 'completed'], true)) throw conflict('This event has ended or was cancelled.', 'event_locked');
        $allowed = array_column(kyc_event_state($ev, $state)['items'], 'key');
    } else {
        $allowed = array_column(array_filter($state['items'], fn($i) => $i['kind'] === 'document'), 'key');
    }
    // Only what the rules ask of this organiser (POPIA: collect no more than needed).
    if (!in_array($req, $allowed, true)) throw bad('That document is not needed from you.', ['requirement' => 'Not needed.']);
    if (in_array($req, ['id_document', 'rep_id'], true) && !$v['id_number_enc']) throw conflict('Save your ID or passport number under "About you" first, so we can match it to the document.', 'identity_details_needed');
    if (in_array($req, ['cipc_certificate', 'npo_certificate'], true) && !$v['registration_number']) throw conflict('Save the registration number under "About you" first.', 'registration_needed');
    if ($req === 'bank_confirmation' && !$org['bank_account_last4']) throw conflict('Add your bank details in Settings first, then upload the letter for that account.', 'no_bank_details');
    $f = kyc_read_upload();
    $file = kyc_store_file($f['bytes']);
    try {
        $doc = tx(function () use ($org, $eventId, $req, $f, $file, $u) {
            $now = now_iso();
            q("UPDATE verification_documents SET status = 'replaced', replaced_at = ? WHERE organiser_id = ? AND " . ($eventId ? 'event_id = ?' : 'event_id IS NULL') . " AND requirement = ? AND status IN ('submitted','approved','rejected')",
                $eventId ? [$now, $org['id'], $eventId, $req] : [$now, $org['id'], $req]);
            $d = insert('verification_documents', ['id' => uuid(), 'organiser_id' => $org['id'], 'event_id' => $eventId ?: null, 'requirement' => $req, 'status' => 'submitted',
                'file_name' => $file, 'original_name' => $f['name'], 'mime_type' => $f['mime'], 'size_bytes' => strlen($f['bytes']), 'sha256' => hash('sha256', $f['bytes']),
                'uploaded_by' => $u['id'], 'created_at' => $now]);
            audit('verification.document_uploaded', ['actor' => $u, 'entityType' => 'verification_document', 'entityId' => $d['id'], 'organiserId' => $org['id'],
                'details' => ['requirement' => $req, 'eventId' => $eventId ?: null, 'type' => $f['mime'], 'bytes' => strlen($f['bytes'])]]);
            return $d;
        });
    } catch (Throwable $e) {
        kyc_delete_file($file);
        throw $e;
    }
    kyc_run_identity(row('SELECT * FROM verification_documents WHERE id = ?', [$doc['id']]));
    return json_out(['document' => kyc_doc_view(row('SELECT * FROM verification_documents WHERE id = ?', [$doc['id']]))], 201);
});

// What the organiser tells us about an event decides which permits it needs.
route('PUT', '/api/organiser/:orgId/events/:eventId/risk', function ($a) {
    $u = require_auth();
    ['event' => $ev] = event_access($u, $a['orgId'], $a['eventId'], ORG_EDIT);
    $b = check(body(), ['sellsAlcohol' => R::bool(), 'publicSpace' => R::bool(), 'thirdParty' => R::bool()]);
    q('INSERT INTO event_risk (event_id, sells_alcohol, public_space, third_party, updated_by, updated_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(event_id) DO UPDATE SET sells_alcohol = excluded.sells_alcohol, public_space = excluded.public_space, third_party = excluded.third_party, updated_by = excluded.updated_by, updated_at = excluded.updated_at',
        [$ev['id'], $b['sellsAlcohol'] ? 1 : 0, $b['publicSpace'] ? 1 : 0, $b['thirdParty'] ? 1 : 0, $u['id'], now_iso()]);
    audit('event.risk_declared', ['actor' => $u, 'entityType' => 'event', 'entityId' => $ev['id'], 'organiserId' => $ev['organiser_id'], 'details' => $b]);
    $state = kyc_state($ev['organiser_id']);
    return ['event' => kyc_event_state(row('SELECT * FROM events WHERE id = ?', [$ev['id']]), $state)];
});

// ============================================================== the file itself
// Only the organisation's owners and TicketRoom staff (admin, support,
// finance). Every view is written to the audit log, which the organiser can see.
route('GET', '/api/verification/documents/:id/file', function ($a) {
    $u = require_auth();
    $d = row('SELECT d.*, o.ref AS org_ref FROM verification_documents d JOIN organisers o ON o.id = d.organiser_id WHERE d.id = ?', [$a['id']]);
    if (!$d) throw not_found('Document not found.');
    $staff = has_role($u, 'admin', 'support', 'finance');
    $owner = !$staff && account_type($u) === 'organiser'
        && val("SELECT 1 FROM organiser_members WHERE organiser_id = ? AND user_id = ? AND role = 'owner'", [$d['organiser_id'], $u['id']]);
    if (!$staff && !$owner) throw not_found('Document not found.');
    if ($d['deleted_at']) throw new AppError(410, 'deleted', 'This document was deleted under the keeping rules.');
    limit('kycview', 200, 3600, $u['id']);
    $path = kyc_dir() . '/' . $d['file_name'];
    if (!preg_match('/^[0-9a-f]{40}$/', $d['file_name']) || !is_file($path)) throw not_found('The file is missing.');
    $bytes = kyc_open((string) file_get_contents($path));
    audit('verification.document_viewed', ['actor' => $u, 'entityType' => 'verification_document', 'entityId' => $d['id'], 'organiserId' => $d['organiser_id'], 'ip' => client_ip(),
        'details' => ['requirement' => $d['requirement'], 'by' => $staff ? 'staff' : 'owner']]);
    $ext = KYC_TYPES[$d['mime_type']] ?? 'bin';
    $name = $d['requirement'] . '-' . ($d['org_ref'] ?: 'organiser') . ".$ext";
    return raw_out($bytes, $d['mime_type'], 200, [
        'Content-Disposition' => ($d['mime_type'] === 'application/pdf' ? 'attachment' : 'inline') . "; filename=\"$name\"",
        'Content-Security-Policy' => "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        'Cache-Control' => 'private, no-store', 'X-Content-Type-Options' => 'nosniff', 'Content-Length' => (string) strlen($bytes),
    ]);
});

// ============================================================== TicketRoom staff
function kyc_staff_can_decide(array $u, string $req): bool
{
    return has_role($u, ...KYC_REVIEW_ROLES) || (has_role($u, 'finance') && in_array($req, KYC_FINANCE_ITEMS, true));
}
route('GET', '/api/admin/verification', function () {
    $u = adm_any();
    $status = qs('status', 'submitted');
    if (!in_array($status, ['submitted', 'approved', 'rejected'], true)) $status = 'submitted';
    $list = rows("SELECT d.id, d.organiser_id, d.event_id, d.requirement, d.status, d.mime_type, d.size_bytes, d.created_at, d.reviewed_at, d.reject_reason,
                         d.provider, d.provider_status, d.provider_message, d.provider_ref, o.name AS organiser_name, o.ref AS organiser_ref, o.status AS organiser_status,
                         e.title AS event_title, e.ref AS event_ref, up.full_name AS uploaded_by_name, rv.full_name AS reviewed_by_name
                    FROM verification_documents d JOIN organisers o ON o.id = d.organiser_id LEFT JOIN events e ON e.id = d.event_id
                    LEFT JOIN users up ON up.id = d.uploaded_by LEFT JOIN users rv ON rv.id = d.reviewed_by
                   WHERE d.status = ? AND d.deleted_at IS NULL ORDER BY " . ($status === 'submitted' ? 'd.created_at' : 'd.reviewed_at DESC') . ' LIMIT 300', [$status]);
    foreach ($list as &$d) {
        $d['label'] = kyc_item_label($d['requirement'], $d['organiser_id']);
        $d['canDecide'] = kyc_staff_can_decide($u, $d['requirement']);
        $d['provider_label'] = $d['provider'] ? kyc_provider_label($d['provider']) : null;
    }
    unset($d);
    return ['documents' => $list, 'provider' => ['name' => kyc_provider(), 'label' => kyc_provider_label(kyc_provider()), 'simulated' => kyc_provider() === 'sandbox', 'rule' => kyc_provider() === 'sandbox' ? KYC_SANDBOX_RULE : null],
        'settings' => kyc_settings(), 'counts' => ['submitted' => (int) val("SELECT count(*) FROM verification_documents WHERE status = 'submitted'")]];
});
route('GET', '/api/admin/organisers/:id/verification', function ($a) {
    adm_any();
    $org = row('SELECT id, ref, name, status, contact_email, contact_phone, created_at, approved_at, bank_name, bank_account_holder, bank_account_last4, bank_branch_code FROM organisers WHERE id = ?', [$a['id']]);
    if (!$org) throw not_found('Organiser not found.');
    $owners = rows("SELECT u.full_name, u.email, u.phone, u.email_verified_at IS NOT NULL AS email_verified FROM organiser_members m JOIN users u ON u.id = m.user_id WHERE m.organiser_id = ? AND m.role = 'owner'", [$org['id']]);
    return ['organiser' => $org, 'owners' => $owners, 'verification' => kyc_view($org['id'], true)];
});
route('POST', '/api/admin/verification/documents/:id/decide', function ($a) {
    $u = adm_any();
    limit('kycdecide', 600, 3600, $u['id']);
    $b = check(body(), ['approve' => R::bool(), 'reason' => R::str(['optional' => true, 'max' => 400])]);
    $d = row('SELECT * FROM verification_documents WHERE id = ?', [$a['id']]);
    if (!$d) throw not_found('Document not found.');
    if (!kyc_staff_can_decide($u, $d['requirement'])) throw forbidden('Your role cannot decide this document.');
    if (!$b['approve'] && empty($b['reason'])) throw bad('Tell the organiser why, so they can fix it.', ['reason' => 'Required when rejecting.']);
    $r = kyc_decide($d['id'], $b['approve'], $b['approve'] ? null : $b['reason'], $u);
    return ['document' => kyc_doc_view($r)];
});
route('POST', '/api/admin/organisers/:id/verification/risk', function ($a) {
    $u = adm_admin();
    $b = check(body(), ['riskOverride' => R::oneOf(['auto', 'high', 'normal']), 'note' => R::str(['optional' => true, 'max' => 300])]);
    if (!val('SELECT 1 FROM organisers WHERE id = ?', [$a['id']])) throw not_found('Organiser not found.');
    kyc_profile_save($a['id'], ['risk_override' => $b['riskOverride'] === 'auto' ? null : $b['riskOverride'], 'risk_note' => $b['note'] ?? null]);
    audit('verification.risk_set', ['actor' => $u, 'entityType' => 'organiser', 'entityId' => $a['id'], 'organiserId' => $a['id'], 'details' => ['riskOverride' => $b['riskOverride'], 'note' => $b['note'] ?? null]]);
    return ['verification' => kyc_view($a['id'], true)];
});
route('POST', '/api/admin/events/:id/risk', function ($a) {
    $u = adm_admin();
    $b = check(body(), ['riskOverride' => R::oneOf(['auto', 'high', 'normal'])]);
    $ev = row('SELECT * FROM events WHERE id = ?', [$a['id']]);
    if (!$ev) throw not_found('Event not found.');
    $o = $b['riskOverride'] === 'auto' ? null : $b['riskOverride'];
    q('INSERT INTO event_risk (event_id, risk_override, updated_by, updated_at) VALUES (?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET risk_override = excluded.risk_override, updated_by = excluded.updated_by, updated_at = excluded.updated_at',
        [$ev['id'], $o, $u['id'], now_iso()]);
    audit('event.risk_set', ['actor' => $u, 'entityType' => 'event', 'entityId' => $ev['id'], 'organiserId' => $ev['organiser_id'], 'details' => ['riskOverride' => $b['riskOverride']]]);
    return ['event' => kyc_event_state(row('SELECT * FROM events WHERE id = ?', [$ev['id']]), kyc_state($ev['organiser_id']))];
});
// The full ID number or bank account number, to compare with the document.
// Each view is recorded, and shown to the organiser.
route('POST', '/api/admin/organisers/:id/verification/reveal-id', function ($a) {
    $u = adm_any();
    if (!has_role($u, ...KYC_REVIEW_ROLES)) throw forbidden();
    limit('reveal', 30, 3600, $u['id']);
    $enc = val('SELECT id_number_enc FROM organiser_verification WHERE organiser_id = ?', [$a['id']]);
    if (!$enc) throw conflict('No ID number on file.', 'no_id_number');
    audit('verification.id_revealed', ['actor' => $u, 'entityType' => 'organiser', 'entityId' => $a['id'], 'organiserId' => $a['id'], 'ip' => client_ip()]);
    return ['idNumber' => decrypt_str((string) $enc)];
});
route('POST', '/api/admin/organisers/:id/verification/reveal-bank', function ($a) {
    $u = adm_any();
    if (!has_role($u, 'admin', 'finance')) throw forbidden();
    limit('reveal', 30, 3600, $u['id']);
    $enc = val('SELECT bank_account_enc FROM organisers WHERE id = ?', [$a['id']]);
    if (!$enc) throw conflict('The organiser has no bank account on file.', 'no_bank_details');
    audit('verification.bank_revealed', ['actor' => $u, 'entityType' => 'organiser', 'entityId' => $a['id'], 'organiserId' => $a['id'], 'ip' => client_ip()]);
    return ['accountNumber' => decrypt_str((string) $enc)];
});
// Closing starts the keeping period (Admin portal: Verification settings).
route('POST', '/api/admin/organisers/:id/verification/close', function ($a) {
    $u = adm_admin();
    $b = check(body(), ['reopen' => R::bool()]);
    if (!val('SELECT 1 FROM organisers WHERE id = ?', [$a['id']])) throw not_found('Organiser not found.');
    kyc_profile_save($a['id'], ['closed_at' => $b['reopen'] ? null : now_iso()]);
    audit($b['reopen'] ? 'verification.reopened' : 'verification.closed', ['actor' => $u, 'entityType' => 'organiser', 'entityId' => $a['id'], 'organiserId' => $a['id']]);
    return ['verification' => kyc_view($a['id'], true)];
});
