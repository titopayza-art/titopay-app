/* SeaGeek Assistants: chat workspace, approvals, task ticks, and the shared-link page. */
(function () {
  "use strict";
  var esc = function (s) { var d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; };
  var post = function (url, data) {
    return fetch(url, { method: "POST", credentials: "same-origin", headers: { Accept: "application/json" }, body: data })
      .then(function (r) { return r.json().catch(function () { return { error: "Something went wrong. Try again." }; }); });
  };
  var typing = function (log) {
    var t = document.createElement("div"); t.className = "amsg ai"; t.innerHTML = '<div class="atyping"><i></i><i></i><i></i></div>';
    log.appendChild(t); log.scrollTop = log.scrollHeight; return t;
  };
  var grow = function (box) { box.style.height = "auto"; box.style.height = Math.min(box.scrollHeight, 220) + "px"; };

  // Model picker: keep the hidden provider field in step with the chosen model.
  document.querySelectorAll("[data-provider-select]").forEach(function (sel) {
    var hidden = sel.form.querySelector('input[name="provider"]');
    sel.addEventListener("change", function () { hidden.value = sel.selectedOptions[0].dataset.provider; });
  });

  var form = document.getElementById("asst-form");
  if (form) {
    var log = document.getElementById("asst-log"), box = document.getElementById("asst-input");
    var csrf = form.querySelector('input[name="_csrf"]').value, busy = false;
    log.scrollTop = log.scrollHeight;
    var card = function (x) {
      var head = x.kind === "email" ? "Email to " + x.to : "SMS to " + x.to;
      var body = x.kind === "email" ? "<b>" + esc(x.subject) + '</b><div class="pre">' + esc(x.body) + "</div>" : '<div class="pre">' + esc(x.text) + "</div>";
      return '<div class="appr" data-appr="' + x.id + '"><div class="appr-head"><span>' + esc(head) + "</span><small>Draft, needs your approval</small></div>" + body
        + '<form method="post" action="' + form.dataset.decide + '" class="appr-btns" data-decide><input type="hidden" name="_csrf" value="' + esc(csrf) + '"><input type="hidden" name="id" value="' + x.id + '">'
        + '<button class="btn btn-primary btn-xs" name="decision" value="send">Send</button><button class="btn btn-ghost btn-xs" name="decision" value="cancel">Cancel</button></form></div>';
    };
    var send = function (text) {
      if (busy || !text.trim()) return;
      busy = true; form.classList.add("busy");
      var empty = log.querySelector(".asst-empty"); if (empty) empty.remove();
      var me = document.createElement("div"); me.className = "amsg me"; me.innerHTML = '<div class="abody">' + esc(text).replace(/\n/g, "<br>") + "</div>";
      log.appendChild(me); box.value = ""; grow(box);
      var t = typing(log);
      var fd = new FormData(); fd.append("_csrf", csrf); fd.append("message", text); fd.append("chat", form.dataset.chat || "");
      post(form.dataset.send, fd).then(function (d) {
        t.remove();
        var m = document.createElement("div"); m.className = "amsg ai";
        if (d.error) { m.innerHTML = '<div class="abody err">' + esc(d.error) + "</div>"; }
        else {
          var done = (d.actions || []).map(function (a) { return '<span>&#10003; ' + esc(a) + "</span>"; }).join("");
          m.innerHTML = (done ? '<div class="adone">' + done + "</div>" : "") + '<div class="abody">' + d.html + "</div>" + (d.approvals || []).map(card).join("");
          if (d.chat && d.chat !== form.dataset.chat) {
            form.dataset.chat = d.chat;
            try { history.replaceState(null, "", location.pathname + "?chat=" + encodeURIComponent(d.chat)); } catch (e) {}
          }
          if ((d.actions || []).some(function (a) { return /task/i.test(a); })) refreshTasks();
        }
        log.appendChild(m); log.scrollTop = log.scrollHeight;
      }).catch(function () { t.remove(); var m = document.createElement("div"); m.className = "amsg ai"; m.innerHTML = '<div class="abody err">Could not reach SeaGeek. Check your connection and try again.</div>'; log.appendChild(m); })
        .then(function () { busy = false; form.classList.remove("busy"); box.focus(); });
    };
    var refreshTasks = function () {
      fetch(location.href, { credentials: "same-origin" }).then(function (r) { return r.text(); }).then(function (html) {
        var fresh = new DOMParser().parseFromString(html, "text/html").getElementById("side-tasks"), cur = document.getElementById("side-tasks");
        if (fresh && cur) cur.replaceWith(fresh);
      }).catch(function () {});
    };
    form.addEventListener("submit", function (e) { e.preventDefault(); send(box.value); });
    box.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(box.value); } });
    box.addEventListener("input", function () { grow(box); });
    document.addEventListener("click", function (e) {
      var s = e.target.closest("[data-starter]"); if (s) send(s.dataset.starter);
    });
    // Send or cancel a draft without leaving the page.
    document.addEventListener("submit", function (e) {
      var f = e.target.closest("[data-decide]"); if (!f) return;
      e.preventDefault();
      var fd = new FormData(f); if (e.submitter) fd.append(e.submitter.name, e.submitter.value);
      f.querySelectorAll("button").forEach(function (b) { b.disabled = true; });
      post(f.action, fd).then(function (d) {
        var st = d.approval && d.approval.status === "approved" ? "approved" : (d.approval && d.approval.status === "cancelled" ? "cancelled" : "error");
        f.outerHTML = '<span class="appr-state ' + st + '">' + esc(d.message || "Done") + "</span>";
      });
    });
    // Tick a task done from the side panel.
    document.addEventListener("change", function (e) {
      var c = e.target.closest("[data-task]"); if (!c) return;
      var fd = new FormData(); fd.append("_csrf", csrf); fd.append("id", c.dataset.task); if (c.checked) fd.append("done", "1");
      post(form.dataset.send.replace(/\/send$/, "/task"), fd).then(function () { var li = c.closest("li"); if (li && c.checked) li.classList.add("ticked"); });
    });
    if (!form.dataset.new) box.focus();
  }

  var pub = document.getElementById("pub-form");
  if (pub) {
    var plog = document.getElementById("pub-log"), pbox = pub.querySelector("textarea"), pbusy = false;
    var psend = function () {
      var text = pbox.value.trim(); if (!text || pbusy) return;
      pbusy = true;
      var me = document.createElement("div"); me.className = "amsg me"; me.innerHTML = '<div class="abody">' + esc(text) + "</div>"; plog.appendChild(me); pbox.value = "";
      var t = typing(plog), fd = new FormData(pub); fd.set("message", text);
      post(pub.dataset.url, fd).then(function (d) {
        t.remove(); var m = document.createElement("div"); m.className = "amsg ai";
        m.innerHTML = d.error ? '<div class="abody err">' + esc(d.error) + "</div>" : '<div class="abody">' + d.html + "</div>";
        plog.appendChild(m); plog.scrollTop = plog.scrollHeight;
      }).catch(function () { t.remove(); }).then(function () { pbusy = false; });
    };
    pub.addEventListener("submit", function (e) { e.preventDefault(); psend(); });
    pbox.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); psend(); } });
  }
})();
