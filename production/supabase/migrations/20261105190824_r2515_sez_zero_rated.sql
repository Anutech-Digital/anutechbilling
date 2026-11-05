-- deploy-peek: to_regprocedure('public.supply_is_zero_rated(text,text)') is not null and exists (select 1 from pg_proc where proname = 'bank_credit_new_sale_quote' and prosrc like '%R-2515%') and exists (select 1 from pg_proc where proname = 'tg_invoice_export_needs_lut' and prosrc like '%R-2515%')
-- deploy-key: r2515sezzerorated
--
-- R-2515 (5 Nov 2026, p1 money) — a supply to an SEZ unit WITHOUT payment of tax is zero-rated (0% GST)
-- under the LUT of its date's FY, like an export (IGST Act s.16(1)(b), s.16(3)(a)).
--
-- THE HOLE (R-2094 needsDecision, May run): an SEZ customer with a Haryana GSTIN paid ₹55,223 against a
--   Zoho invoice at 0% GST. R-1736 / R-1742 gave customers the treatment "SEZ (without payment)", but every
--   path still billed it IGST 18% (LUT_ZERO_RATING_PENDING) — the bank receipt's "A new sale"
--   (bank_credit_new_sale_quote) zero-rated only a customer abroad, so the line could not be booked as Zoho had it.
--
-- WHAT THIS DOES
--   1. supply_is_zero_rated(country, treatment): true for a customer outside India (export) or the
--      treatment sez_without_payment. TS twin: isZeroRatedSupply in src/lib/gst/place-of-supply.ts.
--      SEZ WITH payment stays IGST at the normal rate.
--   2. invoice_zero_rated_under_lut(kind, treatment, country, tax_amount, tax_rate): a 0% Tax Invoice
--      that relies on an LUT — an export (R-2444's rule) OR a 0% invoice to an SEZ-without-payment customer.
--   3. bank_credit_new_sale_quote (latest body 20261030123423_r2095_sale_invoice_on_receipt) zero-rates
--      by supply_is_zero_rated — the only change in its body. Its callers (reconcile_bank_credit_new_sale,
--      the split, the fx sale) are unchanged. create_direct_invoice (latest body R-1643 20261023192418)
--      uses the same rule.
--   4. tg_invoice_export_needs_lut (latest body R-2444 20261104023601): the LUT check also covers a 0% SEZ
--      invoice, on every path (bank sale, quote → invoice, instalments, direct); the refusal names the SEZ.
--   5. delete_tenant_lut and tg_tenants_lut_to_fy (latest bodies R-2444): an LUT that 0% SEZ invoices of
--      its FY rely on is kept, like one export invoices rely on.
-- Test: supabase/tests/r2515_sez_zero_rated.test.sql (begin … rollback; red without this file).

begin;

-- ── 1. The rule ────────────────────────────────────────────────────────────────────────────────
create or replace function public.supply_is_zero_rated(p_country text, p_treatment text)
returns boolean
language sql
immutable
set search_path = public
as $$
  /* R-2515. Empty country = India (the conservative reading of isExportSupply). */
  select coalesce(nullif(lower(btrim(p_country)), ''), 'india') not in ('india', 'in', 'ind', 'bharat')
         or coalesce(p_treatment = 'sez_without_payment', false)
$$;
comment on function public.supply_is_zero_rated(text, text) is
  'R-2515: true when a supply to this customer is zero-rated — outside India (export) or an SEZ unit supplied without payment of tax. TS twin: isZeroRatedSupply (src/lib/gst/place-of-supply.ts).';
revoke all on function public.supply_is_zero_rated(text, text) from public, anon;
grant execute on function public.supply_is_zero_rated(text, text) to authenticated, service_role;

create or replace function public.invoice_zero_rated_under_lut(
  p_kind text, p_treatment text, p_country text, p_tax_amount numeric, p_tax_rate numeric)
returns boolean
language sql
immutable
set search_path = public
as $$
  /* R-2515: a 0% Tax Invoice that relies on the LUT — an export (R-2444: treatment overseas or a country
     outside India) or a supply to an SEZ unit without payment of tax. Charging GST never needs one. */
  select p_kind is not distinct from 'tax_invoice'
         and coalesce(p_tax_amount, 0) = 0 and coalesce(p_tax_rate, 0) = 0
         and (p_treatment is not distinct from 'overseas' or public.supply_is_zero_rated(p_country, p_treatment))
$$;
revoke all on function public.invoice_zero_rated_under_lut(text, text, text, numeric, numeric) from public, anon;
grant execute on function public.invoice_zero_rated_under_lut(text, text, text, numeric, numeric) to authenticated, service_role;

-- ── 2. The bank receipt's "A new sale" (from 20261030123423_r2095_sale_invoice_on_receipt) ───────
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
   (public.supply_is_zero_rated); its 0% invoice needs the LUT of its FY (tg_invoice_export_needs_lut). */
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

-- ── 2b. A direct invoice (Invoices → New, from 20261023192418_r1643_tax_invoice_needs_supplier_gstin) ──
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
  v_r1643_problem text;
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

  select c.id, c.name, c.country, c.gst_treatment, c.tenant_id into v_cust
    from public.customers c where c.id = p_customer_id;
  if not found then raise exception 'Customer not found'; end if;
  if not v_is_svc and v_cust.tenant_id is distinct from v_tenant then
    raise exception 'Customer is not in the caller''s tenant';
  end if;
  v_tenant := v_cust.tenant_id;

  /* R-1643: refuse before any number is taken (generate_invoice checks again). */
  v_r1643_problem := public.supplier_invoice_problem(v_tenant, public.ist_today());
  if v_r1643_problem is not null then
    raise exception '%', v_r1643_problem using errcode = 'check_violation';
  end if;

  /* R-2515: an export OR an SEZ unit supplied without payment of tax is zero-rated (LUT checked on the invoice). */
  v_export := public.supply_is_zero_rated(v_cust.country, v_cust.gst_treatment);
  /* R-1529: no GST on a Bill of Supply — a business that is not GST-registered (or is under
     composition) cannot charge it. 0 here, so the direct invoice becomes a Bill of Supply
     instead of being refused by tg_invoice_document_kind. */
  v_rate := case
              when v_export then 0
              when public.supplier_gst_status(v_tenant, public.ist_today()) in ('unregistered', 'composition') then 0
              else 18
            end;

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
$function$;

-- ── 3. Every 0% export OR SEZ-without-payment invoice needs the LUT of its date's FY (from R-2444) ─
create or replace function public.tg_invoice_export_needs_lut()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_msg text;
  v_sez boolean;
begin
  /* R-2444. Runs after trg_invoice_document_kind and trg_invoice_snapshot_parties (name order), so
     document_kind, gst_treatment and customer_country are already set. An export = treatment
     'overseas' OR a customer country outside India (generate_invoice decides 0% on the country, and a
     customer whose country changed may still carry an old treatment). GST charged → no LUT needed.
     R-2515: a 0% invoice to an SEZ unit without payment of tax needs the same LUT; the refusal says SEZ. */
  if not public.invoice_zero_rated_under_lut(new.document_kind::text, new.gst_treatment, new.customer_country,
                                             new.tax_amount, new.tax_rate)
     or coalesce(new.taxable_value, new.amount, 0) <= 0 then
    return new;
  end if;
  v_msg := public.export_lut_refusal(new.tenant_id, coalesce(new.invoice_date, public.ist_today()));
  if v_msg is not null then
    /* An SEZ supply, not an export (the customer is in India). The words come from export_lut_refusal
       (R-2444); if they are ever reworded the refusal still stops the invoice, only it says "export". */
    v_sez := new.gst_treatment is not distinct from 'sez_without_payment'
             and not public.supply_is_zero_rated(new.customer_country, null);
    if v_sez then
      v_msg := replace(replace(v_msg,
                 'An export sale at 0% GST', 'A supply to an SEZ unit without payment of tax (0% GST)'),
                 'An export at 0% GST', 'A supply to an SEZ unit without payment of tax (0% GST)');
    end if;
    raise exception '%', v_msg using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function public.tg_invoice_export_needs_lut() from public, anon, authenticated;

-- ── 4. An LUT that 0% SEZ invoices rely on is kept too (from R-2444) ─────────────────────────────
create or replace function public.delete_tenant_lut(p_fy_start date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_t  uuid := public.current_tenant_id();
  v_fy date := public.lut_fy_start(p_fy_start);
  v_n  int;
begin
  if v_t is null then raise exception 'No company on this login — sign in again.' using errcode = '28000'; end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or an accountant can change the company''s LUT.' using errcode = '42501';
  end if;
  /* R-2515: export OR SEZ-without-payment 0% invoices of that FY rely on it (the count includes both;
     the words stay R-2444's, which its test and the Settings toast match). */
  select count(*) into v_n from public.invoices i
   where i.tenant_id = v_t
     and public.invoice_zero_rated_under_lut(i.document_kind::text, i.gst_treatment, i.customer_country, i.tax_amount, i.tax_rate)
     and i.invoice_date >= v_fy and i.invoice_date < (v_fy + interval '1 year')::date;
  if v_n > 0 then
    raise exception '% export invoice(s) of FY % were issued at 0%% GST under this LUT — correct its ARN or dates instead of deleting it.',
      v_n, public.lut_fy_label(v_fy) using errcode = 'check_violation';
  end if;
  delete from public.tenant_luts where tenant_id = v_t and fy_start = v_fy;
  perform public.tenant_lut_mirror(v_t);
end;
$$;
revoke all on function public.delete_tenant_lut(date) from public, anon;
grant execute on function public.delete_tenant_lut(date) to authenticated, service_role;

create or replace function public.tg_tenants_lut_to_fy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_arn text; v_new_arn text;
begin
  if coalesce(current_setting('app.r2444_lut_mirror', true), '') = 'on' then
    return new;
  end if;
  v_new_arn := nullif(btrim(coalesce(new.lut_number, '')), '');
  if tg_op = 'UPDATE' then
    if new.lut_number is not distinct from old.lut_number and new.lut_valid_upto is not distinct from old.lut_valid_upto then
      return new;
    end if;
    v_old_arn := nullif(btrim(coalesce(old.lut_number, '')), '');
    /* Not when 0% export / SEZ (R-2515) invoices of that FY rely on it (delete_tenant_lut's rule) — then it stays. */
    if v_old_arn is not null and old.lut_valid_upto is not null
       and not exists (select 1 from public.invoices i
                        where i.tenant_id = new.id
                          and public.invoice_zero_rated_under_lut(i.document_kind::text, i.gst_treatment, i.customer_country, i.tax_amount, i.tax_rate)
                          and i.invoice_date >= public.lut_fy_start(old.lut_valid_upto)
                          and i.invoice_date < (public.lut_fy_start(old.lut_valid_upto) + interval '1 year')::date) then
      delete from public.tenant_luts
       where tenant_id = new.id and fy_start = public.lut_fy_start(old.lut_valid_upto) and arn = v_old_arn;
    end if;
  end if;
  if v_new_arn is not null and new.lut_valid_upto is not null and length(v_new_arn) <= 40 then
    insert into public.tenant_luts (tenant_id, fy_start, arn, valid_from, valid_upto)
    values (new.id, public.lut_fy_start(new.lut_valid_upto), v_new_arn, public.lut_fy_start(new.lut_valid_upto), new.lut_valid_upto)
    on conflict (tenant_id, fy_start) do update
      set arn = excluded.arn, valid_upto = excluded.valid_upto,
          valid_from = least(public.tenant_luts.valid_from, excluded.valid_upto), updated_at = now();
  end if;
  return new;
end;
$$;
revoke all on function public.tg_tenants_lut_to_fy() from public, anon, authenticated;

commit;
