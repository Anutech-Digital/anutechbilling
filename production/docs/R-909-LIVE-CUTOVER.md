# R-909 — Live ko Supabase se hata kar staging jaisa banana (runbook)

Card **R-909** · owner **Pardeep** · prepared 10 Oct 2026 (nothing in GCP was changed while writing this).

| Kab | Kya |
|---|---|
| **15 Oct tak** | Rehearsal: live DB ka clone, us par poora DB step, staging se schema match (section 4.4) |
| **17 Oct, 17:00 IST ke baad** | Cutover — har step par Pardeep ki haan (section 8) |
| **18–19 Oct** | Poora flow test (visible browser) + test data ki safai |
| **20 Oct** | Live par asli data shuru |

Helpers (both **dry run by default** — they only print commands until you add `--run` / `RUN=1`):

- `production/scripts/ops/r909-live-cutover.mjs` — secrets, bucket, Cloud Run env, deploy trigger, scheduler, deploy push, traffic.
- `production/scripts/ops/r909-live-db.sh` — DB: roles, migrations, fingerprint export, compare.
- `production/scripts/ops/r909-schema-fingerprint.sql` — the read-only schema hash query the DB script exports.

Rule used everywhere: every fact below comes from the staging branch code (`anutech/staging` @ `80d85885`, 10 Oct) or a
read-only `gcloud describe/list` run on 10 Oct. Anything else says **not verified**.

---

## 1. Abhi kya hai (10 Oct, measured)

| | Live `resellersos` | Staging `resellersos-staging` |
|---|---|---|
| Image | `…/resellersos:5fb1783` (revision `resellersos-00035-prc`, 100%) | `…/resellersos-staging:1c2a399` |
| Domains | `reselleros.anutech.in` and `anutech.in` (domain mappings) | run.app URL only |
| Cloud SQL | `resellersos-db` (POSTGRES_17, db-custom-1-3840, PITR on) | `resellersos-staging-db` (db-f1-micro) — cloned from live 3 Oct, rows wiped |
| DB logins | `authenticator, postgres, resellersos_app, resellersos_migration, supabase_auth_admin, supabase_storage_admin` | same **+ app_anon, app_auth, app_jobs, app_runtime, app_service** |
| Memory | 512Mi, min 1 / max 3, CPU always on | 1Gi, min 0 / max 3 |
| Browser build (`NEXT_PUBLIC_*`) | trigger `resellersos-deploy-on-push` (branch `^deploy$`) has **no substitutions** → cloudbuild.yaml defaults: `_SUPABASE_URL=https://api.anutech.in`, gateway/auth switches **off** | trigger `resellersos-staging-on-push`: `_DATA_GATEWAY=1`, `_AUTH_PROVIDER=authjs`, `_SUPABASE_URL=<staging>/api/sb` |
| Data plane | VM `supabase-gateway` — **TERMINATED** (disk + daily snapshots till 9 Oct still exist) | none (in-app gateway) |
| Files | Supabase Storage on the VM disk (`STORAGE_BACKEND: file`, phase2 docker-compose) | GCS `resellsubsos-staging-files` |
| Crons | 15 Cloud Scheduler jobs (asia-southeast1) → live run.app URL, `Authorization` header | none, on purpose |

So live today still points every browser and server call at `api.anutech.in`, whose VM is stopped. Live is therefore
**expected not to work today** (not checked by request — nobody uses it).

**Live DB is behind staging.** Cloud SQL import history (read-only `gcloud sql operations list`):
live's last schema import was **6 Oct** (feedback_checked, undeposited_funds, r205). Staging has since had: the R-161
roles + Prisma steps (5–6 Oct), `20261004100000_email_verifications`, **all 59 files** of
`supabase/cloudsql/staging/deploy-db-2026-10-07.sh` (7–10 Oct), `r529` grants, and ~20 hand-run fix files whose content is
not in git (`own-fix.sql`, `own-fix2.sql`, `interns.sql`, `10-svc-1006.sql`, `mfa.sql`, …). Section 4 deals with that.

---

## 2. Env / secret diff (live vs staging)

Source: `gcloud run services describe` of both services; env names read in `src/` of the staging branch.

### 2.1 Add to live (all NEW values — nothing copied from staging)

