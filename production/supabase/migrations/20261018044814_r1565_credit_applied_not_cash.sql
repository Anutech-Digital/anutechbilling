-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'payments' and column_name = 'credit_applied') and exists(select 1 from pg_proc where oid = to_regprocedure('public.record_desk_payment(text,integer,text,text,text,uuid,integer,date,uuid,integer,integer,integer,text,numeric,text,text,text)') and prosrc like '%R-1565%')
-- deploy-key: r1565creditnotcash
-- 20261018044814_r1565_credit_applied_not_cash.sql
--
-- R-1565 (P1 money, audit 18 Oct 2026): advance credit applied to a payment was stored as if
-- it were cash, so the same rupees were "collected" twice and taxed twice as a GSTR-1 advance.
--
-- ══ WHAT WAS WRONG ═══════════════════════════════════════════════════════════════
--   A customer overpays quote A by ₹4,000 → record_payment's overpayment branch keeps the
--   whole ₹10,000 as a payments row (money received) and opens a ₹4,000 customer_credits row.
--   Later record_desk_payment applies that credit to quote B: redeem_customer_credits, then
--   record_payment(p_amount + v_credit) (20261012031823_r895_money_policies.sql:115,120).
--   B's payments row carries amount = cash + credit and nothing says which part was credit
--   (only free text in notes). Every "money in" reader summed payments.amount:
--     Collected this month / /payments total (lib/company/summary.ts collectedInMonth),
--     GSTR-1 11A (accounting/gst/report.ts — every received payment is an advance),
--     the receipt voucher, Day Book and customer ledger Receipts, Tally receipts,
--     bank-line suggestions and the settlement-shortfall "Bank Charges".
--   → the ₹4,000 was counted (and taxed as an advance) once on A and again on B.
--
-- ══ WHAT CHANGES ═════════════════════════════════════════════════════════════════
--   (1) payments.credit_applied integer NOT NULL DEFAULT 0, 0 ≤ credit_applied ≤ amount.
--       amount keeps meaning "what this payment settles" — paid_amount, outstanding,
--       net payable, adjusted_advances and record_payment's own sums are unchanged.
--       Money received on a payment = amount − credit_applied.
--   (2) record_desk_payment writes credit_applied = the credit it actually consumed, in the
--       same transaction (a replay consumes none and writes none).
--       record_payment / record_payment_with_tds / redeem_customer_credits are NOT changed.
--   (3) The SQL readers of money in use amount − credit_applied:
--       suggest_bank_transaction_matches, report_settlement_shortfalls, report_day_book
--       (Receipt / Refund), report_party_ledger (customer Receipt / Refund). Bodies are the
--       latest ones (R-715, tb_slice2, day_book_salary_journal, report_fixes_ist) with only
--       those lines changed. report_balance_sheet is NOT changed here (R-1576 redefines it
--       the same day) — its cash / advance lines are a follow-up on the card.
--   Historical rows: existing credit-applied payments keep credit_applied = 0 until the
--   dry-run repair (scripts/repair-r1565-credit-applied.mjs) is reviewed and run by the owner.
--
-- Test: supabase/tests/r1565_credit_applied_not_cash.test.sql (rolled back).

begin;

alter table public.payments add column if not exists credit_applied integer not null default 0;

alter table public.payments drop constraint if exists payments_credit_applied_within_amount;
alter table public.payments add constraint payments_credit_applied_within_amount
  check (credit_applied >= 0 and credit_applied <= amount);

comment on column public.payments.credit_applied is
  'R-1565: part of amount paid from the customer''s advance credit (customer_credits), not money received now. Money received = amount - credit_applied; amount is what the payment settles.';

-- ── record_desk_payment (R-895 body + the credit_applied write) ───────────────────
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
   R-1565: the credit part is written to payments.credit_applied — it is not money received. */
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


