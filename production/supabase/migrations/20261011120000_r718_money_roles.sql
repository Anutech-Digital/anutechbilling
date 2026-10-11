-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.book_bank_txn_as_expense(uuid,text,text,integer,text)') and prosrc like '%R-718%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.book_bank_txn_as_prepaid(uuid,text,text,text)') and prosrc like '%R-718%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.book_bank_txn_as_referral_commission(uuid,uuid)') and prosrc like '%R-718%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.book_bank_txn_as_statutory(uuid,text,text,text,text)') and prosrc like '%R-718%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.book_bank_txn_as_tax(uuid,text,text,text,integer,integer,text)') and prosrc like '%R-718%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.book_bank_txn_as_vendor_bill(uuid,text,text)') and prosrc like '%R-718%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.create_direct_invoice(uuid,jsonb,text,boolean)') and prosrc like '%R-718%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.delete_payment(uuid)') and prosrc like '%R-718%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.delete_project_invoice(text)') and prosrc like '%R-718%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.delete_subscription(uuid)') and prosrc like '%R-718%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.delete_subscription_invoice(text)') and prosrc like '%R-718%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.issue_credit_note(text,integer,text,text,text)') and prosrc like '%R-718%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.issue_debit_note(text,integer,text,text,text)') and prosrc like '%R-718%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.pay_referral_commission(uuid,uuid,date,text)') and prosrc like '%R-718%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.pay_vendor_bill(text,integer,date,uuid,text)') and prosrc like '%R-718%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_bank_txn(uuid,text,text,text)') and prosrc like '%R-718%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.record_account_transfer(uuid,uuid,integer,date,text)') and prosrc like '%R-718%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.record_payment(text,integer,text,text,text)') and prosrc like '%R-718%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.redeem_customer_credits(uuid,integer,text)') and prosrc like '%R-718%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.unreconcile_bank_receipt(uuid,boolean)') and prosrc like '%R-718%')
-- deploy-key: r718money
-- 20261011120000_r718_money_roles.sql
--
-- R-718 (P1 SECURITY, audit 10 Oct 2026): money SECURITY DEFINER functions check the
-- caller's ROLE, not just the company.
--
-- ══ WHAT WAS OPEN, measured on the local DB 11 Oct ═══════════════════════════════
--
--   Every function below checked only the tenant. A definer skips RLS, so any member of the
--   company — sales, support, delivery — could record a payment, issue a credit note, make a
--   direct invoice, spend a customer's credit, delete a subscription, match / book bank
--   lines, pay a vendor bill or referral commission, or move money between accounts; and a
--   manager or billing user could delete payments, invoices and subscriptions.
--   (supabase/tests/r718_money_roles.test.sql: 112 failures on the old bodies — sales
--   recorded a payment, issued a credit note, made an invoice, redeemed credit and deleted a
--   subscription, all for real.)
--
-- ══ WHAT CHANGES (guards only — bodies are the newest definitions, money maths untouched) ═
--
--   Pardeep's role table (card R-718, decision "haan", 11 Oct 2026):
--   (1) owner, manager, accountant, billing:
--         record_payment, issue_credit_note, issue_debit_note, create_direct_invoice,
--         pay_vendor_bill, pay_referral_commission, record_account_transfer,
--         reconcile_bank_txn, book_bank_txn_as_{expense,prepaid,referral_commission,
--         statutory,tax,vendor_bill}, redeem_customer_credits, unreconcile_bank_receipt
--   (2) owner, accountant only:
--         delete_payment, delete_subscription, delete_project_invoice,
--         delete_subscription_invoice, and unreconcile_bank_receipt(p_undo_sale => true)
--         (it deletes the receipt).
--   (3) sales, sales_senior, support, delivery, partner_agent, a null-caller: none of these.
--   Trust rule as R-454 / R-714 / R-717: service_role or a direct DB session with no request
--   role is trusted. Callers checked 11 Oct: record_payment is called through the ADMIN
--   client by the Razorpay webhook, /api/public/checkout/workspace, lib/checkout/cart-checkout
--   and lib/checkout/quote-order (public quote pay + DMS renewal order) — all service_role,
--   unaffected. Every other call is the signed-in browser client. Inside SQL:
--   bill_late_charges → issue_debit_note and unreconcile_bank_receipt → reconcile_bank_txn /
--   issue_credit_note run with the same caller, so they inherit the same rule.
--   Refusal: SQLSTATE 42501 "Only an owner, manager, accountant or billing user can …" /
--   "Only an owner or accountant user can …". Tenant match is unchanged in every body.
--
-- Source of the bodies: pg_get_functiondef on the local DB at manager-pardeep a4ee8fbb
-- (record_payment = 20261011000500_r829_line_domain_kept; create_direct_invoice /
-- issue_debit_note = 20260930172000; issue_credit_note = 20260930174000; the rest their
-- newest migration). Signatures unchanged → grants and comments are kept as they are.
-- Staging: the deploy script rewrites auth.role() -> public.current_request_role() (R-161).
-- Test: supabase/tests/r718_money_roles.test.sql (rolled back).

begin;

