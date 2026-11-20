<h1 style="font-size:26px;margin-top:18px">Enter your code</h1>
<p class="muted" style="margin-top:6px">Open your authenticator app and type the 6-digit code for SeaGeek.</p>
<form method="post" class="form" style="margin-top:18px"><?= csrf_field() ?>
  <div class="field"><label for="code">Code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" autofocus required style="font-size:24px;letter-spacing:.3em;text-align:center"></div>
  <button class="btn btn-primary">Sign in</button>
</form>
<p class="muted small" style="margin-top:14px">Lost your phone? Ask a SeaGeek owner to reset two-step sign-in for you, or write to hello@seageek.co.za.</p>
