# Zoho Books audit — Purchases, Expenses, Banking (31 Oct 2026)

Auditor: read-only. Code read from `anutech/manager-pardeep` @ `cb40226d1` (31 Oct 09:08 IST) via `git show` / `git grep` — not the local worktree (that is on old `main`).
Zoho side: zoho.com help pages (sources at the end) + product knowledge where a page does not list details (marked *PK*). The live Zoho org was **not** opened in a browser this run.
Pains: board cards R-2094 (Oct/Sep/Aug HDFC reconcile log), R-2095 (gaps found while reconciling), R-2156 (COGS by service period).

Paths below are relative to `production/`. `src/…` = `production/src/…`; `mig/…` = `production/supabase/migrations/…`.

Verdicts: **we-better** · **parity** · **gap** (we have it, weaker) · **missing**. Impact 1–5 for *this* business (GW/M365 reseller, ~130 money-in lines/month on one HDFC account). Effort S ≤ 1 day, M 2–4 days, L > 1 week.

---

## 1. Capability table

### Banking — accounts, feeds, import

| capability | Zoho | ours (file:line) | verdict | impact | effort |
|---|---|---|---|---|---|
| Bank / cash / card / FD accounts | Bank, card, PayPal, clearing accounts; any CoA asset for FD | `src/components/features/banking/add-bank-account-form.tsx:66` (current, savings, OD, fixed_deposit, cash, credit_card); `src/app/(app)/accounting/banking/page.tsx:56-59,208` | parity | 2 | – |
| Direct bank feeds | Yodlee feeds + direct ICICI / Kotak / HSBC / SCB / Yes connected banking (ICICI new sign-ups paused) | Account Aggregator via Setu: `src/components/features/banking/connect-aa-dialog.tsx:2`, `src/app/api/aa/setu/consent/init/route.ts`, `…/fetch/[connectionId]/route.ts` | gap (AA covers HDFC which Zoho does not; but not live/scheduled yet) | 3 | M |
| Statement import (CSV/XLS/PDF) | CSV/TSV/OFX/QIF/CAMT/PDF import, field mapping, undo last import | `src/components/features/banking/import-statement-dialog.tsx:530` (csv/txt/xls/xlsx), AI PDF: `src/app/api/ai/extract-statement/route.ts`; dedupe `src/lib/queries/bank.ts:559-607`; undo import `src/lib/queries/bank.ts:737` | parity | 3 | – |
| Statement integrity check (balance chain, gaps, opening) | none — imports whatever is given | `src/lib/banking/statement-verify.ts`, `statement-chain-block.tsx`, `statement-check-card.tsx:28`, pre-opening lines struck out `import-statement-dialog.tsx:208-225` | **we-better** | 4 | – |
| Paise kept on bank lines | yes (2 decimals) | **rounded to rupees at import** `src/lib/queries/bank.ts:593-594`, `src/lib/banking/statement-parse.ts:115` | gap — root of "₹2,535 vs ₹2,535" (fixed locally in `src/lib/razorpay/settlement-match.ts:88-97`) and the ₹1 dues in R-2094 | 3 | L (S for a tolerance) |

### Banking — rules & auto-categorisation

| capability | Zoho | ours (file:line) | verdict | impact | effort |
|---|---|---|---|---|---|
| Rule criteria | Payee / Description / Reference: is, contains, starts with, empty; Amount =,>,<,>=,<=; ALL or ANY; per deposit/withdrawal | substring on narration + side only: `mig/20260822090000_txn_categorisation.sql:86-113`, `src/lib/banking/categorise.ts` | gap (no amount, no AND/ANY, no reference/payee) | 4 | S |
| Rule action | "Record as" a type (expense, transfer, owner, other income …) + account + paid-via + reference; **Recognise** (pre-fill) or **Auto-categorise** (book without a click) | category text only; "Rules only suggest a category at import… never rewrites lines" `src/app/(app)/accounting/banking/rules/page.tsx:1-16`; vendor guess also reads rules `src/app/(app)/accounting/banking/[id]/page.tsx:202-210`, `src/components/features/banking/debit-pay-for-section.tsx:86` | **gap — biggest speed lever** | 5 | M |
| Rule from a correction | prompt "create rule?" after manual categorise | candidates from narration minus noise tokens `src/lib/banking/rule-from-line.ts`, offered at import `import-statement-dialog.tsx:60-61,152` + learned vendor aliases `src/lib/queries/bank-debit-pay-for.ts:69` | **we-better** (smarter pattern proposal, live "Matches N" count `rules/page.tsx:97-112`) | 3 | – |
| Apply rules to existing unmatched lines | only new feed lines (*PK*) | not available (rules fire at import only) | gap (both) | 4 | S |

