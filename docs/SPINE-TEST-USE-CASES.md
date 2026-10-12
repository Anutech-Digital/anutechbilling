# Money-Spine Test Use-Cases — lead → quote → pay → subscription → invoice → renewal

> Exhaustive list of test angles for the core flow, with concrete examples. Use this as the manual + automated test checklist before launch. Pair with `docs/MONEY-FLOW-TEST-MATRIX.md` (bug-focused) — this doc is scenario/use-case-focused.
>
> **Standing test fixtures (use these in examples):**
> - **Seller (reseller tenant):** Client A — Delhi, state code **07**, GSTIN `07AABCE1234D1Z9`.
> - **Customer A — Acme Corp:** Maharashtra, state **27** → **inter-state → IGST 18%**.
> - **Customer B — Delta Pvt Ltd:** Delhi, state **07** → **intra-state → CGST 9% + SGST 9%**.
> - **Products (real Google India retail, ₹/user/month, annual):** Starter **₹270**, Standard **₹864**, Plus **₹1380**, Enterprise **₹2400**. GST **18%**, HSN **998313**.
> - Each line item commitment ∈ {`monthly`, `annual_monthly`, `annual_quarterly`, `annual_half_yearly`, `annual_yearly`}. `monthly` = flex (no subscription); anything else = 1-year sub.
>
> **Legend:** ✅ should pass · 🔴 known bug (see matrix) · 🟢 fixed (has regression test) · 🧪 = good automated-test candidate.

---

## STAGE 1 — Lead capture & qualification

| ID | Scenario | Setup → Action | Expected |
|----|----------|----------------|----------|
| L-01 | Manual lead | Sales adds lead "Acme Corp", 25 seats | Lead `stage='new'`, owner set, tenant-scoped |
| L-02 | Public enquiry (buy page) | Visitor submits /buy/workspace, Standard, 10 seats | Lead `stage='new'`, source `buy-workspace`, **draft quote auto-created at catalog price** (10×₹864×12 +GST) 🟢 |
| L-03 | Public trial signup | Visitor starts 14-day trial, 20 seats | Lead `stage='trial'`, `trial_started_at`/`trial_expires_at` set, **3 follow-up tasks** (Day 7/12/14), NO quote (free) |
| L-04 | Public direct checkout | Visitor "Buy now" Standard 10 seats | Lead `stage='quote'`, quote `sent`/`awaiting`, Razorpay order created |
| L-05 | Stage transitions | Drag new→contact→demo→quote→won | Each persists; only valid transitions; `won` only via payment |
| L-06 | Lead marked lost | new/contact/demo → lost | Stage `lost`; stays out of active pipeline |
| L-07 | Trial expiry (no convert) | trial-expiry cron, `trial_expires_at` past | `trial_expired_at` stamped; **stage stays `trial`** (not auto-lost); 2 emails (customer + Pardeep) |
| L-08 | Duplicate enquiry same email | Same visitor submits twice | 2 leads OR dedup? (verify behaviour — currently 2 leads) 🧪 |
| L-09 | Contact → promote to lead | Imported contact promoted | New lead, source `from-contact:…`, double-promote blocked |
| L-10 | Missing/invalid fields | Enquiry with bad email/0 seats | Zod rejects 400, no lead created |
| L-11 | Plus/Enterprise enquiry | Enquiry Plus 50 seats | Plus auto-quotes (catalog ₹1380) 🟢; Enterprise = lead only (custom, no auto-quote) |

---

## STAGE 2 — Quote creation & sending

