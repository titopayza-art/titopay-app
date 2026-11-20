// Seeds a freshly set-up local instance of the live package through its own
// public and admin APIs, the same calls the pages make:
//   - admin (hello@ticketroom.co.za) signs in with password + emailed staff code
//   - payments set to the TicketRoom sandbox (Admin > Integrations button)
//   - an organiser signs up (/api/organiser/signup) and confirms the emailed link
//   - a customer signs up (/api/auth/register) and confirms the emailed link
//   - admin approves the organisation; the organiser saves "About you", signs
//     the organiser terms and uploads an ID document; admin approves it
//   - one free event (starting in about 3 hours, so the gate is open) and one
//     paid event (in 3 weeks) are created, submitted and published
// Emails are read from the message_outbox table (mail mode "log").
// Prints a JSON summary (accounts, events) on stdout.
//
//   TR_BASE=http://localhost:8640 TR_DATA=<dir>/ticketroom-data TR_TEST_ADMIN_PASSWORD=... node seed.js
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { Client, outbox, ADMIN_EMAIL } = require("./lib");

const BASE = process.env.TR_BASE || "http://localhost:8640";
const DATA = process.env.TR_DATA;
const ADMIN_PW = process.env.TR_TEST_ADMIN_PASSWORD;
if (!DATA || !ADMIN_PW) { console.error("TR_DATA and TR_TEST_ADMIN_PASSWORD are required"); process.exit(1); }

// A valid South African ID number (Luhn check digit), born 1990-01-01, citizen.
function saId() {
  const body = "900101" + String(5000 + crypto.randomInt(4999)).padStart(4, "0") + "08";
  for (let c = 0; c < 10; c++) {
    const id = body + c;
    let sum = 0;
    for (let i = 0; i < 13; i++) { let d = +id[12 - i]; if (i % 2) { d *= 2; if (d > 9) d -= 9; } sum += d; }
    if (sum % 10 === 0) return id;
  }
  throw new Error("no check digit");
}
// The smallest valid PNG (1x1), standing in for an ID document scan.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
// An event poster drawn with PHP's GD (no external images, no real artists).
function poster(title, line2, colours) {
  const php = `[$w,$h]=[1200,1500]; $im=imagecreatetruecolor($w,$h);
$a=sscanf($argv[3],'#%02x%02x%02x'); $b=sscanf($argv[4],'#%02x%02x%02x');
for($y=0;$y<$h;$y++){$t=$y/$h;$c=imagecolorallocate($im,(int)($a[0]+($b[0]-$a[0])*$t),(int)($a[1]+($b[1]-$a[1])*$t),(int)($a[2]+($b[2]-$a[2])*$t));imageline($im,0,$y,$w,$y,$c);}
imagefilledellipse($im,600,620,620,620,imagecolorallocatealpha($im,255,196,87,30));
$draw=function($txt,$y,$scale) use($im,$w){$f=5;$tw=imagefontwidth($f)*strlen($txt);$th=imagefontheight($f);$tmp=imagecreatetruecolor($tw,$th);imagealphablending($tmp,false);imagesavealpha($tmp,true);imagefill($tmp,0,0,imagecolorallocatealpha($tmp,0,0,0,127));imagestring($tmp,$f,0,0,$txt,imagecolorallocate($tmp,255,255,255));imagecopyresampled($im,$tmp,(int)(($w-$tw*$scale)/2),$y,0,0,(int)($tw*$scale),(int)($th*$scale),$tw,$th);};
$draw(strtoupper($argv[1]),1030,6); $draw($argv[2],1260,3);
ob_start(); imagepng($im); echo base64_encode(ob_get_clean());`;
  return Buffer.from(execFileSync("php", ["-r", php, title, line2, colours[0], colours[1]], { encoding: "utf8" }), "base64");
}
const pw = () => "Tst-" + crypto.randomBytes(12).toString("base64url");
// The free event starts tonight, inside the gate's admission window (12 h before the start).
const hoursFromNow = (h) => { const t = new Date(Date.now() + h * 3600000); t.setUTCMinutes(0, 0, 0); return t.toISOString(); };
const inDays = (d, h = 19) => { const t = new Date(Date.now() + d * 86400000); t.setUTCHours(h - 2, 0, 0, 0); return t.toISOString(); };

