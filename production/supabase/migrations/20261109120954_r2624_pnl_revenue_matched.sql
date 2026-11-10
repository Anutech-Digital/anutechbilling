-- deploy-peek: to_regprocedure('public.report_pnl_revenue_matched_months(date,date)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.report_pnl_revenue_matched_rows(date,date,text[])') and prosrc like '%R-2624%')
-- deploy-key: r2624revenuematched
--
-- R-2624 (9 Nov 2026, slice 4 of R-2156): the P&L "Management (matched)" view spreads prepaid
-- multi-month revenue over the months it pays for — a ₹12,000 yearly invoice dated 1 Oct is
-- ₹1,000 a month Oct..Sep, not ₹12,000 in October.
--
-- Found 30 Oct on the Oct 2026 P&L: October revenue held whole-year prepaid invoices, so October's
-- margin was inflated and the later months of those terms looked empty.
--
-- ══ WHAT CHANGES ══════════════════════════════════════════════════════════════════════════
--   NOTHING existing. report_pnl, report_pnl_revenue_lines, report_pnl_revenue_by_product (the
--   "As invoiced (GST)" view, GST returns, Balance Sheet, Trial Balance) are untouched. New:
--
--   revenue_month_start / revenue_safe_date / revenue_period_months / revenue_part_months
--       small pure date helpers (plain SQL, no SET clause, so the planner inlines them).
--   revenue_line_service_period(...)      — one line's service period: first month + months + basis.
--   report_pnl_revenue_matched_rows(p_from, p_to, p_families)
--       the SAME documents and family shares as report_pnl_revenue_lines (R-2181 — it is called,
--       not copied), each share spread over its service months: one row per (document, family,
--       month) with the part of that month inside [p_from, p_to].
--   report_pnl_revenue_matched_lines  — per (document, family): the drill.
--   report_pnl_revenue_matched        — the totals: the card and the revenue-by-product rows.
--   report_pnl_revenue_matched_months — per month in ONE call: the FY trend.
--   All three are sums of the same rows, so the card, the product rows, the drill and the trend
--   always agree.
--
-- ══ THE SERVICE PERIOD OF A LINE (most specific first; dates as lib/quotes/service-period.ts) ══
--   1. A one-time line — one_time marker, one_time_of (R-2095: the quote's setup lines on the
--      first billing part), commitment 'one_time' — or a one-off quote: the invoice month, also
--      on a billing-part invoice.
--   2. Invoice raised for billing parts (subscription_billings.invoice_id — split-billed /
--      quarterly): the parts' period_start..period_end ('billing_part'; period_end is the next
--      part's start, so 29 Oct..29 Jan is 3 months: Oct, Nov, Dec; 31 Jan..28 Feb is 1).
--   3. No commitment, an undated add-seats line, a project invoice, an invoice with no lines:
--      the invoice month ('invoice_month') — exactly as the GST view.
--   4. A line naming its window — "(pro-rata from X to Y)" / "(current term X to Y)" (R-800,
--      R-806): the calendar months it touches ('line_dates').
--   5. Renewal / extension quote: extension_months from the day after quotes.renewal_term_date
--      (R-1574 — the next term), else from the invoice date ('term').
--   6. New sale: the line's start_date (else the invoice date) + one term — flex 'monthly' 1
--      month; an annual line the quote's billing cycle (yearly 12, half-yearly 6, quarterly 3,
--      monthly 1; legacy annual_quarterly etc. say it on the line) ('term').
--   A period over 36 months, a broken date, a start more than 12 months from the invoice or an
--   end more than 35 months after its month → the invoice month.
--
-- ══ MONEY RULES ══════════════════════════════════════════════════════════════════════════
--   * Whole rupees: each share ÷ months, truncated toward zero, the remainder in the LAST month
--     (R-2156's rule) — the months add up to the share exactly; nothing created or lost.
--   * A credit / debit note follows its invoice's period from the NOTE's month to the period end
--     (past months are not rewritten); dated after the period → the note's month.
--   * A report range that cuts a month takes a spread month's part by days (rounded per row; the
--     totals are sums of the rows, so the drill adds up to the card). A one-month sale
--     ('invoice_month') counts whole on its own date — never in a range that ends before it.
--   * Documents dated from 36 months before to 12 months after the range are read, so a service
--     month is counted wherever it falls: the 12 months of a year add up to that year, and over
--     a range covering every service month the total = report_pnl revenue exactly.
--   * Dates are calendar dates (invoice_date / period columns are DATE — the business's own IST
--     day); month starts are date arithmetic, never a time zone conversion.
--   * Speed (checker BLOCK 9 Nov: 3,000 invoices = 6.4 s a month, 51 s for the FY trend): now a
--     month ~1.0 s and all 12 FY months ~1.7 s in ONE call (local laptop under load, same run
--     report_pnl 0.08 s). Only documents that can reach the range get the family split; lines
--     that cannot spread are not worked out; joins instead of per-row subqueries over CTEs.
--     The month-rows function runs with jit and nested loops off: CTE row estimates are 1, and a
--     nested loop over them made the report quadratic (26 s).
--
-- SECURITY INVOKER, STABLE, read-only; fails CLOSED without a company (report_pnl's message).
-- Rollback: drop function public.report_pnl_revenue_matched_months(date, date);
--           drop function public.report_pnl_revenue_matched(date, date);
--           drop function public.report_pnl_revenue_matched_lines(date, date, text[]);
--           drop function public.report_pnl_revenue_matched_rows(date, date, text[]);
--           drop function public.revenue_line_service_period(date, jsonb, boolean, boolean, boolean, boolean, integer, text, date);
--           drop function public.revenue_part_months(date, date);
--           drop function public.revenue_period_months(date, date);
--           drop function public.revenue_safe_date(text);
--           drop function public.revenue_month_start(date);
-- Test: supabase/tests/r2624_pnl_revenue_matched.test.sql

begin;

-- ── 1. Small date helpers — pure date arithmetic, no table access, every name qualified.
--      Plain SQL WITHOUT a SET clause on purpose: the planner inlines them into the report
--      (a SET clause or plpgsql made one call per line and the month took seconds).

create or replace function public.revenue_month_start(p_d date)
returns date
language sql
immutable
as $function$
  /* R-2624 */
  select p_d - (pg_catalog.date_part('day', p_d)::integer - 1);
$function$;

-- "2026-10-27..." → that date; anything that is not a real calendar date → null (no exception).
create or replace function public.revenue_safe_date(p_s text)
returns date
language sql
immutable
as $function$
  /* R-2624 */
  select case when coalesce(p_s, '') !~ '^\d{4}-\d{2}-\d{2}' then null
              when substr(p_s, 6, 2)::integer not between 1 and 12 then null
              when substr(p_s, 9, 2)::integer not between 1 and
                   pg_catalog.date_part('day', (pg_catalog.make_date(substr(p_s, 1, 4)::integer, substr(p_s, 6, 2)::integer, 1)
                                     + interval '1 month' - interval '1 day'))::integer then null
              else pg_catalog.make_date(substr(p_s, 1, 4)::integer, substr(p_s, 6, 2)::integer, substr(p_s, 9, 2)::integer) end;
$function$;

-- 1 Oct..30 Sep = 12; 15 Oct..14 Oct next year = 12 (anniversary); 25 Sep..31 Mar = 7 (the
-- calendar months it touches); to < from → null.
create or replace function public.revenue_period_months(p_from date, p_to date)
returns integer
language sql
immutable
as $function$
  /* R-2624 */
  select case
    when p_from is null or p_to is null or p_to < p_from then null
    when pg_catalog.date_part('day', (p_to + 1)) = pg_catalog.date_part('day', p_from) then
      ((pg_catalog.date_part('year', (p_to + 1)) * 12 + pg_catalog.date_part('month', (p_to + 1)))
       - (pg_catalog.date_part('year', p_from) * 12 + pg_catalog.date_part('month', p_from)))::integer
    else
      ((pg_catalog.date_part('year', p_to) * 12 + pg_catalog.date_part('month', p_to))
       - (pg_catalog.date_part('year', p_from) * 12 + pg_catalog.date_part('month', p_from)) + 1)::integer
  end;
$function$;

-- A billing part start..end, end = the next part's start (clamped to a short month's end:
-- 31 Jan..28 Feb is one month, 31 Jan..30 Apr three) or written inclusive (1 Oct..31 Dec):
-- whole months, a half month or more rounds up. Never below 1; null for a broken range.
create or replace function public.revenue_part_months(p_start date, p_end date)
returns integer
language sql
immutable
as $function$
  /* R-2624 */
  select case
    when p_start is null or p_end is null or p_end < p_start then null
    else greatest(1,
      ((pg_catalog.date_part('year', p_end) * 12 + pg_catalog.date_part('month', p_end))
       - (pg_catalog.date_part('year', p_start) * 12 + pg_catalog.date_part('month', p_start)))::integer
      + case when pg_catalog.date_part('day', p_end) - pg_catalog.date_part('day', p_start) >= 15 then 1
             when pg_catalog.date_part('day', p_end) - pg_catalog.date_part('day', p_start) <= -15
                  and p_end <> (public.revenue_month_start(p_end) + interval '1 month')::date - 1 then -1
             else 0 end)
  end;
