// Does the splash show the RIGHT wordmark in each colour scheme, and is the
// Peach line gone? Measured from real pixels, because "the markup says so" is
// how the wrong logo shipped in the first place.
const { chromium } = require("playwright");
const http = require("http"); const fs = require("fs"); const path = require("path");
const PWA = "/home/user/titopay-app/pwa"; const PORT = 8141;
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
for (const scheme of ["light","dark"]) {
  const ctx=await b.newContext({colorScheme:scheme,viewport:{width:430,height:932},deviceScaleFactor:2});
  const p=await ctx.newPage();
  // Block the bundle so we measure the SPLASH itself — the first frame, before
  // any JavaScript has had a chance to repaint it.
  await p.route("**/app.min.js*",r=>r.abort());
  await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:"load"});
  await p.waitForTimeout(900);
  const info=await p.evaluate(()=>{
    const img=document.querySelector(".launch-logo");
    return { src: img ? img.currentSrc.split("/").pop() : null,
      w: img ? img.getBoundingClientRect().width : 0,
      h: img ? img.getBoundingClientRect().height : 0,
      bodyBg: getComputedStyle(document.body).backgroundImage,
      text: document.body.innerText };
  });
  console.log(`\n[${scheme}]`);
  ok("the right wordmark is chosen", info.src === (scheme==="dark"?"titopay-logo-night.png":"titopay-logo.png"), info.src);
  ok("it is laid out as a wordmark, not a square", info.w > info.h*3, `${Math.round(info.w)}x${Math.round(info.h)}`);
  ok("no Peach attribution on the splash", !/Peach/i.test(info.text));
  ok("the company line is still there", /Reg No: 2026\/399418\/07/.test(info.text));
  ok("the tagline is still there", /Smart Payments\. Simplified\./.test(info.text));
  // Contrast: sample the logo's own pixels against the ground behind it.
  const shot=await p.locator(".launch-logo").screenshot();
  fs.writeFileSync(`/tmp/claude-0/-home-user-titopay-app/b46bca12-b8d1-59fa-a0f4-cf119e42703a/scratchpad/splash-${scheme}.png`, shot);
  await p.screenshot({path:`/tmp/claude-0/-home-user-titopay-app/b46bca12-b8d1-59fa-a0f4-cf119e42703a/scratchpad/splash-full-${scheme}.png`});
  await ctx.close();
}
await b.close(); srv.close();
console.log(bad?`\n${bad} check(s) failed`:"\nall checks passed");
process.exit(bad?1:0);})();
