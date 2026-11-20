/* SeaGeek chat widget.
   On seageek.co.za it opens SeaGeek support. On a customer's site:
   <script src="https://www.seageek.co.za/assets/js/chat-widget.js" data-org="your-slug" defer></script>
   Messages become Desk tickets; the AI agent answers first and hands over to people when needed. */
(function () {
  "use strict";
  if (window.__seageekChat) return;
  window.__seageekChat = true;

  var script = document.currentScript || document.querySelector('script[src*="chat-widget.js"]');
  var origin = script ? new URL(script.src, location.href).origin : location.origin;
  var org = (script && script.getAttribute("data-org")) || window.SEAGEEK_CHAT_ORG || "";
  var title = (script && script.getAttribute("data-title")) || "Chat with us";
  var storeKey = "sgchat:" + (org || "seageek");
  var greeting = (script && script.getAttribute("data-greeting")) || "";
  var color = (script && script.getAttribute("data-color")) || "";
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) color = "#5fe3cf";
  var rgb = [1, 3, 5].map(function (i) { return parseInt(color.substr(i, 2), 16); });
  var ink = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) > 150 ? "#031512" : "#ffffff";

  var css = ".sgw-fab{position:fixed;right:20px;bottom:20px;z-index:2147483000;height:52px;padding:0 20px 0 16px;border-radius:999px;border:0;background:#5fe3cf;color:#031512;font:600 15px/1 system-ui,-apple-system,Segoe UI,sans-serif;display:inline-flex;gap:8px;align-items:center;cursor:pointer;box-shadow:0 10px 30px -10px rgba(0,0,0,.6)}"
    + ".sgw-fab svg{width:20px;height:20px}.sgw-panel{position:fixed;right:20px;bottom:84px;z-index:2147483000;width:min(380px,calc(100vw - 24px));height:min(560px,calc(100vh - 110px));border-radius:18px;border:1px solid rgba(150,200,210,.22);background:#061218;color:#e6eff1;display:none;flex-direction:column;overflow:hidden;box-shadow:0 30px 80px -20px rgba(0,0,0,.8);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}"
    + ".sgw-panel.open{display:flex}.sgw-head{padding:14px 16px;border-bottom:1px solid rgba(150,200,210,.13);display:flex;justify-content:space-between;align-items:center}.sgw-head b{display:block;font-size:15px}.sgw-head span{font-size:12.5px;color:#7e959c}"
    + ".sgw-x{background:none;border:0;color:#7e959c;cursor:pointer;font-size:22px;width:32px;height:32px}.sgw-log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}"
    + ".sgw-b{max-width:85%;padding:9px 13px;border-radius:14px;font-size:14.5px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}.sgw-me{align-self:flex-end;background:#5fe3cf;color:#031512;border-bottom-right-radius:4px}"
    + ".sgw-them{align-self:flex-start;background:rgba(255,255,255,.07);border-bottom-left-radius:4px}.sgw-sys{align-self:center;color:#7e959c;font-size:12.5px;text-align:center}.sgw-tag{display:block;font-size:11.5px;color:#7e959c;margin-bottom:2px}"
    + ".sgw-typing{align-self:flex-start;display:flex;gap:4px;padding:10px 4px}.sgw-typing i{width:6px;height:6px;border-radius:50%;background:#7e959c;animation:sgwb 1.2s infinite}.sgw-typing i:nth-child(2){animation-delay:.2s}.sgw-typing i:nth-child(3){animation-delay:.4s}@keyframes sgwb{50%{opacity:.2}}"
    + ".sgw-form{display:flex;gap:8px;padding:12px;border-top:1px solid rgba(150,200,210,.13)}.sgw-form textarea{flex:1;height:44px;min-height:44px;max-height:120px;resize:none;padding:11px 12px;border-radius:10px;border:1px solid rgba(150,200,210,.22);background:#04090c;color:#e6eff1;font:inherit;font-size:14.5px}"
    + ".sgw-form button{width:44px;height:44px;border-radius:10px;border:0;background:#5fe3cf;color:#031512;cursor:pointer;display:grid;place-items:center}.sgw-form button svg{width:18px;height:18px}"
    + ".sgw-email{display:flex;gap:6px;padding:0 14px 10px}.sgw-email input{flex:1;height:36px;border-radius:8px;border:1px solid rgba(150,200,210,.22);background:#04090c;color:#e6eff1;padding:0 10px;font:inherit;font-size:13.5px}.sgw-email button{height:36px;border-radius:8px;border:1px solid rgba(150,200,210,.3);background:none;color:#e6eff1;padding:0 12px;cursor:pointer;font-size:13px}";
  css = css.replace(/#5fe3cf/g, color).replace(/#031512/g, ink);
  var style = document.createElement("style"); style.textContent = css; document.head.appendChild(style);

  var icChat = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var icSend = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>';

  var fab = document.createElement("button");
  fab.className = "sgw-fab"; fab.type = "button"; fab.innerHTML = icChat + "<span>" + title + "</span>"; fab.setAttribute("aria-expanded", "false");
  var panel = document.createElement("section");
  panel.className = "sgw-panel"; panel.setAttribute("aria-label", "Chat");
  panel.innerHTML = '<div class="sgw-head"><div><b>' + (org ? "Support" : "SeaGeek support") + '</b><span class="sgw-mode">Assistant replies straight away</span></div><button class="sgw-x" type="button" aria-label="Close chat">×</button></div>'
    + '<div class="sgw-log" aria-live="polite"></div>'
    + '<div class="sgw-email" hidden><input type="email" placeholder="Your email, so we can reply"><button type="button">Save</button></div>'
    + '<form class="sgw-form"><textarea rows="1" placeholder="Type your message" aria-label="Message"></textarea><button type="submit" aria-label="Send">' + icSend + "</button></form>";
  document.body.appendChild(fab); document.body.appendChild(panel);

  var log = panel.querySelector(".sgw-log"), form = panel.querySelector(".sgw-form"), box = form.querySelector("textarea");
  var mode = panel.querySelector(".sgw-mode"), emailRow = panel.querySelector(".sgw-email");
  var state = { token: "", after: 0, human: false, email: "" };
  try { state = Object.assign(state, JSON.parse(localStorage.getItem(storeKey) || "{}")); } catch (e) {}
  var shown = {}, timer = null, typing = null;

  function save() { try { localStorage.setItem(storeKey, JSON.stringify({ token: state.token, email: state.email })); } catch (e) {} }
  function bubble(from, text) {
    var b = document.createElement("div");
    if (from === "customer") b.className = "sgw-b sgw-me";
    else if (from === "system") b.className = "sgw-b sgw-sys";
    else { b.className = "sgw-b sgw-them"; var tag = document.createElement("span"); tag.className = "sgw-tag"; tag.textContent = from === "ai" ? "Assistant" : "Support team"; b.appendChild(tag); }
    b.appendChild(document.createTextNode(text));
    log.appendChild(b); log.scrollTop = log.scrollHeight;
  }
  function setTyping(on) {
    if (on && !typing) { typing = document.createElement("div"); typing.className = "sgw-typing"; typing.innerHTML = "<i></i><i></i><i></i>"; log.appendChild(typing); log.scrollTop = log.scrollHeight; }
    if (!on && typing) { typing.remove(); typing = null; }
  }
  function apply(data) {
    if (!data || data.error) { setTyping(false); bubble("system", (data && data.error) || "Something went wrong. Try again."); return; }
    state.token = data.token; save();
    (data.messages || []).forEach(function (m) { if (!shown[m.id]) { shown[m.id] = 1; bubble(m.from, m.text); } state.after = Math.max(state.after, m.id); });
    state.human = !!data.human;
    mode.textContent = state.human ? "A person from the team will reply here" : "Assistant replies straight away";
    emailRow.hidden = !(state.human && !state.email);
    setTyping(false);
    schedule();
  }
  function request(method, path, body) {
    var url = origin + path + (method === "GET" ? "?" + new URLSearchParams(body).toString() : "");
    return fetch(url, { method: method, headers: method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}, body: method === "POST" ? new URLSearchParams(body).toString() : undefined })
      .then(function (r) { return r.json(); });
  }
  function poll() {
    if (!state.token || !panel.classList.contains("open")) return;
    request("GET", "/chat/poll", { token: state.token, after: state.after, org: org }).then(apply).catch(schedule);
  }
  function schedule() { clearTimeout(timer); if (state.token && panel.classList.contains("open")) timer = setTimeout(poll, state.human ? 5000 : 15000); }

  function open(on) {
    panel.classList.toggle("open", on); fab.setAttribute("aria-expanded", String(on));
    if (on) {
      if (!log.childNodes.length) {
        bubble("ai", greeting || "Hi! Ask me anything about " + (org ? "our products and services" : "SeaGeek: pricing, APIs, WhatsApp, billing or your account") + ". If I can't help, I'll bring in a person.");
        if (state.token) request("GET", "/chat/poll", { token: state.token, after: 0, org: org }).then(apply).catch(function () {});
      }
      box.focus(); schedule();
    }
  }
  fab.addEventListener("click", function () { open(!panel.classList.contains("open")); });
  panel.querySelector(".sgw-x").addEventListener("click", function () { open(false); });
  box.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = box.value.trim();
    if (!text) return;
    box.value = "";
    bubble("customer", text);
    setTyping(!state.human);
    request("POST", "/chat/send", { text: text, token: state.token, after: state.after, org: org, email: state.email })
      .then(function (d) { (d.messages || []).forEach(function (m) { if (m.from === "customer") shown[m.id] = 1; }); apply(d); })
      .catch(function () { setTyping(false); bubble("system", "Couldn't send. Check your connection and try again."); });
  });
  emailRow.querySelector("button").addEventListener("click", function () {
    var v = emailRow.querySelector("input").value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return;
    state.email = v; save(); emailRow.hidden = true;
    bubble("system", "Thanks. We'll also reply to " + v + ".");
    request("POST", "/chat/send", { text: "(My email is " + v + ")", token: state.token, after: state.after, org: org, email: v }).then(apply).catch(function () {});
  });
})();
