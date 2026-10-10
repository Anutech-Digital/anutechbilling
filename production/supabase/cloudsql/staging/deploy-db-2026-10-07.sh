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
# ADDING A MIGRATION (R-385): do NOT hand-edit MIGS. Give the migration a header line
#   -- deploy-peek: <SQL boolean that is true once the file is in>   (+ optional -- deploy-key: <key>)
# then from production/: node scripts/ops/gen-deploy-db.mjs --date 2026-10-07
# It rewrites MIGS here AND in cloudsql/live/deploy-db-2026-10-07.sh, nothing else.
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
  "trialconv|20261007010000_trial_convert_on_payment.sql|resellersos_migration|exists(select 1 from pg_trigger where tgname='trg_trial_convert_on_payment' and tgrelid=to_regclass('public.payments') and not tgisinternal)"
  "compliance|20261007030000_tenant_compliance_profile.sql|resellersos_migration|(exists(select 1 from pg_constraint where conname='tenants_business_type_check') and exists(select 1 from pg_constraint where conname='tenants_gst_filing_check'))"
  "amendactor|20261007040000_contract_amendment_customer_actor.sql|resellersos_migration|exists(select 1 from pg_proc where proname='record_contract_amendment' and pronamespace='public'::regnamespace and prosrc like '%actor_label%')"
  "renewrate|20261007050000_record_payment_renewal_rate.sql|resellersos_migration|exists(select 1 from pg_proc where proname='record_payment' and pronamespace='public'::regnamespace and prosrc like '%renewal_rate%')"
  "salarybill|20261007053000_billing_reads_salary_payments.sql|resellersos_migration|exists(select 1 from pg_policies where schemaname='public' and tablename='salary_payments' and policyname='salary_payments_select_money_roles' and qual like '%billing%')"
  "aggturn|20261007060000_tenant_aggregate_turnover.sql|resellersos_migration|exists(select 1 from pg_constraint where conname='tenants_aggregate_turnover_check')"
  "credit|20261007073000_activate_on_credit.sql|resellersos_migration|exists(select 1 from pg_proc where proname='activate_quote_on_credit' and pronamespace='public'::regnamespace)"
  "testruns|20261007090000_page_test_runs.sql|resellersos_migration|(to_regclass('public.page_test_runs') is not null)"
  "fbclaim|20261007110000_feedback_agent_claim.sql|resellersos_migration|(exists (select 1 from information_schema.columns where table_schema='public' and table_name='feedback' and column_name='agent_card') and exists (select 1 from information_schema.columns where table_schema='public' and table_name='tenants' and column_name='feedback_auto_send'))"
  "credann|20261007123000_credit_annual_block_udyam.sql|resellersos_migration|(exists (select 1 from information_schema.columns where table_schema='public' and table_name='quotes' and column_name='credit_annual_override_reason') and exists (select 1 from information_schema.columns where table_schema='public' and table_name='tenants' and column_name='udyam_number'))"
  "subbillpos|20261007130000_subscription_billing_place_of_supply.sql|resellersos_migration|exists(select 1 from pg_proc where proname='raise_subscription_billing' and prosrc like '%has no state (or GSTIN) on record%')"
  "vendcost|20261007140000_subscription_vendor_cost_from_line.sql|resellersos_migration|(exists(select 1 from pg_proc where proname='record_payment' and prosrc like '%v_cost_pm%') and exists(select 1 from pg_proc where proname='activate_quote_on_credit' and prosrc like '%v_cost_pm%'))"
  "creditsplit|20261007150000_credit_refuse_split_billing.sql|resellersos_migration|exists(select 1 from pg_proc where proname='activate_quote_on_credit' and prosrc like '%billed in instalments%')"
  "oneterm|20261007160000_quote_one_billing_term.sql|resellersos_migration|exists(select 1 from pg_trigger where tgname='trg_quotes_one_billing_term')"
  "leadsrc|20261007190000_lead_source_filter_search.sql|resellersos_migration|(exists(select 1 from pg_proc where proname='lead_source_key' and pronamespace='public'::regnamespace) and exists(select 1 from pg_proc where proname='list_leads' and pronamespace='public'::regnamespace and prosrc like '%lead_source_key%') and exists(select 1 from pg_proc where proname='lead_counts' and pronamespace='public'::regnamespace and prosrc like '%by_source%'))"
  "invstate|20261007200000_invoice_state_from_gstin.sql|resellersos_migration|(exists(select 1 from pg_proc where proname='generate_invoice' and pronamespace='public'::regnamespace and prosrc like '%v_cust_gstin%') and exists(select 1 from pg_proc where proname='accept_quote' and pronamespace='public'::regnamespace and prosrc like '%R-373%') and exists(select 1 from pg_proc where proname='record_payment' and pronamespace='public'::regnamespace and prosrc like '%R-373%'))"
  "rzpfee|20261007210000_razorpay_gateway_fee_refund.sql|resellersos_migration|exists(select 1 from information_schema.columns where table_schema='public' and table_name='payments' and column_name='gateway_refund_ids')"
  "demodata|20261007230000_demo_data_invoices.sql|resellersos_migration|(exists(select 1 from pg_proc where proname='demo_data_add_invoices' and pronamespace='public'::regnamespace) and exists(select 1 from pg_proc where proname='demo_data_clear_invoices' and pronamespace='public'::regnamespace))"
  "custrls|20261007233000_customer_rls_leaks.sql|resellersos_migration|(not exists(select 1 from pg_policy where polname in ('tenants_select_own_customer','quotes_select_own_customer','subscriptions_select_own_customer')) and exists(select 1 from pg_proc where proname='portal_my_tenant' and pronamespace='public'::regnamespace) and exists(select 1 from pg_proc where proname='current_customer_id' and pronamespace='public'::regnamespace and prosrc like '%R-395%'))"
  "fburgent|20261007234000_feedback_urgent.sql|resellersos_migration|(exists (select 1 from information_schema.columns where table_schema='public' and table_name='feedback' and column_name='urgent_at') and exists (select 1 from information_schema.columns where table_schema='public' and table_name='feedback' and column_name='urgent_by'))"
  "custrls2|20261007235000_customer_rls_payments_self.sql|resellersos_migration|(not exists(select 1 from pg_policy where polname in ('payments_select_own_customer','customers_select_self_customer')) and exists(select 1 from pg_proc where proname='portal_my_payments' and pronamespace='public'::regnamespace) and exists(select 1 from pg_proc where proname='portal_my_customer' and pronamespace='public'::regnamespace))"
  "auditactor|20261007240000_audit_actor_admin_writes.sql|resellersos_migration|exists(select 1 from pg_proc where proname='audit_service_actor' and pronamespace='public'::regnamespace)"
  "termsgrant|20261007250000_quote_terms_fn_grant.sql|resellersos_migration|has_function_privilege('authenticated', 'public.quote_line_terms_mixed(jsonb)', 'execute')"
  "invfx|20261007251000_invoice_fx_rate.sql|resellersos_migration|(exists(select 1 from pg_trigger where tgname='trg_invoice_fx_snapshot') and exists(select 1 from pg_trigger where tgname='trg_invoice_fx_freeze') and exists(select 1 from information_schema.columns where table_schema='public' and table_name='quotes' and column_name='fx_source'))"
  "trghelpers|20261007260000_trigger_helper_grants.sql|resellersos_migration|has_function_privilege('authenticated', 'public.ad_channel_guess(text)', 'execute') and has_function_privilege('authenticated', 'public.referral_code_slug(text)', 'execute')"
  "overduesuspend|20261007281600_overdue_auto_suspend.sql|resellersos_migration|(exists(select 1 from pg_trigger where tgname='trg_invoices_overdue_resume') and exists(select 1 from information_schema.columns where table_schema='public' and table_name='tenants' and column_name='overdue_suspend_days') and exists(select 1 from pg_proc where proname='decide_invoice_write_off' and pronamespace='public'::regnamespace))"
  "tbcustbal|20261007290000_tb_customer_balances.sql|resellersos_migration|exists(select 1 from pg_proc where proname='report_balance_sheet' and pronamespace='public'::regnamespace and prosrc like '%S45-TB%')"
  "leadsort|20261007300000_lead_list_sort.sql|resellersos_migration|exists(select 1 from pg_proc where proname='list_leads' and pronamespace='public'::regnamespace and prosrc like '%sort_num%')"
  "quoterevise|20261009120000_quote_revisions.sql|resellersos_migration|exists(select 1 from pg_trigger where tgname='trg_quote_revision_sent') and exists(select 1 from pg_trigger where tgname='trg_quote_accepted_sync_lead')"
  "svcrolegaps|20261009150000_service_role_policy_gaps.sql|resellersos_migration|exists(select 1 from pg_policies where schemaname='public' and tablename='seat_increase_claims' and policyname='zzz_service_role_all') and exists(select 1 from pg_policies where schemaname='public' and tablename='rate_limit_buckets' and policyname='zzz_service_role_all')"
  "cancelsub|20261009151000_cancel_subscription.sql|resellersos_migration|exists(select 1 from pg_proc where proname='cancel_subscription' and pronamespace='public'::regnamespace)"
  "leadfollowup|20261009160000_lead_followup_sync.sql|resellersos_migration|exists(select 1 from pg_trigger where tgname='trg_leads_won_close_tasks') and exists(select 1 from pg_trigger where tgname='trg_tasks_lead_follow_up')"
  "tbslice2|20261009170000_tb_slice2_expense_credits.sql|resellersos_migration|exists(select 1 from pg_proc where proname='report_balance_sheet' and pronamespace='public'::regnamespace and prosrc like '%S45-SLICE2%') and exists(select 1 from pg_proc where proname='set_opening_balances' and pronamespace='public'::regnamespace)"
  "invlinecosts|20261009180000_invoice_line_costs.sql|resellersos_migration|exists(select 1 from pg_trigger where tgname='trg_invoice_copy_quote_lines') and exists(select 1 from pg_proc where proname='invoice_cost_fill_apply' and pronamespace='public'::regnamespace)"
  "wontrialtasks|20261009181000_won_trial_tasks_cancelled.sql|resellersos_migration|exists(select 1 from pg_proc where proname='tg_leads_won_close_tasks' and prosrc like '%R-496%')"
  "leadcountspage|20261009190500_lead_counts_page_pool.sql|resellersos_migration|coalesce(position('page_unassigned' in pg_get_functiondef(to_regprocedure('public.lead_counts(jsonb)'))) > 0, false)"
  "quoteacceptfamily|20261009191000_quote_accept_family_only.sql|resellersos_migration|coalesce(position('revision_of' in pg_get_functiondef(to_regprocedure('public.tg_quote_accepted_sync_lead()'))) > 0, false)"
  "hierarchysvc|20261009200000_hierarchy_service_role.sql|resellersos_migration|coalesce(position('service_role' in pg_get_functiondef(to_regprocedure('public.hierarchy_sees_all()'))) > 0, false)"
  "attendancerolewrites|20261009213000_attendance_role_writes.sql|resellersos_migration|(exists(select 1 from pg_policy where polname = 'attendance_update_hr_roles') and not exists(select 1 from pg_policy where polname = 'tenant isolation write' and polrelid = to_regclass('public.attendance')))"
  "demotenant|20261009220000_demo_tenant_readonly.sql|resellersos_migration|(to_regclass('public.demo_tenants') is not null and to_regprocedure('public.demo_pre_request()') is not null and to_regprocedure('public.demo_readonly_probe()') is not null)"
  "attendancecorrections|20261009224500_attendance_corrections.sql|resellersos_migration|to_regprocedure('public.correct_attendance(uuid,date,timestamptz,timestamptz,text)') is not null"
  "attendanceshift|20261009230000_attendance_shift.sql|resellersos_migration|exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'attendance_settings' and column_name = 'half_day_under_hours')"
  "latecharges|20261009233000_late_payment_charges.sql|resellersos_migration|(to_regclass('public.late_charge_bills') is not null and to_regprocedure('public.bill_late_charges(text,integer,integer,date,date)') is not null and exists(select 1 from information_schema.columns where table_schema='public' and table_name='tenants' and column_name='late_fee_enabled'))"
  "attendancedevices|20261009235000_attendance_devices.sql|resellersos_migration|(to_regclass('public.attendance_devices') is not null and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'attendance_settings' and column_name = 'require_device'))"
  "splitbilledoutstanding|20261009235800_split_billed_outstanding.sql|resellersos_migration|to_regprocedure('public.sync_split_outstanding(uuid)') is not null"
  "attendancepiningestlock|20261010000000_attendance_pin_ingest_lock.sql|resellersos_migration|(to_regclass('public.employee_pin_attempts') is not null and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'attendance_settings' and column_name = 'ingest_key'))"
  "employeepinhidden|20261010010000_employee_pin_hidden.sql|resellersos_migration|exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employees' and column_name = 'pin_set')"
  "sitepromoowner|20261010020000_site_promo_owner_only.sql|resellersos_migration|(exists(select 1 from pg_policy where polname = 'site_promos_insert_admin' and polrelid = to_regclass('public.site_promos')) and not exists(select 1 from pg_policy where polname = 'site_promos_tenant_write' and polrelid = to_regclass('public.site_promos')))"
  "demonoanon|20261010030000_demo_pre_request_no_anon.sql|resellersos_migration|(to_regprocedure('public.demo_pre_request()') is null or not has_function_privilege('anon', 'public.demo_pre_request()', 'execute'))"
  "attendanceoutsideoffice|20261010040000_attendance_outside_office.sql|resellersos_migration|exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employees' and column_name = 'attendance_anywhere')"
  "attendancechangelog|20261010050000_attendance_change_log.sql|resellersos_migration|exists(select 1 from pg_trigger where tgname = 'trg_attendance_change_log' and tgrelid = to_regclass('public.attendance'))"
  "loansgiven|20261010140000_loans_given.sql|resellersos_migration|to_regclass('public.loan_repayments') is not null and exists(select 1 from pg_proc where proname = 'record_loan_repayment')"
  "extmonths|20261010160000_extension_by_months.sql|resellersos_migration|exists(select 1 from pg_proc where oid = to_regprocedure('public.record_payment(text,integer,text,text,text)') and prosrc like '%R-805%')"
  "extplan|20261010173000_extension_keeps_plan.sql|resellersos_migration|exists(select 1 from pg_proc where oid = to_regprocedure('public.record_payment(text,integer,text,text,text)') and prosrc like '%R-812%')"
  "tenantguard|20261010190000_tenant_guard_fail_closed.sql|resellersos_migration|exists(select 1 from pg_proc where oid = to_regprocedure('public.accept_quote(text)') and prosrc like '%R-454%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.generate_invoice(text)') and prosrc like '%R-454%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.raise_subscription_billing(uuid)') and prosrc like '%R-454%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.next_document_number(text,uuid,date)') and prosrc like '%R-454%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.next_customer_number(uuid)') and prosrc like '%R-454%')"
  "presencesecret|20261010203000_presence_code_check.sql|resellersos_migration|(to_regclass('public.presence_code_attempts') is not null and to_regprocedure('public.validate_presence_code(text)') is not null and to_regprocedure('public.presence_code_at(text,bigint)') is not null)"
)
field() { echo "$1" | cut -d'|' -f"$2"; }   # $1 = MIGS line, $2 = 1 key / 2 file / 3 user / 4 peek

