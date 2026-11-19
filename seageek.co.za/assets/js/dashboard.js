/* SeaGeek dashboard and admin helpers */
(function () {
  "use strict";
  document.addEventListener("click", function (e) {
    var btn = e.target.closest(".copy-btn");
    if (btn && navigator.clipboard) {
      var target = btn.dataset.copy ? document.getElementById(btn.dataset.copy) : (btn.closest(".code-window") || document).querySelector("pre:not([hidden])");
      if (target) navigator.clipboard.writeText(target.innerText.trim()).then(function () { btn.textContent = "Copied"; setTimeout(function () { btn.textContent = "Copy"; }, 1500); });
    }
    var macro = e.target.closest("[data-macro]");
    if (macro) {
      var box = document.getElementById("reply-body"), st = document.getElementById("reply-status");
      if (box) { box.value = (box.value ? box.value + "\n\n" : "") + macro.dataset.macro; box.focus(); }
      if (st && macro.dataset.status) st.value = macro.dataset.status;
    }
  });
  document.addEventListener("submit", function (e) {
    var f = e.target.closest("[data-confirm]");
    if (f && !window.confirm(f.dataset.confirm)) e.preventDefault();
  });
  // Live margin preview on the pricing screen
  document.querySelectorAll("tr[data-margin]").forEach(function (row) {
    var inputs = row.querySelectorAll("input"), out = row.querySelector("[data-out]");
    function upd() { var p = parseFloat(inputs[0].value) || 0, c = parseFloat(inputs[1].value) || 0; out.textContent = p > 0 ? Math.round((p - c) / p * 100) + "%" : "–"; out.style.color = p > 0 && (p - c) / p < 0.2 ? "#ff9db1" : ""; }
    inputs.forEach(function (i) { i.addEventListener("input", upd); });
  });
  document.querySelectorAll("[data-tabs]").forEach(function (win) {
    var tabs = win.querySelectorAll(".tab");
    tabs.forEach(function (tab) { tab.addEventListener("click", function () {
      tabs.forEach(function (t) { t.setAttribute("aria-selected", String(t === tab)); });
      win.querySelectorAll("pre[data-lang]").forEach(function (pre) { pre.hidden = pre.getAttribute("data-lang") !== tab.getAttribute("data-lang"); });
    }); });
  });

  // Services: pick several, see packages for each, one order at the end
  var svcForm = document.getElementById("svc-form");
  if (svcForm) {
    var bar = svcForm.querySelector("[data-bar]"), sum = svcForm.querySelector("[data-sum]"), go = svcForm.querySelector("[data-go]");
    var sync = function () {
      var picked = 0, newOnes = 0, pkgs = 0;
      svcForm.querySelectorAll("[data-svc]").forEach(function (card) {
        var pick = card.querySelector("[data-pick]"), list = card.querySelector("[data-pkgs]");
        var on = !!(pick && pick.checked);
        card.classList.toggle("picked", on);
        if (list) list.hidden = !on;
        if (!on) return;
        picked++;
        if (/^Select /.test(pick.parentNode.textContent.trim())) newOnes++;
        var r = card.querySelector("[data-pkgs] input[type=radio]:checked");
        if (r && r.value) pkgs++;
      });
      bar.hidden = picked === 0;
      var parts = [];
      if (newOnes) parts.push(newOnes + (newOnes === 1 ? " service to switch on" : " services to switch on"));
      if (pkgs) parts.push(pkgs + (pkgs === 1 ? " package" : " packages"));
      sum.textContent = parts.length ? parts.join(" and ") : "Choose a package or untick";
      go.textContent = pkgs ? "Continue to order" : "Switch on";
    };
    svcForm.addEventListener("change", sync);
    sync();
  }
})();
