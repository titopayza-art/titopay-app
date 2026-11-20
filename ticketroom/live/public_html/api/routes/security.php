<?php
// Admin portal: the Security card (Site settings), each staff member's own
// two-step set-up, and an admin resetting a colleague's two-step.
declare(strict_types=1);

function sec_view(): array
{
    return ['staffTwoStep' => staff_two_step_required(), 'notSetUp' => staff_two_step_missing(),
        'turnstile' => ['siteKey' => turnstile_site_key(), 'secretSet' => (string) cfg('turnstile.secretKey', '') !== '', 'on' => turnstile_ready()]];
}
route('GET', '/api/admin/security', function () {
    adm_any();
    return sec_view();
});
// Saving needs the admin's own password: it changes how everyone signs in.
route('PUT', '/api/admin/security', function () {
    $u = adm_admin();
    limit('secsave', 20, 3600, $u['id']);
    $b = check(body(), ['currentPassword' => R::str(['max' => 200]), 'staffTwoStep' => R::bool(), 'turnstileSiteKey' => R::str(['max' => 100, 'optional' => true]),
        'turnstileSecretKey' => R::str(['max' => 100, 'optional' => true]), 'clearTurnstile' => R::bool(['optional' => true])]);
    if (!verify_secret($b['currentPassword'], (string) val('SELECT password_hash FROM users WHERE id = ?', [$u['id']]))) throw new AppError(401, 'bad_credentials', 'Your password is incorrect.', ['currentPassword' => 'Incorrect.']);
    // Never lock yourself out: switch it on after setting up your own app.
    if ($b['staffTwoStep'] && !staff_two_step_on($u['id'])) throw conflict('Set up two-step sign-in for yourself first (My password, Two-step sign-in), then switch it on for everyone.', 'two_step_self_first');
    $site = trim((string) ($b['turnstileSiteKey'] ?? ''));
    $secret = trim((string) ($b['turnstileSecretKey'] ?? ''));
    if ($site !== '' && !preg_match('/^[0-9A-Za-z_-]{10,100}$/', $site)) throw invalid(['turnstileSiteKey' => 'That does not look like a Turnstile site key. Copy it again from Cloudflare.']);
    if ($secret !== '' && !preg_match('/^[0-9A-Za-z_-]{10,100}$/', $secret)) throw invalid(['turnstileSecretKey' => 'That does not look like a Turnstile secret key. Copy it again from Cloudflare.']);
    tx(function () use ($u, $b, $site, $secret) {
        setting_set($u, 'security', ['staffTwoStep' => $b['staffTwoStep']]);
        integration_save('turnstile', ['siteKey' => !empty($b['clearTurnstile']) ? '' : $site, 'secretKey' => $secret], !empty($b['clearTurnstile']) ? ['secretKey'] : [], $u['id']);
        audit('security.settings_saved', ['actor' => $u, 'entityType' => 'setting', 'entityId' => 'security', 'details' => ['staffTwoStep' => $b['staffTwoStep'], 'turnstile' => turnstile_ready()]]);
    });
    settings_all(true);
    return sec_view();
});

// ---- my two-step -------------------------------------------------------------
function sec_staff(): array
{
    $u = require_auth();
    if (account_type($u) !== 'staff') throw forbidden();
    return $u;
}
route('GET', '/api/admin/me/two-step', function () {
    $u = sec_staff();
    return ['enabled' => staff_two_step_on($u['id']), 'required' => staff_two_step_required()];
});
route('POST', '/api/admin/me/two-step/start', function () {
    $u = sec_staff();
    limit('twostepstart', 10, 3600, $u['id']);
    if (staff_two_step_on($u['id'])) throw conflict('Two-step sign-in is already on. Turn it off first to move it to a new phone.', 'two_step_on');
    return staff_two_step_start($u);
});
route('POST', '/api/admin/me/two-step/confirm', function () {
    $u = sec_staff();
    limit('twostepconfirm', 10, 900, $u['id']);
    $b = check(body(), ['code' => R::str(['pattern' => '/^\d{6}$/', 'message' => 'Six digits.'])]);
    staff_two_step_confirm($u, $b['code']);
    return ['enabled' => true];
});
route('POST', '/api/admin/me/two-step/off', function () {
    $u = sec_staff();
    $b = check(body(), ['currentPassword' => R::str(['max' => 200]), 'code' => R::str(['pattern' => '/^\d{6}$/', 'message' => 'Six digits.'])]);
    if (staff_two_step_required()) throw conflict('Two-step sign-in is compulsory for staff. An admin can switch that off under Site settings, Security.', 'two_step_required');
    if (!verify_secret($b['currentPassword'], (string) val('SELECT password_hash FROM users WHERE id = ?', [$u['id']]))) throw new AppError(401, 'bad_credentials', 'Your password is incorrect.', ['currentPassword' => 'Incorrect.']);
    if (!staff_two_step_check($u['id'], $b['code'])) throw invalid(['code' => 'That code is not right.']);
    staff_two_step_clear($u['id']);
    audit('security.two_step_disabled', ['actor' => $u, 'entityType' => 'user', 'entityId' => $u['id']]);
    return ['enabled' => false];
});
// A colleague lost their phone: an admin clears it; they set it up again at
// their next sign-in (with an emailed code until then).
route('POST', '/api/admin/staff/:id/two-step/reset', function ($a) {
    $u = adm_admin();
    if ($a['id'] === $u['id']) throw conflict('Turn off your own two-step under My password.', 'two_step_self');
    $t = row("SELECT id, full_name FROM users WHERE id = ? AND account_type = 'staff'", [$a['id']]);
    if (!$t) throw not_found('Staff member not found.');
    adm_guard_owner($u, $t['id']);
    staff_two_step_clear($t['id']);
    q('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [now_iso(), $t['id']]);
    audit('security.two_step_reset', ['actor' => $u, 'entityType' => 'user', 'entityId' => $t['id'], 'details' => ['name' => $t['full_name']]]);
    return ['ok' => true];
});
