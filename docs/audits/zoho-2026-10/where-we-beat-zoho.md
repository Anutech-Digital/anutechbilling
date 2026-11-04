# Where our app is better than Zoho Books (for the website)

Source: Zoho Books audit, 31 Oct 2026. Four reports in this folder: sales.md, banking.md, accounting.md, ux.md. Our side was checked in the code (anutech/manager-pardeep), and UX was checked on localhost. Zoho was checked from its India help docs, plus a read-only walkthrough.

> Before you publish: check each claim once more against the live Zoho Books India edition. Zoho changes often. Don't name a Zoho weakness unless it is confirmed on the date of publishing. Phrasing like "built for Indian Google Workspace / Microsoft 365 resellers" is safer than direct put-downs.

## Built for resellers (subscriptions)
- **Real subscriptions, not plain recurring invoices.** Seats, commitment (Flexible / Annual), payment frequency (monthly, quarterly, half-yearly, yearly), renewal date and billing in parts. Zoho Books only repeats an amount; for seats and terms it needs a separate product, Zoho Billing.
- **Add seats mid-term with automatic pro-rata.**
- **Margin guard.** Every price is checked against wholesale cost, so you can't sell below cost by mistake.
- **Google bill check.** Your Google partner bill is matched against your subscriptions.
- **New sale + subscription straight from a bank credit.** Money arrives, and one step books the sale, the invoice and the receipt.

## Banking & payments
- **One-click Razorpay settlement.** Many payments are matched, and the gateway fee and its GST are booked automatically. In Zoho the fee is a manual entry through a clearing account.
- **Bank statement integrity check.** The balance chain, gaps and opening balance are verified when you import.
- **Smart payer matching.** Short or cut names in UPI/NEFT narrations are still matched to the right customer.
- **Invoice date = the date money hit the bank** for sales booked from receipts.
- **Rules learned from your corrections** when you import.
- **EMI loans with principal/interest split, plus loans given and director loans.**
- **Payment runs.** Bulk vendor payouts with approval and a bank file, in MSME 45-day order.
- **Expense claims built in.** No separate app needed.
- **AI bill reading** that checks your GSTIN is on the bill.

## GST, TDS & compliance (India)
- **TDS receivable register** with a 26AS match, Form 16A tracking and year-end check. The TDS section is picked automatically from the rate and PAN, with the reason shown.
- **TDS-only receipts** (customer paid only TDS, no bank money) handled properly.
- **GST on advances**, with a proper receipt voucher.
- **Write-off with a statement line** and suggestions for overdue invoices.
- **Invoice numbering that never reuses cancelled numbers** (Rule 46 safe).
- **RBI/FBIL exchange rates** for USD invoices, with the source and date stored.
- **Tally day-book export** for your CA.
- **MSME 45-day ageing.**
- **Month-end close checklist** that ends with a books lock.

## Getting paid
- **Payment reminder ladder** from before the due date to final notice, with WhatsApp, late-charge rules and optional service suspend. Zoho Books India has no native late fees.
- **Credit limit and pay-later**, so service can start on credit.
- **Customer groups and parent accounts.**

## Ease of use (tested side by side)
- In a 10-task test we won 6, Zoho won 3, and 1 was a tie. We won on new customer with GSTIN, payment with TDS, credit note, subscription from a paid quote, search and AI reminders.
- **Ctrl+K search everything**, plus keyboard shortcuts.
- **Works well on a phone.** Zoho's web app is hard to use on mobile.
- **AI help** inside the app.

## Not to claim yet (Zoho is still ahead, being fixed under G-ZOHO)
- Bank reconcile speed (Save & next, bulk actions, rules that book).
- Customer statement PDF and email.
- P&L drill-down that ties out.
- One-step "Convert quote to invoice".
- Forex gain/loss and export invoices from USD receipts.
- Full country list.
