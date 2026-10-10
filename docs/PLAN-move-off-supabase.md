# Plan — move ResellerOS off Supabase (Prisma + Auth.js + Cloud Storage) without losing security

- **Status:** Proposal, 3 Oct 2026 — nothing here is built yet.
- **Stack (decided, not re-opened):** Next.js + Cloud SQL Postgres 17 + **Prisma** + **Prisma Migrate** + **Auth.js** + **Google Cloud Storage** + Cloud Run + Cloud Scheduler. The VM goes away.
- **Verdict given first:** do the cheap fixes before the rewrite. The owner chose the full plan; it is below. Phase 0 of this plan *is* the cheap fix, so nothing is wasted either way.

Every number here was measured on branch `Abhishek` at commit `eb6cf53c`. Where I could not measure, it says **I do not know**.

---

## What I checked in the code (and where your numbers were off)

| Fact | Measured | Where |
|---|---|---|
| Supabase calls | 1,635 `.from('…')` · 171 `.rpc` · 203 `.auth.*` · 24 `.storage.*` in **412 files** | `grep` over `production/src` |
| Admin (service-role) client | **215 files** (210 on 3 Oct) — only 32 cron + 5 webhook; **99 normal API routes, 39 lib, 26 public, 9 pages** | `production/src/lib/supabase/server.ts:58` |
| Browser client (talks to PostgREST straight from the browser) | **147 files** (142 on 3 Oct) | `production/src/lib/supabase/client.ts:13` |
| How a policy knows the tenant | `current_tenant_id()` = `select tenant_id from users where id = auth.uid()` — used **65×** in the schema; `auth.uid()` directly **54×** | `production/supabase/baseline.sql:1157` |
| How service_role skips RLS on Cloud SQL | a `USING (true)` policy per table (Cloud SQL forbids BYPASSRLS) | `docs/adr/0001-database-on-cloud-sql.md` |
| Table owner | `resellersos_migration` owns the public tables (`supabase/cloudsql/01b-grants-and-policies.sql:5`); **no table has `FORCE ROW LEVEL SECURITY`** | `production/supabase/cloudsql/README.md`, `grep -c` = 0 in baseline |
| `record_payment` | ~600 lines; rewritten in **8 migrations** since 21 Aug | `production/supabase/migrations/20261003130000_customer_match_needs_name.sql:195-797` |
| Cron routes | 26, each checks `Bearer CRON_SECRET`, then uses the admin client and loops over tenants | e.g. `production/src/app/api/cron/ads-sync/route.ts:16-30` |
| Storage | 4 buckets: `attendance-selfies` (7), `documents` (5), `expense-receipts` (2), `logos` (1) | `grep storage.from` |
| Auth surface | 185 `getUser`, 4 password sign-in, 3 Google OAuth, 2 password reset, 6 admin user ops; **TOTP two-step sign-in via GoTrue `auth.mfa` (R-048, added 4 Oct, commit `28426b57`)**; no realtime | `grep` |
| Migrations | 166 in `supabase/migrations/` + 217 archived + `baseline.sql` (14,543 lines) — not 93 | `ls` |
| Tables / policies / definer functions | **I do not know.** You say 126/366/147; the repo's 5 Sep audit says 118/159/133. Only a query on the live catalog settles it (Phase 0, step 2). | `production/supabase/cloudsql/README.md` |
| SQL tests | 120 files in `supabase/tests/` — **not run by the deploy gate** (gate = `tsc` + `vitest`) | `cloudbuild.yaml:69` |
| Staging | **exists since 3–4 Oct (R-106)**: Cloud Run `resellersos-staging`, Cloud SQL `resellersos-staging-db` (wiped clone), its own gateway VM; migrations still applied by hand with `gcloud sql import` | `production/docs/STAGING.md:12-34` |

**The one thing to remember:** today, about 170 non-cron files already skip RLS and rely on `.eq("tenant_id", …)` (example: `production/src/app/api/contacts/import/route.ts:86-98`). The new design closes that gap; it does not open it.

---

## Step 2 — Target architecture (one picture)

