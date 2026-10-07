# ResellerOS E2E Tests (Playwright)

End-to-end test suite covering critical user journeys and — most importantly — **multi-tenant RLS isolation**. With 200+ features shipped to a single shared Supabase project, the cost of a tenant-leak bug is existential. Automated tests are the only sane defense.

---

## Quick start

```bash
# from production/
npm install                # installs @playwright/test + browsers if missing
npx playwright install     # downloads Chromium + WebKit browser binaries (first time only)
npm run test:e2e           # runs the full suite headless
npm run test:e2e:ui        # interactive UI mode — pick which test to run
```

Default: Playwright auto-starts `npm run dev` on port 3000 and runs tests against it. Override with `PLAYWRIGHT_BASE_URL=https://staging.example.dev npm run test:e2e` to hit staging.

---

## Architecture

```
e2e/
├── README.md                   # this file
├── smoke.spec.ts               # auth-free sanity check (login renders, redirects work)
├── money-spine.spec.ts         # happy-path funnel smoke: lead→quote→pay→invoice→renewal
│                               #   renders + quick-add + public buy page (no-auth part runs today)
├── lead-flow.spec.ts           # Sales Workspace v2 UI flows (Smart Views, drawer, quick-add)
├── cross-tenant.spec.ts        # RLS isolation — tenant A cannot see tenant B
├── role-permissions.spec.ts    # sales role can't reach owner-only routes
└── fixtures/
    ├── auth.ts                 # loginViaSupabase (cookie session) + loginAs (UI) helpers
    └── seed-auth.ts            # programmatically create test auth users via Admin API
```

**Run status (2026-06-01):** the no-auth tests (`smoke.spec.ts`, `money-spine.spec.ts` › public buy page) pass against live prod today. The auth-gated specs `test.skip` until `.env.test` (with `NEXT_PUBLIC_SUPABASE_ANON_KEY`) exists AND the Tenant-A/B fixtures are seeded — see "Test data — seeding" below. That's the one remaining wiring step to light up the full spine regression net.

---

## Logged-in E2E (R-053) — "E2E Test Co" + W6–W13

One test company, four users, and a spec per money workflow from `docs/QA-SYSTEM.md` §3.

| Spec | Workflow | Logs in as |
|---|---|---|
| `w06-seats-add.spec.ts` | Add seats → same subscription grows; paying the add-seats quote makes no 2nd subscription; payment replay is a no-op | owner |
| `w07-renewal.spec.ts` | Renewal due in 5 days → "Generate quote" → "Record payment" → renewal date +12 months | owner |
| `w08-overdue-dunning.spec.ts` | Invoice 10 days past due → listed, Accounting "past due" → dunning engine **dry run** picks it (no email, no log row) | manager |
| `w09-credit-note-refund.spec.ts` | Credit note in UI (net due + GST netted, over-credit refused); refund in UI; refund on an invoiced quote refused | owner |
| `w10-expense-gst-input.spec.ts` | COGS bill + GST expense in UI → both claimable under "Input GST" | accountant |
| `w11-gst-reports.spec.ts` | GSTR-1 row + footer = DB totals; GSTR-1 JSON HSN = same totals; 3B worksheet; sales is bounced | accountant, sales |
| `w12-books-reports.spec.ts` | Day Book voucher, P&L revenue = DB, trial balance debit = credit | accountant |
| `w13-payroll.spec.ts` | Add employee → pay last month's salary → salary register | owner |

Fixtures: `fixtures/e2e-roles.mjs` (env names, production deny list), `fixtures/roles.ts`
(`test.use({ role })` → logs in through the real /login once per role per worker and reuses
the storageState; `db` = supabase-js signed in as the same user, so setup goes through RLS),
`fixtures/seed-e2e-tenant.mjs` (the seed). The specs run on desktop Chromium only (the
mobile project ignores `wNN-*`), and each run creates new "E2E …" documents — they are never
deleted, which is fine on a test database and is why production is refused.

### Env vars

