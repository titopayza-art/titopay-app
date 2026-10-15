const { launchOptions, BASE_URL, CATALOGUE, ROOT } = require("./lib/env");
const { chromium, devices } = require("playwright");
const fs = require("fs");
(async () => {
  const cat = JSON.parse(fs.readFileSync(CATALOGUE,"utf8"));
  const browser = await chromium.launch({ executablePath:"/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args:["--no-sandbox"] });
  const ctx = await browser.newContext(devices["iPhone 13"]);
  await ctx.addInitScript(()=>localStorage.setItem("titopay_candidate_auth_v1",JSON.stringify({accessToken:"t",refreshToken:"r"})));
  await ctx.route("https://api.titopay.co.za/**",(route)=>{
    const u=new URL(route.request().url()); const J=(b)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(b)});
    let body={ok:true,items:[]};
    if(u.pathname==="/health")body={status:"ok"};
    else if(u.pathname==="/v1/maintenance/public")body={maintenance:{pwa:{enabled:false}}};
    else if(u.pathname==="/v1/services")body=cat;
    else if(u.pathname==="/v1/auth/me")body={user:{id:"u1",fullName:"Naledi Mokoena",username:"naledi",accountType:"personal",status:"active",walletId:"81234567",ficaStatus:"pending_review"}};
    else if(u.pathname==="/v1/wallets")body={items:[{wallet_id:"81234567",available_balance:12847.5}]};
    J(body);
  });
  const page=await ctx.newPage();
  await page.goto(`${BASE_URL}/index.html#services`,{waitUntil:"networkidle"}).catch(()=>{});
  await page.waitForTimeout(3300);
  await page.evaluate(()=>window.scrollTo(0,300));
  await page.waitForTimeout(300);
  const beforeModal = await page.evaluate(()=>Math.round(window.scrollY));
  // Dispatch directly: page.click() scrolls the target into view first, which
  // moves the page and invalidates the very thing being measured.
  await page.evaluate(()=>document.querySelector('[data-service="top-up"]').click());
  await page.waitForTimeout(900);
  const withModal = await page.evaluate(()=>{
    const bar=document.querySelector("[data-app-topbar]");
    const back=document.querySelector(".modal-backdrop");
    const cmp = back.compareDocumentPosition(bar);
    return {
      barZ: getComputedStyle(bar).zIndex,
      backdropZ: getComputedStyle(back).zIndex,
      barCoveredByBackdrop: Number(getComputedStyle(back).zIndex) > Number(getComputedStyle(bar).zIndex),
      barStillFixed: getComputedStyle(bar).position === "fixed",
      barTop: Math.round(bar.getBoundingClientRect().top),
      bodyFixed: getComputedStyle(document.body).position
    };
  });
  await page.screenshot({ path: require("path").join(process.env.SHOT_DIR || "tests/artifacts", "modal-stack.png") });
  await page.evaluate(()=>{ window.__trace=[]; const orig=window.scrollTo.bind(window);
    window.scrollTo=(...a)=>{ window.__trace.push(["scrollTo",JSON.stringify(a),Math.round(window.scrollY)]); return orig(...a); };
    const app=document.getElementById("app"); const obs=new MutationObserver(()=>window.__trace.push(["appRerender",Math.round(window.scrollY)]));
    obs.observe(app,{childList:true}); window.__obs=obs;
    window.__lockedY=()=> (window.state? window.state.modalScrollY : "n/a");
  });
  await page.evaluate(()=>document.querySelector(".modal-card [data-close]")?.click());
  await page.waitForTimeout(120);
  const justAfter = await page.evaluate(()=>Math.round(window.scrollY));
  await page.waitForTimeout(600);
  const afterModal = await page.evaluate(()=>Math.round(window.scrollY));
  const trace = await page.evaluate(()=>window.__trace);
  console.log("justAfter",justAfter,"trace",JSON.stringify(trace));
  console.log(JSON.stringify({ beforeModal, withModal, afterModal, scrollKept: Math.abs(beforeModal-afterModal)<=4 },null,1));
  await browser.close();
})();
