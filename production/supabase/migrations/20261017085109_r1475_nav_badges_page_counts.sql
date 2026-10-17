-- deploy-peek: position('R-1475' in coalesce(obj_description(to_regprocedure('public.nav_badges(text[])'), 'pg_proc'), '')) > 0
-- deploy-key: r1475navbadges
--
-- R-1475 (Pawan, staging AI Help, 16 Oct 2026): "sidebar shows Deals 4 but the page says
-- 'All deals 7'; Sales & Pipeline shows 3 but the page says 'All leads 4'".
--
-- The two lead badges counted the OPEN stages only, junk included:
--   leads  stage in (new, contact)             → the page opens on "All leads"  = New + Contacted + Lost, no junk
--   deals  stage in (quote, demo, trial)       → the page opens on "All deals"  = Quote … Won + Lost, no junk
-- Now each badge counts what its page's first view counts (R-118: tile == list; R-433 stage
-- split, lib/leads/page-scope.ts LEADS_PAGE_STAGES / deal-rules.ts DEALS_PAGE_STAGES):
--   leads  stage in (new, contact, lost)                and not is_junk
--   deals  stage in (quote, demo, trial, won, lost)     and not is_junk
-- Lost is on both pages (a lead lost before any quote has nowhere else to be), so it is on
-- both badges. src/lib/leads/nav-badge-page-match.test.ts reads THIS file and fails if the
-- stage lists drift from the TS constants.
--
-- Every other count is 20260928130000's body verbatim. Still SECURITY INVOKER (RLS decides,
-- incl. R-1401's leads hierarchy). Idempotent: create or replace.
-- Test: supabase/tests/nav_badges.test.sql (rolled back).

create or replace function public.nav_badges(p_approval_tiers text[] default '{}')
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_me     uuid := auth.uid();
  v_tenant uuid := public.current_tenant_id();
  -- End of today in IST, as an instant (same as the hook's startUTC + 24h).
  v_eod    timestamptz := ((date_trunc('day', now() at time zone 'Asia/Kolkata') + interval '1 day')
                           at time zone 'Asia/Kolkata');
  -- The hook used new Date(Date.now() + 30d).toISOString().split("T")[0] — a UTC date.
  v_renew  date := ((now() at time zone 'UTC') + interval '720 hours')::date;
  v_quotes integer := 0;
begin
  if v_tenant is null then
    raise exception 'nav_badges: no workspace for this session'
      using errcode = 'insufficient_privilege';
  end if;

  if v_me is not null and coalesce(array_length(p_approval_tiers, 1), 0) > 0 then
    select count(*) into v_quotes
      from public.quotes q
     where q.approval_status = 'pending'
       and q.approval_requested_by <> v_me
       and q.approval_tier::text = any (p_approval_tiers);
  end if;

  return jsonb_build_object(
    'leads',     (select count(*) from public.leads l where l.stage in ('new', 'contact', 'lost') and not l.is_junk),
    'enquiries', (select count(*) from public.inbound_emails e where e.status = 'received' and e.lead_id is null),
    'deals',     (select count(*) from public.leads l where l.stage in ('quote', 'demo', 'trial', 'won', 'lost') and not l.is_junk),
    'tasks',     (select count(*) from public.tasks t where t.status = 'pending' and t.due_at < v_eod),
    'renewals',  (select count(*) from public.subscriptions s where s.status = 'active' and s.renewal_date <= v_renew),
    'invoices',  (select count(*) from public.invoices i where i.status in ('pending', 'overdue')),
    'payments',  (select count(*) from public.quotes q where q.payment_status = 'received'),
    'quotes',    v_quotes
  );
end;
$$;

revoke all on function public.nav_badges(text[]) from public;
revoke all on function public.nav_badges(text[]) from anon;
grant execute on function public.nav_badges(text[]) to authenticated;

comment on function public.nav_badges(text[]) is
  'S16 + R-1475: every sidebar badge count in one call. SECURITY INVOKER — RLS decides what is counted. leads / deals equal the "All leads" / "All deals" view of the page they open (page stages, no junk).';
