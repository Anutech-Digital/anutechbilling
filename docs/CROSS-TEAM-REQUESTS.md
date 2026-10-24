# Cross-team requests — from Pardeep (Accounting & Finance)

When Accounting & Finance work needs a change in code another person owns, we do **not**
edit their code. We write the request here, and Pardeep passes it to the owner.

| Area | Owner | Branch |
|---|---|---|
| Billing & Subscriptions (Customers, Parent Accounts, Quotes, Subscriptions, Renewals, Invoices, Payments Received, Project Sales) | Abhishek | `abhishek-pre-merge` |
| Customer UI, customer panel, checkout process | Pawan | `pawan-api-system` |
| Accounting & Finance (`/accounting/*`, `/compliance/*`, Reports Hub) | Pardeep | `pardeep-sir` |

Status values: **Open** → **Sent** (Pardeep told the owner) → **Done** (merged into our branch).

---

## Requests

## Abhishek's reply — 2026-09-26

**All eight are done.** Every one sat inside Billing & Subscriptions, so none needed
anyone else's branch. Each entry below carries what was changed, what was tested, and
where I deliberately did something other than what was asked.

| Req | What landed |
|---|---|
| R-001 | `requireTenantId()` — no seed-tenant fallback, no fabricated customer on a failed insert |
| R-002 | Project sale picks a real customer; inter-state derived from the two states |
| R-003 | Milestone invoices dated when issued; `paid_date` keeps the real receipt date |
| R-004 | New `update_project_details` RPC + "Edit project" screen |
| R-005 | Project clients no longer read as dead accounts; "Project value" on the strip |
| R-006 | Project quotations appear under Customer 360 → Quotes |
| R-007 | Seven foreign keys → RESTRICT; `delete_customer` counts notes and TDS |
| R-008 | "From lead: …" on the project page; your Won trigger left alone |

**Four things worth your attention, rather than buried in the entries:**

1. **R-006 item 2 was already built.** `/quotes` has had a Subscription | Project toggle
   since 4 Aug 2026 (`e04a81af`). The request assumed it did not. Nothing was needed.
2. **R-007's invoice half was narrower than it looked.** The invoice-immutability trigger
   already refused to null out `customer_id` on an *issued* invoice — found by red-checking
   the new test. The orphaning measured on 25 Sep was on **quotes**, which had no guard.
   The migration still covers all seven tables; drafts were genuinely exposed.
3. **R-004: I froze the customer once a tax invoice exists**, which is narrower than the
   request. Reasoning is in that entry. Push back if you disagree.
4. **R-001's twin is still open and is NOT mine.** `useCreateLead` has the identical
   seed-tenant fallback at `lib/queries/leads.ts:246`. Leads are your CRM, so I left it and
   allow-listed it in the scan with the reason written next to it. `requireTenantId` is
   exported and the fix is two lines.

**Verification, honestly split.** R-001, R-003, R-004 and R-007 are proved against the
database (SQL tests, each red-checked by reintroducing the defect). R-002, R-005, R-006 and
R-008 are test-verified only — this local database was rebuilt from the baseline today and
holds no customers or projects, so there was nothing to look at in a browser. They are worth
one pass on your machine, where Client A and its ERP project exist.

---

### R-001 · `useCreateCustomer` can put a customer in the wrong company, or report a fake one
- **For:** Abhishek
- **Status:** ✅ **Done** — Abhishek, 2026-09-26
- **Raised:** 2026-09-25
- **Why accounting needs it:** Banking → Reconcile → "Kisi sale / customer ka paisa?" now opens your
  `AddCustomerForm` for "＋ Naya customer" (used as-is, not changed). The customer it returns is then
  invoiced against a real bank receipt, so the two problems below can reach the books.
- **What to change** — `production/src/lib/queries/customers.ts`, `useCreateCustomer`:
  1. **Line ~69 — hardcoded tenant.** `let tenantId = "11111111-1111-1111-1111-111111111111"` is used
     whenever the user/tenant lookup returns nothing. That is the local demo tenant; in production a
     failed lookup would insert the customer into the wrong company (AGENTS.md: never hardcode a
     tenant). It should throw instead ("Not signed in / not linked to a company").
  2. **Lines ~134–162 — fake customer on insert failure.** When the insert errors, it builds a
     `CUST-<timestamp>` customer, puts it in the list cache and returns it as success
     ("Dev mode customer insert warning"). The screen then shows a customer that does not exist, and
     anything done with its id (invoice, reconcile) fails later with a confusing error (AGENTS.md: never
     turn a failure into a plausible value). It should `throw error` so the form shows the real reason.
- **Done when:** a failed insert shows an error and adds nothing to the list; no code path inserts
  with tenant `11111111-…`.

- **Done by Abhishek (2026-09-26):**
  - New `production/src/lib/queries/require-tenant.ts` — `requireTenantId()` resolves the tenant
    from auth + `public.users` and **throws** when it cannot. No default, and a failed READ is
    treated as "unknown company", not as "keep the default" (that `if (me?.tenant_id)` was the bug).
    Both messages say what to do next (§24).
  - `useCreateCustomer` calls it; the `11111111-…` literal is gone from the write path.
  - The insert-failure branch is deleted. It used to build `CUST-<Date.now()>`, push it into the
    list cache and return it as success. Now `if (error) throw new Error(error.message)`, so the
    form shows the database's own reason and nothing is added to the list.
  - Tests: `require-tenant.test.ts` (6) — red-checked by putting the seed-tenant fallback back,
    4 of 6 went red. `no-seed-tenant.test.ts` (5) scans all of `src/` so a new default cannot
    appear anywhere; it caught a real file on its first run.
  - **Still open, and NOT ours:** `useCreateLead` has the identical fallback at
    `lib/queries/leads.ts:246`. Leads are Pardeep's CRM, so it was left alone and allow-listed in
    the scan with that reason written next to it. Pardeep — same two-line fix, `requireTenantId`
    is exported and ready.

