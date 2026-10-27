-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.pay_vendor_bill(text,integer,date,uuid,text)') and prosrc not ilike '%current_date%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.top_up_employee_advance(uuid,integer,date,uuid)') and prosrc not ilike '%current_date%') and exists(select 1 from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum where d.adrelid = to_regclass('public.payment_runs') and a.attname = 'pay_on' and pg_get_expr(d.adbin, d.adrelid) like '%Asia/Kolkata%')
-- deploy-key: r1828istdefaultsfns
-- 20261024085113_r1828_ist_today_defaults_fns.sql
--
-- R-1828 (24 Oct 2026) — the last CURRENT_DATE stamps, found by R-1826's night check
-- (supabase/tests/night_ist_pin.test.sql). Follow-up to R-1716 (document date defaults) and
-- R-1816 (money RPCs). CURRENT_DATE is the day in the session time zone and Cloud SQL runs in
-- UTC, so anything stamped between 00:00 and 05:30 IST got YESTERDAY's date — on 1 April that is
-- the previous financial year (TDS receipts, payment runs, vendor bill payments).
--
-- 1. Seven date column defaults → the IST calendar day, the exact R-1716 expression
--    ((now() at time zone 'Asia/Kolkata')::date):
--      bank_accounts.opening_balance_date, compliance_log.filed_date, employee_assets.issued_on,
--      payment_runs.pay_on, prepaid_advances.paid_date, project_payments.received_at,
--      referral_commissions.earned_date
--
-- 2. Fourteen functions: every code CURRENT_DATE becomes public.ist_today() (20260930172000 —
--    STABLE, (now() at time zone 'Asia/Kolkata')::date, granted to authenticated + service_role).
--    26 places, all in code (none in a comment): 23 in the bodies + the p_date DEFAULT of
--    give_employee_advance / top_up_employee_advance / settle_employee_advance (a caller that
--    leaves p_date out got the UTC day too). Each body below is the LATEST definition,
--    copied verbatim — checked equal to pg_get_functiondef on a database with every supabase
--    migration applied (+ r1819) and to the newest create-or-replace in the repo:
--
--      add_reimbursement                      prisma 20261005120000_tenant_context (= supabase/baseline.sql + token rewrite)
--      create_payment_run                     prisma 20261006090000_payment_runs_tenant_context (= 20261005110000_payment_runs + token rewrite)
--      create_project_direct_invoice          20261024063838_r1819_project_money_roles
--      fn_accrue_referral_commission_project  20261018191711_r1583_194h_tds_default
--      give_employee_advance                  20261011070000_r717_payroll_roles
--      mark_payment_run_paid                  prisma 20261006090000_payment_runs_tenant_context (= 20261005110000_payment_runs + token rewrite)
--      pay_referral_commission                20261011120000_r718_money_roles
--      pay_vendor_bill                        20261011120000_r718_money_roles
--      record_payment_with_tds                supabase/baseline.sql
--      record_project_receipt_with_tds        20261012025800_r885_money_roles_more
--      settle_employee_advance                20261011070000_r717_payroll_roles
--      settle_reimbursement                   prisma 20261005120000_tenant_context
--      submit_expense_claim                   supabase/baseline.sql
--      top_up_employee_advance                20261011070000_r717_payroll_roles
--
--    Four of them were last written by the prisma tenant_context migrations, which only swap
--    auth.uid()/auth.role() for public.current_user_id()/current_request_role(). They are written
--    here in the supabase form (auth.uid()), like every supabase migration: the staging/live
--    deploy-db apply() makes the same swap, so Cloud SQL ends with the same body + ist_today().
--
-- Nothing else changes: same signatures, SECURITY DEFINER, search_path. CREATE OR REPLACE keeps
-- the owner, grants (submit_expense_claim stays service_role-only, since 20261010000000) and
-- comments. Stored rows are NOT changed.
-- Proof: supabase/tests/night_ist_pin.test.sql (known lists now empty) + the R-1828 rollback run.

begin;

-- ── 1. Column defaults ─────

alter table public.bank_accounts        alter column opening_balance_date set default ((now() at time zone 'Asia/Kolkata')::date);
alter table public.compliance_log       alter column filed_date set default ((now() at time zone 'Asia/Kolkata')::date);
alter table public.employee_assets      alter column issued_on set default ((now() at time zone 'Asia/Kolkata')::date);
alter table public.payment_runs         alter column pay_on set default ((now() at time zone 'Asia/Kolkata')::date);
alter table public.prepaid_advances     alter column paid_date set default ((now() at time zone 'Asia/Kolkata')::date);
alter table public.project_payments     alter column received_at set default ((now() at time zone 'Asia/Kolkata')::date);
alter table public.referral_commissions alter column earned_date set default ((now() at time zone 'Asia/Kolkata')::date);

