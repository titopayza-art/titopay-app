<div class="grid cols-2">
  <div class="panel">
    <h2>Company</h2>
    <form method="post" class="form" style="margin-top:14px"><?= csrf_field() ?><input type="hidden" name="action" value="org">
      <div class="field"><label>Company name</label><input name="name" value="<?= e($org['name']) ?>" required></div>
      <div class="row"><div class="field"><label>Phone</label><input name="phone" value="<?= e($org['phone']) ?>" required></div><div class="field"><label>VAT number</label><input name="vat_no" value="<?= e($org['vat_no']) ?>"></div></div>
      <div class="field"><label>Website</label><input name="website" value="<?= e($org['website']) ?>"></div>
      <div class="field"><label>Address (for invoices)</label><input name="address" value="<?= e($org['address']) ?>"></div>
      <div class="field"><label>Email me when my balance drops below (R)</label><input name="low_balance" type="number" min="0" value="<?= (float) $org['low_balance'] ?>"></div>
      <button class="btn btn-primary btn-sm">Save</button></form>
  </div>
  <div class="panel">
    <h2>Your password</h2>
    <form method="post" class="form" style="margin-top:14px"><?= csrf_field() ?><input type="hidden" name="action" value="password">
      <div class="field"><label>Current password</label><input name="current" type="password" required autocomplete="current-password"></div>
      <div class="field"><label>New password (10+ characters)</label><input name="new" type="password" required minlength="10" autocomplete="new-password"></div>
      <button class="btn btn-primary btn-sm">Change password</button></form>
    <h2 style="margin-top:26px">Embed your help widget</h2>
    <p class="muted small" style="margin:6px 0 10px">Add the chat to your website. Conversations go to your Desk and your AI agent answers first.</p>
    <pre class="snippet">&lt;script src="<?= e(app_url('/assets/js/chat-widget.js')) ?>" data-org="<?= e($org['slug']) ?>" defer&gt;&lt;/script&gt;</pre>
    <p class="muted small" style="margin-top:8px">Your public help centre: <a class="link" href="/h/<?= e($org['slug']) ?>" target="_blank"><?= e(app_url('/h/' . $org['slug'])) ?></a></p>
  </div>
</div>
<div class="panel flush" style="margin-top:14px">
  <div class="panel-head"><h2>Team</h2><span class="muted"><?= (int) $plan['desk_agents'] ?> Desk seats on your plan</span></div>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last sign-in</th><th></th></tr></thead><tbody>
  <?php foreach ($team as $m): ?><tr><td><?= e($m['name']) ?></td><td class="small"><?= e($m['email']) ?></td><td><span class="pill"><?= e(ucfirst($m['role'])) ?></span></td><td class="muted small"><?= $m['last_login_at'] ? e(date('j M H:i', strtotime($m['last_login_at'] . ' UTC'))) : 'Never' ?></td>
  <td class="right"><?php if ($u['role'] === 'owner' && $m['id'] !== $u['id']): ?><form method="post" class="inline-form" data-confirm="Remove <?= e($m['name']) ?>?"><?= csrf_field() ?><input type="hidden" name="action" value="remove_user"><input type="hidden" name="id" value="<?= (int) $m['id'] ?>"><button class="btn btn-danger btn-xs">Remove</button></form><?php endif; ?></td></tr><?php endforeach; ?>
  </tbody></table></div>
  <?php if ($u['role'] === 'owner'): ?>
  <form method="post" class="toolbar" style="padding:16px 20px;margin:0;border-top:1px solid var(--line)"><?= csrf_field() ?><input type="hidden" name="action" value="invite">
    <input name="name" placeholder="Name"><input name="email" type="email" placeholder="Email" required>
    <select name="role"><option value="agent">Desk agent</option><option value="developer">Developer</option><option value="billing">Billing</option></select>
    <button class="btn btn-primary btn-sm">Invite</button></form>
  <?php endif; ?>
</div>