| Var | Needed by | Notes |
|---|---|---|
| `E2E_OWNER_PASSWORD`, `E2E_MANAGER_PASSWORD`, `E2E_SALES_PASSWORD`, `E2E_ACCOUNTANT_PASSWORD` | seed + specs | **No default.** A spec whose role password is missing skips with the variable name, and `suite-health` goes red. |
| `E2E_OWNER_EMAIL`, `E2E_MANAGER_EMAIL`, `E2E_SALES_EMAIL`, `E2E_ACCOUNTANT_EMAIL` | seed + specs | Optional; default `e2e-<role>@example.test` (a `.test` address can never receive mail). |
| `NEXT_PUBLIC_SUPABASE_URL` (or `SUPABASE_URL`), `NEXT_PUBLIC_SUPABASE_ANON_KEY` | specs | The Supabase the target app uses (test site or local). |
| `SUPABASE_SERVICE_ROLE_KEY` | seed only | Creates the users. Never printed. |
| `E2E_ALLOW_SEED=1` | seed only | The seed refuses to run without it. |
| `PLAYWRIGHT_BASE_URL` | specs | Always set it (see `playwright.config.ts`). |
| `E2E_CRON_SECRET` (or `CRON_SECRET`) | W8 step 3 | Optional; without it the dunning dry-run is noted as "not-checked" in the report, the rest of W8 still runs. |

**Passwords sirf GitHub secrets / local `.env.test` mein — kabhi chat ya code mein nahi.**
Not in a commit, a board card, a screenshot or a Claude chat. `.env.test` is gitignored;
the seed and the specs print only variable names and ids, never a value.

### Seed (idempotent — re-run any time)

```bash
# from production/, with the vars above in env or in .env.test
E2E_ALLOW_SEED=1 node e2e/fixtures/seed-e2e-tenant.mjs
```

It creates or updates: tenant "E2E Test Co" (marker email `e2e-company@example.test`), the
four users (an existing one gets its password reset to the env value), customer
"E2E Customer Pvt Ltd", bank account "E2E Bank Current A/c", vendor "E2E Vendor Pvt Ltd"
(synthetic GSTIN). It **refuses** production — `reselleros.anutech.in`, `anutech.in`,
`api.anutech.in`, the old hosted Supabase project, the `resellsubsos-prod` / production
Cloud Run hosts (hard-coded, no override) — and refuses an E2E email that already belongs to
a user of another company.

### Run locally (against the local Docker Supabase)

```bash
npm run db:start
npx supabase status -o env        # API_URL / ANON_KEY / SERVICE_ROLE_KEY for your shell
node scripts/dev-local.mjs -p 3014   # app on local Supabase only; live keys blanked
# other terminal — same env + your own local-only E2E_*_PASSWORD values
E2E_ALLOW_SEED=1 node e2e/fixtures/seed-e2e-tenant.mjs
PLAYWRIGHT_BASE_URL=http://localhost:3014 CRON_SECRET=local-dev-cron-secret \
  npx playwright test e2e/w0 e2e/w1 --project=chromium --workers=1
```

### In CI — `.github/workflows/e2e-logged-in.yml` (R-058)

Runs on every push to the team branches and nightly at 08:00 IST, against **staging**
(`https://resellersos-staging-njvk4nxhdq-as.a.run.app`) unless repo variable `E2E_BASE_URL`
says otherwise. The first step, `e2e/fixtures/ci-preflight.mjs`, decides:

| Preflight | When | Result |
|---|---|---|
| refuse | base URL or `E2E_SUPABASE_URL` is production (deny list in `e2e-roles.mjs`) | red |
| skip | none of the secrets below is set | job stops there, notice + summary list the names; not red |
| fail | some set, some missing | red, lists the missing names |
| ok | all set | seed + `e2e/w0 e2e/w1 suite-health` run |

Secrets (Settings → Secrets and variables → Actions): `E2E_SUPABASE_URL`, `E2E_SUPABASE_ANON_KEY`,
`E2E_SUPABASE_SERVICE_ROLE_KEY`, `E2E_OWNER_PASSWORD`, `E2E_MANAGER_PASSWORD`, `E2E_SALES_PASSWORD`,
`E2E_ACCOUNTANT_PASSWORD`; optional `E2E_CRON_SECRET`.