$function$;

revoke all on function public.revenue_month_start(date) from public, anon;
grant execute on function public.revenue_month_start(date) to authenticated, service_role;
revoke all on function public.revenue_safe_date(text) from public, anon;
grant execute on function public.revenue_safe_date(text) to authenticated, service_role;
revoke all on function public.revenue_period_months(date, date) from public, anon;
grant execute on function public.revenue_period_months(date, date) to authenticated, service_role;
revoke all on function public.revenue_part_months(date, date) from public, anon;
grant execute on function public.revenue_part_months(date, date) to authenticated, service_role;

-- ── 2. One line's service period (rules 1 and 3–6 above; billing parts are rule 2, in the
--      report). One SELECT, plain SQL, inlined.
create or replace function public.revenue_line_service_period(
  p_inv_date date, p_line jsonb,
  p_is_one_off boolean, p_is_add_seats boolean, p_is_renewal boolean, p_is_extension boolean,
  p_ext_months integer, p_cycle text, p_renewal_term_date date)
returns table(service_from date, months integer, basis text)
language sql
immutable
as $function$
  /* R-2624 — two levels, each value worked out once per line (the fence keeps it so) */
  select case k.kind when 'dates' then public.revenue_month_start(k.d_from)
                     when 'renew' then public.revenue_month_start(k.r_start)
                     when 'new'   then public.revenue_month_start(k.n_start)
                     else public.revenue_month_start(p_inv_date) end,
         case k.kind when 'dates' then k.d_n when 'renew' then p_ext_months when 'new' then k.n_n else 1 end,
         case k.kind when 'dates' then 'line_dates' when 'renew' then 'term' when 'new' then 'term'
                     else 'invoice_month' end
    from (
      select a.d_from, a.d_n, a.r_start, a.n_start, a.n_n,
             case
               when coalesce(p_is_one_off, false) or a.one_time then 'inv'
               when a.m is not null then
                 case when a.d_n between 1 and 36 and abs(a.d_from - p_inv_date) <= 366 then 'dates' else 'inv' end
               when a.c is null or coalesce(p_is_add_seats, false) then 'inv'
               when coalesce(p_is_renewal, false) or coalesce(p_is_extension, false) then
                 case when p_ext_months between 1 and 36 and not (a.c = 'monthly' and p_ext_months <> 1)
                      then 'renew' else 'inv' end
               else 'new'
             end as kind
        from (
          select x.m, x.c, x.one_time, x.n_n,
                 public.revenue_safe_date(x.m[1]) as d_from,
                 public.revenue_period_months(public.revenue_safe_date(x.m[1]), public.revenue_safe_date(x.m[2])) as d_n,
                 case when p_renewal_term_date is not null and abs(p_renewal_term_date + 1 - p_inv_date) <= 366
                      then p_renewal_term_date + 1 else p_inv_date end as r_start,
                 case when x.sd is not null and abs(x.sd - p_inv_date) <= 366 then x.sd else p_inv_date end as n_start
            from (
              select case when position('pro-rata from' in lower(coalesce(p_line->>'name', ''))) > 0
                            or position('current term' in lower(coalesce(p_line->>'name', ''))) > 0
                          then regexp_match(p_line->>'name',
                                 '(?:pro-rata from|current term)\s+(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})', 'i') end as m,
                     lower(nullif(btrim(coalesce(p_line->>'commitment', '')), '')) as c,
                     (lower(coalesce(p_line->>'one_time', '')) = 'true' or p_line ? 'one_time_of'
                      or lower(btrim(coalesce(p_line->>'commitment', ''))) = 'one_time') as one_time,
                     case when p_line ? 'start_date' then public.revenue_safe_date(p_line->>'start_date') end as sd,
                     case lower(nullif(btrim(coalesce(p_line->>'commitment', '')), ''))
                       when 'monthly'            then 1
                       when 'annual_monthly'     then 1
                       when 'annual_quarterly'   then 3
                       when 'annual_half_yearly' then 6
                       else case coalesce(p_cycle, 'yearly')
                              when 'monthly' then 1 when 'quarterly' then 3 when 'half_yearly' then 6 else 12 end
                     end as n_n
              offset 0) x
          offset 0) a
    ) k;
