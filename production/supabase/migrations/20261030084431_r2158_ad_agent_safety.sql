-- deploy-peek: (to_regclass('public.ad_agent_actions') is not null and to_regprocedure('public.ad_agent_action_decide(uuid,text,uuid,text,uuid)') is not null)
-- deploy-key: r2158adagentsafety
--
-- R-2158 (AI-02, goal G-ADS-AI, 30 Oct 2026): the safety layer between the AI ad agent and money.
--
-- Pardeep's decision D3 (30 Oct): the AI RECOMMENDS. Anything that raises spend — publishing a
-- campaign, raising a budget, adding a new creative — waits for the owner. Lowering a budget or
-- pausing may run on its own, but only inside a cap set per company. This migration is the part of
-- that rule the database must hold, because a check in TypeScript alone is one refactor away from
-- being skipped:
--
--   ad_agent_caps     — per company: daily spend cap, max change per day, max active ads. NO default
--                       values and no seed: the numbers are Pardeep's call. With no row, spend-up is
--                       refused and spend-down is held for a person (fail closed).
--   ad_agent_actions  — the ledger. One row per proposal, unique per (company, idempotency key),
--                       key = <campaign>:<action>:v<version>. Asking twice returns the first row
--                       (replayed = true), so a retried publish or a cron that runs twice does nothing new.
--   ad_agent_action_request(…)  — server only. Takes the per-action autonomy mode the app resolved
--                       (lib/ai/autonomy.ts) and decides auto_ok / held / refused under ONE per-company
--                       lock, so two runs cannot both spend the same headroom.
--   ad_agent_action_decide(…)   — the owner approves or rejects a held row. Spend-up needs an approved
--                       marketing budget (R-1792, marketing_budgets) for the same channel and month that
--                       covers the projected month; the hard caps are checked again at approval.
--   ad_agent_action_finish(…)   — server only: the executor marks an auto_ok / approved row done or failed.
--
-- Spend-up hard caps (refused, approval cannot override): daily spend (yesterday's company spend +
-- the added daily budget), max active ads (creatives on publishing/live plans + new ones), and change
-- per day (|delta| of today's auto_ok/approved/done rows + this one, checked when it is asked).
-- Spend-down over the change cap is HELD, never refused: refusing a cut would keep money flowing.
-- A refused key stays refused; the agent asks again with a new version.
--
-- Written for Cloud SQL: auth.uid()/auth.role() (rewritten on staging), explicit grants, no extensions.
-- marketing_budgets lives in prisma/migrations, so it is looked up at run time (no FK) and a missing
-- table means "no budget" — spend-up stays unapproved.

begin;

-- ── Caps ──────────────────────────────────────────────────────────────────────
create table if not exists public.ad_agent_caps (
  tenant_id              uuid primary key references public.tenants(id) on delete cascade,
  daily_spend_cap_inr    numeric(14,2) not null check (daily_spend_cap_inr > 0),
  max_change_per_day_inr numeric(14,2) not null check (max_change_per_day_inr >= 0),
  max_active_ads         integer       not null check (max_active_ads >= 0),
  updated_by             uuid default auth.uid(),
  updated_at             timestamptz not null default now()
);

comment on table public.ad_agent_caps is
  'R-2158: per-company hard caps for the AI ad agent. No row = spend-up refused, spend-down held.';

-- ── Ledger ────────────────────────────────────────────────────────────────────
create table if not exists public.ad_agent_actions (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  plan_id              uuid not null,
  action               text not null check (action in ('publish', 'budget_up', 'budget_down', 'pause', 'new_creative')),
  version              integer not null check (version >= 1),
  idempotency_key      text not null check (char_length(idempotency_key) between 1 and 200),
  platform             text check (platform is null or platform in ('google-ads', 'meta-ads')),
  money_delta_inr      numeric(14,2) not null default 0,
  new_daily_budget_inr numeric(14,2) check (new_daily_budget_inr is null or new_daily_budget_inr >= 0),
  ads_delta            integer not null default 0 check (ads_delta >= 0),
  mode                 text not null check (mode in ('off', 'hold', 'auto')),
  status               text not null check (status in ('auto_ok', 'held', 'approved', 'rejected', 'refused', 'done', 'failed')),
  reason               text not null check (char_length(reason) between 1 and 1000),
  ai_reason            text check (ai_reason is null or char_length(ai_reason) <= 1000),
  budget_id            uuid,
  decided_by           uuid,
  decided_at           timestamptz,
  decision_note        text check (decision_note is null or char_length(decision_note) <= 1000),
  finished_at          timestamptz,
  result_note          text check (result_note is null or char_length(result_note) <= 1000),
  created_at           timestamptz not null default now(),
  constraint ad_agent_actions_key unique (tenant_id, idempotency_key),
  constraint ad_agent_actions_plan_fk foreign key (tenant_id, plan_id)
    references public.ad_plans (tenant_id, id) on delete cascade
);

create index if not exists ad_agent_actions_tenant_day_idx on public.ad_agent_actions (tenant_id, created_at desc);
create index if not exists ad_agent_actions_held_idx on public.ad_agent_actions (tenant_id, status) where status = 'held';

comment on table public.ad_agent_actions is
  'R-2158: every money action the AI ad agent asked for, its autonomy verdict, approval and result. Written only through ad_agent_action_* functions.';

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table public.ad_agent_caps enable row level security;
alter table public.ad_agent_actions enable row level security;

drop policy if exists r2158_caps_read on public.ad_agent_caps;
create policy r2158_caps_read on public.ad_agent_caps for select to authenticated
  using (tenant_id = (select public.current_tenant_id())
         and (select public.current_user_has_role('owner', 'manager', 'marketing')));
drop policy if exists r2158_caps_owner_write on public.ad_agent_caps;
create policy r2158_caps_owner_write on public.ad_agent_caps for all to authenticated
  using (tenant_id = (select public.current_tenant_id()) and (select public.current_user_has_role('owner')))
  with check (tenant_id = (select public.current_tenant_id()) and (select public.current_user_has_role('owner')));

drop policy if exists r2158_actions_read on public.ad_agent_actions;
create policy r2158_actions_read on public.ad_agent_actions for select to authenticated
  using (tenant_id = (select public.current_tenant_id())
         and (select public.current_user_has_role('owner', 'manager', 'marketing')));

-- Cloud SQL has no BYPASSRLS: the server (service_role) needs its own policy (R-450).
drop policy if exists zzz_service_role_all on public.ad_agent_caps;
create policy zzz_service_role_all on public.ad_agent_caps as permissive for all to service_role using (true) with check (true);
drop policy if exists zzz_service_role_all on public.ad_agent_actions;
create policy zzz_service_role_all on public.ad_agent_actions as permissive for all to service_role using (true) with check (true);

revoke all on public.ad_agent_caps from public, anon;
revoke all on public.ad_agent_actions from public, anon, authenticated;
grant select, insert, update, delete on public.ad_agent_caps to authenticated, service_role;
grant select on public.ad_agent_actions to authenticated;
grant select, insert, update, delete on public.ad_agent_actions to service_role;

-- ── Helpers ───────────────────────────────────────────────────────────────────
create or replace function public.r2158_trusted()
returns boolean language sql stable set search_path = public as $$
  select coalesce(auth.role(), '') = 'service_role'
      or (auth.role() is null
          and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime', 'app_jobs'));
$$;
revoke all on function public.r2158_trusted() from public, anon, authenticated;
grant execute on function public.r2158_trusted() to service_role;

/* The hard caps for a spend-up, as the sentence a person reads — or null when it fits.
   p_check_change: the change-per-day cap is checked when the AI ASKS; at approval the owner has
   seen the number, and the caps that still bind are daily spend + ads. */
create or replace function public.r2158_spend_up_problem(
  p_tenant_id uuid, p_action text, p_money_delta numeric, p_new_daily numeric, p_ads_delta integer,
  p_check_change boolean
) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  c          public.ad_agent_caps%rowtype;
  v_today    date := (now() at time zone 'Asia/Kolkata')::date;
  v_added    numeric := case when p_action = 'publish' then coalesce(p_new_daily, greatest(p_money_delta, 0))
                             else greatest(p_money_delta, 0) end;
  v_yday     numeric;
  v_live_ads integer;
  v_changed  numeric;
begin
  select * into c from public.ad_agent_caps where tenant_id = p_tenant_id;
  if not found then
    return 'This company has no ad caps yet (daily spend, change per day, max ads) — the AI cannot raise spend until the owner sets them.';
  end if;

  select coalesce(sum(s.spend), 0) into v_yday
    from public.ad_spend_daily s where s.tenant_id = p_tenant_id and s.day = v_today - 1;
  if v_yday + v_added > c.daily_spend_cap_inr then
    return format('This would take daily spend to ₹%s, above this company''s daily cap of ₹%s.',
                  to_char(v_yday + v_added, 'FM999999990.00'), to_char(c.daily_spend_cap_inr, 'FM999999990.00'));
  end if;

  if coalesce(p_ads_delta, 0) > 0 then
    select count(*) into v_live_ads
      from public.ad_creatives cr
      join public.ad_plans p on p.tenant_id = cr.tenant_id and p.id = cr.plan_id
     where cr.tenant_id = p_tenant_id and p.status in ('publishing', 'live');
    if v_live_ads + p_ads_delta > c.max_active_ads then
      return format('This would make %s live ads, above this company''s limit of %s ads.', v_live_ads + p_ads_delta, c.max_active_ads);
    end if;
  end if;

  if p_check_change then
    select coalesce(sum(abs(a.money_delta_inr)), 0) into v_changed
      from public.ad_agent_actions a
     where a.tenant_id = p_tenant_id and a.status in ('auto_ok', 'approved', 'done')
       and (a.created_at at time zone 'Asia/Kolkata')::date = v_today;
    if v_changed + abs(coalesce(p_money_delta, 0)) > c.max_change_per_day_inr then
      return format('Today''s budget change would reach ₹%s, above this company''s change limit of ₹%s a day.',
                    to_char(v_changed + abs(p_money_delta), 'FM999999990.00'), to_char(c.max_change_per_day_inr, 'FM999999990.00'));
    end if;
  end if;
  return null;
end $$;
revoke all on function public.r2158_spend_up_problem(uuid, text, numeric, numeric, integer, boolean) from public, anon, authenticated;
grant execute on function public.r2158_spend_up_problem(uuid, text, numeric, numeric, integer, boolean) to service_role;

-- ── Request ───────────────────────────────────────────────────────────────────
create or replace function public.ad_agent_action_request(
  p_tenant_id uuid, p_plan_id uuid, p_action text, p_version integer, p_platform text,
  p_money_delta numeric, p_new_daily numeric, p_ads_delta integer, p_mode text, p_reason text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_trusted  boolean := public.r2158_trusted();
  v_caller   uuid := public.current_tenant_id();
  v_key      text;
  v_row      public.ad_agent_actions%rowtype;
  v_spend_up boolean := p_action in ('publish', 'budget_up', 'new_creative');
  v_status   text;
  v_reason   text;
  v_problem  text;
  v_today    date := (now() at time zone 'Asia/Kolkata')::date;
  v_changed  numeric;
  v_cap_chg  numeric;
  v_delta    numeric := coalesce(p_money_delta, 0);
begin
  -- Tenant guard, fail CLOSED (production/CLAUDE.md §17c).
  if v_caller is null and not v_trusted then
    raise exception 'Not signed in to a company.' using errcode = '28000';
  end if;
  if v_caller is not null and v_caller <> p_tenant_id then
    raise exception 'That campaign belongs to another company.' using errcode = '42501';
  end if;

  if p_action is null or p_action not in ('publish', 'budget_up', 'budget_down', 'pause', 'new_creative') then
    raise exception 'Unknown ad action: %', p_action using errcode = '22023';
  end if;
  if p_version is null or p_version < 1 then
    raise exception 'Version must be 1 or more.' using errcode = '22023';
  end if;
  if p_mode is null or p_mode not in ('off', 'hold', 'auto') then
    raise exception 'Unknown autonomy mode: %', p_mode using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'Say why the AI wants this.' using errcode = '22023';
  end if;
  -- Direction: a programming error, refused loudly rather than recorded.
  if (p_action = 'budget_up' and v_delta <= 0)
     or (p_action = 'budget_down' and v_delta >= 0)
     or (p_action = 'pause' and v_delta > 0)
     or (p_action in ('publish', 'new_creative') and (v_delta < 0 or coalesce(p_ads_delta, 0) < 1))
     or (p_action = 'publish' and coalesce(p_new_daily, 0) <= 0) then
    raise exception 'The money change does not match a % action.', p_action using errcode = '22023';
  end if;
  if p_action <> 'new_creative' and p_platform is null then
    raise exception 'Name the platform (google-ads or meta-ads).' using errcode = '22023';
  end if;

  if not exists (select 1 from public.ad_plans p where p.id = p_plan_id and p.tenant_id = p_tenant_id) then
    raise exception 'Campaign not found for this company.' using errcode = '23503';
  end if;

  v_key := p_plan_id::text || ':' || p_action || ':v' || p_version;

  -- One company at a time: two runs must not both spend the same headroom.
  perform pg_advisory_xact_lock(hashtextextended('r2158:' || p_tenant_id::text, 0));

  select * into v_row from public.ad_agent_actions where tenant_id = p_tenant_id and idempotency_key = v_key;
  if found then
    return jsonb_build_object('id', v_row.id, 'status', v_row.status, 'reason', v_row.reason,
                              'key', v_key, 'replayed', true);
  end if;

  if p_mode = 'off' then
    v_status := 'refused';
    v_reason := 'This AI action is switched off for this company (or automation is off).';
  elsif v_spend_up then
    v_problem := public.r2158_spend_up_problem(p_tenant_id, p_action, v_delta, p_new_daily, p_ads_delta, true);
    if v_problem is not null then
      v_status := 'refused'; v_reason := v_problem;
    else
      -- D3: never auto, whatever mode was passed.
      v_status := 'held';
      v_reason := 'Raises spend or publishes — waiting for the owner''s approval.';
    end if;
  else
    select max_change_per_day_inr into v_cap_chg from public.ad_agent_caps where tenant_id = p_tenant_id;
    if not found then
      v_status := 'held';
      v_reason := 'This company has no ad caps yet, so the AI may not change spend on its own — waiting for a person.';
    else
      select coalesce(sum(abs(a.money_delta_inr)), 0) into v_changed
        from public.ad_agent_actions a
       where a.tenant_id = p_tenant_id and a.status in ('auto_ok', 'approved', 'done')
         and (a.created_at at time zone 'Asia/Kolkata')::date = v_today;
      if v_changed + abs(v_delta) > v_cap_chg then
        v_status := 'held';
        v_reason := format('Lowers spend, but today''s change would reach ₹%s, above the ₹%s a day the AI may change alone — waiting for a person.',
                           to_char(v_changed + abs(v_delta), 'FM999999990.00'), to_char(v_cap_chg, 'FM999999990.00'));
      elsif p_mode = 'auto' then
        v_status := 'auto_ok';
        v_reason := 'Lowers spend inside this company''s daily change limit — allowed without a person.';
      else
        v_status := 'held';
        v_reason := 'Set to wait for a person on /automation.';
      end if;
    end if;
  end if;

  insert into public.ad_agent_actions (tenant_id, plan_id, action, version, idempotency_key, platform,
                                       money_delta_inr, new_daily_budget_inr, ads_delta, mode, status, reason, ai_reason)
  values (p_tenant_id, p_plan_id, p_action, p_version, v_key, p_platform,
          v_delta, p_new_daily, coalesce(p_ads_delta, 0), p_mode, v_status, v_reason, left(btrim(p_reason), 1000))
  returning * into v_row;

  return jsonb_build_object('id', v_row.id, 'status', v_row.status, 'reason', v_row.reason,
                            'key', v_key, 'replayed', false);
end $$;
revoke all on function public.ad_agent_action_request(uuid, uuid, text, integer, text, numeric, numeric, integer, text, text) from public, anon, authenticated;
grant execute on function public.ad_agent_action_request(uuid, uuid, text, integer, text, numeric, numeric, integer, text, text) to service_role;

-- ── Decide (owner) ────────────────────────────────────────────────────────────
create or replace function public.ad_agent_action_decide(
  p_action_id uuid, p_decision text, p_budget_id uuid, p_note text, p_decided_by uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_trusted  boolean := public.r2158_trusted();
  v_caller   uuid := public.current_tenant_id();
  v_decider  uuid;
  v_row      public.ad_agent_actions%rowtype;
  v_problem  text;
  v_month    date := date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)::date;
  v_today    date := (now() at time zone 'Asia/Kolkata')::date;
  v_days     integer;
  v_added    numeric;
  v_mtd      numeric;
  v_yday     numeric;
  v_need     numeric;
  v_channel  text;
  v_bmonth   date;
  v_bstatus  text;
  v_bamount  numeric;
begin
  if v_caller is null and not v_trusted then
    raise exception 'Not signed in to a company.' using errcode = '28000';
  end if;
  if p_decision is null or p_decision not in ('approve', 'reject') then
    raise exception 'Decide approve or reject.' using errcode = '22023';
  end if;

  select * into v_row from public.ad_agent_actions where id = p_action_id for update;
  if not found then
    raise exception 'That AI action is not here any more.' using errcode = 'P0002';
  end if;
  if v_caller is not null and v_caller <> v_row.tenant_id then
    raise exception 'That AI action belongs to another company.' using errcode = '42501';
  end if;

  -- A person decides: the signed-in owner, or (from the server) the owner it names.
  v_decider := coalesce(auth.uid(), case when v_trusted then p_decided_by end);
  if v_decider is null or not exists (
    select 1 from public.users u
     where u.id = v_decider and u.tenant_id = v_row.tenant_id and u.role = 'owner' and coalesce(u.is_active, true)
  ) then
    raise exception 'Only the owner can approve or reject what the AI asks for.' using errcode = '42501';
  end if;

  if v_row.status <> 'held' then
    raise exception 'This AI action was already %.', v_row.status using errcode = '22023';
  end if;

  if p_decision = 'approve' and v_row.action in ('publish', 'budget_up', 'new_creative') then
    v_problem := public.r2158_spend_up_problem(v_row.tenant_id, v_row.action, v_row.money_delta_inr,
                                               v_row.new_daily_budget_inr, v_row.ads_delta, false);
    if v_problem is not null then
      raise exception '%', v_problem using errcode = '23514';
    end if;

    v_added := case when v_row.action = 'publish' then coalesce(v_row.new_daily_budget_inr, 0)
                    else greatest(v_row.money_delta_inr, 0) end;
    if v_added > 0 then
      -- R-1792 bridge: an approved marketing budget for this channel and month must cover the month.
      if p_budget_id is null or to_regclass('public.marketing_budgets') is null then
        raise exception 'Pick the approved marketing budget this spend comes from (Marketing → Budget).' using errcode = '23514';
      end if;
      execute 'select channel, month, status, amount_approved from public.marketing_budgets where id = $1 and tenant_id = $2'
        into v_channel, v_bmonth, v_bstatus, v_bamount using p_budget_id, v_row.tenant_id;
      if v_bstatus is distinct from 'approved' then
        raise exception 'That marketing budget is not an approved budget of this company.' using errcode = '23514';
      end if;
      if v_channel is distinct from v_row.platform or v_bmonth <> v_month then
        raise exception 'That marketing budget is for another channel or month — pick this month''s % budget.', v_row.platform using errcode = '23514';
      end if;

      v_days := (v_month + interval '1 month')::date - v_today;   -- today through month end
      select coalesce(sum(s.spend) filter (where s.day >= v_month and s.day < v_today), 0),
             coalesce(sum(s.spend) filter (where s.day = v_today - 1), 0)
        into v_mtd, v_yday
        from public.ad_spend_daily s
        join public.ad_accounts a on a.id = s.ad_account_id
       where s.tenant_id = v_row.tenant_id and a.platform = v_row.platform and s.day >= least(v_month, v_today - 1);
      v_need := v_mtd + (v_yday + v_added) * v_days;
      if v_need > v_bamount then
        raise exception 'At this rate the month needs about ₹%, but that marketing budget has ₹% approved, so too little is left — ask the owner for more budget.',
          to_char(v_need, 'FM999999990'), v_bamount using errcode = '23514';
      end if;
    end if;
  end if;

  update public.ad_agent_actions
     set status = case when p_decision = 'approve' then 'approved' else 'rejected' end,
         budget_id = case when p_decision = 'approve' then p_budget_id end,
         decided_by = v_decider, decided_at = now(),
         decision_note = left(nullif(btrim(coalesce(p_note, '')), ''), 1000)
   where id = v_row.id
  returning * into v_row;

  return jsonb_build_object('id', v_row.id, 'status', v_row.status);
end $$;
revoke all on function public.ad_agent_action_decide(uuid, text, uuid, text, uuid) from public, anon;
grant execute on function public.ad_agent_action_decide(uuid, text, uuid, text, uuid) to authenticated, service_role;

-- ── Finish (server) ───────────────────────────────────────────────────────────
create or replace function public.ad_agent_action_finish(p_action_id uuid, p_ok boolean, p_note text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_row public.ad_agent_actions%rowtype;
begin
  if not public.r2158_trusted() then
    raise exception 'Only the server marks an AI action done.' using errcode = '42501';
  end if;
  select * into v_row from public.ad_agent_actions where id = p_action_id for update;
  if not found then
    raise exception 'That AI action is not here any more.' using errcode = 'P0002';
  end if;
  if v_row.status not in ('auto_ok', 'approved') then
    raise exception 'Only an allowed or approved AI action can be finished (this one is %).', v_row.status using errcode = '22023';
  end if;
  update public.ad_agent_actions
     set status = case when p_ok then 'done' else 'failed' end, finished_at = now(),
         result_note = left(nullif(btrim(coalesce(p_note, '')), ''), 1000)
   where id = v_row.id
  returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'status', v_row.status);
end $$;
revoke all on function public.ad_agent_action_finish(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.ad_agent_action_finish(uuid, boolean, text) to service_role;

commit;
