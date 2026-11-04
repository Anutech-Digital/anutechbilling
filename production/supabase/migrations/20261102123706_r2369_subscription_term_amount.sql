-- deploy-peek: to_regprocedure('public.subscription_term_amount_from_quote(uuid,text,text,integer,integer,integer)') is not null and exists(select 1 from pg_trigger where tgname = 'trg_subscriptions_zz_term_amount' and tgrelid = to_regclass('public.subscriptions'))
-- deploy-key: r2369subscriptiontermamount
-- 20261102123706_r2369_subscription_term_amount.sql
--
-- R-2369 (2 Nov 2026, staging reconcile): a subscription's yearly amount drifted from the sold
-- price. `subscriptions` stores only `mrr` — WHOLE rupees per month — and every renewal quote,
-- billing schedule and "per year" figure rebuilt the term from it:
--     ₹1,300/yr domain   → mrr round(1300 / 12) = 108  → 108 × 12        = ₹1,296
--     5 × ₹850/yr email  → mrr 355                     → round(355×12÷5) = ₹852/seat → ₹4,260
-- so a renewal could bill a different amount from the one the customer bought at.
--
-- ─── WHAT THIS DOES ─────────────────────────────────────────────────────────
--   subscriptions.term_amount numeric(14,2) — the exact ex-GST amount for ONE term
--   (term_months) at the row's current seats. NULL = not known → every reader falls back to
--   mrr × term_months exactly as before (nothing changes for such a row).
--
--   One BEFORE INSERT/UPDATE trigger keeps it (same pattern and reason as
--   subscriptions_term_follows_line / subscriptions_cycle_follows_quote: several functions write
--   subscriptions, re-deploying 800-line filers to add one column is a poor trade):
--     INSERT with a quote_id and no term_amount → from the quote line for this row
--       (subscription_term_amount_from_quote) — kept only when it agrees with the stored mrr
--       within the whole-rupee rounding (≤ ₹0.50 per seat per month), else NULL.
--     UPDATE that sets term_amount itself → as given.
--     UPDATE by a renewal payment (renewal_quote_id cleared, renewal_date moved) → the renewal
--       quote's subtotal when it is a whole-term renewal (not an extension) whose round(subtotal ÷
--       term_months) is the new mrr — the price the customer just renewed at.
--     UPDATE of seats → scaled per seat (the per-seat price does not change with seat count);
--     UPDATE of term_months → scaled per month;
--     UPDATE of mrr with seats unchanged → kept only when the new mrr is round(term_amount ÷
--       term_months) (the same figure every filer writes); any other mrr is a price change and
--       term_amount goes back to NULL (mrr wins, as before).
--     After a seat/term change it is kept only while it still agrees with the mrr (rounding only).
--
--   Back-fill (idempotent): rows with term_amount NULL get it ONLY where the source quote line
--   says it AND it agrees with the stored mrr (rounding only). Every other row stays NULL and
--   behaves exactly as before. Running it again changes nothing.

begin;

alter table public.subscriptions
  add column if not exists term_amount numeric(14,2);

comment on column public.subscriptions.term_amount is
  'R-2369: exact ex-GST amount for one term (term_months) at the current seats. NULL = derive from mrr × term_months.';

/* The quote line's exact term amount for a subscription, or NULL. Rounding-only agreement with
   the mrr the filer wrote is required, so a line that is not really this row's price (seats
   changed, a hand-edited mrr, a bulk line split across domains) is never used. */
create or replace function public.subscription_term_amount_from_quote(
  p_tenant_id uuid, p_quote_id text, p_plan text, p_seats integer, p_term_months integer, p_mrr integer
) returns numeric
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_lines   jsonb;
  v_line    jsonb;
  v_n       int;
  v_qty     numeric;
  v_amount  numeric;
  v_years   int;
  v_term    int := greatest(coalesce(p_term_months, 12), 1);
  v_seats   int := coalesce(p_seats, 0);
begin
  -- R-2369
  if p_quote_id is null or v_seats <= 0 or coalesce(p_mrr, 0) <= 0 then
    return null;
  end if;
  select q.line_items into v_lines
    from public.quotes q
   where q.id = p_quote_id and q.tenant_id = p_tenant_id;
  if v_lines is null or jsonb_typeof(v_lines) <> 'array' then
    return null;
  end if;

  select count(*), (array_agg(t.e order by t.i))[1] into v_n, v_line
    from jsonb_array_elements(v_lines) with ordinality as t(e, i)
   where jsonb_typeof(t.e) = 'object'
     and lower(btrim(coalesce(t.e->>'name', ''))) = lower(btrim(coalesce(p_plan, '')))
     and not coalesce((t.e->>'bulk') = 'true', false)
     and coalesce(t.e->>'qty', '') ~ '^\d+(\.0+)?$'
     and (t.e->>'qty')::numeric = v_seats;
  if v_n <> 1 or v_line is null then
    return null;   -- none, or two lines that could both be this row: do not guess
  end if;

  v_qty := (v_line->>'qty')::numeric;
  begin
    v_amount := case
      when nullif(v_line->>'renewal_rate', '') is not null
        then v_qty * (v_line->>'renewal_rate')::numeric
      else v_qty * coalesce((v_line->>'rate')::numeric, 0)
             * (1 - coalesce(nullif(v_line->>'discount_pct', '')::numeric, 0) / 100)
    end;
    v_years := case when coalesce(v_line->>'years', '') ~ '^\d+$'
                     and (v_line->>'years')::int between 2 and 10
                    then (v_line->>'years')::int else 1 end;
  exception when others then
    return null;   -- a non-numeric rate: never fail the insert
  end;
  if v_amount is null or v_amount <= 0 then
    return null;
  end if;

  -- A monthly line's rate is per month; any other subscription line's rate is per year
  -- (per whole term of `years` on a multi-year domain line — R-1445).
  if coalesce(v_line->>'commitment', '') = 'monthly' then
    v_amount := v_amount * v_term;
  else
    v_amount := v_amount / v_years * v_term / 12.0;
  end if;
  v_amount := round(v_amount, 2);

  if not public.subscription_term_amount_agrees(v_amount, p_mrr, v_term, v_seats) then
    return null;
  end if;
  return v_amount;