---

## Test data — seeding

E2E tests rely on a known fixture roster: **2 tenants × 5 users + sample leads**. The seed is split across two files because Supabase auth schema is admin-only:

**1. `supabase/seed/test-users.sql`** — public data (tenants, users, leads).
Idempotent SQL — safe to re-run. UUIDs are hardcoded so test files can reference them.

**2. `e2e/fixtures/seed-auth.ts`** — auth.users rows.
Calls Supabase Admin API to create the auth users with matching UUIDs. Requires `SUPABASE_SERVICE_ROLE_KEY` in `.env.test` (gitignored).

### Re-seeding locally

```bash
# wipe + reset local Supabase
supabase db reset

# apply test fixtures
psql $SUPABASE_DB_URL -f supabase/seed/test-users.sql

# create auth users (requires .env.test with service key)
node -r dotenv/config -e "require('./e2e/fixtures/seed-auth').ensureTestAuthUsers()"
```

### Re-seeding staging (planned CI)

GitHub Actions runs both steps before the E2E suite:
1. `supabase db push --db-url $STAGING_DB_URL`  (apply migrations)
2. `psql $STAGING_DB_URL -f supabase/seed/test-users.sql`  (apply fixtures)
3. Node script calls `ensureTestAuthUsers({ supabaseUrl, serviceRoleKey })`
4. `npm run test:e2e`

---

## Fixture roster

| Email | Tenant | Role | Notes |
|---|---|---|---|
| `owner@testa.dev` | Test Tenant A | owner | Full access, all of A's leads |
| `manager@testa.dev` | Test Tenant A | manager | Most of owner's access except some admin |
| `sales@testa.dev` | Test Tenant A | sales | Lead-focused — restricted views |
| `owner@testb.dev` | Test Tenant B | owner | Used for cross-tenant tests |
| `sales@testb.dev` | Test Tenant B | sales | |

Password: `test-password-1234` (same for all — test data only, never used in prod).

UUIDs are deterministic and shared between SQL + TS so RLS tests can hard-code them:

```ts
import { TENANT_A_ID, TENANT_B_ID, getTestUser } from "./fixtures/seed-auth";
```

---

## What MUST be tested (P0 priorities)

1. **Auth bouncing** — unauthenticated `/leads` → `/login`. (✅ in smoke.spec.ts)
2. **RLS leak — direct supabase query** — Tenant A's session cannot `SELECT` from Tenant B's `leads`/`quotes`/`invoices`/`customers`/`payments`.
3. **RLS leak — UI** — login as Tenant A, check no Tenant B data renders anywhere.
4. **Role gates** — sales user → `/customers` → redirected. Sales user → `/accounting/saas-metrics` → redirected.
5. **Critical write paths** — record_payment RPC succeeds + auto-converts lead → customer.
6. **Document numbering** — concurrent `next_document_number('invoice')` calls don't collide.
7. **Cross-tenant invoice → vendor_bill trigger** — Tenant A's child (Tenant B) gets a vendor_bill when A invoices B.

---

## What NOT to test in E2E (use unit tests for these)

- Pricing math (rupee formatting, ×12 annualization, GST split) → Vitest.
- Form validation (Zod schemas) → Vitest.
- Date/timezone math (daysBetween) → Vitest.

E2E should cover **user journeys + integration boundaries**, not pure functions.

---

## Debugging

- `npx playwright test --debug` — opens browser, pauses at each step.
- `npx playwright show-report` — opens the HTML report after a run.
- Test failures save traces, screenshots, and videos to `test-results/`.
- For multi-tenant flakiness, add `await page.context().storageState({ path: "tmp.json" })` mid-test to inspect what cookies are set.

---

## CI

Planned `.github/workflows/ci.yml`:
- On PR open / push to main: run typecheck, lint, smoke tests against a staging Supabase branch.
- On nightly cron: run the full suite + RLS-leak tests.
- On merge to main: trigger Cloud Run deploy.

The CI pipeline is the next deliverable in the Critical Infrastructure sprint (Week 1, Day 4).
