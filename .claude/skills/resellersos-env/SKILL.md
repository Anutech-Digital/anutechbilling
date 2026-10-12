---
name: resellersos-env
description: How to actually reach this project's database, deploy, and prove a change on THIS machine — the access paths that work, the ones that look like they work and do not, and the commands that have silently lied here before. Load this before running any Supabase command (`supabase db query`, `db push`, `migration repair`), before running a build or dev server, before deploying to Cloud Run, and before concluding "there is no data" or "I have no DB access" from a failed call. Also covers the OTHER half of this stack — DMS, the hosting/domain app in a separate repo, which serves the local site on 4310 and whose `/` redirects here, so read this before concluding DMS is broken or that hosting/domain code lives in this repo. Not about code patterns — for multi-tenant/pricing/RLS conventions read production/CLAUDE.md, which loads on its own.
---

# ResellerOS — working environment

> ## ⛔ STALE SINCE 6 SEP 2026 — §1, §2 and §6 DO NOT POINT AT PRODUCTION
>
> **Production is Cloud SQL `resellersos-db`** in the GCP project `resellsubsos-prod`, behind a
> self-hosted Supabase data plane at `https://api.anutech.in`. See
> [docs/adr/0001-database-on-cloud-sql.md](../../../docs/adr/0001-database-on-cloud-sql.md)
> (cut-over commit `8a25d726`) and [docs/DEPLOY-S2-S5.md](../../../docs/DEPLOY-S2-S5.md).
>
> **The hosted Supabase project `ontpnqjoysjgrlsukecm` that §6 calls "the real one, linked" is
> now STAGING.** So `npx supabase db query --linked` still works, still returns rows, and is
> answering about the wrong database. That is worse than an error: on 1 Oct 2026 this skill
> sent a session looking for a production list (R-039) through that door, and had the login
> succeeded it would have produced a confident list of customers from staging and called it
> production — AGENTS.md §2 exactly, a failure wearing the costume of a plausible value.
>
> Reach production through gcloud instead:
>
> ```bash
> gcloud sql connect resellersos-db --user=postgres --database=resellersos --project=resellsubsos-prod
> ```
>
> §3 (prove behaviour in a rolled-back transaction), §4 and §5 are about method and still hold.
> The rest of §1/§2/§6 describes staging — useful, but say which one you are on before quoting
> a row count from it.
>
> Left in place rather than deleted, for the reason §2 already gives about itself: this file's
> value depends on a reader seeing that its claims decay.

Everything here was **measured on this machine**, and most of it exists because a session
already got it wrong once. Full write-up: [docs/WORKING-ENVIRONMENT.md](../../../docs/WORKING-ENVIRONMENT.md).

**This file is about ACCESS, not about code.** Multi-tenant rules, the 2-tier pricing model,
commitments, RLS conventions, Indian-market formatting → `production/CLAUDE.md` (42KB, loads
automatically). Do not duplicate them here; a second copy is a second thing to go stale.

---

## 0. The stack has TWO halves — the other one is a different repo

Hosting and domains are not in this repo. They live in **DMS**
(`C:/xampp/htdocs/Domain-Management-Project`) — Next.js 15 + MongoDB + Redis, with its own
admin panel, its own customer panel and **its own test suite**. The two are federated:
ResellerOS reads DMS over an HTTP API and hands users over with a signed SSO token.

| | where | how |
|---|---|---|
| ResellerOS | `localhost:4320` | `npm run dev -- -p 4320` in `production/` |
| DMS | `localhost:4310` | `docker compose up -d --build` in the DMS repo |
| Supabase | 14321 / 14322 | ResellerOS only |
| Local inbox | 14324 | ResellerOS only |

Three things that will otherwise cost a session:

- **ResellerOS is DMS's front door.** With `NEXT_PUBLIC_RESELLEROS_URL` set (it is, as a
  docker-compose build arg), DMS's `/` 307s to `localhost:4320`, as do `/privacy`,
  `/terms-and-conditions`, `/cancellation-refund`, `/contact` and `/about` for non-admins.
  **So if ResellerOS is not running, DMS looks like a dead site.** That is the redirect
  working, not a fault — start ResellerOS before concluding anything about DMS.
