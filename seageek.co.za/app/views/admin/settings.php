<?php $v = fn($k) => e(in_array($k, Settings::SECRET_KEYS, true) ? '' : Settings::get($k)); $saved = fn($k) => Settings::get($k) !== '' ? 'Saved (leave blank to keep)' : ''; ?>
<form method="post" class="grid cols-2"><?= csrf_field() ?>
  <div class="panel form">
    <h2>Company and email</h2>
    <div class="row"><div class="field"><label>Company name</label><input name="company_name" value="<?= $v('company_name') ?>"></div><div class="field"><label>Registration number</label><input name="company_reg" value="<?= $v('company_reg') ?>" placeholder="2027/123456/07"></div></div>
    <div class="field"><label>Address on invoices and statements</label><input name="company_address" value="<?= $v('company_address') ?>"></div>
    <div class="row"><div class="field"><label>Support email</label><input name="support_email" value="<?= $v('support_email') ?>"></div><div class="field"><label>Support hours</label><input name="support_hours" value="<?= $v('support_hours') ?>"></div></div>
    <div class="row"><div class="field"><label>Emails from (name)</label><input name="mail_from_name" value="<?= $v('mail_from_name') ?>"></div><div class="field"><label>Emails from (address)</label><input name="mail_from_address" value="<?= $v('mail_from_address') ?>"></div></div>
    <h2 style="margin-top:8px">Startup programme</h2>
    <p class="muted small" style="margin:4px 0 8px">Lower price offer</p>
    <div class="row"><div class="field"><label>Launch credit (R)</label><input name="startup_credit" value="<?= $v('startup_credit') ?>" inputmode="decimal"></div><div class="field"><label>Startup plan free for (months)</label><input name="startup_plan_months" value="<?= $v('startup_plan_months') ?>" inputmode="numeric"></div></div>
    <div class="row"><div class="field"><label>Then a discount of (%)</label><input name="startup_discount_pct" value="<?= $v('startup_discount_pct') ?>" inputmode="numeric"></div><div class="field"><label>For (months)</label><input name="startup_discount_months" value="<?= $v('startup_discount_months') ?>" inputmode="numeric"></div></div>
    <p class="muted small" style="margin:4px 0 8px">Equity partnership</p>
    <div class="row"><div class="field"><label>Services credit (R)</label><input name="startup_equity_credit" value="<?= $v('startup_equity_credit') ?>" inputmode="decimal"></div><div class="field"><label>Startup plan free for (months)</label><input name="startup_equity_months" value="<?= $v('startup_equity_months') ?>" inputmode="numeric"></div></div>
    <h2 style="margin-top:8px">VAT</h2>
    <div class="row"><div class="field"><label>VAT registered</label><select name="vat_registered"><option value="0">No</option><option value="1" <?= Settings::get('vat_registered') === '1' ? 'selected' : '' ?>>Yes</option></select></div><div class="field"><label>VAT number</label><input name="vat_number" value="<?= $v('vat_number') ?>"></div><div class="field"><label>Rate %</label><input name="vat_rate" value="<?= $v('vat_rate') ?>"></div></div>
    <h2 style="margin-top:8px">Bank details for EFT</h2>
    <div class="row"><div class="field"><label>Bank</label><input name="bank_name" value="<?= $v('bank_name') ?>"></div><div class="field"><label>Account name</label><input name="bank_account_name" value="<?= $v('bank_account_name') ?>"></div></div>
    <div class="row"><div class="field"><label>Account number</label><input name="bank_account_number" value="<?= $v('bank_account_number') ?>"></div><div class="field"><label>Branch code</label><input name="bank_branch_code" value="<?= $v('bank_branch_code') ?>"></div><div class="field"><label>Account type</label><input name="bank_account_type" value="<?= $v('bank_account_type') ?>"></div></div>
    <p class="muted small">Customers pay by EFT with their 6-digit customer number as the reference. Import your bank statement under Bank payments (EFT) and payments are matched to the right account automatically.</p>
  </div>
  <div class="stack">
    <div class="panel form" id="team-alerts">
      <h2>Team alerts</h2>
      <p class="muted small">For running SeaGeek with a small team. A morning email lists only what needs a person; urgent problems (scheduled jobs stopped, a supplier failing, email not sending) are sent at once.</p>
      <div class="row"><div class="field"><label for="ops-email">Send to</label><input id="ops-email" name="ops_email" value="<?= $v('ops_email') ?>" placeholder="Leave empty for all owners and administrators"></div>
      <div class="field"><label for="ops-phone">SMS for urgent alerts <span class="muted">(optional)</span></label><input id="ops-phone" name="ops_phone" value="<?= $v('ops_phone') ?>" inputmode="tel" placeholder="082 123 4567"></div></div>
      <div class="row"><div class="field"><label for="ops-digest">Morning email</label><select id="ops-digest" name="ops_digest"><option value="1">On</option><option value="0" <?= Settings::get('ops_digest') === '0' ? 'selected' : '' ?>>Off</option></select></div>
      <div class="field"><label for="ops-hour">Send at (SAST)</label><select id="ops-hour" name="ops_digest_hour"><?php foreach (range(5, 10) as $h): ?><option value="<?= $h ?>" <?= (int) Settings::get('ops_digest_hour') === $h ? 'selected' : '' ?>><?= sprintf('%02d:00', $h) ?></option><?php endforeach; ?></select></div></div>
      <p class="muted small">Goes to: <?= e(implode(', ', Ops::recipients()) ?: 'nobody yet') ?>.</p>
    </div>
    <div class="panel form" id="email">
      <h2>Email delivery</h2>
      <p class="muted small">How the platform sends invoices, receipts, reminders, Desk replies and newsletters. Most hosts and Microsoft 365 or Google Workspace give you SMTP details. Amazon SES works too once the SES partner is active.</p>
      <div class="row"><div class="field"><label>Send with</label><select name="mail_driver"><?php foreach (['auto' => 'Automatic (SMTP if set, else SES, else PHP mail)', 'smtp' => 'SMTP server', 'ses' => 'Amazon SES partner', 'mail' => 'PHP mail() on this server', 'log' => 'Do not send (keep in outbox, for testing)'] as $k => $label): ?><option value="<?= $k ?>" <?= Settings::get('mail_driver') === $k ? 'selected' : '' ?>><?= e($label) ?></option><?php endforeach; ?></select></div></div>
      <div class="row"><div class="field"><label>SMTP host</label><input name="smtp_host" value="<?= $v('smtp_host') ?>" placeholder="smtp.example.co.za"></div><div class="field"><label>Port</label><input name="smtp_port" value="<?= $v('smtp_port') ?>" inputmode="numeric"></div><div class="field"><label>Security</label><select name="smtp_encryption"><?php foreach (['tls' => 'STARTTLS (587)', 'ssl' => 'SSL/TLS (465)', 'none' => 'None'] as $k => $label): ?><option value="<?= $k ?>" <?= Settings::get('smtp_encryption') === $k ? 'selected' : '' ?>><?= e($label) ?></option><?php endforeach; ?></select></div></div>
      <div class="row"><div class="field"><label>Username</label><input name="smtp_username" value="<?= $v('smtp_username') ?>" autocomplete="off"></div><div class="field"><label>Password</label><input name="smtp_password" type="password" placeholder="<?= $saved('smtp_password') ?>" autocomplete="new-password"></div></div>
      <p class="muted small">Now sending with: <b><?= e(strtoupper(Mail::driver())) ?></b>. Queued: <?= (int) DB::value("SELECT COUNT(*) FROM email_outbox WHERE status = 'queued'") ?>, failed: <?= (int) DB::value("SELECT COUNT(*) FROM email_outbox WHERE status = 'failed'") ?>.</p>
    </div>
    <div class="panel form">
      <h2>PayFast</h2>
      <div class="row"><div class="field"><label>Mode</label><select name="payfast_mode"><option value="sandbox">Sandbox</option><option value="live" <?= Settings::get('payfast_mode') === 'live' ? 'selected' : '' ?>>Live</option></select></div><div class="field"><label>Merchant ID</label><input name="payfast_merchant_id" value="<?= $v('payfast_merchant_id') ?>"></div></div>
      <div class="row"><div class="field"><label>Merchant key</label><input name="payfast_merchant_key" type="password" placeholder="<?= $saved('payfast_merchant_key') ?>"></div><div class="field"><label>Passphrase</label><input name="payfast_passphrase" type="password" placeholder="<?= $saved('payfast_passphrase') ?>"></div></div>
      <p class="muted small">Notify URL to set in PayFast: <span class="code-inline"><?= e(app_url('/webhooks/payfast')) ?></span></p>
    </div>
    <div class="panel form">
      <h2>Collections automation</h2>
      <div class="row"><div class="field"><label>Invoice due after (days)</label><input name="invoice_due_days" value="<?= $v('invoice_due_days') ?>"></div><div class="field"><label>Lock live access after overdue (days)</label><input name="lock_after_days" value="<?= $v('lock_after_days') ?>"></div></div>
      <div class="row"><div class="field"><label>Send reminders on overdue days</label><input name="reminder_days" value="<?= $v('reminder_days') ?>"></div><div class="field"><label>Minimum top-up (R)</label><input name="min_topup" value="<?= $v('min_topup') ?>"></div></div>
      <div class="field"><label>Default low-balance alert (R)</label><input name="low_balance_default" value="<?= $v('low_balance_default') ?>"></div>
    </div>
    <div class="panel form">
      <h2>Support chatbot</h2>
      <div class="row"><div class="field"><label>Provider</label><select name="chat_provider"><option value="anthropic">Anthropic</option><option value="openai" <?= Settings::get('chat_provider') === 'openai' ? 'selected' : '' ?>>OpenAI</option></select></div><div class="field"><label>Anthropic model</label><input name="chat_model_anthropic" value="<?= $v('chat_model_anthropic') ?>"></div><div class="field"><label>OpenAI model</label><input name="chat_model_openai" value="<?= $v('chat_model_openai') ?>"></div></div>
      <p class="muted small">Provider API keys are set on the Anthropic and OpenAI rows under <a class="link" href="/admin/partners">Wholesale partners</a>, shared with SeaGeek AI.</p>
      <div class="field"><label>Extra knowledge for the chatbot</label><textarea name="chat_extra_knowledge" rows="5"><?= $v('chat_extra_knowledge') ?></textarea></div>
      <div class="field"><label>AI models offered (JSON, blank for defaults)</label><textarea class="code" name="ai_models_json" rows="4" placeholder='[{"provider":"anthropic","model":"claude-opus-5-5","label":"Claude Opus 5.5","in":4,"out":20}]'><?= e(Settings::get('ai_models_json')) ?></textarea></div>
    </div>
    <button class="btn btn-primary">Save settings</button>
  </div>
</form>

<form method="post" class="panel" style="margin-top:14px" id="test-email"><?= csrf_field() ?><input type="hidden" name="action" value="test_email">
  <div class="panel-head"><h2>Send a test email</h2><span class="muted">Save your settings first</span></div>
  <div class="toolbar" style="margin:0"><input name="to" type="email" placeholder="<?= e(Auth::user()['email']) ?>" style="min-width:260px"><button class="btn btn-ghost btn-sm">Send test email</button></div>
</form>

<form method="post" class="panel" style="margin-top:14px" id="ai"><?= csrf_field() ?><input type="hidden" name="action" value="test_ai">
  <div class="panel-head"><h2>Test SeaGeek AI</h2><span class="muted">Sends one tiny request to each AI provider with a saved key</span></div>
  <p class="muted small">If one provider is busy or down, the chat and Desk agents switch to the other automatically, so keep both keys saved under Wholesale partners.</p>
  <button class="btn btn-ghost btn-sm" style="margin-top:10px">Test Anthropic and OpenAI</button>
</form>
