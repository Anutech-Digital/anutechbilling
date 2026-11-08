-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.quote_line_terms_mixed(jsonb)') and prosrc like '%R-2193%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.bank_credit_new_sale_quote(uuid,uuid,jsonb,text)') and prosrc like '%R-2193%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.quote_split_due(text,date,date)') and prosrc like '%R-2193%')
-- deploy-key: r2193flexwithonetime
-- 20261107233022_r2193_flex_with_one_time.sql
--
-- R-2193 (G-ZOHO, Zoho Books audit 31 Oct 2026; R-2095 gaps 30 Oct item 2): one bank credit paid for a
-- Monthly flex plan AND a one-time line (domain / setup), and we booked TWO sales. R-381's one-term rule
-- (20261007160000) is about units - a flex line is priced per MONTH, an annual line per YEAR - but its
-- helper quote_line_terms_mixed counted every line without a monthly commitment as annual, so a
-- one-time line (one_time: true, no commitment - R-1688) next to Monthly flex was refused too.
-- A one-time line has no billing term: it is billed once, on the sale's first part (R-2095,
-- 20261030153513 quote_one_time_lines / raise_subscription_billing), and later months carry the
-- seats only. So:
--   1. quote_line_terms_mixed ignores one-time lines (one_time: true or commitment 'one_time').
--      Monthly flex + annual is still mixed (refused); a line with no commitment and no one_time flag
--      still counts as annual (the column default), as before.
--   2. bank_credit_new_sale_quote (latest body 20261105190824_r2515_sez_zero_rated) stores the
--      recurring lines BEFORE the one-time lines: every screen reads the quote's term off line 1
--      (quote_split_due, instalments.ts firstLineCommitment, the quote page / PDF), so a domain typed
--      first must not make a Monthly flex sale look like a 12-part annual one - only on a sale WITH
--      Monthly flex lines; any other sale keeps the typed order (Zoho mirrors). Also the rate check's
--      dot is literal now. No other change in its body.
--   3. quote_split_due reads the term off the first RECURRING line (one-time lines skipped), so a flex
--      quote saved with its one-time line first (builder / API / combine) is still never split.
-- Test: supabase/tests/r2193_flex_with_one_time.test.sql (begin ... rollback; red without this file).

begin;

-- -- 1. One-time lines have no billing term ------------------------------------------------------
create or replace function public.quote_line_terms_mixed(p_lines jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  /* R-381: a monthly flex line AND an annual line (missing commitment = annual).
     R-2193: a one-time line (one_time: true or commitment 'one_time') is billed once and has no
     term, so it never makes a quote mixed. */
  select case
    when p_lines is null or jsonb_typeof(p_lines) <> 'array' then false
    else exists (select 1 from jsonb_array_elements(p_lines) e
                  where jsonb_typeof(e) = 'object' and e->>'commitment' = 'monthly')
     and exists (select 1 from jsonb_array_elements(p_lines) e
                  where jsonb_typeof(e) = 'object'
                    and coalesce(e->>'commitment', 'annual_yearly') not in ('monthly', 'one_time')
                    and lower(coalesce(e->>'one_time', '')) <> 'true')
  end;
$$;

comment on function public.quote_line_terms_mixed(jsonb) is
  'R-381/R-2193: true when a quote''s line_items hold a monthly flex line AND an annual line (missing commitment = annual; one-time lines have no term).';

-- Grants as 20261007250000_quote_terms_fn_grant (create or replace keeps them; restated for a fresh DB).
grant execute on function public.quote_line_terms_mixed(jsonb) to authenticated, service_role;

-- -- 2. The bank receipt's new sale: recurring lines first ---------------------------------------
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
   a subscription line keeps its own end-domain.
   R-2515: an SEZ unit supplied WITHOUT payment of tax is zero-rated like an export
   (public.supply_is_zero_rated); its 0% invoice needs the LUT of its FY (tg_invoice_export_needs_lut).
   R-2193: Monthly flex may sit beside one-time lines (quote_line_terms_mixed); the recurring lines are
   stored FIRST, since every screen reads the quote's term off line 1. */
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

  select c.id, c.name, c.country, c.gst_treatment, c.tenant_id into v_cust from public.customers c where c.id = p_customer_id;
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
                 or coalesce(li->>'rate', '') !~ '^[0-9]+([.][0-9]{1,2})?$'   -- R-2193: a literal dot ("12x5" got the raw numeric error)
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
  v_export := public.supply_is_zero_rated(v_cust.country, v_cust.gst_treatment);   -- R-2515: export or SEZ without payment
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
           -- R-2193: on a Monthly flex sale the recurring lines go first; any other sale keeps the typed order
           order by (v_monthly and coalesce(li->>'commitment', 'one_time') = 'one_time'), ord)
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

