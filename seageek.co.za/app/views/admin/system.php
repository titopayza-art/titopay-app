<div class="grid cols-2">
  <div class="panel">
    <h2>Scheduled jobs</h2>
    <p class="muted small" style="margin:6px 0 12px">Run every minute. Either add a server cron job, or use an external cron service with the web URL.</p>
    <pre class="snippet">* * * * * php <?= e(realpath(APP_ROOT)) ?>/cli.php cron &gt;/dev/null 2&gt;&amp;1</pre>
    <div class="secret" style="margin-top:10px;font-size:12px"><span id="cronurl"><?= e($cronUrl) ?></span><button class="copy-btn" type="button" data-copy="cronurl">Copy</button></div>
    <table class="tbl" style="margin-top:14px"><thead><tr><th>Job</th><th>Last run (UTC)</th><th>Result</th></tr></thead><tbody><?php foreach ($jobs as $j): ?><tr><td class="small"><?= e(Ops::JOBS[$j['name']] ?? $j['name']) ?></td><td class="small"><?= e($j['last_run_at']) ?></td><td class="small muted"><?= e(mb_strimwidth((string) $j['last_result'], 0, 60, '…')) ?></td></tr><?php endforeach; ?><?php if (!$jobs): ?><tr><td colspan="3" class="empty">Jobs have not run yet.</td></tr><?php endif; ?></tbody></table>
  </div>
  <div class="panel">
    <h2>Server</h2>
    <dl class="kv" style="margin-top:12px"><dt>PHP</dt><dd><?= e($php) ?></dd><dt>Database</dt><dd><?= e($db) ?></dd><dt>Health check</dt><dd><a class="link" href="/health" target="_blank">/health</a></dd><dt>Worker</dt><dd class="small">For high volume run <span class="code-inline">php cli.php worker</span> under supervisor on one or more servers.</dd></dl>
    <h2 style="margin-top:20px">Failing webhooks</h2>
    <table class="tbl" style="margin-top:8px"><tbody><?php foreach ($webhooks as $w): ?><tr><td class="small"><?= e($w['org']) ?></td><td class="mono small"><?= e($w['event']) ?></td><td class="small"><?= (int) $w['attempts'] ?> tries</td><td class="mono small"><?= e($w['last_status'] ?? '-') ?></td></tr><?php endforeach; ?><?php if (!$webhooks): ?><tr><td class="empty">None.</td></tr><?php endif; ?></tbody></table>
  </div>
</div>
<div class="grid cols-2" style="margin-top:14px">
  <div class="panel flush"><div class="panel-head"><h2>Email outbox</h2></div><div class="tbl-wrap"><table class="tbl"><tbody><?php foreach ($outbox as $m): ?><tr title="<?= e($m['last_error']) ?>"><td class="small"><?= e($m['to_addr']) ?><div class="muted small"><?= e(mb_strimwidth($m['subject'], 0, 50, '…')) ?></div></td><td><?php $status = $m['status']; require APP_DIR . '/views/partials/status.php'; ?></td><td class="small muted nowrap"><?= e($m['created_at']) ?></td></tr><?php endforeach; ?></tbody></table></div></div>
  <div class="panel flush"><div class="panel-head"><h2>Audit log</h2></div><div class="tbl-wrap"><table class="tbl"><tbody><?php foreach ($audit as $a): ?><tr><td class="small mono"><?= e($a['action']) ?></td><td class="small"><?= e($a['email'] ?? 'system') ?></td><td class="small muted"><?= e(mb_strimwidth((string) $a['detail'], 0, 40, '…')) ?></td><td class="small muted nowrap"><?= e($a['created_at']) ?></td></tr><?php endforeach; ?></tbody></table></div></div>
</div>
<div class="panel flush" id="backups" style="margin-top:14px">
  <div class="panel-head"><h2>Backups</h2><form method="post" class="inline-form"><?= csrf_field() ?><input type="hidden" name="action" value="backup"><button class="btn btn-ghost btn-sm">Back up now</button></form></div>
  <p class="muted small" style="padding:0 20px 12px">A full backup of every table is made each night and the newest 14 are kept in <span class="code-inline">storage/backups</span>. Download one now and then and keep it off this server, together with <span class="code-inline">app_key</span> from <span class="code-inline">app/config.php</span>. Restore with <span class="code-inline">php cli.php restore FILE</span>.</p>
  <div class="tbl-wrap"><table class="tbl"><tbody>
    <?php foreach (array_slice($backups, 0, 14) as $b): ?><tr><td class="mono small"><?= e($b['name']) ?></td><td class="small muted"><?= number_format($b['size'] / 1024, 0) ?> KB</td><td class="small muted nowrap"><?= e(gmdate('j M Y H:i', $b['at'])) ?> UTC</td><td class="right"><a class="link small" href="/admin/system?download=<?= e(rawurlencode($b['name'])) ?>">Download</a></td></tr><?php endforeach; ?>
    <?php if (!$backups): ?><tr><td class="empty">No backups yet. The first is made tonight, or press Back up now.</td></tr><?php endif; ?>
  </tbody></table></div>
</div>