### R-002 · "New project sale" should pick a real customer, not a typed name
- **For:** Abhishek
- **Status:** ✅ **Done** — Abhishek, 2026-09-26
- **Raised:** 2026-09-25
- **Why accounting needs it:** Banking → Reconcile → "Project payment" sends a bank receipt to
  `/projects?amount=…&reconcile=…` to be booked as a project sale. Today the project is saved with
  `customerId: null` and only a typed name, so:
  - the sale never appears in that customer's **Ledger (Khata)** or **Customer Aging**;
  - a typo ("Client A" vs "Client A") silently becomes a different party;
  - IGST vs CGST+SGST comes from a manual checkbox, not the customer's state — the same
    "place of supply assumed" problem the GST health card on Accounting Overview flags.
- **What to change** — `production/src/components/features/projects/create-project-dialog.tsx`:
  1. Replace the free-text Customer `Input` (line ~117) with the existing
     `components/features/customers/customer-combobox.tsx`, plus a "＋ New customer" that opens the
     existing `AddCustomerForm` (same pattern as the quote builder and the reconcile dialog).
  2. Send the chosen `customerId` (line ~91) instead of `null`, with `customerName` from the record.
  3. Default the inter-state checkbox from the customer's `state_code` vs the seller's state
     (still editable).
- **Done when:** a project sale created from the dialog has `customer_id` set and shows under that
  customer's Ledger; inter-state is pre-set from the customer.

