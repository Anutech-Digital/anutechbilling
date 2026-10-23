#!/usr/bin/env bash
# R-1775 (23 Oct 2026) - STAGING ONLY: delete ALL data of ONE company (Anutech Digital) on the staging DB,
# keeping only its logins, company settings, secrets/integration keys and numbering config.
# Every other company, and E2E Test Co (staging's automatic tests), is never touched.
# Pardeep runs this in his own terminal (Claude may not touch the staging DB). The SQL, with the
# KEEP-LIST, is wipe-tenant-transactions.sql next to this file.
#
# ── RUNBOOK ──────────────────────────────────────────────────────────────────────────────────────
# 1) DRY RUN (the default - changes nothing). Takes a backup, finds the company, then rehearses the
#    whole delete inside one transaction, checks every count, and rolls it back. Prints the company
#    (name | id | GSTIN), how many rows each table would lose, and the keep-list counts:
#
#      & "C:\Program Files\Git\bin\bash.exe" "/c/Users/mso50/reselleros-deploy/production/supabase/cloudsql/staging/wipe-tenant-transactions.sh"
#
#    Two or more companies match "anutech digital"? It stops and lists them; pick one by GSTIN:
#      $env:ANUTECH_MATCH="<GSTIN>"; & "C:\Program Files\Git\bin\bash.exe" "/c/.../wipe-tenant-transactions.sh"
#
# 2) APPLY - only after Pardeep has read the dry-run numbers and said yes. The id is typed twice:
#
#      $env:APPLY="1"; $env:TENANTS="<id from the dry run>"; $env:CONFIRM="<same id again>"
#      & "C:\Program Files\Git\bin\bash.exe" "/c/Users/mso50/reselleros-deploy/production/supabase/cloudsql/staging/wipe-tenant-transactions.sh"
#      Remove-Item Env:APPLY, Env:TENANTS, Env:CONFIRM
#
#    It takes a NEW backup, re-runs the dry run (must find the same id), deletes in ONE transaction
#    (any failed check -> everything rolls back), then prints what is left: every wiped table must
#    show 0 and the keep-list must equal the dry run.
#
# 3) GOING BACK = restore the backup this script printed (step 1 of the same run). This puts the WHOLE
#    staging instance back to that moment - every company, every change made after it is lost too:
#
#      gcloud sql backups list --instance=resellersos-staging-db --project=resellsubsos-prod --limit=5
#      gcloud sql backups restore <BACKUP_ID> --restore-instance=resellersos-staging-db --backup-instance=resellersos-staging-db --project=resellsubsos-prod
#
# Not touched: storage files (screenshots, uploads, PDFs) - only database rows go; their links just
# stop pointing anywhere. Document numbering (document_series, customer_number_seq) is KEPT, so the
# next invoice/quote number continues where it was; resetting it is a separate decision, not done here.
# Every trigger is switched off only for the wiped tables and only inside the transaction, and put
# back to its exact mode before it commits (why not session_replication_role: see the .sql).
# Refuses: any instance other than resellersos-staging-db, APPLY without TENANTS + CONFIRM, CONFIRM
# different from TENANTS, an id that is not the company found by name now, E2E Test Co, SKIP_BACKUP with APPLY.
set -euo pipefail
STAGING_I=resellersos-staging-db
P=resellsubsos-prod
I="${INSTANCE:-$STAGING_I}"
DB=resellersos
B=gs://resellsubsos-prod-rehearsal/golive/staging-20261007
HERE="$(cd "$(dirname "$0")" && pwd)"
SQL="$HERE/wipe-tenant-transactions.sql"
E2E=f588b89d-6ba2-4abe-b8b3-e4821a65e7b4
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
say() { printf '\n== %s\n' "$1"; }
refuse() { printf '\nREFUSED: %s\nNothing was run and nothing changed.\n' "$1"; exit 2; }

# ── Guards. No gcloud call happens before every one of these passes. ─────────────────────────────
[ "$I" = "$STAGING_I" ] || refuse "instance '$I' is not $STAGING_I. This script wipes STAGING only (live is resellersos-db)."
[ -f "$SQL" ] || refuse "missing $SQL"
MATCH="${ANUTECH_MATCH:-anutech digital}"
printf '%s' "$MATCH" | grep -Eq '^[A-Za-z0-9 .-]{3,60}$' || refuse "ANUTECH_MATCH may only use letters, digits, space, dot, dash (3-60 long)."
TENANTS="$(printf '%s' "${TENANTS:-}" | tr 'A-F' 'a-f' | tr -d ' ')"
CONFIRM="$(printf '%s' "${CONFIRM:-}" | tr 'A-F' 'a-f' | tr -d ' ')"
case "${APPLY:-0}" in
  0) MODE=dry ;;
  1) MODE=apply
     [ -n "$TENANTS" ] || refuse "APPLY=1 needs TENANTS=<the company id the dry run printed>."
     [ -n "$CONFIRM" ] || refuse "APPLY=1 needs CONFIRM=<the same company id typed again>."
     printf '%s' "$TENANTS" | grep -Eq "$UUID_RE" || refuse "TENANTS must be exactly ONE company id (like 1234abcd-....)."
     [ "$CONFIRM" = "$TENANTS" ] || refuse "CONFIRM ($CONFIRM) is not the same as TENANTS ($TENANTS)."
     [ "$TENANTS" != "$E2E" ] || refuse "that id is E2E Test Co - it is never wiped."
     [ "${SKIP_BACKUP:-0}" = "0" ] || refuse "SKIP_BACKUP is not allowed with APPLY=1 - the backup is the only way back."
     ;;
  *) refuse "APPLY must be 0 (dry run) or 1." ;;
