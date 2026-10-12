-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.record_desk_payment(text,integer,text,text,text,uuid,integer,date,uuid,integer,integer,integer,text,numeric,text,text,text)') and prosrc like '%R-895%') and exists(select 1 from pg_policy where polname = 'payments_update_money_roles' and polrelid = to_regclass('public.payments')) and exists(select 1 from pg_policy where polname = 'invoices_update_money_roles' and polrelid = to_regclass('public.invoices')) and exists(select 1 from pg_policy where polname = 'vendor_bills_insert_money_roles' and polrelid = to_regclass('public.vendor_bills'))
-- deploy-key: r895moneypolicies
-- 20261012031823_r895_money_policies.sql
--
-- R-895 (P1 launch blocker, found by the R-719 worker 11 Oct 2026): align the R-719 table
-- policies with Pardeep's R-718 money table, and stop a failed payment from eating a
-- customer's advance credit.
--
-- ══ WHAT WAS WRONG ═══════════════════════════════════════════════════════════════
--
--   (a) Credit could be lost. The record-payment sheet called redeem_customer_credits
--       FIRST (its own transaction, committed), then record_payment. When record_payment
--       failed — or the reference was already recorded (R-374) — the page tried to put the
--       credit back with a direct customer_credits insert. Since R-719 only money roles may
--       insert there, and a network drop between the two calls skips the put-back entirely,
--       the customer's credit was simply gone until someone restored it by hand.
--   (b) R-719 kept today's app writes, so sales / sales_senior could still update
--       payments.received_at + bank_account_id on ANY payment, move invoices.paid_date, and
--       insert vendor bills (AI Entry). Pardeep's R-718 table: sales, sales_senior, support,
--       delivery — no money actions.
--
-- ══ WHAT CHANGES ═════════════════════════════════════════════════════════════════
--
--   (1) NEW record_desk_payment(...) — the record-payment sheet's ONE call. In one
--       transaction it: redeems the advance credit, records the payment (record_payment, or
--       record_payment_with_tds when TDS was deducted) for amount + credit actually
--       consumed, tags the receipt date + bank account on the new payment, moves the
--       settled invoice's paid_date to the receipt date, and dates the TDS receivable on
--       the receipt date. Any error rolls ALL of it back, credit included. A replay (the
--       reference was already recorded) rolls the redemption back too and returns the
--       earlier payment untouched. The page's put-back insert is gone.
--       Also closes R-1118 (date + bank account were a second client write that could fail
--       after the money was saved).
--       Role gate as R-718 (owner, manager, accountant, billing; service_role / a direct DB
--       session trusted). record_payment / record_payment_with_tds / redeem_customer_credits
--       are NOT changed — their own R-718 gates still apply to the inner calls.
--   (2) Table policies, per Pardeep's R-718 table:
--         payments     update   O M A B          (was + sales, sales_senior for date/bank)
--         invoices     update   O M A B          (was + sales, sales_senior for paid_date)
--         vendor_bills insert   O M A B          (was + sales, sales_senior via AI Entry)
--       payments insert was already O M A B (R-719). The R-719 column-guard triggers on
--       payments / invoices only narrowed the sales columns; with sales gone from the
--       policy they can never fire, so they are dropped. (customers keeps its guard.)
--
-- Staging: the deploy script rewrites auth.role() -> public.current_request_role() (R-161).
-- Test: supabase/tests/r895_money_policies.test.sql (rolled back).

begin;

