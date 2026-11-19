<?php
$crumbs = [['Billing', '/dashboard/billing'], ['Quotes', null]];
require APP_DIR . '/views/partials/crumbs.php';
?>
<div class="quote-layout">
  <div>
    <div class="panel" style="margin-bottom:14px"><h2>Build a quote</h2><p class="muted small" style="margin-top:4px">Enter your expected monthly volumes. Prices update as you type, using your account's rates.</p></div>
    <?php require APP_DIR . '/views/partials/quote_form.php'; ?>
  </div>
  <div>
    <div id="quote-result" aria-live="polite"><?php $saveUrl = '/dashboard/quotes'; $saveLabel = 'Save quote'; require APP_DIR . '/views/partials/quote_result.php'; ?></div>
    <div class="panel flush" style="margin-top:14px">
      <div class="panel-head"><h2>Saved quotes</h2></div>
      <?php if (!$quotes): ?><div class="empty">No quotes yet.</div><?php else: ?>
      <div class="tbl-wrap"><table class="tbl"><tbody><?php foreach ($quotes as $q): $st = $q['status'] === 'open' && $q['valid_until'] < now() ? 'expired' : $q['status']; ?>
        <tr><td><a class="link mono small" href="/dashboard/quotes/<?= e($q['number']) ?>"><?= e($q['number']) ?></a><div class="muted small"><?= e(date('j M Y', strtotime($q['created_at']))) ?> · <?= e(ucfirst((string) $q['plan_code'])) ?> plan</div></td><td class="right mono small"><?= zar($q['total']) ?><div class="muted small">a month</div></td><td><?php $status = $st; require APP_DIR . '/views/partials/status.php'; ?></td><td class="right"><a class="btn btn-ghost btn-xs" href="/dashboard/quotes/<?= e($q['number']) ?>">Open</a></td></tr>
      <?php endforeach; ?></tbody></table></div><?php endif; ?>
    </div>
  </div>
</div>
<script src="/assets/js/quote.js?v=1" defer></script>
