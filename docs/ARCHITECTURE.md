# ResellerOS architecture

A one-file map of the system for a new session, so you can find the right folder before reading
code. Written 19 Oct 2026 (R-1665), checked against the code on `manager-pardeep`.

**Code is truth** ([AGENTS.md §12](../AGENTS.md)). Counts and lists here are a snapshot; verify a
detail in the file it names before you act on it, and fix this file when you find it wrong.

Companion docs: [DATABASE.md](DATABASE.md) (tables, money rules, migrations) · [API.md](API.md)
(every route, generated) · [AGENTS.md](../AGENTS.md) (rules that cost money) ·
[production/CLAUDE.md](../production/CLAUDE.md) (code conventions) · [TEAM-PROTOCOL.md](TEAM-PROTOCOL.md)
(how the team works) · [adr/](adr/) (decisions).

---

## 1. What ResellerOS is

A multi-tenant SaaS for Indian IT / cloud resellers (Google Workspace, Microsoft 365, Zoho,
hosting, domains). One **tenant** = one reseller company; each tenant manages its own customers.
It covers the whole money path — **lead → quote → payment → subscription → GST invoice → renewal** —
plus CRM, accounting and GST compliance, HR/attendance, support and marketing.

- The platform company is ANUTECH DIGITAL PVT LTD (tenant `tier = 'distributor'`); it is also the
  first customer and runs its own shop on the same app ([production/CLAUDE.md §1, §4a](../production/CLAUDE.md)).
- **It is a live business system.** Wrong numbers become wrong invoices to real customers.
- Money is stored in **whole rupees**, never paise ([AGENTS.md §1](../AGENTS.md)).

**Not in this repo: DMS** — the hosting/domain management app (Next.js 15 + MongoDB + Redis, its own
repo, admin panel and customer panel). The two apps are federated: ResellerOS is the front door,
prices, takes payment and issues every bill; DMS provisions hosting/domains and owns the customer
panel. ResellerOS talks to it through `production/src/lib/dms-engine/` (read API, signed commands,
SSO) and DMS calls ResellerOS's `/api/dms/*` routes. ResellerOS has **no customer portal** on
purpose. Full story: [AGENTS.md §0](../AGENTS.md).

---

## 2. Stack

| Layer | What is used | Where |
|---|---|---|
| App | Next.js **15.5** App Router, React **19**, TypeScript strict | `production/` (`package.json`) |
| UI | Tailwind + shadcn/Radix primitives, design tokens | `src/app/globals.css`, `src/components/ui/` |
| Client data | TanStack Query v5 hooks, React Hook Form + Zod | `src/lib/queries/` |
| Database | PostgreSQL 17 on **Cloud SQL** (live `resellersos-db`, staging `resellersos-staging-db`) | [ADR 0001](adr/0001-database-on-cloud-sql.md) |
| Data access | `supabase-js` → Supabase **PostgREST / GoTrue / Storage**, self-hosted on a VM in front of Cloud SQL; or the in-process **data gateway** (Prisma + `pg`) when `DATA_GATEWAY=1` | `src/lib/supabase/`, `src/server/` |
| Isolation | Row-Level Security on every tenant table, `current_tenant_id()` | [DATABASE.md §5](DATABASE.md) |
| Auth | Supabase GoTrue **or** Auth.js (next-auth v5), picked by `AUTH_PROVIDER` | section 5 |
| Hosting | Google **Cloud Run** `asia-southeast1` (live `resellersos`, staging `resellersos-staging`), built by Cloud Build | root `cloudbuild.yaml` |
| Jobs | Cloud Scheduler → `/api/cron/*` | section 6 |
| Monitoring | Sentry (`src/lib/sentry.ts`), uptime check on `/api/version` | [production/CLAUDE.md §22](../production/CLAUDE.md) |
| Tests | Vitest, SQL regression tests, Playwright | section 9 |

`production/CLAUDE.md §2` still lists Next.js 14, Vercel, Gupshup and ClearTax; the table above is
what `package.json` and the code show today.

### Two switches that change the data path (R-161 / R-909)

