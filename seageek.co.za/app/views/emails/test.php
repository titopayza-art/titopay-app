<p style="margin:0 0 16px">Hi,</p>
<p style="margin:0 0 16px">This is a test email from your SeaGeek platform. If you can read this, email delivery is working.</p>
<?= mail_details(['Sent with' => strtoupper(Mail::driver()), 'Time' => gmdate('j M Y H:i') . ' UTC']) ?>
