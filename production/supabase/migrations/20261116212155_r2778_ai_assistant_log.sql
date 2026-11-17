-- deploy-peek: to_regclass('public.ai_assistant_log') is not null and to_regprocedure('public.audit_ai_via(uuid,uuid)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.log_row_change()') and prosrc like '%a change the Help AI made for this signed-in person%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.log_activity(text,text,text,text)') and prosrc like '%marked ''ai'' when the Help AI did this%')
-- ============================================================================
-- R-2778 (H-05, G-HELPAI, 16 Nov 2026): every Help AI question and tool run is recorded, and a
-- change the AI makes for a person is marked "AI on behalf of <person>" in the Activity log.
--
-- 1. ai_assistant_log — one row per question (kind 'question', outcome 'started'), per tool run
--    (kind 'tool': tool name, tier, outcome did | held | refused | failed | timeout, row COUNT,
--    ms) and per answer (kind 'answer': outcome, ms, model, tokens). Never a tool's result rows,
--    never a prompt: the question text is cut to 500 characters, a tool's note to 300, row ids to
--    20 (ids only, for what the AI changed).
--      READ   owner + manager of the same company (the same rule as activity_log, R-1002).
--      WRITE  only log_ai_assistant_event(): SECURITY DEFINER, tenant and user come from the
--             login (current_tenant_id(), auth.uid()) — there is no argument for either, so a
--             client cannot write a row for another person or company. No INSERT / UPDATE /
--             DELETE grant or policy exists for request roles. Same shape as log_activity() —
--             the repo's audit pattern. A person's session is the only door because Help AI
--             runs with the person's own login (R-2774); a service-role writer would need a
--             second path that this table does not have.
--             A burst (120 rows in a minute from one person) is dropped, not raised: the log
--             must never fail an answer.
-- 2. activity_log.via / via_conversation_id: 'ai' + the conversation, set by log_row_change()
--    and log_activity() when the request carries header x-actor-via: ai (PostgREST
--    request.headers) or app.actor_via (SQL path, like R-051's app.actor_id) AND
--    x-actor-conversation / app.actor_conversation names a conversation THIS person logged in the
--    last 24 hours (audit_ai_via). The row is still the person's own (user_id unchanged); the
--    marker only says the AI did it for them. A header alone, a conversation that does not exist,
--    another person's conversation, an old one, or a service-role write marks nothing.
--    Header absent = exactly the old behaviour.
-- Bodies of log_row_change() (R-1002) and log_activity() (R-1010) are copied from their latest
-- definitions; only the marker lines are new.
-- Grants explicit (Cloud SQL has no default privileges). Test: supabase/tests/r2778_ai_assistant_log.test.sql.
-- ============================================================================

begin;

-- ── 1. the assistant log ──────────────────────────────────────────────────────────────

create table if not exists public.ai_assistant_log (
  id              bigint generated always as identity primary key,
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  user_id         uuid references public.users(id) on delete set null,
  conversation_id uuid not null,
  kind            text not null check (kind in ('question', 'tool', 'answer')),
  tool            text,
  tier            text check (tier in ('read', 'safe', 'confirm')),
  question        text,
  args_summary    text,
  outcome         text not null check (outcome in ('started', 'did', 'held', 'refused', 'failed', 'timeout')),
  row_ids         text[],
  row_count       integer check (row_count >= 0),
  duration_ms     integer check (duration_ms >= 0),
  model           text,
  tokens_in       integer check (tokens_in >= 0),
  tokens_out      integer check (tokens_out >= 0),
  created_at      timestamptz not null default now()
);

comment on table public.ai_assistant_log is
  'R-2778: Help AI audit — who asked what, which tools ran, outcome, ms, model/tokens. No result rows, no prompts. Written only by log_ai_assistant_event(); read by owner/manager of the company.';

create index if not exists ai_assistant_log_tenant_time on public.ai_assistant_log (tenant_id, created_at desc);
create index if not exists ai_assistant_log_conversation on public.ai_assistant_log (conversation_id);
create index if not exists ai_assistant_log_user_time on public.ai_assistant_log (user_id, created_at desc);

alter table public.ai_assistant_log enable row level security;

drop policy if exists ai_assistant_log_sel_owner_manager on public.ai_assistant_log;
create policy ai_assistant_log_sel_owner_manager on public.ai_assistant_log
  for select to authenticated
  using (tenant_id = (select public.current_tenant_id())
         and (select public.current_user_has_role('owner', 'manager')));

-- Cloud SQL has no BYPASSRLS: service_role needs its own policy (as activity_log).
drop policy if exists zzz_service_role_all on public.ai_assistant_log;
create policy zzz_service_role_all on public.ai_assistant_log
  as permissive for all to service_role using (true) with check (true);

revoke all on public.ai_assistant_log from public, anon, authenticated;
grant select on public.ai_assistant_log to authenticated;
grant all on public.ai_assistant_log to service_role;

create or replace function public.log_ai_assistant_event(
  p_conversation_id uuid, p_kind text, p_tool text, p_tier text, p_text text, p_outcome text,
  p_row_ids text[], p_row_count integer, p_duration_ms integer,
  p_model text, p_tokens_in integer, p_tokens_out integer)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-1615 style: an inactive user / half-signed-in MFA session logs nothing. */
  v_tenant uuid := public.current_tenant_id();
  v_user   uuid := auth.uid();
begin
  if v_tenant is null or v_user is null or p_conversation_id is null then return; end if;
  /* A burst is dropped, not raised: the log must never fail an answer, nor flood the table. */
  if (select count(*) from public.ai_assistant_log l
       where l.user_id = v_user and l.created_at > now() - interval '1 minute') >= 120 then
    return;
  end if;
  insert into public.ai_assistant_log
    (tenant_id, user_id, conversation_id, kind, tool, tier, question, args_summary, outcome,
     row_ids, row_count, duration_ms, model, tokens_in, tokens_out)
  values
    (v_tenant, v_user, p_conversation_id, p_kind, left(p_tool, 64), p_tier,
     case when p_kind = 'question' then left(p_text, 500) end,
     case when p_kind <> 'question' then left(p_text, 300) end,
     p_outcome,
     (select array_agg(left(x, 80)) from (select x from unnest(p_row_ids) as x limit 20) s),
     /* unknown stays null (greatest(null, 0) would store a false 0); a negative is not a count */
     case when p_row_count >= 0 then p_row_count end, case when p_duration_ms >= 0 then p_duration_ms end,
     left(p_model, 80), case when p_tokens_in >= 0 then p_tokens_in end, case when p_tokens_out >= 0 then p_tokens_out end);
end $function$;

comment on function public.log_ai_assistant_event(uuid, text, text, text, text, text, text[], integer, integer, text, integer, integer) is
  'R-2778: the only writer of ai_assistant_log. Tenant and user come from the login, never from an argument.';

revoke all on function public.log_ai_assistant_event(uuid, text, text, text, text, text, text[], integer, integer, text, integer, integer) from public, anon;
grant execute on function public.log_ai_assistant_event(uuid, text, text, text, text, text, text[], integer, integer, text, integer, integer) to authenticated, service_role;

-- ── 2. the marker on activity_log ─────────────────────────────────────────────────────

alter table public.activity_log add column if not exists via text;
alter table public.activity_log add column if not exists via_conversation_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'activity_log_via_check' and conrelid = 'public.activity_log'::regclass) then
    alter table public.activity_log add constraint activity_log_via_check check (via is null or via = 'ai');
  end if;
