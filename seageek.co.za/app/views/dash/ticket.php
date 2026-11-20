<?php
$names = ['customer' => $t['requester_name'] ?: 'Customer', 'ai' => 'SeaGeek AI', 'system' => 'System'];
$publicCount = count(array_filter($messages, fn($m) => !$m['internal']));
$fileLink = fn($f) => '<a class="att" href="' . e(DeskFiles::url($f)) . '" target="_blank" rel="noopener">' . icon('download') . '<span>' . e($f['name']) . '</span><small>' . e(DeskFiles::human((int) $f['size'])) . '</small></a>';
?>
<div class="toolbar">
  <a class="btn btn-ghost btn-sm" href="<?= e($base) ?>">All tickets</a>
  <span class="muted small">via <?= e(channel_label($t['channel'])) ?> · opened <?= e(date('j M Y H:i', strtotime($t['created_at'] . ' UTC'))) ?> UTC</span>
  <span class="presence" id="presence" hidden></span>
</div>
<div class="ticket-layout">
  <div>
    <div class="thread">
      <?php foreach ($messages as $m): $cls = $m['internal'] ? 'internal' : $m['author']; ?>
        <div class="msg <?= e($cls) ?>">
          <div class="who"><b><?= e($m['author'] === 'agent' ? ($m['author_name'] ?: 'Agent') : ($names[$m['author']] ?? $m['author'])) ?><?= $m['internal'] ? ' · internal note' : '' ?></b><span><?= e(date('j M H:i', strtotime($m['created_at'] . ' UTC'))) ?></span></div>
          <div class="body"><?= e($m['body']) ?></div>
          <?php if (!empty($files[(int) $m['id']])): ?><div class="atts"><?php foreach ($files[(int) $m['id']] as $f) echo $fileLink($f); ?></div><?php endif; ?>
        </div>
      <?php endforeach; ?>
    </div>
    <form method="post" class="reply-box panel" id="reply" enctype="multipart/form-data" data-ticket="<?= (int) $t['id'] ?>" data-last="<?= (int) $seenLast ?>"><?= csrf_field() ?><input type="hidden" name="action" value="reply"><input type="hidden" name="seen_last" value="<?= (int) $seenLast ?>">
      <?php if ($macros): ?><div class="toolbar" style="margin-bottom:10px"><span class="muted small">Saved replies:</span><?php foreach ($macros as $mc): ?><button type="button" class="btn btn-ghost btn-xs" data-macro="<?= e($mc['body']) ?>" data-status="<?= e($mc['set_status']) ?>"><?= e($mc['title']) ?></button><?php endforeach; ?></div><?php endif; ?>
      <div class="newer-note" id="newer-note" hidden>A new message arrived on this ticket. <a class="link" href="">Reload to read it</a> before you send.</div>
      <textarea name="body" id="reply-body" placeholder="Write a reply to <?= e($t['requester_name'] ?: ($t['requester_email'] ?: ($t['requester_phone'] ?: 'the customer'))) ?><?= $t['channel'] === 'whatsapp' ? ' (sent on WhatsApp)' : '' ?>"><?= e($draft) ?></textarea>
      <div class="reply-actions">
        <label class="file-pick"><?= icon('download') ?><span>Attach files</span><input type="file" name="files[]" multiple accept=".jpg,.jpeg,.png,.gif,.webp,.heic,.pdf,.txt,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.mp3,.m4a,.ogg,.mp4,.mov" data-file-list></label>
        <label class="consent"><input type="checkbox" name="internal" value="1"><span>Internal note</span></label>
        <select name="status" id="reply-status" class="mini-select"><option value="">Keep status</option><option value="open">Open</option><option value="pending">Pending (waiting on customer)</option><option value="solved">Solved</option></select>
        <button class="btn btn-primary btn-sm">Send</button>
      </div>
      <div class="file-list muted small" data-file-names></div>
    </form>
    <div class="toolbar" style="margin-top:8px">
      <form method="post" class="inline-form"><?= csrf_field() ?><input type="hidden" name="action" value="ai_draft"><button class="btn btn-ghost btn-sm"><?= icon('ai') ?>&nbsp;Draft a reply with AI</button></form>
      <?php if ($publicCount >= 4): ?><form method="post" class="inline-form"><?= csrf_field() ?><input type="hidden" name="action" value="summarise"><button class="btn btn-ghost btn-sm">Summarise with AI</button></form><?php endif; ?>
    </div>
  </div>
  <aside class="stack">
    <?php if ($context): $co = $context['org']; ?>
    <div class="panel ctx">
      <h2>SeaGeek account</h2>
      <p style="margin:8px 0 10px"><a class="link" href="/admin/orgs/<?= (int) $co['id'] ?>"><b><?= e($co['name']) ?></b></a></p>
      <dl class="kv" style="grid-template-columns:110px 1fr"><dt>Customer no.</dt><dd class="mono"><?= e($co['customer_no']) ?></dd><dt>Plan</dt><dd><?= e(ucfirst((string) $co['plan_code'])) ?></dd>
        <dt>Credit</dt><dd class="mono"><?= zar($co['balance']) ?></dd><dt>Unpaid</dt><dd class="mono<?= $context['unpaid'] > 0 ? ' warn' : '' ?>"><?= zar($context['unpaid']) ?></dd>
        <dt>Account</dt><dd><?= $co['status'] === 'active' ? ($co['live_enabled'] ? 'Live' : 'Sandbox only') : '<span class="warn">' . e(ucfirst($co['status'])) . '</span>' ?></dd>
        <dt>Last payment</dt><dd><?= $context['last_payment'] ? zar($context['last_payment']['amount']) . ', ' . e(date('j M', strtotime($context['last_payment']['created_at']))) : 'None' ?></dd>
        <?php if ($context['services']): ?><dt>Uses</dt><dd><?= e(implode(', ', array_map(fn($k) => service_names()[$k] ?? $k, $context['services']))) ?></dd><?php endif; ?></dl>
    </div>
    <?php endif; ?>
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
    <div class="panel">
      <h2>Merge</h2>
      <p class="muted small" style="margin:6px 0 10px">Same question asked twice? Move this ticket's messages into the other one. This one closes.</p>
      <form method="post" class="inline-form" style="display:flex;gap:8px" data-confirm="Merge #<?= (int) $t['number'] ?> into the ticket you entered? This cannot be undone."><?= csrf_field() ?><input type="hidden" name="action" value="merge"><input name="into" placeholder="Ticket number" inputmode="numeric" aria-label="Ticket number to merge into" style="flex:1;min-width:0"><button class="btn btn-ghost btn-sm">Merge</button></form>
    </div>
    <div class="panel"><h2>Reply target</h2><p class="small muted" style="margin-top:8px">First reply due <?= e(date('j M H:i', strtotime($t['sla_due_at'] . ' UTC'))) ?> UTC<?= $t['first_reply_at'] ? '. Replied ' . e(date('j M H:i', strtotime($t['first_reply_at'] . ' UTC'))) . '.' : '.' ?></p></div>
  </aside>
</div>
