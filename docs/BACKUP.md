# Backups — how they work, and what they don't cover

_Set up 2026-08-13, after the Supabase dashboard was found showing **`LAST BACKUP: No backups`** on a database holding ₹57L of invoices and ₹52L of payments._

---

## State on 27 Sep 2026 (read this first — the sections below describe August)

Production moved off hosted Supabase to **Cloud SQL `resellersos-db`** (Postgres 17, `asia-southeast1`, project `resellsubsos-prod`). Checked read-only on 27 Sep (S4):

| Layer | State | Gap |
|---|---|---|
| Cloud SQL automated backups | ✅ daily 03:00 UTC, 7 kept, last five all SUCCESSFUL | 7 days only |
| Point-in-time recovery | ✅ on, 7 days of logs | — |
| Deletion protection | ✅ on | — |
| Off-site JSON (`gs://resellsubsos-prod-offsite-backups/daily/`, asia-south2, versioned) | ⚠ **last file 2026-09-03** | Stopped when the scheduler still pointed at the old Mumbai URL (403). Job recreated in asia-southeast1 on 27 Sep; first run 28 Sep 00:00 IST — check that `daily/2026-09-28.json` appears |
| Long retention for GST / income-tax (8 years) | ❌ | `daily/` is deleted after 400 days; nothing longer |
| Outside this project and billing account | ❌ | Bucket and DB share one project + one billing account: a lapsed bill (R-017) or a lost owner account takes both |
| Uploaded files (storage) | ❓ not verified | — |
| Restore rehearsal | ✅ 29 Sep 2026 — offsite `daily/2026-09-29.json` (Cloud SQL era), ANUTECH tenant: 55 tables / 2,637 rows typed-loaded into a local DB at current migrations, counts matched, ROLLBACK; canary (one count off by one) went red | repeat each quarter; a full restore into staging still to do |

**Monthly copy (code, not yet deployed):** from the next deploy, the backup cron also writes `monthly/YYYY-MM.json` on the 1st (IST). For it to outlive 400 days, the bucket's delete rule must skip `monthly/` — run once (replaces the lifecycle; keeps the noncurrent-version rule):

```bash
cat > /tmp/lc.json <<'EOF'
{"rule":[
  {"action":{"type":"Delete"},"condition":{"age":400,"isLive":true,"matchesPrefix":["daily/"]}},
  {"action":{"type":"Delete"},"condition":{"age":3000,"isLive":true,"matchesPrefix":["monthly/"]}},
  {"action":{"type":"Delete"},"condition":{"daysSinceNoncurrentTime":30}}
]}
EOF
gcloud storage buckets update gs://resellsubsos-prod-offsite-backups --lifecycle-file=/tmp/lc.json
```

(3000 days ≈ 8.2 years.) Lifecycle applied 29 Sep 2026 (read back from the bucket). Still open: the copy in a **different project** — project `anutech-backup-vault` created 29 Sep; billing link, bucket and the daily transfer are the commands below (a person runs them); a retention lock (decision); a full restore into staging.

**Second copy (anutech-backup-vault) — LIVE since 29 Sep 2026:** first run SUCCESS, 8 of 8 files copied (2026-08-29 … 2026-09-29), md5 of 2026-09-29.json identical in both buckets; versioning on, same 3 lifecycle rules. The Transfer service agent `project-937079952006@storage-transfer-service` has read-only roles (legacyBucketReader + objectViewer) on the source bucket — nothing else. A daily Storage Transfer job copies `gs://resellsubsos-prod-offsite-backups` → `gs://anutech-backup-vault-copies` (asia-south1, a different region from the source asia-south2), same lifecycle. The vault project holds nothing else, so deleting or breaking `resellsubsos-prod` does not take the copies with it. Same billing account for now — a separate billing account would also survive a billing lapse (Abhishek, R-017).

```bash
gcloud billing projects link anutech-backup-vault --billing-account=016FCA-400F3C-38036D
gcloud storage buckets create gs://anutech-backup-vault-copies --project=anutech-backup-vault --location=asia-south1 --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update gs://anutech-backup-vault-copies --versioning --lifecycle-file=lc.json
gcloud services enable storagetransfer.googleapis.com --project=anutech-backup-vault
gcloud transfer authorize --add-missing --project=anutech-backup-vault
gcloud transfer jobs create gs://resellsubsos-prod-offsite-backups gs://anutech-backup-vault-copies --project=anutech-backup-vault --name=daily-offsite-copy --schedule-repeats-every=1d
```

(`lc.json` = the lifecycle file above. On Windows run these from cmd/PowerShell, not Git Bash — Git Bash rewrites `gs://` and `/` paths.)

