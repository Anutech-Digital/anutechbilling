-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_quotes_add_seats_take_back()') and prosrc like '%R-1705%') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'add_seats_taken_back_at')
-- deploy-key: r1705seatquotetakeback
-- 20261021025445_r1705_seat_quote_reject_takes_seats_back.sql
--
-- R-1705 (P1 money, 21 Oct 2026) — added seats were never billed when the customer did not
-- take the pro-rata quote.
--
-- ─── WHAT WAS WRONG ─────────────────────────────────────────────────────────
--   Local billing audit (T-A1): Manage seats +1 → the subscription went to 11 seats and MRR
--   ₹2,970 at once; the pro-rata quote Q-F588-27-0031 (₹3,813) sat "sent". The subscription's
--   outstanding stayed ₹18,232, so the ₹3,813 was in no dues list, and "Mark rejected" only
--   flipped quotes.status — the seats and the MRR stayed. Nothing linked the quote to its
--   subscription except free text in quotes.notes ("Add-seats pro-rata for subscription <id>").
--
-- ─── DECISION: seats stay live until the quote is rejected (unchanged) ──────
--   The operator adds seats because the customer is already using them (R-800 backdating
--   exists for exactly that). Holding seats back until payment would break provisioning and
--   the vendor PO. So the seats stay; the money is made VISIBLE (open seat quotes show in the
--   subscription drawer and Payments → Subscription dues, app side) and REVERSIBLE (below).
--
-- ─── WHAT THIS DOES ─────────────────────────────────────────────────────────
--   quotes.add_seats_subscription_id / add_seats_mrr_added: written by addSeats() from now on;
--   backfilled here for existing add-seat quotes from the notes text and the contract
--   amendment the seat change wrote (seats_added, same seat count, closest after the quote).
--   quotes.add_seats_taken_back_at: when the seats were taken back.
--
--   Trigger trg_quotes_add_seats_take_back (BEFORE UPDATE OF status on quotes) — one rule for
--   EVERY path that closes a quote (quote page "Mark rejected", the lead sheet action bar,
--   SQL, any future expiry job), atomic with the status change:
--     an add-seat quote going to rejected/expired, with no money received and no invoice →
--       subscription seats − quote seats, MRR − the MRR the seats added (the
--       record_contract_amendment trigger logs it in contract_amendments, like every seat
--       change), the draft PO raised for those seats → cancelled, add_seats_taken_back_at set.
--     money received or an invoice raised → refused (refund / credit note first; nothing is
--       changed).
--     reopening a quote whose seats were taken back → refused (add the seats again from
--       Manage seats, which prices them for today).
--   Accept + pay is unchanged (record_payment skips subscription handling for add-seat quotes).
--
-- Test: supabase/tests/r1705_seat_quote_reject_takes_seats_back.test.sql

begin;

alter table public.quotes add column if not exists add_seats_subscription_id uuid
  references public.subscriptions(id) on delete set null;
alter table public.quotes add column if not exists add_seats_mrr_added integer;
alter table public.quotes add column if not exists add_seats_taken_back_at timestamptz;

comment on column public.quotes.add_seats_subscription_id is
  'R-1705: the subscription an add-seats (pro-rata) quote added seats to. Rejecting / expiring the quote takes those seats back.';
comment on column public.quotes.add_seats_mrr_added is
  'R-1705: ₹/month the add-seats change added to the subscription MRR — what is taken back on reject.';
comment on column public.quotes.add_seats_taken_back_at is
  'R-1705: when the seats of a rejected / expired add-seats quote were taken back off the subscription.';

-- ── backfill (existing add-seat quotes) ────────────────────────────────────
update public.quotes q
   set add_seats_subscription_id = s.id
  from public.subscriptions s
 where q.is_add_seats
   and q.add_seats_subscription_id is null
   and s.tenant_id = q.tenant_id
   and s.id::text = substring(q.notes from 'subscription ([0-9a-fA-F-]{36})');

update public.quotes q
   set add_seats_mrr_added = (
         select coalesce(a.mrr_to, 0) - coalesce(a.mrr_from, 0)
           from public.contract_amendments a
          where a.subscription_id = q.add_seats_subscription_id
            and a.tenant_id = q.tenant_id
            and a.seats_to - a.seats_from = q.seats
            and a.mrr_to is not null and a.mrr_from is not null
            and a.created_at >= q.created_at - interval '1 minute'
            and a.created_at <= q.created_at + interval '10 minutes'
          order by abs(extract(epoch from a.created_at - q.created_at))
          limit 1)
 where q.is_add_seats
   and q.add_seats_subscription_id is not null
   and q.add_seats_mrr_added is null;

