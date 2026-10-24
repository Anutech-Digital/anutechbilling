-- deploy-peek: to_regprocedure('public.ai_usage_reserve(uuid,text,boolean)') is not null and to_regprocedure('public.ai_usage_add_tokens(uuid,text,bigint,bigint)') is not null and to_regprocedure('public.ai_usage_summary(uuid)') is not null
-- deploy-key: r1877aiusagecap
-- 20261024220000_r1877_ai_usage_cap.sql
--
-- R-1877 (24 Oct 2026, epic R-1874 — Pardeep: "Claude, one server key + per-company monthly cap"):
-- every company shares the server's AI key (ANTHROPIC_API_KEY / GEMINI_API_KEY), and nothing
-- counted or limited what one company spends. The campaign co-pilot will make many calls.
--
-- ─── WHAT THIS ADDS ─────────────────────────────────────────────────────────
--   ai_usage_monthly   — one row per company × IST month × feature (the geminiJson `label`):
--                        calls, input_tokens, output_tokens. Read-only for the company (RLS).
--   tenant_ai_limits   — a company's own monthly call cap. NO row = the default in
--                        ai_monthly_call_cap() (the ONE place the default lives). Companies can
--                        read it but never write it: the cap protects Anutech's AI bill, so only
--                        the platform (service role / SQL) changes it.
--   ai_monthly_call_cap(tenant)        — the cap that applies.
--   ai_usage_reserve(tenant, feature, enforce) — called by the server BEFORE every AI call
--                        (lib/ai/usage-cap.ts, from geminiJson). Atomic per company (advisory
--                        lock): used >= cap and enforce → {allowed:false}, nothing counted; else
--                        +1 call. enforce=false (the company's own Gemini key) counts, never refuses.
--   ai_usage_add_tokens(tenant, feature, in, out) — after the call, the tokens the provider reported.
--   ai_usage_summary(tenant)           — {month, used, cap, input_tokens, output_tokens} for
--                        Settings → Integrations → AI.
--
-- Month = the calendar month in India time (Asia/Kolkata): 1 Nov 00:00 IST starts a new count.
--
-- Guards: §17c fail-closed. reserve / add_tokens are SERVER-ONLY (service role) — a signed-in user
-- can neither use up nor reset a counter. summary: owner / manager / billing of that company
-- (the roles that see Settings → Integrations, same as /api/integrations/gemini GET).
-- Stored data is not changed. Test: supabase/tests/r1877_ai_usage_cap.test.sql

begin;

create table if not exists public.ai_usage_monthly (
  tenant_id     uuid        not null references public.tenants(id) on delete cascade,
  month         date        not null check (extract(day from month) = 1),
  feature       text        not null check (length(feature) between 1 and 80),
  calls         integer     not null default 0 check (calls >= 0),
  input_tokens  bigint      not null default 0 check (input_tokens >= 0),
  output_tokens bigint      not null default 0 check (output_tokens >= 0),
  updated_at    timestamptz not null default now(),
  primary key (tenant_id, month, feature)
);

comment on table public.ai_usage_monthly is
  'R-1877: AI calls + tokens per company per IST month per feature. Written only by ai_usage_reserve / ai_usage_add_tokens (server).';

create table if not exists public.tenant_ai_limits (
  tenant_id        uuid        primary key references public.tenants(id) on delete cascade,
  monthly_call_cap integer     not null check (monthly_call_cap >= 0),
  note             text,
  updated_at       timestamptz not null default now()
);

comment on table public.tenant_ai_limits is
  'R-1877: per-company AI monthly call cap. No row = ai_monthly_call_cap() default. Platform-only writes.';

alter table public.ai_usage_monthly enable row level security;
alter table public.tenant_ai_limits enable row level security;

drop policy if exists ai_usage_monthly_select on public.ai_usage_monthly;
create policy ai_usage_monthly_select on public.ai_usage_monthly
  for select to authenticated using (tenant_id = public.current_tenant_id());

drop policy if exists tenant_ai_limits_select on public.tenant_ai_limits;
create policy tenant_ai_limits_select on public.tenant_ai_limits
  for select to authenticated using (tenant_id = public.current_tenant_id());

revoke all on public.ai_usage_monthly from public, anon, authenticated;
revoke all on public.tenant_ai_limits from public, anon, authenticated;
grant select on public.ai_usage_monthly to authenticated;
grant select on public.tenant_ai_limits to authenticated;
grant all on public.ai_usage_monthly to service_role;
grant all on public.tenant_ai_limits to service_role;

-- ── The cap that applies — the ONE place the default lives ──────────────────
-- 1000 calls / company / month: Pardeep confirms (card R-1877 step). Change it here, or per
-- company with a tenant_ai_limits row.
create or replace function public.ai_monthly_call_cap(p_tenant_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select monthly_call_cap from public.tenant_ai_limits where tenant_id = p_tenant_id), 1000);
$$;