$function$;

revoke all on function public.revenue_line_service_period(date, jsonb, boolean, boolean, boolean, boolean, integer, text, date) from public, anon;
grant execute on function public.revenue_line_service_period(date, jsonb, boolean, boolean, boolean, boolean, integer, text, date) to authenticated, service_role;

-- The period a line's money is placed in: a one-time line → the invoice month (also on a
-- billing-part invoice); else the billing part; else the line's own period. A period starting
-- over 12 months before the invoice month or ending over 35 months after it → the invoice month.
create or replace function public.revenue_line_pick(
  p_inv_date date, p_one_time boolean, p_part_from date, p_part_months integer,
  p_line_from date, p_line_months integer, p_line_basis text)
returns table(sf date, n integer, basis text)
language sql
immutable
as $function$
  /* R-2624 */
  select case when c.ok then c.sf else c.inv_m end,
         case when c.ok then c.n else 1 end,
         case when c.ok then c.basis else 'invoice_month' end
    from (
      select p.*, (p.sf >= (p.inv_m - interval '12 months')::date
                   and (p.sf + make_interval(months => p.n - 1))::date <= (p.inv_m + interval '35 months')::date) as ok
        from (
          select public.revenue_month_start(p_inv_date) as inv_m,
                 case when p_one_time then public.revenue_month_start(p_inv_date)
                      when p_part_months is not null then p_part_from else p_line_from end as sf,
                 case when p_one_time then 1 when p_part_months is not null then p_part_months else p_line_months end as n,
                 case when p_one_time then 'invoice_month' when p_part_months is not null then 'billing_part'
                      else p_line_basis end as basis
          offset 0) p
      offset 0) c;
