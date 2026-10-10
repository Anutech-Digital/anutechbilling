#!/usr/bin/env bash
# R-909 — bring a LIVE-shaped Cloud SQL database to the schema staging runs (R-161 path), by the
# SAME steps staging took. Runbook: docs/R-909-LIVE-CUTOVER.md (section "DB").
#
# DRY RUN BY DEFAULT (RUN=0): prints every gcloud command and changes nothing — no peek, no
# import, nothing reaches any instance. RUN=1 executes. Run it from a checkout of the STAGING
# commit you will deploy (it needs prisma/migrations, db/ops and supabase/cloudsql/staging/
# deploy-db-2026-10-07.sh from that commit). Git Bash on Windows:
#
#   # 1) rehearsal on a clone of live (by 15 Oct)
#   INSTANCE=resellersos-r909-rehearsal          bash scripts/ops/r909-live-db.sh          # dry run
#   INSTANCE=resellersos-r909-rehearsal RUN=1    bash scripts/ops/r909-live-db.sh          # do it
#   # 2) fingerprints (read-only exports), then compare clone vs staging
#   MODE=fingerprint INSTANCE=resellersos-r909-rehearsal RUN=1 bash scripts/ops/r909-live-db.sh
#   MODE=fingerprint INSTANCE=resellersos-staging-db     RUN=1 bash scripts/ops/r909-live-db.sh
#   MODE=compare A=<dir of clone export> B=<dir of staging export> bash scripts/ops/r909-live-db.sh
#   # 3) cutover (17 Oct, after 17:00 IST, Pardeep's haan)
#   INSTANCE=resellersos-db LIVE_HAAN=1 RUN=1 bash scripts/ops/r909-live-db.sh
#
# MODE=apply (default) does, stopping at the first problem:
#   0. guards: never the staging instance; resellersos-db only with LIVE_HAAN=1; target must NOT
#      carry public.zz_staging_marker (the marker that makes staging scripts run).
#   1. on-demand backup (live only; a clone is its own backup) and checks it is SUCCESSFUL.
#   2. PEEK (read-only RAISE): which of the steps below are already in.
#   3. supabase/migrations 4 Oct files staging has and live may not (email_verifications, lead key
#      grants, employee advance edit) — as resellersos_migration, no rewrite (pre-R-161).
#   4. R-161 roles app_runtime/jobs/anon/service/auth (db/ops/10 + 20), passwords as SCRAM verifiers;
#      on resellersos-db the passwords go straight to Secret Manager live-db-app-<role>-password,
#      on a clone they are thrown away (nothing connects to a clone).
#   5. R-161 Prisma: _prisma_migrations + 0_init + the five 5/6 Oct migrations, tenant_context with
#      the payment-runs rewrite inside the same transaction (exactly r161-step2-prisma.sh).
#   6. prisma 20261006110000_mfa_last_challenged_at (auth.mfa_factors column) as postgres.
#   7. every migration in staging's deploy-db-2026-10-07.sh MIGS that is not in yet, with staging's
#      auth.uid()/auth.role() -> current_user_id()/current_request_role() rewrite, as its MIGS user.
#   8. db/ops/21-auth-login-link.sql (postgres), cloudsql/09 + 10 grants (re-runnable).
#   9. PEEK again — "DB READY" only if every key is true. Then run MODE=fingerprint + compare.
set -euo pipefail
P=resellsubsos-prod
DB=resellersos
MODE="${MODE:-apply}"
RUN="${RUN:-0}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"            # production/
SUPA="$ROOT/supabase"
MIG="$ROOT/prisma/migrations"
STG_SCRIPT="$SUPA/cloudsql/staging/deploy-db-2026-10-07.sh"
say() { printf '\n== %s\n' "$1"; }
win() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

if [ "$MODE" = compare ]; then
  : "${A:?A=<folder with fingerprint.csv of the clone/live>}" "${B:?B=<folder with fingerprint.csv of staging>}"
  say "Schema difference (< only in A, > only in B). Empty = same."
  diff <(sort "$A/fingerprint.csv") <(sort "$B/fingerprint.csv") | awk -F, '/^[<>]/{print $1" "$2" "$3}' | sort -k2 | head -400 || true
  n="$(diff <(sort "$A/fingerprint.csv") <(sort "$B/fingerprint.csv") | grep -c '^[<>]' || true)"
  echo "differing lines: $n"; [ "$n" = 0 ] && echo "SAME SCHEMA" || exit 1
  exit 0
