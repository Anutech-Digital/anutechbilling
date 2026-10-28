-- deploy-peek: to_regprocedure('public.bank_credit_open_items(uuid)') is not null and to_regprocedure('public.reconcile_bank_credit_to_item(uuid,text,text,integer,numeric,text,boolean,date,date)') is not null and exists(select 1 from pg_proc where proname='reconcile_bank_credit_new_sale' and pronamespace='public'::regnamespace)
-- deploy-key: r1838bankcreditpayfor
-- 20261024131600_r1838_bank_credit_pay_for.sql
--
-- R-1838 (24 Oct 2026, Pardeep on staging): "reconcile karke invoice banaya par jab product select
-- kiya to waha sirf total price poocha — subscription product ke number of licences nahi pooche,
-- unit price nahi poocha … ya wo renewal quote ki payment hogi ya pro rata quote ki ya fresh product
-- ki quotation ki payment hogi — isko bhi yahi manage kar liya jaye." + "agar fresh quote ki payment
-- hai to subscription bhi banne ka option ho".
--
-- ─── WHAT WAS WRONG ─────────────────────────────────────────────────────────
--   Bank → Reconcile → "Create invoice" (useBookCreditAsInvoice) made a ONE-OFF quote through
--   create_direct_invoice from a product + one taxable total, then record_payment + a direct
--   bank_transactions update — three separate client calls. A one-off quote never renews a
--   subscription, never adds seats and never creates one, so money for a renewal / an add-seats
--   (pro-rata) quote / a new subscription sale was booked beside the subscription it was for.
--
-- ─── WHAT THIS ADDS — no new money semantics, only the existing paths in ONE transaction ──
--   bank_credit_open_items(customer)  — what this customer still owes, for the "This money is
--       for:" list: open quotes (renewal / add seats / new sale / one-off) with quote_open_balance
--       (R-1686) as the amount due, and unpaid invoices (instalments too) with the R-1561 due
--       (net_payable − paid_amount). Read only.
--   reconcile_bank_credit_to_item(txn, quote | invoice, TDS, subscription choice)
--       1. the line must be an unmatched money-IN line of the caller's company (locked);
--       2. a NEW subscription sale that has filed nothing yet: "Create subscription" unticked →
--          quotes.is_one_off = true, so record_payment files none (its own 0157 guard) and the
--          quote page's existing "paid but has no subscription → Re-create" is the "Create now";
--          ticked with a start / renewal date → written on the quote's subscription lines as
--          start_date / renewal_date, which record_payment (start) and subscription_term_follows_line
--          (renewal) already read;
--       3. record_desk_payment (record_payment / record_payment_with_tds, receipt date = bank date,
--          bank account tag) — or record_instalment_payment for an instalment invoice. A renewal
--          rolls forward, add-seats settles, a new sale files its subscriptions, extra money becomes
--          customer credit — all inside record_payment, unchanged;
--       4. generate_invoice when the quote is now fully paid and has no invoice yet (not for a
--          split-billed subscription — reject_full_term_invoice_when_split_billed's own rule);
--       5. reconcile_bank_txn links the line to the payment.
--       Returns what happened (kind, invoice, subscriptions with plan / seats / renewal date, credit).
--   reconcile_bank_credit_new_sale(txn, customer, lines, …) — a sale with no quote yet: inserts the
--       quote exactly as create_direct_invoice does (same tax rate rule, same subtotal + GST), but
--       with the operator's seats × unit price and each line's own term (annual / monthly /
--       one-time), then calls reconcile_bank_credit_to_item on it.
--
--   Existing "booked as invoice" bank lines are NOT touched (card R-1838 needsDecision).
--
-- Guards: §17c fail-closed tenant check, R-718 money roles (owner / manager / accountant / billing).
-- Test: supabase/tests/r1838_bank_credit_pay_for.test.sql

begin;

-- ── 1. bank_credit_open_items ───────────────────────────────────────────────
create or replace function public.bank_credit_open_items(p_customer_id uuid)
returns table (
  kind               text,      -- renewal | add_seats | new | one_off | invoice | instalment
  quote_id           text,
  invoice_id         text,
  doc_date           date,
  amount_due         integer,
  taxable_value      integer,
  makes_subscription boolean,   -- a new sale whose payment would file subscription(s)
  subscription_id    uuid,
  plan               text,
  seats              integer,
  renewal_date       date,
  lines              jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_caller  uuid;
  v_trusted boolean;
begin
  /* R-1838 / §17c: fail closed for a login with no company. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can reconcile a bank receipt' using errcode = '42501';
  end if;
  if v_caller is null then
    select c.tenant_id into v_caller from public.customers c where c.id = p_customer_id;
  end if;

  return query
  /* Open quotes with no invoice yet. A quote with an invoice is listed by its invoice below. */
  with q as (
    select qq.*,
           coalesce(
             (select s.id from public.subscriptions s
               where s.tenant_id = qq.tenant_id and s.renewal_quote_id = qq.id limit 1),
             qq.renewal_subscription_id) as r_sub_id
      from public.quotes qq
     where qq.tenant_id = v_caller
       and qq.customer_id = p_customer_id
       and qq.status in ('sent', 'viewed', 'accepted')
       and qq.superseded_by is null
       and qq.invoice_id is null
       and coalesce(qq.payment_status::text, 'none') in ('none', 'awaiting', 'partial')
       and coalesce(qq.amount, 0) > 0
  )
  select case
           when q.r_sub_id is not null or q.is_renewal or q.is_extension then 'renewal'
           when q.is_add_seats then 'add_seats'
           when q.is_one_off then 'one_off'
           else 'new'
         end,
         q.id, null::text, q.created_date,
         public.quote_open_balance(q.id),
         coalesce(q.subtotal, 0)::integer,
         (q.r_sub_id is null and not q.is_renewal and not q.is_extension and not q.is_add_seats
          and not q.is_one_off
          and not exists (select 1 from public.subscriptions s where s.tenant_id = q.tenant_id and s.quote_id = q.id)
          and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(q.line_items) = 'array' then q.line_items else '[]'::jsonb end) li
                       where jsonb_typeof(li) = 'object' and public.quote_line_is_subscription(li, q.tenant_id, false))),
         coalesce(q.r_sub_id, q.add_seats_subscription_id),
         coalesce(s.plan, q.plan), coalesce(s.seats, q.seats), s.renewal_date,
         case when jsonb_typeof(q.line_items) = 'array' then q.line_items else '[]'::jsonb end
    from q
    left join public.subscriptions s
      on s.tenant_id = q.tenant_id and s.id = coalesce(q.r_sub_id, q.add_seats_subscription_id)
   where public.quote_open_balance(q.id) > 0

  union all

  /* Unpaid invoices — R-1561 due (net_payable − paid_amount). Project-milestone invoices are paid
     through project payments, and an invoice with neither a quote nor an instalment link has no
     payment path here, so both are left out. */
  select case when i.quote_id is null then 'instalment' else 'invoice' end,
         i.quote_id, i.id, i.invoice_date,
         greatest(0, coalesce(i.net_payable, i.amount, 0) - coalesce(i.paid_amount, 0))::integer,
         coalesce(i.taxable_value, 0)::integer,
         false,
         coalesce(sb.subscription_id,
                  (select s2.id from public.subscriptions s2
                    where s2.tenant_id = i.tenant_id and s2.renewal_quote_id = i.quote_id limit 1)),
         s.plan, s.seats, s.renewal_date,
         coalesce(qi.line_items, '[]'::jsonb)
    from public.invoices i
    left join lateral (select b.subscription_id from public.subscription_billings b
                        where b.tenant_id = i.tenant_id and b.invoice_id = i.id limit 1) sb on true
    left join public.quotes qi on qi.tenant_id = i.tenant_id and qi.id = i.quote_id
    left join public.subscriptions s
      on s.tenant_id = i.tenant_id
     and s.id = coalesce(sb.subscription_id, qi.renewal_subscription_id, qi.add_seats_subscription_id)
   where i.tenant_id = v_caller
     and i.customer_id = p_customer_id
     and i.status in ('pending', 'overdue')
     and i.written_off_at is null
     and (i.quote_id is not null or sb.subscription_id is not null)
     and not exists (select 1 from public.project_milestones m where m.invoice_id = i.id)
     and coalesce(i.net_payable, i.amount, 0) - coalesce(i.paid_amount, 0) > 0
   order by 4 desc, 2;
