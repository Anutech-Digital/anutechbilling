-- deploy-peek: to_regclass('public.renewal_quote_subscriptions') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.create_renewal_quote_together(uuid,jsonb)')) and exists(select 1 from pg_proc where oid = to_regprocedure('public.create_renewal_quote(uuid,uuid,jsonb)') and prosrc like '%a renewal quote billed together for this term%') and exists(select 1 from pg_trigger where tgname = 'trg_quotes_renewal_together_guarded' and tgrelid = to_regclass('public.quotes'))
-- deploy-key: r2847renewalquotetogether
-- 20261115125834_r2847_renewal_quote_together.sql
--
-- R-2847 (15 Nov 2026, p1 money) — R-2809a, part 1 of "yearly subscriptions: Bill together" (R-2809, parent R-2805;
-- Pratik report 8b70e37f: a customer with 2+ yearly subscriptions billed on ONE bill last year gets one renewal quote
-- per subscription today).
--
-- ─── BEFORE ───────────────────────────────────────────────────────────────────────────────────────
-- create_renewal_quote makes a renewal quote for ONE subscription; quotes_one_renewal_per_term (R-1574) keys a quote to
-- one (renewal_subscription_id, renewal_term_date). Bill together (R-2806..R-2810) is only for subscriptions billed in
-- parts and refuses yearly ones.
--
-- ─── AFTER ────────────────────────────────────────────────────────────────────────────────────────
-- * public.renewal_quote_subscriptions — one row per subscription term a renewal quote renews when it covers 2+
--   subscriptions ("billed together"): quote, subscription, renewal_term_date (the subscription's renewal_date when the
--   quote was made), extension_months (12), its own subtotal and seats, line_no, released_at. UNIQUE (subscription_id,
--   renewal_term_date) among rows not released: one together quote per subscription term; a quote closed with no money
--   on it releases ALL its rows (kept as history). Written only by security-definer functions.
-- * public.create_renewal_quote_together(p_tenant_id, p_parts jsonb) — p_parts = [{subscription_id, quote}], each
--   `quote` priced by the app exactly as create_renewal_quote's p_quote (lib/renewals/create-renewal-quote.ts: catalogue
--   price, R-2583 seat cut, export 0%). ONE transaction under a per-customer advisory lock + the subscriptions' row
--   locks (id order): 2+ active yearly subscriptions (billing_cycle yearly, 12-month term) of ONE customer → ONE
--   renewal quote ('sent'), one line per subscription line tagged subscription_id + renewal_term_date + its own period,
--   subtotal = the sum, GST on the total at one rate (export 0%), every subscription's renewal_quote_id → it. The same
--   set again → the same quote (created false; lost links put back). Refused in plain words: other customer / no
--   customer, split-billed or not a 12-month term, not active, Won't renew, no renewal date, another open renewal quote
--   (single or together), mixed GST rates, no price / no line / lines that do not add up to the part's subtotal and
--   amount, seat-cut mismatch (R-2613 N5), fewer than 2. A retry relinks only while every member is still at its quoted
--   term, active and renewing.
--   The quote's own renewal_subscription_id / renewal_term_date stay NULL (R-1574's index is per one subscription);
--   the link rows carry each subscription's term.
-- * NOT READY GATE: until record_payment renews every linked subscription (R-2848), paying a together quote would renew
--   ONE subscription (renewal_quote_id … limit 1) with the whole quote's money. So the RPC refuses (0A000, "not ready on
--   this server") while public.r2847_together_payment_ready() returns false — it does here; R-2848 redefines it to true
--   in the migration that makes record_payment (and the other one-subscription-per-quote readers) handle the link rows.
--   Landing this card alone changes nothing a user can do.
-- * create_renewal_quote (latest body, 20261113060034_r2710) + one step: a subscription whose link to its together
--   quote was lost gets THAT quote back (relinked) — never a second renewal quote for the same term.
-- * r2613_quote_link_guard (latest body, 20261108142224_r2613) + the together case: a seat cut is compared with THAT
--   subscription's own seats on the together quote (link row), not with the quote's total seats.
-- * trg_quotes_renewal_together_guarded: a browser login cannot change a together quote's lines / amounts / tax rate /
--   seats / term / customer / renewal link columns; NOBODY can Revise it (a revision row naming it, or superseded_by
--   set by tg_quote_revision_sent) — cancel it and bill together again.
--
-- Not changed: record_payment, cancel_quote, invoices (R-2848); the API / Renewals screen (R-2849).
-- Tenant guard (CLAUDE.md §17c): R-2810's login rule (trusted = service_role / a non-request login).
-- Test: supabase/tests/r2847_renewal_quote_together.test.sql (one transaction, rolled back; red without this file).

