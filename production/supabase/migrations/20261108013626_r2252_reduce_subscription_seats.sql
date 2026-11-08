-- deploy-peek: to_regclass('public.subscription_seat_reductions') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.reduce_subscription_seats(uuid,uuid,integer,text,integer,integer,text,uuid)') and prosrc like '%R-2252%')
-- deploy-key: r2252reducesubscriptionseats
-- 20261108013626_r2252_reduce_subscription_seats.sql
--
-- R-2252 (G-ZOHO, Zoho Billing audit A17, 31 Oct 2026): "Reduce seats" in Manage seats, with the
-- credit shown before it is saved. Manage seats only added; a seat cut went through Correct
-- details (no money) or a hand credit note, and neither app told the owner what the customer
-- gets back.
--
-- ─── WHAT THIS ADDS ───────────────────────────────────────────────────────────────────────
--   subscription_seat_reductions — one row per seat cut: who, when, N → M seats, 'now' (done) or
--     'end_of_term' (scheduled for the renewal date), and for 'now' the money: the unused value,
--     how much lowered the open invoice, how much became the customer's credit, what was not given
--     back, the credit note. The idempotency key is unique per company — a double click / retry
--     returns the first answer, never a second credit note. RLS: a company reads its own; nobody
--     writes it directly (only the function below).
--
--   reduce_subscription_seats(tenant, subscription, seats_removed, timing, unused_gross, new_mrr,
--     idempotency_key, actor) — server-only (current_request_role() = service_role); the route
--     (POST /api/subscriptions/[id]/reduce-seats) checks the caller's company and role and works
--     out the unused value with the SAME pricing as Add seats (lib/subscriptions/seat-reduction.ts).
--     'end_of_term': a scheduled row, nothing else changes, no money.
--     'now': on the locked part's TAX INVOICE it repeats R-2255's split
--     (lib/subscriptions/change-credit.ts splitChangeCredit):
--         lowerOpen = min(unused, open)
--         credit    = min(unused − lowerOpen, received − alreadyCredited)
--         notGiven  = unused − lowerOpen − credit
--     and issues ONE credit note for lowerOpen + credit (CGST s.34) through issue_credit_note_core
--     (p_settle: money paid past the new value → the customer's open credit, the R-1566 rule), then
--     re-syncs the subscription's stored balance (R-2178), then lowers seats + mrr.
--     "received" = the core's own "settled" figure (receipts + adjusted advances not refunded; a Paid
--     invoice at least its value — TDS the customer deducted is inside that), so the split here and
--     the credit the core books agree.
--     No tax invoice for the part → 'now' with a credit is refused (the way on: end of term). The
--     refund-voucher path (an advance with no invoice; capped at CASH received, not TDS) is not
--     built here — see the card's needsDecision.
--
--   The part's invoice: billed in parts → the subscription_billings row covering today (its
--   invoice_id; none → no invoice). Yearly → the newest issued invoice of the sale quote or a paid
--   renewal quote of this subscription (quotes.renewal_subscription_id), never the pending
--   renewal_quote_id (that is the NEXT term).
--
--   The unused value comes from the route, so it is bounded here: never more than the removed
--   seats' whole-term value at the stored rate + 18% GST (+1% rounding slack) — a wrong caller can
--   not credit more than the seats ever cost; the credit note itself is still capped by the core at
--   what the invoice has left to credit.
--
-- Test: supabase/tests/r2252_reduce_seats.test.sql (begin … rollback; red without this file).
begin;

create table if not exists public.subscription_seat_reductions (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  subscription_id    uuid not null references public.subscriptions(id) on delete cascade,
  idempotency_key    text not null,
  timing             text not null check (timing in ('now', 'end_of_term')),
  status             text not null check (status in ('done', 'scheduled', 'applied', 'cancelled')),
  seats_before       integer not null,
  seats_removed      integer not null check (seats_removed > 0),
  seats_after        integer not null check (seats_after >= 1),
  effective_date     date not null,
  mrr_before         integer,
  mrr_after          integer,
  unused_amount      integer not null default 0,
  lower_open_amount  integer not null default 0,
  credit_amount      integer not null default 0,
  not_given_amount   integer not null default 0,
  invoice_id         text,
  credit_note_id     text,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);
