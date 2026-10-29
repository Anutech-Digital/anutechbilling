-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.bill_subscription_instalment(uuid,boolean)') and prosrc like '%R-2092 siblings laid%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.split_sale_invoice_status(text[])') and prosrc like '%R-2092%')
-- deploy-key: r2092siblingslaid
-- 20261029052411_r2092_siblings_laid.sql
--
-- R-2092 follow-up (29 Oct 2026, localhost check of 68ed55d70 FAILED): a 2-subscription quarterly
-- quote (Starter 57 + Standard 13) paid ₹95,993 got ONE invoice for the Starter only (₹53,808);
-- paid ₹95,933 (₹60 short) the Starter was invoiced 'Paid' (R-2048 broken again — the pool covered
-- the Starter's part alone). The rows show why: the Starter's parts were laid AND billed before
-- the Standard's parts were laid, so billing_part_group found the Starter alone. The TS "lay all
-- first" pass (layInstalments) had failed and its error was swallowed.
--
-- The grouping now does not depend on the caller's order:
--   bill_subscription_instalment  answers {action:'waiting', reason:'siblings_not_laid'} — no
--                                 invoice, no request — while another active subscription of the
--                                 same quote, billed in the same cycle, has no parts laid. The
--                                 caller's next step (the next subscription of the same run, or the
--                                 next run) lays them and bills the whole group in one call.
--                                 Not held back by: a yearly / other-cycle / cancelled / paused
--                                 subscription, one with no start date or no price, one billed elsewhere for
--                                 the period (R-1763).
--   split_sale_invoice_status     reads ALL the sale's subscriptions billed in parts (it read the
--                                 first one only, and said 'invoiced' while the Standard's Q1 had
--                                 no invoice); a sale with a subscription not laid yet → 'not_laid'.
-- Bodies: bill_subscription_instalment from 20261029034541 (R-2092); split_sale_invoice_status from
-- 20261028151322 (R-2057) — the latest definitions.
-- Test: supabase/tests/r2092_quote_period_one_invoice.test.sql (case G),
--       src/lib/billing/raise-instalments-r2092.db.test.ts (route, local DB).

begin;

