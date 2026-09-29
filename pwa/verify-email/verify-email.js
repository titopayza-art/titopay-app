"use strict";

// THE PAGE A CUSTOMER LANDS ON FROM THEIR VERIFICATION EMAIL.
//
// It does one thing: hand the opaque token to the API and present whatever the
// API says. IT DECIDES NOTHING. There is no "verified" flag in here, nothing is
// written to storage, and no state survives the page: the backend is the only
// thing that knows whether an address is confirmed, and this page is a view of
// its answer.
//
// THE TOKEN IS REMOVED FROM THE URL IMMEDIATELY, before any network call. A
// verification token in an address bar ends up in browser history, in a
// screenshot, in a shared link and in the Referer header of anything this page
// loads. It is used once and taken out of sight.

const API_BASE = "https://api.titopay.co.za";

const elements = {
  title: () => document.querySelector("#verification-title"),
  copy: () => document.querySelector("#verification-copy"),
  status: () => document.querySelector("#verification-status"),
  open: () => document.querySelector("#open-titopay"),
  form: () => document.querySelector("#resend-form"),
  email: () => document.querySelector("#resend-email"),
  button: () => document.querySelector("#resend-button"),
  note: () => document.querySelector("#resend-note")
};

function showVerificationResult({ title, copy, status, type = "", allowOpen = false, allowResend = false }) {
  elements.title().textContent = title;
  elements.copy().textContent = copy;
  const statusElement = elements.status();
  statusElement.textContent = status;
  statusElement.className = `status ${type}`.trim();
  elements.open().hidden = !allowOpen;
  elements.form().hidden = !allowResend;
}

// RESEND. The response is deliberately the same whether the address belongs to
// an account, is already verified, or has asked too many times: the API answers
// `accepted` to all of them, and this repeats that answer without embellishing
// it. Saying "no such account" here would turn the page into a way to test
// whether somebody banks with TitoPay.
async function requestNewLink(event) {
  event.preventDefault();
  const email = String(elements.email().value || "").trim();
  if (!email) return;

  const button = elements.button();
  const note = elements.note();
  button.disabled = true;
  note.textContent = "Sending…";

  try {
    await fetch(`${API_BASE}/v1/auth/email/resend-verification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });
    // Rate limiting is the server's job and its refusal looks like every other
    // answer, so there is nothing to distinguish here. Same wording regardless.
    note.textContent = "If that address needs verifying, a new link is on its way. It expires in about 30 minutes.";
  } catch (_error) {
    note.textContent = "TitoPay could not be reached. Check your connection and try again.";
  } finally {
    // Re-enabled after a pause so a repeated tap cannot become a send loop from
    // this page. The server throttles properly; this is only politeness.
    setTimeout(() => { button.disabled = false; }, 5000);
  }
}

async function verifyEmailAddress() {
  let token = "";
  try { token = new URLSearchParams(window.location.search).get("token") || ""; }
  catch (_error) { token = ""; }
  try { window.history.replaceState({}, document.title, window.location.pathname); }
  catch (_error) { /* the URL stays as it is; the token is still used only once */ }

  if (!token) {
    showVerificationResult({
      title: "Verification link incomplete",
      copy: "This link does not contain the secure verification token.",
      status: "Ask for a new verification email and open the newest link.",
      type: "error",
      allowOpen: true,
      allowResend: true
    });
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/v1/auth/email/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) {
      const error = new Error(result.error || "Verification failed");
      error.status = response.status;
      throw error;
    }
    showVerificationResult({
      title: "Email verified",
      copy: "Your email address is now confirmed on your TitoPay account.",
      status: "Verification complete. You can safely return to TitoPay.",
      type: "success",
      allowOpen: true
    });
  } catch (error) {
    const status = Number(error.status);
    const expired = status === 410;
    const alreadyUsed = status === 409;
    const throttled = status === 429;

    // ALREADY USED IS NOT A FAILURE TO THE PERSON READING IT. The commonest way
    // to reach it is tapping the same link twice, and their address is verified
    // either way, so it is presented as done rather than as an error.
    showVerificationResult({
      title: alreadyUsed ? "Email already verified"
        : expired ? "Verification link expired"
          : throttled ? "Too many attempts"
            : "Unable to verify email",
      copy: alreadyUsed
        ? "This secure link has already been used, so nothing more is needed."
        : expired
          ? "Verification links expire after about 30 minutes to protect your account."
          : throttled
            ? "Too many verification attempts have been made from this device."
            : "TitoPay could not confirm this link.",
      status: alreadyUsed
        ? "You can continue to TitoPay."
        : throttled
          ? "Please wait a few minutes and try again."
          : "Request a new verification email below, then open the newest link.",
      type: alreadyUsed ? "success" : "error",
      allowOpen: true,
      allowResend: !alreadyUsed && !throttled
    });
  }
}

document.querySelector("#resend-form").addEventListener("submit", requestNewLink);
verifyEmailAddress();