end;
$$;

revoke all on function public.bank_credit_open_items(uuid) from public, anon;
grant execute on function public.bank_credit_open_items(uuid) to authenticated, service_role;

-- ── 2. reconcile_bank_credit_to_item ────────────────────────────────────────
create or replace function public.reconcile_bank_credit_to_item(
  p_txn_id              uuid,
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
declare
  v_caller     uuid;
  v_trusted    boolean;
  v_txn        record;
  v_inv        record;
  v_quote      record;
  v_quote_id   text;
  v_kind       text;
  v_sub_id     uuid;
  v_new_sale   boolean := false;
  v_skip_sub   boolean := false;
  v_ref        text;
  v_res        jsonb;
  v_pay_id     uuid;
  v_replay     boolean;
  v_tds        integer := greatest(0, coalesce(p_tds_amount, 0));
  v_gross      integer;
  v_inv_issued text := null;
  v_inv_now    text;
  v_subs       jsonb := '[]'::jsonb;
  v_lines      jsonb;
  v_inv_taxable integer := null;
  v_note       text;
begin
  /* §17c fail-closed + R-718 money roles. */
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
  if (p_quote_id is null) = (p_invoice_id is null) then
    raise exception 'Pick one quote or one invoice this money is for.' using errcode = '22023';
  end if;

  select t.* into v_txn from public.bank_transactions t where t.id = p_txn_id for update;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;
  if v_caller is not null and v_txn.tenant_id is distinct from v_caller then
    raise exception 'This bank line is not in your company' using errcode = '42501';
  end if;
  if coalesce(v_txn.credit, 0) <= 0 then
    raise exception 'Only a money-in (credit) bank line can pay a quote or invoice.' using errcode = '22023';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This bank line is already reconciled (%). Un-reconcile it first if it was matched wrongly.', v_txn.matched_to_type
      using errcode = 'check_violation';
  end if;

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

  /* The line's UTR is the payment reference (record_payment replays on quote + reference). */
  v_ref := coalesce(nullif(btrim(v_txn.reference), ''), 'BANK-' || v_txn.id::text);
  /* NOT 'Reconciled from bank receipt': that note marks a throw-away one-off sale which
     unreconcile_bank_receipt may delete ("undo the sale"). A renewal / add-seats / subscription
     payment must never be deleted from the bank page — un-reconciling only frees the line. */
  v_note := 'Bank credit of ' || to_char(v_txn.txn_date, 'DD Mon YYYY') || ' matched to ' || coalesce(p_invoice_id, v_quote_id);

  if v_kind = 'instalment' then
    v_res := public.record_instalment_payment(
      p_invoice_id, v_txn.credit + v_tds, 'bank_transfer', v_ref, v_note,
      null, 0, v_txn.txn_date, v_txn.bank_account_id,
      v_tds, case when v_tds > 0 then v_gross else 0 end, case when v_tds > 0 then v_txn.credit else 0 end,
      case when v_tds > 0 then coalesce(p_tds_section, '194J') end, case when v_tds > 0 then p_tds_rate_pct end,
      null, case when v_tds > 0 then public.indian_fiscal_year(v_txn.txn_date) end);
  else
    v_res := public.record_desk_payment(
      v_quote_id, v_txn.credit + v_tds, 'bank_transfer', v_ref, v_note,
      null, 0, v_txn.txn_date, v_txn.bank_account_id,
      v_tds, case when v_tds > 0 then v_gross else 0 end, case when v_tds > 0 then v_txn.credit else 0 end,
      case when v_tds > 0 then coalesce(p_tds_section, '194J') end, case when v_tds > 0 then p_tds_rate_pct end,
      null, p_invoice_id, case when v_tds > 0 then public.indian_fiscal_year(v_txn.txn_date) end);
  end if;

  v_pay_id := nullif(v_res->>'payment_id', '')::uuid;
  if v_pay_id is null then
    raise exception 'The payment was not recorded.' using errcode = 'P0001';
  end if;
  v_replay := coalesce((v_res->>'already_recorded')::boolean, false)
           or coalesce((v_res->>'idempotent_replay')::boolean, false);
  /* Already recorded by hand with this UTR: reconcile this line to THAT payment, never a second
     one — unless another bank line already carries it. */
  if v_replay and exists (select 1 from public.bank_transactions t
                           where t.tenant_id = v_txn.tenant_id and t.id <> v_txn.id
                             and t.matched_to_type = 'payment' and t.matched_to_id = v_pay_id::text) then
    raise exception 'A payment with reference % is already recorded on % and reconciled to another bank line. Nothing was changed.', v_ref, v_quote_id
      using errcode = 'unique_violation';
  end if;

  /* Invoice once fully paid, when the quote has none (record_payment never issues one). */
  if v_quote_id is not null and not v_replay then
    select q.invoice_id into v_inv_now from public.quotes q where q.id = v_quote_id;
    if v_inv_now is null
       and coalesce((v_res->>'is_fully_paid')::boolean, false)
       and not exists (select 1 from public.subscriptions s
                        where s.tenant_id = v_txn.tenant_id and s.quote_id = v_quote_id
                          and s.billing_cycle is distinct from 'yearly'::public.billing_cycle) then
      select gi.invoice_id into v_inv_issued from public.generate_invoice(v_quote_id) gi;
      /* R-015's rule (record_desk_payment): a settled invoice is paid on the RECEIPT date. */
      update public.invoices set paid_date = v_txn.txn_date
       where id = v_inv_issued and tenant_id = v_txn.tenant_id and status = 'paid';
    end if;
  end if;

  perform public.reconcile_bank_txn(p_txn_id, 'payment', v_pay_id::text, 'manual');

  /* What happened, for the result panel. */
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'plan', s.plan, 'seats', s.seats, 'start_date', s.start_date,
           'renewal_date', s.renewal_date, 'billing_cycle', s.billing_cycle) order by s.created_at), '[]'::jsonb)
    into v_subs
    from public.subscriptions s
   where s.tenant_id = v_txn.tenant_id
     and (s.id = v_sub_id or (v_kind in ('new', 'one_off') and v_quote_id is not null and s.quote_id = v_quote_id));

  return jsonb_build_object(
    'kind',                 v_kind,
    'quote_id',             v_quote_id,
    'invoice_id',           coalesce(p_invoice_id, v_inv_issued, (select q.invoice_id from public.quotes q where q.id = v_quote_id)),
    'invoice_issued',       v_inv_issued,
    'payment_id',           v_pay_id,
    'receipt_voucher_no',   v_res->>'receipt_voucher_no',
    'amount',               v_txn.credit,
    'tds_amount',           v_tds,
    'outstanding',          coalesce((v_res->>'outstanding')::int, 0),
    'is_fully_paid',        coalesce((v_res->>'is_fully_paid')::boolean, false),
    'overpaid_credit',      coalesce((v_res->>'overpaid_credit')::int, 0),
    'renewal_rolled_forward', coalesce((v_res->>'renewal_rolled_forward')::boolean, false),
    'subscription_skipped', v_skip_sub,
    'already_recorded',     v_replay,
    'subscriptions',        v_subs
  );