-- ── Bank-line suggestions: match the cash part ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.suggest_bank_transaction_matches(p_bank_txn_id uuid)
 RETURNS TABLE(match_type text, match_id text, match_label text, match_amount integer, match_date date, match_confidence text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_txn record; v_tenant uuid; v_search_amount integer; v_is_credit boolean;
  v_caller uuid; v_trusted boolean;
begin
  /* R-715: a signed-in caller sees suggestions only for their own company's bank line.
     No company (null-caller) → refused; another company's line → nothing (as "not found"). */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login' using errcode = '42501';
  end if;
  select bt.* into v_txn from public.bank_transactions bt where bt.id = p_bank_txn_id;
  if not found then return; end if;
  if not v_trusted and v_txn.tenant_id is distinct from v_caller then return; end if;
  v_tenant := v_txn.tenant_id; v_search_amount := greatest(v_txn.debit, v_txn.credit); v_is_credit := v_txn.credit > 0;
  if v_is_credit then
    return query
    select 'payment'::text, p.id::text,
           coalesce(c.name, p.receipt_voucher_no, 'Payment') || case when p.reference is not null and p.reference <> '' then ' · ' || p.reference else '' end,
           (p.amount - p.credit_applied), p.received_at::date,
           case when (p.amount - p.credit_applied) = v_search_amount and p.received_at::date = v_txn.txn_date then 'exact'
                when (p.amount - p.credit_applied) = v_search_amount and abs(p.received_at::date - v_txn.txn_date) <= 3 then 'high' else 'low' end::text
    from public.payments p left join public.customers c on c.id = p.customer_id
    -- R-1565: the bank saw only the cash part; a payment paid wholly by advance credit is never suggested.
    where p.tenant_id = v_tenant and p.status = 'received' and (p.amount - p.credit_applied) > 0
      and abs((p.amount - p.credit_applied) - v_search_amount) <= 100 and abs(p.received_at::date - v_txn.txn_date) <= 7
    order by abs((p.amount - p.credit_applied) - v_search_amount), abs(p.received_at::date - v_txn.txn_date) limit 5;

    return query
    select 'project'::text, pp.id::text,
           coalesce(ps.customer_name, ps.title, 'Project payment') || ' · project',
           pp.amount, pp.received_at::date,
           case when pp.amount = v_search_amount and pp.received_at::date = v_txn.txn_date then 'exact'
                when pp.amount = v_search_amount and abs(pp.received_at::date - v_txn.txn_date) <= 3 then 'high' else 'low' end::text
    from public.project_payments pp
    join public.project_sales ps on ps.id = pp.project_id
    where pp.tenant_id = v_tenant and pp.bank_txn_id is null
      and abs(pp.amount - v_search_amount) <= 100 and abs(pp.received_at::date - v_txn.txn_date) <= 7
    order by abs(pp.amount - v_search_amount), abs(pp.received_at::date - v_txn.txn_date) limit 5;
  end if;
  if not v_is_credit then
    return query
    select 'salary'::text, sp.id::text, e.name || ' · salary ' || sp.period, sp.net, sp.pay_date,
           case when sp.net = v_search_amount and sp.pay_date = v_txn.txn_date then 'exact'
                when sp.net = v_search_amount and abs(sp.pay_date - v_txn.txn_date) <= 10 then 'high' else 'low' end::text
    from public.salary_payments sp join public.employees e on e.id = sp.employee_id
    where sp.tenant_id = v_tenant and sp.paid_status = 'unpaid' and abs(sp.net - v_search_amount) <= 100 and abs(sp.pay_date - v_txn.txn_date) <= 15
    order by abs(sp.net - v_search_amount), abs(sp.pay_date - v_txn.txn_date) limit 5;
    return query
    select 'expense'::text, e.id::text, coalesce(e.vendor_name, e.category, 'Expense'), e.amount, e.expense_date,
           case when e.amount = v_search_amount and e.expense_date = v_txn.txn_date then 'exact'
                when e.amount = v_search_amount and abs(e.expense_date - v_txn.txn_date) <= 3 then 'high' else 'low' end::text
    from public.expenses e
    where e.tenant_id = v_tenant and e.category <> 'Salaries' and abs(e.amount - v_search_amount) <= 100 and abs(e.expense_date - v_txn.txn_date) <= 7
    order by abs(e.amount - v_search_amount), abs(e.expense_date - v_txn.txn_date) limit 5;
  end if;
end; $function$;

-- ── Settlement shortfall: the bank owes only the cash part ─────────────────────────
-- ── 1. Settlement shortfall (G1) ─────────────────────────────────────────────
create or replace function public.report_settlement_shortfalls(p_from date, p_to date)
returns table (txn_date date, amount bigint, payment_id uuid, reference text)
language sql
stable
security invoker
set search_path = public
as $function$
  -- Payment ke aane wale paise = amount − customer ka TDS − book hui gateway fee. Us payment
  -- se match hui bank lines ka credit usse kam ho to farq bank / gateway ne rakha.
  -- Zyada aaya ho to yahan kuch nahi (wo galat match hai, kharcha nahi).
  with m as (
    select p.id, p.reference,
           -- R-1565: advance credit applied never reaches the bank — it is not a shortfall.
           (p.amount - p.credit_applied)::bigint
             - coalesce((select sum(t.tds_amount) from public.tds_receivable t
                          where t.tenant_id = p.tenant_id and t.payment_id = p.id), 0)
             - coalesce((select e.amount from public.expenses e
                          where e.tenant_id = p.tenant_id and e.id = 'EXP-RZPFEE-' || p.id::text), 0) as expected,
           sum(b.credit)::bigint as credited,
           max(b.txn_date) as txn_date
      from public.payments p
      join public.bank_transactions b
        on b.tenant_id = p.tenant_id and b.matched_to_type = 'payment' and b.matched_to_id = p.id::text
     where p.tenant_id = public.current_tenant_id() and p.status = 'received'
     group by p.id, p.reference, p.amount, p.credit_applied, p.tenant_id
  )
  select m.txn_date, (m.expected - m.credited)::bigint, m.id, m.reference
    from m
   where m.expected > m.credited and m.txn_date between p_from and p_to;
$function$;

-- ── Day Book: Receipt / Refund at the cash part ────────────────────────────────────
create or replace function public.report_day_book(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_out jsonb;
begin
  if v_tenant is null then
    raise exception 'Day Book nahi ban sakti: aapka login kisi workspace se juda nahi hai. Dobara sign in karein; phir bhi ho to owner se Settings → Team me aapko jodne ko kahein.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Day Book ki tareekh galat hai (% se % tak). "From" tareekh "To" se pehle ya barabar honi chahiye.', p_from, p_to
      using errcode = 'invalid_parameter_value';
  end if;
  if p_to - p_from > 366 then
    raise exception 'Day Book ek baar me zyada se zyada 366 din ki banti hai (aapne % din chune). Chhota period chunein — mahina ya FY.', p_to - p_from + 1
      using errcode = 'invalid_parameter_value';
  end if;

  with v as (
    select i.invoice_date as d, 'Sales'::text as voucher, i.id as ref, i.customer_name as party,
           null::text as narr, i.amount::bigint as amt, 1 as ord
      from public.invoices i
     where i.tenant_id = v_tenant and i.invoice_date between p_from and p_to
       and i.status not in ('draft', 'void')
    union all
    select (p.received_at at time zone 'Asia/Kolkata')::date, 'Receipt',
           coalesce(p.receipt_voucher_no, p.id::text), c.name,
           nullif(concat_ws(' · ', nullif(p.method, ''), nullif(p.reference, '')), ''),
           (p.amount - p.credit_applied)::bigint, 2
      from public.payments p
      left join public.customers c on c.id = p.customer_id and c.tenant_id = v_tenant
     where p.tenant_id = v_tenant
       -- R-1565: a Receipt is money in; advance credit applied was receipted when it came in.
       and p.amount - p.credit_applied > 0
       and (p.received_at at time zone 'Asia/Kolkata')::date between p_from and p_to
    union all
    select (p.refunded_at at time zone 'Asia/Kolkata')::date, 'Refund',
           coalesce(p.refund_voucher_no, coalesce(p.receipt_voucher_no, p.id::text) || ' · refunded'), c.name,
           p.refund_reason, (p.amount - p.credit_applied)::bigint, 3
      from public.payments p
      left join public.customers c on c.id = p.customer_id and c.tenant_id = v_tenant
     where p.tenant_id = v_tenant and p.status = 'refunded' and p.refunded_at is not null
       and p.amount - p.credit_applied > 0
       and (p.refunded_at at time zone 'Asia/Kolkata')::date between p_from and p_to
    union all
    select pp.received_at, 'Receipt', coalesce(nullif(pp.reference, ''), pp.id::text), ps.customer_name,
           'Project: ' || ps.title, pp.amount::bigint, 2
      from public.project_payments pp
      join public.project_sales ps on ps.id = pp.project_id and ps.tenant_id = v_tenant
     where pp.tenant_id = v_tenant and pp.received_at between p_from and p_to
    union all
    select cn.credit_date, 'Credit Note', cn.id, cn.customer_name,
           coalesce(cn.reason, 'against ' || cn.invoice_id), cn.amount::bigint, 4
      from public.credit_notes cn
     where cn.tenant_id = v_tenant and cn.credit_date between p_from and p_to
    union all
    select dn.debit_date, 'Debit Note', dn.id, dn.customer_name,
           coalesce(dn.reason, 'against ' || dn.invoice_id), dn.amount::bigint, 4
      from public.debit_notes dn
     where dn.tenant_id = v_tenant and dn.debit_date between p_from and p_to
    union all
    -- Salary ka kharcha Journal hai (Tally: Salary A/c Dr / Salary Payable A/c Cr), Purchase nahi —
    -- CA ko Day Book me salary kharidari jaisi dikhe to wo galat ledger me jaati hai. Categories
    -- wahi jo app salary maanta hai: lib/accounting/project-cost.ts SALARY_CATEGORIES.
    select e.expense_date,
           case when e.category in ('Salaries', 'Director''s Remuneration') then 'Journal' else 'Purchase' end,
           coalesce(e.bill_no, e.id), e.vendor_name, e.category, e.amount::bigint, 5
      from public.expenses e
     where e.tenant_id = v_tenant and e.expense_date between p_from and p_to
    union all
    select vb.bill_date, 'Purchase', coalesce(vb.bill_no, vb.id), vb.vendor_name, vb.category, vb.total::bigint, 5
      from public.vendor_bills vb
     where vb.tenant_id = v_tenant and vb.bill_date between p_from and p_to
    union all
    select e.paid_date, 'Payment', coalesce(e.bill_no, e.id) || ' · paid', e.vendor_name,
           e.payment_method, e.amount::bigint, 6
      from public.expenses e
     where e.tenant_id = v_tenant and e.paid and e.paid_date between p_from and p_to
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'date', to_char(v.d, 'YYYY-MM-DD'), 'voucher', v.voucher, 'reference', v.ref,
           'party', v.party, 'narration', v.narr, 'amount', v.amt)
         order by v.d, v.ord, v.ref), '[]'::jsonb)
    into v_out
    from v;
  return v_out;