- **`NEXT_PUBLIC_*` in DMS is a BUILD arg, not runtime.** Changing one needs
  `docker compose up -d --build`; setting it on the running container does nothing. It is
  declared in both Dockerfile stages, because the builder copy feeds the client bundle and
  the runner copy feeds the server components.
- **DMS has a separate gate.** `npx vitest run` + `npx tsc --noEmit` in the DMS repo. A
  change spanning both repos must be green in both, and neither suite knows about the
  other. A targeted run is not the gate there — one function had coverage in two test
  files and only the full suite caught the second.

Open items for the integration live in `Todos.md` at this repo's root, not here.

---

## 1. Supabase: two doors, and one of them is painted on

| Door | Works? | Use it for |
|---|---|---|
| `npx supabase db query --linked` (CLI) | ✅ reads **and** DML | anything that writes, and rollback-style proofs |
| MCP `supabase-db` (user-scoped) | ✅ but **read-only** | quick reads, schema, `pg_policies` |
| MCP `supabase` (project `.mcp.json`) | ❌ **always `Unauthorized`** | nothing — see below |

**`env -u SUPABASE_ACCESS_TOKEN` is no longer needed. Measured 28 Aug 2026.** The variable
is set NOWHERE — not in the shell, not in the Windows User env, not in Machine env — and
`npx supabase projects list` returned all three projects with no prefix at all.

> This paragraph previously read "**Every CLI command needs `env -u SUPABASE_ACCESS_TOKEN`**
> — that variable is set to a wrong value on this machine and the CLI reads it *before* the
> stored login." That was true when written. It is the third claim in this file to go stale,
> which is the point §2 makes below: **do not remember the door, try it.**

The prefix is harmless if you keep typing it, so old copy-pasted commands are not wrong —
just be clear that it treats a disease this machine no longer has.

```bash
npx supabase db query --linked "select 1"
```

If `Invalid access token format` ever appears again, check the variable FIRST — it is not a
version problem (same CLI 2.115.0 on both machines):

```powershell
[Environment]::GetEnvironmentVariable("SUPABASE_ACCESS_TOKEN","User")
```

And keep the two failures apart: that error is a bad token, while
`LegacyDbConfigLoginRoleNetworkError` is transient — **retry once** before diagnosing.

**Retry once before diagnosing.** Measured 24 Aug: `migration repair` failed with
`LegacyDbConfigLoginRoleNetworkError: failed to initialise login role: TransportError` and the
identical command succeeded on the next attempt, seconds later. It is a transient network
failure on the CLI's login-role step, not a wrong token and not a wrong command — and it looks
alarming enough to send you rewriting something that was already correct.

**Do not ask Pardeep for a token.** He is already logged in (`npx supabase login`). Asking is
the failure mode, not the fix.

### ⚠️ `Unauthorized` does not mean "no database access"

The project `.mcp.json` server declares `"${SUPABASE_ACCESS_TOKEN}"`, which does not expand
here. On 14 Aug a session read a failure like that as "I have no DB access", started guessing
at schema, and invented tables (`payroll_runs`, `quote_items`) that do not exist. **Read
`Unauthorized` as "wrong door", walk to the CLI, and keep going.**

## 2. What you may and may not run

> **Both bullets below were rewritten on 24 Aug 2026 because both had gone false.** They are
> left visible rather than quietly replaced: this file's own value depends on knowing that its
> claims decay, and a reader who has memorised the old version needs to see it change.

- **DDL through the CLI works.** The previous version said "DDL is blocked by the auto-mode
  permission classifier — `create function`, `create policy`, and any `-f` file containing
  them". Measured 24 Aug: `db query --linked -f` ran a migration containing `create table`,
  `alter table`, `create policy` and `create index` and returned exit 0, and every object was
  verified present afterwards. Whatever blocked it before does not block it now.
  **MCP is still genuinely read-only** — that half was and remains true.
- **`supabase db push` was dangerous here. As of 24 Aug 2026 the drift is 0.** The old text
  said "29 local migrations are missing from remote tracking… a push re-applies ~28
  already-applied files". That was true and it was worth obeying — on 24 Aug the drift was
  down to 5, and pushing would have run a **money data-repair migration** as a side effect of
  wanting one unrelated schema change. All five are now applied-and-tracked, and
  `migration list --linked` shows `local == remote` for every local file.