create or replace function public.record_desk_payment(
  p_quote_id           text,
  p_amount             integer,
  p_method             text,
  p_reference          text,
  p_notes              text    default null,
  p_credit_customer_id uuid    default null,
  p_credit_amount      integer default 0,
  p_received_on        date    default null,
  p_bank_account_id    uuid    default null,
  p_tds_amount         integer default 0,
  p_tds_gross          integer default 0,
  p_tds_net_paid       integer default 0,
  p_tds_section        text    default null,
  p_tds_rate_pct       numeric default null,
  p_customer_tan       text    default null,
  p_invoice_id         text    default null,
  p_fiscal_year        text    default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-895: one transaction for the record-payment sheet — credit + payment + date/bank tag. */
declare
  v_tenant   uuid := public.current_tenant_id();
  v_credit   integer := 0;
  v_notes    text;
  v_result   jsonb;
  v_replay   boolean := false;
  v_pay_id   uuid;
  v_inv_id   text;
  v_tagged   boolean := false;
begin
  /* R-718 role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can record a payment' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  if coalesce(p_credit_amount, 0) < 0 then raise exception 'Credit to apply cannot be negative'; end if;

  if p_bank_account_id is not null
     and not exists (select 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant) then
    raise exception 'That bank account is not in your company' using errcode = '42501';
  end if;

  /* Inner block = a savepoint. A replay raises R0895 after the work; the handler undoes
     the redemption (and anything record_payment touched) while v_result survives. */
  begin
    if coalesce(p_credit_amount, 0) > 0 and p_credit_customer_id is not null then
      v_credit := coalesce(public.redeem_customer_credits(
                    p_credit_customer_id, p_credit_amount, 'Applied to quote ' || p_quote_id), 0);
    end if;

    v_notes := nullif(concat_ws(' · ',
                 nullif(trim(coalesce(p_notes, '')), ''),
                 case when v_credit > 0 then 'Advance credit applied ₹' || v_credit end), '');

    if coalesce(p_tds_amount, 0) > 0 then
      v_result := public.record_payment_with_tds(
        p_quote_id, coalesce(p_amount, 0) + v_credit, p_method, p_reference, v_notes,
        p_tds_amount, p_tds_gross, p_tds_net_paid, p_tds_section, p_tds_rate_pct,
        p_customer_tan, p_invoice_id, p_fiscal_year);
    else
      v_result := public.record_payment(
        p_quote_id, coalesce(p_amount, 0) + v_credit, p_method, p_reference, v_notes);
    end if;

    v_replay := coalesce((v_result->>'already_recorded')::boolean, false)
             or coalesce((v_result->>'idempotent_replay')::boolean, false);
    if v_replay then
      raise exception 'R-895 replay' using errcode = 'R0895';
    end if;
  exception when sqlstate 'R0895' then
    v_credit := 0;
  end;

  if v_replay then
    return v_result || jsonb_build_object('credit_applied', 0, 'tagged', false);
  end if;

  v_pay_id := nullif(v_result->>'payment_id', '')::uuid;

  /* R-1118: the receipt date + bank account, in the same transaction. received_at keeps the
     sheet's old value (the date at 00:00 UTC) so reports read it exactly as before. */
  if v_pay_id is not null and (p_received_on is not null or p_bank_account_id is not null) then
    update public.payments
       set received_at     = coalesce((p_received_on::timestamp at time zone 'UTC'), received_at),
           bank_account_id = coalesce(p_bank_account_id, bank_account_id)
     where id = v_pay_id and tenant_id = v_tenant;
    v_tagged := found;
  end if;

  if p_received_on is not null then
    /* R-015: the invoice this payment settled is paid on the receipt date, not today. */
    if coalesce((v_result->>'invoice_paid')::boolean, false) then
      select invoice_id into v_inv_id from public.quotes where id = p_quote_id and tenant_id = v_tenant;
      if v_inv_id is not null then
        update public.invoices set paid_date = p_received_on
         where id = v_inv_id and tenant_id = v_tenant;
      end if;
    end if;
    /* R-025: the TDS receivable carries the date the money came in. */
    if coalesce((v_result->>'tds_saved')::boolean, false) and v_pay_id is not null then
      update public.tds_receivable set payment_received_date = p_received_on
       where payment_id = v_pay_id and tenant_id = v_tenant;
    end if;
  end if;

  return v_result || jsonb_build_object('credit_applied', v_credit, 'tagged', v_tagged);
end;
$function$;

comment on function public.record_desk_payment(text, integer, text, text, text, uuid, integer, date, uuid, integer, integer, integer, text, numeric, text, text, text) is
  'R-895: record-payment sheet in ONE transaction — redeem advance credit, record_payment(_with_tds) for amount + credit, tag received date + bank account, move paid_date. Owner/manager/accountant/billing.';

revoke all on function public.record_desk_payment(text, integer, text, text, text, uuid, integer, date, uuid, integer, integer, integer, text, numeric, text, text, text) from public, anon;
grant execute on function public.record_desk_payment(text, integer, text, text, text, uuid, integer, date, uuid, integer, integer, integer, text, numeric, text, text, text) to authenticated, service_role;

-- ── payments: update = money roles only ────────────────────────────────────────────
drop policy if exists payments_update_staff on public.payments;
drop policy if exists payments_update_money_roles on public.payments;
create policy payments_update_money_roles on public.payments for update to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing'))
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing'));
drop trigger if exists a00_r719_payments_column_guard on public.payments;

-- ── invoices: update = money roles only ────────────────────────────────────────────
drop policy if exists invoices_update_staff on public.invoices;
drop policy if exists invoices_update_money_roles on public.invoices;
create policy invoices_update_money_roles on public.invoices for update to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing'))
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing'));
drop trigger if exists a00_r719_invoices_column_guard on public.invoices;

-- ── vendor_bills: insert = money roles only (AI Entry no longer offers it to sales) ─
drop policy if exists vendor_bills_insert_roles on public.vendor_bills;
drop policy if exists vendor_bills_insert_money_roles on public.vendor_bills;
create policy vendor_bills_insert_money_roles on public.vendor_bills for insert to authenticated
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant', 'billing'));

commit;
