<?php $h1 = e($title); $meta = 'Help centre'; $lead = 'Search our articles, or start a chat in the corner.'; require APP_DIR . '/views/site/_pagehero.php'; $grouped = []; foreach ($articles as $a) $grouped[$a['category']][] = $a; $base = $org['is_house'] ? '/help/' : '/h/' . $org['slug'] . '/'; ?>
<section class="section" style="padding-top:48px"><div class="wrap">
  <form method="get" class="toolbar"><input name="q" value="<?= e($q) ?>" placeholder="Search articles" style="flex:1;max-width:520px;height:48px;font-size:16px"><button class="btn btn-primary">Search</button></form>
  <?php if (!$articles): ?><div class="empty">No articles match. Try other words, or <a class="link" href="/contact">contact us</a>.</div><?php endif; ?>
  <div class="grid cols-3" style="margin-top:20px">
    <?php foreach ($grouped as $cat => $list): ?><div class="panel"><h2><?= e($cat) ?></h2><ul style="list-style:none;padding:0;margin:12px 0 0;display:grid;gap:8px"><?php foreach ($list as $a): ?><li><a class="link" href="<?= e($base . $a['slug']) ?>"><?= e($a['title']) ?></a></li><?php endforeach; ?></ul></div><?php endforeach; ?>
  </div>
  <?php if (!$org['is_house']) { $poweredRef = 'help'; require APP_DIR . '/views/partials/powered.php'; } ?>
</div></section>
<?php if (!$org['is_house']): ?><script>window.SEAGEEK_CHAT_ORG = <?= json_encode($org['slug']) ?>;</script><?php endif; ?>
