"use strict";

// Keep Customer Care notifications in the chatbot/support experience. The
// existing minified bundle routes all message notifications to peer chat, so
// this capture-phase guard handles older cached bundles without changing the
// peer-chat path.
document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-notification-chat]");
  if (!target) return;

  const text = String(target.textContent || "").toLowerCase();
  const isCustomerCare = /customer care|support agent|support message/.test(text);
  if (!isCustomerCare) return;

  const conversationId = target.dataset.notificationChat || "";
  if (!conversationId) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  sessionStorage.setItem("titopay_support_conversation_id", conversationId);
  document.querySelector('[data-action="chatbot"]')?.click();
}, true);