## Per-tenant backup (S15, 28 Sep 2026 — code + migration, not yet deployed/applied)

**Why:** `backup_all_tenants()` took every tenant's 145-table snapshot inside ONE transaction,
and `export_snapshots_for_offsite()` returned every tenant in ONE jsonb that the Cloud Run
container held as one string. Fine at 3 tenants; at ~50 it is a long lock-holding transaction
and an object heading for jsonb's 1 GB cap and the container's RAM.

**Now** (`lib/backup/per-tenant.ts`, cron `api/cron/backup`):

| | Before | After |
|---|---|---|
| DB snapshot | 1 RPC, all tenants, 1 transaction | `backup_tenant(tenant)` per tenant, own transaction, 3 at a time |
| Off-site object | `daily/YYYY-MM-DD.json` (all tenants) | `daily/YYYY-MM-DD/<tenant_id>.json` + `daily/YYYY-MM-DD/_manifest.json` |
| Monthly (1st, IST) | `monthly/YYYY-MM.json` | `monthly/YYYY-MM/<tenant_id>.json` |
| One tenant fails | whole route 500, **no off-site copy for anyone** | that tenant reported (500 still), every other tenant snapshotted AND uploaded |
| In-DB restore points | newest 30 per tenant | newest **7** (`backup._take`; UI constant `SNAPSHOT_RETENTION`) |

Each per-tenant file is the same envelope as before with one snapshot in `snapshots[]`, so
`node scripts/gen-restore-rehearsal.cjs <file> <tenant_id> out.sql` works on it unchanged.
Prefixes are still `daily/` and `monthly/`, so the lifecycle rules above apply as-is.

**Deploy order does not matter.** If the migration is not applied yet, the cron sees
"function not found" on the first tenant and runs the OLD sweep + combined object that night
(logged `[cron/backup] backup_tenant() nahi mila`).

**Retention 7 note:** the 7 includes manual and pre-reset snapshots — a pre-reset safeguard is
now pushed off after 7 nightly runs (was 30). Off-site keeps 400 days of dailies.

### Steps for Pardeep

```bash
# 1. Apply the migration on Cloud SQL, as the role that owns the backup functions (same as cloudsql/07):
gcloud sql connect resellersos-db --user=postgres --database=resellersos --project=resellsubsos-prod
#   resellersos=> SET ROLE resellersos_migration;
#   resellersos=> \i production/supabase/migrations/20260928141000_backup_per_tenant.sql
#   resellersos=> RESET ROLE;
#   (PostgREST: notify pgrst, 'reload schema';  — so /rpc/backup_tenant is visible)

# 2. Verify in a SEPARATE session — must print PASS (it rolls back):
#   resellersos=> \i production/supabase/tests/backup_per_tenant.test.sql

# 3. After the next deploy, trigger once and read the result (mode must be "per-tenant"):
gcloud scheduler jobs run resellersos-backup --location=asia-southeast1 --project=resellsubsos-prod
gcloud storage ls gs://resellsubsos-prod-offsite-backups/daily/$(TZ=Asia/Kolkata date +%F)/
gcloud storage cat gs://resellsubsos-prod-offsite-backups/daily/$(TZ=Asia/Kolkata date +%F)/_manifest.json
#    → tenant_count = number of tenants, "missing": []
```

## The situation (August 2026)

The project was on the Supabase **free plan**, which has **no automatic backups and no PITR**.

There was already an in-app snapshot feature (`/settings/backup`, migrations `0210`–`0212`), and its own migration header is honest about why it exists: *"the free Supabase plan has no automatic backups / PITR"*. But those snapshots are written to `backup.snapshots` — **a table inside the same database**.

| Protects against | In-app snapshot | This backup |
|---|---|---|
| A bad UPDATE / accidental delete | ✅ yes | ✅ yes |
| Losing the database itself (project deleted, account/billing issue, region failure) | ❌ **no** — the snapshot goes with it | ✅ yes |

**A copy stored inside the thing it is backing up is an undo button, not a backup.** Both are worth having; only one survives losing the database.

---

## Taking a backup

```bash
cd production && npm run backup:db
```

Writes a timestamped JSON to **`C:/dev/resellersos-backups/`** — deliberately **outside the git repo**, because the dump contains customer PII (names, emails, phones, GSTINs) and must never be committed.

**Needs no token.** It runs through the **Supabase CLI**, which is already logged in (`npx supabase login`), and every query is a `select`.

