<p style="margin:0 0 16px">Hi <?= e($user['name']) ?>,</p>
<p style="margin:0 0 16px">Welcome to SeaGeek. Your account is ready. Three steps take you from sandbox to live:</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 6px;font-size:16px;line-height:1.6">
<tr><td style="padding:4px 12px 4px 0;vertical-align:top;color:#0f8f80;font-weight:700">1</td><td style="padding:4px 0">Choose your services and send a test request with your sandbox key.</td></tr>
<tr><td style="padding:4px 12px 4px 0;vertical-align:top;color:#0f8f80;font-weight:700">2</td><td style="padding:4px 0">Add your company phone number under Settings.</td></tr>
<tr><td style="padding:4px 12px 4px 0;vertical-align:top;color:#0f8f80;font-weight:700">3</td><td style="padding:4px 0">Add credit. Live keys switch on as soon as the payment clears.</td></tr>
</table>
<?= mail_button(app_url('/dashboard'), 'Open your dashboard') ?>