$function$;

revoke all on function public.revenue_line_pick(date, boolean, date, integer, date, integer, text) from public, anon;
grant execute on function public.revenue_line_pick(date, boolean, date, integer, date, integer, text) to authenticated, service_role;

-- ── 3. The month rows: every document share spread over its service months ──────────────
-- One row per (document, family, month) with the part of that month inside [p_from, p_to].
-- The lines (drill), the totals (card + product rows) and the FY months are sums of these rows.
--
-- The documents and their family shares are R-2181's report_pnl_revenue_lines, row for row
-- (same filters, same taxable rule, same family weights and largest-remainder split — proven
-- equal by the SQL test, H2). They are worked out here only for the documents whose service
-- period can reach the range: first each line's period (cheap), then the family split for those
-- documents alone — a month of a 3,000-invoice company reads a few hundred documents, not 6,000.
create or replace function public.report_pnl_revenue_matched_rows(p_from date, p_to date, p_families text[] default null)
returns table(doc_kind text, doc_id text, invoice_id text, customer_name text, doc_date date, status text,
              family text, basis text, month date, amount bigint, doc_amount bigint, service_from date, service_to date)
language plpgsql
stable
set search_path to 'public'
set jit to off
set enable_nestloop to off
as $function$
#variable_conflict use_column
declare
  /* R-2624 */
  v_tenant uuid := public.current_tenant_id();
  v_lo     date;
  v_hi     date;
  v_m0     date;