| Env on Cloud Run | Where the value comes from | Secret name (new) | Why (code) |
|---|---|---|---|
| `DATA_GATEWAY=1` | plain | — | `src/server/postgrest/fetch.ts` gatewayEnabled() |
| `AUTH_PROVIDER=authjs` | plain | — | `src/server/auth/authjs.ts` |
| `AUTH_URL=https://reselleros.anutech.in` | plain | — | staging 6 Oct: without it Auth.js sends Google `https://0.0.0.0:8080` (r161-step4 comment) |
| `STORAGE_BACKEND=gcs` | plain | — | `src/server/storage/backend.ts` |
| `GCS_BUCKET=resellsubsos-live-files` | plain | — | same; bucket is new (section 5) |
| `DB_POOL_MAX=3` | plain | — | `src/server/db/gateway.ts`, `auth-store.ts` |
| `DATABASE_URL` | built from app_runtime password | `live-database-url` | gateway "user" pool |
| `ANON_DATABASE_URL` | app_anon | `live-anon-database-url` | gateway "anon" pool |
| `SERVICE_DATABASE_URL` | app_service | `live-service-database-url` | gateway "service" pool (createAdminClient) |
| `AUTH_DATABASE_URL` | app_auth | `live-auth-database-url` | `src/server/db/auth-store.ts` |
| `JOBS_DATABASE_URL` | app_jobs | `live-jobs-database-url` | `src/server/db/jobs.ts` (parity with staging) |
| `SUPABASE_JWT_SECRET` | **new random** 32 bytes | `live-supabase-jwt-secret` | verifies every gateway token + mints user tokens (`identity.ts`, `supabase-jwt.ts`) |
| `AUTH_SECRET` | **new random** 32 bytes | `live-auth-secret` | Auth.js session cookies |
| `SUPABASE_SERVICE_ROLE_KEY` | **re-minted** HS256 `role=service_role` with the new JWT secret | `live-service-role-key` | still required: `createAdminClient()` throws without it; the gateway accepts it only in-process |
| memory `1Gi` | flag | — | staging 6 Oct: 512Mi ran out of heap with the gateway |

The DB URL shape (from r161-step3): `postgresql://app_<role>:<pw>@localhost/resellersos?host=/cloudsql/resellsubsos-prod:asia-southeast1:resellersos-db`
— Cloud Run already has `resellersos-db` attached, so no new connection/IP is opened.

Each DB password is generated inside `r909-live-db.sh` (32 random bytes), the database gets only a SCRAM verifier, and the
password goes straight into `live-db-app-<role>-password` on stdin. `r909-live-cutover.mjs secrets` then reads those and
writes the five URL secrets, again on stdin. **Nothing is printed except the anon key, which is public.**
Every new secret gets `roles/secretmanager.secretAccessor` for the Cloud Run SA
`1005662057478-compute@developer.gserviceaccount.com` (the SA has no project-level secret role — checked with
`gcloud projects get-iam-policy`, it has artifactregistry.writer, cloudbuild.builds.builder, cloudsql.client,
iam.serviceAccountUser, run.admin).

Why a **new** JWT secret instead of the old VM's: the old one lives only in the stopped VM's `.env`; reading it means
starting the VM. No real data and no live sessions exist, so a fresh secret + fresh anon/service keys is cleaner.
It does mean the old anon key baked into cloudbuild.yaml defaults stops working — hence the trigger change (2.4).

`AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET` are **not needed** on live: `authjs.ts` falls back to
`GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET`, which live already has (client `1005662057478-n193k42c…`).
(Whether staging's Auth.js client is the same Google client as live's: not verified — it came from the staging VM.)

Optional, Pardeep's decision: `GEMINI_API_KEY` (staging has `staging-gemini-api-key`; live has none, so AI features are off
on live). If wanted: make a **new** key for live in AI Studio, store as `live-gemini-api-key`, add with `--update-secrets`.

### 2.2 Live-only — keep exactly as they are

`AGENT_QUEUE_TOKEN` (secret `agent-queue-token`), `BUY_PAGE_TENANT_ID`, `CRON_SECRET`, `DIRECTADMIN_URL/ADMIN_USER/API_KEY/IP`,
`GOOGLE_OAUTH_CLIENT_ID/SECRET`, `HOSTING_TRIAL_LIVE`, `INBOUND_EMAIL_SECRET`, `INBOUND_REQUIRE_HEADER`,
`RESELLERCLUB_RESELLER_ID/API_KEY`, `RESEND_API_KEY`, `RESEND_FROM_OVERRIDE`, `SECRETS_MASTER_KEY`, `SENTRY_DSN`,
`NEXT_PUBLIC_SENTRY_DSN`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.