fi

I="${INSTANCE:?set INSTANCE=resellersos-r909-rehearsal (clone) | resellersos-db (live) | resellersos-staging-db (fingerprint only)}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
B=gs://resellsubsos-prod-rehearsal/r909/$I-$STAMP
TMP="$(mktemp -d -p "${TEMP:-/tmp}" 2>/dev/null || mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

x() { # run, or print in dry run
  if [ "$RUN" = 1 ]; then "$@"; else printf '  [dry-run]'; printf ' %q' "$@"; printf '\n'; fi
}

if [ "$MODE" = fingerprint ]; then
  say "Fingerprint of $I (read-only export to $B)"
  Q="$(grep -v '^--' "$ROOT/scripts/ops/r909-schema-fingerprint.sql" | tr '\n' ' ')"
  RC="select n.nspname || '.' || c.relname as tbl, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text as rows from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'r' and n.nspname in ('public','auth','storage') order by 1"
  x gcloud sql export csv "$I" "$B/fingerprint.csv" --database="$DB" --project="$P" --query="$Q" --quiet
  x gcloud sql export csv "$I" "$B/rowcounts.csv" --database="$DB" --project="$P" --query="$RC" --quiet
  OUT="${OUT:-${TEMP:-/tmp}/r909/$I-$STAMP}"
  x mkdir -p "$OUT"
  x gcloud storage cp "$B/fingerprint.csv" "$B/rowcounts.csv" "$(win "$OUT")/" --project="$P"
  echo "Saved under $OUT (fingerprint.csv = schema hashes, rowcounts.csv = rows per table; no row data)."
  exit 0
fi

# ── MODE=apply ────────────────────────────────────────────────────────────────
case "$I" in
  resellersos-staging-db) echo "Refused: staging already has all of this. This script is for the live DB or its clone."; exit 1 ;;
  resellersos-db) [ "${LIVE_HAAN:-}" = 1 ] || { echo "Refused: resellersos-db is LIVE. Set LIVE_HAAN=1 only after Pardeep's haan (runbook step 4)."; exit 1; } ;;
esac
for f in "$STG_SCRIPT" "$ROOT/db/ops/10-runtime-roles.sql" "$ROOT/db/ops/20-auth-login.sql" "$ROOT/db/ops/21-auth-login-link.sql" \
         "$MIG/20261005120000_tenant_context/migration.sql" "$MIG/20261006110000_mfa_last_challenged_at/migration.sql" \
         "$SUPA/cloudsql/09-grant-what-policies-allow.sql" "$SUPA/cloudsql/10-service-role-policy-functions.sql"; do
  [ -f "$f" ] || { echo "Missing $f — run this from a checkout of the STAGING commit (it has R-161). Nothing changed."; exit 1; }
done

# MIGS from staging's own deploy script = the list staging was brought up with (single source).
mapfile -t MIGS < <(sed -n '/^MIGS=($/,/^)$/p' "$STG_SCRIPT" | sed -n 's/^  "\(.*\)"$/\1/p')
[ "${#MIGS[@]}" -gt 0 ] || { echo "No MIGS read from $STG_SCRIPT — nothing changed."; exit 1; }
field() { echo "$1" | cut -d'|' -f"$2"; }
migsrc() { if [ -f "$SUPA/migrations/$1" ]; then echo "$SUPA/migrations/$1"; elif [ -f "$MIG/${1%.sql}/migration.sql" ]; then echo "$MIG/${1%.sql}/migration.sql"; fi; }
for m in "${MIGS[@]}"; do [ -n "$(migsrc "$(field "$m" 2)")" ] || { echo "Missing file $(field "$m" 2) — nothing changed."; exit 1; }; done

