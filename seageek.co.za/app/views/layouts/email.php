<?php
/**
 * One layout for every email: dark header with the logo, white body, dark footer with links.
 * Inline styles and tables because email clients ignore stylesheets.
 * $brand: a customer's name for emails sent on their behalf (Desk replies, campaigns). Null means SeaGeek.
 */
$brand = $brand ?? null;
$site = rtrim(app_url(''), '/');
$font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
?><!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title><?= e($subject ?? 'SeaGeek') ?></title></head>
<body style="margin:0;padding:0;background:#eef2f3;-webkit-text-size-adjust:100%">
<?php if (!empty($preheader)): ?><div style="display:none;max-height:0;overflow:hidden;opacity:0"><?= e($preheader) ?></div><?php endif; ?>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f3"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:<?= $font ?>">
  <tr><td style="background:#0b1f27;padding:30px 36px">
    <?php if ($brand): ?>
      <span style="font-size:26px;line-height:1.2;font-weight:700;color:#ffffff;letter-spacing:-0.01em"><?= e($brand) ?></span>
    <?php else: ?>
      <a href="<?= e($site) ?>" style="text-decoration:none"><img src="<?= e(app_url('/assets/img/email-logo.png')) ?>" width="218" height="44" alt="SeaGeek" style="display:block;border:0;width:218px;height:44px"></a>
    <?php endif; ?>
  </td></tr>
  <tr><td style="padding:36px 36px 34px;font-size:17px;line-height:1.65;color:#14262d">
    <?= $content ?>
  </td></tr>
  <tr><td style="background:#0b1f27;padding:28px 36px;font-size:14.5px;line-height:1.7;color:#c4d3d7">
    <?php if ($brand): ?>
      <div style="font-size:16px;font-weight:700;color:#ffffff"><?= e($brand) ?></div>
      <div>Sent on behalf of <?= e($brand) ?>.</div>
      <div style="margin-top:12px;font-size:13px;color:#8fa4aa">Powered by <a href="<?= e(app_url('/?ref=powered-email')) ?>" style="color:#8fe6d8;text-decoration:underline;font-weight:600">SeaGeek</a></div>
      <?php if (!empty($unsubscribe)): ?><div style="margin-top:10px"><a href="<?= e($unsubscribe) ?>" style="color:#8fe6d8;text-decoration:underline">Unsubscribe</a></div><?php endif; ?>
    <?php else: ?>
      <div style="font-size:16px;font-weight:700;color:#ffffff">SeaGeek</div>
      <div>Intelligence. Connected.</div>
      <div style="margin-top:6px"><a href="mailto:<?= e(Settings::get('support_email')) ?>" style="color:#8fe6d8;text-decoration:underline"><?= e(Settings::get('support_email')) ?></a> &middot; <a href="<?= e($site) ?>" style="color:#8fe6d8;text-decoration:underline">seageek.co.za</a></div>
      <div><a href="<?= e($site . '/help') ?>" style="color:#8fe6d8;text-decoration:underline">Help centre</a> &middot; <a href="<?= e($site . '/privacy') ?>" style="color:#8fe6d8;text-decoration:underline">Privacy notice</a> &middot; <a href="<?= e($site . '/terms') ?>" style="color:#8fe6d8;text-decoration:underline">Terms of service</a><?php if (!empty($unsubscribe)): ?> &middot; <a href="<?= e($unsubscribe) ?>" style="color:#8fe6d8;text-decoration:underline">Unsubscribe</a><?php endif; ?></div>
      <div style="margin-top:14px;color:#8fa4aa;font-size:13.5px">Copyright &copy; <?= date('Y') ?> <?= e(Settings::get('company_name')) ?>. All rights reserved.</div>
    <?php endif; ?>
  </td></tr>
</table>
</td></tr></table>
</body></html>
