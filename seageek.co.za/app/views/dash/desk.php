<?php $root = str_starts_with($base, '/admin') ? '/admin' : '/dashboard'; ?>
<div class="toolbar" style="justify-content:flex-end"><a class="btn btn-ghost btn-sm" href="<?= $root ?>/desk-reports">Reports</a><a class="btn btn-ghost btn-sm" href="<?= $root ?>/desk-settings">Channels and rules</a></div>
<?php if (!empty($setup)): $done = count(array_filter($setup, fn($x) => $x[3])); ?>
<div class="panel setup" style="margin-bottom:14px">
  <div class="panel-head"><h2>Set up Desk in five steps</h2><span class="muted small"><?= $done ?> of <?= count($setup) ?> done</span></div>
  <div class="setup-bar" role="progressbar" aria-valuenow="<?= $done ?>" aria-valuemin="0" aria-valuemax="<?= count($setup) ?>"><i style="width:<?= round($done / count($setup) * 100) ?>%"></i></div>
  <ol class="setup-steps"><?php foreach ($setup as [$t, $d, $href, $ok]): ?>
    <li class="<?= $ok ? 'done' : '' ?>"><span class="tick" aria-hidden="true"></span><div><b><?= e($t) ?></b><small><?= e($d) ?></small></div><?php if (!$ok): ?><a class="btn btn-ghost btn-xs" href="<?= e($href) ?>">Do it</a><?php else: ?><span class="muted small">Done</span><?php endif; ?></li>
  <?php endforeach; ?></ol>
</div>
<?php endif; ?>
<?php $labels = ['open' => 'Open', 'mine' => 'Mine', 'ai' => 'AI handling', 'pending' => 'Pending', 'breached' => 'Overdue', 'solved' => 'Solved', 'all' => 'All']; ?>
<div class="grid cols-4">
  <div class="panel stat"><div class="k">Open</div><div class="v"><?= $stats['open'] ?></div><div class="d"><?= $stats['pending'] ?> waiting on customer</div></div>
  <div class="panel stat"><div class="k">New in 30 days</div><div class="v"><?= $stats['created_30d'] ?></div><div class="d">All channels</div></div>
  <div class="panel stat"><div class="k">Handled by AI</div><div class="v"><?= $stats['ai_handled_30d'] ?></div><div class="d">No agent reply needed</div></div>
  <div class="panel stat"><div class="k">Satisfaction</div><div class="v"><?= $stats['csat'] !== null ? $stats['csat'] . ' / 5' : '–' ?></div><div class="d"><?= $stats['breached'] ?> past first-reply target</div></div>
</div>
<div class="panel flush" style="margin-top:14px">
  <div class="tabs-row" style="padding:0 12px;margin:0">
    <?php foreach ($labels as $k => $l): ?><a href="?view=<?= $k ?>" class="<?= $view === $k ? 'on' : '' ?>"><?= $l ?><span><?= $counts[$k] ?></span></a><?php endforeach; ?>
    <form method="get" style="margin-left:auto;padding:6px 8px"><input type="hidden" name="view" value="<?= e($view) ?>"><input name="q" value="<?= e($q) ?>" placeholder="Search tickets" style="height:34px;padding:0 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--bg);color:var(--text);font:inherit;font-size:14px"></form>
  </div>
  <?php if (!$tickets): ?><div class="empty">No tickets here. Tickets arrive from your website chat, email, WhatsApp, forms, the help centre and the API. Connect channels under Channels and rules.</div><?php else: ?>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>Subject</th><th>Requester</th><th>Channel</th><th>Priority</th><th>Status</th><th>Assignee</th><th>Updated</th></tr></thead><tbody>
  <?php foreach ($tickets as $t): ?>
    <tr class="click" onclick="location.href='<?= e($base) ?>/<?= (int) $t['number'] ?>'">
      <td class="mono small"><?= (int) $t['number'] ?></td>
      <td><a href="<?= e($base) ?>/<?= (int) $t['number'] ?>"><?= e($t['subject']) ?></a><?= $t['ai_active'] ? ' <span class="pill violet">AI</span>' : '' ?><?= str_contains((string) $t['tags'], 'sla-breach') ? ' <span class="pill red">Overdue</span>' : '' ?></td>
      <td class="small"><?= e($t['requester_name'] ?: ($t['requester_email'] ?: $t['requester_phone'])) ?></td>
      <td class="small muted nowrap"><?= icon(['chat' => 'chat', 'email' => 'mail', 'whatsapp' => 'whatsapp', 'web' => 'form', 'api' => 'code'][$t['channel']] ?? 'chat', 'ch-ic') ?> <?= e(channel_label($t['channel'])) ?></td>
      <td class="small prio-<?= e($t['priority']) ?>"><?= e(ucfirst($t['priority'])) ?></td>
      <td><?php $status = $t['status']; require APP_DIR . '/views/partials/status.php'; ?></td>
      <td class="small"><?= e($t['assignee'] ?? '–') ?></td>
      <td class="small muted nowrap"><?= e(date('j M H:i', strtotime($t['updated_at'] . ' UTC'))) ?></td>
    </tr>
  <?php endforeach; ?></tbody></table></div><?php endif; ?>
</div>