- `AUTH_PROVIDER=authjs` (+ `NEXT_PUBLIC_AUTH_PROVIDER`): sign-in by Auth.js instead of GoTrue
  (`src/server/auth/authjs.ts`). After sign-in the server mints a short-lived Supabase-style JWT
  (`src/server/auth/supabase-jwt.ts`, served by `/api/auth/supabase-token`) so existing
  `supabase-js` calls keep working.
- `DATA_GATEWAY=1` (+ `NEXT_PUBLIC_DATA_GATEWAY=1`): `/rest/v1` and `/storage/v1` are answered
  in-process (`src/server/postgrest/fetch.ts`); the browser calls `/api/sb/*` instead of the VM. The
  gateway runs each transaction as role `app_runtime` with `app.user_id` / `app.tenant_id` set
  (`src/server/db/index.ts`, `src/server/db/gateway.ts`).

Both are off unless set. `docs/R-909-LIVE-CUTOVER.md` (in `production/docs/`) has staging running
both; whether live has switched is not recorded here — check the Cloud Run env before assuming.

---

## 3. Folder map

```
production/
├── src/app/            Next.js routes
│   ├── (app)/          signed-in staff app (sidebar shell) — one folder per module, see section 4
│   ├── (auth)/         login, signup, mfa, callback, password pages, verify-email, welcome
│   ├── (marketing)/    the company shop: home, hosting, domains, cart, checkout, status, legal
│   ├── (product)/      the ResellerOS product site (/reselleros)
│   ├── (lp)/           ad landing pages (/lp/*)
│   ├── (public)/       signed-out pages: buy, quote accept, enquiry, expense-claim, assessment, unsubscribe
│   ├── learn/          Apprentice Academy (outside the app shell)
│   ├── dev/            dev-only pages, 404 in production unless ALLOW_DEV_PAGES=1
│   └── api/            route handlers — every one listed in docs/API.md
├── src/components/     ui/ primitives · layout/ (sidebar, topbar) · features/<area>/
├── src/lib/            domain logic per area (accounting, gst, quotes, leads, checkout, …) + integrations
├── src/server/         server-only: Auth.js (auth/), Prisma data gateway (db/, postgrest/), storage, settings
├── src/site/           components + logic for the public websites (cart, checkout, domains, site split)
├── src/middleware.ts   auth, MFA, role gate, dev-page gate, demo guard, two-host site split
├── supabase/           baseline.sql, migrations/, tests/ (SQL), cloudsql/ (Cloud SQL setup + deploy-db scripts)
├── prisma/             generated schema.prisma + data-gateway migrations
├── db/                 local Postgres image (db/local) and ops SQL/runbook (db/ops)
├── scripts/            gate, lint ratchet, migration checks, ops/ (deploy, staging train, worker lock, generators)
├── tests/              repo-level tests (ops scripts, migration scans, isolation suite)
└── e2e/                Playwright specs
```

---

## 4. Module map

Folders are under `production/src/`. "Knows it best" comes from [OWNERS.json](../OWNERS.json)
(queue mode since 1 Oct 2026: anyone may change any file; the area says whom to ask). The billing
screens also carry the hands-off rule in [AGENTS.md §13](../AGENTS.md) — read it before editing them.

