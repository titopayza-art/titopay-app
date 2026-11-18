<h1>Choose a new password</h1>
<form method="post" class="form"><?= csrf_field() ?><div class="field"><label for="password">New password (10+ characters)</label><input id="password" name="password" type="password" minlength="10" autocomplete="new-password" required autofocus></div><button class="btn btn-primary">Save password</button></form>