```
                 Browser  (no database key at all — it only talks to Next.js)
                    │
                    ▼
 ┌──────────────── Cloud Run: resellersos (web) ─────────────────┐
 │  Next.js                                                      │
 │   Auth.js  ──► session { userId, tenantId, role }             │
 │   withTenant(session, tx => …)   ◄── the ONLY way to the DB   │
 │      └─ BEGIN; set_config('app.tenant_id' …, true); …; COMMIT │
 │   GCS SDK ──► files (path always starts with tenant id)       │
 │   DB login: app_runtime  (not owner, no bypass)               │
 └───────────────────────────────┬───────────────────────────────┘
                                 │
 ┌──── Cloud Run: resellersos-jobs (same image) ────┐            │
 │  /api/cron/*  ◄── Cloud Scheduler (OIDC token)   │            │
 │  DB login: app_jobs  (only role that may list    │            │
 │  tenants; then does each tenant via withTenant)  │            │
 └──────────────────────────────┬───────────────────┘            │
                                ▼                                ▼
        ┌──────────── Cloud SQL Postgres 17 ───────────────────────────┐
        │  RLS ON + FORCE on every tenant table                         │
        │  policies read current_setting('app.tenant_id')               │
        │  147 money/GST functions stay here (record_payment etc.)      │
        └───────────────────────────────────────────────────────────────┘
                                ▲
        Cloud Build: gate → prisma migrate deploy (as owner role) → build → deploy
```

In plain words:
- The browser never touches the database again. Today 147 files let it.
- The web app logs in to Postgres as a role that **cannot** see anything until it says which tenant it is working for, and it can only say that through one function.
- Background jobs run in a **separate Cloud Run service** with a different database login. The web app never has that password.
- Money logic stays in Postgres, unchanged.
- The VM is gone.

---

## Step 3 — Security design (the three mechanisms, with real code)

### 3.1 Keep RLS — tenant set per transaction

**Database roles (new):**

| Role | Used by | Can |
|---|---|---|
| `resellersos_migration` (exists, **owner**) | only `prisma migrate deploy` in Cloud Build | DDL. Never used at runtime. |
| `app_runtime` (new, LOGIN) | web service | normal DML, **subject to RLS** (not owner, no BYPASSRLS) |
| `app_jobs` (new, LOGIN) | jobs service only | same as `app_runtime` + read the tenant list + a few named cross-tenant functions |

Plus `ALTER TABLE … FORCE ROW LEVEL SECURITY` on every tenant table. That way even the owner obeys RLS if it is ever used by mistake.

**The helpers — one change covers most of the 366 (or 159) policies.** During the move, both paths run at once. So the helper must work for PostgREST (JWT) **and** for Prisma (setting). It picks based on *who logged in*. It uses `session_user`, not `current_user`, because inside a SECURITY DEFINER function `current_user` becomes the function owner.

```sql
-- current_user_id(): replaces the 54 direct auth.uid() uses.
create or replace function public.current_user_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select case
    when session_user in ('app_runtime', 'app_jobs')
      then nullif(current_setting('app.user_id', true), '')::uuid
    else auth.uid()                       -- PostgREST path, until it is removed
  end;
$$;

-- current_tenant_id(): today baseline.sql:1157. Same name, so all 65 callers keep working.
create or replace function public.current_tenant_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select case
    when session_user in ('app_runtime', 'app_jobs')
      then nullif(current_setting('app.tenant_id', true), '')::uuid
    else (select tenant_id from public.users where id = auth.uid() limit 1)
  end;
$$;
```

**Fail closed:** if the setting is missing, the helper returns `NULL`. `tenant_id = NULL` matches nothing, so you get **zero rows, not someone else's rows**. That is the real meaning of "forgetting is impossible". Forgetting gives an empty screen and a failing test, never a leak.

**Why a browser user cannot fake it:** on the PostgREST path the helper ignores `app.tenant_id` completely (`session_user` is `authenticator`). After the move, the browser has no database access at all.

**Connection pooling and `SET LOCAL` (where this design usually breaks):**

