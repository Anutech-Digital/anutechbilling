-- deploy-peek: to_regprocedure('public.report_pnl_cogs_matched(date,date)') is not null
-- deploy-key: r2156billservicemonth
--
-- R-2156 slice 1 (P1, 9 Nov 2026): P&L matching — the cost of a licence belongs to the month the
-- licence was USED, not the date the vendor's bill was raised. Found 30 Oct on the Oct 2026 P&L:
-- Google's bill dated 7 Oct is "Google Portal Bill (Aug 2026)" (Google bills in arrears), so
-- October showed August's cost and October's own cost will land in December (71% gross margin).
--
-- ══ WHAT CHANGES ═════════════════════════════════════════════════════════════════════════
--   1. vendor_bills.service_from / service_to (date, both or neither): the period the bill is
--      FOR when the owner sets it (R-2623 puts it on the bill form). NULL = work it out:
--   2. public.vendor_bill_service_period(bill_date, category, bill_no, notes, service_from,
--      service_to) → (service_from, service_to, basis), first match wins:
--        'set'            — the bill's own service_from/service_to;
--        'reference'      — a month + year written in the bill no / notes ("Google Portal Bill
--                           (Aug 2026)", "August 2026", "Jul 2026 - Sep 2026" → Jul..Sep), only
--                           when it is between 24 months before and 12 months after the bill
--                           month (a typo like "Aug 2019" is ignored);
--        'vendor_default' — Google (COGS-Workspace) and Microsoft (COGS-M365) portal bills are
--                           raised after the month: the month before the bill date;
--        'bill_month'     — everything else: the bill's own month (same as today).
--   3. public.report_pnl_cogs_matched(p_from, p_to) — the MANAGEMENT view of the same COGS-*
--      bills report_pnl sums: each bill's pre-GST subtotal spread evenly over its service months
--      (whole rupees; the remainder goes to the last month), a month cut by the range counted by
--      days. Returns cogs, cogs_count, cogs_by_category (same shape as report_pnl's, so the P&L can
--      swap it in — R-2622) and bills (one row per bill with its period, basis and amount in range,
--      for the drill).
--   report_pnl (the GST / "as invoiced" view, by bill date) is NOT touched; GST reports and filed
--   months read bill_date as before. No row is written — the new columns start empty.
--
-- Rollback: drop function public.report_pnl_cogs_matched(date, date);
--   drop function public.vendor_bill_service_period(date, text, text, text, date, date);
--   alter table public.vendor_bills drop constraint vendor_bills_service_period_check,
--     drop column service_from, drop column service_to;

alter table public.vendor_bills add column if not exists service_from date;
alter table public.vendor_bills add column if not exists service_to date;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'vendor_bills_service_period_check') then
    alter table public.vendor_bills add constraint vendor_bills_service_period_check
      check ((service_from is null) = (service_to is null)
             and (service_from is null
                  or (service_to >= service_from and service_to < service_from + interval '36 months')));
  end if;
end $$;

comment on column public.vendor_bills.service_from is
  'R-2156: first day of the period this bill is FOR (licence month), set by the owner. NULL = vendor_bill_service_period() works it out (reference month, Google/Microsoft previous month, else bill month). Management P&L only — GST reads bill_date.';
comment on column public.vendor_bills.service_to is
  'R-2156: last day of the period this bill is for; set together with service_from, at most 36 months after it.';

create or replace function public.vendor_bill_service_period(
  p_bill_date date, p_category text, p_bill_no text, p_notes text,
  p_service_from date, p_service_to date)
returns table(service_from date, service_to date, basis text)
language plpgsql
immutable
set search_path to 'public'
as $function$
declare
  /* R-2156 */
  v_bill_month date := date_trunc('month', p_bill_date)::date;
  v_text text := lower(coalesce(p_bill_no, '') || ' ' || coalesce(p_notes, ''));
  v_first date;
  v_last date;
  v_m text[];
  v_month date;
begin
  if p_service_from is not null and p_service_to is not null then
    return query select p_service_from, p_service_to, 'set'::text;
    return;
  end if;
  if p_bill_date is null then
    return query select null::date, null::date, 'bill_month'::text;
    return;
  end if;

  -- A month name + 4-digit year ("Aug 2026", "August-2026", "aug'2026"). A plain number
  -- (a bill no like 5667984259, "08/2026") is never read as a month.
  for v_m in
    select regexp_matches(v_text,
      '\m(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(?:uary|ruary|ch|il|e|y|ust|t|tember|ober|ember)?[\s,.''/-]*((?:19|20)[0-9]{2})\M',
      'g')
  loop
    v_month := to_date(v_m[2] || '-' || v_m[1] || '-01', 'YYYY-mon-DD');
    if v_month >= (v_bill_month - interval '24 months')::date
       and v_month <= (v_bill_month + interval '12 months')::date then
      v_first := least(coalesce(v_first, v_month), v_month);
      v_last := greatest(coalesce(v_last, v_month), v_month);
    end if;
  end loop;
  if v_first is not null then
    return query select v_first, ((v_last + interval '1 month')::date - 1), 'reference'::text;
    return;
  end if;

  if p_category in ('COGS-Workspace', 'COGS-M365') then
    return query select (v_bill_month - interval '1 month')::date, (v_bill_month - 1), 'vendor_default'::text;
    return;
  end if;

  return query select v_bill_month, ((v_bill_month + interval '1 month')::date - 1), 'bill_month'::text;