# Pre-R-161 files: key|file|user|peek
PRE=(
  "emailver|20261004100000_email_verifications.sql|resellersos_migration|(to_regclass('public.email_verifications') is not null)"
  "leadkeys|20261004120000_lead_key_functions_service_role.sql|resellersos_migration|has_function_privilege('service_role', 'public.lead_norm_phone(text)', 'execute')"
  "advedit|20261004130000_employee_advance_edit_delete.sql|resellersos_migration|exists(select 1 from pg_proc where proname='update_employee_advance' and pronamespace='public'::regnamespace)"
)
PRISMA5=(20261005120000_tenant_context 20261005130000_jobs_scope 20261005140000_lock_prisma_migrations 20261005150000_gateway_logins 20261006090000_payment_runs_tenant_context)

{
  echo 'DO $$ DECLARE r text; BEGIN'
  echo "  SELECT concat_ws(' '"
  echo "   ,'nomarker=' || (to_regclass('public.zz_staging_marker') is null)::text"
  for m in "${PRE[@]}"; do printf "   ,'%s=' || (%s)::text\n" "$(field "$m" 1)" "$(field "$m" 4)"; done
  echo "   ,'approles=' || ((select count(*) from pg_roles where rolname in ('app_runtime','app_jobs','app_anon','app_service','app_auth')) = 5)::text"
  echo "   ,'prisma=' || (to_regclass('public._prisma_migrations') is not null)::text"
  echo "   ,'cuid=' || (exists(select 1 from pg_proc where proname='current_user_id' and pronamespace='public'::regnamespace) and exists(select 1 from pg_proc where proname='current_request_role' and pronamespace='public'::regnamespace) and exists(select 1 from pg_proc where proname='jobs_list_tenants'))::text"
  echo "   ,'mfa=' || exists(select 1 from pg_attribute where attrelid = to_regclass('auth.mfa_factors') and attname = 'last_challenged_at' and not attisdropped)::text"
  for m in "${MIGS[@]}"; do printf "   ,'%s=' || (%s)::text\n" "$(field "$m" 1)" "$(field "$m" 4)"; done
  echo "  ) INTO r;"
  echo "  RAISE EXCEPTION 'PEEK %', r; END \$\$;"
} > "$TMP/peek.sql"

peek() { # the import is MEANT to fail with 'PEEK …'; prints that line
  gcloud storage cp "$(win "$TMP/peek.sql")" "$B/peek.sql" --project="$P" -q >/dev/null 2>&1
  gcloud sql import sql "$I" "$B/peek.sql" --database="$DB" --user=resellersos_migration --project="$P" --quiet >/dev/null 2>&1 || true
  gcloud sql operations list --instance="$I" --project="$P" --limit=1 --format=json | grep -oE 'PEEK[^\\"]*' | head -1
}
is_true() { echo "$1" | grep -qE "(^| )$2=true([^a-z0-9_]|$)"; }
imp() { # $1 local file, $2 object name, $3 db user
  if [ "$RUN" != 1 ]; then echo "  [dry-run] gcloud storage cp <$2> $B/$2 && gcloud sql import sql $I $B/$2 --database=$DB --user=$3 --project=$P --quiet"; return; fi
  gcloud storage cp "$(win "$1")" "$B/$2" --project="$P" -q >/dev/null
  if ! gcloud sql import sql "$I" "$B/$2" --database="$DB" --user="$3" --project="$P" --quiet >/dev/null 2>&1; then
    echo "STOPPED at $2 (as $3). Nothing after it ran."
    gcloud sql operations list --instance="$I" --project="$P" --limit=1 --format="value(error.errors[0].message)" | tr '\\' '\n' | grep -E "ERROR|DETAIL|HINT" | head -4
    gcloud storage rm "$B/$2" --project="$P" -q >/dev/null 2>&1 || true
    echo "Send Claude this screen. Do not retry by hand."; exit 1
  fi
  echo "  ok: $2"
}
checksum() { sha256sum "$MIG/$1/migration.sql" | cut -c1-64; }
prisma_row() { # $1 migration name, $2 steps
  printf "insert into public._prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count) select gen_random_uuid()::text, '%s', now(), '%s', %s where not exists (select 1 from public._prisma_migrations where migration_name = '%s');\n" \
    "$(checksum "$1")" "$1" "$2" "$1" > "$TMP/row-$1.sql"
  imp "$TMP/row-$1.sql" "row-$1.sql" resellersos_migration
}