- A pooled connection is shared by many requests, one after another.
- `SET app.tenant_id = …` (session level) **stays on the connection**. The next request that gets that connection inherits tenant A. **That is the classic leak. Never use it.**
- `set_config('app.tenant_id', x, true)`: the `true` means *local to this transaction*. Postgres wipes it at `COMMIT` or `ROLLBACK`. Prisma's own pool and PgBouncer in **transaction mode** both hand out a connection for exactly one transaction, so the value can never outlive the request.
- So the rule is: **the setting and the queries must be in the same transaction.** `withTenant` guarantees it by always opening one.
- Outside a transaction, `set_config(…, true)` lasts for one statement only. So a forgotten transaction also fails closed (zero rows).
- Prisma + PgBouncer: PgBouncer ≥ 1.21 handles prepared statements; older versions need `?pgbouncer=true`. On Cloud Run with the Cloud SQL connector you may not need PgBouncer at all. **Watch total connections:** `instances × connection_limit` must stay under Cloud SQL `max_connections`. I do not know your instance's limit. Read it in Phase 0.
- **Test for it** (in 3.3): run requests for tenant A and B *interleaved on a pool of size 1*. B must never see A's rows.

### 3.2 Make forgetting impossible — only the wrapper is exported

```ts
// production/src/server/db/index.ts — the ONLY file allowed to create a PrismaClient.
import "server-only";
import { Prisma, PrismaClient } from "@prisma/client";

// Not exported. Logs in as app_runtime (DATABASE_URL), never as the owner.
const base = new PrismaClient();

export type TenantSession = { userId: string; tenantId: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function check(s: TenantSession) {
  if (!UUID.test(s.tenantId) || !UUID.test(s.userId)) throw new Error("db: no tenant in session");
}

/**
 * Every DB call goes through here. One transaction; the tenant is set first, inside it.
 * Money functions run long — the timeout is raised from Prisma's default 5 s.
 */
export async function withTenant<T>(
  session: TenantSession,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  check(session);
  return base.$transaction(
    async (tx) => {
      await tx.$executeRaw`select set_config('app.tenant_id', ${session.tenantId}, true),
                                  set_config('app.user_id',   ${session.userId},   true)`;
      return fn(tx);
    },
    { timeout: 30_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
}

/**
 * Client-extension form for simple one-query code: each operation is wrapped
 * in its own small transaction with the tenant set first (batched — one round trip).
 */
export function dbFor(session: TenantSession) {
  check(session);
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const [, result] = await base.$transaction([
            base.$executeRaw`select set_config('app.tenant_id', ${session.tenantId}, true),
                                    set_config('app.user_id',   ${session.userId},   true)`,
            query(args),
          ]);
          return result;
        },
      },
    },
  });
}
```

```ts
// Usage — the session comes from Auth.js, never from the request body.
const session = await requireTenantSession();          // throws 401 if not logged in
const invoices = await withTenant(session, (tx) =>
  tx.invoices.findMany({ orderBy: { created_at: "desc" } }));  // no tenant_id needed — RLS does it
```

Four locks, so "forgetting" can't happen:

1. **Nothing to import.** `base` is not exported, and `server-only` makes a browser import fail the build.
2. **Lint:** `no-restricted-imports` blocks runtime imports of `@prisma/client` everywhere except `src/server/db/`. Type-only imports are allowed. The same rule blocks `@supabase/*` in any folder already migrated.
3. **CI grep test:** fails if `new PrismaClient` or `set_config(` appears outside `src/server/db/`.
4. **The database itself:** even if someone gets around 1–3, `app_runtime` with no setting sees **zero rows** (3.1).

### 3.3 Prove it

**Test A: per-table isolation, generated from the live catalog (not a hand list).**
The current e2e test covers only 13 tables (`production/e2e/cross-tenant.spec.ts`). The new one reads the table list from Postgres. A **new table with no test, no RLS or no FORCE fails CI on its own**.

```ts
// production/tests/isolation/every-table.test.ts — runs against staging-like DB in the gate.
const tables = await owner.$queryRaw<{ t: string; rls: boolean; force: boolean }[]>`
  select c.relname as t, c.relrowsecurity as rls, c.relforcerowsecurity as force
  from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id'
  where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'`;

test("there are tenant tables to check", () => expect(tables.length).toBeGreaterThan(100));

