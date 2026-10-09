-- deploy-key: leadcountspage
-- deploy-peek: position('page_unassigned' in pg_get_functiondef('public.lead_counts(jsonb)'::regprocedure)) > 0
-- 20261009190500_lead_counts_page_pool
--
-- R-489 (R-457 leftover — Abhishek's audit, 8 Oct 2026):
--   The note under the team toggle on /leads said "Plus 2 unassigned, which everyone can
--   see." — and one of the two was a WON lead (Sharma) that /leads does not show at all
--   (R-057: won lives on /deals). pool.unassigned counted every lead in the tenant, junk
--   and stages the page hides included.
--
--   lead_counts().pool now also returns page_total and page_unassigned: the same pool cut
--   to the stages THIS page shows (filters.page_stages) and without junk — the rows a
--   reader of this page can actually find. The note reads these; total / unassigned are
--   unchanged for every other reader.
--
-- EVERYTHING ELSE in lead_counts is 20261007190000's body verbatim.
--
-- HOW TO VERIFY (separate run):
--   select public.lead_counts('{"page_stages":["new","contact","quote","demo","trial","lost"]}'::jsonb)->'pool';
--   -- page_unassigned = unowned, non-junk leads in those stages only.

create or replace function public.lead_counts(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
declare
  v_f         jsonb   := coalesce(p_filters, '{}'::jsonb);
  v_view      text    := coalesce(nullif(v_f->>'smart_view', ''), 'everything');
  v_folder    text    := coalesce(nullif(v_f->>'folder', ''), 'all');
  v_today     date    := (now() at time zone 'Asia/Kolkata')::date;
  v_month_end date;
  v_month_at  timestamptz;
  v_search    text;
  v_stages    text[];
  v_page_stages text[];
  v_prios     text[];
  v_owner_ids uuid[];
  v_owner_id  uuid    := nullif(v_f->>'owner_id', '')::uuid;
  v_owners    text[];
  v_sources   text[];
  v_me        uuid    := auth.uid();
  v_out       jsonb;
begin
  if v_view not in ('everything', 'all', 'mine', 'waiting', 'today', 'overdue', 'hot', 'new',
                    'won-mtd', 'closing', 'stalled', 'duplicates', 'junk') then
    raise exception 'lead_counts: unknown smart_view %', v_view using errcode = '22023';
  end if;
  if v_folder not in ('all', 'inbox', 'talks', 'quoted', 'proving', 'won', 'lost', 'hot', 'followup') then
    raise exception 'lead_counts: unknown folder %', v_folder using errcode = '22023';
  end if;

  v_month_end := (date_trunc('month', v_today) + interval '1 month - 1 day')::date;
  v_month_at  := date_trunc('month', v_today)::timestamp at time zone 'Asia/Kolkata';

  if btrim(coalesce(v_f->>'search', '')) <> '' then
    v_search := v_f->>'search';
  end if;
  if jsonb_typeof(v_f->'stages') = 'array' and jsonb_array_length(v_f->'stages') > 0 then
    select array_agg(x) into v_stages from jsonb_array_elements_text(v_f->'stages') x;
  end if;
  if jsonb_typeof(v_f->'page_stages') = 'array' and jsonb_array_length(v_f->'page_stages') > 0 then
    select array_agg(x) into v_page_stages from jsonb_array_elements_text(v_f->'page_stages') x;
  end if;
  if jsonb_typeof(v_f->'priorities') = 'array' and jsonb_array_length(v_f->'priorities') > 0 then
    select array_agg(x) into v_prios from jsonb_array_elements_text(v_f->'priorities') x;
  end if;
  if jsonb_typeof(v_f->'owner_ids') = 'array' then
    select coalesce(array_agg(x::uuid), '{}') into v_owner_ids from jsonb_array_elements_text(v_f->'owner_ids') x;
  end if;
  if jsonb_typeof(v_f->'owners') = 'array' and jsonb_array_length(v_f->'owners') > 0 then
    select array_agg(x) into v_owners from jsonb_array_elements_text(v_f->'owners') x;
  end if;
  if jsonb_typeof(v_f->'sources') = 'array' and jsonb_array_length(v_f->'sources') > 0 then
    select array_agg(x) into v_sources from jsonb_array_elements_text(v_f->'sources') x;
  end if;

  with pool as (
    select l.id, l.company, l.contact_name, l.contact_email, l.contact_phone, l.plan, l.value,
           l.stage::text as stage, l.priority, l.owner_id, l.is_junk, l.created_at,
           l.follow_up_date, l.expected_close_date, l.stage_changed_at, l.enquiry_type,
           l.requires_human_attention, l.source
      from public.leads l
     where l.tenant_id = public.current_tenant_id()
  ), ws as (
    select p.*,
           public.lead_looks_like_junk(p.company, p.contact_name, p.contact_email, p.contact_phone) as suspect
      from pool p
     where (v_owner_ids is null or p.owner_id is null or p.owner_id = any (v_owner_ids))
       and (v_owner_id is null or p.owner_id = v_owner_id)
  ), dup_ids as (
    /* computeDuplicates(workspaceLeads): every workspace lead whose phone key or company key
       another workspace lead shares. One index-only pass per key over leads_dup_*_idx
       (≈13 ms each at 20,000 leads), counted with a window rather than joined back — the
       join was planned as "recompute the key for every lead" (≈330 ms). */
    select s.id
      from (select g.id, public.lead_norm_phone(g.contact_phone) as k,
                   count(*) over (partition by public.lead_norm_phone(g.contact_phone)) as n
              from public.leads g
             where g.tenant_id = public.current_tenant_id()
               and (v_owner_ids is null or g.owner_id is null or g.owner_id = any (v_owner_ids))
               and (v_owner_id is null or g.owner_id = v_owner_id)) s
     where s.n > 1 and s.k <> ''
    union
    select s.id
      from (select g.id, public.lead_norm_company(g.company) as k,
                   count(*) over (partition by public.lead_norm_company(g.company)) as n
              from public.leads g
             where g.tenant_id = public.current_tenant_id()
               and (v_owner_ids is null or g.owner_id is null or g.owner_id = any (v_owner_ids))
               and (v_owner_id is null or g.owner_id = v_owner_id)) s
     where s.n > 1 and s.k <> ''
  ), flagged as (
    select w.*,
           (w.id in (select id from dup_ids)) as dup,
           (w.stage not in ('won', 'lost') and not w.is_junk) as open
      from ws w
  ), searched as (
    select f.*
      from flagged f
     where (case when v_view = 'junk' then (f.is_junk or f.suspect) else not f.is_junk end)
       and (v_search is null
            or public.lead_search_hit(v_search, f.company, f.contact_name, f.contact_email, f.contact_phone, f.plan,
                                      f.source, (select u.full_name from public.users u where u.id = f.owner_id)))
       and (v_stages is null or f.stage = any (v_stages))
       and (v_prios is null or f.priority = any (v_prios))
       and (v_owners is null
            or (f.owner_id is null and '__unassigned' = any (v_owners))
            or f.owner_id::text = any (v_owners))
       -- Source (R-392)
       and (v_sources is null or public.lead_source_key(f.source) = any (v_sources))
       and (v_view in ('everything', 'all', 'junk')
            or (v_view = 'mine'     and f.owner_id = v_me)
            or (v_view = 'waiting'  and f.requires_human_attention and f.stage not in ('won', 'lost'))
            or (v_view = 'today'    and (f.created_at at time zone 'Asia/Kolkata')::date = v_today)
            or (v_view = 'overdue'  and f.follow_up_date < v_today and f.stage not in ('won', 'lost'))
            or (v_view = 'hot'      and (f.priority = 'high' or f.stage in ('demo', 'trial', 'quote')))
            or (v_view = 'new'      and f.stage = 'new')
            or (v_view = 'won-mtd'  and f.stage = 'won' and coalesce(f.stage_changed_at, f.created_at) >= v_month_at)
            or (v_view = 'closing'  and f.expected_close_date <= v_month_end and f.stage not in ('won', 'lost'))
            or (v_view = 'stalled'  and f.stage not in ('won', 'lost')
                and f.stage_changed_at is not null and f.stage_changed_at <= now() - interval '7 days')
            or (v_view = 'duplicates' and f.dup))
  ), listed as (
    select s.*
      from searched s
     where v_view = 'junk'
        or (v_folder = 'all' and v_view = 'everything')
        or (v_folder = 'all'      and s.open)
        or (v_folder = 'inbox'    and not s.is_junk and s.stage = 'new')
        or (v_folder = 'talks'    and not s.is_junk and s.stage = 'contact')
        or (v_folder = 'quoted'   and not s.is_junk and s.stage = 'quote')
        or (v_folder = 'proving'  and not s.is_junk and s.stage in ('demo', 'trial'))
        or (v_folder = 'won'      and s.stage = 'won')
        or (v_folder = 'lost'     and s.stage = 'lost')
        or (v_folder = 'hot'      and s.open and (s.priority = 'high' or coalesce(s.value, 0) >= 100000))
        or (v_folder = 'followup' and s.open and s.follow_up_date <= v_today)
  )
  select jsonb_build_object(
    'today', v_today,
    'pool', (
      select jsonb_build_object(
        'total',         count(*),
        'unassigned',    count(*) filter (where p.owner_id is null),
        /* R-489: only the rows THIS page can show — its stages, no junk. */
        'page_total',      count(*) filter (where not coalesce(p.is_junk, false)
                                              and (v_page_stages is null or p.stage = any (v_page_stages))),
        'page_unassigned', count(*) filter (where p.owner_id is null and not coalesce(p.is_junk, false)
                                              and (v_page_stages is null or p.stage = any (v_page_stages))),
        'high_priority', count(*) filter (where p.priority = 'high'),
        'by_owner',      coalesce((select jsonb_object_agg(o.owner_id, o.n)
                                     from (select owner_id, count(*) as n from pool
                                            where owner_id is not null group by owner_id) o), '{}'::jsonb),
        'by_source',     coalesce((select jsonb_object_agg(o.k, o.n)
                                     from (select public.lead_source_key(source) as k, count(*) as n from pool
                                            where public.lead_source_key(source) <> '' group by 1) o), '{}'::jsonb))
        from pool p),
    'workspace', (
      select jsonb_build_object(
        'junk',       count(*) filter (where w.is_junk),
        'everything', count(*) filter (where not w.is_junk),
        'suspects',   count(*) filter (where not w.is_junk and w.suspect))
        from ws w),
    'views', (
      select jsonb_build_object(
        'all',        count(*),
        'mine',       count(*) filter (where v_me is not null and f.owner_id = v_me),
        'waiting',    count(*) filter (where f.requires_human_attention),
        'today',      count(*) filter (where (f.created_at at time zone 'Asia/Kolkata')::date = v_today),
        'overdue',    count(*) filter (where f.follow_up_date < v_today),
        'hot',        count(*) filter (where f.priority = 'high' or f.stage in ('demo', 'trial', 'quote')),
        'new',        count(*) filter (where f.stage = 'new'),
        'stalled',    count(*) filter (where f.stage_changed_at is not null and f.stage_changed_at <= now() - interval '7 days'),
        'closing',    count(*) filter (where f.expected_close_date <= v_month_end),
        'duplicates', count(*) filter (where f.dup))
        from flagged f where f.open and (v_page_stages is null or f.stage = any (v_page_stages))),
    'folders', (
      select jsonb_build_object(
        'inbox',    count(*) filter (where not s.is_junk and s.stage = 'new'),
        'talks',    count(*) filter (where not s.is_junk and s.stage = 'contact'),
        'quoted',   count(*) filter (where not s.is_junk and s.stage = 'quote'),
        'proving',  count(*) filter (where not s.is_junk and s.stage in ('demo', 'trial')),
        'won',      count(*) filter (where s.stage = 'won'),
        'lost',     count(*) filter (where s.stage = 'lost'),
        'hot',      count(*) filter (where s.open and (s.priority = 'high' or coalesce(s.value, 0) >= 100000)),
        'followup', count(*) filter (where s.open and s.follow_up_date <= v_today))
        from searched s),
    'list', (
      select jsonb_build_object(
        'matching', count(*),
        'hot',      count(*) filter (where t.stage in ('quote', 'trial')),
        'hot_top',  (select jsonb_build_object(
                              'id', h.id, 'company', h.company, 'contact_name', h.contact_name,
                              'contact_email', h.contact_email, 'contact_phone', h.contact_phone,
                              'plan', h.plan, 'value', h.value, 'stage', h.stage)
                       from listed h
                      where h.stage in ('quote', 'trial')
                      order by coalesce(h.value, 0) desc, h.created_at desc, h.id desc
                      limit 1))
        from listed t),
    'kpi', (
      select jsonb_build_object(
        'open_count',         count(*) filter (where w.stage not in ('won', 'lost')),
        'open_value',         coalesce(sum(coalesce(w.value, 0)) filter (where w.stage not in ('won', 'lost')), 0),
        'open_value_project', coalesce(sum(coalesce(w.value, 0)) filter (where w.stage not in ('won', 'lost')
                                                                        and w.enquiry_type = 'project'), 0),
        'won',                count(*) filter (where w.stage = 'won'),
        'lost',               count(*) filter (where w.stage = 'lost'))
        from ws w where not w.is_junk),
    'stage_totals', (
      select coalesce(jsonb_object_agg(t.stage, jsonb_build_object(
               'count', t.n, 'value', t.total, 'weighted', t.weighted)), '{}'::jsonb)
        from (select s.stage,
                     count(*) as n,
                     coalesce(sum(greatest(coalesce(s.value, 0), 0)), 0) as total,
                     /* forecast.ts#STAGE_PROBABILITY — lead-counts-sql-copy.test.ts holds the
                        two tables equal. round() per deal, as weightedValue does. */
                     coalesce(sum(case when coalesce(s.value, 0) > 0 then
                       round(s.value::numeric * (case s.stage
                         when 'new' then 10 when 'contact' then 20 when 'demo' then 40
                         when 'trial' then 60 when 'quote' then 80 when 'won' then 100
                         else 0 end) / 100) else 0 end), 0)::bigint as weighted
                from searched s
               group by s.stage) t)
  ) into v_out;

  return v_out;
end
$fn$;

comment on function public.lead_counts(jsonb) is
  'S40+R-070+R-221+R-392: every count on the Sales & Pipeline screen (pool, workspace, views, folders, list, kpi, stage_totals) for the given filters. RLS applies (security invoker).';

revoke all on function public.lead_counts(jsonb) from public;
revoke all on function public.lead_counts(jsonb) from anon;
grant execute on function public.lead_counts(jsonb) to authenticated;
