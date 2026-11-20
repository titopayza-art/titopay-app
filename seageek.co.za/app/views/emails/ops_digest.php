<?php $lv = ['urgent' => ['#c2353b', 'Urgent'], 'today' => ['#0f8f80', 'Today'], 'week' => ['#8a6d1f', 'This week']]; ?>
<?php if ($todo): ?>
<p style="margin:0 0 16px">Good morning. Here is what needs a person today. Everything else ran by itself.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 4px;border-top:1px solid #e3e9eb">
<?php foreach ($todo as $t): ?>
  <tr><td style="padding:14px 0;border-bottom:1px solid #e3e9eb">
    <div style="font-size:12px;font-weight:600;color:<?= $lv[$t['level']][0] ?>;text-transform:uppercase;letter-spacing:.04em"><?= $lv[$t['level']][1] ?></div>
    <div style="font-size:16px;font-weight:600;color:#13262c;margin:3px 0"><?= e($t['title']) ?></div>
    <div style="font-size:14px;color:#5b6f76;line-height:1.5"><?= e($t['detail']) ?> <a href="<?= e(app_url($t['href'])) ?>" style="color:#0f8f80;font-weight:600"><?= e($t['action']) ?></a></div>
  </td></tr>
<?php endforeach; ?>
</table>
<?php else: ?>
<p style="margin:0 0 16px">Good morning. Nothing needs you today: support, billing, reminders and messages all ran by themselves.</p>
<?php endif; ?>
<p style="margin:22px 0 0;font-size:15px;font-weight:600;color:#13262c">Yesterday</p>
<?= mail_details($stats) ?>
<?= mail_button($link, 'Open the admin console') ?>
<?= mail_note('Sent every morning. Change the time or switch it off under Settings, Team alerts.') ?>
