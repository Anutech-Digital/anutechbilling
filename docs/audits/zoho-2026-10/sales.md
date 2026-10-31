# Zoho Books vs our Billing app: Sales & Receivables audit

Auditor: zaudit-sales (read-only). Date: 31 Oct 2026.
Code checked on `anutech/manager-pardeep` @ cb40226d1 (the latest branch, not the local worktree). Board cards read: R-2094 (staging reconcile, needsDecision list) and R-2095 (reconcile app gaps, liveLog to 30 Oct).
Zoho sources: zoho.com/in/books/help (invoice, payments received), Zoho KB (foreign-currency payment, bad-debt write-off), and known Zoho Books India behaviour. The features page returned 403. I did NOT open the real Zoho org in a browser. Where this file says "Zoho does X" without a source, it comes from the help index and general product knowledge. Check it in the org before you build anything that copies Zoho.

Verdicts: **we-better** = ours already beats Zoho for an Indian GW/M365 reseller · **parity** · **gap** = we have it, but weaker · **missing**.
Impact = value for Anutech (1–5). Effort = S (≤1 day) / M (2–4 days) / L (a week or more).

---

## 1. Capability table

| # | Capability | Zoho Books (India) | Ours (file:line) | Verdict | Impact | Effort |
|---|---|---|---|---|---|---|
| 1 | Customer master: GST treatment, GSTIN, PAN, place of supply | GST treatment dropdown (registered / unregistered / consumer / overseas / SEZ…), GSTIN lookup, place of supply per customer | Country first, then a live tax-treatment banner; GSTIN prefill + GSTN verify. `components/features/customers/customer-form-page.tsx:290-310`, `gst-treatment-fields.tsx:42` | we-better | 3 | – |
| 2 | **Country list** | Full ISO list (≈250 countries) | Hand-picked list of about 60 countries. **No Estonia, no Cayman Islands** (blocked Customer D and Customer C in R-2094). `lib/gst/countries.ts:11-67` | **gap** | 4 | S |
| 3 | Contacts (several people, one primary) | Contact persons, portal access per person | Primary contact plus several contacts. Can now save a customer with no contact (R-2095 gap 8). `lib/contacts/primary.ts` | parity | 2 | – |
| 4 | Customer groups / parent accounts | No real grouping (tags and custom fields only) | Groups, plus parent accounts in Abhishek's area. `app/(app)/customers/groups/[id]/page.tsx` | we-better | 2 | – |
| 5 | Credit limit / pay-later | Credit limit on customer (warn) | `allow_pay_later` + `credit_limit`, and service starts on credit. `lib/credit/queries.ts:96`, `lib/credit/activate-on-credit.ts` | we-better | 3 | – |
| 6 | Items / catalogue | Items with rate, SAC/HSN, sales and purchase rate, price lists | Products, subscriptions and packages. The catalogue price carries a margin floor against wholesale cost, so the app refuses to sell below cost. `app/(app)/items/*`, `lib/catalog` | we-better (margin floor) | 3 | – |
| 7 | Price lists (per customer or %-markup) | Price lists by % or per item, assigned to a customer, chosen on the invoice | None. The rate is typed per quote line. Partner and coupon pricing exists only in checkout (`lib/checkout/cart-coupon.ts`) | missing | 2 | M |
| 8 | Paise rates | Rates to 2 decimals | Fixed in R-2095 (migration `20261030050145_r2095_new_sale_paise_rate.sql`) | parity | 3 | – |
| 9 | Quotes / estimates | Estimate → SO → invoice. Customer accepts in the portal | Quote builder with margin pill, FX rate and source, a public view and accept page, and combine quotes. `components/features/quotes/quote-builder.tsx`, `app/(public)/quote/[id]/accept/page.tsx`, `app/(public)/quote/view/[token]/page.tsx` | we-better | 3 | – |
| 10 | Sales orders / delivery challans | Yes | None. An accepted quote does the job of a sales order, and a SaaS sale needs no challan | n/a, **don't copy** | 1 | – |
| 11 | Proforma | Proforma or retainer invoice | The quote PDF works as a proforma. `api/quotes/[id]/send/route.ts` | parity | 2 | – |
| 12 | Tax invoice from quote / receipt | Convert estimate → invoice | `generate_invoice`. Since R-2095, a sale booked from a bank receipt gets its invoice on the first receipt, even when part-paid, dated the bank date. `supabase/migrations/20261030123423_r2095_sale_invoice_on_receipt.sql:1-30` | parity (just fixed) | 5 | – |
| 13 | Document series / numbering | Prefix + auto number, editable | FY-based series with a 16-character cap. Cancelled numbers are kept, never reused. `migrations/20261010190000_tenant_guard_fail_closed.sql:525` | we-better (Rule 46 safe) | 3 | – |
| 14 | Recurring invoices | "Recurring invoice" profiles: amount and frequency only, no seats or terms (seats and terms are in Zoho Billing) | Subscriptions with term, renewal date and seats, billed in parts (monthly / quarterly / half-yearly). `lib/billing/instalments.ts:22`, `bill_subscription_instalment` in `20261030123423…sql:375` | we-better | 5 | – |
| 15 | **Commitment vs payment frequency** | Zoho Books has none. Zoho Billing has plan interval vs billing frequency | Commitment lives only in the quote **line JSON** (`line.commitment = annual_yearly / monthly`), and the subscription row stores only `billing_cycle`. Rule: "Monthly flex has no commitment" (`migrations/20261028020622_r2026_new_sale_billing_cycle.sql:118`). Read from `firstLineCommitment(q.line_items)` (`lib/billing/instalments.ts:369`), `lib/banking/credit-pay-for.ts:577` | **gap** | 4 | M |
| 16 | **Mixed monthly + one-time lines in one sale** | One invoice can carry any lines. A recurring profile repeats all of them | Quarterly + setup works (Q1 = quarter + setup). **Monthly flex + one-time is blocked**: "Save disabled" (R-2095 gap 2). The customer pays in one bank credit, so we have to book two sales | **gap** | 4 | M |
| 17 | Add seats mid-term (pro-rata) | Books: manual. Billing: pro-rata add-on | Add seats with pro-rata. The price fix (₹3,150 not ₹3,151) and the IGST preview fix are done in R-2095 | we-better | 4 | – |
| 18 | **Part-paid seat-add from reconcile** | Invoice for the full amount, balance due | `invoice_on_receipt` covers **new sales only** (`…sale_invoice_on_receipt.sql:5-12`: "A quote sent before payment keeps the fully-paid rule"). An add-seats quote paid short gets no invoice until it is paid in full | **gap** | 4 | S |
| 19 | Credit notes | Line-item credit note (qty/rate/tax), apply to invoices, refund | Amount-only note (₹ incl GST), with a reason code such as "seats_reduced". `components/features/invoices/issue-credit-note-dialog.tsx:31,90-117`, `issue_credit_note_core` `migrations/20261018171947_r1563_credit_note_refund.sql:62`. Credit → customer credit, and refund is possible (`20261019132853_r1682_partial_credit_refund.sql:34`) | gap (no lines/qty) | 3 | M |
| 20 | **Credit note ↔ subscription balance** | Not linked at all in Books | A **full** CN frees the billing part, and the CN credit pays the re-issued part (`migrations/20261030035007_r2095_credited_part_rebill.sql:97`, R-2095 P0). A **partial** CN "frees nothing", and "seats_reduced" does **not** lower the subscription's seats or the next part's amount | **gap** (half fixed) | 4 | M |
| 21 | Debit notes | Yes | Yes, with GSTR-1 handling and a statement line. `issue-credit-note-dialog.tsx` (isDebit) | parity | 2 | – |
| 22 | Retainer / advance | Retainer invoice, applied later to invoices | Advance from a bank credit with a GST receipt voucher (`receipt_voucher` series) and apply-to-invoice. `app/(app)/accounting/advances/page.tsx`, `reconcile_bank_credit_as_advance` | we-better (GST on advance) | 3 | – |
| 23 | Payments received: one payment, many invoices | Yes, in one screen | Bank-credit split over several items plus a new sale, with ≤₹50 round-off only when every item is fully settled. `migrations/20261029135130_r2098_round_off_full_only.sql:10-17`, `components/features/banking/credit-pay-for-split.tsx` | parity | 4 | – |
| 24 | Bank / gateway charges on a receipt | "Bank charges" field on Record Payment | Razorpay fee + GST stored on the payment and the settlement booked net. `migrations/20261007210000_razorpay_gateway_fee_refund.sql:29-30`. No bank-charge field for wire receipts (SWIFT charges on USD inward) | gap | 3 | S |
| 25 | **Forex gain/loss on receipts** | Record Payment takes the payment-date rate. Zoho posts the difference to Exchange Gain/Loss automatically, and the invoice shows fully paid (Customer G ₹230 case, R-2094) | **None.** Invoices freeze `currency/fx_rate/fx_source/fx_date` (`migrations/20261007251000_invoice_fx_rate.sql:39-42`). The header says "Books stay in whole ₹", payments have no currency or foreign amount, and grep finds no fx_gain or exchange-difference account anywhere. The ₹230 short stays as "due" | **missing** | 5 | M |
| 26 | Unrealised FX revaluation (period end) | Base Currency Adjustment journal | None | missing | 2 | M |
| 27 | FX rate source | Manual or a feed (Zoho rate feed, not RBI) | FBIL/RBI reference first, then indicative sources, each with its date and source. `lib/fx/rate-source.ts:1-25` | we-better (Rule 34 aware) | 3 | – |
| 28 | **Export (overseas) invoice** | GST treatment "Overseas" → export with or without payment (LUT), INR equivalent, GSTR-1 table 6A | Pieces exist: zero-rated for a foreign customer (`credit-pay-for-section.tsx:183`), LUT number in settings and on the PDF (`api/v1/documents/invoice/[id]/pdf/route.ts:54`), frozen FX. But from reconcile, "Generate GST Invoice" would date it today and treat it as **B2C**, so no export invoice has been issued for Customer G or the UAE customers (R-2094). The receipt-based flow does not carry USD amount + rate onto the invoice | **gap** | 5 | M |
| 29 | TDS on receivables | "TDS deducted" field on Record Payment, to a TDS receivable account | Own register, a year-end 26AS check, a section picker (194C/194J) with a reason, and TDS at ₹0 bank. `app/(app)/accounting/tds-receivable/page.tsx`, `…/year-end/page.tsx`. Open gap: old receipts can't take TDS after the fact (R-2095 gap 12), and odd % (3.28%) still needs a human | we-better | 4 | S (gap 12) |
| 30 | Round-off on receipt | Invoice-level rounding setting | ≤₹50 round-off at reconcile, full-settle only (R-2098). **No ₹1 balance tolerance** on a single balance payment (Q-0224 keeps ₹1 due, R-2094) | gap (small) | 2 | S |
| 31 | Write-off (bad debt) | "Write Off" in Record Payment → Bad Debt account. GST is not reversed (known Zoho weakness) | `write_off_subscription` and invoice write-off with a statement line, plus write-off suggestions for overdue. `migrations/20261023184545_r1635_write_off_invoices.sql:57`, `20261007281600_overdue_auto_suspend.sql:149`, `components/features/collections/write-off-suggestions-card.tsx` | we-better | 3 | – |
| 32 | **Un-reconcile undoes the sale** | Delete payment (the invoice stays) | `unreconcile_bank_receipt(p_txn_id, p_undo_sale)` issues a full CN, cancels the voucher, deletes the receipt and rejects the quote (`migrations/20261027012329_r1999_project_receipt_undo.sql:277-352`, dialog `components/features/banking/unreconcile-dialog.tsx:102-137`). **But: the subscription the sale created stays active** (nothing touches `subscriptions` or `subscription_billings`). The function also refuses when the sale has other receipts, TDS or a CN ("handle it from the invoice"), so a TDS sale can't be undone in one step | **gap** | 4 | S |
| 33 | Payment reminders / dunning | Automated reminders before and after the due date, with templates | A ladder from pre-due to final, with an escalate step and opt-in suspend, WhatsApp, late-charge sentence, and dry-run. `lib/invoices/dunning.ts:88`, `app/api/cron/invoice-dunning/route.ts` | we-better | 4 | – |
| 34 | Late fees / interest | Not native in Books India (manual) | Late-charge rules. `lib/late-charges/rules.ts`, migration `20261009233000_late_payment_charges.sql` | we-better | 2 | – |
| 35 | **Payment link / gateway on the invoice** | Zoho Payments, Razorpay, PayU, Stripe, PayPal. "Pay now" in the invoice email and the portal, auto-recorded | UPI deep link + QR only (`lib/invoices/pay-link.ts`). The Razorpay payment link is **built but not wired** ("Not wired yet — R-1608", `lib/payments/payment-link.server.ts:1`). The webhook auto-records Razorpay checkout payments | gap | 4 | S |
| 36 | Auto-charge / mandates | Card auto-charge (gateway) | UPI Autopay / e-NACH state machine (`lib/payments/mandate.ts`, `migrations/20260817090000_payment_mandates.sql`). Not used live | parity | 3 | M |
| 37 | Customer statement | Statement for a date range: PDF, email, monthly auto-send | On-screen Statement tab with the full ledger including CN/DN/refund/write-off (`components/features/customers/customer-statement.ts:1-40`, `customer-profile.tsx:153`). A "pending dues" email exists (`api/customers/[id]/pending-dues/email/route.ts`). **No statement PDF and no date-range email** | gap | 3 | S |
| 38 | Customer portal | View, pay and download invoices and quotes, accept quotes, statement | Public quote view and accept only. There is no invoice or statement portal in Billing; the customer panel is Pawan's area / DMS (R-1768) | missing (other owner) | 3 | L |
| 39 | E-invoice (IRN) / e-way bill | Direct IRP integration | Warning banner only. "The app does NOT generate IRNs yet (R-044, waiting on the GSP decision)" `lib/compliance/einvoice.ts:12` | missing (needed only above ₹5 Cr AATO) | 2 | L |
| 40 | Multi-currency books | Customer currency, invoice in USD, receivable in USD, FX accounts | Quote and invoice record the currency and rate. Receivable, payment and books are INR only | gap | 4 | M–L |
| 41 | Opening balances / Zoho import | Native | Zoho import scan + opening invoices (`lib/integrations/zoho-books/import-scan.ts`, `20261022013149_r1739_zoho_opening_invoices.sql`) | parity | 3 | – |
| 42 | Invoice date rule | Whatever the user types | Receipt-based sale = bank date. Part = period start (R-2095, migration `20261030054246`) | we-better | 4 | – |
| 43 | Payer matching on bank credits | Bank rules, exact match | Fuzzy payer match including a cut-short prefix (R-2095 gap 7), plus credit-match stop-words. `lib/accounting/credit-match.ts:73` | we-better | 4 | – |

