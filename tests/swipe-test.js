const { launchOptions, BASE_URL, CATALOGUE, ROOT } = require("./lib/env");
const { chromium, devices } = require("playwright");
const fs = require("fs");
(async () => {
  const browser=await chromium.launch({...launchOptions()});
  const ctx=await browser.newContext(devices["iPhone 13"]);
  await ctx.route("https://api.titopay.co.za/**",(route)=>{
    const u=new URL(route.request().url()); const J=(b)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(b)});
    if(u.pathname==="/health")return J({status:"ok"});
    if(u.pathname==="/v1/maintenance/public")return J({maintenance:{pwa:{enabled:false}}});
    if(u.pathname==="/v1/services")return J(JSON.parse(fs.readFileSync(CATALOGUE,"utf8")));
    J({ok:true,items:[]});
  });
  const page=await ctx.newPage();
  const errs=[]; page.on("pageerror",e=>errs.push(String(e).slice(0,120)));
  await page.goto(`${BASE_URL}/index.html`,{waitUntil:"networkidle"}).catch(()=>{});
  await page.waitForTimeout(2800);
  const read=()=>page.evaluate(()=>{
    const seg=document.querySelector("[data-account-segment]");
    return { isBusiness: seg.classList.contains("is-business"),
      thumbX: Math.round(seg.querySelector(".segment-thumb").getBoundingClientRect().left - seg.getBoundingClientRect().left),
      selected: [...seg.querySelectorAll("[role=tab]")].map(b=>b.getAttribute("aria-selected")),
      h1: document.querySelector("h1").textContent.trim() };
  });
  const R={ initial: await read() };
  // swipe right-to-left => business
  const box = await page.$eval("[data-landing-swipe]", el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};});
  const cy = box.y + box.h*0.35;
  await page.mouse.move(box.x+box.w*0.75, cy);
  await page.touchscreen.tap(box.x+box.w*0.75, cy).catch(()=>{});
  await page.evaluate(({x1,x2,y})=>{
    const el=document.querySelector("[data-landing-swipe]");
    const opt=(cx)=>({bubbles:true,cancelable:true,clientX:cx,clientY:y,pointerType:"touch",pointerId:1});
    el.dispatchEvent(new PointerEvent("pointerdown",opt(x1)));
    el.dispatchEvent(new PointerEvent("pointermove",opt(x2)));
    el.dispatchEvent(new PointerEvent("pointerup",opt(x2)));
  },{x1:box.x+box.w*0.8,x2:box.x+box.w*0.2,y:cy});
  await page.waitForTimeout(700);
  R.afterSwipeLeft = await read();
  // swipe back
  await page.evaluate(({x1,x2,y})=>{
    const el=document.querySelector("[data-landing-swipe]");
    const opt=(cx)=>({bubbles:true,cancelable:true,clientX:cx,clientY:y,pointerType:"touch",pointerId:1});
    el.dispatchEvent(new PointerEvent("pointerdown",opt(x1)));
    el.dispatchEvent(new PointerEvent("pointermove",opt(x2)));
    el.dispatchEvent(new PointerEvent("pointerup",opt(x2)));
  },{x1:box.x+box.w*0.2,x2:box.x+box.w*0.8,y:cy});
  await page.waitForTimeout(700);
  R.afterSwipeRight = await read();
  // vertical drag must NOT switch
  await page.evaluate(({x,y1,y2})=>{
    const el=document.querySelector("[data-landing-swipe]");
    const opt=(cy)=>({bubbles:true,cancelable:true,clientX:x,clientY:cy,pointerType:"touch",pointerId:1});
    el.dispatchEvent(new PointerEvent("pointerdown",opt(y1)));
    el.dispatchEvent(new PointerEvent("pointermove",opt(y2)));
    el.dispatchEvent(new PointerEvent("pointerup",opt(y2)));
  },{x:box.x+box.w*0.5,y1:cy,y2:cy+220});
  await page.waitForTimeout(600);
  R.afterVerticalDrag = await read();
  // tap still works
  await page.click('[data-account="business"]');
  await page.waitForTimeout(600);
  R.afterTap = await read();
  R.errors=errs;
  console.log(JSON.stringify(R,null,1));
  await browser.close();
})();
