-- deploy-peek: exists(select 1 from pg_proc where proname='audit_service_actor' and pronamespace='public'::regnamespace)
-- deploy-key: auditactor
-- ============================================================================
-- R-051 part 3 (7 Oct 2026): the audit log names the real user when a signed-in user's
-- API route writes with the SERVICE ROLE (admin client).
--
-- BUG: log_row_change() starts with `if auth.uid() is null then return null`. A route that
-- proves the caller in TypeScript (withRoute / mayDo) and then writes with
-- createAdminClient() reaches Postgres with a service_role JWT and NO `sub` — so the seat
-- decision, the subscription extension, the campaign send … left NO activity_log row at all,
-- and record_contract_amendment() filed the seat/price change as source 'system'.
--
-- FIX: the route tells Postgres who it is acting for, and Postgres believes it ONLY from the
-- service role.
--   * src/lib/supabase/server.ts createAdminClientFor(userId) sends header `x-actor-id`.
--     PostgREST (v12 live/staging, v16 local) exposes request headers to the transaction as
--     the GUC `request.headers` (json) — every write in that request sees it.
--   * SQL callers (maintenance scripts, a future SECURITY DEFINER RPC) can instead do
--     `select set_config('app.actor_id', '<uuid>', true)` inside their transaction.
--   * public.audit_service_actor() returns that id ONLY when the request carries no user
--     session (auth.uid() is null) AND the JWT role is service_role (or there are no
--     claims at all = a direct DB login, e.g. psql/migrations). A browser client cannot
--     produce either: its JWT says 'authenticated'/'anon' and is signed by GoTrue, so an
--     `x-actor-id` header or an app.actor_id it somehow set is ignored. Malformed ids are
--     ignored, never raised (an audit hint must not fail the money write).
--   * log_row_change(): no session + asserted actor → logs the row. Actor is a user of the
--     row's tenant → user_id = actor. Actor is a user of ANOTHER tenant (platform support
--     acting cross-tenant) → user_id null, actor_label 'Platform support' (their name is
--     not shown to this tenant). Unknown id → user_id null. No actor (cron, webhook) →
--     no row, exactly as before.
--   * record_contract_amendment(): same asserted actor of the same tenant → changed_by =
--     actor, source 'user' instead of 'system'.
-- Bodies otherwise identical to 20260930200001 (log_row_change) and 20261007040000
-- (record_contract_amendment). Triggers unchanged (same function names).
--
-- Test: supabase/tests/audit_actor_admin_writes.test.sql (rolled back).
-- ============================================================================

create or replace function public.audit_service_actor()
returns uuid
language plpgsql
stable
set search_path = public
as $$
declare
  /* nullif(…,''): set_config(…, null) leaves an EMPTY string, and ''::jsonb raises 22P02. */
  v_claims text := nullif(current_setting('request.jwt.claims', true), '');
  v_role   text;
  v_raw    text;
begin
  if auth.uid() is not null then
    return null;                       -- a real session: the trigger uses auth.uid() itself
  end if;
  begin
    v_role := coalesce(v_claims::jsonb ->> 'role', '');
  exception when others then
    return null;
  end;
  if v_claims is not null and v_role <> 'service_role' then
    return null;                       -- anon / authenticated / anything else: not trusted
  end if;

  v_raw := nullif(current_setting('app.actor_id', true), '');
  if v_raw is null then
    begin
      v_raw := nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-actor-id';
    exception when others then
      v_raw := null;
    end;
  end if;
  if v_raw is null
     or v_raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  return v_raw::uuid;
end $$;

comment on function public.audit_service_actor() is
  'R-051: the user a SERVICE-ROLE write is made on behalf of (header x-actor-id via PostgREST request.headers, or set_config(''app.actor_id'')). Null when the caller has a session or is not service_role — clients cannot spoof it.';

revoke all on function public.audit_service_actor() from public;
revoke all on function public.audit_service_actor() from anon, authenticated;
grant execute on function public.audit_service_actor() to service_role;

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
        v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('old', v_old->v_key, 'new', v_json->v_key));
      end if;
    end loop;
    if v_changes = '{}'::jsonb then return null; end if;   -- a touch, not a change
  elsif tg_op = 'DELETE' then
    v_changes := jsonb_build_object('old', v_json);
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

  insert into public.activity_log (tenant_id, user_id, actor_label, action, entity, entity_id, label, changes)
  values (v_tenant, v_user, left(v_actor, 120), lower(tg_op), tg_table_name, v_id, left(v_label, 120), v_changes);
  return null;
