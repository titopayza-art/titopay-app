// Message templates. Bodies are plain text; the email adapter also renders a
// branded HTML version (see html.js): a line "Label: https://…" becomes a
// button, "- " lines become bullets, and everything after "—" is the footer.
const config = require("../../config");
const { formatZar } = require("../../lib/money");

const FOOTER = `\n\n—\nTicketRoom · ticketroom.co.za · hello@ticketroom.co.za`;
const when = (d) => new Date(d).toLocaleString("en-ZA", { dateStyle: "full", timeStyle: "short", timeZone: "Africa/Johannesburg" });
const time = (d) => new Date(d).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Africa/Johannesburg" });
const first = (name) => String(name || "there").trim().split(/\s+/)[0];
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const base = () => config.publicBaseUrl;
const place = (e) => [e.venue_name, e.address, e.city].filter(Boolean).join(", ");

module.exports = {
  // ---------------------------------------------------------------- attendees
  orderConfirmed: ({ order, event, ticketCount }) => {
    const free = Number(order.total_cents) === 0;
    return {
      subject: free ? `You're in! Your free ${ticketCount === 1 ? "ticket" : "tickets"} for ${event.title}` : `Your tickets for ${event.title} (${order.reference})`,
      body: `Hi ${first(order.buyer_name)},\n\n${free ? `You're in! Your ${plural(ticketCount, "free ticket")} for ${event.title} ${ticketCount === 1 ? "is" : "are"} ready.` : `Payment received — your ${plural(ticketCount, "ticket")} for ${event.title} ${ticketCount === 1 ? "is" : "are"} ready.`}\n\n${place(event)}\n${when(event.starts_at)}\nOrder ${order.reference}${free ? "" : ` · ${formatZar(order.total_cents)}`}\n\nOpen your tickets: ${base()}/account#/tickets\n\nYour QR code is your entry. Don't share screenshots of it: the first scan wins.${free ? "\n\nCan't make it any more? Transfer your ticket to a friend from My tickets so someone else can use your spot." : ""}${FOOTER}`,
    };
  },
  eventReminder: ({ name, event, ticketCount, soon }) => ({
    subject: soon ? `Starting soon: ${event.title} at ${time(event.starts_at)}` : `Tomorrow: ${event.title}`,
    body: `Hi ${first(name)},\n\n${soon ? `${event.title} starts at ${time(event.starts_at)} today.` : `Just a reminder: ${event.title} is tomorrow.`} You have ${plural(ticketCount, "ticket")}.\n\n${when(event.starts_at)}\n${place(event)}\n\nOpen your tickets: ${base()}/account#/tickets\n\nBefore you go:\n- Open your tickets now while you have signal — they then work offline.\n- Turn your screen brightness up at the gate so the QR code scans quickly.${event.age_restriction ? `\n- This event is ${event.age_restriction}. Bring ID.` : ""}\n- Each ticket admits one person once.${event.transfers_enabled ? `\n- Can't go? Transfer your ticket to a friend before the event starts.` : ""}${event.cashless_enabled ? `\n- This is a cashless event: top up your wristband balance in your account.` : ""}\n\nSee you there!${FOOTER}`,
  }),
  checkoutAbandoned: ({ name, event, eventUrl, unsubscribeUrl }) => ({
    subject: `Still want to go to ${event.title}?`,
    body: `Hi ${first(name)},\n\nYou started booking tickets for ${event.title} but didn't finish, so the tickets weren't kept for you.\n\n${when(event.starts_at)}\n${place(event)}\n\nFinish your booking: ${eventUrl}\n\nIf something went wrong at checkout, request a callback at ${base()}/contact and we'll help.\n\nWe only send this once. Don't want reminders like this? Unsubscribe: ${unsubscribeUrl}${FOOTER}`,
  }),
  eventCancelled: ({ name, event, reason, paid }) => ({
    subject: `Cancelled: ${event.title}`,
    body: `Hi ${first(name)},\n\nWe're sorry — ${event.title} on ${when(event.starts_at)} has been cancelled by the organiser.${reason ? `\n\nReason given: ${reason}` : ""}\n\n${paid ? "You don't need to do anything: a full refund, including the booking fee, has been started to your original payment method. Refunds usually reflect within 3–7 working days." : "Your free tickets have been cancelled. You don't need to do anything."}\n\nFind another event: ${base()}/${FOOTER}`,
  }),
  orderNeedsRefund: ({ order, event }) => ({
    subject: `About your order ${order.reference}`,
    body: `Hi ${first(order.buyer_name)},\n\nYour payment for ${event.title} arrived after your ticket reservation expired and the tickets had sold out. We have started a full refund of ${formatZar(order.total_cents)}; you do not need to do anything.${FOOTER}`,
  }),
  transferOffer: ({ fromName, event, claimUrl }) => ({
    subject: `${fromName} sent you a ticket for ${event.title}`,
    body: `${fromName} has transferred a ticket for ${event.title} (${when(event.starts_at)}) to you.\n\nAccept your ticket: ${claimUrl}\n\nThe link is valid for 7 days. You will need a free TicketRoom account.${FOOTER}`,
  }),
  transferDone: ({ event, toEmail }) => ({
    subject: `Your ticket for ${event.title} was transferred`,
    body: `Your ticket for ${event.title} was accepted by ${toEmail}. The QR code on your copy no longer works.${FOOTER}`,
  }),
  verifyEmail: ({ name, url }) => ({
    subject: "Welcome to TicketRoom — confirm your email",
    body: `Hi ${first(name)},\n\nWelcome to TicketRoom! Please confirm your email address so we can send you your tickets and updates.\n\nConfirm my email: ${url}\n\nWith your account you can keep all your tickets in one place, transfer them to friends, and find events across South Africa.\n\nIf you did not create a TicketRoom account, ignore this message.${FOOTER}`,
  }),
  passwordReset: ({ name, url }) => ({
    subject: "Reset your TicketRoom password",
    body: `Hi ${first(name)},\n\nWe received a request to reset your password. The link is valid for 1 hour.\n\nChoose a new password: ${url}\n\nIf you did not ask for this, ignore this message — your password has not changed.${FOOTER}`,
  }),
  topupConfirmed: ({ event, amount }) => ({
    subject: `Top-up confirmed for ${event.title}`,
    body: `Your cashless balance for ${event.title} was topped up with ${formatZar(amount)}.\n\nView my balance: ${base()}/account#/wallet${FOOTER}`,
  }),
  refundCompleted: ({ reference, amount }) => ({
    subject: `Refund ${reference} processed`,
    body: `Your refund of ${formatZar(amount)} (${reference}) has been processed. Depending on your bank it can take 3–7 working days to reflect.${FOOTER}`,
  }),
  callbackReceived: ({ name, reference, responseTime, email, hoursNote }) => ({
    subject: `We've received your callback request (${reference})`,
    body: `Hi ${first(name)},\n\nThanks for contacting TicketRoom. Your callback request ${reference} is with our team and we'll resolve it within ${responseTime}.\n\nOur hours: ${hoursNote}\n\nNeed to add something? Reply to this email or write to ${email} and quote ${reference}.${FOOTER}`,
  }),
  unsubscribeLink: ({ name, url }) => ({
    subject: "Unsubscribe from TicketRoom marketing",
    body: `Hi ${first(name)},\n\nYou asked to stop receiving marketing from TicketRoom and the organisers you follow. The link is valid for 7 days.\n\nConfirm unsubscribe: ${url}\n\nYou'll still get messages about tickets you have. If you didn't ask for this, ignore this email.${FOOTER}`,
  }),

  // ---------------------------------------------------------------- organisers and staff
  organiserApproved: ({ name, organiser }) => ({
    subject: `${organiser} is approved on TicketRoom`,
    body: `Hi ${first(name)},\n\nGood news — ${organiser} is approved. You can now submit events for publishing and email fans who opted in.\n\nGo to my organiser portal: ${base()}/organisers\n\nRight now TicketRoom is open for free events, with no fees at all. Paid tickets are coming soon.\n\nNeed help setting up? Request a callback at ${base()}/contact.${FOOTER}`,
  }),
  organiserRejected: ({ name, organiser, reason }) => ({
    subject: `About your TicketRoom organiser application`,
    body: `Hi ${first(name)},\n\nThank you for applying to sell tickets on TicketRoom as ${organiser}. We can't approve the application at this stage.${reason ? `\n\nReason: ${reason}` : ""}\n\nIf you can give us more information, reply to this email or request a callback at ${base()}/contact.${FOOTER}`,
  }),
  eventPublished: ({ name, event, eventUrl }) => ({
    subject: `Your event is live: ${event.title}`,
    body: `Hi ${first(name)},\n\n${event.title} has been approved and is now published on TicketRoom.\n\nView the event page: ${eventUrl}\n\nNext steps:\n- Share the link on your socials and WhatsApp groups.\n- Create tracking links to see which channel brings the most bookings.\n- Add your gate staff under Staff so they can scan tickets on their phones.${FOOTER}`,
  }),
  eventChangesRequested: ({ name, event, reason }) => ({
    subject: `Changes needed before ${event.title} can go live`,
    body: `Hi ${first(name)},\n\nWe reviewed ${event.title} and need a few changes before we can publish it.\n\n${reason ? `What to change: ${reason}\n\n` : ""}Edit my event: ${base()}/organisers#/events/${event.id}\n\nWhen you're done, submit it again and we'll review it as soon as possible.${FOOTER}`,
  }),
  staffInvite: ({ name, organiser, event, url }) => ({
    subject: `${organiser} added you as a ticket scanner on TicketRoom`,
    body: `Hi ${first(name)},\n\n${organiser} added you as staff for ${event}. The link is valid for 7 days.\n\nSet my password: ${url}\n\nOn the day, open ticketroom.co.za/scan on your phone and sign in to scan tickets.${FOOTER}`,
  }),
  footer: FOOTER,
};
