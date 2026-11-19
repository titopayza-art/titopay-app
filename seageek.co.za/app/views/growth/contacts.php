<?php $cBase = $base === '/dashboard' ? '/dashboard/campaigns' : $base; ?>
<div class="grid" style="grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);align-items:start" id="ct-grid">
  <div class="panel flush">
    <div class="panel-head"><h2>Contact lists</h2><a class="link small" href="<?= e($base) ?>/contacts/template.csv"><?= icon('download') ?> CSV template</a></div>
    <?php if (!$lists): ?><div class="empty">No lists yet. Create one, then import your customers from a spreadsheet.</div><?php else: ?>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>List</th><th class="right">Contacts</th><th class="right">With phone</th><th class="right">With email</th><th></th></tr></thead><tbody>
      <?php foreach ($lists as $l): ?><tr><td><a class="link" href="<?= e($base . '/contacts/' . $l['id']) ?>"><?= e($l['name']) ?></a><div class="muted small">Created <?= e(date('j M Y', strtotime($l['created_at']))) ?></div></td><td class="right mono small"><?= number_format((int) $l['total']) ?></td><td class="right mono small"><?= number_format((int) $l['phones']) ?></td><td class="right mono small"><?= number_format((int) $l['emails']) ?></td><td class="right"><a class="btn btn-ghost btn-xs" href="<?= e($base . '/contacts/' . $l['id']) ?>">Open</a></td></tr><?php endforeach; ?>
    </tbody></table></div><?php endif; ?>
  </div>
  <div>
    <form method="post" class="panel form"><?= csrf_field() ?>
      <h2>New list</h2>
      <div class="field"><label for="cl-name">Name</label><input id="cl-name" name="name" placeholder="Loyalty customers" required></div>
      <button class="btn btn-primary btn-sm">Create list</button>
    </form>
    <div class="panel" style="margin-top:14px">
      <h2>Good to know</h2>
      <ul class="plain">
        <li>Import from Excel or Google Sheets by saving as CSV. Columns: name, phone, email.</li>
        <li>Numbers like 082 123 4567 are converted to +27821234567 automatically.</li>
        <li>Duplicates in a list are merged.</li>
        <li><?= number_format($optouts) ?> people have opted out. They are skipped in every campaign.</li>
        <li>Only message people who agreed to hear from you (POPIA).</li>
      </ul>
      <a class="btn btn-ghost btn-sm" style="margin-top:12px" href="<?= e($cBase) ?>/new">Start a campaign</a>
    </div>
  </div>
</div>
<style>@media (max-width: 1000px) { #ct-grid { grid-template-columns: 1fr !important; } }</style>