end $$;

create or replace function public.record_contract_amendment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changes jsonb := '{}'::jsonb;
  v_kinds   text[] := '{}';
  v_uid     uuid   := auth.uid();
  v_user    uuid;
  v_actor   text;
  v_as      uuid;
begin
  /* Only COMMERCIAL terms. A domain correction or a reminder timestamp is not an
     amendment, and recording every column change would bury the seat history that
     the ledger exists for under cron noise. */
  if new.seats is distinct from old.seats then
    v_changes := v_changes || jsonb_build_object('seats', jsonb_build_object('from', old.seats, 'to', new.seats));
    v_kinds := v_kinds || (case when new.seats > old.seats then 'seats_added' else 'seats_reduced' end)::text;
  end if;

  if new.mrr is distinct from old.mrr then
    v_changes := v_changes || jsonb_build_object('mrr', jsonb_build_object('from', old.mrr, 'to', new.mrr));
    v_kinds := v_kinds || 'price_changed'::text;
  end if;

  if new.plan is distinct from old.plan then
    v_changes := v_changes || jsonb_build_object('plan', jsonb_build_object('from', old.plan, 'to', new.plan));
    v_kinds := v_kinds || 'plan_changed'::text;
  end if;

  if new.renewal_date is distinct from old.renewal_date then
    v_changes := v_changes || jsonb_build_object('renewal_date', jsonb_build_object('from', old.renewal_date, 'to', new.renewal_date));
    v_kinds := v_kinds || 'term_changed'::text;
  end if;

  if new.status is distinct from old.status then
    v_changes := v_changes || jsonb_build_object('status', jsonb_build_object('from', old.status, 'to', new.status));
    v_kinds := v_kinds || 'status_changed'::text;
  end if;

  if new.billing_cycle is distinct from old.billing_cycle then
    v_changes := v_changes || jsonb_build_object('billing_cycle', jsonb_build_object('from', old.billing_cycle, 'to', new.billing_cycle));
    v_kinds := v_kinds || 'billing_cycle_changed'::text;
  end if;

  if v_changes = '{}'::jsonb then
    return new;   -- nothing commercial moved
  end if;

  -- R-096: who is acting — a staff user, or a portal customer (not in public.users).
  if v_uid is not null then
    select u.id into v_user from public.users u where u.id = v_uid;
    if v_user is null then
      select 'Customer ' || c.name into v_actor
        from public.customer_users cu
        join public.customers c on c.id = cu.customer_id
       where cu.auth_user_id = v_uid
       limit 1;
    end if;
  else
    -- R-051: an admin-client write made for a signed-in staff user of this tenant.
    v_as := public.audit_service_actor();
    if v_as is not null then
      select u.id into v_user from public.users u where u.id = v_as and u.tenant_id = new.tenant_id;
    end if;
  end if;

  insert into public.contract_amendments (
    tenant_id, subscription_id, customer_name, kind, changes,
    seats_from, seats_to, mrr_from, mrr_to, changed_by, actor_label, source
  ) values (
    new.tenant_id, new.id, new.customer_name,
    array_to_string(v_kinds, '+'),
    v_changes,
    case when new.seats is distinct from old.seats then old.seats end,
    case when new.seats is distinct from old.seats then new.seats end,
    case when new.mrr   is distinct from old.mrr   then old.mrr   end,
    case when new.mrr   is distinct from old.mrr   then new.mrr   end,
    v_user,
    left(v_actor, 120),
    case when v_uid is null and v_user is null then 'system' else 'user' end
  );

  return new;
end;
$$;

comment on function public.record_contract_amendment() is
  'Writes an amendment row when a subscription''s COMMERCIAL terms move. changed_by = staff user id (session, or the service-role asserted actor of the same tenant - R-051); a portal customer gets changed_by null + actor_label ''Customer <name>'' (R-096).';