# R-545 (10 Oct): the staging branch (R-161) moves applied migrations to prisma/migrations/<name>/migration.sql,
# so look there too — the staging DB run stopped at "Missing file" on 20261006130000.
migsrc() { if [ -f "$HERE/migrations/$1" ]; then echo "$HERE/migrations/$1"; elif [ -f "$HERE/../prisma/migrations/${1%.sql}/migration.sql" ]; then echo "$HERE/../prisma/migrations/${1%.sql}/migration.sql"; fi; }
# Fail before touching anything if a listed file is missing or a key repeats.
seen=" "
for m in "${MIGS[@]}"; do
  k="$(field "$m" 1)"; f="$(field "$m" 2)"
  [ -n "$(migsrc "$f")" ] || { echo "Missing file: migrations/$f — nothing changed. Send Claude this screen."; exit 1; }
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
  # apply() rewrites auth.uid() to these helpers — they must exist first (R-161).
  echo "   ,'cuid=' || (exists(select 1 from pg_proc where proname='current_user_id' and pronamespace='public'::regnamespace) and exists(select 1 from pg_proc where proname='current_request_role' and pronamespace='public'::regnamespace))::text"
  echo '  ) INTO r;'
  echo "  RAISE EXCEPTION 'PEEK %', r; END \$\$;"
} > "$TMP/peek-staging.sql"
printf "notify pgrst, 'reload schema';\n" > "$TMP/reload.sql"

