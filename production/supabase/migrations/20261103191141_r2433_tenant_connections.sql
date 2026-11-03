-- deploy-peek: to_regclass('public.tenant_connections') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.get_partner_metrics()') and prosrc like '%R-2433%')
-- deploy-key: r2433tenantconnections
-- 20261103191141_r2433_tenant_connections.sql
--
-- R-2433 (goal G-NETWORK, slice N1, 3 Nov 2026): two businesses on ResellerOS connect by a
-- request → accept between their owners, identified by VERIFIED GSTIN on both sides.
-- Spec: docs/specs/g-network.md.
--
-- ══ THE GAP ═══════════════════════════════════════════════════════════════════════════
--   The only links between two companies were tenants.parent_tenant_id and
--   customers.linked_tenant_id, set by hand in the database. Nobody was asked: the
--   distributor read each reseller's MRR / invoiced / paid (get_partner_metrics) although the
--   reseller never agreed to share it.
--
-- ══ WHAT IS HERE ══════════════════════════════════════════════════════════════════════
--   table tenant_connections   one row per request. a = the company that asked, b = the one
--                              asked. status requested → accepted / rejected; requested or
--                              accepted → revoked. a_scopes = what A shares with B, b_scopes =
--                              what B shares with A (invoices, payments, statements, pos,
--                              catalogue, partner_metrics). related_party = group link
--                              (sister companies) — still accepted by both owners.
--                              At most one OPEN (requested/accepted) row per pair.
--                              RLS on, NO grant to anon/authenticated: every read and write
--                              goes through the SECURITY DEFINER functions below.
--   network_request_connection(gstin, scopes, related_party)   owner only
--   network_respond_connection(id, accept, scopes)              owner of the asked company
--   network_revoke_connection(id)                               owner of either side
--   network_set_my_scopes(id, scopes)                           owner of either side
--   network_my_connections()                                    owner / manager / accountant
--   network_suggestions()                                       owner: a customer's / vendor's
--                                                               GSTIN equals another company's
--                                                               VERIFIED GSTIN
--   network_has_scope(sharer, viewer, scope)                    internal (no grant) — the one
--                                                               cross-company check
--   get_partner_metrics()       now lists a child only when the child shares partner_metrics
--                               on an accepted connection (and never a personal workspace).
--   Backfill: every existing parent link (neither side personal) becomes an accepted
--   connection, origin 'parent_link': the child shares partner_metrics (owner decision —
--   existing links keep it until the reseller switches it off in Settings → Network), the
--   parent shares catalogue.
--
-- Rules every function keeps: the caller's company = current_tenant_id() (NULL for a
-- deactivated user or an unfinished MFA sign-in → refused, 28000); owner = current_user_has_role
-- ('owner'); a personal workspace never connects and is never suggested; both GSTINs must be
-- verified (gstin_verified_at) when a request is made AND when it is accepted, and must still be
-- the GSTIN the request was made with; a row of another company pair answers "not found"
-- (nothing leaks). Revoke stops every future read — network_has_scope needs status accepted.
--
-- Test: supabase/tests/r2433_tenant_connections.test.sql (rolled back; red without this file).
-- Idempotent: if not exists / create or replace / on conflict do nothing.

begin;

-- ── table ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.tenant_connections (
  id                    uuid primary key default gen_random_uuid(),
  a_tenant_id           uuid not null references public.tenants(id) on delete cascade,
  b_tenant_id           uuid not null references public.tenants(id) on delete cascade,
  a_gstin               text,
  b_gstin               text,
  status                text not null default 'requested',
  a_scopes              text[] not null default '{}',
  b_scopes              text[] not null default '{}',
  related_party         boolean not null default false,
  origin                text not null default 'request',
  requested_by          uuid,
  requested_at          timestamptz not null default now(),
  responded_by          uuid,
  responded_at          timestamptz,
  revoked_by            uuid,
  revoked_by_tenant_id  uuid,
  revoked_at            timestamptz,
  updated_at            timestamptz not null default now(),
  constraint tenant_connections_not_self check (a_tenant_id <> b_tenant_id),
  constraint tenant_connections_status_check check (status in ('requested', 'accepted', 'rejected', 'revoked')),
  constraint tenant_connections_origin_check check (origin in ('request', 'parent_link')),
  constraint tenant_connections_scopes_known check (
    a_scopes <@ array['invoices', 'payments', 'statements', 'pos', 'catalogue', 'partner_metrics']::text[]
    and b_scopes <@ array['invoices', 'payments', 'statements', 'pos', 'catalogue', 'partner_metrics']::text[]),
  /* A request is always made between two verified GSTINs; only the backfilled parent links
     (made by the operator before this table existed) may lack one. */
  constraint tenant_connections_request_gstins check (origin <> 'request' or (a_gstin is not null and b_gstin is not null))
);

