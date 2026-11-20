<?php $max = max(1, max($r['series'])); ?>
<div class="toolbar"><a class="btn btn-ghost btn-sm" href="<?= e($base) ?>/desk">Back to tickets</a><span class="seg"><?php foreach ([7, 30, 90] as $d): ?><a class="<?= $d === $days ? 'on' : '' ?>" href="?days=<?= $d ?>"><?= $d ?> days</a><?php endforeach; ?></span></div>
<div class="grid cols-4">
  <div class="panel stat"><div class="k">Tickets</div><div class="v"><?= number_format($r['total']) ?></div><div class="d"><?= number_format($r['solved']) ?> solved · <?= $r['open_now'] ?> open now</div></div>
  <div class="panel stat"><div class="k">Answered by AI alone</div><div class="v"><?= $r['ai_pct'] ?>%</div><div class="d"><?= number_format($r['ai']) ?> tickets without a person</div></div>
  <div class="panel stat"><div class="k">First reply from a person</div><div class="v"><?= e(DeskReports::hours($r['first_reply'])) ?></div><div class="d">Median<?= $r['within_target'] !== null ? ' · ' . $r['within_target'] . '% within target' : '' ?></div></div>
  <div class="panel stat"><div class="k">Satisfaction</div><div class="v"><?= $r['csat'] !== null ? $r['csat'] . ' / 5' : 'n/a' ?></div><div class="d"><?= $r['csat_n'] ?> rating<?= $r['csat_n'] === 1 ? '' : 's' ?> · solved in <?= e(DeskReports::hours($r['resolution'])) ?> (median)</div></div>
</div>
<div class="grid" style="grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);margin-top:14px;align-items:start" id="dr-grid">
  <div class="panel">
    <div class="panel-head"><h2>New tickets per day</h2><span class="muted small"><?= number_format($r['total']) ?> in <?= $days ?> days</span></div>
    <div class="day-bars" role="img" aria-label="New tickets per day" style="grid-template-columns:repeat(<?= count($r['series']) ?>,1fr)">
      <?php foreach ($r['series'] as $d => $n): ?><span title="<?= e(date('j M', strtotime($d))) ?>: <?= $n ?> ticket<?= $n === 1 ? '' : 's' ?>"><i style="height:<?= $n ? max(4, round($n / $max * 100)) : 0 ?>%"></i></span><?php endforeach; ?>
    </div>
    <div class="day-axis"><span><?= e(date('j M', strtotime(array_key_first($r['series'])))) ?></span><span>Today</span></div>
  </div>
  <div class="panel">
    <h2>By channel</h2>
    <?php if (!$r['channels']): ?><p class="muted small" style="margin-top:10px">No tickets in this period.</p><?php else: $top = max($r['channels']); ?>
    <div class="bars" style="margin-top:12px"><?php foreach ($r['channels'] as $c => $n): ?><div class="bar-row"><span><?= e(channel_label($c)) ?></span><span class="track"><i style="width:<?= round($n / $top * 100) ?>%"></i></span><span class="right mono small"><?= $n ?></span></div><?php endforeach; ?></div><?php endif; ?>
    <h2 style="margin-top:20px">Ratings</h2>
    <div class="bars" style="margin-top:12px"><?php $tm = max(1, max($r['csat_dist'])); foreach (array_reverse($r['csat_dist'], true) as $k => $n): ?><div class="bar-row"><span><?= $k ?> of 5</span><span class="track"><i style="width:<?= round($n / $tm * 100) ?>%"></i></span><span class="right mono small"><?= $n ?></span></div><?php endforeach; ?></div>
  </div>
</div>
<div class="grid cols-2" style="margin-top:14px;align-items:start">
  <div class="panel flush"><div class="panel-head"><h2>Team</h2></div>
    <?php if (!$r['agents']): ?><div class="empty">No replies from the team in this period.</div><?php else: ?>
    <table class="tbl"><thead><tr><th>Person</th><th class="right">Replies</th><th class="right">Tickets</th></tr></thead><tbody><?php foreach ($r['agents'] as $ag): ?><tr><td><?= e($ag['name']) ?></td><td class="right mono"><?= (int) $ag['replies'] ?></td><td class="right mono"><?= (int) $ag['tickets'] ?></td></tr><?php endforeach; ?></tbody></table><?php endif; ?>
  </div>
  <div class="panel flush"><div class="panel-head"><h2>Top tags</h2><span class="muted small">Add tags by hand or with rules</span></div>
    <?php if (!$r['tags']): ?><div class="empty">No tags yet.</div><?php else: ?>
    <table class="tbl"><tbody><?php foreach ($r['tags'] as $tag => $n): ?><tr><td><span class="pill"><?= e($tag) ?></span></td><td class="right mono"><?= $n ?></td></tr><?php endforeach; ?></tbody></table><?php endif; ?>
  </div>
</div>
