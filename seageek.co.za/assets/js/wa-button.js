/* SeaGeek WhatsApp button: a floating "Chat on WhatsApp" button for any website.
   <script src="https://www.seageek.co.za/assets/js/wa-button.js" data-number="27821234567" data-text="Hi, I have a question" defer></script>
   Options: data-label (button text), data-side ("left" or "right", default right). */
(function () {
  "use strict";
  if (window.__seageekWa) return;
  window.__seageekWa = true;
  var s = document.currentScript || document.querySelector('script[src*="wa-button.js"]');
  if (!s) return;
  var number = (s.getAttribute("data-number") || "").replace(/\D/g, "");
  if (number.charAt(0) === "0") number = "27" + number.slice(1); // South African numbers written as 082...
  if (number.length < 8) return;
  var text = s.getAttribute("data-text") || "";
  var label = s.getAttribute("data-label") || "Chat on WhatsApp";
  var side = s.getAttribute("data-side") === "left" ? "left" : "right";
  // Sit above the SeaGeek chat button when both are on the page.
  var lift = document.querySelector('script[src*="chat-widget.js"]') && side === "right" ? 84 : 20;
  var css = ".sgwa{position:fixed;" + side + ":20px;bottom:" + lift + "px;z-index:2147482999;height:52px;padding:0 20px 0 16px;border-radius:999px;background:#25d366;color:#05210f;"
    + "font:600 15px/1 system-ui,-apple-system,Segoe UI,sans-serif;display:inline-flex;gap:8px;align-items:center;text-decoration:none;box-shadow:0 10px 30px -10px rgba(0,0,0,.5)}"
    + ".sgwa svg{width:22px;height:22px}.sgwa:focus-visible{outline:3px solid #05210f;outline-offset:2px}@media(max-width:480px){.sgwa span{display:none}.sgwa{padding:0 15px}}";
  var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
  var a = document.createElement("a");
  a.className = "sgwa";
  a.href = "https://wa.me/" + number + (text ? "?text=" + encodeURIComponent(text) : "");
  a.target = "_blank"; a.rel = "noopener";
  a.setAttribute("aria-label", label);
  a.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.3-.4.8-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 2.9 2.9 0 0 0-.9 2.2 5 5 0 0 0 1.1 2.7 11.5 11.5 0 0 0 4.4 3.9c1.6.7 2.3.8 3.1.6a2.7 2.7 0 0 0 1.8-1.2 2.2 2.2 0 0 0 .2-1.2c-.1-.1-.3-.2-.5-.3z"/></svg><span></span>';
  a.querySelector("span").textContent = label;
  document.body.appendChild(a);
})();