peek() { # $1 = sql file that RAISEs 'PEEK …'; prints the PEEK line (the import is MEANT to fail)
  gcloud storage cp "$1" "$B/$(basename "$1")" --project="$P" -q >/dev/null 2>&1
  gcloud sql import sql "$I" "$B/$(basename "$1")" --database="$DB" --user=resellersos_migration --project="$P" --quiet >/dev/null 2>&1 || true
  gcloud sql operations list --instance="$I" --project="$P" --limit=1 --format=json | grep -oE 'PEEK[^\\"]*' | head -1
}
is_true() { echo "$1" | grep -qE "(^| )$2=true([^a-z0-9_]|$)"; }   # $1 = PEEK line, $2 = key (last key is glued to "CONTEXT:")

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
is_true "$BEFORE" cuid || { echo "Staging has no public.current_user_id()/current_request_role() (R-161) — nothing changed. Send Claude this screen."; exit 1; }

apply() { # $1 = migration file name, $2 = db user
  # Staging runs R-161 (Auth.js + Prisma path): there auth.uid() is NULL and every function was
  # rewritten to public.current_user_id() / current_request_role() (prisma 20261005120000_tenant_context).
  # Today's files still say auth.uid(), so apply the same token rewrite here — STAGING ONLY. Both
  # helpers fall back to auth.uid()/auth.role() for the PostgREST path, so nothing else changes.
  local f="$TMP/$1"
  sed -e 's/auth\.uid()/public.current_user_id()/g' -e 's/auth\.role()/public.current_request_role()/g' "$(migsrc "$1")" > "$f"
  echo "-- applying $1 as $2 (auth.uid/role -> current_user_id/current_request_role)"
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
