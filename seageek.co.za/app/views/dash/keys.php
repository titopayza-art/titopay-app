<div class="grid cols-3">
  <div class="panel span-2 flush">
    <div class="panel-head"><h2>Keys</h2><span class="muted">Send as <span class="code-inline">Authorization: Bearer sg_...</span></span></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Environment</th><th>Key</th><th>Last used</th><th></th></tr></thead><tbody>
    <?php foreach ($keys as $k): ?>
      <tr style="<?= $k['revoked_at'] ? 'opacity:.5' : '' ?>">
        <td><?= e($k['label']) ?></td>
        <td><span class="pill <?= $k['env'] === 'live' ? 'green' : 'violet' ?>"><?= $k['env'] === 'live' ? 'Live' : 'Sandbox' ?></span></td>
        <td class="mono small"><?= e($k['prefix']) ?>…</td>
        <td class="muted small"><?= $k['revoked_at'] ? 'Revoked' : ($k['last_used_at'] ? e(date('j M H:i', strtotime($k['last_used_at'] . ' UTC'))) : 'Never') ?></td>
        <td class="right"><?php if (!$k['revoked_at']): ?><form method="post" class="inline-form" data-confirm="Revoke this key? Requests using it fail immediately."><?= csrf_field() ?><input type="hidden" name="action" value="revoke"><input type="hidden" name="id" value="<?= (int) $k['id'] ?>"><button class="btn btn-danger btn-xs">Revoke</button></form><?php endif; ?></td>
      </tr>
    <?php endforeach; ?>
    <?php if (!$keys): ?><tr><td colspan="5" class="empty">No keys yet.</td></tr><?php endif; ?>
    </tbody></table></div>
  </div>
  <div class="panel">
    <h2>Create a key</h2>
    <form method="post" class="form" style="margin-top:14px"><?= csrf_field() ?><input type="hidden" name="action" value="create">
      <div class="field"><label for="label">Name</label><input id="label" name="label" placeholder="e.g. Production server"></div>
      <div class="field"><label for="env">Environment</label><select id="env" name="env"><option value="test">Sandbox (free, nothing is sent)</option><option value="live" <?= $org['live_enabled'] ? '' : 'disabled' ?>>Live<?= $org['live_enabled'] ? '' : ' (after first payment)' ?></option></select></div>
      <button class="btn btn-primary">Create key</button>
    </form>
    <p class="muted small" style="margin-top:16px">Keep keys on your server. Never put them in a website or mobile app. If a key leaks, revoke it and create a new one.</p>
  </div>
</div>