say "0. Who / where"
gcloud config get-value account 2>/dev/null || true
echo "instance: $I   project: $P   RUN=$RUN   staging MIGS: ${#MIGS[@]}"

if [ "$I" = resellersos-db ]; then
  say "1. Backup of LIVE before anything changes"
  x gcloud sql backups create --instance="$I" --project="$P" --description="R-909 before cutover ($STAMP)"
  if [ "$RUN" = 1 ]; then
    BST="$(gcloud sql backups list --instance="$I" --project="$P" --limit=1 --format='value(status)')"
    [ "$BST" = SUCCESSFUL ] || { echo "Latest backup is '$BST', not SUCCESSFUL — nothing changed."; exit 1; }
    gcloud sql backups list --instance="$I" --project="$P" --limit=1 --format="value(id)" | sed 's/^/  backup id (for rollback): /'
  fi
else
  say "1. Backup skipped — $I is a clone; live itself is untouched"
fi

say "2. What $I has now (read-only peek)"
if [ "$RUN" = 1 ]; then
  BEFORE="$(peek)"; echo "$BEFORE"
  [ -n "$BEFORE" ] || { echo "Could not read $I — nothing changed."; exit 1; }
  is_true "$BEFORE" nomarker || { echo "$I carries zz_staging_marker — it is a staging copy. Refused."; exit 1; }
else
  BEFORE=""; echo "  [dry-run] peek skipped — every step below is shown as if missing"
fi
need() { ! is_true "$BEFORE" "$1"; }

say "3. 4 Oct files (pre-R-161, no rewrite)"
for m in "${PRE[@]}"; do
  k="$(field "$m" 1)"; f="$(field "$m" 2)"
  if need "$k"; then imp "$SUPA/migrations/$f" "$f" "$(field "$m" 3)"; else echo "  -- $k already in"; fi
done

say "4. R-161 roles (app_runtime, app_jobs, app_anon, app_service, app_auth)"
if need approles || [ "${ROTATE_ROLES:-}" = 1 ]; then
  if [ "$RUN" = 1 ]; then
    declare -A PW VER
    for r in runtime jobs anon service auth; do
      PW[$r]="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')"
      VER[$r]="$(printf '%s' "${PW[$r]}" | node -e '
        const c=require("crypto"); let pw=""; process.stdin.on("data",d=>pw+=d).on("end",()=>{
          const salt=c.randomBytes(16), it=4096, sp=c.pbkdf2Sync(pw,salt,it,32,"sha256");
          const ck=c.createHmac("sha256",sp).update("Client Key").digest(), sk=c.createHmac("sha256",sp).update("Server Key").digest();
          const st=c.createHash("sha256").update(ck).digest();
          process.stdout.write(`SCRAM-SHA-256$${it}:${salt.toString("base64")}$${st.toString("base64")}:${sk.toString("base64")}`);
        });')"
    done
    sed -e "s|:runtime_pw|'${VER[runtime]}'|; s|:jobs_pw|'${VER[jobs]}'|; s|:anon_pw|'${VER[anon]}'|; s|:service_pw|'${VER[service]}'|" "$ROOT/db/ops/10-runtime-roles.sql" > "$TMP/10.sql"
    sed -e "s|:auth_pw|'${VER[auth]}'|" "$ROOT/db/ops/20-auth-login.sql" > "$TMP/20.sql"
    if grep -q ':runtime_pw\|:jobs_pw\|:anon_pw\|:service_pw' "$TMP/10.sql" || grep -q ':auth_pw' "$TMP/20.sql"; then echo "variable left unreplaced — stopping"; exit 1; fi
  fi
  imp "$TMP/10.sql" 10-runtime-roles.sql postgres
  imp "$TMP/20.sql" 20-auth-login.sql postgres
  if [ "$RUN" = 1 ]; then gcloud storage rm "$B/10-runtime-roles.sql" "$B/20-auth-login.sql" --project="$P" -q >/dev/null 2>&1 || true; fi
  if [ "$I" = resellersos-db ]; then
    for r in runtime jobs anon service auth; do
      name="live-db-app-$r-password"
      if [ "$RUN" = 1 ]; then
        if gcloud secrets describe "$name" --project="$P" >/dev/null 2>&1; then
          printf '%s' "${PW[$r]}" | gcloud secrets versions add "$name" --project="$P" --data-file=- >/dev/null
        else
          printf '%s' "${PW[$r]}" | gcloud secrets create "$name" --project="$P" --replication-policy=automatic --data-file=- >/dev/null
        fi
        echo "  $name: stored"
      else echo "  [dry-run] gcloud secrets create|versions add $name --data-file=-   <- password on stdin, never shown"; fi
    done
  else
    echo "  (clone: passwords discarded — nothing connects to the clone)"
  fi
  if [ "$RUN" = 1 ]; then unset PW VER; fi
