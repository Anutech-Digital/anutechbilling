# Playbook: bank money-in reconcile with Zoho Books (staging)

Written by the R-2169 observer, 30 Oct 2026, from the October and September reconcile runs on a
staging tenant's bank account (card R-2094), plus R-2095, R-2098, R-2099 and R-2092.
Every reconcile worker reads it first. The observer adds new lessons after each run (section 8),
through a card push.

## 1. Before you start (5 minutes, saves hours)

1. **Use your own browser tab.** Open a new tab for staging and one for Zoho. Never type into a tab
   another agent opened. Once a coordinator's keystrokes landed in a worker's tab and a customer
   line had to be redone.
2. **Check the session first.** Load `/accounting/banking` once. If it redirects to `/login`, stop
   and ask Pardeep to sign in. Never type a password. If the browser pane refuses the staging URL
   ("navigation denied"), stop and ask the coordinator to re-allow it. Do not retry in a loop.
3. **Read the reconcile card.** Read its decisions, email rule, `needsDecision`, and the last liveLog
   line (what is done, what is open). Do not redo lines that are already done.
4. **Pull the Zoho payment map once.** In the Zoho tab, read `/api/v3/customerpayments` for the month.
   For each payment you need: customer, amount, date, reference, invoices paid, TDS. Each invoice line
   description has `Subscription Period (dd/mm/yyyy - dd/mm/yyyy)`, which is the subscription start
   and renewal date. Keep the map in your notes so you do not look up each line again.
5. **Heartbeat.** Write a liveLog on the card about every 30 minutes (done count, next line).
   Otherwise the board frees the card after 60 minutes. If the session is getting long, stop at a
   clean line and write a HANDOFF entry: done/total, open lines with reasons, and the method.
   A month of more than ~40 lines is better split into batches, one worker per batch.

## 2. Hard rules (never break)

- **Never press Send, Email or WhatsApp** on a quote, invoice, receipt or reminder. Creating documents
  is fine. Sending them is not.
- **Staging only.** Never touch live. Never bulk-delete or wipe staging tenant data (it is real
  data). Leave test leftovers (for example a duplicate customer) alone and list them for cleanup.
- **Prices always come from the Zoho invoice**, not the catalog. Rates with paise are allowed.
- **Customer emails: add the Zoho primary-contact email** for new customers (Pardeep, 30 Oct). This is
  safe because the staging R-1403 allowlist only mails the company's own domain. If Zoho has no email
  or phone, use **Save without contact**.
- **TDS only at exactly 1%, 2% or 10%** of the taxable amount, allowing ₹1 for rounding.
  Anything else (for example a short-payment of about 3%, or one a little above 10%) is not TDS.
  Leave it as due and list it for Pardeep.
- **Round-off only up to ₹50, and only when the item is fully settled** (R-2098 rule). A part-paid item
  never gets a write-off.
- **Razorpay key:** a live key on staging may only be used to READ settlements (R-2155). Never create
  a pay link or checkout with it.
- **Data repairs and prices are Pardeep's call.** Unknown money, odd TDS and term clashes go on the
  list (section 7). Do not guess.

## 3. Method, line by line (Banking → the bank account → Unmatched → Money in → month)

For each credit, find it in your Zoho map, then pick **one** path:

