-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'subscription_renewal_moves' and column_name = 'resolved_at') and exists(select 1 from pg_proc where oid = to_regprocedure('public.unroll_unpaid_renewal_terms(uuid,text)') and prosrc like '%R-2761%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.roll_paid_renewal_terms(uuid)') and prosrc like '%R-2761%') and exists(select 1 from pg_trigger where tgname = 'subscriptions_r2761_recheck_held' and tgrelid = to_regclass('public.subscriptions')) and exists(select 1 from pg_trigger where tgname = 'subscriptions_r2761_renewal_date_changed' and tgrelid = to_regclass('public.subscriptions')) and exists(select 1 from pg_trigger where tgname = 'invoices_r2761_part_paid_recheck' and tgrelid = to_regclass('public.invoices'))
-- deploy-key: r2761renewalheld
-- 20261113231500_r2761_renewal_held_recheck.sql
--
-- R-2761 (14 Nov 2026, p2 money) — follow-up of R-2749 (independent review rev-r2749, MED 1 + LOW 3).
--
-- ─── BEFORE ───────────────────────────────────────────────────────────────────────────────────────
-- 1. A 'held' undo (R-2749: the renewal part's payment was undone but renewal_date was left because the
--    subscription was not active / a quote was linked on renewal_quote_id / a seat cut was scheduled) was
--    never looked at again: made active again (or the quote link cleared) with the part still unpaid, the sub
--    stayed "renewed" on the new term with no money. Held rows were visible only in the ops SQL report.
-- 2. A forward move stayed "in effect" when renewal_date was later changed back BY HAND to its from_date (no
--    back row) — a later undo could walk through that stale move and go one term too far.
--
-- ─── AFTER ────────────────────────────────────────────────────────────────────────────────────────
-- * subscription_renewal_moves gets hold_kind (not_active / quote_linked / seat_cut) and resolved_at /
--   resolved_why: a 'held' row is OPEN until a re-check settles it. One open held row per subscription.
-- * unroll_unpaid_renewal_terms (R-2749 body) now also settles the holds: nothing left unpaid on the chain →
--   open holds resolved; moved back → resolved; held again for another reason → a new held row, the old one
--   resolved; same reason → unchanged (no second row).
-- * Re-check triggers (all call unroll_unpaid_renewal_terms, which decides):
--     subscriptions_r2761_recheck_held — status back to active / paused, or renewal_quote_id cleared. Fires
--       after subscriptions_r2735_link_cleared_renews / subscriptions_r2749_reactivated_renews (trigger names
--       sort), so a waiting roll runs first.
--     invoices_r2761_part_paid_recheck — a marked part's invoice is paid again while a hold is open → the
--       hold is resolved (nothing unpaid any more).
-- * subscriptions_r2761_renewal_date_changed — renewal_date changed by anything but the roll / undo (by hand,
--   a renewal quote, Correct details): a change BACK to the from_date of an active forward move on the chain
--   ending at the old date writes the 'back' rows (the forward is no longer in effect); open holds are resolved
--   (the date the hold was about is gone). The roll / undo set a transaction-local flag around their own update
--   (app.r2761_auto_move) so they are not counted twice.
-- * roll_paid_renewal_terms: R-2749 body + that flag only.
--
-- Seat-cut holds are re-checked only by the triggers above (the cut applies AT renewal_date; moving the date
-- under it is R-2613's risk) — the Renewals row shows the open hold until the owner re-bills or changes it.
-- Test: supabase/tests/r2761_renewal_held_recheck.test.sql (one transaction, rolled back);
--       supabase/tests/r2749_renewal_undo.test.sql still passes.

begin;

-- ── 1. Hold state on the move log ────────────────────────────────────────────────────────────────────
alter table public.subscription_renewal_moves add column if not exists hold_kind text;
alter table public.subscription_renewal_moves add column if not exists resolved_at timestamptz;
alter table public.subscription_renewal_moves add column if not exists resolved_why text;
alter table public.subscription_renewal_moves drop constraint if exists subscription_renewal_moves_hold_kind_check;
alter table public.subscription_renewal_moves add constraint subscription_renewal_moves_hold_kind_check
  check (hold_kind is null or hold_kind in ('not_active', 'quote_linked', 'seat_cut'));
comment on column public.subscription_renewal_moves.hold_kind is
  'R-2761: why a held row was held — not_active (sub not active / paused), quote_linked (renewal_quote_id set), seat_cut (end-of-term seat cut scheduled).';
comment on column public.subscription_renewal_moves.resolved_at is
  'R-2761: a held row is open (shown on the Renewals row) until this is set by a re-check.';

-- R-2749 rows written before this migration (local / same train): kind from the why text.
update public.subscription_renewal_moves
   set hold_kind = case
         when why like '%NOT moved back: subscription is %' then 'not_active'
         when why like '%NOT moved back: quote %' then 'quote_linked'
         when why like '%NOT moved back: a seat cut %' then 'seat_cut'
       end
 where direction = 'held' and hold_kind is null;

create index if not exists subscription_renewal_moves_open_held_idx
  on public.subscription_renewal_moves (tenant_id, subscription_id)
  where direction = 'held' and resolved_at is null;

-- ── 2. The roll (R-2749 body) — flag around its own update ───────────────────────────────────────────
create or replace function public.roll_paid_renewal_terms(p_subscription_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
/* R-2735: a subscription billed in parts renews only by payment. Moves renewal_date over every term whose
   marked first part (renews_from = the CURRENT renewal_date) has a PAID tax invoice, oldest first. Guarded
   on renewal_date = renews_from, so a retry / second payment moves nothing. Returns the number of terms rolled.
   R-2749: each move is logged in subscription_renewal_moves ('forward') so an undone payment can move it back.
   R-2761: sets app.r2761_auto_move around its update (the renewal-date-changed trigger skips it). */
declare
  v_trusted boolean;
  v_caller  uuid := public.current_tenant_id();
  v_sub     record;
  v_b       record;
  v_rolls   integer := 0;
  v_n       integer;
begin
  v_trusted := current_setting('role', true) = 'service_role'
               or (coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon')
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime', 'app_anon', 'app_jobs'));
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — only a user of the subscription''s company can renew it' using errcode = '28000';
  end if;
  for i in 1..24 loop
    select s.id, s.tenant_id, s.renewal_date, s.status::text as status, s.renewal_quote_id into v_sub
      from public.subscriptions s where s.id = p_subscription_id for update;
    if not found or v_sub.renewal_date is null or v_sub.status not in ('active', 'paused')
       or v_sub.renewal_quote_id is not null then
      exit;
    end if;
    if v_caller is not null and v_sub.tenant_id is distinct from v_caller then
      raise exception 'Subscription % is not in the caller''s company', p_subscription_id using errcode = '42501';
    end if;
    select b.id, b.renews_to, b.invoice_id into v_b
      from public.subscription_billings b
      join public.invoices i on i.id = b.invoice_id and i.tenant_id = b.tenant_id
     where b.subscription_id = v_sub.id
       and b.tenant_id = v_sub.tenant_id
       and b.renews_from = v_sub.renewal_date
       and i.status = 'paid'
     order by b.term_start, b.period_index
     limit 1;
    if not found then
      exit;
    end if;
    perform set_config('app.r2761_auto_move', 'on', true);
    update public.subscriptions
       set renewal_date = v_b.renews_to,
           renewal_state = 'renewed',
           reminder_count = 0,
           last_reminder_sent_at_v2 = null
     where id = v_sub.id and tenant_id = v_sub.tenant_id and renewal_date = v_sub.renewal_date
       and renewal_quote_id is null;
    get diagnostics v_n = row_count;
    perform set_config('app.r2761_auto_move', 'off', true);
    exit when v_n = 0;
    insert into public.subscription_renewal_moves (tenant_id, subscription_id, billing_id, direction, from_date, to_date, invoice_id, why)
    values (v_sub.tenant_id, v_sub.id, v_b.id, 'forward', v_sub.renewal_date, v_b.renews_to, v_b.invoice_id,
            'renewal part paid (invoice ' || v_b.invoice_id || ')');
    v_rolls := v_rolls + 1;
  end loop;
  return v_rolls;
end;
$$;
revoke all on function public.roll_paid_renewal_terms(uuid) from public, anon, authenticated;
grant execute on function public.roll_paid_renewal_terms(uuid) to service_role;

-- ── 3. The undo (R-2749 body) — settles holds ────────────────────────────────────────────────────────
create or replace function public.unroll_unpaid_renewal_terms(p_subscription_id uuid, p_why text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
/* R-2749: a renewal part's payment was undone → move renewal_date back to the term's renews_from, once.
   Walks back the chain of ACTIVE 'forward' moves (not yet reversed by a later 'back' of the same term) that
   ends at the CURRENT renewal_date — no such row (a hand-changed date) ends it, so a hand-changed date is never
   touched. The oldest term in that chain whose part is no longer paid decides: renewal_date goes back to its
   renews_from (newer terms rolled on top wait behind it again), renewal_state 'pending', reminders reset.
   HELD (date left, one 'held' row — the owner sees it on the Renewals row): the subscription is not active /
   paused, a quote is linked on renewal_quote_id, or a seat cut is scheduled for the end of the current term.
   R-2761: also the re-check of an open hold — nothing left unpaid → holds resolved; moved back → resolved;
   held for another reason → new held row, the old one resolved; same reason → no second row.
   Returns the number of terms moved back. */
declare
  v_trusted boolean;
  v_caller  uuid := public.current_tenant_id();
  v_sub     record;
  v_m       record;
  v_date    date;
  v_chain   bigint[] := '{}';
  v_upto    integer := 0;
  v_target  date;
  v_oldest  record;
  v_hold    text;
  v_kind    text;
  v_n       integer;
  v_paid    boolean;
  v_new     bigint;
  v_why     text := coalesce(nullif(btrim(p_why), ''), 'renewal part payment undone');
begin
  v_trusted := current_setting('role', true) = 'service_role'
               or (coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon')
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime', 'app_anon', 'app_jobs'));
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — only a user of the subscription''s company can change it' using errcode = '28000';
  end if;
  select s.id, s.tenant_id, s.renewal_date, s.status::text as status, s.renewal_quote_id into v_sub
    from public.subscriptions s where s.id = p_subscription_id for update;
  if not found or v_sub.renewal_date is null then
    return 0;
  end if;
  if v_caller is not null and v_sub.tenant_id is distinct from v_caller then
    raise exception 'Subscription % is not in the caller''s company', p_subscription_id using errcode = '42501';
  end if;

  v_date := v_sub.renewal_date;
  for i in 1..24 loop
    select m.id, m.billing_id, m.from_date, m.to_date into v_m
      from public.subscription_renewal_moves m
     where m.subscription_id = v_sub.id and m.tenant_id = v_sub.tenant_id
       and m.direction = 'forward' and m.to_date = v_date
       and not exists (select 1 from public.subscription_renewal_moves r
                        where r.subscription_id = m.subscription_id and r.tenant_id = m.tenant_id
                          and r.direction = 'back' and r.id > m.id
                          and r.from_date = m.to_date and r.to_date = m.from_date)
     order by m.id desc
     limit 1;
    exit when not found;
    v_chain := v_chain || v_m.id;
    select exists (
      select 1 from public.subscription_billings b
        join public.invoices i on i.id = b.invoice_id and i.tenant_id = b.tenant_id
       where b.subscription_id = v_sub.id and b.tenant_id = v_sub.tenant_id
         and b.renews_from = v_m.from_date and b.renews_to = v_m.to_date
         and i.status = 'paid') into v_paid;
    if not v_paid then
      v_upto := i;            -- walking back = older; the last hit is the OLDEST unpaid term
      v_target := v_m.from_date;
      v_oldest := v_m;
    end if;
    v_date := v_m.from_date;
  end loop;
  if v_upto = 0 then
    /* R-2761: nothing unpaid on the chain ending at today's date → an open hold no longer applies. */
    update public.subscription_renewal_moves
       set resolved_at = now(), resolved_why = v_why || ' — nothing left to move back'
     where subscription_id = v_sub.id and tenant_id = v_sub.tenant_id and direction = 'held' and resolved_at is null;
    return 0;
  end if;

  v_kind := case
    when v_sub.status not in ('active', 'paused') then 'not_active'
    when v_sub.renewal_quote_id is not null then 'quote_linked'
    when exists (select 1 from public.subscription_seat_reductions r
                  where r.tenant_id = v_sub.tenant_id and r.subscription_id = v_sub.id
                    and r.status = 'scheduled' and r.timing = 'end_of_term' and r.effective_date = v_sub.renewal_date)
      then 'seat_cut'
  end;
  v_hold := case v_kind
    when 'not_active' then 'subscription is ' || v_sub.status || ' — its end date is kept'
    when 'quote_linked' then 'quote ' || v_sub.renewal_quote_id || ' is linked for the next term'
    when 'seat_cut' then 'a seat cut is scheduled for ' || to_char(v_sub.renewal_date, 'DD Mon YYYY')
  end;
  if v_kind is not null then
    if not exists (select 1 from public.subscription_renewal_moves h
                    where h.subscription_id = v_sub.id and h.tenant_id = v_sub.tenant_id and h.direction = 'held'
                      and h.resolved_at is null and h.id > v_oldest.id
                      and h.from_date = v_sub.renewal_date and h.to_date = v_target
                      and h.hold_kind is not distinct from v_kind) then
      insert into public.subscription_renewal_moves (tenant_id, subscription_id, billing_id, direction, from_date, to_date, invoice_id, why, hold_kind)
      values (v_sub.tenant_id, v_sub.id, v_oldest.billing_id, 'held', v_sub.renewal_date, v_target, null,
              v_why || ' — NOT moved back: ' || v_hold, v_kind)
      returning id into v_new;
      update public.subscription_renewal_moves
         set resolved_at = now(), resolved_why = 'held again: ' || v_hold
       where subscription_id = v_sub.id and tenant_id = v_sub.tenant_id and direction = 'held'
         and resolved_at is null and id <> v_new;
    end if;
    return 0;
  end if;

  perform set_config('app.r2761_auto_move', 'on', true);
  update public.subscriptions
     set renewal_date = v_target,
         renewal_state = 'pending',
         reminder_count = 0,
         last_reminder_sent_at_v2 = null
   where id = v_sub.id and tenant_id = v_sub.tenant_id and renewal_date = v_sub.renewal_date
     and renewal_quote_id is null;
  get diagnostics v_n = row_count;
  perform set_config('app.r2761_auto_move', 'off', true);
  if v_n = 0 then
    return 0;
  end if;
  insert into public.subscription_renewal_moves (tenant_id, subscription_id, billing_id, direction, from_date, to_date, invoice_id, why)
  select m.tenant_id, m.subscription_id, m.billing_id, 'back', m.to_date, m.from_date, m.invoice_id, v_why
    from unnest(v_chain[1:v_upto]) with ordinality as c(mid, ord)
    join public.subscription_renewal_moves m on m.id = c.mid
   order by c.ord;
  update public.subscription_renewal_moves
     set resolved_at = now(), resolved_why = v_why || ' — moved back to ' || to_char(v_target, 'DD Mon YYYY')
   where subscription_id = v_sub.id and tenant_id = v_sub.tenant_id and direction = 'held' and resolved_at is null;
  return v_upto;
end;
$$;
revoke all on function public.unroll_unpaid_renewal_terms(uuid, text) from public, anon, authenticated;
grant execute on function public.unroll_unpaid_renewal_terms(uuid, text) to service_role;

-- ── 4. Re-check: active again / quote link cleared ───────────────────────────────────────────────────
create or replace function public.tg_r2761_recheck_held()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2761: status back to active / paused, or renewal_quote_id cleared → re-check an undone renewal part
   (moves back if its part is still unpaid; no-op without an active forward chain ending at renewal_date). */
begin
  perform public.unroll_unpaid_renewal_terms(new.id,
    case when old.status is distinct from new.status and new.status in ('active', 'paused')
         then 'subscription ' || new.status::text || ' again'
         else 'quote ' || coalesce(old.renewal_quote_id, '') || ' unlinked' end);
  return new;
end;
$$;
revoke all on function public.tg_r2761_recheck_held() from public, anon, authenticated;

drop trigger if exists subscriptions_r2761_recheck_held on public.subscriptions;
create trigger subscriptions_r2761_recheck_held
  after update of status, renewal_quote_id on public.subscriptions
  for each row
  when ((new.status in ('active', 'paused') and old.status not in ('active', 'paused'))
        or (old.renewal_quote_id is not null and new.renewal_quote_id is null))
  execute function public.tg_r2761_recheck_held();

-- ── 5. Re-check: the part's invoice is paid again while a hold is open ───────────────────────────────
create or replace function public.tg_r2761_part_paid_recheck()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2761: a marked part's invoice turned paid while its subscription has an open hold → re-check (resolves it). */
declare
  v_sid uuid;
begin
  for v_sid in
    select distinct b.subscription_id from public.subscription_billings b
     where b.invoice_id = new.id and b.tenant_id = new.tenant_id and b.renews_to is not null
       and exists (select 1 from public.subscription_renewal_moves h
                    where h.subscription_id = b.subscription_id and h.tenant_id = b.tenant_id
                      and h.direction = 'held' and h.resolved_at is null)
  loop
    perform public.unroll_unpaid_renewal_terms(v_sid, 'invoice ' || new.id || ' paid again');
  end loop;
  return new;
end;
$$;
revoke all on function public.tg_r2761_part_paid_recheck() from public, anon, authenticated;

drop trigger if exists invoices_r2761_part_paid_recheck on public.invoices;
create trigger invoices_r2761_part_paid_recheck
  after update of status on public.invoices
  for each row
  when (new.status = 'paid' and old.status is distinct from 'paid')
  execute function public.tg_r2761_part_paid_recheck();

-- ── 6. renewal_date changed outside the roll / undo ──────────────────────────────────────────────────
create or replace function public.tg_r2761_renewal_date_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2761 (rev-r2749 LOW 3): renewal_date changed by anything but roll_paid_renewal_terms /
   unroll_unpaid_renewal_terms. Back to the from_date of an active forward move on the chain ending at the old
   date → write the 'back' rows (those forwards are no longer in effect). Open holds are resolved — the date
   they were about is gone. */
declare
  v_m     record;
  v_date  date := old.renewal_date;
  v_chain bigint[] := '{}';
  v_hit   boolean := false;
begin
  if coalesce(current_setting('app.r2761_auto_move', true), '') = 'on' then
    return new;
  end if;
  if old.renewal_date is not null and new.renewal_date is not null and new.renewal_date < old.renewal_date then
    for i in 1..24 loop
      select m.id, m.from_date into v_m
        from public.subscription_renewal_moves m
       where m.subscription_id = new.id and m.tenant_id = new.tenant_id
         and m.direction = 'forward' and m.to_date = v_date
         and not exists (select 1 from public.subscription_renewal_moves r
                          where r.subscription_id = m.subscription_id and r.tenant_id = m.tenant_id
                            and r.direction = 'back' and r.id > m.id
                            and r.from_date = m.to_date and r.to_date = m.from_date)
       order by m.id desc
       limit 1;
      exit when not found;
      v_chain := v_chain || v_m.id;
      if v_m.from_date = new.renewal_date then
        v_hit := true;
        exit;
      end if;
      exit when v_m.from_date < new.renewal_date;
      v_date := v_m.from_date;
    end loop;
    if v_hit then
      insert into public.subscription_renewal_moves (tenant_id, subscription_id, billing_id, direction, from_date, to_date, invoice_id, why)
      select m.tenant_id, m.subscription_id, m.billing_id, 'back', m.to_date, m.from_date, m.invoice_id,
             'renewal date changed to ' || to_char(new.renewal_date, 'DD Mon YYYY') || ' outside the part roll'
        from unnest(v_chain) with ordinality as c(mid, ord)
        join public.subscription_renewal_moves m on m.id = c.mid
       order by c.ord;
    end if;
  end if;
  update public.subscription_renewal_moves
     set resolved_at = now(),
         resolved_why = 'renewal date changed to ' || coalesce(to_char(new.renewal_date, 'DD Mon YYYY'), 'none') || ' outside the part roll'
   where subscription_id = new.id and tenant_id = new.tenant_id and direction = 'held' and resolved_at is null;
  return new;
end;
$$;
revoke all on function public.tg_r2761_renewal_date_changed() from public, anon, authenticated;

drop trigger if exists subscriptions_r2761_renewal_date_changed on public.subscriptions;
create trigger subscriptions_r2761_renewal_date_changed
  after update of renewal_date on public.subscriptions
  for each row
  when (old.renewal_date is distinct from new.renewal_date)
  execute function public.tg_r2761_renewal_date_changed();

commit;
