// Admin-controlled site settings. Stored as JSON per key, merged over safe
// defaults, cached for a few seconds and invalidated on every change.
const db = require("../../lib/db");
const audit = require("../../lib/audit");
const { r, check } = require("../../lib/validate");
const { bad } = require("../../lib/errors");

const TZ = "Africa/Johannesburg";
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const nineToFive = { open: "09:00", close: "17:00" };

// South African public holidays (Public Holidays Act; Sunday holidays move to
// Monday). Admins can edit this list in Site settings.
const SA_HOLIDAYS = [
  ["2026-01-01", "New Year's Day"], ["2026-03-21", "Human Rights Day"], ["2026-04-03", "Good Friday"], ["2026-04-06", "Family Day"],
  ["2026-04-27", "Freedom Day"], ["2026-05-01", "Workers' Day"], ["2026-06-16", "Youth Day"], ["2026-08-10", "National Women's Day (observed)"],
  ["2026-09-24", "Heritage Day"], ["2026-12-16", "Day of Reconciliation"], ["2026-12-25", "Christmas Day"], ["2026-12-26", "Day of Goodwill"],
  ["2027-01-01", "New Year's Day"], ["2027-03-22", "Human Rights Day (observed)"], ["2027-03-26", "Good Friday"], ["2027-03-29", "Family Day"],
  ["2027-04-27", "Freedom Day"], ["2027-05-01", "Workers' Day"], ["2027-06-16", "Youth Day"], ["2027-08-09", "National Women's Day"],
  ["2027-09-24", "Heritage Day"], ["2027-12-16", "Day of Reconciliation"], ["2027-12-25", "Christmas Day"], ["2027-12-27", "Day of Goodwill (observed)"],
].map(([date, name]) => ({ date, name }));

const DEFAULTS = {
  maintenance: { enabled: false, message: "TicketRoom is being updated. We'll be back shortly — thank you for your patience." },
  banner: { enabled: true, text: "We're currently open for listing FREE events. Paid tickets are coming soon.", linkText: "List your free event", linkUrl: "/sell" },
  hours: {
    week: { mon: nineToFive, tue: nineToFive, wed: nineToFive, thu: nineToFive, fri: nineToFive, sat: null, sun: null },
    holidays: SA_HOLIDAYS,
    note: "Monday to Friday, 9am to 5pm. Closed on weekends and public holidays.",
  },
  support: { email: "hello@ticketroom.co.za", phone: "", responseTime: "24–48 hours" },
  legal: { entityName: "TicketRoom", registrationNumber: "", vatNumber: "", physicalAddress: "", postalAddress: "", informationOfficer: "", website: "ticketroom.co.za" },
  chatbot: { enabled: true, aiEnabled: true, greeting: "Hi! I'm the TicketRoom assistant. Ask me about tickets, events, refunds, wristbands or selling tickets." },
};

const time = r.str({ pattern: /^([01]\d|2[0-3]):[0-5]\d$/, message: "Use HH:MM (24-hour)." });
const dayRule = (v) => (v === null || v === undefined || v === "" ? null : check(v, { open: time, close: time }));
const SCHEMAS = {
  maintenance: (v) => check(v, { enabled: r.bool(), message: r.text({ max: 500 }) }),
  banner: (v) => check(v, { enabled: r.bool(), text: r.str({ max: 200 }), linkText: r.str({ optional: true, max: 40 }), linkUrl: r.str({ optional: true, max: 200, pattern: /^(\/|https:\/\/)/, message: "Start with / or https://" }) }),
  hours: (v) => {
    const week = {};
    for (const d of DAYS) {
      const day = dayRule(v?.week?.[d]);
      if (day && day.open >= day.close) throw bad(`${d}: closing time must be after opening time.`);
      week[d] = day;
    }
    const holidays = check(v, { holidays: r.array(r.object({ date: r.str({ pattern: /^\d{4}-\d{2}-\d{2}$/, message: "YYYY-MM-DD" }), name: r.str({ max: 80 }) }), { max: 200, optional: true, fallback: [] }) }).holidays;
    return { week, holidays: holidays || [], note: check(v, { note: r.str({ optional: true, max: 200 }) }).note || "" };
  },
  support: (v) => check(v, { email: r.email(), phone: r.str({ optional: true, max: 30 }), responseTime: r.str({ max: 40 }) }),
  legal: (v) => check(v, {
    entityName: r.str({ max: 160 }), registrationNumber: r.str({ optional: true, max: 40 }), vatNumber: r.str({ optional: true, max: 40 }),
    physicalAddress: r.str({ optional: true, max: 300 }), postalAddress: r.str({ optional: true, max: 300 }), informationOfficer: r.str({ optional: true, max: 120 }), website: r.str({ max: 120 }),
  }),
  chatbot: (v) => check(v, { enabled: r.bool(), aiEnabled: r.bool(), greeting: r.str({ max: 300 }) }),
};

let cache = { at: 0, values: null };
const TTL_MS = 5000;

async function all() {
  if (cache.values && Date.now() - cache.at < TTL_MS) return cache.values;
  const { rows } = await db.query("SELECT key, value FROM site_settings");
  const stored = Object.fromEntries(rows.map((x) => [x.key, x.value]));
  const values = {};
  for (const [k, def] of Object.entries(DEFAULTS)) values[k] = { ...def, ...(stored[k] || {}) };
  cache = { at: Date.now(), values };
  return values;
}
const get = async (key) => (await all())[key];

async function set(actor, key, value) {
  if (!SCHEMAS[key]) throw bad("Unknown setting.");
  const clean = SCHEMAS[key](value);
  await db.query(
    `INSERT INTO site_settings (key, value, updated_by, updated_at) VALUES ($1,$2,$3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [key, clean, actor.id]);
  await audit.record(null, { actor, action: `settings.${key}_updated`, entityType: "site_setting", entityId: key, details: key === "maintenance" || key === "banner" ? { enabled: clean.enabled } : {} });
  cache = { at: 0, values: null };
  return (await all())[key];
}

// Local (Johannesburg) calendar parts for a moment in time.
function localParts(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === "24" ? "00" : p.hour}:${p.minute}`, day: p.weekday.slice(0, 3).toLowerCase() };
}

function hoursStatus(hours, now = new Date()) {
  const holidayOn = (date) => hours.holidays.find((h) => h.date === date);
  const today = localParts(now);
  const window = hours.week[today.day];
  const holiday = holidayOn(today.date);
  const openNow = !holiday && !!window && today.time >= window.open && today.time < window.close;
  let nextOpen = null;
  for (let i = 0; i < 21 && !nextOpen; i++) {
    const d = localParts(new Date(now.getTime() + i * 864e5));
    const w = hours.week[d.day];
    if (!w || holidayOn(d.date)) continue;
    if (i === 0 && today.time >= w.open) continue;
    nextOpen = { date: d.date, day: d.day, time: w.open };
  }
  return { openNow, holiday: holiday?.name || null, today: today.date, nextOpen };
}

module.exports = { all, get, set, hoursStatus, DEFAULTS, SA_HOLIDAYS, DAYS };