begin;

-- ── 1. The link table ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.renewal_quote_subscriptions (
  id                bigint generated always as identity primary key,
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  quote_id          text not null references public.quotes(id) on delete cascade,
  subscription_id   uuid not null references public.subscriptions(id) on delete cascade,
  renewal_term_date date not null,
  extension_months  integer not null default 12,
  subtotal          integer not null,
  seats             integer,
  line_no           integer not null,
  renewed_at        timestamptz,
  released_at       timestamptz,
  created_at        timestamptz not null default now(),
  constraint renewal_quote_subscriptions_months_check check (extension_months > 0),
  constraint renewal_quote_subscriptions_subtotal_check check (subtotal > 0)
);
comment on table public.renewal_quote_subscriptions is
  'R-2847: a renewal quote that renews 2+ subscriptions at once ("billed together", R-2809) — one row per subscription term it renews. released_at = the quote was closed with no money on it, so the term is free again (the row is kept as history). Written only by security-definer functions (create_renewal_quote_together; R-2848 record_payment / cancel).';
/* One together quote per subscription term among rows not released (a closed quote's rows stay as history). */
create unique index if not exists renewal_quote_subscriptions_one_per_term
  on public.renewal_quote_subscriptions (subscription_id, renewal_term_date) where released_at is null;
create unique index if not exists renewal_quote_subscriptions_quote_sub
  on public.renewal_quote_subscriptions (quote_id, subscription_id);
create index if not exists renewal_quote_subscriptions_tenant_idx
  on public.renewal_quote_subscriptions (tenant_id, quote_id);

alter table public.renewal_quote_subscriptions enable row level security;
drop policy if exists renewal_quote_subscriptions_select on public.renewal_quote_subscriptions;
create policy renewal_quote_subscriptions_select on public.renewal_quote_subscriptions
  for select to authenticated using (tenant_id = (select public.current_tenant_id()));
drop policy if exists gp09_personal_wall on public.renewal_quote_subscriptions;
create policy gp09_personal_wall on public.renewal_quote_subscriptions as restrictive for select to authenticated
  using (not (select public.is_personal_session()));
drop policy if exists zzz_service_role_all on public.renewal_quote_subscriptions;
create policy zzz_service_role_all on public.renewal_quote_subscriptions
  for all to service_role using (true) with check (true);
revoke all on table public.renewal_quote_subscriptions from public, anon;
revoke insert, update, delete, truncate on table public.renewal_quote_subscriptions from authenticated;
grant select on table public.renewal_quote_subscriptions to authenticated;
grant all on table public.renewal_quote_subscriptions to service_role;

-- ── 2. Is a quote still live? (one definition) ───────────────────────────────────────────────────
/* R-2847: a quote is closed when cancelled, superseded by a revision, rejected or expired. A closed quote that took
   money is still "held" (its link rows are never dropped). */
create or replace function public.r2847_quote_live(p_quote_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.quotes q
                  where q.id = p_quote_id and q.cancelled_at is null and q.superseded_by is null
                    and q.status::text not in ('rejected', 'expired'))
      or exists (select 1 from public.payments p where p.quote_id = p_quote_id and p.status = 'received' and p.amount > 0);
$$;
revoke all on function public.r2847_quote_live(text) from public, anon, authenticated;
grant execute on function public.r2847_quote_live(text) to service_role;

-- ── 3. Not-ready gate ─────────────────────────────────────────────────────────────────────────────
/* R-2847: FALSE until R-2848 redefines this function to return true — in the same migration that makes record_payment
   renew EVERY subscription linked to a together quote and teaches the other one-subscription-per-quote readers (sale
   invoice on receipt R-2095, bank-credit kind detection R-1838/R-2466, cancel_quote) about the link rows. Before that a
   together quote must not exist: paying it would renew ONE subscription (renewal_quote_id … limit 1) with the whole
   quote's money. An explicit switch, not a guess from another function's source text. */
create or replace function public.r2847_together_payment_ready()
returns boolean
language sql
immutable
set search_path = public
as $$
  select false;
$$;
revoke all on function public.r2847_together_payment_ready() from public, anon;
grant execute on function public.r2847_together_payment_ready() to authenticated, service_role;

