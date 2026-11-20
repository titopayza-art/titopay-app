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
    <h2 style="margin-top:26px">Chat on your website</h2>
    <p class="muted small" style="margin:6px 0 0">Set the colour and greeting and copy your snippet under <a class="link" href="/dashboard/chat">Plug-ins, Website chat</a>.</p>
    <p class="muted small" style="margin-top:8px">Your public help centre: <a class="link" href="/h/<?= e($org['slug']) ?>" target="_blank"><?= e(app_url('/h/' . $org['slug'])) ?></a></p>
  </div>
</div>
<div class="panel flush" style="margin-top:14px">
  <div class="panel-head"><h2>Team</h2><span class="muted"><?= (int) $plan['desk_agents'] ?> Desk seats on your plan</span></div>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last sign-in</th><th></th></tr></thead><tbody>
  <?php foreach ($team as $m): ?><tr><td><?= e($m['name']) ?></td><td class="small"><?= e($m['email']) ?></td><td><span class="pill"><?= e(Team::ROLES[$m['role']] ?? ucfirst($m['role'])) ?></span><?php if ($m['role'] !== 'owner'): $lv = Team::map($m); $edit = array_keys(array_filter($lv, fn($x) => $x === 'edit')); $view = array_keys(array_filter($lv, fn($x) => $x === 'view')); ?><div class="muted small" style="margin-top:6px"><?= $edit ? 'Can change: ' . e(implode(', ', array_map(fn($k) => Team::AREAS[$k][0], $edit))) : 'Cannot change anything' ?><br><?= $view ? 'Can see: ' . e(implode(', ', array_map(fn($k) => Team::AREAS[$k][0], $view))) : '' ?></div><?php endif; ?></td><td class="muted small"><?= $m['last_login_at'] ? e(date('j M H:i', strtotime($m['last_login_at'] . ' UTC'))) : 'Never' ?></td>
  <td class="right"><?php if ($u['role'] === 'owner' && $m['id'] !== $u['id'] && $m['role'] !== 'owner'): ?><details class="more" style="text-align:left"><summary>Access</summary><?php render_access_form($m['id'], Team::map($m), $m['name']); ?></details><?php endif; ?><?php if ($u['role'] === 'owner' && $m['id'] !== $u['id']): ?><form method="post" class="inline-form" data-confirm="Remove <?= e($m['name']) ?>?"><?= csrf_field() ?><input type="hidden" name="action" value="remove_user"><input type="hidden" name="id" value="<?= (int) $m['id'] ?>"><button class="btn btn-danger btn-xs">Remove</button></form><?php endif; ?></td></tr><?php endforeach; ?>
  </tbody></table></div>
  <?php if ($u['role'] === 'owner'): ?>
  <details class="panel" style="margin:0 20px 16px;padding:16px 20px"><summary><b>Invite someone</b> <span class="muted small">Choose a role, then adjust what they can see and change.</span></summary>
    <form method="post" class="form" style="margin-top:12px" id="inv-access"><?= csrf_field() ?><input type="hidden" name="action" value="invite">
      <div class="row"><div class="field"><label for="inv-name">Name</label><input id="inv-name" name="name" placeholder="Name"></div><div class="field"><label for="inv-email">Email</label><input id="inv-email" name="email" type="email" placeholder="Email" required></div>
        <div class="field"><label for="inv-role">Role</label><select id="inv-role" name="role"><?php foreach (Team::ROLES as $k => $label): if ($k === 'owner') continue; ?><option value="<?= $k ?>"><?= e($label) ?></option><?php endforeach; ?></select></div></div>
      <?php render_access_fields(Team::defaultsFor('agent')); ?>
      <button class="btn btn-primary btn-sm" style="margin-top:12px">Send invitation</button>
    </form>
    <script>
    (function(){var roles=<?= json_encode(array_combine(array_keys(Team::ROLES), array_map(fn($k) => Team::defaultsFor($k), array_keys(Team::ROLES)))) ?>, sel=document.getElementById('inv-role');
    if(!sel)return; sel.addEventListener('change',function(){var d=roles[sel.value]||{}; document.querySelectorAll('#inv-access select[name^="lvl["]').forEach(function(x){var k=x.name.slice(4,-1); if(d[k]) x.value=d[k];});});})();
    </script>
  </details>
  <?php endif; ?>
</div>
