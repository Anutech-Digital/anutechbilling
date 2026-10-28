-- deploy-peek: to_regprocedure('public.reconcile_bank_credit_new_sale(uuid,uuid,jsonb,boolean,date,date,integer,numeric,text,text)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.relink_bank_one_off_sale(uuid,jsonb)') and prosrc like '%R-2026%')
-- deploy-key: r2026newsalebillingcycle
-- 20261028020622_r2026_new_sale_billing_cycle.sql
--
-- R-2026 (28 Oct 2026, Pardeep): Banking → Reconcile → "A new sale" had its own simple
-- "Billing: Yearly / Monthly / One-time". Google Workspace prices follow the COMMITMENT (annual
-- vs monthly flex) and customers on an annual commitment pay yearly, half-yearly, quarterly or
-- monthly. The sheet now asks Commitment first, then Payment — the quote builder's own pair:
-- a line's `commitment` (price tier) and the quote's `billing_cycle` (how often it is billed).
--
-- ─── WHAT CHANGES — no new money RPC, no new money rule ─────────────────────────────────
--   reconcile_bank_credit_new_sale gains p_billing_cycle (default null = the old behaviour):
--     · a Monthly-flex line                → 'monthly' (a no-commitment plan bills monthly only;
--                                            anything else asked for is refused)
--     · an annual-commitment sale           → the chosen cycle: yearly / half_yearly / quarterly /
--                                            monthly (null → yearly, as before)
--     · one-time only                       → yearly (nothing is split)
--   and writes it on the quote. Everything after that is the existing split-billing path
--   (R-370 / R-527 / R-806..808): subscription_cycle_follows_quote copies the cycle onto the
--   subscription, record_payment files it, split_billed_outstanding keeps only the due
--   instalments as outstanding, reconcile_bank_credit_to_item does not raise a whole-term
--   invoice for a split-billed quote (reject_full_term_invoice_when_split_billed), and the
--   sheet asks raise-instalments for the first period's tax invoice — the Record payment
--   sheet's own call. Renewal and term follow the commitment (record_payment, unchanged).
--   relink_bank_one_off_sale passes target.billing_cycle through to it.
--
-- The old 9-argument signature is dropped (one function, one way; PostgREST would otherwise see
-- two candidates for the same named call).
-- Test: supabase/tests/r2026_new_sale_billing_cycle.test.sql

begin;

drop function if exists public.reconcile_bank_credit_new_sale(uuid, uuid, jsonb, boolean, date, date, integer, numeric, text);

create or replace function public.reconcile_bank_credit_new_sale(
  p_txn_id              uuid,
  p_customer_id         uuid,
  p_lines               jsonb,
  p_create_subscription boolean default true,
  p_sub_start           date    default null,
  p_sub_renewal         date    default null,
  p_tds_amount          integer default 0,
  p_tds_rate_pct        numeric default null,
  p_tds_section         text    default null,
  p_billing_cycle       text    default null   -- R-2026: yearly | half_yearly | quarterly | monthly
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cycle    text;
  v_caller   uuid;
  v_trusted  boolean;
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
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can reconcile a bank receipt' using errcode = '42501';
  end if;

  select t.id, t.tenant_id, t.credit, t.txn_date, t.matched_to_type into v_txn
    from public.bank_transactions t where t.id = p_txn_id;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;
  if v_caller is not null and v_txn.tenant_id is distinct from v_caller then
    raise exception 'This bank line is not in your company' using errcode = '42501';
  end if;

  select c.id, c.name, c.country, c.tenant_id into v_cust from public.customers c where c.id = p_customer_id;
  if not found or v_cust.tenant_id is distinct from v_txn.tenant_id then
    raise exception 'Customer not found in your company' using errcode = 'no_data_found';
  end if;

  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Add what was sold — at least one product line.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_lines) li
              where jsonb_typeof(li) <> 'object'
                 or nullif(btrim(coalesce(li->>'name', '')), '') is null
                 or coalesce(li->>'qty', '') !~ '^[0-9]+$' or (li->>'qty')::int <= 0
                 or coalesce(li->>'rate', '') !~ '^[0-9]+$'
                 or coalesce(li->>'commitment', 'one_time') not in ('annual_yearly', 'monthly', 'one_time')) then
    raise exception 'Every line needs a product, seats / quantity of at least 1 and a whole-rupee unit price.' using errcode = '22023';
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
             'rate',       (li->>'rate')::int,
             'cost',       coalesce(case when coalesce(li->>'cost', '') ~ '^[0-9]+$' then (li->>'cost')::int end, 0),
             'commitment', case when li->>'commitment' in ('annual_yearly', 'monthly') then li->>'commitment' end,
             'one_time',   case when coalesce(li->>'commitment', 'one_time') = 'one_time' then true end))
           order by ord)
    into v_lines
    from jsonb_array_elements(p_lines) with ordinality as t(li, ord);

  select coalesce(sum((li->>'qty')::int * (li->>'rate')::int), 0) into v_subtotal
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

  return public.reconcile_bank_credit_to_item(
           p_txn_id, v_qid, null, p_tds_amount, p_tds_rate_pct, p_tds_section,
           p_create_subscription, p_sub_start, p_sub_renewal)
         || jsonb_build_object('new_quote', true, 'quote_total', v_gross, 'tax_rate', v_rate);
