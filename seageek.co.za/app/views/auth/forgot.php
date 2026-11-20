<h1>Reset your password</h1>
<form method="post" class="form"><?= csrf_field() ?><div class="field"><label for="email">Email</label><input id="email" name="email" type="email" required autofocus></div><?= Shield::turnstileWidget() ?>
<button class="btn btn-primary">Email me a reset link</button></form>
<p class="auth-foot"><a class="link" href="/login">Back to sign in</a></p>
