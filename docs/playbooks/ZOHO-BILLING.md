# Playbook: Zoho Billing — measured rules, safe testing, and lessons from 31 Oct

Written for R-2251, 31 Oct 2026, from the G-ZOHO billing audit and a hands-on run in a Zoho
**test** organisation (08:32–08:55 UTC). Read it before you compare our billing with Zoho, before
you build a G-ZOHO billing card (R-2225..R-2260), and before you open Zoho in the browser.
The numbers below are from the test org's own screens, not from help pages. The full audit lives
in [docs/audits/zoho-2026-10/billing.md](../audits/zoho-2026-10/billing.md) (all audits: [README](../audits/zoho-2026-10/README.md)); every item in it is carried by a
board card (section 5).

## 1. How Zoho Billing behaves (measured in test org 60094055943)

Test setup: plans at ₹270/unit/month, ₹540/unit/month and ₹3,240/unit/year; subscriptions of
10 units starting 21 Oct 2026; changes made on 31 Oct (21 days left in a 31-day cycle).

**Pro-rata (seat add, plan change)**
- **Seat add = seats × rate × days left ÷ days in that billing cycle.** 10→12 seats:
  2 × ₹270 = ₹540 × 21/31 = **₹365.81**. Paise are kept. The preview shows the formula itself:
  "(540 × 21 days / 31 days) = ₹365.81". A full cycle costs exactly one cycle's price.
  (Ours: ₹3,240 × 30/365 = ₹266 for a full 30-day part, rounded to the rupee — R-2226, R-2257.)
- **Annual plan uses 365 days.** 10→12 seats on an annual ₹3,240 plan: 2 × 3,240 = ₹6,480 × 355/365
  = **₹6,302.47 + IGST ₹1,134.44 = ₹7,436.91**. GST is on the pro-rated amount.
- **Seat decrease, immediately: ₹0 now, and no credit line at all.** The owner cannot see what the
  customer gets back. End of term: "Charges for the scheduled changes ₹0", new amount from renewal.
- **Upgrade = new plan pro-rated − unused old plan credit.** ₹540 plan: ₹3,658.06 (5,400 × 21/31)
  − ₹1,829.03 (2,700 × 21/31) = **₹1,829.03 net**. Zoho gives that credit **even when the old
  invoice is unpaid.** We must NOT copy this: credit only what was paid (R-2255).
- **Monthly → annual, immediately:** a new cycle starts today (next renewal one year from today),
  full annual price charged, unused month credited.
- Every change asks **When to apply: Immediately / End of this term / On a specific date** (R-2242).

**Dates, cancel, next billing date**
- **Back-dated subscription:** a checkbox "Create invoice for current billing cycle", **off by
  default** (meant for migrating subs). When ticked, the invoice is dated the **start date**, not
  today, and is "Overdue by 10 days" at once (Due on receipt, straight to Sent, no draft) — R-2253.
- **Change next billing date:** later dates only (earlier ones greyed), a **mandatory reason**
  (shown in activity), then "Charge customer for extension?" — 10 days = **₹1,274.40 incl. GST**
  (3,240 × 10/30 + 18%). Yes = charge, No = only move the date (R-2254).
- **Cancel:** Immediately / End of term. End of term → status **NON RENEWING**, cancellation date
  shown instead of next billing, and a **Reactivate** button (undo). Reason is optional free text.
  No refund/credit choice in the dialog. It warns about unpaid invoices first (R-2225, R-2243).

**Payments, credit notes, charges**
- **Part payment still shows "Overdue".** ₹1,000 of ₹2,700 received: the list and ribbon still say
  Overdue and show ₹2,700; only the Balance due column shows ₹1,700. No "Part-paid" status (R-2258).
- **Credit note on a part-paid invoice pre-fills the FULL invoice** (₹2,700, not the ₹1,700 owed).
  Saved as is: invoice PAID, and the extra ₹1,000 stays as **open customer credit** with no warning.
  It was not auto-applied to the next open invoice. Ours pre-fills the real balance and warns about
  the extra since **R-2219 — keep ours.**
- **Add charge = an invoice created and sent at once** (no draft, no "add to next invoice" here).
- No "Partially paid", no auto-apply of credit by default (our R-2236 is our own improvement).

**GST**
- **SAC is mandatory, at least 6 digits** — it blocks Continue on a GST subscription line (R-2259).
- **Place of supply is kept per subscription** (IGST for Maharashtra, CGST+SGST for Delhi).
  A sub created before GST was switched on kept no tax, yet its extension charge added 18% —
  decide tax once per subscription (R-2256).
