import { html, render, $, post, onSubmit } from "/assets/core.js";

const main = $("#main");
const params = new URLSearchParams(location.search);
const challenge = params.get("challenge") || "";
const nextParam = params.get("next") || "/account";
const next = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/account";
history.replaceState(null, "", location.pathname);

if (!/^[A-Za-z0-9_-]{40,100}$/.test(challenge)) {
  render(main, html`<section class="card"><h1>Sign-in request expired</h1><p class="muted">Please start signing in again.</p><a class="btn btn-primary" href="/">Back to TicketRoom</a></section>`);
} else {
  render(main, html`<section class="card stack" style="max-width:32rem;margin:3rem auto">
    <span class="tk-label">Extra sign-in check</span><h1 class="mb-0">Check your email</h1>
    <p class="muted mb-0">We sent a six-digit, one-use sign-in code to your account email. It expires in 10 minutes.</p>
    <form class="stack" id="otp-form"><input type="hidden" name="challenge" value="${challenge}">
      <div class="field"><label for="otp-code">One-time code</label><input id="otp-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></div>
      <button class="btn btn-primary" type="submit">Verify and continue</button>
    </form><p class="tiny muted mb-0">Didn't request this? Ignore the email and start sign-in again.</p>
  </section>`);
  onSubmit($("#otp-form"), async (v) => {
    await post("/api/auth/login-code/verify", v);
    location.replace(next);
  });
  setTimeout(() => $("#otp-code")?.focus(), 50);
}