| Module | Pages (`app/(app)/…`) | Logic | Knows it best |
|---|---|---|---|
| Dashboard, Today | `dashboard`, `today` | `lib/today`, `lib/analytics` | Pardeep |
| Leads / CRM | `leads`, `contacts`, `deals`, `enquiries`, `lead-gen`, `tasks`, `activity` | `lib/leads`, `lib/queries/leads.ts`, `lib/contacts`, `lib/deals`, `lib/inbound` | Pardeep |
| Billing: customers, quotes, subscriptions, renewals, invoices, payments, projects | `customers`, `quotes`, `subscriptions`, `renewals`, `invoices`, `payments`, `projects`, `collections`, `items`, `products`, `coupons` | `lib/quotes`, `lib/subscriptions`, `lib/invoices`, `lib/renewals`, `lib/payments`, `lib/billing`, `lib/pdf` | Abhishek's area (AGENTS.md §13) |
| Online orders, hosting, domains | `online-orders`, `online-promos`, `provisioning`, `hosting-domains` | `lib/checkout`, `lib/provisioning`, `lib/hosting`, `lib/domains`, `lib/dms-engine`, `lib/trials` | Pawan |
| Public site, checkout, `/api/v1` | `app/(marketing)`, `(public)`, `(product)`, `(lp)` | `src/site`, `lib/checkout`, `lib/api` | Pawan |
| Accounting | `accounting/*` (banking, expenses, bills, P&L, balance sheet, trial balance, day book, ledger, payroll, TDS, loans, …), `purchases`, `purchase-orders`, `reports`, `my-expenses` | `lib/accounting`, `lib/banking`, `lib/reconcile`, `lib/payables`, `lib/payroll`, `lib/expenses` | Pardeep (Hitesh checks the numbers) |
| GST and compliance | `compliance/*` | `lib/compliance`, `lib/gst`, `lib/tax` | Pardeep |
| HR and attendance | `team`, `attendance`, `performance`, `scorecard`, `academy`, `assessments` | `lib/team`, `lib/attendance`, `lib/academy`, `lib/assessments` | Pardeep |
| Support | `support` | `lib/support` | Pardeep |
| Vault | `vault` | `lib/vault` (ciphertext read server-side only, `vaultGate()`) | Pardeep |
| Marketing, campaigns, WhatsApp | `marketing`, `campaigns`, `whatsapp`, `referrals`, `partners` | `lib/marketing`, `lib/whatsapp`, `lib/meta`, `lib/meta-leads`, `lib/referrals` | Pardeep |
| AI | `ai-entry`, `automation`, `ux-insights`, `ui-insights`, `quality` | `lib/ai` (Gemini), `lib/automation`, `lib/voice`, `lib/telecall`, `lib/ux`, `lib/quality` | Pardeep |
| Settings, setup, platform | `settings`, `setup`, `platform`, `admin`, `help`, `mobile` | `lib/platform.ts`, `lib/onboarding`, `lib/api-keys` | Pardeep |

The sidebar and who sees each page: `src/lib/nav.ts` (`APP_NAV`, `ROUTE_DENY`).

---

## 5. Request flow, auth and roles

**Typical read.** A `"use client"` page calls a TanStack Query hook in `src/lib/queries/` →
`createClient()` from `src/lib/supabase/client.ts` → `.from(...)` / `.rpc(...)` → PostgREST (or
`/api/sb`) → Postgres, where **RLS** filters to the caller's tenant through `current_tenant_id()`.
Server components use the cookie client from `src/lib/supabase/server.ts`.

**Typical write.** Single-row writes go straight through `supabase-js` under RLS. Money writes that
touch several rows call one SECURITY DEFINER RPC (`record_payment`, `generate_invoice`,
`refund_payment`, `reconcile_bank_txn`, …; [production/CLAUDE.md §17b](../production/CLAUDE.md)).
Writes that need privileges or a third party go to an `/api/*` route wrapped in `withRoute()`
(`src/lib/api/with-route.ts`): it signs the user in, reads `tenant_id` + `role` from `users`, parses
the body with Zod, checks `roles` / `permission` / `pages`, and returns §24-style errors. There are
**no Server Actions** (no `"use server"` in `src/`).

**Service role.** `createAdminClient()` (`src/lib/supabase/server.ts`) bypasses RLS. It is for code
with no user session — crons, webhooks, `/api/public`, `/api/v1`, integrations — and then the route
itself is the tenant boundary. `src/app/api/admin-client-ratchet.test.ts` makes every such route
prove its caller.

**Sign-in.** `src/middleware.ts` refreshes the session (GoTrue `updateSession()` or Auth.js
`authjsMiddlewareSession()`), then: TOTP **MFA** step (`/mfa`, `src/lib/auth/mfa-gate.ts`,
`src/server/auth/mfa.ts`), deactivated users, must-change-password, the role gate, the `/dev` gate,
and the read-only "Try the demo" visitor (`src/lib/demo/`, `DEMO_ENABLED=1`).

