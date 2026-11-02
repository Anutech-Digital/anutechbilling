-- deploy-peek: exists(select 1 from pg_trigger where tgname = 'trg_quote_revision_renewal_handover' and tgrelid = to_regclass('public.quotes')) and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_quotes_add_seats_take_back()') and prosrc like '%R-2368%')
-- deploy-key: r2368revisesublink
-- 20261102123939_r2368_revise_keeps_subscription_link
--
-- WHAT THIS CHANGES (R-2368, p1 — staging reconcile 2 Nov 2026)
--   Revising an add-seats quote made a -R2 with no link to the subscription (revise.ts did not
--   copy add_seats_subscription_id): Q-A378-27-0565-R2..0567-R2 and Q-…-0880-R2 on staging.
--   The app now copies the add-seats link (and the MRR the seats added) into the revision draft.
--   Two database rules make that copy safe, and close the same hole for renewal quotes:
--
--   1. tg_quotes_add_seats_take_back (R-1705, redefined from its only definition): closing an
--      add-seats quote takes its seats back ONLY when no other open quote of the same revision
--      family still quotes those seats for the same subscription. With the link now on the
--      draft too, a revision closed while the quote it revises is still out must not take the
--      seats back a second time (once for each copy).
--   2. trg_quote_revision_renewal_handover (new): a renewal quote's link is one quote per
--      subscription term (quotes_one_renewal_per_term), so the revision draft cannot carry it.
--      When the revision is SENT and replaces the old quote (tg_quote_revision_sent → expired +
--      superseded_by), the old quote's renewal_subscription_id / renewal_term_date move to the
--      revision and subscriptions.renewal_quote_id is pointed at the revision. Before this,
--      paying a renewal -R2 found no subscription and went down the NEW-SALE path (a second
--      subscription). Only within the revision family — a quote closed as replaced by some
--      other accepted quote of the lead keeps its link.
--
--   No data repair here: the 4 staging -R2 quotes are listed on card R-2368 for a check after
--   deploy.

begin;

-- ── 1. take-back: not while another quote of the family still quotes the seats ──────────
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
  /* R-1705: an add-seats quote that is rejected / expires takes its seats back.
     R-2368: once per revision family (see below). */
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

  /* R-2368: a revision now carries the same add-seats link from its draft on. The seats come
     off the subscription ONCE per family: not while another quote of the family is still out
     with the customer for them, and not again when one of the family already took them back. */
  if new.add_seats_subscription_id is not null and exists (
       select 1 from public.quotes f
        where f.tenant_id = new.tenant_id
          and f.id <> new.id
          and (f.id = coalesce(new.revision_of, new.id) or f.revision_of = coalesce(new.revision_of, new.id))
          and f.add_seats_subscription_id = new.add_seats_subscription_id
          and (f.add_seats_taken_back_at is not null
               or (f.status in ('sent', 'viewed', 'accepted') and f.superseded_by is null))) then
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

-- ── 2. a sent revision takes over the renewal link of the quote it replaces ─────────────
create or replace function public.tg_quote_revision_renewal_handover()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_family_revision boolean;
begin
  /* R-2368: only when THIS update replaces the quote by a revision of its own family. */
  if new.superseded_by is null or old.superseded_by is not null then
    return case when tg_when = 'BEFORE' then new else null end;
  end if;
  select exists (select 1 from public.quotes r
                  where r.id = new.superseded_by and r.tenant_id = new.tenant_id
                    and r.revision_of = coalesce(new.revision_of, new.id))
    into v_is_family_revision;
  if not v_is_family_revision then
    return case when tg_when = 'BEFORE' then new else null end;
  end if;

  if tg_when = 'BEFORE' then
    /* One quote per subscription term (quotes_one_renewal_per_term): free the link here so
       the AFTER step can give it to the revision. */
    if new.renewal_subscription_id is not null
       and exists (select 1 from public.quotes r
                    where r.id = new.superseded_by and r.tenant_id = new.tenant_id
                      and r.renewal_subscription_id is null) then
      new.renewal_subscription_id := null;
      new.renewal_term_date       := null;
    end if;
    return new;
  end if;

  if old.renewal_subscription_id is not null and new.renewal_subscription_id is null then
    update public.quotes r
       set renewal_subscription_id = old.renewal_subscription_id,
           renewal_term_date       = old.renewal_term_date
     where r.id = new.superseded_by and r.tenant_id = new.tenant_id
       and r.renewal_subscription_id is null;
  end if;
  /* The subscription's open renewal quote is now the revision (record_payment renews by it). */
  update public.subscriptions s
     set renewal_quote_id = new.superseded_by
   where s.tenant_id = new.tenant_id and s.renewal_quote_id = new.id;
  return null;
end
$$;
revoke all on function public.tg_quote_revision_renewal_handover() from public, anon, authenticated;

drop trigger if exists trg_quote_revision_renewal_handover on public.quotes;
create trigger trg_quote_revision_renewal_handover
  before update of superseded_by on public.quotes
  for each row execute function public.tg_quote_revision_renewal_handover();

drop trigger if exists trg_quote_revision_renewal_handover_after on public.quotes;
create trigger trg_quote_revision_renewal_handover_after
  after update of superseded_by on public.quotes
  for each row execute function public.tg_quote_revision_renewal_handover();

commit;
