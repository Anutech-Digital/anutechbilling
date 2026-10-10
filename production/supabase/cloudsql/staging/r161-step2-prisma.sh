#!/usr/bin/env bash
# R-161 step 2 on STAGING only (6 Oct 2026): Prisma migrations without a direct DB connection.
#
#   bash production/supabase/cloudsql/staging/r161-step2-prisma.sh
#
# This machine has no Cloud SQL proxy/psql, so `prisma migrate deploy` cannot reach the DB.
# Instead each migration.sql goes through `gcloud sql import` (as resellersos_migration, the
# owner), and the `_prisma_migrations` rows are written with Prisma's own checksum (sha256 of
# the committed file), so a later `prisma migrate deploy` from anywhere sees them as applied.
#
# Checked before running (6 Oct): the 91 functions tenant_context rewrites have the same bodies
# on staging as in git (whitespace-normalised md5), so the rewrite overwrites nothing newer.
# Each migration is one transaction: a failure leaves that file un-applied and stops here.
set -euo pipefail
P=resellsubsos-prod; I=resellersos-staging-db; DB=resellersos
B=gs://resellsubsos-prod-rehearsal/golive/r161-step2
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"   # production/
MIG="$ROOT/prisma/migrations"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
say() { printf '\n== %s\n' "$1"; }
imp() { # $1 local file, $2 name
  gcloud storage cp "$1" "$B/$2" --project="$P" -q >/dev/null
  if ! gcloud sql import sql "$I" "$B/$2" --database="$DB" --user=resellersos_migration --project="$P" --quiet >/dev/null 2>&1; then
    echo "FAILED: $2"
    gcloud sql operations list --instance="$I" --project="$P" --limit=1 --format="value(error.errors[0].message)" | tr '\\' '\n' | grep -E "ERROR|DETAIL|HINT" | head -4
    exit 1
  fi
  echo "ok: $2"
}
checksum() { git -C "$ROOT/.." show "HEAD:production/prisma/migrations/$1/migration.sql" | sha256sum | cut -c1-64; }

say "1. Backup"
gcloud sql backups create --instance="$I" --project="$P" --description="before R-161 step 2 prisma migrations (6 Oct 2026)" --quiet

say "2. Prisma's tracking table + 0_init as already applied (= prisma migrate resolve --applied 0_init)"
cat > "$TMP/track.sql" <<SQL
create table if not exists public._prisma_migrations (
  id varchar(36) primary key not null, checksum varchar(64) not null, finished_at timestamptz,
  migration_name varchar(255) not null, logs text, rolled_back_at timestamptz,
  started_at timestamptz not null default now(), applied_steps_count integer not null default 0);
insert into public._prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count)
select gen_random_uuid()::text, '$(checksum 0_init)', now(), '0_init', 0
 where not exists (select 1 from public._prisma_migrations where migration_name = '0_init');
SQL
imp "$TMP/track.sql" track.sql

say "3. Migrations, in order"
for m in 20261005120000_tenant_context 20261005130000_jobs_scope 20261005140000_lock_prisma_migrations \
         20261005150000_gateway_logins 20261006090000_payment_runs_tenant_context; do
  f="$MIG/$m/migration.sql"
  if [ "$m" = 20261005120000_tenant_context ]; then
    # Its last block refuses to commit while ANY public function still reads auth.uid() —
    # and the Payment Runs functions (newer than this file) do. So the payment-runs rewrite
    # (20261006090000, applied again on its own below — idempotent) goes in the SAME
    # transaction, just before that check. The file on disk is unchanged (checksum intact).
    awk -v pr="$MIG/20261006090000_payment_runs_tenant_context/migration.sql" '
      /^-- ─── 4\. Nothing may still read the JWT directly/ {
        while ((getline l < pr) > 0) if (l !~ /^(begin|commit);[[:space:]]*$/) print l
      } { print }' "$f" | tr -d '\r' > "$TMP/tc.sql"
    f="$TMP/tc.sql"
  fi
  imp "$f" "$m.sql"
  printf "insert into public._prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count) select gen_random_uuid()::text, '%s', now(), '%s', 1 where not exists (select 1 from public._prisma_migrations where migration_name = '%s');\n" \
    "$(checksum "$m")" "$m" "$m" > "$TMP/row.sql"
  imp "$TMP/row.sql" "row-$m.sql"
done

say "4. Schema reload for the VM's PostgREST (still serving until the switch)"
printf "notify pgrst, 'reload schema';\n" > "$TMP/reload.sql"; imp "$TMP/reload.sql" reload.sql

say "5. Check"
cat > "$TMP/peek.sql" <<'SQL'
DO $$ DECLARE r text; BEGIN
  select concat_ws(' ',
    'migrations=' || (select count(*) from public._prisma_migrations),
    'helpers=' || (select count(*) from pg_proc where proname in ('current_user_id','current_request_role','jobs_list_tenants')),
    'auth_uid_left_in_payment_runs=' || (select count(*) from pg_proc where proname like '%payment_run%' and prosrc like '%auth.uid()%'),
    'roles=' || (select string_agg(rolname, ',' order by rolname) from pg_roles where rolname like 'app\_%')) into r;
  RAISE EXCEPTION 'PEEK %', r; END $$;
SQL
gcloud storage cp "$TMP/peek.sql" "$B/peek.sql" --project="$P" -q >/dev/null
gcloud sql import sql "$I" "$B/peek.sql" --database="$DB" --user=resellersos_migration --project="$P" --quiet >/dev/null 2>&1 || true
gcloud sql operations list --instance="$I" --project="$P" --limit=1 --format=json | grep -oE 'PEEK[^\\"]*' | head -1