create unique index if not exists tenant_connections_open_pair_uq
  on public.tenant_connections (least(a_tenant_id, b_tenant_id), greatest(a_tenant_id, b_tenant_id))
  where status in ('requested', 'accepted');
create index if not exists tenant_connections_a_idx on public.tenant_connections (a_tenant_id);
create index if not exists tenant_connections_b_idx on public.tenant_connections (b_tenant_id);

alter table public.tenant_connections enable row level security;
revoke all on public.tenant_connections from public, anon, authenticated;
grant all on public.tenant_connections to service_role;

-- ── helpers ───────────────────────────────────────────────────────────────────────────
create or replace function public.network_scope_list()
returns text[]
language sql
immutable
set search_path to 'public'
as $function$
  select array['invoices', 'payments', 'statements', 'pos', 'catalogue', 'partner_metrics']::text[];
$function$;

/* Known scopes only, each once, sorted. An unknown word is refused, never dropped silently. */
create or replace function public.network_clean_scopes(p_scopes text[])
returns text[]
language plpgsql
immutable
set search_path to 'public'
as $function$
declare
  v_bad text;
begin
  select s into v_bad
    from unnest(coalesce(p_scopes, '{}'::text[])) s
   where lower(btrim(s)) <> all (public.network_scope_list())
   limit 1;
  if v_bad is not null then
    raise exception 'Unknown sharing choice "%". Use: %', v_bad, array_to_string(public.network_scope_list(), ', ')
      using errcode = '22023';
  end if;
  return coalesce((select array_agg(distinct lower(btrim(s)) order by lower(btrim(s)))
                     from unnest(coalesce(p_scopes, '{}'::text[])) s), '{}'::text[]);
end $function$;

/* The caller's company for a network write: active, finished sign-in, owner. */
create or replace function public.network_owner_tenant()
returns uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  /* R-2433 */
  v_t uuid := public.current_tenant_id();
begin
  if v_t is null then
    raise exception 'Connecting businesses needs an active user who has finished sign-in (including the authenticator code). Sign in again and retry.'
      using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner') then
    raise exception 'Only the workspace owner can connect, accept, change or revoke a business connection.'
      using errcode = '42501';
  end if;
  return v_t;
end $function$;

/* The ONE cross-company check: does p_sharer share p_scope with p_viewer on an ACCEPTED
   connection? Not granted to any request role (it would tell who is connected to whom). */
create or replace function public.network_has_scope(p_sharer uuid, p_viewer uuid, p_scope text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  /* R-2433 */
  select exists (
    select 1 from public.tenant_connections c
     where c.status = 'accepted'
       and ((c.a_tenant_id = p_sharer and c.b_tenant_id = p_viewer and p_scope = any (c.a_scopes))
         or (c.b_tenant_id = p_sharer and c.a_tenant_id = p_viewer and p_scope = any (c.b_scopes)))
  );
$function$;

-- ── request ───────────────────────────────────────────────────────────────────────────
create or replace function public.network_request_connection(
  p_gstin text, p_scopes text[] default '{}'::text[], p_related_party boolean default false)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-2433 */
  v_t       uuid := public.network_owner_tenant();
  v_me      public.tenants;
  v_gstin   text := upper(btrim(coalesce(p_gstin, '')));
  v_target  uuid;
  v_tgstin  text;
  v_n       int;
  v_open    public.tenant_connections;
  v_scopes  text[] := public.network_clean_scopes(p_scopes);
  v_id      uuid;
begin
  select * into v_me from public.tenants where id = v_t;
  if v_me.workspace_kind = 'personal' then
    raise exception 'A personal workspace cannot connect to other businesses.' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(v_me.gstin, '')), '') is null or v_me.gstin_verified_at is null then
    raise exception 'Verify your own GSTIN first (Settings → Company) — connections are made between verified GSTINs.'
      using errcode = '22023';
  end if;
  if v_gstin = '' then
    raise exception 'Enter the GSTIN of the business to connect with.' using errcode = '22023';
  end if;
  if v_gstin = upper(btrim(v_me.gstin)) then
    raise exception 'That is your own GSTIN.' using errcode = '22023';
  end if;

  select count(*), min(t.id::text)::uuid into v_n, v_target
    from public.tenants t
   where upper(btrim(t.gstin)) = v_gstin
     and t.gstin_verified_at is not null
     and t.workspace_kind is distinct from 'personal'
     and t.id <> v_t;
  if v_n = 0 then
    raise exception 'No business with the verified GSTIN % is on ResellerOS yet.', v_gstin using errcode = 'P0002';
  end if;
  if v_n > 1 then
    raise exception 'More than one business on ResellerOS has verified GSTIN % — ask support to sort it out before connecting.', v_gstin
      using errcode = '22023';
  end if;
  select upper(btrim(gstin)) into v_tgstin from public.tenants where id = v_target;

  select * into v_open from public.tenant_connections c
   where least(c.a_tenant_id, c.b_tenant_id) = least(v_t, v_target)
     and greatest(c.a_tenant_id, c.b_tenant_id) = greatest(v_t, v_target)
     and c.status in ('requested', 'accepted')
   for update;
  if found then
    if v_open.status = 'accepted' then
      raise exception 'You are already connected with this business.' using errcode = '23505';
    end if;
    if v_open.a_tenant_id = v_t then
      return v_open.id;   -- asked again: same open request
    end if;
    raise exception 'This business has already asked to connect with you — accept it under Requests received.'
      using errcode = '23505';
  end if;

  insert into public.tenant_connections
    (a_tenant_id, b_tenant_id, a_gstin, b_gstin, status, a_scopes, related_party, origin, requested_by)
  values
    (v_t, v_target, upper(btrim(v_me.gstin)), v_tgstin, 'requested', v_scopes, coalesce(p_related_party, false),
     'request', auth.uid())
  returning id into v_id;
  return v_id;