### Banking — reconcile (match, categorise, split, transfer, undo)

| capability | Zoho | ours (file:line) | verdict | impact | effort |
|---|---|---|---|---|---|
| One-click "Match found" | badge + Match button on the list | chip points, does not record: `src/components/features/banking/invoice-match-chip.tsx:1-8`; auto-reconcile server loop `src/lib/queries/bank.ts:958` → `auto_reconcile_bank_account` (`mig/20261024211000_r1867_auto_vendor_payment.sql`…`20261025151940`) with outcome panel `bank.ts:921` | parity (better explanation of "why left") | 4 | – |
| Categorise types | Withdrawal: expense, vendor payment/advance, transfer, card payment, owner drawings, refunds, reimbursement; Deposit: customer payment/advance, sales w/o invoice, transfer, interest/other income, expense refund, owner contribution, vendor refund (*PK*) | Who-tiles: customer, vendor, employee, owner, loan, tax, tax refund, transfer, other: `src/components/features/banking/reconcile-transaction-dialog.tsx:837-1117`; other income `other-income-section.tsx:20` | parity — plus GST/TDS-aware sale from a bank line (we-better), **minus "expense refund / vendor refund" (missing)** | 4 | – |
| New sale + subscription straight from a money-in line | no (sales without invoice only) | `credit-pay-for-section.tsx:102`, `useBookCreditAsInvoice` `bank.ts:779`; TDS 1/2/10 % detect `src/lib/banking/reconcile-suggestion.ts:48`; round-off ≤ ₹50 (R-2095) | **we-better** (core to the reseller flow) — but it is also why speed is ~50 lines/h: every line is a full sale form | 5 | – |
| Match one bank line to many records | multi-select matches summing to the line | money-out → many expenses `bank.ts:1052` (`reconcile_expenses_to_bank_txn`); money-in → many invoices `credit-pay-for-multi.ts`, `credit-pay-for-split.tsx:40` | parity | 3 | – |
| Many bank lines → one record ("Multi-select & Match") | yes, with a difference-adjustment line | not available (one line at a time) | missing | 2 | M |
| Difference / fee adjustment line while matching | "+ Create new transaction" then match both | round-off and TDS on money-in only; fee only inside Razorpay flow | gap | 3 | S |
| Own transfer, other side auto-matched | transfer type, matches the other account's line | `own-transfer-section.tsx:30`, `reconcile_bank_txn_as_transfer` `mig/20261030153511_r2095_other_income_fd_transfer.sql:1-40` (other side ±3 days else added) + `transfer-dialog.tsx:59` | parity | 3 | – |
| **Reversal pair (credit reverses a same-day debit already booked)** | categorise credit as *Expense refund* against the expense; or match deposit to withdrawal ("Include withdrawals") | **none** — R-2094 Aug: PhonePe ₹1,003 / ₹2,425 vs KFC debits already booked as expense; only path is un-reconcile + data repair | **missing** | 4 | M |
| Exclude / ignore a line (duplicate, ₹1 penny test, bank error) with restore | Exclude + Restore (*PK*) | none (only pre-opening-date rows at import) | missing | 3 | S |
| Bulk actions on many lines | Multi-select & match, bulk exclude/delete (*PK*) | none — list has no row checkboxes `src/app/(app)/accounting/banking/[id]/page.tsx` (no select state); dialog closes after each save | **missing** | 5 | M |
| Save & next / keyboard flow | pane on the right moves to next uncategorised line (*PK*) | dialog closes `onOpenChange(false)` on every section (`reconcile-transaction-dialog.tsx:1024-1308`) | gap | 4 | S |
| Undo (unmatch vs uncategorise-and-delete) | Unmatch keeps txn; Uncategorise deletes it | `unreconcile-dialog.tsx:99` asks keep/undo the sale (`unreconcile_bank_receipt(uuid, boolean)` `mig/20261027012329_r1999_project_receipt_undo.sql:359`); FD/transfer frees other side (r2095 mig) | parity, clearer words | 3 | – |
| Period reconciliation (closing balance, difference 0, undo by period) | Reconcile account per period, undo latest first | BRS report `src/app/(app)/accounting/banking/brs/page.tsx:27`, `src/lib/banking/brs.ts` + month close `src/app/(app)/accounting/close/page.tsx`; coverage tile `reconcile-coverage-tile.tsx:12` | parity (no explicit "period reconciled" record / lock per account) | 2 | M |

