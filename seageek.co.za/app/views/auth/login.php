<h1>Sign in</h1>
<?php if (isset($_GET['installed'])): ?><div class="alert alert-ok">Installed. Sign in with the admin account you just created.</div><?php endif; ?>
<form method="post" class="form"><?= csrf_field() ?>
  <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" value="<?= old('email') ?>" autocomplete="email" required autofocus></div>
  <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
  <button class="btn btn-primary">Sign in</button>
</form>
<p class="auth-foot"><a class="link" href="/forgot">Forgot your password?</a> · New to SeaGeek? <a class="link" href="/register">Create an account</a></p>