- A **GST-TDS (s.51)** setting exists (Settings → Taxes, off by default; on for treatment "Tax
  Deductor"). The payment form offers **income-tax TDS only** (R-2248).

**Plans and the free plan**
- A plan = product + billing frequency (every N weeks/months/years) + cycles (auto-renew or N).
  Pricing model in this org: Flat / Per unit only.
- **No "annual term paid monthly" concept.** A 12-month commitment paid monthly can only be faked
  with "expires after 12 cycles". Our split of term vs payment frequency is an advantage — keep it.
- **No free plan today** (public pricing page, 31 Oct): Standard and Premium, 14-day trial.
  Subscriptions, proration and dunning are **Premium only**.

## 2. Where we already beat Zoho Billing

- Commitment and payment frequency are separate ("Annual · paid monthly" = one sub, 12 parts).
- The billing schedule shows the exact period each part covers; Zoho shows only the next date.
- Tax invoice only when a part is paid (payment request first); Zoho's version is early access.
- Credit note pre-fills the real balance and warns about extra credit (R-2219).
- Margin guard and Google/Microsoft seat match on the subscriptions list (Zoho has no vendor cost).
- Customer page explains the balance in words (advance, still due, received + TDS).
- TDS section default per customer, TDS register and 26AS check.
- Sale + subscription straight from a bank credit (Zoho Billing has no bank reconcile).
- Cancel offers a credit note on the open invoice for the unused part.
- Late-fee rules per subscription, WhatsApp reminder ladder, renewals cockpit with a forecast.

## 3. How to test Zoho safely

1. **Pardeep's real org (60071232622) is READ ONLY.** Open forms, read, press Cancel. Never Save.
   Its trial has expired, so it refuses saves anyway ("Your subscription of Zoho Billing has
   expired") — do not try to get around that.
2. **Writes go only in the test org (60094055943).** It shows the banner **"This is a Test
   organization"**. Before EVERY save, check both the URL (org id) and the banner.
3. **No real people.** Emails `test@example.com` only. Record **offline** payments only — no payment
   gateway. Untick every "notify", "send" and "thank-you note" box before saving.
4. **Dummy GSTIN `07AAAAA0000A1Z4`** (PAN AAAAA0000A, not a real company) only in the test org.
   Zoho accepted it with no portal check.
5. **Preview, then cancel** when the preview is all you need (change, cancel, add charge). Add
   charge sends an invoice at once, so do not save it.
6. Name test records `ZZ Audit …` so they are easy to find and never mixed with real ones.
7. A write in a real account needs the owner's OK **in the session that acts** (section 4a).

## 4. Process lessons from 31 Oct (team rules)

a. **Relayed approvals do not count.** A subagent will not act on an owner approval that another
   agent passed on to it — and it is right not to. An owner-approved write in someone's real
   account is done by the session the owner is talking to, or the owner says it in the acting
   session. (The audit worker refused to save a test customer in the real Zoho org for this reason.)
b. **Docker Desktop down ⇒ local Supabase down ⇒ localhost:3001 dies.** Start Docker Desktop (on
   Pardeep's laptop it is a per-user install at `%LOCALAPPDATA%/Programs/DockerDesktop`), wait until
   `supabase_db`, `supabase_auth` and `supabase_kong` are healthy, then start the
   `ResellerOS-local-ai` preview. Do not debug the app before the containers are healthy.
c. **The shared browser-pane tab can be moved by someone else.** Every checker opens its own tab and
   checks the URL (and, for Zoho, the org banner) before each action.
d. **A 1280×800 emulation clips right-side drawers in the pane.** Check drawers at the pane's own
   width (reset to desktop) before calling a drawer "cut off".
e. **Invoice dates before R-2095 (30 Oct ~10:43 UTC) were the save day**, not the receipt date.
   Old invoices with odd dates are a data repair (R-2223), not a new bug.
f. **Never `git reset --soft anutech/manager-pardeep` in a worktree after the base moved** — it
   silently undoes other cards' work (worker-lock exit 9). Rebase instead.
g. **The worker-lock push guard step takes 99–141 s** (over its 90 s target). Known; a card will
   shorten the guard list. Give `worker-lock push` a long timeout; it is not stuck.

## 5. Cards that carry each item (board, G-ZOHO)

| Area | Cards |
|---|---|
| Subscription status, cancel, renew | R-2225 non-renewing, R-2231 past due / unpaid, R-2232 renewals = end of commitment, R-2243 cancel reasons |
| Pro-rata, seats, plan change | R-2226 part's own rate, R-2257 formula line, R-2227 mid-term plan change, R-2252 decrease with credit, R-2255 credit only what was paid, R-2242 when to apply |
| Dates, terms, schedule | R-2253 back-dated sub, R-2254 next date + charge extra days, R-2228 lock Correct details, R-2235 part rounding, R-2240 owed links to source, R-2246 schedule collapsed |
| Money totals, credit, pricing | R-2229 one MRR function, R-2233 subscription events, R-2234 computed outstanding, R-2236 auto-apply credit, R-2237 renewal price rule, R-2238 deferred revenue |
| GST | R-2256 tax once per subscription, R-2259 SAC required, R-2248 Tax Deductor + GST-TDS |
| Customers, payments, UI | R-2258 part-paid status, R-2249 save and add subscription, R-2250 next part date + credit + emails, R-2244 merge customers, R-2260 duplicate-email warning, R-2241 subscription number, R-2245 customer emails settings, R-2247 reports, R-2239 dashboard loading |
| Data repair | R-2223 pre-R-2095 invoice dates |
