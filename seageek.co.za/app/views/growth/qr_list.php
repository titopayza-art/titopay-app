<?php
$isHouse = !empty($org['is_house']);
$units = balance_units($org);
?>
<div class="grid" style="grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);align-items:start" id="qr-grid">
  <form method="post" class="panel form"><?= csrf_field() ?>
    <div class="panel-head" style="margin-bottom:4px"><h2>Create a QR code</h2><?php if (!$isHouse): ?><span class="price-tag"><?= zar($price) ?> per code</span><?php endif; ?></div>
    <div class="field"><label for="qr-url">Link people should open</label><input id="qr-url" name="url" type="url" inputmode="url" placeholder="https://yourbusiness.co.za/menu" required></div>
    <div class="field"><label for="qr-name">Name <span class="muted">(only you see this)</span></label><input id="qr-name" name="name" placeholder="Table cards, flyer, shop window"></div>
    <div class="choice-row">
      <label class="choice"><input type="radio" name="type" value="dynamic" checked><span><b>Dynamic</b><small>Prints a short SeaGeek link. Change where it points any time, and see how many people scan it.</small></span></label>
      <label class="choice"><input type="radio" name="type" value="static"><span><b>Static</b><small>Holds your link itself. Works forever, but cannot be changed or counted.</small></span></label>
    </div>
    <div class="field"><label for="qr-color">Colour</label><div class="color-row"><input id="qr-color" name="color" type="color" value="#0b1f27" aria-label="QR colour"><span class="muted small">Dark colours on white scan best. Very light colours are refused.</span></div></div>
    <button class="btn btn-primary"><?= $isHouse ? 'Create QR code' : 'Create QR code for ' . zar($price) ?></button>
    <?php if (!$isHouse): ?><p class="muted small">Charged once from your credit. You have <b style="color:var(--text)"><?= zar($org['balance']) ?></b>, enough for <?= number_format($units['qr']) ?> codes. <a class="link" href="/dashboard/billing#topup">Add credit</a></p><?php endif; ?>
  </form>
  <div class="panel">
    <h2>How it works</h2>
    <ol class="howto">
      <li><b>1</b><span>Paste the link: your menu, payment page, WhatsApp chat, Google review page or anything else.</span></li>
      <li><b>2</b><span>Download the code as PNG for documents and social posts, or SVG for printing at any size.</span></li>
      <li><b>3</b><span>Print it on flyers, packaging, receipts and signage. With a dynamic code you can send people somewhere new later without reprinting.</span></li>
    </ol>
    <p class="muted small" style="margin-top:14px">Developers can create codes with the API: <a class="link" href="/docs/qr">QR Codes API</a>.</p>
  </div>
</div>

<div class="panel flush" style="margin-top:14px">
  <div class="panel-head"><h2><?= $isHouse ? 'SeaGeek QR codes' : 'Your QR codes' ?></h2><span class="muted"><?= count($codes) ?> code<?= count($codes) === 1 ? '' : 's' ?> · <?= number_format(array_sum(array_column($codes, 'scans'))) ?> scans</span></div>
  <?php if (!$codes): ?><div class="empty">No QR codes yet. Create your first one above.</div><?php else: ?>
  <div class="qr-cards">
    <?php foreach ($codes as $q): ?>
      <a class="qr-card" href="<?= e($qrBase . '/' . $q['public_id']) ?>">
        <img src="<?= e(Qr::imagePath($q, 'svg')) ?>" alt="QR code for <?= e($q['name']) ?>" width="96" height="96" loading="lazy">
        <span class="qr-meta"><b><?= e($q['name']) ?></b><span class="muted small clip"><?= e($q['target_url']) ?></span>
          <span class="small"><?= $q['dynamic'] ? number_format((int) $q['scans']) . ' scan' . ((int) $q['scans'] === 1 ? '' : 's') : 'Static code' ?><?= $q['status'] !== 'active' ? ' · <span style="color:var(--warn)">Paused</span>' : '' ?></span></span>
      </a>
    <?php endforeach; ?>
  </div>
  <?php endif; ?>
</div>

<?php if ($isHouse): ?>
<div class="panel flush" style="margin-top:14px">
  <div class="panel-head"><h2>Customer QR codes</h2><span class="muted"><?= count($all) ?> latest · <?= zar(array_sum(array_column($all, 'amount'))) ?> earned</span></div>
  <?php if (!$all): ?><div class="empty">No customer has created a QR code yet.</div><?php else: ?>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Customer</th><th>Code</th><th>Links to</th><th class="right">Scans</th><th class="right">Paid</th><th>Created</th></tr></thead><tbody>
    <?php foreach ($all as $q): ?><tr><td><a class="link" href="/admin/orgs/<?= (int) $q['org_id'] ?>"><?= e($q['org']) ?></a> <span class="mono small muted"><?= e($q['customer_no']) ?></span></td><td><?= e($q['name']) ?></td><td class="small muted clip"><?= e($q['target_url']) ?></td><td class="right mono small"><?= number_format((int) $q['scans']) ?></td><td class="right mono small"><?= zar($q['amount']) ?></td><td class="small nowrap"><?= e(date('j M Y', strtotime($q['created_at']))) ?></td></tr><?php endforeach; ?>
  </tbody></table></div><?php endif; ?>
</div>
<?php endif; ?>
<style>@media (max-width: 1000px) { #qr-grid { grid-template-columns: 1fr !important; } }</style>
