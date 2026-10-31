# production/scripts — what is here and how it is run

Updated 19 Oct 2026 (R-1605). Run everything from `production/`. Anything that writes to a
database is **dry run by default** and takes `--apply`; never point one at live or staging —
that is the manager's deploy step (docs/LIVE-OPERATIONS.md).

## Run through `npm run` (see package.json)

`gate.mjs` (gate), `lint-ratchet.mjs`, `build-check.mjs`, `dev-local.mjs` (dev:local), `setup.mjs`,
`test-sql.mjs`, `isolation-mutation.mjs`, `new-migration.mjs`, `migration-drift-check.mjs`,
`rebuild-db.mjs`, `db-compare.mjs`, `db-cols.mjs`, `backup-code.mjs`, `backup-db.mjs`,
`prune-backups.mjs`, `restore-check.mjs`, `verify-deploy.mjs`, `health-prod.mjs`,
`org-chart-sync.mjs`, `apps-script.mjs`, `sales-dry-run.mjs`.

## Called by other tools (do not delete)

- `ops/worker-lock.mjs`, `ops/push-guard-suites.mjs` — worker claim/check/push (docs/WORKER-SESSION-PROMPT.md).
- `ops/staging-train.mjs`, `ops/staging-gate.mjs`, `ops/deploy-gate.mjs` (deploy.sh), `ops/gen-deploy-db.mjs`, `ops/secret-scan.mjs` — manager's staging/live path.
- `migration-order-check.mjs`, `areas.mjs`, `apps-script-lib.mjs`, `dev/local-guard.mjs`, `ops/queue-watch-lib.mjs` — used by the scripts above or by tests.

## Run by hand (one line each)

| Script | What it does |
|---|---|
| `setup-cloud-scheduler.sh` | Creates/updates the Cloud Scheduler job for every cron route (crons live here, not in vercel.json). |
| `cron-preflight.sh` | Preflight checks, then runs setup-cloud-scheduler.sh. |
| `rotate-cron-secret.sh` | Rotates CRON_SECRET on the Cloud Run service and every Scheduler job together. |
| `setup-uptime-checks.sh` | Cloud Monitoring uptime check + alerts. |
| `set-cloudrun-master-key.mjs` / `set-master-key.mjs` | Puts SECRETS_MASTER_KEY on Cloud Run / generates it into .env.local. |
| `check-mfa-local.mjs` | End-to-end two-step sign-in check against the LOCAL stack only. |
| `webhook-selftest.mjs` | Proves the Razorpay webhook signature path works, without Razorpay. |
| `gmail.mjs` | Reads the ERP label in Gmail through domain-wide delegation (no key file). |
| `local-cron.mjs` | Runs the hosting cron on a laptop the way Scheduler runs it live. |
| `prisma-pull.mjs` | Regenerates `prisma/schema.prisma` from the LOCAL db (`npm run db:local`) — its header names this script. |
| `gen-tenant-context-migration.mjs`, `gen-restore-rehearsal.cjs` | Generate committed SQL from a local db (one-off generators, kept with their output). |
| `check-config-drift.mjs`, `check-db-types.mjs`, `check-embed-ambiguity.mjs` | Read-only consistency checks. |
| `a11y-count.mjs`, `count-raw-toast-errors.cjs` | Count UI gaps per owner (numbers for ratchets). |
| `create-user.mjs`, `setup-e2e-tenants.mjs`, `dev/local-login-link.mjs`, `dev/seed-e2e-catalog.mjs`, `dev/seed-e2e-approval.mjs` (R-2318) | Local/test users and fixtures only. |
| `dev/scenario.mjs` (+ `dev/scenarios/*.sql`) | R-1957: one-click LOCAL test scenarios for the money cards — `node scripts/dev/scenario.mjs <vendor-sharma|vendor-advance|bills-page-paid|all> [--reset|--clear]`, `--self-test` proves load/reset in a rolled-back run. Local docker DB + E2E Test Co only. |
| `set-doc-code.mjs` | Changes a tenant's document-number code (doc_code). |
| `backup-tenant-data.mjs` | Off-database data backup with the service key. |
| `delete-tenants.mjs` | Deletes tenants by EXPLICIT id after a backup; dry run unless `--apply`. Local/staging clean-ups only — never live without Pardeep. |
| `delete-stranded-auth-users.mjs` | Deletes Auth accounts with no users row; writes a record file first; dry run unless `--apply`. Same rule. |
| `renewed-state-repair.mjs` (R-1562), `r1574-duplicate-renewal-quotes.mjs` (R-1574) | Card-specific repair/report; dry run / report only by default. |
| `ops/backup-restore-test.mjs` | Restores the latest Cloud SQL backup into a new instance to prove it works (R-887). |
| `ops/live-env-commands.mjs` | PRINTS the Cloud Run env/secret commands; runs nothing. |
| `ops/queue-watch.mjs` | Read-only watcher for new bug reports. |
| `ops/agent-queue-token.sh`, `ops/staging-gemini-key.sh` | Set the agent-queue token / the staging-only Gemini key. |
| `ops/r909-live-cutover.mjs`, `ops/r909-live-db.sh`, `ops/r909-schema-fingerprint.sql` | R-909 live cutover runbook (docs/R-909-LIVE-CUTOVER.md). |

## Removed 19 Oct 2026 (R-1605) — still in git history

One-off scripts nothing referenced: `execute-dummy-data-cleanup.mjs` (deleted data for
hard-coded customer ids, no dry run, fell back to the anon key), `check-and-clean-dummy-data.mjs`,
`reset-to-real.sql` (emptied every table), `seed-anutech-digital-deal.mjs`, `set-tenant-hierarchy.mjs`,
`audit-anutech-lifecycle.mjs`, `audit-all-database-tenant-ids.mjs`, `gen-overpaid-credit-migration.cjs`
(its migration is already committed), `seed-from-dms.mjs`, `dsp-migration/extract.sh` (DSP migration
parked), `ops/r205-gw-list-prices.sql` (applied; `supabase/cloudsql/r205/apply.sql` holds it),
`screenshot-landing.mjs`, `screenshot-pricing.mjs`, `visual-tour.mjs`, `human-test.mjs`.
Need one back? `git log --diff-filter=D --oneline -- production/scripts/<name>` and restore it
from the commit before.