| ID | Scenario | Setup → Action | Expected |
|----|----------|----------------|----------|
| Q-01 | Build quote (lead-mode) | Quote builder from lead, add Standard ×10 | quote `draft`, line_items stored, number `Q-2026-27-NNNN` via RPC |
| Q-02 | Build quote (customer-mode) | Existing customer Delta, add Plus ×5 | quote linked to customer, GST = intra (CGST+SGST) |
| Q-03 | Multi-line quote | Standard ×10 + Voice add-on ×5 | subtotal = Σ(qty×rate); GST on subtotal |
| Q-04 | Discount applied | 10% line discount | taxable reduced; GST recomputed on discounted base |
| Q-05 | Coupon applied | Valid coupon code | `redeem_coupon` RPC; discount pre-GST; GST on net |
| Q-06 | Site-promo auto | Active 20%-off promo | auto-applied; reflected in total |
| Q-07 | GST intra-state | Customer Delta (07), seller (07) | **CGST 9% + SGST 9%** |
| Q-08 | GST inter-state | Customer Acme (27), seller (07) | **IGST 18%** |
| Q-09 | Commitment = monthly flex | Standard ×10, `monthly` | stored, but on pay → NO subscription (flex) |
| Q-10 | Commitment = annual_quarterly | invoices/yr=4 | rate stored as annual ₹/seat; display ÷4 |
| Q-11 | Send via email | "Send" → status sent | quote `sent`, PDF generated, `quote_send_log` row |
| Q-12 | Send PDF GST split | Inter-state customer | PDF must show **IGST** (not CGST/SGST) 🔴 (#19 — verify) |
| Q-13 | Quote expiry | `expires_date` past | status `expired` (or blocked at accept) |
| Q-14 | Zero/empty amount quote | amount = 0 or null | should be blocked from payment/invoice 🔴 (#26/#27) |
| Q-15 | Quote number per-tenant/FY | Two tenants same day | each gets own `Q-2026-27-0001` (per-tenant) — but **global PK risk** 🔴 (PO/INV collision) |

---

## STAGE 3 — Quote acceptance (customer-facing + operator)

| ID | Scenario | Setup → Action | Expected |
|----|----------|----------------|----------|
| QA-01 | Customer accepts (public page) | /quote/[id]/accept | status `accepted`, payment_status `awaiting`; sent→viewed on open |
| QA-02 | Operator "Mark accepted" | accept_quote RPC | quote accepted; lead→customer (RPC exists 🟢, was false-alarm #14) |
| QA-03 | Accept draft quote | open draft directly | 404 / blocked (only sent/viewed acceptable) |
| QA-04 | Accept expired quote | expires_date past | rejected; ⚠️ IST off-by-one-day 🔴 (#18) |
| QA-05 | Accept already-rejected | rejected quote | blocked |
| QA-06 | Reseller notified on accept | customer accepts | email to reseller — **TODO not built** 🔴 (#17) |

---

## STAGE 4 — Payment (`record_payment` RPC) — most angles

| ID | Scenario | Setup → Action | Expected |
|----|----------|----------------|----------|
| P-01 | Full payment, new prospect | Acme quote ₹X, lead linked, pay full | **lead→customer**, lead `won`, receipt voucher, payment row, **subscription created** (if annual), quote `accepted`+`received` |
| P-02 | Partial then balance | Pay 50%, then 50% (diff refs) | 2 payment rows, `partial`→`received`; ✅ both record 🟢 |
| P-03 | **Idempotent retry (same ref)** | Razorpay webhook fires twice, same `payment.id` | **1 payment row only**, no double sub/voucher 🟢 (fixed #1/#2) 🧪 |
| P-04 | Over-payment | Pay ₹X+5000 on ₹X quote | recorded; outstanding floored at 0 (refund path = TODO) |
| P-05 | Monthly-flex sale | commitment `monthly`, pay | customer created, NO subscription (flex) — verify intended 🔴 (#29) |
| P-06 | Annual sale, existing customer | Delta buys new annual plan | new subscription created |
| P-07 | **Add-seats** | Existing sub 10 seats, add 5 (is_add_seats), pay | sub seats→15, **NO duplicate sub** 🟢 (fixed #3/#4) 🧪 |
| P-08 | Add-seats partial pay | add-seats quote, partial | still no duplicate sub 🟢 |
| P-09 | Vendor inference | plan name "Google Workspace…" | sub.vendor = `google`; "M365"→microsoft; "Zoho"→zoho |
| P-10 | Payment methods | upi / razorpay / bank_transfer / cheque / cash | all accepted; invalid method → error |
| P-11 | Blank reference | empty p_reference | **error "reference required"** |
| P-12 | Zero/negative amount | p_amount ≤ 0 | **error "amount must be > 0"** |
| P-13 | Receipt voucher | first pay, no invoice yet | RV-2026-27-NNNN issued (CGST §31(3)(d)) |
| P-14 | No voucher if invoice exists | pay after invoice generated | no new RV; invoice path instead |
| P-15 | TDS deducted by customer | Customer pays net-of-TDS + records TDS | payment + tds_receivable; ⚠️ non-atomic 🔴 (#22) |
| P-16 | Service-role (webhook) | Razorpay webhook pays | runs in service mode, derives tenant from quote |
| P-17 | Authenticated (internal dialog) | Pardeep records cash payment | tenant from auth; recorded_by = user |
| P-18 | Simulation mode | No Razorpay keys + simulate | record_payment called directly, `[TEST]` emails |
| P-19 | Cross-tenant guard | tenant B tries to pay tenant A's quote | **rejected** (non-service caller) 🧪 |
| P-20 | Fully-paid, no customer resolvable | annual quote, no lead & no customer | currently **silent no-sub** 🔴 (#6) |
| P-21 | Missing/zero seats | line item qty 0 | seats=0 sub + wrong PO 🔴 (#28) |
| P-22 | Sibling-sub outstanding | customer has 2 subs, pay one | currently clobbers BOTH 🔴 (#5 — needs quote_id FK) |

---

## STAGE 5 — Subscription lifecycle & changes

| ID | Scenario | Setup → Action | Expected |
|----|----------|----------------|----------|
| S-01 | Sub created on annual pay | (see P-01/P-06) | active, mrr=round(annual/12), renewal_date=+1yr |
| S-02 | MRR/ARR calc | 10×₹864 annual | mrr ≈ ₹8,640, arr ≈ ₹1,03,680 (ex-GST) |
| S-03 | Add seats mid-term | +5 seats, 100 days left | pro-rata charge = annual×5×(100/365); seats+mrr updated, draft PO 🟢 |
| S-04 | Extend subscription | "add 2 years" | extension quote, on pay renewal_date += 24mo |
| S-05 | Extend on already-renewed sub | extend a `renewed` sub | ⚠️ may duplicate 🔴 (#16) |
| S-06 | Auto-suspend | grace lapsed, unpaid | status `paused`, renewal_state `suspended` |
| S-07 | Resume after pay | paused sub, renewal paid | status `active` |
| S-08 | Trial sub excluded from MRR | trial in flight | not counted in MRR/ARR |
| S-09 | Cancel subscription | operator cancels | status `cancelled`; out of renewals |
| S-10 | Outstanding tracking | partial-paid sub | outstanding_amount = expected − received |

---

## STAGE 6 — Invoice generation & advance adjustment

| ID | Scenario | Setup → Action | Expected |
|----|----------|----------------|----------|
| INV-01 | Generate from fully-paid quote | accepted+received quote | invoice `paid`, INV-2026-27-NNNN, net_payable=0 |
| INV-02 | Generate from partially-paid | 50% paid quote | invoice `pending`, net_payable = amount − advances |
| INV-03 | **Advance adjustment (Rule 53)** | RV advances frozen into invoice | `adjusted_advances` snapshot; net_payable = amount − Σadvances |
| INV-04 | **One invoice per quote** | double-click / retry generate | **2nd blocked** (unique index) 🟢 (fixed #7) 🧪 |
| INV-05 | Invoice auto-paid on balance | pay balance after invoice | invoice flips `paid` when receipts ≥ net_payable |
| INV-06 | GST split frozen | inter-state customer | invoice should freeze IGST split 🔴 (#24 — not frozen, recomputed) |
| INV-07 | 30-day advance clock | first_advance_at | invoice within 30 days (CGST §13(2)) |
| INV-08 | Zero-amount invoice | quote amount 0 | should block ₹0 "paid" invoice 🔴 (#26) |
| INV-09 | Sequence gaps | number consumed, insert fails | gap risk (Rule 46) 🔴 (#25) |
| INV-10 | Cross-tenant invoice id | 2 tenants | **global PK collision risk** 🔴 (new P0) |
| INV-11 | Aging buckets | overdue invoice | 0-30/31-60/61-90/90+ (⚠️ b90 dead-key bug) 🔴 |

---

## STAGE 7 — Renewal automation

| ID | Scenario | Setup → Action | Expected |
|----|----------|----------------|----------|
| R-01 | Cadence T-15 | renewals cron, 15 days to renewal | notice email + PDF quote, renewal_state `notice_sent` |
| R-02 | Cadence T-12/9/6/3/0 | each exact day | reminder_1..4 / final; tone escalates |
| R-03 | Grace period | T+1..+grace, unpaid | grace email (if grace>0) |
| R-04 | Cron re-run same day | cron runs twice in a day | **no duplicate email** (idempotency via log) 🧪 |
| R-05 | Missed cadence day | cron skipped a day (outage) | currently **permanently skips** that reminder 🔴 (#21) |
| R-06 | Renewal quote auto-created | T-15 fires | idempotent renewal quote, linked `renewal_quote_id` |
| R-07 | **Renewal paid → roll-forward** | customer pays renewal quote | renewal_date += 12mo, seats/mrr refresh, `renewed`, **NOT a new sub** 🧪 |
| R-08 | Partial renewal payment | pay 50% of renewal | sub NOT rolled forward until fully paid |
| R-09 | Renewal PDF GST split | inter-state renewal | should show IGST 🔴 (#20) |
| R-10 | Auto-renew OFF | sub auto_renew=false | excluded from cron |
| R-11 | Terminal-state protection | already `renewed`/`suspended` | not re-processed |
| R-12 | Concurrent renewal pay | two webhooks for renewal quote | only one roll-forward 🧪 |

---

## CROSS-CUTTING ANGLES (apply across all stages)

### X-A — GST correctness
- Intra vs inter-state driven by `state_code` (07 vs 27). Test every doc (quote, invoice, RV, renewal PDF) for correct CGST+SGST vs IGST.
- Rounding: ₹864×12×10 = ₹103,680; IGST 18% = ₹18,662.40 → ₹18,662; total ₹122,342. Verify paise rounding.
- HSN 998313 on all SaaS lines.

### X-B — Idempotency & retries
- Razorpay delivers the SAME webhook 2-5 times → exactly one effect (P-03) 🟢.
- Operator double-clicks "Record payment" / "Generate invoice" → one effect 🟢.

### X-C — Concurrency
- Two simultaneous payments same quote; two simultaneous invoice generations; two renewal webhooks. Expect locks/constraints prevent doubles.

### X-D — Multi-tenancy & RLS
- Tenant A can NEVER read/write tenant B's leads/quotes/invoices/payments/subs (RLS). 🧪 (TC-1008/1009 blocked on key rotation)
- Document numbers per-tenant; **but global text PKs (PO/INV/quote) collide across tenants** 🔴 (new P0).

### X-E — Document numbering
- Per-tenant, per-fiscal-year (Apr 1 reset), 4-digit, gap-free intent. Test FY rollover (Mar 31 → Apr 1 → 0001).
- Onboarding start-number escape hatch (migrating from Tally).

### X-F — Money-unit & edge
- Negative, zero, null, huge (10000 seats) amounts. Overflow. Rounding consistency (₹ vs paise — confirm unit).

### X-G — Payment channels
- UPI, card, netbanking → method maps to enum (upi/razorpay). NEFT/cheque/cash manual entry.

### X-H — Coupons / site-promos stacking
- subtotal → site-promo (auto) → coupon → recompute 18% GST on discounted base. Test: coupon value unit (₹ vs %), 100% coupon, expired coupon, usage limit.

### X-I — Partner / distributor
- Distributor invoices a customer linked to a child tenant → **auto-mirror vendor_bill** in child's books (idempotent), GST reverse-derived. Test the trigger.

### X-J — Notifications (best-effort)
- Emails (Resend) / WhatsApp fire but NEVER block the transaction; failure logged, money still recorded.

---

## END-TO-END HAPPY-PATH JOURNEYS (full worked examples)

### E2E-1 — Inbound prospect → paid annual (inter-state)
1. Acme Corp (Maharashtra) submits buy-page enquiry: Standard, 25 seats → lead `new` + draft quote (25×₹864×12 = ₹2,59,200 +IGST 18% ₹46,656 = **₹3,05,856**).
2. Pardeep reviews, sends quote → `sent`.
3. Acme opens link → `viewed`; clicks Accept & Pay → Razorpay.
4. Payment captured → webhook → `record_payment`:
   - lead→customer (Acme), lead `won`
   - receipt voucher RV-2026-27-0001
   - subscription active (25 seats, mrr ₹21,600, renewal +1yr)
   - quote `accepted` + `received`
5. Pardeep generates GST invoice → INV `paid`, IGST split, advances adjusted.
6. **Assert:** 1 customer, 1 subscription (25 seats), 1 payment, 1 invoice, lead won. Webhook retry → no change.

### E2E-2 — Renewal cycle (intra-state)
1. Delta Pvt Ltd (Delhi) sub renews in 15 days → cron sends notice + renewal quote (CGST+SGST).
2. T-12/9/6/3 reminders escalate. Delta pays at T-4.
3. `record_payment` roll-forward: renewal_date +1yr, mrr refreshed, `renewed`, NO new sub.
4. **Assert:** same subscription extended, 1 new invoice, no duplicate sub.

### E2E-3 — Mid-term add-seats
1. Acme (25 seats) needs +10 → add-seats flow: sub→35 seats, pro-rata quote (10×₹864×days-left/365 +GST).
2. Acme pays → `record_payment` (is_add_seats) → **no duplicate sub**, payment recorded, draft PO for +10.
3. **Assert:** still 1 subscription (35 seats), no second sub.

---

## ADVERSARIAL / FAILURE / SECURITY CASES

| ID | Angle | Expected |
|----|-------|----------|
| ADV-01 | Forged Razorpay webhook (bad signature) | rejected (HMAC verify, fails closed) |
| ADV-02 | Replay same webhook 10× | one effect (idempotent) 🟢 |
| ADV-03 | Tamper amount in client checkout | server prices from catalog, ignores client price 🔴 (catalog-vanish overcharge #13) |
| ADV-04 | Pay another tenant's quote | cross-tenant guard blocks 🧪 |
| ADV-05 | Accept quote via guessed ID | quote ID is the secret; only non-draft acceptable |
| ADV-06 | Mid-flight failure (insert fails after number consumed) | gap / orphan risk 🔴 (#9/#25) |
| ADV-07 | Concurrent identical add-seats | lost-update risk 🔴 (#33) |
| ADV-08 | CRON_SECRET unset | cron accepts unauthenticated 🔴 (launch blocker) |
| ADV-09 | Coupon in paise vs rupees | 100× mis-discount risk 🔴 (#31) |
| ADV-10 | Quote with no line items, paid | no sub, money recorded — verify guard |

---

## Priority for automated tests (🧪) — build first
1. P-03 idempotency 🟢 (done) · P-07/P-08 add-seats no-dup 🟢 (done) · INV-04 one-invoice 🟢 (done)
2. P-19/ADV-04 cross-tenant payment guard
3. R-07/R-12 renewal roll-forward (no dup) · R-04 cron idempotency
4. P-01/E2E-1 full happy-path (Playwright)
5. X-A GST intra/inter split (Vitest, pure)
