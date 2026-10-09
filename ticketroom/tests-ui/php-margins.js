// Phone-width layout check for the PHP edition: run after php-walkthrough.js on the same instance.
//   node tests-ui/php-margins.js
// Every page at phone width: headings, cards, forms and tables must sit inside the side margin.
const { chromium } = require("playwright");
const B = process.argv[2] || "http://127.0.0.1:8600";
const who = {
  visitor: [null, ["/", "/sell", "/advertise", "/help", "/contact", "/unsubscribe", "/legal/privacy", "/legal/terms", "/signin", "/nope", "/events/free-jazz-in-the-park"]],
  fan: [["sipho@example.co.za", "fan-password-123"], ["/account#/tickets", "/account#/orders", "/account#/transfers", "/account#/settings"]],
  org: [["naledi@example.co.za", "organiser-pass-1"], ["/organisers#/", "/organisers#/events", "/organisers#/marketing", "/organisers#/team", "/organisers#/settings", "/scan"]],
  admin: [["hello@ticketroom.co.za", "Admin-pass-#2026"], ["/admin#/", "/admin#/organisers", "/admin#/events", "/admin#/users", "/admin#/support", "/admin#/site", "/admin#/password"]],
};
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] });
  let bad = 0;
  for (const [k, [cred, urls]] of Object.entries(who)) {
    const p = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    if (cred) await p.request.post(B + "/api/auth/login", { data: { email: cred[0], password: cred[1] } });
    // the live site's first event slug
    for (let u of urls) {
      if (u.startsWith("/events/")) { const ev = await (await p.request.get(B + "/api/public/events")).json(); u = `/events/${ev.events[0]?.slug}`; }
      await p.goto(B + u); await p.waitForTimeout(900);
      const hits = await p.evaluate(() => [...document.querySelectorAll("#main h1, #main h2, #main .card, #main form, #main .table-wrap, #main p.lead, #main .page-head, #main .callout")]
        .filter((e) => e.offsetParent && !e.closest(".hero, .promo-band, .ad-band, .feature-rail, .poster-rail, .chips, .event-grid"))
        .map((e) => { const r = e.getBoundingClientRect(); return [e.tagName + "." + (e.className || "").toString().split(" ")[0], Math.round(r.left), Math.round(r.right)]; })
        .filter(([, l, r]) => l < 12 || r > 390 - 12 + 0.5));
      const over = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      if (hits.length || over) { bad++; console.log(k, u, over ? "PAGE SCROLLS SIDEWAYS" : "", JSON.stringify(hits.slice(0, 4))); }
    }
  }
  console.log(bad ? `${bad} pages with edge problems` : "All pages keep their side margins.");
  process.exitCode = bad ? 1 : 0;
  await b.close();
})();
