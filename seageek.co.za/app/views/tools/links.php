<?php $old = $_SESSION['old'] ?? []; unset($_SESSION['old']); $newId = $_SESSION['new_link'] ?? null; unset($_SESSION['new_link']); ?>
<div class="grid" style="grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);align-items:start" id="links-grid">
  <form method="post" class="panel form"><?= csrf_field() ?>
    <div class="panel-head" style="margin-bottom:4px"><h2>Shorten a link</h2><span class="price-tag">Free</span></div>
    <div class="field"><label for="l-url">Long link</label><input id="l-url" name="url" type="url" inputmode="url" value="<?= e($old['url'] ?? '') ?>" placeholder="https://yourbusiness.co.za/specials/december-2026?utm_source=sms" required></div>
    <div class="row">
      <div class="field"><label for="l-code">Your own ending <span class="muted">(optional)</span></label><div class="prefix-input"><span><?= e(preg_replace('#^https?://#', '', app_url('/l/'))) ?></span><input id="l-code" name="code" value="<?= e($old['code'] ?? '') ?>" placeholder="december" maxlength="30" pattern="[A-Za-z0-9][A-Za-z0-9\-]{2,29}"></div></div>
      <div class="field"><label for="l-name">Name <span class="muted">(only you see this)</span></label><input id="l-name" name="name" value="<?= e($old['name'] ?? '') ?>" placeholder="December SMS campaign"></div>
    </div>
    <button class="btn btn-primary">Create short link</button>
  </form>
  <div class="panel">
    <h2>Why use them</h2>
    <ul class="plain small">
      <li>Short links fit in one SMS and look tidy on posters, invoices and social posts.</li>
      <li>See how many people clicked, and on which kind of device.</li>
      <li>Point a link somewhere new later without changing what you already sent or printed.</li>
    </ul>
    <p class="muted small" style="margin-top:12px">Need it on paper? Make a <a class="link" href="/dashboard/qr">QR code</a> from the short link.</p>
  </div>
</div>
<div class="panel flush" style="margin-top:14px">
  <div class="panel-head"><h2>Your short links</h2><span class="muted"><?= count($links) ?> · <?= number_format(array_sum(array_column($links, 'clicks'))) ?> clicks</span></div>
  <?php if (!$links): ?><div class="empty">No short links yet.</div><?php else: ?>
  <div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>Short link</th><th>Opens</th><th class="right">Clicks</th><th>Status</th></tr></thead>
    <tbody><?php foreach ($links as $l): ?>
      <tr<?= (int) $l['id'] === (int) $newId ? ' class="row-new"' : '' ?>>
        <td><div class="secret secret-inline"><span id="sl-<?= (int) $l['id'] ?>"><?= e(ShortLinks::url($l)) ?></span><button class="copy-btn" type="button" data-copy="sl-<?= (int) $l['id'] ?>">Copy</button></div><?= $l['name'] ? '<div class="muted small">' . e($l['name']) . '</div>' : '' ?></td>
        <td class="small" style="max-width:340px;overflow-wrap:anywhere"><a class="link" href="/dashboard/links/<?= (int) $l['id'] ?>"><?= e(mb_strimwidth(preg_replace('#^https?://#', '', $l['target_url']), 0, 70, '…')) ?></a></td>
        <td class="right"><?= number_format((int) $l['clicks']) ?></td>
        <td><span class="pill <?= $l['status'] === 'active' ? 'green' : 'amber' ?>"><?= $l['status'] === 'active' ? 'Active' : 'Paused' ?></span></td>
      </tr>
    <?php endforeach; ?></tbody>
  </table></div>
  <?php endif; ?>
</div>