end;
$function$;

-- ── Customer ledger: Receipt / Refund at the cash part ─────────────────────────────
create or replace function public.report_party_ledger(p_kind text, p_party text, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_cust   uuid;
  v_out jsonb;
begin
  if v_tenant is null then
    raise exception 'Ledger nahi ban sakta: aapka login kisi workspace se juda nahi hai. Dobara sign in karein.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_kind not in ('customer', 'vendor') then
    raise exception 'Ledger ka prakaar "%" samajh nahi aaya — sirf customer ya vendor chalta hai.', p_kind
      using errcode = 'invalid_parameter_value';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Ledger ki tareekh galat hai (% se % tak). Period dobara chunein.', p_from, p_to
      using errcode = 'invalid_parameter_value';
  end if;
  -- Customer id pehle hi uuid bana lo — query ke andar cast karte to vendor ke naam par
  -- bhi cast chal sakta (planner constant-fold karta hai) aur index bhi na lagta.
  if p_kind = 'customer' then
    begin
      v_cust := p_party::uuid;
    exception when invalid_text_representation then
      raise exception 'Customer id "%" sahi nahi hai. Customer list se dobara chunein.', p_party
        using errcode = 'invalid_parameter_value';
    end;
  end if;

  with e as (
    select * from (
      -- Customer: Sales (Dr), Receipt (Cr), Refund (Dr), Credit Note (Cr), Debit Note (Dr).
      select i.invoice_date as d, i.id as ref, 'Sales'::text as voucher, null::text as narr,
             i.amount::bigint as amt, true as up
        from public.invoices i
       where p_kind = 'customer' and i.tenant_id = v_tenant
         and i.customer_id = v_cust and i.status <> 'void'
      union all
      select (p.received_at at time zone 'Asia/Kolkata')::date, coalesce(p.receipt_voucher_no, p.id::text), 'Receipt',
             nullif(concat_ws(' · ', nullif(p.method, ''), nullif(p.reference, '')), ''),
             (p.amount - p.credit_applied)::bigint, false
        from public.payments p
       -- R-1565: the customer's credit was already a Receipt on the payment that created it.
       where p_kind = 'customer' and p.tenant_id = v_tenant and p.customer_id = v_cust
         and p.amount - p.credit_applied > 0
      union all
      select (p.refunded_at at time zone 'Asia/Kolkata')::date,
             coalesce(p.receipt_voucher_no, p.id::text) || ' · refunded', 'Refund',
             'Payment returned to the customer', (p.amount - p.credit_applied)::bigint, true
        from public.payments p
       where p_kind = 'customer' and p.tenant_id = v_tenant and p.customer_id = v_cust
         and p.status = 'refunded' and p.refunded_at is not null
         and p.amount - p.credit_applied > 0
      union all
      select c.credit_date, c.id, 'Credit Note',
             coalesce(c.reason, case when coalesce(c.invoice_id, '') <> '' then 'against ' || c.invoice_id end),
             c.amount::bigint, false
        from public.credit_notes c
       where p_kind = 'customer' and c.tenant_id = v_tenant and c.customer_id = v_cust
      union all
      select d.debit_date, d.id, 'Debit Note',
             coalesce(d.reason, case when coalesce(d.invoice_id, '') <> '' then 'against ' || d.invoice_id end),
             d.amount::bigint, true
        from public.debit_notes d
       where p_kind = 'customer' and d.tenant_id = v_tenant and d.customer_id = v_cust
      union all
      -- Vendor: expenses hi bill hain (vendor_name par — vendor_id zyaadatar khaali hai).
      select x.expense_date, coalesce(x.bill_no, x.id), 'Purchase', x.category, x.amount::bigint, true
        from public.expenses x
       where p_kind = 'vendor' and x.tenant_id = v_tenant and x.vendor_name = p_party
      union all
      select x.paid_date, coalesce(x.bill_no, x.id) || ' · paid', 'Payment', x.payment_method, x.amount::bigint, false
        from public.expenses x
       where p_kind = 'vendor' and x.tenant_id = v_tenant and x.vendor_name = p_party
         and x.paid and x.paid_date is not null
    ) u
    where u.d is not null
  )
  select jsonb_build_object(
    'opening', (select coalesce(sum(case when e.up then e.amt else -e.amt end), 0) from e where e.d < p_from),
    'entries', (select coalesce(jsonb_agg(jsonb_build_object(
                  'date', to_char(e.d, 'YYYY-MM-DD'), 'reference', e.ref, 'voucher', e.voucher,
                  'narration', e.narr, 'amount', e.amt, 'increasesLiability', e.up)
                  order by e.d, e.up desc, e.ref), '[]'::jsonb)
                  from e where e.d between p_from and p_to)
  ) into v_out;
  return v_out;
end;
$function$;

comment on function public.record_desk_payment(text, integer, text, text, text, uuid, integer, date, uuid, integer, integer, integer, text, numeric, text, text, text) is
  'R-895: record-payment sheet in ONE transaction — redeem advance credit, record_payment(_with_tds) for amount + credit, tag received date + bank account, move paid_date. R-1565: the credit part is saved as payments.credit_applied. Owner/manager/accountant/billing.';

-- create or replace keeps every grant; restated for the R-401 guard and a fresh database.
revoke all on function public.record_desk_payment(text, integer, text, text, text, uuid, integer, date, uuid, integer, integer, integer, text, numeric, text, text, text) from public, anon;
grant execute on function public.record_desk_payment(text, integer, text, text, text, uuid, integer, date, uuid, integer, integer, integer, text, numeric, text, text, text) to authenticated, service_role;
revoke all on function public.report_settlement_shortfalls(date, date) from public, anon;
grant execute on function public.report_settlement_shortfalls(date, date) to authenticated, service_role;
revoke all on function public.report_day_book(date, date) from public, anon;
grant execute on function public.report_day_book(date, date) to authenticated;
revoke all on function public.report_party_ledger(text, text, date, date) from public, anon;
grant execute on function public.report_party_ledger(text, text, date, date) to authenticated;

commit;
