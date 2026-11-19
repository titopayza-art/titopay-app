<?php
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$isAdmin = str_starts_with($path, '/admin');
$u = Auth::user();
$o = $isAdmin ? null : Auth::org();
$on = fn(string $p, bool $exact = false) => ($exact ? $path === $p : str_starts_with($path, $p)) ? ' on' : '';
$svcStatus = $o ? Services::all((int) $o['id']) : [];
$unpaidCount = $o ? (int) DB::value("SELECT COUNT(*) FROM invoices WHERE org_id = ? AND status = 'unpaid'", [$o['id']]) : 0;
$eftWaiting = $isAdmin ? (int) DB::value("SELECT COUNT(*) FROM bank_lines WHERE status = 'unmatched' AND amount > 0") : 0;
$cartCount = $o ? Cart::count() : 0;
$openTickets = $isAdmin
    ? (int) DB::value("SELECT COUNT(*) FROM tickets WHERE org_id = ? AND status IN ('new','open')", [Desk::house()['id']])
    : ($o ? (int) DB::value("SELECT COUNT(*) FROM tickets WHERE org_id = ? AND status IN ('new','open')", [$o['id']]) : 0);
?>
<!doctype html>
<html lang="en-ZA">
<head><?php require APP_DIR . '/views/partials/head.php'; ?><meta name="robots" content="noindex"></head>
<body>
<div class="app">
  <aside class="side" id="side">
    <a class="brand" href="<?= $isAdmin ? '/admin' : '/dashboard' ?>"><?php require APP_DIR . '/views/partials/logo.php'; ?><span>SeaGeek<?= $isAdmin ? ' <small class="muted" style="font-weight:500;font-size:13px">Admin</small>' : '' ?></span></a>
    <?php if ($isAdmin): ?>
      <a class="nav<?= $on('/admin', true) ?>" href="/admin"><?= icon('grid') ?>Overview</a>
      <a class="nav<?= $on('/admin/orgs') ?>" href="/admin/orgs"><?= icon('users') ?>Customers</a>
      <a class="nav<?= $on('/admin/desk') ?>" href="/admin/desk"><?= icon('desk') ?>Support desk<?= $openTickets ? '<span class="badge">' . $openTickets . '</span>' : '' ?></a>
      <a class="nav<?= $on('/admin/help-centre') ?>" href="/admin/help-centre"><?= icon('book') ?>Help centre</a>
      <h6>Money</h6>
      <a class="nav<?= $on('/admin/billing') ?><?= $on('/admin/invoices') ?>" href="/admin/billing"><?= icon('card') ?>Invoices &amp; payments</a>
      <a class="nav<?= $on('/admin/eft') ?>" href="/admin/eft"><?= icon('bank') ?>Bank payments (EFT)<?= $eftWaiting ? '<span class="badge">' . $eftWaiting . '</span>' : '' ?></a>
      <a class="nav<?= $on('/admin/quotes') ?>" href="/admin/quotes"><?= icon('calc') ?>Quotes</a>
      <h6>Reseller</h6>
      <a class="nav<?= $on('/admin/partners') ?>" href="/admin/partners"><?= icon('plug') ?>Wholesale partners</a>
      <a class="nav<?= $on('/admin/pricing') ?>" href="/admin/pricing"><?= icon('tag') ?>Plans, packages &amp; rates</a>
      <h6>System</h6>
      <a class="nav<?= $on('/admin/settings') ?>" href="/admin/settings"><?= icon('cog') ?>Settings</a>
      <a class="nav<?= $on('/admin/system') ?>" href="/admin/system"><?= icon('server') ?>Jobs &amp; logs</a>
    <?php else: ?>
      <a class="nav<?= $on('/dashboard', true) ?>" href="/dashboard"><?= icon('grid') ?>Overview</a>
      <a class="nav<?= $on('/dashboard/services') ?><?= $on('/dashboard/cart') ?>" href="/dashboard/services"><?= icon('box') ?>Services</a>
      <a class="nav<?= $on('/dashboard/keys') ?>" href="/dashboard/keys"><?= icon('key') ?>API keys</a>
      <a class="nav<?= $on('/dashboard/usage') ?>" href="/dashboard/usage"><?= icon('chart') ?>Usage &amp; logs</a>
      <h6>Environments</h6>
      <?php foreach (Catalog::services() as $k => $s): if ($s['status'] === 'planned' || $k === 'desk') continue; $act = ($svcStatus[$k] ?? 'inactive') === 'active'; ?>
        <a class="nav<?= $on('/dashboard/service/' . $k) ?><?= $act ? '' : ' dim' ?>" href="/dashboard/service/<?= $k ?>"<?= $act ? '' : ' title="Not switched on: sandbox only"' ?>><?= icon($s['icon']) ?><?= e($s['name']) ?></a>
      <?php endforeach; ?>
      <h6>Desk</h6>
      <a class="nav<?= $on('/dashboard/desk') ?>" href="/dashboard/desk"><?= icon('desk') ?>Tickets<?= $openTickets ? '<span class="badge">' . $openTickets . '</span>' : '' ?></a>
      <a class="nav<?= $on('/dashboard/help-centre') ?>" href="/dashboard/help-centre"><?= icon('book') ?>Help centre</a>
      <h6>Billing</h6>
      <a class="nav<?= $on('/dashboard/billing') ?>" href="/dashboard/billing"><?= icon('wallet') ?>Credit &amp; plan</a>
      <a class="nav<?= $on('/dashboard/invoice') ?><?= $on('/dashboard/pay') ?><?= $on('/dashboard/statement') ?>" href="/dashboard/invoices"><?= icon('doc') ?>Invoices<?= $unpaidCount ? '<span class="badge">' . $unpaidCount . '</span>' : '' ?></a>
      <a class="nav<?= $on('/dashboard/quotes') ?>" href="/dashboard/quotes"><?= icon('calc') ?>Quotes</a>
      <h6>Developers</h6>
      <a class="nav<?= $on('/dashboard/webhooks') ?>" href="/dashboard/webhooks"><?= icon('webhook') ?>Webhooks</a>
      <a class="nav" href="/docs" target="_blank" rel="noopener"><?= icon('code') ?>API docs</a>
      <h6>Account</h6>
      <a class="nav<?= $on('/dashboard/settings') ?>" href="/dashboard/settings"><?= icon('cog') ?>Settings &amp; team</a>
    <?php endif; ?>
    <div class="side-foot">
      <div style="color:var(--text-soft)"><?= e($u['name']) ?></div>
      <div class="small" style="margin-bottom:8px"><?= e($u['email']) ?></div>
      <form method="post" action="/logout"><?= csrf_field() ?><button><?= icon('logout') ?>Sign out</button></form>
    </div>
  </aside>
  <div class="main">
    <?php if (!$isAdmin && !empty($u['is_admin']) && !empty($_SESSION['act_as_org'])): ?>
      <div class="acting"><span>You are viewing <b><?= e($o['name']) ?></b> as SeaGeek staff.</span><form method="post" action="/admin/stop-acting"><?= csrf_field() ?><button class="btn btn-ghost btn-xs">Back to admin</button></form></div>
    <?php endif; ?>
    <div class="topbar">
      <div style="display:flex;gap:12px;align-items:center">
        <button class="icon-btn menu-btn" onclick="document.getElementById('side').classList.toggle('open')" aria-label="Menu"><?= icon('menu') ?></button>
        <h1><?= e($title ?? '') ?></h1>
      </div>
      <div class="right-tools">
        <?php if ($o): ?>
          <span class="custno hide-sm" title="Your customer number. Use it as the reference for EFT payments.">Customer no. <b><?= e($o['customer_no']) ?></b></span>
          <span class="muted small nowrap">Balance <b class="mono" style="color:var(--text)"><?= zar($o['balance']) ?></b></span>
          <?php if ($cartCount): ?><a class="btn btn-ghost btn-sm cart-btn" href="/dashboard/cart" aria-label="Your order, <?= $cartCount ?> item(s)"><?= icon('cart') ?>Order<span class="n"><?= $cartCount ?></span></a><?php endif; ?>
          <a class="btn btn-primary btn-sm" href="/dashboard/billing#topup">Add credit</a>
        <?php elseif ($isAdmin): ?>
          <a class="btn btn-ghost btn-sm" href="/" target="_blank" rel="noopener">View site</a>
        <?php endif; ?>
      </div>
    </div>
    <div class="content">
      <?php if ($o && $o['status'] === 'locked'): ?>
        <div class="alert alert-error"><b>Live access is paused.</b> <?= e($o['locked_reason'] ?: '') ?>. Sandbox keys still work. <a class="link" href="/dashboard/billing">Pay now to restore access</a>.</div>
      <?php endif; ?>
      <?php if (!empty($_SESSION['new_test_key']) || !empty($_SESSION['new_live_key']) || !empty($_SESSION['new_key'])): ?>
        <?php foreach (['new_test_key', 'new_live_key', 'new_key'] as $k) if (!empty($_SESSION[$k])): ?>
          <div class="alert alert-ok"><b>Copy your new API key now.</b> For your security we only show it once.<div class="secret" style="margin-top:8px"><span id="nk-<?= $k ?>"><?= e($_SESSION[$k]) ?></span><button class="copy-btn" type="button" data-copy="nk-<?= $k ?>">Copy</button></div></div>
        <?php unset($_SESSION[$k]); endif; ?>
      <?php endif; ?>
      <?php require APP_DIR . '/views/partials/flash.php'; ?>
      <?= $content ?>
    </div>
  </div>
</div>
<script src="/assets/js/dashboard.js?v=4" defer></script>
<?php if (!$isAdmin): ?><script src="/assets/js/chat-widget.js?v=3" defer></script><?php endif; ?>
</body>
</html>
