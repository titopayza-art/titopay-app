/* Live quote: re-prices on the server as volumes change, so the maths lives in one place. */
(function () {
  "use strict";
  var form = document.querySelector("[data-live-quote]"), out = document.getElementById("quote-result");
  if (!form || !out) return;
  var timer = null, seq = 0;
  function update() {
    var params = new URLSearchParams(new FormData(form));
    var url = location.pathname + "?" + params.toString();
    params.set("fragment", "1");
    var mine = ++seq;
    out.setAttribute("aria-busy", "true");
    fetch(location.pathname + "?" + params.toString(), { headers: { "X-Requested-With": "fetch" }, credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.text() : Promise.reject(r.status); })
      .then(function (html) { if (mine !== seq) return; out.innerHTML = html; out.removeAttribute("aria-busy"); history.replaceState(null, "", url); })
      .catch(function () { out.removeAttribute("aria-busy"); });
  }
  form.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(update, 250); });
  form.addEventListener("change", function () { clearTimeout(timer); timer = setTimeout(update, 50); });
  form.addEventListener("submit", function (e) { e.preventDefault(); update(); });
})();
