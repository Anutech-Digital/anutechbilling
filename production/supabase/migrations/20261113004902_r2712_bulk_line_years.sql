-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.subscription_term_follows_line()') and prosrc like '%R-2712%')
-- deploy-key: r2712bulklineyears
-- 20261113004902_r2712_bulk_line_years.sql
--
-- R-2712 (Pratik, staging 16 Oct; audit 12 Nov): a quote's "Bulk / many domains" line can now be
-- "Register for N years" with a start date (the client paid 3 years of domain registration). The
-- dialog writes `years` (2..10) and `start_date` on the bulk line; its rate is the price for the
-- WHOLE term, as on a normal multi-year domain line (R-156 / R-1445), so the quote and its one
-- invoice bill the N years once.
--
-- ─── WHAT ALREADY WORKS ─────────────────────────────────────────────────────
--   record_payment / activate_quote_on_credit / file_invoiced_quote_subscriptions expand a bulk
--   line into one subscription per domain with start = line.start_date and the filers' default
--   renewal = start + 1 year. subscription_term_follows_line (R-1445) matches the row to its
--   line by plan name and, for `years` 2..10, sets renewal = start + years and mrr = mrr / years.
--
-- ─── WHAT WAS STILL WRONG FOR A BULK LINE ───────────────────────────────────
--   1. The money per year drifted. The filer splits round(line amount / 12) across the domains
--      (whole rupees, last domain takes the remainder) and R-1445 then rounds mrr / years again:
--      ₹800 a year for 3 years → pool share 200 → 67 → 67 × 12 = ₹804 at the next renewal.
--      R-2369's exact term_amount skips bulk lines (their qty is the sum of all domains).
--   2. The same plan sold as a normal line AND a bulk line on one quote: the row took the first
--      line with that name, so a bulk row could take the normal line's term (or the reverse).
--   3. vendor_cost_per_seat_month: the filers write round(line cost / 12), and a multi-year
--      line's cost is the whole term's (like its rate) — so the stored monthly cost was N times
--      too high (₹600 a year for 3 years → 150 a month instead of 50), for a normal multi-year
--      domain line (R-1445) as much as for a bulk one.
--
-- ─── WHAT THIS DOES ─────────────────────────────────────────────────────────
--   Only subscription_term_follows_line changes (body: 20261106162400, R-2543, the latest):
--   a. Line pick, among the lines with the row's plan name. A row takes a BULK line only when
--      it is that bulk line's own row:
--        - its domain is one of the bulk line's domains, AND
--        - it was filed from that bulk loop. The filers file a quote's lines in line order, so
--          that is: every normal subscription line of the same name that comes BEFORE the bulk
--          line already has its subscription on this quote (rows of this quote + plan on another
--          domain >= those lines). With no such normal line before it, the first test decides.
--      Every other row is a normal line's row and picks exactly as before (same domain, then
--      line order) among the NON-bulk lines; a bulk line is its last resort only. So "bulk"
--      never outranks line order for a normal row — e.g. a normal 1-year line (no domain of its
--      own) whose row borrowed the customer's domain, next to a bulk line listing that domain
--      with the same seats, keeps its own 1 year.
--      A quote with one line of that name picks it exactly as before.
--   b. A row of a bulk line with years 2..10 (its domain is listed, seats > 0, a usable rate):
--        renewal_date = start + years                       (as R-1445)
--        term_amount  = seats × net rate ÷ years            (the exact price of ONE year)
--        mrr          = round(term_amount ÷ 12)             (one rounding, from the exact figure)
--      Net rate = the line's renewal_rate, else rate × (1 − discount_pct) — the same figure the
--      filers' pool is built from (R-329). Anything unusable → the R-1445 rule (mrr ÷ years).
--   c. Any row of a line with years 2..10 (bulk or normal): vendor_cost_per_seat_month =
--      round(line cost ÷ (12 × years)) — ONE division from the line's own cost, rounded once
--      (the filer's figure ÷ years only when the line carries no usable cost).
--   The "lists the domain" test is one jsonb containment (@>) per row — the Bulk dialog stores
--   domains lower-case, as the filers file them; a list typed any other way is scanned.
--   term_months stays 12: after the paid years a domain renews yearly (R-1445). A bulk line
--   without `years` (every bulk line made before this card) is filed exactly as before.
--   record_payment and every renewal function are not touched. No data is changed.

begin;

-- R-1445 + R-2533 + R-2543 + R-2712
create or replace function public.subscription_term_follows_line()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_lines   jsonb;
  v_line    jsonb;
  v_yearly  boolean;
  v_renewal date;
  v_years   int;
  v_term    int;
  v_cycle_m int;
  v_min     date;
  v_dom     text;      -- R-2712
  v_rate    numeric;   -- R-2712
  v_year_amount numeric;  -- R-2712
  v_bulk_i  bigint;    -- R-2712: the bulk line (its position) that lists this row's domain
  v_before  int;       -- R-2712: normal subscription lines of the same name before that bulk line
  v_filed   int;       -- R-2712: rows of this quote + plan already filed on another domain
  v_cost    numeric;   -- R-2712
begin
  -- R-1445
  if new.quote_id is null or new.start_date is null or new.renewal_date is null then
    return new;
  end if;

  v_yearly := new.renewal_date = (new.start_date + interval '1 year')::date;
  if not v_yearly and new.renewal_date <> (new.start_date + interval '1 month')::date then
    return new;   -- the caller chose its own date: keep it
  end if;

  -- R-2533: split-billed = more than one part per term.
  v_term := greatest(1, coalesce(new.term_months, 12));
  v_cycle_m := case coalesce(new.billing_cycle::text, '')
                 when 'monthly' then 1 when 'quarterly' then 3 when 'half_yearly' then 6 else null end;
  v_min := (new.start_date + make_interval(months => v_term))::date - 1;
  v_dom := nullif(lower(btrim(coalesce(new.domain, ''))), '');

  <<from_line>>
  begin
    select q.line_items into v_lines
      from public.quotes q
     where q.id = new.quote_id and q.tenant_id = new.tenant_id;
    if v_lines is null or jsonb_typeof(v_lines) <> 'array' then
      exit from_line;
    end if;

    /* R-2712: is this row a bulk line's OWN row? (header, a.) Its domain must be listed by a
       bulk line of its plan name … */
    v_line := null;
    select t.i, t.e into v_bulk_i, v_line
      from jsonb_array_elements(v_lines) with ordinality as t(e, i)
     where jsonb_typeof(t.e) = 'object'
       and lower(btrim(coalesce(t.e->>'name', ''))) = lower(btrim(coalesce(new.plan, '')))
       and public.r2712_bulk_line_lists_domain(t.e, v_dom, null)
     order by t.i
     limit 1;
    if v_bulk_i is not null then
      /* … and it must come from that bulk loop: the normal subscription lines of the same name
         BEFORE the bulk line are filed first (line order), each with its own row. While one of
         them still has no row, this row is theirs — even when it borrowed a listed domain. */
      select count(*) into v_before
        from jsonb_array_elements(v_lines) with ordinality as t(e, i)
       where t.i < v_bulk_i
         and jsonb_typeof(t.e) = 'object'
         and lower(btrim(coalesce(t.e->>'name', ''))) = lower(btrim(coalesce(new.plan, '')))
         and coalesce(t.e->>'bulk', '') <> 'true'
         and coalesce(t.e->>'one_time', '') <> 'true'
         and coalesce(t.e->>'commitment', '') not in ('', 'one_time');
      if v_before > 0 then
        select count(*) into v_filed
          from public.subscriptions s
         where s.tenant_id = new.tenant_id and s.quote_id = new.quote_id
           and lower(btrim(coalesce(s.plan, ''))) = lower(btrim(coalesce(new.plan, '')))
           and nullif(lower(btrim(coalesce(s.domain, ''))), '') is distinct from v_dom;
        if v_filed < v_before then
          v_bulk_i := null;
          v_line := null;
        end if;
      end if;
    end if;

    if v_line is null then
      /* A normal line's row: the pick it always had (same domain, then line order) — among the
         non-bulk lines first, so "bulk" never outranks line order here. */
      select t.e into v_line
        from jsonb_array_elements(v_lines) with ordinality as t(e, i)
       where jsonb_typeof(t.e) = 'object'
         and lower(btrim(coalesce(t.e->>'name', ''))) = lower(btrim(coalesce(new.plan, '')))
       order by (coalesce(t.e->>'bulk', '') = 'true'),
                (nullif(lower(btrim(coalesce(t.e->>'domain', ''))), '')
                   is not distinct from nullif(lower(btrim(coalesce(new.domain, ''))), '')) desc,
                t.i
       limit 1;
    end if;
    if v_line is null then
      exit from_line;
    end if;

    -- 1. The date the operator saw / typed (Onboard dialog → line.renewal_date).
    if coalesce(v_line->>'renewal_date', '') ~ '^\d{4}-\d{2}-\d{2}$' then
      begin
        v_renewal := (v_line->>'renewal_date')::date;
      exception when others then
        v_renewal := null;   -- 2026-02-30 and the like: ignore, never fail the payment
      end;
      -- R-2533: split-billed → the line date must cover one whole term, else it is the next
      -- PART's date (Suresh: 19 Dec on a 19 Jun annual half-yearly sale).
      if v_renewal is not null and v_cycle_m is not null and v_cycle_m < v_term and v_renewal < v_min then
        raise notice 'R-2533: quote % line renewal date % is shorter than its %-month term — kept the default',
          new.quote_id, v_renewal, v_term;
        v_renewal := null;
      end if;
      if v_renewal > new.start_date and v_renewal <= (new.start_date + interval '10 years')::date then
        new.renewal_date := v_renewal;
        return new;
      end if;
    end if;

    -- 2. A domain registered for several years (line.years, R-156).
    if v_yearly and coalesce(v_line->>'years', '') ~ '^\d+$' then
      v_years := (v_line->>'years')::int;
      if v_years between 2 and 10 then
        new.renewal_date := (new.start_date + make_interval(years => v_years))::date;
        /* R-2712: the line's cost covers the whole term like its rate, and the filers write
           round(cost / 12). One division from the line's own cost, rounded once; only a line
           with no usable cost falls back to the filer's figure ÷ years. */
        if new.vendor_cost_per_seat_month is not null then
          v_cost := null;
          if jsonb_typeof(v_line->'cost') = 'number' then
            v_cost := (v_line->>'cost')::numeric;
          end if;
          new.vendor_cost_per_seat_month := case
            when v_cost > 0 then round(v_cost / (12.0 * v_years))::int
            else round(new.vendor_cost_per_seat_month::numeric / v_years)::int end;
        end if;

        /* R-2712: a bulk line's row is priced from the line itself — seats × net rate ÷ years is
           the exact price of one year for THIS domain. The filer's mrr is a share of a rounded
           pool; dividing that by the years again drifted (₹800 a year → ₹804). */
        v_year_amount := null;
        if coalesce(v_line->>'bulk', '') = 'true' and coalesce(new.seats, 0) > 0
           and v_bulk_i is not null then   -- this row is that bulk line's own (see the pick above)
          begin
            v_rate := case
              when nullif(v_line->>'renewal_rate', '') is not null then (v_line->>'renewal_rate')::numeric
              else coalesce((v_line->>'rate')::numeric, 0)
                     * (1 - coalesce(nullif(v_line->>'discount_pct', '')::numeric, 0) / 100)
            end;
          exception when others then
            v_rate := null;   -- a non-numeric rate: never fail the payment
          end;
          if v_rate > 0 then
            v_year_amount := round(new.seats * v_rate / v_years, 2);
          end if;
        end if;

        if v_year_amount is not null and round(v_year_amount / 12.0) >= 1 then
          new.mrr := round(v_year_amount / 12.0)::int;
          if new.term_amount is null and v_term = 12
             and public.subscription_term_amount_agrees(v_year_amount, new.mrr, 12, new.seats) then
            new.term_amount := v_year_amount;
          end if;
        else
          new.mrr := round(coalesce(new.mrr, 0)::numeric / v_years)::int;
        end if;
      end if;
    end if;
  end from_line;

  -- R-2543: the filer's default (start + 1 year / + 1 month) on a split-billed row whose term is
  -- longer than that would be refused by trg_subscriptions_zzz_split_term_covers and abort the
  -- whole payment — lift it to the last day of the term, the guard's own rule.
  -- Only the default itself: a multi-year domain line (step 2) already set its own date and mrr.
  if v_cycle_m is not null and v_cycle_m < v_term and new.renewal_date < v_min
     and (new.renewal_date = (new.start_date + interval '1 year')::date
          or new.renewal_date = (new.start_date + interval '1 month')::date) then
    raise notice 'R-2543: subscription default renewal % is shorter than its %-month term — set to %',
      new.renewal_date, v_term, v_min;
    new.renewal_date := v_min;
  end if;

  return new;
end;
$function$;

/* R-2712: does this bulk quote line list the domain — with p_seats given, list it with exactly
   those seats? False for anything that is not a bulk line with a domains array, and for an empty
   domain — never an error (it runs inside a payment). One jsonb containment when the list holds
   the domain as filed (lower-case, trimmed — what the Bulk dialog stores); only a list typed some
   other way is scanned element by element. */
create or replace function public.r2712_bulk_line_lists_domain(p_line jsonb, p_domain text, p_seats integer)
returns boolean
language sql
immutable
set search_path to 'public'
as $function$
  select case
    when p_line is null or jsonb_typeof(p_line) <> 'object' then false
    when coalesce(p_line->>'bulk', '') <> 'true' then false
    when jsonb_typeof(p_line->'domains') <> 'array' then false
    when nullif(lower(btrim(coalesce(p_domain, ''))), '') is null then false
    when p_line->'domains' @> jsonb_build_array(
           case when p_seats is null then jsonb_build_object('domain', lower(btrim(p_domain)))
                else jsonb_build_object('domain', lower(btrim(p_domain)), 'seats', p_seats) end) then true
    else exists (
      select 1 from jsonb_array_elements(p_line->'domains') d
       where jsonb_typeof(d) = 'object'
         and lower(btrim(coalesce(d->>'domain', ''))) = lower(btrim(p_domain))
         and (p_seats is null
              or (coalesce(d->>'seats', '') ~ '^\d+(\.0+)?$' and (d->>'seats')::numeric = p_seats)))
  end;
$function$;

comment on function public.subscription_term_follows_line() is
  'R-1445: a subscription filed from a quote with the default term (start + 1 year / + 1 month) takes its line''s renewal_date (Onboard dialog), or start + years for a multi-year domain line (mrr spread over the years). Any caller-chosen date is kept. R-2533: on a split-billed row a line date shorter than one term is not copied. R-2543: on a split-billed row a default shorter than the term becomes start + term_months - 1 day. R-2712: a row of a multi-year BULK line is priced from the line (seats x net rate / years = term_amount, mrr = that / 12); a bulk line is picked only for its own rows (a domain it lists, filed after the normal lines of that name before it); a multi-year line''s vendor_cost_per_seat_month is round(line cost / (12 x years)).';
comment on function public.r2712_bulk_line_lists_domain(jsonb, text, integer) is
  'R-2712: true when the quote line is a bulk line whose domains array lists this domain (with exactly p_seats seats when given). Used by subscription_term_follows_line.';

-- The trigger function: nobody calls it directly.
revoke all on function public.subscription_term_follows_line() from public, anon, authenticated;
-- The helper is a pure function of its arguments (it reads no table). The trigger above is
-- SECURITY DEFINER, so it calls it as the owner — the explicit grant is the R-401 rule (Cloud SQL
-- gives a new function no default EXECUTE), so a later invoker caller can never hit a 403.
revoke all on function public.r2712_bulk_line_lists_domain(jsonb, text, integer) from public, anon;
grant execute on function public.r2712_bulk_line_lists_domain(jsonb, text, integer) to authenticated, service_role;

commit;
