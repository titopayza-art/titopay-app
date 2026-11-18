<div class="grid cols-3">
  <div class="panel span-2 flush">
    <div class="panel-head"><h2>Articles</h2><a class="link small" href="<?= $org['is_house'] ? '/help' : '/h/' . e($org['slug']) ?>" target="_blank">View public help centre</a></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Title</th><th>Category</th><th>Views</th><th>Status</th><th></th></tr></thead><tbody>
    <?php foreach ($articles as $a): ?><tr><td><a class="link" href="?edit=<?= (int) $a['id'] ?>"><?= e($a['title']) ?></a></td><td class="small muted"><?= e($a['category']) ?></td><td class="mono small"><?= (int) $a['views'] ?></td><td><?= $a['published'] ? '<span class="pill green">Published</span>' : '<span class="pill">Draft</span>' ?></td>
      <td class="right"><form method="post" class="inline-form" data-confirm="Delete this article?"><?= csrf_field() ?><input type="hidden" name="action" value="delete"><input type="hidden" name="id" value="<?= (int) $a['id'] ?>"><button class="btn btn-danger btn-xs">Delete</button></form></td></tr><?php endforeach; ?>
    </tbody></table></div>
  </div>
  <div class="panel">
    <h2><?= $edit ? 'Edit article' : 'New article' ?></h2>
    <p class="muted small" style="margin-top:6px">Published articles also teach your AI agent.</p>
    <form method="post" class="form" style="margin-top:12px"><?= csrf_field() ?><input type="hidden" name="action" value="article"><input type="hidden" name="id" value="<?= (int) ($edit['id'] ?? 0) ?>">
      <div class="field"><label>Title</label><input name="title" value="<?= e($edit['title'] ?? '') ?>" required></div>
      <div class="field"><label>Category</label><input name="category" value="<?= e($edit['category'] ?? 'General') ?>"></div>
      <div class="field"><label>Body</label><textarea name="body" rows="9" required><?= e($edit['body'] ?? '') ?></textarea></div>
      <label class="consent"><input type="checkbox" name="published" value="1" <?= !$edit || $edit['published'] ? 'checked' : '' ?>><span>Published</span></label>
      <button class="btn btn-primary btn-sm">Save article</button>
    </form>
  </div>
</div>
<div class="panel" style="margin-top:14px">
  <div class="panel-head"><h2>Macros</h2><span class="muted">Saved replies for agents</span></div>
  <ul style="padding-left:18px;margin:0 0 14px"><?php foreach ($macros as $m): ?><li><b><?= e($m['title']) ?></b>: <span class="muted"><?= e(mb_strimwidth($m['body'], 0, 120, '…')) ?></span></li><?php endforeach; ?></ul>
  <form method="post" class="form"><?= csrf_field() ?><input type="hidden" name="action" value="macro">
    <div class="row"><div class="field"><label>Title</label><input name="title" required></div><div class="field"><label>Sets status</label><select name="set_status"><option value="">No change</option><option value="pending">Pending</option><option value="solved">Solved</option></select></div></div>
    <div class="field"><label>Reply text</label><textarea name="body" required></textarea></div>
    <button class="btn btn-ghost btn-sm">Add macro</button></form>
</div>