-- ── 4. create_renewal_quote_together ──────────────────────────────────────────────────────────────
create or replace function public.create_renewal_quote_together(
  p_tenant_id uuid,
  p_parts     jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2847: ONE renewal quote for 2+ yearly subscriptions of one customer — see the migration header. */
declare
  v_trusted  boolean;
  v_caller   uuid := public.current_tenant_id();
  v_tenant   uuid;
  v_ids      uuid[];
  v_sorted   uuid[];
  v_n        integer;
  v_ncust    integer;
  v_customer uuid;
  v_names    text;
  v_p        record;
  v_s        record;
  v_q        jsonb;
  v_lines    jsonb := '[]'::jsonb;
  v_l        jsonb;
  v_i        integer;
  v_rates    integer[] := '{}'::integer[];
  v_rate     integer;
  v_subtotal integer := 0;
  v_part_sub integer;
  v_part_amt integer;
  v_seats    integer := 0;
  v_pseats   integer;
  v_cost     integer := 0;
  v_months   integer;
  v_cut      public.subscription_seat_reductions%rowtype;
  v_plans    text[] := '{}'::text[];
  v_expires  date;
  v_lead     record;
  v_has_lead boolean := false;
  v_found    text;
  v_other    text;
  v_relinked boolean := false;
  v_tax      integer;
  v_amount   integer;
  v_id       text;
  v_today    date := public.ist_today();
begin
  v_trusted := current_setting('role', true) = 'service_role'
               or (coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon')
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime', 'app_anon', 'app_jobs'));
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can make a renewal quote.' using errcode = '42501';
  end if;
  if p_tenant_id is null or (v_caller is not null and p_tenant_id is distinct from v_caller) then
    raise exception 'A subscription to renew was not found — refresh Renewals and try again.' using errcode = 'no_data_found';
  end if;
  v_tenant := p_tenant_id;

  /* Not ready gate (see the header). */
  if not public.r2847_together_payment_ready() then
    raise exception 'One renewal quote for several yearly subscriptions is not ready on this server yet — make each renewal quote on its own for now.'
      using errcode = '0A000';
  end if;

  if p_parts is null or jsonb_typeof(p_parts) <> 'array' then
    raise exception 'Pick at least two subscriptions to renew together.' using errcode = '22023';
  end if;
  /* The subscriptions, each once, in the order asked (the first leads the quote's name and domain). */
  begin
    select array_agg(t.id order by t.n) into v_ids
      from (select (e->>'subscription_id')::uuid as id, min(o) as n
              from jsonb_array_elements(p_parts) with ordinality x(e, o)
             where jsonb_typeof(e) = 'object' and nullif(e->>'subscription_id', '') is not null
             group by 1) t;
  exception when invalid_text_representation then
    raise exception 'A subscription to renew was not found — refresh Renewals and try again.' using errcode = 'no_data_found';
  end;
  if coalesce(cardinality(v_ids), 0) < 2 then
    raise exception 'Pick at least two subscriptions to renew together.' using errcode = '22023';
  end if;
  if cardinality(v_ids) <> jsonb_array_length(p_parts) then
    raise exception 'Each subscription can be on the quote only once — pick each one once.' using errcode = '22023';
  end if;
  /* Another company's subscription reads exactly like one that does not exist (no "is this id real?" oracle). */
  select count(*) into v_n from public.subscriptions s where s.id = any(v_ids) and s.tenant_id = v_tenant;
  if v_n < cardinality(v_ids) then
    raise exception 'A subscription to renew was not found — refresh Renewals and try again.' using errcode = 'no_data_found';
  end if;
  select string_agg(s.plan, ', ' order by s.plan) into v_names
    from public.subscriptions s where s.id = any(v_ids) and s.customer_id is null;
  if v_names is not null then
    raise exception '% is not linked to a customer — link it to a customer first, then renew together.', v_names using errcode = '22023';
  end if;
  select count(distinct s.customer_id), min(s.customer_id::text)::uuid, string_agg(distinct coalesce(s.customer_name, '?'), ', ')
    into v_ncust, v_customer, v_names
    from public.subscriptions s where s.id = any(v_ids);
  if v_ncust <> 1 then
    raise exception 'Subscriptions of different customers cannot be on one renewal quote (%) — renew together only one customer''s subscriptions.', v_names
      using errcode = '22023';
  end if;

  /* Two calls at once: one at a time per customer, then the subscriptions' rows in id order. */
  perform pg_advisory_xact_lock(hashtextextended('r2847:renewal-together:' || v_tenant::text || ':' || v_customer::text, 0));
  perform 1 from public.subscriptions s where s.id = any(v_ids) order by s.id for update;
  select array_agg(x order by x) into v_sorted from unnest(v_ids) x;

  /* The same set again → that quote (a retry, a second click, a second tab); a lost link is put back. Only while EVERY
     subscription on it is still at the term it was quoted for, active and renewing (rev: one member moved or Won't
     renew → never relinked to an old term). */
  select l.quote_id into v_found
    from public.renewal_quote_subscriptions l
   where l.tenant_id = v_tenant and l.subscription_id = any(v_ids) and l.released_at is null
     /* an OPEN quote only — a closed one that took money still holds the terms (refused below), it is never handed
        back as "the quote" */
     and exists (select 1 from public.quotes qo where qo.id = l.quote_id and qo.cancelled_at is null
                   and qo.superseded_by is null and qo.status::text not in ('rejected', 'expired'))
     and v_sorted = (select array_agg(l2.subscription_id order by l2.subscription_id)
                       from public.renewal_quote_subscriptions l2 where l2.quote_id = l.quote_id and l2.released_at is null)
     and not exists (select 1 from public.renewal_quote_subscriptions l3
                       join public.subscriptions s3 on s3.id = l3.subscription_id
                      where l3.quote_id = l.quote_id and l3.released_at is null
                        and (s3.renewal_date is distinct from l3.renewal_term_date or s3.status::text <> 'active'
                             or s3.auto_renew is false))
   limit 1;
  if v_found is not null then
    select string_agg(s.plan || ' (' || s.renewal_quote_id || ')', ', ' order by s.plan) into v_other
      from public.subscriptions s
     where s.id = any(v_ids) and s.renewal_quote_id is not null and s.renewal_quote_id <> v_found
       and public.r2847_quote_live(s.renewal_quote_id);
    if v_other is not null then
      raise exception 'Another renewal quote is open for % — cancel it first; renewal quote % already renews these subscriptions together.', v_other, v_found
        using errcode = '22023';
    end if;
    update public.subscriptions s set renewal_quote_id = v_found
     where s.id = any(v_ids) and s.tenant_id = v_tenant
       and (s.renewal_quote_id is null or (s.renewal_quote_id <> v_found and not public.r2847_quote_live(s.renewal_quote_id)));
    v_relinked := found;
    select to_jsonb(q.*) into v_q from public.quotes q where q.id = v_found;
    return jsonb_build_object('quote_id', v_found, 'created', false, 'relinked', v_relinked, 'already_existed', true,
      'amount', v_q->'amount', 'subtotal', v_q->'subtotal', 'tax_rate', v_q->'tax_rate', 'discount_pct', v_q->'discount_pct',
      'line_items', v_q->'line_items', 'subscription_ids', to_jsonb(v_ids));
  end if;

  /* Each subscription, as asked. */
  for v_p in
    select (e->>'subscription_id')::uuid as sub_id, e->'quote' as q, o::int as n
      from jsonb_array_elements(p_parts) with ordinality x(e, o)
     order by o
  loop
    select s.id, s.plan, s.seats, s.status::text as status, s.billing_cycle::text as cycle, s.term_months, s.renewal_date,
           s.auto_renew, s.renewal_quote_id, s.customer_name, s.domain
      into v_s
      from public.subscriptions s where s.id = v_p.sub_id;
    if v_s.status <> 'active' then
      raise exception '% is % — only an active subscription can be renewed together.', v_s.plan, v_s.status using errcode = '22023';
    end if;
    if v_s.cycle is distinct from 'yearly' or coalesce(v_s.term_months, 12) <> 12 then
      raise exception '% is not a yearly subscription billed once a year — subscriptions billed in parts are billed together with Bill together on their parts.', v_s.plan
        using errcode = '22023';
    end if;
    if v_s.auto_renew is false then
      raise exception '% is marked Won''t renew — press Undo Won''t renew on the subscription first.', v_s.plan using errcode = '22023';
    end if;
    if v_s.renewal_date is null then
      raise exception '% has no renewal date — set it on the subscription first.', v_s.plan using errcode = '22023';
    end if;
    if v_s.renewal_quote_id is not null and public.r2847_quote_live(v_s.renewal_quote_id) then
      raise exception 'Renewal quote % is still open (or has money received on it) for % — cancel it or record the rest of the payment on it first, then renew together.', v_s.renewal_quote_id, v_s.plan
        using errcode = '22023';
    end if;
    select l.quote_id into v_other
      from public.renewal_quote_subscriptions l
     where l.subscription_id = v_s.id and l.renewal_term_date = v_s.renewal_date and l.released_at is null
       and public.r2847_quote_live(l.quote_id)
     limit 1;
    if v_other is not null then
      raise exception '% is already on renewal quote % (billed together with other subscriptions) — cancel % first, then renew together.', v_s.plan, v_other, v_other
        using errcode = '22023';
    end if;
    select q.id into v_other
      from public.quotes q
     where q.tenant_id = v_tenant and q.renewal_subscription_id = v_s.id and q.renewal_term_date = v_s.renewal_date
       and public.r2847_quote_live(q.id)
     limit 1;
    if v_other is not null then
      raise exception 'Renewal quote % was already made for % (due %) — cancel it first, then renew together.', v_other, v_s.plan, to_char(v_s.renewal_date, 'DD Mon YYYY')
        using errcode = '22023';
    end if;

    /* The app's price for this subscription's renewal (create_renewal_quote's rules). */
    v_q := v_p.q;
    if v_q is null or jsonb_typeof(v_q) <> 'object' then
      raise exception 'The renewal of % has no price, so no quote was made. Check the plan price in Items, then try again.', v_s.plan using errcode = '22023';
    end if;
    v_part_sub := nullif(v_q->>'subtotal', '')::integer;
    v_part_amt := nullif(v_q->>'amount', '')::integer;
    if v_part_sub is null or v_part_sub <= 0 or v_part_amt is null or v_part_amt <= 0 then
      raise exception 'The renewal of % has no price, so no quote was made. Check the plan price in Items, then try again.', v_s.plan using errcode = '22023';
    end if;
    if jsonb_typeof(v_q->'line_items') is distinct from 'array' or jsonb_array_length(v_q->'line_items') = 0 then
      raise exception 'The renewal of % has no line, so no quote was made. Try again from Renewals.', v_s.plan using errcode = '22023';
    end if;
    v_months := coalesce(nullif(v_q->>'extension_months', '')::integer, 12);
    if v_months <> 12 then
      raise exception 'The renewal of % is for % months — only one-year renewals can be on one quote together.', v_s.plan, v_months using errcode = '22023';
    end if;
    v_pseats := nullif(v_q->>'seats', '')::integer;
    /* R-2613 (rule N5), read under the row lock: a cut scheduled for this renewal → priced at the cut's seats. */
    v_cut := public.r2613_applying_seat_cut(v_tenant, v_s.id, v_s.seats, v_s.renewal_date);
    /* Coordinator decision (15 Nov): never trust the caller's seats — with no cut the part is for the subscription's
       own seats (createRenewalQuote's quoteSeats), and its lines' qty add up to them. */
    if v_cut.id is null and v_pseats is distinct from v_s.seats
       and not public.r2613_removed_seat_cut(v_tenant, v_s.id, v_s.seats, v_s.renewal_date, v_pseats) then
      raise exception 'The renewal of % was priced for % seats, but the subscription has % seats, so no quote was made. Try again from Renewals.',
        v_s.plan, coalesce(v_pseats::text, 'unknown'), v_s.seats using errcode = '22023';
    end if;
    if (select sum(coalesce(nullif(e->>'qty', '')::numeric, 1)) from jsonb_array_elements(v_q->'line_items') e
         where jsonb_typeof(e) = 'object') is distinct from v_pseats::numeric then
      raise exception 'The renewal of % does not add up (its lines are not for % seats), so no quote was made. Try again from Renewals.',
        v_s.plan, coalesce(v_pseats::text, 'unknown') using errcode = '22023';
    end if;
    if v_cut.id is not null and v_pseats is distinct from v_cut.seats_after then
      raise exception 'A seat cut to % seats is scheduled for % on % while its renewal was priced for % seats, so no quote was made. Try again — it is priced with the cut.',
        v_cut.seats_after, to_char(v_cut.effective_date, 'DD Mon YYYY'), v_s.plan, coalesce(v_pseats::text, 'unknown')
        using errcode = 'check_violation';
    end if;
    if v_cut.id is null and public.r2613_removed_seat_cut(v_tenant, v_s.id, v_s.seats, v_s.renewal_date, v_pseats) then
      raise exception 'The seat cut to % seats on % was removed while its renewal was being priced, so no quote was made. Try again — it is priced for % seats.',
        v_pseats, v_s.plan, v_s.seats
        using errcode = 'check_violation';
    end if;

    v_rates := v_rates || coalesce(nullif(v_q->>'tax_rate', '')::integer, 18);
    v_subtotal := v_subtotal + v_part_sub;
    v_seats := v_seats + coalesce(v_pseats, 0);
    v_cost := v_cost + coalesce(nullif(v_q->>'total_cost', '')::integer, 0);
    v_plans := v_plans || coalesce(nullif(v_q->>'plan', ''), v_s.plan);
    v_expires := least(coalesce(v_expires, nullif(v_q->>'expires_date', '')::date), nullif(v_q->>'expires_date', '')::date);
    if not v_has_lead then
      v_lead := v_s;
      v_has_lead := true;
    end if;
    /* rev: the lines must add up to the part's subtotal (qty × rate, as createRenewalQuote builds them), and the part's
       amount must be that subtotal + its GST (±₹1 rounding) — a quote whose lines show another price than it charges
       is refused. */
    if exists (select 1 from jsonb_array_elements(v_q->'line_items') e where jsonb_typeof(e) <> 'object') then
      raise exception 'The renewal of % has a broken line, so no quote was made. Try again from Renewals.', v_s.plan using errcode = '22023';
    end if;
    begin
      if (select round(sum(coalesce(nullif(e->>'qty', '')::numeric, 1) * coalesce(nullif(e->>'rate', '')::numeric, 0)))
            from jsonb_array_elements(v_q->'line_items') e) is distinct from v_part_sub
         or abs(v_part_amt - (v_part_sub + round(v_part_sub * coalesce(nullif(v_q->>'tax_rate', '')::integer, 18) / 100.0))) > 1 then
        raise exception 'The renewal of % does not add up (its lines, subtotal ₹% and amount ₹% differ), so no quote was made. Try again from Renewals.',
          v_s.plan, v_part_sub, v_part_amt using errcode = '22023';
      end if;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'The renewal of % has a broken line, so no quote was made. Try again from Renewals.', v_s.plan using errcode = '22023';
    end;
    v_i := 0;
    for v_l in select e from jsonb_array_elements(v_q->'line_items') e loop
      v_i := v_i + 1;
      /* security review: only the keys createRenewalQuote builds are kept — a caller-sent billing_id / plan_change /
         bulk / one_time / years key would make other money code (part-request guards, record_payment's plan-change
         and bulk paths, R-2710 years) read this quote as something it is not. */
      v_l := (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(v_l) x(k, v)
               where k in ('name', 'description', 'item_id', 'qty', 'rate', 'cost', 'commitment', 'hsn', 'sac', 'unit'));
      v_lines := v_lines || jsonb_build_array(v_l || jsonb_build_object(
        'id',                'renewal-' || v_p.n::text || '-' || v_i::text,
        'subscription_id',   v_s.id::text,
        'renewal_term_date', v_s.renewal_date,
        'period_start',      v_s.renewal_date,
        'period_end',        ((v_s.renewal_date + make_interval(months => v_months))::date - 1)));
    end loop;
  end loop;

  if (select count(distinct r) from unnest(v_rates) r) > 1 then
    raise exception 'Subscriptions with different GST rates cannot be on one renewal quote (%) — make their renewal quotes separately.',
      (select string_agg(distinct r::text || '%', ' and ') from unnest(v_rates) r) using errcode = '22023';
  end if;
  v_rate   := v_rates[1];
  v_tax    := round(v_subtotal * v_rate / 100.0);
  v_amount := v_subtotal + v_tax;

  /* A closed together quote (no money on it) no longer holds its subscriptions' terms: ALL its rows are released
     together (kept as history, never deleted). */
  update public.renewal_quote_subscriptions l
     set released_at = now()
   where l.tenant_id = v_tenant and l.released_at is null
     and l.quote_id in (select l2.quote_id from public.renewal_quote_subscriptions l2
                         where l2.tenant_id = v_tenant and l2.subscription_id = any(v_ids) and l2.released_at is null)
     and not public.r2847_quote_live(l.quote_id);

  v_id := public.next_document_number('quote', v_tenant);
  if v_id is null then
    raise exception 'No quote number could be issued, so no renewal quote was made. Check Settings → Document numbering, then try again.' using errcode = 'P0001';
  end if;

  insert into public.quotes (
    id, tenant_id, customer_id, customer_name, plan, seats, amount, status, payment_status,
    owner_id, domain, created_date, expires_date, line_items, subtotal, total_cost,
    discount_pct, tax_rate, is_renewal, extension_months, notes,
    renewal_subscription_id, renewal_term_date
  ) values (
    v_id, v_tenant, v_customer, v_lead.customer_name, array_to_string(v_plans, ' + '), v_seats, v_amount, 'sent', 'awaiting',
    null, v_lead.domain, v_today, v_expires, v_lines, v_subtotal, v_cost,
    0, v_rate, true, 12,
    'Renewal of ' || array_to_string(v_plans, ' + ') || ' — billed together on one quote.',
    null, null
  );

  insert into public.renewal_quote_subscriptions
    (tenant_id, quote_id, subscription_id, renewal_term_date, extension_months, subtotal, seats, line_no)
  select v_tenant, v_id, s.id, s.renewal_date, 12, nullif(e->'quote'->>'subtotal', '')::integer,
         nullif(e->'quote'->>'seats', '')::integer, o::int
    from jsonb_array_elements(p_parts) with ordinality x(e, o)
    join public.subscriptions s on s.id = (e->>'subscription_id')::uuid;

  update public.subscriptions s set renewal_quote_id = v_id
   where s.id = any(v_ids) and s.tenant_id = v_tenant;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, (select u.id from public.users u where u.id = auth.uid()), 'quote.renewal_together', 'quote', v_id,
          left(format('Renewal quote %s for %s together', v_id, array_to_string(v_plans, ' + ')), 120),
          jsonb_build_object('subscription_ids', to_jsonb(v_ids), 'subtotal', v_subtotal, 'tax_rate', v_rate, 'amount', v_amount));

  return jsonb_build_object('quote_id', v_id, 'created', true, 'relinked', false, 'already_existed', false,
    'amount', v_amount, 'subtotal', v_subtotal, 'tax_rate', v_rate, 'tax', v_tax, 'discount_pct', 0,
    'line_items', v_lines, 'subscription_ids', to_jsonb(v_ids));
end;
$$;
revoke all on function public.create_renewal_quote_together(uuid, jsonb) from public, anon;
grant execute on function public.create_renewal_quote_together(uuid, jsonb) to authenticated, service_role;

-- ── 5. create_renewal_quote: a lost link to a together quote comes back ────────────────────────────
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
   at other seats than the cut's is refused (rule N5).
   R-2710: p_quote.status = 'draft' makes the NEW quote a draft ("Review renewal quote" opens it in
   the editor; nothing is emailed). Anything else — the cron, Send now, old callers — 'sent' as before.
   An existing / re-linked quote is returned as it is (its status is never changed here).
   R-2847: a renewal quote billed together for this term (renewal_quote_subscriptions) whose link was lost is linked
   again and returned — never a second quote for the same term. */
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
  v_status   public.quote_status;   -- R-2710
  v_tl       record;                -- R-2847
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

  /* R-2847: a renewal quote billed together for this term that lost its link → link it again, make nothing. The link
     guard (r2613_quote_link_guard) checks a scheduled cut against THIS subscription's seats on it. */
  select l.quote_id, q.amount, q.subtotal, q.discount_pct, q.tax_rate, q.line_items
    into v_tl
    from public.renewal_quote_subscriptions l
    join public.quotes q on q.id = l.quote_id
   where l.tenant_id = v_sub.tenant_id and l.subscription_id = v_sub.id and l.renewal_term_date = v_sub.renewal_date
     and l.released_at is null and public.r2847_quote_live(l.quote_id)
   limit 1;
  if found then
    update public.subscriptions set renewal_quote_id = v_tl.quote_id
     where id = v_sub.id and tenant_id = v_sub.tenant_id;
    return jsonb_build_object('quote_id', v_tl.quote_id, 'created', false, 'relinked', true,
      'amount', v_tl.amount, 'subtotal', v_tl.subtotal, 'discount_pct', v_tl.discount_pct,
      'tax_rate', v_tl.tax_rate, 'line_items', v_tl.line_items);
  end if;

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
  v_status   := case when p_quote->>'status' = 'draft' then 'draft' else 'sent' end;   -- R-2710
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
  /* R-2613 (the other way round): priced WITH a cut that was removed meanwhile → it would bill
     fewer seats than the customer keeps, and paying it would drop the seats (rule N1). */
  if v_cut.id is null and public.r2613_removed_seat_cut(v_sub.tenant_id, v_sub.id, v_sub.seats, v_sub.renewal_date, v_seats) then
    raise exception 'The seat cut to % seats for % was removed while this renewal quote was being made, so it was not made. Generate the renewal quote again — it is made for % seats.',
      v_seats, to_char(v_sub.renewal_date, 'DD Mon YYYY'), v_sub.seats
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
    v_amount, v_status, 'awaiting',  -- R-2710: 'draft' only when asked (Review renewal quote)
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

-- ── 6. Seat-cut link guard: a together quote is checked per subscription ──────────────────────────
create or replace function public.r2613_quote_link_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-2613 (rule N5): a renewal or extension quote linked while a seat cut is scheduled for the
   renewal must be for the cut's seats — else it bills the seats the owner cut. The UPDATE holds
   the subscription row lock, so a cut saved just before (reduce_subscription_seats locks the same
   row) is seen here.
   R-2847: on a renewal quote billed together the seats are THIS subscription's own (its link row), not the quote's
   total. */
declare
  v_cut public.subscription_seat_reductions%rowtype;
  v_q   record;
  v_own integer;
begin
  select q.id, q.seats, q.is_renewal, q.extension_months into v_q
    from public.quotes q where q.id = new.renewal_quote_id and q.tenant_id = new.tenant_id;
  if not found or not coalesce(v_q.is_renewal, false) or coalesce(v_q.extension_months, 0) <= 0 then
    return new;   -- not a renewal / extension (plan change, support upgrade: extension_months 0)
  end if;
  select l.seats into v_own
    from public.renewal_quote_subscriptions l
   where l.quote_id = v_q.id and l.subscription_id = new.id;
  if found then
    v_q.seats := v_own;   -- R-2847
  end if;
  v_cut := public.r2613_applying_seat_cut(new.tenant_id, new.id, new.seats, new.renewal_date);
  if v_cut.id is null then
    /* The other way round: a quote made WITH a cut that has since been removed. */
    if public.r2613_removed_seat_cut(new.tenant_id, new.id, new.seats, new.renewal_date, v_q.seats) then
      raise exception 'Quote % is for % seats, made with a seat cut that was removed — so it was not linked to the subscription (it has % seats). Delete that quote and make the renewal quote again.',
        v_q.id, v_q.seats, new.seats
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if v_q.seats is distinct from v_cut.seats_after then
    raise exception 'A seat cut to % seats is scheduled for % — quote % is for % seats, so it was not linked to the subscription. Remove the cut in Manage seats first, or let the renewal happen with the cut.',
      v_cut.seats_after, to_char(v_cut.effective_date, 'DD Mon YYYY'), v_q.id, coalesce(v_q.seats::text, 'unknown')
      using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;
revoke all on function public.r2613_quote_link_guard() from public, anon, authenticated;

-- ── 7. A together quote is not edited or revised by hand ─────────────────────────────────────────
/* R-2847: is this quote a renewal quote billed together? Definer, so the guard triggers below work for every login
   (a browser login only learns it for its own company's quotes). */
create or replace function public.r2847_is_together_quote(p_quote_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_quote_id is not null and exists (
    select 1 from public.renewal_quote_subscriptions l
     where l.quote_id = p_quote_id
       and ((public.current_tenant_id() is null and coalesce(public.current_request_role(), '') not in ('anon', 'authenticated'))
            or l.tenant_id = public.current_tenant_id()));
$$;
-- Every login that can update a quote runs the guard below (server logins too), so it is callable by all; a login
-- with no company (anon, a stray authenticated) always gets false.
grant execute on function public.r2847_is_together_quote(text) to public;
grant execute on function public.r2847_is_together_quote(text) to authenticated, service_role;

create or replace function public.tg_quotes_renewal_together_guarded()
returns trigger
language plpgsql
set search_path = public
as $$
/* R-2847: a renewal quote billed together keeps the lines / amounts / term / customer its link rows were made from —
   an edit by a browser login would make the payment renew subscriptions at prices nobody quoted. NOT security definer:
   is_direct_request_login() is false inside a definer body (rev). Revise is refused for EVERY caller (rev): a revision
   is a new quote without the link rows, and trg_quote_revision_renewal_handover (run by the definer
   tg_quote_revision_sent) would move every member's renewal_quote_id onto it — then paying it renews one subscription
   with the whole quote's money. */
begin
  if tg_op = 'INSERT' then
    if new.revision_of is not null and public.r2847_is_together_quote(new.revision_of) then
      raise exception 'Quote % renews several subscriptions together and cannot be revised. Cancel it and make the renewal quote together again from Renewals.', new.revision_of
        using errcode = '42501';
    end if;
    return new;
  end if;
  if not public.r2847_is_together_quote(old.id) then
    return new;
  end if;
  if new.superseded_by is distinct from old.superseded_by and new.superseded_by is not null then
    raise exception 'Quote % renews several subscriptions together and cannot be revised. Cancel it and make the renewal quote together again from Renewals.', old.id
      using errcode = '42501';
  end if;
  if not public.is_direct_request_login() then
    return new;
  end if;
  if new.line_items is distinct from old.line_items or new.amount is distinct from old.amount
     or new.subtotal is distinct from old.subtotal or new.tax_rate is distinct from old.tax_rate
     or new.discount_pct is distinct from old.discount_pct or new.seats is distinct from old.seats
     or new.extension_months is distinct from old.extension_months or new.is_renewal is distinct from old.is_renewal
     or new.is_extension is distinct from old.is_extension
     or new.customer_id is distinct from old.customer_id
     or new.renewal_subscription_id is distinct from old.renewal_subscription_id
     or new.renewal_term_date is distinct from old.renewal_term_date then
    raise exception 'Quote % renews several subscriptions together — its lines, amounts and customer cannot be edited by hand. Cancel it and make the renewal quote together again from Renewals.', old.id
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.tg_quotes_renewal_together_guarded() from public, anon, authenticated;
drop trigger if exists trg_quotes_renewal_together_guarded on public.quotes;
create trigger trg_quotes_renewal_together_guarded
  before insert or update of line_items, amount, subtotal, tax_rate, discount_pct, seats, extension_months, is_renewal,
                   is_extension, customer_id, superseded_by, renewal_subscription_id, renewal_term_date on public.quotes
  for each row execute function public.tg_quotes_renewal_together_guarded();

commit;