> ### ⚠️ This script was silently broken from ~13 Aug to 19 Aug 2026. Read why before trusting any backup.
>
> It used to talk to the `@supabase/mcp-server-supabase` MCP server, which authenticates with a PAT from `SUPABASE_ACCESS_TOKEN`. On this machine that variable holds a **malformed value** (see [WORKING-ENVIRONMENT.md §2](WORKING-ENVIRONMENT.md)), so every run got `Unauthorized` — and the parser turned that into `rows(...).map is not a function`, a message that names nothing.
>
> **On the free plan there is no PITR and no automatic backup.** So for six days the entire safety net was one stale file from 13 Aug, and nothing said so. Two things changed on 19 Aug:
>
> 1. **Transport → the CLI**, which needs no token and is the path everything else in this repo already uses.
> 2. **Every parse failure now throws.** The old code returned `[]` on anything it could not read, and its own comments record the result: a run that once wrote a "backup" with zero tables. An empty backup is indistinguishable from a real one on the day you need it.
>
> **Still check the counts after a run.** Loud failure covers a broken query; it cannot tell you a table was emptied by mistake.

### What a run captures (verified 2026-08-19)

| | |
|---|---|
| Tables | 96 |
| Rows | 933 |
| Columns | 1,488 |
| RLS policies | 290 |
| Functions | 144 (full `pg_get_functiondef` source) |
| Triggers | 56 (full `pg_get_triggerdef`) |
| Indexes | 346 |
| Constraints | 534 |
| Applied-migration ledger | 247 records |

> **Rows went DOWN, 1,210 → 933, and that is correct.** It looks exactly like a
> half-captured backup, so it was checked rather than assumed: every table's count
> was compared against a live `count(*)` through a *different* connection (the
> read-only MCP user) — leads 18, customers 15, quotes 27, payments 24, tenants 2,
> contacts 17, tasks 37, activity_log 378 — and all of them match to the row. The
> drop is real deletion of test data between 13 and 18 Aug (3 test tenants, and the
> whole `project_*` set). Table count rose 80 → 96 over the same period.
>
> Do this comparison whenever a dump shrinks. "Fewer rows" and "broken backup" look
> identical in the output, and only one of them is safe to ignore.

Schema definitions are captured **live from the database, not from git**, and that is deliberate — see the drift note below.

---

## Cloud SQL backup → real restore test (R-887, 16 Oct 2026)

The 29 Sep rehearsal proved the **off-site JSON** restores. It never touched a **Cloud SQL backup file**. `production/scripts/ops/backup-restore-test.mjs` does exactly that: it restores the latest SUCCESSFUL backup of an instance into a brand-new temporary instance (`r887-restore-test-<yyyymmddhhmm>`), runs one read-only `count(*)` per key table (tenants, users, customers, invoices, payments, subscriptions, employees, activity_log) plus the migration-ledger tail, compares them with minimums (`--min=table=N`), and deletes the clone in a `finally` block. The source instance is only described and listed — never written.

```bash
cd production
# Dry run (default): prints every gcloud/psql command it WOULD run + the cost note. Runs nothing.
node scripts/ops/backup-restore-test.mjs --instance=resellersos-staging-db

# Real run — creates a BILLABLE clone (Pardeep's haan first). Needs --run, your public IPv4 and the typed phrase.
node scripts/ops/backup-restore-test.mjs --instance=resellersos-staging-db --client-ip=<your public IPv4> \
     --run --confirm="RESTORE TEST resellersos-staging-db"
# The live instance (resellersos-db) is refused unless --allow-live-source is added as well.
```

Guards: `--run` without the exact phrase `RESTORE TEST <instance>` creates nothing; the clone opens its public IP only to `--client-ip/32`, has no backups and no deletion protection; the delete never targets a name outside `r887-restore-test-*`; if the delete fails the script prints the exact `gcloud sql instances delete …` to run by hand. Cost: roughly ₹2–4 for a staging-tier clone, ₹8–16 for a live-tier one (30–60 min). Tests: `npx vitest run tests/ops/backup-restore-test.test.ts` (gcloud/psql mocked). Expected cadence: once before the 20 Oct cutover against the live instance's backup, then quarterly with the off-site rehearsal.

## 🔴 Restore rehearsal — attempted 2026-08-13, and it found a blocker BEFORE the rehearsal

A live rehearsal needs somewhere to restore *into*: no Docker, no `psql`, no local Postgres on this machine, and `supabase start` needs Docker. So before asking anyone to install a stack, the cheaper question was asked first: **could a restore even work?**

```bash
cd production && npm run backup:check
```

**Answer: no — not today.** The assumed recipe is "create the schema from git migrations, then insert the backup's data". But:

> **11 tables exist in prod that git's migrations cannot create. 6 of them hold data — including `contacts` with 58 rows.**

