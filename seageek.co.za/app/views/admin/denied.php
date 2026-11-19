<?php $u = Auth::user(); ?>
<?php if (!empty($u['is_admin'])): ?>
<div class="panel" style="max-width:680px">
  <h2>You do not have access to this area</h2>
  <p class="muted" style="margin-top:8px">This page needs the <b style="color:var(--text)"><?= e(Staff::PERMISSIONS[$perm][0] ?? $perm) ?></b> permission. Your role is <?= e(Staff::roleLabel($u['admin_role'])) ?>. Ask an owner to change it under Staff and permissions.</p>
  <a class="btn btn-ghost btn-sm" style="margin-top:14px" href="/admin">Back to the overview</a>
</div>
<?php else: ?>
<h1 style="font-size:24px;margin-top:18px">This page is for SeaGeek staff</h1>
<p class="muted" style="margin-top:8px">You are signed in with a customer account.</p>
<a class="btn btn-primary" style="margin-top:16px" href="/dashboard">Go to your dashboard</a>
<?php endif; ?>