---

## 2. Where Zoho's UX is clearly better (copy the idea, not the screen)

1. **One "Record Payment" screen** holds amount, bank charges, TDS withheld, payment-date exchange rate and a "write off the rest" option. The FX difference is posted for you. We need several steps (split, round-off, a separate TDS step), and FX has no step at all.
2. **"Pay now" link inside every invoice email and reminder.** The customer clicks, pays, and the receipt books itself.
3. **Statement → date range → PDF / Email** in one click from the customer page.
4. **Overseas customer = one dropdown value** ("Overseas"), and every export invoice then follows from it: currency, LUT text, 6A. Ours knows "foreign" from the country, but the receipt-to-invoice path loses it.
5. **Credit note with item lines**: the reader sees *what* was credited (2 seats × ₹3,150), not just a ₹ figure.

## 3. Where Zoho is weak: do NOT copy

- **Recurring invoices with no subscription state.** No seats, no term, no renewal date, no pro-rata. That is why Zoho runs a separate "Zoho Billing" product. Our subscriptions are the moat. Keep them.
- **A USD invoice can only be paid into a USD bank account / Undeposited Funds dance** (Zoho KB). An Indian exporter receives INR in HDFC. Our FX design must take "INR received for a USD invoice" as the normal case.
- **Write-off posts to Bad Debt and leaves GST as filed** (Zoho community). Keep our CN-based handling.
- **Leaving a 1% TDS shortfall as "balance due"** (Zoho AKS invoices, R-2094). Our TDS register with 26AS is better. Keep the rule "TDS = exact 1/2/10% auto, odd % asks a human".
- **Sales orders and delivery challans**: dead weight for SaaS seats.
- **Free-edit invoice numbers and hard delete**: we keep cancelled numbers (Rule 46). Keep that.
- **Recurring profile repeats one-time lines.** Users then hand-edit them out. Our "setup only on the first part" rule is right. Extend it to Monthly flex instead of blocking (see #6 below).

---

## 4. Top 10 improvements, ranked by value ÷ effort

### 1. Full ISO country list (impact 4, S)
**Spec.** Replace the 60-name `COUNTRIES` (`lib/gst/countries.ts:11`) with the full ISO 3166 short-name list (≈249). Keep India first and the current "common export" names as a pinned top group, with an alphabetical rest. Make the select searchable (type "Est" → Estonia). Keep the stored value as the display name so existing rows stay valid. Add an alias map for old values ("USA" → "United States"). Use the same list in leads and import CSV (`customers-csv.ts:135`).
**Test.** Unit: `COUNTRIES` includes "Estonia", "Cayman Islands", "Bangladesh"; no duplicates; India is index 0; `isExportSupply("Estonia") === true`. CSV import of `country=Cayman Islands` → overseas, no state needed. Browser: create Customer D (Estonia) and book R-2094's ₹10,758 Razorpay receipt.

### 2. Razorpay "Pay now" link on invoice email and dunning (impact 4, S)
**Spec.** Wire the already-built `lib/payments/payment-link.server.ts` (R-1608) into: the invoice send email, every dunning step (`api/cron/invoice-dunning/route.ts`, which today has UPI only), and a "Copy pay link" button on the invoice detail. The link amount = `invoiceAmountDue`. The webhook already auto-records Razorpay payments, so make sure it matches on `invoice_id` in the link notes. Keep UPI as a fallback when Razorpay keys are missing. The send goes through the autonomy chokepoint (already the design).
**Test.** Unit: link request amount = amount due in paise, and notes carry invoice_id. Webhook fixture `payment_link.paid` → payment recorded against that invoice, status Paid. Dunning dry-run output shows the link. Test keys only, localhost.

### 3. Un-reconcile also undoes the subscription the sale created (impact 4, S)
**Spec.** In `unreconcile_bank_receipt` (`migrations/…r1999_project_receipt_undo.sql:304-352`), when `p_undo_sale` is set and the quote created a subscription (or added seats), do one of two things. A subscription created by this quote with no other paid invoices is cancelled and its `subscription_billings` voided. A seat-add has its seats reverted (via the activity-log old value). Next, allow undo when the only other row is a TDS entry on this sale: reverse the TDS row inside the same transaction instead of refusing. The dialog lists every effect ("subscription X will be cancelled, 5 seats removed").
**Test.** SQL test: bank sale → subscription active → un-reconcile with undo → subscription cancelled, no pending parts, renewals list empty, TB balanced. Seat-add variant → seats back to the old count. TDS variant → TDS row gone, 26AS register clean.

### 4. Part-paid add-seats / renewal from reconcile gets its invoice on receipt (impact 4, S)
**Spec.** Extend `quotes.invoice_on_receipt` (`20261030123423…sql`) so an add-seats or renewal quote **paid from a bank credit** is invoiced on its first receipt even when short (balance due), dated the bank date. The service is already live, so the tax point has passed. Show "Invoice INV-x issued, ₹N still due" in the reconcile sheet. Do not change quotes sent before payment that the customer has not paid at all.
**Test.** SQL: add-seats quote ₹31,500, bank ₹30,000 → invoice ₹31,500 pending, paid ₹30,000, due ₹1,500, invoice_date = bank date. A second receipt of ₹1,500 → Paid, no second invoice.

### 5. Forex gain/loss on foreign-currency receipts (impact 5, M)
**Spec.** On a receipt against an invoice with `currency <> INR`, take **foreign amount received** (USD) + **INR credited** (bank). Invoice INR value = USD × invoice `fx_rate`. If USD received = USD due, settle the invoice in full and post `INR credited − INR invoiced` to a new "Exchange gain / loss (realised)" ledger account: other income or other expense, outside GST. Add `payments.currency, foreign_amount, fx_rate, fx_diff`. In the reconcile split, add `p_rest = 'fx'` next to `'advance' | 'round_off'`, allowed only for a foreign-currency invoice. Show it in P&L, the customer statement and the day book. Do not build period-end revaluation yet (item 26).
**Test.** SQL: Customer G case, USD 139 invoice @95.007 = ₹13,206, bank ₹12,976 → invoice Paid, FX loss ₹230 in P&L, `tb_money_events_balanced` green. Gain case: UAE USD 759 at 95.17 vs bank 93.55 → loss; reversed rate → gain. An INR invoice cannot use `'fx'`.

### 6. Export invoice end-to-end from a USD receipt (impact 5, M)
**Spec.** For a customer where `isExportSupply(country)`, the "new sale / generate invoice" path from a bank credit sets: currency = USD (or the quote currency), `fx_rate` = FBIL rate on **invoice date** (= sale or service date, not today), GST 0, treatment export without payment under LUT (refuse if `tenants.lut_number` is empty, with a link to Settings), place of supply 96 (other country), and B2B/export classification in GSTR-1 table 6A (EXPWOP), never B2C. The PDF already prints the LUT line. Together with #5, the receipt then settles in USD.
**Test.** Unit: export invoice builder → igst = cgst = 0, `gst_treatment = overseas`, `fx_rate` from FBIL on the invoice date. GSTR-1 report puts it in 6A, not B2CS. Browser: R-2094's 5 Aug USD 759 Customer E (UAE) → INV in USD, INR equivalent, LUT text.

### 7. Monthly flex + one-time lines in one sale (impact 4, M)
**Spec.** Remove the "Save disabled" block (R-2095 gap 2). Reuse the quarterly+setup rule: one-time lines go only on the **first** part invoice, and monthly parts after that carry the recurring lines only. "Then ₹X every month" excludes one-time lines (already fixed). The server check in `bank_credit_new_sale_quote` / `reconcile_bank_credit_split` (`20261028020622…sql:118` family) allows `one_time` lines next to a monthly-flex line, but still refuses annual + flex mixed.
**Test.** SQL: sale = 10 seats Monthly flex ₹264 + domain one-time ₹1,200, one bank credit = first month + domain → part 1 invoice = both lines, Paid. Part 2 (next month) = ₹264 × 10 only. Mixed annual + flex is still refused with a message.

### 8. Commitment stored on the subscription, separate from payment frequency (impact 4, M)
**Spec.** Add `subscriptions.commitment` (`annual` | `monthly_flex`) and keep `billing_cycle` as the payment frequency (yearly / half-yearly / quarterly / monthly). Back-fill from `firstLineCommitment(quote.line_items)` (`lib/billing/instalments.ts:369`). Show both on the subscription, renewal and quote ("Annual commitment · paid quarterly"). Rules then read the column, not the line JSON: annual can't drop seats mid-term; flex bills monthly only; half-yearly renewal-date check (R-2095). This also gives the credit-note rule (#9) and renewals one source of truth.
**Test.** Migration test: every existing sub gets a commitment and none is null. Unit: `canReduceSeats(annual, midTerm) === false`, `canReduceSeats(monthly_flex) === true`. Renewals Generate for flex = next month; for annual-quarterly = next quarter.

### 9. Credit note with lines → subscription seats and next part follow (impact 4, M)
**Spec.** Give the credit-note sheet an optional "lines" mode: pick invoice lines, qty and rate, and the GST split is computed (Zoho-style). Amount-only stays for discounts. When the reason is `seats_reduced` and the invoice belongs to a subscription with commitment `monthly_flex` (or end of term), offer "Also reduce subscription to N seats from <date>". This updates `subscriptions.seats` (activity log) and the amount of future unbilled parts. A partial CN on a part invoice lowers that part's due and must never make the part "Paid" by mistake.
**Test.** SQL: quarterly sub 10 seats, Q1 invoice, CN 2 seats × ₹3,150 with reduce ticked → sub seats 8, Q2 part amount = 8 seats, statement shows the CN, GSTR-1 CDNR row. Untick → seats unchanged.

### 10. Statement PDF + email for a date range (impact 3, S)
**Spec.** On the customer Statement tab, add From/To dates and a **PDF** and **Email statement** button, using `buildCustomerStatement` (`customer-statement.ts`) as the single source, so the opening balance is computed at From. Email goes through `sendCustomerEmail` with the PDF attached and the pay link from #2. Optional later: a monthly auto-send setting.
**Test.** Unit: opening balance at From = closing of all entries before From. The PDF total equals the on-screen closing. Email dry-run logs one `email_log` row with the attachment.

---

### Next in line (not top 10)
- Bank-charge field for wire receipts (#24, S): SWIFT fee on USD inward booked as an expense, not as due.
- Record TDS on an old reconciled receipt (#29 / R-2095 gap 12, S).
- ₹1 balance tolerance on a single receipt (#30, S): Q-0224.
- Price lists per customer group (#7, M): useful only once partner resellers buy.
- Customer invoice portal (#38, L): Pawan's / DMS panel area. Raise it as a cross-team request, don't build it here.
- E-invoice IRN (#39, L): only needed when AATO goes above ₹5 Cr. R-044 is waiting on the GSP decision.

### Ownership note
Items 3, 4, 5, 6, 7 and 9 touch reconcile (`components/features/banking/*`, banking SQL), which is Pardeep's area. Items 2, 8 and 10 touch invoices, subscriptions and customers. Since 19 Oct those count as Pardeep's too (memory: billing area buildable), but `nav.ts` / shared components / migrations still need Pardeep's OK. Item 38 is Pawan's area: cross-team request only.