- **Do not trust the sentence above either — run the check.** It costs one command:

  ```bash
  cd production && env -u SUPABASE_ACCESS_TOKEN npx supabase migration list --linked
  ```

  Any row with a `remote` and no `local` is history (pre-Aug migrations live in
  `supabase/migrations-archive/`) and push ignores it. Any row with a `local` and no `remote`
  is what push would run. **Read that list, not this paragraph.**

- **Applying one migration without pushing all of them:**

  ```bash
  cd production && env -u SUPABASE_ACCESS_TOKEN npx supabase db query --linked -f supabase/migrations/<file>.sql
  env -u SUPABASE_ACCESS_TOKEN npx supabase migration repair --status applied <version>
  ```

  `migration repair` only writes the tracking table — it runs none of the migration's SQL. So
  **verify the objects actually exist before repairing**, or you permanently mark an unapplied
  change as applied and it can never run again. On 24 Aug two of four "already applied"
  migrations turned out genuinely unapplied; marking all four would have buried both.

## 3. Proving DB behaviour without leaving a trace — the pattern that works

> Was titled "without DDL" while §2 believed DDL was blocked. The pattern never depended on
> that, and it matters more now that DDL *does* go through: the reason to wrap a proof in
> `rollback` is that this is the production database, not that the tool would stop you.

DDL is transactional in Postgres and `db query -f` honours transaction boundaries, so a test
file can build a scenario, assert against it, and `rollback` — **safe on production**.

```
begin;
  -- synthetic rows in a synthetic tenant
  set local role authenticated;                       -- so RLS is actually enforced
  perform set_config('request.jwt.claims',
    json_build_object('sub', <uuid>, 'role','authenticated')::text, true);  -- becomes auth.uid()
  -- assertions: raise exception on FAIL
rollback;
```

Worked examples:
[users_privileged_columns_owner_only.test.sql](../../../production/supabase/tests/users_privileged_columns_owner_only.test.sql) ·
[portal_customer_users_no_self_update.test.sql](../../../production/supabase/tests/portal_customer_users_no_self_update.test.sql) ·
[ai_sales_agent_tenant_isolation.test.sql](../../../production/supabase/tests/ai_sales_agent_tenant_isolation.test.sql)
(composite-FK tenant isolation, and `on delete` behaviour — the pattern for asserting that a
DELETE *succeeds*, not just that it is refused)

**Prove the harness fails before believing that it passed.** These files report success by
exiting 0, which is also what a file that silently did nothing returns. Measured 24 Aug: a
one-line file containing `raise exception` exits **1** with the message surfaced, so exit 0 is
a real pass here. Then mutate one assertion and confirm it goes red — two mutations on the
file above turned up red, which is what makes its green meaningful.

**Two rules that came out of writing these.** A superuser connection is not useless for
RLS/`auth.uid()` tests — it takes carve-outs only because it has no `auth.uid()`, and
`set_config` supplies one. And **assert on the specific error message, not on "0 rows
changed"** — a row-count assertion passes for the wrong reason when RLS refuses the row, and
keeps passing the day the trigger it was meant to guard is dropped.

## 4. Commands that have lied here

- **`npm run build` while the dev server is up wipes `.next`** — the running page then 404s
  its own chunks and looks broken. Stop the dev server first, or do not build.
- **Never pipe a command whose exit code matters.** `… | tail` hid a deploy failure and the
  session reported success. Use `${PIPESTATUS[0]}`, or do not pipe.
- **The DB backup fails loudly now, but used to fail quietly** — see §5.

## 5. Backups (free plan: no PITR, no automatic backups)

`cd production && npm run backup:db` → timestamped JSON in `C:/dev/resellersos-backups/`
(outside git — it contains customer PII).

It ran on the MCP server until 19 Aug 2026 and was **silently broken for six days** — the
malformed token above meant `Unauthorized`, and the parser degraded that to an empty result.
It now runs on the CLI (no token) and **throws on any unparseable response**.

