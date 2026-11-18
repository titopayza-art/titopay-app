<h1>Confirm your email</h1>
<p class="muted">We sent a link to <b style="color:var(--text)"><?= e($u['email']) ?></b>. Open it to finish setting up your account. It works for 3 days.</p>
<form method="post" class="form"><?= csrf_field() ?><button class="btn btn-ghost">Send the link again</button></form>
<form method="post" action="/logout" style="margin-top:12px"><?= csrf_field() ?><button class="btn btn-ghost btn-sm" style="border-color:transparent">Sign out</button></form>
