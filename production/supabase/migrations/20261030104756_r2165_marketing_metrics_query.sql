-- deploy-peek: to_regprocedure('public.marketing_metrics_query(text[],text[],date,date,text,text,text,boolean,integer)') is not null and exists(select 1 from pg_proc where proname = 'marketing_metrics_query' and prosrc like '%R-2165%')
-- deploy-key: r2165marketingmetricsquery
-- 20261030104756_r2165_marketing_metrics_query.sql
--
-- R-2165 (30 Oct 2026, goal G-ADS-AI, card AI-09): the ONE door through which Neo (the
-- marketing analytics chat) reads numbers. Neo never writes SQL: it turns a question into a
-- typed plan (metrics, dimensions, date range, filters) and the app calls this function with
-- that plan. Only the names listed below are accepted; nothing the user types is ever
-- spliced into SQL (no dynamic SQL in this function at all).
--
-- ─── WHAT IT ANSWERS ────────────────────────────────────────────────────────
--   metrics    spend, clicks, impressions, ctr, cpc, cpm   (ad platforms + booked campaign costs)
--              leads                                       (leads created in the range)
--              paid_orders, revenue, roas, cac             (money actually received — R-1980)
--   dimensions day | week | month (at most one), campaign, platform, ad  — at most two
--   filters    campaign (utm code or campaign name), platform (google-ads / meta-ads / linkedin-ads)
--   range      [p_from, p_to) — p_to is exclusive, at most 366 days
--
-- The numbers follow "Sales by campaign" (Marketing → Reports, lib/marketing/campaign-sales.ts)
-- rule for rule, so Neo and the report never disagree (one fact, one place):
--   * spend = ad platform spend (ad_spend_daily, matched to a campaign by utm code, platform
--     campaign id or campaign name) + costs booked against the campaign (expenses.campaign_id),
--     except a booked ad-platform invoice when the platform's own rows exist for that campaign;
--   * revenue = payments received in the range minus payments refunded in the range, WITHOUT
--     GST (the invoice's taxable share, else the quote's GST rate, else 18%);
--     payment → quote (own, the invoice's, or a monthly-flex invoice's subscription) → ad
--     fields (the quote's own utm set when it names a source or campaign, else the lead's);
--   * paid_orders = orders (one lead / quote / invoice) whose net money in the group is > 0;
--   * roas = money the CAMPAIGNS brought ÷ spend (orders with no campaign never inflate it,
--     same as the report's "Ads total"); cac = spend ÷ paid orders the campaigns brought.
--   Days are the UTC calendar date of the timestamp, as the report's slice(0, 10) reads it.
--   Spend data is per campaign per day: there is no ad-level spend, so the "ad" dimension
--   only goes with leads / paid_orders / revenue, and "platform" only with the spend metrics.
--
-- ─── WHO / SAFETY ───────────────────────────────────────────────────────────
--   * SECURITY INVOKER + STABLE: it runs as the caller, so every table's RLS applies, and it
--     cannot write. Every read ALSO filters tenant_id = current_tenant_id() explicitly.
--   * Only the owner and the marketing team (same roles as the marketing agent, R-2157).
--     A deactivated login, an MFA login without the second step, a personal workspace and
--     anon all hold no such role and are refused (42501).
--   * Payments are visible (RLS payments_select) only to owner / manager / accountant /
--     billing. For a marketing login the money metrics come back NULL with
--     revenue_visible = false, so Neo says "your role cannot see payments" instead of
--     showing a false ₹0. (Whether marketing should see revenue totals is an owner decision,
--     recorded on the card — not changed here.)
--
-- Returns jsonb { metrics, dimensions, from, to, revenue_visible, rows: [...], total: {...},
-- row_count, truncated }. No tables, no data changed.
-- Test: supabase/tests/r2165_marketing_metrics_query.test.sql

begin;

create or replace function public.marketing_metrics_query(
  p_metrics    text[],
  p_dimensions text[]  default '{}',
  p_from       date    default null,
  p_to         date    default null,
  p_campaign   text    default null,
  p_platform   text    default null,
  p_sort       text    default null,
  p_sort_desc  boolean default true,
  p_limit      integer default 50
) returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $fn$
/* R-2165: Neo's allowlisted, read-only metrics query. See the migration header. */
declare
  c_metrics    constant text[] := array['spend','clicks','impressions','ctr','cpc','cpm','leads','paid_orders','revenue','roas','cac'];
  c_spend_only constant text[] := array['spend','clicks','impressions','ctr','cpc','cpm'];
  c_by_ad      constant text[] := array['leads','paid_orders','revenue'];
  c_money      constant text[] := array['paid_orders','revenue','roas','cac'];
  c_dims       constant text[] := array['day','week','month','campaign','platform','ad'];
  c_platforms  constant text[] := array['google-ads','meta-ads','linkedin-ads'];
  v_tenant     uuid := public.current_tenant_id();
  v_dims       text[] := coalesce(p_dimensions, '{}');
  v_time       text;
  v_by_camp    boolean;
  v_by_plat    boolean;
  v_by_ad      boolean;
  v_campaign   text := nullif(lower(btrim(coalesce(p_campaign, ''))), '');
  v_platform   text := nullif(lower(btrim(coalesce(p_platform, ''))), '');
  v_limit      integer := coalesce(p_limit, 50);
  v_rev        boolean;
  v_m          text;
  v_out        jsonb;
begin
  -- ── who ───────────────────────────────────────────────────────────────────
  if v_tenant is null or not public.current_user_has_role('owner', 'marketing') then
    raise exception 'marketing_metrics_query: only the owner and the marketing team can ask about marketing numbers'
      using errcode = '42501';
  end if;

  -- ── the plan, checked against the allowlists ──────────────────────────────
  if p_metrics is null or cardinality(p_metrics) = 0 or cardinality(p_metrics) > 6 then
    raise exception 'marketing_metrics_query: ask for 1 to 6 metrics' using errcode = '22023';
  end if;
  foreach v_m in array p_metrics loop
    if v_m is null or not (v_m = any (c_metrics)) then
      raise exception 'marketing_metrics_query: unknown metric "%"', left(coalesce(v_m, 'null'), 40) using errcode = '22023';
    end if;
  end loop;
  if cardinality(p_metrics) <> (select count(distinct x) from unnest(p_metrics) x) then
    raise exception 'marketing_metrics_query: a metric is listed twice' using errcode = '22023';
  end if;
  if cardinality(v_dims) > 2 then
    raise exception 'marketing_metrics_query: at most 2 dimensions' using errcode = '22023';
  end if;
  foreach v_m in array v_dims loop
    if v_m is null or not (v_m = any (c_dims)) then
      raise exception 'marketing_metrics_query: unknown dimension "%"', left(coalesce(v_m, 'null'), 40) using errcode = '22023';
    end if;
  end loop;
  if cardinality(v_dims) <> (select count(distinct x) from unnest(v_dims) x) then
    raise exception 'marketing_metrics_query: a dimension is listed twice' using errcode = '22023';
  end if;
  if (select count(*) from unnest(v_dims) x where x in ('day','week','month')) > 1 then
    raise exception 'marketing_metrics_query: use only one of day, week, month' using errcode = '22023';
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > 366 then
    raise exception 'marketing_metrics_query: the date range must be 1 to 366 days (to is exclusive)' using errcode = '22023';
  end if;
  if v_platform is not null and not (v_platform = any (c_platforms)) then
    raise exception 'marketing_metrics_query: unknown platform "%"', left(v_platform, 40) using errcode = '22023';
  end if;
  if (v_platform is not null or 'platform' = any (v_dims)) and not (p_metrics <@ c_spend_only) then
    raise exception 'marketing_metrics_query: platform goes only with spend, clicks, impressions, ctr, cpc, cpm' using errcode = '22023';
  end if;
  if 'ad' = any (v_dims) and not (p_metrics <@ c_by_ad) then
    raise exception 'marketing_metrics_query: ad goes only with leads, paid_orders, revenue (spend is per campaign)' using errcode = '22023';
  end if;
  if p_sort is not null and not (p_sort = any (p_metrics)) then
    raise exception 'marketing_metrics_query: sort by one of the metrics asked for' using errcode = '22023';
  end if;
  if v_limit < 1 or v_limit > 200 then
    raise exception 'marketing_metrics_query: limit must be 1 to 200' using errcode = '22023';
  end if;

  v_time    := (select x from unnest(v_dims) x where x in ('day','week','month') limit 1);
  v_by_camp := 'campaign' = any (v_dims);
  v_by_plat := 'platform' = any (v_dims);
  v_by_ad   := 'ad' = any (v_dims);
  -- Mirrors RLS payments_select: who may see money at all.
  v_rev     := public.current_user_has_role('owner', 'manager', 'accountant', 'billing');

  with
  camp as (
    select c.id, lower(btrim(c.code)) as k, c.name
      from public.marketing_campaigns c
     where c.tenant_id = v_tenant
  ),
  -- ── ad platform spend ────────────────────────────────────────────────────
  sp as (
    select d.day, a.platform, d.campaign_name, d.campaign_id,
           coalesce(d.spend, 0)::numeric as spend, coalesce(d.clicks, 0)::bigint as clicks,
           coalesce(d.impressions, 0)::bigint as impressions,
           coalesce(
             (select c.id from camp c where c.k = lower(btrim(d.campaign_name)) limit 1),
             (select c.id from camp c where c.k = lower(btrim(d.campaign_id)) limit 1),
             (select c.id from camp c where lower(btrim(c.name)) = lower(btrim(d.campaign_name)) limit 1)
           ) as def_id
      from public.ad_spend_daily d
      join public.ad_accounts a on a.id = d.ad_account_id and a.tenant_id = v_tenant
     where d.tenant_id = v_tenant and d.day >= p_from and d.day < p_to
  ),
  sp_k as (
    select s.day, s.platform,
           coalesce(c.k, nullif(lower(btrim(s.campaign_name)), ''), lower(btrim(s.campaign_id))) as k,
           coalesce(c.name, s.campaign_name) as nm,
           s.spend, s.clicks, s.impressions
      from sp s left join camp c on c.id = s.def_id
  ),
  has_platform as (select distinct k from sp_k),
  -- ── costs booked against a campaign ──────────────────────────────────────
  ex as (
    select e.expense_date as day, c.k, c.name as nm, coalesce(e.amount, 0)::numeric as amount,
           lower(btrim(coalesce(e.channel, ''))) in ('google-ads','meta-ads','linkedin-ads') as platform_bill
      from public.expenses e
      join camp c on c.id = e.campaign_id
     where e.tenant_id = v_tenant and e.campaign_id is not null
       and e.expense_date >= p_from and e.expense_date < p_to
  ),
  -- ── leads created in the range ───────────────────────────────────────────
  ld as (
    select (l.created_at at time zone 'UTC')::date as day,
           coalesce(nullif(lower(btrim(l.utm_campaign)), ''), '__none__') as k,
           nullif(btrim(l.utm_campaign), '') as raw_name,
           nullif(btrim(l.utm_content), '') as ad
      from public.leads l
     where l.tenant_id = v_tenant
       and (l.created_at at time zone 'UTC')::date >= p_from and (l.created_at at time zone 'UTC')::date < p_to
  ),
  -- ── money: payments received / refunded in the range ─────────────────────
  pay as (
    select p.id, p.amount, p.invoice_id, p.received_at, p.refunded_at, p.status,
           i.id as i_id, i.amount as i_amount, i.taxable_value as i_taxable,
           coalesce(p.quote_id, i.quote_id,
             (select s.quote_id from public.subscription_billings b
                join public.subscriptions s on s.id = b.subscription_id and s.tenant_id = v_tenant
               where b.invoice_id = p.invoice_id and b.tenant_id = v_tenant
               limit 1)) as qid,
           (p.received_at at time zone 'UTC')::date as got_day,
           (p.refunded_at at time zone 'UTC')::date as back_day
      from public.payments p
      left join public.invoices i on i.id = p.invoice_id and i.tenant_id = v_tenant
     where p.tenant_id = v_tenant
       and ( ((p.received_at at time zone 'UTC')::date >= p_from and (p.received_at at time zone 'UTC')::date < p_to)
          or (p.status = 'refunded' and (p.refunded_at at time zone 'UTC')::date >= p_from
                                    and (p.refunded_at at time zone 'UTC')::date < p_to) )
  ),
  pay_r as (
    select x.*,
           (x.q_id is not null and (nullif(btrim(x.q_src), '') is not null or nullif(btrim(x.q_camp), '') is not null)) as q_own
      from (
        select pa.*, q.id as q_id, q.tax_rate, q.utm_source as q_src, q.utm_campaign as q_camp,
               q.utm_content as q_content, l.id as l_id, l.utm_campaign as l_camp, l.utm_content as l_content,
               coalesce(case when pa.i_id is not null then pa.i_amount end, i2.amount) as inv_amount,
               case when pa.i_id is not null then pa.i_taxable else i2.taxable_value end as inv_taxable,
               (pa.i_id is not null or i2.id is not null) as has_inv
          from pay pa
          left join public.quotes q on q.id = pa.qid and q.tenant_id = v_tenant
          left join public.leads l on l.id = q.lead_id and l.tenant_id = v_tenant
          left join public.invoices i2 on pa.i_id is null and i2.id = q.invoice_id and i2.tenant_id = v_tenant
      ) x
  ),
  pay_f as (
    select r.*,
           case when r.has_inv and coalesce(r.inv_amount, 0) > 0 and r.inv_taxable is not null
                then round(r.amount::numeric * r.inv_taxable / r.inv_amount)
                else round(r.amount::numeric * 100 / (100 + greatest(0, coalesce(r.tax_rate, 18))))
           end as ex_gst,
           nullif(btrim(case when r.q_own then r.q_camp else r.l_camp end), '') as camp_raw,
           nullif(btrim(case when r.q_own then r.q_content else coalesce(r.q_content, r.l_content) end), '') as ad,
           case when r.l_id is not null then 'lead:' || r.l_id
                when r.q_id is not null then 'quote:' || r.q_id
                else 'invoice:' || coalesce(r.invoice_id, r.id::text) end as order_key
      from pay_r r
  ),
  -- ── one row per fact ─────────────────────────────────────────────────────
  facts as (
    select s.day, s.platform, s.k, s.nm, null::text as ad,
           s.spend, s.clicks, s.impressions, 0::bigint as leads,
           0::numeric as received, 0::numeric as refunded, null::text as order_key, 0::numeric as net
      from sp_k s
    union all
    select e.day, null, e.k, e.nm, null, e.amount, 0, 0, 0, 0, 0, null, 0
      from ex e
     where not e.platform_bill or not exists (select 1 from has_platform h where h.k = e.k)
    union all
    select l.day, null, l.k,
           case when l.k = '__none__' then 'Not from an ad campaign'
                else coalesce((select c.name from camp c where c.k = l.k limit 1), l.raw_name) end,
           l.ad, 0, 0, 0, 1, 0, 0, null, 0
      from ld l
    union all
    select f.got_day, null, coalesce(lower(f.camp_raw), '__none__'),
           case when f.camp_raw is null then 'Not from an ad campaign'
                else coalesce((select c.name from camp c where c.k = lower(f.camp_raw) limit 1), f.camp_raw) end,
           f.ad, 0, 0, 0, 0, f.ex_gst, 0, f.order_key, f.ex_gst
      from pay_f f
     where f.got_day >= p_from and f.got_day < p_to
    union all
    select f.back_day, null, coalesce(lower(f.camp_raw), '__none__'),
           case when f.camp_raw is null then 'Not from an ad campaign'
                else coalesce((select c.name from camp c where c.k = lower(f.camp_raw) limit 1), f.camp_raw) end,
           f.ad, 0, 0, 0, 0, 0, f.ex_gst, f.order_key, -f.ex_gst
      from pay_f f
     where f.status = 'refunded' and f.back_day >= p_from and f.back_day < p_to
  ),
  kept as (
    select f.* from facts f
     where (v_campaign is null or f.k = v_campaign or lower(btrim(f.nm)) = v_campaign
            or f.k in (select c.k from camp c where lower(btrim(c.name)) = v_campaign))
       and (v_platform is null or f.platform = v_platform)
       -- by ad: only lead / money facts; by platform: only spend facts (see header)
       and (not v_by_ad or f.spend = 0 and f.clicks = 0 and f.impressions = 0 and (f.leads > 0 or f.order_key is not null))
       and (not v_by_plat or (f.leads = 0 and f.order_key is null))
  ),
  -- every fact twice: once in its group, once in the grand total
  g as (
    select t.is_total,
           case when t.is_total or v_time is null then null
                when v_time = 'day'  then f.day
                when v_time = 'week' then date_trunc('week', f.day)::date
                else date_trunc('month', f.day)::date end as tkey,
           case when not t.is_total and v_by_camp then f.k end as ck,
           case when not t.is_total and v_by_plat then f.platform end as pk,
           case when not t.is_total and v_by_ad then f.ad end as ak,
           f.*
      from kept f cross join (values (false), (true)) t(is_total)
  ),
  o as (
    select is_total, tkey, ck, pk, ak, k, order_key, sum(net) as net
      from g where order_key is not null
     group by is_total, tkey, ck, pk, ak, k, order_key
  ),
  oc as (
    select is_total, tkey, ck, pk, ak,
           count(*) filter (where net > 0) as paid,
           count(*) filter (where net > 0 and k <> '__none__') as ad_paid
      from o group by is_total, tkey, ck, pk, ak
  ),
  agg as (
    select g.is_total, g.tkey, g.ck, g.pk, g.ak, min(g.nm) as nm,
           sum(g.spend) as spend, sum(g.clicks) as clicks, sum(g.impressions) as impressions,
           sum(g.leads) as leads, sum(g.received) as received, sum(g.refunded) as refunded,
           sum(g.received - g.refunded) filter (where g.k <> '__none__') as ad_revenue
      from g group by g.is_total, g.tkey, g.ck, g.pk, g.ak
  ),
  m as (
    select a.is_total, a.tkey, a.ck, a.pk, a.ak, a.nm,
           jsonb_build_object(
             'spend',       round(a.spend, 2),
             'clicks',      a.clicks,
             'impressions', a.impressions,
             'ctr',         case when a.impressions > 0 then round(a.clicks * 100.0 / a.impressions, 2) end,
             'cpc',         case when a.clicks > 0 then round(a.spend / a.clicks, 2) end,
             'cpm',         case when a.impressions > 0 then round(a.spend * 1000 / a.impressions, 2) end,
             'leads',       a.leads,
             'paid_orders', case when v_rev then coalesce(oc.paid, 0) end,
             'revenue',     case when v_rev then a.received - a.refunded end,
             'roas',        case when v_rev and a.spend > 0 then round(coalesce(a.ad_revenue, 0) / a.spend, 2) end,
             'cac',         case when v_rev and a.spend > 0 and coalesce(oc.ad_paid, 0) > 0 then round(a.spend / oc.ad_paid) end
           ) as full_m
      from agg a
      left join oc on oc.is_total = a.is_total
                  and oc.tkey is not distinct from a.tkey and oc.ck is not distinct from a.ck
                  and oc.pk is not distinct from a.pk and oc.ak is not distinct from a.ak
  ),
  shaped as (
    select m.is_total, m.tkey, m.ck, m.pk, m.ak, m.full_m,
           (select jsonb_object_agg(x, m.full_m -> x) from unnest(p_metrics) x) as mets
      from m
  ),
  rows_ranked as (
    select s.*, row_number() over (
             order by
               case when p_sort is not null and p_sort_desc then (s.full_m ->> p_sort)::numeric end desc nulls last,
               case when p_sort is not null and not p_sort_desc then (s.full_m ->> p_sort)::numeric end asc nulls last,
               case when p_sort is null and v_time is not null then s.tkey end asc,
               case when p_sort is null and v_time is null then (s.full_m ->> p_metrics[1])::numeric end desc nulls last,
               s.tkey, s.ck, s.pk, s.ak) as rn
      from shaped s
     where not s.is_total
  )
  select jsonb_build_object(
    'metrics',         to_jsonb(p_metrics),
    'dimensions',      to_jsonb(v_dims),
    'from',            p_from,
    'to',              p_to,
    'revenue_visible', v_rev,
    'rows', coalesce((
      select jsonb_agg(
               (case when v_time is not null then jsonb_build_object(v_time, to_char(r.tkey, 'YYYY-MM-DD')) else '{}'::jsonb end)
               || (case when v_by_camp then jsonb_build_object('campaign', r.ck,
                     'campaign_name', (select min(m2.nm) from m m2 where not m2.is_total and m2.ck = r.ck)) else '{}'::jsonb end)
               || (case when v_by_plat then jsonb_build_object('platform', r.pk) else '{}'::jsonb end)
               || (case when v_by_ad then jsonb_build_object('ad', r.ak) else '{}'::jsonb end)
               || r.mets
               order by r.rn)
        from rows_ranked r where r.rn <= v_limit), '[]'::jsonb),
    'total', coalesce((select s.mets from shaped s where s.is_total),
                      (select jsonb_object_agg(x, case when x in ('spend','clicks','impressions','leads') then to_jsonb(0)
                                                       when x in ('paid_orders','revenue') and v_rev then to_jsonb(0)
                                                       else 'null'::jsonb end)
                         from unnest(p_metrics) x)),
    'row_count', (select count(*) from rows_ranked),
    'truncated', (select count(*) from rows_ranked) > v_limit
  ) into v_out;

  return v_out;
end;
$fn$;

comment on function public.marketing_metrics_query(text[], text[], date, date, text, text, text, boolean, integer) is
  'R-2165: Neo''s allowlisted read-only marketing metrics (owner / marketing; RLS + explicit tenant). Never free SQL.';

revoke all on function public.marketing_metrics_query(text[], text[], date, date, text, text, text, boolean, integer) from public, anon;
grant execute on function public.marketing_metrics_query(text[], text[], date, date, text, text, text, boolean, integer) to authenticated, service_role;

commit;