create index if not exists subscription_seat_reductions_sub_idx
  on public.subscription_seat_reductions (tenant_id, subscription_id, created_at desc);

alter table public.subscription_seat_reductions enable row level security;
drop policy if exists subscription_seat_reductions_read on public.subscription_seat_reductions;
create policy subscription_seat_reductions_read on public.subscription_seat_reductions for select to authenticated
  using (tenant_id = public.current_tenant_id());
drop policy if exists zzz_service_role_all on public.subscription_seat_reductions;
create policy zzz_service_role_all on public.subscription_seat_reductions as permissive for all to service_role using (true) with check (true);
revoke all on public.subscription_seat_reductions from public, anon;
grant select on public.subscription_seat_reductions to authenticated, service_role;

create or replace function public.reduce_subscription_seats(
  p_tenant_id        uuid,
  p_subscription_id  uuid,
  p_seats_removed    integer,
  p_timing           text,
  p_unused_gross     integer,
  p_new_mrr          integer,
  p_idempotency_key  text,
  p_actor            uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-2252: a seat cut — now (credit note on the part's invoice, R-2255 split) or at end of term. */
declare
  v_prior        public.subscription_seat_reductions%rowtype;
  v_sub          record;
  v_today        date := public.ist_today();
  v_split_billed boolean;
  v_part         record;
  v_inv_id       text;
  v_inv          record;
  v_cns          integer := 0;
  v_debits       integer := 0;
  v_adv          integer := 0;
  v_open         integer := 0;
  v_recv         integer := 0;
  v_already      integer := 0;
  v_creditable   integer := 0;
  v_unused       integer := 0;
  v_lower        integer := 0;
  v_credit       integer := 0;
  v_cn_amt       integer := 0;
  v_not_given    integer := 0;
  v_cap          numeric;
  v_cn           jsonb;
  v_cn_id        text;
  v_row_id       uuid;
  v_eff          date;
begin
  if public.current_request_role() is distinct from 'service_role' then
    raise exception 'reduce_subscription_seats is server-only — use Manage seats' using errcode = '42501';
  end if;
  if p_timing is null or p_timing not in ('now', 'end_of_term') then
    raise exception 'When must be now or end_of_term' using errcode = '22023';
  end if;
  if p_seats_removed is null or p_seats_removed < 1 then
    raise exception 'Remove at least 1 seat' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) < 8 or length(p_idempotency_key) > 128 then
    raise exception 'A request key of 8–128 characters is required' using errcode = '22023';
  end if;

  /* A replay answers with the first attempt. */
  select * into v_prior from public.subscription_seat_reductions
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
  if found then
    return to_jsonb(v_prior) || jsonb_build_object('replayed', true);
  end if;

  select s.id, s.tenant_id, s.status::text as status, s.seats, s.mrr, s.term_months, s.billing_cycle::text as billing_cycle,
         s.renewal_date, s.quote_id, s.renewal_quote_id, s.written_off_at
    into v_sub
    from public.subscriptions s where s.id = p_subscription_id for update;
  if not found or v_sub.tenant_id is distinct from p_tenant_id then
    raise exception 'Subscription not found' using errcode = 'no_data_found';
  end if;
  if v_sub.status <> 'active' then
    raise exception 'Seats can only be reduced on an active subscription (this one is %)', v_sub.status using errcode = 'check_violation';
  end if;
  if p_seats_removed >= coalesce(v_sub.seats, 0) then
    raise exception 'At least 1 seat must stay — this subscription has %. To stop every seat, cancel the subscription instead.', v_sub.seats
      using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.subscription_seat_reductions r
              where r.subscription_id = v_sub.id and r.status = 'scheduled') then
    raise exception 'A seat cut is already scheduled for the end of this term — it must happen (or be removed) before another seat cut'
      using errcode = 'check_violation';
  end if;

  if p_timing = 'end_of_term' then
    v_eff := v_sub.renewal_date;
    if v_eff is null then
      raise exception 'This subscription has no renewal date to schedule the cut on' using errcode = 'check_violation';
    end if;
    insert into public.subscription_seat_reductions
      (tenant_id, subscription_id, idempotency_key, timing, status, seats_before, seats_removed, seats_after,
       effective_date, mrr_before, created_by)
    values
      (p_tenant_id, v_sub.id, p_idempotency_key, 'end_of_term', 'scheduled', v_sub.seats, p_seats_removed,
       v_sub.seats - p_seats_removed, v_eff, v_sub.mrr, p_actor)
    returning id into v_row_id;
    return (select to_jsonb(r) from public.subscription_seat_reductions r where r.id = v_row_id) || jsonb_build_object('replayed', false);
  end if;

  -- ── now ────────────────────────────────────────────────────────────────────────────────
  if p_new_mrr is null or p_new_mrr < 0 or p_new_mrr > coalesce(v_sub.mrr, 0) then
    raise exception 'New monthly amount % is not between 0 and the current %', p_new_mrr, v_sub.mrr using errcode = '22023';
  end if;
  if p_unused_gross is null or p_unused_gross < 0 then
    raise exception 'Unused value must be 0 or more' using errcode = '22023';
  end if;
  v_cap := ceil(coalesce(v_sub.mrr, 0) * 12.0 / v_sub.seats * p_seats_removed
                * greatest(1, coalesce(v_sub.term_months, 12)) / 12.0 * 1.18 * 1.01) + p_seats_removed;
  if p_unused_gross > v_cap then
    raise exception 'Unused value % is more than the removed seats cost for the whole term (%)', p_unused_gross, v_cap
      using errcode = 'check_violation';
  end if;
  v_unused := p_unused_gross;

  /* The part's tax invoice. */
  v_split_billed := v_sub.billing_cycle in ('monthly', 'quarterly', 'half_yearly');
  if v_split_billed then
    select b.invoice_id into v_part
      from public.subscription_billings b
     where b.subscription_id = v_sub.id and b.period_start <= v_today and v_today < b.period_end
     order by b.term_start desc, b.period_index desc limit 1;
    v_inv_id := case when found then v_part.invoice_id end;
  else
    select i.id into v_inv_id
      from public.invoices i
     where i.tenant_id = p_tenant_id
       and i.status not in ('draft', 'void')
       and (i.quote_id = v_sub.quote_id
            or i.quote_id in (select q.id from public.quotes q
                               where q.tenant_id = p_tenant_id and q.renewal_subscription_id = v_sub.id
                                 and q.id is distinct from v_sub.renewal_quote_id))
     order by i.invoice_date desc, i.created_at desc limit 1;
  end if;

  if v_inv_id is not null then
    select i.id, i.status::text as status, i.amount, i.net_payable, i.paid_amount, i.adjusted_advances, i.written_off_at
      into v_inv from public.invoices i where i.id = v_inv_id and i.tenant_id = p_tenant_id for update;
    if not found or v_inv.status in ('draft', 'void') then
      v_inv_id := null;
    end if;
  end if;

  if v_inv_id is null and v_unused > 0 then
    raise exception 'This part has no tax invoice yet, so there is no invoice to credit. Choose "At end of term", or reduce the seats after the part is invoiced.'
      using errcode = 'check_violation';
  end if;

  if v_inv_id is not null and v_unused > 0 then
    /* R-2255's split — the inputs read exactly as issue_credit_note_core reads them. */
    select coalesce(sum(amount), 0) into v_cns from public.credit_notes where invoice_id = v_inv_id;
    select coalesce(sum(amount), 0) into v_debits from public.debit_notes where invoice_id = v_inv_id;
    select coalesce(sum((adv->>'amount')::int), 0)::int into v_adv
      from jsonb_array_elements(case when jsonb_typeof(v_inv.adjusted_advances) = 'array'
                                     then v_inv.adjusted_advances else '[]'::jsonb end) adv
     where not exists (select 1 from public.payments p
                        where p.id::text = adv->>'payment_id' and p.status = 'refunded');
    v_open := case when v_inv.status in ('pending', 'overdue') and v_inv.written_off_at is null
                   then greatest(0, coalesce(v_inv.net_payable, v_inv.amount, 0) - coalesce(v_inv.paid_amount, 0))
                   else 0 end;
    v_recv := coalesce(v_inv.paid_amount, 0) + v_adv;
    if v_inv.status = 'paid' then
      v_recv := greatest(v_recv, coalesce(v_inv.amount, 0) + v_debits - v_cns);
    end if;
    select coalesce(sum(c.amount), 0) into v_already
      from public.customer_credits c
     where c.tenant_id = p_tenant_id and c.source = 'credit_note' and c.source_invoice_id = v_inv_id;
    v_creditable := greatest(0, coalesce(v_inv.amount, 0) - v_cns);

    v_lower  := least(v_unused, v_open);
    v_credit := least(v_unused - v_lower, greatest(0, v_recv - v_already));
    v_cn_amt := least(v_lower + v_credit, v_creditable);
    if v_cn_amt < v_lower + v_credit then
      v_lower  := least(v_lower, v_cn_amt);
      v_credit := v_cn_amt - v_lower;
    end if;
    v_not_given := v_unused - v_lower - v_credit;

    if v_cn_amt > 0 then
      v_cn := public.issue_credit_note_core(
        v_inv_id, v_cn_amt, 'seat_reduction',
        format('Seats reduced from %s to %s on %s', v_sub.seats, v_sub.seats - p_seats_removed, to_char(v_today, 'DD Mon YYYY')),
        format('R-2252 Reduce seats: unused value ₹%s — lowers what is owed ₹%s, credit ₹%s', v_unused, v_lower, v_credit),
        true);
      v_cn_id := v_cn->>'credit_note_id';
      perform public.sync_invoice_subscription_outstanding(v_inv_id);
    end if;
  end if;

  update public.subscriptions
     set seats = seats - p_seats_removed, mrr = p_new_mrr, updated_at = now()
   where id = v_sub.id;

  insert into public.subscription_seat_reductions
    (tenant_id, subscription_id, idempotency_key, timing, status, seats_before, seats_removed, seats_after,
     effective_date, mrr_before, mrr_after, unused_amount, lower_open_amount, credit_amount, not_given_amount,
     invoice_id, credit_note_id, created_by)
  values
    (p_tenant_id, v_sub.id, p_idempotency_key, 'now', 'done', v_sub.seats, p_seats_removed, v_sub.seats - p_seats_removed,
     v_today, v_sub.mrr, p_new_mrr, v_unused, v_lower, v_credit, v_not_given,
     v_inv_id, v_cn_id, p_actor)
  returning id into v_row_id;

  return (select to_jsonb(r) from public.subscription_seat_reductions r where r.id = v_row_id)
         || jsonb_build_object('replayed', false, 'customer_credit', coalesce((v_cn->>'customer_credit')::int, 0));
end;
$function$;

comment on function public.reduce_subscription_seats(uuid, uuid, integer, text, integer, integer, text, uuid) is
  'R-2252: seat cut from Manage seats. end_of_term → scheduled row only. now → one credit note on the part''s tax invoice for min(unused, open) + min(rest, received − already credited) (R-2255 split), seats + mrr lowered, balance re-synced (R-2178). Server-only.';

revoke all on function public.reduce_subscription_seats(uuid, uuid, integer, text, integer, integer, text, uuid) from public, anon, authenticated;
grant execute on function public.reduce_subscription_seats(uuid, uuid, integer, text, integer, integer, text, uuid) to service_role;

commit;