**Roles** (`src/lib/auth/roles.ts`): `owner`, `manager`, `sales_senior`, `sales`, `billing`,
`delivery`, `accountant`, `support`, `partner_agent` (some legacy only). Actions:
`PERMISSIONS` / `can()`, `MONEY_RECORD_ROLES`, `ACTION_ROLES` / `mayDo()` (`src/lib/auth/action-roles.ts`).
Pages: `isRouteAllowed()` in `src/lib/nav.ts`, enforced by middleware. APIs: `withRoute({ roles | permission | pages })`;
`src/app/api/role-gate-ratchet.test.ts` fails if any mutating route lacks a role gate.
**Platform admin** (cross-tenant founder tools): `isPlatformAdmin()` in `src/lib/platform.ts`.

**Machine callers.** `/api/v1` uses tenant API keys (`src/lib/api-keys/auth.ts`, hashed, scoped).
DMS calls `/api/dms/*` with a panel key. Webhooks verify signatures. Crons send `CRON_SECRET`.
The per-route hint is in [API.md](API.md).

---

## 6. Background jobs

- 27 routes under `production/src/app/api/cron/`, triggered by **Google Cloud Scheduler** (jobs
  defined in `production/scripts/setup-cloud-scheduler.sh`, GET with `Authorization: Bearer <CRON_SECRET>`,
  time zone Asia/Kolkata, 540 s deadline).
- Every cron is wrapped in `gatedCron()` (`src/lib/automation/cron-gate.ts`): constant-time secret
  check (503 when the secret is unset, 401 when wrong) plus a per-tenant on / off / dry-run switch in
  the `automation_jobs` table. Provisioning crons also call `cronAuthFailure()` (`src/app/api/cron/_lib/cron-auth.ts`).
- Main jobs: `renewals` (renewal cadence, grace, auto-suspend), `billing` (instalment invoices),
  `invoice-dunning`, `trial-expiry`, `mrr-snapshot`, `backup`, `health-digest` (owner morning email),
  `compliance-reminders`, `provision-hosting` / `register-domains` / `renew-domains` / `renew-hosting`
  (DMS engine, each behind its own `*_LIVE=1` switch), `gmail-inbox`, `indiamart-leads`, `ads-sync`,
  `gbp-sync`, the `ai-*` jobs, `attendance-*`, `demo-reset`.
- Partial failures are logged as `[cron/<name>]` lines (`src/lib/ops/cron-report.ts`) that the health
  digest reads. Locally, `node scripts/local-cron.mjs` runs the hosting job every minute.

---

## 7. Integrations (what the code really has)

| Service | Code | Notes |
|---|---|---|
| Razorpay | `src/lib/checkout/`, `src/lib/razorpay/`, `api/webhooks/razorpay` | Orders, payment verify, HMAC-checked webhook (idempotent by event id); keys per tenant in `tenant_secrets`. |
| Email | `src/lib/email/` | SMTP (`smtp-transport.ts`, nodemailer) first, then Resend; a tenant's own Gmail wins when set. No recipient allow-list. |
| WhatsApp | `src/lib/whatsapp/` | Meta WhatsApp Cloud API, credentials per tenant. |
| Google | `src/lib/google/` | OAuth (Gmail send/read, Contacts, Business Profile, Ads, Workspace reseller orders). |
| Meta | `src/lib/meta/`, `src/lib/meta-leads/` | Ads spend; Lead Ads webhook → leads. |
| ResellerClub | `src/lib/resellerclub/` | Domain prices (live), lookup, catalog sync. |
| DMS engine | `src/lib/dms-engine/` | Read API, signed commands (`hosting.provision`, `domain.register`, …), SSO. |
| DirectAdmin | `src/lib/directadmin/` | Admin test-account tool only; sales provisioning goes through DMS. |
| Gemini | `src/lib/ai/gemini.ts` | REST, `GEMINI_API_KEY`; AI entry, inbound parsing, sales/support agents. |
| Voice / telephony | `src/lib/voice/` (Sarvam), `src/lib/telecall/` (Retell or Vapi) | AI renewal calls, inbound calls. |
| Web push | `src/lib/push/` | `web-push` with VAPID keys. |
| FX rates | `src/lib/fx/` | FBIL, with public fallbacks. |
| IndiaMART | `api/cron/indiamart-leads` | Lead pull with a per-company CRM key. |
| Sentry | `src/lib/sentry.ts` | Init imported from the server Supabase client (CLAUDE.md §22). |