else echo "  -- roles already in"; fi

say "5. R-161 Prisma baseline + five migrations (r161-step2-prisma.sh)"
if need cuid; then
  cat > "$TMP/track.sql" <<SQL
create table if not exists public._prisma_migrations (
  id varchar(36) primary key not null, checksum varchar(64) not null, finished_at timestamptz,
  migration_name varchar(255) not null, logs text, rolled_back_at timestamptz,
  started_at timestamptz not null default now(), applied_steps_count integer not null default 0);
insert into public._prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count)
select gen_random_uuid()::text, '$(checksum 0_init)', now(), '0_init', 0
 where not exists (select 1 from public._prisma_migrations where migration_name = '0_init');
SQL
  imp "$TMP/track.sql" track.sql resellersos_migration
  for m in "${PRISMA5[@]}"; do
    f="$MIG/$m/migration.sql"
    if [ "$m" = 20261005120000_tenant_context ]; then
      awk -v pr="$MIG/20261006090000_payment_runs_tenant_context/migration.sql" '
        /^-- ─── 4\. Nothing may still read the JWT directly/ {
          while ((getline l < pr) > 0) if (l !~ /^(begin|commit);[[:space:]]*$/) print l
        } { print }' "$f" | tr -d '\r' > "$TMP/tc.sql"
      f="$TMP/tc.sql"
    fi
    imp "$f" "$m.sql" resellersos_migration
    prisma_row "$m" 1
  done
else echo "  -- R-161 helpers already in"; fi

say "6. auth.mfa_factors.last_challenged_at (prisma 20261006110000)"
if need mfa; then
  imp "$MIG/20261006110000_mfa_last_challenged_at/migration.sql" mfa_last_challenged_at.sql postgres
  prisma_row 20261006110000_mfa_last_challenged_at 1
else echo "  -- already in"; fi

say "7. Staging's MIGS (${#MIGS[@]} files), auth.uid()/auth.role() rewritten exactly as staging's apply()"
for m in "${MIGS[@]}"; do
  k="$(field "$m" 1)"; f="$(field "$m" 2)"; u="$(field "$m" 3)"
  if need "$k"; then
    sed -e 's/auth\.uid()/public.current_user_id()/g' -e 's/auth\.role()/public.current_request_role()/g' "$(migsrc "$f")" > "$TMP/$f"
    imp "$TMP/$f" "$f" "$u"
  else echo "  -- $k already in"; fi
done

say "8. Grants: db/ops/21 (app_auth login link), cloudsql/09 + 10 (re-runnable)"
imp "$ROOT/db/ops/21-auth-login-link.sql" 21-auth-login-link.sql postgres
imp "$SUPA/cloudsql/09-grant-what-policies-allow.sql" 09-grant.sql resellersos_migration
imp "$SUPA/cloudsql/10-service-role-policy-functions.sql" 10-grants.sql resellersos_migration

say "9. Peek again"
if [ "$RUN" = 1 ]; then
  AFTER="$(peek)"; echo "$AFTER"
  missing=""
  for k in nomarker approles prisma cuid mfa $(for m in "${PRE[@]}" "${MIGS[@]}"; do field "$m" 1; done); do is_true "$AFTER" "$k" || missing="$missing $k"; done
  if [ -n "$AFTER" ] && [ -z "$missing" ]; then
    say "DB READY on $I — next: MODE=fingerprint for $I and resellersos-staging-db, then MODE=compare."
  else echo "Still missing:${missing:- (could not read $I)} — send Claude this screen."; exit 1; fi
else
  say "dry run only — nothing changed. Add RUN=1 to do it."
fi
