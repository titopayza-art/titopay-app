<?php
$crumbs = [['Contacts', $base . '/contacts'], [$list['name'], null]];
require APP_DIR . '/views/partials/crumbs.php';
$cBase = $base === '/dashboard' ? '/dashboard/campaigns' : $base;
?>
<div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:start" id="cl-grid">
  <form method="post" enctype="multipart/form-data" class="panel form"><?= csrf_field() ?><input type="hidden" name="action" value="import">
    <div class="panel-head" style="margin-bottom:4px"><h2>Import contacts</h2><a class="link small" href="<?= e($base) ?>/contacts/template.csv"><?= icon('download') ?> CSV template</a></div>
    <div class="field"><label for="cl-file">CSV file</label><input id="cl-file" name="file" type="file" accept=".csv,text/csv"></div>
    <div class="field"><label for="cl-csv">Or paste rows</label><textarea id="cl-csv" name="csv" class="code" style="min-height:130px" placeholder="name,phone,email&#10;Thandi Mokoena,0821234567,thandi@example.co.za"></textarea></div>
    <button class="btn btn-primary btn-sm">Import</button>
  </form>
  <div>
    <form method="post" class="panel form"><?= csrf_field() ?><input type="hidden" name="action" value="add">
      <h2>Add one contact</h2>
      <div class="field"><label for="ca-name">Name</label><input id="ca-name" name="name"></div>
      <div class="row"><div class="field"><label for="ca-phone">Phone</label><input id="ca-phone" name="phone" inputmode="tel" placeholder="082 123 4567"></div><div class="field"><label for="ca-email">Email</label><input id="ca-email" name="email" type="email"></div></div>
      <button class="btn btn-ghost btn-sm">Add contact</button>
    </form>
    <div class="panel" style="margin-top:14px">
      <div class="refbox" style="grid-template-columns:1fr 1fr"><div><span>Contacts</span><b><?= number_format($total) ?></b></div><div><span>Send them</span><b style="font-family:var(--font-sans);font-size:16px"><a class="link" href="<?= e($cBase) ?>/new?channel=sms">SMS</a> or <a class="link" href="<?= e($cBase) ?>/new?channel=email">email</a></b></div></div>
    </div>
  </div>
</div>

<div class="panel flush" style="margin-top:14px">
  <div class="panel-head"><h2><?= e($list['name']) ?></h2>
    <form method="get" class="toolbar" style="margin:0"><input name="q" value="<?= e($q) ?>" placeholder="Search name, phone or email"><button class="btn btn-ghost btn-sm">Search</button></form>
  </div>
  <?php if (!$contacts): ?><div class="empty"><?= $q !== '' ? 'Nobody matches.' : 'This list is empty. Import a CSV or add contacts above.' ?></div><?php else: ?>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Source</th><th>Added</th><th></th></tr></thead><tbody>
    <?php foreach ($contacts as $c): ?><tr><td><?= e($c['name'] ?: '–') ?></td><td class="mono small"><?= e($c['phone'] ?: '–') ?></td><td class="small"><?= e($c['email'] ?: '–') ?></td><td class="small muted"><?= e(ucfirst((string) $c['source'])) ?></td><td class="small nowrap"><?= e(date('j M Y', strtotime($c['created_at']))) ?></td>
      <td class="right"><form method="post" class="inline-form"><?= csrf_field() ?><input type="hidden" name="action" value="delete"><input type="hidden" name="contact" value="<?= (int) $c['id'] ?>"><button class="btn btn-ghost btn-xs" aria-label="Remove <?= e($c['name'] ?: 'contact') ?>"><?= icon('x') ?></button></form></td></tr><?php endforeach; ?>
  </tbody></table></div>
  <?php if ($total > count($contacts)): ?><p class="muted small" style="padding:12px 20px">Showing the newest <?= count($contacts) ?> of <?= number_format($total) ?>. Search to find someone.</p><?php endif; ?>
  <?php endif; ?>
</div>
<div class="toolbar" style="margin-top:14px;justify-content:space-between">
  <form method="post" class="toolbar" style="margin:0"><?= csrf_field() ?><input type="hidden" name="action" value="rename"><input name="name" value="<?= e($list['name']) ?>" aria-label="List name"><button class="btn btn-ghost btn-sm">Rename list</button></form>
  <form method="post" data-confirm="Delete this list and its <?= number_format($total) ?> contacts? Opt-outs are kept."><?= csrf_field() ?><input type="hidden" name="action" value="delete_list"><button class="btn btn-danger btn-sm">Delete list</button></form>
</div>
<style>@media (max-width: 1000px) { #cl-grid { grid-template-columns: 1fr !important; } }</style>
