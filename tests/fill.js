const { launchOptions, BASE_URL, CATALOGUE, ROOT } = require("./lib/env");
const { chromium } = require("playwright");
const fs = require("fs");
const V = [[320,568],[375,667],[393,852],[430,932],[768,1024],[820,1180],[1024,768],[1280,800],[1440,900],[1920,1080]];
(async () => {
  const browser = await chromium.launch({ executablePath:"/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args:["--no-sandbox"] });
  for (const acct of ["personal","business"]) {
    const rows=[];
    for (const [w,h] of V) {
      const ctx = await browser.newContext({ viewport:{width:w,height:h}, isMobile:w<768, hasTouch:w<768, deviceScaleFactor:1 });
      await ctx.route("https://api.titopay.co.za/**",(route)=>{
        const u=new URL(route.request().url()); const J=(b)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(b)});
        if(u.pathname==="/health")return J({status:"ok"});
        if(u.pathname==="/v1/maintenance/public")return J({maintenance:{pwa:{enabled:false}}});
        if(u.pathname==="/v1/services")return J(JSON.parse(fs.readFileSync(CATALOGUE,"utf8")));
        J({ok:true,items:[]});
      });
      const page=await ctx.newPage();
      const errs=[]; page.on("pageerror",e=>errs.push(String(e).slice(0,80)));
      await page.goto(`${BASE_URL}/index.html`,{waitUntil:"networkidle"}).catch(()=>{});
      await page.waitForTimeout(2600);
      if(acct==="business"){ await page.click('[data-account="business"]').catch(()=>{}); await page.waitForTimeout(900); }
      const m = await page.evaluate(() => {
        const main=document.querySelector(".landing-flow");
        const kids=[...main.children].filter(e=>e.getBoundingClientRect().height>0);
        const tops=kids.map(e=>e.getBoundingClientRect().top), bots=kids.map(e=>e.getBoundingClientRect().bottom);
        const blockTop=Math.min(...tops), blockBot=Math.max(...bots);
        const de=document.documentElement;
        const seg=main.querySelector(".segment");
        const h1=main.querySelector("h1"), tag=main.querySelector(".landing-tagline");
        return {
          blockH: Math.round(blockBot-blockTop), view: de.clientHeight,
          topBand: Math.round(blockTop), bottomBand: Math.round(de.clientHeight-blockBot),
          scrolls: de.scrollHeight>de.clientHeight+1,
          overflowX: de.scrollWidth>de.clientWidth+1,
          cols: getComputedStyle(main).gridTemplateColumns.split(" ").length,
          h1Align: h1?getComputedStyle(h1).textAlign:null,
          tagAlign: tag?getComputedStyle(tag).textAlign:null,
          h1Size: h1?getComputedStyle(h1).fontSize:null,
          segThumb: !!main.querySelector(".segment-thumb"),
          tiles: main.querySelectorAll(".preview-grid .service-tile").length
        };
      });
      rows.push({size:`${w}x${h}`, fill:`${Math.round(m.blockH/m.view*100)}%`, ...m, errors:errs.length});
      await ctx.close();
    }
    console.log("== "+acct);
    rows.forEach(r=>console.log(`  ${r.size.padEnd(10)} fill=${r.fill.padStart(4)} block=${String(r.blockH).padStart(4)}/${r.view} bands=${r.topBand}/${r.bottomBand} cols=${r.cols} tiles=${r.tiles} h1=${r.h1Size} align=${r.h1Align}/${r.tagAlign} scroll=${r.scrolls} ovX=${r.overflowX} err=${r.errors}`));
  }
  await browser.close();
})();