begin
  if v_tenant is null then
    raise exception 'P&L nahi ban sakta: aapka login kisi workspace se juda nahi hai. Dobara sign in karein; phir bhi ho to owner se Settings → Team me aapko jodne ko kahein.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'P&L ki tareekh galat hai (% se % tak). "From" tareekh "To" se pehle ya barabar honi chahiye — range dobara chunein.', p_from, p_to
      using errcode = 'invalid_parameter_value';
  end if;
  -- A service period starts at most 12 months before its document's month and ends at most
  -- 35 months after it (else: the invoice month), so only documents dated in this window can
  -- reach the range.
  v_m0 := public.revenue_month_start(p_from);
  v_lo := (v_m0 - interval '36 months')::date;
  v_hi := (p_to + interval '12 months')::date;

  return query
  with docs_all as materialized (
    -- report_pnl / R-2181's documents (same filters, same taxable rule), dated in the window.
    select 'invoice'::text as kind, i.id as doc_id, i.id as invoice_id, i.customer_name, i.invoice_date as doc_date,
           i.status::text as status,
           coalesce(i.taxable_value::bigint,
             floor(i.amount::numeric * 100 / (100 + coalesce(i.tax_rate, 18)) + 0.5)::bigint) as amt
      from public.invoices i
     where i.tenant_id = v_tenant and i.invoice_date between v_lo and v_hi
       and i.status in ('pending', 'paid', 'overdue')
       and public.invoice_is_sale(i.document_kind)  -- R-1739
    union all
    select 'credit_note', c.id, c.invoice_id, c.customer_name, c.credit_date, null::text, c.taxable_value::bigint
      from public.credit_notes c where c.tenant_id = v_tenant and c.credit_date between v_lo and v_hi
    union all
    select 'debit_note', d.id, d.invoice_id, d.customer_name, d.debit_date, null::text, d.taxable_value::bigint
      from public.debit_notes d where d.tenant_id = v_tenant and d.debit_date between v_lo and v_hi
  ), inv as materialized (
    -- the invoice behind each document (lines, quote flags) — any status, as R-2181 reads lines
    select i.id, i.invoice_date, i.line_items, q.line_items as q_lines,
           q.is_one_off, q.is_add_seats, q.is_renewal, q.is_extension, q.extension_months, q.billing_cycle,
           q.renewal_term_date
      from (select distinct d.invoice_id from docs_all d) di
      join public.invoices i on i.id = di.invoice_id and i.tenant_id = v_tenant
      left join public.quotes q on q.id = i.quote_id and q.tenant_id = v_tenant
  ), proj as materialized (
    select distinct pm.invoice_id
      from public.project_milestones pm
     where pm.tenant_id = v_tenant and pm.invoice_id is not null
  ), part_period as materialized (
    -- Billing parts (split-billed / quarterly): the invoice covers exactly these periods.
    select b.invoice_id, public.revenue_month_start(min(b.period_start)) as sf,
           public.revenue_part_months(min(b.period_start), max(b.period_end)) as n
      from public.subscription_billings b
      join inv x on x.id = b.invoice_id
     where b.tenant_id = v_tenant
     group by b.invoice_id
    having public.revenue_part_months(min(b.period_start), max(b.period_end)) between 1 and 36
  ), line_src as (
    -- the same line source as R-1835 / R-2181: the invoice's lines, else its quote's; a project
    -- invoice is 'projects' and has no lines (R-2181)
    select x.id as invoice_id, x.invoice_date, x.is_one_off, x.is_add_seats, x.is_renewal, x.is_extension,
           x.extension_months, x.billing_cycle, x.renewal_term_date, e.li, pp.sf as p_sf, pp.n as p_n,
           greatest(
             (case when jsonb_typeof(e.li->'qty') = 'number' then (e.li->>'qty')::numeric else 1 end)
           * (case when jsonb_typeof(e.li->'rate') = 'number' then (e.li->>'rate')::numeric else 0 end), 0) as wt,
           -- a one-time line (marker, R-2095's one_time_of on a first part, or commitment) never
           -- spreads — checked BEFORE the billing part
           (lower(coalesce(e.li->>'one_time', '')) = 'true' or e.li ? 'one_time_of'
            or lower(btrim(coalesce(e.li->>'commitment', ''))) = 'one_time') as one_time
      from inv x
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(x.line_items) = 'array' and jsonb_array_length(x.line_items) > 0 then x.line_items
             when jsonb_typeof(x.q_lines) = 'array' then x.q_lines
             else '[]'::jsonb end) as e(li)
      left join part_period pp on pp.invoice_id = x.id
      left join proj pj on pj.invoice_id = x.id
     where jsonb_typeof(e.li) = 'object'
       and pj.invoice_id is null
  ), probe as materialized (
    -- which invoices dated outside the range can still put money in it: only lines that can
    -- spread (a term, a dated window, a renewal, a start date, a billing part) are worked out
    select l.invoice_id, lp.sf, lp.n
      from line_src l
      cross join lateral public.revenue_line_service_period(
        l.invoice_date, l.li, l.is_one_off, l.is_add_seats, l.is_renewal, l.is_extension,
        l.extension_months, l.billing_cycle::text, l.renewal_term_date) sp
      cross join lateral public.revenue_line_pick(l.invoice_date, l.one_time, l.p_sf, l.p_n, sp.service_from, sp.months, sp.basis) lp
     where l.invoice_date not between v_m0 and p_to
       and not l.one_time
       and (l.p_n is not null
            or lower(btrim(coalesce(l.li->>'commitment', ''))) not in ('', 'monthly')
            or l.li ? 'start_date'
            or coalesce(l.li->>'name', '') ~* '(pro-rata from|current term)'
            or coalesce(l.is_renewal, false) or coalesce(l.is_extension, false))
  ), reach as (
    -- lines that can spread, AND every billing-part invoice by its part (an invoice raised for a
    -- part may have no lines at all — its money then follows the part, R-2624 re-check)
    select p.invoice_id from (
      select pr.invoice_id, pr.sf, pr.n from probe pr
      union all
      select pp.invoice_id, pp.sf, pp.n from part_period pp
    ) p
     group by p.invoice_id
    having min(p.sf) <= p_to and max((p.sf + make_interval(months => p.n))::date - 1) >= p_from
  ), docs as materialized (
    -- only documents that can put money in the range: dated in it, or their invoice reaches it
    -- (a note from its own month on)
    select d.*
      from docs_all d
      left join reach r on r.invoice_id = d.invoice_id
      left join inv x on x.id = d.invoice_id
     where d.doc_date between p_from and p_to
        or (d.kind = 'invoice' and x.invoice_date between v_m0 and p_to)
        or (r.invoice_id is not null and (d.kind = 'invoice' or public.revenue_month_start(d.doc_date) <= p_to))
        or (d.kind <> 'invoice' and x.invoice_date between v_m0 and p_to and public.revenue_month_start(d.doc_date) <= p_to)
  ), fam_lines as materialized (
    -- every line of those documents' invoices: its family (R-1835's revenue_family) and period
    select l.invoice_id, lp.sf, lp.n, lp.basis, l.wt,
           public.revenue_family(it.vendor::text, l.li) as family
      from line_src l
      join (select distinct d.invoice_id from docs d) di on di.invoice_id = l.invoice_id
      left join public.items it on it.tenant_id = v_tenant and it.id = l.li->>'item_id'
      cross join lateral public.revenue_line_service_period(
        l.invoice_date, l.li, l.is_one_off, l.is_add_seats, l.is_renewal, l.is_extension,
        l.extension_months, l.billing_cycle::text, l.renewal_term_date) sp
      cross join lateral public.revenue_line_pick(l.invoice_date, l.one_time, l.p_sf, l.p_n, sp.service_from, sp.months, sp.basis) lp
  ), fam_w as (
    -- R-2181's family weights: lines (w > 0), else 'projects' for a project invoice, else 'other'
    select f.invoice_id, f.family, sum(f.wt) as w from fam_lines f group by 1, 2 having sum(f.wt) > 0
    union all
    -- (joins, not per-row subqueries over a CTE: those made the report quadratic)
    select di.invoice_id, case when pj.invoice_id is not null then 'projects' else 'other' end, 1::numeric
      from (select distinct d.invoice_id from docs d) di
      left join proj pj on pj.invoice_id = di.invoice_id
      left join (select f.invoice_id from fam_lines f where f.wt > 0 group by 1) hw on hw.invoice_id = di.invoice_id
     where pj.invoice_id is not null or hw.invoice_id is null
  ), fam_split as (
    -- R-2181's split of each document over its families (largest remainder, same order)
    select s.kind, s.doc_id, s.invoice_id, s.customer_name, s.doc_date, s.status, s.family,
           (case when s.kind = 'credit_note' then -1 else 1 end)
             * (s.base + case when s.rn <= s.left_over then 1 else 0 end) as amount
      from (
        select t.*, floor(t.exact)::bigint as base,
               t.amt - sum(floor(t.exact)::bigint) over (partition by t.kind, t.doc_id) as left_over,
               row_number() over (partition by t.kind, t.doc_id order by t.exact - floor(t.exact) desc, t.family) as rn
          from (select d.*, f.family, d.amt::numeric * f.w / sum(f.w) over (partition by d.kind, d.doc_id) as exact
                  from docs d join fam_w f on f.invoice_id = d.invoice_id) t
      ) s
     where p_families is null or s.family = any(p_families)
  ), groups as (
    -- each family's period groups (by line weight); none (projects, 'other') → the billing
    -- parts' period, else the invoice month
    select f.invoice_id, f.family, f.sf, f.n, f.basis, sum(f.wt) as w
      from fam_lines f where f.wt > 0 group by 1, 2, 3, 4, 5
  ), doc_groups as (
    select d.kind as doc_kind, d.doc_id, d.invoice_id, d.customer_name, d.doc_date, d.status, d.family, d.amount,
           coalesce(g.sf, pp.sf, public.revenue_month_start(coalesce(x.invoice_date, d.doc_date))) as sf,
           coalesce(g.n, pp.n, 1) as n,
           coalesce(g.basis, case when pp.n is not null then 'billing_part' else 'invoice_month' end) as basis,
           coalesce(g.w, 1::numeric) as w
      from fam_split d
      left join groups g on g.invoice_id = d.invoice_id and g.family = d.family
      left join inv x on g.invoice_id is null and x.id = d.invoice_id
      left join part_period pp on g.invoice_id is null and pp.invoice_id = d.invoice_id
  ), ranked as (
    select s.*, floor(s.exact)::bigint as base,
           abs(s.amount) - sum(floor(s.exact)::bigint) over (partition by s.doc_kind, s.doc_id, s.family) as left_over,
           row_number() over (partition by s.doc_kind, s.doc_id, s.family
                              order by s.exact - floor(s.exact) desc, s.sf, s.n, s.basis) as rn
      from (select dg.*, abs(dg.amount)::numeric * dg.w / sum(dg.w) over (partition by dg.doc_kind, dg.doc_id, dg.family) as exact
              from doc_groups dg) s
  ), grp as (
    -- A note starts at its own month (past months are not rewritten) and ends with the period.
    select r.doc_kind, r.doc_id, r.invoice_id, r.customer_name, r.doc_date, r.status, r.family, r.amount, r.basis,
           (case when r.amount < 0 then -1 else 1 end) * (r.base + case when r.rn <= r.left_over then 1 else 0 end) as g_amt,
           case when r.doc_kind = 'invoice' then r.sf
                else greatest(r.sf, public.revenue_month_start(r.doc_date)) end as g_sf,
           case when r.doc_kind = 'invoice' then (r.sf + make_interval(months => r.n - 1))::date
                else greatest((r.sf + make_interval(months => r.n - 1))::date, public.revenue_month_start(r.doc_date)) end as last_m
      from ranked r
  ), grp2 as (
    select g.*,
           ((extract(year from g.last_m) * 12 + extract(month from g.last_m))
            - (extract(year from g.g_sf) * 12 + extract(month from g.g_sf)) + 1)::integer as g_n,
           min(g.g_sf) over w as p_sf,
           max((g.last_m + interval '1 month')::date - 1) over w as p_st
      from grp g
    window w as (partition by g.doc_kind, g.doc_id, g.family)
  ), months as (
    -- only groups that can touch the range are expanded month by month
    select g.*, k,
           (g.g_sf + make_interval(months => k))::date as ms,
           (g.g_sf + make_interval(months => k + 1))::date - 1 as me,
           case when k < g.g_n - 1 then trunc(g.g_amt::numeric / g.g_n)::bigint
                else g.g_amt - trunc(g.g_amt::numeric / g.g_n)::bigint * (g.g_n - 1) end as v
      from grp2 g
      cross join lateral generate_series(0, g.g_n - 1) as k
     where g.g_sf <= p_to and (g.last_m + interval '1 month')::date - 1 >= p_from
  )
  select m.doc_kind, m.doc_id, m.invoice_id, m.customer_name, m.doc_date, m.status, m.family, m.basis, m.ms,
         case
           -- a one-month sale counts whole, on its own date (a custom range never shows a sale made after it)
           when m.basis = 'invoice_month' or (m.ms >= p_from and m.me <= p_to) then m.v
           else round(m.v::numeric * (least(m.me, p_to) - greatest(m.ms, p_from) + 1) / (m.me - m.ms + 1))::bigint
         end,
         m.amount, m.p_sf, m.p_st
    from months m
   where m.ms <= p_to and m.me >= p_from
     and (m.basis <> 'invoice_month' or m.doc_date between p_from and p_to);