end $function$;

-- ── accept / reject (owner of the asked company) ──────────────────────────────────────
create or replace function public.network_respond_connection(
  p_id uuid, p_accept boolean, p_scopes text[] default '{}'::text[])
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-2433 */
  v_t      uuid := public.network_owner_tenant();
  v_c      public.tenant_connections;
  v_scopes text[] := public.network_clean_scopes(p_scopes);
  v_ok     boolean;
begin
  select * into v_c from public.tenant_connections where id = p_id and b_tenant_id = v_t for update;
  if not found then
    raise exception 'Connection request not found.' using errcode = 'P0002';
  end if;
  if v_c.status <> 'requested' then
    raise exception 'This request is no longer open (it is %).', v_c.status using errcode = '22023';
  end if;

  if not coalesce(p_accept, false) then
    update public.tenant_connections
       set status = 'rejected', responded_by = auth.uid(), responded_at = now(), updated_at = now()
     where id = p_id;
    return 'rejected';
  end if;

  /* Both sides must STILL be verified, not personal, and on the GSTIN the request named. */
  select count(*) = 2 into v_ok
    from public.tenants t
   where (t.id = v_c.a_tenant_id and upper(btrim(t.gstin)) = v_c.a_gstin
          or t.id = v_c.b_tenant_id and upper(btrim(t.gstin)) = v_c.b_gstin)
     and t.gstin_verified_at is not null
     and t.workspace_kind is distinct from 'personal';
  if not v_ok then
    raise exception 'A GSTIN on this request changed or is no longer verified — ask them to send a new request.'
      using errcode = '22023';
  end if;

  update public.tenant_connections
     set status = 'accepted', b_scopes = v_scopes, responded_by = auth.uid(), responded_at = now(), updated_at = now()
   where id = p_id;
  return 'accepted';
end $function$;