- **`SECRETS_MASTER_KEY` must never change** — it decrypts vault rows already in the DB.
- `CRON_SECRET` unchanged → the 15 Scheduler jobs need no edit.
- Seen, not in R-909 scope: `RESEND_FROM_OVERRIDE` is `onboarding@resend.dev` (Resend's test sender) — decide before 20 Oct.
  Several secrets are **plain env vars** on live (visible to anyone with `run.services.get`); moving them to Secret
  Manager is a separate card.

### 2.3 Fix / remove

| What | Action |
|---|---|
| `NEXT_PUBLIC_APP_URL` = `https://resellersos-njvk4nxhdq-el.a.run.app` (old asia-south1 URL) | set to `https://reselleros.anutech.in` (`--update-env-vars`). Next inlines `NEXT_PUBLIC_*` at build (the build arg is already `https://reselleros.anutech.in`), so this is for server code reading it at runtime. |
| `SUPABASE_SERVICE_ROLE_KEY` plain env var | `--remove-env-vars`, then `--update-secrets=…=live-service-role-key:latest` (Cloud Run does not convert a plain var into a secret in place). |
| `SUPABASE_*` | **cannot be removed** — the code still uses `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `NEXT_PUBLIC_SUPABASE_URL/ANON_KEY` as the names of the gateway's keys. Only their values change. |

`r909-live-cutover.mjs run-env` uses only `--update-env-vars`, `--update-secrets`, `--remove-env-vars` — never `--set-*`
(that would wipe the 23 live-only values; cloudbuild.yaml's own comment warns the same).

### 2.4 Browser build args (`NEXT_PUBLIC_*`) — via the deploy trigger

`cloudbuild.yaml` passes these as `--build-arg`; the `deploy` trigger has none set, so it gets the defaults. Add
substitutions to **`resellersos-deploy-on-push`** (same export → edit → import as `r161-step4b-trigger.sh`, because
`triggers update --update-substitutions` returned INVALID_ARGUMENT on staging):

| Substitution | Live value |
|---|---|
| `_DATA_GATEWAY` | `1` |
| `_AUTH_PROVIDER` | `authjs` |
| `_SUPABASE_URL` | `https://reselleros.anutech.in/api/sb` (routes `src/app/api/sb/rest` + `api/sb/storage` exist) |
| `_SUPABASE_ANON_KEY` | the new live anon key (minted from `live-supabase-jwt-secret`; public) |
| `_APP_URL`, `_APP_ENV`, `_MIN_INSTANCES`, `_CPU_BOOST`, `_IMAGE`, `_SERVICE`, `_REGION` | leave the defaults (already the production values) |

Alternative (not chosen): change the defaults in `cloudbuild.yaml` itself. The staging trigger overrides all four, so it
would be safe, but it ties the switch to a code merge; the trigger route matches what staging did and rolls back by
importing the saved YAML.

---

## 3. Google OAuth (Pardeep — Google Cloud console)

Client: the one in live's `GOOGLE_OAUTH_CLIENT_ID` (`1005662057478-n193k42crikjbj0mnbmier35082u2vbf.apps.googleusercontent.com`).
Console: **APIs & Services → Credentials → OAuth 2.0 Client IDs → that client → Edit**.

1. **Authorised redirect URIs → Add URI:** `https://reselleros.anutech.in/api/auth/callback/google`
   (Auth.js route `src/app/api/auth/[...nextauth]/route.ts`; base = `AUTH_URL`).
2. **Authorised JavaScript origins:** `https://reselleros.anutech.in` (add if missing).
3. Leave the existing integration URIs as they are (code builds them from the request host,
   `src/lib/google/oauth.ts`): `/api/integrations/google-contacts/callback`, `/google-gmail/callback`,
   `/google-ads/callback`, `/google-business/callback` on `https://reselleros.anutech.in`. Whether these are already
   registered: **not verified** (gcloud cannot list web OAuth clients' URIs) — check while on that screen.
4. Save. Google says changes can take a few minutes.

Scope asked at login is only `openid email profile` (`authjs.ts`) — no new consent-screen verification is needed for login.
The old GoTrue callback (`https://api.anutech.in/auth/v1/callback`, if registered) can be removed after 20 Oct.

---

## 4. Live DB

### 4.1 Options

| | (a) Same migration chain as staging, on `resellersos-db` | (b) Recreate database `resellersos` fresh |
|---|---|---|
| How | Replay what staging got, in staging's order: 4 Oct files → R-161 roles → R-161 Prisma → mfa column → staging's 59 MIGS (with staging's `auth.uid()` rewrite) → grants. Already-applied files are skipped by their own peek. | Drop/recreate the DB and load a schema: either a dump of staging (clone → wipe → export → import) or the git baseline (`db/local/build.sh` style: baseline.sql + all migrations). |
| Setup data (tenant `fbb976f1…` = BUY_PAGE_TENANT_ID, owner logins, catalog/price rows, settings) | **Kept as is** | Must be carried over table by table (CSV export/import) or re-entered |
| Roles / passwords | Instance-level, kept; 5 new app_* roles added | Roles are instance-level anyway — still need the R-161 role step |
| Risk | Live may differ from staging where staging got **hand-run fixes not in git** | A staging dump brings test rows **and `zz_staging_marker`** (the table that makes staging scripts run) onto live; the wipe scripts staging used on 3 Oct are not in git |
| Proven | Every file already ran on staging through the same `gcloud sql import` path | Not done before on Cloud SQL here |
| Rollback | on-demand backup → `gcloud sql backups restore` | same |

### 4.2 Recommendation: (a), gated by a schema fingerprint

Run the replay (`r909-live-db.sh`), then **prove** it matches staging: export a per-object hash of every column,
function, policy, trigger, constraint, index, grant, role and storage bucket from both DBs
(`r909-schema-fingerprint.sql` via `gcloud sql export csv --query`, read-only) and diff them. An empty diff = same
schema. Every line that differs is either (i) a staging hand-fix that must become a committed SQL file and be added to
the replay, or (ii) a staging-only accident that stays off live — decided line by line during the rehearsal, before 17 Oct.

### 4.3 What `r909-live-db.sh` runs (MODE=apply)

0. Guards: refuses `resellersos-staging-db`; refuses `resellersos-db` unless `LIVE_HAAN=1`; stops if the target has `public.zz_staging_marker`.
1. Live only: `gcloud sql backups create` and checks the newest backup is `SUCCESSFUL` (prints its id for rollback).
2. Peek (a `RAISE EXCEPTION 'PEEK …'` import, changes nothing) — which steps are already in.
3. `20261004100000_email_verifications`, `20261004120000_lead_key_functions_service_role`, `20261004130000_employee_advance_edit_delete` (as `resellersos_migration`).
4. `db/ops/10-runtime-roles.sql` + `20-auth-login.sql` as `postgres`, SCRAM verifiers in place of the psql variables; passwords → `live-db-app-<role>-password` (live) or discarded (clone).
5. `_prisma_migrations` + `0_init` + the five R-161 Prisma migrations, tenant_context with payment-runs inlined before its "nothing may still read the JWT" check — byte-for-byte the r161-step2 method; a `_prisma_migrations` row per file with Prisma's checksum.
6. `20261006110000_mfa_last_challenged_at` as `postgres` (staging ran its `mfa.sql` as postgres too).
7. Every MIGS line of `supabase/cloudsql/staging/deploy-db-2026-10-07.sh` whose peek is false, with `auth.uid()`→`public.current_user_id()` and `auth.role()`→`public.current_request_role()`, as the MIGS user. (The list is read from that file at run time, so new staging migrations are included automatically.)
8. `db/ops/21-auth-login-link.sql` (postgres), `cloudsql/09` + `10` grants (re-runnable).
9. Peek again → prints **DB READY** only when every key is true.

It must be run from a checkout of the **staging commit that will be deployed** (it needs `prisma/migrations`, `db/ops`,
which `manager-pardeep` does not have). It refuses with "Missing …" otherwise.

### 4.4 Rehearsal on a clone (by 15 Oct) — Pardeep ki haan (costs money while the clone exists)

```bash
# from production/ of a staging checkout, Git Bash
P=resellsubsos-prod
gcloud sql instances clone resellersos-db resellersos-r909-rehearsal --project=$P
# the clone gets its own Cloud SQL service account: let it read/write the rehearsal bucket
CSA=$(gcloud sql instances describe resellersos-r909-rehearsal --project=$P --format='value(serviceAccountEmailAddress)')
gcloud storage buckets add-iam-policy-binding gs://resellsubsos-prod-rehearsal --member=serviceAccount:$CSA --role=roles/storage.objectAdmin
# staging's SA (p1005662057478-6dwyjs@…) has only objectViewer there; the fingerprint EXPORT needs to write:
gcloud storage buckets add-iam-policy-binding gs://resellsubsos-prod-rehearsal --member=serviceAccount:p1005662057478-6dwyjs@gcp-sa-cloud-sql.iam.gserviceaccount.com --role=roles/storage.objectCreator

INSTANCE=resellersos-r909-rehearsal bash scripts/ops/r909-live-db.sh            # dry run: read the list
INSTANCE=resellersos-r909-rehearsal RUN=1 bash scripts/ops/r909-live-db.sh      # → "DB READY"
MODE=fingerprint INSTANCE=resellersos-r909-rehearsal RUN=1 bash scripts/ops/r909-live-db.sh
MODE=fingerprint INSTANCE=resellersos-staging-db     RUN=1 bash scripts/ops/r909-live-db.sh
MODE=compare A=<clone folder printed above> B=<staging folder> bash scripts/ops/r909-live-db.sh
```

Rehearsal is done when: DB READY on the clone, **compare = SAME SCHEMA** (or every remaining line is written down with
its decision), the clone's `rowcounts.csv` has been read to list what setup/test rows live really holds (input for the
18–19 Oct cleanup), and `max_connections` on the clone is known (section 9, F16). Then delete the clone:
`gcloud sql instances delete resellersos-r909-rehearsal --project=resellsubsos-prod` (Pardeep ki haan).
If the replay stops on the clone, nothing on live is touched — fix the file in git, re-clone, run again.

---

## 5. Storage

- Code uses four Supabase buckets: `documents` (8 call sites), `attendance-selfies` (7), `expense-receipts` (2), `logos` (1).
  Their rows are in `storage.buckets` / `storage.objects` in the DB (policies unchanged: "first folder = your tenant").
- Today live's file **bytes** sit on the stopped VM's disk (`supabase-gateway`, docker volume `storage-data`).
  With no real data they are **not migrated**. Any `storage.objects` rows on live will point at bytes that are not in
  GCS → those files show as missing. The clone's `rowcounts.csv` says how many; delete those rows in the 18–19 Oct cleanup.
- New bucket (mirrors `resellsubsos-staging-files`: asia-southeast1, uniform access, public access prevention enforced,
  7-day soft delete default): **`gs://resellsubsos-live-files`**. Objects are stored as `<supabase bucket>/<path>`;
  nothing is public on GCS — public/signed reads go through the app (`src/server/storage/backend.ts`), so no signBlob/IAM
  token creator is needed.
- IAM: `roles/storage.objectAdmin` on that bucket for `1005662057478-compute@developer.gserviceaccount.com` (same as staging's bucket).

---

## 6. Crons (Cloud Scheduler)

15 jobs in **asia-southeast1**, all ENABLED, all `GET https://resellersos-njvk4nxhdq-as.a.run.app/api/cron/<name>`,
time zone Asia/Kolkata, auth by an `Authorization` header (value not read): renewals, health-digest, **gmail-inbox (every
minute)**, billing, attendance-retention, invoice-dunning, ai-reply-retry (every 5 min), birthday-greetings, mrr-snapshot,
ai-reflection, attendance-reminders, compliance-reminders, trial-expiry, backup, google-contacts-sync.

- The URL is the run.app URL of the same service → it keeps working after the switch. `CRON_SECRET` is unchanged → no edit.
- **Pause all 15 for the cutover window** (`r909-live-cutover.mjs scheduler-pause`) and resume after step 8.9.
- 15 more jobs with the same names exist in **asia-south1**, all PAUSED, pointing at old asia-south1 URLs — leftovers;
  delete after 20 Oct (separate card), do not resume them.
- Cron routes in code with **no** Scheduler job (live or staging): ads-sync, ai-sales-loop, ai-support-sla,
  ai-telecall-renewals, demo-reset, gbp-sync, indiamart-leads, lead-finder, provision-hosting, register-domains,
  renew-domains, renew-hosting. Whether any must run on live from 20 Oct: **not verified** — product decision, not R-909.
- `backup` cron labels files with the host part of `NEXT_PUBLIC_SUPABASE_URL` (will become `reselleros`) — cosmetic.

---

## 7. Deploy — how live gets the staging code

- Triggers (`gcloud builds triggers list`, global): `resellersos-deploy-on-push` (repo Anutech-Digital/anutechbilling,
  branch `^deploy$`, `cloudbuild.yaml`) and `resellersos-staging-on-push` (branch `^staging$`). No regional triggers.
- `anutech/deploy` = `5fb17830` (6 Oct) and **is an ancestor of `anutech/staging`** (384 commits behind) → a plain
  fast-forward push works, no force:
  `git push anutech <staging-sha>:refs/heads/deploy`
- `<staging-sha>` = the staging commit that passed the staging check on 17 Oct (from the staging release session).
- Cloud Build runs the gate (npm ci, prisma generate, typegen, tsc, vitest), builds with the trigger's substitutions,
  pushes `resellersos:<sha>` and runs `gcloud run deploy resellersos --image=…` — **no --set-env-vars**, so the env from
  step 8.6 is kept. Build time on staging: ~20 min (r161-step4 note).
- After `--no-traffic` updates, whether Cloud Build's `run deploy` sends traffic to the new revision automatically:
  **not verified**. Step 8.8 checks traffic either way; step 8.9 sets it explicitly.

---

## 8. Cutover checklist — 17 Oct, 17:00 IST ke baad

Run from `production/` of a checkout of `<staging-sha>`. Every step: **Pardeep ki haan** before it starts.
Who runs it: steps that create secret values (8.2, 8.3) run in **Pardeep's terminal**; the rest Claude can run on his
gcloud login after his haan. PowerShell form: `& "C:\Program Files\Git\bin\bash.exe" -c "cd /c/Users/mso50/<checkout>/production && <command>"`.

### 8.0 Pehle jaanch (read-only) — Pardeep ki haan
```bash
node scripts/ops/r909-live-cutover.mjs check --run
```
✔ Account = pardeep@anutech.in; traffic = `resellersos-00035-prc` 100%; no `live-*` secrets yet; trigger has no
substitutions; 15 jobs ENABLED; rehearsal report (4.4) says SAME SCHEMA; staging sha chosen and green.
↩ Nothing changed.

### 8.1 Crons rok do — Pardeep ki haan
```bash
node scripts/ops/r909-live-cutover.mjs scheduler-pause --run
```
✔ `gcloud scheduler jobs list --location=asia-southeast1 --project=resellsubsos-prod` → 15 × PAUSED.
↩ `node scripts/ops/r909-live-cutover.mjs scheduler-resume --run`

### 8.2 Live DB: backup + roles + migrations — Pardeep ki haan (Pardeep's terminal)
```bash
INSTANCE=resellersos-db LIVE_HAAN=1 RUN=1 bash scripts/ops/r909-live-db.sh
MODE=fingerprint INSTANCE=resellersos-db LIVE_HAAN=1 RUN=1 bash scripts/ops/r909-live-db.sh
MODE=compare A=<live folder> B=<staging folder from today> bash scripts/ops/r909-live-db.sh
```
✔ "DB READY"; compare = SAME SCHEMA or exactly the lines accepted in the rehearsal; `gcloud secrets list
--filter=name~^live-db-app` → 5 names.
↩ Note the backup id the script printed, then (Pardeep ki haan):
`gcloud sql backups restore <BACKUP_ID> --restore-instance=resellersos-db --backup-instance=resellersos-db --project=resellsubsos-prod`
(overwrites the whole instance, roles included — fine, there is no real data). If it stopped half-way, prefer
fix-forward: every step is peek-gated and re-runnable.

### 8.3 Secrets — Pardeep ki haan (Pardeep's terminal)
```bash
node scripts/ops/r909-live-cutover.mjs secrets --run
```
✔ `gcloud secrets list --project=resellsubsos-prod --filter=name~^live-` → 14 names: 5 `live-db-app-*-password`,
5 `live-*database-url`, `live-supabase-jwt-secret`, `live-service-role-key`, `live-anon-key`, `live-auth-secret`.
The command prints the live anon key (public) — nothing else.
↩ Unused until 8.6; leave them, or `gcloud secrets delete <name>`. Re-running adds new versions (all rotate together).

### 8.4 Files bucket — Pardeep ki haan
```bash
node scripts/ops/r909-live-cutover.mjs bucket --run
```
✔ `gcloud storage buckets describe gs://resellsubsos-live-files` (uniform access True, PAP enforced);
`gcloud storage buckets get-iam-policy gs://resellsubsos-live-files` shows objectAdmin for the compute SA.
↩ `gcloud storage buckets delete gs://resellsubsos-live-files` (only while empty).

### 8.5 Google console — Pardeep khud (section 3)
✔ The client shows `https://reselleros.anutech.in/api/auth/callback/google`.
↩ Remove that URI.

### 8.6 Cloud Run env, bina traffic — Pardeep ki haan
```bash
node scripts/ops/r909-live-cutover.mjs run-env            # read the 3 commands
node scripts/ops/r909-live-cutover.mjs run-env --run
```
✔ `gcloud run services describe resellersos --region=asia-southeast1 --project=resellsubsos-prod --format="value(status.traffic,spec.template.spec.containers[0].env[].name)"`
→ traffic still `resellersos-00035-prc` 100%; 36 env names = today's 23 (the 21 of section 2.2 + `NEXT_PUBLIC_APP_URL`
+ `SUPABASE_SERVICE_ROLE_KEY`, now from a secret) + 13 new from 2.1; memory 1Gi.
If gcloud refuses the remove-then-add of `SUPABASE_SERVICE_ROLE_KEY`, stop and send the screen (both are no-traffic).
↩ Traffic was never moved. To drop the new template: `gcloud run services update resellersos --region=asia-southeast1
--project=resellsubsos-prod --no-traffic --remove-env-vars=DATA_GATEWAY,AUTH_PROVIDER,AUTH_URL,STORAGE_BACKEND,GCS_BUCKET,DB_POOL_MAX
--remove-secrets=DATABASE_URL,ANON_DATABASE_URL,SERVICE_DATABASE_URL,AUTH_DATABASE_URL,JOBS_DATABASE_URL,SUPABASE_JWT_SECRET,AUTH_SECRET`.

### 8.7 Deploy trigger ke browser switches — Pardeep ki haan
```bash
node scripts/ops/r909-live-cutover.mjs trigger --run
```
✔ Last line prints `1  authjs  https://reselleros.anutech.in/api/sb`. The script prints where it saved the trigger as it was.
↩ `gcloud beta builds triggers import --project=resellsubsos-prod --source=<saved trigger-before.yaml>`

### 8.8 Code bhejo (deploy branch) — Pardeep ki haan
```bash
node scripts/ops/r909-live-cutover.mjs deploy --sha=<staging-sha> --run
# ~20 min later
gcloud builds list --project=resellsubsos-prod --limit=1 --format="value(id,status,substitutions.SHORT_SHA)"
node scripts/ops/r909-live-cutover.mjs tag-new --run
curl -s https://r909---resellersos-njvk4nxhdq-as.a.run.app/api/version
```
✔ Build SUCCESS; `/api/version` on the tag URL shows `<staging-sha>`; traffic still on 00035 (or, if Cloud Build moved it,
note that and go to 8.9 checks directly).
↩ Nothing is serving the new code yet. A red build deploys nothing (gate). `deploy` cannot be rewound without force — leave it; the next push fast-forwards.

### 8.9 Traffic switch + jaanch — Pardeep ki haan
```bash
node scripts/ops/r909-live-cutover.mjs traffic --run
```
✔ In a **visible browser** (Claude drives, Pardeep watches):
1. `https://reselleros.anutech.in/api/version` = `<staging-sha>`.
2. Signed-out public page (pricing / buy page for tenant `BUY_PAGE_TENANT_ID`) loads data → proves anon key ↔ JWT secret match.
3. Email + password login of an existing live account; then **Google login**; also start login from `https://anutech.in/login` once (F11).
4. Open an invoice, download its PDF; Report Bug; upload a logo → `gcloud storage ls gs://resellsubsos-live-files/logos/` shows it.
5. `gcloud run services logs read resellersos --region=asia-southeast1 --project=resellsubsos-prod --limit=100` — no `PGRST301`, no `db: … is not set`, no `permission denied`.
↩ `node scripts/ops/r909-live-cutover.mjs rollback-traffic --run` → back to `resellersos-00035-prc`. Honest note: that revision
needs the stopped VM, so "rollback" = live back to today's unused state; the real fix is forward.

### 8.10 Crons chalu — Pardeep ki haan
```bash
node scripts/ops/r909-live-cutover.mjs scheduler-resume --run
gcloud scheduler jobs run resellersos-health-digest --location=asia-southeast1 --project=resellsubsos-prod
```
✔ 15 × ENABLED; Cloud Run logs show `/api/cron/health-digest` 200 within a minute; gmail-inbox 200 on the next minute.
↩ `scheduler-pause --run` again.

### 8.11 Likh do
Board card R-909: each step's time (from `date -u`), backup id, deployed sha, any accepted fingerprint lines.

### 18–19 Oct — poora flow test + safai
Claude clicks through every flow on live in the visible browser (quote → pay → invoice → PDF, attendance selfie upload,
expense receipt, Google login, crons' effects). Test-data cleanup from the clone's `rowcounts.csv`: one committed SQL file
(new card), run with Pardeep's haan, `storage.objects` rows without bytes included. 20 Oct real data only after that.

### After 20 Oct (separate cards)
Delete VM `supabase-gateway` + its disk + snapshots; delete the 15 paused asia-south1 Scheduler jobs; remove the old
GoTrue redirect URI; move live's plain-env secrets into Secret Manager; check whether live still needs Direct VPC egress
(`network-interfaces default`, `private-ranges-only` — why it was added: not verified).

---

## 9. Failure cases (and the recovery that ships with them)

| # | How it breaks | What catches / recovers it |
|---|---|---|
| F1 | A migration stops on live (e.g. tenant_context's "nothing may read the JWT" guard finds a live-only function) | Rehearsal on the clone hits it first. On live the script stops at that file and prints the error; peek-gated re-run after a fix, or restore the backup id from 8.2. |
| F2 | Live ≠ staging because of staging hand-fixes not in git | Fingerprint compare is a gate (4.2); every diff line gets a written decision before 17 Oct. |
| F3 | `zz_staging_marker` reaches live (would arm staging-only scripts) | Option (a) never copies staging data; `r909-live-db.sh` refuses a target that has it; the fingerprint ignores it only by name, so a dump would still be caught by the guard. |
| F4 | The live DB script pointed at staging, or at live without a decision | Refused for `resellersos-staging-db`; `resellersos-db` needs `LIVE_HAAN=1`; dry run is the default. |
| F5 | URL secrets made before the role passwords exist | `secrets --run` checks all 5 `live-db-app-*-password` first and stops. |
| F6 | `--set-env-vars` used by hand → 23 live-only values gone | Helper only uses update/remove; 8.6 check compares env names. If it happens: values are not in git — Pardeep re-enters them (worst case; avoid). |
| F7 | Plain → secret switch of `SUPABASE_SERVICE_ROLE_KEY` refused or half-done | Both commands are `--no-traffic`; the half state never serves users; re-run the third command. |
| F8 | `AUTH_URL` missing → Google redirect to `0.0.0.0` (staging 6 Oct) | In `run-env`; 8.9 Google login. |
| F9 | 512Mi out of heap with the gateway | `--memory=1Gi` in `run-env`. |
| F10 | `redirect_uri_mismatch` at Google | Section 3 / 8.5 before traffic; `src/lib/google/gmail-connect-result.ts` shows the reason in the UI for integrations. |
| F11 | Login started on `anutech.in` while `AUTH_URL` is `reselleros.anutech.in` → state cookie on the other host (not verified whether `/login` on the apex redirects) | 8.9 step 3 tests it; if it fails, a small middleware/site-split fix card before 20 Oct. |
| F12 | Anon key in the build signed with a different secret than `SUPABASE_JWT_SECRET` → every signed-out request 401 `PGRST301` | Both minted in one `secrets` run from one value; 8.9 step 2 checks signed-out data. Fix: re-run `trigger` (reads `live-anon-key`) and rebuild. |
| F13 | Trigger import breaks the trigger | Saved `trigger-before.yaml`; import it back. |
| F14 | Build gate red on the chosen sha | Nothing deploys; pick the next green staging sha. |
| F15 | Cloud Build moves traffic by itself | Live is unused; 8.9 checks run the same; rollback command unchanged. |
| F16 | Too many DB connections: per instance gateway 3 pools × 3 + auth 3 + jobs (no max set, pg default 10) ≈ 22, × max 3 instances ≈ 66 | `max_connections` of db-custom-1-3840: **not verified** — read it on the clone during rehearsal (add `'maxconn=' || current_setting('max_connections')` to a peek); lower max instances or `DB_POOL_MAX` if close. |
| F17 | Crons hit half-switched live (gmail-inbox every minute) | Paused in 8.1, resumed only in 8.10; `check` shows their state. |
| F18 | Crons forgotten paused after cutover | 8.10 + `check`; board card step list. |
| F19 | Chat/session stops mid-cutover | Every step is idempotent and peek/describe-checked; `check --run` + the DB peek show where it stopped; board card records the last finished step. |
| F20 | Two pushes to `deploy` (another session) | Only this runbook pushes `deploy`, with haan; fast-forward only, no force. |
| F21 | Uploads 403/500 (bucket IAM missing) | 8.4 IAM check; 8.9 logo upload. |
| F22 | Old `storage.objects` rows without bytes → broken images/files | Counted on the clone; deleted in 18–19 Oct cleanup. |
| F23 | `SECRETS_MASTER_KEY` changed → vault rows unreadable | Never touched by any step; listed under "keep". |
| F24 | Backup not SUCCESSFUL | Script stops before any change. |
| F25 | Rehearsal clone left running (cost) | Delete in 4.4 once the report is written. |
| F26 | Fingerprint/rowcount export refused (export user lacks rights on `auth.*`, or the instance SA cannot write the bucket) | Not verified — rehearsal shows it; fall back to a peek-style query for that part. |
| F27 | Real data entered before 18–19 Oct checks finish | 20 Oct start; R-909 not Done until 8.9 + flow test pass. |

---

## 10. Not verified (so nobody treats these as facts)

- Whether live login works today (expected broken — VM stopped; not tested).
- Registered redirect URIs / JS origins on the live OAuth client; whether staging's Auth.js client is the same client.
- Content and necessity of staging's hand-run files (`own-fix*.sql`, `interns.sql`, `10-svc-1006.sql`, `mfa.sql`, …) — the fingerprint decides.
- Whether gcloud accepts the plain→secret switch exactly as scripted (8.6); whether Cloud Build's deploy moves traffic after `--no-traffic` updates.
- `max_connections` on `resellersos-db`; which user `gcloud sql export csv` runs as.
- What setup rows live holds (tenant, owner, catalog) — the clone's `rowcounts.csv` answers it without touching live.
- Whether `/login` on `anutech.in` redirects to `reselleros.anutech.in`.

## 11. Sirf Pardeep kar sakte hain

1. Haan for every step in section 8 and for the clone create/delete (4.4).
2. Google Cloud console: add the redirect URI (section 3).
3. Run 8.2 and 8.3 in his own terminal (they create password/secret values) — on his gcloud login.
4. Bucket IAM grants for the clone SA and staging SA on `resellsubsos-prod-rehearsal` (4.4).
5. Optional: a new live Gemini key (AI Studio) and the `RESEND_FROM_OVERRIDE` decision before 20 Oct.
