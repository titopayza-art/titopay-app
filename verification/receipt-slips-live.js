"use strict";
// THE TWO SLIPS, READ OFF THE RENDERED SCREEN IN A REAL BROWSER.
process.env.NODE_ENV="test";
process.env.POSTGRES_URL||="postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET||="test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET||="test-refresh-secret-with-sufficient-length";
const assert=require("node:assert/strict");
const {randomUUID}=require("node:crypto");
const {pool}=require("/home/user/titopay-app/api/src/db/pool");
const bcrypt=require("bcryptjs");
const {chromium}=require("playwright");
const TAG=`rc${String(Date.now()).slice(-7)}`;
const PASS="Str0ng!Pass2026";
const shop={id:randomUUID(),phone:"27110000261",type:"business"};
const payer={id:randomUUID(),phone:"27110000262",type:"personal"};
async function seed(u,bal){u.email=`${TAG}_${u.phone.slice(-3)}@example.invalid`;
 await pool.query(`INSERT INTO users (id,account_type,full_name,username,email,phone,password_hash,status,profile_locked,fica_status,basic_verified_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,'active',FALSE,'approved',NOW())`,[u.id,u.type,`${TAG} P${u.phone.slice(-3)}`,`${TAG}_${u.phone.slice(-3)}`,u.email,u.phone,await bcrypt.hash(PASS,10)]);
 await pool.query(`INSERT INTO wallets (id,wallet_number,user_id,kind,currency,available_balance,reserved_balance,status)
  VALUES ($1,$2,$3,$4,'ZAR',$5,0,'active')`,[randomUUID(),u.phone.slice(-9),u.id,u.type,bal]);}
