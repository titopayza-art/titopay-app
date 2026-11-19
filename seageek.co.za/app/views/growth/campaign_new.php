<?php
$crumbs = [[$base === '/dashboard' ? 'Campaigns' : 'Marketing', $listBase], ['New ' . ($channel === 'sms' ? 'SMS campaign' : 'email'), null]];
require APP_DIR . '/views/partials/crumbs.php';
$values = ['name' => $tpl[2] ?? '', 'subject' => $tpl[3] ?? '', 'body' => $tpl[4] ?? '', 'audience' => array_key_first($audiences)];
?>
<div class="tabs-row"><a class="<?= $channel === 'sms' ? 'on' : '' ?>" href="?channel=sms">SMS</a><a class="<?= $channel === 'email' ? 'on' : '' ?>" href="?channel=email">Email</a></div>
<div class="grid" style="grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);align-items:start" id="cn-grid">
  <form method="post" class="panel form"><?= csrf_field() ?><input type="hidden" name="channel" value="<?= e($channel) ?>">
    <h2><?= $channel === 'sms' ? 'SMS campaign' : 'Email newsletter' ?></h2>
    <?php require __DIR__ . '/_campaign_fields.php'; ?>
    <label class="consent"><input type="checkbox" name="save_template" value="1"><span>Also save this message as a template</span></label>
    <button class="btn btn-primary btn-sm">Save and preview</button>
    <p class="muted small">Nothing is sent yet. On the next page you see the cost, send yourself a test, then send or schedule it.</p>
  </form>
  <div>
    <div class="panel flush">
      <div class="panel-head"><h2>Templates</h2><span class="muted">Click one to start from it</span></div>
      <div class="tpl-list">
        <?php foreach ($library as $i => [$ch, $cat, $name, $subj, $body]): if ($ch !== $channel) continue; ?>
          <a class="tpl" href="?channel=<?= e($ch) ?>&amp;t=<?= $i ?>"><span class="tpl-cat"><?= e($cat) ?></span><b><?= e($name) ?></b><span class="muted small"><?= e(mb_strimwidth(str_replace("\n", ' ', $body), 0, 120, '…')) ?></span></a>
        <?php endforeach; ?>
        <?php foreach ($mine as $m): if ($m['channel'] !== $channel) continue; ?>
          <a class="tpl" href="?mine=<?= (int) $m['id'] ?>"><span class="tpl-cat">Saved</span><b><?= e($m['name']) ?></b><span class="muted small"><?= e(mb_strimwidth(str_replace("\n", ' ', $m['body']), 0, 120, '…')) ?></span></a>
        <?php endforeach; ?>
      </div>
    </div>
  </div>
</div>
<style>@media (max-width: 1000px) { #cn-grid { grid-template-columns: 1fr !important; } }</style>