end;
$$;

revoke all on function public.reconcile_bank_credit_to_item(uuid, text, text, integer, numeric, text, boolean, date, date) from public, anon;
grant execute on function public.reconcile_bank_credit_to_item(uuid, text, text, integer, numeric, text, boolean, date, date) to authenticated, service_role;

-- ── 3. reconcile_bank_credit_new_sale ───────────────────────────────────────
create or replace function public.reconcile_bank_credit_new_sale(
  p_txn_id              uuid,
  p_customer_id         uuid,
  p_lines               jsonb,
  p_create_subscription boolean default true,
  p_sub_start           date    default null,
  p_sub_renewal         date    default null,
  p_tds_amount          integer default 0,
  p_tds_rate_pct        numeric default null,
  p_tds_section         text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
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
    v_lines, 'accepted', 'awaiting', not (v_monthly or v_annual), case when v_monthly then 'monthly' else 'yearly' end,
    public.ist_today(), 'Sale booked from a bank receipt of ' || to_char(v_txn.txn_date, 'DD Mon YYYY')
  );

  return public.reconcile_bank_credit_to_item(
           p_txn_id, v_qid, null, p_tds_amount, p_tds_rate_pct, p_tds_section,
           p_create_subscription, p_sub_start, p_sub_renewal)
         || jsonb_build_object('new_quote', true, 'quote_total', v_gross, 'tax_rate', v_rate);
end;
$$;

revoke all on function public.reconcile_bank_credit_new_sale(uuid, uuid, jsonb, boolean, date, date, integer, numeric, text) from public, anon;
grant execute on function public.reconcile_bank_credit_new_sale(uuid, uuid, jsonb, boolean, date, date, integer, numeric, text) to authenticated, service_role;

commit;
