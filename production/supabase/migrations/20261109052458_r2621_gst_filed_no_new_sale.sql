-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tenants' and column_name = 'gst_filed_through') and to_regprocedure('public.gst_filed_days(uuid,date[])') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.gst_filed_why(uuid,date)') and prosrc like '%R-2621%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.set_gst_filed_through(date)') and prosrc like '%R-2621%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.bank_credit_new_sale_quote(uuid,uuid,jsonb,text)') and prosrc like '%R-2621%') and exists(select 1 from pg_trigger where tgname = 'r2621_gst_filed_through_guard' and tgrelid = to_regclass('public.tenants'))
-- deploy-key: r2621gstfilednonewsale
-- 20261109052458_r2621_gst_filed_no_new_sale.sql
--
-- R-2621 (9 Nov 2026, p0 money, G-FY2526 D2 + D7): Reconcile from Zoho was about to book ~69 brand-new
-- 18% GST sales on bank lines of months whose GST returns are already filed (FY 2025-26, and Apr-Sep 2026
-- - Pardeep's decisions of 6 Nov). A new sale is dated on the bank line's day, so it changes a filed
-- GSTR-1 / 3B and counts the revenue twice (the sale is already in Zoho's filed return).
--
--   1. tenants.gst_filed_through (date, null = not set) - "GST returns filed up to" the end of that month.
--      The OWNER sets it (Accounting → Overview → GST returns filed up to) through set_gst_filed_through():
--      stored as the month's last day; a month that has not ended yet is refused; NULL clears; one
--      activity_log row per change (gst.filed_through_set). r2621_gst_filed_through_guard: a direct table
--      write (tenants_self_update) cannot change it.
--   2. gst_filed_why(tenant, day) / gst_month_filed(tenant, day) - the ONE rule "is this day's GST already filed" (and why): on or
--      before gst_filed_through, or on or before books_locked_until, or GSTR-1 of its month (or of its FY
--      quarter, QRMP) is marked filed in the existing register (compliance_log gst_gstr1 /
--      month_close_checks gstr1_filed). gst_filed_refusal(tenant, day) = the plain message, null when open.
--      gst_filed_days(tenant, days[]) = which of those days are filed (Reconcile from Zoho's plan reads it
--      through the server's admin client). All four: service_role + definer callers only; gst_filed_why also refuses
--      another company's id for a signed-in login (§17c tenant gate).
--   3. bank_credit_new_sale_quote (latest body 20261107233022_r2193_flex_with_one_time) - the one quote
--      maker of every NEW sale from a bank credit (reconcile_bank_credit_new_sale 10/11 args,
--      reconcile_bank_credit_new_sale_fx, reconcile_bank_credit_split with p_sale, and the below-cost
--      bank_sale_park_for_approval) - refuses when the bank line's day is GST-filed. Paying an EXISTING
--      invoice (an imported Zoho sale, R-2542's bank_credit_pay_item) is not touched: it changes no GST.
--      No other change in its body.
-- Not changed: invoices already booked (no data repair). Test: supabase/tests/r2621_gst_filed_no_new_sale.test.sql

begin;

-- -- 1. The setting ----------------------------------------------------------------------------------
alter table public.tenants add column if not exists gst_filed_through date;

comment on column public.tenants.gst_filed_through is
  'R-2621: GST returns (GSTR-1 / 3B) are filed up to the end of this month (stored as the month''s last day). NULL = not set. Written only by set_gst_filed_through() (owner). Read through gst_month_filed().';

-- -- 2. The one rule ---------------------------------------------------------------------------------
create or replace function public.gst_filed_why(p_tenant_id uuid, p_day date)
returns text
language plpgsql
stable
security definer
set search_path = public
as $function$
/* R-2621: WHY the day's GST is final (null = open) - the setting, the books lock, or GSTR-1 of its month /
   FY quarter marked filed. FY quarter key as the Compliance Calendar's QRMP GSTR-1: '<FY start year>-q<1..4>'
   (Apr-Jun = q1). Tenant gate (§17c): a login only asks about its own company. */
declare
  v_caller uuid := public.current_tenant_id();
  v_t      record;
  v_fy     text;
begin
  if p_day is null or p_tenant_id is null then return null; end if;
  if v_caller is not null and v_caller is distinct from p_tenant_id then
    raise exception 'Not your company' using errcode = '42501';
  end if;
  select t.gst_filed_through, t.books_locked_until into v_t from public.tenants t where t.id = p_tenant_id;
  if v_t.gst_filed_through is not null and p_day <= v_t.gst_filed_through then
    return 'GST returns are filed up to ' || to_char(v_t.gst_filed_through, 'FMMonth YYYY') || ' (Accounting → Overview → GST returns filed up to)';
  end if;
  if v_t.books_locked_until is not null and p_day <= v_t.books_locked_until then
    return 'the books are locked up to ' || to_char(v_t.books_locked_until, 'FMDD Mon YYYY') || ' (Accounting → Overview → Lock books)';
  end if;
  v_fy := (extract(year from p_day)::int - case when extract(month from p_day) < 4 then 1 else 0 end)::text
          || '-q' || (((extract(month from p_day)::int + 8) % 12) / 3 + 1)::text;
  if exists (select 1 from public.compliance_log c
              where c.tenant_id = p_tenant_id and c.obligation_key = 'gst_gstr1'
                and c.period_key in (to_char(p_day, 'YYYY-MM'), v_fy))
     or exists (select 1 from public.month_close_checks m
                 where m.tenant_id = p_tenant_id and m.key = 'gstr1_filed' and m.period = to_char(p_day, 'YYYY-MM')) then
    return 'GSTR-1 for ' || to_char(p_day, 'FMMon YYYY') || ' is marked filed (Compliance Calendar / Month close)';
  end if;
  return null;
end;
$function$;

comment on function public.gst_filed_why(uuid, date) is
  'R-2621: why the day''s GST is already filed (null = open) - on/before tenants.gst_filed_through or books_locked_until, or GSTR-1 of its month / FY quarter marked filed (compliance_log gst_gstr1, month_close_checks gstr1_filed). A login may ask only about its own company.';

revoke all on function public.gst_filed_why(uuid, date) from public, anon, authenticated;
grant execute on function public.gst_filed_why(uuid, date) to service_role;

create or replace function public.gst_month_filed(p_tenant_id uuid, p_day date)
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
  /* R-2621: the ONE rule - the day's GST is final (gst_filed_why, which holds the tenant gate). */
  select public.gst_filed_why(p_tenant_id, p_day) is not null;
$function$;

revoke all on function public.gst_month_filed(uuid, date) from public, anon, authenticated;
grant execute on function public.gst_month_filed(uuid, date) to service_role;

create or replace function public.gst_filed_refusal(p_tenant_id uuid, p_day date)
returns text
language sql
stable
security definer
set search_path = public
as $function$
  /* R-2621: the plain refusal for a new sale on a GST-filed day, naming why; null = the month is open. */
  select 'GST for ' || to_char(p_day, 'FMMon YYYY') || ' is already filed (' || w || '), so a new sale on '
         || to_char(p_day, 'FMDD Mon YYYY') || ' would change a filed return. If this money pays a Zoho invoice, import that invoice '
         || '(Invoices → FY sales from Zoho) and pay it; otherwise reconcile this line by hand.'
    from (select public.gst_filed_why(p_tenant_id, p_day) as w) x
   where x.w is not null;
$function$;

revoke all on function public.gst_filed_refusal(uuid, date) from public, anon, authenticated;
grant execute on function public.gst_filed_refusal(uuid, date) to service_role;

create or replace function public.gst_filed_days(p_tenant_id uuid, p_days date[])
returns date[]
language sql
stable
security definer
set search_path = public
as $function$
  /* R-2621: which of these days are GST-filed (Reconcile from Zoho's plan, server admin client). */
  select coalesce(array_agg(distinct u.d order by u.d), array[]::date[])
    from unnest(coalesce(p_days, array[]::date[])) as u(d)
   where public.gst_month_filed(p_tenant_id, u.d);
$function$;

revoke all on function public.gst_filed_days(uuid, date[]) from public, anon, authenticated;
grant execute on function public.gst_filed_days(uuid, date[]) to service_role;

-- -- 1b. The owner sets it ---------------------------------------------------------------------------
create or replace function public.set_gst_filed_through(p_month date)
returns date
language plpgsql
volatile
security definer
set search_path = public
as $function$
declare
  /* R-2621 */
  v_tenant  uuid := public.current_tenant_id();
  v_current date;
  v_new     date;
begin
  if v_tenant is null then
    raise exception 'Sign in to your company to change the GST filed month.' using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner') then
    raise exception 'Only the owner can change the month GST returns are filed up to.' using errcode = '42501';
  end if;

  v_new := case when p_month is null then null
                else (date_trunc('month', p_month) + interval '1 month' - interval '1 day')::date end;
  if v_new is not null and v_new >= date_trunc('month', public.ist_today())::date then
    raise exception 'GST for % cannot be filed yet - that month has not ended. Pick % or earlier.',
      to_char(v_new, 'FMMon YYYY'), to_char(date_trunc('month', public.ist_today()) - interval '1 day', 'FMMon YYYY')
      using errcode = '22023';
  end if;

  select t.gst_filed_through into v_current from public.tenants t where t.id = v_tenant for update;
  if v_new is not distinct from v_current then
    return v_new;
  end if;

  update public.tenants set gst_filed_through = v_new where id = v_tenant;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, auth.uid(), 'gst.filed_through_set', 'tenant', v_tenant::text,
          case when v_new is null then 'GST filed month cleared'
               else 'GST returns filed up to ' || to_char(v_new, 'FMMon YYYY') end,
          jsonb_build_object('gst_filed_through', jsonb_build_object('old', v_current, 'new', v_new)));

  return v_new;
end;
$function$;

comment on function public.set_gst_filed_through(date) is
  'R-2621: the owner sets (or clears with NULL) the month GST returns are filed up to; stored as that month''s last day; a month not yet ended is refused; logs gst.filed_through_set.';

revoke all on function public.set_gst_filed_through(date) from public, anon;
grant execute on function public.set_gst_filed_through(date) to authenticated, service_role;

create or replace function public.r2621_gst_filed_through_guard()
returns trigger
language plpgsql
set search_path = public
as $function$
begin
  /* R-2621: only set_gst_filed_through() (SECURITY DEFINER) or the server changes it. */
  if public.is_direct_request_login()
     and new.gst_filed_through is distinct from old.gst_filed_through then
    raise exception 'The GST filed month is changed only from Accounting → Overview → GST returns filed up to (owner).'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;

revoke all on function public.r2621_gst_filed_through_guard() from public, anon, authenticated;

drop trigger if exists r2621_gst_filed_through_guard on public.tenants;
create trigger r2621_gst_filed_through_guard
  before update of gst_filed_through on public.tenants
  for each row execute function public.r2621_gst_filed_through_guard();

-- -- 3. No new sale from a bank line of a GST-filed month (body from 20261107233022_r2193) ------------
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
   stored FIRST, since every screen reads the quote's term off line 1.
   R-2621: no new sale from a bank line of a GST-filed month (gst_filed_refusal) - before anything is written. */
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
  v_problem := public.gst_filed_refusal(v_txn.tenant_id, v_txn.txn_date);   -- R-2621
  if v_problem is not null then
    raise exception '%', v_problem using errcode = 'check_violation';
  end if;

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

commit;