revoke all on function public.ai_monthly_call_cap(uuid) from public, anon;
grant execute on function public.ai_monthly_call_cap(uuid) to authenticated, service_role;

-- ── Before every AI call (server only) ───────────────────────────────────────
create or replace function public.ai_usage_reserve(p_tenant_id uuid, p_feature text, p_enforce boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted boolean;
  v_caller  uuid;
  v_month   date := (date_trunc('month', now() at time zone 'Asia/Kolkata'))::date;
  v_feature text := left(coalesce(nullif(btrim(p_feature), ''), 'unlabelled'), 80);
  v_used    integer;
  v_cap     integer;
begin
  /* §17c fail-closed, then server-only: a login must not use up or reset a counter. */
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted then
    raise exception 'AI usage is counted by the server only' using errcode = '42501';
  end if;
  if p_tenant_id is null then
    raise exception 'ai_usage_reserve: company is required' using errcode = '22004';
  end if;

  -- One company's calls are counted one at a time, so two calls racing at used = cap - 1
  -- cannot both get through.
  perform pg_advisory_xact_lock(hashtextextended('ai_usage:' || p_tenant_id::text, 0));

  select coalesce(sum(calls), 0)::integer into v_used
    from public.ai_usage_monthly where tenant_id = p_tenant_id and month = v_month;
  v_cap := public.ai_monthly_call_cap(p_tenant_id);

  if coalesce(p_enforce, true) and v_used >= v_cap then
    return jsonb_build_object('allowed', false, 'used', v_used, 'cap', v_cap, 'month', v_month);
  end if;

  insert into public.ai_usage_monthly as u (tenant_id, month, feature, calls)
  values (p_tenant_id, v_month, v_feature, 1)
  on conflict (tenant_id, month, feature)
  do update set calls = u.calls + 1, updated_at = now();

  return jsonb_build_object('allowed', true, 'used', v_used + 1, 'cap', v_cap, 'month', v_month);
end;
$$;

revoke all on function public.ai_usage_reserve(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.ai_usage_reserve(uuid, text, boolean) to service_role;

-- ── After the call: the tokens the provider reported (server only) ──────────
create or replace function public.ai_usage_add_tokens(p_tenant_id uuid, p_feature text, p_input bigint, p_output bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted boolean;
  v_caller  uuid;
  v_month   date := (date_trunc('month', now() at time zone 'Asia/Kolkata'))::date;
  v_feature text := left(coalesce(nullif(btrim(p_feature), ''), 'unlabelled'), 80);
begin
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted then
    raise exception 'AI usage is counted by the server only' using errcode = '42501';
  end if;
  if p_tenant_id is null then
    raise exception 'ai_usage_add_tokens: company is required' using errcode = '22004';
  end if;

  insert into public.ai_usage_monthly as u (tenant_id, month, feature, input_tokens, output_tokens)
  values (p_tenant_id, v_month, v_feature, greatest(coalesce(p_input, 0), 0), greatest(coalesce(p_output, 0), 0))
  on conflict (tenant_id, month, feature)
  do update set input_tokens  = u.input_tokens  + excluded.input_tokens,
                output_tokens = u.output_tokens + excluded.output_tokens,
                updated_at    = now();
end;
$$;

revoke all on function public.ai_usage_add_tokens(uuid, text, bigint, bigint) from public, anon, authenticated;
grant execute on function public.ai_usage_add_tokens(uuid, text, bigint, bigint) to service_role;

-- ── This month, for Settings → Integrations → AI ─────────────────────────────
create or replace function public.ai_usage_summary(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_trusted boolean;
  v_caller  uuid;
  v_month   date := (date_trunc('month', now() at time zone 'Asia/Kolkata'))::date;
  v_row     record;
begin
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and v_caller is distinct from p_tenant_id then
    raise exception 'That is another company''s AI usage' using errcode = '42501';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'billing') then
    raise exception 'Only an owner, manager or billing user can see AI usage' using errcode = '42501';
  end if;

  select coalesce(sum(calls), 0)::integer        as used,
         coalesce(sum(input_tokens), 0)::bigint  as input_tokens,
         coalesce(sum(output_tokens), 0)::bigint as output_tokens
    into v_row
    from public.ai_usage_monthly where tenant_id = p_tenant_id and month = v_month;

  return jsonb_build_object(
    'month',         v_month,
    'used',          v_row.used,
    'cap',           public.ai_monthly_call_cap(p_tenant_id),
    'input_tokens',  v_row.input_tokens,
    'output_tokens', v_row.output_tokens
  );
end;
$$;

revoke all on function public.ai_usage_summary(uuid) from public, anon;
grant execute on function public.ai_usage_summary(uuid) to authenticated, service_role;

commit;
