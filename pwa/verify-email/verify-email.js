"use strict";

const API_BASE = "https://api.titopay.co.za";

function showVerificationResult({ title, copy, status, type = "", allowOpen = false }) {
  document.querySelector("#verification-title").textContent = title;
  document.querySelector("#verification-copy").textContent = copy;
  const statusElement = document.querySelector("#verification-status");
  statusElement.textContent = status;
  statusElement.className = `status ${type}`.trim();
  document.querySelector("#open-titopay").hidden = !allowOpen;
}

async function verifyEmailAddress() {
  const token = new URLSearchParams(window.location.search).get("token") || "";
  window.history.replaceState({}, document.title, window.location.pathname);
  if (!token) {
    showVerificationResult({
      title: "Verification link incomplete",
      copy: "This link does not contain the secure verification token.",
      status: "Request a new verification email from TitoPay and use the newest link.",
      type: "error",
      allowOpen: true
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
    const expired = Number(error.status) === 410;
    const alreadyUsed = Number(error.status) === 409;
    showVerificationResult({
      title: alreadyUsed ? "Email already verified" : expired ? "Verification link expired" : "Unable to verify email",
      copy: alreadyUsed
        ? "This secure verification link has already been used."
        : expired
          ? "Verification links expire to protect your account."
          : "TitoPay could not confirm this link.",
      status: alreadyUsed
        ? "You can continue to TitoPay."
        : "Open TitoPay and request a new verification email, then use the newest link.",
      type: alreadyUsed ? "success" : "error",
      allowOpen: true
    });
  }
}

verifyEmailAddress();