| What the line is | Path |
|---|---|
| Payment for an open quote/invoice already in the app | Reconcile → Customer → pick the open item(s). If one line covers several items, use multi-pick (R-2098). Any extra becomes an advance. |
| New customer, first sale | Reconcile → Customer → **New customer** (Zoho name, GSTIN, PAN, address, phone, email) → **A new sale** → products at Zoho rates → Commitment (annual / monthly / one_time) → Payment (yearly / half-yearly / quarterly) → subscription start = Zoho service-period start. |
| Pro-rata / extra seats on a plan the app does not have yet (for example a customer whose base was paid before go-live) | **Opening subscription first** (base plan from Zoho's last full-term invoice: seats, rate, start, term). **Then** Subscriptions → **Manage seats** → quote → back to the bank line → reconcile against that open quote. Never the other way round. Manage seats needs the base. |
| Monthly customer with past months | Past months = one_time sale lines. Latest month = **monthly subscription** with the Zoho period start, so renewals run. |
| Renewal of a monthly sub that is behind | Renewals → Generate. It bills the **oldest** unbilled month first (R-2095). Check the "N months due" text before you click. |
| Razorpay settlement (`RAZORPAY` narration) | Reconcile → **Fetch settlement** (needs the live key in Settings → Integrations, owner-only). Match each payment to its customer, then **Reconcile settlement** (books the fee and GST). **Never use plain Match**, because it skips the fee. A payment that is not in Zoho goes on the list. |
| FD sweep-in credit | Own transfer → mark reconciled. |
| Interest credit | Other / manual for now (gap: no interest-income option yet). |
| IMPS return pair | Mark the debit and the return as a manual pair. |
| Part payment | Book it, leave the rest due (as Zoho does). Never invent TDS to close the gap. |

The amount check at the bottom of the drawer has these outcomes:
- Exact: Save.
- Short by exactly 1/2/10% TDS: **TDS deducted** (the form auto-detects it).
- Short by up to ₹50 and fully settled: round-off.
- Extra: advance.
- Anything else: part payment plus a list entry.

Old receipts whose shortfall is TDS: **Record balance payment → Customer deducted TDS**.

## 4. Checks after each line

- The line leaves Unmatched, and the invoice date is the **bank date** (not today).
- The customer has no duplicate (search by GSTIN before creating). If the reconcile popup does not show a
  customer you just created, refresh the list. Do not create it again.
- The subscription has the right domain. Zoho bills per end-domain, so a typo (`.com` vs `.org`)
  blocks Opening later. Fix it with **Correct details → Domain**.

## 5. Known app gaps (work around, don't fight)

The live list is on card R-2095 (`gaps30Oct`), with Razorpay on R-2099. If a screen refuses something
twice, stop. Write the exact message and line on the card as a gap, move to the next line, and come back
after the fix ships.

## 6. Time savers learned

- Do all lines for one customer together (base, then seats, then later months).
- Batch the Zoho lookups: one payment-map pull per month, not one per line.
- Create missing catalog products before you start the month (support charges, hosting, control panel,
  SSL, mail plans, cloud, website edits and similar items seen in Zoho). Use the Zoho rate, leave cost
  blank, and list them for Pardeep.

## 7. What to list for Pardeep (end of run, in `needsDecision` on the card)

One line each, with the amount and date:
- Money not in Zoho: foreign/USD inward credits, unknown payer names, and Razorpay payments with no
  Zoho invoice (give the pay_ id and order id).
- TDS that is not 1/2/10%. Customer short-paid GST only (B2B2C).
- Term or seat clashes between Zoho and the app (for example quarterly in Zoho vs half-yearly in the
  app, or a first bill that differs from Zoho's).
- Data repairs needed on staging (for example a missing month's bill, or back-dated invoices).
- New products you created (name + rate) and duplicates or test leftovers to clean.

## 8. Lessons log (observer appends after each run)

- 29–30 Oct, October run: Opening subscription before Manage seats; one-time + monthly split for
  history; emails from Zoho are fine on staging; Razorpay needs the live key, and a false "not the
  right settlement" was a paise/rupee bug (fixed in R-2099).
- 30 Oct, September run: the TDS auto-detect in the new-sale form works for exact 1/2/10%. Part-paid
  new sales issued no GST invoice, and half-yearly sales auto-created a SENT next quote (both P0 on
  R-2095). Use your own tab. Hand off at a clean line when the session gets long.
- 30 Oct, Sep finish runs (three workers in a row; a few lines left for the owner):
  - **Razorpay line with no quote in the app:** New quote (Zoho items and rates) → **Mark as sent** →
    **Record payment** (method Razorpay, reference = the `pay_` id, date = the Zoho payment date) →
    back on the bank line **Fetch settlement** → **Reconcile settlement** (books fee and GST).
  - **Date fields:** set them with `form_input` as `YYYY-MM-DD`. Typing or clicking the picker can
    land on a different day (one form auto-set the day before the Zoho date). Read the value back.
  - **Low-margin quotes** (below the margin floor) show **Review & decide** and must be approved before
    **Mark as sent**. Approving a price is an **owner decision**. A worker may approve only when the
    price equals the Zoho invoice exactly; otherwise list the quote for Pardeep and move on.
  - **Overseas customer:** choosing a non-India country sets Overseas and USD. Use Zoho's exchange
    rate on the quote. A small rupee gap left due is the FX difference: note it, do not write it off.
    Do not press Generate for an export invoice (it dates it today and treats it as B2C). If the
    country is missing from the region list, stop and list it (app gap).
  - **TDS on an old receipt:** Record balance payment → **Customer deducted TDS**, bank amount 0.
    The multi-item (split) reconcile has no TDS option, so book TDS afterwards this way.
  - **Count from the app, not the handoff:** Banking → Unmatched + Money in + month filter is the
    real total. Handoff counts drifted (one month was two lines off).
  - **Zoho bills per end-domain.** One customer can hold several domains on different terms and
    start dates. Make one subscription per domain and check each against its own Zoho invoice;
    fix a wrong domain or date with **Correct details**, never by a new sale.
  - **Find bank lines by reference number** (UTR / `pay_` id), not by name or amount.
  - **Manage seats → add-seats with effective date = Zoho period start** gives the Zoho amount
    within ₹5. Larger gaps mean the base (seats, rate, term) is wrong: fix the base first.
