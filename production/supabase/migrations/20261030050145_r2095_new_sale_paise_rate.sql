-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.bank_credit_new_sale_quote(uuid,uuid,jsonb,text)') and prosrc like '%R-2095%')
-- deploy-key: r2095newsalepaiserate
-- 20261030050145_r2095_new_sale_paise_rate.sql
--
-- R-2095 (30 Oct 2026, staging reconcile): Reconcile → "A new sale" refused a paise unit price
-- ("a whole-rupee unit price") and the screen rounded it — Zoho bills ₹103.5 and ₹1,347.5 a seat, so
-- the sale never matched the bank line. A line's rate now keeps up to two decimals; the subtotal is
-- qty × rate summed and rounded to the rupee ONCE (the invoice is in rupees; lib/banking/credit-pay-for
-- salePreview adds the same way). Body of 20261029054707 (R-2098), the latest definition; only the
-- rate check, the line's rate and the subtotal change.
-- Test: supabase/tests/r2095_new_sale_paise_rate.test.sql

begin;

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
   R-2095: unit prices keep paise (Zoho rates ₹103.5, ₹1,347.5); the subtotal is rounded once. */
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
             'one_time',   case when coalesce(li->>'commitment', 'one_time') = 'one_time' then true end))
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
    line_items, status, payment_status, is_one_off, billing_cycle, created_date, notes
  ) values (
    v_qid, v_txn.tenant_id, p_customer_id, v_cust.name, v_lines->0->>'name', v_seats,
    v_gross, v_subtotal, v_rate, 0,
    v_lines, 'accepted', 'awaiting', not (v_monthly or v_annual), v_cycle,
    public.ist_today(), 'Sale booked from a bank receipt of ' || to_char(v_txn.txn_date, 'DD Mon YYYY')
  );

  return jsonb_build_object('quote_id', v_qid, 'quote_total', v_gross, 'tax_rate', v_rate);
end;
$$;
revoke all on function public.bank_credit_new_sale_quote(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.bank_credit_new_sale_quote(uuid, uuid, jsonb, text) to service_role;

commit;
