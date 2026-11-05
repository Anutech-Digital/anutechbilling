# 0001 — Production database on Cloud SQL behind a self-hosted Supabase data plane

- **Status:** Accepted (recorded after the fact, 28 Sep 2026)
- **Date:** 2026-09-06 (cut-over commit `8a25d726`)
- **Decided by:** Pardeep
- **Area:** infra

## Context

Production ran on hosted Supabase (project `ontpnqjoysjgrlsukecm`). The owner wanted the
database inside the company's own Google Cloud project (`resellsubsos-prod`), with the app,
the backups and the billing in one place.

The app is a Supabase application, not a Postgres one: about 1,300 `.from()` and 130
`.rpc()` calls over PostgREST, ~210 auth calls, and `auth.uid()` inside the RLS policies.
There is no direct Postgres driver in the code. Cloud SQL on its own cannot serve it.

## Decision

- Data lives in **Cloud SQL `resellersos-db`** (PostgreSQL 17, `asia-southeast1`).
- The Supabase **data plane is self-hosted** on a VM against it — PostgREST, GoTrue,
  Storage, behind Caddy TLS at `https://api.anutech.in`. The app changed only its
  `NEXT_PUBLIC_SUPABASE_URL` / anon key (build time, `cloudbuild.yaml` substitutions) and the
  service-role key (Cloud Run). Same JWT secret, so existing tokens and keys stay valid.
- Cloud SQL forbids `BYPASSRLS`, so `service_role` gets a permissive `USING (true)` policy
  per table instead (`production/supabase/cloudsql/`).
- Cloud Run moved to the same region, `asia-southeast1`.
- The old hosted project stays up and becomes **staging** (`docs/ACCESS.md`).

## Consequences

- One project, one bill, Cloud SQL backups + 7-day PITR (`docs/BACKUP.md`).
- We now operate what Supabase used to: the VM, its TLS, CORS on `/auth` (commits
  `a3d4db99`, `9ff42980`), GoTrue upgrades. A VM outage is an app outage — it needs its
  own uptime check.
- A new table needs the `service_role` policy too, or crons/webhooks lose access to it.
- The Supabase CLI's `--linked` commands talk to a hosted Supabase project, not to Cloud
  SQL. Scripts built on `supabase db query --linked` (`test-sql.mjs --remote` — local by default since R-2493,
  `migration-drift-check.mjs`, `backup-db.mjs`) are therefore not a check of production
  any more until they are repointed — confirm which database a script reached before
  believing its result.
- Rolling Cloud Run back to a revision built before 6 Sep would point it at the old
  database (`docs/ROLLBACK.md`).
- Single database and bucket in one billing account: a lapsed bill takes both (`docs/ACCESS.md`, R-017).

## Alternatives considered

- Stay on hosted Supabase — simplest, but the owner wanted the data inside the company's own GCP project.
- Rewrite the data layer on a Postgres driver — months of work across 1,400+ call sites, and RLS would have to be re-proved.
