<?php $crumbs = [['Website forms', '/dashboard/forms'], [$f['name'], null]]; require APP_DIR . '/views/partials/crumbs.php'; ?>
<?php if ($new): ?><div class="alert alert-ok">Your form is ready. Copy the address below into your website form.</div><?php endif; ?>
<div class="grid" style="grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);align-items:start" id="form-grid">
  <div class="stack">
    <div class="panel">
      <h2>Connect your website</h2>
      <p class="muted small">Set your form's <code>action</code> to this address and its <code>method</code> to <code>post</code>.</p>
      <div class="field"><div class="secret"><span id="f-end"><?= e(WebForms::endpoint($f)) ?></span><button class="copy-btn" type="button" data-copy="f-end">Copy</button></div></div>
      <div class="snippet-head"><span class="snippet-label">Or start from this ready-made form</span><button class="copy-btn" type="button" data-copy="f-html">Copy</button></div>
      <pre class="snippet" id="f-html"><?= e(WebForms::htmlExample($f)) ?></pre>
      <p class="muted small" style="margin-top:10px">Name the email field <code>email</code> so you can reply straight from the notification. The hidden <code>_gotcha</code> field catches spam bots. Sending with JavaScript? Add the header <code>Accept: application/json</code> and you get a JSON answer instead of a page.</p>
    </div>
    <div class="panel flush">
      <div class="panel-head"><h2>Messages</h2><span class="muted"><?= number_format((int) $f['submissions']) ?> total<?= $entries ? ' · <a class="link" href="?export=csv">Download CSV</a>' : '' ?></span></div>
      <?php if (!$entries): ?><div class="empty">No messages yet. Send a test from your website.</div><?php else: ?>
      <div class="entries"><?php foreach ($entries as $en): $d = json_decode($en['data'], true) ?: []; ?>
        <div class="entry">
          <div class="entry-head"><b><?= e($d['name'] ?? $en['email'] ?? 'Message') ?></b><span class="muted small"><?= e(date('j M Y H:i', strtotime($en['created_at'] . ' UTC'))) ?><?= $en['ticket_no'] ? ' · <a class="link" href="/dashboard/desk/' . (int) $en['ticket_no'] . '">Ticket #' . (int) $en['ticket_no'] . '</a>' : '' ?></span></div>
          <dl><?php foreach ($d as $k => $v): ?><dt><?= e(ucfirst(str_replace('_', ' ', $k))) ?></dt><dd><?= nl2br(e($v)) ?></dd><?php endforeach; ?></dl>
          <?php if ($en['page']): ?><p class="muted small">From <?= e($en['page']) ?></p><?php endif; ?>
        </div>
      <?php endforeach; ?></div>
      <?php endif; ?>
    </div>
  </div>
  <div class="stack">
    <form method="post" class="panel form"><?= csrf_field() ?><input type="hidden" name="action" value="save">
      <h2>Settings</h2>
      <div class="field"><label for="fe-name">Name</label><input id="fe-name" name="name" value="<?= e($f['name']) ?>"></div>
      <div class="field"><label for="fe-email">Email each message to</label><input id="fe-email" name="notify_email" type="email" value="<?= e((string) $f['notify_email']) ?>"></div>
      <div class="field"><label for="fe-phone">SMS alert to</label><input id="fe-phone" name="notify_phone" inputmode="tel" value="<?= e((string) $f['notify_phone']) ?>" placeholder="Leave empty for no SMS"></div>
      <label class="consent"><input type="checkbox" name="to_desk" value="1" <?= $f['to_desk'] ? 'checked' : '' ?>><span>Open a Desk ticket for each message. Desk also emails the sender a confirmation.</span></label>
      <div class="field" style="margin-top:12px"><label for="fe-auto">Automatic reply to the sender <span class="muted">(when Desk is off)</span></label><textarea id="fe-auto" name="auto_reply" rows="3" placeholder="Thanks for getting in touch. We reply within one working day."><?= e((string) $f['auto_reply']) ?></textarea></div>
      <div class="field"><label for="fe-thanks">Thank-you page</label><input id="fe-thanks" name="thanks_url" type="url" value="<?= e((string) $f['thanks_url']) ?>" placeholder="Leave empty to show a SeaGeek thank-you page"></div>
      <button class="btn btn-primary btn-sm">Save</button>
    </form>
    <div class="panel">
      <h2>Status</h2>
      <p class="muted small"><?= $f['status'] === 'active' ? 'Accepting messages.' : 'Paused: new messages are refused.' ?></p>
      <div class="btn-row" style="margin-top:10px">
        <form method="post" class="inline-form"><?= csrf_field() ?><input type="hidden" name="action" value="<?= $f['status'] === 'active' ? 'pause' : 'resume' ?>"><button class="btn btn-ghost btn-sm"><?= $f['status'] === 'active' ? 'Pause' : 'Switch back on' ?></button></form>
        <form method="post" class="inline-form" data-confirm="Delete this form and all its messages? Your website form will stop working."><?= csrf_field() ?><input type="hidden" name="action" value="delete"><button class="btn btn-danger btn-sm">Delete</button></form>
      </div>
    </div>
  </div>
</div>