Last known-good: **114 tables / 1,645 rows** (24 Aug 2026, after the AI-support-agent and
draft-feedback migrations; all 10 key tables matched live exactly). Earlier markers:
112 / 1,434 and 110 / 1,432 (24 Aug), 96 / 933 (19 Aug).

**And the script was rewritten that night, because it had stopped working.** It ran one
`npx supabase db query` PER TABLE — about 120 process launches — and after a heavy session
Windows refuses to start them: `supabase db query exited 3221225794` (0xC0000142,
STATUS_DLL_INIT_FAILED). It failed twice in a row, at DIFFERENT tables, while a single query
by hand returned exit 0. It is now three launches total: one for the table list, one
`union all` covering every table, one `jsonb_build_object` covering all seven schema reads.
If you see that exit code from anything else on this machine, suspect process count first.

Note what the table count does: it goes UP when a migration adds tables, so a jump of two is
a migration and not a bug. It is the per-table row comparison that tells you whether coverage
is intact.

If a dump comes back smaller, do not assume either way — compare per-table counts against a
live `count(*)` through a different connection. A shrinking dump and a broken dump look
identical.

**And FILE SIZE is not the check.** Measured 24 Aug: the new dump was **1.66 MB against the
22 Aug dump's 2.12 MB** — 22% smaller — while holding *more* rows. Byte size tracks whatever
large text a table happens to hold (screenshots, snapshot blobs), not coverage. The per-table
comparison settled it in one query; the size difference would have sent you hunting a
non-existent bug. On 24 Aug all 9 key tables matched live exactly.

**Diffing a backup against live is also how you prove a data migration did only what it
claimed.** After the GST repair on 24 Aug, comparing the pre-change dump's `quotes` amounts
against live showed `rows changed: 1, total delta: 8165` — which is a far stronger statement
than "exit code 0", and it is the only thing that would have caught a second row moving.

## 6. Which Supabase project

`ontpnqjoysjgrlsukecm` is the real one, and `--linked` already points there — **verified
24 Aug**, do not re-link on a hunch. Open by ref, never by name.

Measured 24 Aug 2026 (`supabase projects list`) — **three** projects on the account, not the
"a second project exists" this section said until today:

| Ref | Name | Region | Status |
|---|---|---|---|
| `ontpnqjoysjgrlsukecm` | resellersos | ap-south-1 | **ACTIVE — the live one, linked** |
| `ixgvlbgmvgaihvudtbwt` | resellerosv3-staging | ap-south-1 | active — has a branch **labelled "PRODUCTION" that is not** |
| `ruaupcicjrdztabzwurx` | Google Workspace Sales Website | us-east-1 | inactive |

The trap is the middle row: its branch name says PRODUCTION and it is staging. Two of the
three are `ap-south-1`, so region does not disambiguate either. **Match the ref.**

`current_database()` is `postgres` on every Supabase project, so it cannot tell them apart.
To confirm which one you are actually on, check a fingerprint instead:

```sql
select (select count(*) from tenants) tenants, (select count(*) from quotes) quotes;
-- live on 24 Aug 2026: tenants 3, quotes 20
```

## 7. Tenants: never identify one by name

Tenant names are auto-derived from an email domain, so a wrong tenant can look like the right
one. Always check `tenant_id`. Measured 24 Aug 2026 — **three**, not the two this section
claimed until today:

| Tenant | `tenant_id` | Users | What it is |
|---|---|---|---|
| ANUTECH DIGITAL PVT LTD | `fbb976f1-9090-4f10-9726-0901bd144e42` | 10 | the live business (`distributor`) |
| Client A | (id on the board / DB) | 1 | historical, and **still holds real money** |
| Client C | `7e57e57e-0000-4000-8000-000000000001` | 1 | `reseller` |

**Do not read "historical" as "empty".** Client A holds `Q-2026-9776` — the quote
whose missing ₹8,165 of GST was repaired on 24 Aug. A tenant nobody logs into is exactly where
a money defect survives longest, because nobody is looking at the screen it is wrong on.

**Count the tenants, do not quote this table.** It has been wrong once already:

```sql
select t.name, t.id, (select count(*) from users u where u.tenant_id = t.id) as users
from tenants t order by users desc;
```
