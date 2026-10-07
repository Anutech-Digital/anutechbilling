#!/usr/bin/env bash
# STAGING database step of the 7 Oct 2026 deploy (R-348) — run BEFORE the live one. Pardeep runs this (Claude may not touch
# the staging DB either — its writes there are refused by design). Set SKIP_BACKUP=1 to skip step 1:
#
#   & "C:\Program Files\Git\bin\bash.exe" "/c/Users/mso50/new-reselleros/production/supabase/cloudsql/staging/deploy-db-2026-10-07.sh"
#
# What it does, in order, stopping at the first problem (set -e + explicit checks):
#   1. On-demand backup of resellersos-staging-db, unless SKIP_BACKUP=1 (gcloud waits for it), and checks it is SUCCESSFUL.
#   2. Read-only PEEK: for each migration in MIGS, is its marker object already on staging?
#   3. Applies only the missing ones, in file order, as the user named in MIGS
#      (resellersos_migration = table/function owner on Cloud SQL; postgres only for files that
#      touch auth.* objects — none today, they only CALL auth.uid()/auth.role()).
#   4. Re-runs cloudsql/09 + 10 grants (re-runnable, same as 6 Oct).
#   5. notify pgrst, 'reload schema' — not optional (6 Oct: skipped once → Report Bug 400).
#   6. PEEK again; prints "DB READY" only if every marker is true.
# It does NOT deploy the app. When this says "DB READY", tell Claude — the code push follows.
#
# ADDING A MIGRATION (e.g. R-346): append ONE line to MIGS below, in file order:
#   "<key>|<file name>|<db user>|<SQL boolean that is true once the file is in>"
# Keys: short, unique, letters/digits only. The same line must go into the live script
# (cloudsql/live/deploy-db-2026-10-07.sh) too.
set -euo pipefail
P=resellsubsos-prod
I=resellersos-staging-db
DB=resellersos
B=gs://resellsubsos-prod-rehearsal/golive/staging-20261007
HERE="$(cd "$(dirname "$0")/../.." && pwd)"   # production/supabase
say() { printf '\n== %s\n' "$1"; }

# ── The migrations, in file order. key | file | db user | PEEK (true = already applied) ──────
MIGS=(
  "checked|20261006130000_feedback_checked.sql|resellersos_migration|exists(select 1 from information_schema.columns where table_schema='public' and table_name='feedback' and column_name='checked_at')"
  "undep|20261006140000_undeposited_funds.sql|resellersos_migration|exists(select 1 from pg_proc where proname='report_balance_sheet' and pronamespace='public'::regnamespace and pg_get_function_result(oid) like '%undeposited_funds%')"
  "leadsrch|20261007000000_lead_search_tokens.sql|resellersos_migration|(exists(select 1 from pg_proc where proname='list_leads' and pronamespace='public'::regnamespace and prosrc like '%lead_search_hit%') and exists(select 1 from pg_proc where proname='lead_counts' and pronamespace='public'::regnamespace and prosrc like '%lead_search_hit%'))"
  "trialconv|20261007010000_trial_convert_on_payment.sql|resellersos_migration|exists(select 1 from pg_trigger where tgname='trg_trial_convert_on_payment' and tgrelid='public.payments'::regclass and not tgisinternal)"
  "compliance|20261007030000_tenant_compliance_profile.sql|resellersos_migration|(exists(select 1 from pg_constraint where conname='tenants_business_type_check') and exists(select 1 from pg_constraint where conname='tenants_gst_filing_check'))"
  "amendactor|20261007040000_contract_amendment_customer_actor.sql|resellersos_migration|exists(select 1 from pg_proc where proname='record_contract_amendment' and pronamespace='public'::regnamespace and prosrc like '%actor_label%')"
  "renewrate|20261007050000_record_payment_renewal_rate.sql|resellersos_migration|exists(select 1 from pg_proc where proname='record_payment' and pronamespace='public'::regnamespace and prosrc like '%renewal_rate%')"
  "salarybill|20261007053000_billing_reads_salary_payments.sql|resellersos_migration|exists(select 1 from pg_policies where schemaname='public' and tablename='salary_payments' and policyname='salary_payments_select_money_roles' and qual like '%billing%')"
  "aggturn|20261007060000_tenant_aggregate_turnover.sql|resellersos_migration|exists(select 1 from pg_constraint where conname='tenants_aggregate_turnover_check')"
  "credit|20261007073000_activate_on_credit.sql|resellersos_migration|exists(select 1 from pg_proc where proname='activate_quote_on_credit' and pronamespace='public'::regnamespace)"
  "testruns|20261007090000_page_test_runs.sql|resellersos_migration|(to_regclass('public.page_test_runs') is not null)"
)
field() { echo "$1" | cut -d'|' -f"$2"; }   # $1 = MIGS line, $2 = 1 key / 2 file / 3 user / 4 peek

# Fail before touching anything if a listed file is missing or a key repeats.
seen=" "
for m in "${MIGS[@]}"; do
  k="$(field "$m" 1)"; f="$(field "$m" 2)"
  [ -f "$HERE/migrations/$f" ] || { echo "Missing file: migrations/$f — nothing changed. Send Claude this screen."; exit 1; }
  case "$seen" in *" $k "*) echo "Key '$k' twice in MIGS — nothing changed."; exit 1;; esac
  seen="$seen$k "