-- ── revoke (either side; also withdraws an open request) ──────────────────────────────
create or replace function public.network_revoke_connection(p_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-2433 */
  v_t uuid := public.network_owner_tenant();
  v_c public.tenant_connections;
begin
  select * into v_c from public.tenant_connections
   where id = p_id and v_t in (a_tenant_id, b_tenant_id) for update;
  if not found then
    raise exception 'Connection not found.' using errcode = 'P0002';
  end if;
  if v_c.status not in ('requested', 'accepted') then
    raise exception 'This connection is already %.', v_c.status using errcode = '22023';
  end if;
  update public.tenant_connections
     set status = 'revoked', revoked_by = auth.uid(), revoked_by_tenant_id = v_t, revoked_at = now(), updated_at = now()
   where id = p_id;
  return 'revoked';
end $function$;

-- ── what MY side shares (either side, open connection) ────────────────────────────────
create or replace function public.network_set_my_scopes(p_id uuid, p_scopes text[])
returns text[]
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-2433 */
  v_t      uuid := public.network_owner_tenant();
  v_c      public.tenant_connections;
  v_scopes text[] := public.network_clean_scopes(p_scopes);
begin
  select * into v_c from public.tenant_connections
   where id = p_id and v_t in (a_tenant_id, b_tenant_id) for update;
  if not found then
    raise exception 'Connection not found.' using errcode = 'P0002';
  end if;
  if v_c.status not in ('requested', 'accepted') then
    raise exception 'This connection is %; nothing is shared any more.', v_c.status using errcode = '22023';
  end if;
  if v_c.a_tenant_id = v_t then
    update public.tenant_connections set a_scopes = v_scopes, updated_at = now() where id = p_id;
  else
    update public.tenant_connections set b_scopes = v_scopes, updated_at = now() where id = p_id;
  end if;
  return v_scopes;
end $function$;

-- ── list my connections (no other company's data beyond its name + GSTIN) ─────────────
create or replace function public.network_my_connections()
returns table (
  id uuid, other_tenant_id uuid, other_name text, other_gstin text, status text, direction text,
  my_scopes text[], their_scopes text[], related_party boolean, origin text,
  requested_at timestamptz, responded_at timestamptz, revoked_at timestamptz, revoked_by_me boolean)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  /* R-2433: owner / manager / accountant of the caller's company; anyone else sees nothing. */
  v_t uuid := public.current_tenant_id();
begin
  if v_t is null or not public.current_user_has_role('owner', 'manager', 'accountant') then
    return;
  end if;
  return query
  select c.id,
         case when c.a_tenant_id = v_t then c.b_tenant_id else c.a_tenant_id end,
         o.name::text,
         case when c.a_tenant_id = v_t then c.b_gstin else c.a_gstin end,
         c.status,
         case when c.a_tenant_id = v_t then 'sent' else 'received' end,
         case when c.a_tenant_id = v_t then c.a_scopes else c.b_scopes end,
         case when c.a_tenant_id = v_t then c.b_scopes else c.a_scopes end,
         c.related_party, c.origin, c.requested_at, c.responded_at, c.revoked_at,
         c.revoked_by_tenant_id = v_t
    from public.tenant_connections c
    join public.tenants o on o.id = case when c.a_tenant_id = v_t then c.b_tenant_id else c.a_tenant_id end
   where v_t in (c.a_tenant_id, c.b_tenant_id)
   order by case c.status when 'requested' then 0 when 'accepted' then 1 else 2 end, c.updated_at desc;
end $function$;

-- ── suggestions: my customer / vendor is a verified business on ResellerOS ────────────
create or replace function public.network_suggestions()
returns table (tenant_id uuid, tenant_name text, gstin text, matched_as text, matched_name text)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  /* R-2433: owner only (only the owner can act on one); never from or to a personal workspace. */
  v_t uuid := public.current_tenant_id();
begin
  if v_t is null or not public.current_user_has_role('owner') then
    return;
  end if;
  if exists (select 1 from public.tenants where id = v_t and workspace_kind = 'personal') then
    return;
  end if;
  return query
  with mine as (
    select upper(btrim(cu.gstin)) as g, 'customer'::text as kind, cu.name::text as nm
      from public.customers cu
     where cu.tenant_id = v_t and cu.is_active and nullif(btrim(coalesce(cu.gstin, '')), '') is not null
    union all
    select upper(btrim(v.gstin)), 'vendor', v.name::text
      from public.vendors v
     where v.tenant_id = v_t and nullif(btrim(coalesce(v.gstin, '')), '') is not null
  )
  select distinct on (t.id) t.id, t.name::text, upper(btrim(t.gstin)), m.kind, m.nm
    from mine m
    join public.tenants t on upper(btrim(t.gstin)) = m.g
   where t.id <> v_t
     and t.gstin_verified_at is not null
     and t.workspace_kind is distinct from 'personal'
     and not exists (
       select 1 from public.tenant_connections c
        where least(c.a_tenant_id, c.b_tenant_id) = least(v_t, t.id)
          and greatest(c.a_tenant_id, c.b_tenant_id) = greatest(v_t, t.id)
          and c.status in ('requested', 'accepted', 'rejected'))
   order by t.id, m.kind, m.nm;
end $function$;

-- ── partner metrics: only with the reseller's consent ─────────────────────────────────
-- From 20261024030326_r1816_money_rpcs_ist_today (latest body); one added condition.
CREATE OR REPLACE FUNCTION public.get_partner_metrics()
 RETURNS TABLE(tenant_id uuid, tenant_name text, tenant_gstin text, active_subscriptions integer, total_seats_sold integer, mrr integer, invoiced_this_month integer, paid_this_month integer, renewals_due_30d integer, renewal_revenue_30d integer, last_invoice_date date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  /* R-1615: current_tenant_id() — no rows for a deactivated user / half-signed-in MFA session.
     R-2433: a child shows only when IT shares partner_metrics with the caller on an accepted
     connection (Settings → Network), and never a personal workspace. */
  with caller as (
    select public.current_tenant_id() as tenant_id
  ),
  month_start as (
    select date_trunc('month', public.ist_today())::date as d
  ),
  children as (
    select t.id, t.name, t.gstin
    from public.tenants t
    where t.parent_tenant_id = (select tenant_id from caller)
      and t.workspace_kind is distinct from 'personal'
      and public.network_has_scope(t.id, (select tenant_id from caller), 'partner_metrics')
  )
  select
    c.id, c.name, c.gstin,
    coalesce((select count(*)::int from public.subscriptions s
      where s.tenant_id = c.id and s.status = 'active'), 0),
    coalesce((select sum(seats)::int from public.subscriptions s
      where s.tenant_id = c.id and s.status = 'active'), 0),
    coalesce((select sum(mrr)::int from public.subscriptions s
      where s.tenant_id = c.id and s.status = 'active'), 0),
    coalesce((select sum(amount)::int from public.invoices i
      where i.tenant_id = c.id and i.invoice_date >= (select d from month_start)
        and public.invoice_is_sale(i.document_kind)), 0),  -- R-1739
    coalesce((select sum(amount)::int from public.invoices i
      where i.tenant_id = c.id and i.status = 'paid' and i.paid_date is not null
        and public.invoice_is_sale(i.document_kind)  -- R-1739
        and i.paid_date >= (select d from month_start)), 0),
    coalesce((select count(*)::int from public.subscriptions s
      where s.tenant_id = c.id and s.status = 'active'
        and s.renewal_date is not null and s.renewal_date <= public.ist_today() + interval '30 days'), 0),
    coalesce((select sum(mrr * 12)::int from public.subscriptions s
      where s.tenant_id = c.id and s.status = 'active'
        and s.renewal_date is not null and s.renewal_date <= public.ist_today() + interval '30 days'), 0),
    (select max(invoice_date) from public.invoices i where i.tenant_id = c.id and public.invoice_is_sale(i.document_kind))
  from children c
  order by c.name;
$function$;

-- ── backfill: today's parent links keep working, now as consented connections ─────────
insert into public.tenant_connections
  (a_tenant_id, b_tenant_id, a_gstin, b_gstin, status, a_scopes, b_scopes, origin, requested_at, responded_at)
select p.id, ch.id, nullif(upper(btrim(coalesce(p.gstin, ''))), ''), nullif(upper(btrim(coalesce(ch.gstin, ''))), ''),
       'accepted', array['catalogue']::text[], array['partner_metrics']::text[], 'parent_link', now(), now()
  from public.tenants ch
  join public.tenants p on p.id = ch.parent_tenant_id
 where ch.id <> p.id
   and ch.workspace_kind is distinct from 'personal'
   and p.workspace_kind is distinct from 'personal'
on conflict do nothing;

-- ── grants ────────────────────────────────────────────────────────────────────────────
revoke all on function public.network_scope_list() from public, anon;
revoke all on function public.network_clean_scopes(text[]) from public, anon;
revoke all on function public.network_owner_tenant() from public, anon, authenticated;
revoke all on function public.network_has_scope(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.network_request_connection(text, text[], boolean) from public, anon;
revoke all on function public.network_respond_connection(uuid, boolean, text[]) from public, anon;
revoke all on function public.network_revoke_connection(uuid) from public, anon;
revoke all on function public.network_set_my_scopes(uuid, text[]) from public, anon;
revoke all on function public.network_my_connections() from public, anon;
revoke all on function public.network_suggestions() from public, anon;

grant execute on function public.network_scope_list() to authenticated, service_role;
grant execute on function public.network_clean_scopes(text[]) to authenticated, service_role;
grant execute on function public.network_request_connection(text, text[], boolean) to authenticated;
grant execute on function public.network_respond_connection(uuid, boolean, text[]) to authenticated;
grant execute on function public.network_revoke_connection(uuid) to authenticated;
grant execute on function public.network_set_my_scopes(uuid, text[]) to authenticated;
grant execute on function public.network_my_connections() to authenticated;
grant execute on function public.network_suggestions() to authenticated;

commit;