| Table | Rows | In git? |
|---|---|---|
| `contacts` | 58 | 6 migrations **ALTER** it — **none CREATE it** |
| `support_plans` | 4 | not mentioned at all |
| `reimbursements` | 3 | 1 ALTER, no CREATE |
| `campaign_templates` | 3 | not mentioned at all |
| `prepaid_advances` | 1 | not mentioned at all |
| `support_sync_outbox` | 1 | not mentioned at all |
| `campaigns`, `campaign_sends`, `employee_documents`, `po_bill_allocations`, `whatsapp_messages` | 0 | not creatable (empty, so lower risk) |

These were created straight in prod via Studio/MCP; only later *alterations* were ever committed. It is the same drift `0003` and `0146` captured before, and `PROJECT-KNOWLEDGE` §14 predicted the remainder — now measured exactly.

**Mitigation already in place:** the backup captures **columns, 430 constraints, indexes and RLS policies** for all 11, so their definitions are recoverable *from the backup* even though git can't produce them. (Constraints were added on 2026-08-13 precisely because of this — without them the backup knew a table's columns but not its rules.)

**Proper fix, not yet done:** generate a `0224_capture_remaining_drift.sql` from the captured definitions — exactly what `0146` did — so git can rebuild prod again. **Do that before the live rehearsal**, otherwise the rehearsal only re-discovers this slowly.

What the check confirmed is fine:
- every populated table's rows match its captured columns (an INSERT would not fail on unknown columns)
- 8 FK references point at `auth.users` — which is **not** in the backup (see below)

## ⚠️ What this does NOT cover

Be clear-eyed about the gaps:

1. **Not a `pg_dump`.** There is no ready-to-run restore script. Restoring means recreating the schema from `production/supabase/migrations/` and re-inserting the JSON data in FK order. **This has never been rehearsed.** An untested restore is a hope, not a plan.
2. **Auth users are not included.** `auth.users` lives outside the `public` schema. Logins would have to be re-created; `public.users` rows reference `auth.users(id)`.
3. **Storage buckets are not included** — TDS certificates (`tds-certificates`), payment receipts, uploaded documents, tenant logos.
4. **It is manual.** Nothing runs it on a schedule yet. A backup you have to remember is a backup you will forget.
5. **Point-in-time recovery is impossible.** You can only go back to the last time someone ran it.

---

## The proper fix (needs a decision + a credential)

Ranked by value:

1. **Supabase Pro (~$25/mo)** — daily automatic backups + 7-day PITR, covering auth, storage and schema. This is the real answer, and the cheapest hour of insurance available for a database with ₹57L of invoices in it. GST records are legally required to be retained.
2. **`supabase db dump`** — the CLI is already installed (v2.114.0), but the project is **not linked** (no `config.toml`, no project ref stored) and linking needs the **database password**. That produces a genuine, restorable `pg_dump`.
3. **Schedule whichever you choose**, and **rehearse one restore** into a scratch project.
   **✅ REHEARSED — 1 Sep 2026.** Kal raat ke offsite JSON (`daily/2026-09-01.json`) se
   ANUTECH tenant ke **46 tables / 1,993 rows** ek scratch schema me `jsonb_populate_recordset`
   se **typed** load hue, har table ki ginti backup se milayi gayi, aur poora kaam ROLLBACK
   hua (prod par koi nishaan nahi). Canary bhi chala: ek ginti jaan-boojh kar bigaadi to run
   laal hua — matlab green asli tha. Dobara karne ke liye:
   `node scripts/gen-restore-rehearsal.cjs <backup.json> <tenant_id> out.sql` →
   `supabase db query --linked -f out.sql`. **Jo ab bhi backup ke BAHAR hai: auth-users aur
   storage-files** — data lautne par bhi login nahi lautega; ye agla kaam hai.

Until one of those lands, `npm run backup:db` **before any risky change** is the floor — not the ceiling.

---

## Drift note — why live schema is captured

The applied-migration ledger in prod holds **247 records; git holds 194 `.sql` files, and 190 prod records have no matching file.** Most are the descriptive names Studio/MCP assigns (`init_multi_tenant_schema`, `fix_users_infinite_recursion`, …) for changes later consolidated into git — `0003_freeze_baseline.sql` folded in 19 of them, `0146` captured more.

The practical consequence: **git alone cannot reliably reconstruct production.** That is exactly why this backup dumps live policies, functions and triggers rather than trusting the migration files — and why the read-only MCP config exists, so this gap stops widening.

*(Bug worth remembering: the first version of this script used `information_schema.triggers`, which only reports triggers on tables the caller owns — it returned **0** while 46 existed. A silently incomplete backup is more dangerous than none, because you stop worrying. It now reads `pg_trigger`.)*
