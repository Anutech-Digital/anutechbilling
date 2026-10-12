-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.gateway_rows_add(text,integer,integer,integer)')) and exists(select 1 from pg_policy where polrelid = to_regclass('public.rate_limit_buckets') and polname = 'zzz_service_role_all')
-- deploy-key: r1005gateway
-- 20261012024706_r1005_gateway_row_budget.sql (card slot 20261011144000 was already passed on manager-pardeep; timestamp chosen right before first push)
--
-- R-1005 (P1 SECURITY, launch blocker, data-leak audit item e, 12 Oct 2026): the browser data
-- gateway (/api/sb/rest/v1) had no per-user limits, so a low role could page through every
-- table its RLS lets it read. The TS side (src/server/postgrest/gateway-limits.ts) now gives
-- low roles (sales, sales_senior, support, delivery, partner_agent) a rate limit, paging caps,
-- no select=* on customers/contacts/payments, and a DAILY ROW BUDGET (~20k rows per IST day).
--
-- This migration is the shared store for that row budget, so the count is one number across
-- every Cloud Run instance (with RATE_LIMIT_STORE=postgres, same opt-in as rate_limit_hit).
-- Without it the TS falls back to per-instance memory — nothing breaks if this has not run.
--
--   public.gateway_rows_add(p_key, p_rows, p_limit, p_window_ms)
--     adds p_rows to the key's count in its fixed window (p_rows = 0 just reads it) and returns
--     (allowed = used < p_limit, used, retry_after_sec). Reuses public.rate_limit_buckets
--     (UNLOGGED counter table, RLS on, zzz_service_role_all policy from 20261009150000); keys
--     are SHA-256 hex from TS, so they never collide with rate_limit_hit's keys in practice.
--   service_role ONLY — a browser that could call it could fill someone else's budget.
--
-- No table, no data change, no grant widened. Re-runnable.

begin;

create or replace function public.gateway_rows_add(p_key text, p_rows integer, p_limit integer, p_window_ms integer)
returns table(allowed boolean, used integer, retry_after_sec integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_now   timestamptz := clock_timestamp();
  v_used  integer;
  v_reset timestamptz;
begin
  if auth.uid() is not null or v_role in ('authenticated', 'anon') then
    raise exception 'gateway_rows_add is service_role only';
  end if;
  if p_key is null or length(p_key) = 0 or length(p_key) > 128 then
    raise exception 'gateway_rows_add: key must be 1..128 chars (TS sends sha256 hex)';
  end if;
  if p_rows is null or p_rows < 0 or p_rows > 100000 then
    raise exception 'gateway_rows_add: rows must be 0..100000';
  end if;
  if p_limit is null or p_limit < 1 or p_window_ms is null or p_window_ms < 1000 or p_window_ms > 86400000 then
    raise exception 'gateway_rows_add: limit >= 1 and window 1s..24h';
  end if;

  insert into public.rate_limit_buckets as b (key, hits, reset_at)
  values (p_key, p_rows, v_now + make_interval(secs => p_window_ms / 1000.0))
  on conflict (key) do update
    set hits     = case when b.reset_at <= v_now then excluded.hits
                        else least(b.hits::bigint + excluded.hits, 2000000000)::integer end,
        reset_at = case when b.reset_at <= v_now then excluded.reset_at else b.reset_at end
  returning b.hits, b.reset_at into v_used, v_reset;

  if random() < 0.01 then
    delete from public.rate_limit_buckets where reset_at < v_now - interval '1 hour';
  end if;

  return query select
    v_used < p_limit,
    v_used,
    case when v_used < p_limit then 0
         else greatest(1, ceil(extract(epoch from (v_reset - v_now)))::integer) end;
end;
$$;

comment on function public.gateway_rows_add(text, integer, integer, integer) is
  'R-1005: daily row budget for low roles on /api/sb (fixed window). service_role only. Test: supabase/tests/gateway_row_budget.test.sql';

revoke all on function public.gateway_rows_add(text, integer, integer, integer) from public;
revoke all on function public.gateway_rows_add(text, integer, integer, integer) from anon;
revoke all on function public.gateway_rows_add(text, integer, integer, integer) from authenticated;
grant execute on function public.gateway_rows_add(text, integer, integer, integer) to service_role;

-- Already created by 20261009150000; repeated (idempotent) so this file stands alone.
drop policy if exists zzz_service_role_all on public.rate_limit_buckets;
create policy zzz_service_role_all on public.rate_limit_buckets
  as permissive for all to service_role using (true) with check (true);

commit;
