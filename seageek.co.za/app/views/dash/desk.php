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
  <?php if (!$tickets): ?><div class="empty">No tickets here. Tickets arrive from your chat widget, help centre, WhatsApp, email and the API.</div><?php else: ?>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>Subject</th><th>Requester</th><th>Channel</th><th>Priority</th><th>Status</th><th>Assignee</th><th>Updated</th></tr></thead><tbody>
  <?php foreach ($tickets as $t): ?>
    <tr class="click" onclick="location.href='<?= e($base) ?>/<?= (int) $t['number'] ?>'">
      <td class="mono small"><?= (int) $t['number'] ?></td>
      <td><a href="<?= e($base) ?>/<?= (int) $t['number'] ?>"><?= e($t['subject']) ?></a><?= $t['ai_active'] ? ' <span class="pill violet">AI</span>' : '' ?><?= str_contains((string) $t['tags'], 'sla-breach') ? ' <span class="pill red">Overdue</span>' : '' ?></td>
      <td class="small"><?= e($t['requester_name'] ?: ($t['requester_email'] ?: $t['requester_phone'])) ?></td>
      <td class="small muted"><?= e(channel_label($t['channel'])) ?></td>
      <td class="small prio-<?= e($t['priority']) ?>"><?= e(ucfirst($t['priority'])) ?></td>
      <td><?php $status = $t['status']; require APP_DIR . '/views/partials/status.php'; ?></td>
      <td class="small"><?= e($t['assignee'] ?? '–') ?></td>
      <td class="small muted nowrap"><?= e(date('j M H:i', strtotime($t['updated_at'] . ' UTC'))) ?></td>
    </tr>
  <?php endforeach; ?></tbody></table></div><?php endif; ?>
</div>