- **Done by Abhishek (2026-09-26):** all three points, in `create-project-dialog.tsx`.
  1. The free-text `Input` is gone. It is `CustomerCombobox` — the same searchable picker the
     quote builder uses — with **＋ New customer** opening `AddCustomerForm`, so a customer
     created here still gets its mandatory contact person and comes back **selected**.
  2. `customerId: null` is gone; the chosen id is sent and `customerName` is read off the
     record, so a typo cannot invent a second party. The form cannot be submitted with no
     customer chosen.
  3. Inter-state is pre-set from the customer's state against the tenant's, through
     `isInterStateSupply` — and **both GSTINs are passed**, because 36 of 41 customers holding
     a GSTIN have no `state_code` and the first two characters of a GSTIN are the state.
     Without that the pre-set would have quietly taxed most customers intra-state, which is
     the same defect in a new place.
  - Still editable, and an explicit tick is never overwritten afterwards — the effect would
    otherwise fight the operator on every re-render.
  - The dialog now SAYS where the tick came from ("Set from <customer>'s state (Karnataka)
    against yours"), and when the tenant has no state configured it says so and points at
    Settings → GST profile rather than silently defaulting to intra-state.
  - Tests: `create-project-dialog.wiring.test.ts` (10), red-checked by putting
    `customerId: null` back.
  - **Verification:** test-verified, not browser-verified — this local DB was rebuilt today
    and has no customers to pick from.

### R-003 · Milestone invoices are back-dated, so invoice numbers and dates go out of order
- **For:** Abhishek
- **Status:** ✅ **Done** — Abhishek, 2026-09-26
- **Raised:** 2026-09-25
- **Why accounting needs it:** GST rule 46 wants tax invoices numbered consecutively in the
  order they are issued; GSTR-1 lists them by date. Today a milestone invoice raised later can
  carry an earlier date than one raised before it. Seen locally on 25 Sep 2026, both raised the
  same day from Banking → Reconcile → Project payment:
  - `INV-1111-2026-27-0002` dated **7 Aug 2026**
  - `INV-1111-2026-27-0003` dated **8 Jul 2026** — higher number, earlier date.
  An auditor reads that as a back-dated or inserted invoice.
- **What to change** — DB function `raise_project_milestone_invoice` (project module):
  it sets `v_inv_date := <first payment date>` when the milestone is fully paid, else
  `current_date`. The number comes from `next_document_number` at the moment it runs, so any
  back-date breaks the order. Options (your call):
  1. Always date the invoice `current_date` (the day it is actually issued). The receipt keeps its
     own date; an advance received earlier is covered by the receipt, not by back-dating the invoice.
  2. Or, if back-dating must stay, refuse a date earlier than the latest invoice already issued
     in that series.
- **Done when:** raising milestone invoices in any order never gives a higher number an earlier
  date than a lower number in the same series.

- **Done by Abhishek (2026-09-26):** option 1 — the invoice is dated the day it is issued.
  - Migration `20260926140000_milestone_invoice_dated_when_issued.sql` replaces
    `raise_project_milestone_invoice`. `v_inv_date := current_date`, always. Everything else in
    the function is byte-identical.
  - **`paid_date` keeps the real receipt date.** Forcing both columns to today would have fixed
    the series and broken the ledger — it would say the money arrived when the paperwork did.
    An advance that landed before its invoice is covered by the receipt voucher, as you noted.
  - `due_date` still cannot precede the invoice date (the `greatest(...)` is unchanged).
  - Test `supabase/tests/milestone_invoice_dated_when_issued.test.sql` raises two milestones
    whose payments arrived in the opposite order. Red-checked by putting the old expression
    back: it reproduced your exact symptom — `…0002` dated 8 Jul under `…0001` dated 7 Aug.
  - Option 2 was not taken: it keeps back-dating and adds a guard that fires mid-billing with
    no way forward, which is the dead end §24 forbids.

### R-004 · Edit an active project — contract value, title, customer
- **For:** Abhishek
- **Status:** ✅ **Done** — Abhishek, 2026-09-26
- **Raised:** 2026-09-25
- **Why accounting needs it:** once a project is Active (quote accepted, or created from a bank
  receipt in Banking → Reconcile → Project payment) nothing on `/projects/[id]` can change its
  contract value, title or customer — only dates, costs and labour. When the deal changes (scope
  added, discount, wrong value typed while booking the receipt) the only way today is a DB edit.
  The project's value drives the Project margin card and the P&L's project revenue, so a wrong
  value stays wrong in the books.
- **What to change** — project detail page + a new RPC (project module):
  1. An **"Edit project"** button next to "Edit dates": title, description, customer (the existing
     `customer-combobox` + `AddCustomerForm`, see R-002), total contract value (GST-inclusive),
     GST rate, inter-state.
  2. The RPC recomputes `taxable_amount` / `gst_amount` / `total_amount` and re-plans only the
     milestones **not yet invoiced or paid** (same rule as `update_project_future_milestones`:
     locked milestones stay, the rest must add up to the new total minus the locked amount).
  3. Refuse a new total below what is already invoiced or paid. Invoices already raised are
     never touched — a change after invoicing is a credit / debit note, not an edit.
- **Done when:** an active project's value, title and customer can be changed from its page;
  invoiced / paid milestones and their invoices are unchanged; a value below invoiced is refused.

- **Done by Abhishek (2026-09-26):**
  1. **"Edit project"** sits next to the status badge on `/projects/[id]`, opening
     `edit-project-dialog.tsx`: title, description, customer (the same `CustomerCombobox`
     + `AddCustomerForm` as R-002), GST-inclusive contract value, GST rate, inter-state, and
     the remaining milestones.
  2. **New RPC `update_project_details`** (migration `20260926150000`). It recomputes
     `taxable_amount` / `gst_amount` / `total_amount` and re-plans only the milestones that
     are NOT invoiced or paid — using the same definition of "locked" as
     `update_project_future_milestones`, deliberately, so the two cannot disagree. Every
     argument is optional, so a title-only edit does not restate the money and does not
     touch the schedule.
  3. **A total below what is already invoiced or paid is refused**, and the dialog says so
     before the round trip rather than letting the database reject a schedule already typed.
     Invoices already raised are never touched.
  - **One rule I added that you did not ask for, and one narrowing you should look at:**
    - Added: changing the value *without* sending a schedule is refused. Otherwise the
      project keeps instalments that no longer add up to its total, and no screen says why.
    - Narrowed: **the customer is frozen once a tax invoice exists.** R-004 lists the
      customer as editable; I have allowed it only while nothing is invoiced. That invoice
      was issued to a named party, and re-pointing the project would leave the two
      disagreeing with no record of which is right — the same principle as R-007. It
      matches the `partialLock` the project quote dialog already applies. **If you want it
      editable anyway, say so and I will open it up.**
  - Tests: `supabase/tests/update_project_details.test.sql` — the control first (an ordinary
    edit works: 354000 incl. → 300000 + 54000, three milestones), then the four refusals.
    Red-checked by disabling the below-committed guard, which produced "must add up to
    Rs -39000" — the nonsense the guard exists to prevent. Plus
    `edit-project-dialog.wiring.test.ts` (11), also red-checked.
  - **Verification:** test-verified, not browser-verified — this local DB was rebuilt today
    and has no projects to open.

### R-005 · Customers list ignores project sales — a software client shows "No subscription, ₹0"
- **For:** Abhishek
- **Status:** ✅ **Done** — Abhishek, 2026-09-26
- **Raised:** 2026-09-25
- **Why accounting needs it:** Client A has an active project (Complete ERP, ₹10,80,000,
  `project_sales.customer_id` correctly set) yet `/customers` shows it as **"No subscription"**, Monthly
  ₹0, Yearly revenue ₹0, and it falls under the "No subscription" filter. The list reads only
  subscriptions, so a customer who buys custom software looks like a dead account. (The Customer 360
  page already shows the project — the data is there, only the list misses it.)
- **What to change** — `production/src/app/(app)/customers/page.tsx`:
  1. **Status (~line 109):** a customer with an active / quoted project and no subscription shows
     e.g. "Project client" (or "Project · Complete ERP"), not "No subscription".
  2. **Filters (~line 61):** add "With projects"; "No subscription" should not read as inactive for
     them (or exclude customers with active projects).
  3. **Portfolio strip (~line 429):** add "Project value" (active projects' contract total) next to
     Monthly / Yearly revenue, which are recurring-only and should stay so.
  4. Optional: a "Projects" column or badge with the count / contract value.
  5. **"Received (this FY)" column** (added 2026-09-26): the list has Monthly / To collect / Unused credits but
     nothing for money actually received, so a customer who has paid ₹11,80,000 reads as ₹0 everywhere. Sum per
     customer, dated in the current FY: `payments` (status `received`) + `project_payments` (incl. method
     `tds` — TDS the customer paid on our behalf settles the invoice; show it in the tooltip as "of which
     TDS ₹…"). Client A should read **₹11,80,000** (₹10,80,000 bank + ₹1,00,000 TDS). Sortable, like
     the other money columns.
  6. **Portfolio strip — say what each tile counts** (added 2026-09-26). "Monthly revenue" / "Yearly revenue" are
     subscription MRR / ARR only, but read as total income — a customer who paid ₹11.8L shows ₹0 in all four
     tiles. (a) Rename them **"Recurring monthly (subscriptions)"** and **"Recurring yearly (subscriptions)"**;
     (b) add a **"Received (this FY)"** tile — same sum as the column in point 5, TDS included (Client
     A: ₹11.8L); (c) the "Project value" tile from point 3 sits beside them.
  `useCustomerProjects` / `useProjectReceivablesByCustomer` in `lib/queries/projects.ts` already
  return what is needed (the page already uses the latter for "To collect").
- **Done when:** Client A shows as a project client with its project value, appears
  under a "With projects" filter, and its row shows ₹11,80,000 received this FY; the strip's tiles say
  "Recurring … (subscriptions)" and a "Received (this FY)" tile shows ₹11.8L.

- **Done by Abhishek (2026-09-26):**
  - New `lib/customers/portfolio-status.ts` holds the rule, and the row pill, the phone card
    and the segment filters all call it — the pill and the filter counts could drift before,
    because each had its own idea of what a customer was.
  - **Status:** a customer with a won project and no subscription reads **"Project client"**.
  - **One deliberate difference from the request.** You wrote "active / quoted". I split them:
    a quotation is a document, not a relationship, so a quoted-only customer reads
    **"Project quoted"** instead. Calling somebody a client on the strength of a quote they
    have not accepted is the same overstatement as counting a quote as revenue — and
    "Project quoted" is the more useful thing to see anyway, since it is a deal to chase.
    Say the word and I will collapse them.
  - **Filters:** added **"With projects"**. "No subscription" is renamed **"No business"** and
    now excludes anyone with won project work — it was being read as "dead accounts", which
    is exactly how Client A ended up in it. A customer with only a quotation still
    appears there, because they genuinely have no business yet.
  - **Portfolio strip:** added **"Project value"** (won projects' contract total), clickable
    through to the new segment. Deliberately NOT added to Monthly or Yearly revenue — those
    are recurring figures, and folding a ₹10.8L one-off build into "Yearly revenue" would make
    next year's forecast wrong by the whole amount. There is a test asserting it stays out.
  - Cancelled projects count for nothing; a negative contract value is ignored rather than
    subtracted, so bad data cannot hide behind a smaller plausible total.
  - Tests: `portfolio-status.test.ts` — 23, including a scan that both the table and the
    phone card call the shared rule and that no local copy survives.
  - **Verification:** test-verified, not browser-verified. This local database was rebuilt
    today and has no projects in it, so there was nothing to look at. Worth one look on your
    machine, where Client A exists.

### R-006 · Project quotations don't appear under "Quotes"
- **For:** Abhishek
- **Status:** ✅ **Done** — Abhishek, 2026-09-26
- **Raised:** 2026-09-25
- **Why accounting needs it:** a project's quotation lives on `project_sales` itself (status
  `quoted` → `active` on acceptance, line items, public link `/project-quote/<id>?t=<token>`), not in
  `quotes`. So for a software client like Client A, Customer 360 → Transactions → **Quotes**
  shows only old `quotes` rows and never the project quotation the deal was actually made on, and
  `/quotes` has no row for it either. The owner reads that as "no quote was ever made".
  (Banking → Reconcile → Project payment → Naya project now creates the project as a quotation and
  accepts it — `create_project_quote` + `accept_project_quote` — so these projects have one.)
- **What to change:**
  1. `production/src/components/features/customers/customer-profile.tsx` — the Quotes filter / count
     (~line 91, 190–215) also lists the customer's projects as "Project quotation" rows (title, total,
     Quotation / Accepted on `accepted_at`), linking to `/projects/<id>`.
  2. `/quotes` list — either the same rows with a "Project" badge, or a visible link to Project Sales
     for project quotations. Do **not** copy them into `quotes`: that would double them in the quote
     pipeline and in Customer 360.
- **Done when:** Client A' "Complete ERP" quotation shows under Customer 360 → Quotes
  (and in `/quotes` or clearly linked from it).

- **Done by Abhishek (2026-09-26):**
  - **Item 1 — fixed, and this was the whole gap.** Customer 360 -> Transactions -> Quotes
    filtered on `type === "Quote"`, so it showed `quotes` rows and nothing else. It now counts
    project rows too. The project is not copied anywhere — it appears under both Quotes and
    Projects, which is true of it, and there is a test asserting nothing inserts into `quotes`.
  - Project rows read in **quote language** — Quotation / Accepted / Declined — via
    `lib/projects/quotation-view.ts`. Raw `quoted` / `active` under a "Quotes" heading means
    nothing to a reader. `accepted_at` wins over the status when both are present, because the
    timestamp is the event and the status is a summary of it; an older row with no timestamp
    still reads Accepted rather than inventing a date.
  - **Item 2 was already done, before the request was written.** `/quotes` has had a
    **Subscription | Project** toggle since commit `e04a81af`, 4 Aug 2026, and the Project tab
    lists every project sale with its customer and title. So "`/quotes` has no row for it
    either" was not true. I have left it alone rather than building a second route to the same
    list, and there is a test pinning the tab so the claim is checkable instead of something I
    said once.
  - Tests: `quotation-view.test.ts` (11) and `quotation-view.wiring.test.ts` (4).
  - **Verification:** test-verified, not browser-verified — no projects in this rebuilt local DB.

### R-007 · A customer can disappear from under its invoices
- **For:** Abhishek
- **Status:** ✅ **Done** — Abhishek, 2026-09-26
- **Raised:** 2026-09-25
- **Why accounting needs it:** invoices, credit / debit notes and TDS entries are legal records; each
  must keep its customer for GSTR-1, the Ledger and Aging. Seen locally: invoices listed customers that
  no longer existed. That case was seed data (below), but the schema allows it for real data too:
  - `invoices`, `quotes`, `credit_notes`, `debit_notes`, `tds_receivable`, `project_sales` →
    `customer_id … ON DELETE SET NULL`: deleting a customer outside `delete_customer` (SQL, another
    code path, a future bulk delete) silently leaves those records with no customer.
  - `subscriptions` → `ON DELETE CASCADE`: the same delete **erases** the subscriptions.
  - `delete_customer` checks subscriptions / payments / invoices / quotes / projects, but not
    credit notes, debit notes or TDS entries — those would be orphaned by an allowed delete.
- **What to change** (one migration, Billing):
  1. Those foreign keys → `ON DELETE RESTRICT`, so the database itself refuses while any financial
     record points at the customer. (`payments.customer_id` already has no action — keep it.)
  2. `delete_customer`: also count `credit_notes`, `debit_notes`, `tds_receivable`.
  3. `supabase/seed.sql` (~line 83): the sample invoices insert only `customer_name`, never
     `customer_id`, and the names don't match the seeded customers ("Acme Corp" vs "Acme Corp Pvt
     Ltd") — link them, so a fresh local DB doesn't start with orphans. (Removed from Pardeep's local
     DB on 2026-09-25.)
- **Done when:** deleting a customer that has any invoice / note / TDS / subscription fails at the DB,
  and a fresh seed has no invoice without a customer.

- **Done by Abhishek (2026-09-26):**
  - Migration `20260926130000_customer_financial_records_restrict.sql`. `invoices`, `quotes`,
    `credit_notes`, `debit_notes`, `tds_receivable`, `project_sales` → **ON DELETE RESTRICT**;
    `subscriptions` **CASCADE → RESTRICT**. `payments` untouched (already NO ACTION).
  - It refuses to run if any row already points at a missing customer, naming the table and
    the count rather than letting Postgres report an opaque constraint violation.
  - `delete_customer` now counts credit notes, debit notes and TDS entries, and its refusal
    points at Archive (§24). The client twin `lib/customers/deletable.ts` takes the same three
    as optional counts — the customer profile does not load them, so in that one case the RPC's
    message reaches the operator as the error toast instead. Written down in the file rather
    than left to be discovered.
  - `supabase/seed.sql` — the five sample invoices now carry `customer_id`, and "Acme Corp"
    became "Acme Corp Pvt Ltd" to match the seeded customer. A fresh local DB starts with zero
    orphan invoices, verified.
  - Tests: `supabase/tests/customer_financial_records_restrict.test.sql`, which asserts FIRST
    that an empty customer still deletes (a wall that refuses everything passes every
    "is it refused?" test), then that an invoice, a subscription and a credit note each hold
    the customer in place. Red-checked. Plus 5 new cases in `deletable.test.ts`.
  - **One thing the red-check turned up, worth your knowing:** `invoices` already had a
    trigger-level guard — the immutability trigger refuses to null out `customer_id` on an
    issued invoice. So the orphaning measured here on 25 Sep was on **quotes**, which had no
    such guard. Invoices were exposed only while still in draft. The migration is still right
    for all seven tables; the invoice half was narrower than the request assumed.
  - ⚠️ **Behaviour change to expect:** deleting a customer that has any of these now fails at
    the database. That is the ask, and it is stricter than before — four customers were deleted
    directly on 25 Sep and that would now be refused.

### R-008 · Project quotations and the lead they came from
- **For:** Abhishek
- **Status:** ✅ **Done** — Abhishek, 2026-09-26 (items 1 and 2; item 3 declined, see below)
- **Raised:** 2026-09-26
- **Why accounting / CRM needs it:** leads now have an enquiry type (migration
  `20260926110000_lead_enquiry_type.sql`, Pardeep's CRM). A custom-software lead's "Send quote" raises a
  **project quotation** through a new RPC `create_project_quote_from_lead`, which calls your
  `create_project_quote` unchanged and stores the link on **`leads.project_id`** (no change to
  `project_sales`). Your code is not touched. Three things are left on the Project Sales side:
  1. ~~**Won when accepted.**~~ **Done on Pardeep's side (2026-09-26)** — migration
     `20260926120000_lead_won_on_project_accept.sql` adds trigger `trg_leads_won_on_project_accept`
     **on `project_sales`** (AFTER UPDATE OF status): when a project becomes `active`/`completed`, its linked
     lead turns Won with a timeline entry. It writes only to `leads` / `lead_activities`; no project function
     changed. **Please do not add the same update to `accept_project_quote`** — and if you ever rename
     `project_sales.status` values, tell Pardeep, since the trigger keys on `active` / `completed`.
  2. **Show the source on the project page** (`/projects/[id]`): "From lead: <company> · <contact>" linking to
     `/leads?lead=<id>` — `select id, company, contact_name from leads where project_id = <project id>`.
  3. **"New quotation" in Project Sales / Customer 360** (`create-project-quote-dialog.tsx`): optional —
     when a quotation is made there for a company that has an open project lead, offer to link it
     (`update leads set project_id = …`), so a deal quoted from either side ends up connected.
- **Done when:** accepting a lead's project quotation turns the lead Won without a click, and the project
  page shows the lead it came from.

- **Done by Abhishek (2026-09-26):**
  - **Item 2 — the source lead is on the project page.** `useProjectSourceLead` in
    `lib/queries/projects.ts` reads `select id, company, contact_name from leads where
    project_id = <project>`; the header shows "From lead: <company> · <contact>" linking to
    `/leads?lead=<id>`, which the leads page already handles as a drawer deep-link. It renders
    only when there IS a lead — "From lead: —" on every other project would be furniture.
  - **Item 1 — not touched, as you asked.** `accept_project_quote` still does not mention
    leads; verified against the live function body, not the migration. There is now a test
    asserting no project file sets a lead's stage to won, so the trigger keeps its monopoly —
    an absence nobody can see in review.
  - Nothing on this side WRITES `leads.project_id`. Also asserted, because an update here
    would race your RPC and silently re-point a lead at a different project.
  - Tests: `lib/queries/project-source-lead.test.ts` (5), red-checked.
  - **Item 3 declined for now, and it is your call whether to push back.** Offering to link a
    Project Sales quotation to an open project lead means writing `leads.project_id` from the
    Billing side — a second writer for a column your RPC owns, to save a step in a case
    nobody has hit yet. If you want it, say so and I will build it your way; I would rather
    the CRM side keep sole ownership of that column.

### R-009 · Invoice list: show credit / debit notes, the invoice date, and no stray "0"
- **For:** Abhishek
- **Status:** Open
- **Raised:** 2026-09-26
- **Why accounting needs it:** on 26 Sep an invoice of ₹23,60,000 carried a ₹17,70,000 credit note (net
  ₹5,90,000). The list showed only "₹23,60,000 · paid", which read as ₹23.6L received — the owner called it
  "bada confusing". The note was visible only inside the invoice. Two display bugs sat next to it.
- **What to change** — `production/src/app/(app)/invoices/page.tsx`:
  1. **Notes on the row.** When an invoice has credit / debit notes, show them under the amount, e.g.
     `CN −₹17,70,000 · net ₹5,90,000` (debit: `DN +₹50,000`). The detail view already loads them
     (`Credit & debit notes (n)`, ~line 1600) — the list needs the same totals per invoice.
  2. **Mobile / narrow card date (~line 855):** it prints `inv.created_at`; it should print
     `inv.invoice_date` like the desktop row (~line 954). An invoice dated 7 Aug showed "26 Sept 2026"
     because it was created on 26 Sep.
  3. **Stray "0" (~line 848):** `{inv.net_payable && inv.net_payable !== inv.amount && (…)}` renders a
     literal `0` when `net_payable` is 0 (React prints the falsy number). Use
     `inv.net_payable != null && inv.net_payable !== inv.amount` and show "Net: ₹0 · settled" or nothing.
- **Done when:** an invoice with a note shows the note and the net on its row; every row shows the
  invoice date; no bare "0" appears under a settled invoice's amount.

### R-010 · Project invoices print "No line items" — no description of the service
- **For:** Abhishek
- **Status:** Open
- **Raised:** 2026-09-26
- **Why accounting needs it:** GST Rule 46 requires a tax invoice to carry the description of the service
  (with SAC). Every project milestone invoice shows **"No line items recorded on the parent quote."** in the
  invoice dialog and the PDF — e.g. `INV-FBB9-2026-27-0003`, ₹5,00,000 + CGST ₹45,000 + SGST ₹45,000, with
  no line saying what it is for. The amounts are right; the invoice is not complete.
- **Cause:** the dialog / PDF take lines only from the parent quote —
  `production/src/app/(app)/invoices/page.tsx` ~line 1208 `const lineItems = quote?.line_items ?? []` — and a
  project invoice has no quote. `raise_project_milestone_invoice` also never writes `invoices.line_items`
  (NULL on all three local project invoices).
- **What to change:**
  1. `raise_project_milestone_invoice`: write one line into `invoices.line_items` —
     `{ name: "<project title> — <milestone label>", description: <project description>, sac: <project sac_code, 998314>,
     qty: 1, rate: <taxable>, amount: <taxable> }` (same shape as `QuoteLineItem`).
  2. Invoice dialog (`components/features/quotes/tax-invoice-dialog.tsx`) and PDF (`lib/pdf/InvoicePDF.tsx`): when
     there is no quote, use `invoice.line_items`; show the SAC in the HSN/SAC column.
  3. Backfill existing project invoices from their milestone + project. The freeze trigger
     `tg_invoices_freeze_issued` already allows it — it blocks `line_items` only when the old value is
     **not null** — so filling an empty one is permitted and changes no amount.
- **Done when:** a project milestone invoice shows "Complete Billing System — Doosri kist (advance) · SAC 998314 ·
  ₹5,00,000" in the dialog and the PDF, for new and existing invoices.

### R-011 · Project "Profit & Loss" card: an expandable breakdown, and "to date" that means to date
- **For:** Abhishek
- **Status:** Open
- **Raised:** 2026-09-26
- **Why accounting needs it:** on `/projects/[id]` the card shows five totals — Contract ₹50,00,000 · Costs ₹5,00,000
  · Labour ₹20,74,840 · Expected profit ₹24,25,160 · 49% — and "Booked to date: ₹10,00,000 invoiced −
  ₹25,74,840 costs = −157%". Nothing says which entries make up a number, and two readings are misleading:
  - **Labour counts the whole allocation, future months included.** Four people at 100% for 20 Apr – 26 Dec 2026
    = ₹20,74,840; "Booked to date" subtracts all of it on 26 Sep, although only ~₹14.5L of that period has passed —
    hence −157%.
  - The ₹5,00,000 "cost" was a commission to an employee (now moved to Payroll) — nobody could tell from the card.
- **What to change** — the project detail page (P&L card):
  1. A **"Details"** toggle on the card that expands:
     - **Revenue:** contract (ex-GST) · invoiced · received (bank + TDS) · still to invoice.
     - **External costs** grouped by category, each row → vendor / payee, date, amount (link to the expense).
     - **Labour** one row per person: % · dates · monthly salary · **to date** · **planned (full stint)**.
     - **Commission** (referral commissions on this project's payments) as its own line.
     - **Margin:** to date and expected, side by side.
  2. **"Booked to date"** must use labour **up to today** (overlap of each allocation with start…today), not the full
     stint. The P&L already does this per period — `projectCostForPeriod` in `lib/accounting/project-cost.ts`
     (Pardeep's) can be reused for "start → today" as-is.
  3. When a person is allocated 100% on more than one active project at once, flag it (a salary cannot be 200%
     spent).
- **Done when:** the card expands to show which entries make each number; "Booked to date" on 26 Sep counts
  labour only to 26 Sep.

### R-012 · Renewal quotes: monthly subscriptions renewed for a year, and cost guessed at 83% of price

> Numbered R-012 on 26 Sep 2026: it was first written here as R-009, but Pardeep's branch already uses
> R-009 to R-011 for his own requests (credit notes on the invoice list, project invoice line items,
> the project P&L card).
- **For:** Abhishek
- **From:** Pawan (checkout and renewals, `pawan-api-system`). Pardeep asked for it to be passed on.
- **Status:** Open
- **Raised:** 2026-09-25 (written up here 2026-09-26)
- **Where:** `production/src/lib/renewals/create-renewal-quote.ts`. That one file only; it is in your
  Billing folder, so nobody else edits it. Nothing else in the Billing folders should change unless
  Pardeep agrees.
- **Read first:** `AGENTS.md` at the repo root, especially:
  - §1: money is stored in whole rupees, not paise;
  - §2: never substitute a plausible-looking value, say it is unknown;
  - §9: "done" means the full gate is green;
  - L24 and L36: verify money changes in a rolled-back transaction, and run the WHOLE suite before
    believing a money diagnosis.

**How a renewal quote reaches a subscription.** `createOrGetRenewalQuote()` builds the renewal quote.
Its three callers:
- the renewals cron, `app/api/cron/renewals/route.ts` (around line 280);
- `app/api/renewals/send-now/route.ts:155`;
- `app/api/subscriptions/[id]/generate-renewal-quote/route.ts:93`.

When the quote is paid, the Postgres function `record_payment` rolls the subscription forward using the
quote's `extension_months` in three places:

```sql
-- the line after the subscription row is selected into v_renewal_sub
v_extension_months := v_quote.extension_months;      -- only falls back to sub.term_months when NULL

v_new_mrr := greatest(0, round(coalesce(v_quote.subtotal, v_expected)::numeric
                               / greatest(v_extension_months, 1)))::int;
update public.subscriptions
   set renewal_state = case when v_extension_months >= coalesce(v_renewal_sub.term_months, 12)
                            then 'renewed' else renewal_state end,
       renewal_date  = (v_renewal_sub.renewal_date + (v_extension_months || ' months')::interval)::date,
       mrr           = case when v_new_mrr > 0 then v_new_mrr else mrr end, ...
```

Live body: `select pg_get_functiondef(p.oid) from pg_proc p where p.proname = 'record_payment';`

**Bug 1: every renewal quote says it extends 12 months, monthly subscriptions included.**
Around line 221:

```ts
extension_months: 12,    // standard 1-year renewal; extensions use 24/36 via createExtensionQuote
```

The same file already prices the renewal for the subscription's own term. It calls
`renewalTerm({ termMonths })` and writes `commitment: term.commitment` ("monthly" for a 1-month
subscription). Only `extension_months` still says 12. When a MONTHLY subscription's renewal is paid:
- the renewal date moves 12 months instead of 1: the customer gets a year for one month's money;
- `mrr` becomes one month's subtotal ÷ 12, so MRR drops about twelvefold after the first renewal.

Measured on a local database inside a rolled-back transaction. Standard hosting, monthly, ₹250/month,
`term_months = 1`, renewal date 2026-10-25. Renewal quote as this helper writes it: subtotal 250,
`extension_months` 12, line commitment "monthly", amount ₹295. Then `record_payment`:

| field | before | after one ₹295 renewal | should be |
|---|---|---|---|
| `renewal_date` | 2026-10-25 | 2027-10-25 | 2026-11-25 |
| `mrr` | 250 | 21 | 250 |
| `term_months` | 1 | 1 | 1 |

`record_payment`'s own result also reported `"extension_months": 12`.

**Fix:** set `extension_months` from the term actually priced, e.g. `extension_months: term.termMonths`.
`renewalTerm()` already returns `termMonths` (`lib/renewals/renewal-term.ts`): 1 for monthly, 12 for
annual, anything in 1–60 passes through. The `existingQuoteId` path must not change a quote that already
exists. Leave `create-extension-quote.ts` alone: it deliberately uses 24/36 for multi-year extensions.

**Bug 2: cost is guessed as 83% of the price.** Around lines 185 and 217:

```ts
const perSeatCost  = Math.round((annualAmount * 0.83) / Math.max(1, input.seats));
...
total_cost: Math.round(annualAmount * 0.83),
```

A hardcoded 17% margin standing in for the real vendor cost. AGENTS.md §2 lists this exact pattern as a
known bug. On Google Workspace Business Starter the real cost is ₹110 per seat per month; the guess said
about ₹224, double. So the margin shown on every renewal quote is made up.

**Fix:** take the cost from the catalogue. The helper already reads the catalogue item (by `itemId`,
falling back to plan name) for `msrp`; read its wholesale cost column too (check `items` for the name,
e.g. `wholesale`):
- per seat: wholesale × the months in the term (the same months used for the price);
- `total_cost`: that per-seat cost × seats.

If the catalogue has no cost, do not guess. `quotes.total_cost` is nullable in the database, but the
generated TypeScript type says `number` and the quote screens read it as a number. Either:
- make those readers handle an unknown cost and show "cost unknown", or
- store 0 and show "cost unknown" wherever 0 means not known.

Pick one, and do not let 0 read as a 100% margin.

**Do NOT change:**
- `record_payment` or anything under `supabase/migrations`, unless you find it is wrong. Its use of
  `extension_months` is correct once the quote carries the right value.
- Domain renewals, `lib/domains/renewal.ts` (`createDomainRenewalQuote`): builds its own quotes at
  ResellerClub's live price, and the cron uses it instead of this helper for `vendor = 'domain'`.
  Not affected.
- The hosting renewal worker, `app/api/cron/renew-hosting/route.ts`: it reads the term from the quote
  line's `commitment`, not `extension_months`, so it is correct either way.

**Tests: prove it, don't just assert it.**
1. **Unit tests for the helper** (existing ones sit near `lib/renewals`, e.g. `renewal-term.test.ts`):
   - a monthly subscription's quote gets `extension_months: 1`; an annual one's gets 12;
   - an existing quote is returned unchanged;
   - the cost is the catalogue's wholesale × months × seats;
   - no catalogue cost is not a guess.

   Red-check: put 12 and 0.83 back and confirm the new tests fail.
2. **A SQL regression test** in `production/supabase/tests/`, rollback style (read two existing files
   for the convention). Build your own fixture tenant, customer and monthly subscription; never use
   live ids (AGENTS.md L11). Pay a renewal quote shaped like the fixed helper's output, and assert
   `renewal_date` moved exactly 1 month and `mrr` did not change. Then flip an assertion and see it go
   red (L23).
3. **The full gate** in `production/`: `npm run typecheck && npm run test && npm run lint`. Baseline on
   26 Sep 2026: 7,047 tests passing across 399 files. Run all 63 SQL tests too, not only yours; AGENTS.md
   §9 explains how to run them without mis-reading the report-style ones.

**Before shipping: check real data for damage.** Ask Pardeep before changing any data. Find renewals
already paid with the bug. In production, run:

```sql
select q.id as quote_id, q.tenant_id, q.extension_months, s.id as subscription_id,
       s.term_months, s.renewal_date, s.mrr, q.subtotal
  from quotes q
  join payments p on p.quote_id = q.id and p.status = 'received'
  join subscriptions s on s.tenant_id = q.tenant_id
 where q.is_renewal
   and q.extension_months = 12
   and exists (select 1 from jsonb_array_elements(q.line_items) li where li->>'commitment' = 'monthly')
   and s.term_months = 1
   and s.plan = (q.line_items->0->>'name');
```

Any rows are monthly subscriptions pushed a year ahead with a shrunken MRR. List them for Pardeep with
the correct renewal date and MRR. Don't fix them yourself.

- **Report back:** what changed, with `file:line`; the tests added and the red-check results; the gate
  numbers; and what the production query returned.
- **Done when:** a paid renewal of a monthly subscription moves `renewal_date` by exactly one month and
  leaves `mrr` unchanged (SQL test green), and no renewal quote carries a cost the catalogue didn't give.

### R-013 · Security migration `20260927100000` rewrites 12 of your RPCs — review it, apply on production
- **For:** Abhishek
- **Status:** Sent (on the board, 2026-09-27)
- **Raised:** 2026-09-27
- **Why it matters:** the 27 Sep security audit found three holes that exposed any tenant's data: (1) a signed-in
  account with no `users` row could `POST /rest/v1/users` and make itself owner of any tenant; (2) 17 SECURITY
  DEFINER RPCs guarded with `if v_tenant is not null and …`, so a null tenant skipped the check — yours include
  `refund_payment`, `reopen_quote`, `delete_payment`, `delete_subscription`, `delete_*_invoice`, `record_project_payment`,
  `raise_project_milestone_invoice`, `update_project_*`; (3) 62 definer functions executable by `anon`.
- **What to change:** read `supabase/migrations/20260927100000_definer_rpc_hardening.sql` (commit `631ec3f2`); tell
  Pardeep if any function genuinely needs `anon`; apply on production together with the pending migrations, in file order.
- **Done when:** the migration is on production, `supabase/tests/definer_rpc_hardening.test.sql` is green there, and the
  signup → welcome → join-approval flow has been run once by hand.

### R-014 · Issued GST invoices can be hard-deleted — receipts included, number never comes back
- **For:** Abhishek
- **Status:** Sent (on the board, 2026-09-27)
- **Raised:** 2026-09-27
- **Why it matters:** `delete_project_invoice` and `delete_subscription_invoice` run `DELETE FROM invoices` without
  checking status; `tg_invoices_freeze_issued` is BEFORE UPDATE only. `delete_project_invoice` also deletes
  `project_payments` (real bank receipts). `document_series` never decrements, so the series keeps a permanent gap.
- **What to change:** freeze trigger `BEFORE UPDATE OR DELETE` refusing `status <> 'draft'`; draft-only guard in both
  RPCs (issued → credit note via `issue_credit_note`); never delete `project_payments` — set `invoice_id = null`.
- **Done when:** deleting an issued or paid invoice is refused by the DB (SQL test red-checked), draft delete works,
  and no path deletes a `project_payments` row.

### R-015 · Invoice number uses today's FY and is 21 characters; partial payments never reach Aging
- **For:** Abhishek
- **Status:** Sent (on the board, 2026-09-27)
- **Raised:** 2026-09-27
- **Why it matters:** `next_document_number` takes `indian_fiscal_year(current_date)` with no invoice-date parameter, so
  a 28 March invoice issued in April gets the new FY's series. Rule 46(b) caps the number at 16 characters;
  `INV-3BBD-2026-27-0002` is 21. `record_payment` never writes `invoices.paid_amount`, so Aging and the Balance Sheet
  count the full `net_payable` after a ₹40k part-payment on a ₹1L invoice.
- **What to change:** `next_document_number(p_doc_type, p_tenant_id, p_on date default current_date)`; a ≤16-char
  format for new numbers only; `record_payment` adds to `paid_amount`, sets `paid_date = received_at`, status `partial`.
- **Done when:** a 25 March invoice issued in April gets the 2025-26 series and ≤16 chars; ₹40,000 recorded on a
  ₹1,00,000 invoice leaves `paid_amount = 40000` and Aging shows ₹60,000.

### R-016 · Customer-portal auto-renew toggle fails on the DB — `activity_log` FK
- **For:** Abhishek
- **Status:** Sent (on the board, 2026-09-27)
- **Raised:** 2026-09-27
- **Why it matters:** `supabase/tests/portal_set_auto_renew.test.sql` is red: `set_subscription_auto_renew` violates
  `activity_log_user_id_fkey` because portal users live in `customer_users`, not `public.users`. Every portal RPC that
  logs activity will hit the same wall.
- **What to change:** in the activity trigger, when `auth.uid()` is not in `users`, write `user_id = null` and put the
  customer's name/email in the label (or drop the FK and add `actor_kind`).
- **Done when:** `portal_set_auto_renew.test.sql` is green and a portal toggle shows "Customer <name>" in the activity feed.

### R-017 · Google Cloud billing is on a FREE TRIAL — 5 days left; only you can upgrade it
- **For:** Abhishek
- **Status:** Sent (on the board and by WhatsApp, 2026-09-27) — **URGENT**
- **Raised:** 2026-09-27
- **Why it matters:** Cloud Console for project `resellsubsos-prod` shows "Upgrade your account to avoid a break in
  service — ₹28,320.75 credit and 5 days left in your trial". When the trial ends, Cloud Run (the app), every Cloud
  Scheduler cron and backups stop. The billing account (`My Billing Account`, `016FCA-400F3C-38036D`, org anutech.in)
  has **abhishek@anutech.in as its only Billing Account Administrator**; pardeep@anutech.in is a Billing Account User,
  so the Upgrade button and AI Studio billing both answer "You don't have permission to upgrade this account".
- **What to change:** (1) console.cloud.google.com → banner **Upgrade** → "Upgrade to a full account" — the remaining
  credit still applies, billing only starts once it is used up; (2) Billing → Account management → info panel → give
  pardeep@anutech.in the **Billing Account Administrator** role so this never depends on one person again.
- **Done when:** the trial banner is gone, Billing → Overview shows the account upgraded, and pardeep@anutech.in holds
  Billing Account Administrator.

### R-018 · Export log (board card R-1006) — 4 Billing exports still need one line each
- **For:** Abhishek
- **Status:** Done 2026-10-23 by board card R-1795 (Pardeep owns this area since 19 Oct) — all four call `downloadCSV`
- **Raised:** 2026-10-19
- **Why accounting needs it:** R-1006 records every export (who, what, how many rows) in `export_log`, owner-only.
  Every export through `downloadCSV` (lib/csv) — customers list, quotes, renewals, subscriptions — is already logged
  with no change to your screens. Four of your screens build the CSV by hand, so they are not logged yet.
- **What to change:** right after the `a.click()` of each, add
  `void logExport({ what: "<report>", rowCount: <data rows>, format: "csv" });`
  (`import { logExport } from "@/lib/export-log";`) — or switch the screen to `downloadCSV` from `@/lib/csv`:
  - `production/src/app/(app)/customers/page.tsx` (~line 580, the hand-built customers CSV)
  - `production/src/app/(app)/invoices/page.tsx` (~line 724, selected-invoices CSV)
  - `production/src/app/(app)/payments/page.tsx` (~line 322, payments CSV)
  - `production/src/components/features/subscriptions/reconcile-google-dialog.tsx` (~line 133, reconcile bucket CSV)
  Then delete that file's "R-1006 pending" line from `ALLOW` in `src/lib/export-log/export-log-scan.test.ts`
  (the scan fails on a stale entry, so it tells you).
- **Done when:** the four lines are gone from the scan's allowlist and `npx vitest run src/lib/export-log` passes.

> Live status for R-013 to R-017 is on the board (https://claude.ai/artifact/2E442MT5zCLxm2oE1Lipos), not here —
> this file is the written record; the board is where the status changes.
<!-- Template — copy for each new request:

### R-001 · <short title>
- **For:** Abhishek | Pawan
- **Status:** Open
- **Raised:** YYYY-MM-DD
- **Why accounting needs it:** <what accounting feature is blocked or wrong>
- **What to change:** <file(s) / behaviour, as specific as possible>
- **Done when:** <how we can check it>

-->

## Done

R-001 to R-008 — all closed by Abhishek on 2026-09-26. They are left in place above rather
than moved down here, because each one now carries the reasoning for what was built and, in
three cases, for what was built differently. Cutting them loose from their requests would
strand both halves.
