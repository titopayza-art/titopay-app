<?php
$label = fn(string $a): string => ['access.denied' => 'Tried to open a page without access', 'team.invited' => 'Invited a team member', 'team.removed' => 'Removed a team member', 'team.access_changed' => 'Changed someone\'s access',
    'desk.reply' => 'Replied to a ticket', 'desk.update' => 'Changed a ticket', 'desk.merge' => 'Merged tickets', 'assistant.action_approved' => 'Approved an assistant message', 'assistant.created' => 'Created an assistant',
    'assistant.deleted' => 'Deleted an assistant', 'assistant.action_cancelled' => 'Cancelled an assistant message', 'privacy.settings_saved' => 'Changed data protection settings', 'privacy.exported' => 'Downloaded a copy of the company data',
    'wa_template.saved' => 'Saved a WhatsApp template', 'wa_template.deleted' => 'Deleted a WhatsApp template', 'settings.company' => 'Changed company details'][$a] ?? ucfirst(str_replace(['.', '_'], [' · ', ' '], $a));
?>
<p class="muted" style="margin-bottom:12px;max-width:760px">Every change made in your account, who made it and when. Entries are kept for at least 12 months and cannot be edited.</p>
<form method="get" class="toolbar" style="margin-bottom:12px"><select name="user" aria-label="Person" style="height:40px"><option value="">Everyone</option><?php foreach ($people as $p): ?><option value="<?= (int) $p['id'] ?>" <?= $who === (int) $p['id'] ? 'selected' : '' ?>><?= e($p['name']) ?></option><?php endforeach; ?></select><button class="btn btn-ghost btn-sm">Filter</button></form>
<div class="panel flush">
  <?php if (!$rows): ?><div class="empty">Nothing recorded yet.</div><?php else: ?>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>When (UTC)</th><th>Who</th><th>What</th><th>Details</th></tr></thead><tbody>
  <?php foreach ($rows as $r): ?><tr><td class="small muted nowrap"><?= e(date('j M Y H:i', strtotime($r['created_at'] . ' UTC'))) ?></td><td class="small"><?= e($r['uname'] ?: 'System') ?><div class="muted small"><?= e($r['uemail'] ?? '') ?></div></td><td><?= e($label($r['action'])) ?></td><td class="small muted" style="overflow-wrap:anywhere;max-width:340px"><?= e($r['detail'] ?? '') ?></td></tr><?php endforeach; ?>
  </tbody></table></div><?php endif; ?>
</div>