CREATE OR REPLACE FUNCTION public.book_bank_txn_as_expense(p_txn_id uuid, p_category text, p_vendor text, p_gst integer, p_notes text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn    public.bank_transactions;
  v_exp_id text;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can book a bank line' using errcode = '42501';
  end if;
  if trim(coalesce(p_category, '')) = '' then
    raise exception 'Please choose a category';
  end if;
  select * into v_txn from public.bank_transactions
    where id = p_txn_id and tenant_id = v_tenant;
  if not found then raise exception 'Transaction not found'; end if;
  if coalesce(v_txn.debit, 0) <= 0 then
    raise exception 'Only a money-out (debit) line can be booked as an expense';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This line is already reconciled';
  end if;
  v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint))
                     || '-' || upper(to_hex((random() * 255)::int));
  insert into public.expenses
    (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description,
     paid, paid_date, bank_account_id, reconciled_txn_id)
  values
    (v_exp_id, v_tenant, trim(p_category), nullif(trim(coalesce(p_vendor, '')), ''),
     v_txn.txn_date, v_txn.debit, greatest(coalesce(p_gst, 0), 0), 'bank',
     coalesce(nullif(trim(coalesce(p_notes, '')), ''), v_txn.description),
     true, v_txn.txn_date, v_txn.bank_account_id, p_txn_id);
  update public.bank_transactions
     set matched_to_type = 'expense', matched_to_id = v_exp_id, match_confidence = 'manual',
         matched_at = now(), matched_by = auth.uid()
   where id = p_txn_id and tenant_id = v_tenant;
  return v_exp_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.book_bank_txn_as_prepaid(p_txn_id uuid, p_vendor_name text, p_category text DEFAULT 'Advertising'::text, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn    public.bank_transactions;
  v_id     uuid;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can book a bank line' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  if nullif(trim(coalesce(p_vendor_name, '')), '') is null then
    raise exception 'Enter who the advance was paid to (e.g. Facebook).';
  end if;
  if nullif(trim(coalesce(p_category, '')), '') is null or p_category = 'Salaries' then
    raise exception 'Pick the expense category this advance will be used for.';
  end if;

  select * into v_txn from public.bank_transactions where id = p_txn_id and tenant_id = v_tenant;
  if not found then raise exception 'Bank line not found in your company.'; end if;
  if v_txn.matched_to_type is not null then raise exception 'This bank line is already reconciled — un-reconcile it first.'; end if;
  if coalesce(v_txn.debit, 0) <= 0 then raise exception 'An advance paid out must be a money-out line.'; end if;

  insert into public.prepaid_advances
    (tenant_id, vendor_name, category, total_amount, consumed_amount, paid_date, payment_method,
     bank_account_id, notes, created_by, bank_txn_id)
  values
    (v_tenant, trim(p_vendor_name), p_category, v_txn.debit, 0, v_txn.txn_date, 'bank_transfer',
     v_txn.bank_account_id, coalesce(nullif(trim(coalesce(p_notes, '')), ''), v_txn.description), auth.uid(), p_txn_id)
  returning id into v_id;

  update public.bank_transactions
     set matched_to_type = 'prepaid', matched_to_id = v_id::text, match_confidence = 'manual',
         matched_at = now(), matched_by = auth.uid(), updated_at = now()
   where id = p_txn_id;

  return v_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.book_bank_txn_as_referral_commission(p_txn_id uuid, p_commission_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn public.bank_transactions;
  v_comm public.referral_commissions;
  v_synth uuid;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can book a bank line' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No tenant context'; end if;
  select * into v_txn from public.bank_transactions where id = p_txn_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Bank transaction not found'; end if;
  if v_txn.matched_to_type is not null then raise exception 'This line is already reconciled'; end if;
  if coalesce(v_txn.debit, 0) <= 0 then raise exception 'A commission payment must be a money-out line'; end if;

  select * into v_comm from public.referral_commissions where id = p_commission_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Commission not found'; end if;
  if v_comm.status = 'cancelled' then raise exception 'Commission is cancelled'; end if;
  if v_txn.debit <> v_comm.net_payable then
    raise exception 'Line (%) is not the commission''s net payable (%) — commissions are paid in full', v_txn.debit, v_comm.net_payable;
  end if;

  select id into v_synth from public.bank_transactions
   where tenant_id = v_tenant and id <> p_txn_id and source = 'manual'
     and matched_to_type = 'referral_commission' and matched_to_id = p_commission_id::text
   order by abs(txn_date - v_txn.txn_date) limit 1;

  if v_synth is not null then
    delete from public.bank_transactions where id = v_synth;
  elsif v_comm.status = 'paid' then
    raise exception 'Commission already paid (and its bank line is not a synthetic one) — un-reconcile that first';
  end if;

  update public.referral_commissions
     set status = 'paid', paid_date = coalesce(paid_date, v_txn.txn_date), pay_txn_id = p_txn_id
   where id = p_commission_id;

  update public.bank_transactions
     set matched_to_type = 'referral_commission', matched_to_id = p_commission_id::text, match_confidence = 'manual',
         matched_at = now(), matched_by = auth.uid(), updated_at = now()
   where id = p_txn_id;

  return jsonb_build_object('commission_id', p_commission_id, 'replaced_synthetic', v_synth, 'amount', v_txn.debit);
end; $function$
;

CREATE OR REPLACE FUNCTION public.book_bank_txn_as_statutory(p_txn_id uuid, p_kind text, p_notes text DEFAULT NULL::text, p_challan_no text DEFAULT NULL::text, p_period text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn public.bank_transactions;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can book a bank line' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No tenant context'; end if;
  select * into v_txn from public.bank_transactions where id = p_txn_id and tenant_id = v_tenant;
  if not found then raise exception 'Bank transaction not found'; end if;
  if v_txn.matched_to_type is not null then raise exception 'This line is already reconciled'; end if;
  if coalesce(v_txn.debit,0) <= 0 then raise exception 'A statutory payment must be a money-out line'; end if;

  insert into public.statutory_dues_payments (tenant_id, kind, amount, paid_on, bank_account_id, notes, bank_txn_id, challan_no, period)
  values (v_tenant, coalesce(nullif(p_kind,''),'mixed'), v_txn.debit, v_txn.txn_date, v_txn.bank_account_id,
          nullif(trim(coalesce(p_notes,'')),''), p_txn_id,
          nullif(trim(coalesce(p_challan_no,'')),''), nullif(trim(coalesce(p_period,'')),''));

  update public.bank_transactions
     set matched_to_type='statutory', matched_to_id=null, match_confidence='manual',
         matched_at=now(), matched_by=auth.uid(), updated_at=now()
   where id = p_txn_id;
end; $function$
;

CREATE OR REPLACE FUNCTION public.book_bank_txn_as_tax(p_txn_id uuid, p_kind text, p_period text DEFAULT NULL::text, p_fy text DEFAULT NULL::text, p_interest integer DEFAULT 0, p_late_fee integer DEFAULT 0, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_txn      public.bank_transactions;
  v_interest integer := coalesce(p_interest, 0);
  v_late     integer := coalesce(p_late_fee, 0);
  v_tax      integer;
  v_exp_id   text;
  v_id       uuid;
  v_label    text;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can book a bank line' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  if p_kind not in ('gst', 'advance_tax', 'self_assessment_tax') then
    raise exception 'Unknown tax type "%" — pick GST, advance tax or self-assessment tax.', p_kind;
  end if;

  select * into v_txn from public.bank_transactions where id = p_txn_id and tenant_id = v_tenant;
  if not found then raise exception 'Bank line not found in your company.'; end if;
  if v_txn.matched_to_type is not null then raise exception 'This bank line is already reconciled — un-reconcile it first.'; end if;
  if coalesce(v_txn.debit, 0) <= 0 then raise exception 'A tax payment must be a money-out line.'; end if;

  if v_interest < 0 or v_late < 0 then raise exception 'Interest and late fee cannot be negative.'; end if;
  v_tax := v_txn.debit - v_interest - v_late;
  if v_tax <= 0 then
    raise exception 'Interest + late fee (₹%) leave no tax out of this ₹% line — check the amounts.', v_interest + v_late, v_txn.debit;
  end if;

  if p_kind = 'gst' then
    if p_period is null or p_period !~ '^\d{4}-(0[1-9]|1[0-2])$' then
      raise exception 'Pick the GST return month this payment is for.';
    end if;
    v_label := 'GST ' || p_period;
  else
    if p_fy is null or p_fy !~ '^\d{4}-\d{2}$'
       or (split_part(p_fy, '-', 1)::int + 1) % 100 <> split_part(p_fy, '-', 2)::int then
      raise exception 'Pick the financial year, e.g. 2026-27.';
    end if;
    v_label := case p_kind when 'advance_tax' then 'Advance tax FY ' else 'Self-assessment tax FY ' end || p_fy;
  end if;

  /* Interest and late fee are expenses — booked, paid from this account, and tied to
     this line so they never show as an unreconciled expense. */
  if v_interest + v_late > 0 then
    v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)) || '-' || upper(to_hex((random() * 255)::int));
    insert into public.expenses
      (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method,
       description, paid, paid_date, bank_account_id, reconciled_txn_id, bill_type)
    values
      (v_exp_id, v_tenant, 'Rates & Taxes', 'Government', v_txn.txn_date, v_interest + v_late, 0, 'bank_transfer',
       v_label || ' — ' ||
         concat_ws(' + ',
           case when v_interest > 0 then 'interest ₹' || v_interest end,
           case when v_late > 0 then 'late fee ₹' || v_late end),
       true, v_txn.txn_date, v_txn.bank_account_id, p_txn_id, 'none');
  end if;

  insert into public.tax_payments
    (tenant_id, kind, amount, interest, late_fee, period, fy, paid_on, bank_account_id, bank_txn_id, expense_id, notes)
  values
    (v_tenant, p_kind, v_tax, v_interest, v_late,
     case when p_kind = 'gst' then p_period end,
     case when p_kind <> 'gst' then p_fy end,
     v_txn.txn_date, v_txn.bank_account_id, p_txn_id, v_exp_id,
     nullif(trim(coalesce(p_notes, '')), ''))
  returning id into v_id;

  update public.bank_transactions
     set matched_to_type = 'statutory', matched_to_id = v_id::text, match_confidence = 'manual',
         matched_at = now(), matched_by = auth.uid(), updated_at = now()
   where id = p_txn_id;

  return v_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.book_bank_txn_as_vendor_bill(p_txn_id uuid, p_bill_id text, p_method text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn public.bank_transactions;
  v_bill public.vendor_bills;
  v_synth uuid;
  v_outstanding integer;
  v_new_paid integer;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can book a bank line' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No tenant context'; end if;
  select * into v_txn from public.bank_transactions where id = p_txn_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Bank transaction not found'; end if;
  if v_txn.matched_to_type is not null then raise exception 'This line is already reconciled'; end if;
  if coalesce(v_txn.debit, 0) <= 0 then raise exception 'A bill payment must be a money-out line'; end if;

  select * into v_bill from public.vendor_bills where id = p_bill_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Bill not found'; end if;

  -- The same payment already booked from the Bills page as a synthetic line? Replace it.
  select id into v_synth from public.bank_transactions
   where tenant_id = v_tenant and id <> p_txn_id and source = 'manual'
     and matched_to_type = 'vendor_bill' and matched_to_id = p_bill_id
     and debit = v_txn.debit
   order by abs(txn_date - v_txn.txn_date) limit 1;

  if v_synth is not null then
    delete from public.bank_transactions where id = v_synth;
  else
    v_outstanding := coalesce(v_bill.total, 0) - coalesce(v_bill.paid_amount, 0);
    if v_txn.debit > v_outstanding then
      raise exception 'Line (%) is more than the bill''s outstanding (%) — split the line, or pick the right bill', v_txn.debit, v_outstanding;
    end if;
    v_new_paid := coalesce(v_bill.paid_amount, 0) + v_txn.debit;
    update public.vendor_bills
       set paid_amount = v_new_paid,
           status = case when v_new_paid >= coalesce(total, 0) then 'paid' else 'partial' end,
           updated_at = now()
     where id = p_bill_id;
  end if;

  update public.bank_transactions
     set matched_to_type = 'vendor_bill', matched_to_id = p_bill_id, match_confidence = 'manual',
         reference = coalesce(nullif(trim(coalesce(p_method, '')), ''), reference),
         matched_at = now(), matched_by = auth.uid(), updated_at = now()
   where id = p_txn_id;

  return jsonb_build_object('bill_id', p_bill_id, 'replaced_synthetic', v_synth, 'amount', v_txn.debit);
end; $function$
;

CREATE OR REPLACE FUNCTION public.create_direct_invoice(p_customer_id uuid, p_line_items jsonb, p_notes text DEFAULT NULL::text, p_recurring boolean DEFAULT false)
 RETURNS TABLE(invoice_id text, quote_id text, net_payable integer, tax_rate integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_is_svc   boolean := auth.role() = 'service_role';
  v_cust     record;
  v_export   boolean;
  v_rate     integer;
  v_subtotal integer;
  v_gross    integer;
  v_qid      text;
  v_inv      record;
  v_commit   text := case when p_recurring then 'annual_yearly' else 'one_time' end;
  v_lines    jsonb;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can create an invoice' using errcode = '42501';
  end if;
  if not v_is_svc and v_tenant is null then raise exception 'No tenant context'; end if;
  if p_customer_id is null then raise exception 'Customer required'; end if;
  if jsonb_typeof(p_line_items) <> 'array' or jsonb_array_length(p_line_items) = 0 then
    raise exception 'At least one line item is required';
  end if;

  select c.id, c.name, c.country, c.tenant_id into v_cust
    from public.customers c where c.id = p_customer_id;
  if not found then raise exception 'Customer not found'; end if;
  if not v_is_svc and v_cust.tenant_id is distinct from v_tenant then
    raise exception 'Customer is not in the caller''s tenant';
  end if;
  v_tenant := v_cust.tenant_id;

  v_export := coalesce(nullif(lower(trim(v_cust.country)), ''), 'india') not in ('india','in','ind','bharat');
  v_rate := case when v_export then 0 else 18 end;

  select coalesce(jsonb_agg(li || jsonb_build_object('commitment', v_commit)), '[]'::jsonb)
    into v_lines
    from jsonb_array_elements(p_line_items) li;

  select coalesce(sum( coalesce((li->>'qty')::int, 1) * coalesce((li->>'rate')::int, 0) ), 0)
    into v_subtotal
    from jsonb_array_elements(v_lines) li;
  if v_subtotal <= 0 then raise exception 'Invoice total must be greater than zero'; end if;
  v_gross := v_subtotal + round(v_subtotal * v_rate / 100.0)::int;

  v_qid := public.next_document_number('quote', v_tenant, public.ist_today());
  if v_qid is null then raise exception 'Could not allocate a quote number'; end if;

  insert into public.quotes (
    id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, discount_pct,
    line_items, status, payment_status, is_one_off, created_date, notes
  ) values (
    v_qid, v_tenant, p_customer_id, v_cust.name, v_gross, v_subtotal, v_rate, 0,
    v_lines, 'accepted', 'awaiting', not p_recurring, public.ist_today(), p_notes
  );

  select gi.invoice_id, gi.net_payable into v_inv
    from public.generate_invoice(v_qid) gi;

  return query select v_inv.invoice_id, v_qid, v_inv.net_payable, v_rate;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.delete_payment(p_payment_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_pay      record;
  v_quote    record;
  v_remaining integer;
  v_expected  integer;
  v_new_status public.payment_status;
  v_subs_removed int := 0;
  v_pos_removed  int := 0;
  v_bank_cnt int;
  v_bad_po   int;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only an owner or accountant user can delete a payment' using errcode = '42501';
  end if;
  select * into v_pay from public.payments where id = p_payment_id;
  if not found then raise exception 'Payment not found'; end if;
  if (v_tenant is null and coalesce(auth.role(), '') in ('anon', 'authenticated')) or (v_tenant is not null and v_pay.tenant_id is distinct from v_tenant) then
    raise exception 'Payment not in your tenant' using errcode = 'insufficient_privilege';
  end if;

  select id, tenant_id, amount, invoice_id, is_add_seats, lead_id, customer_id, customer_name, status
    into v_quote from public.quotes where id = v_pay.quote_id;

  if v_quote.invoice_id is not null then
    raise exception 'A GST invoice is already generated for this quote — cancel / credit-note that invoice before deleting the payment.'
      using errcode = 'invalid_parameter_value';
  end if;

  select count(*) into v_bank_cnt from public.bank_transactions
   where tenant_id = v_pay.tenant_id and matched_to_type = 'payment' and matched_to_id = v_pay.id::text;
  if v_bank_cnt > 0 then
    raise exception 'This payment is reconciled to a bank transaction — un-reconcile that bank line first, then delete.'
      using errcode = 'invalid_parameter_value';
  end if;

  if coalesce(v_quote.is_add_seats, false) then
    if exists (
      select 1 from public.subscriptions s
       where s.tenant_id = v_pay.tenant_id
         and ( (v_quote.customer_id is not null and s.customer_id = v_quote.customer_id)
            or (v_quote.customer_id is null and s.customer_name = v_quote.customer_name) )
    ) then
      raise exception 'This is an add-seats payment — adjust it from the subscription (reduce seats), not by deleting here.'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  delete from public.payments where id = p_payment_id;

  select coalesce(sum(amount), 0) into v_remaining
    from public.payments where quote_id = v_pay.quote_id and status = 'received';
  v_expected := coalesce(v_quote.amount, 0);

  v_new_status := case
    when v_remaining <= 0            then 'none'
    when v_remaining >= v_expected   then 'received'
    else                                  'partial' end::public.payment_status;

  update public.quotes
     set payment_status      = v_new_status,
         payment_amount      = v_remaining,
         payment_method      = case when v_remaining <= 0 then null else payment_method end,
         payment_reference   = case when v_remaining <= 0 then null else payment_reference end,
         payment_received_at = case when v_remaining <= 0 then null else payment_received_at end,
         payment_notes       = case when v_remaining <= 0 then null else payment_notes end,
         status              = case when v_remaining <= 0 and status = 'accepted'
                                    then 'sent'::public.quote_status else status end
   where id = v_pay.quote_id and tenant_id = v_pay.tenant_id;

  if v_remaining <= 0 then
    select count(*) into v_bad_po
      from public.purchase_orders po
      join public.subscriptions s on s.id = po.subscription_id
     where s.tenant_id = v_pay.tenant_id and s.quote_id = v_pay.quote_id and po.status <> 'draft';
    if v_bad_po > 0 then
      raise exception 'A purchase order from this sale is already processed — handle it manually before deleting the payment.'
        using errcode = 'invalid_parameter_value';
    end if;

    with subs as (
      select id from public.subscriptions where tenant_id = v_pay.tenant_id and quote_id = v_pay.quote_id
    )
    delete from public.purchase_orders po using subs where po.subscription_id = subs.id;
    get diagnostics v_pos_removed = row_count;

    delete from public.subscriptions where tenant_id = v_pay.tenant_id and quote_id = v_pay.quote_id;
    get diagnostics v_subs_removed = row_count;

    if v_quote.lead_id is not null then
      update public.leads set stage = 'quote', trial_converted_at = null
       where id = v_quote.lead_id and tenant_id = v_pay.tenant_id and stage = 'won';
    end if;
  else
    update public.subscriptions set outstanding_amount = greatest(0, v_expected - v_remaining)
     where tenant_id = v_pay.tenant_id and quote_id = v_pay.quote_id;
  end if;

  return jsonb_build_object(
    'deleted', true, 'quote_id', v_pay.quote_id, 'amount', v_pay.amount,
    'remaining', v_remaining, 'new_payment_status', v_new_status,
    'subscriptions_removed', v_subs_removed, 'purchase_orders_removed', v_pos_removed
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.delete_project_invoice(p_invoice_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_inv     public.invoices;
  v_ms_ids  uuid[];
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only an owner or accountant user can delete an invoice' using errcode = '42501';
  end if;
  select * into v_inv from public.invoices where id = p_invoice_id;
  if not found then raise exception 'Invoice not found'; end if;
  /* R-013 (Pardeep, 27 Sep 2026): the hardened form. The old guard opened by testing
     that the tenant was NOT null and only then comparing — so a NULL tenant skipped the
     comparison entirely, which is the anon case and the signed-in-but-no-users-row case,
     and quote/invoice ids are countable. Migration 20260927100000 rewrote 17 definer RPCs
     by regex; this file recreates some of them, so it must carry the hardened shape
     forward or it silently undoes that fix.

     The old wording is deliberately NOT quoted here. `definer_rpc_hardening.test.sql`
     FAIL 4 scans `pg_get_functiondef`, which includes COMMENTS — so writing the phrase in
     prose turns that security test red for no reason (AGENTS.md L46). Verified: quoting it
     did exactly that. */
  if (v_tenant is null and coalesce(auth.role(), '') in ('anon', 'authenticated'))
     or (v_tenant is not null and v_inv.tenant_id is distinct from v_tenant) then
    raise exception 'Invoice not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;

  /* R-014. Checked HERE as well as in the trigger, on purpose. The trigger is the floor
     and cannot be bypassed; this one exists so the operator gets the refusal before any
     of the unlinking below has run, and so the message can name the project flow. Two
     guards, one of which is reachable and one of which is unavoidable.

     It honours the same escape hatch as the trigger, and that is not decoration: a hatch
     the trigger respects and the RPC does not is a hatch that works for a raw DELETE and
     silently fails for the sanctioned route — which is how somebody ends up deleting the
     row by hand instead, with no guard in the way at all. */
  if v_inv.status <> 'draft'
     and nullif(btrim(coalesce(current_setting('app.invoice_amend_reason', true), '')), '') is null then
    raise exception
      'Invoice % is % — an issued invoice cannot be deleted. Raise a credit note against it instead (Invoices → open % → Credit note); that keeps the number on the GST record, which deleting it would not.',
      p_invoice_id, v_inv.status, p_invoice_id
      using errcode = 'restrict_violation';
  end if;

  select array_agg(id) into v_ms_ids
    from public.project_milestones
   where invoice_id = p_invoice_id and tenant_id = v_inv.tenant_id;

  if v_ms_ids is null then
    raise exception 'Not a project invoice (nothing references it) — cannot delete here'
      using errcode = 'invalid_parameter_value';
  end if;

  /* R-014, the part that was destroying evidence.
     This used to be `delete from public.project_payments where milestone_id = any(...)`
     and, before that, an unmatching of the bank lines those payments were reconciled to.
     `project_payments` rows are money that actually arrived, carrying `bank_txn_id` back
     to a real statement line — they are not a detail of the invoice and they outlive it.

     A draft invoice should never have payments against it in the first place; if one
     somehow does, that is a fact to surface rather than to erase, so the delete is
     refused and the operator is told where to look. */
  if exists (
    select 1 from public.project_payments
     where milestone_id = any (v_ms_ids) and tenant_id = v_inv.tenant_id
  ) then
    raise exception
      'Invoice % has payments recorded against its milestones. Delete or refund those payments first (Projects → the project → Payments) — they are real receipts reconciled to your bank statement and this must not remove them.',
      p_invoice_id
      using errcode = 'restrict_violation';
  end if;

  update public.project_milestones
     set invoice_id = null, status = 'pending'
   where id = any (v_ms_ids);

  delete from public.invoices where id = p_invoice_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.delete_subscription(p_subscription_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_sub    record;
  v_paid_cnt int;
  v_bad_po   int;
  v_pos_removed int := 0;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only an owner or accountant user can delete a subscription' using errcode = '42501';
  end if;
  select * into v_sub from public.subscriptions where id = p_subscription_id;
  if not found then raise exception 'Subscription not found'; end if;
  if (v_tenant is null and coalesce(auth.role(), '') in ('anon', 'authenticated')) or (v_tenant is not null and v_sub.tenant_id is distinct from v_tenant) then
    raise exception 'Subscription not in your tenant' using errcode = 'insufficient_privilege';
  end if;

  if v_sub.quote_id is not null then
    select count(*) into v_paid_cnt from public.payments
     where tenant_id = v_sub.tenant_id and quote_id = v_sub.quote_id and status = 'received';
    if v_paid_cnt > 0 then
      raise exception 'This subscription came from a paid quote — delete that payment in Payments instead; it removes this subscription cleanly.'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  select count(*) into v_bad_po from public.purchase_orders
   where tenant_id = v_sub.tenant_id and subscription_id = p_subscription_id and status <> 'draft';
  if v_bad_po > 0 then
    raise exception 'A purchase order linked to this subscription is already processed — handle it manually first.'
      using errcode = 'invalid_parameter_value';
  end if;

  delete from public.purchase_orders
   where tenant_id = v_sub.tenant_id and subscription_id = p_subscription_id;
  get diagnostics v_pos_removed = row_count;

  delete from public.subscriptions where id = p_subscription_id;

  return jsonb_build_object('deleted', true, 'purchase_orders_removed', v_pos_removed);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.delete_subscription_invoice(p_invoice_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_inv    public.invoices;
  v_paid   integer;
  v_status payment_status;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only an owner or accountant user can delete an invoice' using errcode = '42501';
  end if;
  select * into v_inv from public.invoices where id = p_invoice_id;
  if not found then raise exception 'Invoice not found'; end if;
  /* R-013 (Pardeep, 27 Sep 2026): the hardened form. The old guard opened by testing
     that the tenant was NOT null and only then comparing — so a NULL tenant skipped the
     comparison entirely, which is the anon case and the signed-in-but-no-users-row case,
     and quote/invoice ids are countable. Migration 20260927100000 rewrote 17 definer RPCs
     by regex; this file recreates some of them, so it must carry the hardened shape
     forward or it silently undoes that fix.

     The old wording is deliberately NOT quoted here. `definer_rpc_hardening.test.sql`
     FAIL 4 scans `pg_get_functiondef`, which includes COMMENTS — so writing the phrase in
     prose turns that security test red for no reason (AGENTS.md L46). Verified: quoting it
     did exactly that. */
  if (v_tenant is null and coalesce(auth.role(), '') in ('anon', 'authenticated'))
     or (v_tenant is not null and v_inv.tenant_id is distinct from v_tenant) then
    raise exception 'Invoice not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;

  if exists (select 1 from public.project_milestones where invoice_id = p_invoice_id) then
    raise exception 'This is a project invoice — delete it from the project flow'
      using errcode = 'invalid_parameter_value';
  end if;

  -- R-014. Same guard, same escape hatch, same reasons as the project path above.
  if v_inv.status <> 'draft'
     and nullif(btrim(coalesce(current_setting('app.invoice_amend_reason', true), '')), '') is null then
    raise exception
      'Invoice % is % — an issued invoice cannot be deleted. Raise a credit note against it instead (Invoices → open % → Credit note); that keeps the number on the GST record, which deleting it would not.',
      p_invoice_id, v_inv.status, p_invoice_id
      using errcode = 'restrict_violation';
  end if;

  if v_inv.quote_id is not null then
    select coalesce(sum(amount), 0) into v_paid
      from public.payments
     where quote_id = v_inv.quote_id and status = 'received';

    v_status := (case
      when v_paid >= coalesce(v_inv.amount, 0) and v_paid > 0 then 'received'
      when v_paid > 0                                         then 'partial'
      else 'none'
    end)::payment_status;

    update public.quotes
       set invoice_id = null, payment_status = v_status
     where id = v_inv.quote_id and tenant_id = v_inv.tenant_id;
  end if;

  delete from public.invoices where id = p_invoice_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.issue_credit_note(p_invoice_id text, p_gross_amount integer, p_reason_code text DEFAULT 'other'::text, p_reason text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_inv             record;
  v_is_service      boolean;
  v_caller_tenant   uuid;
  v_already         integer;
  v_max_creditable  integer;
  v_rate            integer;
  v_taxable         integer;
  v_tax             integer;
  v_cn_id           text;
  v_supply_fy_end   text;
  v_s34_deadline    date;
  v_new_net         integer;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can issue a credit note' using errcode = '42501';
  end if;
  v_is_service := auth.role() = 'service_role';
  if not v_is_service then
    v_caller_tenant := public.current_tenant_id();
    if v_caller_tenant is null then raise exception 'No tenant context'; end if;
  end if;

  if p_gross_amount is null or p_gross_amount <= 0 then
    raise exception 'Credit amount must be greater than zero' using errcode = 'check_violation';
  end if;

  /* R-041 added i.invoice_date: the Section 34(2) deadline is measured from the FY of the
     SUPPLY, so the check below needs the invoice date rather than today. */
  select i.id, i.tenant_id, i.customer_id, i.customer_name, i.amount, i.net_payable,
         i.tax_rate, i.inter_state, i.invoice_date
    into v_inv
    from public.invoices i where i.id = p_invoice_id for update;
  if not found then raise exception 'Invoice % not found', p_invoice_id using errcode = 'no_data_found'; end if;
  if not v_is_service and v_inv.tenant_id is distinct from v_caller_tenant then
    raise exception 'Invoice % is not in the caller''s tenant', p_invoice_id using errcode = 'insufficient_privilege';
  end if;

  select coalesce(sum(amount), 0) into v_already from public.credit_notes where invoice_id = p_invoice_id;
  v_max_creditable := coalesce(v_inv.amount, 0) - v_already;
  if p_gross_amount > v_max_creditable then
    raise exception 'Credit % exceeds the creditable balance % on invoice %',
      p_gross_amount, v_max_creditable, p_invoice_id using errcode = 'check_violation';
  end if;

  v_rate := coalesce(v_inv.tax_rate, 18);
  if v_rate = 0 then
    v_taxable := p_gross_amount;
    v_tax     := 0;
  else
    v_taxable := round(p_gross_amount * 100.0 / (100 + v_rate));
    v_tax     := p_gross_amount - v_taxable;
  end if;

  /* ── R-041: CGST Section 34(2) — a credit note has a deadline ──────────────────
     A credit note may be declared up to 30 NOVEMBER following the end of the financial
     year of the original supply (or the date the annual return is filed, whichever is
     earlier). Past that, the supplier cannot reduce its output tax liability: the note
     can still be raised commercially, but the GST on it is simply lost, and GSTR-1 will
     not accept it against that invoice.

     Nothing checked this. A note raised in, say, January against an invoice from two
     financial years earlier looked completely normal and quietly wrote off the tax.

     The annual-return half is not knowable from this database, so only the 30 November
     limb is enforced — the earlier of the two is what the law asks for, so this is the
     permissive side of the rule and is stated as such rather than claimed as complete. */
  v_supply_fy_end := (public.indian_fiscal_year(coalesce(v_inv.invoice_date, public.ist_today())));
  v_s34_deadline  := make_date(2000 + substring(v_supply_fy_end from 5 for 2)::int, 11, 30);
  if public.ist_today() > v_s34_deadline then
    raise exception
      'Too late for a credit note against invoice %: it was supplied in FY %, and CGST Section 34(2) allows one only up to 30 November %. Raise a refund or a commercial adjustment instead — a credit note now cannot reduce the GST you already paid.',
      p_invoice_id, v_supply_fy_end, to_char(v_s34_deadline, 'DD Mon YYYY')
      using errcode = 'check_violation';
  end if;

  v_cn_id := public.next_document_number('credit_note', v_inv.tenant_id, public.ist_today());
  if v_cn_id is null then raise exception 'Could not allocate a credit note number'; end if;

  insert into public.credit_notes (
    id, tenant_id, invoice_id, customer_id, customer_name, credit_date,
    reason_code, reason, amount, taxable_value, tax_amount, tax_rate, inter_state, notes, created_by
  ) values (
    v_cn_id, v_inv.tenant_id, p_invoice_id, v_inv.customer_id, v_inv.customer_name, public.ist_today(),
    coalesce(p_reason_code, 'other'), p_reason, p_gross_amount, v_taxable, v_tax, v_rate,
    coalesce(v_inv.inter_state, false), p_notes, auth.uid()
  );

  v_new_net := greatest(0, coalesce(v_inv.net_payable, v_inv.amount) - p_gross_amount);
  update public.invoices set net_payable = v_new_net, updated_at = now() where id = p_invoice_id;

  return jsonb_build_object(
    'credit_note_id',  v_cn_id,
    'invoice_id',      p_invoice_id,
    'amount',          p_gross_amount,
    'taxable_value',   v_taxable,
    'tax_amount',      v_tax,
    'tax_rate',        v_rate,
    'inter_state',     coalesce(v_inv.inter_state, false),
    'new_net_payable', v_new_net
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.issue_debit_note(p_invoice_id text, p_gross_amount integer, p_reason_code text DEFAULT 'other'::text, p_reason text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_inv           record;
  v_is_service    boolean;
  v_caller_tenant uuid;
  v_rate          integer;
  v_taxable       integer;
  v_tax           integer;
  v_dn_id         text;
  v_new_net       integer;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can issue a debit note' using errcode = '42501';
  end if;
  v_is_service := auth.role() = 'service_role';
  if not v_is_service then
    v_caller_tenant := public.current_tenant_id();
    if v_caller_tenant is null then raise exception 'No tenant context'; end if;
  end if;

  if p_gross_amount is null or p_gross_amount <= 0 then
    raise exception 'Debit amount must be greater than zero' using errcode = 'check_violation';
  end if;

  select i.id, i.tenant_id, i.customer_id, i.customer_name, i.amount, i.net_payable,
         i.tax_rate, i.inter_state
    into v_inv
    from public.invoices i where i.id = p_invoice_id for update;
  if not found then raise exception 'Invoice % not found', p_invoice_id using errcode = 'no_data_found'; end if;
  if not v_is_service and v_inv.tenant_id is distinct from v_caller_tenant then
    raise exception 'Invoice % is not in the caller''s tenant', p_invoice_id using errcode = 'insufficient_privilege';
  end if;

  v_rate := coalesce(v_inv.tax_rate, 18);
  if v_rate = 0 then
    v_taxable := p_gross_amount;
    v_tax     := 0;
  else
    v_taxable := round(p_gross_amount * 100.0 / (100 + v_rate));
    v_tax     := p_gross_amount - v_taxable;
  end if;

  v_dn_id := public.next_document_number('debit_note', v_inv.tenant_id, public.ist_today());
  if v_dn_id is null then raise exception 'Could not allocate a debit note number'; end if;

  insert into public.debit_notes (
    id, tenant_id, invoice_id, customer_id, customer_name, debit_date,
    reason_code, reason, amount, taxable_value, tax_amount, tax_rate, inter_state, notes, created_by
  ) values (
    v_dn_id, v_inv.tenant_id, p_invoice_id, v_inv.customer_id, v_inv.customer_name, public.ist_today(),
    coalesce(p_reason_code, 'other'), p_reason, p_gross_amount, v_taxable, v_tax, v_rate,
    coalesce(v_inv.inter_state, false), p_notes, auth.uid()
  );

  v_new_net := coalesce(v_inv.net_payable, v_inv.amount) + p_gross_amount;
  update public.invoices set net_payable = v_new_net, updated_at = now() where id = p_invoice_id;

  return jsonb_build_object(
    'debit_note_id',   v_dn_id,
    'invoice_id',      p_invoice_id,
    'amount',          p_gross_amount,
    'taxable_value',   v_taxable,
    'tax_amount',      v_tax,
    'tax_rate',        v_rate,
    'inter_state',     coalesce(v_inv.inter_state, false),
    'new_net_payable', v_new_net
  );
end;
$function$
;

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
    (v_tenant, p_bank_account_id, coalesce(p_paid_on, current_date),
     'Referral commission: ' || coalesce(v_pname, 'partner'), v_comm.net_payable, 0, 'manual',
     'referral_commission', p_commission_id::text, 'manual',
     nullif(trim(coalesce(p_method, '')), ''));

  update public.referral_commissions
     set status = 'paid', paid_date = coalesce(p_paid_on, current_date)
   where id = p_commission_id;
end;
$function$
;

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
    (v_tenant, p_bank_account_id, coalesce(p_paid_on, current_date),
     'Bill payment: ' || v_bill.vendor_name, p_amount, 0, 'manual', 'vendor_bill', p_bill_id, 'manual',
     nullif(trim(coalesce(p_method, '')), ''));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.reconcile_bank_txn(p_txn_id uuid, p_matched_to_type text, p_matched_to_id text, p_match_confidence text)
 RETURNS bank_transactions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn    public.bank_transactions;
  v_row    public.bank_transactions;
  v_tax_expenses text[];
  v_used   integer;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can match a bank line' using errcode = '42501';
  end if;
  select * into v_txn from public.bank_transactions where id = p_txn_id;
  if not found then
    raise exception 'Bank transaction not found' using errcode = 'no_data_found';
  end if;
  if (v_tenant is null and coalesce(auth.role(), '') in ('anon', 'authenticated')) or (v_tenant is not null and v_txn.tenant_id is distinct from v_tenant) then
    raise exception 'Not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;

  -- A prepaid line that stops being one: refuse if its advance was already used.
  if v_txn.matched_to_type = 'prepaid' and p_matched_to_type is distinct from 'prepaid' then
    select coalesce(sum(consumed_amount), 0) into v_used
      from public.prepaid_advances where bank_txn_id = p_txn_id;
    if v_used > 0 then
      raise exception 'This advance has ₹% already booked as expenses from invoices. Delete those invoice expenses first (Prepaid page), then un-reconcile.', v_used;
    end if;
  end if;

  if p_matched_to_type is not null then
    update public.bank_transactions
       set matched_to_type  = p_matched_to_type,
           matched_to_id    = p_matched_to_id,
           matched_at       = now(),
           matched_by       = auth.uid(),
           match_confidence = coalesce(p_match_confidence, 'manual')
     where id = p_txn_id
     returning * into v_row;
  else
    update public.bank_transactions
       set matched_to_type  = null,
           matched_to_id    = null,
           matched_at       = null,
           matched_by       = null,
           match_confidence = null
     where id = p_txn_id
     returning * into v_row;
  end if;

  if p_matched_to_type is distinct from 'prepaid' then
    delete from public.prepaid_advances where bank_txn_id = p_txn_id;
  end if;

  -- Tax payment on this line: gone once the line is no longer a tax payment.
  if p_matched_to_type is distinct from 'statutory' then
    select array_agg(expense_id) filter (where expense_id is not null) into v_tax_expenses
      from public.tax_payments where bank_txn_id = p_txn_id;
    delete from public.tax_payments where bank_txn_id = p_txn_id;
    if v_tax_expenses is not null then
      delete from public.expenses where id = any (v_tax_expenses);
    end if;
  end if;

  -- Reverse link on project_payments: clear any stale pointer to this line,
  -- then set it when matching to a project payment. (project_payments.id is uuid.)
  update public.project_payments set bank_txn_id = null where bank_txn_id = p_txn_id;
  if p_matched_to_type = 'project' and p_matched_to_id is not null then
    update public.project_payments set bank_txn_id = p_txn_id where id = p_matched_to_id::uuid;
  end if;

  -- Reverse link on expenses: same clear-then-set. (expenses.id is text.)
  update public.expenses set reconciled_txn_id = null where reconciled_txn_id = p_txn_id;
  if p_matched_to_type = 'expense' and p_matched_to_id is not null then
    update public.expenses set reconciled_txn_id = p_txn_id where id = p_matched_to_id;
  end if;

  -- Un-reconcile also reverses a line booked as capital / director's loan
  -- (balance sheet) or a statutory (TDS/PF/ESI) challan, so nothing drifts.
  if p_matched_to_type is null then
    delete from public.balance_sheet_items       where bank_txn_id = p_txn_id;
    delete from public.statutory_dues_payments    where bank_txn_id = p_txn_id;
  end if;

  return v_row;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.record_account_transfer(p_from_account uuid, p_to_account uuid, p_amount integer, p_txn_date date, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_from_name text;
  v_to_name   text;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can record a transfer between accounts' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Transfer amount must be positive';
  end if;
  if p_from_account = p_to_account then
    raise exception 'Cannot transfer to the same account';
  end if;

  select name into v_from_name from public.bank_accounts
    where id = p_from_account and tenant_id = v_tenant;
  if not found then raise exception 'Source account not found'; end if;

  select name into v_to_name from public.bank_accounts
    where id = p_to_account and tenant_id = v_tenant;
  if not found then raise exception 'Destination account not found'; end if;

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
  values
    (v_tenant, p_from_account, p_txn_date,
     coalesce(nullif(p_note, ''), 'Transfer to ' || v_to_name),
     p_amount, 0, 'manual', 'transfer', 'manual');

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
  values
    (v_tenant, p_to_account, p_txn_date,
     coalesce(nullif(p_note, ''), 'Transfer from ' || v_from_name),
     0, p_amount, 'manual', 'transfer', 'manual');
end;
$function$
;

CREATE OR REPLACE FUNCTION public.record_payment(p_quote_id text, p_amount integer, p_method text, p_reference text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_quote                 record;
  v_tenant_id             uuid;
  v_caller_tenant         uuid;
  v_is_service_role       boolean;
  v_has_existing_invoice  boolean;
  v_receipt_voucher_no    text := null;
  v_payment_id            uuid;
  v_prior_received        integer;
  v_total_received        integer;
  v_expected              integer;
  v_outstanding           integer;
  v_overpaid_credit       integer := 0;
  v_is_first_payment      boolean;
  v_is_fully_paid         boolean;
  v_new_payment_status    public.payment_status;
  v_customer_id           uuid;
  v_converted_now         boolean := false;
  v_lead                  record;
  v_domain                text;
  v_subscription_created  boolean := false;
  v_new_sub_id            uuid;
  v_first_line            jsonb;
  v_commitment            text;
  v_is_annual             boolean;
  v_is_monthly            boolean;
  v_plan_name             text;
  v_plan_lower            text;
  v_vendor                public.vendor;
  v_seats                 integer;
  v_is_renewal_quote      boolean := false;
  v_renewal_sub           record;
  v_renewal_rolled_forward boolean := false;
  v_extension_months      integer;
  v_new_mrr               integer;
  v_invoice               record;
  v_already_adjusted      integer;
  v_post_invoice_received integer;
  v_net_due               integer;
  v_invoice_paid          boolean := false;
  v_po_id                 text := null;
  v_po_created            boolean := false;
  v_unit_wholesale_pm     integer;
  v_total_wholesale       integer;
  v_po_seats              integer;
  v_po_months             integer;
  v_po_plan               text;
  v_po_vendor             public.vendor;
  v_po_sub_id             uuid;
  v_was_trial             boolean := false;
  v_existing_payment      record;
  v_is_add_seats          boolean := false;
  v_has_bulk              boolean := false;
  v_bulk_total_seats      integer;
  v_bulk_pool             integer;
  v_running_mrr           integer;
  v_dom_mrr               integer;
  v_dom_seats             integer;
  v_dom                   text;
  v_idx                   integer;
  v_n                     integer;
  v_d                     jsonb;
  v_bulk_count            integer := 0;
  v_start                 date;
  -- 0172: multi-line-item support
  v_line_idx              integer;
  v_line_amount           integer;
  -- R-329: what the line's subscription renews at (qty x renewal_rate), else v_line_amount.
  v_renew_amount          integer;
  v_first_sub_in_quote    boolean := true;
  -- Only domain/Workspace-type products are meaningfully tied to a single
  -- domain; a quote mixing e.g. a support plan + a hosting plan has no
  -- per-line domain of its own, so both would otherwise fall back to the
  -- SAME customer domain and collide against
  -- subscriptions_tenant_quote_domain_unique (tenant_id, quote_id,
  -- lower(domain)). Track domains already used THIS call and null out any
  -- repeat instead of erroring or silently dropping the subscription.
  v_used_domains          text[] := array[]::text[];
  v_sub_domain            text;
  -- R-829: a line's OWN typed domain is kept even when another line of the quote has it
  -- (Starter + Business Standard on one domain). Only the same domain AND the same plan
  -- clash; such a line is listed in domain_conflicts in the result, never dropped silently.
  v_own_domain            boolean;
  v_used_domain_plans     text[] := array[]::text[];
  v_domain_conflicts      jsonb := '[]'::jsonb;
  -- R-346: the quote already has its subscriptions (activated on credit, or recreated).
  v_quote_subs_exist      boolean := false;
  -- R-378: the line's cost as ₹/seat/month → subscriptions.vendor_cost_per_seat_month.
  v_cost_pm               integer;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can record a payment' using errcode = '42501';
  end if;
  v_is_service_role := auth.role() = 'service_role';
  if not v_is_service_role then
    v_caller_tenant := public.current_tenant_id();
    if v_caller_tenant is null then
      raise exception 'No tenant context';
    end if;
  end if;

  if p_amount is null or p_amount <= 0 then raise exception 'amount must be > 0'; end if;
  if p_method is null or p_method not in ('upi','razorpay','bank_transfer','cheque','cash','other')
    then raise exception 'invalid payment method: %', p_method; end if;
  if p_reference is null or length(trim(p_reference)) = 0 then raise exception 'reference required'; end if;

  select q.id, q.tenant_id, q.customer_id, q.customer_name, q.lead_id,
         q.amount, q.line_items, q.invoice_id, q.payment_status,
         q.domain, q.extension_months, q.is_add_seats, q.subtotal, q.is_one_off, q.is_extension,
         q.prospect_state_code, q.prospect_state, q.prospect_country
    into v_quote
    from public.quotes q
   where q.id = p_quote_id for update;
  if not found then raise exception 'quote % not found', p_quote_id; end if;
  if not v_is_service_role and v_quote.tenant_id <> v_caller_tenant then
    raise exception 'quote % does not belong to your tenant', p_quote_id;
  end if;

  select p.id, p.receipt_voucher_no, p.customer_id
    into v_existing_payment
    from public.payments p
   where p.tenant_id = v_quote.tenant_id
     and p.quote_id  = p_quote_id
     and p.reference = p_reference
     and p.status    = 'received'
   limit 1;
  if found then
    select coalesce(sum(amount), 0) into v_total_received
      from public.payments where quote_id = p_quote_id and status = 'received';
    v_expected    := coalesce(v_quote.amount, 0);
    v_outstanding := greatest(0, v_expected - v_total_received);
    return jsonb_build_object(
      'payment_id', v_existing_payment.id,
      'receipt_voucher_no', v_existing_payment.receipt_voucher_no,
      'customer_id', v_existing_payment.customer_id,
      'total_received', v_total_received,
      'expected', v_expected,
      'outstanding', v_outstanding,
      'is_first_payment', false,
      'is_fully_paid', v_total_received >= v_expected,
      'idempotent_replay', true,
      'already_recorded', true
    );
  end if;

  v_tenant_id            := v_quote.tenant_id;
  v_has_existing_invoice := v_quote.invoice_id is not null;
  v_expected             := coalesce(v_quote.amount, 0);
  v_domain               := v_quote.domain;
  /* Default to the TERM of the subscription being renewed, not a hard 12. A monthly
     subscription renewed with a plain renewal quote was being pushed a YEAR forward, so
     it would never be chased again and its MRR would keep counting for twelve months of
     service nobody had sold. Falls back to 12 when there is no subscription in hand
     (a new sale), which is where the old constant was right. */
  /* Left deliberately NULL when the quote does not say. The term of the subscription
     being renewed is not known yet — v_renewal_sub is selected below — and reading an
     unassigned RECORD raises 55000 for every payment, renewal or not. Resolved right
     after that select. */
  v_extension_months     := v_quote.extension_months;
  v_is_add_seats         := coalesce(v_quote.is_add_seats, false);
  v_has_bulk := exists (
    select 1
      from jsonb_array_elements(case when jsonb_typeof(v_quote.line_items) = 'array' then v_quote.line_items else '[]'::jsonb end) li
     where coalesce((li->>'bulk')::boolean, false)
  );

  select s.id, s.renewal_date, s.seats, s.mrr, s.plan, s.renewal_state, s.vendor, s.customer_id, s.customer_name, s.domain as sub_domain, s.term_months, s.start_date
    into v_renewal_sub
    from public.subscriptions s
   where s.tenant_id = v_tenant_id
     and s.renewal_quote_id = p_quote_id
   for update limit 1;
  v_is_renewal_quote := found;

  /* Now the term IS known. Default to the term of the subscription being renewed rather
     than a hard 12: renewing a MONTHLY subscription used to push its renewal date twelve
     months out, so it was never chased again and its MRR counted for a year of service
     nobody had sold. Falls back to 12 for a new sale, where no subscription exists and the
     old constant was right. */
  if v_extension_months is null then
    v_extension_months := coalesce(case when v_is_renewal_quote then v_renewal_sub.term_months end, 12);
  end if;

  select coalesce(sum(amount), 0) into v_prior_received
    from public.payments where quote_id = p_quote_id and status = 'received';
  v_is_first_payment := (v_prior_received = 0);

  /* #27 (migrations 0060/0061), lost from this function and re-added 22 Aug 2026.
     A quote with no amount has nothing to pay. Without this, paying ₹5,000 against a
     ₹0 quote recorded the payment, marked the quote received, and created an mrr=0
     subscription — a live customer with a subscription worth nothing, which then
     enters the renewal cadence and is invoiced for ₹0.

     Placed AFTER the idempotency replay above, deliberately: a quote that WAS priced,
     was paid, and was later edited to 0 must still replay idempotently rather than
     start throwing at a webhook that already succeeded. Only a NEW payment is refused. */
  if coalesce(v_quote.amount, 0) <= 0 then
    raise exception 'Quote % has no amount, so a payment cannot be recorded against it. Set the quote total first, then record the payment.', p_quote_id;
  end if;

  v_customer_id := v_quote.customer_id;
  if v_is_first_payment and v_quote.lead_id is not null and v_quote.customer_id is null then
    select l.contact_name, l.contact_email, l.contact_phone, l.company, l.notes, l.domain, l.stage,
           l.state_code, l.state, l.gstin
      into v_lead from public.leads l
     where l.id = v_quote.lead_id and l.tenant_id = v_tenant_id;
    if not found then raise exception 'lead % not found', v_quote.lead_id; end if;
    if v_domain is null then v_domain := v_lead.domain; end if;
    v_was_trial := (v_lead.stage = 'trial');

    /* Dedup (migrations 0064/0065), lost from this function and re-added 22 Aug 2026.
       The lead is a fresh row but the company may already be a customer — the same
       business enquiring a second time, or a renewal that came in as a new lead. This
       used to insert unconditionally, so that company got a SECOND customer row, and
       then a second subscription and a second invoice series against the same buyer.

       Matched on contact_email, case-insensitively and tenant-scoped. Email only:
       company NAME is not an identity ("Excel Tech" vs "Excel Technologies Pvt Ltd")
       and matching on it would merge two genuinely different customers, which is the
       worse error of the two — a wrongly-merged customer is far harder to unpick than
       a duplicate. No email on the lead means no match, and a new customer is created. */
    /* R-137 (3 Oct 2026): email alone merged different businesses that shared one
       inbox — every test quote on the owner's own address landed on one customer
       ("Sri Ganga Technologies": 64 quotes, Rs 3.9L of payments). Now: same GSTIN, or
       same email AND a matching name (match_existing_customer). The rule above still
       holds — when unsure, a duplicate is the lesser error. */
    v_customer_id := public.match_existing_customer(v_tenant_id, v_lead.contact_email, v_lead.gstin, v_lead.company);

    if v_customer_id is null then
      insert into public.customers (tenant_id, name, contact_name, contact_email, contact_phone, domain, since, health, notes, state_code, state, gstin)
      values (v_tenant_id, v_lead.company, v_lead.contact_name, v_lead.contact_email, v_lead.contact_phone, v_domain, current_date,
              case when p_amount >= v_expected then 85 else 75 end, v_lead.notes, v_lead.state_code, v_lead.state, v_lead.gstin)
      returning id into v_customer_id;
    else
      /* Reused. The quote must point at the customer that actually exists, or the
         invoice and the subscription below hang off a different row than the payment. */
      update public.quotes set customer_id = v_customer_id
       where id = p_quote_id and tenant_id = v_tenant_id;

      /* R-373 (7 Oct 2026): the reused customer may have no state (149/160 locally),
         and generate_invoice refuses an invoice without one. The lead in hand carries
         the state the buyer gave (or a GSTIN whose first two digits are the code), so
         fill a BLANK customer state from it — never overwrite one already set. Same
         rule as fillBlankCustomerState on the online path. */
      update public.customers c
         set state_code = case
                            when btrim(coalesce(v_lead.state_code, '')) ~ '^[0-9]{2}$' then btrim(v_lead.state_code)
                            else substring(btrim(v_lead.gstin) from 1 for 2)
                          end,
             state      = case
                            when nullif(btrim(coalesce(c.state, '')), '') is null then v_lead.state
                            else c.state
                          end
       where c.id = v_customer_id
         and c.tenant_id = v_tenant_id
         and nullif(btrim(coalesce(c.state_code, '')), '') is null
         and (btrim(coalesce(v_lead.state_code, '')) ~ '^[0-9]{2}$'
              or btrim(coalesce(v_lead.gstin, '')) ~ '^[0-9]{2}');
    end if;

    update public.leads
       set stage              = 'won',
           trial_converted_at = case when v_was_trial then now() else trial_converted_at end
     where id = v_quote.lead_id and tenant_id = v_tenant_id;
    v_converted_now := true;
  elsif v_is_first_payment and v_quote.customer_id is null and v_quote.lead_id is null then
    insert into public.customers (tenant_id, name, domain, since, health, state_code, state, country)
    values (v_tenant_id, coalesce(nullif(trim(v_quote.customer_name), ''), 'Customer'),
            v_domain, current_date, case when p_amount >= v_expected then 85 else 75 end,
            v_quote.prospect_state_code, v_quote.prospect_state,
            coalesce(nullif(trim(v_quote.prospect_country), ''), 'India'))
    returning id into v_customer_id;
    v_converted_now := true;
  elsif v_quote.lead_id is not null then
    select l.stage into v_lead from public.leads l where l.id = v_quote.lead_id and l.tenant_id = v_tenant_id;
    if v_is_first_payment then
      update public.leads
         set trial_converted_at = case when stage = 'won' and trial_started_at is not null and trial_converted_at is null then now() else trial_converted_at end
       where id = v_quote.lead_id and tenant_id = v_tenant_id;
    end if;
  end if;

  if not v_has_existing_invoice then
    v_receipt_voucher_no := public.next_document_number('receipt_voucher', v_tenant_id, public.ist_today());
  end if;

  begin
    insert into public.payments (tenant_id, quote_id, customer_id, amount, method, reference, notes,
      status, received_at, receipt_voucher_no, recorded_by)
    values (v_tenant_id, p_quote_id, v_customer_id, p_amount, p_method, p_reference,
            nullif(trim(coalesce(p_notes, '')), ''), 'received', now(), v_receipt_voucher_no, auth.uid())
    returning id into v_payment_id;
  exception when unique_violation then
    select p.id, p.receipt_voucher_no, p.customer_id into v_existing_payment
      from public.payments p
     where p.tenant_id = v_tenant_id and p.quote_id = p_quote_id
       and p.reference = p_reference and p.status = 'received' limit 1;
    select coalesce(sum(amount), 0) into v_total_received
      from public.payments where quote_id = p_quote_id and status = 'received';
    v_outstanding := greatest(0, v_expected - v_total_received);
    return jsonb_build_object(
      'payment_id', v_existing_payment.id,
      'receipt_voucher_no', v_existing_payment.receipt_voucher_no,
      'customer_id', v_existing_payment.customer_id,
      'total_received', v_total_received,
      'expected', v_expected,
      'outstanding', v_outstanding,
      'is_first_payment', false,
      'is_fully_paid', v_total_received >= v_expected,
      'idempotent_replay', true,
      'already_recorded', true
    );
  end;

  v_total_received := v_prior_received + p_amount;
  v_outstanding    := greatest(0, v_expected - v_total_received);
  v_is_fully_paid  := v_total_received >= v_expected;
  v_new_payment_status := case
    when v_has_existing_invoice then 'invoiced'
    when v_is_fully_paid        then 'received'
    else                             'partial' end::public.payment_status;

  /* 0157: a ONE-OFF sale creates no subscription. Lost from this function and re-added
     22 Aug 2026 — and this is the costliest of the three, because it does not just
     record something wrong, it goes on to CHARGE for it. A direct invoice (is_one_off)
     is a single sale; the guard's absence gave it a recurring subscription, which the
     renewal cron then bills again on its next cycle. The customer is invoiced for a
     subscription nobody sold them. */
  /* R-346: a quote activated on credit already has its subscriptions (and draft POs). The
     first payment used to file them all AGAIN — two active subscriptions per line, both
     renewing. Existing rows for this quote_id mean "already filed": the payment goes down the
     elsif below, which only brings the outstanding down. */
  v_quote_subs_exist := exists (
    select 1 from public.subscriptions s
     where s.tenant_id = v_tenant_id and s.quote_id = p_quote_id
  );

  if v_is_first_payment and not v_is_renewal_quote and not v_is_add_seats
     and not coalesce(v_quote.is_one_off, false)
     and not v_quote_subs_exist then  -- R-346
    if jsonb_typeof(v_quote.line_items) = 'array' and jsonb_array_length(v_quote.line_items) > 0 then
      for v_line_idx in 0 .. jsonb_array_length(v_quote.line_items) - 1 loop
        v_first_line := v_quote.line_items -> v_line_idx;
        v_commitment := v_first_line->>'commitment';
        v_plan_name  := coalesce(v_first_line->>'name',
                          case when v_commitment = 'monthly' then 'Monthly subscription'
                               else 'Annual subscription' end);
        v_is_annual  := v_commitment is distinct from 'monthly' and v_commitment is not null;
        v_is_monthly := v_commitment = 'monthly';
        v_po_sub_id  := null;

        if (v_is_annual or v_is_monthly) and v_customer_id is not null then
          -- 0172: exact vendor via the catalog item itself; name-guess only
          -- for lines with no item_id (hand-typed, no catalog link).
          v_vendor := null;
          if v_first_line->>'item_id' is not null then
            select i.vendor into v_vendor from public.items i
             where i.id = v_first_line->>'item_id' and i.tenant_id = v_tenant_id;
          end if;
          if v_vendor is null then
            v_plan_lower := lower(v_plan_name);
            v_vendor := case
              when v_plan_lower like '%google%'    then 'google'::public.vendor
              when v_plan_lower like '%m365%'      then 'microsoft'::public.vendor
              when v_plan_lower like '%microsoft%' then 'microsoft'::public.vendor
              when v_plan_lower like '%365%'       then 'microsoft'::public.vendor
              when v_plan_lower like '%zoho%'      then 'zoho'::public.vendor
              else 'other'::public.vendor end;
          end if;

          v_start := coalesce(nullif(v_first_line->>'start_date', '')::date, current_date);
          v_line_amount := round(
            coalesce((v_first_line->>'qty')::numeric, 0) * coalesce((v_first_line->>'rate')::numeric, 0)
              * (1 - coalesce((v_first_line->>'discount_pct')::numeric, 0) / 100)
          )::int;
          /* R-329: a cart coupon discounts the first payment only. The line then says what it
             renews at; the subscription's mrr (and so every renewal) is filed from that. */
          v_renew_amount := case
            when nullif(v_first_line->>'renewal_rate', '') is not null
              then round(coalesce((v_first_line->>'qty')::numeric, 0) * (v_first_line->>'renewal_rate')::numeric)::int
            else v_line_amount end;

          /* R-378: the line's cost per seat, as ₹/seat/MONTH (monthly line = as is, annual = /12). */
          v_cost_pm := case
            when jsonb_typeof(v_first_line->'cost') = 'number' and (v_first_line->>'cost')::numeric > 0
              then round((v_first_line->>'cost')::numeric / case when v_is_monthly then 1.0 else 12.0 end)::int
            else null end;

          if coalesce((v_first_line->>'bulk')::boolean, false)
             and jsonb_typeof(v_first_line->'domains') = 'array'
             and jsonb_array_length(v_first_line->'domains') > 0 then
            select coalesce(sum((e->>'seats')::int), 0) into v_bulk_total_seats
              from jsonb_array_elements(v_first_line->'domains') e;
            if v_bulk_total_seats <= 0 then
              raise exception 'bulk line has zero total seats (quote %)', p_quote_id;
            end if;
            v_bulk_pool := greatest(0, round(
                             coalesce(v_renew_amount, v_expected) / case when v_is_monthly then 1.0 else 12.0 end  -- R-329
                           ))::int;
            v_running_mrr := 0;
            v_idx := 0;
            v_n := jsonb_array_length(v_first_line->'domains');
            for v_d in select e from jsonb_array_elements(v_first_line->'domains') e loop
              v_idx := v_idx + 1;
              v_dom := lower(trim(v_d->>'domain'));
              v_dom_seats := coalesce((v_d->>'seats')::int, 0);
              if v_dom = '' then continue; end if;
              if v_idx < v_n then
                v_dom_mrr := floor(v_bulk_pool::numeric * v_dom_seats / v_bulk_total_seats)::int;
              else
                v_dom_mrr := v_bulk_pool - v_running_mrr;
              end if;
              v_running_mrr := v_running_mrr + v_dom_mrr;

              insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                start_date, renewal_date, status, outstanding_amount, domain, quote_id,
                term_months, vendor_cost_per_seat_month)  -- R-378
              values (v_tenant_id, v_customer_id, v_quote.customer_name, v_plan_name, v_vendor, v_dom_seats, v_dom_mrr,
                v_start,
                (v_start + case when v_is_monthly then interval '1 month' else interval '1 year' end)::date,
                'active', 0, v_dom, p_quote_id,
                case when v_is_monthly then 1 else 12 end,
                v_cost_pm)  -- R-378
              on conflict (tenant_id, quote_id, lower(domain), lower(plan)) where quote_id is not null and domain is not null  -- R-829
                do nothing
              returning id into v_new_sub_id;

              insert into public.customer_domains (tenant_id, customer_id, domain)
              values (v_tenant_id, v_customer_id, v_dom)
              on conflict (tenant_id, lower(domain)) do nothing;

              v_bulk_count := v_bulk_count + 1;
              v_used_domains := array_append(v_used_domains, v_dom);
              v_used_domain_plans := array_append(v_used_domain_plans, v_dom || '|' || lower(v_plan_name));  -- R-829
            end loop;
            v_subscription_created := true;
            v_first_sub_in_quote := false;
            v_po_seats := v_bulk_total_seats; v_po_months := 12; v_po_plan := v_plan_name;
            v_po_vendor := v_vendor; v_po_sub_id := v_new_sub_id;
          else
            v_seats := coalesce((v_first_line->>'qty')::int, 0);
            -- 0172: prefer THIS line's own domain (the quote builder now lets
            -- staff type a distinct domain per product line) over the
            -- whole-quote/customer fallback below, which was the only source
            -- before per-line domains existed.
            v_sub_domain := nullif(lower(trim(v_first_line->>'domain')), '');
            v_own_domain := v_sub_domain is not null;  -- R-829
            if v_sub_domain is null then
              if v_domain is null and v_customer_id is not null then
                select domain into v_domain from public.customers where id = v_customer_id;
              end if;
              v_sub_domain := lower(nullif(trim(v_domain), ''));
            end if;
            /* R-829: the line's own domain stays unless THIS plan already has it on this quote
               (the unique index is per quote + domain + plan). A borrowed quote/customer
               domain still goes on one subscription only, as before (a support line next to
               Workspace does not take the Workspace domain). */
            if v_sub_domain is not null then
              if v_own_domain then
                if (v_sub_domain || '|' || lower(v_plan_name)) = any(v_used_domain_plans) then
                  v_domain_conflicts := v_domain_conflicts || jsonb_build_object(
                    'line', v_line_idx + 1, 'plan', v_plan_name, 'domain', v_sub_domain);
                  v_sub_domain := null;
                end if;
              elsif v_sub_domain = any(v_used_domains) then
                v_sub_domain := null;
              end if;
            end if;
            insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
              start_date, renewal_date, status, outstanding_amount, domain, quote_id,
              term_months, vendor_cost_per_seat_month)  -- R-378
            values (v_tenant_id, v_customer_id, v_quote.customer_name, v_plan_name, v_vendor, v_seats,
              greatest(0, round(v_renew_amount / case when v_is_monthly then 1.0 else 12.0 end))::int, v_start,  -- R-329
              (v_start + case when v_is_monthly then interval '1 month' else interval '1 year' end)::date, 'active',
              case when v_first_sub_in_quote then v_outstanding else 0 end,
              v_sub_domain, p_quote_id,
              case when v_is_monthly then 1 else 12 end,
              v_cost_pm)  -- R-378
            returning id into v_new_sub_id;
            if v_sub_domain is not null then
              v_used_domains := array_append(v_used_domains, lower(v_sub_domain));
              v_used_domain_plans := array_append(v_used_domain_plans, lower(v_sub_domain) || '|' || lower(v_plan_name));  -- R-829
            end if;
            v_subscription_created := true;
            v_first_sub_in_quote := false;
            v_po_seats := v_seats; v_po_months := 12; v_po_plan := v_plan_name;
            v_po_vendor := v_vendor; v_po_sub_id := v_new_sub_id;
          end if;

          if v_po_sub_id is not null then
            select coalesce(nullif((prices->'annual'->>'wholesale')::int, 0), nullif(wholesale, 0))
              into v_unit_wholesale_pm from public.items
             where tenant_id = v_tenant_id and lower(name) = lower(v_po_plan) limit 1;
            if v_unit_wholesale_pm is null or v_unit_wholesale_pm <= 0 then
              v_unit_wholesale_pm := greatest(0, round(coalesce(v_line_amount, v_expected)::numeric * 0.83 / greatest(v_po_seats * v_po_months, 1)))::int;
            end if;
            v_total_wholesale := v_unit_wholesale_pm * v_po_seats * v_po_months;
            v_po_id := public.next_document_number('purchase_order', v_tenant_id);
            insert into public.purchase_orders (
              id, tenant_id, subscription_id, customer_id, customer_name, domain,
              vendor, plan, seats, term_months, unit_cost_pm, total_cost, status, notes, created_by
            ) values (
              v_po_id, v_tenant_id, v_po_sub_id, v_customer_id, v_quote.customer_name, v_domain,
              v_po_vendor, v_po_plan, v_po_seats, v_po_months, v_unit_wholesale_pm, v_total_wholesale, 'draft',
              'Auto-created from quote ' || p_quote_id ||
              case when coalesce((v_first_line->>'bulk')::boolean, false) then ' (bulk order - ' || v_bulk_count || ' domains)'
                   else ' (new sub)' end,
              auth.uid()
            );
            v_po_created := true;
          end if;
        end if;
      end loop;
    end if;
    v_po_sub_id := null;
  elsif v_customer_id is not null and not v_is_renewal_quote and not v_is_add_seats and not v_has_bulk then
    update public.subscriptions set outstanding_amount = v_outstanding
     where tenant_id = v_tenant_id and customer_id = v_customer_id and quote_id = p_quote_id and outstanding_amount > 0;
  end if;

  if v_is_renewal_quote and v_is_fully_paid then
    v_first_line := case
      when jsonb_typeof(v_quote.line_items) = 'array' and jsonb_array_length(v_quote.line_items) > 0
        then v_quote.line_items->0 else null end;
    /* R-812: the subscription keeps ITS OWN plan. The line name is quote text — an
       extension line reads "<plan> · 3-month extension" — and writing it here renamed the
       subscription on every extension payment. The line name is only a fallback for a
       subscription that has no plan at all. */
    v_plan_name := coalesce(nullif(trim(v_renewal_sub.plan), ''), v_first_line->>'name');
    if v_first_line is not null then
      v_seats     := coalesce((v_first_line->>'qty')::int, v_renewal_sub.seats);
    else
      v_seats := v_renewal_sub.seats;
    end if;
    v_new_mrr := greatest(0, round(coalesce(v_quote.subtotal, v_expected)::numeric / greatest(v_extension_months, 1)))::int;
    update public.subscriptions
       /* A full TERM, not a fixed twelve months. On a monthly subscription one month IS
          the whole term, and the old test left renewal_state stuck at whatever step the
          cadence had reached — so the ladder never re-armed and the next month went
          unchased. */
       set renewal_state = case when v_extension_months >= coalesce(v_renewal_sub.term_months, 12)
                                then 'renewed'
                                /* R-805: a part-year extension moved the date — start the
                                   reminder ladder again rather than keep a stale step. */
                                when coalesce(v_quote.is_extension, false) then 'pending'
                                else renewal_state end,
           /* R-805: an extension by MONTHS (not whole years) sets the new INCLUSIVE last day
              = (first day of the following term + N months) - 1 day, reading both stored
              shapes like followingTermStart() in subscription-schedule.ts: an ANNIVERSARY row
              (renewal_date = start_date + whole terms) is followed by renewal_date itself, an
              inclusive row by the day after it. Renewals and whole-year extensions roll
              exactly as before. */
           renewal_date  = case
             when coalesce(v_quote.is_extension, false) and v_extension_months % 12 <> 0 then
               ((case when v_renewal_sub.start_date is not null and exists (
                         select 1 from generate_series(1, 100) n
                          where (v_renewal_sub.start_date
                                 + make_interval(months => n * greatest(coalesce(v_renewal_sub.term_months, 12), 1)))::date
                                = v_renewal_sub.renewal_date)
                      then v_renewal_sub.renewal_date
                      else v_renewal_sub.renewal_date + 1 end)
                + make_interval(months => v_extension_months))::date - 1
             else (v_renewal_sub.renewal_date + (v_extension_months || ' months')::interval)::date
           end,
           seats = v_seats, plan = v_plan_name,
           mrr   = case when v_new_mrr > 0 then v_new_mrr else mrr end,
           outstanding_amount = 0, renewal_quote_id = null,
           reminder_count = 0, last_reminder_sent_at_v2 = null, status = 'active'
     where id = v_renewal_sub.id and tenant_id = v_tenant_id;
    v_renewal_rolled_forward := true;
    v_po_seats := v_seats; v_po_months := v_extension_months;
    v_po_plan := v_plan_name; v_po_vendor := v_renewal_sub.vendor; v_po_sub_id := v_renewal_sub.id;
  end if;

  if v_po_sub_id is not null then
    select coalesce(nullif((prices->'annual'->>'wholesale')::int, 0), nullif(wholesale, 0))
      into v_unit_wholesale_pm from public.items
     where tenant_id = v_tenant_id and lower(name) = lower(v_po_plan) limit 1;
    if v_unit_wholesale_pm is null or v_unit_wholesale_pm <= 0 then
      v_unit_wholesale_pm := greatest(0, round(v_expected::numeric * 0.83 / greatest(v_po_seats * v_po_months, 1)))::int;
    end if;
    v_total_wholesale := v_unit_wholesale_pm * v_po_seats * v_po_months;
    v_po_id := public.next_document_number('purchase_order', v_tenant_id);
    insert into public.purchase_orders (
      id, tenant_id, subscription_id, customer_id, customer_name, domain,
      vendor, plan, seats, term_months, unit_cost_pm, total_cost, status, notes, created_by
    ) values (
      v_po_id, v_tenant_id, v_po_sub_id, v_customer_id, v_quote.customer_name, v_domain,
      v_po_vendor, v_po_plan, v_po_seats, v_po_months, v_unit_wholesale_pm, v_total_wholesale, 'draft',
      'Auto-created from quote ' || p_quote_id ||
      case when v_is_renewal_quote then ' (renewal/extension)'
           when v_bulk_count > 0    then ' (bulk order - ' || v_bulk_count || ' domains)'
           else ' (new sub)' end,
      auth.uid()
    );
    v_po_created := true;
  end if;

  update public.quotes
     set payment_status = v_new_payment_status,
         payment_amount = v_total_received,
         payment_method = p_method,
         payment_reference = p_reference,
         payment_received_at = now(),
         payment_notes = nullif(trim(coalesce(p_notes, '')), ''),
         customer_id = v_customer_id,
         status = case
           when status in ('draft', 'sent', 'viewed') then 'accepted'::public.quote_status
           else status
         end
   where id = p_quote_id and tenant_id = v_tenant_id;

  if v_has_existing_invoice then
    select i.amount, i.net_payable, i.status, i.adjusted_advances into v_invoice
      from public.invoices i where i.id = v_quote.invoice_id and i.tenant_id = v_tenant_id;
    if found and v_invoice.status <> 'paid' then
      v_already_adjusted := coalesce((select sum((adv->>'amount')::int) from jsonb_array_elements(v_invoice.adjusted_advances) adv), 0);
      v_post_invoice_received := v_total_received - v_already_adjusted;
      v_net_due := coalesce(v_invoice.net_payable, v_invoice.amount);
      /* R-015 (Pardeep, 29 Sep 2026). This wrote NOTHING unless the invoice was settled
         in full, so `invoices.paid_amount` stayed 0 on every part-paid invoice — and
         Aging and the Balance Sheet both count the whole `net_payable`. A Rs 1,00,000
         invoice with Rs 40,000 received showed Rs 1,00,000 outstanding while the same
         Rs 40,000 was also counted as cash: wrong on both sides of the books at once.
         (Only `sync_project_invoice_paid`, on the project side, ever filled the column,
         which is why it looks populated to anybody who checks a project invoice.)

         paid_amount is written on EVERY payment now. `greatest(0, ...)` because
         v_post_invoice_received is net of advances already adjusted onto the invoice and
         can legitimately go negative; a negative paid_amount would flatter the aging
         rather than merely be wrong.

         status and paid_date still move only on full settlement. invoice_status has no
         'partial' value, and adding one reaches every screen that switches on status —
         that is a change to ask for, not to take. Aging reads net_payable - paid_amount,
         which needs no new status.

         paid_date uses ist_today(): current_date is the UTC day on this server (R-015
         part 1), so an invoice settled at 01:00 IST was stamped yesterday. It is still
         the SETTLEMENT day and not the payment's own received date — record_payment has
         no received-date parameter to read, so the dialog patches that in afterwards. */
      update public.invoices
         set paid_amount = greatest(0, v_post_invoice_received),
             status      = case when v_post_invoice_received >= v_net_due
                                then 'paid'::invoice_status else status end,
             paid_date   = case when v_post_invoice_received >= v_net_due
                                then public.ist_today() else paid_date end
       where id = v_quote.invoice_id and tenant_id = v_tenant_id;
      v_invoice_paid := v_post_invoice_received >= v_net_due;
    end if;
  end if;

  /* R-346: paid in full → the credit reminders ("Credit: send payment link", "Credit: payment
     not in — stop service?") have nothing left to chase. Only those two; the set-up task stays. */
  if v_invoice_paid then
    update public.tasks
       set status = 'cancelled'
     where tenant_id = v_tenant_id
       and quote_id  = p_quote_id
       and status in ('pending', 'snoozed')
       and title like 'Credit:%';
  end if;

  /* ─── Overpayment → customer credit, ISI transaction me (audit A5, 1 Sep 2026) ───
     Outstanding upar 0 par floor hota hai, to expected se zyada aaya paisa yahan
     record na ho to KAHIN record nahi hota. Ye insert pehle client-side tha
     (record-payment-dialog.tsx), RPC ke commit ke BAAD — network/RLS ki ek hichki
     aur customer ka extra rupaya hamesha ke liye be-hisaab. Incremental hi jodta
     hai (is payment ne jitna naya excess banaya), taki kai kishton me double na gine —
     wahi ganit jo client me tha. */
  v_overpaid_credit := greatest(0, v_total_received - v_expected)
                     - greatest(0, v_prior_received - v_expected);
  if v_overpaid_credit > 0 and v_customer_id is not null then
    insert into public.customer_credits
      (tenant_id, customer_id, amount, source, source_payment_id, source_quote_id, note, status)
    values
      (v_tenant_id, v_customer_id, v_overpaid_credit, 'overpayment', v_payment_id, p_quote_id,
       'Excess over quote ' || p_quote_id, 'open');
  end if;

  return jsonb_build_object(
    'payment_id', v_payment_id,
    'receipt_voucher_no', v_receipt_voucher_no,
    'customer_id', v_customer_id,
    'total_received', v_total_received,
    'expected', v_expected,
    'outstanding', v_outstanding,
    'is_first_payment', v_is_first_payment,
    'is_fully_paid', v_is_fully_paid,
    'converted_now', v_converted_now,
    'subscription_created', v_subscription_created,
    'bulk_domains_created', v_bulk_count,
    'invoice_paid', v_invoice_paid,
    'has_existing_invoice', v_has_existing_invoice,
    'is_renewal_quote', v_is_renewal_quote,
    'renewal_rolled_forward', v_renewal_rolled_forward,
    'extension_months', v_extension_months,
    'domain', v_domain,
    'po_id', v_po_id,
    'po_created', v_po_created,
    'was_trial', v_was_trial,
    'is_add_seats', v_is_add_seats,
    'overpaid_credit', v_overpaid_credit,
    'domain_conflicts', v_domain_conflicts,  -- R-829
    'idempotent_replay', false
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.redeem_customer_credits(p_customer_id uuid, p_amount integer, p_note text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant    uuid    := public.current_tenant_id();
  v_remaining integer := greatest(0, coalesce(p_amount, 0));
  v_consumed  integer := 0;
  v_take      integer;
  v_row       record;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can use a customer''s credit' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if v_remaining <= 0 then return 0; end if;

  for v_row in
    select id, amount from public.customer_credits
     where tenant_id = v_tenant and customer_id = p_customer_id and status = 'open'
     order by created_at asc
     for update
  loop
    exit when v_remaining <= 0;
    v_take := least(v_row.amount, v_remaining);
    if v_take >= v_row.amount then
      update public.customer_credits set status = 'used' where id = v_row.id;
    else
      update public.customer_credits set amount = amount - v_take where id = v_row.id;
      insert into public.customer_credits (tenant_id, customer_id, amount, source, note, status)
      values (v_tenant, p_customer_id, v_take, 'redeemed_split',
              coalesce(nullif(trim(p_note), ''), 'Partial advance credit applied'), 'used');
    end if;
    v_consumed  := v_consumed + v_take;
    v_remaining := v_remaining - v_take;
  end loop;

  return v_consumed;
end; $function$
;

CREATE OR REPLACE FUNCTION public.unreconcile_bank_receipt(p_txn_id uuid, p_undo_sale boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_txn     public.bank_transactions;
  v_pay     public.payments;
  v_quote   record;
  v_inv     record;
  v_invoice text;
  v_cn      jsonb;
  v_voided  text;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can un-match a bank line' using errcode = '42501';
  end if;
  /* R-718: "undo the sale" deletes the receipt — a delete, so owner / accountant only. */
  if p_undo_sale and not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only an owner or accountant user can delete a payment' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No tenant in context'; end if;
  select * into v_txn from public.bank_transactions where id = p_txn_id for update;
  if not found then raise exception 'Bank transaction not found' using errcode = 'no_data_found'; end if;
  if v_txn.tenant_id is distinct from v_tenant then
    raise exception 'Not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;

  if p_undo_sale then
    if v_txn.matched_to_type is distinct from 'payment' or v_txn.matched_to_id is null then
      raise exception 'This line is not reconciled to a customer receipt — nothing to undo.';
    end if;
    select * into v_pay from public.payments where id = v_txn.matched_to_id::uuid for update;
    if not found then raise exception 'The receipt this line points to no longer exists.'; end if;
    if v_pay.notes is distinct from 'Reconciled from bank receipt' then
      raise exception 'This receipt was recorded separately, not from this bank line — undo it from Payments instead.';
    end if;

    select id, invoice_id into v_quote from public.quotes where id = v_pay.quote_id for update;
    v_invoice := v_quote.invoice_id;
    if exists (select 1 from public.payments where quote_id = v_pay.quote_id and id <> v_pay.id) then
      raise exception 'This sale has other receipts too — undo it from the invoice, not from here.';
    end if;
    if v_invoice is not null and (
         exists (select 1 from public.credit_notes where invoice_id = v_invoice)
      or exists (select 1 from public.debit_notes where invoice_id = v_invoice)
      or exists (select 1 from public.tds_receivable where invoice_id = v_invoice)
    ) then
      raise exception 'Invoice % has a credit/debit note or TDS entry — handle it from the invoice.', v_invoice;
    end if;
  end if;

  -- Free the line through the one reconcile path, so every other reversal still runs.
  perform public.reconcile_bank_txn(p_txn_id, null, null, 'manual');

  if p_undo_sale then
    if v_invoice is not null then
      select id, status, amount into v_inv from public.invoices where id = v_invoice and tenant_id = v_tenant for update;
      if found then
        if v_inv.status = 'draft' then
          update public.invoices set status = 'void'::invoice_status, paid_date = null
           where id = v_invoice and tenant_id = v_tenant;
          v_voided := v_invoice;
        else
          -- Issued: reverse with a full credit note; the invoice stays, nothing due.
          v_cn := public.issue_credit_note(v_invoice, v_inv.amount, 'cancellation',
                    'Sale reversed — bank receipt un-reconciled',
                    'unreconcile_bank_receipt ' || p_txn_id::text);
          update public.invoices
             set status = 'pending'::invoice_status, paid_date = null, paid_amount = 0, net_payable = 0, updated_at = now()
           where id = v_invoice and tenant_id = v_tenant;
        end if;
      end if;
    end if;
    delete from public.payments where id = v_pay.id;
    update public.quotes
       set status = 'rejected'::quote_status,
           payment_status = 'none'::payment_status,
           payment_amount = 0,
           payment_method = null, payment_reference = null,
           payment_received_at = null, payment_notes = null
     where id = v_pay.quote_id and tenant_id = v_tenant;
  end if;

  return jsonb_build_object(
    'unreconciled', true,
    'invoice_voided', v_voided,
    'invoice_credited', case when v_cn is not null then v_invoice end,
    'credit_note_id', v_cn->>'credit_note_id',
    'receipt_removed', case when p_undo_sale then v_pay.id end
  );
end;
$function$
;

commit;
