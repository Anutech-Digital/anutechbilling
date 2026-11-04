-- deploy-peek: to_regclass('public.record_access_log') is not null and to_regprocedure('public.log_record_view(text,text)') is not null and to_regclass('public.security_log') is not null
-- deploy-key: r2350accesslog
-- 20261101231527_r2350_record_access_log.sql
--
-- R-2350 (G-DPDP, split from R-2017 part 3). Test: supabase/tests/r2350_record_access_log.test.sql
--
-- ══ WHY ═══════════════════════════════════════════════════════════════════════════════════
--   Only exports were recorded (R-1006 export_log). Nobody could tell who LOOKED at a
--   customer's or a lead's personal data. DPDP security safeguards expect access to personal
--   data to be traceable, so the owner can answer "who opened this person's record?".
--
-- ══ WHAT ══════════════════════════════════════════════════════════════════════════════════
--   * record_access_log — one row per customer / lead detail open: company, user, record type,
--     record id, action (view | export), when.
--   * READ: the owner of that company only — current_tenant_id() (active + MFA, R-722/R-731)
--     AND current_user_has_role('owner'), the export_log (R-1006) shape.
--   * WRITE: nobody writes the table directly. authenticated has SELECT only; service_role has
--     SELECT + INSERT (no UPDATE / DELETE for anyone but the table owner — the log is append
--     only). The app calls log_record_view(), SECURITY DEFINER, which takes the company from
--     current_tenant_id() and the user from auth.uid() — never from an argument.
--   * DEBOUNCE: the same user opening the same record again within 10 minutes is the same
--     look, so no second row (an advisory lock keeps two parallel opens to one row).
--   * Only a record that exists in the caller's own company is logged (else returns false).
--   * security_log — one owner-facing list: these rows UNION the R-1006 export_log rows, with
--     the record's name. security_invoker = on, so the caller's own RLS on every table applies
--     (owner only, own company). export_log keeps working exactly as before.
--   * Nothing here changes who can see a customer or a lead.
--
-- Rollback: drop view public.security_log; drop function public.log_record_view(text, text);
--   drop table public.record_access_log;

begin;

create table if not exists public.record_access_log (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references public.tenants(id) on delete cascade,
  user_id     uuid        references public.users(id) on delete set null,
  record_type text        not null check (record_type in ('customer', 'lead')),
  record_id   text        not null check (char_length(record_id) between 1 and 100),
  action      text        not null default 'view' check (action in ('view', 'export')),
  at          timestamptz not null default now()
);

comment on table public.record_access_log is
  'R-2350: who opened which customer / lead detail (DPDP read-audit). Owner-only read; written only by log_record_view(); append only.';

create index if not exists record_access_log_tenant_at_idx
  on public.record_access_log (tenant_id, at desc);
create index if not exists record_access_log_debounce_idx
  on public.record_access_log (tenant_id, user_id, record_type, record_id, at desc);

alter table public.record_access_log enable row level security;

revoke all on table public.record_access_log from public;
revoke all on table public.record_access_log from anon;
revoke all on table public.record_access_log from authenticated;
revoke all on table public.record_access_log from service_role;
grant select on table public.record_access_log to authenticated;
grant select, insert on table public.record_access_log to service_role;

drop policy if exists record_access_log_owner_select on public.record_access_log;
create policy record_access_log_owner_select on public.record_access_log as permissive for select to authenticated
  using ((tenant_id = ( select public.current_tenant_id() )) and public.current_user_has_role('owner'));

-- Cloud SQL has no BYPASSRLS: the server (service_role) client needs its own policies (R-450).
drop policy if exists zzz_service_role_select on public.record_access_log;
create policy zzz_service_role_select on public.record_access_log
  as permissive for select to service_role using (true);
drop policy if exists zzz_service_role_insert on public.record_access_log;
create policy zzz_service_role_insert on public.record_access_log
  as permissive for insert to service_role with check (true);

-- ── the only writer ────────────────────────────────────────────────────────────────────────
create or replace function public.log_record_view(p_record_type text, p_record_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_user   uuid := auth.uid();
  v_type   text := lower(btrim(coalesce(p_record_type, '')));
  v_id     text := btrim(coalesce(p_record_id, ''));
  v_found  boolean;
begin
  -- Company from the session only (CLAUDE.md 17c): NULL for anon, inactive and aal1-MFA callers.
  if v_tenant is null or v_user is null then
    raise exception 'log_record_view: no active company session' using errcode = '42501';
  end if;
  if v_type not in ('customer', 'lead') then
    raise exception 'log_record_view: record type must be customer or lead' using errcode = '22023';
  end if;
  if v_id = '' or char_length(v_id) > 100 then
    raise exception 'log_record_view: record id is required' using errcode = '22023';
  end if;

  -- Only a record of the caller's own company is logged (no rows for made-up ids).
  if v_type = 'customer' then
    v_found := v_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and exists (select 1 from public.customers c where c.id = v_id::uuid and c.tenant_id = v_tenant);
  else
    v_found := exists (select 1 from public.leads l where l.id = v_id and l.tenant_id = v_tenant);
  end if;
  if not v_found then
    return false;
  end if;

  -- Debounce: one row per user + record per 10 minutes. The lock makes two parallel opens one row.
  perform pg_advisory_xact_lock(hashtextextended('r2350:' || v_tenant::text || ':' || v_user::text || ':' || v_type || ':' || v_id, 2350));
  if exists (
    select 1 from public.record_access_log r
     where r.tenant_id = v_tenant and r.user_id = v_user
       and r.record_type = v_type and r.record_id = v_id
       and r.action = 'view' and r.at > now() - interval '10 minutes'
  ) then
    return false;
  end if;

  insert into public.record_access_log (tenant_id, user_id, record_type, record_id, action)
  values (v_tenant, v_user, v_type, v_id, 'view');
  return true;
end;
$function$;

comment on function public.log_record_view(text, text) is
  'R-2350: record that the caller opened one customer / lead detail (tenant from current_tenant_id(), user from auth.uid(); 10-minute debounce). True when a row was written.';

revoke all on function public.log_record_view(text, text) from public;
revoke all on function public.log_record_view(text, text) from anon;
grant execute on function public.log_record_view(text, text) to authenticated, service_role;

-- ── the owner's one list: record opens + exports ──────────────────────────────────────────
create or replace view public.security_log
with (security_invoker = true) as
  select r.id,
         r.tenant_id,
         r.user_id,
         r.at,
         r.action,
         r.record_type,
         r.record_id,
         case r.record_type
           when 'customer' then (select c.name from public.customers c where c.id = r.record_id::uuid and c.tenant_id = r.tenant_id)
           when 'lead' then (select coalesce(nullif(btrim(l.company), ''), nullif(btrim(l.contact_name), ''), l.id)
                               from public.leads l where l.id = r.record_id and l.tenant_id = r.tenant_id)
         end as record_label,
         null::integer as row_count,
         null::text as format
    from public.record_access_log r
  union all
  select e.id,
         e.tenant_id,
         e.user_id,
         e.at,
         'export'::text as action,
         'export'::text as record_type,
         null::text as record_id,
         e.what as record_label,
         e.row_count,
         e.format
    from public.export_log e;

comment on view public.security_log is
  'R-2350: Settings → Security log. Customer / lead detail opens (record_access_log) + exports (export_log, R-1006). security_invoker: owner of the company only, through each table''s RLS.';

revoke all on table public.security_log from public;
revoke all on table public.security_log from anon;
revoke all on table public.security_log from authenticated;
grant select on table public.security_log to authenticated;
grant select on table public.security_log to service_role;

commit;