end $$;
comment on column public.activity_log.via is
  'R-2778: ''ai'' when the Help AI made this change for user_id (the person''s own login). Null = the person did it.';

create or replace function public.audit_ai_via(p_tenant uuid, p_user uuid)
returns uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_via  text := nullif(current_setting('app.actor_via', true), '');
  v_conv text := nullif(current_setting('app.actor_conversation', true), '');
  v_h    jsonb;
  v_raw  text := current_setting('request.headers', true);
begin
  /* Only a real session can be marked (a service-role / cron write has no person to speak for). */
  if p_user is null or p_tenant is null or auth.uid() is distinct from p_user then return null; end if;
  if v_via is null then
    /* Most writes carry no marker: skip parsing the headers (this runs once per audited row). */
    if v_raw is null or position('x-actor-via' in v_raw) = 0 then return null; end if;
    begin
      v_h := nullif(v_raw, '')::jsonb;
    exception when others then
      return null;
    end;
    v_via := v_h ->> 'x-actor-via';
    v_conv := coalesce(v_conv, v_h ->> 'x-actor-conversation');
  end if;
  if v_via is distinct from 'ai' or v_conv is null
     or v_conv !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  /* The conversation must be one THIS person logged in the last day, in this company. */
  if exists (select 1 from public.ai_assistant_log l
              where l.conversation_id = v_conv::uuid and l.user_id = p_user and l.tenant_id = p_tenant
                and l.created_at > now() - interval '1 day') then
    return v_conv::uuid;
  end if;
  return null;
end $function$;

comment on function public.audit_ai_via(uuid, uuid) is
  'R-2778: the Help AI conversation a write belongs to (header x-actor-via: ai + x-actor-conversation, or app.actor_via), only when that conversation is in ai_assistant_log for the same person and company within 24 h. Else null.';

-- Only called from the SECURITY DEFINER audit functions below (they run as the owner).
revoke all on function public.audit_ai_via(uuid, uuid) from public, anon, authenticated;
grant execute on function public.audit_ai_via(uuid, uuid) to service_role;