esac

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

run_sql() { # $1 = dry | apply | after. Prints the WIPE... line (dry/after are MEANT to fail: RAISE carries the output)
  local f="$TMP/wipe-$1.sql"
  sed -e "s/__MODE__/$1/" -e "s/__ANUTECH_MATCH__/$MATCH/" \
      -e "s/__TENANTS__/${TENANTS:-00000000-0000-0000-0000-000000000000}/" "$SQL" > "$f"
  gcloud storage cp "$f" "$B/r1775-wipe-$1.sql" --project="$P" -q >/dev/null 2>&1 || { echo "UPLOAD-FAILED to $B"; return 0; }
  if gcloud sql import sql "$I" "$B/r1775-wipe-$1.sql" --database="$DB" --user=resellersos_migration --project="$P" --quiet >/dev/null 2>&1; then
    echo "IMPORT-OK"
  else
    gcloud sql operations list --instance="$I" --project="$P" --limit=1 --format=json | grep -oE 'WIPE[A-Z]+ [^\\"]*' | head -1 || true
    gcloud sql operations list --instance="$I" --project="$P" --limit=1 --format="value(error.errors[0].message)" | tr '\\' '\n' | grep -E "ERROR" | grep -v WIPE | head -3 || true
  fi
}
show() { printf '%s\n' "$1" | sed 's/ || /\n   /g'; }

say "0. Who is logged in (must be your account), which project and instance"
ACCT="$(gcloud config get-value account 2>/dev/null || true)"
echo "account: ${ACCT:-<none>}   project: $P   instance: $I   database: $DB   mode: $MODE   match: $MATCH"
[ -n "$ACCT" ] || { echo "Not logged in - run: gcloud auth login. Nothing changed."; exit 1; }
FOUND="$(gcloud sql instances describe "$I" --project="$P" --format='value(name)' 2>/dev/null || true)"
[ "$FOUND" = "$STAGING_I" ] || refuse "gcloud describes instance '$FOUND', not $STAGING_I."

if [ "$MODE" = "dry" ] && [ "${SKIP_BACKUP:-0}" = "1" ]; then
  say "1. Backup SKIPPED (SKIP_BACKUP=1, dry run only)"
  BID="(none taken)"
else
  say "1. Backup staging DB before anything changes"
  gcloud sql backups create --instance="$I" --project="$P" --description="before R-1775 wipe of one company ($MODE)"
  gcloud sql backups list --instance="$I" --project="$P" --limit=1 --format="table(id,status,windowStartTime)"
  BST="$(gcloud sql backups list --instance="$I" --project="$P" --limit=1 --format='value(status)')"
  BID="$(gcloud sql backups list --instance="$I" --project="$P" --limit=1 --format='value(id)')"
  [ "$BST" = "SUCCESSFUL" ] || { echo "Latest backup is '$BST', not SUCCESSFUL - nothing changed. Send Claude this screen."; exit 1; }
  echo "Backup id: $BID   (way back: gcloud sql backups restore $BID --restore-instance=$I --backup-instance=$I --project=$P)"
fi

say "2. DRY RUN - rehearse the delete in one transaction, check every count, roll back (nothing changes)"
DRY="$(run_sql dry)"
show "$DRY"
case "$DRY" in
  WIPEDRY*) ;;
  *) echo "Dry run did not finish - nothing changed. Send Claude this screen."; exit 1 ;;
esac
FOUND_ID="$(printf '%s' "$DRY" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)"
DRY_KEEP="$(printf '%s' "$DRY" | grep -oE 'KEEP\{[^}]*\}' | head -1 || true)"

if [ "$MODE" = "dry" ]; then
  say "DRY RUN DONE - nothing changed. Read the numbers above with Pardeep."
  echo "Only after his yes, apply (PowerShell):"
  echo "  \$env:APPLY=\"1\"; \$env:TENANTS=\"$FOUND_ID\"; \$env:CONFIRM=\"$FOUND_ID\""
  echo "  & \"C:\\Program Files\\Git\\bin\\bash.exe\" \"/c/Users/mso50/reselleros-deploy/production/supabase/cloudsql/staging/wipe-tenant-transactions.sh\""
  echo "  Remove-Item Env:APPLY, Env:TENANTS, Env:CONFIRM"
  exit 0
fi

[ "$FOUND_ID" = "$TENANTS" ] || refuse "the dry run found company $FOUND_ID, but TENANTS is $TENANTS."

say "3. APPLY - one transaction: delete, check every count, commit (any failed check rolls everything back)"
OUT="$(run_sql apply)"
if [ "$OUT" != "IMPORT-OK" ]; then
  show "$OUT"
  echo "STOPPED - the transaction rolled back, nothing changed. Send Claude this screen."
  exit 1
fi
echo "committed."

say "4. What is left now (read-only)"
AFTER="$(run_sql after)"
show "$AFTER"
AFTER_KEEP="$(printf '%s' "$AFTER" | grep -oE 'KEEP\{[^}]*\}' | head -1 || true)"
if printf '%s' "$AFTER" | grep -q 'LEFT{total=0 ' && [ -n "$AFTER_KEEP" ] && [ "$AFTER_KEEP" = "$DRY_KEEP" ]; then
  say "WIPE DONE - every wiped table is 0 and the keep-list equals the dry run."
  echo "Backup to go back to: $BID"
else
  echo "After-check does not match (left rows, or keep-list differs from the dry run: $DRY_KEEP). Send Claude this screen."
  echo "Backup to go back to: $BID"
  exit 1
fi
