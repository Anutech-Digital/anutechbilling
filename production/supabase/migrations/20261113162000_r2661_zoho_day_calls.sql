-- deploy-peek: to_regclass('public.zoho_api_day_calls') is not null and to_regprocedure('public.zoho_day_calls_add(uuid,date,integer,boolean,text)') is not null and to_regprocedure('public.zoho_reader_take(uuid,date,text,timestamptz)') is not null
-- deploy-key: r2661zohodaycalls
--
-- R-2661 (13 Nov 2026): Zoho Books allows an organization about 1,000 API calls a DAY. On 10 Nov two
-- Zoho readers (Reconcile from Zoho + the FY purchase read) spent it by 04:24Z; zoho-pace.ts paces the
-- minute only and nothing counted the day — the owner learnt it from 429s, reads stopped half way.
--
-- ══ WHAT THIS ADDS ═══════════════════════════════════════════════════════════════════════════════
--   zoho_api_day_calls   one row per company per IST day: how many Zoho calls the app made, whether
--                        Zoho itself refused for the day (limit_hit_at + its words), and — one reader
--                        at a time — which read holds the Zoho connection until when.
--   zoho_day_calls_add   atomic "add N calls to today" (several app instances / cron + dialog at once
--                        never undercount); answers the new total.
--   zoho_reader_take     take / renew the one-reader lease; answers the holder's name when it is
--                        someone else's and still fresh.
--   zoho_reader_release  let the lease go (only the holder's own).
-- Written ONLY by the server (service_role: api.ts booksGet through store.ts' meter — the tenant is
-- the signed-in caller's own row or the cron's run row, never a browser). A signed-in user reads only
-- their own company's rows (the dialogs' "Zoho calls today: N of 900"). The budget itself (900 by
-- default, ZOHO_DAY_BUDGET) lives in code: zoho-day-budget.ts.
-- Cloud SQL: no extensions schema; auth.*() rewritten by the deploy script. Grants explicit.
-- Test: supabase/tests/r2661_zoho_day_calls.test.sql (rolled back).
-- Rollback: drop the three functions and the table.

begin;

create table if not exists public.zoho_api_day_calls (
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  day           date not null,
  calls         integer not null default 0 check (calls >= 0),
  limit_hit_at  timestamptz,
  last_refusal  text check (last_refusal is null or char_length(last_refusal) <= 300),
  reader        text check (reader is null or char_length(reader) <= 80),
  reader_until  timestamptz,
  updated_at    timestamptz not null default now(),
  primary key (tenant_id, day)
);

comment on table public.zoho_api_day_calls is
  'R-2661: Zoho Books API calls this company made per IST day (Zoho allows ~1,000 a day). limit_hit_at = Zoho itself refused for the day. reader / reader_until = the one Zoho read running now.';

alter table public.zoho_api_day_calls enable row level security;
grant select on table public.zoho_api_day_calls to authenticated;
grant all on table public.zoho_api_day_calls to service_role;
drop policy if exists zoho_api_day_calls_select on public.zoho_api_day_calls;
create policy zoho_api_day_calls_select on public.zoho_api_day_calls as permissive for select to authenticated
  using (tenant_id = ( select public.current_tenant_id() ));
drop policy if exists zzz_service_role_all on public.zoho_api_day_calls;
create policy zzz_service_role_all on public.zoho_api_day_calls as permissive for all to service_role using (true) with check (true);

-- Add p_calls to the company's day (insert the row when it is the day's first); p_limit_hit = Zoho's
-- own "per day" 429 (kept with its words, first time only). Answers the new total — one statement,
-- so two callers at once both add.
create or replace function public.zoho_day_calls_add(p_tenant uuid, p_day date, p_calls integer, p_limit_hit boolean, p_refusal text)
returns table (total integer, hit_at timestamptz)
language sql
set search_path = public
as $$
  insert into public.zoho_api_day_calls as c (tenant_id, day, calls, limit_hit_at, last_refusal, updated_at)
  values (p_tenant, p_day, greatest(0, coalesce(p_calls, 0)), case when coalesce(p_limit_hit, false) then now() end, left(p_refusal, 300), now())
  on conflict (tenant_id, day) do update
    set calls        = c.calls + greatest(0, coalesce(excluded.calls, 0)),
        limit_hit_at = coalesce(c.limit_hit_at, excluded.limit_hit_at),
        last_refusal = coalesce(excluded.last_refusal, c.last_refusal),
        updated_at   = now()
  returning c.calls, c.limit_hit_at;
$$;

-- One Zoho reader at a time per company: take (or renew) the lease until p_until. Null = it is yours
-- now; otherwise the name of the reader that still holds it (its reader_until is in the future).
create or replace function public.zoho_reader_take(p_tenant uuid, p_day date, p_name text, p_until timestamptz)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_holder text;
begin
  if p_tenant is null or p_day is null or coalesce(p_name, '') = '' or p_until is null then
    raise exception 'R-2661: tenant, day, reader name and until are required';
  end if;
  insert into public.zoho_api_day_calls (tenant_id, day) values (p_tenant, p_day) on conflict (tenant_id, day) do nothing;
  update public.zoho_api_day_calls
     set reader = left(p_name, 80), reader_until = p_until, updated_at = now()
   where tenant_id = p_tenant and day = p_day
     and (reader is null or reader_until is null or reader_until < now() or reader = left(p_name, 80));
  if found then return null; end if;
  select reader into v_holder from public.zoho_api_day_calls where tenant_id = p_tenant and day = p_day;
  return v_holder;
end;
$$;

-- Let the lease go — only the holder's own (a reader whose lease was taken over changes nothing).
create or replace function public.zoho_reader_release(p_tenant uuid, p_day date, p_name text)
returns boolean
language sql
set search_path = public
as $$
  with done as (
    update public.zoho_api_day_calls
       set reader = null, reader_until = null, updated_at = now()
     where tenant_id = p_tenant and day = p_day and reader = left(p_name, 80)
    returning 1
  )
  select exists (select 1 from done);
$$;

revoke all on function public.zoho_day_calls_add(uuid, date, integer, boolean, text) from public, anon, authenticated;
revoke all on function public.zoho_reader_take(uuid, date, text, timestamptz) from public, anon, authenticated;
revoke all on function public.zoho_reader_release(uuid, date, text) from public, anon, authenticated;
grant execute on function public.zoho_day_calls_add(uuid, date, integer, boolean, text) to service_role;
grant execute on function public.zoho_reader_take(uuid, date, text, timestamptz) to service_role;
grant execute on function public.zoho_reader_release(uuid, date, text) to service_role;

commit;
