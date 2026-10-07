#!/usr/bin/env bash
# LIVE database step of the 6 Oct 2026 deploy (5 Oct's app deploy never went out — live is still on
# a3d3564 from 4 Oct — so this carries the 5 Oct migrations too, and skips whatever is already in). Pardeep runs this (Claude may not touch the live
# DB — production reads/writes are blocked for it, by design):
#
#   & "C:\Program Files\Git\bin\bash.exe" "/c/Users/mso50/new-reselleros/production/supabase/cloudsql/live/deploy-db-2026-10-06.sh"
#
# What it does, in order, stopping at the first problem:
#   1. On-demand backup of resellersos-db (and waits for it).
#   2. Read-only check: which of the 7 migrations (5 + 6 Oct) are already on live.
#   3. Applies only the missing ones, in file order — the two Academy files as `postgres`
#      (they touch auth.users; staging was done the same way), the other three as
#      `resellersos_migration` (the table owner on Cloud SQL).
#   4. notify pgrst, 'reload schema'  — skipped on staging once today, and Report Bug then
#      failed with a 400 until it was run. Not optional.
#   5. Checks again and prints what live now has.
# It does NOT deploy the app. When this says "DB READY", tell Claude — the code push follows.
set -euo pipefail
P=resellsubsos-prod
I=resellersos-db
DB=resellersos
B=gs://resellsubsos-prod-rehearsal/golive/live-20261006
HERE="$(cd "$(dirname "$0")/../.." && pwd)"   # production/supabase
say() { printf '\n== %s\n' "$1"; }

peek() { # $1 = sql file that RAISEs 'PEEK …'; prints the PEEK line
  gcloud storage cp "$1" "$B/$(basename "$1")" --project="$P" -q >/dev/null 2>&1
  gcloud sql import sql "$I" "$B/$(basename "$1")" --database="$DB" --user=resellersos_migration --project="$P" --quiet >/dev/null 2>&1 || true
  gcloud sql operations list --instance="$I" --project="$P" --limit=1 --format=json | grep -oE 'PEEK[^\\"]*' | head -1
}

TMP="$(mktemp -d)"
cat > "$TMP/peek-live.sql" <<'EOF'
DO $$ DECLARE r text; BEGIN
  SELECT concat_ws(' ',
   'academy1=' || (to_regclass('public.academy_apprentices') is not null)::text,
   'academy2=' || (to_regclass('public.academy_evaluations') is not null)::text,
   'years='    || exists(select 1 from information_schema.columns where table_schema='public' and table_name='provisioning_requests' and column_name='years')::text,
   'filedvia=' || exists(select 1 from information_schema.columns where table_schema='public' and table_name='feedback' and column_name='filed_via')::text,
   'runs='     || (to_regclass('public.payment_runs') is not null)::text,
   'checked='  || exists(select 1 from information_schema.columns where table_schema='public' and table_name='feedback' and column_name='checked_at')::text,
   'undep='    || exists(select 1 from pg_proc where proname='report_balance_sheet' and pg_get_function_result(oid) like '%undeposited_funds%')::text) INTO r;
  RAISE EXCEPTION 'PEEK %', r; END $$;
EOF
printf "notify pgrst, 'reload schema';\n" > "$TMP/reload.sql"

say "0. Who is logged in (must be your account) and which project"
gcloud config get-value account
echo "project: $P   instance: $I"

say "1. Backup live DB before anything changes"
gcloud sql backups create --instance="$I" --project="$P" --description="before 6 Oct 2026 deploy (a3d3564 -> manager-pardeep, 7 migrations)"
gcloud sql backups list --instance="$I" --project="$P" --limit=1 --format="table(id,status,windowStartTime)"

say "2. What live has now (read-only)"
BEFORE="$(peek "$TMP/peek-live.sql")"
echo "$BEFORE"
[ -n "$BEFORE" ] || { echo "Could not read live — nothing changed. Send Claude a screenshot."; exit 1; }
has() { echo "$BEFORE" | grep -q "$1=true"; }

apply() { # $1 = migration file name, $2 = db user
  local f="$HERE/migrations/$1"
  echo "-- applying $1 as $2"
  gcloud storage cp "$f" "$B/$1" --project="$P" -q >/dev/null
  if ! gcloud sql import sql "$I" "$B/$1" --database="$DB" --user="$2" --project="$P" --quiet; then
    echo; echo "STOPPED at $1. Files after it were NOT applied. (The three 5-Oct files roll back whole; the Academy files have no transaction and may be partly in — Claude checks before any retry.)"
    gcloud sql operations list --instance="$I" --project="$P" --limit=1 --format="value(error.errors[0].message)" | tr '\\' '\n' | grep -E "ERROR" | head -3
    echo "Send Claude this screen. Do not retry by hand."
    exit 1
  fi
}

say "3. Apply what is missing, in order"
has academy1 || apply 20261004150000_academy_phase1.sql postgres
has academy2 || apply 20261004160000_academy_phase2.sql postgres
has years    || apply 20261005090000_provisioning_requests_years.sql resellersos_migration
has filedvia || apply 20261005100000_feedback_filed_via_ai_chat.sql resellersos_migration
has runs     || apply 20261005110000_payment_runs.sql resellersos_migration
has checked  || apply 20261006130000_feedback_checked.sql resellersos_migration
has undep    || apply 20261006140000_undeposited_funds.sql resellersos_migration

say "3b. Grant what the RLS policies already allow (cloudsql/09) — fixed a 403 on staging"
# Staging, 5 Oct: /subscriptions got 403 on customer_contacts — 30 tables had policies for
# signed-in users but no GRANT (migrations written the hosted-Supabase way). Live very likely has
# the same gap. Grants only what each policy covers; server-only tables stay closed. Re-runnable.
gcloud storage cp "$HERE/cloudsql/09-grant-what-policies-allow.sql" "$B/09-grant.sql" --project="$P" -q >/dev/null
gcloud sql import sql "$I" "$B/09-grant.sql" --database="$DB" --user=resellersos_migration --project="$P" --quiet

say "3c. service_role may run the functions RLS policies call (cloudsql/10) — R-165"
gcloud storage cp "$HERE/cloudsql/10-service-role-policy-functions.sql" "$B/10-grants.sql" --project="$P" -q >/dev/null
gcloud sql import sql "$I" "$B/10-grants.sql" --database="$DB" --user=resellersos_migration --project="$P" --quiet

say "4. Tell PostgREST about the new columns (schema reload)"
gcloud storage cp "$TMP/reload.sql" "$B/reload.sql" --project="$P" -q >/dev/null
gcloud sql import sql "$I" "$B/reload.sql" --database="$DB" --user=resellersos_migration --project="$P" --quiet

say "5. What live has now"
AFTER="$(peek "$TMP/peek-live.sql")"
echo "$AFTER"
if echo "$AFTER" | grep -q "academy1=true academy2=true years=true filedvia=true runs=true checked=true undep=true"; then
  say "DB READY — tell Claude 'db ho gaya' and it will push the app."
else
  echo "Something is still missing — send Claude this screen."; exit 1
fi
