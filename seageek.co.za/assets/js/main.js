/* SeaGeek site interactions */
(function () {
  "use strict";

  var header = document.querySelector(".site-header");
  function onScroll() { header.classList.toggle("scrolled", window.scrollY > 40); }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Mobile menu
  var toggle = document.querySelector(".menu-toggle");
  var menu = document.querySelector(".mobile-nav");
  function setMenu(open) {
    menu.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", String(open));
    document.body.style.overflow = open ? "hidden" : "";
  }
  toggle.addEventListener("click", function () { setMenu(!menu.classList.contains("open")); });
  menu.addEventListener("click", function (e) { if (e.target.closest("a")) setMenu(false); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") setMenu(false); });

  // Code sample language tabs
  document.querySelectorAll("[data-tabs]").forEach(function (win) {
    var tabs = win.querySelectorAll(".tab");
    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        var lang = tab.getAttribute("data-lang");
        tabs.forEach(function (t) { t.setAttribute("aria-selected", String(t === tab)); });
        win.querySelectorAll("pre[data-lang]").forEach(function (pre) { pre.hidden = pre.getAttribute("data-lang") !== lang; });
      });
    });
  });

  // Copy code
  document.querySelectorAll(".copy-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var pre = btn.closest(".code-window").querySelector("pre:not([hidden])");
      if (!pre || !navigator.clipboard) return;
      navigator.clipboard.writeText(pre.innerText).then(function () {
        btn.textContent = "Copied";
        setTimeout(function () { btn.textContent = "Copy"; }, 1500);
      });
    });
  });

  // Forms: no backend yet, so hand the enquiry to the visitor's email app.
  document.querySelectorAll("form[data-mailto]").forEach(function (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var to = form.getAttribute("data-mailto");
      var lines = [];
      new FormData(form).forEach(function (value, key) {
        if (key !== "consent" && value) lines.push(key.charAt(0).toUpperCase() + key.slice(1) + ": " + value);
      });
      form.querySelector(".form-status").textContent = "Opening your email app. If nothing happens, email " + to + ".";
      window.location.href = "mailto:" + to +
        "?subject=" + encodeURIComponent(form.getAttribute("data-subject")) +
        "&body=" + encodeURIComponent(lines.join("\n"));
    });
  });

  document.querySelectorAll("[data-year]").forEach(function (el) { el.textContent = new Date().getFullYear(); });
})();
