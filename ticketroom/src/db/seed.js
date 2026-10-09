// Development / demo seed. Refuses to run in production.
// Creates staff accounts, an approved organiser, published events with ticket
// types, vendors with products and a terminal, and a batch of QR tags.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("../config");
const db = require("../lib/db");
const { hashSecret, randomCode } = require("../lib/crypto");
const tagsSvc = require("../modules/tags/service");
const pos = require("../modules/pos/service");

if (config.isProd) { console.error("Refusing to seed a production database."); process.exit(1); }

const PASSWORD = process.env.SEED_PASSWORD || "TicketRoom!2026";
const day = 864e5;
const at = (days, hour = 18) => { const d = new Date(Date.now() + days * day); d.setUTCHours(hour - 2, 0, 0, 0); return d.toISOString(); };

async function user(email, name, phone, roles = []) {
  const { rows } = await db.query(
    `INSERT INTO users (email, full_name, phone, password_hash, email_verified_at) VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (lower(email)) DO UPDATE SET full_name = EXCLUDED.full_name RETURNING *`, [email, name, phone, hashSecret(PASSWORD)]);
  for (const role of roles) await db.query("INSERT INTO platform_roles (user_id, role) VALUES ($1,$2) ON CONFLICT DO NOTHING", [rows[0].id, role]);
  return rows[0];
}

async function image(orgId, ownerId, file) {
  const p = path.resolve(__dirname, "..", "..", "seed-assets", file);
  if (!fs.existsSync(p)) return null;
  const buf = fs.readFileSync(p);
  const { rows } = await db.query("INSERT INTO uploads (owner_id, organiser_id, mime_type, size_bytes, sha256) VALUES ($1,$2,'image/png',$3,$4) RETURNING id",
    [ownerId, orgId, buf.length, crypto.createHash("sha256").update(buf).digest("hex")]);
  fs.mkdirSync(config.uploadDir, { recursive: true });
  fs.writeFileSync(path.join(config.uploadDir, rows[0].id), buf);
  return rows[0].id;
}

