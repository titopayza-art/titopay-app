// TicketRoom legal documents. Company details come from Back office → Site
// settings → Legal details, so they can be completed without a code change.
// Markup: blank line = new paragraph, "- " = bullet, **bold**.

export const VERSION = "1.0";
export const EFFECTIVE = "9 October 2026";

const who = (L) => {
  const parts = [`**${L.entityName || "TicketRoom"}**`];
  if (L.registrationNumber) parts.push(`registration number ${L.registrationNumber}`);
  if (L.vatNumber) parts.push(`VAT number ${L.vatNumber}`);
  return parts.join(", ");
};

export function documents(L, S) {
  const email = S.email || "hello@ticketroom.co.za";
  const addr = L.physicalAddress || "available on request from " + email;
  const io = L.informationOfficer || "our Information Officer";

  return {
    // ------------------------------------------------------------------ TERMS OF USE
    "terms-of-use": {
      title: "Terms of Use",
      summary: "These rules apply to everyone who visits or uses ticketroom.co.za, whether or not you buy anything. Ticket purchases are also governed by our Terms and Conditions of Sale.",
      important: [
        "TicketRoom is a platform. Events are organised, run and controlled by independent organisers, not by TicketRoom (clause 3).",
        "You use the platform at your own risk and our liability is limited as far as the law allows (clause 10).",
        "You indemnify us against claims arising from your breach of these terms or misuse of the platform (clause 11).",
        "We may suspend or close accounts that break these terms (clause 8).",
      ],
      sections: [
        ["1. Who we are and agreement to these terms", `The website ticketroom.co.za, its sub-domains, apps, scanners, point-of-sale tools and related services (together, **the Platform**) are operated by ${who(L)} (**TicketRoom**, **we**, **us**).

By accessing or using the Platform you agree to these Terms of Use, our Privacy Policy and our Cookie Policy. If you do not agree, do not use the Platform. If you use the Platform on behalf of a business or organisation, you confirm you are authorised to bind it.`],
        ["2. Definitions", `- **Attendee**: a person who obtains or holds a ticket.
- **Organiser**: a person or entity that lists an event on the Platform and is responsible for it.
- **Event**: any event, performance, activity, venue entry or experience listed on the Platform.
- **Ticket**: a revocable licence to attend an Event, issued electronically with a unique QR code.
- **Account**: your registered TicketRoom profile.`],
        ["3. What TicketRoom does, and what it does not do", `TicketRoom provides technology that lets Organisers list Events, sell or distribute tickets, scan tickets at entry, run cashless payments and communicate with Attendees.

**TicketRoom does not organise, host, produce, supervise or control any Event**, and is not responsible for an Event's content, quality, safety, timing, line-up, venue, health and safety compliance, security, licensing, or for the conduct of Organisers, performers, venue staff or other Attendees. The Organiser is solely responsible for its Event and for complying with all laws that apply to it. TicketRoom acts as the Organiser's agent for the purpose of distributing tickets and collecting payments on its behalf.`],
        ["4. Eligibility and accounts", `You must be at least 18 years old to open an Account. A person under 18 may only use the Platform under the supervision of a parent or legal guardian who accepts these terms on their behalf.

You must give accurate information, keep your password and spending PIN secret, and tell us immediately at ${email} if you suspect unauthorised use. You are responsible for all activity on your Account unless it results from our negligence. One person may hold only one Account.`],
        ["5. Acceptable use", `You must not:
- break any law, or infringe anyone's rights;
- buy tickets with automated software (bots, scripts), bypass purchase limits, queues or security, or buy tickets for unauthorised resale;
- resell, advertise or transfer tickets for more than face value, or outside the Platform's transfer feature, unless the Organiser expressly allows it;
- copy, forge, alter or duplicate tickets, QR codes, wristbands, cards or tags;
- upload unlawful, misleading, defamatory, obscene, hateful or infringing content, or malicious code;
- probe, scan, overload, scrape or attempt to gain unauthorised access to the Platform or other users' data;
- impersonate any person, or misrepresent your connection with an Organiser or TicketRoom;
- use the Platform to send spam or unsolicited communications.`],
        ["6. Organisers", `Organisers must also accept our Terms and Conditions (Organiser section). Organisers must hold all rights, permits, licences and insurance needed for their Events, describe Events accurately, honour every valid ticket, and comply with the Consumer Protection Act, the Protection of Personal Information Act (POPIA) and all other applicable laws. We review Organisers and Events before publishing them but do not guarantee them.`],
        ["7. Content and intellectual property", `The Platform, its software, design, logos and content (excluding Organiser content) belong to TicketRoom or its licensors and are protected by law. You receive a limited, personal, non-transferable right to use the Platform for its intended purpose.

Organisers keep ownership of their content but grant TicketRoom a non-exclusive, royalty-free licence to host, display, reproduce and promote it on and in connection with the Platform. You confirm you have the rights to anything you upload.`],
        ["8. Suspension and termination", `We may suspend, restrict or close an Account, cancel or void tickets obtained in breach of these terms, remove content, or refuse service where we reasonably believe there is fraud, a breach of these terms, a security risk or a legal requirement. Where reasonable we will tell you why. You may close your Account at any time in Settings & privacy.`],
        ["9. Availability and changes", `We aim to keep the Platform available but do not guarantee uninterrupted or error-free service. We may maintain, change or withdraw features. Our support team works Monday to Friday, 9am to 5pm, excluding weekends and South African public holidays.`],
        ["10. Limitation of liability", `**To the fullest extent permitted by law, including the Consumer Protection Act 68 of 2008:**
- the Platform is provided "as is" and "as available";
- TicketRoom is not liable for any loss or damage arising from an Event, or from the acts or omissions of an Organiser, venue, performer, vendor or other Attendee;
- TicketRoom is not liable for indirect, special or consequential loss, loss of profit, loss of data, or loss caused by events beyond our reasonable control (including load-shedding, network or provider failures, strikes, unrest, pandemics, natural disasters or acts of government);
- our total liability to you for any claim relating to the Platform is limited to the booking fees you paid to TicketRoom in the 12 months before the claim arose.

Nothing in these terms limits liability that cannot be limited by law, including for gross negligence, intentional misconduct, or your rights under the Consumer Protection Act.`],
        ["11. Indemnity", `You indemnify and hold harmless TicketRoom, its directors, employees, agents and technology and payment partners against all claims, losses, damages, penalties and costs (including reasonable legal fees) arising from your breach of these terms, your misuse of the Platform, your content or, if you are an Organiser, your Event.`],
        ["12. Notices and electronic communication", `You agree to receive communications electronically. Notices to us must be sent to ${email}. Our physical address for legal notices is ${addr}. A notice sent by email is received when it enters the recipient's mailbox.`],
        ["13. Changes to these terms", `We may update these terms. The version and date at the top show when they last changed. For material changes we will give notice on the Platform or by email. Continuing to use the Platform after the effective date means you accept the update.`],
        ["14. General", `These terms are governed by the laws of the Republic of South Africa. You consent to the jurisdiction of the Magistrates' Court having jurisdiction, without prejudice to our right to approach the High Court. If any clause is invalid, the rest remain in force. Our failure to enforce a right is not a waiver. These terms, together with the documents they refer to, are the entire agreement on their subject.`],
        ["15. Information required by the ECTA (section 43)", `- Operator: ${who(L)}
- Website: ${L.website || "ticketroom.co.za"}
- Email: ${email}${S.phone ? `\n- Telephone: ${S.phone}` : ""}
- Physical address: ${addr}${L.postalAddress ? `\n- Postal address: ${L.postalAddress}` : ""}
- Information Officer: ${io}
- PAIA manual: available on request from ${email}
- Payment security: card payments are processed by PCI-DSS compliant payment service providers; TicketRoom does not store card numbers or CVV codes.`],
      ],
    },

    // ------------------------------------------------------------------ TERMS AND CONDITIONS (SALE, ATTENDEES, ORGANISERS)
    terms: {
      title: "Terms and Conditions",
      summary: "These Terms and Conditions apply to every ticket, booking, cashless top-up and organiser listing on TicketRoom. Please read the highlighted clauses carefully.",
      important: [
        "Tickets are sold on behalf of the Organiser, who is responsible for the Event (clause 2).",
        "The first valid scan of a QR code admits; copies are refused. Keep your ticket private (clause 5).",
        "Tickets are non-refundable except where the Event is cancelled, materially changed, or the Organiser's policy or the law says otherwise. The R10 booking fee is refunded only if the Event is cancelled (clause 7).",
        "You attend Events at your own risk and must follow venue rules; you may be refused entry or removed (clause 6).",
        "Our liability is limited and you indemnify us as set out in clause 12 and in our Terms of Use.",
      ],
      sections: [
        ["1. Application", `These Terms and Conditions (**Terms**) apply between you and ${who(L)} (**TicketRoom**) when you obtain a ticket, top up a cashless balance, or list an Event as an Organiser. They form part of, and are read with, our Terms of Use, Privacy Policy and Cookie Policy. Each Event may also have its own conditions, refund policy and age limits, shown on the Event page, which form part of your agreement with the Organiser.`],
        ["2. TicketRoom acts for the Organiser", `When you buy a ticket, the contract to attend the Event is between **you and the Organiser**. TicketRoom sells and issues tickets as the Organiser's agent and collects payment on its behalf. The Organiser is responsible for delivering the Event as described.`],
        ["3. Prices and fees", `- Ticket prices are set by the Organiser and shown in South African rand (ZAR), including VAT where applicable.
- TicketRoom charges a **booking fee of R10 per paid ticket**, shown separately before you pay. Free tickets carry no fees.
- The total you will pay is shown before you confirm your order.
- We may correct obvious pricing errors; if a price is wrong we will offer you the choice to proceed at the correct price or cancel for a full refund.`],
        ["4. Orders and payment", `- Tickets are reserved for a limited time while you pay. If payment is not completed in time the reservation lapses.
- An order is confirmed only when our payment provider confirms payment, not when you return to our website. We then issue your tickets and email you.
- We may cancel orders suspected of fraud, automated purchasing, or breach of purchase limits, and refund the amount received.
- If payment is received after your reservation lapsed and the tickets are sold out, we refund you in full.
- Do not pay twice. If something looks wrong, request a callback and we will check with the payment provider.
- Chargebacks: if you dispute a valid payment with your bank, related tickets will be cancelled. Fraudulent chargebacks may be reported.`],
        ["5. Your ticket", `- Your ticket is a personal, revocable licence to attend the Event. It is not a property right.
- Your QR code is your ticket. **The first valid scan admits one person; any later scan of the same code, including screenshots and copies, is refused.** Keep it private. TicketRoom is not responsible if a copy of your ticket is used before you arrive.
- Tickets may be transferred only through the Platform's transfer feature while the Organiser allows it. A transfer issues a new QR code and cancels the previous one.
- Reselling or offering tickets above face value, or through unauthorised channels, is prohibited unless the Organiser allows it; such tickets may be cancelled without refund.
- Tickets obtained from anyone other than TicketRoom or an authorised transfer may be invalid.
- We may reissue or cancel a ticket where needed to prevent fraud, and will replace it where you are not at fault.`],
        ["6. Attending an Event", `- The Organiser and venue may refuse entry or remove you, without refund, if you breach venue rules, the law, age limits, or behave unsafely or abusively.
- You may be searched, asked for identification, and required to comply with health, safety and security instructions.
- Age restrictions are set by the Organiser. Proof of age may be required.
- **You attend at your own risk.** Events may involve loud noise, lighting effects, crowds and physical activity. To the extent permitted by law, neither TicketRoom nor (where the law allows) the Organiser is liable for loss of or damage to personal belongings, or injury not caused by their negligence.
- Events may be filmed, photographed or recorded; by attending you consent to appearing in such recordings, subject to our Privacy Policy and the Organiser's notices.
- Line-ups, times and programmes may change. A change is "material" only if it substantially changes the Event you booked.`],
        ["7. Cancellations, changes and refunds", `- **Cancelled Events:** if an Event is cancelled, you receive a full refund of the ticket price and the booking fee to your original payment method. You do not need to apply.
- **Postponed or materially changed Events:** you will be notified and offered the option to keep your ticket or receive a refund, in line with the Consumer Protection Act.
- **Otherwise, tickets are non-refundable** unless the Organiser's published refund policy allows it. You may ask the Organiser to cancel an advance booking; under section 17 of the Consumer Protection Act a reasonable cancellation charge may apply.
- The **R10 booking fee is non-refundable** except when the Event is cancelled or we are at fault.
- The cooling-off period in section 44 of the Electronic Communications and Transactions Act does not apply to leisure services booked for a specific date (section 42 of that Act).
- Approved refunds are paid to the original payment method and usually reflect within 3–10 working days, depending on your bank.
- If an Organiser fails to honour its obligations, TicketRoom will assist you and, where it still holds the Organiser's funds, may refund you from them, but TicketRoom is not otherwise liable for the Organiser's obligations.`],
        ["8. Cashless payments, wristbands and tags", `- At cashless Events you may link a wristband, card or QR tag to your Account and top up an Event balance. Your balance is held on your Account, not on the tag.
- **Report a lost or stolen tag immediately** in your Account; we block it at once. You are responsible for purchases made before you report it, unless caused by our negligence.
- Purchases above a set amount require your spending PIN. Never share your PIN.
- Balances may only be used at the specific Event and are not legal tender, interest-bearing or transferable.
- You may request a refund of any unused balance; it is paid back to the payment method you used. Balances may be subject to caps and expiry rules shown at top-up.`],
        ["9. Organisers", `If you list Events, you also agree that:
- you are legally responsible for your Event, its description, safety, permits, licences, insurance and compliance with all laws;
- listing free Events is free. For paid Events, **TicketRoom retains a commission of 5% of ticket sales** (excluding the booking fee), which is deducted from your payouts, unless a different rate is agreed in writing;
- Events are published only after TicketRoom approves them; we may decline, suspend or remove an Event or Organiser at our discretion, including for suspected fraud or risk to Attendees;
- payouts are made by EFT to your verified bank account after the Event has ended and any holding period has passed, less commission, refunds, chargebacks and amounts you owe us. We may withhold payouts while refunds or disputes are outstanding;
- you must refund Attendees where the law or your refund policy requires, and if you cancel an Event, TicketRoom will refund Attendees from your funds and you remain liable for any shortfall, including booking fees refunded;
- you may contact Attendees for marketing only if they opted in for your organisation, and only through the Platform or in compliance with POPIA, and you must honour unsubscribe requests;
- you act as an independent responsible party for personal information you receive about your Attendees, and must protect it and use it only for your Event and lawful purposes;
- staff you add as scanners act on your behalf and you are responsible for them;
- you indemnify TicketRoom against all claims arising from your Event, your content, your staff, or your breach of these Terms.`],
        ["10. Vendors (cashless point of sale)", `Vendors trading at cashless Events act under the Organiser's arrangements. Sales are recorded by the Platform; refunds of sales require approval by someone other than the requester. Settlements are made after the Event, less agreed commission and reversals.`],
        ["11. Communications", `We send service messages (receipts, tickets, event reminders, changes, cancellations and refunds) by email and, where provided, SMS. If you start a booking but don't finish it, we may send one reminder about that event, which you can opt out of. Marketing is sent only if you opted in, and every message lets you unsubscribe. See our Privacy Policy.`],
        ["12. Liability and indemnity", `**To the fullest extent permitted by law:** TicketRoom is not liable for the Event itself or for the acts or omissions of Organisers, venues, performers, vendors or other Attendees; and TicketRoom's total liability in connection with any order is limited to the amount you paid for that order. Nothing limits liability that cannot lawfully be limited. The limitation of liability and indemnity in our Terms of Use also apply.`],
        ["13. Complaints and disputes", `Contact us first at ${email} or use the callback form; we aim to respond within 24–48 hours during business hours (Monday to Friday, 9am to 5pm, excluding public holidays). If we cannot resolve your complaint, you may approach the Consumer Goods and Services Ombud or the National Consumer Commission. South African law applies.`],
      ],
    },

    // ------------------------------------------------------------------ PRIVACY POLICY
    privacy: {
      title: "Privacy Policy",
      summary: "How TicketRoom collects, uses, shares and protects your personal information, and your rights under the Protection of Personal Information Act 4 of 2013 (POPIA).",
      important: [
        "We collect only what we need to sell tickets, run Events safely and support you.",
        "We never sell your personal information. We do not store card numbers or CVV codes.",
        "Organisers receive the details needed to run their Event; they may market to you only if you opted in for them.",
        "You can access, correct, download or delete your information, and unsubscribe at any time.",
      ],
      sections: [
        ["1. Who is responsible", `${who(L)} (**TicketRoom**) is the responsible party for personal information processed through ticketroom.co.za and related services. Our Information Officer is ${io}, contactable at ${email}. Physical address: ${addr}.

For Attendee information they receive, Organisers are separate responsible parties and must also comply with POPIA.`],
        ["2. Information we collect", `- **Account information:** name, email address, mobile number (optional), password (stored only as a secure hash), spending PIN (stored only as a secure hash).
- **Orders and tickets:** events booked, ticket types, order references, amounts, ticket holder names, transfers, admission (scan) times.
- **Payments:** payment status, amounts, references and the payment method type, received from our payment providers. **We do not receive or store full card numbers or CVV codes.**
- **Cashless:** linked wristbands/cards/tags (stored only as protected identifiers), top-ups, purchases, refunds.
- **Organisers and vendors:** business and contact details, team members, bank details for payouts (encrypted; only the last four digits are displayed).
- **Support:** callback requests, messages to us, questions asked to our online assistant.
- **Technical:** IP address, browser type, session identifiers and security logs needed to protect the Platform.
- **Marketing preferences:** which organisers and channels you opted in to, and when you changed them.`],
        ["3. How we collect it", `Directly from you; from Organisers (for example when they add you as staff); from people who transfer a ticket to you; from payment, SMS and email service providers; and automatically when you use the Platform (see our Cookie Policy).`],
        ["4. Why we use it (purpose and lawful basis)", `- To create and manage your Account, sell and deliver tickets, process transfers and refunds: **to perform our contract with you** (POPIA s11(1)(b)).
- To admit you to Events, prevent duplicate entry, fraud and abuse, and keep the Platform secure: **our legitimate interests** and those of Organisers (s11(1)(f)).
- To keep financial and tax records, respond to lawful requests, and comply with law: **legal obligations** (s11(1)(c)).
- To send transactional messages about your orders and Events: **contract**.
- To remind you about Events you hold tickets for, and to send one reminder if you leave a booking unfinished (you can opt out at any time): **legitimate interest**.
- To send marketing from TicketRoom or an Organiser: **only with your consent** (s69), which you can withdraw at any time.
- To answer support requests and improve our help content: **legitimate interests**.`],
        ["5. Who we share it with", `- **Organisers** of Events you book or attend: your name, email, ticket and admission details, and your phone number if you provided it, so they can run the Event and contact you about it. Organisers may send you marketing only if you opted in for them.
- **Service providers (operators)** who process information for us under written agreements: hosting, payment processing, email and SMS delivery, and, where our online assistant uses artificial intelligence, an AI service provider that processes the text of your question (do not include personal details in assistant questions).
- **TitoPay**, our technology partner, where you choose TitoPay wallet payments.
- **Authorities, regulators and professional advisers** where required by law or to protect rights, safety and property.
- **A buyer or successor** of our business, subject to the same protections.

We **never sell** your personal information.`],
        ["6. Cross-border transfers", `Some service providers may store or process information outside South Africa. We only do so where the recipient is subject to laws, binding rules or an agreement providing adequate protection, or with your consent, as required by POPIA section 72.`],
        ["7. How long we keep it", `- Account information: while your Account is active and for up to 12 months after closure, unless needed longer for a dispute.
- Orders, payments, refunds and the financial ledger: **at least 5 years** after the transaction, as required by tax and company law. If you delete your Account, these records are kept with your identity removed where possible.
- Security logs and webhook data: up to 90 days. Message content: up to 180 days. Assistant questions: up to 90 days.
- Marketing consent records: for as long as needed to prove consent or opt-out.`],
        ["8. How we protect it", `Encryption in transit (HTTPS), encryption of bank details at rest, hashed passwords and PINs, role-based access with separation of duties, tamper-evident audit logs, secure payment providers, and staff confidentiality obligations. No system is perfectly secure; if a breach affecting you occurs, we will notify you and the Information Regulator as required by POPIA section 22.`],
        ["9. Your rights", `You may:
- access your personal information and request a copy (Settings & privacy → Download my data);
- correct inaccurate information;
- delete your Account and personal information (Settings & privacy → Delete my account), subject to records we must keep by law;
- object to processing based on legitimate interests;
- withdraw consent to marketing at any time (unsubscribe link, Settings & privacy, or ticketroom.co.za/unsubscribe);
- lodge a complaint with the **Information Regulator** (South Africa): inforegulator.org.za, enquiries@inforegulator.org.za.

Contact ${email} to exercise any right. We may need to verify your identity first.`],
        ["10. Children", `The Platform is not directed at children under 18. A parent or guardian must open the Account and give consent for a child's information to be processed.`],
        ["11. Direct marketing", `We and Organisers send electronic marketing only with your opt-in consent, or to existing customers for similar products where POPIA allows, and always with an easy way to opt out. Opting out does not affect messages about tickets you have bought.`],
        ["12. Changes", `We may update this policy; the date at the top shows the latest version. Material changes will be notified on the Platform or by email.`],
      ],
    },

    // ------------------------------------------------------------------ COOKIE POLICY
    cookies: {
      title: "Cookie Policy",
      summary: "TicketRoom uses only the cookies and on-device storage needed to run the service securely. We do not use advertising or third-party tracking cookies.",
      important: [
        "We only use essential cookies. There are no advertising, social media or third-party analytics cookies.",
        "Blocking essential cookies will stop sign-in and checkout from working.",
      ],
      sections: [
        ["1. What cookies are", `Cookies are small text files a website stores on your device. Similar technologies include your browser's local storage. We refer to all of them as "cookies".`],
        ["2. Cookies we use", `
- **tr_sid**: essential, first-party. Keeps you signed in securely (HttpOnly, Secure, SameSite). Expires after 14 days or when you sign out.
- **Security token (in memory)**: essential. Protects forms against cross-site request forgery. Lasts for your session.
- **tr_wallet_v1** (local storage): essential. Saves your tickets on your own device so your QR code opens with poor signal at the venue. Cleared when you sign out of the browser or clear site data.
- **tr_terminal_key** (local storage, vendor tills only): essential. Identifies a registered point-of-sale device.
- **tr_org, tr_scan_event, banner and chat preferences** (local/session storage): functional. Remember your selected organisation, scanning event, dismissed banners and assistant conversation for convenience.
- **Service worker cache**: functional. Stores the app shell so the ticket wallet loads offline. Contains no personal information.`],
        ["3. Third parties", `We do not allow third parties to set cookies on ticketroom.co.za. When you pay, you are sent to your payment provider's secure page, which uses its own cookies under its own policy.`],
        ["4. Managing cookies", `You can block or delete cookies in your browser settings. Because we only use essential and functional cookies, blocking them will prevent sign-in, checkout and the offline ticket wallet from working. If we ever introduce non-essential cookies (for example analytics), we will ask for your consent first and update this policy.`],
        ["5. Contact", `Questions about cookies: ${email}.`],
      ],
    },

    paia: {
      title: "PAIA and POPIA Manual",
      summary: "Information about requesting access to records held by TicketRoom under the Promotion of Access to Information Act 2 of 2000 (PAIA).",
      important: [],
      sections: [
        ["Requests for information", `Our PAIA manual, describing the records we hold and how to request access to them, is available on request from ${email}. Requests are handled by ${io}. You can access most of your own information directly in Settings & privacy → Download my data.`],
        ["Information Regulator", `Information Regulator (South Africa), inforegulator.org.za, enquiries@inforegulator.org.za`],
      ],
    },
  };
}

export const ORDER = [["terms-of-use", "Terms of Use"], ["terms", "Terms and Conditions"], ["privacy", "Privacy Policy"], ["cookies", "Cookie Policy"], ["paia", "PAIA manual"]];