end;
$function$;

revoke all on function public.report_pnl_revenue_matched_rows(date, date, text[]) from public, anon;
grant execute on function public.report_pnl_revenue_matched_rows(date, date, text[]) to authenticated, service_role;

-- ── 4. The documents behind Management revenue (the drill) ──────────────────────────────
create or replace function public.report_pnl_revenue_matched_lines(p_from date, p_to date, p_families text[] default null)
returns table(doc_kind text, doc_id text, invoice_id text, customer_name text, doc_date date, status text,
              family text, amount bigint, doc_amount bigint, service_from date, service_to date, basis text)
language sql
stable
set search_path to 'public'
as $function$
  /* R-2624: one row per (document, family) — the sum of its month rows in the range; ₹0 left out. */
  select r.doc_kind, r.doc_id, r.invoice_id, r.customer_name, r.doc_date, r.status, r.family,
         sum(r.amount)::bigint, max(r.doc_amount)::bigint, min(r.service_from), max(r.service_to),
         case when count(distinct r.basis) > 1 then 'mixed' else min(r.basis) end
    from public.report_pnl_revenue_matched_rows(p_from, p_to, p_families) r
   group by r.doc_kind, r.doc_id, r.invoice_id, r.customer_name, r.doc_date, r.status, r.family
  having sum(r.amount) <> 0
   order by r.doc_date desc, r.doc_id, r.family;
