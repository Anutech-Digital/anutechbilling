-- deploy-key: leadsrc
-- deploy-peek: (exists(select 1 from pg_proc where proname='lead_source_key' and pronamespace='public'::regnamespace) and exists(select 1 from pg_proc where proname='list_leads' and pronamespace='public'::regnamespace and prosrc like '%lead_source_key%') and exists(select 1 from pg_proc where proname='lead_counts' and pronamespace='public'::regnamespace and prosrc like '%by_source%'))
-- 20261007190000_lead_source_filter_search
--
-- WHAT THIS CHANGES (R-392, 7 Oct 2026 — Abhishek's report, Excel Technologies, staging)
--   /leads and /deals: typing a source ("Google Ads") or the assigned person's name in
--   "Search leads & deals" found nothing, and there was no Source filter.
--     1. public.lead_source_key(text): the canonical source key — a saved key or label
--        (any case, trimmed) becomes the key; anything else is returned trimmed.
--        TS twin: lib/leads/lead-sources.ts#canonicalSource.
--     2. public.lead_source_label(text): key -> label (LEAD_SOURCES).
--     3. public.lead_search_hit() gets an 8-argument form: the 6 fields as before, plus the
--        lead's source (key, key with dashes as spaces, label) and the assigned person's
--        name. TS twin: lib/leads/lead-search.ts#leadMatchesSearch. The 6-argument form is
--        left in place (nothing calls it after this file; harmless, and a rollback of the
--        two functions below keeps working).
--     4. list_leads() / lead_counts() take p_filters.sources (canonical keys, any-of) and
--        search with the 8-argument form; the assigned person's name is read from
--        public.users (RLS applies — security invoker, same as useTeamMembers).
--     5. lead_counts().pool.by_source: leads per canonical source — the filter's options.
--
-- EVERYTHING ELSE in list_leads / lead_counts is 20261007000000's body verbatim (incl. the
-- 'mine' view's auth.uid()). src/lib/leads/lead-source-search-sql.test.ts re-derives both
-- bodies from that migration and fails if anything else differs.
--
-- NOT APPLIED by the worker. Apply with the usual migration flow (manager).

create or replace function public.lead_source_key(p_source text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select case
    when lower(btrim(coalesce(p_source, ''))) in ('google-ads', 'google ads') then 'google-ads'
    when lower(btrim(coalesce(p_source, ''))) in ('meta-ads', 'facebook / instagram ads') then 'meta-ads'
    when lower(btrim(coalesce(p_source, ''))) in ('linkedin-ads', 'linkedin ads') then 'linkedin-ads'
    when lower(btrim(coalesce(p_source, ''))) in ('indiamart', 'indiamart') then 'indiamart'
    when lower(btrim(coalesce(p_source, ''))) in ('justdial', 'justdial') then 'justdial'
    when lower(btrim(coalesce(p_source, ''))) in ('google-organic', 'google search / seo') then 'google-organic'
    when lower(btrim(coalesce(p_source, ''))) in ('meta-organic', 'facebook / instagram page (organic)') then 'meta-organic'
    when lower(btrim(coalesce(p_source, ''))) in ('linkedin-organic', 'linkedin (organic)') then 'linkedin-organic'
    when lower(btrim(coalesce(p_source, ''))) in ('youtube-organic', 'youtube') then 'youtube-organic'
    when lower(btrim(coalesce(p_source, ''))) in ('enquiry-form', 'website enquiry form') then 'enquiry-form'
    when lower(btrim(coalesce(p_source, ''))) in ('buy-workspace-v2', 'buy workspace page') then 'buy-workspace-v2'
    when lower(btrim(coalesce(p_source, ''))) in ('whatsapp', 'whatsapp') then 'whatsapp'
    when lower(btrim(coalesce(p_source, ''))) in ('referral', 'referral') then 'referral'
    when lower(btrim(coalesce(p_source, ''))) in ('tele-calling', 'tele calling') then 'tele-calling'
    when lower(btrim(coalesce(p_source, ''))) in ('email-outreach', 'email outreach') then 'email-outreach'
    when lower(btrim(coalesce(p_source, ''))) in ('email-inbound', 'email (inbound)') then 'email-inbound'
    when lower(btrim(coalesce(p_source, ''))) in ('trade-show', 'trade show / event') then 'trade-show'
    when lower(btrim(coalesce(p_source, ''))) in ('walk-in', 'walk-in / office visit') then 'walk-in'
    when lower(btrim(coalesce(p_source, ''))) in ('ai-finder', 'ai lead finder') then 'ai-finder'
    when lower(btrim(coalesce(p_source, ''))) in ('manual', 'added manually') then 'manual'
    when lower(btrim(coalesce(p_source, ''))) in ('csv', 'csv import') then 'csv'
    else btrim(coalesce(p_source, ''))
  end
$fn$;

comment on function public.lead_source_key(text) is
  'R-392: canonical lead source key (key or label, any case -> key). TS twin: lib/leads/lead-sources.ts#canonicalSource.';

revoke all on function public.lead_source_key(text) from public;
revoke all on function public.lead_source_key(text) from anon;
grant execute on function public.lead_source_key(text) to authenticated;

create or replace function public.lead_source_label(p_key text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select case p_key
    when 'google-ads' then 'Google Ads'
    when 'meta-ads' then 'Facebook / Instagram Ads'
    when 'linkedin-ads' then 'LinkedIn Ads'
    when 'indiamart' then 'IndiaMART'
    when 'justdial' then 'JustDial'
    when 'google-organic' then 'Google search / SEO'
    when 'meta-organic' then 'Facebook / Instagram page (organic)'
    when 'linkedin-organic' then 'LinkedIn (organic)'
    when 'youtube-organic' then 'YouTube'
    when 'enquiry-form' then 'Website enquiry form'
    when 'buy-workspace-v2' then 'Buy Workspace page'
    when 'whatsapp' then 'WhatsApp'
    when 'referral' then 'Referral'
    when 'tele-calling' then 'Tele calling'
    when 'email-outreach' then 'Email outreach'
    when 'email-inbound' then 'Email (inbound)'
    when 'trade-show' then 'Trade show / event'
    when 'walk-in' then 'Walk-in / office visit'
    when 'ai-finder' then 'AI Lead Finder'
    when 'manual' then 'Added manually'
    when 'csv' then 'CSV import'
    else null
  end
$fn$;

comment on function public.lead_source_label(text) is
  'R-392: label for a canonical lead source key, null when unknown. TS twin: lib/leads/lead-sources.ts#LEAD_SOURCES.';

revoke all on function public.lead_source_label(text) from public;
revoke all on function public.lead_source_label(text) from anon;
grant execute on function public.lead_source_label(text) to authenticated;

create or replace function public.lead_search_hit(
  p_search text,
  p_company text,
  p_name text,
  p_email text,
  p_phone text,
  p_plan text,
  p_source text,
  p_owner_name text
)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $fn$
declare
  v_q      text := btrim(lower(regexp_replace(coalesce(p_search, ''), '\s+', ' ', 'g')));
  v_raw    text := btrim(coalesce(p_source, ''));
  v_src    text := '';
  v_owner  text := lower(coalesce(p_owner_name, ''));
  v_digits text;
  v_word   text;
begin
  if v_q = '' then
    return true;
  end if;
  -- lead-search.ts#PHONE_LIKE / PHONE_MIN_DIGITS
  if v_q ~ '^[+0-9][0-9 ()+-]*$' then
    v_digits := regexp_replace(v_q, '[^0-9]', '', 'g');
    if length(v_digits) >= 5 then
      if length(v_digits) > 10 and (left(v_digits, 2) = '91' or left(v_digits, 1) = '0') then
        v_digits := right(v_digits, 10);
      end if;
      if strpos(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), v_digits) > 0 then
        return true;
      end if;
    end if;
  end if;
  -- lead-sources.ts#sourceSearchText: raw, raw with dashes as spaces, label.
  if v_raw <> '' then
    v_src := lower(v_raw || ' ' || replace(v_raw, '-', ' ') || ' '
                   || coalesce(public.lead_source_label(public.lead_source_key(v_raw)), ''));
  end if;
  foreach v_word in array string_to_array(v_q, ' ') loop
    if not (strpos(lower(coalesce(p_company, '')), v_word) > 0
         or strpos(lower(coalesce(p_name, '')), v_word) > 0
         or strpos(lower(coalesce(p_email, '')), v_word) > 0
         or strpos(lower(coalesce(p_phone, '')), v_word) > 0
         or strpos(lower(coalesce(p_plan, '')), v_word) > 0
         or strpos(v_src, v_word) > 0
         or strpos(v_owner, v_word) > 0) then
      return false;
    end if;
  end loop;
  return true;
end
$fn$;

comment on function public.lead_search_hit(text, text, text, text, text, text, text, text) is
  'R-221+R-392: does a lead match the Sales & Pipeline search box? Words across fields incl. source and assigned person; phone by digits. TS twin: lib/leads/lead-search.ts.';

revoke all on function public.lead_search_hit(text, text, text, text, text, text, text, text) from public;
revoke all on function public.lead_search_hit(text, text, text, text, text, text, text, text) from anon;
grant execute on function public.lead_search_hit(text, text, text, text, text, text, text, text) to authenticated;

-- ── list_leads (20261007000000's body; search + sources changed) ────────────
create or replace function public.list_leads(
  p_cursor  jsonb   default null,
  p_limit   integer default 50,
  p_filters jsonb   default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
declare
  v_limit     integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_f         jsonb   := coalesce(p_filters, '{}'::jsonb);
  v_sort      text    := coalesce(nullif(v_f->>'sort', ''), 'created');
  v_view      text    := nullif(v_f->>'smart_view', '');
  v_folder    text    := coalesce(nullif(v_f->>'folder', ''), 'all');
  v_today     date    := (now() at time zone 'Asia/Kolkata')::date;
  v_c_at      timestamptz;
  v_c_key     numeric;
  v_c_id      text;
  v_search    text;
  v_stages    text[];
  v_prios     text[];
  v_junk      text    := coalesce(nullif(v_f->>'junk', ''), 'exclude');
  v_owner_ids uuid[];
  v_owner_id  uuid    := nullif(v_f->>'owner_id', '')::uuid;
  v_owners    text[];
  v_sources   text[];
  v_open_only boolean := coalesce((v_f->>'open_only')::boolean, false);
  v_dup_of    text    := nullif(v_f->>'dup_of', '');
  v_like      jsonb   := case when jsonb_typeof(v_f->'dup_like') = 'object' then v_f->'dup_like' end;
  v_of_p      text;
  v_of_c      text;
  v_of_ids    text[];
  v_rows      jsonb;
  v_keys      jsonb;
  v_count     integer;
  v_last      integer;
begin
  if v_sort not in ('created', 'wait') then
    raise exception 'list_leads: sort must be created or wait (got %)', v_sort using errcode = '22023';
  end if;
  if v_view is not null and v_view not in ('everything', 'all', 'mine', 'waiting', 'today', 'overdue', 'hot', 'new',
                                          'won-mtd', 'closing', 'stalled', 'duplicates', 'junk') then
    raise exception 'list_leads: unknown smart_view %', v_view using errcode = '22023';
  end if;
  if v_folder not in ('all', 'inbox', 'talks', 'quoted', 'proving', 'won', 'lost', 'hot', 'followup') then
    raise exception 'list_leads: unknown folder %', v_folder using errcode = '22023';
  end if;

  if p_cursor is not null and jsonb_typeof(p_cursor) <> 'null' then
    v_c_id := nullif(p_cursor->>'id', '');
    if v_sort = 'wait' then
      v_c_key := nullif(p_cursor->>'wait_key', '')::numeric;
      if v_c_key is null or v_c_id is null then
        raise exception 'list_leads: the cursor needs both wait_key and id — pass back next_cursor exactly as it was returned, or null for the first page'
          using errcode = '22023';
      end if;
    else
      v_c_at := nullif(p_cursor->>'created_at', '')::timestamptz;
      if v_c_at is null or v_c_id is null then
        raise exception 'list_leads: the cursor needs both created_at and id — pass back next_cursor exactly as it was returned, or null for the first page'
          using errcode = '22023';
      end if;
    end if;
  end if;

  if v_junk not in ('exclude', 'only', 'any') then
    raise exception 'list_leads: junk must be exclude, only or any (got %)', v_junk using errcode = '22023';
  end if;
  /* A smart view decides the junk cut, as searchLeads step 0 does. */
  if v_view is not null then
    v_junk := case when v_view = 'junk' then 'view' else 'exclude' end;
  end if;

  if btrim(coalesce(v_f->>'search', '')) <> '' then
    v_search  := v_f->>'search';
  end if;

  if jsonb_typeof(v_f->'stages') = 'array' and jsonb_array_length(v_f->'stages') > 0 then
    select array_agg(x) into v_stages from jsonb_array_elements_text(v_f->'stages') x;
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

  /* dup_of — the other leads that make THIS one a duplicate (the page's matchesOf), for the
     merge dialog: same workspace, same keys, not the lead itself.

     Why the keys are read through "offset 0" and never compared in a WHERE on the leads
     scan: leads has RLS, and Postgres will not evaluate a non-LEAKPROOF function (these
     key functions) ahead of the policy quals — so "key = x" can never be an index
     condition, and a filter on it recomputes the key for every lead (2.9 s for one page at
     20,000 leads, measured). Selecting the key as a COLUMN lets the planner read it from
     leads_dup_*_idx with an index-only scan instead (≈13 ms). LEAKPROOF itself needs a
     superuser, which a migration on hosted Supabase is not.

     dup_like — the same match for a lead that does not exist yet: the Add-lead form's "this
     company / phone is already a lead" warning. { company, contact_phone, exclude_id } —
     exclude_id is the lead being edited, which must not warn about itself. */
  if v_dup_of is not null then
    select public.lead_norm_phone(me.contact_phone), public.lead_norm_company(me.company)
      into v_of_p, v_of_c
      from public.leads me
     where me.id = v_dup_of and me.tenant_id = public.current_tenant_id();
  elsif v_like is not null then
    v_of_p   := public.lead_norm_phone(v_like->>'contact_phone');
    v_of_c   := public.lead_norm_company(v_like->>'company');
    v_dup_of := coalesce(nullif(v_like->>'exclude_id', ''), '');
  end if;
  if v_dup_of is not null then
    select coalesce(array_agg(distinct x.id), '{}') into v_of_ids from (
      select k.id
        from (select g.id, public.lead_norm_phone(g.contact_phone) as key
                from public.leads g
               where g.tenant_id = public.current_tenant_id()
                 and (v_owner_ids is null or g.owner_id is null or g.owner_id = any (v_owner_ids))
                 and (v_owner_id is null or g.owner_id = v_owner_id)
              offset 0) k
       where coalesce(v_of_p, '') <> '' and k.key = v_of_p and k.id <> v_dup_of
      union
      select k.id
        from (select g.id, public.lead_norm_company(g.company) as key
                from public.leads g
               where g.tenant_id = public.current_tenant_id()
                 and (v_owner_ids is null or g.owner_id is null or g.owner_id = any (v_owner_ids))
                 and (v_owner_id is null or g.owner_id = v_owner_id)
              offset 0) k
       where coalesce(v_of_c, '') <> '' and k.key = v_of_c and k.id <> v_dup_of
    ) x;
  end if;

  with dup as materialized (
    /* computeDuplicates(workspaceLeads) — every workspace lead (team cut only, junk
       included) whose phone key or company key ANOTHER workspace lead shares. Keys come
       from leads_dup_*_idx through index-only scans, counted with a window (see dup_of
       above for why it is never a WHERE). Read lazily: only the 'duplicates' view and the
       page's own rows ask for it. */
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
  ), cand as (
    select l.id, l.company, l.contact_name, l.contact_email, l.contact_phone,
           l.plan, l.seats, l.value, l.stage, l.priority, l.owner_id, l.source,
           l.is_junk, l.created_at, l.updated_at, l.follow_up_date, l.expected_close_date,
           l.stage_changed_at, l.enquiry_type, l.project_id, l.customer_id,
           l.requires_human_attention, l.pipeline, l.subscription_type, l.lost_reason,
           l.domain, l.human_attention_reason,
           /* waitPriority as one stable number: still waiting → 1e12 − arrival epoch (older
              = bigger, and it does not drift with the clock, so a cursor stays valid);
              answered → seconds to first reply (≥ 0). Every waiting key is above every
              answered one, which is waitPriority's "waiting beats any answered lead". */
           case when v_sort = 'wait' then
             case when fr.at is null
                  then 1000000000000::numeric - extract(epoch from l.created_at)
                  else greatest(0::numeric, extract(epoch from fr.at) - extract(epoch from l.created_at))
             end
           end as wait_key
      from public.leads l
      /* lib/queries/lead-first-reply.ts: the first OUTBOUND touch (waiting.ts#OUTBOUND_KINDS),
         per lead through lead_activities_lead_idx. A grouped CTE joined back was planned as
         a nested loop — 22 s for one page at 20,000 leads; this is one index probe per lead.
         Skipped outright for the 'created' order. */
      left join lateral (
        select min(a.created_at) as at
          from public.lead_activities a
         where v_sort = 'wait'
           and a.lead_id = l.id
           and a.tenant_id = public.current_tenant_id()
           and a.kind in ('email', 'email_out', 'call', 'whatsapp', 'quote')
      ) fr on true
     where l.tenant_id = public.current_tenant_id()
       -- S37 keys
       and (v_junk in ('any', 'view') or (v_junk = 'only') = l.is_junk)
       and (v_junk <> 'view' or l.is_junk
            or public.lead_looks_like_junk(l.company, l.contact_name, l.contact_email, l.contact_phone))
       and (v_search is null
            or public.lead_search_hit(v_search, l.company, l.contact_name, l.contact_email, l.contact_phone, l.plan,
                                      l.source, (select u.full_name from public.users u where u.id = l.owner_id)))
       and (v_stages is null or l.stage::text = any (v_stages))
       and (v_prios is null or l.priority = any (v_prios))
       and (v_owner_ids is null or l.owner_id is null or l.owner_id = any (v_owner_ids))
       and (v_owner_id is null or l.owner_id = v_owner_id)
       and (not v_open_only or (l.stage not in ('won', 'lost') and not l.is_junk))
       -- Kiska (searchLeads 3b)
       and (v_owners is null
            or (l.owner_id is null and '__unassigned' = any (v_owners))
            or l.owner_id::text = any (v_owners))
       -- Source (R-392)
       and (v_sources is null or public.lead_source_key(l.source) = any (v_sources))
       -- smart view (searchLeads 4)
       and (v_view is null or v_view in ('everything', 'all', 'junk')
            or (v_view = 'mine'     and l.owner_id = auth.uid())
            or (v_view = 'waiting'  and l.requires_human_attention and l.stage not in ('won', 'lost'))
            or (v_view = 'today'    and (l.created_at at time zone 'Asia/Kolkata')::date = v_today)
            or (v_view = 'overdue'  and l.follow_up_date < v_today and l.stage not in ('won', 'lost'))
            or (v_view = 'hot'      and (l.priority = 'high' or l.stage in ('demo', 'trial', 'quote')))
            or (v_view = 'new'      and l.stage = 'new')
            or (v_view = 'won-mtd'  and l.stage = 'won'
                and coalesce(l.stage_changed_at, l.created_at) >= (date_trunc('month', v_today)::timestamp at time zone 'Asia/Kolkata'))
            or (v_view = 'closing'  and l.expected_close_date <= (date_trunc('month', v_today) + interval '1 month - 1 day')::date
                and l.stage not in ('won', 'lost'))
            or (v_view = 'stalled'  and l.stage not in ('won', 'lost')
                and l.stage_changed_at is not null and l.stage_changed_at <= now() - interval '7 days')
            or (v_view = 'duplicates' and l.id in (select d.id from dup d)))
       and (v_dup_of is null or l.id = any (v_of_ids))
       -- folder cut (listCut + inSalesFolder), only alongside a smart view
       and (v_view is null or v_view = 'junk'
            or (v_folder = 'all' and v_view = 'everything')
            or (v_folder = 'all'      and l.stage not in ('won', 'lost') and not l.is_junk)
            or (v_folder = 'inbox'    and not l.is_junk and l.stage = 'new')
            or (v_folder = 'talks'    and not l.is_junk and l.stage = 'contact')
            or (v_folder = 'quoted'   and not l.is_junk and l.stage = 'quote')
            or (v_folder = 'proving'  and not l.is_junk and l.stage in ('demo', 'trial'))
            or (v_folder = 'won'      and l.stage = 'won')
            or (v_folder = 'lost'     and l.stage = 'lost')
            or (v_folder = 'hot'      and not l.is_junk and l.stage not in ('won', 'lost')
                and (l.priority = 'high' or coalesce(l.value, 0) >= 100000))
            or (v_folder = 'followup' and not l.is_junk and l.stage not in ('won', 'lost')
                and l.follow_up_date <= v_today))
  ), page as (
    select c.*
      from cand c
     where v_c_id is null
        or (v_sort = 'wait'    and (c.wait_key, c.id) < (v_c_key, v_c_id))
        or (v_sort = 'created' and (c.created_at, c.id) < (v_c_at, v_c_id))
     order by case when v_sort = 'wait' then c.wait_key end desc,
              case when v_sort = 'created' then c.created_at end desc,
              c.id desc
     limit v_limit + 1
  ), numbered as (
    select p.*,
           /* The row's "Duplicate?" flag — only for the ≤ 51 rows of this page. */
           (p.id in (select d.id from dup d)) as is_duplicate,
           row_number() over (
             order by case when v_sort = 'wait' then p.wait_key end desc,
                      case when v_sort = 'created' then p.created_at end desc,
                      p.id desc) as rn
      from page p
  )
  select coalesce(jsonb_agg(to_jsonb(n) - 'rn' - 'wait_key' order by n.rn) filter (where n.rn <= v_limit), '[]'::jsonb),
         coalesce(jsonb_agg(jsonb_build_object('wait_key', n.wait_key::text, 'id', n.id, 'created_at', n.created_at)
                            order by n.rn) filter (where n.rn <= v_limit), '[]'::jsonb),
         count(*)::integer
    into v_rows, v_keys, v_count
    from numbered n;

  if v_count > v_limit then
    v_last := v_limit - 1;
    return jsonb_build_object(
      'rows', v_rows,
      'next_cursor', case when v_sort = 'wait'
                          then jsonb_build_object('wait_key', v_keys->v_last->'wait_key', 'id', v_keys->v_last->'id')
                          else jsonb_build_object('created_at', v_rows->v_last->'created_at', 'id', v_rows->v_last->'id')
                     end);
  end if;
  return jsonb_build_object('rows', v_rows, 'next_cursor', null);
end
$fn$;

comment on function public.list_leads(jsonb, integer, jsonb) is
  'S37+S40+R-070+R-221+R-392: one keyset page of leads, slim columns, RLS applies (security invoker). Filters incl. owners / smart_view / folder; sort created|wait. Returns {rows, next_cursor}.';

revoke all on function public.list_leads(jsonb, integer, jsonb) from public;
revoke all on function public.list_leads(jsonb, integer, jsonb) from anon;
grant execute on function public.list_leads(jsonb, integer, jsonb) to authenticated;

-- ── lead_counts (20261007000000's body; search + sources + by_source) ──────
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
