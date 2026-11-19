<?php $v = fn($k) => e(in_array($k, Settings::SECRET_KEYS, true) ? '' : Settings::get($k)); $saved = fn($k) => Settings::get($k) !== '' ? 'Saved (leave blank to keep)' : ''; ?>
<form method="post" class="grid cols-2"><?= csrf_field() ?>
  <div class="panel form">
    <h2>Company and email</h2>
    <div class="row"><div class="field"><label>Company name</label><input name="company_name" value="<?= $v('company_name') ?>"></div><div class="field"><label>Registration number</label><input name="company_reg" value="<?= $v('company_reg') ?>" placeholder="2027/123456/07"></div></div>
    <div class="field"><label>Address on invoices and statements</label><input name="company_address" value="<?= $v('company_address') ?>"></div>
    <div class="row"><div class="field"><label>Support email</label><input name="support_email" value="<?= $v('support_email') ?>"></div><div class="field"><label>Support hours</label><input name="support_hours" value="<?= $v('support_hours') ?>"></div></div>
    <div class="row"><div class="field"><label>Emails from (name)</label><input name="mail_from_name" value="<?= $v('mail_from_name') ?>"></div><div class="field"><label>Emails from (address)</label><input name="mail_from_address" value="<?= $v('mail_from_address') ?>"></div></div>
    <h2 style="margin-top:8px">VAT</h2>
    <div class="row"><div class="field"><label>VAT registered</label><select name="vat_registered"><option value="0">No</option><option value="1" <?= Settings::get('vat_registered') === '1' ? 'selected' : '' ?>>Yes</option></select></div><div class="field"><label>VAT number</label><input name="vat_number" value="<?= $v('vat_number') ?>"></div><div class="field"><label>Rate %</label><input name="vat_rate" value="<?= $v('vat_rate') ?>"></div></div>
    <h2 style="margin-top:8px">Bank details for EFT</h2>
    <div class="row"><div class="field"><label>Bank</label><input name="bank_name" value="<?= $v('bank_name') ?>"></div><div class="field"><label>Account name</label><input name="bank_account_name" value="<?= $v('bank_account_name') ?>"></div></div>
    <div class="row"><div class="field"><label>Account number</label><input name="bank_account_number" value="<?= $v('bank_account_number') ?>"></div><div class="field"><label>Branch code</label><input name="bank_branch_code" value="<?= $v('bank_branch_code') ?>"></div><div class="field"><label>Account type</label><input name="bank_account_type" value="<?= $v('bank_account_type') ?>"></div></div>
    <p class="muted small">Customers pay by EFT with their 6-digit customer number as the reference. Import your bank statement under Bank payments (EFT) and payments are matched to the right account automatically.</p>
  </div>
  <div class="stack">
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
