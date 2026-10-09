// Message templates. Bodies are plain text; the email adapter also renders a
// branded HTML version (see html.js): a line "Label: https://…" becomes a
// button, "- " lines become bullets, and everything after the "-- " line is
// the footer.
const config = require("../../config");
const { formatZar } = require("../../lib/money");

const FOOTER = `\n\n-- \nTicketRoom · ticketroom.co.za · hello@ticketroom.co.za\nTicketRoom (Pty) Ltd · Reg. no. 2026811077`;
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
    const isAre = ticketCount === 1 ? "is" : "are";
    return {
      subject: free ? `Your free ${ticketCount === 1 ? "ticket" : "tickets"} for ${event.title}` : `Your tickets for ${event.title} (${order.reference})`,
      body: `Hi ${first(order.buyer_name)},\n\n${free ? `You're booked for ${event.title}. Your ${plural(ticketCount, "free ticket")} ${isAre} waiting in your TicketRoom account.` : `Thanks for your order. Your ${plural(ticketCount, "ticket")} for ${event.title} ${isAre} ready.`}\n\n${place(event)}\n${when(event.starts_at)}\nOrder ${order.reference}${free ? "" : ` · ${formatZar(order.total_cents)}`}\n\nOpen my tickets: ${base()}/account#/tickets\n\nYour QR code is your way in, so please don't share it. If someone else scans it first, you won't get in.${free ? "\n\nIf you can't make it after all, you can pass your ticket to a friend from My tickets." : ""}${FOOTER}`,
    };
  },
  eventReminder: ({ name, event, ticketCount, soon }) => {
    const tips = [
      "- Open your tickets before you leave home. They'll still work if the signal at the venue is bad.",
      "- Turn your screen brightness up so the QR code scans first time.",
      "- Each ticket lets one person in, once.",
    ];
    if (event.age_restriction) tips.push(`- This event is ${event.age_restriction}, so bring ID.`);
    if (event.transfers_enabled) tips.push("- Can't go? Send your ticket to a friend before the event starts.");
    if (event.cashless_enabled) tips.push("- It's a cashless event, so top up your wristband in your account before you arrive.");
    return {
      subject: soon ? `${event.title} starts at ${time(event.starts_at)}` : `${event.title} is tomorrow`,
      body: `Hi ${first(name)},\n\n${soon ? `${event.title} starts at ${time(event.starts_at)} today.` : `${event.title} is tomorrow.`} You have ${plural(ticketCount, "ticket")}.\n\n${when(event.starts_at)}\n${place(event)}\n\nOpen my tickets: ${base()}/account#/tickets\n\nA few things that help at the gate:\n${tips.join("\n")}\n\nEnjoy it!${FOOTER}`,
    };
  },
  checkoutAbandoned: ({ name, event, eventUrl, unsubscribeUrl }) => ({
    subject: `Still want to go to ${event.title}?`,
    body: `Hi ${first(name)},\n\nYou started booking tickets for ${event.title} but didn't finish, so we couldn't hold them for you. There are still tickets available.\n\n${when(event.starts_at)}\n${place(event)}\n\nFinish my booking: ${eventUrl}\n\nIf something went wrong at checkout, ask us to call you back at ${base()}/contact and we'll sort it out.\n\nThis is the only reminder we'll send about it. To stop emails like this, unsubscribe here: ${unsubscribeUrl}${FOOTER}`,
  }),
  eventCancelled: ({ name, event, reason, paid }) => ({
    subject: `${event.title} has been cancelled`,
    body: `Hi ${first(name)},\n\nWe're sorry to tell you that the organiser has cancelled ${event.title}, which was set for ${when(event.starts_at)}.${reason ? `\n\nThe reason they gave: ${reason}` : ""}\n\n${paid ? "You don't need to do anything. We've started a full refund, booking fee included, to the card or account you paid with. It usually shows within 3 to 7 working days." : "Your free tickets have been cancelled, so there's nothing you need to do."}\n\nSee what else is on: ${base()}/${FOOTER}`,
  }),
  orderNeedsRefund: ({ order, event }) => ({
    subject: `About your order ${order.reference}`,
    body: `Hi ${first(order.buyer_name)},\n\nYour payment for ${event.title} reached us after your booking time ran out, and by then the tickets had sold out. We've started a full refund of ${formatZar(order.total_cents)}. You don't need to do anything.${FOOTER}`,
  }),
  transferOffer: ({ fromName, event, claimUrl }) => ({
    subject: `${fromName} sent you a ticket for ${event.title}`,
    body: `${fromName} has sent you a ticket for ${event.title} on ${when(event.starts_at)}.\n\nAccept the ticket: ${claimUrl}\n\nThe link works for 7 days. You'll need a TicketRoom account to accept it, and signing up is free.${FOOTER}`,
  }),
  transferDone: ({ event, toEmail }) => ({
    subject: `Your ticket for ${event.title} has been accepted`,
    body: `${toEmail} has accepted the ticket you sent for ${event.title}. The QR code on your copy no longer works.${FOOTER}`,
  }),
  verifyEmail: ({ name, url }) => ({
    subject: "Please confirm your email address",
    body: `Hi ${first(name)},\n\nThanks for signing up to TicketRoom. Please confirm your email address so your tickets and updates reach you.\n\nConfirm my email: ${url}\n\nIf you didn't create a TicketRoom account, you can ignore this email.${FOOTER}`,
  }),
  passwordReset: ({ name, url }) => ({
    subject: "Reset your TicketRoom password",
    body: `Hi ${first(name)},\n\nSomeone, hopefully you, asked to reset the password on your TicketRoom account. This link works for one hour.\n\nChoose a new password: ${url}\n\nIf it wasn't you, ignore this email and your password will stay the same.${FOOTER}`,
  }),
  topupConfirmed: ({ event, amount }) => ({
    subject: `Top-up confirmed for ${event.title}`,
    body: `We've added ${formatZar(amount)} to your cashless balance for ${event.title}.\n\nSee my balance: ${base()}/account#/wallet${FOOTER}`,
  }),
  refundCompleted: ({ reference, amount }) => ({
    subject: `Refund ${reference} processed`,
    body: `Your refund of ${formatZar(amount)} (${reference}) has been processed. Depending on your bank, it can take 3 to 7 working days to show.${FOOTER}`,
  }),
  callbackReceived: ({ name, reference, responseTime, email, hoursNote }) => ({
    subject: `We've got your callback request (${reference})`,
    body: `Hi ${first(name)},\n\nThanks for getting in touch. Your reference is ${reference}, and someone from our team will get back to you within ${responseTime}.\n\nOur office hours: ${hoursNote}\n\nIf there's anything to add, reply to this email or write to ${email} and mention ${reference}.${FOOTER}`,
  }),
  unsubscribeLink: ({ name, url }) => ({
    subject: "Unsubscribe from TicketRoom marketing",
    body: `Hi ${first(name)},\n\nYou asked to stop getting marketing emails from TicketRoom and the organisers you follow. Please confirm below. The link works for 7 days.\n\nConfirm unsubscribe: ${url}\n\nWe'll still email you about tickets you already have. If you didn't ask for this, you can ignore this email.${FOOTER}`,
  }),
  newsletterConfirm: ({ url }) => ({
    subject: "Confirm your TicketRoom updates",
    body: `Hi there,\n\nThanks for signing up for TicketRoom updates: new events, ticket releases and the odd bit of news. Please confirm it's you. The link works for 7 days.\n\nConfirm my subscription: ${url}\n\nIf you didn't sign up, ignore this email and you won't hear from us.${FOOTER}`,
  }),
  newsletterUpdate: ({ subject, message, unsubscribeUrl }) => ({
    subject,
    body: `${String(message).trimEnd()}\n\n-- \nYou're getting this because you subscribed to TicketRoom updates on ticketroom.co.za. To stop them, unsubscribe here: ${unsubscribeUrl}\nTicketRoom (Pty) Ltd · Reg. no. 2026811077`,
  }),

  // ---------------------------------------------------------------- organisers and staff
  organiserApproved: ({ name, organiser }) => ({
    subject: `${organiser} is approved on TicketRoom`,
    body: `Hi ${first(name)},\n\n${organiser} has been approved. You can now send your events to us for review, and email people who asked to hear from you.\n\nGo to the organiser portal: ${base()}/organisers\n\nFor now, free events are listed at no cost. Paid ticket sales are coming soon.\n\nIf you'd like a hand setting up your first event, ask us to call you at ${base()}/contact.${FOOTER}`,
  }),
  organiserRejected: ({ name, organiser, reason }) => ({
    subject: "About your TicketRoom organiser application",
    body: `Hi ${first(name)},\n\nThanks for applying to list events on TicketRoom as ${organiser}. We can't approve the application at this stage.${reason ? `\n\nReason: ${reason}` : ""}\n\nIf you can send us more information, reply to this email or ask us to call you at ${base()}/contact.${FOOTER}`,
  }),
  eventPublished: ({ name, event, eventUrl }) => ({
    subject: `Your event is live: ${event.title}`,
    body: `Hi ${first(name)},\n\n${event.title} has been approved and is now live on TicketRoom.\n\nSee the event page: ${eventUrl}\n\nA few next steps:\n- Share the link on your socials and in your WhatsApp groups.\n- Make a tracking link for each place you share it, so you can see what works.\n- Add your door staff under Staff so they can scan tickets on their phones.${FOOTER}`,
  }),
  eventChangesRequested: ({ name, event, reason }) => ({
    subject: `Changes needed before ${event.title} can go live`,
    body: `Hi ${first(name)},\n\nWe've looked at ${event.title} and need a few changes before we can publish it.\n\n${reason ? `What to change: ${reason}\n\n` : ""}Edit my event: ${base()}/organisers#/events/${event.id}\n\nOnce you've made the changes, send it to us again and we'll take another look.${FOOTER}`,
  }),
  staffInvite: ({ name, organiser, event, url }) => ({
    subject: `${organiser} added you as a ticket scanner on TicketRoom`,
    body: `Hi ${first(name)},\n\n${organiser} has added you as a ticket scanner for ${event}. Set a password to get started. The link works for 7 days.\n\nSet my password: ${url}\n\nOn the day, open ticketroom.co.za/scan on your phone, sign in, and point the camera at each ticket.${FOOTER}`,
  }),
  footer: FOOTER,
};