end;
$function$;

/* Rounding only: the filers write mrr = round(term ÷ months) (≤ ₹0.50 a month out) or a per-seat
   whole-rupee rate × seats (≤ ₹0.50 per seat a month out). Anything further is a different price. */
create or replace function public.subscription_term_amount_agrees(
  p_term_amount numeric, p_mrr integer, p_term_months integer, p_seats integer
) returns boolean
language sql
immutable
set search_path to 'public'
as $function$
  select p_term_amount is not null and p_term_amount > 0 and coalesce(p_mrr, 0) > 0
     and abs(p_term_amount - p_mrr::numeric * greatest(coalesce(p_term_months, 12), 1))
         <= 0.5 * greatest(coalesce(p_term_months, 12), 1) * greatest(coalesce(p_seats, 1), 1) + 0.01;
$function$;

create or replace function public.tg_subscriptions_term_amount_r2369()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_q    record;
  v_term int := greatest(coalesce(new.term_months, 12), 1);
begin
  -- R-2369
  if tg_op = 'INSERT' then
    if new.term_amount is null then
      new.term_amount := public.subscription_term_amount_from_quote(
        new.tenant_id, new.quote_id, new.plan, new.seats, new.term_months, new.mrr);
    end if;
    return new;
  end if;

  -- The caller set it (or cleared it) itself: as given.
  if new.term_amount is distinct from old.term_amount then
    return new;
  end if;

  -- A renewal payment rolled the term forward: the renewal quote is the new price.
  if old.renewal_quote_id is not null and new.renewal_quote_id is null
     and new.renewal_date is distinct from old.renewal_date then
    select q.subtotal, coalesce(q.is_extension, false) as is_extension, coalesce(q.discount_pct, 0) as discount_pct
      into v_q
      from public.quotes q
     where q.id = old.renewal_quote_id and q.tenant_id = new.tenant_id;
    if found and not v_q.is_extension and v_q.discount_pct = 0 and coalesce(v_q.subtotal, 0) > 0
       and round(v_q.subtotal::numeric / v_term) = new.mrr then
      new.term_amount := round(v_q.subtotal::numeric, 2);
      return new;
    end if;
  end if;

  if new.term_amount is null then
    return new;
  end if;

  if new.seats is distinct from old.seats then
    if coalesce(old.seats, 0) > 0 and coalesce(new.seats, 0) > 0 then
      new.term_amount := round(new.term_amount * new.seats / old.seats, 2);
    else
      new.term_amount := null;
      return new;
    end if;
  elsif new.mrr is distinct from old.mrr then
    -- Same seats, new monthly figure: kept only when it is this amount's own rounding.
    if round(new.term_amount / greatest(coalesce(old.term_months, 12), 1)) <> new.mrr then
      new.term_amount := null;
      return new;
    end if;
  end if;

  if new.term_months is distinct from old.term_months and coalesce(old.term_months, 0) > 0 then
    new.term_amount := round(new.term_amount * v_term / old.term_months, 2);
  end if;

  if not public.subscription_term_amount_agrees(new.term_amount, new.mrr, new.term_months, new.seats) then
    new.term_amount := null;
  end if;
  return new;
end;
$function$;

/* "zz": BEFORE triggers fire in name order — this one runs after subscriptions_term_follows_line
   (which may divide a multi-year line's mrr by its years) and every other insert trigger. */
drop trigger if exists trg_subscriptions_zz_term_amount on public.subscriptions;
create trigger trg_subscriptions_zz_term_amount
  before insert or update on public.subscriptions
  for each row execute function public.tg_subscriptions_term_amount_r2369();

revoke all on function public.subscription_term_amount_from_quote(uuid, text, text, integer, integer, integer) from public, anon;
grant execute on function public.subscription_term_amount_from_quote(uuid, text, text, integer, integer, integer) to authenticated, service_role;
revoke all on function public.subscription_term_amount_agrees(numeric, integer, integer, integer) from public, anon;
grant execute on function public.subscription_term_amount_agrees(numeric, integer, integer, integer) to authenticated, service_role;
revoke all on function public.tg_subscriptions_term_amount_r2369() from public, anon, authenticated;

-- Back-fill: only where the source quote line says the amount and it agrees with the mrr.
update public.subscriptions s
   set term_amount = public.subscription_term_amount_from_quote(s.tenant_id, s.quote_id, s.plan, s.seats, s.term_months, s.mrr)
 where s.term_amount is null
   and s.quote_id is not null
   and public.subscription_term_amount_from_quote(s.tenant_id, s.quote_id, s.plan, s.seats, s.term_months, s.mrr) is not null;

commit;