$function$;

revoke all on function public.report_pnl_revenue_matched_lines(date, date, text[]) from public, anon;
grant execute on function public.report_pnl_revenue_matched_lines(date, date, text[]) to authenticated, service_role;

-- ── 5. Management revenue = the same rows, added up ──────────────────────────────────────
create or replace function public.report_pnl_revenue_matched(p_from date, p_to date)
returns table(inv_taxable bigint, cn_taxable bigint, dn_taxable bigint, revenue_count integer, by_product jsonb)
language sql
stable
set search_path to 'public'
as $function$
  /* R-2624: the sum of report_pnl_revenue_matched_lines — the drill's own rows. revenue_count =
     invoices with a part in the range (not "issued" in it). */
  with l as (
    select * from public.report_pnl_revenue_matched_lines(p_from, p_to, null)
  ), fam as (
    select l.family,
           coalesce(sum(l.amount) filter (where l.doc_kind = 'invoice'), 0)::bigint as invoiced,
           coalesce(-sum(l.amount) filter (where l.doc_kind = 'credit_note'), 0)::bigint as credit_notes,
           coalesce(sum(l.amount) filter (where l.doc_kind = 'debit_note'), 0)::bigint as debit_notes,
           (count(distinct l.doc_id) filter (where l.doc_kind = 'invoice'))::int as invoice_count
      from l group by l.family
  )
  select coalesce((select sum(f.invoiced) from fam f), 0)::bigint,
         coalesce((select sum(f.credit_notes) from fam f), 0)::bigint,
         coalesce((select sum(f.debit_notes) from fam f), 0)::bigint,
         (select count(distinct l.doc_id) filter (where l.doc_kind = 'invoice') from l)::int,
         coalesce((select jsonb_agg(jsonb_build_object(
                     'family', f.family, 'invoiced', f.invoiced, 'credit_notes', f.credit_notes,
                     'debit_notes', f.debit_notes, 'invoice_count', f.invoice_count) order by f.family)
                     from fam f), '[]'::jsonb);