describe.each(tables)("$t", ({ t, rls, force }) => {
  test("RLS on and forced", () => { expect(rls).toBe(true); expect(force).toBe(true); });

  test("tenant A CAN read its own row (so an empty result can't fake a pass)", async () => {
    await seedRowFor(TENANT_A, t);
    const rows = await withTenant(A_SESSION, (tx) =>
      tx.$queryRawUnsafe(`select tenant_id from public."${t}" where tenant_id = $1`, TENANT_A));
    expect(rows.length).toBeGreaterThan(0);
  });

  test("tenant A cannot read tenant B", async () => {
    await seedRowFor(TENANT_B, t);                              // owner inserts one B row
    const rows = await withTenant(A_SESSION, (tx) =>
      tx.$queryRawUnsafe(`select tenant_id from public."${t}"`));
    expect(rows.filter((r: any) => r.tenant_id === TENANT_B)).toHaveLength(0);
  });

  test("tenant A cannot write into tenant B", async () => {
    await expect(withTenant(A_SESSION, (tx) =>
      tx.$executeRawUnsafe(`update public."${t}" set tenant_id = tenant_id where tenant_id = $1`, TENANT_B)))
      .resolves.toBe(0);                                        // 0 rows touched
  });

  test("no session setting → zero rows (fails closed)", async () => {
    expect(await runtimeNoTx.$queryRawUnsafe(`select 1 from public."${t}" limit 1`)).toHaveLength(0);
  });
});

test("pool of 1, interleaved A/B requests never mix", async () => { /* 200 alternating calls, assert each sees only its own tenant */ });
```

**Test B: mutation test, proving test A can go red.** It runs in CI on each PR that touches `src/server/db/` or a migration:

1. Copy the DB. Change `current_tenant_id()` to `return (select tenant_id from users limit 1)` (a broken guard). Run test A. **It must fail.**
2. Drop one policy on `invoices`. Run test A. **It must fail.**
3. Remove the `set_config` line from `withTenant`. Run test A. **It must fail** (zero rows where rows were expected, via a "can read own row" check).

If any mutation leaves the tests green, the job fails. In other words, the test suite itself is tested.

### 3.4 The 147 SECURITY DEFINER functions — leave them in Postgres

**Answer: leave them in Postgres and call them. Do not port them to TypeScript.**

Why:
- They are **already tested where they live**. 120 SQL test files, about 15 of them on `record_payment` alone (idempotency, partial pay, overpaid credit, TDS, MRR ex-GST…).
- They hold the rules that must be **atomic**: gapless invoice numbers per tenant per FY (16 chars, CGST Rule 46(b)), s.34(2) credit-note deadlines, whole-rupee amounts. Row locks and a single transaction inside Postgres are the safest place for those. In TypeScript, every round trip is a chance for two payments to race.
- Porting means re-proving all of that for **zero security gain**. ⚠️ Highest-risk work in the whole project for no benefit.

How Prisma calls them (inside the tenant transaction, so `current_tenant_id()` works):

```ts
const result = await withTenant(session, (tx) =>
  tx.$queryRaw<{ record_payment: unknown }[]>`
    select public.record_payment(${quoteId}::text, ${amountRupees}::integer,
                                 ${method}::text, ${reference}::text, ${notes}::text)`);
