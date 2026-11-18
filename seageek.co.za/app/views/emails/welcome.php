<p>Hi <?= e($user['name']) ?>,</p><p>Your account is ready. Here's how to go from sandbox to live:</p>
<ol><li>Copy your sandbox key from the dashboard and send a test request.</li><li>Add your company phone number under Settings.</li><li>Add credit under Billing. Live keys switch on as soon as the payment clears.</li></ol>
<p><a style="display:inline-block;background:#5fe3cf;color:#031512;padding:12px 20px;border-radius:999px;font-weight:600;text-decoration:none" href="<?= e(app_url('/dashboard')) ?>">Open your dashboard</a></p>
