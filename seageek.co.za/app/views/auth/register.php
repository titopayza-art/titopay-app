<h1>Create your account</h1>
<p class="muted">Free sandbox straight away. Pay only when you go live.</p>
<form method="post" class="form"><?= csrf_field() ?>
  <div class="row"><div class="field"><label for="name">Your name</label><input id="name" name="name" value="<?= old('name') ?>" autocomplete="name" required></div><div class="field"><label for="company">Company</label><input id="company" name="company" value="<?= old('company') ?>" autocomplete="organization" required></div></div>
  <div class="field"><label for="email">Work email</label><input id="email" name="email" type="email" value="<?= old('email') ?>" autocomplete="email" required></div>
  <div class="row"><div class="field"><label for="phone">Phone</label><input id="phone" name="phone" value="<?= old('phone') ?>" autocomplete="tel"></div><div class="field"><label for="industry">Industry</label><select id="industry" name="industry"><?php foreach (['Financial services', 'Retail and e-commerce', 'Education', 'Property', 'Healthcare', 'Software and SaaS', 'Other'] as $i): ?><option><?= $i ?></option><?php endforeach; ?></select></div></div>
  <div class="field"><label for="password">Password (10+ characters)</label><input id="password" name="password" type="password" minlength="10" autocomplete="new-password" required></div>
  <label class="consent"><input type="checkbox" name="terms" value="1" required><span>I accept the <a class="link" href="/terms" target="_blank">terms of service</a> and <a class="link" href="/privacy" target="_blank">privacy notice</a>.</span></label>
  <?= Shield::turnstileWidget() ?>
<button class="btn btn-primary">Create account</button>
</form>
<p class="auth-foot">Already have an account? <a class="link" href="/login">Sign in</a></p>
