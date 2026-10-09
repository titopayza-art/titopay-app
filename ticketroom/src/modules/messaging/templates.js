// Plain-text message templates. Every message names the operator.
const config = require("../../config");
const { formatZar } = require("../../lib/money");

const FOOTER = `\n\n—\nTicketRoom · ticketroom.co.za\nPowered by TitoPay`;
const when = (d) => new Date(d).toLocaleString("en-ZA", { dateStyle: "full", timeStyle: "short", timeZone: "Africa/Johannesburg" });

module.exports = {
  orderConfirmed: ({ order, event, ticketCount }) => ({
    subject: `Your tickets for ${event.title} (${order.reference})`,
    body: `Hi ${order.buyer_name},\n\nPayment received — your ${ticketCount} ticket${ticketCount === 1 ? "" : "s"} for ${event.title} ${ticketCount === 1 ? "is" : "are"} ready.\n\n${event.venue_name}, ${event.city}\n${when(event.starts_at)}\nOrder ${order.reference} · ${formatZar(order.total_cents)}\n\nOpen your tickets: ${config.publicBaseUrl}/account#/tickets\n\nYour QR code is your entry. Do not share screenshots of it: the first scan wins.${FOOTER}`,
  }),
  orderNeedsRefund: ({ order, event }) => ({
    subject: `About your order ${order.reference}`,
    body: `Hi ${order.buyer_name},\n\nYour payment for ${event.title} arrived after your ticket reservation expired and the tickets had sold out. We have started a full refund of ${formatZar(order.total_cents)}; you do not need to do anything.${FOOTER}`,
  }),
  transferOffer: ({ fromName, event, claimUrl }) => ({
    subject: `${fromName} sent you a ticket for ${event.title}`,
    body: `${fromName} has transferred a ticket for ${event.title} (${when(event.starts_at)}) to you.\n\nAccept it here (link valid for 7 days): ${claimUrl}\n\nYou will need a free TicketRoom account.${FOOTER}`,
  }),
  transferDone: ({ event, toEmail }) => ({
    subject: `Your ticket for ${event.title} was transferred`,
    body: `Your ticket for ${event.title} was accepted by ${toEmail}. The QR code on your copy no longer works.${FOOTER}`,
  }),
  verifyEmail: ({ name, url }) => ({
    subject: "Confirm your TicketRoom email address",
    body: `Hi ${name},\n\nConfirm your email address: ${url}\n\nIf you did not create a TicketRoom account, ignore this message.${FOOTER}`,
  }),
  passwordReset: ({ name, url }) => ({
    subject: "Reset your TicketRoom password",
    body: `Hi ${name},\n\nReset your password (link valid for 1 hour): ${url}\n\nIf you did not ask for this, ignore this message — your password has not changed.${FOOTER}`,
  }),
  topupConfirmed: ({ event, amount }) => ({
    subject: `Top-up confirmed for ${event.title}`,
    body: `Your cashless balance for ${event.title} was topped up with ${formatZar(amount)}.\n\nView balance: ${config.publicBaseUrl}/account#/wallet${FOOTER}`,
  }),
  refundCompleted: ({ reference, amount }) => ({
    subject: `Refund ${reference} processed`,
    body: `Your refund of ${formatZar(amount)} (${reference}) has been processed. Depending on your bank it can take 3–7 working days to reflect.${FOOTER}`,
  }),
  footer: FOOTER,
};
