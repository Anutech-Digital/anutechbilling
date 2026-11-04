#!/usr/bin/env bash
# R-2223 (31 Oct 2026): invoices raised BEFORE the R-2095 fix were dated the day they were SAVED,
# not the day the money came in (e.g. I-XL INV-A378-27-0064: money 20 Apr 2026, invoice 30 Oct).
# This moves each such invoice to its receipt's date (due date and, where it was the save day,
# paid date move with it). Pardeep chose this (option a) on card R-2223.
#
# Pardeep runs it — Claude may not write to staging or live. NOT part of any deploy script.
# From PowerShell (staging first; live only after staging is checked):
#   & "C:\Program Files\Git\bin\bash.exe" "<repo>/production/supabase/cloudsql/live/r2223-invoice-dates/run.sh" staging
#   & "C:\Program Files\Git\bin\bash.exe" "<repo>/production/supabase/cloudsql/live/r2223-invoice-dates/run.sh" live
# Undo (puts every changed date back from the undo record):
#   … run.sh staging undo        /   … run.sh live undo
#
# What it does, stopping at the first problem:
#   1. Shows the gcloud account and the target.
#   2. Live only: a Cloud SQL backup first.
#   3. Read-only count (staging dry run, 31 Oct: repair=81 cross_month=11 cross_taxable=1400662
#      same_month=70 same_taxable=1983067 skipped=0).
#   4. Asks you to type  haan  before changing anything.
#   5. One transaction: moves the dates, writes one activity-log line per invoice and an undo
#      record (table r2223_invoice_date_repair), then checks itself — if any invoice did not
#      move, NOTHING is saved.
#   6. Counts again: repair=0 and undo_rows=<how many moved>.
# Safe to run twice: the second run finds nothing to move.
set -euo pipefail
case "${1:-}" in
  staging) I=resellersos-staging-db; ENV=STAGING ;;
  live)    I=resellersos-db;         ENV=LIVE ;;
  *) echo "Usage: run.sh staging|live [undo]  — say which database (no default)."; exit 2 ;;
esac
MODE="${2:-apply}"
P=resellsubsos-prod
DB=resellersos
B=gs://resellsubsos-prod-rehearsal/golive/r2223-invoice-dates-$I
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
say() { printf '\n== %s\n' "$1"; }

# rows.sql pasted where a body file says __ROWS__
with_rows() { awk -v RF="$HERE/rows.sql" '/__ROWS__/{while((getline l < RF)>0) print l; close(RF); next} {print}' "$1"; }

{ echo "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;"
  echo 'DO $$ DECLARE r text; BEGIN'
  with_rows "$HERE/peek-body.sql"
  echo "RAISE EXCEPTION 'PEEK %', r; END \$\$;"; } > "$TMP/peek.sql"

{ echo "begin;"
  echo "create temp view r2223_live as"
  cat "$HERE/rows.sql"
  echo ";"
  echo "create temp table r2223_rows on commit drop as select * from r2223_live;"
  cat "$HERE/apply-body.sql"
  echo "commit;"; } > "$TMP/apply.sql"

peek() {
  gcloud storage cp "$TMP/peek.sql" "$B/peek.sql" --project="$P" -q >/dev/null 2>&1
  gcloud sql import sql "$I" "$B/peek.sql" --database="$DB" --user=resellersos_migration --project="$P" --quiet >/dev/null 2>&1 || true
  gcloud sql operations list --instance="$I" --project="$P" --limit=1 --format=json | grep -oE 'PEEK[^\\"]*' | head -1
}

say "0. Account and target ($ENV: $I, $MODE)"
gcloud config get-value account

if [ "$ENV" = "LIVE" ]; then
  say "1. Backup before anything changes"
  gcloud sql backups create --instance="$I" --project="$P" --description="before R-2223 invoice-date repair ($MODE)"
fi

say "2. What would change (read-only)"
BEFORE="$(peek)"
[ -n "$BEFORE" ] || { echo "Could not read the database — nothing changed. Send Claude a screenshot."; exit 1; }
echo "$BEFORE"

if [ "$MODE" = "undo" ]; then
  echo "$BEFORE" | grep -q "undo_rows=none" && { say "No repair to undo. Done."; exit 0; }
  printf '\nType haan to PUT BACK the old invoice dates on %s: ' "$ENV"
  read -r OK; [ "$OK" = "haan" ] || { echo "Stopped — nothing changed."; exit 0; }
  gcloud storage cp "$HERE/undo.sql" "$B/undo.sql" --project="$P" -q >/dev/null
  gcloud sql import sql "$I" "$B/undo.sql" --database="$DB" --user=resellersos_migration --project="$P" --quiet \
    || { echo "STOPPED — one transaction, nothing was written. Send Claude this screen."; exit 1; }
  say "After"; peek; say "UNDO DONE"; exit 0
fi

if echo "$BEFORE" | grep -q "PEEK repair=0 "; then say "Nothing to move. Done."; exit 0; fi
printf '\nType haan to move these invoice dates on %s: ' "$ENV"
read -r OK
[ "$OK" = "haan" ] || { echo "Stopped — nothing changed."; exit 0; }

say "3. Moving the dates (one transaction)"
gcloud storage cp "$TMP/apply.sql" "$B/apply.sql" --project="$P" -q >/dev/null
if ! gcloud sql import sql "$I" "$B/apply.sql" --database="$DB" --user=resellersos_migration --project="$P" --quiet; then
  echo "STOPPED — the change runs in one transaction, so nothing was written. Send Claude this screen."
  exit 1
fi

say "4. After (expect repair=0 and undo_rows = the number moved)"
peek
say "DONE — tell Claude 'R-2223 ho gaya' with the two PEEK lines."
