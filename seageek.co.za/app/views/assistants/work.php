<?php $cols = ['todo' => 'To do', 'doing' => 'In progress', 'done' => 'Done']; $today = gmdate('Y-m-d', time() + 7200); ?>
<div class="work-top">
  <nav class="seg"><a class="<?= !$p ? 'on' : '' ?>" href="/dashboard/work">All</a><?php foreach ($projects as $pr): ?><a class="<?= $p === (int) $pr['id'] ? 'on' : '' ?>" href="?p=<?= (int) $pr['id'] ?>"><?= e($pr['name']) ?> <small><?= (int) $pr['open_n'] ?></small></a><?php endforeach; ?></nav>
  <form method="post" class="inline-form work-add"><?= csrf_field() ?><input type="hidden" name="action" value="project"><input name="name" placeholder="New project" aria-label="New project name" required><button class="btn btn-ghost btn-sm">Add project</button></form>
</div>
<form method="post" class="panel work-task"><?= csrf_field() ?><input type="hidden" name="action" value="task"><input type="hidden" name="p" value="<?= $p ?>">
  <input name="title" placeholder="Add a task" aria-label="Task" required style="flex:2;min-width:180px">
  <select name="project" aria-label="Project"><option value="">No project</option><?php foreach ($projects as $pr): ?><option value="<?= (int) $pr['id'] ?>" <?= $p === (int) $pr['id'] ? 'selected' : '' ?>><?= e($pr['name']) ?></option><?php endforeach; ?></select>
  <select name="assignee" aria-label="Assignee"><?php foreach ($team as $tm): ?><option value="<?= (int) $tm['id'] ?>"><?= e($tm['name']) ?></option><?php endforeach; ?></select>
  <input name="due_on" type="date" aria-label="Due date">
  <button class="btn btn-primary btn-sm">Add</button>
</form>
<div class="board">
  <?php foreach ($cols as $st => $label): $list = array_filter($tasks, fn($t) => $t['status'] === $st); ?>
    <section class="col"><h3><?= $label ?> <span class="muted"><?= count($list) ?></span></h3>
      <?php if (!$list): ?><p class="muted small empty-col"><?= $st === 'todo' ? 'Nothing to do. Ask an assistant to plan something.' : 'Nothing here.' ?></p><?php endif; ?>
      <?php foreach ($list as $t): $late = $t['due_on'] && $t['due_on'] < $today && $st !== 'done'; ?>
        <article class="tcard prio-<?= e($t['priority']) ?>">
          <b><?= e($t['title']) ?></b>
          <?php if ($t['notes']): ?><p><?= e(mb_strimwidth($t['notes'], 0, 140, '…')) ?></p><?php endif; ?>
          <small class="<?= $late ? 'warn' : 'muted' ?>">#<?= (int) $t['id'] ?><?= $t['due_on'] ? ' · ' . ($late ? 'Late, ' : 'Due ') . e(date('j M', strtotime($t['due_on']))) : '' ?><?= $t['project'] && !$p ? ' · ' . e($t['project']) : '' ?><?= $t['assignee'] ? ' · ' . e($t['assignee']) : '' ?><?= $t['created_by'] ? ' · by ' . e($t['created_by']) : '' ?></small>
          <form method="post" class="tmove"><?= csrf_field() ?><input type="hidden" name="action" value="move"><input type="hidden" name="id" value="<?= (int) $t['id'] ?>"><input type="hidden" name="p" value="<?= $p ?>">
            <?php foreach ($cols as $k => $l) if ($k !== $st): ?><button class="btn btn-ghost btn-xs" name="status" value="<?= $k ?>"><?= $l ?></button><?php endif; ?></form>
        </article>
      <?php endforeach; ?>
    </section>
  <?php endforeach; ?>
</div>
