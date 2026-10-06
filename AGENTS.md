# AGENTS.md — rules for any AI agent working in this repo

> **Three people, three agents (27 Sep 2026).** At the start of EVERY session read
> [`docs/TEAM-PROTOCOL.md`](docs/TEAM-PROTOCOL.md): it says how to read your tasks and other
> people's changes from the shared board, how to stay in your area ([`OWNERS.json`](OWNERS.json)),
> and what to write back before you stop. Five minutes of it saves a day of merge conflicts.

Read this before writing code. It is the short list of things that, if you get them
wrong, cost real money or break a live business.

The long version is `production/CLAUDE.md` (25 sections). This file is the subset that
must not be got wrong, plus the things that are true of this repo *today*. Where the two
disagree, **this file wins** — CLAUDE.md has been wrong before, see §1.

**Canonical (S25, 28 Sep 2026):** the two files stay separate on purpose — every
teammate's session loads both. `AGENTS.md` is canonical for **rules** (what must not go
wrong); `production/CLAUDE.md` is canonical for **conventions and patterns** (how code is
written). Write a new rule here and link to it from CLAUDE.md rather than copying it.
Decisions and their history go in [`docs/adr/`](docs/adr/), which also holds the comment
convention.

Two agents work here: **Claude Code** and **Antigravity**. Both read this file. Keeping
one rulebook is the point of it existing.

---

## 0. What this is

ResellerOS — a multi-tenant SaaS for Indian cloud resellers (Google Workspace, Microsoft
365, Zoho). Owner: **ANUTECH DIGITAL PVT LTD**, tenant `fbb976f1-9090-4f10-9726-0901bd144e42`.

**It is a live business system.** Wrong numbers here become wrong invoices sent to real
customers. Prefer being slow and right.

- App code: `production/`
- Migrations: `production/supabase/migrations/`
- SQL regression tests: `production/supabase/tests/` (not in CI — run by hand)

**Hosting and domains are NOT in this repo.** They live in DMS
(`C:/xampp/htdocs/Domain-Management-Project`, `exceltechnologies-india/domain-management-system`) —
Next.js 15 + MongoDB + Redis, with its own admin panel and its own customer panel. The two
apps are **federated, not merged**: DMS keeps its own database and its own UI, and
ResellerOS reaches it over a read-only HTTP API plus a signed SSO hand-off
(`src/lib/dms-engine/`). Two consequences an agent gets wrong otherwise:

- **ResellerOS has no customer portal, deliberately.** `(public)/portal`, `api/portal` and
  `lib/portal` were deleted on 2026-09-19; DMS owns the customer experience and staff reach
  it from the demo panel on `/login`. Do not rebuild one without being asked. The `portal_*`
  DB functions and their SQL tests were left in place on purpose, so their presence is not
  evidence the feature exists.
- **ResellerOS is the front door, and DMS has no public pages at all** (owner decision,
  24 Sep 2026). DMS's `/`, legal pages and shop pages (`/hosting`, `/domains/*`) were
  deleted; each URL is a 307 to its ResellerOS page, so `NEXT_PUBLIC_RESELLEROS_URL` is
  required on DMS and its deploy refuses to build without it. A customer already inside the
  DMS panel buys from two dialogs there (`?buy=hosting` / `?buy=domain`), which use DMS's
  own cart. Do not rebuild DMS marketing pages without being asked.

**Billing belongs to ResellerOS (owner decision, 24 Sep 2026).** ResellerOS's cart and
billing are primary for a first purchase; DMS keeps its cart only for in-panel purchases.
**DMS is to issue no bills** — every bill and every renewal is ResellerOS's, and DMS holds a
copy for reference. BUILT on 25 Sep 2026 (DMS `2598cc4f`): `createPrimaryInvoice`, its number
allocator and the INV pre-save hook are gone, and a scan test fails if any returns. A payment DMS
still takes is flagged "raise the bill in ResellerOS", never billed silently. DMS's Razorpay Tokens recurring charger is gated off
(`DMS_TOKEN_RECURRING_ENABLED`, default off), because two systems able to debit the same
renewal is a double-collection with no detector. Do not re-enable it or build a second
invoice series in DMS without being asked. **Hosting prices are ResellerOS's too**
(`LANDING_PLANS` in `site/lib/data/hosting-landing.ts`); DMS's `hostingplans` prices are
disregarded and must not be read as a price source. **DMS keeps no copy of them** (owner, 28 Sep
2026: "Read prices live from ResellerOS"): ResellerOS publishes `GET /api/public/hosting-prices`,
computed by the same `hostingRate` its checkout charges with (`lib/checkout/hosting-prices.ts`), and
DMS reads it (`lib/reselleros/hosting-prices.ts`, `hooks/useHostingPrices.ts`) with no fallback figure:
if ResellerOS cannot be read, DMS prices nothing and says so. Do not put a price back in DMS's
`config/hosting-plans.ts`; a DMS test fails if one appears. Full record: `Todos.md` §0A.

**The site cart charges only what the server can price** (24 Sep 2026). Every site
`cart.add` must carry a `sku`, and a domain line must also carry the exact `domain` —
`src/site/cart-lines-priceable.test.ts` fails otherwise. Domains are charged the LIVE price,
re-checked at payment through `lib/domains/live-lookup.ts` (the same code the search uses),
and refused when it cannot be read — never a fallback figure. Workspace, Anutech Mail and SSL
are quote items, not cart items. After payment, provisioning is one request per product
(`lib/provisioning/products.ts`), so a domain and hosting bought together are both queued.

**Automatic domain registration exists and is OFF** (24 Sep 2026, decisions 21-24). It is
registered under the customer's own details (checkout collects the address), into a DMS
account for them, through the engine's `domain.register`, within a spend limit the ENGINE
enforces (live payment, paid ≥ cost, daily count + ₹ cap). Two independent fail-closed
switches: `DOMAIN_REGISTRATION_LIVE=1` here, `ENGINE_DOMAIN_REGISTER_LIVE=1` on DMS. Do not set
either without the owner — the eight steps before switching on are in `Todos.md` §0A.

**Paid hosting is provisioned by the DMS engine too, and it is OFF** (decision 25). This app no
longer creates DirectAdmin accounts for a sale: `/api/cron/provision-hosting` sends
`hosting.provision`, behind `HOSTING_PROVISIONING_LIVE=1` here and `ENGINE_HOSTING_PROVISION_LIVE=1`
on DMS. The hosting TRIAL goes through the engine as well (`hosting.provision` with `trial: true`,
25 Sep 2026), so DMS is the only DirectAdmin writer. The one exception is the admin test-account
tool (`api/catalog/directadmin-test-account`), kept on purpose.

