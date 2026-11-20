# South African compliance checklist

> This is an engineering checklist, **not legal advice**. No compliance claim may be made publicly until each "Owner" item has been completed and documented by qualified advisers. Status is either **Built** (supporting engineering exists) or **Open** (a decision or opinion is required).

## National Payment System / prepaid balances

| Question | Owner | Status |
|---|---|---|
| Does holding attendee prepaid balances (Mode A) constitute issuing electronic money or stored value under SARB's position on e-money, or fall within an exemption for closed-loop, single-event use? | Payments counsel | **Open (blocks real-money cashless)** |
| Who legally holds the float (TitoPay, a sponsor bank, the provider)? Are funds segregated or held in trust? | Payments counsel, finance | **Open** |
| Does collecting on behalf of organisers and vendors and paying out to them require PASA registration as a payment service provider or third-party payment provider, or operation under a bank sponsor? | Payments counsel | **Open** |
| Does TitoPay's existing licensing or provider arrangement cover TicketRoom's flows? | TitoPay compliance | **Open** |
| Unused balances: refund policy and unclaimed-funds treatment | Legal, finance | Built: refund-on-request flow. Policy is **Open**. |
| Caps to limit exposure | Finance | Built (configurable): R5,000 balance cap, R2,000 top-up cap, R3,000 sale cap |

## POPIA

| Requirement | Status |
|---|---|
| Responsible party identified (TitoPay (Pty) Ltd), Information Officer registered | Draft privacy notice built. Registration is **Open (TitoPay)**. |
| Lawful basis and minimality: only name, email, optional phone. No ID numbers, no card data. | Built |
| s18 notification at collection | Draft notice built; legal review **Open** |
| s69 direct marketing: opt-in per organiser per channel at checkout, opt-out in every message, consent log | Built (tested) |
| Data subject access and deletion (export JSON; delete anonymises while keeping financial records) | Built (tested) |
| Retention schedule (sessions 30 d, resets 7 d, webhook payloads 90 d, message bodies 180 d; financial records kept) | Built (configurable). Statutory periods to be confirmed (**Open**). |
| Security safeguards (s19): encryption of bank details, access control, audit, breach procedure | Built (see `SECURITY.md`). Breach procedure **Open (TitoPay)**. |
| Operator agreements (s21) with hosting, email, SMS and payment providers | **Open** |
| Cross-border transfers (s72) if hosting or email providers are outside SA | **Open** |

## Consumer Protection Act / ECTA

| Requirement | Status |
|---|---|
| All-in price disclosure before payment (ticket + fee shown separately and in the total) | Built |
| Supplier identity, contact details, terms, refund policy on site (ECTA s43) | Built (drafts flagged DRAFT). Physical address and company registration number **Open**. |
| Event cancellation means a full refund. Material changes are blocked from organiser self-service once tickets are sold and routed through support (CPA s47). | Built |
| Cooling-off (ECTA s44) does not apply to leisure services on a specific date (s42 exclusion) | Legal to confirm (**Open**) |

## Tax and records

| Item | Status |
|---|---|
| VAT treatment of ticket price (organiser's supply?) and service fee (TitoPay's supply) | **Open (tax adviser)** |
| Tax invoices / receipts with VAT numbers | Not built: order confirmation only. **Open.** |
| Financial records retention (Companies Act / Tax Administration Act, typically 5+ years) | Ledger is immutable. Deletion keeps records. |

## PCI DSS

TicketRoom never receives card data: hosted checkout, with card entry on the provider's page. The expected scope is **SAQ A**, to be confirmed with the chosen provider and acquirer. Do not add card fields to TicketRoom pages.

## Contracts

| Agreement | Status |
|---|---|
| Organiser agreement (agency, fees, payout timing, refunds liability, chargebacks, data use) | **Open** |
| Vendor terms (commission, settlement, refunds) | **Open** |
| Attendee terms of use (draft in the site, flagged DRAFT) | Draft built; review **Open** |
| Payment provider merchant agreement | **Open** |
