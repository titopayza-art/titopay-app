<div class="panel" style="max-width:640px;margin:20px 0">
  <h2>You do not have access to <?= e($area) ?></h2>
  <p class="muted" style="margin-top:8px"><?= $need === 'edit' ? 'Your access lets you see this area but not change it.' : 'Your access does not include this area.' ?> Ask the owner of <?= e($org['name']) ?> to change your access under Settings, Team.</p>
  <div class="btn-row"><a class="btn btn-ghost btn-sm" href="/dashboard">Back to the overview</a></div>
</div>
