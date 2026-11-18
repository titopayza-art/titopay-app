<?php $ok = $cron !== '' && strtotime($cron . ' UTC') > time() - 600; $failing = array_filter($partners, fn($p) => (int) $p['fail_count'] >= 5); ?>
<section class="section" style="padding-top:130px"><div class="wrap" style="max-width:820px">
  <h1 style="font-size:clamp(32px,4.4vw,46px)">Service status</h1>
  <div class="alert <?= $ok && !$failing ? 'alert-ok' : 'alert-warn' ?>" style="margin-top:20px"><?= $ok && !$failing ? 'All systems operating normally.' : 'Some services are degraded. We are on it.' ?></div>
  <div class="panel flush"><table class="tbl"><tbody>
    <tr><td>API and dashboard</td><td class="right"><span class="pill green">Operational</span></td></tr>
    <tr><td>Scheduled processing (billing, queues, email)</td><td class="right"><span class="pill <?= $ok ? 'green' : 'amber' ?>"><?= $ok ? 'Operational' : 'Delayed' ?></span></td></tr>
    <?php $bySvc = []; foreach ($partners as $p) $bySvc[$p['service']][] = $p; foreach ($bySvc as $svc => $ps): $healthy = array_filter($ps, fn($p) => (int) $p['fail_count'] < 5); ?>
    <tr><td><?= e(service_names()[$svc] ?? $svc) ?> delivery</td><td class="right"><span class="pill <?= $healthy ? 'green' : 'red' ?>"><?= $healthy ? (count($healthy) < count($ps) ? 'Running on backup route' : 'Operational') : 'Disrupted' ?></span></td></tr>
    <?php endforeach; ?>
  </tbody></table></div>
  <p class="muted small" style="margin-top:12px">Updated <?= gmdate('j M Y H:i') ?> UTC. Machine-readable: <a class="link" href="/health">/health</a></p>
</div></section>
