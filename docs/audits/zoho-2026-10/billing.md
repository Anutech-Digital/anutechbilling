# Zoho BILLING vs our app (ResellerOS): subscription-billing audit

Auditor: zaudit-billing (read-only). Date: 31 Oct 2026, 07:57–08:15 UTC.
Sources:
- **Zoho Billing org** (subscriptions.zoho.in, tab-5). It is read-only and the free trial is over. The org is **almost empty**: 0 plans, 0 subscriptions, 8 test customers, 4 paid invoices and 5 items. So Zoho *flows* come from its settings screens, its forms (opened and cancelled, nothing saved) and the zoho.com/in/billing help pages (proration, dunning, advance billing, unbilled charges, renewal pricing, manual renewal, MRR/ARR, revenue recognition, subscriptions).
- **Our app** on localhost:3001 (E2E Test Co, local data, nothing saved): Subscriptions list and drawer, Manage seats preview, Renewals, Invoices, a customer page, the Dashboard and SaaS Metrics.
- **Code**: `anutech/manager-pardeep` @ 96c9b4645 (31 Oct 13:19 IST), read with `git show` / `git grep`.
- **Board cards** read: R-049, R-1608, R-2044, R-2154, R-2178, R-2213..R-2224, plus plan.md and sales.md, so nothing here is repeated.

---

## Summary for Pardeep (10 lines)

1. Zoho Billing ka asli fayda: **har subscription ka status khud banta hai** (Live, Non-renewing, Past due, Unpaid, Paused, Expired, Cancelled). Hamare yahan "Active" hi dikhta hai, chahe paisa baaki ho ya customer ne mana kar diya ho.
2. **"Customer renew nahi karega"** record karne ka koi button nahi hai. DB mein `auto_renew` hai aur cron use maanta bhi hai, par UI se koi set nahi kar sakta. Zoho mein "Cancel on next renewal" se ye ek click hai.
3. **Seats badhane (pro-rata) ka hisaab part ke rate se match nahi karta.** ₹270/seat/month wale part mein 30 din ka seat ₹266 lagta hai, 31 din ka ₹275. Zoho part ke apne rate × bache din lagata hai.
4. **Google plan upgrade (Starter → Standard) mid-term nahi ho sakta.** "Upgrade plan" sirf Support plan par hai. Zoho mein Change plan pe purane plan ka credit aur naye plan ka pro-rata invoice ek saath ban jaata hai.
5. **"Correct details" se seats, MRR aur status bina kisi bill ya credit note ke badle ja sakte hain.** Paisa aur subscription alag ho jaate hain. Zoho mein amount hamesha plan × quantity se banta hai.
6. **SaaS Metrics mein ek hi page par do MRR hain** (₹2,04,322 aur ₹2,05,012). Ek one-time line (Email migration ₹417) bhi MRR mein gin li gayi hai. Expansion aur contraction track nahi hote.
7. Renewals page par ek hi subscription par **"Renewed" bhi likha hai aur "Call within 24 hours" bhi**. Monthly flex ka agla mahina bhi "renewal" ki tarah urgent dikhta hai.
8. **Baaki paisa bina due date ke dikhta hai.** Payment request (R-2044) par "₹1,632 due · No payment due date" aata hai, aur customer page par "Unpaid invoices ₹0" bhi likha hai.
9. Hum Zoho se aage hain in cheezon mein: commitment aur payment frequency alag, invoice sirf paise par (R-2044, jaise Zoho ka early-access "Advance Payment Request"), TDS/26AS, bank se sale, margin guard aur Google bill match.
10. **Sabse pehle bananu:** non-renewing, part-rate pro-rata, Google plan change, Correct-details lock, ek MRR function, aur due date har request par. Ye sab S/M size ke hain.

---

## Per area

### 1. Subscriptions list + detail, change subscription
**Zoho.**
- Statuses: Live, Trial, Future, Non-renewing (cancel on next renewal), Past due (renewal invoice overdue, during the dunning period), Unpaid (dunning over, final action "Do nothing"), Paused, Expired (cycles over), Cancelled. All are system-derived, never typed.
- Detail page: Next Billing Date, which you can edit with a reason and a choice between "charge for the extension" or "only move the date".
- Edit takes "When to apply changes": **Immediately** (prorated invoice + credit note), **End of term**, or **Scheduled date**. An immediate change cancels any pending scheduled change.
- More menu: Add Charge, Add one-time addon, Pause (now / scheduled / next renewal), Resume, Cancel (**immediately** or **on next renewal**), Reactivate.
- Subscriptions are numbered (SUB-xxxxx).

**Ours.**
- List: Active / Expiring / Suspended / Ended tabs, plus a cycle filter (Annual · paid yearly, Annual · paid monthly/quarterly, Flexible, No term). The list shows MRR, margin, Google seats vs ours ("NOT CHECKED") and the owed amount.
- Drawer: Manage seats, Extend term, Statement, Open customer, Correct details. It shows Status, Seats, MRR and Owed, plus a full **billing schedule** (every part with the period it covers, this term and next term), Contract changes, and a late-fee toggle. At the bottom: Cancel subscription (last day + reason + offer to issue a credit note for the unused part), and Delete (wrong entry).

**Gaps.**
- **No Non-renewing.** `auto_renew` exists and `api/cron/renewals/route.ts:177-199` lapses `auto_renew=false` subs, but no screen sets it. The only grep hits for `auto_renew` writes are `auto_renew: true` in add/import.
- **No Past due / Unpaid status.** Customer A shows "Active" with ₹1,632 owed.
- **No mid-term plan change for licences.** `sub-drawer-actions.tsx:53` "Upgrade plan" is only wired for support subs (R-2073 `upgrade-support-dialog.tsx`).
- **No "apply at end of term / on date".** Seat cuts for Flexible and plan changes at renewal are typed by hand in Correct details.
- **Correct details is a second, money-free way to change seats, MRR and status.** `edit-subscription-dialog.tsx:1-8` says it "does NOT re-bill". It also has `STATUSES = active/paused/expired/cancelled` as a free select (line 61), and MRR is a typed field (line 421) next to seats (line 418). That breaks the one-fact-one-place and one-way rules.
- **No subscription number.** The list has identical-looking rows (E2E Customer, r826-quarterly.test, Starter 57 seats, ₹15,200 appears 3 times) with nothing to tell them apart.

**Our advantage.**
- Commitment shown separately from payment frequency ("Annual commitment · Payment frequency: Monthly").
- The billing schedule shows the exact period each part covers. Zoho shows only the next billing date.
- Margin and Google seat match on the list.
- Cancel offers a credit note on the open invoice (CGST s.34).

