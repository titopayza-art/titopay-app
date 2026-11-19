<?php $isHouse = !empty($org['is_house']); ?>
<div class="toolbar" style="justify-content:space-between">
  <p class="muted" style="margin:0;max-width:760px"><?= $isHouse ? 'Newsletters and announcements from SeaGeek to customers and website subscribers.' : 'Bulk SMS and email newsletters to your contact lists, with ready-made templates, opt-outs handled for you and results per message.' ?></p>
  <div class="toolbar" style="margin:0"><a class="btn btn-ghost btn-sm" href="<?= e($cBase) ?>/new?channel=email"><?= icon('mail') ?>New email</a><a class="btn btn-primary btn-sm" href="<?= e($cBase) ?>/new?channel=sms"><?= icon('sms') ?>New SMS campaign</a></div>
</div>
<?php if (!$campaigns): ?>
<div class="panel empty-state">
  <h2>Send your first campaign</h2>
  <ol class="howto" style="max-width:640px;margin:14px auto 0;text-align:left">
    <li><b>1</b><span>Create a contact list and import your customers from a CSV file.<?= $lists ? '' : ' <a class="link" href="' . e($base) . '/contacts">Go to Contacts</a>' ?></span></li>
    <li><b>2</b><span>Pick a template or write your message. {first_name} is filled in for each person.</span></li>
    <li><b>3</b><span>Send yourself a test, then send now or schedule it. Results show per message.</span></li>
  </ol>
</div>
<?php else: ?>
<div class="panel flush">
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Campaign</th><th>Channel</th><th>Status</th><th class="right">Recipients</th><th class="right">Sent</th><th class="right">Failed</th><th class="right">Cost</th><th>Date</th></tr></thead><tbody>
    <?php foreach ($campaigns as $c): ?><tr class="click" onclick="location.href='<?= e($cBase . '/' . $c['public_id']) ?>'">
      <td><a class="link" href="<?= e($cBase . '/' . $c['public_id']) ?>"><?= e($c['name']) ?></a></td>
      <td class="small"><?= $c['channel'] === 'sms' ? 'SMS' : 'Email' ?></td>
      <td><?php $status = $c['status']; require APP_DIR . '/views/partials/status.php'; ?></td>
      <td class="right mono small"><?= number_format((int) $c['total']) ?></td><td class="right mono small"><?= number_format((int) $c['sent']) ?></td><td class="right mono small"><?= number_format((int) $c['failed']) ?></td>
      <td class="right mono small"><?= zar($c['cost']) ?></td>
      <td class="small nowrap"><?= e(date('j M Y', strtotime(($c['started_at'] ?: $c['scheduled_at'] ?: $c['created_at'])))) ?></td></tr><?php endforeach; ?>
  </tbody></table></div>
</div>
<?php endif; ?>
