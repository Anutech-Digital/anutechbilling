-- deploy-peek: exists(select 1 from pg_trigger where tgname = 'trg_invoice_stamp_line_periods' and tgrelid = to_regclass('public.invoices') and not tgisinternal)
-- deploy-key: r2744invoicelineperiod
-- 20261113210500_r2744_invoice_line_service_period.sql
--
-- R-2744 (13 Nov 2026, from the R-2727 review HIGH): an issued GST invoice must never re-print a
-- different service period. Invoices stored no period: the PDF, the invoice screen and the emailed PDF
-- worked it out from the backing quote + the live subscription every time (lib/quotes/service-period.ts
-- lineServicePeriod, R-1764 / R-2727), so editing the quote or the subscription after issue changed the
-- printed period. The owner (13 Nov): one invoice may carry several lines with different periods.
--
-- WHAT THIS DOES
--   On INSERT of an invoice made from a quote, every line object in invoices.line_items gets
--   `service_period`: {"from","to","months"} (YYYY-MM-DD, both ends inclusive; months null for a dated
--   add-seats window) or an explicit JSON null (a line with no period: one-time, one-off quote, unknown
--   commitment, renewal without its term date). Worked out with a SQL copy of the SAME rule the screen
--   and PDF use at that moment — lineServicePeriod + quoteLinePeriodContext + the R-2727 cutoff
--   (app_rule_dates 'r2727_invoice_period_rule' vs the invoice's created_at) + billing's
--   followingTermStart. The parity case list in supabase/tests/r2744_invoice_line_period.test.sql is
--   run through BOTH implementations (the TS test reads it from that file).
--   The trigger runs after trg_invoice_copy_quote_lines (alphabetical BEFORE INSERT order), so the
--   quote's copied lines are stamped too. A line that already carries service_period (a caller that
--   knows each line's own period) is kept. An invoice without a quote is not stamped. Any error ->
--   the invoice is issued unstamped (prints by the old computed path) and a WARNING is logged: a
--   period helper never blocks a tax invoice.
--   Stored values are frozen with the lines: tg_invoices_freeze_issued treats line_items as once-set.
--
-- WHAT THIS DOES NOT DO
--   Existing invoices are NOT changed (a backfill is a data repair = owner's decision).
--   scripts/ops/r2744-invoice-line-period-backfill-report.sql lists, read-only, what one would store.
--   No new table / column, so RLS is unchanged. Pure helpers: execute for authenticated + service_role,
--   never anon (R-401 / R-2389: Cloud SQL has no PUBLIC default); the trigger function has no grants.

begin;

-- ── 1. a real calendar date from the first 10 characters (isoDateOf) ───────────
create or replace function public.invoice_line_iso_date(p text)
returns date
language plpgsql
stable
set search_path = ''
as $$
declare
  s text := left(regexp_replace(coalesce(p, ''), '^\s+|\s+$', '', 'g'), 10);
begin
  if s !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  begin
    if to_char(s::date, 'YYYY-MM-DD') = s then return s::date; end if;
  exception when others then
    return null;
  end;
  return null;
end;
$$;

-- ── 2. one line's period (lineServicePeriod with quoteLinePeriodContext) ──────
-- p_line: the line object; p_quote: the quote row as jsonb; p_sub: {start_date, term_months} of the
-- renewed subscription or null; p_rule_from: app_rule_dates.from_at or null; p_created_at: when the
-- invoice was created. Returns {"from","to","months"} or SQL null.
create or replace function public.invoice_line_service_period(
  p_line jsonb, p_quote jsonb, p_sub jsonb, p_rule_from timestamptz, p_created_at timestamptz
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_commit  text;
  v_range   text[];
  v_rfrom   date;
  v_rto     date;
  v_term    int;
  v_m       numeric;
  v_rtd     date;
  v_start   date;
  v_tm      int;
  v_anniv   boolean := false;
  v_from    date;
  v_years   numeric;
  v_months  int;
begin
  if jsonb_typeof(p_line) is distinct from 'object' then return null; end if;
  if (p_quote->'is_one_off') = 'true'::jsonb then return null; end if;

  -- isTermLine: one_time line no; a dated window yes; else a commitment other than one_time.
  if (p_line->'one_time') = 'true'::jsonb then return null; end if;
  v_range := regexp_match(coalesce(p_line->>'name', ''),
    '(?:pro-rata from|current term)\s+(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})', 'i');
  if v_range is not null then
    v_rfrom := public.invoice_line_iso_date(v_range[1]);
    v_rto   := public.invoice_line_iso_date(v_range[2]);
    if v_rfrom is null or v_rto is null or v_rto < v_rfrom then
      v_rfrom := null; v_rto := null;
    end if;
  end if;
  v_commit := lower(regexp_replace(coalesce(p_line->>'commitment', ''), '^\s+|\s+$', '', 'g'));
  if v_rfrom is null and (v_commit = '' or v_commit = 'one_time') then return null; end if;

  -- 1. Add-seats: the window the line names.
  if v_rfrom is not null then
    return jsonb_build_object('from', to_char(v_rfrom, 'YYYY-MM-DD'), 'to', to_char(v_rto, 'YYYY-MM-DD'), 'months', null);
  end if;
  if (p_quote->'is_add_seats') = 'true'::jsonb then return null; end if;

  v_term := case when v_commit = 'monthly' then 1 when v_commit like 'annual\_%' then 12 else null end;

  -- 2. Renewal / extension: the term after renewal_term_date.
  if (p_quote->'is_renewal') = 'true'::jsonb or (p_quote->'is_extension') = 'true'::jsonb then
    v_rtd := public.invoice_line_iso_date(p_quote->>'renewal_term_date');
    if jsonb_typeof(p_quote->'extension_months') = 'number' then v_m := (p_quote->>'extension_months')::numeric; end if;
    if v_rtd is null or v_m is null or v_m <> trunc(v_m) or v_m <= 0 then return null; end if;
    if v_term = 1 and v_m <> 1 then return null; end if;
    -- R-2727: billing's followingTermStart, only for an invoice created on/after the rule went live
    -- here (invoicePeriodSubscription) and only when the subscription's start is known.
    if p_rule_from is not null and p_created_at is not null and p_created_at >= p_rule_from
       and jsonb_typeof(p_sub) = 'object' then
      v_start := public.invoice_line_iso_date(p_sub->>'start_date');
      if v_start is not null and v_rtd > v_start then
        v_tm := greatest(1, coalesce(case when jsonb_typeof(p_sub->'term_months') = 'number'
                                          then trunc((p_sub->>'term_months')::numeric)::int end, 12));
        select exists (
          select 1 from generate_series(1, 100) n
           where (v_start + make_interval(months => n * v_tm))::date = v_rtd
        ) into v_anniv;
      end if;
    end if;
    if v_anniv then
      return jsonb_build_object('from', to_char(v_rtd, 'YYYY-MM-DD'),
        'to', to_char((v_rtd + make_interval(months => v_m::int))::date - 1, 'YYYY-MM-DD'), 'months', v_m::int);
    end if;
    return jsonb_build_object('from', to_char(v_rtd + 1, 'YYYY-MM-DD'),
      'to', to_char((v_rtd + make_interval(months => v_m::int))::date, 'YYYY-MM-DD'), 'months', v_m::int);
  end if;

  -- 3. New sale: start_date (else the quote's date) + one term (x years on a multi-year line).
  if v_term is null then return null; end if;
  v_from := coalesce(public.invoice_line_iso_date(p_line->>'start_date'),
                     public.invoice_line_iso_date(p_quote->>'created_date'));
  if v_from is null then return null; end if;
  v_months := v_term;
  if v_term = 12 then
    begin
      v_years := (p_line->>'years')::numeric;
    exception when others then
      v_years := null;
    end;
    v_months := 12 * case when v_years is not null and v_years = trunc(v_years) and v_years between 1 and 10
                          then v_years::int else 1 end;
  end if;
  return jsonb_build_object('from', to_char(v_from, 'YYYY-MM-DD'),
    'to', to_char((v_from + make_interval(months => v_months))::date - 1, 'YYYY-MM-DD'), 'months', v_months);
end;
$$;

-- ── 3. every line, a caller's own service_period kept ─────────────────────────
create or replace function public.invoice_lines_with_periods(
  p_lines jsonb, p_quote jsonb, p_sub jsonb, p_rule_from timestamptz, p_created_at timestamptz
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case when jsonb_typeof(p_lines) is distinct from 'array' then p_lines
    else coalesce((
      select jsonb_agg(
               case when jsonb_typeof(l) = 'object' and not (l ? 'service_period')
                    then l || jsonb_build_object('service_period',
                           public.invoice_line_service_period(l, p_quote, p_sub, p_rule_from, p_created_at))
                    else l end
               order by i)
        from jsonb_array_elements(p_lines) with ordinality as e(l, i)
    ), p_lines) end
$$;

revoke all on function public.invoice_line_iso_date(text) from public, anon, authenticated;
revoke all on function public.invoice_line_service_period(jsonb, jsonb, jsonb, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.invoice_lines_with_periods(jsonb, jsonb, jsonb, timestamptz, timestamptz) from public, anon, authenticated;
/* R-401 / R-2389: SECURITY INVOKER functions are granted to authenticated explicitly (Cloud SQL has no
   PUBLIC default). They are pure — they read no table, only their arguments — so this exposes nothing.
   Never anon. */
grant execute on function public.invoice_line_iso_date(text) to authenticated, service_role;
grant execute on function public.invoice_line_service_period(jsonb, jsonb, jsonb, timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.invoice_lines_with_periods(jsonb, jsonb, jsonb, timestamptz, timestamptz) to authenticated, service_role;

-- ── 4. stamp at issue ─────────────────────────────────────────────────────────
create or replace function public.tg_invoice_stamp_line_periods()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_q    jsonb;
  v_sub  jsonb;
  v_rule timestamptz;
begin
  if new.quote_id is null or jsonb_typeof(new.line_items) is distinct from 'array' then return new; end if;
  begin
    select to_jsonb(q) into v_q from public.quotes q
     where q.id = new.quote_id and q.tenant_id = new.tenant_id;
    if v_q is null then return new; end if;

    -- Only an invoice whose lines ARE its quote's lines (the copy trigger, or a caller writing the
    -- same lines): same count, and line by line the same name / qty / rate. A part / instalment /
    -- re-priced invoice that writes its own lines prints no period today (build-props R-375) — it is
    -- left unstamped so it keeps printing exactly that. A line that already carries service_period
    -- (a caller that knows each line's own period) is kept either way.
    if jsonb_typeof(v_q->'line_items') is distinct from 'array'
       or jsonb_array_length(v_q->'line_items') <> jsonb_array_length(new.line_items)
       or exists (
         select 1 from jsonb_array_elements(new.line_items) with ordinality as il(l, i)
          where jsonb_typeof(il.l) = 'object'
            and not (il.l ? 'service_period')
            and ((il.l->'name') is distinct from (v_q->'line_items'->(il.i::int - 1)->'name')
                 or (il.l->'qty') is distinct from (v_q->'line_items'->(il.i::int - 1)->'qty')
                 or (il.l->'rate') is distinct from (v_q->'line_items'->(il.i::int - 1)->'rate'))
       ) then
      return new;
    end if;

    -- loadRenewedSubscription: renewal_subscription_id, else the row whose renewal_quote_id is this quote.
    if (v_q->'is_renewal') = 'true'::jsonb or (v_q->'is_extension') = 'true'::jsonb then
      select jsonb_build_object('start_date', s.start_date, 'term_months', s.term_months) into v_sub
        from public.subscriptions s
       where s.tenant_id = new.tenant_id
         and case when nullif(v_q->>'renewal_subscription_id', '') is not null
                  then s.id::text = v_q->>'renewal_subscription_id'
                  else s.renewal_quote_id = new.quote_id end
       limit 1;
    end if;

    -- loadInvoicePeriodRuleFrom: no row / no table -> the old (day-after) rule.
    begin
      select r.from_at into v_rule from public.app_rule_dates r where r.key = 'r2727_invoice_period_rule';
    exception when undefined_table then
      v_rule := null;
    end;

    new.line_items := public.invoice_lines_with_periods(new.line_items, v_q, v_sub, v_rule, coalesce(new.created_at, now()));
  exception when others then
    raise warning '[R-2744] invoice % (quote %): line periods not stored (%), printed by the computed path',
      new.id, new.quote_id, sqlerrm;
  end;
  return new;
end;
$$;

revoke all on function public.tg_invoice_stamp_line_periods() from public, anon, authenticated;

drop trigger if exists trg_invoice_stamp_line_periods on public.invoices;
create trigger trg_invoice_stamp_line_periods
  before insert on public.invoices
  for each row execute function public.tg_invoice_stamp_line_periods();

comment on function public.tg_invoice_stamp_line_periods() is
  'R-2744: stores each line''s service_period on an invoice made from a quote, at issue (same rule as lib/quotes/service-period.ts lineServicePeriod). Never blocks the invoice.';

commit;
