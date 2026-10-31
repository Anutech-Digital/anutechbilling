-- deploy-peek: exists(select 1 from pg_policies where schemaname = 'public' and tablename = 'statutory_dues_payments' and policyname = 'gp09_personal_wall')
-- deploy-key: gp09bpersonalwall
-- R-2123 (GP-09b, goal G-PERSONAL, 30 Oct 2026): the DB wall, part 2.
--
-- GP-09a (20261030071753_gp09a_personal_restrictive_money.sql) built public.is_personal_session()
-- and walled the sales money / bank / journal / GST tables. A personal session could still read
-- and write the rest of the business: CRM, team, vendors and purchases, catalogue, automation,
-- customer messages, and the spend side of the books (R-2122 check, 30 Oct: expenses,
-- purchase_orders, project_payments, po_bill_allocations, payment_runs, EMI/loan payments,
-- statutory_dues_payments, salary_payments).
--
-- Same policy, same shape: gp09_personal_wall AS RESTRICTIVE FOR ALL TO authenticated,
-- USING / WITH CHECK `not (select public.is_personal_session())` (InitPlan wrap — one helper call
-- per statement). RESTRICTIVE = ANDed on top of every existing permissive policy; business owners
-- and staff (and their Private Vault, D1) are unchanged. The helper is not redefined here.
--
-- THE LIST (explicit; supabase/tests/gp09b_personal_restrictive_crm.test.sql checks every entry):
--   CRM / leads   leads, lead_activities, lead_finder_profiles, lead_finder_runs,
--                 lead_finder_candidates, indiamart_lead_imports, contacts, customer_contacts,
--                 cold_call_campaigns, cold_call_contacts, payment_followups
--   team          team_invites, join_requests
--   vendors/bills vendors, vendor_bills, vendor_advance_applications, vendor_narration_aliases,
--                 purchase_orders, po_bill_allocations, inbound_purchases
--   catalogue     items, packages, package_items   ("price lists" are no table of their own:
--                 the selling price lives on items / packages)
--   automation    automation_jobs, automation_job_runs
--   messages      whatsapp_messages, whatsapp_broadcasts, whatsapp_templates,
--                 whatsapp_reminder_settings, whatsapp_reminder_templates, whatsapp_reminder_log,
--                 whatsapp_opt_outs, customer_email_sends, campaigns, campaign_sends,
--                 campaign_templates, renewal_email_log
--   spend / books expenses, expense_claims, project_payments, payment_runs, payment_run_items,
--                 bank_vendor_payment_lines, late_charge_bills, emi_purchases, emi_payments,
--                 emi_schedule, business_loans, business_loan_payments, loans_given,
--                 loan_repayments, employee_loans, employee_loan_repayments,
--                 statutory_dues_payments, salary_payments
-- Deliberately NOT walled: notifications, email_log, activity_log, support tables and the
-- personal_* / vault_* tables — a personal user's own account, mail and support use them.
-- SECURITY DEFINER RPCs (which skip RLS) are GP-09c.
--
-- cold_call_campaigns / cold_call_contacts are made by prisma/migrations (R-1661), not by the
-- supabase/migrations chain, so a DB built only from baseline + supabase/migrations (the CI SQL
-- job) lacks them: those two are walled when present and skipped with a NOTICE otherwise. Every
-- other table on the list must exist (missing = the list is out of date = exception).
--
-- Re-runnable (drop policy if exists + create).

begin;

do $$
declare
  v_t text;
begin
  if to_regprocedure('public.is_personal_session()') is null then
    raise exception 'R-2123: public.is_personal_session() is missing — apply gp09a (R-2122) first';
  end if;
  foreach v_t in array array[
    'leads', 'lead_activities', 'lead_finder_profiles', 'lead_finder_runs',
    'lead_finder_candidates', 'indiamart_lead_imports', 'contacts', 'customer_contacts',
    'cold_call_campaigns', 'cold_call_contacts', 'payment_followups',
    'team_invites', 'join_requests',
    'vendors', 'vendor_bills', 'vendor_advance_applications', 'vendor_narration_aliases',
    'purchase_orders', 'po_bill_allocations', 'inbound_purchases',
    'items', 'packages', 'package_items',
    'automation_jobs', 'automation_job_runs',
    'whatsapp_messages', 'whatsapp_broadcasts', 'whatsapp_templates',
    'whatsapp_reminder_settings', 'whatsapp_reminder_templates', 'whatsapp_reminder_log',
    'whatsapp_opt_outs', 'customer_email_sends', 'campaigns', 'campaign_sends',
    'campaign_templates', 'renewal_email_log',
    'expenses', 'expense_claims', 'project_payments', 'payment_runs', 'payment_run_items',
    'bank_vendor_payment_lines', 'late_charge_bills', 'emi_purchases', 'emi_payments',
    'emi_schedule', 'business_loans', 'business_loan_payments', 'loans_given',
    'loan_repayments', 'employee_loans', 'employee_loan_repayments',
    'statutory_dues_payments', 'salary_payments']
  loop
    if to_regclass('public.' || v_t) is null then
      if v_t in ('cold_call_campaigns', 'cold_call_contacts') then
        raise notice 'R-2123: public.% not on this DB (prisma-made, R-1661) — skipped', v_t;
        continue;
      end if;
      raise exception 'R-2123: table public.% is missing — the personal wall list is out of date', v_t;
    end if;
    execute format('drop policy if exists gp09_personal_wall on public.%I', v_t);
    execute format(
      'create policy gp09_personal_wall on public.%I as restrictive for all to authenticated '
      'using (not (select public.is_personal_session())) '
      'with check (not (select public.is_personal_session()))', v_t);
  end loop;
end $$;

commit;
