<?php $late = array_filter($tasks, fn($t) => $t['due_on'] < $today); $due = array_filter($tasks, fn($t) => $t['due_on'] >= $today); ?>
<p style="margin:0 0 16px">Good morning <?= e(explode(' ', (string) $a['uname'])[0]) ?>. Here is your day from <?= e($a['name']) ?>.</p>
<?php if (!$tasks && !$reminders): ?><p style="margin:0 0 16px">Nothing is due today or tomorrow. A good day to get ahead.</p><?php endif; ?>
<?php foreach ([['Overdue', $late, '#c2353b'], ['Due today and tomorrow', $due, '#0f8f80']] as [$h, $list, $c]): if (!$list) continue; ?>
<p style="margin:18px 0 6px;font-size:13px;font-weight:700;color:<?= $c ?>;text-transform:uppercase;letter-spacing:.04em"><?= $h ?></p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><?php foreach ($list as $t): ?><tr><td style="padding:8px 0;border-bottom:1px solid #e3e9eb;font-size:15px;color:#13262c">#<?= (int) $t['id'] ?> <?= e($t['title']) ?><?= $t['project'] ? '<span style="color:#5b6f76"> · ' . e($t['project']) . '</span>' : '' ?></td><td align="right" style="padding:8px 0;border-bottom:1px solid #e3e9eb;font-size:14px;color:#5b6f76;white-space:nowrap"><?= e(date('D j M', strtotime($t['due_on']))) ?></td></tr><?php endforeach; ?></table>
<?php endforeach; ?>
<?php if ($reminders): ?>
<p style="margin:18px 0 6px;font-size:13px;font-weight:700;color:#13262c;text-transform:uppercase;letter-spacing:.04em">Reminders today</p>
<?php foreach ($reminders as $r): ?><p style="margin:0 0 6px;font-size:15px"><?= e(gmdate('H:i', strtotime($r['due_at'] . ' UTC') + 7200)) ?> · <?= e($r['message']) ?></p><?php endforeach; ?>
<?php endif; ?>
<?= mail_button($link, 'Open ' . $a['name']) ?>
<?= mail_note('Change the time or turn this off in the assistant\'s settings.') ?>