-- -- 3. quote_split_due: the term is read off the first RECURRING line ------------------------------
-- Body from 20261009235800_split_billed_outstanding (the only definition; r715 changed grants only).
-- A Monthly flex quote is never split (its stored figures are one month); before, only line 1 was
-- read, so a one-time line saved first (any writer other than the bank sale) made a flex quote look
-- like an annual one billed monthly - 12 parts of the total. TS twin: instalments.ts firstLineCommitment.
create or replace function public.quote_split_due(p_quote_id text, p_term_start date, p_as_of date)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_q         record;
  v_months    integer;
  v_count     integer;
  v_taxable   integer;
  v_per       integer;
  v_rem       integer;
  v_t         integer;
  v_due       integer := 0;
  v_rate      integer;
  i           integer;
begin
  select q.tenant_id, q.subtotal, q.discount_pct, q.tax_rate, q.amount, q.billing_cycle, q.line_items
    into v_q
    from public.quotes q
   where q.id = p_quote_id;
  if not found then return null; end if;

  if public.current_tenant_id() is not null and v_q.tenant_id is distinct from public.current_tenant_id() then
    return null;
  end if;

  -- flex term line: stored figures are already one month, nothing to split.
  -- R-2193: the first line that is not one-time (one_time: true / commitment 'one_time') sets the term.
  if jsonb_typeof(v_q.line_items) = 'array'
     and (select e->>'commitment'
            from jsonb_array_elements(v_q.line_items) with ordinality t(e, ord)
           where jsonb_typeof(e) = 'object'
             and coalesce(e->>'commitment', '') <> 'one_time'
             and lower(coalesce(e->>'one_time', '')) <> 'true'
           order by ord limit 1) = 'monthly' then
    return null;
  end if;

  v_months := case v_q.billing_cycle
                when 'monthly' then 1 when 'quarterly' then 3 when 'half_yearly' then 6
                else null end;
  if v_months is null then return null; end if;
  if coalesce(v_q.amount, 0) <= 0 then return null; end if;

  v_taxable := round(coalesce(v_q.subtotal, 0))::int;
  v_taxable := v_taxable - round(v_taxable * coalesce(v_q.discount_pct, 0) / 100.0)::int;
  if v_taxable <= 0 then return null; end if;

  v_count := ceil(12.0 / v_months)::int;
  if v_count <= 1 then return null; end if;
  v_per  := floor(v_taxable::numeric / v_count)::int;
  v_rem  := v_taxable - v_per * v_count;
  v_rate := coalesce(v_q.tax_rate, 18);

  for i in 0 .. v_count - 1 loop
    exit when i > 0 and (p_term_start + make_interval(months => i * v_months))::date > p_as_of;
    v_t   := v_per + case when i = v_count - 1 then v_rem else 0 end;
    v_due := v_due + v_t + round(v_t * v_rate / 100.0)::int;
  end loop;
  return v_due;
end;
$$;
-- Grants as 20261011072600_r715_definers_tenant (service_role only); restated for a fresh DB.
revoke execute on function public.quote_split_due(text, date, date) from public, anon, authenticated;
grant execute on function public.quote_split_due(text, date, date) to service_role;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_runtime') then
    execute 'grant execute on function public.quote_line_terms_mixed(jsonb) to app_runtime';
  end if;
  if exists (select 1 from pg_roles where rolname = 'app_jobs') then
    execute 'grant execute on function public.quote_line_terms_mixed(jsonb) to app_jobs';
  end if;
end $$;

commit;
