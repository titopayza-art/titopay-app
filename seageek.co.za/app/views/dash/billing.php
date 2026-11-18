<?php if ($pay): ?>
<div class="panel" style="margin-bottom:14px;border-color:rgba(95,227,207,.45)">
  <div class="panel-head"><h2>Pay invoice <?= e($pay['invoice']['number']) ?></h2><span class="mono"><?= zar($pay['invoice']['total']) ?></span></div>
  <p class="muted small"><?= e($pay['invoice']['description']) ?>. You'll go to PayFast to pay by card, Instant EFT, SnapScan or Zapper. Your account updates automatically when the payment clears.</p>
  <form action="<?= e($pay['form']['action']) ?>" method="post" style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap" id="pf-form">
    <?php foreach ($pay['form']['fields'] as $k => $v): ?><input type="hidden" name="<?= e($k) ?>" value="<?= e($v) ?>"><?php endforeach; ?>
    <button class="btn btn-primary">Pay <?= zar($pay['invoice']['total']) ?> with PayFast</button>
    <a class="btn btn-ghost" href="#eft">Pay by bank transfer instead</a>
  </form>
</div>
<?php endif; ?>

<div class="grid cols-3">
  <div class="panel stat"><div class="k">Credit balance</div><div class="v"><?= zar($org['balance']) ?></div><div class="d"><?= (float) $org['credit_limit'] > 0 ? 'Plus ' . zar($org['credit_limit'], 0) . ' credit limit' : 'Prepaid' ?></div></div>
  <div class="panel stat"><div class="k">Plan</div><div class="v" style="font-family:var(--font-sans)"><?= e($plan['name']) ?></div><div class="d"><?= $org['plan_renews_at'] ? 'Renews ' . e(date('j M Y', strtotime($org['plan_renews_at']))) : 'No monthly fee' ?></div></div>
  <div class="panel" id="topup">
    <h2>Add credit</h2>
    <form method="post" class="form" style="margin-top:12px"><?= csrf_field() ?><input type="hidden" name="action" value="topup">
      <div class="toolbar" style="margin:0"><?php foreach ([200, 500, 1000, 5000] as $a): ?><button type="button" class="btn btn-ghost btn-xs" onclick="this.form.amount.value=<?= $a ?>"><?= zar($a, 0) ?></button><?php endforeach; ?></div>
      <div class="field"><label>Amount (R)</label><input name="amount" type="number" min="<?= (int) Settings::get('min_topup') ?>" step="1" value="500" required></div>
      <button class="btn btn-primary btn-sm">Continue to payment</button>
    </form>
  </div>
</div>

<div class="panel" style="margin-top:14px">
  <div class="panel-head"><h2>Plans</h2><span class="muted">Monthly, excl. VAT. Included credit is added on every renewal.</span></div>
  <div class="grid cols-4" style="grid-template-columns:repeat(5,minmax(0,1fr))">
    <?php foreach ($plans as $p): $feat = json_decode((string) $p['features'], true) ?: []; $current = $p['code'] === $org['plan_code']; ?>
    <div class="plan" style="<?= $current ? 'border-color:rgba(95,227,207,.5)' : '' ?>">
      <span class="name"><?= e($p['name']) ?> <?= $current ? '<span class="pill green">Current</span>' : '' ?></span>
      <div class="price"><?= (float) $p['price'] ? zar($p['price'], 0) : 'R0' ?><small> /mo</small></div>
      <ul><?php foreach (array_slice($feat, 0, 4) as $f): ?><li><?= icon('check') ?><?= e($f) ?></li><?php endforeach; ?></ul>
      <?php if (!$current): ?><form method="post"><?= csrf_field() ?><input type="hidden" name="action" value="plan"><input type="hidden" name="plan" value="<?= e($p['code']) ?>">
        <?php if ((float) $p['price'] > 0 && (float) $org['balance'] >= (float) $p['price']): ?><label class="consent" style="margin-bottom:8px"><input type="checkbox" name="from_credit" value="1"><span>Pay from my credit</span></label><?php endif; ?>
        <button class="btn btn-ghost btn-sm" style="width:100%">Switch to <?= e($p['name']) ?></button></form><?php endif; ?>
    </div>
    <?php endforeach; ?>
  </div>
  <form method="post" style="margin-top:14px"><?= csrf_field() ?><input type="hidden" name="action" value="auto_pay"><label class="consent"><input type="checkbox" name="auto_pay" value="1" <?= $org['auto_pay'] ? 'checked' : '' ?> onchange="this.form.submit()"><span>Pay plan renewals from my credit balance automatically when it's enough</span></label></form>
</div>

<div class="grid cols-2" style="margin-top:14px">
  <div class="panel flush">
    <div class="panel-head"><h2>Invoices</h2></div>
    <?php if (!$invoices): ?><div class="empty">No invoices yet.</div><?php else: ?>
    <div class="tbl-wrap"><table class="tbl"><tbody><?php foreach ($invoices as $i): ?><tr>
      <td><a class="link mono small" href="/dashboard/invoice/<?= e($i['number']) ?>"><?= e($i['number']) ?></a><div class="muted small"><?= e($i['description']) ?></div></td>
      <td class="right mono small"><?= zar($i['total']) ?></td><td><?php $status = $i['status'] === 'unpaid' && $i['due_at'] < now() ? 'overdue' : $i['status']; require APP_DIR . '/views/partials/status.php'; ?></td>
      <td class="right"><?php if ($i['status'] === 'unpaid'): ?><form method="post" class="inline-form"><?= csrf_field() ?><input type="hidden" name="action" value="pay"><input type="hidden" name="invoice" value="<?= (int) $i['id'] ?>"><button class="btn btn-primary btn-xs">Pay</button></form><?php endif; ?></td></tr><?php endforeach; ?></tbody></table></div><?php endif; ?>
  </div>
  <div class="panel flush">
    <div class="panel-head"><h2>Statement</h2><span class="muted">Latest 30 entries</span></div>
    <?php if (!$ledger): ?><div class="empty">No transactions yet.</div><?php else: ?>
    <div class="tbl-wrap"><table class="tbl"><tbody><?php foreach ($ledger as $l): ?><tr><td class="small"><?= e($l['description']) ?><div class="muted small"><?= e(date('j M H:i', strtotime($l['created_at'] . ' UTC'))) ?></div></td><td class="right mono small" style="color:<?= (float) $l['amount'] < 0 ? 'var(--text-soft)' : 'var(--accent)' ?>"><?= ((float) $l['amount'] > 0 ? '+' : '') . zar($l['amount'], 4) ?></td><td class="right mono small muted"><?= zar($l['balance_after']) ?></td></tr><?php endforeach; ?></tbody></table></div><?php endif; ?>
  </div>
</div>

<div class="panel" id="eft" style="margin-top:14px">
  <h2>Bank transfer (EFT)</h2>
  <p class="muted small" style="margin-top:6px">Use the invoice number as your reference. Transfers are matched within one working day.</p>
  <dl class="kv" style="margin-top:12px"><dt>Bank</dt><dd><?= e(Settings::get('bank_name') ?: 'Shared on request') ?></dd><dt>Account name</dt><dd><?= e(Settings::get('bank_account_name')) ?></dd><dt>Account number</dt><dd class="mono"><?= e(Settings::get('bank_account_number') ?: 'Shared on request') ?></dd><dt>Branch code</dt><dd class="mono"><?= e(Settings::get('bank_branch_code') ?: '') ?></dd></dl>
</div>