(async()=>{let passed=0;const ok=(m,d="")=>{console.log(`  PASS  ${m}${d?"  — "+d:""}`);passed++;};let browser=null;
 try{
  await seed(shop,0); await seed(payer,5000);
  await pool.query(`INSERT INTO merchants (id,user_id,business_name,merchant_id,status,verification_status)
   VALUES ($1,$2,$3,$4,'active','verified')`,[randomUUID(),shop.id,`${TAG} Corner Cafe`,`TPM-${Date.now()}-${TAG.slice(-4).toUpperCase()}`]);
  browser=await chromium.launch({args:["--no-sandbox"],executablePath:"/opt/pw-browsers/chromium-1194/chrome-linux/chrome"});
  const context=await browser.newContext({viewport:{width:900,height:1200},serviceWorkers:"block"});
  await context.route("https://api.titopay.co.za/**",async(route)=>{const rq=route.request();
   const t=rq.url().replace("https://api.titopay.co.za","http://127.0.0.1:8110");
   const h=Object.assign({},rq.headers());delete h.host;delete h.origin;delete h.referer;
   const up=await fetch(t,{method:rq.method(),headers:h,body:rq.postData()||undefined,redirect:"manual"});
   const body=Buffer.from(await up.arrayBuffer());const out={};
   up.headers.forEach((v,k)=>{if(!/^(content-encoding|content-length|transfer-encoding)$/i.test(k))out[k]=v;});
   out["access-control-allow-origin"]="*";await route.fulfill({status:up.status,headers:out,body});});
  const open=async(u)=>{const p=await context.newPage();const errs=[];p.on("pageerror",e=>errs.push(String(e)));
   await p.goto("http://127.0.0.1:8010/",{waitUntil:"domcontentloaded"});await p.waitForTimeout(1200);
   const okd=await p.evaluate(async({email,password,accountType})=>{
    const r=await fetch("https://api.titopay.co.za/v1/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({identifier:email,password})});
    const b=await r.json();const tok=b.accessToken||b.token||(b.tokens&&b.tokens.accessToken);if(!tok)return false;
    state.auth=Object.assign({},state.auth||{},b.tokens||{},{accessToken:tok});state.user=b.user||{};state.accountType=accountType;
    await refreshData().catch(()=>{});return true;},{email:u.email,password:PASS,accountType:u.type});
   if(!okd)throw new Error("sign in failed");return {page:p,errs};};
  const till=await open(shop); const phone=await open(payer);
  // Merchant rings up R50 and the customer pays it.
  await till.page.evaluate(()=>openMerchantSaleModal());
  await till.page.waitForSelector("[data-pos-key]",{timeout:10000});
  for(const d of "50")await till.page.click(`[data-pos-key="${d}"]`);
  await till.page.click("[data-action='merchant-generate-qr']");
  await till.page.waitForSelector("[data-sale-countdown]",{timeout:15000});
  const qrId=await till.page.evaluate(()=>state.merchantSale?.qr?.id||"");
  await phone.page.evaluate(async(id)=>{await processQrPayment({qrId:id});},qrId);
  await phone.page.waitForSelector("[data-action='confirm-qr-payment-review']",{timeout:15000});
  await phone.page.click("[data-action='confirm-qr-payment-review']");
  await phone.page.waitForTimeout(3500);
  // THE CUSTOMER'S SLIP, read off the screen.
  const customer=await phone.page.evaluate(()=>{
   const r=titoPayReceipts()[0];
   openReceiptModal(r.id);
   return [...document.querySelectorAll(".receipt-card dl > div")].map(d=>[d.querySelector("dt").textContent.trim(),d.querySelector("dd").textContent.trim()]);});
  const cmap=new Map(customer);
  console.log("\n  THE CUSTOMER'S SLIP");for(const[k,v]of customer)console.log(`    ${k.padEnd(18)} ${v}`);
  assert.equal(cmap.has("Merchant ID"),false,"the customer is still shown a raw Merchant ID");
  ok("the customer's slip shows no Merchant ID");
  // Headless Chromium renders en-ZA with a period; a phone shows a comma. The
  // separator is the locale's business, the figure is the product's.
  const cents=(v)=>String(v||"").replace(/[^\d.,]/g,"").replace(",",".");
  assert.equal(cents(cmap.get("Total paid")),"51.50",`the customer's total reads ${cmap.get("Total paid")}`);
  assert.equal(cmap.has("Net Amount"),false,"the merchant's net is still on the customer's slip");
  ok("and it says Total paid R51,50, which is what left the wallet");
  await till.page.waitForTimeout(3000);
  const merchant=await till.page.evaluate(()=>{
   const r=titoPayReceipts().find(x=>x.accountType==="business");
   openReceiptModal(r.id);
   return [...document.querySelectorAll(".receipt-card dl > div")].map(d=>[d.querySelector("dt").textContent.trim(),d.querySelector("dd").textContent.trim()]);});
  const mmap=new Map(merchant);
  console.log("\n  THE MERCHANT'S SLIP");for(const[k,v]of merchant)console.log(`    ${k.padEnd(18)} ${v}`);
  const shownId=mmap.get("Merchant ID");
  assert.ok(shownId,"the merchant lost their Merchant ID");
  // IT MUST BE THE TRADING ID, NOT THE ACCOUNT UUID. currentMerchantId() ended
  // in user.id, and nothing in the session carried a merchant id, so every
  // merchant receipt printed the owner's internal account UUID on a document
  // with a Share button. TPM-... is what a merchant quotes to Support.
  assert.doesNotMatch(shownId,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    `the merchant's slip shows a raw UUID (${shownId}) instead of their trading id`);
  assert.match(shownId,/^TPM-/,`the merchant's slip shows "${shownId}", not their TPM- trading id`);
  ok("the merchant's slip shows their real trading id, not an account UUID",shownId);
  assert.equal(cents(mmap.get("Net Amount")),"47.75",`the merchant's net reads ${mmap.get("Net Amount")}`);
  assert.equal(cents(mmap.get("Fees")),"2.25",`the merchant's fee reads ${mmap.get("Fees")}`);
  ok("and it says Net Amount R47,75 with a fee of R2,25, which is what arrived");
  assert.deepEqual([...till.errs,...phone.errs],[],"script errors");
  ok("no script errors on either screen");
  console.log(`\n  ${passed}/5 checks passed\n`);
 }catch(e){console.error("\nFAILED:",e.message);process.exitCode=1;}
 finally{if(browser)await browser.close().catch(()=>{});
  for(const u of[shop,payer]){for(const q of["DELETE FROM email_queue WHERE user_id=$1","DELETE FROM notifications WHERE user_id=$1",
   "DELETE FROM revenue_ledger WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id=$1)",
   "DELETE FROM wallet_ledger WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id=$1)",
   "DELETE FROM wallet_ledger WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id=$1)",
   "DELETE FROM transactions WHERE user_id=$1","DELETE FROM qr_codes WHERE user_id=$1","DELETE FROM audit_logs WHERE actor_id=$1",
   "DELETE FROM merchants WHERE user_id=$1","DELETE FROM wallets WHERE user_id=$1 AND kind<>'revenue'","DELETE FROM users WHERE id=$1"])
   await pool.query(q,[u.id]).catch(()=>{});}
  await pool.end().catch(()=>{});}
})();