async function signUpAndVerify(path, body) {
  const c = new Client(BASE, DATA);
  await c.call("POST", path, body, 201);
  const link = outbox(DATA, body.email, /#\/verify\/([A-Za-z0-9._~%-]+)/);
  await c.call("POST", "/api/auth/verify-email", { token: decodeURIComponent(link[1]) });
  await c.refreshCsrf();
  return c;
}

(async () => {
  const stamp = Date.now().toString(36);
  const admin = new Client(BASE, DATA);
  await admin.staffLogin(ADMIN_EMAIL, ADMIN_PW);
  await admin.call("POST", "/api/admin/integrations/payments/sandbox", { currentPassword: ADMIN_PW, kind: "ticketroom" });

  const org = { name: "Test Organiser", email: `organiser+${stamp}@example.test`, password: pw(), organisation: "Harbour Lights Productions" };
  const orgC = await signUpAndVerify("/api/organiser/signup", { fullName: org.name, email: org.email, password: org.password, organisation: org.organisation, acceptTerms: true });
  const cust = { name: "Test Customer", email: `customer+${stamp}@example.test`, password: pw() };
  await signUpAndVerify("/api/auth/register", { fullName: cust.name, email: cust.email, password: cust.password, marketingOptIn: false, acceptTerms: true });

  const orgs = await orgC.call("GET", "/api/organiser/orgs");
  const orgId = (orgs.organisers || orgs.orgs || orgs)[0].id;
  await admin.call("POST", `/api/admin/organisers/${orgId}/status`, { status: "approved" });

  // FICA: About you, terms, ID document; staff approve the document.
  await orgC.call("PUT", `/api/organiser/${orgId}/verification/profile`, { entityType: "individual", nationality: "sa", legalName: org.name, idNumber: saId(), plansPaid: true });
  await orgC.call("POST", `/api/organiser/${orgId}/verification/terms`, { fullName: org.name, accept: true });
  const doc = await orgC.call("POST", `/api/organiser/${orgId}/verification/documents?requirement=id_document`, PNG, 201, { "content-type": "image/png", "x-file-name": "id.png" });
  if (doc.document.status !== "approved") await admin.call("POST", `/api/admin/verification/documents/${doc.document.id}/decide`, { approve: true });

  const upload = async (png) => (await orgC.call("POST", `/api/organiser/${orgId}/uploads`, png, 201, { "content-type": "image/png" })).uploadId;
  const common = { category: "music", venueName: "The Old Biscuit Hall", address: "375 Albert Road, Woodstock", city: "Cape Town", province: "Western Cape",
    startsAt: inDays(14), endsAt: inDays(14, 23),
    description: "An evening of live sets from local bands. Food trucks and a cash-free bar on site. (Local test data from the dev seed.)" };
  const free = (await orgC.call("POST", `/api/organiser/${orgId}/events`, { ...common, title: "Sunset Sessions in the Courtyard", summary: "Free live music in the courtyard, tonight", imageUploadId: await upload(poster("Sunset Sessions", "Free live music in the courtyard", ["#1d3557", "#e76f51"])), isFree: true, capacity: 200, startsAt: hoursFromNow(3), endsAt: hoursFromNow(7) }, 201)).event;
  const paid = (await orgC.call("POST", `/api/organiser/${orgId}/events`, { ...common, title: "Harbour Lights Live: Summer Opening", summary: "Three local bands, one long summer night", imageUploadId: await upload(poster("Harbour Lights Live", "Summer Opening - The Old Biscuit Hall", ["#0b1a33", "#2a9d8f"])), isFree: false, capacity: 300, startsAt: inDays(21), endsAt: inDays(21, 23) }, 201)).event;
  await orgC.call("POST", `/api/organiser/${orgId}/events/${paid.id}/ticket-types`, { name: "General admission", priceCents: 15000, quantityTotal: 250, perOrderLimit: 6 }, 201);
  for (const ev of [free, paid]) {
    await orgC.call("POST", `/api/organiser/${orgId}/events/${ev.id}/submit`, {});
    await admin.call("POST", `/api/admin/events/${ev.id}/status`, { action: "publish" });
  }

  const out = {
    base: BASE,
    admin: { email: ADMIN_EMAIL, password: "(TR_TEST_ADMIN_PASSWORD)" },
    organiser: { ...org, orgId },
    customer: cust,
    events: { free: { id: free.id, slug: free.slug, title: free.title }, paid: { id: paid.id, slug: paid.slug, title: paid.title } },
  };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
})().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