$function$;

revoke all on function public.report_pnl_revenue_matched(date, date) from public, anon;
grant execute on function public.report_pnl_revenue_matched(date, date) to authenticated, service_role;

-- ── 6. The FY trend in ONE call: Management revenue per calendar month ───────────────────
-- Each month = report_pnl_revenue_matched(that whole month): the same rows, grouped by month.
create or replace function public.report_pnl_revenue_matched_months(p_from date, p_to date)
returns table(month date, inv_taxable bigint, cn_taxable bigint, dn_taxable bigint, revenue_count integer, by_product jsonb)
language sql
stable
set search_path to 'public'
as $function$
  /* R-2624 */
  with l as (
    select r.month, r.doc_kind, r.doc_id, r.family, sum(r.amount)::bigint as amount
      from public.report_pnl_revenue_matched_rows(public.revenue_month_start(p_from),
             (public.revenue_month_start(p_to) + interval '1 month')::date - 1, null) r
     group by 1, 2, 3, 4
    having sum(r.amount) <> 0
  ), fam as (
    select l.month, l.family,
           coalesce(sum(l.amount) filter (where l.doc_kind = 'invoice'), 0)::bigint as invoiced,
           coalesce(-sum(l.amount) filter (where l.doc_kind = 'credit_note'), 0)::bigint as credit_notes,
           coalesce(sum(l.amount) filter (where l.doc_kind = 'debit_note'), 0)::bigint as debit_notes,
           (count(distinct l.doc_id) filter (where l.doc_kind = 'invoice'))::int as invoice_count
      from l group by 1, 2
  ), cnt as (
    select l.month, (count(distinct l.doc_id) filter (where l.doc_kind = 'invoice'))::int as n from l group by 1
  )
  select f.month, sum(f.invoiced)::bigint, sum(f.credit_notes)::bigint, sum(f.debit_notes)::bigint,
         max(c.n),
         jsonb_agg(jsonb_build_object(
           'family', f.family, 'invoiced', f.invoiced, 'credit_notes', f.credit_notes,
           'debit_notes', f.debit_notes, 'invoice_count', f.invoice_count) order by f.family)
    from fam f join cnt c on c.month = f.month
   group by f.month
   order by f.month;
$function$;

revoke all on function public.report_pnl_revenue_matched_months(date, date) from public, anon;
grant execute on function public.report_pnl_revenue_matched_months(date, date) to authenticated, service_role;

commit;