-- ── 2. Functions: CURRENT_DATE → public.ist_today() ─────

-- ── add_reimbursement (from prisma 20261005120000_tenant_context (= supabase/baseline.sql + token rewrite)) — 2 × CURRENT_DATE ─────

CREATE OR REPLACE FUNCTION public.add_reimbursement(p_person text, p_purpose text, p_category text, p_amount integer, p_gst integer, p_incurred_on date, p_paid_via text, p_employee_id uuid DEFAULT NULL::uuid, p_receipt_path text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_cat    text := coalesce(nullif(trim(p_category), ''), 'Other');
  v_via    text := nullif(trim(coalesce(p_paid_via, '')), '');
  v_exp_id text;
  v_id     uuid;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than 0'; end if;
  if coalesce(trim(p_person), '') = '' then raise exception 'Who paid? — person name is required'; end if;
  if coalesce(trim(p_purpose), '') = '' then raise exception 'What was it for? — purpose is required'; end if;

  if p_employee_id is not null then
    perform 1 from public.employees where id = p_employee_id and tenant_id = v_tenant;
    if not found then raise exception 'Employee not found'; end if;
  end if;

  v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)) || '-' || upper(to_hex((random() * 255)::int));
  insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
  values (v_exp_id, v_tenant, v_cat, trim(p_person), coalesce(p_incurred_on, public.ist_today()), p_amount, greatest(coalesce(p_gst, 0), 0), 'reimbursement',
          'Reimbursement · ' || p_purpose || ' · paid by ' || trim(p_person) || coalesce(' (' || v_via || ')', ''));

  insert into public.reimbursements (tenant_id, person_name, purpose, category, amount, gst_paid, incurred_on, paid_via, employee_id, receipt_path, expense_id, created_by)
  values (v_tenant, trim(p_person), trim(p_purpose), v_cat, p_amount, greatest(coalesce(p_gst, 0), 0), coalesce(p_incurred_on, public.ist_today()), v_via,
          p_employee_id, nullif(trim(coalesce(p_receipt_path, '')), ''), v_exp_id, auth.uid())
  returning id into v_id;
  return v_id;
end;
$function$;

-- ── create_payment_run (from prisma 20261006090000_payment_runs_tenant_context (= 20261005110000_payment_runs + token rewrite)) — 3 × CURRENT_DATE ─────

