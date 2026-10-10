#!/usr/bin/env bash
# Build a LOCAL Postgres 17 (Docker) that matches production's schema, from git alone.
#   npm run db:local            → container ros-pg on localhost:54329, database ros
#   npm run db:local -- <name>  → another database in the same container (tests use ros_test)
#   SKIP_PRISMA=1 npm run db:local → stop before prisma/migrations (used to regenerate them)
# Local passwords are all "localdev". Never point this at a real database.
set -euo pipefail
cd "$(dirname "$0")/../.."
DB="${1:-ros}"
PORT=54329

if ! docker ps --format '{{.Names}}' | grep -qx ros-pg; then
  docker rm -f ros-pg >/dev/null 2>&1 || true
  docker run -d --name ros-pg -e POSTGRES_PASSWORD=localdev -p ${PORT}:5432 postgres:17 >/dev/null
  until docker exec ros-pg pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
  sleep 2
fi

PSQL=(docker exec -i ros-pg psql -U postgres -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -c "drop database if exists ${DB} with (force)" -c "create database ${DB}"
run() { echo "  · $1"; "${PSQL[@]}" -d "$DB" -1 -f - < "$1" > /dev/null; }

# The Cloud SQL move (6 Sep 2026): ownership to resellersos_migration, plus the objects it
# added outside supabase/migrations — blanket grants, the service_role policies, the backup
# schema, functions synced from live. "already exists" is expected and ignored.
cloudsql_move() {
  run db/local/10-cloudsql-ownership.sql
  "${PSQL[@]}" -d "$DB" -c "grant create on database ${DB} to resellersos_migration" > /dev/null
  local f errs
  for f in supabase/cloudsql/01b-grants-and-policies.sql \
           supabase/cloudsql/04-auth-schema-usage-grants.sql \
           supabase/cloudsql/05-restore-app-rls-policies.sql \
           supabase/cloudsql/06-backup-subsystem-and-merge-grant.sql \
           supabase/cloudsql/07-sync-backup-functions-from-live.sql \
           supabase/cloudsql/08-storage-role-switch.sql; do
    echo "  · $f"
    errs=$(docker exec -i ros-pg psql -U postgres -d "$DB" -q -f - < "$f" 2>&1 | grep -E 'ERROR' | grep -vE 'already exists' || true)
    if [ -n "$errs" ]; then echo "$errs" | sed 's/^/      /' | head -5; fi
  done
}

run db/local/00-supabase-shim.sql
run supabase/baseline.sql
run supabase/baseline-storage.sql

# Replay history in order. The Cloud SQL move sits BETWEEN migrations: later migrations
# (28–30 Sep) re-hardened grants that its blanket GRANTs opened. Applying it last would
# undo them and make the hardening tests fail for a reason production does not have.
CLOUDSQL_AT=20260906120000
moved=""
for f in supabase/migrations/*.sql; do
  ts=$(basename "$f" | cut -c1-14)
  if [ -z "$moved" ] && [[ "$ts" > "$CLOUDSQL_AT" ]]; then cloudsql_move; moved=1; fi
  run "$f"
done
if [ -z "$moved" ]; then cloudsql_move; fi
# Migrations after the move were applied as resellersos_migration on Cloud SQL
# (docs/STAGING.md: --user=resellersos_migration), so it owns what they created too.
run db/local/10-cloudsql-ownership.sql

"${PSQL[@]}" -d "$DB" -v runtime_pw="'localdev'" -v jobs_pw="'localdev'" -v anon_pw="'localdev'" -v service_pw="'localdev'" -f - < db/ops/10-runtime-roles.sql > /dev/null
"${PSQL[@]}" -d "$DB" -v auth_pw="'localdev'" -f - < db/ops/20-auth-login.sql > /dev/null
echo "  · roles app_runtime / app_jobs / app_anon / app_service / app_auth"

if [ -n "${SKIP_PRISMA:-}" ]; then echo "built without Prisma migrations: $DB"; exit 0; fi

# Migrations run as the table owner, exactly like the deploy pipeline will.
export MIGRATE_DATABASE_URL="postgresql://resellersos_migration:localdev@localhost:${PORT}/${DB}"
npx prisma migrate resolve --applied 0_init > /dev/null
npx prisma migrate deploy
echo "ready: postgresql://app_runtime:localdev@localhost:${PORT}/${DB}"
