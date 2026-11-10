-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.reduce_subscription_seats(uuid,uuid,integer,text,integer,integer,text,uuid,integer)') and prosrc like '%R-2584%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.cancel_scheduled_seat_reduction(uuid,uuid)') and prosrc like '%R-2584%')
-- deploy-key: r2584seatcutignorepastschedules
-- 20261108043428_r2584_seat_cut_ignore_past_schedules.sql
--
-- R-2584 (independent review of R-2252, 8 Nov 2026): a seat cut scheduled for the end of the term
-- is only a row — nothing applies it at renewal yet (R-2583). Once its date has passed it stayed
-- status 'scheduled' for ever, and reduce_subscription_seats refused EVERY later cut with "A seat
-- cut is already scheduled". Now a scheduled row dated before today (IST) no longer blocks; one
-- dated today or later still does. The "At end of term" choice is hidden in the app
-- (SEAT_CUT_END_OF_TERM_ENABLED) and refused by the route until R-2583, so the no-invoice message
-- no longer points the owner at it.
--
-- Redefines reduce_subscription_seats from its only (latest) definition, 20261108013626 (R-2252);
-- same signature, grants repeated. cancel_scheduled_seat_reduction (same file) is redefined too: a
-- stale row no longer blocks, so a subscription can hold a stale row AND a live one — its old
-- "update … returning into" (exactly one row) would then fail; it now cancels every scheduled row
-- of the subscription (stale ones too) and returns the latest-dated one.
-- Test: supabase/tests/r2584_seat_cut_past_schedule.test.sql (begin … rollback; red without this file).
begin;

create or replace function public.reduce_subscription_seats(
  p_tenant_id        uuid,
  p_subscription_id  uuid,
  p_seats_removed    integer,
  p_timing           text,
  p_unused_gross     integer,
  p_new_mrr          integer,
  p_idempotency_key  text,
  p_actor            uuid,
  p_seats_before     integer
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-2252: a seat cut — now (credit note on the part's invoice, R-2255 split) or at end of term.
   R-2584: a scheduled cut dated before today (IST) is stale — it no longer blocks a new cut. */
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
  /* The route priced the cut from the seats it read; a change in between (Add seats) → price again. */
  if p_seats_before is distinct from v_sub.seats then
    raise exception 'The seats changed to % while this was open — close Manage seats and open it again', v_sub.seats
      using errcode = 'check_violation';
  end if;
  if v_sub.written_off_at is not null then
    raise exception 'This subscription''s dues are written off — a seat cut with credit would contradict the write-off. Use Correct details instead.'
      using errcode = 'check_violation';
  end if;
  if p_seats_removed >= coalesce(v_sub.seats, 0) then
    raise exception 'At least 1 seat must stay — this subscription has %. To stop every seat, cancel the subscription instead.', v_sub.seats
      using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.subscription_seat_reductions r
              where r.subscription_id = v_sub.id and r.status = 'scheduled'
                and r.effective_date >= v_today) then
    raise exception 'A seat cut is already scheduled for the end of this term — it must happen (or be removed) before another seat cut'
      using errcode = 'check_violation';
  end if;

  if p_timing = 'end_of_term' then
    v_eff := v_sub.renewal_date;
    if v_eff is null then
      raise exception 'This subscription has no renewal date to schedule the cut on' using errcode = 'check_violation';
    end if;
    if v_eff < v_today then
      raise exception 'The renewal date % has already passed — renew or correct the subscription first', to_char(v_eff, 'DD Mon YYYY')
        using errcode = 'check_violation';
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
       /* It must be THIS term's bill: raised no earlier than a month before the term began. */
       and i.invoice_date >= (v_sub.renewal_date - make_interval(months => greatest(1, coalesce(v_sub.term_months, 12))))::date - 31
     order by i.invoice_date desc, i.created_at desc limit 1;
  end if;

  if v_inv_id is not null then
    select i.id, i.status::text as status, i.amount, i.net_payable, i.paid_amount, i.adjusted_advances, i.written_off_at
      into v_inv from public.invoices i where i.id = v_inv_id and i.tenant_id = p_tenant_id for update;
    if not found or v_inv.status in ('draft', 'void') then
      v_inv_id := null;
    end if;
  end if;

  if v_inv_id is not null and v_inv.written_off_at is not null and v_unused > 0 then
    raise exception 'Invoice % is written off — a credit note on it would contradict the write-off. Use Correct details instead.', v_inv_id
      using errcode = 'check_violation';
  end if;

  if v_inv_id is null and v_unused > 0 then
    raise exception 'This part has no tax invoice yet, so there is no invoice to credit. Reduce the seats after the part is invoiced.'
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
        v_inv_id, v_cn_amt, 'seats_reduced',
        format('Seats reduced from %s to %s on %s', v_sub.seats, v_sub.seats - p_seats_removed, to_char(v_today, 'DD Mon YYYY')),
        format('R-2252 Reduce seats: unused value ₹%s — lowers what is owed ₹%s, credit ₹%s', v_unused, v_lower, v_credit),
        true);
      v_cn_id := v_cn->>'credit_note_id';
      /* Store what the core really booked as the customer's credit (its own settled rule). */
      v_credit := least(v_cn_amt, greatest(0, coalesce((v_cn->>'customer_credit')::int, 0)));
      v_lower  := v_cn_amt - v_credit;
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

comment on function public.reduce_subscription_seats(uuid, uuid, integer, text, integer, integer, text, uuid, integer) is
  'R-2252 + R-2584 (a scheduled cut dated before today no longer blocks): seat cut from Manage seats. end_of_term → scheduled row only. now → one credit note on the part''s tax invoice for min(unused, open) + min(rest, received − already credited) (R-2255 split), seats + mrr lowered, balance re-synced (R-2178). Server-only.';

revoke all on function public.reduce_subscription_seats(uuid, uuid, integer, text, integer, integer, text, uuid, integer) from public, anon, authenticated;
grant execute on function public.reduce_subscription_seats(uuid, uuid, integer, text, integer, integer, text, uuid, integer) to service_role;

/* R-2252 + R-2584: take back the scheduled cut(s) — every scheduled row of the subscription, stale ones too. */
create or replace function public.cancel_scheduled_seat_reduction(p_tenant_id uuid, p_subscription_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_out jsonb;
begin
  if public.current_request_role() is distinct from 'service_role' then
    raise exception 'cancel_scheduled_seat_reduction is server-only — use Manage seats' using errcode = '42501';
  end if;
  /* R-2584: more than one row can be scheduled (a stale one + a live one) — cancel them all. */
  with c as (
    update public.subscription_seat_reductions r
       set status = 'cancelled'
     where r.tenant_id = p_tenant_id and r.subscription_id = p_subscription_id and r.status = 'scheduled'
    returning r.*
  )
  select to_jsonb(c) into v_out from c order by c.effective_date desc, c.created_at desc limit 1;
  if v_out is null then
    raise exception 'No seat cut is scheduled on this subscription' using errcode = 'no_data_found';
  end if;
  return v_out;
end;
$function$;
revoke all on function public.cancel_scheduled_seat_reduction(uuid, uuid) from public, anon, authenticated;
grant execute on function public.cancel_scheduled_seat_reduction(uuid, uuid) to service_role;

commit;