CREATE OR REPLACE FUNCTION public.create_payment_run(p_items jsonb, p_bank_account_id uuid, p_pay_on date DEFAULT NULL::date, p_note text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_role   text := public.payment_run_role();
  v_run    uuid;
  v_no     text;
  v_total  bigint := 0;
  it       jsonb;
  v_src    text; v_doc text; v_amt integer; v_owed integer;
  v_vid uuid; v_vname text; v_ref text;
begin
  if v_tenant is null then raise exception 'No tenant context' using errcode = 'insufficient_privilege'; end if;
  if v_role is null or v_role not in ('owner','manager','billing','accountant') then
    raise exception 'Only owner, manager, billing or accountant can create a payment run' using errcode = 'insufficient_privilege';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Pick at least one bill to pay';
  end if;
  if jsonb_array_length(p_items) > 200 then raise exception 'At most 200 bills in one run'; end if;
  if not exists (select 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant) then
    raise exception 'Pay-from bank account not found';
  end if;

  -- Run number: PR-YYYYMM-NNN, per tenant. The advisory lock makes two creates in the same
  -- instant take turns instead of colliding on the unique (tenant_id, run_no).
  perform pg_advisory_xact_lock(hashtext('payment_run_no:' || v_tenant::text));
  select 'PR-' || to_char(coalesce(p_pay_on, public.ist_today()), 'YYYYMM') || '-' ||
         lpad((count(*) + 1)::text, 3, '0')
    into v_no
    from public.payment_runs
   where tenant_id = v_tenant and run_no like 'PR-' || to_char(coalesce(p_pay_on, public.ist_today()), 'YYYYMM') || '-%';

  insert into public.payment_runs (tenant_id, run_no, bank_account_id, pay_on, note, created_by)
  values (v_tenant, v_no, p_bank_account_id, coalesce(p_pay_on, public.ist_today()), nullif(trim(p_note), ''), auth.uid())
  returning id into v_run;

  for it in select * from jsonb_array_elements(p_items) loop
    v_src := it->>'source';
    v_doc := it->>'doc_id';
    v_amt := (it->>'amount')::integer;
    if v_src not in ('vendor_bill','expense') or v_doc is null then raise exception 'Bad item in the run'; end if;
    if v_amt is null or v_amt <= 0 then raise exception 'Amount must be more than zero (%)', v_doc; end if;

    v_owed := public.payment_run_outstanding(v_tenant, v_src, v_doc);
    if v_owed is null or v_owed = 0 then raise exception '% is already paid or not found', v_doc; end if;
    if v_amt > v_owed then raise exception '% — ₹% is more than the ₹% still owed', v_doc, v_amt, v_owed; end if;

    if exists (select 1 from public.payment_run_items i join public.payment_runs r on r.id = i.run_id
                where i.tenant_id = v_tenant and i.source = v_src and i.doc_id = v_doc
                  and r.status in ('draft','approved') and r.id <> v_run) then
      raise exception '% is already in another open payment run', v_doc;
    end if;

    if v_src = 'vendor_bill' then
      select b.vendor_id, b.vendor_name, b.bill_no into v_vid, v_vname, v_ref from public.vendor_bills b where b.id = v_doc;
    else
      select e.vendor_id, coalesce(e.vendor_name, e.category), e.bill_no into v_vid, v_vname, v_ref from public.expenses e where e.id = v_doc;
    end if;

    insert into public.payment_run_items (run_id, tenant_id, source, doc_id, doc_ref, vendor_id, vendor_name, amount)
    values (v_run, v_tenant, v_src, v_doc, v_ref, v_vid, coalesce(v_vname, 'Vendor'), v_amt);
    v_total := v_total + v_amt;
  end loop;

  update public.payment_runs set total = v_total where id = v_run;
  return v_run;
end $function$;

-- ── create_project_direct_invoice (from 20261024063838_r1819_project_money_roles) — 1 × CURRENT_DATE ─────

CREATE OR REPLACE FUNCTION public.create_project_direct_invoice(p_customer_id uuid, p_customer_name text, p_title text, p_description text, p_line_items jsonb, p_gst_rate integer, p_inter_state boolean)
 RETURNS TABLE(invoice_id text, project_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_r1819_trusted boolean;
  v_lines   jsonb;
  v_taxable integer := 0;
  v_gst     integer;
  v_total   integer;
  v_pid     uuid;
  v_msid    uuid;
  v_inv     text;
  v_r1803_problem text;
begin
  /* R-1819 (security audit 24 Oct 2026): role + company guard (production/CLAUDE.md §17c).
     Trusted = service_role (admin client) or a direct DB session with no request role. */
  v_r1819_trusted := coalesce(auth.role(), '') = 'service_role'
                     or (auth.role() is null
                         and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if public.current_tenant_id() is null and not v_r1819_trusted then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_r1819_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can create a project invoice' using errcode = '42501';
  end if;
  if jsonb_typeof(p_line_items) <> 'array' or jsonb_array_length(p_line_items) = 0 then
    raise exception 'At least one line item is required';
  end if;

  /* R-1803 (R-1643 follow-up): refuse before the project, its quote number and its milestone
     are made (raise_project_milestone_invoice checks again before the invoice number). */
  if public.current_tenant_id() is not null then
    v_r1803_problem := public.supplier_invoice_problem(public.current_tenant_id(), public.ist_today());
    if v_r1803_problem is not null then
      raise exception '%', v_r1803_problem using errcode = 'check_violation';
    end if;
  end if;

  select coalesce(jsonb_agg(
           li || jsonb_build_object('amount',
             coalesce(nullif((li->>'amount'), '')::int,
                      coalesce((li->>'qty')::int, 1) * coalesce((li->>'rate')::int, 0)))
         ), '[]'::jsonb)
    into v_lines from jsonb_array_elements(p_line_items) li;

  select coalesce(sum(greatest(coalesce((li->>'amount')::int, 0), 0)), 0)
    into v_taxable from jsonb_array_elements(v_lines) li;
  if v_taxable <= 0 then raise exception 'Invoice total must be greater than zero'; end if;
  v_gst   := round(v_taxable * coalesce(p_gst_rate, 18) / 100.0);
  v_total := v_taxable + v_gst;

  v_pid := public.create_project_quote(
    p_customer_id, p_customer_name, p_title, p_description, v_lines,
    coalesce(p_gst_rate, 18), coalesce(p_inter_state, false),
    jsonb_build_array(jsonb_build_object('label', 'Full amount', 'total_amount', v_total, 'due_date', public.ist_today()::text))
  );

  perform public.accept_project_quote(v_pid);

  -- THE ONE CHANGE: `pm` alias so `pm.project_id` is unmistakably the column, not this
  -- function's OUT variable of the same name.
  select pm.id into v_msid
    from public.project_milestones pm
   where pm.project_id = v_pid
   order by pm.seq
   limit 1;
  if v_msid is null then raise exception 'Milestone was not created for project %', v_pid; end if;

  v_inv := public.raise_project_milestone_invoice(v_msid);

  return query select v_inv, v_pid;
end;
$function$;

-- ── fn_accrue_referral_commission_project (from 20261018191711_r1583_194h_tds_default) — 1 × CURRENT_DATE ─────

CREATE OR REPLACE FUNCTION public.fn_accrue_referral_commission_project()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_proj   public.project_sales;
  v_agr    public.referral_agreements%rowtype;
  v_base   integer;
  v_rate   numeric;
  v_gross  integer;
  v_tds    integer;
begin
  select * into v_proj from public.project_sales where id = new.project_id;
  if not found or v_proj.customer_id is null or coalesce(new.amount, 0) <= 0 then return new; end if;

  begin
    select * into v_agr from public.referral_agreements
     where tenant_id = new.tenant_id and customer_id = v_proj.customer_id and status = 'active'
     limit 1;
    if not found then return new; end if;

    if v_agr.scope = 'one_time' and exists (
      select 1 from public.referral_commissions where agreement_id = v_agr.id and status <> 'cancelled'
    ) then
      return new;
    end if;

    v_base := round(new.amount::numeric * 100.0 / (100.0 + coalesce(v_proj.gst_rate, 18)))::integer;

    if v_agr.basis = 'percent' then
      v_rate  := coalesce(v_agr.percent, 0);
      v_gross := round(v_base::numeric * v_rate / 100.0)::integer;
    else
      if new.method = 'tds' then return new; end if;   -- one fixed fee per instalment
      v_rate  := null;
      v_gross := coalesce(v_agr.fixed_amount, 0);
    end if;
    if v_gross <= 0 then return new; end if;

    -- R-1583: same fallback as payments — the one SQL source of the s.194H rate.
    v_tds := case when v_agr.deduct_tds then round(v_gross::numeric * coalesce(v_agr.tds_rate, public.tds_194h_default_rate()) / 100.0)::integer else 0 end;

    insert into public.referral_commissions (
      tenant_id, agreement_id, partner_id, customer_id, project_payment_id,
      base_amount, basis, rate, gross_commission, tds_amount, net_payable, status, earned_date, notes
    ) values (
      new.tenant_id, v_agr.id, v_agr.partner_id, v_proj.customer_id, new.id,
      v_base, v_agr.basis, v_rate, v_gross, v_tds, v_gross - v_tds, 'earned', coalesce(new.received_at, public.ist_today()),
      format('Project "%s"%s', v_proj.title, case when new.method = 'tds' then ' — TDS part of the instalment' else '' end)
    )
    on conflict (agreement_id, project_payment_id) where project_payment_id is not null do nothing;
  exception when others then
    raise warning 'referral commission accrual failed for project payment %: %', new.id, sqlerrm;
  end;
  return new;
end;
$function$;

-- ── give_employee_advance (from 20261011070000_r717_payroll_roles) — 3 × CURRENT_DATE ─────

CREATE OR REPLACE FUNCTION public.give_employee_advance(p_name text, p_amount integer, p_date date DEFAULT public.ist_today(), p_method text DEFAULT 'cash'::text, p_account uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_id     uuid;
  v_leg    uuid;
  v_trusted boolean;
begin
  /* R-717: role gate. Trusted = service_role or a direct DB session with no request role
     (same rule as R-454 / R-714). Everyone else must hold one of the roles below — a
     null-caller (no public.users row) holds none, so it is refused here too. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can give an employee advance' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Enter who you gave the money to.'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Amount must be more than ₹0.'; end if;
  if p_account is not null and not exists (select 1 from public.bank_accounts where id = p_account and tenant_id = v_tenant) then
    raise exception 'That bank / cash account is not in your company.';
  end if;

  insert into public.prepaid_advances
    (tenant_id, vendor_name, category, total_amount, consumed_amount, paid_date, payment_method,
     bank_account_id, notes, created_by)
  values
    (v_tenant, trim(p_name), 'Employee advance', p_amount, 0, coalesce(p_date, public.ist_today()), p_method,
     p_account, nullif(trim(coalesce(p_note, '')), ''), auth.uid())
  returning id into v_id;

  v_leg := public._employee_advance_cash_leg(v_tenant, p_account, coalesce(p_date, public.ist_today()), p_amount, 0,
                                             'Advance to ' || trim(p_name), v_id);
  if v_leg is not null then
    update public.prepaid_advances set bank_txn_id = v_leg where id = v_id;
  end if;
  return v_id;
end $function$;

-- ── mark_payment_run_paid (from prisma 20261006090000_payment_runs_tenant_context (= 20261005110000_payment_runs + token rewrite)) — 1 × CURRENT_DATE ─────

CREATE OR REPLACE FUNCTION public.mark_payment_run_paid(p_run_id uuid, p_paid_on date DEFAULT NULL::date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_role   text := public.payment_run_role();
  r        public.payment_runs;
  it       public.payment_run_items;
  v_owed   integer;
  v_on     date := coalesce(p_paid_on, public.ist_today());
  v_txn    uuid;
  v_bill   public.vendor_bills;
begin
  if v_tenant is null then raise exception 'No tenant context' using errcode = 'insufficient_privilege'; end if;
  if v_role is null or v_role not in ('owner','manager','billing','accountant') then
    raise exception 'Only owner, manager, billing or accountant can mark a run paid' using errcode = 'insufficient_privilege';
  end if;
  select * into r from public.payment_runs where id = p_run_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Payment run not found'; end if;
  if r.status <> 'approved' then raise exception 'Only an approved run can be marked paid (this one is %)', r.status; end if;

  for it in select * from public.payment_run_items where run_id = r.id order by vendor_name loop
    v_owed := public.payment_run_outstanding(v_tenant, it.source, it.doc_id);
    if v_owed is null or v_owed < it.amount then
      raise exception '% (%) was paid elsewhere after approval — nothing was marked; check it and try again', coalesce(it.doc_ref, it.doc_id), it.vendor_name;
    end if;

    if it.source = 'vendor_bill' then
      select * into v_bill from public.vendor_bills where id = it.doc_id and tenant_id = v_tenant for update;
      update public.vendor_bills
         set paid_amount = coalesce(paid_amount,0) + it.amount,
             status = case when coalesce(paid_amount,0) + it.amount >= total then 'paid' else 'partial' end,
             updated_at = now()
       where id = it.doc_id and tenant_id = v_tenant;
      insert into public.bank_transactions (tenant_id, bank_account_id, txn_date, description, debit, credit, source,
                                            matched_to_type, matched_to_id, match_confidence, reference)
      values (v_tenant, r.bank_account_id, v_on, 'Bill payment: ' || it.vendor_name || ' · ' || r.run_no, it.amount, 0, 'manual',
              'vendor_bill', it.doc_id, 'manual', r.run_no);
    else
      insert into public.bank_transactions (tenant_id, bank_account_id, txn_date, description, debit, credit, source,
                                            matched_to_type, matched_to_id, match_confidence, reference)
      values (v_tenant, r.bank_account_id, v_on, 'Expense payment: ' || it.vendor_name || ' · ' || r.run_no, it.amount, 0, 'manual',
              'expense', it.doc_id, 'manual', r.run_no)
      returning id into v_txn;
      update public.expenses
         set paid = true, paid_date = v_on, payment_method = 'bank_transfer',
             bank_account_id = r.bank_account_id, reconciled_txn_id = v_txn
       where id = it.doc_id and tenant_id = v_tenant;
    end if;
  end loop;

  update public.payment_runs set status = 'paid', paid_by = auth.uid(), paid_at = now(), paid_on = v_on, updated_at = now() where id = r.id;
end $function$;

-- ── pay_referral_commission (from 20261011120000_r718_money_roles) — 2 × CURRENT_DATE ─────

CREATE OR REPLACE FUNCTION public.pay_referral_commission(p_commission_id uuid, p_bank_account_id uuid, p_paid_on date DEFAULT NULL::date, p_method text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_comm   public.referral_commissions;
  v_pname  text;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can pay a referral commission' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No tenant context'; end if;

  select * into v_comm from public.referral_commissions
   where id = p_commission_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Commission not found'; end if;
  if v_comm.status = 'paid' then raise exception 'Commission already paid'; end if;
  if v_comm.status = 'cancelled' then raise exception 'Commission is cancelled'; end if;

  perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Pay-from account not found'; end if;

  select name into v_pname from public.referral_partners where id = v_comm.partner_id;

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source,
     matched_to_type, matched_to_id, match_confidence, reference)
  values
    (v_tenant, p_bank_account_id, coalesce(p_paid_on, public.ist_today()),
     'Referral commission: ' || coalesce(v_pname, 'partner'), v_comm.net_payable, 0, 'manual',
     'referral_commission', p_commission_id::text, 'manual',
     nullif(trim(coalesce(p_method, '')), ''));

  update public.referral_commissions
     set status = 'paid', paid_date = coalesce(p_paid_on, public.ist_today())
   where id = p_commission_id;
end;
$function$;

-- ── pay_vendor_bill (from 20261011120000_r718_money_roles) — 1 × CURRENT_DATE ─────

CREATE OR REPLACE FUNCTION public.pay_vendor_bill(p_bill_id text, p_amount integer, p_paid_on date, p_bank_account_id uuid, p_method text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant      uuid := public.current_tenant_id();
  v_bill        public.vendor_bills;
  v_outstanding integer;
  v_new_paid    integer;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can pay a vendor bill' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than 0'; end if;

  select * into v_bill from public.vendor_bills where id = p_bill_id and tenant_id = v_tenant;
  if not found then raise exception 'Bill not found'; end if;

  v_outstanding := coalesce(v_bill.total, 0) - coalesce(v_bill.paid_amount, 0);
  if p_amount > v_outstanding then
    raise exception 'Payment (%) exceeds the outstanding (%)', p_amount, v_outstanding;
  end if;

  perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Pay-from account not found'; end if;

  v_new_paid := coalesce(v_bill.paid_amount, 0) + p_amount;
  update public.vendor_bills
     set paid_amount = v_new_paid,
         status      = case when v_new_paid >= coalesce(total, 0) then 'paid' else 'partial' end,
         updated_at  = now()
   where id = p_bill_id;

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, matched_to_id, match_confidence, reference)
  values
    (v_tenant, p_bank_account_id, coalesce(p_paid_on, public.ist_today()),
     'Bill payment: ' || v_bill.vendor_name, p_amount, 0, 'manual', 'vendor_bill', p_bill_id, 'manual',
     nullif(trim(coalesce(p_method, '')), ''));
end;
$function$;

-- ── record_payment_with_tds (from supabase/baseline.sql) — 2 × CURRENT_DATE ─────

CREATE OR REPLACE FUNCTION public.record_payment_with_tds(p_quote_id text, p_amount integer, p_method text, p_reference text, p_notes text DEFAULT NULL::text, p_tds_amount integer DEFAULT 0, p_tds_gross integer DEFAULT 0, p_tds_net_paid integer DEFAULT 0, p_tds_section text DEFAULT NULL::text, p_tds_rate_pct numeric DEFAULT NULL::numeric, p_customer_tan text DEFAULT NULL::text, p_invoice_id text DEFAULT NULL::text, p_fiscal_year text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_result    jsonb;
  v_replay    boolean;
  v_pay_id    uuid;
  v_tenant    uuid;
  v_cust      uuid;
  v_cust_name text;
  v_tds_saved boolean := false;
begin
  v_result := public.record_payment(p_quote_id, p_amount, p_method, p_reference, p_notes);

  v_replay := coalesce((v_result->>'already_recorded')::boolean, false)
           or coalesce((v_result->>'idempotent_replay')::boolean, false);
  v_pay_id := nullif(v_result->>'payment_id', '')::uuid;

  if not v_replay and coalesce(p_tds_amount, 0) > 0 then
    select tenant_id, customer_name into v_tenant, v_cust_name
      from public.quotes where id = p_quote_id;
    v_cust := nullif(v_result->>'customer_id', '')::uuid;

    insert into public.tds_receivable (
      id, tenant_id, invoice_id, payment_id, customer_id, customer_name,
      customer_tan, section, rate_pct, gross_amount, tds_amount, net_paid,
      fiscal_year, payment_received_date, status, notes
    ) values (
      'TDS-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 10)),
      v_tenant, p_invoice_id, v_pay_id, v_cust, coalesce(v_cust_name, ''),
      nullif(trim(p_customer_tan), ''), coalesce(p_tds_section, '194J'), p_tds_rate_pct,
      p_tds_gross, p_tds_amount, p_tds_net_paid,
      coalesce(p_fiscal_year, public.indian_fiscal_year(public.ist_today())),
      public.ist_today(), 'pending_cert',
      'Auto-created atomically with payment ' || coalesce(v_pay_id::text, '?') || ' on quote ' || p_quote_id
    );
    v_tds_saved := true;
  end if;

  return v_result || jsonb_build_object('tds_saved', v_tds_saved);
end;
$function$;

-- ── record_project_receipt_with_tds (from 20261012025800_r885_money_roles_more) — 2 × CURRENT_DATE ─────

CREATE OR REPLACE FUNCTION public.record_project_receipt_with_tds(p_milestone_id uuid, p_net integer, p_tds integer, p_section text, p_rate_pct numeric, p_tds_base integer, p_received_at date, p_bank_txn_id uuid, p_reference text, p_raise_invoice boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_ms      public.project_milestones;
  v_proj    public.project_sales;
  v_net_id  uuid;
  v_tds_id  uuid;
  v_invoice text;
  v_tds_row text;
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — record group: owner, manager, accountant, billing).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can record a project payment' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No tenant in context'; end if;
  select * into v_ms from public.project_milestones where id = p_milestone_id for update;
  if not found then raise exception 'Milestone not found'; end if;
  if v_ms.tenant_id is distinct from v_tenant then
    raise exception 'Milestone not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_net, 0) <= 0 or coalesce(p_tds, 0) <= 0 or coalesce(p_tds_base, 0) <= 0 then
    raise exception 'Net, TDS and the TDS base must all be more than zero';
  end if;
  select * into v_proj from public.project_sales where id = v_ms.project_id;

  -- 1 + 2. both parts of the settlement, through the one project-payment path
  v_net_id := public.record_project_payment(p_milestone_id, p_net, 'bank_transfer', p_reference, p_received_at, p_bank_txn_id);
  v_tds_id := public.record_project_payment(p_milestone_id, p_tds, 'tds',
                format('TDS %s @ %s%% on ₹%s', coalesce(p_section, '194J'), p_rate_pct, p_tds_base), p_received_at, null);

  -- 3. invoice, after both, so a fully settled milestone's invoice is born paid
  select invoice_id into v_invoice from public.project_milestones where id = p_milestone_id;
  if p_raise_invoice and v_invoice is null then
    v_invoice := public.raise_project_milestone_invoice(p_milestone_id);
  end if;

  -- 4. the credit to claim
  v_tds_row := 'TDS-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 10));
  insert into public.tds_receivable (
    id, tenant_id, invoice_id, payment_id, customer_id, customer_name, section, rate_pct,
    gross_amount, tds_amount, net_paid, fiscal_year, payment_received_date, status, notes
  ) values (
    v_tds_row, v_tenant, v_invoice, null, v_proj.customer_id, coalesce(v_proj.customer_name, ''),
    coalesce(p_section, '194J'), p_rate_pct, p_tds_base, p_tds, p_net,
    public.indian_fiscal_year(coalesce(p_received_at, public.ist_today())), coalesce(p_received_at, public.ist_today()),
    'pending_cert',
    format('Project %s · milestone "%s" · project payments %s (bank) + %s (TDS)', v_proj.title, v_ms.label, v_net_id, v_tds_id)
  );

  return jsonb_build_object('net_payment', v_net_id, 'tds_payment', v_tds_id, 'invoice_id', v_invoice, 'tds_receivable', v_tds_row);
end;
$function$;

-- ── settle_employee_advance (from 20261011070000_r717_payroll_roles) — 3 × CURRENT_DATE ─────

CREATE OR REPLACE FUNCTION public.settle_employee_advance(p_advance_id uuid, p_date date DEFAULT public.ist_today(), p_account uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_adv      public.prepaid_advances;
  v_returned int;
  v_trusted boolean;
begin
  /* R-717: role gate. Trusted = service_role or a direct DB session with no request role
     (same rule as R-454 / R-714). Everyone else must hold one of the roles below — a
     null-caller (no public.users row) holds none, so it is refused here too. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can settle an employee advance' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  select * into v_adv from public.prepaid_advances
   where id = p_advance_id and tenant_id = v_tenant and category = 'Employee advance' for update;
  if not found then raise exception 'Advance not found.'; end if;
  if v_adv.closed_at is not null then raise exception 'This advance is already settled.'; end if;

  v_returned := v_adv.total_amount - v_adv.consumed_amount;
  update public.prepaid_advances
     set total_amount = consumed_amount, closed_at = now(), updated_at = now(),
         notes = concat_ws(E'\n', notes, 'Settled on ' || to_char(coalesce(p_date, public.ist_today()), 'DD Mon YYYY')
                                         || ' · ₹' || v_returned || ' returned')
   where id = p_advance_id;

  if v_returned > 0 then
    perform public._employee_advance_cash_leg(v_tenant, coalesce(p_account, v_adv.bank_account_id), coalesce(p_date, public.ist_today()),
                                              0, v_returned, 'Advance returned by ' || v_adv.vendor_name, p_advance_id);
  end if;
  return v_returned;
end $function$;

-- ── settle_reimbursement (from prisma 20261005120000_tenant_context) — 1 × CURRENT_DATE ─────

CREATE OR REPLACE FUNCTION public.settle_reimbursement(p_id uuid, p_settled_on date, p_notes text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_r      public.reimbursements;
begin
  select * into v_r from public.reimbursements where id = p_id;
  if not found then raise exception 'Reimbursement not found'; end if;
  if (v_tenant is null and coalesce(auth.role(), '') in ('anon', 'authenticated')) or (v_tenant is not null and v_r.tenant_id is distinct from v_tenant) then
    raise exception 'Not in your tenant' using errcode = 'insufficient_privilege';
  end if;
  update public.reimbursements
     set status = 'settled', settled_on = coalesce(p_settled_on, public.ist_today()),
         settled_notes = nullif(trim(coalesce(p_notes, '')), '')
   where id = p_id;
end;
$function$;

-- ── submit_expense_claim (from supabase/baseline.sql) — 1 × CURRENT_DATE ─────

CREATE OR REPLACE FUNCTION public.submit_expense_claim(p_tenant_id uuid, p_employee_id uuid, p_pin text, p_amount integer, p_category text, p_purpose text, p_spent_on date, p_receipt_path text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_emp        public.employees;
  v_loan       public.employee_loans;
  v_paid       integer;
  v_pending    integer;
  v_available  integer;
  v_claim      uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be more than zero';
  end if;
  if trim(coalesce(p_category, '')) = '' then
    raise exception 'Please choose a category';
  end if;

  select * into v_emp from public.employees
    where id = p_employee_id and tenant_id = p_tenant_id;
  if not found then raise exception 'Employee not found'; end if;
  if not v_emp.is_active then raise exception 'This employee is inactive'; end if;
  if v_emp.pin_hash is null then raise exception 'No PIN set for you — ask the office to set one'; end if;
  if p_pin is null or crypt(p_pin, v_emp.pin_hash) <> v_emp.pin_hash then
    raise exception 'Wrong PIN';
  end if;

  select * into v_loan from public.employee_loans
    where tenant_id = p_tenant_id and employee_name = v_emp.name
      and kind = 'expense_advance' and status = 'active'
    order by created_at desc limit 1;
  if not found then
    raise exception 'You have no open expense advance to claim against';
  end if;

  select coalesce(sum(amount), 0) into v_paid
    from public.employee_loan_repayments where loan_id = v_loan.id;
  select coalesce(sum(amount), 0) into v_pending
    from public.expense_claims where loan_id = v_loan.id and status = 'pending';
  v_available := v_loan.principal - v_paid - v_pending;

  if p_amount > v_available then
    raise exception 'Amount (%) is more than your remaining advance (%)', p_amount, v_available;
  end if;

  insert into public.expense_claims
    (tenant_id, loan_id, employee_id, amount, category, purpose, spent_on, receipt_path, status)
  values
    (p_tenant_id, v_loan.id, p_employee_id, p_amount, trim(p_category),
     nullif(trim(coalesce(p_purpose, '')), ''), coalesce(p_spent_on, public.ist_today()), p_receipt_path, 'pending')
  returning id into v_claim;

  return v_claim;
end;
$function$;

-- ── top_up_employee_advance (from 20261011070000_r717_payroll_roles) — 3 × CURRENT_DATE ─────

CREATE OR REPLACE FUNCTION public.top_up_employee_advance(p_advance_id uuid, p_amount integer, p_date date DEFAULT public.ist_today(), p_account uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_adv    public.prepaid_advances;
  v_trusted boolean;
begin
  /* R-717: role gate. Trusted = service_role or a direct DB session with no request role
     (same rule as R-454 / R-714). Everyone else must hold one of the roles below — a
     null-caller (no public.users row) holds none, so it is refused here too. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can top up an employee advance' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Amount must be more than ₹0.'; end if;
  select * into v_adv from public.prepaid_advances
   where id = p_advance_id and tenant_id = v_tenant and category = 'Employee advance' for update;
  if not found then raise exception 'Advance not found.'; end if;

  update public.prepaid_advances
     set total_amount = total_amount + p_amount, closed_at = null, updated_at = now(),
         notes = concat_ws(E'\n', notes, 'Top-up ₹' || p_amount || ' on ' || to_char(coalesce(p_date, public.ist_today()), 'DD Mon YYYY'))
   where id = p_advance_id;

  perform public._employee_advance_cash_leg(v_tenant, coalesce(p_account, v_adv.bank_account_id), coalesce(p_date, public.ist_today()),
                                            p_amount, 0, 'Advance top-up to ' || v_adv.vendor_name, p_advance_id);
  return v_adv.total_amount + p_amount - v_adv.consumed_amount;
end $function$;

commit;
