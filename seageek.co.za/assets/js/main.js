/* SeaGeek — site interactions */
(function () {
  "use strict";
  document.documentElement.classList.remove("no-js");

  // Header state
  var header = document.querySelector(".site-header");
  function onScroll() {
    if (header) header.classList.toggle("scrolled", window.scrollY > 40);
    updateGauge();
  }

  // Mobile nav
  var toggle = document.querySelector(".menu-toggle");
  var mnav = document.querySelector(".mobile-nav");
  if (toggle && mnav) {
    toggle.addEventListener("click", function () {
      var open = mnav.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open);
      document.body.style.overflow = open ? "hidden" : "";
    });
    mnav.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () {
        mnav.classList.remove("open"); toggle.setAttribute("aria-expanded", "false"); document.body.style.overflow = "";
      });
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && mnav.classList.contains("open")) toggle.click();
    });
  }

  // Depth gauge: scroll position mapped to ocean zones
  var gauge = document.querySelector(".depth-gauge");
  var zones = [
    [0, "Surface"], [200, "Sunlight zone"], [1000, "Twilight zone"],
    [4000, "Midnight zone"], [6000, "Abyssal zone"], [11000, "Hadal zone"]
  ];
  var maxDepth = 11000;
  function updateGauge() {
    if (!gauge) return;
    var max = document.documentElement.scrollHeight - window.innerHeight;
    var p = max > 0 ? Math.min(1, window.scrollY / max) : 0;
    var depth = Math.round(Math.pow(p, 1.6) * maxDepth);
    var zone = zones[0][1];
    for (var i = 0; i < zones.length; i++) if (depth >= zones[i][0]) zone = zones[i][1];
    gauge.querySelector(".fill").style.height = (p * 100) + "%";
    gauge.querySelector(".readout").textContent = String(depth).padStart(5, "0") + " m";
    gauge.querySelector(".zone").textContent = zone;
    gauge.classList.toggle("visible", window.scrollY > window.innerHeight * 0.5);
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Reveal on scroll
  var reveals = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("in"); });
  }

  // Code tabs
  document.querySelectorAll("[data-tabs]").forEach(function (win) {
    var tabs = win.querySelectorAll(".tab");
    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        tabs.forEach(function (t) { t.setAttribute("aria-selected", t === tab); });
        win.querySelectorAll("pre[data-lang]").forEach(function (pre) {
          pre.hidden = pre.getAttribute("data-lang") !== tab.getAttribute("data-lang");
        });
      });
    });
  });

  // Copy buttons
  document.querySelectorAll(".copy-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var win = btn.closest(".code-window");
      var pre = win && (win.querySelector("pre:not([hidden])") || win.querySelector("pre"));
      if (!pre || !navigator.clipboard) return;
      navigator.clipboard.writeText(pre.innerText).then(function () {
        var old = btn.textContent; btn.textContent = "Copied";
        setTimeout(function () { btn.textContent = old; }, 1600);
      });
    });
  });

  // Contact / early-access forms: no backend yet, so compose an email.
  document.querySelectorAll("form[data-mailto]").forEach(function (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!form.reportValidity()) return;
      var data = new FormData(form);
      var lines = [];
      data.forEach(function (v, k) { if (k !== "consent" && v) lines.push(k.charAt(0).toUpperCase() + k.slice(1) + ": " + v); });
      var subject = form.getAttribute("data-subject") || "SeaGeek enquiry";
      var href = "mailto:" + form.getAttribute("data-mailto") +
        "?subject=" + encodeURIComponent(subject) +
        "&body=" + encodeURIComponent(lines.join("\n"));
      var status = form.querySelector(".form-status");
      if (status) status.textContent = "Opening your email app. If nothing opens, email " + form.getAttribute("data-mailto") + ".";
      window.location.href = href;
    });
  });

  // Year
  document.querySelectorAll("[data-year]").forEach(function (el) { el.textContent = new Date().getFullYear(); });
})();