**On a laptop, a TEST-mode payment can set up hosting** (Pawan, 3 Oct 2026: "even in test mode allow
me to create hosting — otherwise how will I test"; ResellerOS `4f54929a`, DMS `82e25019`). Three
local-only switches, all ignored on the live site:
- `ALLOW_TEST_PAYMENT_PROVISIONING=1` here: `testPaymentProvisioningAllowed()` in
  `lib/provisioning/provisioning.ts`, false in any production build. HOSTING only — a domain is never
  registered on a test payment (real ResellerClub money). The dial and the engine switch still apply.
- `ENGINE_ALLOW_TEST_PAYMENT_PROVISION=1` on DMS: only when its `RESELLEROS_SERVER_URL` is this machine
  (localhost / 127.0.0.1 / host.docker.internal). The DMS image is a production build and the live
  site still takes test-key payments, so neither NODE_ENV nor the key prefix could be the guard.
- `NO_OWNER_PAYMENT_ALERT_LOCAL=1` here (5 Oct 2026, Pawan: owner alerts "only on my machine" off):
  `ownerPaymentAlertAllowed()` in `lib/email/storefront-voice.ts` skips the "payment received" email to
  the owner for local test payments; ignored on any deployed server, so live sales always reach the owner.
- `node scripts/local-cron.mjs` runs `/api/cron/provision-hosting` every minute (localhost only), as
  Cloud Scheduler does on the live site every 15 min, 9–21 IST.
The worker now tells DMS the real `paymentMode` instead of always "live". Measured end to end on
3 Oct: Razorpay test netbanking → invoice → job → DMS Hosting active → account on server1.

**Domain renewals exist and are OFF** (decision 28, 25 Sep 2026). A paid domain gets a yearly
vendor-`domain` subscription. Its renewal quote is priced at ResellerClub's LIVE renewal price, full
price (`lib/domains/renewal.ts`). A paid renewal is queued as `plan = "domain-renewal"`, never a
registration, and `/api/cron/renew-domains` sends DMS's `domain.renew` with the current expiry.
Switches: `DOMAIN_RENEWAL_LIVE=1` here, `ENGINE_DOMAIN_RENEW_LIVE=1` on DMS.

**A paid renewal is never set up again as a new sale** (25 Sep 2026). The Razorpay webhook finds
the subscription a quote renews before `record_payment`:
- **domain:** renewal row;
- **hosting:** `hosting-renewal` row. `/api/cron/renew-hosting` sends DMS `hosting.renew` so DMS's
  own expiry moves and it does not suspend a paid account. Switches: `HOSTING_RENEWAL_LIVE=1` here,
  `ENGINE_HOSTING_RENEW_LIVE=1` on DMS.
- **anything else:** nothing queued.

Known and handed to the colleague (blocked folder): `lib/renewals/create-renewal-quote.ts` writes
`extension_months: 12` even for monthly subscriptions (`Todos.md`).

**The free hosting trial is Starter only, on monthly and yearly** (decisions 26-27, 24 Sep 2026).
"Start free trial" on /hosting puts a ₹0 `hosting-trial:starter` line in the cart. Checkout
starts it with no payment step (`lib/hosting/start-trial.ts`), and a trial checks out on its own.
There is no trial form any more: `/hosting/trial` is only where the confirm-your-email link lands.
**One trial per customer across BOTH apps**, matched on email, phone (last 10 digits) or domain.
This app checks its own `buy-hosting-trial` leads, then asks DMS, which holds the shared record
(`lib/dms-engine/trials.ts`). If DMS does not answer, the trial is refused. A trial line is
always quantity 1. On a laptop, `ALLOW_REPEAT_TRIALS_LOCAL=1` switches the one-trial check off for
testing (`repeatTrialsAllowed()`, ignored in a production build; 3 Oct 2026). **A trial needs a real domain, the same as paid hosting** (owner, 30 Sep 2026;
`lib/checkout/hosting-domain.ts`, with a "buy a domain" link when the customer has none).
**A trial sends the owner no email** (owner, 30 Sep 2026: "Remove this feature completely. That
will just annoy the owner."): staff see it as a lead, and a setup that fails becomes a `tasks` row.
`lib/hosting/no-trial-owner-email.test.ts` fails if an owner email comes back, including the "new
enquiry" alert for a request from the site's trial form (`trial: true`). The nightly
`cron/trial-expiry` still emails the owner; it is Pardeep's, raised as R-065.
**The customer's "trial is live" email comes from DMS** (3 Oct 2026): DMS sends "hosting is live"
(Customer Portal link, nameservers, server IP) whenever `hosting.provision` creates an account, trial
or paid, so the confirm route sends no email of its own. Once DMS has created it, `/hosting/trial`
shows **"Log in to the Customer Portal"** (`site/lib/trial-statuses.ts`); while a person still has
to create it, no login button and "within 1 working day".
The one rule is `lib/hosting/trial-plan.ts`. DMS enforces the same rule on its in-panel trial,
which on monthly renews one month at a time (`Hosting.billingCycle`).
It was **run once against the live DirectAdmin on 24 Sep 2026** (test, create, replay,
no-duplicate all passed). The test account `rsospf34b2` / `rsosprovtest2409.in` was deleted from
server1 on 25 Sep 2026, which leaves server1 with no users.
**server1.anutech.in is the DirectAdmin server, on 35.207.233.155** (owner, 25 Sep 2026: "Update the
address"). That is the only IP in server1's own list. DMS's `DA_FALLBACK_IP` and its `.env.local` now
say so; they said 34.93.167.160 before.

**The live / production DMS is a SEPARATE project, not ours** (owner, 25 Sep 2026: "Ignore the Live
DMS or Production DMS. That is a separate project from ours"). "DMS" in this repo's work means the
local DMS repo and its local container. Do not plan, deploy, reconfigure or report on the production
DMS service (Cloud Run), its env vars or its data. Do not list it as an open item.

**ResellerOS creates every Razorpay order, including one made inside the DMS panel** (decision
30, 25 Sep 2026; it replaces decision 16). DMS calls `POST /api/dms/panel-order` with
`DMS_PANEL_API_KEY`, and it is priced by the same function as the site cart
(`lib/checkout/cart-checkout.ts`). If ResellerOS cannot be reached, DMS refuses the purchase. The
bill is the paid-order PDF at once, and the GST invoice when staff issue it (decision 29). DMS reads
bills through the existing `/api/v1` API. The DMS half is built (DMS `15f52e9f`..`abf8cb57`); what it
still leaves open is in `Todos.md`.

**DMS takes no new payment on its own Razorpay keys** (25 Sep 2026, DMS `0b41b2ff`..`84b5ae33`). Its
`/cart` pays through `/api/dms/panel-order`. A plan upgrade is a request, `POST /api/dms/upgrade-request`,
which becomes a lead here; staff quote it and change the plan once it is paid. Guest checkout, autopay,
`api/payments/create-order` and `verify` are deleted. A DMS scan test fails if anything outside a named
allow-list can create a Razorpay order again: refunds, webhooks for old orders, and the gated Tokens
charger remain.

**A trial started inside the DMS panel starts HERE** (owner, 26 Sep 2026: "Move it to ResellerOS").
DMS calls `POST /api/dms/start-trial`, which runs the same `startHostingTrial` as the site cart, so
there is one trial path for both apps and ResellerOS can remind, quote the conversion and bill it.
The panel's "can I have a trial?" pre-check asks `POST /api/dms/trial-eligibility`, which runs the
same `checkTrialEligibility` that `startHostingTrial` decides with; an unreadable history is never
"eligible".

**A first purchase happens in ResellerOS; a renewal happens inside the DMS panel** (owner, 28 Sep
2026: "Do these in ResellerOS if user buys for first time. But if existing user renew either hosting
or domain, then that part should happen inside the DMS customer portal itself"). The renewal quote and
the bill stay ResellerOS's; DMS's Renew dialog asks `POST /api/dms/renewal-order` (panel key, the
customer's email matched exactly, renewal quotes only) for the Razorpay order and pays it in the
panel. `/api/v1` quotes carry `renews` (vendor + domain), so a service's Renew offers only the bill
that renews THAT service. Multi-year domains and several hosting plans in one order are for the
ResellerOS cart. **Multi-year domains are not built yet** (R-030, R-031). **Several hosting plans
in one order work since R-032 (1 Oct 2026)** (until then checkout refused a second plan). Now each plan is its own cart line with its own domain box (two plans
cannot share a domain, `planDomains` in `lib/checkout/hosting-domain.ts`); each hosting line
carries that domain as `domain` (so `record_payment` gives each plan's subscription its own domain)
and `hostingDomain`; `domainsInLines` and `domainSubscriptionsToCreate` skip hosting lines, so a
hosting domain is never queued for registration; the webhook queues one hosting request per line
with its own plan, and `cron/provision-hosting` finds a request's line by domain. Only a single
hosting line with quantity above 1 is still refused (`SEVERAL_HOSTING_PLANS_READY`,
`lib/checkout/hosting-limit.ts`).

**Email goes to every recipient, from both apps** (owner, 30 Sep 2026: "Fix this permanently. It
should remain on by default for both DMS and Reseller OS app"). SMTP (`lib/email/smtp-transport.ts`,
the `SMTP_*` variables) is the platform sender ahead of Resend, and a tenant's own working Gmail
still wins. There is no recipient allow-list in either app, and a scan test fails in each if one
comes back (`lib/email/send-smtp.test.ts` here, `tests/unit/lib/email/no-recipient-filter.test.ts` in DMS). SMTP connects over
IPv4 with the real host name kept for TLS: the IPv6 attempt hung the first send for 21 s.

**DMS is purely a backend service for ResellerOS; the customer sees ResellerOS everywhere** (Pawan,
3 Oct 2026: "Wherever user buys from… they should always see the ResellerOS branding — in the emails,
the panels and any other frontend… Remember that point"). "ResellerOS branding" means the storefront a
buyer sees at reselleros.anutech.in: **Anutech Digital**, the round blue "A" mark, Archivo + IBM Plex
Mono, Anutech blue `#1668E3` (`site/site.css`). Built in DMS (`a40887b8`, `03d509c3`, `1f5739d3`,
`36cdcd88`):
- **Emails:** every DMS customer email uses ResellerOS's plain pattern (`lib/email/plain.ts` there):
  "Hi <first name>", plain sentences, the one link, the support line, "— Anutech Digital"; no banners,
  emoji or "Private Limited Team". New: "hosting is live" on every engine-created account, and "hosting
  removed" when admin → Hosting → Terminate really deleted the server account.
- **Customer Portal:** DMS's shared tokens carry the storefront colours and fonts, the logo is the
  storefront mark, the tab reads "Customer Portal | Anutech Digital". The admin "frontend colour
  theme" (violet) switch is removed — it defaulted to violet.
- **Razorpay windows:** storefront blue on the shop checkout and in DMS. The Workspace buy page and
  the quote-accept page stay orange: their whole pages are in that palette, and the quote page also
  serves other reseller tenants.
- **Asking for the profile:** DMS's "complete your profile" banner and the cart's profile gate apply
  only to domains (a hosting-only customer is never nagged; buying a domain asks for the address),
  and the banner reads the saved account, so a saved mobile is never called missing (DMS `96a27f82`,
  `26eecfde`).
- **ResellerOS's own storefront emails sign the same way (5 Oct 2026):** for the storefront tenant
  (`BUY_PAGE_TENANT_ID`) the paid-order, payment-failed, trial, trial-ended and enquiry emails sign
  "— Anutech Digital" and a reply goes to support@anutech.in (`SUPPORT_EMAIL`), via
  `storefrontVoice()` in `lib/email/storefront-voice.ts`. Every other tenant is a reseller and keeps
  its own sign-off and reply-to — never sign a reseller's customer email as Anutech.
- **Admin → Appearance in DMS** holds footer template, GSTIN and social links only; the Support widget
  and "Phone number (Call Us)" switches changed nothing and were removed (owner, 5 Oct 2026).
Any new customer-facing email or screen in DMS follows this; never a separate DMS identity.
The DMS repo's working branch for Pawan is `website-pawan` too (renamed from `pawan-api-system` on
3 Oct 2026; the old branch is deleted).

**The invoice PDF names each line's website and shows a settled invoice as paid** (3 Oct 2026,
`add72978`; display only, no stored data changes). `lib/pdf/invoice-display.ts`, used by
`InvoicePDF` and `QuotePDF`:
- `lineDomainNote`: a line carrying a `domain` prints "For <domain>" under its name (skipped
  when the name/detail already shows it, or on a bulk line).
- `invoicePaidInFull`: nothing left to pay AND (status `paid`, or the adjusted advances cover the
  total) → the date box reads "Paid on <date>" and the footer "Paid in full on <date>." Anything
  still owed keeps its due date (R-038).
The on-screen tax-invoice preview (`components/features/quotes/tax-invoice-dialog.tsx`) is in the
Billing & Subscriptions section (§13) and still shows the old "Due Date" and no domain line; the
hand-off note for its owner is in `Todos.md`.

**Every buying path passed end to end on localhost (5–6 Oct 2026, Razorpay TEST, real server1):** shop hosting
trial (confirm → account → Customer Portal login), shop paid hosting, shop domain, DMS cart with two plans, the
portal's Buy hosting dialog and Register domain dialog — each with its invoice, subscription and (hosting) the
server1 account, then terminated and purged. A test payment never registers a domain (it is queued and held).
Re-run them with the scripts' flow, not by hand: buy → deliver the real webhook (Razorpay cannot reach localhost)
→ the local cron (`scripts/local-cron.mjs`) sets up hosting within a minute → check server1 → terminate in DMS
admin → purge the rows.
**Engine retries reuse one commandId per request per day** (`provisionCommandId` → `rsos-hostprov-<row>-<date>`), so
DMS replays a stored outcome — except a failure that never reached a provider, which it now runs again (DMS
`1c6180bf`). Before that, one DirectAdmin timeout turned a paid order into "failed, set it up by hand".

Open items for the integration are tracked in `Todos.md`, not here.

---

## 1. ⚠️ MONEY IS STORED IN WHOLE RUPEES, NOT PAISE

This is the one that will bite you hardest, because the docs used to say the opposite.

```
items."Google Workspace Business Starter"  →  msrp = 270,  wholesale = 110
```

That is **₹270** and **₹110** per seat per month — the real Google list and partner
prices. As paise they would be ₹2.70 and ₹1.10, which is not a price for anything.

- `rupee(490644)` → `"₹4,90,644"`. It takes **rupees**.
- `rupeeFromPaise()` is for genuinely-paise numbers. Almost nothing in this schema is paise.
- **Paise DO appear inside calculations**, deliberately — `lib/subscriptions/proration.ts`
  and `margin.ts` convert to integer paise so a division rounds once instead of drifting,
  then convert back. That is a local unit for arithmetic, not the storage unit.
- Rule of thumb: **if it came out of the database or is going into it, it is rupees.**

`CLAUDE.md:296` said "All money in paise" until 14 Aug 2026, and `utils.ts` said it too.
Both are corrected. If you find any other place claiming paise storage, it is wrong —
fix it, don't work around it.

---

## 2. The pattern behind four separate bugs in this codebase

**A failure converted into a plausible value is worse than the failure.**

Real examples from this repo:

| Code | What it did |
|---|---|
| `.catch(() => ({ users: [] }))` | Rendered the founder's signups page **empty for months**. It looked like "no signups". |
| `?? "resend"` on an email provider | Logged every email as sent via Resend, including ones that were not |
| `useCurrentUser` returning `null` on error | Every user looked logged-out-but-logged-in |
| `annualPerSeat × 0.83` as a cost | A hardcoded 17% margin standing in for the real vendor price. On Business Starter the real cost is ₹110; the guess said ₹224 — **double** |

So: **let it fail loudly, or say the value is unknown.** Never substitute a number that
looks reasonable. `null` + "unknown" beats a confident wrong figure every time. If a
component cannot be computed, the UI must say so — see §7.

---

## 3. Types

- **No `any`. No `@ts-ignore`.** TypeScript is in strict mode. If a type fights you, fix
  the type — an `as any` here was reverted on 14 Aug because it turned a compile-time
  error into a runtime one.
- Import the real union rather than widening to `string` (e.g. `LeadActivityKind`).

---

## 4. Multi-tenancy — every table, every query

- Every table (except `tenants`, `users`) has `tenant_id uuid NOT NULL`.
- **RLS is on for every table.** Policies use `public.current_tenant_id()` — 335 policies
  depend on that one function.
- **Never hardcode a `tenant_id`.** Always derive it from auth.
- **Foreign keys must stay inside tenant boundaries.** `items.id` is a bare primary key, so
  a plain FK to it can point at another tenant's row. Use a composite FK on
  `(tenant_id, id)` — see migration `0248`.
- **Never assume a tenant's name tells you whose it is.** New tenants are auto-named from
  the signer-in's email domain, so a wrongly-created tenant is named *exactly* like the
  company it should have joined. When diagnosing "the app looks empty", check `tenant_id`,
  never the tenant name.

---

## 4a. Getting a database to work against

**Never develop against production.** It holds real customers, real invoices, real money.

There is a staging project — `resellerosv3-staging` (`ixgvlbgmvgaihvudtbwt`, Mumbai). Its
schema is an exact copy of production: 87 tables, 133 functions, 286 policies, 48
triggers, 305 indexes, 1335 columns, 234 foreign keys — verified object-by-object, not
assumed.

To rebuild it, or to build any fresh project:

```bash
cd production
node scripts/rebuild-db.mjs <project-ref>      # refuses to run against production
node scripts/db-compare.mjs ontpnqjoysjgrlsukecm <project-ref>   # must be a clean match
```

**Do not build a database by running the 218 files in supabase/migrations/.** They do not
work from empty — see the header of `scripts/rebuild-db.mjs` for exactly why and which
tables break. That is a known, documented defect, not something to rediscover.

A fresh database comes from `supabase/baseline.sql` + `supabase/baseline-storage.sql`.
Both are committed. The storage file is separate because `supabase db dump --schema
public` silently omits the storage schema, and without it file upload and download fail
while every other check passes.

**The database is SHARED between everyone using staging.** A worktree separates files,
not data. Only one person runs a migration or a data reset at a time, and says so first.

---

## 5. Database changes

- **Never apply a DB change without a versioned migration file** in
  `production/supabase/migrations/`. Schema drift between git and prod has broken this
  project before.
- **Run DDL in small batches**, not a whole file at once. The SQL editor runs a pasted
  script as ONE transaction, so one late failure silently rolls back the parts that
  worked, and the screen shows an error nobody connects to "nothing applied".
- **Never put a verification `SELECT` in the same run as the DDL.** It executes inside the
  same uncommitted transaction, sees the new columns, and reports success for a change
  that is about to disappear. Verify in a **separate** run.
- Tooling: `production/scripts/apply-migration.mjs` applies a file batch-by-batch. It needs
  `begin; … commit;` blocks. A `rollback;` block also works — that is how the SQL tests run.
- **Checking grants: use `pg_proc.proacl` / `pg_class.relacl`.** `information_schema`
  filters by the current role and will confidently tell you a grant is missing when it is
  not. This cost real time on 14 Aug.
- **Document numbers come from the `next_document_number(doc_type)` RPC.** Never generate
  one in JS — no `Math.random()`, no `Date.now()`, no `count(*) + 1`. GST law requires an
  unbroken series.

---

## 6. Dates — the IST trap

`new Date().toISOString().slice(0, 10)` returns **yesterday's date** for any moment before
05:30 IST, because IST is UTC+5:30. The users are in India and reps work early.

This was a live bug: "arrived today" showed nothing and "overdue" silently swallowed
leads due today. Use `localDateISO()` from `lib/leads/outcomes.ts`, which formats from
local date parts.

**Since S21 (28 Sep 2026): use `@/lib/dates/ist`** — `istToday()`, `toIstDate(d)`, `fyBounds()`,
`monthBounds()`, `addDaysISO()`, `formatIstDate()`. `localDateISO()` is only right in a browser
set to IST; on Cloud Run (UTC) it is the same bug. In Pardeep's areas ESLint now fails a raw
`toISOString().slice(0, 10)`.

---

## 7. Errors and blocks must say what to do next (CLAUDE.md §24)

Whenever the app blocks a user, it gives three things:

1. **What happened** — plain language
2. **Why** — the actual reason
3. **What to do next** — with a button or link to that place when one exists

Never a bare "not allowed". This applies to Postgres `raise exception` messages too. If a
guard blocks an action, make sure there is always a reachable way to complete or undo it.

---

## 8. Caching — both Supabase clients pin `cache: "no-store"`

Any new Supabase client must do the same.

- **Server:** Next.js caches GET `fetch()` including Supabase's. Without no-store, `/api/v1`
  served **stale billing status and let revoked API keys authenticate.**
- **Browser:** Supabase REST sends no `Cache-Control` and no `Vary: Origin`, and echoes the
  request Origin into `Access-Control-Allow-Origin`. A response cached on
  `http://localhost:3000` gets replayed to the deployed origin still carrying the localhost
  header, so **every** client query fails CORS and the page dies. The build is fine; the
  cache is poisoned. Only a machine that visits both origins can hit it, which is why it
  never shows up in monitoring and always looks like "the deploy is broken".

---

## 9. "Done" means the test is green

```bash
cd production
npm run typecheck && npm run test && npm run lint
```

Lint **warnings** are acceptable; lint **errors** are not. Current baseline: **9,117 tests
passing across 568 files** (plus 2 files / 10 tests skipped), typecheck clean, **lint exit 0
with 0 errors** — measured 3 Oct 2026 on `website-pawan` at `add72978`.
Earlier markers: 9,106/567 at `133fd00e` the same day; 9,100/566 at `3b0301ad` the same day; 8,410/517 on 30 Sep after merging `manager-pardeep` (C-053); 8,242/504 the same day before that merge; 8,193/499 after `9ad95378` (trials send the
owner no email); 8,111/486 on 29 Sep after merging `abhishek-pre-merge` (`3bebf671`: R-012 renewal quote,
R-018 dunning pay link); 8,049/480 the same day after the fourth
`pardeep-sir` merge (`ddde2754`); 7,972/477 the same day after the Tailwind dev-server fix; 7,933/472 on 28 Sep
after the third `pardeep-sir` merge (`9054977f`, which brought Next 15.5 / React 19: run
`npm ci` after pulling it);
7,085/404 the same day after the quote-notes fix, 7,083/403 on 26 Sep after the second `pardeep-sir` merge, 7,054/400 the same day after `/api/dms/trial-eligibility`, 7,047/399 the same day after `/api/dms/start-trial`, 7,041/398 the same day after merging `pardeep-sir` (Pardeep's banking, P&L and project-quotation work), 6,884/378 the same day after the `/api/v1` literal email match, 6,880/377 on 25 Sep after the upgrade-request route and the `pardeep-sir` merge, 6,820/374 the same day after the DMS panel-order API, 6,812/373 the same day after the trial moved onto the DMS engine, 6,799/372 the same day after hosting renewals, 6,776/370 the same day after domain renewals, 6,743/367 the same day after the cart-hosting subscription fix, 6,737/367 on 24 Sep after the cross-app trial check, 6,733/367 the same day after one-trial-per-customer, 6,725/366 the same day after the trial moved into the cart, 6,718/366 the same day after the Starter-only trial, 6,713/365 the same day after hosting provisioning moved to the DMS engine, 6,668/362 the same day after enabling the site cart, 6,629/357 on 23 Sep after merging `abhishek-pre-merge`, 6,610/356 the same day, 6,609/356 on 21 Sep, then 4,371/233, 3,404/182 and 1,492,
which is §12 happening to this very file four times. If your change drops the test count, it
is not done.

**`npm run build` passes — measured 23 Sep 2026, for the first time.** This line said it had
NOT been run for as long as it existed, which mattered: CI does not run on feature branches,
so on `pawan-api-system` the local gate is the only gate, and a build was never in it. Both
repos build clean. Lint on this repo: exit 0, **0 errors / 29 warnings**.

**Stop the dev server before building.** `next build` rewrites `.next`, which the running dev
server is serving from, so the open page then 404s its own chunks and looks broken until it is
restarted — and because DMS's front door redirects here, a stopped ResellerOS makes DMS look
dead too. Stop it, build, start it again.

DMS has its own, separate gate — `npx vitest run` in
`C:/xampp/htdocs/Domain-Management-Project`, **6,452 passing across 444 files, zero failures**
on 30 Sep 2026, after the recipient allow-list was removed and SMTP moved to IPv4 (DMS `e55b5132`,
`79a415f4`). 6,444 / 442 on 28 Sep, after four never-rendered components were deleted (DMS `c75dba79`); 6,470 / 446 just
before, after hosting prices moved to a live read from ResellerOS (DMS `46092c10`), and 6,450 / 444 the
same day after in-panel renewal payment. The count FELL on purpose: 26 tests went with the deleted
components. Earlier: 6,422 / 442 on 26 Sep 2026, after round 5 (DMS `c1e52acd`: the trial pre-check asks ResellerOS, admin package
edits create no Razorpay plans). Same day, 6,422 / 441 after round 4 (DMS `9bc63716`: dead payment code deleted, old renewal dunning
switched off, reminders point to the ResellerOS quote, the panel trial starts in ResellerOS). The
count FELL, on purpose: tests were deleted along with the code they covered. Earlier:
6,497 / 444 on 25 Sep after DMS stopped taking payments on its own keys (DMS `84b5ae33`),
6,783 / 453 the same day after billing moved to ResellerOS (DMS `abf8cb57`), about 180 deleted with the invoice and renewal code,
6,886 / 453 the same day after trial mode for hosting.provision (DMS `05a2dce2`),
6,860 / 451 the same day after hosting.renew (DMS `e80c7851`),
6,810 / 450 the same day after domain.renew got its gate and spend limit (DMS `e6c1406c`),
6,787 / 450 on 24 Sep after the cross-app trial record (DMS `2315ae26`),
6,768 / 448 after the monthly Starter trial (DMS `47f0a81a`),
6,758 / 448 after the Starter-only trial guard (DMS `19c1134a`),
6,753 / 447 after the live DirectAdmin fixes (DMS `23680de9`),
6,702 / 445 after hosting moved to ResellerOS's price + GST (DMS `06a9546`), 6,676 / 444 after DMS's public pages were removed (`0fe6c95`), and 6,617 / 442, after Zoho Books was removed (owner decision; ~250 Zoho tests deleted with the
code) and the tokens recurring flow was gated off (DMS `8bf941e`). An earlier reading the same
day, 6,594 passing with 23 failing in `recurring-charge-service.test.ts`, caught that gate
mid-change, before those tests were opted in; it was not a real regression. Integration suite
(`npm run test:int`, in-memory Mongo, no external services): **194 passed / 1 skipped across 15
files, zero failures**, measured 26 Sep 2026 after DMS `e4792ce1`. The skipped file makes a real
Razorpay charge and is opt-in. (This line said 238 before; `npm run test:integration` is a
different, older runner that needs a dev server on :3000 and live ResellerClub, and is not the
suite.) Before that: **6,845 tests across 452 files**,
typecheck clean (measured 23 Sep 2026 after the public-page link fixes; 6,773/448 earlier the
same day after Phase 8 and the transfer clean-up, then 6,748/447 and 6,724/447, and 6,451/432
on 21 Sep).

That run also reports **16 "Errors"** alongside the passing count. They are unhandled
rejections inside `tests/unit/lib/directadmin/retry-transport.test.ts`, which itself passes;
they are not failures and not new. Said here because a reader who meets them for the first
time will otherwise treat a green suite as red.
DMS lint and build — also measured 23 Sep 2026 for the first time: `npx next lint` exits 0
with **0 errors / 418 warnings**, and `npx next build` exits 0. A change that spans both repos
has to be green in both, and neither suite knows about the other.

**DMS also has 8 MongoDB migrations** (`scripts/db/migrations/`, tracked in the `_migrations`
collection, run with `npm run migrate`). All 8 are applied to production as of 23 Sep 2026.
The runner could not run at all on Windows until that date — see L110.

**A targeted run is not the gate.** One function there had coverage in two test files;
the targeted run was green while the full suite caught the second one. Run the whole suite
before calling anything done.

- CI runs on **pull requests** and on pushes to `main`. It does **not** run on feature
  branches — on a long-lived branch the local gate is the only gate. This is exactly how
  4 unit tests sat broken for months.
- The **95** SQL tests in `production/supabase/tests/` are **not** in CI. A DB/RPC change
  means running them by hand, or it is not verified. (This line said 65 on 26 Sep, 63 earlier that day, 54 on 23 Sep,
  28 before that, and L7 said 38.) **Measured 28 Sep 2026 against the LOCAL Supabase, after
  applying the 42 migrations `20260926130000`..`20260928200000` from the third `pardeep-sir`
  merge: 92 pass / 2 fail / 1 not-applicable** (`sandbox_tenant_isolation`, below). The two red:
  `anon_default_privileges` (FAIL 3: `can_see_record` is still anon-executable, and since
  `20260928100000_rls_initplan_wrap` inlined its body no policy uses it, so it is no longer
  exempt) and `portal_set_auto_renew` (a portal login is not a `public.users` row, so the
  subscriptions audit trigger's `activity_log.user_id` FK refuses it; it fails the same with the
  pre-merge `log_row_change`, so the merge did not cause it, and the portal has had no caller
  since 19 Sep). Both are left red on purpose (L8). The 26 Sep count was 64 pass /
  1 not-applicable of 65. Four files still MENTION
  `TESTRESULT` in comments describing their old style; they are rollback tests now, so a
  runner that keys on the word misreads them.

  Measured that day against the LOCAL Supabase: **53 pass / 1 not-applicable**. The one is
  `sandbox_tenant_isolation`, which measures the REAL sandbox tenant against the REAL live
  tenant — that IS the question it exists to answer — and now says
  `NOT APPLICABLE HERE` rather than dying on a foreign key, which read as a broken schema. Two things about
  running them that cost time otherwise. **Prove the detector first** (L23): the folder holds
  two conventions, and the report-style files that end `raise exception 'TESTRESULT >> …'`
  exit **non-zero when they PASS**, so a naive runner reports them as failures. And use
  `psql -v ON_ERROR_STOP=1`, or psql exits 0 with errors on screen. The two still red are
  `offsite_export_service_role_only` (asserts a backup snapshot exists; `backup.snapshots` is
  empty locally) and `sandbox_tenant_isolation` — both environment, neither a defect. Both
  have since been fixed; the second is production-only by design and now says so.

  **A zero-based assertion needs a precondition that something could have leaked.** Every
  case-1 assertion in `sandbox_tenant_isolation` is "the tester sees ZERO rows of another
  tenant", and zero is also what an EMPTY other tenant returns. The file guarded the session
  being dead and not this — so on 22 Aug 2026, when the live tenant's transactional tables
  were all cleared (L11), its headline would have passed with nothing to find. It now counts
  what could leak first, as the connection role, before switching to `authenticated`:
  afterwards RLS hides the very rows being counted.

**Say which kind of verified**, and never blur them:

- **test-verified** — a test asserts it
- **browser-verified** — actually observed in the running app
- **reasoned-only** — inferred from reading code

"Reasoned-only" is a fine answer. Calling it "verified" is not.

---

## 10. Two agents, one repo — how not to clobber each other

On 14 Aug both agents worked in the same folder on the same branch. One commit stripped
140 lines from files the other was mid-edit on, because to the second agent that
half-finished work looked like broken code. The fix was two git worktrees under `C:/dev/`,
one per agent.

**Neither of those folders exists any more**
(checked 2026-09-21), so the table that used to sit here described a layout nobody was
working in. What is true today:

| | |
|---|---|
| Folder | `C:/xampp/htdocs/anutechbilling-new` |
| Branch | `website-pawan` (renamed from `pawan-api-system` on 30 Sep 2026, C-053; the other branches are `manager-pardeep`, `billing-abhishek`, `accounts-hitesh`) |
| Dev server | port 4320 (`npm run dev -- -p 4320`) — DMS holds 4310 |
| Commit author | `Excel Technologies <pawan@exceltechnologies.in>` |

If a second agent starts working here again, give it its own worktree and its own port
before it writes anything, and re-read the rules below — they are what the 14 Aug incident
cost, and they do not depend on which folders are in use:

Rules:

1. **Work only in your own folder.** They are git worktrees — separate files, shared history.
2. **`npm run typecheck` reports the whole repo.** If you see errors in files you did not
   touch, they belong to the other agent. **Do not "fix" them.** Leave them.
3. **The database is SHARED.** A worktree separates files, not data. A migration applied
   from one folder hits the other immediately. **Only one agent runs a migration or a data
   reset at a time**, and says so first.
4. Push your branch when work is done, and **stop there**. Do **not** open a pull request
   unless you are explicitly asked to in that message — opening one is the owner's call
   about when work is proposed for `main`, not a tidy-up step. When you are asked, the flow
   is: PR into `main`, let CI go green, merge.
   Worth saying once rather than offering a PR: CI does not run on feature branches, so on a
   long-lived branch the local gate in §9 is the only gate.

---

## 11. Before you build — check whether it already exists

This repo is large and has grown fast. On 14 Aug a brief asked for six features; four
already existed and two of them were fully wired. Three other components (837 lines) were
found unmounted — and git showed they had been removed **deliberately** for a redesign, so
re-mounting them would have undone someone's decision.

So: **search first, read the git history of anything that looks abandoned, and only then
build.** `git log -S"ComponentName" -- path/to/file` tells you whether something was
removed on purpose.

---

## 12. Docs go stale — code is truth

`docs/PROJECT-KNOWLEDGE.md` claimed 27 migrations when there were 196. Never quote a count,
a module list, or a bug status from a doc — verify it, then cite `file:line`.

**And when you find a doc wrong: fix it in the same session.** Working around a stale doc
leaves the trap armed for the next reader. That rule is why §1 of this file exists.

---

## 13. Hands off: the "Billing & Subscriptions" section belongs to a colleague

**Owner instruction, 24 Sep 2026:** *"This part of ResellerOS cannot be edited or touched by
our any edits … that part is being worked on by my colleague and can cause massive
conflict."* It applies to Claude Code and Antigravity alike, until the owner lifts it.

Do not edit, reformat, move, rename or "fix" anything in:

| Menu item | Files |
|---|---|
| Customers, Parent Accounts | `production/src/app/(app)/customers/**`, `src/components/features/customers/**` |
| Quotes | `src/app/(app)/quotes/**`, `src/components/features/quotes/**` |
| Subscriptions | `src/app/(app)/subscriptions/**`, `src/components/features/subscriptions/**` |
| Renewals | `src/app/(app)/renewals/**` |
| Invoices | `src/app/(app)/invoices/**`, `src/components/features/invoices/**` |
| Payments Received | `src/app/(app)/payments/**` |
| Project Sales | `src/app/(app)/projects/**`, `src/components/features/projects/**` |
| Shared money logic | `src/lib/quotes/**`, `src/lib/subscriptions/**`, `src/lib/invoices/**`, `src/lib/renewals/**` |
| The menu itself | the `section: "Billing & Subscriptions"` block and the `["Billing", …]` breadcrumbs in `src/lib/nav.ts` — the rest of `nav.ts` is not covered |

- **This includes "harmless" edits.** A lint fix, a renamed import or a reworded comment in
  those files is still a conflict for the person rebuilding them. If a change elsewhere
  would need one of these files to change, stop and ask the owner. Do not make the edit
  and do not work round it by moving the code.
- **Guarded mechanically in this clone.** `.git/hooks/pre-commit` runs
  `scripts/guard-billing-section.mjs`, which refuses a commit that stages any of the above.
  It is local on purpose and not shared, so it never blocks the colleague. Override only when
  the owner explicitly allows that commit: `ALLOW_BILLING_SECTION_EDIT=1 git commit …`. The
  hook lives in `.git/`, so a fresh clone or a new worktree does not have it: reinstall it
  there before editing anything.
- **The shared money logic is blocked too** (owner, 24 Sep 2026: *"block it for now. If need
  to edit, ask me and I will ask my colleague"*): `src/lib/quotes/**`,
  `src/lib/subscriptions/**`, `src/lib/invoices/**`, `src/lib/renewals/**`. If a task needs
  any of it, stop and ask the owner, who checks with the colleague. Query hooks in
  `src/lib/queries/` are not blocked, but check `git log` for the colleague's recent commits
  before touching one that serves these pages.

---

# Learned Guidelines

> One rule per incident, each written the day it cost something. Newest last.

## L1. A scheduled job with no retry and no alert loses a whole unit of work, silently
*22 Aug 2026, from the nightly backup.*

`[cron/backup] sweep failed: JWT issued at future` (20 Aug 18:30 UTC = 21 Aug 00:00 IST).
One attempt, one failure, no retry, no notification. `backup.snapshots` has automated rows
for 17, 18, 19, 20 and 22 Aug and **nothing for the 21st** — one night in six, on a free
plan with no PITR. It was found two days later by reading Cloud Run logs, because nothing
tells anybody.

**The rule:** for any scheduled job, answer all three before calling it done — *what
retries it, who is told when it fails, and how you would notice the failure a week later.*
"It returns 500" is not an answer to any of them. A 500 nobody reads is a silent failure
with extra steps.

**Cloud Scheduler specifically:** a `retryConfig` **without `retryCount` means zero
retries**. Every job in this project was created that way (`scripts/setup-cloud-scheduler.sh`
passes no retry flags), so treat every cron here as one-shot until proven otherwise.

## L2. Classify a failure before retrying it — default to NOT retrying
*22 Aug 2026, same incident.*

The obvious fix is `withRetry(3)`. It is wrong. A missing grant or an unapplied migration
cannot fix itself in four seconds, so retrying it produces the same error fifteen seconds
later, having tripled the load and delayed the only signal anybody gets. That is §2's
"failure converted into a plausible value" wearing a different hat.

**The rule:** retry only failures with a *named* mechanism that a later attempt could
survive — clock skew, a transport blip, lock contention. Anything unrecognised surfaces
immediately. See `lib/backup/sweep-retry.ts` (default-deny, both lists tested) and
`lib/email/gmail-transport.ts` (`retryable: boolean` per failure kind), which is the older
example of the same shape.

Two traps that live in the same list: **"invalid JWT" and "JWT issued at future" both
mention a JWT** and only one is transient, so check the permanent list first. And a
**statement timeout is deliberately permanent** — a job outgrowing its window is a fact the
owner needs, and retrying hides the growth while tripling the load that caused it.

## L3. Do not add a retry to an endpoint that returns non-2xx for PARTIAL success
*22 Aug 2026, the fix that was deliberately not shipped.*

Adding `--max-retry-attempts` to the backup scheduler job looks like the completing half of
L1. It is unsafe here, and the reason generalises. `/api/cron/backup` returns 500 in two
different situations: the sweep failed (nothing written — a retry is free), and the sweep
*partly* succeeded (`result.failed > 0`, some tenants already have tonight's snapshot). Cloud
Scheduler cannot tell those apart; it retries any non-2xx. On the second one, a retry writes
duplicate snapshots for the tenants that already succeeded, and `backup._take` keeps only
the newest 30 per tenant — so the retry **evicts genuine older restore points**. The repair
does more damage than the fault.

**The rule:** before putting a retry in front of anything, ask what the endpoint does when it
half-succeeds. If a second run is not idempotent, make it idempotent *first* — the retry is
not the change, the idempotency is. Retrying inside the handler (where you know nothing was
written) is safe; retrying from outside, where you cannot know, is not.

## L4. Never decide authorization by name substring — and never hardcode a colleague's name to do it
*22 Aug 2026, from `/api/my-advances`.*

That route reads `expenses` with `createAdminClient()`, so **RLS is off** and a plain
JS filter was the only thing between one employee and another's money. The filter was:

```ts
curNameLower.includes(empNameLower) || empNameLower.includes(curNameLower)
```

plus a hardcoded ladder of six colleagues' first names, plus a clause granting anyone
whose *email* contained "sales" every advance named "darshan".

Against the live staff list that is not theoretical. An advance recorded as **"Raj"**
would show to **"Ranjeet Raj"**; one recorded as **"Sharma"** to all five Sharmas in this
tenant. **Surnames are shared — a substring test cannot decide whose money this is.**

**The rules:**
- **A route that uses `createAdminClient()` has no RLS.** Its filter *is* the security
  boundary, so it belongs in a tested module, not inline — see
  `lib/expenses/advance-visibility.ts`.
- **Match whole name tokens, never substrings**, and fail closed: no name on the viewer
  or no name on the record means no match.
- **Never match on a display placeholder.** `vendor_name || "Employee"` must not reach the
  matcher, or every unnamed row belongs to anyone called "Employee" (§2 again).
- **Never hardcode a person's name in a rule.** It matched nothing in the live data, so it
  read as harmless — a standing grant that fires the day the data changes.
- **Check the WRITE side too.** The same route's POST took `advance_id` from the request
  body and never checked whose it was, so any employee could file a claim against a
  colleague's advance — and since the balance is derived by summing linked claims, a
  ₹5,000 claim against a ₹2,000 advance drove someone else's balance to zero. Read-side
  filtering is half a fix.

## L5. An `as any` on a Supabase insert switches off checking for EVERY column in it
*22 Aug 2026, same route.*

`(admin.from("expenses" as any) as any).insert({...})` existed because `ExpenseInsert` was
missing `prepaid_advance_id` — a column `ExpenseRow` has had since migration 0209. The cast
was written to smuggle one field past the compiler, and in doing so it stopped type-checking
the other twelve fields in the same object.

**The rule:** a cast to get one column through is never local to that column. When a type
fights you, **fix the type** — the missing field took one line in
`lib/supabase/database.types.ts`, and the route then type-checked clean with no casts at all.
A missing field in the generated types is a bug in the types, not a reason to opt out of them.

## L6. A config problem is not a server error — one catch-all makes the 5xx log unreadable
*22 Aug 2026, from `/api/whatsapp/send`.*

The route mapped every throw to `502` in a single catch, so a workspace that had simply
not filled in its WhatsApp credentials landed in Cloud Run's **ERROR** bucket:

```
502  [/api/whatsapp/send] failed: WhatsApp credentials are not configured for this
     workspace. Settings → Integrations → WhatsApp Business.
```

Production had **four** 5xx events in the fortnight to 22 Aug 2026, and this was one of
them — a settings page nobody filled in, sitting in the same bucket as a lost nightly
backup. That is the real cost: the error log is the one signal anybody scans, and every
non-error in it makes the next reader trust it less. Finding the backup gap meant reading
past this.

Also: **502 means "retry, the upstream is unwell"** and nothing here would change on a
retry — Meta was never called. The caller cannot fix a 502; it can fix a 409, and the
message already said where to go.

**The rules:**
- **Choose the status by who can fix it.** Tenant configuration → 4xx (this repo uses
  **409** for "your workspace state conflicts with this request" — see
  `api/integrations/email-provider`). A missing *deployment* secret is genuinely ours → 503,
  which is what the cron routes correctly use. Upstream actually failing → 502.
- **`console.error` is for faults.** A config notice is `console.warn`, or the error bucket
  becomes a feed.
- **One catch-all per route is a smell.** Classify, then act — the same shape as L2,
  `lib/whatsapp/send-failure.ts` and `lib/email/gmail-transport.ts`.
- **Do not key the decision on `instanceof` alone.** It stops holding across a re-throw or a
  structured clone while the message survives, and a status code that depends on how the
  error travelled is a status code that will be wrong one day.

## L7. A zero-based isolation assertion must be scoped to the OTHER tenant, not to "everything"
*22 Aug 2026, from running the SQL suite that nothing runs.*

`supabase/tests/sandbox_tenant_isolation.test.sql` now fails with:

```
FAIL 1: a sandbox tester can read 8 customer(s) of the live business
```

**There is no leak.** The assertion is `select count(*) from public.customers` — no tenant
filter — and it then calls whatever it counted "the live business". When the sandbox had zero
customers the count was zero and it passed. The tester has since created 8 of their own, and
the arithmetic settles it: the tester saw exactly **8**, the sandbox tenant owns exactly **8**,
and the live tenant's **26** are not among them. A real leak would have counted 26 or 34.

This file already guards against the opposite mistake — its own notes explain that "0 is also
what a broken session returns", so it reads back things that SHOULD be visible as a control.
The author protected against a session that sees nothing and not against a tenant that
legitimately acquires something.

**The rules:**
- Assert `count(*) where tenant_id = <the other tenant>` = 0. Never bare `count(*)`, and never
  let the message claim a tenant the query never checked.
- **A security test that cries wolf is worse than no test.** The next reader learns to discount
  it, and the day it means something nobody believes it.
- **Run `supabase/tests/` before trusting any sentence of the form "the wall is proven".** Those
  files are not in CI and not in the Stop hook, so their claims age silently. **There are 54 of
  them as of 23 Sep 2026** — this said 38, and §9 said 28; see §9 for the current state and for
  how to run them without mis-reporting the report-style convention. Measured in Aug 2026:
  **6 of the 31 runnable files are red**, and none of the six is a live defect —
  one false positive (above), one assertion made stale by a deliberate change the same day
  (`renewal_and_subscription_creation` documents "monthly-flex creates NO subscription", which
  `85a5d67` changed on purpose), one polluted by leftover data, and three not yet triaged.
- **Two conventions live in that folder, and a naive runner mis-reports one of them.** 31 files
  end `rollback;` and exit 0 on success. The other 7 do their work inside `do $$ … end $$` and
  finish with `raise exception 'TESTRESULT >> …'` — the exception IS the rollback, so they exit
  **non-zero when they pass** and their result is in the error text. Do not "fix" one of those by
  deleting the raise: that commits its test rows to production.
- **A duplicate-key failure in an isolation test means a previous run did not roll back.** Check
  for the leftover row before believing the assertion — `hierarchy_peer_isolation` failed today
  on `users_pkey`, and the synthetic user from an earlier run was still in `public.users`.

## L8. A guard proved by a test that nobody runs is a guard you no longer have
*22 Aug 2026, from `zero_amount_guards.test.sql`.*

`supabase/tests/zero_amount_guards.test.sql` asserts bug #27: `record_payment` rejects a
payment against a ₹0 quote (migrations 0060/0061). Run for the first time in a long while, it
fails — and the reason is that **the guard is not in the function any more.**

`record_payment` does have `if p_amount is null or p_amount <= 0 then raise exception 'amount
must be > 0'`, and at a glance that looks like the guard. It is not. It checks the **payment
argument**, not the **quote's total**. Nothing anywhere reads `v_quote.amount` for this, so a
₹5,000 payment against a ₹0 quote goes straight through. The function is 26,000 characters and
has been rewritten repeatedly; the guard was lost in one of those rewrites and the only thing
that would have noticed was a test file outside CI.

Measured before claiming harm: there are **zero** ₹0-amount quotes and zero ₹0 payments in the
database, so this is an exposure, not an incident.

**The rules:**
- **A migration is not evidence a guard exists today.** `0060/0061` applied; the behaviour is
  gone. Before citing any guard, grep the live function body — `pg_get_functiondef` — not the
  migration that introduced it.
- **When a guard's test goes red, do not "fix" the test to match the code.** That silently
  retires the guard and destroys the only record that it was ever wanted. Leave it red, say so
  out loud, and let a human decide whether to restore the guard. Red is the correct state for a
  protection that has gone missing.
- **Two guards with the same shape are not the same guard.** `p_amount <= 0` and
  `quote.amount <= 0` differ by one word and by the entire thing being protected. This is how a
  missing check reads as a present one to anybody skimming.

## L9. `record_payment` has lost TWO guards its tests still prove — check the body, not the migration
*22 Aug 2026, from finishing the triage L8 started.*

`record_payment` is 26,000 characters and has been rewritten repeatedly. Two separate guards
that SQL tests in this repo assert are **no longer in it**, and both were found the same
evening, by running a suite that is in neither CI nor the Stop hook:

| Migration | What the test proves | What the function does today |
|---|---|---|
| 0060/0061 (bug #27) | rejects a payment against a ₹0 quote | only checks `p_amount <= 0` — the payment argument. Nothing reads `v_quote.amount`. |
| 0064/0065 | reuses an existing same-email customer instead of duplicating | inserts a new customer from the lead unconditionally (line ~188). No lookup by `contact_email` at all. |
| 0157 | a one-off quote (`is_one_off`) records the payment but creates NO subscription | **the string `is_one_off` does not appear in the function at all.** A direct invoice gets a subscription like anything else. |

**0157 is the worst of the three, because its path is reachable and its damage is silent.**
`quote-builder.tsx:917` sets `is_one_off: isInvoiceMode ? !invoiceRecurring : false` — so any
non-recurring direct invoice takes it. The spurious subscription then lands in MRR (a one-time
sale counted as recurring revenue) and in the renewal cron, which can send a renewal reminder to
somebody who bought once. Nobody has used the path yet — 0 one-off quotes exist — so it is an
exposure, not an incident, and the test that would have caught it asserted nothing at all: it
ended `raise exception 'TESTRESULT >> %'` with the observed values interpolated and the expected
values in a comment for a human to eyeball.

Neither has caused damage yet, measured: zero ₹0-amount quotes, and 12 emailed customers with
12 distinct emails. But the dedup one has a second edge worth knowing — **23 of 35 customers
have no email at all**, so an email-keyed dedup could never have protected two thirds of them
even when it worked.

**The rules:**
- **One long function is where guards go to die.** Every rewrite of a 26k-character body is a
  chance to drop a four-line check, and nothing fails loudly when one goes. If you touch
  `record_payment`, diff the guard list before and after.
- **Grep the live body, never the migration.** `pg_get_functiondef(p.oid)` is the only honest
  answer to "does this guard exist". A merged migration proves it once existed.
- **A guard-shaped line is not the guard.** `p_amount <= 0` sits where the #27 guard should be
  and protects something else entirely, which is why nobody noticed for months.

## L10. When a tenant-scoped function returns 0, suspect the missing context before the logic
*22 Aug 2026, from two of the eleven red SQL tests.*

Two failures looked like product bugs and were neither:

- `credit_card_liability` → `FAIL: card spend touched the bank (bank=0)`. The bank fixture
  opens at ₹1,00,000, so 0 is not "₹5,000 was wrongly deducted" — it is *no rows found*.
  `bank_account_current_balance` is SECURITY DEFINER and scoped by `current_tenant_id()`, and
  the test sets only `{"role":"service_role"}` with no `sub`, so there is no tenant to scope to.
- `portal_customer_users_no_self_update` → `last_login_at not stamped by RPC`.
  `portal_touch_login` keys off `auth.uid()`, which that session does not supply, so it updated
  zero rows. Note what DID pass in the same file: the exploit updated 0 rows and the
  `customer_id` did not move. **The security half held; only the "does the RPC work" half fell.**

**The rules:**
- **Distinguish "wrong number" from "no rows".** A tenant-scoped function with no tenant
  returns 0, ∅ or NULL — which reads exactly like a computation that went wrong.
- **A test that sets `role` has not set an identity.** `current_tenant_id()` needs a `sub`;
  `auth.uid()` needs a `sub`. Setting the role alone gets you neither.
- **Write the failure message about what the query actually checked** (L7 again). "card spend
  touched the bank" sent me looking at card logic for a value that came from an empty result.

## L11. Seven SQL tests ran against the live tenant's books — a fixture must own its data
*22 Aug 2026.*

Seven of the 38 files in `supabase/tests/` hardcode the production tenant and a production
customer, and create no fixtures of their own:

```sql
v_tenant uuid := 'fbb976f1-9090-4f10-9726-0901bd144e42';  -- Anutech Digital
v_cust   uuid := '53db44e6-6e90-4fec-8871-8d2288393a2a';
```

`accrue_referral_commission`, `create_direct_invoice`, `create_direct_invoice_recurring`,
`create_project_direct_invoice`, `generate_invoice_payment_terms`,
`record_payment_billing_cycle_decouple`, `record_payment_one_off_guard`.

They **insert quotes and call `record_payment` inside the real company's books**, and the only
thing that takes it back out is the closing `rollback` or `raise exception`. That is one deleted
line away from test quotes and test payments being permanently in ANUTECH's ledger — and
"delete the raise so the test stops erroring" is a plausible thing for somebody to try (see L7).

They also all broke on 22 Aug for the mundane reason: customer `53db44e6…` was deleted, so every
one of them died on `quotes_customer_id_fkey` before its first assertion. **A test that borrows
live ids is a hostage to whatever the operator did last week** — the same failure as
`hierarchy_peer_isolation` borrowing auth ids (L7) and `sandbox_tenant_isolation` counting live
rows (L7).

**The rules:**
- **A fixture owns its data.** Insert your own tenant, your own customer, your own auth user, with
  literal ids in a reserved-looking range. Never `select … limit 1` from real tables, never a
  hardcoded production id. AGENTS.md §4 already forbids hardcoding a `tenant_id`; this is that
  rule applied to tests, where it is easiest to excuse.
- **Never point a write-path test at the live tenant**, even inside a transaction. Correctness
  should not depend on one keyword at the bottom of the file.

**The rule paid for itself the same day.** Hours after those seven were rewritten, the live
ANUTECH tenant had every transactional table cleared at Pardeep's request — leads, quotes,
payments, invoices, customers, subscriptions and the rest, all to 0. The SQL suite came back
**32/38, byte-identical to before the wipe**: not one test broke. Every one of the seven would
have died on the missing customer id that morning. A fixture that owns its data does not
notice what the operator did to theirs.

- **Report-style tests are not tests.** `raise exception 'TESTRESULT >> %'` with expected values
  in a header comment means a regression prints a slightly different sentence and passes. Assert,
  then finish with a visible `select 'PASS'`.

## L12. A status field must answer the question its name asks
*22 Aug 2026, from `invoice_dunning_log`.*

```ts
status: isEmailConfigured() ? "sent" : "stubbed",
```

`isEmailConfigured()` answers *"is Resend set up on this server"*. The column is called
`status` and is read as *"did this message reach the customer"*. Two different questions, and
the wrong one was cheaper to ask.

The result, on real rows: INV-3BBD-2026-27-0002 (SAHAKAR INFRACON PROJECTS PRIVATE LIMITED,
₹55,885) has a `reminder` step logged on 19 Aug and a `retry` on 21 Aug, both `status = 'sent'`,
both `recipient_email = NULL`. **Nothing was sent** — the route only sends when it has an
address (`if (to && msg)`), and that customer has no `contact_email`.

This is §2 in its most expensive form, because **the wrong value is reassuring**. The reseller
reads "reminder sent, retry sent, still unpaid" and concludes the customer is stalling. The
ladder advances on those rows too, so the invoice marches toward an escalation that says "the
customer has had the full reminder sequence" about somebody who was never contacted. A missing
customer email is an ordinary state; it only needs to be *visible*, because it is the
reseller's to fix and nobody else's.

**The rules:**
- **Log what happened, not what was possible.** Derive a status from the outcome of the action,
  never from the configuration that would have permitted it.
- **Check the specific before the general.** `lib/invoices/dunning-log-status.ts` looks at the
  recipient first and the provider second, because a configured provider says nothing about a
  message with nowhere to go. Getting that order wrong *is* the bug.
- **"Nothing to do" and "done" must not share a value.** They need separate states —
  `no_recipient` here — or the difference is unrecoverable from the audit trail afterwards.
- **Count the silent cases and surface them.** The cron now returns `no_recipient`, so a run
  that reached nobody cannot report itself as a normal night.

## L13. A function whose OUT column shares a name with a table column cannot run
*22 Aug 2026, from `create_project_direct_invoice`.*

```
RETURNS TABLE(invoice_id text, project_id uuid)
...
select id into v_msid from public.project_milestones where project_id = v_pid order by seq limit 1;

ERROR 42702: column reference "project_id" is ambiguous
```

An OUT column is a PL/pgSQL variable inside the body, so `project_id` in that WHERE clause
could be either. Postgres refuses to guess, and it refuses at **runtime**, on every single
call — there is no compile step to catch it. The function aborts after
`create_project_quote` and `accept_project_quote` have already run, so the caller gets an
error naming neither.

**It had never once succeeded.** `project_sales` and `project_milestones` both hold 0 rows,
while `create-project-quote-dialog.tsx:46` has called it through
`useCreateProjectDirectInvoice()` since migration 0160. A whole feature, wired to the UI,
dead the entire time.

**The rules:**
- **Alias every table in a plpgsql function body and qualify every column** — `pm.project_id`,
  never bare `project_id`. Cheap habit; the alternative is a landmine that only goes off in
  production.
- **An OUT column name is taken.** `RETURNS TABLE(... project_id ...)` reserves that word
  for the whole body. Prefix locals (`v_`) — this codebase already does — and treat the OUT
  names as equally dangerous.
- **0 rows in a feature's table is a finding, not a quiet fact.** Both tables being empty was
  the visible symptom for months and read as "nobody uses projects yet".
- **This is what an unrun test costs.** The one file exercising this path had stopped running
  (deleted customer id) and asserted nothing before that. Fixing the test found the bug in a
  single run.

## L14. Read your ids BEFORE `set role authenticated`, or the exploit you test targets NULL
*22 Aug 2026, from `portal_customer_users_no_self_update`.*

That file proved a portal customer cannot re-point their `customer_users` link at another
customer. It had been passing. It was proving nothing:

```sql
set local role authenticated;
do $$ begin
  select auth_user_id::text into v_uid from public.customer_users where customer_id = '…a7';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, …), true);
  update public.customer_users set customer_id = '…a8' where auth_user_id::text = v_uid;
  -- assert 0 rows updated
```

The SELECT runs as `authenticated` with **no claims set yet**. RLS filters it, `v_uid` is
NULL, and the exploit UPDATE becomes `where auth_user_id::text = NULL` — zero rows whatever
the policies say. A green security test over a statement that could never have touched a row.

The symptom that exposed it was the *other* case: `portal_touch_login()` keys off `auth.uid()`
and also did nothing, so `last_login_at` stayed at its seeded 2020 value. That failure is the
only reason anybody looked, and it was the smaller problem by far.

**The rules:**
- **Capture ids before the role switch**, and carry them in a transaction-local GUC —
  `authenticated` can read a GUC but not a temp table owned by the connection role.
  `hierarchy_peer_isolation.test.sql` already documented this; the lesson had not spread.
- **Guard the guard.** A "cannot update / cannot insert" assertion needs a setup check that
  the target row IS reachable as that user first, so "0 rows" means *refused* and not
  *invisible*. This file now asserts `auth.uid()` matches and that the user sees exactly 1 of
  their own rows before trying the exploit — and reverting to the old order makes it say
  `SETUP FAIL: … would match no rows and prove nothing` instead of passing.
- **Suspect any security test whose every number is 0.** That is the shape both this and
  `sandbox_tenant_isolation` failed in, in two different ways (L7).

## L15. There is no forgot-password page, and a destructive screen demands the password
*22 Aug 2026, from Pardeep trying to use Settings → Reset data.*

`src/app/(auth)/` contains `login`, `signup`, `callback` and `welcome`. **There is no
forgot-password or reset-password route anywhere in the app.**

That collides with a real screen: Settings → Reset data requires the operator's login
password, and the API re-checks it with `signInWithPassword`. So the owner of the business
could not use it — measured on the live account, `pardeep@anutech.in` has
`providers = 'email, google'`, meaning he normally signs in with Google and has no reason to
remember the password that exists on the row.

The only way out is the Supabase dashboard (Authentication → Users → ⋯ → send recovery, or
set a new password), which is not something the app tells anybody.

**The rules:**
- **Password recovery is not optional once anything asks for a password.** Any screen that
  demands re-authentication needs a reachable way to recover that credential — otherwise the
  guard is a locked door with the key thrown away (CLAUDE.md §24: never a dead end).
- **Check the auth providers before assuming a password is known.** A Google-first account has
  a password row it has never used. `auth.identities.provider` is where that shows.
- **Do not weaken the guard to work around it.** The password check on that screen is
  protecting a delete that takes 39 payments and 26 lead activities along with the six
  sections it names. The fix is a recovery route, not a softer gate.

## L16. `grid-flow-col` on top of an unreset `grid-cols-N` renders columns at ZERO width
*22 Aug 2026, from the Kanban board on /leads.*

Reported as *"canban view sahi show nahi ho raha hai"*. The board carried:

```
grid-cols-1 sm:grid-cols-2 lg:grid-flow-col lg:auto-cols-[minmax(220px,1fr)]
```

Measured in the browser at a 1051px viewport:

```
grid-template-columns: 0px 0px 220px 220px 220px 220px
```

**New (9 leads) and Contacted (26) were the two 0px tracks** — 35 of 37 deals with no width
to render in, under a footer reading "37 total deals visible". Three empty columns on screen
and a count of 37 beneath them.

The mechanism: `sm:grid-cols-2` is an **explicit** template and nothing reset it at `lg`. With
`grid-auto-flow: column`, items 1–2 fill those explicit tracks and 3–6 create **implicit**
ones — and `grid-auto-columns` applies *only to implicit tracks*. The four implicit columns
took 4×220px of a 779px container, so the explicit pair's `1fr` resolved to 0. Adding
`lg:grid-cols-none` makes all six implicit: `220px ×6`, scrollWidth 1380, and the board
scrolls as designed.

**The rules:**
- **Reset the template wherever you switch to `grid-flow-col`.** `grid-cols-none` at that
  breakpoint, every time. A responsive `grid-cols-N` lower down does not stop applying just
  because a later breakpoint adds column flow.
- **`grid-auto-columns` never touches explicit tracks.** If some columns obey your minimum and
  others do not, that is the tell.
- **A zero-width grid track is invisible, not broken-looking.** No error, no overflow, no gap —
  the cards simply are not there, which reads as "no data" rather than "bad layout".
- **jsdom cannot catch this**, so a rendering test is no help: it does not do grid layout, and
  the columns measure identically before and after. `lib/ui/grid-flow-col-reset.test.ts` scans
  the source for the class combination instead — the same approach as `route-map.test.ts`, with
  a guard that it actually scanned 100+ files.

## L17. An API field the UI never sends is a feature that does not exist
*22 Aug 2026, from "email sales@anutech.in se jani chahiye".*

`PATCH /api/integrations/email-provider` has accepted `gmailSenderUserId` all along, and
validates it properly — it refuses an account with no refresh token, refuses one that never
granted `gmail.send`, and returns a §24 message with a `next` link for each. Everything
needed to choose a different sending account was there.

`email-sending-card.tsx` never sent the field. So the sender was whoever configured email
FIRST, because PATCH derives it as `body.gmailSenderUserId || current || the caller's id`.
Pardeep set it up, so every email left as `pardeep@anutech.in`, and no screen in the app
could change it. From the outside this looks exactly like a missing feature; in the code it
looks finished.

**The rules:**
- **A validated parameter with no caller is dead weight that reads as capability.** When
  reviewing "does the app support X", check the call site, not the handler. `grep` for the
  field name and see whether anything sends it.
- **Defaulting an identity to "whoever is asking" outlives the request.** `|| user.id` is
  reasonable for a first save and wrong forever after — it silently makes a config decision
  that nobody chose and nobody can see.
- **List the ineligible options, do not hide them.** "sales@ is not in the picker" and
  "sales@ has not connected Google" send someone to different places, and only the second
  was true. The row is shown, disabled, with what is missing and who has to fix it.
- **Show the address mail actually leaves from.** A workspace login of sales@anutech.in
  connected to a personal Gmail sends from the personal one. Displaying the login would
  hide from the operator what the customer sees in From.

## L18. A `redirectTo` that is not allowlisted is discarded in silence, and Site URL takes over
*22 Aug 2026, from the first real password-reset link.*

`/forgot-password` sends
`redirectTo: ${origin}/callback?next=/reset-password`, and `appPathOr` accepts
`/reset-password` — the app-side chain is correct and was verified. Clicking the link still
landed on the **marketing landing page**, at
`resellersos-1005662057478.asia-south1.run.app` with no path, no `code`, no query.

That is Supabase Auth falling back to **Site URL**: when `redirectTo` is not in the
project's Redirect URLs allowlist it is ignored, and nothing anywhere reports it. Not an
error, not a warning, not a different landing page — the operator simply arrives somewhere
that looks like the app failed.

**Two hosts serve this Cloud Run service and both are real** —
`resellersos-njvk4nxhdq-el.a.run.app` (what `gcloud run services describe` returns) and
`resellersos-1005662057478.asia-south1.run.app` (what the Cloud Scheduler jobs call). An
allowlist holding one of them breaks every flow started from the other.

**The rules:**
- **Any OAuth or magic-link `redirectTo` needs its origin in the allowlist**, with a path
  wildcard: `https://<host>/**`. Add every host that serves the app, plus
  `http://localhost:3000/**` for development.
- **Do not debug this in the app first.** The give-away is a landing URL with no `code`
  parameter: the callback was never reached, so no amount of reading the callback route
  explains it. Check the allowlist before the code.
- **The service having more than one hostname is the part that surprises people.** Grep for
  hardcoded hosts (`scripts/setup-cloud-scheduler.sh` pins one, docs pin the other) before
  assuming there is a single canonical origin.

## L19. Supabase Auth still emails under a brand this company retired
*22 Aug 2026, same email.*

The password-reset mail arrives as:

```
Excel Technologies <no-reply@mail.exceltechnologies.in>
```

**Excel Technologies is historical.** The company is ANUTECH DIGITAL PVT LTD
(`CLAUDE.md §1`, corrected 14 Aug 2026 after the same name was found in `doc_code`, the
dev-login list, and the docs). Auth email is one more place it survived — and the worst
one, because it is the only branding a *teammate or customer* sees before they trust a link
enough to click it. A reset mail from a company they have never heard of is a mail they
should ignore.

**The rules:**
- **Auth emails are branding, not plumbing.** They are sent by Supabase, so they are invisible
  to every grep of this repo and survive every rename done in code. Check
  Authentication → Emails / SMTP whenever the company name changes.
- **When correcting a historical name, list the places it can hide**: `doc_code`, seeded demo
  data, docs, and anything a third-party service sends on your behalf. §1 caught the first
  three; this is the fourth.

## L20. A hardcoded recipient is a data leak, not a stale string
*22 Aug 2026, found in five routes while reading an unrelated log line.*

Five server routes carried `const PARDEEP_EMAIL = "Pardeep@exceltechnologies.in"` and used it
as `to:` / `replyTo:`. `api/webhooks/razorpay/route.ts` had been fixed months earlier and its
own header states the cost — *"every tenant's payment alert, carrying their customer's name,
email and amount, was mailed to one fixed address. The owner of the tenant that made the sale
never got it, and someone else did."* The other four kept the bug, and one of them,
`api/cron/trial-expiry`, **SELECTS `tenant_id` for every expired trial and never reads it.**

Two things make this class hard to see:

- **It never looks broken.** A misdirected alert is delivered, so nothing errors, nothing
  retries, no log line appears. A *missing* alert eventually gets noticed; a misdirected one
  does not. That inverts the usual instinct — here, refusing to send is the safer failure.
- **The comment tells you it is temporary and nobody re-reads comments.** The enquiry route
  said, in full: *"Hardcoded for v1 (single tenant); resolve per-tenant once we go
  multi-tenant."* That TODO came due and no test, type, or lint rule was watching it.

**The rules:**
- **Resolve every recipient from data, never from a constant.** `lib/email/owner-alert.ts`
  returns an address or a *stated reason* — there is no fallback constant to leak, the same
  posture as `lib/invoices/supplier-identity.ts` ("never invent a tax identity").
- **A fallback recipient is the bug with better manners.** The razorpay route's
  `seller.email || FALLBACK_OWNER_EMAIL` was defended in its comment as better than "silently
  dropping" the alert. It was not dropping it — it was delivering another tenant's customer
  data to a third party. Deleted, not improved.
- **Guard the SHAPE, not the string.** The obvious test is
  `expect(src).not.toMatch(/exceltechnologies/)`, which `lib/whatsapp.test.ts` does for
  signatures. Wrong tool here: one live tenant legitimately *has* that address on file, and a
  brand-dated guard passes the day somebody hardcodes `pardeep@anutech.in` instead — the same
  bug with a fresher domain. `lib/email/no-hardcoded-recipient.test.ts` scans for *a literal
  at a recipient field*, so it fails on an address nobody has thought of yet.
- **A shape guard has a blind spot, and you must go fix what it cannot see.** The razorpay
  fallback reached `to:` through a variable, so the scan showed that route clean while the
  other four looked guilty. Green there was luck. Grep the same idea by hand once, then
  remove what the guard cannot reach rather than trusting the pass.
- **The same audit finds hardcoded IDENTITY, not just hardcoded addressing.** Those routes
  also told every customer that "Pardeep will WhatsApp you", gave one fixed phone number,
  and signed off *"Google Premier Partner · since 2014"* — a certification claim asserted on
  behalf of whichever tenant owns the storefront. Check the message body, not only the
  headers.

## L21. `x && sendEmail(...)` inside Promise.allSettled makes "not sent" read as "sent fine"
*22 Aug 2026, introduced by the L20 fix and caught before it shipped.*

Guarding a send as `owner.ok && sendEmail({...})` is the natural way to skip it. But
`Promise.allSettled` settles the literal `false` as `{ status: "fulfilled", value: false }`,
and the handlers below all read `r.value.status === "failed"`. On a skipped send that is
`undefined` — falsy — so the skip is silently classified as a success. No throw, no log, and
the counter that was supposed to prove the mail went out counts it.

**The rule:** when a conditional send sits in an `allSettled` array, check the value is a
result before reading it as one (`r.value && r.value.status === "failed"`). Same family as the
dunning-log defect: a log that reports a send nobody made is worse than no log, because it is
the thing you will trust later.

## L22. A template fed a stale snapshot reads as unread mail
*22 Aug 2026, reported from the lead drawer with a screenshot.*

The thread was: we wrote "your enquiry for 50 users of Business Starter"; the customer
replied "actually I need 20 users of Business **Standard**, not 50 of Starter". The
"Quote is on the way" pill then filled the composer with **"Thank you for your enquiry for
50 users of Google Workspace Business Starter … If the number of users changes before then,
just reply here and I will adjust it."**

Both sentences are wrong in the same way: it restated the figures the customer had just
corrected, then invited them to do the thing they had just done. Not a badly-written
template — a correct template fed a stale snapshot. `PillContext.seats`/`.product` come from
the LEAD row, which records the FIRST enquiry, and nothing told the pill a newer message
existed.

The module already held the principle it needed. It hides the "Ask for phone number" pill
when a number is on file, because — its own words — *"a button that asks a customer for
something already on file makes the reseller look like they did not read the email."*
Restating superseded seats is that failure exactly; the reasoning was written down and not
carried across.

**The rules:**
- **A record built from an event is a snapshot, not the current truth.** Any field copied
  out of the first contact (seats, product, budget, timeline) must be treated as possibly
  overtaken the moment a newer message exists. Ask "what is the newest thing the customer
  said?" before restating anything back to them.
- **When facts may be stale, stop asserting them — do not guess the new ones.** The reply
  said 20 of Standard; a template cannot parse that and must not pretend to. Dropping the
  clause is honest, a guessed seat count in a customer's inbox is not. Same rule as
  `whatTheyAskedFor`: "or nothing, never a guess."
- **The stale/fresh distinction needs BOTH halves.** "Newest message is inbound" is not
  enough — a first enquiry is also inbound-newest, and there the stored facts are exactly
  right to repeat back. `summariseThread().customerRepliedToUs` requires an inbound newest
  AND at least one outbound before it.
- **Reading a correction and acting on it is a model's job, not a template's.** The honest
  ceiling for a canned reply is to acknowledge that something changed. If the product needs
  to answer "they cut it to 20 Standard, here is the revised quote", that is an LLM reading
  the thread, and it needs the money-guard that `api/ai/draft-followup` already has.

## L23. Check what "pass" means before believing a test count
*22 Aug 2026, Phase 0 of automating the spine.*

I built a runner for the 38 files in `supabase/tests/` and it reported **12 pass / 26 fail**.
Twenty of those failures said "exit 0, no PASS row". I almost reported 26 failures.

The detector was wrong, not the suite. These tests signal success with
`raise notice 'PASS: …'` — a NOTICE, which the CLI's JSON output does not carry at all. A
real failure `raise exception`s, which exits non-zero. So the correct criterion is the exit
code, and the honest count is **32 pass / 6 fail**.

**The rule:** before reporting a test count, run one test you believe PASSES and one you
believe FAILS, and confirm the detector separates them. A pass-detector that looks for
evidence of success will read a silent success as a failure — and unlike the usual vacuous
test, this one fails LOUD and sends you fixing things that were never broken. Twenty
invented failures in the money spine is a full day spent, and it would have ended with a
"fix" to code that was correct.

Corollary, from the same run: **a suspiciously large number of failures is itself evidence
about the harness, not the code.** Twenty simultaneous regressions in one folder is a less
likely story than one wrong grep.

## L24. Verify a DDL fix in a rolled-back transaction, and inject it after EVERY `begin;`
*22 Aug 2026, same work.*

DDL is transactional in Postgres, so a 26 KB `CREATE OR REPLACE FUNCTION` can be applied
inside a test's own transaction, asserted against, and rolled back — proving a fix against
production data without persisting a byte. That is how the three `record_payment` guards were
confirmed as 32/38 → 36/38 with zero regressions before anything was applied.

Two things that make the difference between proof and theatre:

- **Inject after every `begin;`, not the first one.** Several files here run more than one
  transaction (`zero_amount_guards` has two). Patch only the first and the later sections run
  against the UNPATCHED function while the file still reports green — the regression check
  silently covers less than it claims.
- **Run the WHOLE suite, not just the tests you meant to fix.** The four target tests going
  green says nothing about the other 34, and the change was to the function at the centre of
  the spine. "Zero regressions" is a measurement, not an expectation.

And when merging several test files into one transaction to save time, don't: fixture ids
collide (`cccccccc-…d1` is used by two of these), and the collision reads as a failure of the
fix. One transaction per file.

## L25. "The data is slow" is usually "the screen never refetches" — check the last hop first
*22 Aug 2026, reported as "email receive me bahut time lagta hai, real time nahi ho sakta?"*

The instinct is to go looking at ingestion: is the webhook slow, is Gmail forwarding lagging,
should we poll the Gmail API. All of that was fine. Inbound mail is PUSHED —
customer → Gmail → forwarding rule → inbound-parse provider →
`POST /api/webhooks/inbound-email` → `inbound_emails` — and every hop to the database takes
seconds.

The delay was entirely the last arrow, the one nobody counts as a hop. `useInboundEmails()`
declared no `refetchInterval`; `query-provider.tsx` sets `refetchOnWindowFocus: false` for the
whole app; `staleTime` is 30s. So once the page was open, a new email could sit in the
database **indefinitely** and never appear. The only remedy was a hard reload.

**The rules:**
- **Walk the chain backwards from the eyeball, not forwards from the source.** The render is a
  hop. It is the cheapest one to check and the easiest one to forget, because every other hop
  has a log line and this one has none.
- **A global default that is right for the app can be wrong for one screen.** That comment —
  "refetchOnWindowFocus: disabled (annoying for SaaS apps)" — is correct for a settings page
  and exactly backwards for an inbox, where the commonest motion is reading mail in Gmail then
  switching tabs to see it. Override locally; do not flip the global.
- **A poll with the default `staleTime` can still show nothing new.** The refetch is answered
  from cache. `refetchInterval` without `staleTime: 0` is the same bug wearing a shorter delay.
- **Look at what the neighbours do.** `lib/queries/whatsapp.ts` already polled at 10-15s and
  `useNavBadges` at 60s. Inbound email — the one surface with a customer waiting at the other
  end — had nothing. An inconsistency across sibling modules is a defect report sitting in the
  codebase for free.
- **The missing column is why it stayed unexplained.** `inbound_emails` records `created_at`
  (when the webhook wrote the row) and nothing about when the customer sent it, so "the
  provider was slow" and "the list is frozen" were indistinguishable from the data. When a
  latency complaint cannot be attributed, that is a schema gap, not a mystery.

## L26. Ask "who is this from" before "what is this" — a classifier must never judge a reply
*22 Aug 2026, reported as "kafi time ho gaya message aaye abhi tak show nahi ho raha".*

The message had arrived three minutes earlier, with fifteen more in the preceding two hours.
It was in the database with status `skipped_non_enquiry`, which `lib/inbound/folders.ts` files
under **Spam / System**, out of the Inbox. `api/webhooks/inbound-email/route.ts` asked its two
questions in this order:

```
line 431   if (!extracted.isEnquiry) -> skipped_non_enquiry, stop
line 445   is there an open lead with this sender? -> append to it
```

The skip came first. So a mid-thread reply — *"actually I need 20 users of Standard, not 50 of
Starter"* — was handed to Gemini, asked "is this a sales enquiry?", and correctly answered
**no**. It is not an enquiry. It is the most important message in the thread. It went to Spam.

**The rules:**
- **Identity before classification.** A message from somebody you already have an open
  conversation with is never spam: you know who they are and what it is about, so there is
  nothing left to decide. A classifier earns its keep on mail from STRANGERS — that is the only
  case where the question is open. Reordering two `if`s was the entire fix.
- **The model was not wrong; the question was.** This is the failure mode to watch for in AI
  plumbing. Nothing in a log would show a bad classification to go hunting for, because the
  classification was right. Auditing prompts and model output would have found nothing.
- **An absent verdict is not a "no".** `isEnquiry: null` means the model never ran (no key,
  timeout, breaker open) and must resolve to "show the operator", never to "spam". Otherwise a
  real customer's first email vanishes during an outage — the one time nobody is watching.
- **Filing something out of sight needs a stated reason.** The row recorded *that* it was
  skipped and never *why*, so answering "where is my email" took a database query. Every
  disposition now carries a reason (`lib/inbound/disposition.ts`).
- **The lesson generalises past email.** Any pipeline that both (a) recognises known entities
  and (b) classifies unknown ones must run the recognition first. Otherwise the classifier gets
  asked about things it was never meant to judge, and answers anyway.

## L27. Postgres block comments NEST — a glob inside one breaks the whole function
*23 Aug 2026, writing the invoice-immutability trigger.*

The migration would not parse:

```
ERROR: 42601: unterminated /* comment at or near "/* An escape hatch that has to be…
```

The comment was closed. What was not closed was the comment *it* opened: the prose said
"the same shape as `supabase/maintenance/*.sql`", and that path contains a slash-star.
PostgreSQL follows the SQL standard here and **nests** block comments, unlike C — so the
inner `/*` opened a second comment and the single `*/` closed only that one, swallowing the
entire remaining function body.

**The rules:**
- **Never write a glob path inside a `/* */` block in SQL.** Say "the files under
  supabase/maintenance", or use `--` line comments, which do not nest.
- **The error names the OUTER comment, not the glob.** It points at the line where the
  comment began, which is where you already know the comment is fine. The offending
  characters can be forty lines further down.
- **Verifying in a rollback transaction caught it before it reached the operator.** This is
  the second thing that pattern has paid for (see L24) — a migration that cannot parse is
  indistinguishable, from the outside, from one that applied.

## L28. A money guard needs its ALLOW list tested as hard as its BLOCK list
*23 Aug 2026, the same trigger.*

Freezing an issued invoice's particulars is the easy half. The half that decides whether the
guard survives is what it must still permit, and two of those would have broken a working
feature outright:

- **`gst_irn`** arrives from the IRP only AFTER the invoice is issued. Freeze it and
  e-invoicing cannot ever complete — a guard that makes the compliant path impossible.
- **`adjusted_advances` / `net_payable` / `first_advance_at`** carry a real post-issue
  settlement (CGST 31(3)(d), migration 0209). Freezing them would have looked correct and
  silently killed advance adjustment.
- **A NULL particular must stay fillable.** `taxable_value`/`tax_amount`/`tax_rate`/
  `inter_state` arrived in a later migration, so older invoices hold nulls. Filling a blank
  completes the record; replacing a value amends the document. Two tiers, not one.

**The rules:**
- **Write the ALLOW cases into the test, with the reason each one exists.** Otherwise the
  next person reading only BLOCK assertions cannot tell a carve-out from an oversight, and
  "tighten this up" removes a load-bearing exception.
- **Run the entire suite with the guard active, not just its own test.** 38/39 with it on is
  the claim worth making; the guard's own test passing says nothing about `record_payment`.
- **Give a guard a stated-reason escape hatch, not none.** `set local
  app.invoice_amend_reason = '<why>'` is transaction-scoped, greppable, and reached by no
  application code path. A guard with no legitimate override is a guard somebody eventually
  drops — and there IS a legitimate need here: 41 invoices carry a due_date that predates the
  net-30 fix.

## L29. Strip the quoted thread BEFORE reading a reply — or you read your own words back
*23 Aug 2026, building Phase 1.*

A reply carries the whole previous conversation underneath it. The message that started
all of this was, in full:

```
Actually, I need the quotation for 20 users of Google Workspace Business
Standard, not 50 users of Starter. Please adjust that.

On Sat, 22 Aug 2026 at 21:54, <sales@anutech.in> wrote:
> Thank you for your enquiry for 50 users of Google Workspace Business
> Starter. …
```

Both numbers and both product names are in that body. **Only the quoted half is ours.**
Anything that reads the raw text to learn what the customer wants — a regex, a model —
is reading our own previous message as if the customer had just said it. For a feature
that WRITES what it reads, that is not cosmetic: it would overwrite 20 with 50 and
record the customer as the source.

**The rules:**
- **Strip first, always** (`lib/inbound/strip-quoted.ts`), and take the EARLIEST marker,
  not the first pattern in your list — a Gmail quote can contain an Outlook divider
  further down, and matching by list order keeps the Gmail block.
- **Fail toward empty, never toward the full text.** The tempting fallback — "if
  stripping left nothing, use the original" — reinstates the quoted thread in exactly
  the case where the parse went wrong. Empty means nothing-to-do.
- **A trailing `>` block is quoted; an inline `>` is not.** A `>` in the middle of fresh
  text is the customer quoting a phrase to answer it. Cutting there loses their answer.
- **Test with the bytes from the database, not a transcription.** Three things about the
  real message are invisible when you retype it tidily: it is CRLF, the catalogue name is
  WRAPPED mid-phrase ("Google Workspace Business\r\nStandard"), and both figures are
  present. A hand-written fixture had none of them and passed while the real message
  would have failed on all three — including a silent miss in `findProduct`, whose exact
  substring match cannot see its own product across a line break.

## L30. Fix the RECORD, not the sentence that reads from it
*23 Aug 2026, after three failed attempts at the same bug.*

A customer said twice that they wanted 20 users of Standard, not 50 of Starter. Three
separate fixes went into the reply DRAFT — stop restating the figures, then a different
staleness rule, then a third — and every one of them was a fresh coat of paint. The
actual state was that `leads.seats` was still 50 and `leads.plan` was still Starter,
because nothing had ever written the correction down.

While that is true, the draft is not the only thing wrong: every quote, every renewal and
every future reply derived from that row is wrong too, and each is its own bug to be
reported later.

**The rule:** when a displayed value is wrong, ask whether the STORED value is wrong
before touching the display. If it is, the display needs no special case at all — it
becomes correct for free, and so does everything else reading the same row. Three of my
attempts at this were spent on the reading end because the reading end is where the
symptom appears.

**Corollary on tools:** this needed no model. `lib/inbound/extract.ts` already read seats
and product with tested regexes and already returned the source sentence each value came
from, which is strictly better here — it cannot invent a number, cannot drift between
runs, and the audit trail is free. Reach for the deterministic thing that exists before
adding an LLM, a wait, a cost and a failure mode.

## L31. Registering ONE more table in the generated Database type can collapse all of it
*23 Aug 2026, adding `document_series` for the invoice-issue dialog.*

> **S21 update (28 Sep 2026):** the collapse was a property of the HAND-WRITTEN type. The
> Database type is now generated (`database.generated.ts`, all 152 tables incl.
> `document_series`, with real `Relationships`) plus a thin overlay, and `tsc` is clean with
> no depth errors. New tables need no untyped client — regenerate with
> `node scripts/check-db-types.mjs --write`. The existing untyped handles (lib/ai/*,
> api/invoices/series, …) still work; converting them is follow-up, owner by owner.

`document_series` was missing from `src/lib/supabase/database.types.ts`, so reading
`last_number` did not typecheck. The obvious fix — declare the Row type and add one line
to `Tables` — did this:

```
without the change:     4 errors
with the change:    2,722 errors
```

Every unrelated table collapsed to `never` (`Property 'customer_id' does not exist on
type 'never'`). supabase-js resolves row types through a large conditional-type chain,
and a `Database` type this size sits close enough to the instantiation-depth limit that
one more member tips it over. Nothing in the error output points at the table you added.

**The rules:**
- **Diagnose by removing, not by reading.** `git stash push -- <the types file>` and
  re-run typecheck. Four errors versus 2,722 is a one-command answer; staring at the
  first ten errors tells you nothing, because they are all in files you never touched.
- **Do not add the table.** Put the one query that needs it behind a route with a
  deliberately UNTYPED client (`createClient` from `@supabase/supabase-js`, no generic),
  in a file small enough to read in full — `api/invoices/series/route.ts`. Keep the Row
  interface as the written record of the shape even though nothing references it from
  `Tables`.
- **An untyped client has no tenant checking.** With no generated types, nothing verifies
  the filter, so an explicit `.eq("tenant_id", …)` IS the entire boundary. Write it on
  the next line and say so in a comment.
- **A cast is not the cheaper option here.** It looks smaller and it is worse: L5 —
  a cast added to get one table through stops checking everything else in the call.

## L32. Fixing "never file it as spam" turned every echo of our own mail into a lead
*23 Aug 2026. My regression, caught by the operator within the hour: "ye lead kyo bani".*

L26 reordered the inbound webhook so a known sender's reply is never classified, and
added: an absent verdict (`isEnquiry: null` — Gemini did not run) resolves to `create`
rather than `skip`, so a real customer's first email cannot vanish during an outage.
Sound reasoning, and it created a new bug the same day.

Every reply on a thread arrives **twice** — once at the customer-facing address, once at
the address we send FROM, because that address is in the thread. Those echoes used to be
filed as spam. Now each one created a lead, named from the domain fallback
(`fromEmail.split("@")[1].split(".")[0]` → "anutech"), with no seats and no plan, sitting
in New beside the real one. The data showed it exactly: the same sender, `skipped` at
514 and 494 minutes ago, `lead_created` at 4.

**The rules:**
- **Our own address is never a customer.** Check it before everything else, including
  before the known-lead lookup — appending the echo would duplicate a thread that already
  records the outgoing message as sent.
- **Match exact addresses, never the domain.** "Anything @anutech.in is ours" silently
  drops a reseller buying for itself, and this app's whole first customer is the tenant
  itself. Collect `tenants.email`, the tenant's `users.email`, and the connected
  `user_google_tokens.google_email` — that last one is what replies actually leave from
  and need not equal any user's login (the "Send as" picker exists for that).
- **When widening a default from "drop" to "surface", ask what ELSE arrives on that
  path.** The change was correct for the case it was written for and wrong for the case
  nobody enumerated. "What else reaches this branch?" is the question that would have
  caught it before the operator did.
- **`user_google_tokens` has no `tenant_id`.** Scope it through the tenant's user ids.
  An unfiltered read under the admin client pulls every tenant's sending address into
  "ours", and then a genuine enquiry from another reseller gets silently dropped — I
  wrote that filter-less query first and caught it before it shipped.

## L33. Before building a list of "the N dangerous actions", check each one exists
*23 Aug 2026, Phase 2.*

My own plan named four irreversible taps: issue invoice, send quote, record payment,
suspend/cancel. Measuring found:

| tap | reality |
|---|---|
| issue invoice | a bare `onClick`, plus a BULK loop over every selected quote |
| send quote | a dialog existed, describing the mechanism and not the commitment |
| record payment | a dialog existed with a title and nothing else |
| suspend/cancel | **not an action in this app at all** |

Only one of four was the job I had written down. The nearest thing to the fourth —
deleting a subscription — already confirms well (what it does, what it is for, and the
alternative when it is blocked). Building a "suspend" tap would have been inventing a
feature to satisfy my own list.

**The rules:**
- **A plan is a hypothesis about the code.** CLAUDE.md §25 says that about docs; it is just
  as true of a plan written an hour ago by me. Grep for each item before starting.
- **"Add a confirmation" and "make the existing confirmation honest" are different jobs.**
  Two of these already had dialogs. The work was not a dialog, it was the sentences —
  which is a smaller change and a harder one to spot as missing.
- **Report the count you found, not the count you promised.** Saying "the real work is
  two, not three, and here is why" is the deliverable; quietly building four would hide
  that the fourth was fictional.

## L34. A money guard's copy must name the consequence nobody would guess
*23 Aug 2026, writing the three consequence modules.*

The mechanical description is the one that gets written and the one that helps least.
"Email a copy of the quote PDF to the customer" is true and tells the operator nothing
they did not already intend. What each act actually needed was the fact they could NOT
have inferred:

- **Send quote** — the accept link works without you, so they can commit you at any hour;
  and a *resend* does not replace the earlier email, so two prices now sit in the thread
  and the customer picks which to read.
- **Record payment** — it issues a GST **receipt voucher** under CGST Section 31(3)(d),
  consuming a serial from the same gapless machinery as an invoice. No screen had ever
  mentioned this. ANUTECH holds zero payments with that counter at 39.
- **Issue invoice** — the number is spent either way, because deleting the invoice retires
  it rather than freeing it (migration 0118).

**The rules:**
- **Say the recovery as well as the risk.** "Delete the payment in Payments — that unwinds
  the customer and subscription cleanly. The receipt-voucher number does not come back."
  An operator who knows the way back acts on a mistake; one who does not, leaves it.
- **Never build the list from invented figures.** The send dialog renders nothing at all
  unless the caller passes real amounts. Defaulting to zero would have put "₹0 goes to the
  customer" on a real quote — a sentence the operator might believe.
- **Phrase by outcome when you cannot know the cause.** "No subscription and no renewal
  are created" is true whether the reason is a one-off sale (guard 0157) or line items with
  no billing commitment. I dropped an `isOneOff` field I could not populate honestly rather
  than let the caller guess it.
- **Move a check EARLIER when the earlier act is the exposing one.** The quote-total-vs-GST
  check lived only on the invoice path. Sending is what actually puts the figure in front
  of the customer, so it belongs there too — by invoice time the number is already quoted.

## L35. When a feature ships "term-aware", check every place the term is used — not just the one you touched
*23 Aug 2026, Phase 3.*

On 22 Aug a term-aware reminder ladder shipped so monthly subscriptions renew properly.
`term_months` appears four times in `api/cron/renewals/route.ts`. It appears **zero**
times in `lib/renewals/create-renewal-quote.ts`, which priced every renewal as:

```ts
const annualAmount = Math.round((input.mrr ?? 0) * 12);
```

So the reminders knew the subscription was monthly and the PRICE did not. The work
stopped at the thing being changed and never followed the concept.

Measured on the row that renews first — c398e832, "Xyz cloud solutions", 10 seats of
Business Starter, `term_months = 1`, renewal 27 Aug, `auto_renew = true`:

```
correct one month     10 × 270      = ₹2,700 ex-GST    → ₹3,186 incl
what it would quote   32,400 × 12   = ₹3,88,800 ex     → ₹4,58,784 incl
```

about **144×**, four days out, on a subscription set to renew by itself. Two defects
compounding: the hardcoded 12-month term, and `mrr` on that row holding an ANNUAL figure
(₹3,240/seat against a ₹270 catalogue price) where every other subscription stores a
genuine per-month rate.

**The rules:**
- **Grep the CONCEPT, not the file.** After making anything term-aware / tenant-aware /
  currency-aware, grep the whole tree for the field and read every hit. The dangerous one
  is the file with zero hits that should have had some.
- **Refuse; do not repair.** The tempting fix for an annual-looking `mrr` is to divide by
  12. That produces a plausible number from data known to be untrustworthy, and a
  plausible wrong price on a customer-facing quote is the worst outcome available. Stop and
  say what to fix.
- **Set the sanity threshold where it catches the neighbours too.** `suspectAnnualMrr`
  triggers above 2× the catalogue rate, not at exactly 12×, so a 3× or 6× mistake is
  caught as well — and a genuine monthly rate slightly above MSRP still passes, which is
  what stops the guard being deleted as a nuisance.
- **A derived label is part of the price.** The quote line's `commitment` was hardcoded
  `annual_yearly`. `record_payment` reads it to decide what subscription to build on the
  way back in, so a one-month renewal labelled annual rebuilds the wrong subscription —
  the error survives the round trip.

## L36. I concluded a money function was wrong. Three existing tests said otherwise, and they were right
*23 Aug 2026, Phase 3. The most important entry here, because I was about to ship it.*

I traced a 12x MRR error to `record_payment`:

```sql
round(v_line_amount / case when v_is_monthly then 1.0 else 12.0 end)
```

and reasoned: `v_line_amount` is `qty * rate`, the quote builder stores rate as ₹/seat/YEAR
(`updateCommitment` writes `rate: tier.msrp * 12`, commented "store as ₹/seat/year"), so
dividing by 1 for monthly is the bug. I wrote the migration, wrote a regression test that
went red for exactly the predicted reason, verified the patch in a rolled-back transaction,
and it went GREEN.

Then the full suite: **four failures**, three of them asserting the opposite in words:

```
monthly_subscription            "the line is Rs 38,232 PER MONTH (a /12 would give 3186)"
record_payment_billing_cycle…   "expected 32400 (the whole month; a twelfth would be 2700)"
renewal_and_subscription…       "mrr should be 3900 (the full month), got 325"
```

A `monthly` line's rate IS per-month — it is a separate price tier, not the annual rate
rebilled. `case when v_is_monthly then 1.0` is correct by design. The real defect was one
branch further out: `updateCommitment` kept the rate when the catalogue had no tier to
read, so switching annual → monthly left a per-YEAR rate on a per-MONTH line.

**The rules:**
- **A green targeted test proves your change does what you meant. It says nothing about
  whether you meant the right thing.** Mine was red-then-green on a false premise, which is
  the most convincing possible way to be wrong.
- **Run the WHOLE suite before believing a money diagnosis** — not after writing the fix,
  and not only the tests you think are related. The three that caught this were named for
  subscriptions, billing cycles and renewals; none would have looked relevant.
- **Existing tests are documentation written by somebody who had the context you lack.**
  Those assertions carry parenthetical asides — "(a /12 would give 3186)" — put there by
  someone who had already considered the exact division I was about to change. Read them
  as an argument, not an obstacle.
- **Two consistent readings of a comment can still both be wrong about the system.** The
  builder's "store as ₹/seat/year" is true of the ANNUAL tier and I generalised it. When a
  convention has families, check the boundary rather than the label.
- **Delete the wrong artifact.** The migration and its test encoded a false belief; leaving
  them "for reference" would let a future session apply them.

## L37. A reminder that fires on the wrong day teaches people to ignore it on the right one
*23 Aug 2026, reported on a Sunday: "aaj kya attendance reminder ko aana chahiye kya ye logical hai".*

It should not, and nothing in the path knew what a working day was. Grepping
`lib/attendance/reminders.ts` for holiday / weekend / sunday / isodow returned exactly one
hit, and that was the phrase "working day" inside an unrelated message. So the nudge went
out every Sunday and on every public holiday — while `public.holidays` (tenant_id,
holiday_date, name) had stored them the whole time and nothing ever read it.

**The rules:**
- **The cost is not the annoyance, it is the correct reminder that gets ignored later.** A
  notification arriving on a day off teaches people to dismiss it unread; three weeks on it
  no longer works on the day it was built for.
- **A calendar question is a business fact, not a default.** Saturday IS a working day at
  ANUTECH — six-day week, Sunday off — and Indian SMEs also run five-day and
  alternate-Saturday weeks. There is no safe default, so `weeklyOffDows` has none and the
  caller must state it. Getting it wrong the OTHER way is worse: silence on a day everyone
  is working becomes a payroll query.
- **Check whether the data already exists before adding a setting.** The holidays table was
  already there. The gap was a read, not a schema.
- **Fail closed on an unreadable date.** `isWorkingDay` refuses rather than defaulting to
  "working" — defaulting is how a nudge goes out on a Sunday because a date string arrived
  in the wrong format.
- **Two surfaces sharing a decision must share the INPUTS too.** The cron and the popup
  already shared `decideAttendanceReminder` precisely so they could not disagree — but
  resolving the working day server-side only would have made the phone stay quiet while the
  screen kept nagging. The popup got the same answer, from the same function.
- **A multi-tenant cron needs the answer per tenant.** That route reads users across every
  tenant by design (one Scheduler hit covers all), so one working-day answer would apply one
  company's holiday calendar to another company's staff.

## L38. "System healthy" from a scan that cannot see is the worst sentence in this file
*23 Aug 2026, asked directly: "kya wo sahi kaam kar raha hai check to karo ek baar".*

Measured, the self-healing loop had two of three eyes shut:

```
Cloud Run logs   PRIMARY source — gcloud auth expired mid-session
Sentry           never worked; SENTRY_DSN is empty (CLAUDE.md §22 already
                 documents that its init is fragile on this host)
DB log tables    working — and the only thing that found anything all day
```

I had reported "System healthy. Waiting for next cycle." repeatedly across that session.
Each one was true of what the scan could still see and worthless as a statement about the
system — which is exactly the shape L1 is about, applied to the monitoring rather than the
monitored.

The evidence that it was not working is stronger than the missing sources. **None of the
day's real defects came from the scan.** The hardcoded recipients came from reading a
route while chasing something else; the frozen inbox, the reply filed as spam, the Sunday
reminder and the 12x MRR all came from the operator asking a question. The scan said zero
errors throughout.

And the database could have told it. `renewal_email_log` was empty with a subscription at
T-4; `attendance_reminder_log` held 7 rows for a Sunday. Both were one query away the whole
time.

**The rules:**
- **A checker must refuse to say "healthy" when a source is unreadable.** `checkHealth`
  returns `unknown`, never `ok`, whenever `sourcesUnavailable` is non-empty. "Nobody knows"
  and "nothing is wrong" are different answers and only one of them is honest.
- **Prefer the signal that cannot expire.** Cloud Run logs need a token that dies quietly;
  the tables are reachable with the same credentials as everything else. Build the check on
  the durable source and treat the rich one as a bonus.
- **Absence of evidence needs BOTH halves before it means anything.** "No renewal emails
  ever" is a young workspace or a dead cron, and only "and something is due" separates
  them. An alarm on the first half alone gets muted, and a muted alarm is not an alarm.
- **Keep the check for a bug after fixing it.** The Sunday-reminder check stays, because
  "the fix is not live" and "the fix is wrong" look identical from outside — a deploy that
  never landed presents exactly as a broken guard.
- **When somebody asks whether your automation works, measure it rather than describing
  it.** I could have listed what the loop does. What was worth having was the count of what
  it had actually caught: none of it.

## L39. My own monitoring cried wolf on its second query. Absence of evidence needed THREE halves
*23 Aug 2026, an hour after writing L38.*

L38's health check raised an ALARM: "renewal_email_log is empty and 1 subscription inside
the reminder window has never been reminded — the renewals cron has not done its job."

Then gcloud auth came back and the cron was measured directly:

```
Cloud Scheduler   resellersos-renewals   0 9 * * *   ENABLED   ran 03:30 UTC today
Cloud Run         /api/cron/renewals     200         1.475s
```

Working. The subscription it counted was created **22 Aug** for a **27 Aug** renewal — five
days apart — and the ladder opens at **T-15**, which for that row was 12 Aug, before it
existed. Today is T-4, and T-4 is not a step at all: the cadence is T-30/15/12/9/6/3/0. The
cron had nothing to send and correctly sent nothing.

Zero subscriptions in the whole database have ever existed at their own T-15. `renewal_email_log`
being empty is the correct, quiet answer for a workspace this young.

**The rules:**
- **"Inside the window and never reminded" is not a missed reminder.** It needs three
  conditions: never reminded, a step has passed, AND the row existed when it passed. I wrote
  L38 saying absence of evidence needs both halves and then shipped a check with two of
  three.
- **A monitor is code and gets the same suspicion as code.** I verified this one against
  hand-written inputs and shipped it without ever asking what its own query would return on
  real data. Run a new check against production numbers and read every finding before
  believing any of them.
- **Delete the comment that records the wrong diagnosis.** A test here carried "together
  they say the job is not running" as settled fact. Left alone it would teach the next reader
  the mistake — the same reason the record_payment migration was deleted rather than kept
  "for reference".
- **A false alarm on day one is how a check gets muted by day ten.** Two wolf-cries in one
  session (this, and the record_payment misdiagnosis) both came from reasoning that was
  internally consistent and never checked against the live rows.

## L40. Half a monitoring setup reports nothing and looks configured
*23 Aug 2026, wiring the Sentry DSN for the first time.*

Asked to set `SENTRY_DSN`. Before setting anything, three measurements:

```
Cloud Run env      no SENTRY var at all
.env.example       NEXT_PUBLIC_SENTRY_DSN only — the server one was NEVER LISTED
lib/sentry.ts      reads process.env.SENTRY_DSN, and is the only Sentry.init() anywhere
```

So the variable the code actually needs had never appeared in the file people copy when
setting the app up. That is why it was never set, and it is a documentation bug wearing a
monitoring bug's clothes.

The second half is worse. `app/global-error.tsx` and `app/(app)/error.tsx` both call
`Sentry.captureException` **from the client**, and no client init existed — `SENTRY_DSN` is
not exposed to the browser, and nothing read `NEXT_PUBLIC_SENTRY_DSN`. So those calls minted
event ids locally and dropped them, while the boundaries' own comments said they "report to
Sentry". Every crash an operator or a customer actually saw went nowhere. This is exactly
the failure CLAUDE.md §22 documents for the server, repeating one level down, in the file
that documents it.

**The rules:**
- **Two runtimes need two inits, and the prefix is the difference.** `SENTRY_DSN` server,
  `NEXT_PUBLIC_SENTRY_DSN` browser, same value. Setting one leaves half the app silent, and
  which half depends on which you set — nothing on screen tells you which.
- **A comment claiming "reports to Sentry" is not evidence that it does.** Both boundaries
  said so and neither could. Trace the init before trusting a capture call.
- **`.env.example` is part of the feature.** A variable the code requires and the example
  omits will not be set, and the resulting silence looks like "no errors".
- **A browser event carries whatever was on screen.** These screens carry customer names,
  emails and amounts, so the client init keeps `sendDefaultPii` off and scrubs
  email-shaped strings from messages, exception values and breadcrumbs. A monitoring tool
  is not a place to accumulate a copy of the customer list.
- **What could not be done, and why:** creating the Sentry account and project is signup
  plus credentials, which is the operator's to do. Everything downstream of the DSN is
  ready, so the value is the only missing input.

## L41. A doc claiming something is protected is not a gate. /dev was public for months
*23 Aug 2026, while adding a browser Sentry test page.*

CLAUDE.md §7 had said since May: dev pages are "NOT included in production builds
(middleware redirect if NODE_ENV=production)". Grepping `middleware.ts` for `/dev`
returned nothing. Measured against the live service, no session:

```
GET /dev            404      (no page at the root — which is why nobody noticed)
GET /dev/pdf-test   200
```

`/dev/pdf-test` renders a sample tax invoice from hardcoded fixtures — including the
fabricated GSTIN `27AABCE9876D1Z3` that `lib/invoices/supplier-identity.ts` exists
specifically to keep off real documents — served publicly under the company's own domain.

It surfaced only because the next thing I was about to do was add a page that deliberately
crashes the browser. In a public directory that is a crash-on-demand endpoint for anybody
who finds it.

**The rules:**
- **Test the claim, not the sentence.** "Middleware redirect if NODE_ENV=production" is
  specific enough to grep in five seconds and was never grepped. §25's "docs are hypotheses"
  applies hardest to the ones that describe a protection.
- **A 404 at the parent hides an open subtree.** `/dev` returning 404 reads as "gated" and
  means only "no page at that exact path". Probe a real child.
- **Gate the subtree and fail closed.** `pathname === "/dev" || startsWith("/dev/")`, and
  `ALLOW_DEV_PAGES !== "1"` rather than a truthy check, so an empty or misspelled value keeps
  it shut. The whole point is that it was open by accident.
- **404, not a redirect to login.** A redirect confirms the path exists and is merely
  protected. This is not an authorisation question — a dev page should not exist in
  production for anybody, signed in or not — so it runs before the auth work.
- **Adding to a directory means inheriting its exposure.** The reason to check was not
  diligence about old code; it was that my new page would have been the worst thing in there.

## L42. NEXT_PUBLIC_ is inlined at BUILD time. A runtime env var never reaches the browser
*23 Aug 2026. The browser test page found this on its first run, which is the only reason I know.*

I set the Sentry DSN as two Cloud Run variables, confirmed both were present on the
service, proved the server half end-to-end (`clientReady=true`, `flushed=true`, a real
event id), and called it done. Then the operator opened the new browser test page:

```
dsnPresent   false
clientReady  false
flushed      false
eventId      f489b180579d4c4ca9b01bfb50aa7616   <- minted, and went nowhere
```

`NEXT_PUBLIC_*` is substituted into the JS bundle by Next.js at **build** time. Cloud Run
env vars are **runtime**. The image had been built before the variable existed, so the
browser bundle contained nothing — and `.env.local` had no such line either, so localhost
was equally blind. Setting it "correctly" on the service could never have worked, in either
place.

**The rules:**
- **A `NEXT_PUBLIC_` variable is a build input, not configuration.** Changing it needs a
  rebuild. If the value lives in the deployment (Cloud Run, a secret manager, anything set
  after `next build`), the browser cannot see it — no matter how right the variable name is.
- **Prefer handing it down from a Server Component.** The root layout reads
  `process.env.SENTRY_DSN` at request time and passes it as a prop. One variable instead of
  two, no rebuild when it changes, and no way for the build and the runtime to disagree
  about whether monitoring is on.
- **Check which layout you are in.** `(app)/layout.tsx` is `"use client"` and cannot read
  server env at all — the first attempt mounted there and would have silently kept failing.
  The root layout is a Server Component, and a crash in `(public)/` or `(auth)/` deserves
  reporting just as much as one behind the login.
- **Ask the SDK, never `process.env`, when testing whether a client is configured.** The
  probe originally read `process.env.NEXT_PUBLIC_SENTRY_DSN` — the very thing that was
  wrong. `Sentry.getClient()?.getOptions().dsn` answers the question that matters: did the
  client end up with a DSN.
- **The whole reason this was caught is that the page reports `flushed`.** Without it the
  crash test would have shown the boundary screen, nothing would have arrived, and both look
  identical. Build the verification before believing the configuration.

## L43. "On the server" is not "while serving". A Server Component under a static page reads env at BUILD time
*23 Aug 2026, the second build-time trap in a row, on the same value.*

L42 fixed a `NEXT_PUBLIC_SENTRY_DSN` read in a client module by moving it to the ROOT
layout — a Server Component — and passing it down as a prop. That sounded like the fix. It
produced the identical symptom:

```
DSN on the Cloud Run service      present (verified)
DSN in the served HTML            absent
```

The pages under that layout are **statically prerendered** — `○` in the build output, which
I had read aloud two hours earlier without connecting it. So the layout's
`process.env.SENTRY_DSN` ran during `next build`, when the variable did not exist, and
`null` was baked into the static HTML. Same class of bug, one level up, and it looked more
correct than the first version.

The fix is a `force-dynamic` route handler that the client fetches. That is the only thing
in this app that reliably runs per request.

**The rules:**
- **Three places can read env, and only one is runtime.** A client module (build), a Server
  Component under a static route (build), a `force-dynamic` route handler (request). Ask
  which one you are in before reading anything that is set after `next build`.
- **`○` vs `ƒ` in the build output is the answer, and it is printed every time.** `○ /dev/…`
  is prerendered; `ƒ /api/…` is dynamic. I had that output on screen and did not use it.
- **`force-dynamic` on such a route is load-bearing, not decoration.** Without it a
  prerender pass folds the value into the build and the bug returns, silently.
- **Two failures with the identical symptom mean the model of the system is wrong, not the
  code.** Both attempts were internally sound. What was wrong was believing "Server
  Component" implies "per request". A third guess would have been cheaper to skip than the
  two rebuilds it cost to learn that.
- **This is the fourth time today** that reasoning which was internally consistent lost to
  a measurement (`record_payment`, the renewals alarm, L42, this). The pattern is always the
  same: a conclusion that explains the evidence, shipped without asking what the live system
  would actually return.

**L44 — Two "primary" buttons in one view is a bug, not a redundancy.** The lead drawer
had a full-strength stage-aware CTA at the top (`nextAction`) and a *second* full-strength
stage-aware CTA in the footer, built from separate logic. On a new lead with a phone they
said different things — "Call now · first contact" and "Send Quote" — and both looked like
THE answer. Nobody wrote that on purpose: each was correct when added, and the second
inherited the first's job without the first losing it. **When adding a primary action, grep
for the primary that already exists.** Two decision-makers do not average out; they cancel.
Fixed by deleting the footer's copy and keeping only the actions the survivor genuinely does
not cover — which had to be enumerated case by case, because "delete the duplicate" would
have quietly dropped "Open accepted quote" and "Revise & resend".

**L45 — A container's gate silently gates everything inside it.** The same drawer's
next-step CTA lived inside a card wrapped in `lead.contact_phone || lead.contact_email ||
lead.gstin`. That gate was right for the card's *contact details* and wrong for the CTA that
happened to sit at the bottom of it, so a lead with no phone, no email and no GSTIN got no
next-step suggestion at all — the lead that most needs one, since there is nobody to call.
**When moving a block out of a conditional, check what the conditional was actually for.**
Found only by asking why the block was nested there, never by reading the block itself.

**L46 — A comment that explains a deletion breaks the test that asserts the deletion.**
Three of the new drawer tests failed on their first run, all green in the code and red on
the prose: `expect(page).not.toContain("Generate quote")` matched the comment saying
*Generate quote → deleted*, and the footer's "no `variant="primary"`" scan matched the
comment that says `variant="primary"` while explaining its removal. The fix is a
comment-stripped copy of the source to assert code against, keeping the raw text for
asserting the prose — `sentry-client.test.ts` already had this and said why: a blunt scan
"would push the reasoning out of the file to satisfy the test". **Absence assertions on
source text need the comments stripped first**, or the test quietly punishes documentation.

**L47 — The loudest element on a screen is the one to check for lies.** A lead drawer's
biggest, most saturated button read "Call now · first contact" on a lead with 15 emails in
its thread — 7 in, 8 out, all visible three inches below it. The rule behind it read
`lead.stage` and nothing else, and the stage was still "new" because stages are moved by
hand and nobody had. **A stage column is not evidence about whether anyone has spoken to a
lead**; the conversation is. Nothing was broken in the usual sense — no error, no failing
test, no wrong number — and it had presumably been telling operators to introduce
themselves to people they were mid-correspondence with for as long as the rule existed.
When auditing a screen, read the biggest thing on it against the data next to it.

**L48 — "It would appear in three places" can be backwards.** I rejected promoting the
email thread to its own tab on the grounds that the same conversation would then live in
three places, and kept it as a segmented control inside another tab. The screenshot showed
the control did not save a label, it ADDED one: above the first message the reader met
"Conversation (16)", then "Everything | Email (15)", then "EMAIL CONVERSATION · 7 in · 8
out" — three headings and two unequal numbers with nothing saying the 15 sat inside the 16.
Promoting it deleted the control, one heading and the mismatch together. **Count the labels
a nesting costs before assuming nesting is cheaper than a peer.**

**L49 — Do not splice JSX with printf.** Rebuilding a tab structure by cutting the file into
ranges and reassembling with `printf` put a literal backslash into the source (`\&\&`
survives shell escaping as two characters) and produced 20 cascading TS17008 errors that
read like a JSX nesting bug rather than a bad byte. `git checkout` the file and redo it with
the Edit tool: anchored string replacement cannot silently shift a range or mangle an
escape, and the failure it gives is local instead of a wall.

**L50 — A drawer fed a state snapshot will disagree with the list behind it.** `/leads` kept
the open lead as `useState<Lead | null>` — the row OBJECT captured at click time. Every
mutation invalidated `["leads"]` and the board updated correctly, so nothing looked broken
until the drawer's own button moved a stage: the card slid from New to Contacted three
inches away while the drawer still said "Stage: New" and still offered the nudge that had
just worked. Pardeep caught it in one tap. **Store WHICH record is open, derive WHAT it says
from the query** (`leads?.find(l => l.id === selected.id) ?? selected`). The in-drawer stage
dropdown had carried the same staleness for as long as it existed and nobody had seen it —
it sits next to a label it also failed to refresh, so the two agreed with each other while
both were wrong.

**L51 — `.reverse()` mutates, and something downstream is reading the last element.** Showing
the email thread newest-first looked like a one-word change. But `summariseThread` takes
`latest` from `thread[thread.length - 1]`, and `latest` drives the "they are waiting" CTA and
the reply pills' staleness check — so reversing in place would have made "latest" the OLDEST
message and had the drafter answer the first enquiry instead of the newest. Reverse a COPY at
render (`[...thread].reverse()`) and leave the canonical order alone; the test asserts the
input array is unchanged, not just that the output looks right.

**L52 — A safe change can make a neighbouring flaw expensive.** Quoted reply history
("> Hi test, …") sat harmlessly at the BOTTOM of an oldest-first thread for weeks. Flipping
to newest-first made it the reader's first screenful — text repeated three inches below.
Nothing about the quoting changed; its position did. **After reordering a list, re-read the
top of it as a first-time reader** — the item that moved into first place is now carrying
weight it never had. Fixed with the existing `stripQuoted`, with a fallback to the raw body
because that helper fails toward EMPTY by design (right for an AI prompt, wrong for a bubble
that would read as a lost message).

**L53 — Identify what is on screen before filing a bug about it.** I reported "the sidebar
avatar overlaps the mobile bottom bar", spun off a task to fix `Sidebar.tsx`, and was wrong:
the round colour emblem at bottom-left is the **TanStack Query devtools toggle**, whose
default artwork reads as a profile photo at a glance. `Sidebar` is correctly gated
`hidden md:flex` and was never rendered at that width — one grep for the component would
have said so before the task was written. **A visual guess about which component drew a
pixel is a hypothesis; `grep` is the check.** Same discipline as CLAUDE.md §25.1 for docs,
applied to screenshots.

The real fix was still worth making. It never reaches a customer (NODE_ENV-gated, verified
absent from `.next/static`), but it covered a live control at every width — MobileBottomNav
and the lead drawer's 44px Call button below `md`, the sidebar's user-chip
`DropdownMenuTrigger` above it. **A debug affordance does not get to outrank an app
control**, and covering the exact button you are trying to click is how a dev-only overlay
turns into a wrong bug report.

**L54 — The AI extraction and the regex extraction were on different code paths, and only
one of them read seats.** `inbound-email`'s CREATE branch builds its lead from `ExtractedLead`
— the Gemini result — whose schema has no `seats` field at all. `extractEntities`, the
deterministic reader that DOES find seat counts, ran only on the APPEND branch, for the
Phase 1 correction write-back. So every lead ever created from an email was saved without a
seat count, however plainly the mail stated one, and the "why doesn't a quote come back"
question had nothing to do with the wording. **When two extractors exist, check which paths
each one is actually wired to** — the one with the better name is not necessarily the one
running.

**L55 — Widening a regex lets an EARLIER wrong match win.** Making the seat-count pattern
tolerate words between the number and the unit ("50 Google Workspace Business Starter users")
looked like a one-line change. `exec` returns the FIRST match, so the wider pattern turned
"12 months for 30 users" from 30 into 12, and read 365 out of "Microsoft 365 Business Premium
licenses". Fix: run the strict pattern first and the tolerant one only when strict found
NOTHING — then the change can only turn a null into an answer, never alter an answer, which
is a property of the structure rather than of the test suite. Second lesson from the same
hour: **ask what stands BEFORE the number, not after it.** A quantity is introduced
("for 50", "need 50"); a number buried mid-phrase is part of a name, a price or a date. That
one requirement disposed of "₹270 per user" and "15 percent discount for users" structurally,
where a blocklist of words would have been a permanent game of catch-up.

**L56 — "Microsoft 365 accounts" was already reading as 365 seats, and had been for months.**
Found by a test written for something else, then confirmed pre-existing by stashing the new
file and re-running. "accounts", "licenses" and "mailboxes" are all seat units, so any
product name ending in a number sits one space from one. The catalogue is the authority for
what is a name — the same list `findProduct` matches, longest-first — so a number falling
inside a matched product span is not a count. Worth more than the feature it was found by: a
365-seat quote off a sentence that was not an order is a five-figure document.

**L57 — Do not let the app send a price it inferred.** An email that says "50 Business
Starter" does not say monthly or annual, and the two differ by 12×. A DRAFT may assume — a
human opens it and the term is the first thing on the line — but an unattended send may not.
So the term is now extracted as its own field that is **null unless the sender said it**
(both terms in one mail also yields null: "monthly and yearly?" is a comparison, not a
choice), and `termAssumed` on the plan is the gate an auto-send has to read. Build the switch
before building the thing that needs switching off.

**L58 — "Reuse the existing sender" is the right instinct and can still be the wrong call.**
The obvious way to email an auto-drafted quote was to refactor `POST /api/quotes/[id]/send`
so both paths share it. Checked first: that route is 265 lines, touches money, and **has no
tests** — `send-consequences.test.ts` covers a pure helper beside it, nothing covers the
route. Extracting a send stack out of an untested money path is how a working feature breaks
quietly, so the auto-send got its own narrower sender instead, with the narrowing LISTED in
the header (no cc, no UPI QR, tenant-default GST head) rather than left to be discovered.
Two facts made the duplication small enough to accept: an auto-drafted quote has no customer
record, so the GST place-of-supply comparison the operator route does is a no-op there
anyway, and the arithmetic reads the STORED `quote.amount` rather than recomputing it.
**Before extracting shared code from a money path, look for its tests. If there are none,
the refactor is the risky option and the duplicate is the careful one** — and say so in
writing, or the next reader will "clean it up".

**L59 — Do not render a PDF inside a webhook the provider is waiting on.** The auto-send is
fire-and-forget (`void … .catch`), because a send failure must not turn a captured enquiry
into a 500: the provider would retry the whole message, the `inbound_emails` idempotency
claim would then skip it as a duplicate, and the mail would be lost to protect an email.
The lead, the message and the draft are all committed before the send is attempted.

**L60 — When a guard blocks the owner too, add a way to STATE intent, not a way to turn the
guard off.** `senderIsOurs` stops our own addresses becoming leads, and it exists because a
forwarded copy of our own mail did exactly that. It also blocked Pardeep from testing the
enquiry→quote→email path from the address he actually uses. The tempting fixes were both
wrong: an env flag (`ALLOW_SELF_ENQUIRY=1`) turns the guard off for every message and
reinstates the original bug, and a domain exemption is worse. What separates the two cases
is not the sender, it is **intent** — the accidents are a forward and an echo, which nobody
meant to send; a self-test is deliberate. Intent is invisible in an address, so it has to be
declared: a subject that STARTS with `[selftest]`, and only from one of our own addresses.
`startsWith` and not `includes`, because "Re:"/"Fwd:" prefixes are precisely the trail an
accidental resend leaves.

Two things that made it safe rather than merely clever: the marker buys passage through the
own-address rule and **nothing else** (a marked mail with no term stated still will not
auto-send, and one the classifier rejects is still rejected), and the loop is closed by
construction — the quote mail this feature exists to test is subjected "Your quote Q-… —
<tenant>", which cannot begin with the marker. There is a test asserting that exact subject.

**L61 — A test that writes to production has a cost; put it on the record, in the record.**
A self-test produces a real lead and, if the mail is complete, a real quote — which takes an
irreversible number from the gapless CGST Rule 46 series. The lead is marked
`source = "email-selftest"` so it is findable by a QUERY rather than by reading prose, and
its notes open with a banner saying the lead is safe to delete **and that deleting it does
not give the document number back**. Nothing currently excludes that source from pipeline or
forecast reporting, which is worth writing down rather than assuming.

**L62 — The app could not be told to stop.** Asked whether an AI sales agent was possible;
the audit found something more urgent than the answer. Five crons — invoice dunning,
renewals, trial expiry, compliance reminders, birthday greetings — emailed customers
unattended, and **the only way to stop any of them was disabling a Cloud Scheduler job in a
Google console.** Grepped for `ai_enabled`, `emails_paused`, `sending_paused`,
`DISABLE_EMAIL`: nothing. Meanwhile all 13 AI routes only draft and none send, so the risk
had never come from the AI. **Before automating anything further, check whether the
automation already running can be stopped from inside the product.**

**L63 — Introducing a brake must not itself change what the car is doing.** The obvious dial
design — default every action to "hold" and let config opt in — would have silently stopped
five working crons the moment it was wired, because no tenant has any config. Dunning would
have quietly stopped chasing money. So each action DECLARES the mode that is live today and
that declaration is the fallback; turning something off became a separate, visible decision.
A new action's author writes its own default, which puts the right question in front of them:
is this safe to do while nobody is looking?

**L64 — A kill switch stops what the app sends OUT, never what it says TO YOU.** Owner alerts
in the crons are deliberately ungated, and `compliance.send` was declared in the registry and
then removed once it turned out to be an internal "your GSTR-1 is due" reminder rather than a
customer send — a switch that muted the filing alarm would turn one bad afternoon into a late
fee. And a registry entry nobody enforces is worse than no entry: it reads as a control the
operator does not actually have. There is a scan test asserting every remaining declared
action is really passed at a call site.

**L65 — Gate at the chokepoint, not at the call sites.** The `automated` flag lives on
`sendEmail`, the one function all five crons already go through, for the same reason the
`email_log` write lives there: a guard that can be skipped by forgetting an argument is not a
guard. It is opt-in rather than default because a person pressing Send is not automation and
must not be blocked by the switch they flipped in order to take over by hand. That opt-in has
a real cost — a new automated caller that forgets the flag is ungated — so it is paid for by
a source scan that fails when a declared action has no call site. Red-checked by deleting one
cron's flag and watching two assertions fail.

**L66 — Fail closed on "am I switched off?", open on "how am I configured?"** Two reads in the
same function go opposite ways. An unreadable kill switch resolves to ON: a missing answer
must not be read as "carry on", because the moment somebody needs that switch is exactly when
a database blip is least acceptable as a yes. An unreadable per-action dial resolves to
NOT-CONFIGURED: an empty dial is the normal state, so a read failure there is
indistinguishable from it and must behave the same rather than stopping five working crons.

**L67 — Click the switch. The kill switch was wired backwards and every test passed.** The
Automation page shipped with `killSwitch: on` where `on` is what the UI switch reports —
"automation is on" — so the column that stores `ai_kill_switch` got the OPPOSITE value, and
the confirmation dialog fired on the wrong direction too. Turning automation off popped
"Turn automation back on?" and would have written `killSwitch: false`, leaving every cron
running while the operator believed they had stopped it. 3938 tests were green; the dial,
the resolver and the log were all individually correct. **A UI boolean and a stored boolean
that mean opposite things need a named function and a test, not a `!` at the call site** —
`killSwitchFor()` and `needsConfirmation()` exist for exactly that, and the test asserts the
round trip through the real resolver so the mapping and the rule cannot each be right about
a different convention. Found in the first ten seconds of using the page.

**L68 — Register the page in the same commit that creates it.** `npm run test` failed on two
route-map assertions the moment the Automation page existed without an `APP_ROUTES` entry and
a `SCREEN_TITLES` breadcrumb. That guard exists because Marketing, Backup and /team were each
found later as pages the app could render and nobody could click. It caught me the same day I
wrote a comment about it. A brake nobody can find is not a brake.

**L69 — Put production back the way you found it.** Testing the switch meant setting
`ai_kill_switch = true` on the live ANUTECH tenant, which really did stop dunning, renewals,
trial reminders, greetings and auto-quotes. Verified it off, verified the log row, then turned
it back on and verified `false` again in a separate query. A verification that leaves the
system in the state it was testing is not a verification, it is an outage with good notes.

**L70 — Automate on a FACT, never on a confidence score.** Step 2 lets the app answer a
customer by itself, and the gate is not "the model seems sure" — it is "this text contains no
figure, no date, no discount word and no guarantee". Same shape as the auto-quote gate that
works ("the customer stated the term"). A price, a deadline, a discount or a guarantee is a
sentence a customer can hold us to; everything else — an acknowledgement, a question, "which
plan did you have in mind" — promises nothing and is most of what a first reply should say.

**L71 — `\bfree\b` would have held every safe reply.** "Feel free to call me" is the commonest
sentence in this business, so the discount rule excludes that idiom by phrase rather than
dropping the word — "first month free" still has to hold. Two more of the same kind found by
its own tests: `%` is a non-word character, so a trailing `\b` after it made "GST at 18%
applies" pass, and `\boff\b` needs the boundary or every reply mentioning an *office* holds.
**A safety rule that fires on everything is indistinguishable from an unbuilt one** — it looks
done and never lets anything through.

**L72 — Name the automation rate you are trading away, and make it measurable.** The promise
check is deliberately blunt: any time word holds the reply, including "thanks for writing
today". Trying to tell a commitment from a pleasantry is the widening trap the seat-count
regex fell into, and there the cost was a missing number while here it would be a promise
nobody checked. So the cost is stated in the file rather than discovered later — and every
hold is logged with the matched phrase, so the first question to ask `ai_action_log` in a week
is which rule fires most and whether its matches are real. Tighten from data.

**L73 — Shadow mode has to SHOW something.** `reply.send` ships as `hold`, not `auto`: the
drafter runs, seven conditions are checked, and nothing is sent. That is only useful if the
operator can see what WOULD have gone — a held reply that logged "held" and nothing else would
tell them it happened and never what it said. So the draft is written onto the lead's
timeline, where they already look, and the decision goes to the audit log. Content on the
timeline, decisions in the log: `buildAiActionRecord` redacts message bodies by key name
exactly so the audit table does not become the second place customer mail accumulates.

**L74 — "off" as a default can be a description, and descriptions expire.** `reply.send` was
declared `off` yesterday because nothing could send a reply — a fact, not a policy. Once the
code existed that default was a lie, so it moved to `hold` in the same commit. The chokepoint
scan skips actions declared `off` on the grounds that they are unbuilt; leaving the old value
would have kept it skipped and left the new send path unasserted. **When a default encodes
"not built yet", changing the code has to change the default.**

**L75 — A green suite can be entirely about decisions and blind to wiring.** The auto-quote
never ran on the webhook's APPEND branch. Found only by sending a real self-test mail: it
appended (correctly), the extractor rewrote the lead — seats 20 → 50, plan Standard →
Starter — and nothing priced it. `planQuoteFromEnquiry` had 17 assertions,
`decideAutoSend` 17, the extractor 83, and **not one of them looks at where the functions are
called**. The auto-reply had been wired to both branches in the same sitting and the
auto-quote to one. Fixed with a source scan (`auto-quote-wiring.test.ts`) that counts call
sites per branch, red-checked by deleting one. **When a feature has to run in more than one
place, assert the call sites, not only the logic** — and prefer moving the block into a shared
function so there is one thing to call rather than two to remember.

**L76 — The append branch is the more valuable one, and it was the one left out.** A reply
from somebody already in conversation, naming a seat count and a plan, is the most
quote-worthy mail this app receives; a first enquiry is usually vaguer. The instinct to build
the "new lead" path first is right for leads and wrong for quotes.

**L77 — On a re-quote, the expensive answer is "no".** Every quote takes an irreversible
number from the gapless CGST Rule 46 series, so "draft one whenever a reply mentions seats"
would mint a document per message in a long thread — five mails about the same fifty seats,
five documents. `shouldRequoteOnReply` compares the reply's facts against the LATEST quote and
declines when nothing moved. It re-quotes for a SENT quote too: a customer sent 20 seats who
now says 50 needs a revised document, not a note on a lead.

**L78 — My test was wrong about `samePlan`, and the function was right.** I asserted that
"google-workspace-starter" matches "Google Workspace Business Starter". It does not:
`samePlan` is containment, and the dropped word sits in the MIDDLE. The first version of the
new file had its own copy of that normalisation — the exact drift this repo keeps recording —
so it now imports the real one and the test asserts the real limitation, with the cost stated
(one extra quote on a lead still carrying a buy-page slug, which then settles). Widening it to
token-subset matching would be better and is a SEPARATE change: `samePlan`'s own comment warns
that "Business Starter" and "Business Standard" must never collapse, and that warning is
load-bearing.

**L79 — Two faults were wearing one error message.** AI drafting was dead with a 403
("Your project has been denied access"). A new key fixed the 403 and revealed a **404**
underneath: `gemini-2.5-flash` is "no longer available to new users". Fixing either alone
looked like no progress. **When an error clears and a different one appears, that is the
diagnosis working, not a new bug** — and the corollary is that a single failing call can hide
an arbitrary number of faults behind whichever one is checked first.

Also worth the two curls: an INVALID key returns `400 INVALID_ARGUMENT / "API key not valid"`
while a blocked project returns `403 PERMISSION_DENIED`. Comparing those two responses proved
the key was recognised and the project was refused — which is what ruled out "paste a
different key from the same account" before anyone spent an afternoon on it.

**L80 — `ListModels` is not a source of truth, in EITHER direction.** Same key, same minute:
it reported `gemini-2.5-flash` as supporting generateContent (calling it 404s) and omitted
`gemini-3.6-flash` (calling it 200s). A comment in `lib/ai/gemini.ts` already half-knew this
and still pinned a version. **Only an actual generateContent call tells you what works**, so
the model dropdown now lists exactly the four that were called and answered 200 —
`gemini-pro-latest` is absent because it answered 429, which is a quota problem and does not
belong in a list of safe choices.

**L81 — Prefer a rolling model alias, and say what it costs.** `gemini-flash-latest` replaces
a pinned version, because the pin is what aged into an outage — silently, with nothing
breaking until a key was rotated. The cost is that the model can change without a deploy and
the prose may shift. Acceptable here specifically because nothing downstream trusts the model
with money or facts: `verifyDraftMoney` allows only figures already on the deal,
`findPromises` refuses any price/date/discount/guarantee before an unattended send, and
`responseMimeType: application/json` pins the response contract rather than the model. A model
swap can change how a reply reads; it cannot make it promise something.

**L82 — A stored config value beats the code default, so fixing the code fixes nothing.**
`resolveGeminiConfig` lets `tenant_secrets.gemini_model` override `DEFAULT_MODEL`. The tenant
row held the retired `gemini-2.5-flash`, so correcting the constant would have left the 404
exactly where it was. **When a default is wrong, check whether any row is overriding it** —
and update both in the same breath.

**L83 — The self-test marker held up under a real attempt, and the right fix was a log line.**
Pardeep FORWARDED a marked test rather than composing one, so the subject arrived as
"Fwd: [selftest] …" and `isSelfTest` refused it — `startsWith`, not `includes`. The tempting
relaxation (strip Re:/Fwd: first, or match anywhere) would open a LOOP, not a convenience: the
auto-reply's subject is written by Gemini from a thread already subjected "[selftest] …", so a
plausible generation is "Re: [selftest] …", and our own outbound reply returning through
ingest would then read as a deliberate test, make a lead, and be answered again. **Do not
relax a safety rule to make testing easier.**

What WAS wrong was the diagnosis: the log said only "sent from one of our own addresses",
which is true and says nothing about a marker having been typed. Tracing it cost a five-minute
poll and a round trip. Now `selfTestMarkerMisplaced` names the deliberate-but-malformed middle
case in a warning that changes no decision. **When a guard refuses something a human meant,
the guard is often right and the MESSAGE is the bug.**

**L84 — supabase-js does not throw, so an unchecked write reports success.** The live run on
23 Aug 2026 produced four records telling three different stories: `email_log` said the quote
was sent (provider gmail), `quote_send_log` was EMPTY, `quotes.status` was still `draft`, and
the lead's timeline said "emailed automatically … (PDF attached)". Both middle writes were
`await admin.from(...).insert/update(...)` with the returned `{ error }` never read — so the
function sailed past both failures and wrote a success line. The file's own header had
promised "quote_send_log gets a row whatever happens".

The damage is not cosmetic: the customer holds a quote the pipeline calls a draft, so the next
person to look sends it a second time. **Read the error on every write, or the write is a
wish.** And the subtle half — **an update matching NO ROWS is a success in supabase-js**, so
`.select("id")` and a length check are the only way to tell "worked" from "matched nothing".

Both statements succeeded when run by hand inside a rollback, which means the cause is at the
client and not a constraint. That is exactly why the fix is to REPORT rather than to keep
diagnosing: an unchecked write hides its own reason, and the next run will name it.

**L85 — Guard the discarded return value, not just the decision.** Three bugs today were
invisible to a 4,000-assertion suite because all three were about plumbing: a function called
on one branch instead of two (L75), a UI boolean inverted at a call site (L67), and now a
return value dropped. Each was caught by a SOURCE SCAN, and each scan was red-checked by
reintroducing the bug. When a suite tests decisions well, the remaining risk moves to the
wiring — so put the scans where the wiring is.

**L86 — The Gmail forwarder labels a thread whether or not the app accepted it, so a failed
POST loses the enquiry permanently.** `docs/ENQUIRY-EMAIL-SETUP.md`'s script called
`thread.addLabel('erp-sent')` straight after the POST without reading the response code, and
`-label:erp-sent` is what stops a thread being picked up again. So any non-2xx — a 401, a
500, a deploy restart — marked the thread done and that customer's mail was **gone, not
delayed**. Nothing retries it and nothing reports it. Found while planning a secret rotation,
which is precisely when it would have bitten. Fixed in the doc: label only on 2xx, which is
safe because the webhook is idempotent on `messageId`.

**L87 — Rotate a shared secret through a LIST, and deploy the reader before the value.**
`INBOUND_EMAIL_SECRET` now accepts "old,new" so both are valid during a changeover — needed
because a rotation window on this endpoint drops mail rather than failing requests (L86).
The ordering is the part that is easy to get backwards and expensive: **deploy the code that
understands a list FIRST**, then set "old,new", then update the forwarder, then narrow to
"new". Setting the list against the old single-value comparison makes every request 401 —
which is the exact outage the list exists to prevent.

**L88 — There was no retry at all, so one transient 503 lost a customer's reply for good.**
Traced from the live run: `Gemini HTTP 503` — Google busy for a moment — and the drafter
reported "the AI did not return a reply", which reads like a model fault and sent me back to
the model. Three real failures were seen that day and only now are they told apart: **403
(project denied) and 404 (retired model) are permanent, 503/429 clear in a second.** Treating
them alike made a transient loss indistinguishable from a misconfiguration. Retried once, not
in a loop, because this runs inside a webhook a provider is waiting on.

**L89 — A retry is ONE attempt at one thing; count it once.** My first version recorded a
breaker failure on the way past AND on the retry, so a single logical call cost two and the
threshold of 3 tripped after one and a half — the breaker opening on transient noise, which
is the opposite of its purpose. Caught by an EXISTING test ("a success resets the failure
count") that received null where it expected a draft. **When adding a retry, check what else
counts attempts** — breakers, quotas, rate limiters and audit logs all do, and each will be
wrong by a factor of two without being told.

**L90 — `gcloud --update-env-vars` splits on commas, which collides with a comma-separated
secret list.** Setting `INBOUND_EMAIL_SECRET="old,new"` failed outright — and failing was the
good outcome, since the alternative is two env vars nobody asked for. The custom-delimiter
form works: `--update-env-vars "^@^KEY=old,new"`. Do NOT reach for `--env-vars-file`, which
REPLACES every variable on the service rather than updating one.

**L91 — `?? ""` turned a missing host into a dead link in customer email, silently.**
`NEXT_PUBLIC_APP_URL` was never set on Cloud Run, and the renewals cron called
`quoteAcceptUrl(process.env.NEXT_PUBLIC_APP_URL ?? "", …)`. With an empty base that returned
`/quote/Q-…/accept?t=…` — and **in an email a relative path is not a degraded link, it is a
dead one**: no mail client can resolve it. So renewal reminders reached customers with an
accept link that could not be clicked. The renewal is the money and the link is how it
converts. Nothing errored, nothing logged, the cron reported success.

Two halves to the fix, and the second is the durable one. The env var is now set — all uses
are in server-side route handlers, so a RUNTIME variable works and no rebuild was needed (not
the `NEXT_PUBLIC_*` build-time trap of L42/L43, which only bites client bundles). And
`quoteAcceptUrl` returns **null** for a missing base or one with no scheme, so the three call
sites stopped compiling until each decided what to do — two send the mail without a link, one
refuses to send. **A function that accepts "" and returns something plausible is what lets a
`?? ""` through; make the empty case unrepresentable.**

Also worth knowing: the fallback those routes used when the env var was absent —
`https://resellersos.web.app` — answers **503**. So both paths were broken, and the "safe
default" was as dead as the missing one.

**L92 — One sentence stood for four different faults, and cost most of a day.** Every failure
path in `geminiJson` returned bare `null`, so every caller reported "the AI did not return a
reply". On 23–24 Aug 2026 that covered: **403** (the GCP project had billing disabled), **404**
(`gemini-2.5-flash` retired for new keys), **503** (Google momentarily overloaded) and **429**
(free tier — 20 requests/day/model — exhausted). Google stated all four plainly in the response
body; we threw the body away and wrote a guess. The fixes are a billing console, a config
field, one second, and a day — and that sentence points at none of them. It sent me to the
model three times.

`onFailure` now hands the caller an actionable sentence, including Google's own `retryDelay`
when it supplies one. **A failure that reports "it didn't work" is barely better than a silent
one** — when a third party tells you why, pass it on.

**L93 — Google's own retry hint made my retry useless, and that is worth reading.** The 429
body carried `retryDelay: "16s"`; the retry waits 900ms. So the retry that fixed the 503 case
cannot fix a 429 — and for a DAILY quota no delay helps at all. The delay is now surfaced in
the message rather than obeyed blindly, because a 16-second hold inside a webhook a provider
is waiting on is the wrong trade. **Check whether the upstream told you how long to wait before
deciding your own backoff.**

**L94 — The free Gemini tier is 20 requests per day PER MODEL, which a day of testing exhausts.**
Worth knowing before diagnosing: the quota is per model, so switching models resets nothing
that matters and `gemini-flash-latest` pointing at `gemini-3.7-flash` on a given day means the
quota belongs to that resolved model. The app's own dialog already recommends the paid tier —
for privacy — and this is the second reason.

**L95 — "Connected ✓" was testing the SAVED key while a new one sat unsaved in the field.**
The Gemini dialog's Test posts an empty body and the route resolves the key through
`resolveGeminiConfig`, so it exercises what is STORED, never what is typed. On 24 Aug 2026
Pardeep pasted a new paid-tier key, pressed Test, saw green, and closed the dialog — the row
still held yesterday's free-tier key, whose daily quota had simply reset at midnight. Two
independent things looked like one success.

Proved by `updated_at`, not by argument: it still read `2026-08-23 15:49` while the clock said
24 Aug. **When a UI reports success, check WHICH object it succeeded against** — and I had this
backwards first, suspecting Test used the typed value. Reading the route settled it in one grep.

The toast now says "This tested the SAVED key, not the one you just typed. Press Save to store
it." **A success message next to an unsaved input reads as confirmation of that input**, whatever
it technically means.

**L96 — Two of today's mysteries were one cause: the project's billing was disabled.** The
403 `PERMISSION_DENIED` "your project has been denied access" on the old Gemini key, and Cloud
Run answering 503 with "billing is disabled for this project", were the same fault. I had
diagnosed the 403 as a wrong key FORMAT — claiming an `AQ.`-prefixed key was not a valid API
key — and Pardeep was right that AI Studio issues them. **A platform-level fault presents as
several unrelated application faults**, so when two subsystems fail on the same day, check the
account before the code. Restoring billing fixed both, and the old key started working again.

**L97 — The self-test escape was added to one gate and not its twin.** `isSelfTest` reached
`decideDisposition` and `decideAutoSend` (quotes) in the same sitting, and **not**
`decideAutoReply`. So a marked self-test exercised the whole chain except the single step it
existed to prove — the first successful AI draft came back `held` reading "the sender is one of
our own addresses" instead of "replies are set to hold for this workspace". Right outcome,
wrong reason, and the wrong reason is what stops somebody trusting the next result.

**When a flag has to be honoured by more than one gate, add it to all of them in one edit and
list them in the comment.** Same shape as L75 (a function wired to one webhook branch instead
of two): the logic was right everywhere and the wiring was right in two places out of three.

## L98 — A column named after an act must be written by that act

Darshan, 24 Aug 2026: "Customer ko quotation sent kar di lekin Quote sent mein show nahi kar
raha." He was right. `folders.ts` defines that column as `stage === "quote"`, and grepping the
whole codebase, **the only place that ever set it was the public buy-page checkout.** Sending a
quote from inside the app — the operator's Send button, the auto-quote from an inbound email, a
renewal — never touched the stage. The quote genuinely went out; the column named after that
exact act stayed empty.

Then the scan written to prove the fix found a **third** writer on its first run:
`quote-builder.tsx` set `stage: "quote"` inline with no Won/Lost guard, so an upsell quote to a
won customer dragged them back into the pipeline. One decision, three copies, and the newest
was the only correct one.

**When a UI element is named after an event, find every code path that performs that event and
check each one writes the field — the count is the finding, not the logic.** Three of this
week's bugs are this same shape (L75 one webhook branch of two, L97 two gates of three, this
one one send path of three). A unit test cannot see it; a source scan that counts call sites
can, which is why `quote-sent-stage-wiring.test.ts` is a scan rather than only a unit test.

**The corollary that cost a second bug in the same hour:** moving a control behind a tab can
remove the only route to an action without removing any code. Pardeep, minutes later: "new
stage me quote bhejne ka option hi nahi aata hai." A new lead with a phone got the CTA "Call
now · first contact"; the footer's quote buttons all required `hasQuotes`, which it had none
of; and the pre-quote stage rail carrying a quote button lived inside the `details` tab — the
fourth tab, not the one that opens. Each gate was individually defensible and the money step
had no door. My own comment in that footer asserted "nextAction already says send the first
quote, in the same words" — true in every branch but that one. **An in-code claim of full
coverage is worth exactly as much as the branch you did not enumerate.**

## L99 — The fix that revealed the real bug: a provider was deleting every query string

L98 above is correct as far as it goes, and it does not go far enough. Having wired the stage
rule into all four senders, I went to the browser to watch it work — and it did not. The toast
said "the lead has no stage recorded, so nothing was moved", and the database said why:
`lead_id` was **NULL** on a quote raised from a lead's own drawer.

`workspace-tabs-provider.tsx` keeps the address bar in step with the active tab by calling
`router.replace(<the tab's recorded url>)`. Two effects recorded that url as `pathname` alone.
**So every query string in the application was deleted a moment after arriving**, by a
navigation nobody asked for. `/quotes/new?leadId=L-MT6S9CNF` became `/quotes/new`, the
builder's lead mode switched off, and the quote saved attached to no lead. A third reader of
the current URL, the popstate handler twenty lines up, had `pathname + search` — right in one
place, wrong in two, the same shape as L98 itself.

Measured, not reasoned: the network log shows `GET /quotes/new?leadId=…&company=… → 200` with
no redirect, `window.location.href` reads `/quotes/new` immediately after, and two quotes on
the same lead bracket the fix — Q-ADPL-2026-27-0048 `lead_id` null, Q-ADPL-2026-27-0049
`lead_id` L-MT6S9CNF.

**Three things to take from it:**

**Reproduce in the browser before believing a diagnosis, even a well-evidenced one.** The
stage rule genuinely was missing from three of four senders; every test I wrote about it
passed and was red-checked; and it was still not the bug the user reported. Reading code finds
the bugs that are in the code. It does not find the ones caused by two correct-looking
components interacting.

**A silent `router.replace` is a data-loss bug, not a routing bug.** It presents as an empty
form — the most ignorable symptom there is. Nobody files "the form was blank" as corruption,
they just retype it, and the row goes to the database wrong.

**When a component holds a copy of browser state, count its readers.** Three effects read the
current URL here and one of them was right.

*Also found on the way, same root:* the builder resolved the lead from the URL only, so EDIT
and DUPLICATE saw no lead at all — the prospect fields loaded empty on a quote that had them,
and duplicating dropped `lead_id` even with the provider fixed. `linkedLeadId` now falls back
to the source quote. It did not delete contact details, because the writes were gated on the
same missing id that emptied the fields; two bugs from one cause cancelled each other's worst
outcome. Say that plainly rather than claiming the scarier version.

## L100 — A stage move with a silent timeline is worse than no move

Watched L98/L99's fix run on live data and it worked: Rohit Tech went from Contacted to Quote
Sent, the chips went `In Talks 5 → 4` and `Quote Sent 0 → 1`. Then I looked at the lead's
timeline and it said nothing at all.

`useUpdateLeadStage` writes the column and no activity row. The other three senders each insert
a `kind: "stage"` row, so "Mark as sent" moved a deal between columns with **no record of
why** — and that is harder to debug than the bug being fixed, because the board is right and
the history is silent. Nobody can tell whether a person moved it or the app did.

**That is the L98 shape a fourth time, and I introduced it myself hours after writing L98
down.** The lesson clearly is not "remember to check call sites" — I did remember, wrote a scan
for it, and still shipped it, because the scan asked "does this path apply the rule" and not
"does this path leave the same trace as its siblings". **When you add a scan for a rule, assert
every EFFECT the other call sites produce, not just the call.** A partially-implemented rule
passes a scan aimed at the function name.

Two details worth keeping:
- The history write is the LAST statement and its failure is swallowed. The quote is already
  sent and the stage already moved by then; throwing would report "could not mark as sent" over
  two successful writes and the operator would press it again.
- It goes through the `log_lead_activity` RPC, not a client-side insert, so `tenant_id` comes
  from the server rather than from a React component (CLAUDE.md §4).

## L101 — "Has a person touched this?" must not count the app's own footprints

Before asking Pardeep to re-run a self-test, I read the path it would take. `run-auto-reply`
asks whether a colleague has picked the thread up, and answered it by counting
`lead_activities` of kind call / whatsapp / note / email_out newer than the customer's message.
**The inbound webhook writes its own `note` a fraction of a second after filing that message**
— "No new quote from this reply — …" when the requote rule declines (route.ts:737) — or an
`email_out` row when the auto-quote does go. Both matched. Both are this app.

So the second enquiry in any thread would have held the reply saying *"a person has picked this
thread up"* when nobody had. **A wrong reason is worse than a wrong outcome**: the outcome was
right by luck, and the reason is the sentence somebody reads when deciding whether to trust the
automation. Exactly L97 again, and it was invisible because the own-address rule fires first and
always fired first on the self-tests.

`created_by` fixed it with no migration, and the discriminator was **checked against live data
before being relied on**: `call` ×5, `email` ×3 and `note` ×6 all carry a `created_by`, while
`note` ×9, `email_in` ×14, `email_out` and `quote` are all NULL. Humans go through the
`log_lead_activity` RPC, which stamps `auth.uid()`; the bare service-role client cannot know a
user, so every automated write is anonymous.

**Two things to carry forward.** When a check reads a shared table that the app itself writes
to, ask which rows are the app's before trusting the count — a service-role client leaves
fingerprints in the same place a person does. And **a test that pins the fix is not enough when
the fix depends on an invariant**: `human-touch.test.ts` also asserts that the webhook's own
inserts never set `created_by`, because the day somebody gives that client a user id, the
discriminator inverts and this returns silently.

## L102 — An audit log that records only refusals makes working automation look dead

The self-test on 24 Aug proved the chain end to end: a quote was drafted, emailed with a PDF,
and the lead moved to Quote Sent — all unattended. Then `select count(*) from ai_action_log
where outcome='did'` returned **0 across the whole table**.

`logAiAction` was called only inside the refusal branch of the send chokepoint
(`lib/email/send.ts`). Every "skipped" and "held" was recorded; nothing that actually went out
was. The reply path logged its own `did`; the chokepoint-mediated actions — quote.send,
dunning.send, followup.send — were the ones going unrecorded, and **they are the ones that
reach customers.**

Not a cosmetic gap. That table is what `/automation` renders and what somebody reads before
widening a dial. A log of nothing but refusals is indistinguishable from automation that has
never once fired — which is exactly the impression Pardeep had when he asked whether his AI
sales agent existed at all. The honest answer needed a database query, not the screen built for
it.

**When you add an audit trail, write the success path first.** Refusals are the interesting
case while you are building the brake, so they get logged first and feel like enough. They are
not: the log is read by someone deciding whether to trust the thing, and trust is built on what
it did.

Two details that came with it. `outcome` is derived from the send result rather than assumed —
a `did` row for a send the provider rejected would be the worst row this table could hold. And
the reply path sets `logsItsOwnOutcome: true` so one reply produces one row, not two; the flag
is an assertion about the caller, so `human-touch.test.ts` also checks that caller still logs,
because the day it stops, the flag turns a double row into no row at all.

---

## L103 — A guard borrowed from a stricter path fires on the RIGHT answer, and then somebody deletes it

Measured 24 Aug 2026, on the first real message the AI sales agent ever answered. It read the
enquiry correctly — confidence 0.95 — wrote a good reply, and its own guards refused to send it
**twice, for two different reasons, both wrong.**

**First:** `applyHandoverRules` handed it to a human because the draft said `"24/7"` and
`"free"`. Both are phrases `SALES_AGENT_SYSTEM_PROMPT` explicitly authorises — "24/7 support
from a named local team", "Free migration of existing mail and data". `findPromises` reads
`24/7` as a DATE (its `\d{1,2}[/-]\d{1,2}` branch — 24 July) and bare `free` as a DISCOUNT.

**Second, after that was fixed:** `decideAutoReply` held it for naming `Rs 864` — the tenant's
own catalogue price, which the agent is not merely allowed but *required* to state.

The reason both happened is one design fact: **`promise-check.ts` was written for the
acknowledgement path, where the safe reply promises NOTHING AT ALL.** It runs its money check
with an empty allow-list, on purpose, and that is correct there. Reused unchanged on a path
whose whole job is to quote a price, it refuses every correct answer.

That is the failure mode to fear, and it is not "the guard was too weak":

> **A guard that fires on the right answer gets switched off within a week** — and then it is
> not there for the wrong one.

The second one was worse than a held reply, and this is the part worth remembering. That gate
sits **upstream of the autonomy dial**: when it refuses, `run-sales-agent.ts` files the draft
and returns without ever reaching the dispatcher. So moving `reply.send` to `auto` would have
changed nothing. **The feature's main path was closed at every dial setting while looking
open**, and no test could see it because every test was about the guard working.

**What to do when you put an existing guard on a new path.** Ask the question the guard cannot:
*what is this path authorised to say, and does that authorisation reach the guard?* Then:

- **Exempt by PHRASE or by ALLOW-LIST, never by dropping the rule.** `maskAuthorisedSellingPoints`
  hides `24/7` and — only inside a sentence about migration — `free`. "The first month is free"
  and "we'll migrate by Friday" still hold, and there is a test on each side of that boundary.
- **Default to the strict behaviour.** `AutoReplyInput.promisesAlreadyChecked` defaults to
  false, so every existing caller is untouched; the one caller entitled to it is the one whose
  own guard is *stricter* (it checks money against the real catalogue).
- **Pin the entitlement on the SOURCE.** A test asserts `run-auto-reply.ts` does NOT pass that
  flag. The failure would be an absence, and an absence reads as normal in a mock.
- **Probe it end to end before believing any of it.** All three findings came from one POST to
  the live webhook from an `@example.invalid` address — not from reading code. Two of them
  contradicted what the tests said the feature did.

Same shape appeared the same day on the support side, where `free up space` — the correct answer
to a full mailbox — and a customer's own renewal date both tripped the identical rule. See
`maskSupportIdioms` and `maskAuthorisedDates` in `lib/ai/support-agent.ts`.

**And the same day it happened three more times, in code written that afternoon.** A support
agent probe found: a CONSOLE URL (`admin.google.com`) refused as if it were a DNS record — the
guard blocking the exact reply the knowledge base tells the agent to write; a ticket the agent had
correctly triaged left filed as `other/normal` because triage was only written on the send path;
and an escalation somebody closed without assigning still alerting on every sweep, because
neither the decision nor its query looked at `status`. Six findings in one afternoon, all the
same shape, none of them visible to a test — every test was about the guard working. **Probe the
path end to end before you believe any of it.**

---

## L104 — Reading a price live protects you from a stale number, not from a wrong UNIT

`lib/ai/sales-agent.ts` opens with a long, correct argument against hardcoding prices: read
`items.msrp` at call time, because a constant goes stale silently. The argument is right and it
was followed. The module still under-quoted every deal by **twelve times**, below its own cost,
for the whole of its first day.

`items.msrp` is **₹ per seat per MONTH** — AGENTS.md §1 says so, and
`lib/quotes/quote-from-enquiry.ts` has always honoured it (`rate = msrp × 12`).
`loadSalesCatalog` copied the column straight into a field named `msrpPerSeatPerYear`. The
header even quoted the live figure — "₹864 (wholesale ₹620)" — while describing it as annual.

Measured on a demo enquiry, 24 Aug 2026. One deal, three different numbers:

| Where | ₹/seat/year | 12 seats |
|---|---|---|
| What the agent's email said | 864 | 10,368 |
| What the quote it referenced BY NUMBER said | 1,500 | 21,240 |
| The truth | 10,368 | 1,24,416 |
| Our own cost | 7,440 | 89,280 |

**And `verifyDraftMoney` approved it.** Its allow-list was built from the same wrong figures, so
the money guard was checking the draft against the bug. A guard fed by the thing it is meant to
police is decoration.

**What to do.**

- **Name the unit beside every number, in the type and in the comment.** `msrp` alone is a
  trap; `msrpPerSeatPerMonth` cannot be copied into a per-year field by accident.
- **Convert through a named function, never a bare `* 12`** — `perSeatPerYear`. A named
  conversion is something a test can point at.
- **Pin the unit ACROSS the paths that share the column.** The test that matters is not
  `perSeatPerYear(864) === 10368` — that would have passed on the day the bug shipped, because
  the bug was a belief about the column, not an arithmetic slip. It is the one asserting the
  agent's figure equals `planQuoteFromEnquiry`'s annual rate for the SAME item. Two places
  computing one figure is exactly what this module's header warns about, and the warning came
  true inside the module.
- **Add the cheap sanity check anyway.** `isBelowCost` withholds a SKU whose retail is under
  its own cost, at the point of use. It would not have caught this particular bug (both figures
  were un-multiplied, so they stayed in proportion) — and it is still worth having, because
  `money-check.yml` exists for the version that is not in proportion.

The second half of the same incident is data, not code: the catalogue named one SKU
"Google Workspace **Business** Starter" and its sibling "Google Workspace Standard". Customers
write Google's real name — "Business Standard" — which matched neither, so a generic
eight-character hosting SKU called "Standard" won the match and priced the quote. **An
inconsistent catalogue name is a pricing bug with a delay on it.** See L103 for the guard half.

---

## L105 — A backup whose cost grows with the table count is a backup with an expiry date

`scripts/backup-db.mjs` failed twice in a row on 24 Aug 2026 with
`supabase db query exited 3221225794`. That is Windows 0xC0000142 — STATUS_DLL_INIT_FAILED,
what process creation returns once something is exhausted. It is on the free plan, so this
script is the **only** backup there is: no PITR, no automatic snapshots, and the in-app
`backup.snapshots` rows live inside the same database, which makes them an undo button.

The script was not broken in the way it looked. It ran `npx supabase db query` **once per
table** — 112 tables, plus seven schema reads, plus the table list: about 120 process
launches, each one a shell starting `npx` starting node starting the CLI. Nothing was wrong
with the transport: a single `db query` run by hand seconds later returned exit 0.

Two details said so before any theory did. The two runs died at DIFFERENT tables — one
reached `subscriptions`, the next stopped at `referral_*` — which is cumulative exhaustion,
not a bad row. And it only started failing after a long session that had already spawned the
CLI dozens of times for other work.

**So the fault was the SHAPE, not the tool.** A script whose cost is O(tables) works fine at
20 tables, works fine at 60, and stops working at some point nobody chose — and it stops on
the day the machine is busiest, which is the day somebody is about to apply a migration and
wants a backup first. That is the worst possible failure schedule.

Rewritten to three launches: one for the table list, one `union all` with a
`jsonb_agg(to_jsonb(x))` branch per table, one `jsonb_build_object` covering all seven schema
reads. Postgres does the fan-out. Nothing about the output changed — same shape, same file,
verified against live counts on all ten key tables.

**What to take from it.**

- **Count the process launches, not the queries.** A loop of database calls is cheap; a loop
  of `spawnSync` is not, and on Windows the ceiling is real and undocumented.
- **Push the fan-out into the database.** `union all` over generated branches, or one
  `jsonb_build_object`, replaces N round trips with one and gives better errors — Postgres
  names the offending relation, which the per-table loop only managed because it happened to
  be iterating.
- **Keyed off the SOURCE list, not the result.** The rewrite iterates `pg_tables` and throws
  if a table is missing from the response. A dump silently short a table is the exact failure
  this script's own header refuses, and the naive rewrite — iterate what came back — would
  have reintroduced it.
- **The exit code is a clue, not noise.** 3221225794 looks like line noise and means something
  specific. Anything on this machine returning it should be read as "too many processes".

---

## L106 — A price in a prompt is a second source, and a price spoken aloud cannot be corrected

Written 25 Aug 2026, building the AI telecalling agent. The brief specified the persona's
price list in the brief itself: *"Google Workspace (Starter Rs 270/mo, Standard Rs 750/mo)"*.
Both halves of that instruction were wrong, in two different ways, and the second is the one
worth remembering.

**The measurable half.** Checked against `items` for tenant `fbb976f1…` before writing a line:
Starter is `msrp = 270` — correct. Standard is **864**, not 750. Pasting 750 into the prompt
would have had an automated voice quote Rs 114 per seat per month below the real price. On a
12-seat deal that is Rs 16,416 a year given away, per call, with nobody in the room.

**The half that matters more.** Even if 750 had been right that morning, it would have been a
SECOND SOURCE for a number the catalogue already owns — and a hardcoded figure agrees with
itself forever, so no test can notice it going stale. `GW-STD-fbb` has already changed once.
This is the same defect family as 24 Aug's twelfth-of-every-price bug, where
`loadSalesCatalog` copied a monthly figure into a field named per-year and `verifyDraftMoney`
**approved** the result because its allow-list was built from the same wrong source. It is
also `quote-builder.tsx`'s hardcoded plan→price map, which disagrees with the catalogue on 8
of 8 lines and survives only because it is unreachable.

So `lib/ai/telecaller-prompt.ts` contains **no number at all**. There is a test that reads its
own source, strips comments, and fails on any 3-or-more-digit literal. Mutating a `750` back
in turns it red — checked, not assumed. The one allowance is `Microsoft 365`, named explicitly
in the test rather than handled by loosening the pattern, because an allow-list of one is
reviewable and a relaxed regex lets 750 back in.

**And then the part that is new with voice.**

Every rule this codebase has about automated messages assumes the message is TEXT. A wrong
price in an email can be followed by a correction the customer reads next to the original; a
draft exists before it is sent, so a person can read it; and `hold` means a human sees the
words first. **A phone call has none of those properties.** It interrupts, it cannot be
edited, it cannot be recalled, and the first draft anybody sees is a transcript of something
the customer has already heard and written down.

That changes what a guard can even be. `verifyCallMoney` runs on the transcript AFTER the
call, so it cannot refuse anything — its entire value is that a person finds out in seconds
instead of when the customer quotes it back. It is written down as a **detector, not a
guard**, in those words, because dressing it up as a guard would be the more comfortable lie.
It has a real blind spot too: speech-to-text renders "ten thousand three hundred and
sixty-eight rupees" as words and `verifyDraftMoney` matches digits, so a clean pass here is
weaker evidence than a clean pass on an email draft. Stated in the docstring rather than
discovered later.

**What to take from it.**

- **A number in a prompt file is a hardcoded price wearing a costume.** Read the catalogue at
  call time and pass it in. If the module has no numbers, a test can say so.
- **Build the allow-list and the prompt from the SAME array**, in one function. 24 Aug proved
  what a guard fed from a different source is worth; the inverse — a guard that flags the
  agent for saying exactly what it was told — is just as bad and looks like a bug in the agent.
- **The agent gets rates; the app computes totals.** `authorisedCallFigures` deliberately does
  not contain seats × price. A model that multiplies can multiply wrongly, and on a call it
  does so out loud.
- **When a new channel is irreversible, say so in the default.** `telecall.place` ships `hold`,
  and the reason is written in the registry next to it: not caution in general, but the
  specific fact that none of the properties the other dials rely on hold for voice. `hold` is
  built to be USEFUL — it files the number, the script and the authorised figures so the
  operator can ring by hand — precisely so nobody moves the dial merely to get value out of
  the feature.
- **Never infer intent from a transcript.** Whether the customer wanted a quotation is read
  from the vendor's structured post-call analysis, never from searching the words. *"No, please
  don't send me a quote"* contains the word. A keyword match there does not produce a slightly
  worse decision — it emails a quotation to somebody who explicitly declined one.

---

## L107 — A CHECK says "always". Most rules you write actually mean "when it is written"

Found 25 Aug 2026, by the SQL test, on its first run against production, before a single row
existed. Two constraints shipped in the same migration — one page apart — and they fight:

```sql
constraint ai_telecall_logs_has_subject
  check (lead_id is not null or subscription_id is not null)

constraint ai_telecall_logs_lead_fk
  foreign key (tenant_id, lead_id) references public.leads (tenant_id, id)
  on delete set null (lead_id)
```

Delete a lead that has been rung. Postgres runs `UPDATE ai_telecall_logs SET lead_id = NULL`.
For a call that was about a lead and not a subscription, that leaves BOTH subject columns
null, the CHECK fires, and **the DELETE is refused outright**:

```
23514: new row for relation "ai_telecall_logs" violates check constraint
       "ai_telecall_logs_has_subject"
CONTEXT: SQL statement "UPDATE ONLY ... SET lead_id = NULL"
```

Which is precisely the failure the column list on `SET NULL` exists to prevent — the same
shape, arriving through a different door, one screen below the comment explaining it. The
comment was right, the FK was right, and the row above it undid both.

**The mistake is a category error, not a typo.** The requirement was *"do not WRITE a call
that is about nothing"* — a statement about the moment of insertion. A `CHECK` is a statement
about the row for the rest of its life. Those are the same sentence right up until something
else legitimately changes the row, and then they are not. And here the post-delete state is
not a mistake at all: it is the **intended end state**, designed on purpose two paragraphs
earlier — *"a record of a phone call placed to a real person is not deletable bookkeeping"* —
with `phone_number` and `transcript` still on the row.

Fixed by moving the rule to a `BEFORE INSERT` trigger. **UPDATE is deliberately not covered**,
and that is the whole point: the FK's SET NULL *is* an UPDATE, so covering it would recreate
the bug exactly. The trigger's own comment says so, because the next person's instinct will be
to "complete" it with `OR UPDATE`.

**What to take from it.**

- **Before writing a CHECK, ask what changes this row later.** Cascades, `SET NULL`, triggers,
  and repair scripts all produce rows the original author never pictured. If any of them can
  legitimately produce a state the CHECK forbids, the rule belongs at INSERT.
- **A constraint that fights another constraint fails at DELETE time, not at migration time.**
  Both applied cleanly. Exit 0 said nothing. It would have surfaced months later as "why can't
  I delete this lead", with the error naming a table nobody was thinking about.
- **This is what the rollback-style SQL tests are FOR.** The pattern in the environment skill
  §3 says to assert that a DELETE *succeeds*, not merely that a bad insert is refused — and
  that specific assertion, which looks like the boring one, is the only thing in the suite that
  could have caught this. It caught it on production, cost nothing, and left no residue.
- **And the harness has to be shown failing.** Green here means exit 0, which is also what a
  file that silently did nothing returns. One assertion was flipped, the run went exit 1 with
  `FAIL 1: ...` on screen, and only then was the green worth anything.

---

## L108 — "Not determinable from either codebase" was determinable from one of them

*23 Sep 2026. The question had been blocking a whole phase.*

`Todos.md` §E recorded: *"Is a domain renewal idempotent at ResellerClub, or does a second
call add a year? **Not determinable from either codebase.**"* It gated Phase 8, and the plan
around it assumed the worst — every renewal parked for a human to release.

The answer was three lines of our own code. ResellerClub's `renew.json` requires `exp-date`,
documented as *"Current Expiry Date of the Order"* — an optimistic-concurrency guard, and a
good one. But `resellerclub-wrapper.ts:136` **re-reads the expiry on every call** and passes
whatever it just read. So a retry after an unacknowledged renewal reads the NEW expiry, sends
that, it matches, and the registrar renews again.

A retry buys a second year. Not because of anything ResellerClub does — because of what WE
send. The vendor's own guard was being handed a valid answer by our pre-flight.

**The rules:**
- **Before recording a question as needing an outside answer, read your own call path.** The
  question was phrased about the vendor's behaviour, so nobody looked at the wrapper. "What
  does the third party do" and "what do we ask it to do" are different questions and only the
  second is free to answer.
- **A required parameter naming current state is usually a concurrency guard.** `exp-date`,
  `If-Match`, a version column — they exist so a stale writer loses. Re-reading the value
  immediately before sending it converts the guard into a rubber stamp. If you want the
  protection, send the value you read BEFORE the work, not after.
- **The answer improved the design rather than merely unblocking it.** The pre-renewal expiry
  is a reconciler: record it, re-read on ambiguity, moved means done. That is a pure read with
  a definite answer — the bar Phase 6 set for giving a command a reconciler — so renewals can
  be automated instead of parked. The pessimistic plan was more expensive AND less safe.

## L109 — A status code is a retry instruction, and on a non-idempotent spend that is the whole safety story

*23 Sep 2026, from `/api/domains/renew`.*

`hard_failure` covered three situations — the request never left, the socket died after the
POST, the registrar answered "no" — and returned **500** for all three. 500 is what clients,
proxies, load balancers and impatient humans all retry. So the one case that must never be
repeated was the only one being advertised as repeatable, on a call that buys a year of a
domain with money that does not come back.

The fix is not a better error message. It is choosing the status by **how far the request
got**, which the caller cannot infer and the sender always knows:

- `not_sent` / `responded` → **502**, "nothing was renewed, it is safe to try again"
- `sent_unknown` → **409**, "do NOT try again, a second attempt could buy an extra year"

409 because nothing retries it on its own. That property is the point; the wording is
secondary, because an automated caller never reads the wording.

**The rules:**
- **Ask what a client DOES with the status, not what it means.** 500 and 502 read similarly to
  a person and differently to a retry policy.
- **The sender is the only thing that knows how far it got**, so it has to say so
  structurally — `lib/integrations/transport.ts` for the DMS side, and the same three-way
  split (`not_sent` / `sent_unknown` / `responded`) is now what the engine route reads off a
  branded error.
- **Found in the same file: a false failure is the same bug wearing better manners.**
  `createOrder` sat in the same `try` as the registrar call, so a bookkeeping throw returned
  500 and "Failed to renew domain" about a renewal that had just succeeded. The customer reads
  a failure, presses the button, and buys the second year themselves. Post-success bookkeeping
  gets its own `try`, and its failure is reported as what it is.

## L110 — A tool that fails before it starts looks exactly like the work failing

*23 Sep 2026, applying migration 008 to production.*

The runner said:

```
[migrate]   008_drop_domain_orderid_unique.ts FAILED: Only URLs with a scheme in:
file, data, and node are supported by the default ESM loader. Received protocol 'c:'
```

That reads as "the migration failed" and is nothing of the sort. `await import()` was handed
an absolute Windows path, so the module never resolved — `up()` had not been called, the
database was untouched, and because the ledger row is written AFTER `up()` returns, no false
record of success existed either. Verified against production before retrying rather than
assumed: still 7 ledger rows, `orderId_1` still unique.

Migrations 001-007 were applied in May, before the Node version that enforces this. The
runner had been broken for months and nothing noticed, because nothing had run since.

**The rules:**
- **After a failed write to a live system, measure what state it left before doing anything
  else.** "It said FAILED" narrows nothing: it could mean nothing happened, everything
  happened, or half did. One read settles it and costs nothing.
- **Know where the ledger write sits relative to the work.** A tracking row written after the
  work means a crash leaves no false success; written before, it means the opposite, and a
  retry would skip a migration that never ran.
- **A tool nobody has run since the environment changed is not known to work.** The runner
  was fine under the Node of May and broken under the Node of September, silently, because
  the gap between migrations was longer than the gap between Node releases.

## L111 — "It does not throw" is not an assertion that anything happened

*23 Sep 2026, deleting `appendUserDomain`.*

The function pushed a subdocument onto `User.domains`. The User schema declares no such
path, so Mongoose strict mode dropped every write silently. It had a test, it was green,
and here is what the test said:

```
it("is a no-throw side effect — User schema doesn't declare a domains[] field, so
    mongoose strict-mode strips the $push silently", ...)
    // The helper is best-effort: callers treat it as a fire-and-forget audit hook.
    // Test the contract that matters — it doesn't throw — rather than asserting a
    // side-effect that strict-mode drops.
await expect(appendUserDomain(...)).resolves.toBeUndefined();
```

The test **knew** the write was dropped, said so in its own name, and then asserted the one
property that would hold whether the function worked, did nothing, or was an empty body. It
is not a weak test; it is a test that argues the defect is a design choice. That framing is
why nobody removed the function for months — and the destination turned out to be read by
nothing anyway, so even a working version would have changed no screen.

**The rules:**
- **Assert the effect, or assert that there is none and say why.** `resolves.toBeUndefined()`
  on a write is a test of the return type, not of the write. If the effect genuinely cannot
  be asserted, that is a finding about the code, not a reason to assert something else.
- **"Best-effort" and "fire-and-forget" are the words to grep for** when hunting for
  silently-dead code. They are how a no-op gets described once somebody notices it is a
  no-op and decides that is acceptable.
- **Check the destination as well as the write.** Two independent things were wrong here and
  either alone would have been enough: the write was dropped, AND nothing read where it was
  going. Fixing the first would have produced a correct write into a field no screen reads.
- **When deleting code a test defends, replace the assertion with the invariant that made it
  pointless.** What is pinned now is that the User schema has no `domains` path — the reason
  the function could never have worked, and the reason reviving it would be wrong.

## L112. Code that is WRONG and UNREACHABLE survives, because it reads exactly like code that is right

*23 Sep 2026. Three independent instances in one day, found three different ways.*

| What | Why it was wrong | Why nobody removed it |
|---|---|---|
| `AdminLayoutSkeleton`'s chrome | a `bg-blue-900` sidebar from before the restyle — the exact flash the shell was built to stop | all 19 importers sit under that shell, so the guard always fired and it never rendered |
| `onLogout={() => { window.location.href = "/login" }}` in five admin pages | navigates without `signOut()` or clearing storage — the operator would land on /login still authenticated | inside the shell `AdminLayout` returns only its children, so a page's own `onLogout` is dead |
| `\|\| "https://resellersos.web.app"` in 13 files | that host answers **503** | `NEXT_PUBLIC_APP_URL` is baked at build and set at runtime, so the fallback never fires |

None of these could run. Every one of them was *wrong*. And that combination is
what preserved them: a reader cannot tell dead-and-wrong from dead-and-fine, so
the honest-looking response to each is to leave it alone.

**Two of the three were actively defended.** The skeleton's chrome had a comment
saying it was kept "because this component is also used outside the /admin
subtree" — measured, there is no such use — and two tests that rendered it
with no provider and asserted the dark chrome appeared. That is L111 one step on:
not a test that asserts nothing, but a test that asserts something true of a
configuration no caller can produce.

**The rules:**

- **"It cannot run" is not a reason to stop reading.** Ask the second question:
  *and is it right?* Dead-and-right is housekeeping. Dead-and-wrong is a loaded
  gun — it fires the day somebody deletes a guard, moves a component out of a
  provider, or builds without an arg, and it fires as the behaviour nobody
  reviewed.
- **The compiler is the honest way to find a dead constant.** Deleting the
  razorpay fix's `WEBHOOK_APP_URL` produced `TS6133: declared but its value is
  never read`. Earlier the same day I *claimed* `compliance-reminders`' constant
  was unused from a grep; it is used, 115 lines down. Remove the last use and let
  tsc tell you, rather than counting matches.
- **A justification written next to dead code ages with nothing to correct it.**
  Normal code gets corrected when it misbehaves. This never misbehaves, so its
  comment is never re-read, and the comment is usually the only reason it is
  still there. Test the claim (§12, L41) rather than the sentence.
- **Fix it toward "cannot be wrong", not toward "right today".** Both URL fixes
  went to `new URL(path, request.url)` rather than a better fallback host: the
  request's own origin needs no configuration, cannot drift, and survives this
  service answering on more than one hostname (L18).

## L113. Check where a string is CONSUMED, not where it is declared

*23 Sep 2026, and it cost a wrong statement to the operator before it was caught.*

Auditing the dead-host fallback, I grepped the declarations, read the first use in
each file, and reported that all the remaining sites built "internal staff links".
One did not. `api/webhooks/razorpay` used it **350 lines below the declaration** to
build the GST tax-invoice link in the CUSTOMER's order confirmation — a statutory
document link, sent after payment, pointing at a host that answers 503.

A declaration tells you a value exists. Only the call site tells you who receives
it. On a long route file those are nowhere near each other, and the first use is
not representative of the rest.

**The rules:**
- **Trace every use to its `to:`.** The audit that was worth anything listed each
  consumption against the recipient it reaches — `alert.to`, `owner.to`, a role
  query, a customer address. "Internal" is a claim about the recipient, so it has
  to be read off the recipient.
- **A filter that hides a usage reads exactly like no usage.** Two of my own
  passes over the same files produced false absences: an `awk` exclusion for
  `^ *const ` swallowed `const msg = renderReminder(plan, APP_URL)`, and a
  `head -40` truncated the last file. Both printed a clean-looking nothing. If a
  file you expect to appear does not, suspect the pipeline before the code (L23).
- **When a classification has been wrong once, do not restate it — re-derive it.**
  Leaving "the rest are internal" in a comment as reassurance would have carried
  my error forward in the place most likely to be trusted.

## L114. A migration that REPAIRS A STATE is undone by the next migration that rebuilds it

*30 Sep 2026, reviewing R-013 — and the thing it caught was my own work from the day before.*

`20260927100000_definer_rpc_hardening.sql` closed three real holes, correctly. It closed
them the only way a repair can: a `do $$ … regexp_replace … $$` that rewrote 17
SECURITY DEFINER bodies in place, and a loop that revoked `anon` EXECUTE from the definer
functions **that existed at that moment**.

Both are one-shot sweeps over a state that keeps regenerating. Twenty-four hours later,
R-014 and R-015 recreated four of those functions — `delete_project_invoice`,
`delete_subscription_invoice`, `raise_project_milestone_invoice`, `next_document_number` —
from bodies read with `pg_get_functiondef` on a database where the hardening had never been
applied. Every one carried the pre-hardening guard straight back in, and by timestamp they
run *after* it, so production would have ended with the hole reopened and
`definer_rpc_hardening.test.sql` red.

**Two distinct mechanisms, and the second is the one nobody would see:**

- **The body.** `pg_get_functiondef` returns whatever is installed *here*. On a database
  missing 44 migrations, "the live body" is a body from before the fix.
- **The grants.** `create or replace function` **keeps** a function's ACL.
  `drop function` + `create` **resets it to the PUBLIC default.** Six of my functions were
  replaced in place and kept their hardened grants; the one that needed a new parameter had
  to be dropped, and silently handed `anon` back the gapless CGST document counter — where
  one anon call burns a number that is never reissued.

**The rules:**

- **Before recreating any function from `pg_get_functiondef`, check the migrations your
  database has NOT applied.** A local body is a snapshot of your own drift, not of
  production. Diff the guard list before and after (L9) — and diff the *grants* too.
- **`create or replace` keeps grants; `drop` + `create` does not.** If a signature change
  forces a drop, re-state the grants deliberately rather than copying the old `proacl`,
  which is exactly the state a hardening migration may have been written to change.
- **Prefer a mechanism over a sweep.** A sweep is a repair; `alter default privileges …
  revoke execute on functions from public` is a rule, and a rule covers what is written
  tomorrow. Recommended to the owner of that area rather than applied unilaterally.
- **Put the regression check where it actually runs.** The SQL test that catches this
  (`FAIL 4`, a repo-wide `pg_get_functiondef` scan) is correct, needs a database, and is not
  in CI — so it had not run in a while. `src/lib/security/definer-hardening-holds.test.ts`
  scans the migration *files* instead: no Docker, runs on every `npm run test`, red-checked
  both ways. It does not replace the SQL test; it catches the case at the moment somebody is
  writing the migration, which is the moment it is cheap.
- **Exempt what the rule must not fire on, by name and with the reason.** RLS policy helpers
  genuinely need `anon` EXECUTE — a policy runs as the querying role. The first version of
  the scan went red on `hierarchy_sees_all` / `visible_owner_ids`, which are right. A guard
  that fires on the right answer gets deleted within a week (L103), so they are allow-listed
  individually, each with the policy that evaluates it, plus an assertion that the policy
  still exists.