done

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
{
  echo 'DO $$ DECLARE r text; BEGIN'
  echo '  SELECT concat_ws('"' '"
  sep=","
  for m in "${MIGS[@]}"; do
    printf "   %s'%s=' || (%s)::text\n" "$sep" "$(field "$m" 1)" "$(field "$m" 4)"
  done
  echo '  ) INTO r;'
  echo "  RAISE EXCEPTION 'PEEK %', r; END \$\$;"
} > "$TMP/peek-staging.sql"
printf "notify pgrst, 'reload schema';\n" > "$TMP/reload.sql"

peek() { # $1 = sql file that RAISEs 'PEEK …'; prints the PEEK line (the import is MEANT to fail)
  gcloud storage cp "$1" "$B/$(basename "$1")" --project="$P" -q >/dev/null 2>&1
  gcloud sql import sql "$I" "$B/$(basename "$1")" --database="$DB" --user=resellersos_migration --project="$P" --quiet >/dev/null 2>&1 || true
  gcloud sql operations list --instance="$I" --project="$P" --limit=1 --format=json | grep -oE 'PEEK[^\\"]*' | head -1
}
is_true() { echo "$1" | grep -qE "(^| )$2=true( |$)"; }   # $1 = PEEK line, $2 = key

say "0. Who is logged in (must be your account) and which project"
gcloud config get-value account
echo "project: $P   instance: $I   migrations listed: ${#MIGS[@]}"

if [ "${SKIP_BACKUP:-0}" = "1" ]; then
  say "1. Backup SKIPPED (SKIP_BACKUP=1)"
else
  say "1. Backup staging DB before anything changes"
  gcloud sql backups create --instance="$I" --project="$P" --description="before 7 Oct 2026 deploy (${#MIGS[@]} migrations, R-348)"
  gcloud sql backups list --instance="$I" --project="$P" --limit=1 --format="table(id,status,windowStartTime)"
  BST="$(gcloud sql backups list --instance="$I" --project="$P" --limit=1 --format='value(status)')"
  [ "$BST" = "SUCCESSFUL" ] || { echo "Latest backup is '$BST', not SUCCESSFUL — nothing changed. Send Claude this screen."; exit 1; }
fi

say "2. What staging has now (read-only)"
BEFORE="$(peek "$TMP/peek-staging.sql")"
echo "$BEFORE"
[ -n "$BEFORE" ] || { echo "Could not read staging — nothing changed. Send Claude a screenshot."; exit 1; }

apply() { # $1 = migration file name, $2 = db user
  local f="$HERE/migrations/$1"
  echo "-- applying $1 as $2"
  gcloud storage cp "$f" "$B/$1" --project="$P" -q >/dev/null
  if ! gcloud sql import sql "$I" "$B/$1" --database="$DB" --user="$2" --project="$P" --quiet; then
    echo; echo "STOPPED at $1. Files after it were NOT applied. (feedback_checked + salary_payments roll back whole; the others have no begin/commit and may be partly in — all are re-runnable, but Claude checks before any retry.)"
    gcloud sql operations list --instance="$I" --project="$P" --limit=1 --format="value(error.errors[0].message)" | tr '\\' '\n' | grep -E "ERROR" | head -3
    echo "Send Claude this screen. Do not retry by hand."
    exit 1
  fi
}

say "3. Apply what is missing, in file order"
for m in "${MIGS[@]}"; do
  k="$(field "$m" 1)"
  if is_true "$BEFORE" "$k"; then echo "-- $k: already on staging, skipped"
  else apply "$(field "$m" 2)" "$(field "$m" 3)"; fi
done

say "3b. Grant what the RLS policies already allow (cloudsql/09) — re-runnable"
gcloud storage cp "$HERE/cloudsql/09-grant-what-policies-allow.sql" "$B/09-grant.sql" --project="$P" -q >/dev/null
gcloud sql import sql "$I" "$B/09-grant.sql" --database="$DB" --user=resellersos_migration --project="$P" --quiet

say "3c. service_role may run the functions RLS policies call (cloudsql/10) — re-runnable"
gcloud storage cp "$HERE/cloudsql/10-service-role-policy-functions.sql" "$B/10-grants.sql" --project="$P" -q >/dev/null
gcloud sql import sql "$I" "$B/10-grants.sql" --database="$DB" --user=resellersos_migration --project="$P" --quiet

say "4. Tell PostgREST about the new columns/functions (schema reload)"
gcloud storage cp "$TMP/reload.sql" "$B/reload.sql" --project="$P" -q >/dev/null
gcloud sql import sql "$I" "$B/reload.sql" --database="$DB" --user=resellersos_migration --project="$P" --quiet

say "5. What staging has now"
AFTER="$(peek "$TMP/peek-staging.sql")"
echo "$AFTER"
missing=""
for m in "${MIGS[@]}"; do
  k="$(field "$m" 1)"; is_true "$AFTER" "$k" || missing="$missing $k"
done
if [ -n "$AFTER" ] && [ -z "$missing" ]; then
  say "DB READY — tell Claude 'db ho gaya' and it will push the app."
else
  echo "Still missing:${missing:- (could not read staging)} — send Claude this screen."; exit 1
fi