GST returns are computed in `src/lib/gst/` and `src/lib/compliance/`; there is **no e-invoice / IRP
client yet** (`src/lib/compliance/einvoice.ts` only tracks readiness). No Gupshup, no ClearTax.

---

## 8. From a commit to live

1. **Card branch** off `manager-pardeep`; build with tests (root [CLAUDE.md](../CLAUDE.md)).
2. **Push** only through `node scripts/ops/worker-lock.mjs push <CARD>` (from `production/`): it
   rebases on `anutech/manager-pardeep`, runs `tsc`, the push-guard suites
   (`scripts/ops/push-guard-suites.mjs`) and the secret scan, then pushes to `manager-pardeep`.
   The real remote is `anutech`; `origin` is an old public repo.
3. **CI** (`.github/workflows/ci.yml`) runs on `manager-pardeep`: migration order check, secret scan,
   typecheck, unit tests, lint + lint ratchet, build, smoke Playwright. `sql-tests.yml` runs the SQL suite.
4. **Staging train** — the manager runs `node scripts/ops/staging-train.mjs` every 2–3 hours: newest
   green `manager-pardeep` commit → merge into `staging` (never a force push). New migrations stop
   it until the staging DB step is done (`--db-done`). A push to `staging` builds `resellersos-staging`.
5. **Live** — on deploy days (docs/LIVE-OPERATIONS.md, R-911: Tuesday and Friday after 17:00 IST
   from 17 Oct 2026; older docs still say Thursday): the live `deploy-db-<day>.sh` prints "DB READY",
   then `production/deploy.sh` (gated by `scripts/ops/deploy-gate.mjs`: clean tree, sha pushed, CI +
   SQL tests green) fast-forwards `deploy`, Cloud Build runs the gate (`tsc` + `vitest`), builds the
   image and deploys Cloud Run `resellersos`; then `npm run verify:deploy`. Rollback: [ROLLBACK.md](ROLLBACK.md).
6. **Database** changes ride the per-day scripts in `production/supabase/cloudsql/{staging,live}/deploy-db-<day>.sh`,
   generated by `scripts/ops/gen-deploy-db.mjs` from each migration's `-- deploy-peek:` header.
   Agents never run them and never touch the staging/live DB. Details: [DATABASE.md §6](DATABASE.md).

---

## 9. Tests and guards

| What | Where | Run |
|---|---|---|
| Unit tests (co-located) | `production/src/**/*.test.ts(x)` | `npm run test` |
| Repo-level tests | `production/tests/**` (ops scripts, migration scans) | `npm run test` |
| Isolation suite (real Postgres) | `production/tests/isolation/` | `npm run test:isolation` |
| SQL regression tests | `production/supabase/tests/*.test.sql` | `npm run test:sql:local` |
| E2E | `production/e2e/*.spec.ts` | `npm run test:e2e` |
| Full local gate | build, typecheck, unit tests, lint | `npm run gate` |

Guards worth knowing (all run on push, listed in `scripts/ops/push-guard-suites.mjs`):
`admin-client-ratchet` and `role-gate-ratchet` (API callers and roles), `secret-columns.test.ts`
and `service-role-policies.test.ts` (DB grants), the a11y and toast-error ratchets, the secret scan,
and `tests/ops/gen-api-doc.test.ts` (keeps [API.md](API.md) in step with the routes — after adding or
changing a route run `cd production && node scripts/ops/gen-api-doc.mjs`).

"Done" means the test is green; say whether something is test-verified, browser-verified or
reasoned-only ([AGENTS.md §9](../AGENTS.md)).
