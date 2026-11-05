-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.current_user_has_role(text[])') and prosrc like '%R-2481%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.current_tenant_id()') and prosrc like '%R-2481%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.repair_missing_tenant_memberships()'))
-- deploy-key: r2481membershipfixes
-- 20261105000700_r2481_membership_review_fixes.sql
--
-- R-2481 (5 Nov 2026) — fixes from the independent review of R-2471 (tenant_memberships, slice 1):
--   Anutech-HQ/drafts/REVIEWS/2026-11-05-r2471-memberships.md. Spec: docs/specs/memberships.md.
--
--   F1. current_user_has_role() went from ~0.2 ms to 1.1–2.0 ms per call after R-2471 (a SQL body
--       that joins memberships + users AND calls current_tenant_id() inside the WHERE), and 96 RLS
--       policies call it per row: a bulk lock of 1,526 bank lines went from ~0.4 s to ~2.4–3 s.
--       Both helpers become plpgsql with the SAME checks: the plans are cached and the selected
--       company is read once per call. Bodies are the R-2471 bodies (20261105000000), which kept
--       R-722 / R-731 / R-1556 / R-1896 — every check and every marker the deploy peeks read stays.
--       current_user_is_owner() calls current_user_has_role('owner') and needs no change.
--   F3. R-2471's backfill ran before its users→membership trigger existed, without a lock, so a
--       signup committed in that window has no membership and is locked out. The trigger exists
--       now, so repair_missing_tenant_memberships() closes it for good: it gives every users row
--       that has NO membership row at all for its selected company the membership the backfill
--       would have given (idempotent; an ENDED membership is a decision and is left alone). The
--       migration runs it once; the deploy runs the same check after the train (spec §8).
--   (F2 is the staging wipe tool's keep-list — supabase/cloudsql/staging/wipe-tenant-transactions.sql.)
-- Idempotent.

begin;

-- ── F1. current_tenant_id(): same checks, plpgsql ──────────────────────────────────
create or replace function public.current_tenant_id() returns uuid
  language plpgsql stable security definer set search_path = ''
as $$
  /* R-722: an inactive user (users.is_active = false) has no tenant — every policy built on
     this gives them nothing.
     R-731: an MFA-enrolled user whose session is not aal2 has no tenant either
     (public.session_mfa_ok()).
     R-1896: nor does a login past its access_ends_on (an employee after their last working
     day) — checked against the IST date on every call, so no job has to switch it off.
     R-2471: the tenant is the SELECTED company (users.tenant_id) and only while this login's
     membership there is active, not ended and not past its access_ends_on. No membership →
     NULL. A job for a user needs that user's active membership in app.tenant_id.
     R-2481: plpgsql with the login id in a variable — the plan is cached and the users row is
     found by its primary key (the SQL body re-planned on every call and joined from the
     membership side: ~350 µs → ~30 µs per call). Same checks as R-2471, branch for branch. */
declare
  v_uid uuid;
  v_app_tid uuid;
  v_tid uuid;
begin
  if session_user = 'app_runtime' then
    v_uid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_app_tid := nullif(current_setting('app.tenant_id', true), '')::uuid;
    if v_uid is null then
      return null;
    end if;
    select u.tenant_id into v_tid from public.users u
      join public.tenant_memberships m on m.user_id = u.id and m.tenant_id = u.tenant_id
     where u.id = v_uid
       and u.is_active
       and (u.access_ends_on is null or u.access_ends_on >= public.ist_today())
       and m.is_active and m.ended_at is null
       and (m.access_ends_on is null or m.access_ends_on >= public.ist_today())
       and (v_app_tid is null or u.tenant_id = v_app_tid);
  elsif session_user = 'app_jobs' then
    v_uid := nullif(current_setting('app.user_id', true), '')::uuid;
    v_app_tid := nullif(current_setting('app.tenant_id', true), '')::uuid;
    if v_uid is null then
      return v_app_tid;
    end if;
    select m.tenant_id into v_tid from public.tenant_memberships m
     where m.user_id = v_uid
       and m.tenant_id = v_app_tid
       and m.is_active and m.ended_at is null
       and (m.access_ends_on is null or m.access_ends_on >= public.ist_today());
    return v_tid;
  elsif session_user in ('app_service', 'app_anon') then
    return null;
  else
    v_uid := public.current_user_id();
    if v_uid is null then
      return null;
    end if;
    select u.tenant_id into v_tid from public.users u
      join public.tenant_memberships m on m.user_id = u.id and m.tenant_id = u.tenant_id
     where u.id = v_uid and u.is_active
       and (u.access_ends_on is null or u.access_ends_on >= public.ist_today())
       and m.is_active and m.ended_at is null
       and (m.access_ends_on is null or m.access_ends_on >= public.ist_today());
  end if;
  /* app_runtime + a signed-in user: R-731 two-step sign-in (the SQL body had it in the WHERE). */
  if v_tid is null or not public.session_mfa_ok() then
    return null;
  end if;
  return v_tid;
end;
$$;

comment on function public.current_tenant_id() is
  'Selected company of the signed-in user — NULL when there is none, the user is deactivated (R-722), MFA is enrolled and this session is not aal2 (R-731), the login is past its access_ends_on (R-1896), or its membership in the selected company is off / ended / expired (R-2471). plpgsql since R-2481 (speed; same checks).';

-- ── F1. current_user_has_role(): same checks, plpgsql, tenant read once ─────────────
create or replace function public.current_user_has_role(variadic p_roles text[])
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
  /* `is_active` matters as much as the role: a deactivated owner is how an ex-employee
     keeps their access. current_user_is_owner() already checks it; this matches.
     R-1556: and the session must have passed two-step sign-in if the user enrolled
     (session_mfa_ok(), R-731) — a password-only session holds no role.
     R-1896: a login past its access_ends_on holds no role either.
     R-2471: the role is the one in the membership of the company current_tenant_id() returns
     (the SELECTED company; for a job, its app.tenant_id) — so the role and the tenant always
     come from the same membership. current_tenant_id() already requires that membership active,
     not ended and not expired. For the selected company the users mirror must agree too (role,
     active, end date): if they ever drift, no role (fail closed).
     R-2481: plpgsql — current_tenant_id() runs ONCE per call and the membership is found by its
     (user, company) key (the SQL body called it inside the WHERE: 1.1–2.0 ms per call, and 96
     RLS policies call this per row). Same checks as R-2471. */
declare
  v_uid uuid;
  v_tid uuid;
  v_ok boolean;
begin
  v_tid := public.current_tenant_id();
  if v_tid is null then
    return false;
  end if;
  v_uid := public.current_user_id();
  if v_uid is null then
    return false;
  end if;
  select exists (
    select 1 from public.tenant_memberships m
      join public.users u on u.id = m.user_id
     where m.user_id = v_uid
       and m.tenant_id = v_tid
       and m.is_active and m.ended_at is null
       and (m.access_ends_on is null or m.access_ends_on >= public.ist_today())
       and m.role::text = any (p_roles)
       and (u.tenant_id is distinct from m.tenant_id
            or (u.role = m.role and u.is_active
                and (u.access_ends_on is null or u.access_ends_on >= public.ist_today())))
  ) into v_ok;
  return v_ok and public.session_mfa_ok();
end;
$function$;

comment on function public.current_user_has_role(text[]) is
  'True when the signed-in user is ACTIVE (and not past access_ends_on, R-1896), holds one of the given roles in the SELECTED company''s active membership (R-2471), and (if MFA-enrolled) '
  'this session is aal2. The single definition of "who may touch this". S41, R-1556. plpgsql since R-2481 (speed; same checks).';

-- ── F3. Repair: a users row with no membership for its selected company ─────────────
create or replace function public.repair_missing_tenant_memberships()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
/* R-2481 (F3 of the R-2471 review): the R-2471 backfill ran before its users→membership trigger
   existed, with no lock on users — a users row committed in between got no membership, and
   current_tenant_id() is NULL for it for good. Gives each such row exactly the membership the
   backfill gives (same columns). Only rows with NO membership row for (user, selected company):
   an ended / switched-off membership is a decision (Remove, exit, move) and is left alone.
   Idempotent — returns how many it added; 0 on a healthy DB. Service-side only. */
declare
  v_n integer;
begin
  insert into public.tenant_memberships
    (user_id, tenant_id, role, is_active, access_ends_on, employee_id, manager_id,
     can_view_deals, gets_new_leads, created_at)
  select u.id, u.tenant_id, u.role, u.is_active, u.access_ends_on, u.employee_id, u.manager_id,
         u.can_view_deals, u.gets_new_leads, u.created_at
    from public.users u
   where u.tenant_id is not null
     and not exists (select 1 from public.tenant_memberships m
                      where m.user_id = u.id and m.tenant_id = u.tenant_id)
  on conflict (user_id, tenant_id) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.repair_missing_tenant_memberships() from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.repair_missing_tenant_memberships() to service_role;
  end if;
end $$;

comment on function public.repair_missing_tenant_memberships() is
  'R-2481: gives every users row with NO membership row for its selected company the R-2471 backfill membership. Idempotent; returns rows added (0 = healthy). Service-side only.';

do $$ declare v_n integer; begin
  v_n := public.repair_missing_tenant_memberships();
  raise notice 'R-2481: % users row(s) given their missing membership', v_n;
end $$;

commit;
