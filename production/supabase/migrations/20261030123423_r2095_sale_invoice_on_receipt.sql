-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'invoice_on_receipt') and exists(select 1 from pg_proc where oid = to_regprocedure('public.bill_subscription_instalment(uuid,boolean)') and prosrc like '%invoice_on_receipt%') and to_regprocedure('public.tg_bank_txn_payment_link()') is not null
-- deploy-key: r2095saleinvoiceonreceipt
-- 20261030123423_r2095_sale_invoice_on_receipt.sql
--
-- R-2095 (30 Oct 2026, September reconcile on staging), P0 money:
--   1. A part-paid NEW SALE booked from a bank receipt got no GST invoice (three staging sales:
--      short ₹8, short ₹568, and a half-yearly sale). The service is live, so the tax invoice is
--      for the whole supply with the balance due — Zoho does the same. Such a sale is now marked
--      quotes.invoice_on_receipt and is invoiced on its FIRST receipt:
--        yearly / one-time → generate_invoice in bank_credit_pay_item (pending, balance due);
--        billed in parts   → its first part in bill_subscription_instalment.
--      A quote sent before payment keeps the fully-paid rule (unchanged).
--   2. The half-yearly sale (start 19 Jun) was filed with renewal 19 Dec 2026 — the next half's
--      date. The schedule counts the year back from the renewal date, so its "next half" request
--      (sent at sale time) covered the paid half again. bank_credit_pay_item now refuses a renewal
--      date inside the first year for a sale billed in parts on a 1-year commitment (the screen
--      no longer offers it either; the sale-time call raises no request — app code).
--   3. A new sale's subscription line may carry its own end-domain (Zoho bills per end-domain);
--      empty = the customer's domain, as before (record_payment keeps a line's domain, R-829).
--   4. Receipts made from bank lines did not say which line: an AFTER trigger on
--      bank_transactions stores payments.bank_txn_id whenever a line is matched to a receipt
--      (every path — reconcile, advance, manual match); existing matched lines are back-filled.
--
-- Existing sales booked from a bank receipt (note 'Sale booked from a bank receipt of …') get the
-- flag; this migration itself invoices nothing (Generate / the billing job do it).
-- Bodies: bank_credit_pay_item from 20261029054707 (R-2098); bank_credit_new_sale_quote from
-- 20261030050145 (R-2095 paise); bill_subscription_instalment from 20261030035007 (R-2095) — the
-- latest definitions.
-- Test: supabase/tests/r2095_sale_invoice_on_receipt.test.sql

begin;

alter table public.quotes add column if not exists invoice_on_receipt boolean not null default false;
comment on column public.quotes.invoice_on_receipt is
  'R-2095: a sale booked from a bank receipt — its tax invoice (or first part''s) is issued on the first receipt, part-paid or not.';
update public.quotes set invoice_on_receipt = true
 where not invoice_on_receipt and notes like 'Sale booked from a bank receipt of %';

