# Money rules — one place for GST, rounding, TDS, credit, billing in parts

Spec started 8 Nov 2026 (R-2593). The money rules were spread over ~2,500 board cards, so reviews
kept finding cross-feature money bugs (a seat credited twice through Change plan + Reduce seats,
R-2589). This page lists every decided money rule once: what it says, the card that decided it,
the code that enforces it and the test that proves it.

**How to use it**

- A card that touches money names the rules it touches (e.g. "touches C1, C5") in its liveLog or
  review, and runs their tests.
- A new money rule → add a row here in the same commit (next free id in its group), with its
  enforcing code and its test. A rule with no test goes in **Gaps** and gets a board card.
- A rule that changes → change its row here in the same commit; the card says why.
- Paths are from `production/` unless they start with `docs/`. Line numbers are as of 8 Nov 2026
  (anutech/manager-pardeep db5216527) — they drift; the function name is the anchor.
- SQL "enforced by" = the LATEST migration that defines the function (a later
  `create or replace` wins). Find the newest with
  `grep -l "create or replace function public.<name>" supabase/migrations/*.sql | sort | tail -1`.
- No customer names, amounts or GSTINs here (public repo — see `README.md`).

Older background: `docs/MONEY-FLOW-TEST-MATRIX.md` (the May–June 2026 money-spine audit, bugs #1–#35).
Who pays the online fee: `razorpay-fee.md`.

## GST — which head, which rate

| # | Rule | Card | Enforced by | Proved by |
|---|---|---|---|---|
| G1 | Head = buyer's state vs seller's state: same → CGST + SGST, different → IGST. A missing state code is filled from a checksum-valid GSTIN (first 2 digits); a typed state code wins. | audit #19/#20, R-373 | `src/lib/gst/place-of-supply.ts:54` `isInterStateSupply`; SQL `tg_invoice_snapshot_parties` (`supabase/migrations/20261106150544_r2536_zoho_import_party_as_filed.sql:49`) | `src/lib/gst/place-of-supply.test.ts`, `supabase/tests/invoice_state_from_gstin.test.sql` |
| G2 | Unknown state on either side → the tax invoice is refused (never CGST + SGST by default). | R-041, R-431 | `src/lib/gst/place-of-supply.ts:204` `supplyHead`; SQL `generate_invoice` (`supabase/migrations/20261030054246_r2095_invoice_date_receipt.sql:167`) | `src/lib/gst/place-of-supply.test.ts`, `supabase/tests/invoice_place_of_supply_and_s34.test.sql` |
| G3 | A supply to an SEZ unit / developer is always inter-state (IGST), even in the seller's own state. | R-1736 | `src/lib/gst/place-of-supply.ts:15` `treatmentIsAlwaysInterState`; SQL `tg_invoice_snapshot_parties` | `supabase/tests/customer_gst_treatment.test.sql` |
| G4 | Zero-rated (0% GST): customer outside India (export) or SEZ **without** payment of tax. SEZ **with** payment is taxed (IGST). | R-2515 | `src/lib/gst/place-of-supply.ts:100` `isZeroRatedSupply`; SQL `supply_is_zero_rated` (`supabase/migrations/20261105190824_r2515_sez_zero_rated.sql:31`) | `src/lib/gst/zero-rated-supply-r2515.test.ts`, `supabase/tests/r2515_sez_zero_rated.test.sql` |
| G5 | An empty / unknown country is domestic — never zero-rate a customer by accident. | money-spine audit | `src/lib/gst/place-of-supply.ts:85` `isExportSupply` | `src/lib/gst/place-of-supply.test.ts` |
| G6 | A 0% (export / SEZ-without-payment) invoice needs the LUT of **its own** financial year; without it the invoice is refused. | R-2444 | `src/lib/gst/export-lut.ts:110` `exportLutRefusal`; SQL `export_lut_refusal` (`supabase/migrations/20261104023601_r2444_lut_per_fy.sql:105`) | `src/lib/gst/export-lut.test.ts`, `supabase/tests/r2444_lut_per_fy.test.sql` |
| G7 | A 0% export invoice prints the LUT endorsement; an SEZ invoice prints the with / without payment endorsement (CGST Rule 46). | R-334, R-1742 | `src/lib/gst/export-lut.ts:34` `exportEndorsement`, `src/lib/gst/sez-endorsement.ts:21` `sezEndorsement` | `src/lib/gst/export-lut.test.ts`, `src/lib/gst/sez-endorsement.test.ts` |
| G8 | The buyer (GSTIN, state, country) is frozen on the invoice at issue; a later customer edit never changes an issued invoice's head. | R-043 | `src/lib/gst/place-of-supply.ts:151` `frozenParty`; SQL `tg_invoice_snapshot_parties` | `src/lib/gst/place-of-supply.test.ts` |
| G9 | A credit note we issue warns after the GST s.34(2) time limit (30 Nov after the invoice's FY). | R-335 | `src/lib/gst/credit-note-deadline.ts:20` `creditNoteDeadline` | `src/lib/gst/credit-note-deadline.test.ts` |

## Rounding

| # | Rule | Card | Enforced by | Proved by |
|---|---|---|---|---|
| D1 | Quotes and invoices are whole rupees: taxable rounded first, GST = round(taxable × rate ÷ 100), total = taxable + GST. | renewal GST fix (no card) | `src/lib/quotes/amounts.ts:14` `grossAmount` | `src/lib/quotes/amounts.test.ts` |
| D2 | GST is computed forward from the taxable, never backwards from a total; shown subtotal + GST === payable. | R-1438, R-1108 | `src/lib/quotes/amounts.ts:36` `gstBreakup` | `src/lib/quotes/amounts.test.ts` |
| D3 | Intra-state tax: CGST = round-half-up(tax ÷ 2), SGST = tax − CGST — the odd rupee goes to CGST; paise tax splits at the paise; a credit note mirrors the same heads. One rule for PDF, screens and GSTR-1. | WC-gst (30 Sep) | `src/lib/gst/tax-split.ts:32` `splitIntraStateTax` | `src/lib/gst/tax-split.test.ts`, `supabase/tests/invoice_tax_breakdown.test.sql` |
| D4 | A quote's stored amount must match subtotal − discount + GST within ₹1. | R-082 | `src/lib/quotes/amounts.ts:83` `QUOTE_AMOUNT_TOLERANCE` / `isQuoteAmountConsistent` | `src/lib/quotes/amounts.test.ts` |
| D5 | No ₹0 tax invoice, no payment against a ₹0 / empty quote. | audit #26/#27 | SQL `generate_invoice` (`supabase/migrations/20261030054246_r2095_invoice_date_receipt.sql:141`), `record_payment` | `supabase/tests/zero_amount_guards.test.sql` |

## Online payment (Razorpay) fee

| # | Rule | Card | Enforced by | Proved by |
|---|---|---|---|---|
| F1 | Who bears the fee, first match wins: bill waiver > customer absorbs > company default "We pay" > "we pay above ₹X" > customer pays. | R-2416 | `src/lib/payments/online-fee.ts:107` `onlineFeeFor` | `src/lib/payments/online-fee.test.ts` |
| F2 | The recovered fee is grossed up (f = r·B ÷ (1 − r·1.18)) and carries 18% GST as an incidental charge of the same supply. | R-2416 | `src/lib/payments/online-fee.ts:88` `onlineFeeAmounts`, `:30` `ONLINE_FEE_GST_PCT` | `src/lib/payments/online-fee.test.ts`, `supabase/tests/r2416_online_fee.test.sql` (18% bill only — 0% bill: gap R-2598) |
| F3 | A receipt's expected bank cash = amount − advance used − TDS − Razorpay fee; the fee is booked separately (gross, never net), also for Zoho-imported receipts. | R-2565, R-045 | SQL `supabase/migrations/20261107134000_r2565_razorpay_fee_receipts.sql`; `src/lib/integrations/zoho-books/receipts-import/plan.ts` | `supabase/tests/r2565_razorpay_fee_receipts.test.sql`, `src/lib/integrations/zoho-books/receipts-import/razorpay-fee.test.ts` |

## TDS

| # | Rule | Card | Enforced by | Proved by |
|---|---|---|---|---|
| T1 | Section rates: 194C 2% (1% individual / HUF), 194J(a) 2%, 194J(b) 10%, 194J royalty 10%, 194I 10% (2% plant), 194H 2%, 194A 10%, 194Q 0.1%. A rate off the table is flagged. | R-523, R-2338 | `src/lib/accounting/tds-rates.ts:27` `TDS_SECTION_RATES`, `:138` `checkTdsRate` | `src/lib/accounting/tds-rates.test.ts` |
| T2 | TDS base excludes GST: vendor side amount − GST shown on the bill; receipt side incl-GST × 100 ÷ (100 + the document's own rate, not a fixed 18%). | R-1119 | `src/lib/accounting/tds-rates.ts:100` `tdsBase`, `src/lib/accounting/tds-receipt.ts:54` `tdsBase` | `src/lib/accounting/tds-rates.test.ts`, `src/lib/accounting/tds-receipt.test.ts` |
| T3 | Thresholds per payee per FY: 194C ₹30,000 single / ₹1,00,000 yearly, 194J ₹50,000, 194I ₹6,00,000, 194H ₹20,000, 194A ₹10,000, 194Q only on the part above ₹50 lakh. | 30-day audit (TDS deductor), R-2320 | `src/lib/accounting/tds-deductor.ts:59` `TDS_THRESHOLDS`, `:117` `tdsDecision` | `src/lib/accounting/tds-deductor.test.ts` |
| T4 | 194J(a), 194J(b) and 194J royalty share ONE yearly threshold for a vendor. | R-2338 | `src/lib/accounting/tds-rates.ts:72` `tdsThresholdSection` | `src/lib/accounting/tds-194j-split-r2338.test.ts` |
| T5 | Payee without PAN → 20%. | 30-day audit (TDS deductor) | `src/lib/accounting/tds-deductor.ts:67` `NO_PAN_RATE_PCT` | `src/lib/accounting/tds-deductor.test.ts` |
| T6 | The app never picks a TDS section the owner did not set (vendor default or "No TDS"). | R-2343 | `src/lib/accounting/tds-rates.ts:67` `vendorTdsPrefill` | `src/app/(app)/accounting/prepaid/prepaid-tds-no-prepick-r2343.test.ts` |
| T7 | Below the threshold TDS is taken only with the owner's reason; the FY total counts earlier COGS + expense payments of the same threshold family. | R-2335 | `src/lib/accounting/bill-pay-tds.ts:37` `billPayTds`, `src/lib/banking/debit-pay-for.ts:275` `planTds`, `src/lib/accounting/vendor-tds-fy.ts:31` `vendorFyTdsTotal` | `src/lib/accounting/bill-pay-tds-r2335.test.ts`, `src/lib/accounting/vendor-tds-fy-r2335.test.ts` |
| T8 | A payment and the customer's TDS commit in ONE transaction; a replay never adds a second TDS row. | audit #22 | SQL `record_payment_with_tds` (`supabase/migrations/20261028082218_r2045_part_request_tds.sql:28`) | `supabase/tests/record_payment_with_tds_atomic.test.sql` |
| T9 | TDS on a vendor advance paid from the bank: advance gross = cash + TDS; TDS ≤ 20% of the gross; 194Q is refused on an advance. | R-1916 | SQL `reconcile_bank_debit_to_vendor` 12-arg (`supabase/migrations/20261108034643_r1916_vendor_advance_tds.sql:42`, guard `:93`) | `supabase/tests/r1916_vendor_advance_tds.test.sql`, `src/lib/banking/debit-pay-for-r1916.test.ts` |
| T10 | Applying a TDS-carrying advance to a bill credits that TDS on the bill (pro-rata if partly applied) — TDS is counted once, and the FY total counts it once. | R-2588 | SQL `vendor_advance_tds_take` / `vendor_advance_apply_core` (`supabase/migrations/20261108053501_r2588_vendor_advance_tds_credit.sql:42`, `:76`); `src/lib/accounting/vendor-tds-fy.ts:31` | `supabase/tests/r2588_vendor_advance_tds_credit.test.sql`, `src/lib/accounting/vendor-tds-fy-r2588.test.ts` |
| T11 | A receipt that pays only a PART of a document: TDS gross = paid share of the taxable, never above the taxable; when the TDS doesn't fit the rate on that part (±₹1), gross = TDS × 100 ÷ rate (what 26AS shows). Desk and bank paths give the same figure. | R-2538, R-2551 | SQL `bank_credit_tds_part_gross` / `bank_credit_tds_gross` (`supabase/migrations/20261107074500_r2538_tds_gross_part_paid.sql:38`, `:60`); `src/lib/accounting/tds-receipt.ts:77` `tdsPartGross` | `supabase/tests/r2538_tds_gross_part_paid.test.sql`, `supabase/tests/r2551_tds_gross_desk_multi.test.sql`, `src/components/features/quotes/record-payment-tds-gross-r2551.test.ts` |
| T12 | The Record payment sheet's default TDS on a part-paid document = remaining × taxable ÷ total at the rate, less TDS already booked at that rate. | R-2556, R-2560 | `src/lib/accounting/tds-receipt.ts:119` `tdsDefaultForPart` | `src/components/features/quotes/record-payment-tds-default-r2556.test.ts` |

## Credits (plan change, seat cut, credit notes)

| # | Rule | Card | Enforced by | Proved by |
|---|---|---|---|---|
| C1 | Credit only from money received: the unused value first LOWERS what the part's bill still asks for; only the rest (up to received − already credited) becomes the customer's credit. | R-2255 | `src/lib/subscriptions/change-credit.ts:83` `splitChangeCredit`; SQL `reduce_subscription_seats` (`supabase/migrations/20261108051500_r2589_plan_change_seat_guard.sql:954`) | `src/lib/subscriptions/change-credit.test.ts`, `supabase/tests/r2252_reduce_seats.test.sql` |
| C2 | Seat cut credit = unused days of the part × the per-seat part rate (+GST), as a credit note on the part's invoice — never more than was paid. | R-2252 | `src/lib/subscriptions/seat-reduction.ts:163` `seatReductionPreview`; SQL `reduce_subscription_seats` | `src/lib/subscriptions/seat-reduction.test.ts`, `supabase/tests/r2252_reduce_seats.test.sql` |
| C3 | A seat-day is credited ONCE: a plan-change quote is refused at payment when the subscription's seats / MRR / plan changed since it was priced; Reduce seats is refused while a plan-change quote is open. | R-2589 | SQL `record_payment` (`supabase/migrations/20261108051500_r2589_plan_change_seat_guard.sql:270`), `reduce_subscription_seats` (same file `:1029`); `src/lib/subscriptions/seat-reduction.ts:205` | `supabase/tests/r2589_plan_change_seat_guard.test.sql`, `src/app/api/subscriptions/[id]/reduce-seats/load-r2589.test.ts` |
| C4 | Change plan "Now" is refused while this term's bill has unpaid money (record that payment first, or change at renewal). | R-2227, R-2255 | `src/lib/subscriptions/change-plan.ts:237` `buildPlanChange` | `src/lib/subscriptions/change-plan.test.ts` |
| C5 | No mid-term downgrade: a new plan that costs no more than the unused current one changes at renewal; seats can't go below the current count in Change plan. | R-2205, R-2227 | `src/lib/subscriptions/change-plan.ts:194`, `:244` `buildPlanChange` | `src/lib/subscriptions/change-plan.test.ts`, `supabase/tests/r2227_plan_change.test.sql` |
| C6 | A credit note on a paid invoice opens a customer credit for the extra (spendable / refundable) and recomputes the invoice status; no note on a draft / void invoice. | R-1566, R-1563 | SQL `issue_credit_note_core` (`supabase/migrations/20261018171947_r1563_credit_note_refund.sql:62`) | `supabase/tests/r1563_credit_note_refund.test.sql`, `supabase/tests/issue_credit_note.test.sql` |
| C7 | A credit / debit note re-syncs the subscription's stored balance (no "₹X owed" after the invoice is settled). | R-2178 | SQL `sync_invoice_subscription_outstanding` (`supabase/migrations/20261031032023_r2178_credit_note_syncs_subscription.sql:49`) | `supabase/tests/r2178_credit_note_syncs_subscription.test.sql` |

## Billing in parts (monthly / quarterly / half-yearly)

| # | Rule | Card | Enforced by | Proved by |
|---|---|---|---|---|
| P1 | A seat on a split-billed subscription is priced at the PART's own rate (its share of the yearly price), not a whole-year share. | R-2226 | `src/lib/subscriptions/seat-part-rate.ts:51` `partShareOf` | `src/lib/subscriptions/seat-part-rate-r2226.test.ts` |
| P2 | Each part's gross = its taxable + GST, rounded per part (D1); what is due is the sum of parts fallen due, never the quote amount. | billing cycle (one invoice per period) | `src/lib/billing/instalments.ts:254` `instalmentGross` | `src/lib/billing/sync-instalments-r2104.test.ts` |
| P3 | An instalment payment is applied to the parts in order inside one RPC. | R-1564 | SQL `record_instalment_payment` (`supabase/migrations/20261018033137_r1564_instalment_payment.sql:66`) | `supabase/tests/r1564_instalment_payment.test.sql` |
| P4 | Monthly-flex lines may sit beside one-time lines (domain / setup); a one-time line has no term and is billed once, on the first part only. | R-2193 | SQL `quote_line_terms_mixed`, `quote_split_due` (`supabase/migrations/20261107233022_r2193_flex_with_one_time.sql:29`, `:204`); `src/lib/billing/instalments.ts:359` `firstLineCommitment` | `supabase/tests/r2193_flex_with_one_time.test.sql`, `src/lib/billing/flex-one-time-r2193.test.ts` |
| P5 | A split-billed subscription gets no whole-term renewal quote (the term rolls, the parts keep coming) and no Extend by years — both billed the year twice. | R-808, R-807 | `src/lib/renewals/split-billed-renewal.ts:35` `renewalQuoteBlockedReason`; `src/app/api/subscriptions/[id]/extend/route.ts:80` | `src/lib/renewals/split-billed-renewal.test.ts`, `src/app/api/subscriptions/[id]/extend/route.test.ts` |
| P6 | A quote says the real period the payment buys, never a blanket 12 months. | R-806 | `src/lib/quotes/service-period.ts:56` `quoteServicePeriod` | `src/lib/quotes/service-period.test.ts` |
| P7 | **Pending owner OK.** A part received short by no more than the small-difference limit shows "₹X short" with the R-2192 action (bank charge / small difference) — the owner confirms; the part is not silently closed. | R-2587 | `src/lib/quotes/instalment-status.ts` | `src/lib/quotes/instalment-status.test.ts` |

## Small differences and bank charges

| # | Rule | Card | Enforced by | Proved by |
|---|---|---|---|---|
| S1 | ₹1 apart is the same money (matching, auto-reconcile). | R-2192 | `src/lib/banking/same-money.ts:21` `sameMoney` (`ROUND_OFF_AUTO` = 1) | `src/lib/banking/same-money.test.ts` |
| S2 | ₹1 short on a receipt is booked as a settlement shortfall (Bank Charges); ₹1 over is a round-off gain — never a ₹1 advance on the customer. | R-2192 | SQL `bank_line_receipt_round_off` (`supabase/migrations/20261107205640_r2192_small_receipt_differences.sql:43`); `src/lib/banking/credit-pay-for.ts:342` `overIsRoundOff` | `supabase/tests/r2192_small_receipt_differences.test.sql`, `src/lib/banking/credit-pay-for-r2192.test.ts` |
| S3 | Bank / SWIFT charge on a wire: every item settled in full; the gap (≤ ₹5,000 and ≤ 10% of what was settled) is ONE Bank Charges expense; refused for an over-payment, a part-paid item or a bigger gap. | R-2192 | SQL `reconcile_bank_credit_split` (`supabase/migrations/20261107221154_r2577_bank_charge_server_guard.sql:31`) | `supabase/tests/r2192_small_receipt_differences.test.sql` |
| S4 | A bank charge is refused for a customer in India unless the line is an inward remittance whose amount × rate fits the credit (±₹1), and refused when the gap is TDS at a common rate. Server-side, not only on screen. | R-2577 | SQL `reconcile_bank_credit_split` (same file `:410`, `:513`); `src/lib/banking/credit-pay-for.ts:296` `bankChargeWire` | `supabase/tests/r2577_bank_charge_server_guard.test.sql`, `src/lib/banking/credit-pay-for-r2192.test.ts` |
| S5 | The bank charge expense is booked without input GST (`bill_type 'none'`); the bank's own GST invoice, if any, is a separate bill. | R-2192 | SQL `reconcile_bank_credit_split` (same file `:554`) | **none — gap R-2599** |
| S6 | One bank reference (UTR) is counted once: a payment replay is idempotent; the same reference on another quote is refused. | audit #1, R-1676 | `payments_idempotency_uq`; trigger `trg_payments_ref_once` (`supabase/migrations/20261019125620_r1676_payment_ref_once.sql`) | `supabase/tests/record_payment_idempotency.test.sql`, `supabase/tests/r1676_payment_ref_once.test.sql` |

## Write-offs

| # | Rule | Card | Enforced by | Proved by |
|---|---|---|---|---|
| W1 | A write-off is a LATER event on the invoice: same status, amount and paid amount, still in GSTR-1 (bad debt is not a credit note); it gets `written_off_at` + reason and every "still owed" reader treats it as 0. | R-1635 | SQL `write_off_subscription` (`supabase/migrations/20261023184545_r1635_write_off_invoices.sql:57`); `src/lib/payments/amount-due.ts:44` `invoiceAmountDue` | `supabase/tests/r1635_write_off_subscription.test.sql`, `src/lib/invoices/written-off.test.ts` |
| W2 | A small leftover (≤ ₹500, or exactly the customer's TDS) is closed by "Book as TDS" or "Write off small balance" — without cancelling the subscription. | R-2410, R-2421 | SQL `write_off_small_invoice_balance` (`supabase/migrations/20261103134813_r2421_leftover_part_paid_and_waive_lock.sql:24`); `src/lib/collections/small-leftovers.ts:28` | `supabase/tests/r2410_write_off_small_balance.test.sql`, `src/lib/collections/small-leftovers.test.ts` |

## Refunds

| # | Rule | Card | Enforced by | Proved by |
|---|---|---|---|---|
| X1 | A refund is never dated before the money it pays back was received (same day allowed). | R-2336 | SQL `r2336_refund_late_reason` (`supabase/migrations/20261101065250_r2336_customer_refund_not_before_receipt.sql:39`) | `supabase/tests/r2336_customer_refund_not_before_receipt.test.sql` |
| X2 | A partial refund of credit-note credit: up to the open credit-note credit on that invoice and never more than the payment's cash. | R-1682 | SQL `refund_credit_note_credit` (`supabase/migrations/20261101013533_r2322_bank_customer_refund.sql:502`) | `supabase/tests/r1682_partial_credit_refund.test.sql` |
| X3 | Refunding / deleting a payment also reverses the advance credit it opened (incl. credit already spent) and its TDS receivable; the receipt voucher number is never reused. | R-1567, R-1568 | SQL `refund_payment` (`supabase/migrations/20261101013533_r2322_bank_customer_refund.sql:141`) | `supabase/tests/r1567_refund_delete_payment_credit.test.sql`, `supabase/tests/refund_payment.test.sql` |

## Loans given

| # | Rule | Card | Enforced by | Proved by |
|---|---|---|---|---|
| L1 | Money the business lends is ONE store: `loans_given` (Accounting → Loans given, Balance Sheet "Loans given"). A money-out bank line reconciled as "I am GIVING a loan" becomes one loans_given row on that line (matched `loan_given` + loan id) — never a `balance_sheet_items` "Advance/loan given" line; booked once (an already reconciled or hand-typed line is refused); money back from a borrower with an OPEN loan is a receipt on that loan — book_bank_advance refuses it; Un-reconcile removes the loan (refused while a receipt is on the books). The same borrower in another case / spacing keeps the spelling already on Loans given. | R-2603 | SQL `record_loan_given_from_bank_out`, `book_bank_advance` (`supabase/migrations/20261108080000_r2603_reconcile_loan_given.sql`); undo `tg_loan_given_line_unmatched` (`supabase/migrations/20261107165630_r2570_bank_line_own_type.sql`); `src/components/features/banking/loan-given-out-fields.tsx` | `supabase/tests/r2603_reconcile_loan_given.test.sql`, `src/components/features/banking/loan-given-out-fields-r2603.test.tsx`, `src/lib/accounting/loans-given-r2603.test.ts` |

## Renewals

| # | Rule | Card | Enforced by | Proved by |
|---|---|---|---|---|
| N1 | A paid monthly renewal moves the date one month; annual moves twelve and keeps its MRR. | R-012 | SQL `record_payment` (`supabase/migrations/20261108051500_r2589_plan_change_seat_guard.sql:552`) | `supabase/tests/monthly_renewal_extends_one_month.test.sql` |
| N2 | One renewal quote per subscription term, made and linked in one transaction; paying a quote whose link was lost still renews its own subscription; a term already renewed is refused (never a second subscription). | R-1574 | SQL `create_renewal_quote` (`supabase/migrations/20261018162355_r1574_renewal_quote_once.sql:59`), `record_payment` | `supabase/tests/r1574_renewal_quote_once.test.sql` |
| N3 | A renewal payment never wipes the unpaid previous term. | R-1703 | SQL `record_payment` (`supabase/migrations/20261108051500_r2589_plan_change_seat_guard.sql:134`) | `supabase/tests/r1703_renewal_payment_keeps_prior_dues.test.sql` |
| N4 | A cart coupon is for the first payment only — the subscription's MRR (what renewals bill) comes from the line's renewal rate. | R-329 | SQL `record_payment` (same file `:108`) | `supabase/tests/record_payment_renewal_rate.test.sql` |

## Gaps (rule with no test)

| Rule | Gap | Card |
|---|---|---|
| S5 | No test asserts that the bank / SWIFT charge expense from `reconcile_bank_credit_split` carries no input GST (`bill_type 'none'`, `gst_paid` 0) — a change could start claiming ITC on it unnoticed. | R-2599 |
| F2 | The online fee always carries 18% GST (`ONLINE_FEE_GST_PCT`), also in the gross-up. On a 0% bill (export / SEZ without payment, G4) the fee is part of a zero-rated supply; nothing passes the bill's rate in and no test covers a 0% bill (razorpay-fee.md rule 3 says it must, before R-2417 charges it). | R-2598 |