async function main() {
  const { rows: existing } = await db.query("SELECT 1 FROM organisers WHERE slug = 'jozi-live-demo'");
  if (existing[0]) { console.log("Seed data already present."); return db.close(); }

  const admin = await user("admin@ticketroom.test", "Ayanda Admin", "+27820000001", ["admin"]);
  const finance = await user("finance@ticketroom.test", "Fatima Finance", "+27820000002", ["finance"]);
  await user("support@ticketroom.test", "Sipho Support", "+27820000003", ["support"]);
  const owner = await user("organiser@ticketroom.test", "Olwethu Organiser", "+27820000004");
  const staff = await user("staff@ticketroom.test", "Sam Scanner", "+27820000005");
  const cashier = await user("vendor@ticketroom.test", "Vusi Vendor", "+27820000006");
  const fan = await user("fan@ticketroom.test", "Thandi Fan", "+27820000007");

  const { rows: org } = await db.query(
    `INSERT INTO organisers (name, slug, contact_email, contact_phone, description, status, approved_at, approved_by, bank_name, bank_account_holder, bank_account_enc, bank_account_last4, bank_branch_code)
     VALUES ('Jozi Live Events','jozi-live-demo','hello@jozilive.test','+27110000000','Live music and festivals across Gauteng.','approved', now(), $1,
             'FNB','Jozi Live Events (Pty) Ltd', $2, '4321', '250655') RETURNING *`, [admin.id, require("../lib/crypto").encrypt("62000004321")]);
  const orgId = org[0].id;
  await db.query("INSERT INTO organiser_members (organiser_id, user_id, role) VALUES ($1,$2,'owner')", [orgId, owner.id]);

  const events = [
    { title: "Soweto Sunset Sessions", category: "music", venue: "Orlando Amphitheatre", city: "Johannesburg", province: "Gauteng", start: 12, hours: 6, cap: 800, featured: true, cashless: true, img: "sunset.png",
      summary: "Amapiano, deep house and a skyline sunset.", types: [["Early Bird", 15000, 200], ["General Admission", 22000, 500], ["VIP Deck", 55000, 100]] },
    { title: "Cape Town Comedy Night", category: "comedy", venue: "Baxter Theatre", city: "Cape Town", province: "Western Cape", start: 20, hours: 3, cap: 600, featured: true, img: "comedy.png",
      summary: "Five comics, one night, no mercy.", types: [["Standard", 18000, 450], ["Front Row", 32000, 150]] },
    { title: "Durban Food & Jazz Festival", category: "festival", venue: "Moses Mabhida Stadium Precinct", city: "Durban", province: "KwaZulu-Natal", start: 34, hours: 9, cap: 3000, featured: true, cashless: true, img: "jazz.png",
      summary: "Two stages, forty kitchens, all day.", types: [["Day Pass", 35000, 2500], ["Family (2 adults + 2 kids)", 95000, 300]] },
    { title: "Pretoria Tech Breakfast", category: "business", venue: "Innovation Hub", city: "Pretoria", province: "Gauteng", start: 8, hours: 3, cap: 150, img: "tech.png",
      summary: "Founders, funders and filter coffee.", types: [["Free Community Seat", 0, 100], ["Supporter", 25000, 50]] },
    { title: "Kids Science Saturday", category: "family", venue: "Sci-Bono Discovery Centre", city: "Johannesburg", province: "Gauteng", start: 5, hours: 5, cap: 300, img: "kids.png",
      summary: "Hands-on experiments for ages 6–12.", types: [["Child", 8000, 200], ["Adult", 6000, 100]] },
    { title: "Bloemfontein Rugby Fan Park", category: "sport", venue: "Loftus Fan Zone", city: "Bloemfontein", province: "Free State", start: 26, hours: 7, cap: 1200, img: "rugby.png",
      summary: "Big screens, braai and the full match day vibe.", types: [["Fan Park Entry", 12000, 1200]] },
  ];
  const created = [];
  for (const e of events) {
    const imageId = await image(orgId, owner.id, e.img);
    const { rows } = await db.query(
      `INSERT INTO events (organiser_id, slug, title, summary, description, category, venue_name, city, province, starts_at, ends_at, capacity, status, published_at, featured, cashless_enabled, image_upload_id, created_by, accessibility_info, refund_policy)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'published', now(), $13,$14,$15,$16,$17,$18) RETURNING *`,
      [orgId, `${e.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomCode(4).toLowerCase()}`, e.title, e.summary,
        `${e.summary}\n\nGates open one hour before the start. Bring your ticket on your phone — screenshots are not accepted once the original has been scanned.\n\nThis is demo data generated for TicketRoom development.`,
        e.category, e.venue, e.city, e.province, at(e.start), at(e.start, 18 + e.hours), e.cap, !!e.featured, !!e.cashless, imageId, owner.id,
        "Wheelchair-accessible entrance and viewing area. Accessible toilets on site. Contact the organiser for companion tickets.",
        "Tickets are non-refundable unless the event is cancelled or materially changed. Transfers are free until the event starts."]);
    let i = 0;
    for (const [name, price, qty] of e.types) {
      await db.query("INSERT INTO ticket_types (event_id, name, price_cents, quantity_total, sort_order, per_order_limit) VALUES ($1,$2,$3,$4,$5,$6)", [rows[0].id, name, price, qty, i++, price === 0 ? 2 : 10]);
    }
    created.push(rows[0]);
  }
  const main = created[0];
  await db.query("INSERT INTO event_staff (event_id, user_id, can_scan, can_manage_tags, added_by) VALUES ($1,$2,true,true,$3)", [main.id, staff.id, owner.id]);
  await db.query("INSERT INTO promo_codes (event_id, code, kind, value, max_uses) VALUES ($1,'SUNSET20','percent',20,100)", [main.id]);
  await db.query("INSERT INTO tracking_links (event_id, code, label) VALUES ($1,'IG-STORY','Instagram story'), ($1,'WHATSAPP','WhatsApp groups')", [main.id]);

  const { rows: v } = await db.query("INSERT INTO vendors (event_id, organiser_id, name, description, commission_bps) VALUES ($1,$2,'Kasi Grill','Braai, wors rolls, pap',500) RETURNING *", [main.id, orgId]);
  await db.query("INSERT INTO vendor_members (vendor_id, user_id, role) VALUES ($1,$2,'manager')", [v[0].id, cashier.id]);
  const products = [["Wors roll", 6500], ["Chicken & pap", 9500], ["Chakalaka side", 2500], ["Soft drink", 2500], ["Water 500ml", 1500], ["Ice cream", 3000]];
  let s = 0;
  for (const [name, price] of products) await db.query("INSERT INTO products (vendor_id, name, price_cents, sort_order) VALUES ($1,$2,$3,$4)", [v[0].id, name, price, s++]);
  const term = await pos.registerTerminal(cashier, v[0], "Stall 1 till");

  const batch = await tagsSvc.createBatch(admin, { tagType: "qr_tag", quantity: 10, eventId: main.id, mode: "generate", notes: "Demo QR tags" });
  const nfc = await tagsSvc.createBatch(admin, { tagType: "nfc_wristband", quantity: 5, eventId: main.id, mode: "generate", notes: "Demo NFC wristbands (NDEF token)" });

  const outDir = path.resolve(__dirname, "..", "..", "var");
  fs.mkdirSync(outDir, { recursive: true });
  const lines = [
    `TicketRoom demo seed — ${new Date().toISOString()}`,
    `All accounts use password: ${PASSWORD}`,
    "", "admin@ticketroom.test     platform admin", "finance@ticketroom.test   finance officer", "support@ticketroom.test   support",
    "organiser@ticketroom.test owner of Jozi Live Events", "staff@ticketroom.test     scanner + tag desk for Soweto Sunset Sessions",
    "vendor@ticketroom.test    Kasi Grill manager", "fan@ticketroom.test       attendee",
    "", `POS terminal key (Kasi Grill, Stall 1 till): ${term.terminalKey}`,
    "", "QR tags (payload | display code | activation code):", ...batch.tags.map((t) => `${t.payload} | ${t.displayCode} | ${t.activationCode}`),
    "", "NFC wristbands (NDEF payload | display code | activation code):", ...nfc.tags.map((t) => `${t.payload} | ${t.displayCode} | ${t.activationCode}`),
    "", `Promo code: SUNSET20 (20% off Soweto Sunset Sessions)`,
  ];
  fs.writeFileSync(path.join(outDir, "seed-credentials.txt"), lines.join("\n"));
  console.log(lines.slice(0, 12).join("\n"));
  console.log(`\nFull list (tags, terminal key): var/seed-credentials.txt`);
  void finance; void fan;
  await db.close();
}

main().catch(async (err) => { console.error(err); await db.close(); process.exit(1); });
