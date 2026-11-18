<?php $names = ['customer' => $t['requester_name'] ?: 'Customer', 'ai' => 'AI agent', 'system' => 'System']; ?>
<div class="toolbar"><a class="btn btn-ghost btn-sm" href="<?= e($base) ?>">All tickets</a><span class="muted small">via <?= e(channel_label($t['channel'])) ?> · opened <?= e(date('j M Y H:i', strtotime($t['created_at'] . ' UTC'))) ?> UTC</span></div>
<div class="ticket-layout">
  <div>
    <div class="thread">
      <?php foreach ($messages as $m): $cls = $m['internal'] ? 'internal' : $m['author']; ?>
        <div class="msg <?= e($cls) ?>">
          <div class="who"><b><?= e($m['author'] === 'agent' ? ($m['author_name'] ?: 'Agent') : ($names[$m['author']] ?? $m['author'])) ?><?= $m['internal'] ? ' · internal note' : '' ?></b><span><?= e(date('j M H:i', strtotime($m['created_at'] . ' UTC'))) ?></span></div>
          <div class="body"><?= e($m['body']) ?></div>
        </div>
      <?php endforeach; ?>
    </div>
    <form method="post" class="reply-box panel"><?= csrf_field() ?><input type="hidden" name="action" value="reply">
      <?php if ($macros): ?><div class="toolbar" style="margin-bottom:10px"><span class="muted small">Macros:</span><?php foreach ($macros as $mc): ?><button type="button" class="btn btn-ghost btn-xs" data-macro="<?= e($mc['body']) ?>" data-status="<?= e($mc['set_status']) ?>"><?= e($mc['title']) ?></button><?php endforeach; ?></div><?php endif; ?>
      <textarea name="body" id="reply-body" placeholder="Write a reply to <?= e($t['requester_email'] ?: 'the customer') ?>"><?= e($draft) ?></textarea>
      <div class="reply-actions">
        <label><input type="checkbox" name="internal" value="1"> Internal note</label>
        <select name="status" id="reply-status" style="height:38px;border-radius:8px;border:1px solid var(--line-strong);background:var(--bg);color:var(--text);padding:0 10px"><option value="">Keep status</option><option value="open">Open</option><option value="pending">Pending (waiting on customer)</option><option value="solved">Solved</option></select>
        <button class="btn btn-primary btn-sm">Send</button>
      </div>
    </form>
    <form method="post" style="margin-top:8px"><?= csrf_field() ?><input type="hidden" name="action" value="ai_draft"><button class="btn btn-ghost btn-sm"><?= icon('ai') ?>&nbsp;Draft a reply with AI</button></form>
  </div>
  <aside class="stack">
    <div class="panel">
      <h2>Details</h2>
      <form method="post" class="form" style="margin-top:12px"><?= csrf_field() ?><input type="hidden" name="action" value="update">
        <div class="field"><label>Status</label><select name="status"><?php foreach (Desk::STATUSES as $s): ?><option <?= $t['status'] === $s ? 'selected' : '' ?> value="<?= $s ?>"><?= ucfirst($s) ?></option><?php endforeach; ?></select></div>
        <div class="field"><label>Priority</label><select name="priority"><?php foreach (Desk::PRIORITIES as $p): ?><option <?= $t['priority'] === $p ? 'selected' : '' ?> value="<?= $p ?>"><?= ucfirst($p) ?></option><?php endforeach; ?></select></div>
        <div class="field"><label>Assignee</label><select name="assignee_id"><option value="">Unassigned</option><?php foreach ($agents as $a): ?><option value="<?= (int) $a['id'] ?>" <?= (int) $t['assignee_id'] === (int) $a['id'] ? 'selected' : '' ?>><?= e($a['name']) ?></option><?php endforeach; ?></select></div>
        <div class="field"><label>Tags</label><input name="tags" value="<?= e($t['tags']) ?>"></div>
        <button class="btn btn-ghost btn-sm">Update</button>
      </form>
    </div>
    <div class="panel">
      <h2>Requester</h2>
      <dl class="kv" style="grid-template-columns:70px 1fr;margin-top:10px"><dt>Name</dt><dd><?= e($t['requester_name'] ?: '–') ?></dd><dt>Email</dt><dd><?= e($t['requester_email'] ?: '–') ?></dd><dt>Phone</dt><dd><?= e($t['requester_phone'] ?: '–') ?></dd><dt>Rating</dt><dd><?= $t['csat'] ? (int) $t['csat'] . ' / 5' : '–' ?></dd></dl>
      <?php if ($history): ?><h2 style="margin-top:16px;font-size:14px">Earlier requests</h2><ul style="padding-left:18px;margin:8px 0 0;font-size:14px"><?php foreach ($history as $h): ?><li><a class="link" href="<?= e($base) ?>/<?= (int) $h['number'] ?>">#<?= (int) $h['number'] ?></a> <?= e($h['subject']) ?></li><?php endforeach; ?></ul><?php endif; ?>
    </div>
    <div class="panel"><h2>SLA</h2><p class="small muted" style="margin-top:8px">First reply due <?= e(date('j M H:i', strtotime($t['sla_due_at'] . ' UTC'))) ?> UTC<?= $t['first_reply_at'] ? '. Replied ' . e(date('j M H:i', strtotime($t['first_reply_at'] . ' UTC'))) . '.' : '.' ?></p></div>
  </aside>
</div>
