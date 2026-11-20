<?php
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$isAdmin = str_starts_with($path, '/admin') || ($path === '/account/security' && !empty(Auth::user()['is_admin']) && empty($_SESSION['act_as_org']));
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
    <?php if ($isAdmin): $can = fn(string $p) => Staff::can($u, $p); ?>
      <a class="nav<?= $on('/admin', true) ?>" href="/admin"><?= icon('grid') ?>Overview</a>
      <?php if ($can('customers')): ?><a class="nav<?= $on('/admin/orgs') ?>" href="/admin/orgs"><?= icon('users') ?>Customers</a><?php endif; ?>
      <?php if ($can('desk')): ?>
      <a class="nav<?= $on('/admin/desk') ?>" href="/admin/desk"><?= icon('desk') ?>Support desk<?= $openTickets ? '<span class="badge">' . $openTickets . '</span>' : '' ?></a>
      <a class="nav<?= $on('/admin/help-centre') ?>" href="/admin/help-centre"><?= icon('book') ?>Help centre</a>
      <?php endif; ?>
      <?php if ($can('billing')): ?>
      <h6>Money</h6>
      <a class="nav<?= $on('/admin/billing') ?><?= $on('/admin/invoices') ?>" href="/admin/billing"><?= icon('card') ?>Invoices &amp; payments</a>
      <a class="nav<?= $on('/admin/eft') ?>" href="/admin/eft"><?= icon('bank') ?>Bank payments (EFT)<?= $eftWaiting ? '<span class="badge">' . $eftWaiting . '</span>' : '' ?></a>
      <a class="nav<?= $on('/admin/quotes') ?>" href="/admin/quotes"><?= icon('calc') ?>Quotes</a>
      <a class="nav<?= $on('/admin/xero') ?>" href="/admin/xero"><?= icon('book') ?>Xero accounting</a>
      <?php endif; ?>
      <?php if ($can('marketing')): ?>
      <h6>Marketing</h6>
      <a class="nav<?= $on('/admin/marketing', true) ?><?= $on('/admin/marketing/campaigns') ?>" href="/admin/marketing"><?= icon('megaphone') ?>Campaigns</a>
      <a class="nav<?= $on('/admin/marketing/contacts') ?>" href="/admin/marketing/contacts"><?= icon('contacts') ?>Contacts</a>
      <a class="nav<?= $on('/admin/marketing/qr') ?>" href="/admin/marketing/qr"><?= icon('qr') ?>QR codes</a>
      <?php endif; ?>
      <?php if ($can('partners') || $can('pricing')): ?>
      <h6>Reseller</h6>
      <?php if ($can('partners')): ?><a class="nav<?= $on('/admin/partners') ?>" href="/admin/partners"><?= icon('plug') ?>Wholesale partners</a><?php endif; ?>
      <?php if ($can('pricing')): ?><a class="nav<?= $on('/admin/pricing') ?>" href="/admin/pricing"><?= icon('tag') ?>Plans, packages &amp; rates</a><?php endif; ?>
      <?php endif; ?>
      <?php if ($can('staff') || $can('settings') || $can('system')): ?>
      <h6>System</h6>
      <?php if ($can('staff')): ?><a class="nav<?= $on('/admin/staff') ?>" href="/admin/staff"><?= icon('staff') ?>Staff &amp; permissions</a><?php endif; ?>
      <?php if ($can('settings')): ?><a class="nav<?= $on('/admin/settings') ?>" href="/admin/settings"><?= icon('cog') ?>Settings</a><?php endif; ?>
      <?php if ($can('system')): ?><a class="nav<?= $on('/admin/system') ?>" href="/admin/system"><?= icon('server') ?>Jobs &amp; logs</a><?php endif; ?>
      <?php if ($can('system')): ?><a class="nav<?= $on('/admin/security') ?>" href="/admin/security"><?= icon('shield') ?>Security</a><?php endif; ?>
      <?php endif; ?>
    <?php else: ?>
      <a class="nav<?= $on('/dashboard', true) ?>" href="/dashboard"><?= icon('grid') ?>Overview</a>
      <a class="nav<?= $on('/dashboard/services') ?><?= $on('/dashboard/cart') ?>" href="/dashboard/services"><?= icon('box') ?>Services</a>
      <a class="nav<?= $on('/dashboard/keys') ?>" href="/dashboard/keys"><?= icon('key') ?>API keys</a>
      <a class="nav<?= $on('/dashboard/usage') ?>" href="/dashboard/usage"><?= icon('chart') ?>Usage &amp; logs</a>
      <h6>Plug-ins <a class="h6-link" href="/dashboard/plugins">All</a></h6>
      <a class="nav<?= $on('/dashboard/chat') ?>" href="/dashboard/chat"><?= icon('chat') ?>Website chat</a>
      <a class="nav<?= $on('/dashboard/forms') ?>" href="/dashboard/forms"><?= icon('form') ?>Website forms</a>
      <a class="nav<?= $on('/dashboard/links') ?>" href="/dashboard/links"><?= icon('link') ?>Short links</a>
      <a class="nav<?= $on('/dashboard/monitors') ?>" href="/dashboard/monitors"><?= icon('pulse') ?>Website monitor</a>
      <a class="nav<?= $on('/dashboard/qr') ?>" href="/dashboard/qr"><?= icon('qr') ?>QR codes</a>
      <a class="nav<?= $on('/dashboard/stores') ?>" href="/dashboard/stores"><?= icon('store') ?>Store SMS</a>
      <a class="nav<?= $on('/dashboard/campaigns') ?>" href="/dashboard/campaigns"><?= icon('megaphone') ?>Campaigns</a>
      <a class="nav<?= $on('/dashboard/contacts') ?>" href="/dashboard/contacts"><?= icon('contacts') ?>Contacts</a>
      <h6>API environments</h6>
      <?php foreach (Catalog::services() as $k => $s): if ($s['status'] === 'planned' || in_array($k, ['desk', 'qr', 'stores'], true)) continue; $act = ($svcStatus[$k] ?? 'inactive') === 'active'; ?>
        <a class="nav<?= $on('/dashboard/service/' . $k) ?><?= $act ? '' : ' dim' ?>" href="/dashboard/service/<?= $k ?>"<?= $act ? '' : ' title="Not switched on: sandbox only"' ?>><?= icon($s['icon']) ?><?= e($s['name']) ?><?= $s['status'] === 'soon' ? '<small class="soon">Soon</small>' : '' ?></a>
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
      <a class="small link" href="/account/security" style="display:block;margin-bottom:8px">Two-step sign-in<?= $u['totp_enabled_at'] ? ': on' : ': off' ?></a>
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
          <span class="bal nowrap" title="Your credit works for every service"><span class="muted">Credit</span> <b class="mono"><?= zar($o['balance']) ?></b><span class="muted hide-sm"> &middot; about <?= number_format(balance_units($o)['sms']) ?> SMS</span></span>
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
<script src="/assets/js/dashboard.js?v=5" defer></script>
<?php if (!$isAdmin): ?><script src="/assets/js/chat-widget.js?v=4" defer></script><?php endif; ?>
</body>
</html>
