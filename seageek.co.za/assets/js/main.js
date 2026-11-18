/* SeaGeek public site interactions */
(function () {
  "use strict";
  var header = document.querySelector(".site-header");
  function onScroll() { if (header) header.classList.toggle("scrolled", window.scrollY > 40); }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  var toggle = document.querySelector(".menu-toggle"), menu = document.querySelector(".mobile-nav");
  if (toggle && menu) {
    var setMenu = function (open) { menu.classList.toggle("open", open); toggle.setAttribute("aria-expanded", String(open)); document.body.style.overflow = open ? "hidden" : ""; };
    toggle.addEventListener("click", function () { setMenu(!menu.classList.contains("open")); });
    menu.addEventListener("click", function (e) { if (e.target.closest("a")) setMenu(false); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") setMenu(false); });
  }

  document.querySelectorAll("[data-tabs]").forEach(function (win) {
    var tabs = win.querySelectorAll(".tab");
    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        tabs.forEach(function (t) { t.setAttribute("aria-selected", String(t === tab)); });
        win.querySelectorAll("pre[data-lang]").forEach(function (pre) { pre.hidden = pre.getAttribute("data-lang") !== tab.getAttribute("data-lang"); });
      });
    });
  });

  document.addEventListener("click", function (e) {
    var btn = e.target.closest(".copy-btn");
    if (!btn || !navigator.clipboard) return;
    var target = btn.dataset.copy ? document.getElementById(btn.dataset.copy) : (btn.closest(".code-window") || document).querySelector("pre:not([hidden])");
    if (!target) return;
    navigator.clipboard.writeText(target.innerText.trim()).then(function () { btn.textContent = "Copied"; setTimeout(function () { btn.textContent = "Copy"; }, 1500); });
  });
})();