```

Rules for money calls:
- **Always cast to the exact SQL type** (`::integer` for rupees). A JS `number` like `1500.5` must be rejected before the call. Add a `rupees()` helper that throws on non-integers. ⚠️ Money: if the function is ever called with paise or a float, the amounts go wrong.
- Wrap each function in one typed TypeScript function (`src/server/db/rpc/recordPayment.ts`), so 166 call sites use names, not SQL strings. Prisma TypedSQL can generate these.
- Each definer function also gets `GRANT EXECUTE … TO app_runtime` (and is `REVOKE`d from `PUBLIC`). There's a CI check that every definer function has `SET search_path` (most do already).

### 3.5 Cron jobs — how they reach data across tenants

This is the one place where "everything scoped to one tenant" does not apply. The design:

1. **Separate Cloud Run service `resellersos-jobs`**, same Docker image. Only this service has `JOBS_DATABASE_URL` (login `app_jobs`). The web service does not have that secret, so a bug in a web page **cannot** become a cross-tenant read.
2. **Cloud Scheduler calls it with an OIDC token**, and the service accepts only that identity (Cloud Run IAM). `CRON_SECRET` stays as a second check during the move. A leaked shared secret alone then gets nobody in.
3. **Cross-tenant power is tiny.** `app_jobs` may run a few named functions, e.g. `jobs_list_tenants(job text)` → tenant ids. Then the job does **each tenant's work through `withTenant(systemSessionFor(tenantId), …)`**, under normal RLS. That already matches how the crons are written today: `ads-sync/route.ts:21-30` lists tenants, then loops.
4. The few truly cross-tenant reads (health digest, backups, MRR snapshot) are **named SECURITY DEFINER functions**, granted to `app_jobs` only and tested.
5. Lint: `withJobsScope` is importable only from `src/app/api/cron/**`.

Webhooks (5) and public pages (26) work the same way. They find the tenant from a verified signature or token (a small definer function), then use `withTenant`.

---

## Step 4 — Strangler plan (ordered phases)

Each phase ships on a normal Thursday deploy. Both data paths run side by side until Phase 7. **Rule: no phase starts until the previous one's "done when" is true on production.**

| # | Phase | What ships | Done when | Rough days |
|---|---|---|---|---|
| **0** | **Ground** (= the cheap fix) | Staging exists (R-106) — wire it into the pipeline. Live catalog snapshot (real table, policy and function counts). Prisma installed; `prisma db pull`; baseline migration marked applied. Cloud Build step: Cloud SQL proxy → `prisma migrate deploy` (as owner) → `notify pgrst`. The 120 SQL tests run in the gate against a throwaway DB. | A migration merged on Monday reaches staging, then prod, with no human typing SQL; SQL tests red = deploy stops. | 8–12 |
| **1** | **Roles and helpers** | `app_runtime`, `app_jobs`. `FORCE RLS` on all tenant tables. New `current_user_id()` / dual `current_tenant_id()`. 54 `auth.uid()` → `current_user_id()` in policies and functions. Grants. | PostgREST path still 100% green (e2e money-spine + cross-tenant). Prisma as `app_runtime` with no setting sees 0 rows. | 5–8 |
| **2** | **The safe client + proof** | `src/server/db` (3.2). Lint rules. Isolation test A + mutation test B. Typed RPC wrappers for the money functions. | Test A covers every tenant table from the catalog; all 3 mutations go red; CI blocks a raw import. | 6–8 |
| **3** | **Admin-client clean-up** (biggest security win) | ~170 non-cron admin-client files → `withTenant`. All are server-side already, so it's mostly a mechanical swap. | `createAdminClient` remains only in cron/webhook allow-list files; CI enforces the list. | 15–20 |
| **4** | **Jobs service** | `resellersos-jobs` service, `app_jobs`, OIDC on Scheduler, 26 crons moved one by one. | All 26 run from the jobs service for a full week; web service has no jobs DB secret. | 6–8 |
| **5** | **Browser screens → server**, area by area | The 147 browser-client files become server actions/routes using `withTenant`. Order: **low risk first** (tasks, attendance, contacts, leads, marketing) → reports → **money last** (quotes → payments → invoices → credit/debit notes → GST/books). | Per area: `@supabase/*` import banned in that folder by lint; area's tests green; one week on prod with no incident. | 30–45 |
| **6** | **Files → Cloud Storage** | 24 sites, 4 buckets. Path `tenant/<tenantId>/…`. Signed URLs made server-side after a tenant check. Copy objects; read new → fall back old for 2 weeks. | Old storage gets zero reads for 7 days. | 4–6 |
| **7** | **Login cut-over → Auth.js**, one planned evening | Copy users from `auth.users` (bcrypt hashes → Credentials provider verifies them; Google accounts linked by Google `sub`). Same user ids, so `public.users.id` still matches. Password reset, invites and portal users rebuilt. Everyone signs in once more. | All logins via Auth.js for 2 weeks; GoTrue gets no traffic. | 10–15 |
| **8** | **Remove the VM** | Turn off PostgREST, GoTrue, Storage, Caddy. Remove `@supabase/*`. Drop the PostgREST branch of the helpers, the `service_role USING(true)` policies, and the `anon`/`authenticated` grants. | VM deleted; `grep @supabase` = 0; isolation tests still green. | 3–5 |

**Total: about 90–130 working days.** Phases 0–2 alone (about 4 weeks) already fix manual migrations and give you the safe client.

**Rollback per phase:**
- 0–2: additive only. Revert the commit; old path untouched.
- 3, 5: per area, behind a flag (`DATA_PATH_<area>=supabase|prisma`). Flip back in one deploy. Both paths read the same tables, so there is no data to move back.
- 4: point Cloud Scheduler back at the web service (old routes kept for 2 weeks).
- 6: reads fall back to old storage for 2 weeks.
- 7: GoTrue stays running, untouched, for 2 weeks. Flag `AUTH_PROVIDER=gotrue` brings it back. ⚠️ Users who changed their password in that window would need a reset. That's accepted and written down before the evening.
- 8: only after 2 quiet weeks. A VM snapshot is kept for 30 days.

**Why not a big-bang rewrite:** you would have to test 412 files and the login change on the same day, with paying customers. If anything goes wrong, rolling back means losing a day of payments. The strangler approach means each risky step is small and can be undone. A big bang is not safer here.

---

## Step 5 — Risks (including the ones you didn't ask about)

**Money / GST / numbering — higher risk** ⚠️
1. **Transaction timeouts.** Prisma's default interactive transaction timeout is 5 s. If `record_payment` runs past it, the whole payment rolls back. Set it on purpose (30 s above) and alert on it.
2. **Number types.** Prisma returns `bigint` for `int8` and `Decimal` for `numeric`. If code turns a `Decimal` into a float, or sends paise, rupee amounts go wrong. Use one `rupees()` helper and never do sums in JS.
3. **Gapless invoice numbers** depend on the numbering function's lock happening in the same transaction as the insert. Moving the *caller* must not split one Postgres call into two Prisma calls. Test: 50 parallel invoices for one tenant → numbers 1..50, no gap, all ≤ 16 chars (`document_number_ist_fy_and_length.test.sql` already exists. Keep it in the gate).
4. **Money areas go last** (Phase 5), one at a time, each with a week of watching. Don't start them during GST filing week.

**Security**

5. **Table owner skips RLS.** Today's owner `resellersos_migration` would see everything. That's why we add `FORCE RLS` and use a separate runtime role. If someone ever points `DATABASE_URL` at the owner, test A catches it (the RLS/force check plus fail-closed).
6. **`SET` vs `SET LOCAL`.** One session-level `SET` anywhere leaks between requests. That's why the CI grep and pool-of-1 test exist.
7. **Definer functions skip RLS by design.** They are safe only because they check `current_tenant_id()` inside. Add a test: call each one as tenant A with tenant B's ids → it must refuse.
8. **The app server is trusted with the tenant id.** Today it already is, because it holds the service-role key. No worse than now. The tenant must always come from the Auth.js session, never from the request.
9. **During the move there are two ways in** (PostgREST + Prisma). Isolation tests must run against **both** until Phase 8.

**Things you didn't ask about**

10. **Prisma Migrate doesn't understand policies, functions or triggers.** They live as raw SQL inside migration files. That's fine, but a new table can ship without a policy. Test A blocks that. **Never run `prisma migrate dev` against prod or staging.** Only `migrate deploy` runs in the pipeline.
11. **`prisma db pull` on this schema will need hand fixes** (tables without a primary key, views, generated columns, Postgres enums). I do not know how many until it is run in Phase 0.
12. **An automatic migration can break prod faster than a manual one.** That's why the SQL tests and staging come first, and why every migration must be backward compatible with the running code (add first, remove a release later).
13. **Connection count on Cloud SQL** (the web service, the jobs service, migrations, plus the old PostgREST during the move). I do not know your `max_connections`. Check in Phase 0.
14. ⚠️ **Two-step sign-in (TOTP, R-048) must move too.** The TOTP secrets live in GoTrue's `auth.mfa_factors`. Auth.js has no built-in TOTP, so it has to be built (e.g. `otplib`) and the existing secrets copied over — otherwise staff who turned it on lose it or get locked out. I do not know yet whether GoTrue stores those secrets in a form we can copy; check in Phase 0. **Everyone is logged out once** at the Auth.js cut-over. Tell customers. Portal (customer) users need the same treatment.
15. **Team rhythm.** Four people and AI work by cards with a Thursday deploy. This plan is long, so new features will collide with it. Rule from day one: **new code goes through `src/server/db` only**, so the work left never grows.
16. **Backup and drift scripts** use the Supabase CLI (`backup-db.mjs`, `migration-drift-check.mjs`) and may already point at the wrong database (ADR 0001). Repoint them in Phase 0.
17. **Cost of waiting vs doing:** 4–6 months of senior attention that isn't going into features. Phases 0–3 bring most of the security gain. If time runs short, stopping after Phase 4 is a safe place to pause.

---

## What I need from you before Phase 0 starts

1. A read-only query on the live catalog (I will write it) to get the real table, policy and function counts and `max_connections`.
2. A yes on the new DB roles and on the separate jobs service. Both touch production IAM, so Abhishek (server/deploy) should do them.
3. Staging is back (R-106) — who owns turning its manual `gcloud sql import` step into the pipeline step.

---

## Update 5 Oct 2026 — after merging 43 commits from `manager-pardeep`

- **Staging now exists** (R-106). Phase 0 gets shorter: wire staging into the pipeline instead of building it.
- **Two-step sign-in (TOTP) was added** (R-048). The Auth.js cut-over (Phase 7) now has to carry TOTP over too. Risk 14.
- **The table owner is `resellersos_migration`**, not `resellersos_app` (fixed above).
- **The coupling grew in two days:** admin-client files 210 → 215, browser-client files 142 → 147, `.from('…')` 1,635 → 1,666, `.rpc` 171 → 178. A new SQL test even makes the website insert leads as service_role (`supabase/tests/lead_insert_as_service_role.test.sql`). This is the "what you lose by waiting" point, measured: **add the "new code goes through one DB folder" rule now**, whatever else is decided.

---

## Built — 5 Oct 2026 (card R-161, branch `abhishek-R-161`) — Phases 0–2 + first route

Measured on a local Postgres 17 built from git in production's own order (`production/db/local/build.sh`):
**168 tables (164 with `tenant_id`), 487 policies, 185 SECURITY DEFINER functions** — more than both the prompt (126/366/147) and the repo docs said.

| Piece | Where | Proof |
|---|---|---|
| Prisma 7.10 + `@prisma/adapter-pg`, 169 models | `production/prisma/`, `prisma.config.ts` | `npm run typecheck`, `npm run build` green |
| Baseline + frozen old folder | `prisma/migrations/0_init`, `src/server/db/migrations-frozen.test.ts` | unit test |
| Tenant context: 88 policies + 90 functions moved off `auth.uid()`/`auth.role()` | `prisma/migrations/20261005120000_tenant_context` (generated by `scripts/gen-tenant-context-migration.mjs`) | **SQL suite 117/120 before and after — Supabase path unchanged** (other 3 need live data) |
| Logins `app_runtime` / `app_jobs` | `db/ops/10-runtime-roles.sql` | role checks in the isolation suite |
| The only door: `withTenant`, `dbFor` (client extension), money RPC wrappers, `rupees()` | `src/server/db/` | `import-boundary.test.ts` + lint |
| Jobs: list tenants, then per-tenant work | `src/server/db/jobs.ts`, `migrations/20261005130000_jobs_scope` | isolation suite |
| Proof per table + both paths agree | `tests/isolation/` (`npm run test:isolation`) | **839/839** |
| Proof the proof can fail | `scripts/isolation-mutation.mjs` | **5/5 breakages caught** |
| First route moved (was service-role) | `/api/settings/email-sender` → `src/server/settings/email-sender.ts` | 3 isolation tests; falls back to old code while `DATABASE_URL` is unset |
| Runbook to switch an environment | `production/db/ops/README.md` | — |

**Design changes from §3 above, found while building:**
- **No `FORCE ROW LEVEL SECURITY`.** Production's SECURITY DEFINER functions are owned by the table owner (`resellersos_migration`) and skip RLS *because* they are the owner; forcing RLS would break `record_payment` and friends. The same protection comes from a login that owns nothing and cannot bypass — checked on every run.
- **`auth.role()` is rewritten too, not just `auth.uid()`.** 20 policies and 23 functions trust `auth.role() = 'service_role'`, which reads a setting any connection could set itself. `current_request_role()` fixes it by login role; the Prisma path can never claim `service_role`.
- **`current_tenant_id()` cross-checks the user.** A session naming the wrong tenant for its user gets NULL (no rows), not the other tenant.
- **`_prisma_migrations` is locked** (RLS on, no grants) — PostgREST exposes `public`.

**Not done yet (next cards):** switch staging (runbook), Cloud Build migrate step, move the ~170 admin-client files, crons to the jobs service, browser screens → server, files → GCS, Auth.js (incl. TOTP), remove the VM.