-- ── the rule ───────────────────────────────────────────────────────────────
create or replace function public.tg_quotes_add_seats_take_back()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_closing   boolean;
  v_reopening boolean;
  v_sub_id    uuid;
  v_sub       record;
  v_received  integer;
  v_mrr_back  integer;
begin
  /* R-1705: an add-seats quote that is rejected / expires takes its seats back. */
  if not coalesce(new.is_add_seats, false) or new.status is not distinct from old.status then
    return new;
  end if;

  v_closing   := new.status in ('rejected', 'expired') and old.status not in ('rejected', 'expired');
  v_reopening := old.status in ('rejected', 'expired') and new.status not in ('rejected', 'expired');

  if v_reopening and old.add_seats_taken_back_at is not null then
    raise exception 'Quote % added seats that were taken back off the subscription when it was closed. Add the seats again from Manage seats — that prices them for today. Nothing was changed.', new.id
      using errcode = 'check_violation';
  end if;

  if not v_closing or new.add_seats_taken_back_at is not null then
    return new;
  end if;

  /* Replaced by a revision (tg_quote_revision_sent: expired + superseded_by) — the seats are
     still being quoted, on the revision. Hand the link over; take nothing back. */
  if new.superseded_by is not null then
    update public.quotes r
       set add_seats_subscription_id = coalesce(r.add_seats_subscription_id, new.add_seats_subscription_id),
           add_seats_mrr_added       = coalesce(r.add_seats_mrr_added, new.add_seats_mrr_added)
     where r.id = new.superseded_by and r.tenant_id = new.tenant_id;
    return new;
  end if;

  select coalesce(sum(p.amount), 0)::int into v_received
    from public.payments p
   where p.tenant_id = new.tenant_id and p.quote_id = new.id and p.status = 'received';
  if v_received > 0 then
    raise exception 'Quote % already has ₹% received for these seats, so it cannot be rejected — the seats are being paid for. Refund the payment first if the customer really is not taking them. Nothing was changed.', new.id, v_received
      using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.invoices i
              where i.tenant_id = new.tenant_id and i.quote_id = new.id and i.status <> 'void') then
    raise exception 'Quote % already has a GST invoice for these seats. Cancel it with a credit note first, then reject the quote. Nothing was changed.', new.id
      using errcode = 'check_violation';
  end if;

  v_sub_id := coalesce(new.add_seats_subscription_id,
                       (select s.id from public.subscriptions s
                         where s.tenant_id = new.tenant_id
                           and s.id::text = substring(new.notes from 'subscription ([0-9a-fA-F-]{36})')));
  if v_sub_id is null then
    -- Not linked to any subscription (the subscription was deleted): nothing to take back.
    return new;
  end if;

  select s.id, s.seats, s.mrr into v_sub
    from public.subscriptions s
   where s.id = v_sub_id and s.tenant_id = new.tenant_id
   for update;
  if not found then
    return new;
  end if;

  if coalesce(v_sub.seats, 0) - coalesce(new.seats, 0) < 1 then
    raise exception 'Quote % added % seat(s), but the subscription now has only %. Correct the seats on the subscription by hand, then reject the quote. Nothing was changed.', new.id, new.seats, v_sub.seats
      using errcode = 'check_violation';
  end if;

  /* The MRR the seats added (stored by addSeats since R-1705, backfilled from the contract
     amendment for older quotes); else the per-seat share of today's MRR. */
  v_mrr_back := coalesce(new.add_seats_mrr_added,
                         round(coalesce(v_sub.mrr, 0)::numeric * new.seats / greatest(v_sub.seats, 1))::int);

  update public.subscriptions
     set seats = v_sub.seats - new.seats,
         mrr   = greatest(0, coalesce(v_sub.mrr, 0) - greatest(0, v_mrr_back))
   where id = v_sub.id and tenant_id = new.tenant_id;

  /* The draft PO addSeats raised for these seats was never sent to the distributor — cancel
     it so nobody orders seats the customer turned down. Placed / provisioned POs are left
     alone (a human has acted on them). */
  update public.purchase_orders
     set status = 'cancelled'
   where tenant_id = new.tenant_id
     and subscription_id = v_sub.id
     and status = 'draft'
     and notes like '%Quote ' || new.id || '.%';

  new.add_seats_subscription_id := v_sub.id;
  new.add_seats_mrr_added       := greatest(0, v_mrr_back);
  new.add_seats_taken_back_at   := now();
  return new;
end;
$$;

revoke all on function public.tg_quotes_add_seats_take_back() from public, anon, authenticated;

drop trigger if exists trg_quotes_add_seats_take_back on public.quotes;
create trigger trg_quotes_add_seats_take_back
  before update of status on public.quotes
  for each row
  execute function public.tg_quotes_add_seats_take_back();

commit;
