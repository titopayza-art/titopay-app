<?php
$roles = Staff::roles();
$myRole = $me['admin_role'] ?: 'owner';
$roleOptions = fn(string $sel) => implode('', array_map(fn($k) => ($k === 'owner' && $myRole !== 'owner') ? '' : '<option value="' . $k . '"' . ($k === $sel ? ' selected' : '') . '>' . e($roles[$k][0]) . '</option>', array_keys($roles)));
?>
<div class="grid" style="grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);align-items:start" id="staff-grid">
  <form method="post" class="panel form" data-role-form><?= csrf_field() ?><input type="hidden" name="action" value="invite">
    <h2>Add a team member</h2>
    <p class="muted small">They get an email with a link to choose a password. Only people you add here can open the admin console.</p>
    <div class="row"><div class="field"><label for="s-name">Name</label><input id="s-name" name="name" required></div><div class="field"><label for="s-email">Work email</label><input id="s-email" name="email" type="email" required></div></div>
    <div class="field"><label for="s-role">Role</label><select id="s-role" name="role" data-role><?= $roleOptions('support') ?></select></div>
    <fieldset class="perm-grid" data-perms>
      <legend>What they can open</legend>
      <?php foreach (Staff::PERMISSIONS as $k => [$label, $desc]): ?>
        <label class="perm"><input type="checkbox" name="perms[]" value="<?= $k ?>"><span><b><?= e($label) ?></b><small><?= e($desc) ?></small></span></label>
      <?php endforeach; ?>
    </fieldset>
    <p class="muted small" data-perm-note>Ticked boxes show what the role includes. Choose Custom to pick them yourself.</p>
    <button class="btn btn-primary btn-sm">Send invitation</button>
  </form>
  <div class="panel flush">
    <div class="panel-head"><h2>Roles</h2></div>
    <div class="tbl-wrap"><table class="tbl"><tbody>
      <?php foreach ($roles as $k => [$label, $desc, $perms]): if ($k === 'custom') continue; ?>
        <tr><td style="width:150px"><b><?= e($label) ?></b></td><td class="small"><?= e($desc) ?><div class="muted"><?= e(implode(', ', array_map(fn($p) => Staff::PERMISSIONS[$p][0], $perms))) ?></div></td></tr>
      <?php endforeach; ?>
    </tbody></table></div>
  </div>
</div>

<div class="panel flush" style="margin-top:14px">
  <div class="panel-head"><h2>Team</h2><span class="muted"><?= count(array_filter($staff, fn($s) => !$s['disabled_at'])) ?> active</span></div>
  <div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>Person</th><th>Role</th><th>Can open</th><th>Last sign-in</th><th>Status</th><th></th></tr></thead>
    <tbody>
    <?php foreach ($staff as $s): $role = $s['admin_role'] ?: 'owner'; $perms = Staff::permissionsOf($s + ['disabled_at' => null]); $self = (int) $s['id'] === (int) $me['id']; ?>
      <tr>
        <td><b><?= e($s['name']) ?></b><?= $self ? ' <span class="muted small">(you)</span>' : '' ?><div class="muted small"><?= e($s['email']) ?></div></td>
        <td>
          <form method="post" class="inline-form staff-role" data-role-form><?= csrf_field() ?><input type="hidden" name="action" value="save"><input type="hidden" name="user" value="<?= (int) $s['id'] ?>">
            <select name="role" data-role aria-label="Role for <?= e($s['name']) ?>" <?= ($role === 'owner' && $myRole !== 'owner') ? 'disabled' : '' ?>><?= $role === 'owner' && $myRole !== 'owner' ? '<option>Owner</option>' : $roleOptions($role) ?></select>
            <div data-perms class="perm-mini" <?= $role === 'custom' ? '' : 'hidden' ?>><?php foreach (Staff::PERMISSIONS as $k => [$label]): ?><label><input type="checkbox" name="perms[]" value="<?= $k ?>" <?= in_array($k, $perms, true) ? 'checked' : '' ?>> <?= e($label) ?></label><?php endforeach; ?></div>
            <?php if (!($role === 'owner' && $myRole !== 'owner')): ?><button class="btn btn-ghost btn-xs">Save</button><?php endif; ?>
          </form>
        </td>
        <td class="small muted" style="max-width:260px"><?= e(implode(', ', array_map(fn($p) => Staff::PERMISSIONS[$p][0], $perms))) ?></td>
        <td class="small nowrap"><?= $s['last_login_at'] ? e(date('j M Y H:i', strtotime($s['last_login_at'] . ' UTC'))) : '<span class="muted">Never</span>' ?></td>
        <td><?php $status = $s['disabled_at'] ? 'switched off' : ($s['last_login_at'] ? 'active' : 'invited'); ?><span class="pill <?= $s['disabled_at'] ? 'red' : ($s['last_login_at'] ? 'green' : 'amber') ?>"><?= ucfirst($status) ?></span></td>
        <td class="right nowrap">
          <?php if (!$self): ?>
            <?php if (!$s['last_login_at'] && !$s['disabled_at']): ?><form method="post" class="inline-form"><?= csrf_field() ?><input type="hidden" name="action" value="resend"><input type="hidden" name="user" value="<?= (int) $s['id'] ?>"><button class="btn btn-ghost btn-xs">Resend link</button></form><?php endif; ?>
            <form method="post" class="inline-form" <?= $s['disabled_at'] ? '' : 'data-confirm="Switch off ' . e($s['name']) . '? They are signed out straight away."' ?>><?= csrf_field() ?><input type="hidden" name="action" value="<?= $s['disabled_at'] ? 'enable' : 'disable' ?>"><input type="hidden" name="user" value="<?= (int) $s['id'] ?>"><button class="btn <?= $s['disabled_at'] ? 'btn-ghost' : 'btn-danger' ?> btn-xs"><?= $s['disabled_at'] ? 'Switch on' : 'Switch off' ?></button></form>
          <?php endif; ?>
        </td>
      </tr>
    <?php endforeach; ?>
    </tbody>
  </table></div>
</div>
<script>
(function () {
  var roles = <?= json_encode(array_map(fn($r) => $r[2], $roles)) ?>;
  document.querySelectorAll('[data-role-form]').forEach(function (f) {
    var sel = f.querySelector('[data-role]'), box = f.querySelector('[data-perms]');
    if (!sel || !box) return;
    var sync = function () {
      var custom = sel.value === 'custom';
      if (box.classList.contains('perm-mini')) { box.hidden = !custom; return; }
      box.querySelectorAll('input').forEach(function (i) { if (!custom) i.checked = (roles[sel.value] || []).indexOf(i.value) >= 0; i.disabled = !custom; });
    };
    sel.addEventListener('change', sync); sync();
  });
})();
</script>
<style>@media (max-width: 1000px) { #staff-grid { grid-template-columns: 1fr !important; } }</style>