-- ── bank_credit_pay_item ──────────────────────────────────────────────────────────────────
create or replace function public.bank_credit_pay_item(
  p_txn_id              uuid,
  p_amount              integer,
  p_reference           text,
  p_quote_id            text    default null,
  p_invoice_id          text    default null,
  p_tds_amount          integer default 0,
  p_tds_rate_pct        numeric default null,
  p_tds_section         text    default null,
  p_create_subscription boolean default null,
  p_sub_start           date    default null,
  p_sub_renewal         date    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2095 (Sept reconcile): a sale booked from a bank receipt (quotes.invoice_on_receipt) is invoiced on
   its FIRST receipt, part-paid or not; a split-billed sale's renewal date is the end of the commitment.
   R-2098: one item paid from a bank credit — no line lock, no reconcile (the caller does both).
   Called by reconcile_bank_credit_to_item (amount = the whole credit) and
   reconcile_bank_credit_split (amount = the item's share). */
declare
  v_txn        record;
  v_inv        record;
  v_quote      record;
  v_quote_id   text;
  v_kind       text;
  v_sub_id     uuid;
  v_new_sale   boolean := false;
  v_skip_sub   boolean := false;
  v_res        jsonb;
  v_pay_id     uuid;
  v_replay     boolean;
  v_tds        integer := greatest(0, coalesce(p_tds_amount, 0));
  v_gross      integer;
  v_inv_issued text := null;
  v_inv_now    text;
  v_lines      jsonb;
  v_inv_taxable integer := null;
  v_note       text;
begin
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'Each item needs an amount of more than ₹0.' using errcode = '22023';
  end if;
  if (p_quote_id is null) = (p_invoice_id is null) then
    raise exception 'Pick one quote or one invoice this money is for.' using errcode = '22023';
  end if;
  select t.* into v_txn from public.bank_transactions t where t.id = p_txn_id;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;

  /* What the money is for. */
  if p_invoice_id is not null then
    select i.id, i.tenant_id, i.quote_id, i.taxable_value, i.status into v_inv
      from public.invoices i where i.id = p_invoice_id;
    if not found or v_inv.tenant_id is distinct from v_txn.tenant_id then
      raise exception 'Invoice % not found in your company', p_invoice_id using errcode = 'no_data_found';
    end if;
    if v_inv.status not in ('pending', 'overdue') then
      raise exception 'Invoice % is %, so there is nothing left to pay on it.', p_invoice_id, v_inv.status using errcode = 'check_violation';
    end if;
    v_quote_id := v_inv.quote_id;
    v_inv_taxable := nullif(v_inv.taxable_value, 0);
    if v_quote_id is null then
      select b.subscription_id into v_sub_id from public.subscription_billings b
       where b.tenant_id = v_txn.tenant_id and b.invoice_id = p_invoice_id limit 1;
      if v_sub_id is null then
        raise exception 'Invoice % has no quote or subscription behind it — record its payment from the invoice page.', p_invoice_id
          using errcode = 'check_violation';
      end if;
      v_kind := 'instalment';
    end if;
  else
    v_quote_id := p_quote_id;
  end if;

  if v_quote_id is not null then
    select q.* into v_quote from public.quotes q where q.id = v_quote_id for update;
    if not found or v_quote.tenant_id is distinct from v_txn.tenant_id then
      raise exception 'Quote % not found in your company', v_quote_id using errcode = 'no_data_found';
    end if;
    v_sub_id := coalesce(
      (select s.id from public.subscriptions s where s.tenant_id = v_quote.tenant_id and s.renewal_quote_id = v_quote.id limit 1),
      v_quote.renewal_subscription_id, v_quote.add_seats_subscription_id);
    v_kind := case
                when v_quote.is_add_seats then 'add_seats'
                when v_sub_id is not null or v_quote.is_renewal or v_quote.is_extension then 'renewal'
                when v_quote.is_one_off then 'one_off'
                else 'new' end;
    v_gross := coalesce(v_inv_taxable, nullif(v_quote.subtotal, 0), round(coalesce(v_quote.amount, 0) * 100.0 / (100 + coalesce(v_quote.tax_rate, 18)))::int);

    /* A new subscription sale that has filed nothing yet: the operator's subscription choice. */
    v_new_sale := v_kind = 'new'
      and not exists (select 1 from public.subscriptions s where s.tenant_id = v_quote.tenant_id and s.quote_id = v_quote.id)
      and not exists (select 1 from public.payments p where p.quote_id = v_quote.id and p.status = 'received')
      and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(v_quote.line_items) = 'array' then v_quote.line_items else '[]'::jsonb end) li
                   where jsonb_typeof(li) = 'object' and public.quote_line_is_subscription(li, v_quote.tenant_id, false));
    if v_new_sale and p_create_subscription is false then
      /* record_payment's own 0157 guard: a one-off quote files no subscription. */
      update public.quotes set is_one_off = true where id = v_quote.id;
      v_skip_sub := true;
    elsif v_new_sale and (p_sub_start is not null or p_sub_renewal is not null) then
      if p_sub_start is not null and p_sub_renewal is not null and p_sub_renewal <= p_sub_start then
        raise exception 'The renewal date (%) must be after the start date (%).', p_sub_renewal, p_sub_start using errcode = '22023';
      end if;
      /* R-2095: billed in parts on a 1-year commitment — the renewal date is the END of the year,
         never the next part's date. Staging: renewal 19 Dec 2026 on a half-yearly sale from 19 Jun
         made the schedule count the year back from it (term start 20 Dec 2025), so the "next half"
         request covered the paid half again. */
      if p_sub_renewal is not null
         and coalesce(v_quote.billing_cycle, 'yearly') in ('monthly', 'quarterly', 'half_yearly')
         and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(v_quote.line_items) = 'array' then v_quote.line_items else '[]'::jsonb end) li
                      where jsonb_typeof(li) = 'object' and li->>'commitment' = 'annual_yearly')
         and p_sub_renewal < (coalesce(p_sub_start, v_txn.txn_date) + interval '12 months' - interval '1 day')::date then
        raise exception 'Billed % on a 1-year commitment: the renewal date is the end of the year (%), not the next part''s date. The next part is billed on its own date.',
          replace(v_quote.billing_cycle, '_', '-'), to_char(coalesce(p_sub_start, v_txn.txn_date) + interval '12 months', 'FMDD Mon YYYY')
          using errcode = '22023';
      end if;
      select jsonb_agg(
               case when jsonb_typeof(li) = 'object' and public.quote_line_is_subscription(li, v_quote.tenant_id, false)
                    then li
                         || case when p_sub_start   is not null then jsonb_build_object('start_date',   p_sub_start::text)   else '{}'::jsonb end
                         || case when p_sub_renewal is not null then jsonb_build_object('renewal_date', p_sub_renewal::text) else '{}'::jsonb end
                    else li end
               order by ord)
        into v_lines
        from jsonb_array_elements(v_quote.line_items) with ordinality as t(li, ord);
      update public.quotes set line_items = v_lines where id = v_quote.id;
    end if;
  else
    v_gross := coalesce(v_inv_taxable, 0);
  end if;

  /* NOT 'Reconciled from bank receipt': that note marks a throw-away one-off sale which
     unreconcile_bank_receipt may delete ("undo the sale"). A renewal / add-seats / subscription
     payment must never be deleted from the bank page — un-reconciling only frees the line. */
  v_note := 'Bank credit of ' || to_char(v_txn.txn_date, 'DD Mon YYYY') || ' matched to ' || coalesce(p_invoice_id, v_quote_id);

  if v_kind = 'instalment' then
    v_res := public.record_instalment_payment(
      p_invoice_id, p_amount + v_tds, 'bank_transfer', p_reference, v_note,
      null, 0, v_txn.txn_date, v_txn.bank_account_id,
      v_tds, case when v_tds > 0 then v_gross else 0 end, case when v_tds > 0 then p_amount else 0 end,
      case when v_tds > 0 then coalesce(p_tds_section, '194J') end, case when v_tds > 0 then p_tds_rate_pct end,
      null, case when v_tds > 0 then public.indian_fiscal_year(v_txn.txn_date) end);
  else
    v_res := public.record_desk_payment(
      v_quote_id, p_amount + v_tds, 'bank_transfer', p_reference, v_note,
      null, 0, v_txn.txn_date, v_txn.bank_account_id,
      v_tds, case when v_tds > 0 then v_gross else 0 end, case when v_tds > 0 then p_amount else 0 end,
      case when v_tds > 0 then coalesce(p_tds_section, '194J') end, case when v_tds > 0 then p_tds_rate_pct end,
      null, p_invoice_id, case when v_tds > 0 then public.indian_fiscal_year(v_txn.txn_date) end);
  end if;

  v_pay_id := nullif(v_res->>'payment_id', '')::uuid;
  if v_pay_id is null then
    raise exception 'The payment was not recorded.' using errcode = 'P0001';
  end if;
  v_replay := coalesce((v_res->>'already_recorded')::boolean, false)
           or coalesce((v_res->>'idempotent_replay')::boolean, false);

  /* Invoice once fully paid, when the quote has none (record_payment never issues one).
     R-2095: a sale booked from a bank receipt is invoiced on its first receipt even if part-paid —
     the licence is live, so the tax invoice is for the whole supply with the balance due (Zoho does
     the same). A quote sent before payment keeps the fully-paid rule. */
  if v_quote_id is not null and not v_replay then
    select q.invoice_id into v_inv_now from public.quotes q where q.id = v_quote_id;
    if v_inv_now is null
       and (coalesce((v_res->>'is_fully_paid')::boolean, false)
            or coalesce((select q2.invoice_on_receipt from public.quotes q2 where q2.id = v_quote_id), false))
       and not exists (select 1 from public.subscriptions s
                        where s.tenant_id = v_txn.tenant_id and s.quote_id = v_quote_id
                          and s.billing_cycle is distinct from 'yearly'::public.billing_cycle)
       /* R-2044: a part payment request is never invoiced whole — its part's tax invoice is
          raised by tg_payments_part_quote_invoice when it is paid (raise_subscription_billing). */
       and not exists (select 1 from public.quotes pq
                        where pq.id = v_quote_id and pq.subscription_billing_id is not null) then
      select gi.invoice_id into v_inv_issued from public.generate_invoice(v_quote_id) gi;
      /* R-015's rule (record_desk_payment): a settled invoice is paid on the RECEIPT date. */
      update public.invoices set paid_date = v_txn.txn_date
       where id = v_inv_issued and tenant_id = v_txn.tenant_id and status = 'paid';
    end if;
  end if;

  return jsonb_build_object(
    'kind', v_kind, 'quote_id', v_quote_id, 'sub_id', v_sub_id, 'skip_sub', v_skip_sub,
    'invoice_issued', v_inv_issued, 'payment_id', v_pay_id, 'replay', v_replay, 'res', v_res);