### Gateway, FD, cheques, cards, loans, petty cash

| capability | Zoho | ours (file:line) | verdict | impact | effort |
|---|---|---|---|---|---|
| Razorpay settlement net of fee → many payments | Razorpay clearing account; fee booked by hand as expense (KB article); payout = transfer to bank; forum: no split of aggregated settlement | `razorpay-settlement-section.tsx:1-60`, `src/app/api/banking/razorpay-settlement/route.ts`, `reconcile_razorpay_settlement` `mig/20261029060514_r2099_razorpay_settlement.sql:128` (payments linked, fee → Bank charges, GST → ITC) | **we-better** — but one line at a time, needs live key, missing payments must be built as sales first (R-2094: 5–7 settlements per month left open) | 5 | – |
| Batch settlement fetch for a month | n/a | not available | missing | 4 | M |
| FD sweep in/out | transfer to an FD asset account | own transfer to `fixed_deposit` + "New FD" inline `own-transfer-section.tsx:20-47` | parity | 3 | – |
| FD interest + TDS 194A | other income (interest) + TDS receivable by journal (*PK*) | interest → Other income `other-income-section.tsx:16-20`, `other_incomes` (whole rupees, `amount integer`) `mig/20261030153511…:31`; **no gross-up for bank TDS, no maturity / accrual** | gap | 3 | S |
| Sweep auto-detect | via rule → transfer | none (no rule action) — covered by rule actions (#4) | gap | 3 | – |
| Cheques (issue, PDC, bounce, print) | cheque payments + printing (India) | `cheque` only as a payment method `src/lib/payments/deposit-accounts.ts:23`; BRS knows manual lines as "cheques not presented" `brs.ts:1-15` | gap | 2 | M |
| Petty cash | cash account | cash account + "Paid from petty cash" on expense `add-expense-dialog.tsx:1735`; employee advances `src/app/(app)/accounting/advances` | parity | 2 | – |
| Credit cards | card account, card payment type, statement import | `credit_card` type, payable on BS `balance-sheet/page.tsx:224,412` | parity | 2 | – |
| Loans taken (EMI split principal/interest) | none (journals) | `business-loans/page.tsx:48`, `emi-repayment-section.tsx:1-36` (late fee, prepay, recompute) | **we-better** | 3 | – |
| Loans given / director loans (s185) | none | `loans-given/page.tsx:52`, `s185-step.tsx`, `src/lib/accounting/director-loans.ts` | **we-better** | 2 | – |

### Purchases & expenses

| capability | Zoho | ours (file:line) | verdict | impact | effort |
|---|---|---|---|---|---|
| Vendors + statement | vendor, portal, statement | `src/app/(app)/accounting/vendors/page.tsx:84`, `vendor-statement-view.tsx`, `src/lib/accounting/vendor-statement.ts` | parity (no vendor portal — fine) | 2 | – |
| Bills (GST, ITC, TDS, 194Q, HSN) | bills with TDS, RCM, ITC | `bills/page.tsx:77`, `add-vendor-bill-dialog.tsx` (HSN, OIDAR R-2056/R-2095), `mig/20261024230000_r1891_cogs_bill_194q.sql` | parity+ | 4 | – |
| Bill OCR / autoscan | Autoscan, email-in to Documents | AI read `src/app/api/ai/extract-bill/route.ts:32` (buyer-GSTIN check, proforma sanitise), from URL `bills/add-from-url.ts`, email inbox `src/app/(app)/purchases/inbox/page.tsx:25` | **we-better** (checks buyer GSTIN, OIDAR) | 3 | – |
| Google bill vs subscriptions check | none | `src/app/(app)/accounting/google-bill-check/page.tsx:73` | **we-better** (reseller-specific) | 4 | – |
| Bill service period → COGS month | none (bill date) | R-2156 todo | gap (both) | 4 | M |
| Recurring bills / recurring expenses | yes (profile, auto-create, auto-pay) | none (`git grep recurring` in bills/expenses: 0 hits) | missing | 3 | M |
| Vendor credits (credit memo, apply to bill, refund) | yes | none — `debit_notes` is sales-side GST only (`src/app/(app)/accounting/gst/report.ts:149`); ledger mentions concept `src/lib/accounting/ledger.ts:11` | **missing** (Google/Microsoft credit memos for seat cuts are routine for a reseller) | 4 | M |
| Payments made (incl. pay many bills) | yes | `bill-payments/page.tsx:32`; from bank `debit-pay-for-section.tsx`, `allocateOldestFirst` `src/lib/banking/debit-pay-for.ts:292`, TDS plan `:235` | parity | 3 | – |
| Bulk vendor payouts + bank file + approval | ICICI / Kotak connected payouts | Payment runs with approval + bank file `src/app/(app)/accounting/payment-runs/page.tsx:1-49` (MSME 45-day ordering) | **we-better** (bank-agnostic, MSME) | 2 | – |
| Vendor advances (apply / undo) | yes | `src/lib/queries/vendor-advance.ts:46,65`, `expenses/advance-on-bill.tsx`, `mig/20261025164002_r1913_apply_vendor_advance.sql:59` | parity | 3 | – |
| Purchase orders → bill | yes, with approval | `src/app/(app)/purchase-orders/page.tsx:45`, `create-bill-from-po-dialog.tsx:75` | parity | 1 | – |
| Expenses (itemised, GST, petty cash) | yes | `src/app/(app)/accounting/expenses/page.tsx:90`, `add-expense-dialog.tsx`, AI fill, TDS 26Q `expenses/tds-26q.ts` | parity+ | 3 | – |
| Expense claims / reimbursements | Zoho Expense (separate app) | public claim link `src/app/(public)/expense-claim/page.tsx:22`, `reimbursements/page.tsx:43`, `my-expenses` | **we-better** (built in) | 2 | – |
| Mileage | rates per km, GPS (via Zoho Expense) | none (keyword only `src/lib/queries/expenses.ts:61`) | missing | 1 | S |
| Prepaid expenses / advances amortised | journals | `src/app/(app)/accounting/prepaid/page.tsx:48` | **we-better** | 2 | – |

---

## 2. Where Zoho's UX is clearly better (copy the idea)

1. **The reconcile pane stays open.** You categorise, the next uncategorised line loads. Ours closes the sheet after every save, so each line costs an extra click and you lose your place in the list.
2. **Rules that book.** "Auto-categorise" means a repeating vendor line (Google Play, Facebook, rent, SaaS, salary) never needs a click again. Our rules only label a category and seed the vendor guess.
3. **Exclude.** You can drop a penny test, a duplicate, or a bank-side error from the work list in one click, and bring it back with Restore. Today those lines sit on our "Unmatched" list for ever and spoil the 0-left goal.
4. **Expense refund as a deposit type.** A reversal credit gets booked against the original expense, with no need to undo the original.
5. **Multi-select across the list.** You can tick lines and act on all of them at once.

## 3. What NOT to copy

- **The clearing account for Razorpay.** Zoho has you book the fee by hand and treat the payout as a transfer. Our one-click settlement (payments + fee + GST ITC) is better. Keep it.
- **Auto-categorise with no preview and no undo-all.** Zoho will not let you delete an auto-categorise rule until you switch it back to "recognise". Ours should always show "this rule will book N lines" first, and should keep a rule-run id so one click can undo a whole run.
- **"Uncategorise" that silently deletes the transaction.** Our keep-or-undo-the-sale question (`unreconcile-dialog.tsx`) is clearer. Keep it.
- **Importing a statement with no balance-chain check.** Ours refuses gaps and wrong openings. Keep it.
- **A separate expense app.** Keep claims and mileage inside the app.

---

## 4. Staging pains → root cause

| pain (R-2094/R-2095) | root cause in our app | fix (§5 #) |
|---|---|---|
| About 50 lines/hour with workarounds | Most money-in lines are a *new sale* (customer + subscription + invoice). That form is the real cost, and on top of it the sheet closes after each save, there is no bulk action, and the rules never book | #1, #4, #5 |
| PhonePe reversal of a KFC debit that is already an expense | No refund/reversal type; the only path is un-reconcile plus a data repair | #7 |
| Razorpay settlement: one line at a time, needs the live key, missing payments built by hand | Settlement fetch works one line at a time; no month batch; no "create payment from Razorpay data" | #6 |
| "₹2,535 but ₹2,535", ₹1 left due (AKS Q-0224), ₹230 FX gap | Bank lines are rounded to rupees (`bank.ts:593`); there is no ₹1 tolerance and no FX gain/loss on receipts | #2 |
| FD sweep and interest ₹88 went to "Other/manual" | Fixed in R-2095 (transfer to FD, Other income). Still open: TDS 194A gross-up, sweep auto-detect | #8, #4 |
| Repeating vendors re-entered every month | A rule is only a category; there is no vendor/GST/TDS action | #4 |
| SEED ₹1 penny test left unmatched | There is no Exclude | #3 |

---

## 5. Top 10 improvements (ranked by value ÷ effort; S=1, M=2, L=3)

### 1. "Save & next" in the reconcile sheet — impact 4, S (4.0)
**Build:** Every section's `onDone` moves to the next unmatched line in the current filter order instead of closing the sheet (`reconcile-transaction-dialog.tsx` already receives `onOpenChange`; pass `onDone(next)` from `banking/[id]/page.tsx`, which owns the filtered list). Add keys: `J`/`K` for next/previous line, `Enter` to accept the top suggestion, `E` for Exclude (#3), `Esc` to close. Keep the scroll position of the list. Show a counter in the header, e.g. "Line 14 of 58 unmatched".
**Test:** RTL. Render the page with 3 unmatched lines, save line 1 as Other income, and expect the sheet title to show line 2 and the list count to be 2. Pressing `J` on the last line keeps the sheet on the last line. Browser: time 20 Aug lines before and after on staging.

### 2. ₹1 tolerance + FX/round-off on every match — impact 4, S (4.0)
**Build:** One helper, `sameMoney(a, b, tol=1)`, in `lib/banking/`, used by `suggest_bank_transaction_matches`/auto-reconcile SQL (`abs(diff) <= 1`), by the invoice-match chip and by credit-pay-for. When the difference is ≤ ₹1, book it to round-off (`bank_receipt_round_offs` already exists, `mig/20261029054707_r2098_bank_credit_split.sql:62`). For a foreign-currency invoice, show a choice to book the gap as "Exchange loss/gain" instead of leaving it due. Longer term (L): store paise on `bank_transactions` and stop rounding at `bank.ts:593`.
**Test:** pgTAP. A bank line of ₹13,105 against an invoice of ₹13,106 auto-reconciles with a ₹1 round-off row, and a gap of ₹2 does not. Unit: `sameMoney(253473/100, 2535)` is true.

### 3. Exclude / Restore a line — impact 3, S (3.0)
**Build:** Add `matched_to_type = 'excluded'` plus `exclude_reason` (duplicate, penny test, bank error, not ours) and `excluded_by`. It is not counted in Unmatched or coverage. In BRS it is listed as "excluded by you" with its reason, so the books still tie. Add an "Excluded" filter tab with a Restore button. Bulk-capable (#5).
**Test:** pgTAP. Exclude, and the unmatched count drops by 1. The BRS statement balance is unchanged and the line appears in the excluded section. Restore brings the line back to unmatched. A viewer role cannot exclude (`rules-write-roles` pattern).

### 4. Rules that act (recognise / auto-book) + run on existing lines — impact 5, M (2.5)
**Build:** Extend `txn_category_rules` with:
- `match_all bool`;
- `conditions jsonb` (field: narration/reference; op: contains/starts/equals; amount =,<,>,between);
- `action` (expense | vendor_payment | transfer | other_income | owner | ignore);
- `action_params` (vendor_id, category, gst_rate, itc, tds_section, to_account_id, income head);
- `mode` (`suggest` | `auto`);
- `priority`.

Import and a new "Run rules on unmatched" button call one SQL function, `apply_bank_rules(account, dry_run)`. It returns the lines it would book (dry run) and then books them through the existing RPCs (`book_bank_txn_as_expense`, `reconcile_bank_txn_as_transfer`, `book_bank_credit_as_other_income`) under a `rule_run_id`. Add "Undo this run". The rule from line candidates (`rule-from-line.ts`) becomes "Save as rule" at the foot of every section. Seed rules for FD sweep ("SWEEP", "TRF TO FD" → transfer to the FD account), Google Play, Facebook, salary.
**Test:** pgTAP. An auto rule "PAYUFACEBOOK, debit, expense Advertising 18 % ITC" books 3 of 3 lines and leaves a credit line containing the same text untouched. Dry run writes 0 rows. Undoing the run restores 3 unmatched lines and deletes 3 expenses. Two rules on the same line: priority wins, deterministically.

### 5. Bulk select + bulk action — impact 5, M (2.5)
**Build:** Row checkboxes on `banking/[id]/page.tsx` (shift-click for ranges). A sticky bar offers: Exclude · Own transfer to… · Other income (head) · Expense (vendor + category + GST) · "Make rule from selection". One RPC per action that takes `uuid[]`, all-or-nothing, and reports each line it refused. Limit 200 lines per call. Respects `canWriteMoney`.
**Test:** pgTAP. Bulk-book 5 debits as expense: 5 expenses, 5 reconciled. If one line was already matched by someone else, nothing is written and the reply names that line. RTL: selecting 3 rows shows "3 selected · ₹x out".

### 6. Razorpay month batch + "create payment from Razorpay" — impact 5, M (2.5)
**Build:** On the account page, add a button "Fetch Razorpay settlements (month)". The server fetches `/v1/settlements` for the range, pairs each with the Razorpay-named bank line by UTR, else by `sameRupees`, and shows one table: settlement | bank line | payments found / missing | fee. "Reconcile all ready" runs `reconcile_razorpay_settlement` for each line that has no blockers. For a missing payment, pre-fill the new-sale form with the Razorpay payment's email, contact, notes and amount, plus the order id. Auto-reconcile should also try settlement lines.
**Test:** Route test with a mocked Razorpay API: 3 settlements, 1 with an unknown payment. Expect 2 ready, 1 blocked with "Record payment pay_X", and "Reconcile all" reconciles exactly 2 and books 2 fee rows.

### 7. Reversal / refund of an earlier line — impact 4, M (2.0)
**Build:** In the reconcile sheet, add "Reverses an earlier line" for both sides. It suggests opposite-side lines with the same amount within ±7 days, matching narration tokens (UPI ref, merchant). Three outcomes:
- (a) Neither line is booked: pair them as `matched_to_type='reversal'` (net 0, no P&L).
- (b) The original is booked as an expense or bill payment: book this line as an **expense refund** (negative expense row linked to the original, so GST ITC is reversed proportionally) without touching the original.
- (c) The original is a customer receipt: "payment returned", which reopens the invoice due.

**Test:** pgTAP for PhonePe ₹1,003 credit against KFC ₹1,003 debit already booked: P&L food falls by ₹1,003, the original expense is unchanged, and both lines are reconciled. Un-reconciling the credit removes only the refund row. Case (a) leaves the P&L and balance sheet unchanged.

### 8. FD interest with TDS 194A + FD register — impact 3, S/M (2.0)
**Build:** Other-income "Interest received" gets a "Bank deducted TDS ₹__" field. Book the gross amount as income and the TDS as TDS receivable (feeds `tds-receivable` / 26AS check). Make `other_incomes.amount` hold paise, or round only at display. Add fields to the FD account: principal, rate, start and maturity dates. Show maturity-due on the banking page and the accrued interest at year-end on the balance sheet.
**Test:** pgTAP. A ₹88 credit with ₹10 TDS gives P&L interest 98 and TDS receivable 10. On the FD account, sweep-in plus interest makes the balance equal principal plus interest.

### 9. Vendor credits (credit memo → apply to bill / refund) — impact 4, M (2.0)
**Build:** Add a `vendor_credits` table (vendor, date, number, lines with HSN/GST, ITC reversal, optional link to the original bill), plus `apply_vendor_credit(bill, amount)` and an "undo" that mirrors `apply_vendor_advance`. A vendor refund arriving on a money-in line is matched under Vendor → "Refund of credit". GST: ITC is reduced in the month of the credit. Google and Microsoft credit memos for seat reductions come through `extract-bill` as `doc_type = credit_note`.
**Test:** pgTAP. A ₹10,000 bill and a ₹2,000 credit applied leave ₹8,000 due and ITC lower by ₹360 at 18 %. Undo restores both. A refund line of ₹2,000 matched to an unapplied credit closes it.

### 10. Recurring bills / expenses — impact 3, M (1.5)
**Build:** Add `recurring_purchases` (vendor, template lines, frequency, next date, end, mode `draft` | `auto`). A daily cron creates a draft bill or expense. A draft is matched by the auto-reconcile vendor rule when the bank debit arrives. Use it for rent, Zoho, internet and salary-like fixed costs. Google bills stay real bills (amounts vary) but get a *reminder* if not entered by day 10 (ties into R-2156 COGS estimates).
**Test:** Unit test on next-date maths (31st → month end, IST). pgTAP: the cron run makes exactly one draft per profile per period, is idempotent on re-run, and creates nothing after the end date.

**Next in line (not in the top 10):** cheque register with PDC, bounce and print (impact 2, M); many lines → one record multi-match (2, M); mileage rates on expense claims (1, S); per-account period-reconciled lock (2, M); scheduled AA fetch (3, M).

---

## Sources
- [Zoho Books — Transaction Rules](https://www.zoho.com/us/books/help/banking/transaction-rule.html)
- [Zoho Books — Auto categorisation KB](https://www.zoho.com/us/books/kb/banking/auto-categorization-of-transactions.html)
- [Zoho Books India — Banking help index](https://www.zoho.com/in/books/help/banking/)
- [Zoho Books India — Match & Categorise](https://www.zoho.com/in/books/help/banking/matching-transactions.html)
- [Zoho Books India — Reconciliation](https://www.zoho.com/in/books/help/banking/reconciliation.html)
- [Zoho Books India — Integrate Razorpay](https://www.zoho.com/in/books/help/online-payments/razorpay.html), [Record Razorpay fees KB](https://www.zoho.com/in/books/kb/gst/record-razorpay-transactionfees.html), [Community: Razorpay import](https://help.zoho.com/portal/en/community/topic/not-able-to-import-transactions-from-razorpay)
- [Connected Banking with ICICI](https://www.zoho.com/in/books/help/online-payments/icicibank-integration.html), [Kotak integration](https://www.zoho.com/in/books/help/online-payments/kotak.html)
