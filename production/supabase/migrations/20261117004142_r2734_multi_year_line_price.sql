-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.subscription_term_follows_line()') and prosrc like '%R-2734: a NORMAL multi-year line%')
-- deploy-key: r2734multiyearlineprice
-- 20261117004142_r2734_multi_year_line_price.sql
--
-- R-2734 (Pratik, 16 Oct; independent review rev-r2734, 14 Nov): the Onboard dialog's "Register for
-- N years" (and the quote builder's multi-year domain line, R-1445) on the Payment Received path.
-- record_payment files the row with mrr = round(whole-term amount / 12); step 2 of
-- subscription_term_follows_line then did round(mrr / years) — a second rounding. At 2 years about
-- one price in four drifts: ₹999 a year × 2 → 167 → 84 → the renewal after the paid years bills
-- 84 × 12 = ₹1,008, and R-2369 leaves term_amount NULL (84 does not agree with 999). ₹797 × 2 → ₹804.
-- Postpaid / Opening of the same sale were exact (mrr 83, term_amount 999.00).
--
-- ─── WHAT THIS DOES ─────────────────────────────────────────────────────────
--   Only subscription_term_follows_line changes (body: 20261116155537, R-2723, the latest). In step 2
--   (a line with years 2..10 on a row filed with the default term), a NORMAL (non-bulk) line whose qty
--   equals the row's seats is priced from the line exactly as R-2712 prices a bulk line's own row:
--     year_amount = round(seats × net rate ÷ years, 2)   (net rate = renewal_rate, else rate × (1 − discount_pct))
--     mrr         = round(year_amount ÷ 12)               (one rounding)
--     term_amount = year_amount                           (when NULL, 12-month term, and it agrees)
--   Seats ≠ qty, or no usable rate → the old rule (mrr ÷ years), unchanged. Renewal date, vendor
--   cost, the line pick, bulk rows, 1-year lines and caller-chosen dates are exactly as before.
--   record_payment and every renewal function are not touched. No data is changed (existing rows keep
--   their mrr / term_amount; a repair of old 2-year rows, if any, is a separate owner-approved step).
--   r2712_bulk_line_lists_domain is not redefined (unchanged since 20261113004902).

begin;

-- R-1445 + R-2533 + R-2543 + R-2712 + R-2723 + R-2734
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
  v_hint    text;      -- R-2723: '<quote id>|<line index>' the filer set for the row it is inserting
  v_hint_i  int;       -- R-2723
  v_hinted  boolean := false;  -- R-2723: the filer named this row's line — nothing is counted
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

    /* R-2723: the filer (record_payment / activate_quote_on_credit /
       file_invoiced_quote_subscriptions) names the quote line it is filing, in a transaction-local
       setting: '<quote id>|<0-based line index>'. When it names THIS row's quote and a line that
       can be this row's (same plan name; a bulk line must list the row's domain), that line is
       the row's line. Anything else — no setting (import, hand insert, an older filer), another
       quote, an index past the end, junk — is ignored and the R-2712 pick below decides. */
    v_line := null;
    v_bulk_i := null;
    v_hint := nullif(current_setting('app.r2723_quote_line', true), '');
    if v_hint is not null and v_hint ~ '[|][0-9]{1,6}$'
       and left(v_hint, length(v_hint) - length(substring(v_hint from '[|][0-9]{1,6}$'))) = new.quote_id then
      v_hint_i := substring(v_hint from '[|]([0-9]{1,6})$')::int;
      v_line := v_lines -> v_hint_i;
      if v_line is not null and jsonb_typeof(v_line) = 'object'
         and lower(btrim(coalesce(v_line->>'name', ''))) = lower(btrim(coalesce(new.plan, ''))) then
        if coalesce(v_line->>'bulk', '') <> 'true' then
          v_hinted := true;
        elsif public.r2712_bulk_line_lists_domain(v_line, v_dom, null) then
          v_hinted := true;
          v_bulk_i := v_hint_i + 1;
        end if;
      end if;
      if not v_hinted then
        v_line := null;
      end if;
    end if;

    if not v_hinted then   -- R-2723: the R-2712 pick, unchanged, for a row whose line was not named
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
    end if;   -- R-2723: not v_hinted

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
           pool; dividing that by the years again drifted (₹800 a year → ₹804).
           R-2734: a NORMAL multi-year line whose qty is this row's seats is priced the same way.
           The filer wrote round(whole term ÷ 12) and ÷ years rounded a second time (₹999 a year ×
           2 years → 167 → 84 → renews at ₹1,008, term_amount left NULL). Any other row (seats ≠
           qty, no usable rate) keeps the old mrr ÷ years. */
        v_year_amount := null;
        if coalesce(new.seats, 0) > 0
           and ((coalesce(v_line->>'bulk', '') = 'true'
                 and v_bulk_i is not null)   -- this row is that bulk line's own (see the pick above)
                or (coalesce(v_line->>'bulk', '') <> 'true'   -- R-2734
                    and coalesce(v_line->>'qty', '') ~ '^\d+(\.0+)?$'
                    and (v_line->>'qty')::numeric = new.seats)) then
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

    /* 3. R-2723: a bulk line's own row on a ONE-year line — the R-2712 rule with years = 1.
       The filer's mrr is a share of a rounded pool (floor, the last domain takes the rest):
       3 domains × ₹800 a year → 66 / 66 / 68 → renewals of ₹792 / ₹792 / ₹816, and R-2369's exact
       term_amount skips bulk lines. Priced from the line itself: seats × net rate = the exact
       price of the year, mrr = that ÷ 12 rounded once. Only a yearly row (a Flexible bulk row
       renews + 1 month), a 12-month term, and when the caller gave no term_amount; anything
       unusable (0 seats, a rate of 0 or not a number) keeps the filer's figures. */
    if v_yearly and v_bulk_i is not null and coalesce(v_line->>'bulk', '') = 'true'
       and coalesce(v_years, 1) not between 2 and 10
       and v_term = 12 and coalesce(new.seats, 0) > 0 and new.term_amount is null then
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
        v_year_amount := round(new.seats * v_rate, 2);
        if round(v_year_amount / 12.0) >= 1
           and public.subscription_term_amount_agrees(v_year_amount, round(v_year_amount / 12.0)::int, 12, new.seats) then
          new.mrr := round(v_year_amount / 12.0)::int;
          new.term_amount := v_year_amount;
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

comment on function public.subscription_term_follows_line() is
  'R-1445: a subscription filed from a quote with the default term (start + 1 year / + 1 month) takes its line''s renewal_date (Onboard dialog), or start + years for a multi-year domain line (mrr spread over the years). Any caller-chosen date is kept. R-2533: on a split-billed row a line date shorter than one term is not copied. R-2543: on a split-billed row a default shorter than the term becomes start + term_months - 1 day. R-2712: a row of a multi-year BULK line is priced from the line (seats x net rate / years = term_amount, mrr = that / 12); a multi-year line''s vendor_cost_per_seat_month is round(line cost / (12 x years)). R-2723: the row''s line is the one the filer names in app.r2723_quote_line (''<quote id>|<line index>''); without it the R-2712 count decides; a 1-year bulk row is priced from the line too (seats x net rate).';

-- The trigger function: nobody calls it directly.
revoke all on function public.subscription_term_follows_line() from public, anon, authenticated;

commit;