### 2. Plans / addons / coupons / price lists
**Zoho.**
- Plan = Product + name + code + **Billing Frequency** (every N weeks/months/years) + **Billing Cycles** ("Auto-renews until cancelled" or N cycles, which makes it term-based).
- Pricing model: Flat / Per unit / Volume / Tier / Package.
- Unit name, Free Trial (days), **Setup Fee** (with its own income account), SAC, intra/inter GST rates.
- "Show in pricing widget", "Allow customers to switch to this plan from the portal", Quantity restriction.
- Addons (recurring or one-time) and Coupons (flat or %, duration). Price lists. Renewal pricing per subscription: **Retain existing / Use latest / Markup % / Markdown %** (the last two are early access).

**Ours.**
- Catalogue items with a margin floor against wholesale cost (better). Commitment (Annual / Flexible) and payment frequency are chosen on the quote line, and the setup line goes only on the first part.
- No tier or volume pricing, and no trial on licences.
- Coupons only in checkout. No price lists (sales.md #7).

**Gap.** No **renewal pricing rule**. When Google raises prices, there is no per-subscription choice between "keep the old price" and "use the new catalogue price". This is a pricing decision, so it needs Pardeep. Tier/volume pricing is not needed for GW/M365 resale today.

### 3. Invoices from subscriptions, dunning, failed payment
**Zoho.**
- Anniversary or **Calendar billing** (bill everyone on the 1st, with a prorated first cycle).
- **Consolidated billing**: one invoice per customer for all subscriptions, with the others prorated to the first one's date. It can be set per customer.
- "Redeem credit notes for subscriptions" and "Apply excess payments to subscriptions" are settings: credits auto-apply at renewal.
- **Unbilled charges**: hold one-time charges and invoice them later or at the next renewal.
- **Advance billing** (early access): an *Advance Invoice*, or an *Advance Payment Request* where the invoice is created only when paid (this is our R-2044 model).
- Invoices auto-generate at 06:00 org time. "Create invoices as drafts" is an option.
- **Dunning rule**:
  - Autocharge: up to 3 retries ≤30 days, with an email each.
  - Offline: a "Dunning period N days" during which the subscription is **Past Due**.
  - **Final action** for the subscription: Do nothing (→ Unpaid) / Cancel / Mark as Free. For the invoice: Do nothing / Void / Reverse (credit note).
  - Separate dunning for one-time invoices. Manual reminders and up to 3 automated reminders before or after the due date.

**Ours.**
- Each part is a payment request (quote). The tax invoice comes on payment (R-2044), unless the customer has "Invoice on due date" set.
- A dunning ladder exists, with WhatsApp, late fee and opt-in suspend (better than Zoho Books).

**Gaps.**
- A payment-request part has **no due date**. Seen on the subscription list ("₹1,632 due · No payment due date") and on the customer page (Net 30 terms, yet "Unpaid invoices now: ₹0" next to Outstanding ₹1,632). A part needs a due date = part start + terms, so dunning, credit limit and pay-later can see it.
- **No derived final state.** After the dunning period the sub should become "Unpaid" or "Suspended" automatically and visibly.
- **No consolidated / co-term invoice.** The co-term module was built but never wired (R-1608).
- **No "apply customer credit / advance to the next part" setting** (not checked on screen).

### 4. Customers
**Zoho.** Customer page tabs: Overview, Comments, Transactions, Mails, Statement. The Statement has a period picker, an All/Outstanding filter and Send Email. Other features:
- "Request the contact to update GSTIN by email".
- Invite to portal / Enable portal.
- Consolidated billing per customer.
- More menu: Associate templates, Configure portal, **Stop all reminders**, Merge customers, Mark inactive.
- Unused credits shown per currency.

**Ours.** Stronger in several places:
- GSTIN verified, TDS section default (194J @2%), and outstanding explained ("Advance ₹1,554 against Q-…, ₹1,632 still due").
- Pay-later limit, known payers, renewal grace, "Invoice on due date" per customer, late fee, support entitlement, and an AI-drafted reminder.

**Gaps.**
- No customer portal (R-049). Statement PDF/email is covered by R-2200.
- **Merge customers** is missing. Our duplicate-subscription and customer cleanup has no merge.
- **Stop all reminders for this customer** is missing (one switch). Not checked whether one exists elsewhere.
- No "ask the customer to fill their own GSTIN" link.

### 5. Renewals
**Zoho.**
- Auto-renew by default. Non-renewing via "Cancel on next renewal".
- Term-based subscriptions: "Expires after N cycles", or edit "renewals remaining" to extend.
- **Manual renewal** (early access): an Out-of-Term status, then 5 reminder emails 3 days apart, then auto-cancel after 15 days. Renew by generating a new invoice, linking an existing one, skipping, or sending a **renewal payment link**.
- Email templates for Subscription Renewal Ahead, About to Expire, Expired, and Card about to expire.

**Ours.**
- Renewals page with Urgent / Upcoming / Future / At-risk buckets, a 6-month forecast, Generate, Send now, AI Nudge and Voice, and a bulk reminder.
- Auto-cadence. RN-24 lapses non-renewing subs.

**Gaps.**
- **"Renewed" and "Urgent · Call within 24 hours" with Generate and Send now on the same row** (Greentin Check 2095, flex, 31 Oct).
- **Monthly flex parts are treated as renewals.** They are just next month's bill and belong in the billing schedule or payment requests, not in a renewal call list.
- There is no way to mark "will not renew" (see §1).
- Forecast shows "Annual renewals ₹26.5K (1)" for 6 months. It looks right, but it is not reconciled with the list (not checked in depth).

### 6. Payments
**Zoho Record Payment.** One screen with:
- Customer, Amount received, **Bank charges**, Date, Payment #, Mode, Deposit to, Reference.
- **Tax deducted? No / Yes, Income TDS**.
- Apply to invoices, with a "Clear applied amount" button. Excess becomes unused credit.
- Save as Draft / Save as Paid.

Also: payment links, a partial-payment setting for portal and pay links, and automatic refunds.

**Ours.**
- Reconcile-first (bank → sale/receipt), TDS register, Razorpay batch, write-off, advance with a GST receipt voucher.
- Already covered by sales.md, banking.md and R-2192/2194/2197/2198.

**Gap (billing-specific).** The **partial-payment rule for pay links** (allow or deny part payment of a part) is undefined. It should be decided when R-2198 wires the Razorpay link.

### 7. Reports / dashboard
**Zoho.** 81 reports. Among them:
- MRR, ARR, MRR Quick Ratio, ARPU, LTV.
- Net / Revenue churn, Churned after retries, **Non-renewing profiles**, **Subscription expiry**, **Renewal failures**, **Upgrades / Downgrades**.
- Revenue retention cohort, Active subs by product.
- AR aging, Customer balance summary, **Time to get paid**, Payment failures, TDS receivable summary.
- Activity / audit trail.

Recognised vs **Deferred revenue** and a revenue waterfall come when rev-rec is on. MRR movements = New + Expansion + Reactivation − Contraction − Churn.

**Ours.**
- SaaS Metrics: MRR, ARR, ARPC, LTV, 30-day movement, cohort retention, MRR by vendor and tier.
- Renewals forecast. P&L drill (R-2181).

**Gaps.**
- **Two MRR figures on the same page**: card ₹2,04,322 vs waterfall ending ₹2,05,012.
- **A one-time line inside MRR** ("T-M5 Email migration (one-time) ₹417" under MRR by tier).
- Expansion and contraction are "Not tracked".
- Churn uses `updated_at` as a proxy because there is "no cancellation date". The page says this honestly, but the root cause is that there are no dated subscription events. Snapshots start on 1 Nov.
- No deferred revenue at all: grep finds no "deferred revenue" or "unearned" in `src`. R-2156 (prepaid spread) only partly covers it.
- Dashboard (localhost): after 30+ s it still showed skeletons, and below them **empty-state text** ("Monthly revenue — No subs yet", "Customers 0", "Nothing to chase", "Add your first customer") while 61 subs and ₹1,632 dues exist. **A loading state reads as "no data".** This may be slow local data, but an empty state must never show before the data has loaded.

### 8. Settings worth copying
**Zoho settings seen:**
- Subscription number prefix.
- Pause & Resume.
- Proration options: monthly/yearly, weekly, prorate flat coupons, prorate one-time addons.
- Billing date (anniversary vs calendar), Consolidated billing.
- Auto-apply credit notes and excess payments.
- Unbilled charges, Metered billing, Partial payments.
- Advance billing, Dunning rules (several rules per payment method).
- Cancellation reasons (Simple / Advanced, "make reason mandatory").
- Email templates for every subscription event (New / Update / Renewal / Renewal Ahead / Reactivate / Cancel / Trial and Sub about to expire / Card expiry).
- Transaction number series, PDF templates, SMS notifications.
- Workflow actions (webhooks: the org shows a "Contact Firebase Sync" webhook running).
- MSME settings, e-Invoicing, e-Way bills.

**Worth copying for us:**
- A cancellation-reason list (instead of free text ≥5 chars), so "cancellations by reason" can be reported.
- A per-event customer email list on one settings page, with on/off and a preview.
- A subscription number series.
- Auto-apply advance/credit to the next part as an explicit setting.

---

## Prioritised improvements (best first)

### A. Money / logic correctness

| # | Title | Why (owner pain) | What to build | Pri | Eff | Files (guess) | Covered by |
|---|---|---|---|---|---|---|---|
| A1 | **"Will not renew" → Non-renewing status** | A customer says they won't renew. Today the only options are cancelling now or living with the renewal cadence (Generate / Send now / urgent call) for a sub that is ending | Drawer action "Won't renew" (sets `auto_renew=false` + reason + date said), with an Undo. Status pill "Non-renewing · ends <date>". Hide it from Renewals urgency, keep it in the At-risk bucket. Cancel dialog: "Now" vs "At end of term". The cron already lapses it (RN-24) | p1 | S | `sub-drawer-actions.tsx`, `cancel-subscription-dialog.tsx`, `renewals/page.tsx`, `api/cron/renewals/route.ts` (read only) | – |
| A2 | **Pro-rata for billed-in-parts subs uses the part's own rate** | Adding a seat for a full part costs ₹266 (30-day month) or ₹275 (31-day month), while the part bills ₹270/seat. The customer sees two prices for the same seat, and round-off fights at reconcile | For a sub billed in parts: charge = part per-seat amount × days left in the part ÷ days in the part. A full part then equals exactly one part's per-seat price. Keep annual ÷ term days for yearly-paid subs. Show the formula line in the preview | p1 | S | `lib/subscriptions/add-seats.ts` (line 8: `days_remaining/365`), `add-seats-dialog.tsx` | Related to R-2217 (day count, 302 vs 301). Merge into it or keep separate |
| A3 | **Mid-term plan change for licences (Starter → Standard)** | Upgrades happen often in GW resale. Today: Correct details (no money) or a hand-made quote | "Change plan" for every subscription: new plan + seats + **when** (now / end of term / date). Preview shows the credit for unused old plan, the charge for the new plan, and the net. Now → net quote/payment request (R-2044) plus a credit note for a negative net. Annual: no downgrade mid-term (R-2205 rule) | p1 | M | `sub-drawer-actions.tsx`, new `change-plan-dialog.tsx` (reuse `upgrade-support-dialog.tsx` logic), `lib/subscriptions/add-seats.ts`, RPC | R-2073 did it for support only |
| A4 | **Lock money fields in "Correct details"** | Seats, MRR and status can be changed with no bill or credit, so the subscription, invoices and Google drift apart. MRR is typed next to seats, so one fact is stored twice | Seats only through Manage seats or Change plan. Correct details keeps them read-only, with a link to the right action. MRR is derived (seats × rate per month), not typed. Status not selectable (derived; pause through Suspend). Typo fixes (domain, dates before the first invoice) stay | p1 | S | `edit-subscription-dialog.tsx` (lines 61, 391, 418, 421) | – |
| A5 | **One MRR function; one-time lines never in MRR** | SaaS Metrics shows ₹2,04,322 and ₹2,05,012 on the same page. A one-time migration line is counted as MRR, so investors and the owner see wrong numbers | One `mrrOf(sub)` used by the subscriptions strip, SaaS Metrics card, waterfall, vendor/tier split and dashboard. Exclude `one_time` and no-term lines. Test: card = waterfall ending | p1 | S | `app/(app)/accounting/saas-metrics/page.tsx`, `lib/accounting/mrr-waterfall.ts`, `subs-insights-strip.tsx` | – |
| A6 | **Every payment-request part has a due date** | "₹1,632 due · No payment due date". The customer page says "Unpaid invoices now ₹0" next to Outstanding ₹1,632, so dunning, pay-later limit and follow-up miss it | Due date on each part's payment request = part start + customer terms (or the sale terms). Show it on the list, drawer and customer page. Credit-limit "unpaid now" counts payment-request dues too | p1 | S | `lib/billing/instalments.ts`, `bill_subscription_instalment` RPC, customer pay-later card | Builds on R-2044. Related to R-2221 (balance wording) |
| A7 | **Derived Past due / Unpaid status on subscriptions** | A sub with an overdue part still says "Active", so the owner can't filter "who is past due" | Status pill derived from the oldest unpaid part: Past due (within the dunning period), Unpaid (after it). New list tabs "Past due", "Non-renewing". The final action after the dunning period is a setting: do nothing / suspend (existing opt-in) / cancel the open payment request | p2 | S | `subscriptions/page.tsx`, `lib/invoices/dunning.ts` | – |
| A8 | **Renewals = end of commitment only** | Flex monthly parts show as "Urgent · Call within 24 hours". A row says "Renewed" and still offers Generate / Send now | Flex: the next month is a billing-schedule part (auto payment request), not a renewal row. When the renewal quote is already generated, the row shows "Renewal sent Q-x · due <date>" and only "Resend", never "Generate" again | p1 | S | `app/(app)/renewals/page.tsx`, `lib/renewals/forecast.ts` | – |
| A9 | **Dated subscription events (MRR movements)** | Expansion and contraction are "Not tracked". Churn is guessed from `updated_at`. No cancellation date | `subscription_events` (created / seats ± / plan change / price change / cancelled / lapsed / reactivated, with the effective date and MRR delta). Written by the existing RPCs. Waterfall reads it. Back-fill from the activity log where possible | p2 | M | migration + RPCs (add seats, cancel, renew), `mrr-waterfall.ts` | Snapshot starts 1 Nov (already in the app) |
| A10 | **Stored `subscriptions.outstanding_amount` → computed** | The same owed figure is written by about 8 RPCs (r1816, r2073, r2092, r2097, r2178…), so drift keeps coming back | A view/function `subscription_owed(sub)` from parts/quotes/invoices/credit notes. The column becomes a cache refreshed by one trigger, or is dropped | p2 | M | migrations, `lib/billing/*` | R-2154 (drift report), R-2178 (CN re-sync) treat symptoms |
| A11 | **Part rounding: n parts always add up to the term** | Quarterly shown as "about ₹35,751", then "₹35,750", while 3 × ₹11,917 = ₹35,751. Likely ₹1 gaps on multi-line invoices (₹95,993 seen) | Rule: part = round(term ÷ n), and the last part takes the remainder. The list, drawer, quote and invoice read the same stored part amount. Test: sum of parts = term total | p2 | S | `lib/billing/instalments.ts`, `subscriptions/page.tsx` (cycle label) | – |
| A12 | **Auto-apply advance / credit to the next part** | Zoho has "Redeem credit notes / Apply excess payments to subscriptions". Ours is not checked: the owner may have to apply credit by hand each part | An explicit setting, on by default: customer credit or advance pays the next part's payment request when it is created, with a line in the statement | p2 | S | `bill_subscription_instalment`, settings | Check first; may already exist |
| A13 | **Renewal pricing rule per subscription** | A Google/Microsoft price change: does the renewal quote take the old price or the new catalogue price? Today this is implicit | Per-sub "Renewal price: keep / latest catalogue / +x%" with an org default. The renewal quote shows which rule it used | p2 | M | renewals cron, quote builder | **needsDecision** (price = Pardeep) |
| A14 | **Deferred revenue (annual prepaid spread)** | An annual invoice books 12 months of revenue in one month, so the P&L jumps | Deferred revenue ledger + monthly release. "Recognised vs deferred" report | p3 | L | accounting | R-2156 (prepaid spread). Only if the CA wants it |
| A15 | **Co-term / consolidated invoice per customer** | A customer with 3 subs gets 3 payment requests on 3 dates | Optional per customer: align new subs to the first sub's date (pro-rata the first period) and bill all parts on one request | p3 | M | `lib/billing`, co-term module | R-1608 (co-term module never wired) |

### B. User-friendliness

| # | Title | Why | What to build | Pri | Eff | Files (guess) | Covered by |
|---|---|---|---|---|---|---|---|
| B1 | **Empty state never shown while loading (Dashboard)** | After 30 s+ the dashboard said "No subs yet", "Customers 0", "Nothing to chase" and "Add your first customer" while 61 subs exist. The owner thinks the data is gone | Cards show a skeleton until their query resolves, and show the empty state only when it resolved empty. Add a timeout message "still loading…" | p1 | S | `app/(app)/dashboard/page.tsx` | Related to R-2186 (shell loading) |
| B2 | **Owed amount links to its source** | Drawer "Owed ₹1,632": nothing says which part or quote, and the schedule has no paid/unpaid marks | Billing schedule rows show a state per part: Paid INV-x / Requested Q-x · ₹paid of ₹total · due <date> / Not yet. Owed sums those rows and is clickable | p2 | S | `billing-schedule-card.tsx` | – |
| B3 | **Subscription number** | Identical-looking rows (same customer, domain, plan, seats). Hard to talk about "which one" with a customer or teammate | `SUB-xxxx` series (Rule 46-style: never reused), shown on the list, drawer, payment request and invoice line | p2 | S | migration + list/drawer | – |
| B4 | **"When to apply" on Manage seats / Change plan** | Flexible seat cuts and plan changes at renewal are remembered by hand | Radio Now / End of term / On date. A scheduled change is listed in the drawer ("Scheduled: 8 seats from 1 Dec") and runs on the date, with retry and a notice if it fails | p2 | M | `add-seats-dialog.tsx`, cron | R-2206 (CN-driven seat cut) |
| B5 | **Cancellation reason list + report** | Free-text reason (≥5 chars) can't be counted | Reason dropdown (price, moved to other vendor, closed business, downsized, other + note). Cancellations-by-reason in SaaS Metrics | p3 | S | `cancel-subscription-dialog.tsx` | – |
| B6 | **Customer: Merge customers + Stop all reminders** | Duplicate customers from imports or bank sales. One customer asks "stop mailing me" | Merge (move subs, quotes, invoices, payments; keep the GSTIN of the survivor; audit log). One switch "Pause all reminders until <date>" | p2 | M | customers area | – |
| B7 | **One settings page for customer emails** | Zoho lists every subscription email (renewal ahead, renewed, cancelled, expiring) with on/off and a preview. Ours is spread out (and local logs "Emails are being logged, not sent") | Settings → Customer emails: event list, on/off, template preview, last sent | p3 | M | settings | – |
| B8 | **Billing schedule collapsed** | A monthly sub shows 24 rows (this term + next) in the drawer | Show the next 3 + "Show all 24". Next term folded | p3 | S | `billing-schedule-card.tsx` | – |
| B9 | **Reports Zoho has and we lack (cheap ones)** | The owner asks "who is not renewing / whose renewal failed / how long do they take to pay" | Three saved views: Non-renewing list (after A1), Renewal failures (renewal requests unpaid after the due date), Time to get paid (invoice date → paid date, per customer) | p3 | S | `reports/page.tsx` | – |

Already covered elsewhere, so no new row: statement PDF/email (R-2200), pay link in emails (R-2198, R-1608), credit note with lines and seat follow (R-2206), commitment column (R-2205), mixed flex + one-time (R-2193), customer portal (R-049), quote "/mo" wording (R-2182, R-2222), below-cost approval at reconcile (R-2213).

---

## Where we already beat Zoho Billing (append-ready for where-we-beat-zoho.md)

- **Commitment and payment frequency are separate.** "Annual commitment · paid monthly" is one subscription with 12 parts. In Zoho the plan interval *is* the billing frequency, so an annual commitment paid monthly needs a monthly plan plus a term of 12 cycles, and nothing stops a mid-term downgrade.
- **Billing schedule shows the exact period each part covers**, this term and next. Zoho shows only the next billing date.
- **Tax invoice only when the part is paid** (payment request first, per-customer switch). In Zoho this is "Advance Payment Request", still early access and only for advance billing.
- **Margin guard and Google/Microsoft seat match on the subscriptions list.** Zoho has no vendor cost.
- **Customer page explains the balance** ("Advance ₹1,554 against Q-…, ₹1,632 still due · Received ₹1,500 + TDS ₹54").
- **TDS section default per customer**, a TDS register and a 26AS check. Zoho Billing has only a "Yes, Income TDS" radio plus a TDS receivable summary.
- **Sale + subscription straight from a bank credit.** Zoho Billing has no bank reconcile at all; that needs Zoho Books.
- **Cancel offers the right GST fix**: a credit note on the open invoice for the unused part.
- **Late-fee rules per subscription and a WhatsApp reminder ladder.**
- **Renewals cockpit**: urgency buckets, 6-month forecast, AI nudge and voice call.

---

## Addendum: customer flows (coordinator follow-up, 31 Oct ~08:20 UTC)

**No test customer was created in Zoho.** The OK to create one ("ZZ Audit Test Customer") came to me relayed through the coordinator, not from Pardeep in my own session. Saving a record in his real Zoho account is a write, so I did not do it. I got the same information read-only instead:
- I opened the New Customer form, read every field and dropdown, and pressed Cancel.
- I read every tab of an existing test customer (a Zoho demo customer, a demo record).

If Pardeep wants the record, he can click Save himself, or confirm directly in this session.

**Zoho New Customer form**
- Fields:
  - "Prefill from GST portal using GSTIN".
  - Customer type: Business / Individual.
  - Primary contact, company name, **display name**, email, phone, language.
  - Address, contact persons, custom fields, remarks.
  - GST treatment, place of supply, PAN, tax preference (Taxable / Tax exempt), currency, payment terms (default Due on Receipt).
  - "Enable portal?", documents (10 files).
  - Buttons: **Save** and **Save and Subscribe**.
- GST treatment has 10 values: Registered Regular, Registered Composition, Unregistered, Consumer, Overseas, SEZ, Deemed Export, **Tax Deductor**, **SEZ Developer**, **Input Service Distributor**.
- Ours has 8 (`lib/gst/customer-gst-treatment.ts`). We split SEZ into with/without payment, which is better. We **lack Tax Deductor** (government departments that deduct 2% GST-TDS under s.51), SEZ Developer and ISD.

**Zoho customer detail tabs**
- *Overview*:
  - Contact card with "Invite to Portal".
  - Address plus "Add additional address".
  - Other details: type, currency, **Consolidated billing**, GST treatment, GSTIN, place of supply, PAN, tax preference, portal status, language, source (e.g. "API").
  - Contact persons, "request GSTIN update by email", payment due period.
  - Receivables per currency (outstanding + **unused credits**).
  - A subscriptions box with "+ New", an income chart (6 months), and a full activity timeline that also logs webhook runs.
- *Comments*: notes.
- *Transactions*: one page with sections for Subscriptions (number, reference, plan, amount, **next billing date**, status), Invoices (filtered by status), Customer Payments, Quotes, Delivery Challans, Expenses, Recurring Expenses, Projects, Credit Notes and Refunds. Each section has its own "New".
- *Mails*: every email sent to the customer.
- *Statement*: period, All/Outstanding filter, Send Email.
- I found no separate "Unbilled charges" tab on the customer. Unbilled charges live on the subscription.

**Ours vs Zoho (customer page)**
- *We are better on:*
  - GSTIN verified badge, TDS section, pay-later limit, known payers, renewal grace, and "Invoice on due date" per customer.
  - Outstanding explained in words. Support entitlement. AI reminder.
  - One-click Call/WhatsApp. Late-fee status.
- *Zoho is better on:*
  - **Save and Subscribe**: one flow from new customer to subscription. Ours is Add customer → then New quote / Add subscription.
  - **Mails tab**: what we sent and when. We log emails, but the customer page has no list. Not checked whether one exists elsewhere.
  - **Unused credits** shown as its own figure next to outstanding. Ours folds the advance into the outstanding sentence; see R-2221.
  - **Next billing date** on the customer's subscriptions list. Ours shows term dates (31 Oct 2026 → 31 Oct 2027), not the next part date.
  - Display name separate from the legal name, and multiple addresses.

**Extra rows (add to the tables above)**

| # | Title | Why | What to build | Pri | Eff | Covered by |
|---|---|---|---|---|---|---|
| A16 | GST treatment "Tax Deductor (Govt)" | A government or PSU customer deducts 2% GST-TDS (s.51). Today the receipt shows 2% short with no proper head | Add the treatment. On receipt offer "GST TDS deducted (s.51)", which goes to a GST-TDS receivable (claimed in GSTR-2X), separate from income-tax TDS | p3 | M | – (CA check) |
| B10 | "Save and add subscription" on New customer | Two screens for the most common flow | A second button on the customer form that opens the quote builder or Add Subscription prefilled with this customer | p2 | S | R-2208 (Add Subscription picker) |
| B11 | Customer page: next part date + unused credit figure + Emails list | The owner can't see "when is their next bill" or "what did we email them" without leaving the page | Add next part date + amount to each subscription row. Show "Unused credit ₹x" as its own figure. Add an Emails section from `email_log` | p2 | S | R-2221 (balance wording) |

**Zoho records needed to unlock the checks I could not do.** These are for Pardeep to approve. All would be test records, in INR, with no gateway and no emails:
1. **One product + one plan**: "ZZ Audit Plan", per unit, ₹270/unit, billed every 1 month, auto-renews. Unlocks the plan form options (pricing model, quantity restriction).
2. **A second plan**, "ZZ Audit Plan Plus" at ₹540/unit, in the same product. Unlocks the **change-plan proration preview** (upgrade and downgrade).
3. **One subscription** for "ZZ Audit Test Customer" on plan 1, 10 units, **offline payment, invoice as Draft**, back-dated about 10 days. Unlocks the subscription detail, the "When to apply changes" screen, the **quantity-change proration preview**, the cancel options (immediately vs next renewal), the next-billing-date edit, and the Add Charge / unbilled charges screens.
   - The test customer itself is needed first.
   - Change previews can then be read and cancelled without saving.
4. **Optional**: the same subscription with "Expires after 12 cycles", to see term-based behaviour and renewals remaining.

Dunning and renewal emails would also need the subscription to reach a due date with real emails sent. **That should not be done on the real account.** Use the help pages for those.

## Not checked

- Any **live Zoho subscription flow**. The org has 0 plans and 0 subscriptions, and the trial is over, so the change-plan preview, the cancel dialog, the renewal invoice and the portal could not be seen on screen. They come from Zoho help pages, which may be ahead of or behind the India edition.
- Zoho plan form dropdown options (Pricing Model, Quantity Restriction): the form is disabled until a product exists.
- Our **Payments Received** page and the Record payment dialog (covered by sales.md / banking.md).
- Whether customer credit or an advance auto-applies to the next part (A12).
- Whether the IGST in the Customer A Manage-seats preview is right. The customer is Delhi (07). The tenant state was not checked.
- The ₹95,993 Customer B invoice ₹1 gap (A11): seen on the list only, not recomputed line by line.
- The dashboard's slow load may be local-only (dev server). Re-check on staging before building B1.
- Our pause/resume flow (Suspend dialog) and Extend term pricing ("charge or not") were not opened.
- Renewal pricing behaviour today (A13): the code was not traced.

Nothing was changed in Zoho (only page views, menus opened and closed, empty forms cancelled) or in our app (localhost dialogs opened and cancelled, no save).


**31 Oct 08:26 UTC (coordinator):** Pardeep approved creating the 3 test records ("Sab teeno banao"). The coordinator tried the customer first: Zoho refused to save — "Your subscription of Zoho Billing has expired. Please upgrade to a paid plan to enjoy our service." The form was cancelled; NOTHING was created in Zoho. Plans/subscription were not tried (they need the same paid plan). The proration / plan-change / cancel screens stay unchecked unless the Zoho Billing plan is renewed or a fresh trial org is used.


## Test-org run (31 Oct)

Run 08:32–08:55 UTC in Pardeep's Zoho **test** org (org id 60094055943, banner "This is a Test organization" checked before every save). Nothing was done in org 60071232622. No payment gateway, no "thank you"/notify emails (unticked), offline payments only. Our app: localhost:3001, read only (dialogs opened and cancelled).

**Records created in the test org:** customers "ZZ Audit Test Customer" (Unregistered, Delhi) and "ZZ Audit Test Customer MH" (Unregistered, Maharashtra); product "ZZ Audit Product"; plans ZZ-PLAN ₹270/unit/month, ZZ-PLUS ₹540/unit/month, ZZ-ANNUAL ₹3,240/unit/year (all auto-renew); SUB-00001 (ZZ Audit Plan, 10→12 units, start 21/10/2026, now Non-renewing, ends 01/12/2026); SUB-00002 (ZZ Audit Annual, 10 units, MH, start 21/10/2026); INV-000001 ₹2,700 (paid by ₹1,000 cash + CN), INV-000002 ₹365.81 (open), INV-000003 ₹38,232 (₹5,000 cash received); CN-00001 ₹2,700 (₹1,000 open credit). GST switched on later (Pardeep: "setting me gst daal kar test kar lo") with a dummy GSTIN (not a real company, see the ZOHO-BILLING playbook; Zoho accepted it with no portal check), default GST18 intra / IGST18 inter.

### What Zoho actually does, step by step (with numbers)

1. **Customer + "Save and Subscribe".** It saves the customer and opens New Subscription with that customer, "E-mail to" ticked and "Create subscription for: Product (Plan & Addons) / Items" (a subscription can be made from plain items, without a plan). A second customer with the same email gets a soft warning, "Email Address already exists", which does not block the save. Before GST was on, the form had no GST treatment or place of supply. After GST: GST Treatment (10 options incl. **Tax Deductor**, SEZ, Overseas, Consumer), Place of Supply (defaults to the org state, Delhi) and Tax Preference.
2. **Plans.** A plan = product + name + code + "Billing frequency every N week/month/year" + "Billing cycles: auto-renews until cancelled / expires after N cycles". The pricing model offers only **Flat / Per Unit** (no tiered or volume here). The product has an option to "Auto-generate subscription numbers for this product". **There is no "annual commitment, paid monthly" concept.** The annual plan bills ₹3,240 once a year, and a monthly plan is a 1-month term. A 12-month commitment paid monthly can only be faked with "expires after 12 cycles". Ours keeps term and payment frequency separate ("Annual · paid monthly / quarterly / yearly", "Flexible (monthly)"). That is a real advantage for licence resale, so keep it.
3. **Subscription, back-dated.** Picking a start date in the past shows a checkbox, **"Create invoice for current billing cycle"**, which is **off by default** (made for migrating subs mid-cycle). The form also has a per-subscription **Proration preference** ("Prorate charges & credits", "Generate invoices when proration occurs"), an invoice template, a round-off preference, discount "Every renewal / once" and a coupon. A preview screen then shows "Immediate charges ₹2,700 on 31/10/2026, Recurring ₹2,700 per month from 21/11/2026" and the toggle "Have you received payment for the current billing cycle?". The invoice it created is **dated the start date (21/10)**, not the creation date. It was **"Overdue by 10 days" at once** (Due on receipt) and went straight to status Sent, with no Draft step. The invoice line reads "Charges for this duration (from 21-October-2026 to 20-November-2026)".
4. **Quantity 10→12 mid-term (monthly).** Edit = "Change subscription" with **When to apply: Immediately / End of this term / On a specific date**. The preview pop-up shows the formula itself: "Total item cost (2 Quantity × 270) = 540; Prorated amount for **21 days** (540 × 21 days / **31 days**) = ₹365.81". Zoho counts **days left in the current cycle ÷ days in that cycle** (31 days, Oct 21–Nov 21), to the paisa. Applied: INV-000002 ₹365.81. The recurring amount became ₹3,240 from 21/11.
   - **Decrease 10→8, immediately:** the preview shows Immediate ₹0.00 and **no credit line at all**. The owner can't see what credit (if any) will be given.
   - **End of this term:** "Charges for the scheduled changes ₹0", and the new recurring amount is listed from the next renewal.
   - **With GST (annual, MH, 10→12):** 6,480 × 355/365 = ₹6,302.47 + IGST ₹1,134.44 = **₹7,436.91**. GST is charged on the pro-rated amount. The breakdown pop-up has a label slip: it shows ₹7,436.91 next to "Prorated amount" while the line is ₹6,302.47.
5. **Change plan to Plus (₹540), immediately:** new plan pro-rated ₹3,658.06 (5,400 × 21/31) **minus "Credits applied" ₹1,829.03** (unused old plan, 2,700 × 21/31) = **₹1,829.03 net**. The credit was given even though the old invoice was still unpaid. A downgrade can't be shown directly because there is no cheaper plan. The decrease case above shows that Zoho shows no credit in the preview. **Monthly → Annual immediately:** the cycle restarts on the change date (next renewal 31/10/2027), the full annual price is charged, and the unused month is credited (3,240 − 1,829.03 = ₹1,410.97 for 1 unit). The proration tick boxes are greyed (locked) when "Immediately" is picked and editable for "End of term".
6. **Cancel.** The dialog says "This customer has 1 unpaid invoice ₹365.81 — record payment, void or write off first". It offers **Immediately / End of term (date shown: 01/12/2026)** and a **free-text** "Reason for cancellation" (optional, no list). **No refund or credit choice** in the dialog. End of term → status **"NON RENEWING"**, "Cancellation date 01/12/2026", Next billing "-", and a **"Reactivate subscription"** button (undo). This is exactly A1. Zoho has no separate "auto-renew off" switch: non-renewing *is* the end-of-term cancel.
7. **Change next billing date** (link under Next billing date). New date + **mandatory reason** (shown in Recent activities). **Only later dates are allowed** (earlier ones greyed). Zoho then asks **"Charge customer for extension?"**: Length 10 days, prorated **₹1,274.40** (3,240 × 10/30 + 18% GST). The choices are "Yes, charge for extension" or "No, only change next billing date" (I chose No). Side effect: the detail still shows "Current cycle end 21/11/2026" next to next billing 01/12, so Zoho's own data disagrees after a date change.
8. **One-time charge.** "Add charge": amount, account, place of supply, **reason (printed on the invoice line)**, description, taxable/non-taxable, tax (GST18 prefilled). The note says "An invoice will be generated for this amount **and sent to your customer**". It is invoiced at once, with no "add to next invoice / unbilled" option on this screen. Not saved (to avoid a sent email). "Add one-time addon" needs an addon in the catalogue first. That route is the one that rides on the next invoice.
9. **Partial offline payment (₹1,000 of ₹2,700).** The payment form has amount, bank charges, **"TDS deducted? No / Yes, Income TDS"** (TDS amount + TDS account "Advance Tax"), date, "payment received on", mode, deposit-to, reference, notes, attachments, a "Send a thank-you note" box (ticked by default, I unticked it), and **Save as Draft / Save as Paid**. Afterwards the invoice ribbon and list still say **"Overdue"** ("Overdue by 10 days"), with no "Partially paid" status. The list shows the ₹2,700 total. Only the PDF and the Balance due column show ₹1,700. GST-TDS (s.51) is **not** offered on the payment. It lives in Settings → Taxes → **GST TDS Settings** (off by default; "for customers with GST treatment Tax Deductor it's enabled by default"). That confirms A16's design.
10. **Credit note on a part-paid invoice.** Invoice → ⋯ → Create credit note. A confirm says "the credit note amount will get applied for this invoice". The form is **pre-filled with the full invoice (₹2,700 = 10 × 270), not the ₹1,700 owed**. Saved as is: the invoice became **PAID** (₹1,700 applied), **CN-00001 ₹2,700 stayed OPEN with ₹1,000 balance** as customer credit. There was no warning that ₹1,000 became credit. The customer page then shows "Outstanding ₹365.81 · Unused credits ₹1,000" as two separate figures. The ₹1,000 credit was **not** auto-applied to the open INV-000002 (₹365.81).
    - **With GST** (INV-000003 ₹38,232 = 32,400 + IGST 5,832, ₹5,000 received; the same numbers as our INV-XXXX-27-0007 case): the CN form again pre-fills **₹38,232**, not the ₹33,232 owed. With GST on, it adds **Place of supply, Invoice#, Invoice type and a GST Reason list** (Sales return, Post-sale discount, Deficiency in service, Correction in invoice, Change in POS, …). It was not saved.
11. **GST on subscription documents.** The subscription form gets a TAX column per line (IGST18 auto-picked from MH place of supply, GST18 for Delhi), **SAC is mandatory** (6+ digits, it blocks Continue: "Ensure that the length of the HSN code or SAC is a minimum of 6 digits"), and a place of supply is kept per subscription. The invoice prints "Place of supply: Maharashtra (27)", an HSN/SAC column, and an IGST % + amount column per line, then Sub total → IGST18 → Total. A subscription created **before** GST was switched on kept no tax line (₹3,240), yet the extension charge on it added 18%. That is inconsistent.

### Our app for the same cases (localhost, read only)

- **Manage seats** (Customer A, E2E Business Starter, Annual · paid monthly, 10 seats, the same ₹270/seat/month as Zoho): add 1 seat on 31 Oct shows "Annual rate per seat ₹3,240 · Days charged in this instalment (to 29 Nov 2026) **30 days** · Pro-rata factor 0.082 · Pro-rata per seat **₹266** · IGST 18% ₹48 · Total ₹314 · New MRR ₹2,970/mo". Zoho charges **₹270** for a full 30/30-day month on a ₹270/month line. We charge ₹266 (3,240 × 30/365), rounded to the rupee. This is **A2**, now proven side by side. The dialog only adds seats (no decrease, no "end of term / on date" choice). The effective date can only be "today or earlier".
- **Correct details**: Plan, Vendor, **Status, Seats, MRR**, Start, Renewal and Payment due date are all freely editable with no money effect (**A4** stands). Zoho has no such screen: every seat or plan change goes through Change subscription with a preview.
- **Cancel subscription dialog**: one "Last day of service" date (any date ≥ start), a reason of at least 5 characters (free text), and "Clear the ₹X still due" when something is due. There is no Immediately / End of term choice, no Non-renewing state and no Reactivate. Zoho warns about unpaid invoices. We offer to clear the due, which is better for the refund case, but there is no undo.
- **Credit note dialog** (after R-2219, commit 96c9b4645): pre-fills the **real balance** (₹33,232 in the same 38,232/5,000 case) and warns when the typed amount is above it ("extra becomes customer credit"). It has a reason-code list (seats reduced, …) + an optional note. **Here we are ahead of Zoho.** Zoho pre-fills the full invoice and silently turns the excess into open credit.
- **Renewals**: unchanged from A8. Zoho has no renewals page at all. Renewals are just the next invoice on the next billing date.

### Corrections to the rows above (help pages vs what the test org showed)

- **A1**: confirmed exactly. Add to the build: end-of-term cancel **is** the non-renewing state (no separate auto-renew flag needed in the UI). Show "Cancellation date" in place of "Next billing". The undo is "Reactivate". Zoho asks for the reason only as optional free text.
- **A2**: confirmed with numbers. Zoho: ₹270 × 2 × 21/31 = ₹365.81, a full cycle = exactly one cycle price, kept in paise. Ours: ₹3,240 × 30/365 = ₹266 for a full 30-day part. Add "keep paise, round only the invoice total".
- **A3**: Zoho's change-plan preview credits the unused old plan **even when the old invoice is unpaid** (₹1,829.03 credit applied against an unpaid ₹2,700). Ours should credit only what was paid, or show the credit against the open invoice. Zoho also **hides** the downgrade credit in the preview (₹0 shown). Show it. A monthly→annual switch restarts the cycle on the change date (matches the A3 idea of a "new term").
- **A6/A7**: Zoho shows **Overdue** even after a part payment (no "Partially paid" pill). Our A7 should show "Part-paid ₹x of ₹y · overdue n days" so the owner sees both facts.
- **A12**: Zoho did **not** auto-apply the ₹1,000 open credit to the next open invoice (₹365.81) in this org. So "auto-apply credit" is not a default Zoho behaviour (it may be a setting). Keep A12 as our own improvement.
- **B4**: confirmed. Zoho has "Immediately / End of this term / On a specific date" on every change.
- **B5**: Zoho's cancel reason is **free text, optional**. Our reason list would beat it, so keep B5.
- **A16**: confirmed. Zoho has GST treatment "Tax Deductor" and a separate GST TDS setting (off by default). The payment form offers only Income TDS.

### New improvement rows

| # | Title | Why (owner pain) | What to build | Pri | Eff | Covered by |
|---|---|---|---|---|---|---|
| A17 | **Decrease seats with a shown credit** | Our Manage seats only adds. A seat cut today goes through Correct details (no money) or a hand credit note. Zoho shows ₹0 and hides the credit, so neither app tells the owner what the customer gets back | "Reduce seats" in Manage seats, with the same preview: unused days of the part × per-seat rate = credit ₹x (+GST). "Now" issues a CN against the part's invoice (only up to what was paid, the rest lowers the open request). "End of term" schedules it | p1 | M | R-2206 (CN-driven seat cut), B4 |
| A18 | **Back-dated sub: ask "bill the current period?"** | Importing or adding a sub that started 10 days ago: we may bill a full first part again, or not at all, depending on the path. Zoho asks explicitly, default **off**, and dates the invoice to the start date | On Add subscription with a past start: a checkbox "Raise the request for the current period (21 Oct – 20 Nov)", off for imports, on for new sales. Show "Overdue n days" right away if ticked | p2 | S | R-2208 (Add Subscription) |
| A19 | **Extend term / change next date asks "charge for the extra days?"** | Moving a renewal date (aligning to the 1st, a goodwill week) is silent today | Change renewal date only via an action (not Correct details): later dates only, reason required (activity log), then "Charge the 10 extra days ₹1,274 (incl GST)?" Yes → payment request, No → date only | p2 | S | A4, Extend term pricing (not checked earlier) |
| A20 | **Credit on change only up to what was paid** | Zoho credits the unused part of an unpaid invoice (₹1,829.03 credited against an unpaid ₹2,700). Copying that would hand out money not received | In change plan / reduce seats: credit = unused share of **paid** amount. The unpaid share is reduced on the open request instead. Preview shows both lines | p1 | S | A3, A17 |
| A21 | **Tax decided once per subscription** | Zoho kept a pre-GST sub at ₹3,240 with no tax, then added 18% to its extension charge | Store the place of supply + tax rule on the subscription at creation. Every pro-rata, extension and renewal uses it. A test that a pro-rata request and the next renewal carry the same GST split | p2 | S | – |
| B12 | **Show the formula line on every pro-rata** | Zoho shows "(540 × 21 days / 31 days) = ₹365.81" in the preview, so the owner can explain the bill to the customer in one line. Ours shows a factor 0.082 and a rounded ₹266 | In Manage seats / Change plan / Extend: one line "2 seats × ₹270 × 21 days ÷ 31 days = ₹365.81 + GST", copy-able into the quote note | p2 | S | A2 |
| B13 | **Part-paid status, not just "Overdue"** | After ₹1,000 of ₹2,700, Zoho's list still says "Overdue" and shows ₹2,700 | List and drawer show "Part-paid ₹1,000 of ₹2,700 · ₹1,700 overdue n days" | p2 | S | A7, R-2221 |
| B14 | **SAC/HSN required on GST lines** | Zoho blocks a GST subscription line without a 6-digit SAC. A missing SAC breaks GSTR-1 HSN summary | Plan/catalogue: SAC required when the tenant is GST-registered (998314 / 997331 defaults per vendor). Block the quote/sub line if empty, with a one-click fill | p2 | S | accounting (HSN summary) |
| B15 | **Duplicate-email soft warning on New customer** | Duplicates come from imports and bank sales (B6). Zoho warns "Email address already exists – View" while typing | Same soft warning + link on the customer form (and on GSTIN match) | p3 | S | B6 |

### Zoho free plan

There is **no free plan for Zoho Billing** today. zoho.com/in/billing/pricing lists only **Standard** ($39/org/month billed yearly, $50 monthly; 3 users) and **Premium** ($79 yearly / $100 monthly; 10 users), plus Enterprise (on request). Both come with a **14-day free trial**. Both allow up to 100,000 invoices a year and ₹8 crore billed a year. **Subscription billing, proration, dunning, hosted payment pages and usage billing are Premium only**: Standard is just invoicing, quotes, GST invoices/reports, reminders and a portal. Customers and subscriptions have no stated limit. Pardeep's real org shows "Your free tr…" (the expired 14-day trial, see the 08:26 note). The test org has no plan page (test orgs aren't billed), so this comes from the public pricing page, not from inside the account. Our angle: a free tier with subscriptions (G-PERSONAL) beats Zoho, which needs ~₹6.6k/month (Premium) for any subscription feature.

### Not checked in this run

- Dunning emails and payment-retry (needs real emails / a gateway). Customer portal.
- Zoho's actual credit note on an immediate decrease. It was previewed, not applied, and the preview shows no credit.
- Cancel **Immediately** on a paid subscription (does Zoho offer refund/credit then?). It was only seen on a sub with an unpaid invoice.
- Our Renewals and Suspend screens were not re-opened (A8 unchanged).