end;
$function$;

revoke all on function public.vendor_bill_service_period(date, text, text, text, date, date) from public, anon;
grant execute on function public.vendor_bill_service_period(date, text, text, text, date, date) to authenticated, service_role;

create or replace function public.report_pnl_cogs_matched(p_from date, p_to date)
returns table(cogs bigint, cogs_count integer, cogs_by_category jsonb, bills jsonb)
language plpgsql
stable
set search_path to 'public'
as $function$
#variable_conflict use_column
declare
  /* R-2156 */
  v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then
    raise exception 'P&L cannot be built: your login is not linked to a company. Sign in again; if it still happens, ask the owner to add you under Settings → Team.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'The P&L dates are wrong (% to %). "From" must be on or before "To" — pick the range again.', p_from, p_to
      using errcode = 'invalid_parameter_value';
  end if;

  return query
  with b as (
    -- The same bills report_pnl.cogs sums (COGS-* category), whatever their bill date.
    select vb.id, vb.vendor_name, vb.bill_no, vb.bill_date, vb.category, vb.subtotal::bigint as subtotal,
           sp.service_from as sf, sp.service_to as st, sp.basis
      from public.vendor_bills vb
      cross join lateral public.vendor_bill_service_period(vb.bill_date, vb.category, vb.bill_no, vb.notes,
                                                            vb.service_from, vb.service_to) sp
     where vb.tenant_id = v_tenant
       and vb.category like 'COGS-%'
  ), months as (
    -- One row per service month. Whole rupees: every month but the last gets subtotal / n
    -- (truncated toward zero, so a negative credit behaves the same), the last gets the rest.
    select b.id, m.k, b.n_months,
           greatest(m.month_start, b.sf) as part_from,
           least((m.month_start + interval '1 month')::date - 1, b.st) as part_to,
           case when m.k = b.n_months then b.subtotal - (b.subtotal / b.n_months) * (b.n_months - 1)
                else b.subtotal / b.n_months end as share
      from (select b.*, ((extract(year from age(date_trunc('month', b.st), date_trunc('month', b.sf))) * 12
                          + extract(month from age(date_trunc('month', b.st), date_trunc('month', b.sf))))::int + 1) as n_months
              from b) b
      cross join lateral (
        select gs::date as month_start, row_number() over (order by gs)::int as k
          from generate_series(date_trunc('month', b.sf), date_trunc('month', b.st), interval '1 month') gs
      ) m
  ), in_range as (
    -- A month cut by the report range (or by the service period itself) counts by days.
    select mo.id,
           round(mo.share::numeric
                 * (least(mo.part_to, p_to) - greatest(mo.part_from, p_from) + 1)
                 / (mo.part_to - mo.part_from + 1))::bigint as amount
      from months mo
     where mo.part_from <= p_to and mo.part_to >= p_from
  ), per_bill as (
    select b.id, b.vendor_name, b.bill_no, b.bill_date, b.category, b.subtotal, b.sf, b.st, b.basis,
           sum(r.amount)::bigint as amount
      from in_range r join b on b.id = r.id
     group by b.id, b.vendor_name, b.bill_no, b.bill_date, b.category, b.subtotal, b.sf, b.st, b.basis
  )
  select
    (select coalesce(sum(pb.amount), 0)::bigint from per_bill pb),
    (select count(*)::int from per_bill pb),
    (select coalesce(jsonb_agg(jsonb_build_object('category', g.category, 'subtotal', g.subtotal, 'n', g.n)
                               order by g.category), '[]'::jsonb)
       from (select pb.category, sum(pb.amount)::bigint as subtotal, count(*)::int as n
               from per_bill pb group by pb.category) g),
    (select coalesce(jsonb_agg(jsonb_build_object(
              'id', pb.id, 'vendor_name', pb.vendor_name, 'bill_no', pb.bill_no, 'bill_date', pb.bill_date,
              'category', pb.category, 'subtotal', pb.subtotal, 'service_from', pb.sf, 'service_to', pb.st,
              'basis', pb.basis, 'amount', pb.amount)
            order by pb.sf, pb.bill_date, pb.id), '[]'::jsonb)
       from per_bill pb);
end;
$function$;

revoke all on function public.report_pnl_cogs_matched(date, date) from public, anon;
grant execute on function public.report_pnl_cogs_matched(date, date) to authenticated, service_role;
