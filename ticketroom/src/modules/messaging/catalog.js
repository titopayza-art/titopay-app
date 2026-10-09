// Every email TicketRoom sends, with sample data for previews in the back office.
const config = require("../../config");
const templates = require("./templates");

const inDays = (d, h = 19) => { const x = new Date(Date.now() + d * 864e5); x.setUTCHours(h - 2, 0, 0, 0); return x.toISOString(); };
const event = () => ({ id: "00000000-0000-0000-0000-000000000000", title: "Soweto Sunset Sessions", slug: "soweto-sunset-sessions", starts_at: inDays(1), venue_name: "Orlando Amphitheatre", address: "Mooki St, Orlando East", city: "Soweto", age_restriction: "18+", transfers_enabled: true, cashless_enabled: false });
const B = () => config.publicBaseUrl;

const CATALOG = [
  { key: "orderConfirmedFree", name: "Free tickets confirmed", audience: "Attendee", trigger: "Right after someone gets free tickets",
    sample: () => templates.orderConfirmed({ order: { buyer_name: "Lerato Mokoena", reference: "TR-7KQ2M9", total_cents: 0 }, event: event(), ticketCount: 2 }) },
  { key: "orderConfirmed", name: "Paid tickets confirmed", audience: "Attendee", trigger: "When the payment provider confirms payment",
    sample: () => templates.orderConfirmed({ order: { buyer_name: "Lerato Mokoena", reference: "TR-7KQ2M9", total_cents: 32000 }, event: event(), ticketCount: 2 }) },
  { key: "eventReminderDay", name: "Event reminder — day before", audience: "Attendee", trigger: "Automatic, about 24 hours before the event starts", setting: "reminderDayBefore",
    sample: () => templates.eventReminder({ name: "Lerato Mokoena", event: event(), ticketCount: 2, soon: false }) },
  { key: "eventReminderSoon", name: "Event reminder — starting soon", audience: "Attendee", trigger: "Automatic, within 3 hours of the start", setting: "reminderSoon",
    sample: () => templates.eventReminder({ name: "Lerato Mokoena", event: { ...event(), starts_at: inDays(0, 19) }, ticketCount: 2, soon: true }) },
  { key: "checkoutAbandoned", name: "Abandoned checkout", audience: "Attendee", trigger: "Automatic, once, after an unfinished booking (delay set below)", setting: "abandonedCheckout",
    sample: () => templates.checkoutAbandoned({ name: "Lerato Mokoena", event: event(), eventUrl: `${B()}/events/soweto-sunset-sessions`, unsubscribeUrl: `${B()}/unsubscribe?t=sample` }) },
  { key: "eventCancelled", name: "Event cancelled", audience: "Attendee", trigger: "When an event is cancelled",
    sample: () => templates.eventCancelled({ name: "Lerato Mokoena", event: event(), reason: "Severe weather warning for the venue", paid: false }) },
  { key: "transferOffer", name: "Ticket transfer received", audience: "Attendee", trigger: "When someone sends a ticket",
    sample: () => templates.transferOffer({ fromName: "Thabo Nkosi", event: event(), claimUrl: `${B()}/account#/claim/sample` }) },
  { key: "transferDone", name: "Ticket transfer accepted", audience: "Attendee", trigger: "When the friend accepts",
    sample: () => templates.transferDone({ event: event(), toEmail: "friend@example.co.za" }) },
  { key: "verifyEmail", name: "Welcome / confirm email", audience: "Everyone", trigger: "On sign-up",
    sample: () => templates.verifyEmail({ name: "Lerato Mokoena", url: `${B()}/account#/verify/sample` }) },
  { key: "passwordReset", name: "Password reset", audience: "Everyone", trigger: "On \"Forgot password\"",
    sample: () => templates.passwordReset({ name: "Lerato Mokoena", url: `${B()}/account#/reset/sample` }) },
  { key: "callbackReceived", name: "Callback request received", audience: "Everyone", trigger: "When the callback form is sent",
    sample: () => templates.callbackReceived({ name: "Lerato Mokoena", reference: "CB-4H8D2K", responseTime: "24–48 hours", email: "hello@ticketroom.co.za", hoursNote: "Monday to Friday, 9am to 5pm. Closed on weekends and public holidays." }) },
  { key: "unsubscribeLink", name: "Unsubscribe link", audience: "Everyone", trigger: "From the Unsubscribe page",
    sample: () => templates.unsubscribeLink({ name: "Lerato Mokoena", url: `${B()}/unsubscribe?t=sample` }) },
  { key: "organiserApproved", name: "Organiser approved", audience: "Organiser", trigger: "When admin approves an organiser",
    sample: () => templates.organiserApproved({ name: "Naledi Dlamini", organiser: "Soweto Community Arts" }) },
  { key: "organiserRejected", name: "Organiser not approved", audience: "Organiser", trigger: "When admin rejects an organiser",
    sample: () => templates.organiserRejected({ name: "Naledi Dlamini", organiser: "Soweto Community Arts", reason: "We couldn't verify the contact details." }) },
  { key: "eventPublished", name: "Event published", audience: "Organiser", trigger: "When admin approves an event",
    sample: () => templates.eventPublished({ name: "Naledi Dlamini", event: event(), eventUrl: `${B()}/events/soweto-sunset-sessions` }) },
  { key: "eventChangesRequested", name: "Event needs changes", audience: "Organiser", trigger: "When admin sends an event back",
    sample: () => templates.eventChangesRequested({ name: "Naledi Dlamini", event: event(), reason: "Please add the full venue address and a poster image." }) },
  { key: "staffInvite", name: "Scanner staff invite", audience: "Staff", trigger: "When an organiser adds a new scanner",
    sample: () => templates.staffInvite({ name: "Sipho", organiser: "Soweto Community Arts", event: "Soweto Sunset Sessions", url: `${B()}/account#/reset/sample` }) },
  { key: "refundCompleted", name: "Refund processed", audience: "Attendee", trigger: "When a refund is paid (paid events)",
    sample: () => templates.refundCompleted({ reference: "RF-2M8Q1X", amount: 16000 }) },
  { key: "topupConfirmed", name: "Cashless top-up", audience: "Attendee", trigger: "After a wristband top-up (cashless events)",
    sample: () => templates.topupConfirmed({ event: event(), amount: 20000 }) },
];

module.exports = { CATALOG, find: (key) => CATALOG.find((x) => x.key === key) };
