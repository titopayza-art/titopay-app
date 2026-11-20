<?php $tpls = Assistants::templates(); ?>
<?php if (!$aiReady): ?><div class="alert alert-error">SeaGeek AI is not switched on yet, so assistants cannot answer. Contact SeaGeek support.</div><?php endif; ?>
<?php if ($list): ?>
<div class="asst-grid">
  <?php foreach ($list as $a): ?>
    <a class="panel asst-card" href="/dashboard/assistants/<?= e($a['public_id']) ?>">
      <span class="asst-av" style="--c:<?= e($a['color']) ?>"><?= e(mb_strtoupper(mb_substr($a['name'], 0, 1))) ?></span>
      <div><b><?= e($a['name']) ?></b><small><?= e($tpls[$a['role']][0] ?? 'Assistant') ?> · <?= $a['shared'] ? 'Team' : 'Private' ?></small></div>
      <span class="muted small"><?= (int) $a['chats'] ?> conversation<?= (int) $a['chats'] === 1 ? '' : 's' ?><?= $a['last_at'] ? ' · ' . e(Ops::ago($a['last_at'])) : '' ?></span>
    </a>
  <?php endforeach; ?>
</div>
<h2 class="asst-h2">Add another assistant</h2>
<?php else: ?>
<div class="asst-intro">
  <h2>Your own AI assistants for work</h2>
  <p>Each assistant has a job, learns from your documents, remembers what you tell it, and gets things done: tasks and projects, reminders, email and SMS drafts you approve, and your support tickets. Your team can share them, and you can give a customer or partner a link to one.</p>
</div>
<?php endif; ?>
<div class="tpl-grid">
  <?php foreach ($tpls as $k => [$name, $line, , $groups, , $color]): ?>
    <form method="post" class="panel tpl"><?= csrf_field() ?><input type="hidden" name="template" value="<?= e($k) ?>">
      <span class="asst-av" style="--c:<?= e($color) ?>"><?= e(mb_substr($name, 0, 1)) ?></span>
      <h3><?= e($name) ?></h3>
      <p><?= e($line) ?></p>
      <p class="tpl-tools"><?= e(implode(' · ', array_map(fn($g) => Assistants::GROUPS[$g][0], $groups))) ?></p>
      <button class="btn btn-ghost btn-sm">Create</button>
    </form>
  <?php endforeach; ?>
</div>
<p class="muted small" style="margin-top:14px">Assistants are billed as SeaGeek AI usage from your credit, within the monthly AI spending cap you set under <a class="link" href="/dashboard/service/ai">AI</a>. SMS they send after your approval costs the normal SMS rate.</p>