create or replace function public.log_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_json    jsonb;
  v_old     jsonb;
  v_tenant  uuid;
  v_id      text;
  v_label   text;
  v_changes jsonb;
  v_key     text;
  v_uid     uuid := auth.uid();
  v_as      uuid;
  v_user    uuid;
  v_actor   text;
  v_redacted text[] := '{}';
  v_via_conv uuid;
begin
  if v_uid is null then
    v_as := public.audit_service_actor();     -- R-051: admin-client write for a signed-in user
    if v_as is null then return null; end if; -- cron / webhook / system: not logged (as before)
  end if;
  if tg_op = 'DELETE' then v_json := to_jsonb(old); else v_json := to_jsonb(new); end if;
  v_tenant := nullif(v_json->>'tenant_id', '')::uuid;
  if v_tenant is null then return null; end if;
  v_id := v_json->>'id';
  v_label := coalesce(
    v_json->>'full_name', v_json->>'name', v_json->>'company', v_json->>'company_name',
    v_json->>'invoice_no', v_json->>'quote_no', v_json->>'title', v_json->>'vendor_name',
    v_json->>'category', v_json->>'kind', v_json->>'period', ''
  );

  if tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    v_changes := '{}'::jsonb;
    for v_key in select jsonb_object_keys(v_json) loop
      if v_key in ('updated_at', 'created_at') then continue; end if;
      if v_json->v_key is distinct from v_old->v_key then
        /* R-1002: a secret column (pin_hash, public_token …) is named, never copied. */
        if public.audit_secret_key(v_key) then
          v_redacted := v_redacted || v_key;
          continue;
        end if;
        v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('old', v_old->v_key, 'new', v_json->v_key));
      end if;
    end loop;
    if cardinality(v_redacted) > 0 then
      v_changes := v_changes || jsonb_build_object('_redacted', to_jsonb(v_redacted));
    end if;
    if v_changes = '{}'::jsonb then return null; end if;   -- a touch, not a change
  elsif tg_op = 'DELETE' then
    v_changes := jsonb_build_object('old', public.audit_strip_secrets(v_json));   -- R-1002
  end if;

  if v_uid is not null then
    -- Who is acting: a staff user, or a portal customer (not in public.users).
    select u.id into v_user from public.users u where u.id = v_uid;
    if v_user is null then
      select 'Customer ' || c.name into v_actor
        from public.customer_users cu
        join public.customers c on c.id = cu.customer_id
       where cu.auth_user_id = v_uid
       limit 1;
    end if;
  else
    -- R-051: the service role vouched for v_as. Name them only inside their own tenant.
    select u.id into v_user from public.users u where u.id = v_as and u.tenant_id = v_tenant;
    if v_user is null and exists (select 1 from public.users u where u.id = v_as) then
      v_actor := 'Platform support';
    end if;
  end if;

  /* R-2778: a change the Help AI made for this signed-in person carries the marker (via='ai').
     Only a real session can be marked, and only for a conversation this person logged. */
  if v_uid is not null then
    v_via_conv := public.audit_ai_via(v_tenant, v_uid);
  end if;

  insert into public.activity_log (tenant_id, user_id, actor_label, action, entity, entity_id, label, changes, via, via_conversation_id)
  values (v_tenant, v_user, left(v_actor, 120), lower(tg_op), tg_table_name, v_id, left(v_label, 120), v_changes,
          case when v_via_conv is not null then 'ai' end, v_via_conv);
  return null;
end $$;

-- ── 2b. Every writer: strip on the way in ───────────────────────────────────────────

create or replace function public.activity_log_strip_secrets()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  /* R-1002: whoever writes the row (log_row_change, log_attendance_change, an admin-client
     route, a future function), activity_log.changes never keeps a secret key. */
  new.changes := public.audit_strip_secrets(new.changes);
  return new;
end;
$function$;

create or replace function public.log_activity(
  p_action text, p_entity text default 'session'::text,
  p_entity_id text default null::text, p_label text default null::text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-1615: a deactivated user / half-signed-in MFA session logs nothing. */
  v_tenant uuid := public.current_tenant_id();
  v_via_conv uuid;
begin
  /* R-1010: sign-ins are recorded by the app server only (src/server/auth/login-log.ts). */
  if lower(btrim(coalesce(p_action, ''))) = 'login' then return; end if;
  if v_tenant is null then return; end if;
  /* R-2778: marked 'ai' when the Help AI did this for the signed-in person (see audit_ai_via). */
  v_via_conv := public.audit_ai_via(v_tenant, auth.uid());
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, via, via_conversation_id)
  values (v_tenant, auth.uid(), p_action, coalesce(p_entity, 'session'), p_entity_id, left(p_label, 120),
          case when v_via_conv is not null then 'ai' end, v_via_conv);
end $function$;

commit;
