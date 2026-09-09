// Does Contact us open on a tap instead of sitting open?
//
// Driven through the real menu the app builds, not a fixture: the point is the
// section the customer actually taps.
const { chromium } = require("playwright");
const http = require("http"); const fs = require("fs"); const path = require("path");
const PWA = "/home/user/titopay-app/pwa"; const PORT = 8143;
const T={".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",
".webmanifest":"application/manifest+json",".png":"image/png",".jpg":"image/jpeg",".ico":"image/x-icon"};
const srv=http.createServer((q,r)=>{const c=decodeURIComponent(q.url.split("?")[0]);
let f=path.join(PWA,c==="/"?"index.html":c);
if(!f.startsWith(PWA)||!fs.existsSync(f)){r.writeHead(404).end();return;}
if(fs.statSync(f).isDirectory())f=path.join(f,"index.html");
r.writeHead(200,{"Content-Type":T[path.extname(f)]||"application/octet-stream"});fs.createReadStream(f).pipe(r);});
let bad=0; const ok=(l,v,d)=>{if(!v)bad++;console.log(`  ${v?"PASS":"FAIL"}  ${l}${d!==undefined?": "+d:""}`);};
(async()=>{
await new Promise(r=>srv.listen(PORT,"127.0.0.1",r));
const b=await chromium.launch({executablePath:"/opt/pw-browsers/chromium",args:["--no-sandbox"]});
const p=await b.newPage({viewport:{width:430,height:932}});
const errs=[]; p.on("pageerror",e=>errs.push(String(e.message)));
let posted=null;
await p.route("**/api.titopay.co.za/**",r=>{
  const u=r.request().url();
  if(/contact/i.test(u)&&r.request().method()==="POST"){posted=r.request().postData();}
  r.fulfill({status:200,contentType:"application/json",body:'{"ok":true,"items":[]}'});});
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:"load"}); await p.waitForTimeout(2200);

// Open the menu the way a customer does.
await p.evaluate(()=>window.openLandingMenu());
await p.waitForTimeout(700);

const d = p.locator("details.menu-section-collapsible");
ok("the Contact us section is a disclosure", await d.count()===1, String(await d.count()));
ok("it starts CLOSED", await d.evaluate(e=>!e.open));
ok("the form is not rendered open", !(await p.locator(".landing-contact-form").isVisible()));
ok("but the heading is there to tap", (await p.locator(".menu-section-summary h3").innerText()).trim()==="Contact us");

// The other sections must be untouched.
const plain = await p.locator("section.menu-section").count();
ok("the other menu sections still render normally", plain === 7, `${plain} plain sections`);
ok("their content is still visible", await p.locator("section.menu-section .menu-section-body").first().isVisible());

// Tap it.
await p.locator(".menu-section-summary").click();
await p.waitForTimeout(400);
ok("a tap opens it", await d.evaluate(e=>e.open));
ok("the form is now visible", await p.locator(".landing-contact-form").isVisible());
const caret = await p.locator(".menu-section-caret").evaluate(e=>getComputedStyle(e).transform);
ok("the chevron turned", caret !== "none", caret);

// Type, close, reopen: the draft must survive, which is why this is <details>.
await p.fill('.landing-contact-form input[name="fullName"]', "Thuso Tshiloane");
await p.locator(".menu-section-summary").click(); await p.waitForTimeout(250);
ok("a second tap closes it", await d.evaluate(e=>!e.open));
await p.locator(".menu-section-summary").click(); await p.waitForTimeout(250);
const kept = await p.inputValue('.landing-contact-form input[name="fullName"]');
ok("a typed draft survives closing and reopening", kept === "Thuso Tshiloane", JSON.stringify(kept));

// And it still submits.
await p.fill('.landing-contact-form input[name="cellphone"]', "0821234567");
await p.fill('.landing-contact-form textarea[name="message"]', "Testing the contact form still works.");
await p.check('.landing-contact-form input[name="consent"]');
await p.locator('.landing-contact-form button[type="submit"]').click();
await p.waitForTimeout(1200);
ok("the enquiry still posts", Boolean(posted) && /Thuso Tshiloane/.test(posted||""), posted?String(posted).slice(0,60):"nothing posted");
ok("no page errors", errs.length===0, errs.join(" | "));

await p.screenshot({path:"menu-closed.png"});
await b.close(); srv.close();
console.log(bad?`\n${bad} check(s) failed`:"\nall checks passed"); process.exit(bad?1:0);})();
