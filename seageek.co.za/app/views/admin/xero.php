<?php
$t = Xero::tokens();
$n = fn($e, $s) => (int) ($counts[$e][$s] ?? 0);
$job = DB::one("SELECT * FROM jobs WHERE name = 'xero'");
$label = ['contact' => 'Customer', 'invoice' => 'Invoice', 'payment' => 'Payment'];
?>
<div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:start" id="xero-grid">
  <div class="stack">
    <div class="panel">
      <h2 style="margin-bottom:10px">Connection</h2>
      <?php if (Xero::connected()): ?>
        <p>Connected to <b><?= e($t['tenant_name'] ?? Settings::get('xero_tenant_name')) ?></b>.</p>
        <p class="muted small">Every invoice SeaGeek issues is copied to Xero as a sales invoice, with the customer as a contact (matched on their 6-digit customer number). Card, EFT and PayFast payments are recorded against the invoice in Xero. Voided invoices are voided in Xero too. The scheduled jobs do this every few minutes.</p>
        <div class="btn-row">
          <form method="post" class="inline-form"><?= csrf_field() ?><input type="hidden" name="action" value="sync"><button class="btn btn-primary btn-sm">Sync now</button></form>
          <form method="post" class="inline-form" data-confirm="Disconnect Xero? Invoices already in Xero stay there."><?= csrf_field() ?><input type="hidden" name="action" value="disconnect"><button class="btn btn-ghost btn-sm">Disconnect</button></form>
        </div>
      <?php else: ?>
        <p>Not connected.</p>
        <ol class="howto">
          <li><b>Create a Xero app.</b> Sign in at developer.xero.com, choose New app, type Web app.</li>
          <li><b>Add the redirect address.</b> Paste <code><?= e(Xero::redirectUri()) ?></code> as the redirect URI.</li>
          <li><b>Copy the keys here.</b> Paste the Client ID and generate a Client secret, then save below.</li>
          <li><b>Connect.</b> Press Connect to Xero, sign in and choose your organisation.</li>
        </ol>
        <form method="post"><?= csrf_field() ?><input type="hidden" name="action" value="connect"><button class="btn btn-primary btn-sm" <?= Xero::configured() ? '' : 'disabled' ?>>Connect to Xero</button></form>
      <?php endif; ?>
    </div>
    <form method="post" class="panel form"><?= csrf_field() ?><input type="hidden" name="action" value="save">
      <h2>Settings</h2>
      <div class="row"><div class="field"><label for="x-id">Client ID</label><input id="x-id" name="xero_client_id" value="<?= e(Settings::get('xero_client_id')) ?>" autocomplete="off"></div>
      <div class="field"><label for="x-sec">Client secret</label><input id="x-sec" name="xero_client_secret" type="password" placeholder="<?= Settings::get('xero_client_secret') !== '' ? 'Saved (leave blank to keep)' : '' ?>" autocomplete="new-password"></div></div>
      <div class="row">
        <div class="field"><label for="x-sales">Sales account code</label><input id="x-sales" name="xero_sales_account" value="<?= e(Settings::get('xero_sales_account')) ?>" inputmode="numeric"></div>
        <div class="field"><label for="x-bank">Bank account code</label><input id="x-bank" name="xero_bank_account" value="<?= e(Settings::get('xero_bank_account')) ?>" inputmode="numeric"></div>
        <div class="field"><label for="x-tax">Tax rate</label><select id="x-tax" name="xero_tax_type"><?php foreach (['NONE' => 'No VAT', 'OUTPUT' => 'Standard rate sales (15%)', 'ZERORATEDOUTPUT' => 'Zero rated', 'EXEMPTOUTPUT' => 'Exempt'] as $k => $l): ?><option value="<?= $k ?>" <?= Settings::get('xero_tax_type') === $k ? 'selected' : '' ?>><?= e($l) ?></option><?php endforeach; ?></select></div>
      </div>
      <p class="muted small">Account codes come from Accounting, Chart of accounts in Xero. 200 is Sales and 090 is the business bank account in a new Xero organisation. Pick Standard rate once SeaGeek is VAT registered.</p>
      <button class="btn btn-sm">Save settings</button>
    </form>
  </div>
  <div class="stack">
    <div class="panel">
      <h2>What has been copied</h2>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th></th><th class="right">In Xero</th><th class="right">Failed</th></tr></thead>
        <tbody>
          <tr><td>Customers</td><td class="right"><?= $n('contact', 'synced') ?></td><td class="right"><?= $n('contact', 'error') ?></td></tr>
          <tr><td>Invoices</td><td class="right"><?= $n('invoice', 'synced') ?><?= $n('invoice', 'voided') ? ' <span class="muted small">+' . $n('invoice', 'voided') . ' voided</span>' : '' ?></td><td class="right"><?= $n('invoice', 'error') ?></td></tr>
          <tr><td>Payments</td><td class="right"><?= $n('payment', 'synced') ?></td><td class="right"><?= $n('payment', 'error') ?></td></tr>
        </tbody>
      </table></div>
      <p class="muted small" style="margin-top:10px"><?= $waiting ?> invoice<?= $waiting === 1 ? '' : 's' ?> waiting. Last run: <?= $job ? e(date('j M H:i', strtotime($job['last_run_at'] . ' UTC'))) : 'never' ?>.</p>
      <?php if ($n('invoice', 'error') + $n('payment', 'error')): ?><form method="post"><?= csrf_field() ?><input type="hidden" name="action" value="retry"><button class="btn btn-ghost btn-xs">Try failed items again</button></form><?php endif; ?>
    </div>
    <div class="panel flush">
      <div class="panel-head"><h2>Log</h2></div>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Item</th><th>Status</th><th>When</th></tr></thead>
        <tbody>
        <?php if (!$log): ?><tr><td colspan="3" class="muted">Nothing copied yet.</td></tr><?php endif; ?>
        <?php foreach ($log as $l): ?>
          <tr><td><?= e($label[$l['entity']]) ?> <b><?= e((string) $l['label']) ?></b><?= $l['error'] ? '<div class="small" style="color:var(--red)">' . e($l['error']) . '</div>' : '' ?></td>
          <td><span class="pill <?= $l['status'] === 'error' ? 'red' : ($l['status'] === 'voided' ? 'amber' : 'green') ?>"><?= e(ucfirst($l['status'] === 'synced' ? 'in Xero' : $l['status'])) ?></span></td>
          <td class="small muted nowrap"><?= e(date('j M H:i', strtotime(($l['synced_at'] ?: $l['created_at']) . ' UTC'))) ?></td></tr>
        <?php endforeach; ?>
        </tbody>
      </table></div>
    </div>
  </div>
</div>
