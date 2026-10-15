const { launchOptions, BASE_URL, CATALOGUE, ROOT } = require("./lib/env");
const { chromium } = require("playwright");
const fs = require("fs");
const OUT = process.env.SHOT_DIR || "tests/artifacts";
const TX = Array.from({length:26},(_,i)=>({id:`t${i}`,reference:`TP-${1000+i}`,service_name:["Send Money","Airtime","Electricity","Payment Request","Top Up"][i%5],direction:i%3===0?"credit":"debit",amount:120+i*7,total:122.5+i*7,status:"completed",created_at:new Date(Date.now()-i*86400000).toISOString()}));
(async () => {
  const cat=JSON.parse(fs.readFileSync(CATALOGUE,"utf8"));
  const browser=await chromium.launch({...launchOptions()});
  for (const acct of ["personal","business"]) {
    const ctx=await browser.newContext({viewport:{width:430,height:932},isMobile:true,hasTouch:true,deviceScaleFactor:2});
    await ctx.addInitScript(()=>{localStorage.setItem("titopay_candidate_auth_v1",JSON.stringify({accessToken:"t",refreshToken:"r"}));
      document.addEventListener("DOMContentLoaded",()=>document.documentElement.style.setProperty("--safe-top","47px"));});
    await ctx.route("https://api.titopay.co.za/**",(route)=>{
      const u=new URL(route.request().url()); const J=(b)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(b)});
      let body={ok:true,items:[]};
      if(u.pathname==="/health")body={status:"ok"};
      else if(u.pathname==="/v1/maintenance/public")body={maintenance:{pwa:{enabled:false}}};
      else if(u.pathname==="/v1/services")body=cat;
      else if(u.pathname==="/v1/transactions")body={items:TX};
      else if(u.pathname==="/v1/auth/me")body={user:{id:"u1",fullName:"Thuso Tshiloane",businessName:"Naledi Trading",username:"thuso.tshiloane",accountType:acct,status:"active",walletId:"81234567",ficaStatus:"pending_review",email:"thusotshiloane@icloud.com"}};
      else if(u.pathname==="/v1/wallets")body={items:[{wallet_id:"81234567",available_balance:12847.5}]};
      J(body);
    });
    const page=await ctx.newPage();
    await page.goto(`${BASE_URL}/index.html#services`,{waitUntil:"networkidle"}).catch(()=>{});
    await page.waitForTimeout(3300);
    await page.evaluate(()=>document.documentElement.style.setProperty("--safe-top","47px"));
    await page.evaluate(()=>document.querySelector(".install-float-wrap .icon-btn, [data-install-dismiss]")?.click());
    await page.waitForTimeout(400);
    for (const [route,scrollY,label] of [["services",0,"services-top"],["services",520,"services-scrolled"],["activity",380,"activity-scrolled"],["dashboard",0,"home-top"],["profile",0,"profile-top"]]) {
      await page.evaluate((r)=>{location.hash=r;},route);
      await page.waitForTimeout(800);
      await page.evaluate((y)=>window.scrollTo(0,y),scrollY);
      await page.waitForTimeout(450);
      await page.screenshot({path:`${OUT}/inside-${acct}-${label}.png`});
    }
    await ctx.close();
  }
  await browser.close();
})();
