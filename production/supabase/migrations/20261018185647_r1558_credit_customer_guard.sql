-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.record_desk_payment(text,integer,text,text,text,uuid,integer,date,uuid,integer,integer,integer,text,numeric,text,text,text)') and prosrc like '%R-1558%')
-- deploy-key: r1558creditcustomer
--
-- R-1558 (P2 money, security audit 18 Oct 2026): a payment could use ANOTHER customer's advance
-- credit.
--
-- ══ WHAT WAS WRONG ═══════════════════════════════════════════════════════════════
--   record_desk_payment (newest body: 20261018164416_r1567_refund_delete_payment_credit.sql)
--   called redeem_customer_credits(p_credit_customer_id, …) — tenant-safe, but never checked
--   that p_credit_customer_id is the customer of p_quote_id. A billing user could settle
--   customer B's quote with customer A's advance: A's credit gone, B's quote paid by money B
--   never paid — both customers' ledgers wrong (same company).
--   record_instalment_payment (20261018033137_r1564) passes its p_credit_customer_id straight
--   to record_desk_payment, so instalment invoices had the same gap.
--   record_multi_invoice_payment always passes null / 0 credit — no gap there.
--
-- ══ FIX ══════════════════════════════════════════════════════════════════════════
--   record_desk_payment, before redeeming any credit: the credit's customer must be the
--   quote's customer_id, and — when p_invoice_id is given (instalment / multi-invoice / TDS) —
--   the invoice's customer_id too. A quote with no customer cannot take advance credit.
--   Otherwise raise 42501 with what / why / next step (§24). Nothing else changes (R-1567 body).
--   record_instalment_payment is covered through this one function (its quote is the
--   subscription's quote, its invoice is p_invoice_id).
--
-- Test: supabase/tests/r1558_credit_customer_guard.test.sql (mismatch refused for desk +
-- instalment, matching credit works). Mutation: the R-1567 body + that test → RED.

begin;

-- ── record_desk_payment (R-1567 body + R-1558 credit-customer check) ────────────────
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
/* R-895: one transaction for the record-payment sheet — credit + payment + date/bank tag.
   R-1565: the credit part is written to payments.credit_applied — it is not money received.
   R-1567: the credit rows consumed here get applied_payment_id = this payment, so a refund or
   delete of it can give exactly that credit back.
   R-1558: the credit must belong to the quote's customer (and the invoice's, when given). */
declare
  v_tenant   uuid := public.current_tenant_id();
  v_credit   integer := 0;
  v_notes    text;
  v_result   jsonb;
  v_replay   boolean := false;
  v_pay_id   uuid;
  v_inv_id   text;
  v_tagged   boolean := false;
  v_linked   integer := 0;
  v_q_cust   uuid;
  v_i_cust   uuid;
  v_cr_name  text;
  v_q_name   text;
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

  /* R-1558: advance credit is the money ONE customer paid ahead — it may only settle that
     customer's own quote (and invoice). Checked before anything is redeemed; fail closed. */
  if coalesce(p_credit_amount, 0) > 0 and p_credit_customer_id is not null then
    select q.customer_id, q.customer_name into v_q_cust, v_q_name
      from public.quotes q where q.id = p_quote_id and q.tenant_id = v_tenant;
    select c.name into v_cr_name
      from public.customers c where c.id = p_credit_customer_id and c.tenant_id = v_tenant;
    if v_q_cust is null or v_q_cust <> p_credit_customer_id then
      raise exception 'This advance credit belongs to %, but quote % is for %. A customer''s advance can only pay that same customer''s quotes. Untick "Apply advance credit" and record the payment again — or open % and use the credit on their own quote.',
        coalesce(v_cr_name, 'another customer'), p_quote_id, coalesce(v_q_name, 'no saved customer'),
        coalesce(v_cr_name, 'that customer')
        using errcode = '42501';
    end if;
    if p_invoice_id is not null then
      select i.customer_id into v_i_cust
        from public.invoices i where i.id = p_invoice_id and i.tenant_id = v_tenant;
      /* An older invoice saved without customer_id is still bound by the quote check above. */
      if v_i_cust is not null and v_i_cust <> p_credit_customer_id then
        raise exception 'This advance credit belongs to %, but invoice % is not that customer''s invoice. Untick "Apply advance credit" and record the payment again — or use the credit on an invoice of %.',
          coalesce(v_cr_name, 'another customer'), p_invoice_id, coalesce(v_cr_name, 'that customer')
          using errcode = '42501';
      end if;
    end if;
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

  /* R-1565: amount stays what the payment settles (cash + credit); credit_applied says how
     much of it was the customer's advance credit — money already received on the payment that
     created that credit. Collected, GSTR-1 11A, receipt voucher, day book, Tally and bank
     matching read amount − credit_applied. */
  if v_pay_id is not null and v_credit > 0 then
    update public.payments set credit_applied = v_credit
     where id = v_pay_id and tenant_id = v_tenant;
    if not found then
      raise exception 'R-1565: the new payment % was not found to mark its advance credit', v_pay_id;
    end if;

    /* R-1567: the rows redeem_customer_credits consumed in THIS call (used_at = now(), not yet
       linked) belong to this payment. They must add up to the credit applied — fail closed. */
    with s as (
      update public.customer_credits
         set applied_payment_id = v_pay_id
       where tenant_id = v_tenant and customer_id = p_credit_customer_id
         and status = 'used' and applied_payment_id is null and used_at = now()
      returning amount)
    select coalesce(sum(amount), 0)::int into v_linked from s;
    if v_linked <> v_credit then
      raise exception 'R-1567: linked ₹% of ₹% advance credit to payment % — nothing was recorded.', v_linked, v_credit, v_pay_id;
    end if;
  end if;

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
  'R-895: record-payment sheet in ONE transaction — redeem advance credit, record_payment(_with_tds) for amount + credit, tag received date + bank account, move paid_date. R-1565: the credit part is saved as payments.credit_applied. R-1567: the credit rows used are linked to the payment (customer_credits.applied_payment_id). R-1558: the credit must belong to the quote (and invoice) customer. Owner/manager/accountant/billing.';

revoke all on function public.record_desk_payment(text, integer, text, text, text, uuid, integer, date, uuid, integer, integer, integer, text, numeric, text, text, text) from public, anon;

commit;
