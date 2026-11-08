-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.create_renewal_quote(uuid,uuid,jsonb)') and prosrc like '%R-2613%') and exists(select 1 from pg_trigger where tgname = 'subscriptions_r2613_quote_link_guard') and exists(select 1 from pg_trigger where tgname = 'subscriptions_r2613_seat_cut_redate')
-- deploy-key: r2613seatcutquotelinkrace
-- 20261108133000_r2613_seat_cut_quote_link_race.sql
--
-- R-2613 (8 Nov 2026, R-2608 independent review follow-ups; money rule N5).
--
-- 1. THE RACE. createOrGetRenewalQuote (cron / "Generate renewal quote") and createExtensionQuote
--    read the scheduled end-of-term seat cuts (R-2252) in the app, BEFORE anything locks the
--    subscription. A cut scheduled in that window (reduce_subscription_seats locks the row, sees no
--    quote linked, saves the cut) was followed by a FULL-seat quote being linked — it would bill
--    the seats the owner had cut.
--      * create_renewal_quote (body = its only definition, 20261018162355_r1574_renewal_quote_once,
--        verbatim + the R-2613 blocks; auth.role() → public.current_request_role()) now re-reads the
--        scheduled cut AFTER it has locked the subscription row and refuses to make — or re-link —
--        a quote whose seats are not the cut's seats_after. The check runs before a quote number is
--        taken, so a refusal leaves nothing behind; the next run reads the cut and makes the quote
--        with it (R-2583).
--      * subscriptions_r2613_quote_link_guard (new BEFORE UPDATE OF renewal_quote_id trigger): the
--        same check on EVERY link of a renewal / extension quote (is_renewal, extension_months > 0),
--        whoever links it — createExtensionQuote links with a plain client update, not an RPC.
--        Plan-change and support-upgrade quotes (extension_months = 0) are not renewals: untouched.
--    Lock order: reduce_subscription_seats, create_renewal_quote and the link UPDATE all take the
--    subscription row lock first. Whoever comes second waits for the first to commit and then
--    reads it (READ COMMITTED: each statement in a plpgsql function / trigger takes a new snapshot
--    after the lock): a quote linked first → the cut is refused (R-2608); a cut saved first → the
--    full-seat quote is refused here.
--    "The applying cut" = the same rule as lib/renewals/scheduled-seat-cut.ts renewalSeatCut: exactly
--    one row status 'scheduled', timing 'end_of_term', effective_date = the renewal date, made on the
--    seats the subscription has now (seats_before = seats), seats_after between 1 and seats - 1.
--    A cut that no longer applies (seats changed since / two rows) is not billed by the renewal
--    quote either (it keeps today's seats with a note), so it refuses nothing.
--
-- 2. CORRECT DETAILS MOVES THE RENEWAL DATE BACKWARD (or clears it). The scheduled cut stayed dated
--    the old renewal date: never matched by the renewal quote (R-2583 matches the date), and it
--    blocked new cuts until then. subscriptions_r2613_seat_cut_redate (AFTER UPDATE OF renewal_date):
--    new date today (IST) or later → the cut moves to the new date (it is still "the end of this
--    term"); new date in the past or cleared → the cut is cancelled (never applied retroactively,
--    R-2584). Moving the date FORWARD stays with R-2608's trigger (cut cancelled). The Correct
--    details dialog tells the owner when the date is moved earlier.
--
-- Same signature, SECURITY DEFINER, search_path, grants. Stored rows are NOT changed.
-- Test: supabase/tests/r2613_seat_cut_quote_link_race.test.sql (begin … rollback; red without this file).
begin;

/* R-2613: the seat count of the scheduled end-of-term cut the renewal for p_renewal_date bills, or
   null when none applies. Same rule as lib/renewals/scheduled-seat-cut.ts renewalSeatCut. */
create or replace function public.r2613_applying_seat_cut(
  p_tenant_id uuid, p_subscription_id uuid, p_seats integer, p_renewal_date date
)
returns public.subscription_seat_reductions
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_n   integer;
  v_row public.subscription_seat_reductions%rowtype;
begin
  if p_renewal_date is null or p_seats is null then
    return null;
  end if;
  select count(*) into v_n
    from public.subscription_seat_reductions r
   where r.tenant_id = p_tenant_id and r.subscription_id = p_subscription_id
     and r.status = 'scheduled' and r.timing = 'end_of_term' and r.effective_date = p_renewal_date;
  if v_n <> 1 then
    return null;
  end if;
  select * into v_row
    from public.subscription_seat_reductions r
   where r.tenant_id = p_tenant_id and r.subscription_id = p_subscription_id
     and r.status = 'scheduled' and r.timing = 'end_of_term' and r.effective_date = p_renewal_date;
  if v_row.seats_before is distinct from p_seats or v_row.seats_after >= p_seats or v_row.seats_after < 1 then
    return null;
  end if;
  return v_row;
end;
$function$;
revoke all on function public.r2613_applying_seat_cut(uuid, uuid, integer, date) from public, anon, authenticated;
grant execute on function public.r2613_applying_seat_cut(uuid, uuid, integer, date) to service_role;

-- ─── create_renewal_quote ───────────────────────────────────────────────────
create or replace function public.create_renewal_quote(
  p_subscription_id uuid,
  p_tenant_id       uuid,
  p_quote           jsonb
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-1574: ONE transaction — lock the subscription, reuse its quote or make one and link it.
   R-2613: a scheduled end-of-term seat cut is re-read under that lock — a quote (new or re-linked)
   at other seats than the cut's is refused (rule N5). */
declare
  v_trusted  boolean;
  v_caller   uuid;
  v_sub      record;
  v_q        record;
  v_id       text;
  v_amount   integer;
  v_subtotal integer;
  v_tax      integer;
  v_lines    jsonb;
  v_cut      public.subscription_seat_reductions%rowtype;
  v_seats    integer;
begin
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company context — sign in again, then generate the renewal quote.' using errcode = '28000';
  end if;
  if not v_trusted
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can make a renewal quote. Ask one of them to press "Generate renewal quote" on the subscription.' using errcode = '42501';
  end if;
  if p_subscription_id is null or p_tenant_id is null then
    raise exception 'A renewal quote needs its subscription and company. Open the subscription and press "Generate renewal quote" again.' using errcode = '22004';
  end if;

  select s.id, s.tenant_id, s.renewal_date, s.renewal_quote_id, s.customer_id, s.customer_name, s.seats
    into v_sub
    from public.subscriptions s
   where s.id = p_subscription_id
   for update;
  if not found then
    raise exception 'Subscription % was not found, so no renewal quote was made. Refresh the Renewals page and try again.', p_subscription_id using errcode = 'P0002';
  end if;
  if v_sub.tenant_id <> p_tenant_id or (v_caller is not null and v_sub.tenant_id <> v_caller) then
    raise exception 'Subscription % belongs to another company, so no renewal quote was made. Open it from your own Renewals page.', p_subscription_id using errcode = '42501';
  end if;
  if v_sub.renewal_date is null then
    raise exception 'Subscription % has no renewal date, so its renewal quote cannot be made. Set the renewal date on the subscription first.', p_subscription_id using errcode = '22004';
  end if;

  -- 1. Already linked → that quote (also an extension quote: one open renewal at a time).
  if v_sub.renewal_quote_id is not null then
    select q.id, q.amount, q.subtotal, q.discount_pct, q.tax_rate, q.line_items
      into v_q
      from public.quotes q
     where q.id = v_sub.renewal_quote_id and q.tenant_id = v_sub.tenant_id;
    if found then
      return jsonb_build_object('quote_id', v_q.id, 'created', false, 'relinked', false,
        'amount', v_q.amount, 'subtotal', v_q.subtotal, 'discount_pct', v_q.discount_pct,
        'tax_rate', v_q.tax_rate, 'line_items', v_q.line_items);
    end if;
  end if;

  /* R-2613: the cut scheduled for this renewal, read AFTER the row lock above — a cut saved while
     the app was pricing this quote is seen here (reduce_subscription_seats locks the same row). */
  v_cut := public.r2613_applying_seat_cut(v_sub.tenant_id, v_sub.id, v_sub.seats, v_sub.renewal_date);

  -- 2. A quote already made for THIS term that lost its link → link it again, make nothing.
  select q.id, q.amount, q.subtotal, q.discount_pct, q.tax_rate, q.line_items, q.seats
    into v_q
    from public.quotes q
   where q.tenant_id = v_sub.tenant_id
     and q.renewal_subscription_id = v_sub.id
     and q.renewal_term_date = v_sub.renewal_date
   limit 1;
  if found then
    if v_cut.id is not null and v_q.seats is distinct from v_cut.seats_after then
      raise exception 'Renewal quote % for this term is for % seats, but a seat cut to % seats is scheduled for % — so it was not linked. Delete that quote, then generate the renewal quote again (it is made with the cut).',
        v_q.id, coalesce(v_q.seats::text, 'unknown'), v_cut.seats_after, to_char(v_cut.effective_date, 'DD Mon YYYY')
        using errcode = 'check_violation';
    end if;
    update public.subscriptions set renewal_quote_id = v_q.id
     where id = v_sub.id and tenant_id = v_sub.tenant_id;
    return jsonb_build_object('quote_id', v_q.id, 'created', false, 'relinked', true,
      'amount', v_q.amount, 'subtotal', v_q.subtotal, 'discount_pct', v_q.discount_pct,
      'tax_rate', v_q.tax_rate, 'line_items', v_q.line_items);
  end if;

  -- 3. Make it. Refuse a quote with nothing to pay rather than store one.
  v_amount   := nullif(p_quote->>'amount', '')::integer;
  v_subtotal := nullif(p_quote->>'subtotal', '')::integer;
  v_tax      := coalesce(nullif(p_quote->>'tax_rate', '')::integer, 18);
  v_lines    := p_quote->'line_items';
  if v_amount is null or v_amount <= 0 or v_subtotal is null or v_subtotal <= 0 then
    raise exception 'The renewal quote for subscription % has no price, so it was not made. Check the plan price in Items, then generate it again.', p_subscription_id using errcode = '22023';
  end if;
  if v_lines is null or jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) = 0 then
    raise exception 'The renewal quote for subscription % has no line, so it was not made. Generate it again from the subscription.', p_subscription_id using errcode = '22023';
  end if;
  /* R-2613: priced before the cut was saved → refused before a quote number is taken. */
  v_seats := nullif(p_quote->>'seats', '')::integer;
  if v_cut.id is not null and v_seats is distinct from v_cut.seats_after then
    raise exception 'A seat cut to % seats was scheduled for % while this renewal quote was being made for % seats, so it was not made. Generate the renewal quote again — it is made with the cut.',
      v_cut.seats_after, to_char(v_cut.effective_date, 'DD Mon YYYY'), coalesce(v_seats::text, 'unknown')
      using errcode = 'check_violation';
  end if;

  v_id := public.next_document_number('quote', v_sub.tenant_id);
  if v_id is null then
    raise exception 'No quote number could be issued, so no renewal quote was made. Check Settings → Document numbering, then try again.' using errcode = 'P0001';
  end if;

  insert into public.quotes (
    id, tenant_id, customer_id, customer_name, plan, seats, amount, status, payment_status,
    owner_id, domain, created_date, expires_date, line_items, subtotal, total_cost,
    discount_pct, tax_rate, is_renewal, extension_months, notes,
    renewal_subscription_id, renewal_term_date
  ) values (
    v_id, v_sub.tenant_id, v_sub.customer_id,
    coalesce(nullif(p_quote->>'customer_name', ''), v_sub.customer_name),
    p_quote->>'plan',
    nullif(p_quote->>'seats', '')::integer,
    v_amount, 'sent', 'awaiting',
    null,
    nullif(p_quote->>'domain', ''),
    coalesce(nullif(p_quote->>'created_date', '')::date, (now() at time zone 'Asia/Kolkata')::date),
    nullif(p_quote->>'expires_date', '')::date,
    v_lines,
    v_subtotal,
    coalesce(nullif(p_quote->>'total_cost', '')::integer, 0),
    0,
    v_tax,
    true,
    coalesce(nullif(p_quote->>'extension_months', '')::integer, 12),
    p_quote->>'notes',
    v_sub.id, v_sub.renewal_date
  );

  update public.subscriptions set renewal_quote_id = v_id
   where id = v_sub.id and tenant_id = v_sub.tenant_id;

  return jsonb_build_object('quote_id', v_id, 'created', true, 'relinked', false,
    'amount', v_amount, 'subtotal', v_subtotal, 'discount_pct', 0,
    'tax_rate', v_tax, 'line_items', v_lines);
end;
$function$;

revoke all on function public.create_renewal_quote(uuid, uuid, jsonb) from public, anon;
grant execute on function public.create_renewal_quote(uuid, uuid, jsonb) to authenticated, service_role;

-- ─── link guard: every renewal / extension quote linked to a subscription ──────
create or replace function public.r2613_quote_link_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-2613 (rule N5): a renewal or extension quote linked while a seat cut is scheduled for the
   renewal must be for the cut's seats — else it bills the seats the owner cut. The UPDATE holds
   the subscription row lock, so a cut saved just before (reduce_subscription_seats locks the same
   row) is seen here. */
declare
  v_cut public.subscription_seat_reductions%rowtype;
  v_q   record;
begin
  v_cut := public.r2613_applying_seat_cut(new.tenant_id, new.id, new.seats, new.renewal_date);
  if v_cut.id is null then
    return new;
  end if;
  select q.id, q.seats, q.is_renewal, q.extension_months into v_q
    from public.quotes q where q.id = new.renewal_quote_id and q.tenant_id = new.tenant_id;
  if found and coalesce(v_q.is_renewal, false) and coalesce(v_q.extension_months, 0) > 0
     and v_q.seats is distinct from v_cut.seats_after then
    raise exception 'A seat cut to % seats is scheduled for % — quote % is for % seats, so it was not linked to the subscription. Remove the cut in Manage seats first, or let the renewal happen with the cut.',
      v_cut.seats_after, to_char(v_cut.effective_date, 'DD Mon YYYY'), v_q.id, coalesce(v_q.seats::text, 'unknown')
      using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;
revoke all on function public.r2613_quote_link_guard() from public, anon, authenticated;

drop trigger if exists subscriptions_r2613_quote_link_guard on public.subscriptions;
create trigger subscriptions_r2613_quote_link_guard
  before update of renewal_quote_id on public.subscriptions
  for each row
  when (new.renewal_quote_id is not null and new.renewal_quote_id is distinct from old.renewal_quote_id)
  execute function public.r2613_quote_link_guard();

-- ─── renewal date moved backward / cleared: the scheduled cut follows or goes ──
create or replace function public.r2613_seat_cut_redate()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-2613: Correct details moved the renewal date EARLIER (or cleared it). The cut scheduled for
   the old date is "the end of this term": today or later → it moves to the new date; in the past
   or cleared → cancelled (never applied retroactively, R-2584). Forward moves: R-2608's trigger. */
begin
  if new.renewal_date is not null and new.renewal_date >= public.ist_today() then
    update public.subscription_seat_reductions r
       set effective_date = new.renewal_date
     where r.tenant_id = new.tenant_id and r.subscription_id = new.id
       and r.status = 'scheduled' and r.timing = 'end_of_term'
       and r.effective_date = old.renewal_date;
  else
    update public.subscription_seat_reductions r
       set status = 'cancelled'
     where r.tenant_id = new.tenant_id and r.subscription_id = new.id
       and r.status = 'scheduled' and r.timing = 'end_of_term'
       and r.effective_date = old.renewal_date;
  end if;
  return null;
end;
$function$;
revoke all on function public.r2613_seat_cut_redate() from public, anon, authenticated;

drop trigger if exists subscriptions_r2613_seat_cut_redate on public.subscriptions;
create trigger subscriptions_r2613_seat_cut_redate
  after update of renewal_date on public.subscriptions
  for each row
  when (old.renewal_date is not null
        and (new.renewal_date is null or new.renewal_date < old.renewal_date))
  execute function public.r2613_seat_cut_redate();

commit;
