<div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:start" id="sec-grid">
<?php if ($u['totp_enabled_at']): ?>
  <div class="panel">
    <div class="panel-head"><h2>Two-step sign-in is on</h2><span class="pill green">On since <?= e(date('j M Y', strtotime($u['totp_enabled_at']))) ?></span></div>
    <p class="muted">Each sign-in asks for your password and a 6-digit code from your authenticator app, so a stolen password alone is not enough.</p>
    <?php if (!($u['is_admin'] && Settings::get('require_staff_2fa') === '1')): ?>
    <form method="post" class="toolbar" style="margin:16px 0 0"><?= csrf_field() ?><input type="hidden" name="action" value="disable"><input name="code" inputmode="numeric" placeholder="Current code" maxlength="7" required><button class="btn btn-danger btn-sm">Switch off</button></form>
    <?php else: ?><p class="muted small" style="margin-top:12px">Required for SeaGeek staff.</p><?php endif; ?>
  </div>
<?php else: ?>
  <div class="panel">
    <h2>Set up two-step sign-in</h2>
    <ol class="howto">
      <li><b>1</b><span>Install an authenticator app on your phone: Google Authenticator, Microsoft Authenticator or Authy.</span></li>
      <li><b>2</b><span>Scan this QR code with the app, or type the key by hand.</span></li>
      <li><b>3</b><span>Enter the 6-digit code the app shows.</span></li>
    </ol>
    <form method="post" class="toolbar" style="margin:18px 0 0"><?= csrf_field() ?><input type="hidden" name="action" value="enable"><input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code" maxlength="7" required style="width:160px"><button class="btn btn-primary btn-sm">Turn on</button></form>
  </div>
  <div class="panel" style="text-align:center">
    <div class="qr-frame" style="display:inline-block"><?= Totp::qrSvg(Totp::uri($secret, $u['email'])) ?></div>
    <p class="muted small" style="margin-top:12px">Key: <span class="mono" style="color:var(--text);letter-spacing:.08em"><?= e(trim(chunk_split($secret, 4, ' '))) ?></span></p>
  </div>
<?php endif; ?>
</div>
<style>#sec-grid .qr-frame svg { width: 220px; height: 220px; display: block; } @media (max-width: 900px) { #sec-grid { grid-template-columns: 1fr !important; } }</style>
