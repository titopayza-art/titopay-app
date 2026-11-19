/* Docs: "On this page" index with scroll tracking, and instant search across every page and endpoint. */
(function () {
  "use strict";
  var article = document.getElementById("docs-article"), toc = document.querySelector("[data-toc]");
  if (article && toc) {
    var items = article.querySelectorAll("h2[id], section.endpoint[id], .docs-steps > li[id]");
    var links = [];
    items.forEach(function (el) {
      var a = document.createElement("a");
      a.href = "#" + el.id;
      var h = el.tagName === "LI" ? el.querySelector("h2") : null;
      a.textContent = el.dataset.tocTitle || (h ? h.textContent : el.textContent).trim();
      if (el.tagName === "SECTION") a.className = "sub";
      toc.appendChild(a);
      links.push([el, a]);
    });
    if (!links.length) toc.parentNode.hidden = true;
    var mark = function () {
      var current = null;
      links.forEach(function (pair) { if (pair[0].getBoundingClientRect().top < 140) current = pair[1]; });
      links.forEach(function (pair) { pair[1].classList.toggle("on", pair[1] === current); });
    };
    window.addEventListener("scroll", mark, { passive: true }); mark();
  }
  var input = document.querySelector("[data-docs-search]"), box = document.querySelector("[data-docs-results]"), data = document.getElementById("docs-index");
  if (!input || !box || !data) return;
  var index = JSON.parse(data.textContent);
  var esc = function (s) { return s.replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  var sel = -1;
  var run = function () {
    var q = input.value.trim().toLowerCase();
    if (q.length < 2) { box.hidden = true; return; }
    var words = q.split(/\s+/);
    var hits = index.map(function (it) {
      var hay = (it.t + " " + it.d + " " + it.g).toLowerCase(), score = 0;
      for (var i = 0; i < words.length; i++) { if (hay.indexOf(words[i]) < 0) return null; score += it.t.toLowerCase().indexOf(words[i]) >= 0 ? 3 : 1; }
      return [score, it];
    }).filter(Boolean).sort(function (a, b) { return b[0] - a[0]; }).slice(0, 8);
    sel = -1;
    box.innerHTML = hits.length ? hits.map(function (h) { return '<a href="' + esc(h[1].h) + '"><b>' + esc(h[1].t) + '</b><span>' + esc(h[1].g) + ' · ' + esc(h[1].d) + '</span></a>'; }).join("") : '<p>No results. Try "sms", "webhook" or "error".</p>';
    box.hidden = false;
  };
  input.addEventListener("input", run);
  input.addEventListener("keydown", function (e) {
    var a = box.querySelectorAll("a");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, Math.min(a.length - 1, sel + (e.key === "ArrowDown" ? 1 : -1))); a.forEach(function (x, i) { x.classList.toggle("on", i === sel); }); }
    if (e.key === "Enter" && a.length) { e.preventDefault(); location.href = a[Math.max(0, sel)].getAttribute("href"); }
    if (e.key === "Escape") { box.hidden = true; input.blur(); }
  });
  document.addEventListener("click", function (e) { if (!e.target.closest(".docs-search")) box.hidden = true; });
  document.addEventListener("keydown", function (e) { if (e.key === "/" && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA") { e.preventDefault(); input.focus(); } });
})();
