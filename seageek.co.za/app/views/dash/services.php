<?php
$crumbs = [['Overview', '/dashboard'], ['Services', null]];
require APP_DIR . '/views/partials/crumbs.php';
$svcStatus = $status;
$byService = [];
foreach ($packages as $p) $byService[$p['service']][] = $p;
$all = Catalog::services();
$counts = array_count_values($svcStatus);
$labels = ['active' => ['green', 'Active'], 'pending' => ['amber', 'Pending approval'], 'inactive' => ['', 'Not active']];
?>
<div class="panel" style="margin-bottom:14px">
  <div class="panel-head"><h2>Choose your services</h2><span class="custno">Customer no. <b><?= e($org['customer_no']) ?></b></span></div>
  <p class="muted" style="max-width:860px">Tick every service you need and switch them on together. Switching a service on is free: usage comes out of your one credit balance, and everything appears on one invoice and one monthly statement. Packages are optional. They add credit, and the bigger ones include bonus credit.</p>
  <div class="refbox" style="margin-top:14px">
    <div><span>Active services</span><b><?= (int) ($counts['active'] ?? 0) ?> of <?= count($svcStatus) ?></b></div>
    <div><span>Credit balance</span><b><?= zar($org['balance']) ?></b></div>
    <div><span>Plan</span><b style="font-family:var(--font-sans)"><?= e($plan['name']) ?></b></div>
  </div>
</div>

<form method="post" id="svc-form"><?= csrf_field() ?><input type="hidden" name="action" value="select">
<div class="svc-cards">
  <?php foreach ($svcStatus as $svc => $st): $s = $all[$svc]; $next = Services::nextStep($org, $svc); [$pcls, $plabel] = $labels[$st]; $pk = $byService[$svc] ?? []; ?>
  <div class="svc-card" data-svc>
    <div class="head"><span class="product-icon"><?= icon($s['icon']) ?></span><b><?= e($s['name']) ?></b><span class="pill <?= $pcls ?>"><?= e($plabel) ?></span></div>
    <p><?= e($s['summary']) ?></p>
    <div class="price"><?= e(Services::fromPrice($org, $svc)) ?></div>
    <?php if ($st !== 'inactive' && $next): ?><div class="next"><?= e($next) ?></div><?php endif; ?>
    <?php if ($st === 'inactive'): ?>
      <label class="pick"><input type="checkbox" name="services[]" value="<?= e($svc) ?>" data-pick> Select <?= e($s['name']) ?></label>
    <?php elseif ($pk): ?>
      <label class="pick"><input type="checkbox" name="services[]" value="<?= e($svc) ?>" data-pick> Add a package</label>
    <?php endif; ?>
    <?php if ($pk): ?>
      <div class="pkg-list" data-pkgs hidden>
        <?php if ($st === 'inactive'): ?><label class="pkg-opt"><input type="radio" name="package[<?= e($svc) ?>]" value="" checked><span><b>No package</b><span class="d">Pay as you use from your balance</span></span><span class="p"></span></label><?php endif; ?>
        <?php foreach ($pk as $i => $p): ?>
          <label class="pkg-opt"><input type="radio" name="package[<?= e($svc) ?>]" value="<?= e($p['code']) ?>" <?= $st !== 'inactive' && $i === 0 ? 'checked' : '' ?>><span><b><?= e($p['name']) ?></b><span class="d"><?= e($p['description']) ?></span></span><span class="p"><?= zar($p['price'], 0) ?></span></label>
        <?php endforeach; ?>
        <div class="qty">Quantity <input type="number" name="qty[<?= e($svc) ?>]" value="1" min="1" max="100" aria-label="Quantity"></div>
      </div>
    <?php endif; ?>
    <div class="foot">
      <?php if ($st === 'active'): ?><a class="btn btn-ghost btn-xs" href="<?= $svc === 'desk' ? '/dashboard/desk' : '/dashboard/service/' . e($svc) ?>">Open <?= e($s['name']) ?></a><?php else: ?><span class="on-note">Sandbox works before you switch on</span><?php endif; ?>
      <a class="link small" href="/docs/<?= e($svc) ?>" target="_blank" rel="noopener">Docs</a>
    </div>
  </div>
  <?php endforeach; ?>
</div>
<div class="select-bar" data-bar hidden>
  <div class="sum" data-sum>Nothing selected</div>
  <button class="btn btn-primary" data-go>Continue</button>
</div>
</form>

<?php foreach ($svcStatus as $svc => $st): if ($st === 'inactive') continue; ?>
  <form method="post" id="off-<?= e($svc) ?>" data-confirm="Switch off <?= e($all[$svc]['name']) ?>? Live requests for it will be refused until you switch it on again."><?= csrf_field() ?><input type="hidden" name="action" value="deactivate"><input type="hidden" name="service" value="<?= e($svc) ?>"></form>
<?php endforeach; ?>

<div class="panel flush" style="margin-top:14px">
  <div class="panel-head"><h2>Switched on</h2><span class="muted">Switch off anything you no longer use</span></div>
  <div class="tbl-wrap"><table class="tbl"><tbody>
    <?php $any = false; foreach ($svcStatus as $svc => $st): if ($st === 'inactive') continue; $any = true; ?>
      <tr><td><?= icon($all[$svc]['icon'], 'ic-inline') ?> <?= e($all[$svc]['name']) ?></td><td><?php $status = $st; require APP_DIR . '/views/partials/status.php'; ?></td><td class="muted small"><?= e(Services::nextStep($org, $svc) ?? 'Ready for live traffic') ?></td><td class="right"><button class="btn btn-ghost btn-xs" form="off-<?= e($svc) ?>">Switch off</button></td></tr>
    <?php endforeach; ?>
    <?php if (!$any): ?><tr><td class="empty">No services switched on yet. Pick them above.</td></tr><?php endif; ?>
  </tbody></table></div>
</div>
<p class="muted small" style="margin-top:14px">Coming in 2028: Notify (push notifications) and Sign (electronic signatures).</p>