end;
$$;

revoke all on function public.reconcile_bank_credit_new_sale(uuid, uuid, jsonb, boolean, date, date, integer, numeric, text, text) from public, anon;
grant execute on function public.reconcile_bank_credit_new_sale(uuid, uuid, jsonb, boolean, date, date, integer, numeric, text, text) to authenticated, service_role;

-- ── 4. relink_bank_one_off_sale ─────────────────────────────────────────────
-- p_target: {"path":"item","quote_id"|"invoice_id",…tds/subscription…}
--         | {"path":"new_sale","customer_id","lines",…} | {"path":"advance","customer_id"}
create or replace function public.relink_bank_one_off_sale(p_txn_id uuid, p_target jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller  uuid;
  v_trusted boolean;
  v_row     record;
  v_path    text := p_target->>'path';
  v_undo    jsonb;
  v_res     jsonb;
  v_lock    date;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  /* Relink removes the old receipt — a delete, so owner / accountant (delete_payment's rule). */
  if not v_trusted and not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Relinking removes the old one-off receipt, so only an owner or accountant can do it. Ask them to press Relink on this line.' using errcode = '42501';
  end if;
  if v_path is null or v_path not in ('item', 'new_sale', 'advance') then
    raise exception 'Pick what this money is for (an open quote / invoice, a new sale or an advance).' using errcode = '22023';
  end if;

  perform 1 from public.bank_transactions t where t.id = p_txn_id for update;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;

  select o.* into v_row
    from public.bank_transactions t
    cross join lateral public.bank_old_one_off_bookings(t.bank_account_id) o
   where t.id = p_txn_id and o.txn_id = p_txn_id;
  if not found then
    raise exception 'This bank line is not an old one-off bank sale, so there is nothing to relink. Un-reconcile it and reconcile it again instead.' using errcode = 'check_violation';
  end if;
  if v_row.blocker = 'books_locked' then
    select t.books_locked_until into v_lock from public.tenants t where t.id = v_caller;
    raise exception 'Books are locked up to %, and this receipt (%)% falls in a locked month. Nothing was changed. Unlock the books on Accounting → Close month (/accounting/close), relink this line, then lock again.',
      to_char(v_lock, 'DD Mon YYYY'), to_char(v_row.received_on, 'DD Mon YYYY'),
      case when v_row.invoice_id is not null then ' or invoice ' || v_row.invoice_id || ' (' || to_char(v_row.invoice_date, 'DD Mon YYYY') || ')' else '' end
      using errcode = 'check_violation';
  end if;
  if v_row.blocker = 'other_receipts' then
    raise exception 'Quote % has other receipts too, so it cannot be undone from the bank line. Nothing was changed. Open the quote (/quotes/%) and handle its payments there.', v_row.quote_id, v_row.quote_id
      using errcode = 'check_violation';
  end if;
  if v_row.blocker = 'invoice_notes' then
    raise exception 'Invoice % already has a credit / debit note or TDS entry, so it cannot be reversed from here. Nothing was changed. Open the invoice (/invoices/%) and settle it there.', v_row.invoice_id, v_row.invoice_id
      using errcode = 'check_violation';
  end if;

  /* 1. Undo the old one-off sale: credit note (issued GST invoice) / void (draft), receipt removed. */
  v_undo := public.unreconcile_bank_receipt(p_txn_id, true);

  /* 2. Book the line on what the money was really for. */
  if v_path = 'item' then
    v_res := public.reconcile_bank_credit_to_item(
      p_txn_id,
      nullif(p_target->>'quote_id', ''), nullif(p_target->>'invoice_id', ''),
      coalesce((p_target->>'tds_amount')::int, 0), (p_target->>'tds_rate_pct')::numeric, nullif(p_target->>'tds_section', ''),
      (p_target->>'create_subscription')::boolean, (p_target->>'sub_start')::date, (p_target->>'sub_renewal')::date);
  elsif v_path = 'new_sale' then
    v_res := public.reconcile_bank_credit_new_sale(
      p_txn_id, (p_target->>'customer_id')::uuid, coalesce(p_target->'lines', '[]'::jsonb),
      coalesce((p_target->>'create_subscription')::boolean, true), (p_target->>'sub_start')::date, (p_target->>'sub_renewal')::date,
      coalesce((p_target->>'tds_amount')::int, 0), (p_target->>'tds_rate_pct')::numeric, nullif(p_target->>'tds_section', ''),
      nullif(p_target->>'billing_cycle', ''));   -- R-2026
  else
    v_res := public.reconcile_bank_credit_as_advance(p_txn_id, (p_target->>'customer_id')::uuid);
  end if;

  return v_res || jsonb_build_object(
    'relinked_from_quote',   v_row.quote_id,
    'relinked_from_invoice', v_row.invoice_id,
    'old_invoice_credited',  v_undo->>'invoice_credited',
    'old_invoice_voided',    v_undo->>'invoice_voided',
    'old_credit_note_id',    v_undo->>'credit_note_id');
end;
$$;

revoke all on function public.relink_bank_one_off_sale(uuid, jsonb) from public, anon;
grant execute on function public.relink_bank_one_off_sale(uuid, jsonb) to authenticated, service_role;

commit;