create or replace function public.bill_subscription_instalment(p_billing_id uuid, p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2044: invoice a paid part or make its payment request — once. R-2048: the sale quote's first part only when money covers it; an open unpaid sale quote IS its request. R-2092: the quote's parts for one period are ONE group — one invoice, one request, the quote's money pool; none billed while a sibling's parts are not laid (R-2092 siblings laid). */
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

  select q.id, q.amount, q.status::text as status, q.invoice_id into v_q
    from public.quotes q where q.subscription_billing_id = any(v_ids)
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
  v_first := v_sub.quote_id is not null
             and v_b.period_index = 1
             and v_b.term_start = (select min(b2.term_start) from public.subscription_billings b2
                                    where b2.subscription_id = v_b.subscription_id);
  v_paid_up := public.instalment_credit(v_b.subscription_id) >= v_gross;

  /* v_on_due: the customer's "Invoice on due date" switch — the old path, a tax invoice on the
     bill date even if unpaid (chased by invoice-dunning). */
  if v_req_paid or v_on_due or v_paid_up then
    if coalesce(p_dry_run, false) then
      return jsonb_build_object('action', 'invoice', 'gross', v_gross, 'dry_run', true, 'parts', v_parts,
        'reason', case when v_req_paid then 'request_paid' when v_on_due then 'invoice_on_due_date'
                       when v_first then 'first_part_of_sale' else 'already_paid' end);
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

create or replace function public.split_sale_invoice_status(p_quote_ids text[])
returns table(
  quote_id        text,
  state           text,
  subscription_id uuid,
  billing_id      uuid,
  cycle           text,
  period_index    integer,
  period_label    text,
  period_start    date,
  period_end      date,
  gross           integer,
  credit          integer,
  invoice_id      text,
  term_start      date
)
language plpgsql
security definer
set search_path = public
as $$
/* R-2057: what the part of a sale billed in parts stands at, for the pending GST invoice list. R-2092: every subscription of the sale. */
declare
  v_trusted boolean;
  v_caller  uuid;
  v_today   date := public.ist_today();
  v_q       record;
  v_sub     record;
  v_t       record;
  v_last    record;
  v_term    date;
  v_dry     jsonb;
  v_credit  integer;
  v_has_req boolean;
  v_has_t   boolean;
  v_has_last boolean;
  v_unlaid  uuid;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login' using errcode = '28000';
  end if;
  /* The same roles that may bill a part (bill_subscription_instalment). Anyone else: no rows —
     the pending list is only shown to them anyway. */
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    return;
  end if;

  for v_q in
    select q.id, q.tenant_id, q.subscription_billing_id
      from public.quotes q
     where q.id = any(coalesce(p_quote_ids, '{}'::text[]))
       and (v_caller is null or q.tenant_id = v_caller)
  loop
    v_has_t := false; v_has_last := false; v_term := null;

    if v_q.subscription_billing_id is not null then
      /* A part's own payment request (R-2044): its one part. */
      select b.* into v_t from public.subscription_billings b where b.id = v_q.subscription_billing_id;
      if not found then continue; end if;
      select s.id, s.billing_cycle::text as cycle, s.start_date into v_sub
        from public.subscriptions s where s.id = v_t.subscription_id;
      if not found then continue; end if;
      v_term := v_t.term_start;
      if v_t.invoice_id is not null then
        v_last := v_t;
        v_has_last := true;
      else
        v_has_t := true;
      end if;
    else
      /* The sale quote: its subscriptions billed in parts (the trigger's own test). R-2092: ALL of
         them — a quote with two subscriptions is invoiced per period on one invoice; reading the
         first subscription alone said 'invoiced' while the second's part had none. */
      select s.id, s.billing_cycle::text as cycle, s.start_date into v_sub
        from public.subscriptions s
       where s.quote_id = v_q.id
         and s.tenant_id = v_q.tenant_id
         and s.billing_cycle is distinct from 'yearly'::billing_cycle
       order by s.created_at, s.id
       limit 1;
      if not found then continue; end if;

      /* A subscription of the sale with no parts laid yet → the billing job has not laid it. */
      select s.id into v_unlaid
        from public.subscriptions s
       where s.quote_id = v_q.id and s.tenant_id = v_q.tenant_id
         and s.billing_cycle is distinct from 'yearly'::billing_cycle
         and s.status = 'active'
         and not exists (select 1 from public.subscription_billings b where b.subscription_id = s.id)
       order by s.created_at, s.id
       limit 1;
      if found then
        return query select v_q.id, 'not_laid'::text, v_unlaid, null::uuid, v_sub.cycle, 1, null::text,
                            null::date, null::date, null::integer,
                            public.instalment_credit(v_sub.id), null::text, v_sub.start_date;
        continue;
      end if;

      /* The first due part of any of the sale's subscriptions (each in its first term) with no
         invoice; the latest due part that is invoiced. */
      select b.* into v_t
        from public.subscription_billings b
        join public.subscriptions s on s.id = b.subscription_id
       where s.quote_id = v_q.id and s.tenant_id = v_q.tenant_id
         and s.billing_cycle is distinct from 'yearly'::billing_cycle
         and b.term_start = (select min(b2.term_start) from public.subscription_billings b2 where b2.subscription_id = s.id)
         and b.invoice_id is null and b.bill_on <= v_today
       order by b.period_start, s.created_at, s.id
       limit 1;
      v_has_t := found;
      select b.* into v_last
        from public.subscription_billings b
        join public.subscriptions s on s.id = b.subscription_id
       where s.quote_id = v_q.id and s.tenant_id = v_q.tenant_id
         and s.billing_cycle is distinct from 'yearly'::billing_cycle
         and b.term_start = (select min(b2.term_start) from public.subscription_billings b2 where b2.subscription_id = s.id)
         and b.invoice_id is not null and b.bill_on <= v_today
       order by b.period_start desc, s.created_at, s.id
       limit 1;
      v_has_last := found;
      v_term := case when v_has_t then v_t.term_start when v_has_last then v_last.term_start end;
    end if;

    v_credit := public.instalment_credit(v_sub.id);

    if not v_has_t then
      if not v_has_last then continue; end if;   -- nothing due yet
      return query
        select v_q.id, 'invoiced'::text, v_last.subscription_id, v_last.id, v_sub.cycle, v_last.period_index,
               public.r2057_part_label(v_sub.cycle, v_last.period_index),
               v_last.period_start, v_last.period_end,
               (select i.amount from public.invoices i where i.id = v_last.invoice_id),
               v_credit, v_last.invoice_id, v_term;
      continue;
    end if;

    /* bill_subscription_instalment decides — dry run, writes nothing. */
    v_dry := public.bill_subscription_instalment(v_t.id, true);
    v_has_req := exists (select 1 from public.quotes r
                          where r.subscription_billing_id in (select g.billing_id from public.billing_part_group(v_t.id) g));

    return query
      select v_q.id,
             case
               when v_dry->>'action' = 'already_invoiced' then 'invoiced'
               when v_dry->>'action' = 'invoice' then 'ready'
               when v_dry->>'action' = 'waiting' then 'not_laid'
               /* The sale's own money is invoiced; the unpaid part is owed on its request. */
               when v_q.subscription_billing_id is null and (v_has_last or v_has_req) then 'on_request'
               else 'short'
             end,
             v_t.subscription_id, v_t.id, v_sub.cycle, v_t.period_index,
             public.r2057_part_label(v_sub.cycle, v_t.period_index),
             v_t.period_start, v_t.period_end,
             coalesce((v_dry->>'gross')::integer, 0),
             v_credit,
             case when v_dry->>'action' = 'already_invoiced' then v_dry->>'invoice_id' end,
             v_term;
  end loop;
end;
$$;

revoke all on function public.split_sale_invoice_status(text[]) from public, anon;
grant execute on function public.split_sale_invoice_status(text[]) to authenticated, service_role;

commit;
