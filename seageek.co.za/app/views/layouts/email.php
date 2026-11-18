<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title><?= e($subject ?? 'SeaGeek') ?></title></head>
<body style="margin:0;padding:0;background:#eef3f4;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#10242b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef3f4;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden">
<tr><td style="background:#06161d;padding:20px 28px"><span style="color:#5fe3cf;font-weight:700;font-size:18px;letter-spacing:-.01em">SeaGeek</span></td></tr>
<tr><td style="padding:28px;font-size:15px;line-height:1.6"><?= $content ?></td></tr>
<tr><td style="padding:18px 28px;border-top:1px solid #e3eaec;font-size:12.5px;color:#5c7178">SeaGeek Technologies (Pty) Ltd, Johannesburg. Questions? Reply to this email or write to <?= e(Settings::get('support_email')) ?>.</td></tr>
</table></td></tr></table>
</body></html>