end;
$$;
revoke all on function public.bank_credit_pay_item(uuid, integer, text, text, text, integer, numeric, text, boolean, date, date) from public, anon, authenticated;
grant execute on function public.bank_credit_pay_item(uuid, integer, text, text, text, integer, numeric, text, boolean, date, date) to service_role;


-- ── bank_credit_new_sale_quote ──
create or replace function public.bank_credit_new_sale_quote(
  p_txn_id        uuid,
  p_customer_id   uuid,
  p_lines         jsonb,
  p_billing_cycle text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2098: reconcile_bank_credit_new_sale's quote, moved here unchanged so the split can make the
   same sale and pay part of the line on it. Returns {quote_id, quote_total, tax_rate}.
   R-2095: unit prices keep paise (Zoho rates ₹103.5, ₹1,347.5); the subtotal is rounded once.
   R-2095 (Sept): invoice_on_receipt — the sale is invoiced on its first receipt, part-paid or not;
   a subscription line keeps its own end-domain. */
declare
  v_cycle    text;
  v_txn      record;
  v_cust     record;
  v_export   boolean;
  v_rate     integer;
  v_lines    jsonb;
  v_subtotal integer;
  v_gross    integer;
  v_qid      text;
  v_monthly  boolean;
  v_annual   boolean;
  v_problem  text;
  v_seats    integer;
begin
  select t.id, t.tenant_id, t.credit, t.txn_date, t.matched_to_type into v_txn
    from public.bank_transactions t where t.id = p_txn_id;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;

  select c.id, c.name, c.country, c.tenant_id into v_cust from public.customers c where c.id = p_customer_id;
  if not found or v_cust.tenant_id is distinct from v_txn.tenant_id then
    raise exception 'Customer not found in your company' using errcode = 'no_data_found';
  end if;

  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Add what was sold — at least one product line.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_lines) li
              where jsonb_typeof(li) <> 'object'
                 or nullif(btrim(coalesce(li->>'name', '')), '') is null
                 or coalesce(li->>'qty', '') !~ '^[0-9]+$' or (li->>'qty')::int <= 0
                 or coalesce(li->>'rate', '') !~ '^[0-9]+(.[0-9]{1,2})?$'
                 or coalesce(li->>'commitment', 'one_time') not in ('annual_yearly', 'monthly', 'one_time')) then
    raise exception 'Every line needs a product, seats / quantity of at least 1 and a unit price (paise allowed, two decimals at most).' using errcode = '22023';
  end if;
  /* R-2095 (Sept): a subscription line may name its own end-domain (Zoho bills per end-domain);
     empty = the customer's domain. */
  if exists (select 1 from jsonb_array_elements(p_lines) li
              where nullif(btrim(coalesce(li->>'domain', '')), '') is not null
                and lower(btrim(li->>'domain')) !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$') then
    raise exception 'A line''s domain must look like example.com.' using errcode = '22023';
  end if;
  v_monthly := exists (select 1 from jsonb_array_elements(p_lines) li where li->>'commitment' = 'monthly');
  v_annual  := exists (select 1 from jsonb_array_elements(p_lines) li where li->>'commitment' = 'annual_yearly');
  if v_monthly and v_annual then
    raise exception 'One quote = one billing term. Put monthly items on a separate sale.' using errcode = 'check_violation';
  end if;

  /* R-2026: how often it is billed — the quote builder's rule. Monthly flex has no commitment,
     so it is billed monthly only; an annual commitment is billed yearly, half-yearly, quarterly
     or monthly; a one-time sale is not split. */
  v_cycle := nullif(btrim(coalesce(p_billing_cycle, '')), '');
  if v_cycle is not null and v_cycle not in ('yearly', 'half_yearly', 'quarterly', 'monthly') then
    raise exception 'Payment must be yearly, half-yearly, quarterly or monthly.' using errcode = '22023';
  end if;
  if v_monthly then
    if v_cycle is not null and v_cycle <> 'monthly' then
      raise exception 'A Monthly flex plan has no commitment, so it is billed monthly only.' using errcode = 'check_violation';
    end if;
    v_cycle := 'monthly';
  elsif not v_annual then
    v_cycle := 'yearly';
  else
    v_cycle := coalesce(v_cycle, 'yearly');
  end if;

  /* Same refusals and tax rule as create_direct_invoice. */
  v_problem := public.supplier_invoice_problem(v_txn.tenant_id, public.ist_today());
  if v_problem is not null then
    raise exception '%', v_problem using errcode = 'check_violation';
  end if;
  v_export := coalesce(nullif(lower(trim(v_cust.country)), ''), 'india') not in ('india','in','ind','bharat');
  v_rate := case
              when v_export then 0
              when public.supplier_gst_status(v_txn.tenant_id, public.ist_today()) in ('unregistered', 'composition') then 0
              else 18
            end;

  /* The builder's line shape: id, item_id, name, qty, rate (₹ per unit for the term), cost,
     commitment — a one-time line carries one_time: true and no commitment (R-1688). */
  select jsonb_agg(
           jsonb_strip_nulls(jsonb_build_object(
             'id',         coalesce(nullif(li->>'id', ''), 'line-' || ord),
             'item_id',    nullif(li->>'item_id', ''),
             'name',       btrim(li->>'name'),
             'qty',        (li->>'qty')::int,
             'rate',       round((li->>'rate')::numeric, 2),   -- R-2095: paise kept
             'cost',       coalesce(case when coalesce(li->>'cost', '') ~ '^[0-9]+$' then (li->>'cost')::int end, 0),
             'commitment', case when li->>'commitment' in ('annual_yearly', 'monthly') then li->>'commitment' end,
             'one_time',   case when coalesce(li->>'commitment', 'one_time') = 'one_time' then true end,
             'domain',     case when li->>'commitment' in ('annual_yearly', 'monthly')
                                then nullif(lower(btrim(coalesce(li->>'domain', ''))), '') end))
           order by ord)
    into v_lines
    from jsonb_array_elements(p_lines) with ordinality as t(li, ord);

  /* R-2095: qty × paise rate summed, rounded to the rupee once (as salePreview). */
  select round(coalesce(sum((li->>'qty')::int * (li->>'rate')::numeric), 0))::int into v_subtotal
    from jsonb_array_elements(v_lines) li;
  if v_subtotal <= 0 then raise exception 'The sale total must be more than ₹0.' using errcode = '22023'; end if;
  v_gross := v_subtotal + round(v_subtotal * v_rate / 100.0)::int;
  select sum((li->>'qty')::int) into v_seats from jsonb_array_elements(v_lines) li where li ? 'commitment';

  v_qid := public.next_document_number('quote', v_txn.tenant_id, public.ist_today());
  if v_qid is null then raise exception 'Could not allocate a quote number'; end if;

  insert into public.quotes (
    id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, tax_rate, discount_pct,
    line_items, status, payment_status, is_one_off, billing_cycle, created_date, notes, invoice_on_receipt
  ) values (
    v_qid, v_txn.tenant_id, p_customer_id, v_cust.name, v_lines->0->>'name', v_seats,
    v_gross, v_subtotal, v_rate, 0,
    v_lines, 'accepted', 'awaiting', not (v_monthly or v_annual), v_cycle,
    public.ist_today(), 'Sale booked from a bank receipt of ' || to_char(v_txn.txn_date, 'DD Mon YYYY'), true
  );

  return jsonb_build_object('quote_id', v_qid, 'quote_total', v_gross, 'tax_rate', v_rate);
end;
$$;
revoke all on function public.bank_credit_new_sale_quote(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.bank_credit_new_sale_quote(uuid, uuid, jsonb, text) to service_role;


-- ── bill_subscription_instalment ──
create or replace function public.bill_subscription_instalment(p_billing_id uuid, p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2044: invoice a paid part or make its payment request — once. R-2048: the sale quote's first part only when money covers it; an open unpaid sale quote IS its request. R-2092: the quote's parts for one period are ONE group — one invoice, one request, the quote's money pool; none billed while a sibling's parts are not laid (R-2092 siblings laid). R-2095: a part freed by credit notes is billed afresh. R-2095 (Sept): the first part of a sale booked from a bank receipt (invoice_on_receipt) is invoiced once any money came in. */
declare
  v_trusted  boolean;
  v_caller   uuid;
  v_b        record;
  v_sub      record;
  v_q        record;
  v_has_q    boolean := false;
  v_first    boolean;
  v_rate     integer;
  v_tax      integer;
  v_gross    integer;
  v_country  text;
  v_req_paid boolean := false;
  v_raised   record;
  v_id       text;
  v_period   text;
  v_on_due   boolean := false;
  v_label    text;
  v_cycle    text;
  v_paid_up  boolean := false;
  v_sale     record;
  v_ids      uuid[];
  v_lead     uuid;
  v_taxable  integer;
  v_parts    integer;
  v_lines    jsonb;
  v_g        record;
  v_seats    integer;
  v_unlaid   uuid[];
  v_on_rcpt  boolean := false;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — only a user of the subscription''s company can bill its part'
      using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can bill a subscription part' using errcode = '42501';
  end if;

  if coalesce(p_dry_run, false) then
    select b.* into v_b from public.subscription_billings b where b.id = p_billing_id;
  else
    select b.* into v_b from public.subscription_billings b where b.id = p_billing_id for update;
  end if;
  if not found then
    raise exception 'Billing part % not found', p_billing_id using errcode = 'no_data_found';
  end if;
  if v_caller is not null and v_b.tenant_id is distinct from v_caller then
    raise exception 'Billing part % is not in the caller''s company', p_billing_id using errcode = 'insufficient_privilege';
  end if;

  if v_b.invoice_id is not null then
    return jsonb_build_object('action', 'already_invoiced', 'invoice_id', v_b.invoice_id);
  end if;

  /* R-2092 siblings laid: the quote's parts of one period are billed together — so a part is
     not billed (no invoice, no request) while another active subscription of the SAME quote,
     billed in the same cycle, has no parts laid yet. Its own billing run lays them and bills the
     whole group then. Before: the billing code laid one subscription's parts and billed them
     before the next subscription's were there (a lay that failed was swallowed), and the quote's
     Q1 went out as the Starter alone (localhost, 29 Oct). A subscription whose parts can never be
     laid here (no start date, billed elsewhere for the period) does not hold the others back. */
  select array_agg(s2.id order by s2.created_at, s2.id) into v_unlaid
    from public.subscriptions s2
    join public.subscriptions me on me.id = v_b.subscription_id
   where me.quote_id is not null
     and s2.tenant_id = me.tenant_id and s2.quote_id = me.quote_id and s2.id <> me.id
     and s2.status = 'active'
     and s2.billing_cycle = me.billing_cycle
     and s2.billing_cycle is distinct from 'yearly'::billing_cycle
     and s2.start_date is not null
     and coalesce(s2.mrr, 0) > 0
     and (s2.billed_externally_until is null or s2.billed_externally_until < v_b.period_start)
     and not exists (select 1 from public.subscription_billings b3 where b3.subscription_id = s2.id);
  if v_unlaid is not null then
    return jsonb_build_object('action', 'waiting', 'reason', 'siblings_not_laid',
                              'subscription_ids', to_jsonb(v_unlaid));
  end if;

  select s.id, s.tenant_id, s.quote_id, s.customer_id, s.customer_name, s.plan, s.seats, s.domain,
         s.billing_cycle::text as cycle
    into v_sub from public.subscriptions s where s.id = v_b.subscription_id;
  if not found then
    raise exception 'Subscription behind billing part % no longer exists', p_billing_id using errcode = 'no_data_found';
  end if;

  /* R-2092: the group (a single part = the old behaviour). Its first part leads: a request is
     linked to it. */
  v_lines := '[]'::jsonb; v_taxable := 0; v_parts := 0; v_seats := 0;
  for v_g in select * from public.billing_part_group(p_billing_id) loop
    v_parts := v_parts + 1;
    v_ids := coalesce(v_ids, '{}'::uuid[]) || v_g.billing_id;
    v_taxable := v_taxable + v_g.taxable;
    v_seats := v_seats + coalesce(v_g.seats, 0);
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'billing_id', v_g.billing_id::text, 'plan', v_g.plan, 'seats', coalesce(v_g.seats, 0), 'taxable', v_g.taxable));
  end loop;
  if v_parts = 0 then
    v_ids := array[v_b.id]; v_taxable := v_b.taxable_amount; v_parts := 1; v_seats := coalesce(v_sub.seats, 0);
  end if;
  v_lead := v_ids[1];

  /* The group's gross, the same figure raise_subscription_billing will invoice: export → 0%. */
  select c.country, coalesce(c.invoice_parts_on_due_date, false) into v_country, v_on_due
    from public.customers c where c.id = v_sub.customer_id;
  v_rate := case when v_country is not null
                  and lower(btrim(v_country)) not in ('', 'in', 'ind', 'india', 'bharat') then 0
                 else v_b.tax_rate end;
  v_tax   := round(v_taxable * v_rate / 100.0);
  v_gross := v_taxable + v_tax;

  /* R-2095: a request already spent on an invoice that credit notes cancelled is not this period's
     request any more — its money stays in the quote's pool (instalment_credit). */
  select q.id, q.amount, q.status::text as status, q.invoice_id into v_q
    from public.quotes q where q.subscription_billing_id = any(v_ids)
     and not (q.invoice_id is not null and exists (
               select 1 from public.subscription_billings bx
                where bx.id = any(v_ids) and q.invoice_id = any(bx.credited_invoice_ids)))
   order by (q.subscription_billing_id = v_b.id) desc
   limit 1;
  v_has_q := found;
  if v_has_q then
    v_req_paid := coalesce((select sum(p.amount) from public.payments p
                             where p.quote_id = v_q.id and p.status = 'received'), 0) >= coalesce(v_q.amount, 0);
  end if;

  /* The sale quote IS the payment request of the first part of the first term. R-2048: it is
     invoiced only when money covers it (instalment_credit counts the sale quote's receipts) —
     no longer "paid by definition"; an accepted-but-unpaid sale got an unpaid tax invoice.
     R-2092: "money covers it" = the QUOTE's pool covers the GROUP — before, each subscription
     counted the sale quote's whole receipt as its own, so a short payment covered both. */
  /* R-2095: a first part whose invoice credit notes cancelled is not covered by the sale quote
     any more (that quote was spent on the cancelled invoice) — it gets its own request. */
  v_first := v_sub.quote_id is not null
             and cardinality(v_b.credited_invoice_ids) = 0
             and v_b.period_index = 1
             and v_b.term_start = (select min(b2.term_start) from public.subscription_billings b2
                                    where b2.subscription_id = v_b.subscription_id);
  v_paid_up := public.instalment_credit(v_b.subscription_id) >= v_gross;
  /* R-2095 (Sept reconcile): a sale booked from a bank receipt — its first part is invoiced on the
     first receipt even when part-paid (balance due on the invoice), like the whole-quote rule in
     bank_credit_pay_item. Staging: Suresh's half-yearly sale had money and no GST invoice. */
  v_on_rcpt := v_first and exists (
                 select 1 from public.quotes sq
                  where sq.id = v_sub.quote_id and sq.invoice_on_receipt
                    and exists (select 1 from public.payments p where p.quote_id = sq.id and p.status = 'received' and p.amount > 0));

  /* v_on_due: the customer's "Invoice on due date" switch — the old path, a tax invoice on the
     bill date even if unpaid (chased by invoice-dunning). */
  if v_req_paid or v_on_due or v_paid_up or v_on_rcpt then
    if coalesce(p_dry_run, false) then
      return jsonb_build_object('action', 'invoice', 'gross', v_gross, 'dry_run', true, 'parts', v_parts,
        'reason', case when v_req_paid then 'request_paid' when v_on_due then 'invoice_on_due_date'
                       when v_on_rcpt and not v_paid_up then 'first_receipt_of_sale' when v_first then 'first_part_of_sale' else 'already_paid' end);
    end if;
    select r.* into v_raised from public.raise_subscription_billing(v_b.id) r;
    if v_has_q and v_q.invoice_id is null then
      update public.quotes
         set invoice_id = case when v_req_paid then v_raised.invoice_id else invoice_id end,
             status = case when v_req_paid then status else 'expired'::public.quote_status end,
             notes = case when v_req_paid then notes
                          else concat_ws(E'\n', nullif(notes, ''),
                                 case when v_on_due
                                      then 'Closed: the customer is invoiced on the due date — tax invoice ' || v_raised.invoice_id || '.'
                                      else 'Closed: this part was already paid another way — tax invoice ' || v_raised.invoice_id || '.' end) end
       where id = v_q.id;
    end if;
    return jsonb_build_object('action', 'invoice', 'invoice_id', v_raised.invoice_id,
      'gross', v_raised.gross, 'already_raised', v_raised.already_raised, 'parts', v_parts);
  end if;

  if v_has_q then
    return jsonb_build_object('action', 'request_open', 'quote_id', v_q.id, 'status', v_q.status, 'gross', v_gross);
  end if;
  /* R-2048: the first part of an unpaid sale — the open sale quote is what the customer pays; no
     invoice and no second request. Paying it raises this part's invoice (credit rule above). A
     closed (rejected / expired) sale quote is not a request any more → this part gets its own. */
  if v_first then
    select q.id, q.status::text as status into v_sale
      from public.quotes q where q.id = v_sub.quote_id;
    if found and v_sale.status in ('draft', 'sent', 'viewed', 'accepted') then
      return jsonb_build_object('action', 'request_open', 'quote_id', v_sale.id, 'status', v_sale.status,
                                'gross', v_gross, 'sale_quote', true);
    end if;
  end if;
  if coalesce(p_dry_run, false) then
    return jsonb_build_object('action', 'request', 'gross', v_gross, 'dry_run', true, 'parts', v_parts);
  end if;

  v_id := public.next_document_number('quote', v_b.tenant_id);
  if v_id is null then
    raise exception 'No quote number could be issued for the payment request of billing part %. Check Settings → Document numbering.', p_billing_id;
  end if;
  /* "Advance payment for Q2 · 28 Jan–27 Apr 2027" — period_end is exclusive (schedule.ts). */
  v_period := to_char(v_b.period_start, 'FMDD Mon') || '–' || to_char(v_b.period_end - 1, 'FMDD Mon YYYY');
  v_label := 'Advance payment for '
             || case v_sub.cycle when 'quarterly' then 'Q' || v_b.period_index::text
                                 when 'half_yearly' then 'H' || v_b.period_index::text
                                 else 'month ' || v_b.period_index::text end
             || ' · ' || v_period;

  insert into public.quotes (
    id, tenant_id, customer_id, customer_name, plan, seats, amount, status, payment_status,
    domain, created_date, expires_date, line_items, subtotal, total_cost, discount_pct, tax_rate,
    is_one_off, billing_cycle, payment_terms_days, notes, subscription_billing_id
  ) values (
    v_id, v_b.tenant_id, v_sub.customer_id, v_sub.customer_name,
    case when v_parts > 1 then (select string_agg(x->>'plan', ' + ' order by n) from jsonb_array_elements(v_lines) with ordinality t(x, n))
         else v_sub.plan end,
    case when v_parts > 1 then v_seats else v_sub.seats end,
    v_gross, 'sent', 'awaiting',
    /* Prepaid: sent on the bill date (the period's first day) and due that day. No expiry — it
       stays open until it is paid or "Customer stopped". */
    v_sub.domain, public.ist_today(), null,
    /* R-2092: one line per subscription of the group, each naming its part (billing_id) — the
       group is then fixed by the request (billing_part_group). A group of one: the old line. */
    case when v_parts > 1 then
      (select jsonb_agg(jsonb_build_object(
                'id',          'part-' || v_b.period_index::text || '-' || n::text,
                'name',        v_label,
                'description', coalesce(x->>'plan', 'Subscription') || ' · ' || coalesce(x->>'seats', '0') || ' seats',
                'qty',         1,
                'rate',        (x->>'taxable')::integer,
                'cost',        0,
                'one_time',    true,
                'billing_id',  x->>'billing_id') order by n)
         from jsonb_array_elements(v_lines) with ordinality t(x, n))
    else
      jsonb_build_array(jsonb_build_object(
        'id',          'part-' || v_b.period_index::text,
        'name',        v_label,
        'description', coalesce(v_sub.plan, 'Subscription') || ' · ' || coalesce(v_sub.seats, 0)::text || ' seats',
        'qty',         1,
        'rate',        v_b.taxable_amount,
        'cost',        0,
        'one_time',    true))
    end,
    v_taxable, 0, 0, v_rate,
    true, 'yearly', 0,
    v_label || '. Due on ' || to_char(v_b.bill_on, 'FMDD Mon YYYY') || '. The tax invoice is issued when this is paid.',
    v_lead
  );
  return jsonb_build_object('action', 'request', 'quote_id', v_id, 'created', true, 'gross', v_gross, 'label', v_label, 'parts', v_parts);
end;
$$;
revoke all on function public.bill_subscription_instalment(uuid, boolean) from public, anon;
grant execute on function public.bill_subscription_instalment(uuid, boolean) to authenticated, service_role;


-- ── Receipts carry the bank line they came in on ──────────────────────────────────────────
create or replace function public.tg_bank_txn_payment_link()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  /* R-2095: a line matched to a receipt → that receipt names the line (BRS / audit). Runs after
     trg_bank_split_line_unmatched (name order), which clears the old link on a re-match. */
  if new.matched_to_type = 'payment' and new.matched_to_id ~* '^[0-9a-f-]{36}$' then
    update public.payments set bank_txn_id = new.id
     where tenant_id = new.tenant_id and id = new.matched_to_id::uuid and bank_txn_id is null;
  end if;
  return new;
end;
$$;
revoke all on function public.tg_bank_txn_payment_link() from public, anon, authenticated;

drop trigger if exists trg_bank_txn_payment_link on public.bank_transactions;
create trigger trg_bank_txn_payment_link
  after insert or update of matched_to_type, matched_to_id on public.bank_transactions
  for each row execute function public.tg_bank_txn_payment_link();

update public.payments p set bank_txn_id = t.id
  from public.bank_transactions t
 where t.matched_to_type = 'payment' and t.tenant_id = p.tenant_id
   and t.matched_to_id = p.id::text and p.bank_txn_id is null;

commit;
