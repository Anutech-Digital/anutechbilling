-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.split_sale_invoice_status(text[])') and prosrc like '%R-2057%')
-- deploy-key: r2057splitsalepending
-- 20261028151322_r2057_split_sale_pending.sql
--
-- R-2057 (28 Oct 2026, Pardeep, staging): Invoices → "Pending GST invoice generation" listed a
-- quarterly-billed sale (annual commitment, Q1 paid) with a Generate button, and Generate refused
-- it: "This subscription is billed quarterly, so it is invoiced one period at a time …"
-- (reject_full_term_invoice_when_split_billed). The list said "invoice it", the button said "no".
--
-- Cause: the list was every quote with money in and no quotes.invoice_id. A sale billed in parts
-- NEVER gets quotes.invoice_id — each part's tax invoice is an instalment invoice
-- (raise_subscription_billing, quote_id NULL on purpose) — so the sale stayed "pending" for ever,
-- and its Generate called generate_invoice (the whole term), which the trigger rightly refuses.
--
-- Now the Invoices page asks this function, for the pending quotes, what their part stands at,
-- and Generate on such a row runs the billing cron's own path (POST /api/quotes/:id/
-- raise-instalments → raiseDueInstalmentsForQuote → bill_subscription_instalment →
-- raise_subscription_billing). This function decides NOTHING itself: whether a part may be
-- invoiced is bill_subscription_instalment's dry run (R-2044 / R-2048 rules unchanged — an
-- unpaid part, the first part of an unpaid sale included, gets no tax invoice).
--
-- One row per pending quote that is billed in parts (other quotes: no row = the old path):
--   state 'ready'       a due part is not invoiced and may be (money covers it) → "Generate
--                       invoice for Q1 · 1 Oct–31 Dec 2026 ₹X"
--   state 'short'       a due part is not invoiced and money does not cover it yet → no Generate;
--                       credit vs gross says by how much
--   state 'invoiced'    every due part is invoiced (invoice_id = the latest one) → not pending
--   state 'on_request'  an earlier part is invoiced and the unpaid one is owed on its own payment
--                       request → the sale is not pending
--   state 'not_laid'    no schedule rows yet (the billing job has not run since the sale) →
--                       Generate lays them and bills, the same as the job
-- Read-only: bill_subscription_instalment is called with p_dry_run = true only.
-- Test: supabase/tests/r2057_split_sale_pending.test.sql

begin;

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
/* R-2057: what the part of a sale billed in parts stands at, for the pending GST invoice list. */
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
      /* The sale quote: its subscription billed in parts (the trigger's own test). */
      select s.id, s.billing_cycle::text as cycle, s.start_date into v_sub
        from public.subscriptions s
       where s.quote_id = v_q.id
         and s.tenant_id = v_q.tenant_id
         and s.billing_cycle is distinct from 'yearly'::billing_cycle
       order by s.created_at
       limit 1;
      if not found then continue; end if;

      select min(b.term_start) into v_term
        from public.subscription_billings b where b.subscription_id = v_sub.id;
      if v_term is null then
        return query select v_q.id, 'not_laid'::text, v_sub.id, null::uuid, v_sub.cycle, 1, null::text,
                            null::date, null::date, null::integer,
                            public.instalment_credit(v_sub.id), null::text, v_sub.start_date;
        continue;
      end if;

      /* The first due part of the sale's term with no invoice. */
      select b.* into v_t
        from public.subscription_billings b
       where b.subscription_id = v_sub.id and b.term_start = v_term
         and b.invoice_id is null and b.bill_on <= v_today
       order by b.period_index
       limit 1;
      v_has_t := found;
      /* The latest due part that is invoiced. */
      select b.* into v_last
        from public.subscription_billings b
       where b.subscription_id = v_sub.id and b.term_start = v_term
         and b.invoice_id is not null and b.bill_on <= v_today
       order by b.period_index desc
       limit 1;
      v_has_last := found;
    end if;

    v_credit := public.instalment_credit(v_sub.id);

    if not v_has_t then
      if not v_has_last then continue; end if;   -- nothing due yet
      return query
        select v_q.id, 'invoiced'::text, v_sub.id, v_last.id, v_sub.cycle, v_last.period_index,
               public.r2057_part_label(v_sub.cycle, v_last.period_index),
               v_last.period_start, v_last.period_end,
               (select i.amount from public.invoices i where i.id = v_last.invoice_id),
               v_credit, v_last.invoice_id, v_term;
      continue;
    end if;

    /* bill_subscription_instalment decides — dry run, writes nothing. */
    v_dry := public.bill_subscription_instalment(v_t.id, true);
    v_has_req := exists (select 1 from public.quotes r where r.subscription_billing_id = v_t.id);

    return query
      select v_q.id,
             case
               when v_dry->>'action' = 'already_invoiced' then 'invoiced'
               when v_dry->>'action' = 'invoice' then 'ready'
               /* The sale's own money is invoiced; the unpaid part is owed on its request. */
               when v_q.subscription_billing_id is null and (v_has_last or v_has_req) then 'on_request'
               else 'short'
             end,
             v_sub.id, v_t.id, v_sub.cycle, v_t.period_index,
             public.r2057_part_label(v_sub.cycle, v_t.period_index),
             v_t.period_start, v_t.period_end,
             coalesce((v_dry->>'gross')::integer, 0),
             v_credit,
             case when v_dry->>'action' = 'already_invoiced' then v_dry->>'invoice_id' end,
             v_term;
  end loop;
end;
$$;

/* "Q1 · 1 Oct–31 Dec 2026" — the same words bill_subscription_instalment puts on a part's payment
   request ("Advance payment for Q2 · 28 Jan–27 Apr 2027"); period_end is exclusive. */
create or replace function public.r2057_part_label(p_cycle text, p_index integer)
returns text
language sql
immutable
set search_path = public
as $$
  select case p_cycle when 'quarterly' then 'Q' || p_index::text
                      when 'half_yearly' then 'H' || p_index::text
                      else 'Month ' || p_index::text end;
$$;

revoke all on function public.split_sale_invoice_status(text[]) from public, anon;
grant execute on function public.split_sale_invoice_status(text[]) to authenticated, service_role;
revoke all on function public.r2057_part_label(text, integer) from public, anon;
grant execute on function public.r2057_part_label(text, integer) to authenticated, service_role;

commit;
