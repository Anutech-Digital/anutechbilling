-- deploy-peek: to_regclass('public.company_share_capital') is not null and to_regclass('public.company_shareholders') is not null and to_regprocedure('public.save_share_capital(bigint,integer)') is not null and to_regprocedure('public.save_shareholder(uuid,text,text,bigint,date)') is not null and to_regprocedure('public.delete_shareholder(uuid)') is not null
-- deploy-key: r1851sharecapital
-- 20261024204000_r1851_share_capital.sql
--
-- R-1851 (epic R-1841, Phase 3 — Pvt Ltd): share capital + shareholders register.
--
-- A company's share capital was a hand-entered Balance Sheet equity line. Now:
--   company_share_capital — one row per company: authorised capital (₹, whole rupees) and the
--     face value of one share (₹, whole rupees).
--   company_shareholders  — one row per shareholder: name, PAN, number of shares, date of
--     allotment.
-- Paid-up shares = the holders' shares added up (one fact, one place — never typed twice), so
-- the percentages always total 100 %. Paid-up capital = paid-up shares × face value (fully paid
-- shares; partly-paid is not supported yet). It may not exceed the authorised capital (Companies
-- Act 2013 s.61 — raising it needs an ordinary resolution + SH-7 with the ROC): both functions
-- refuse a save that would break that.
--
-- The Balance Sheet reads paid-up capital from here (lib/accounting/equity-section.ts). No
-- existing row is changed: a hand-entered Share capital line stays exactly as it is and the page
-- shows an amber "counted twice?" note when both exist (R-1839 pattern).
--
-- Writes only through the functions (no direct insert/update/delete grants). §17c guard on every
-- function; roles owner, manager, accountant (the R-1847 / R-1850 register roles). Only a Pvt Ltd
-- (or an empty business type, which means Pvt Ltd — R-1842). Reads: same company AND one of those
-- roles. Proof: supabase/tests/r1851_share_capital.test.sql (one rollback).

begin;

-- ── 1. Tables ──────────────────────────────────────────────────────────────────────────────
create table if not exists public.company_share_capital (
  tenant_id           uuid         primary key references public.tenants(id) on delete cascade,
  authorised_capital  bigint       not null check (authorised_capital > 0),
  face_value          integer      not null check (face_value > 0),
  updated_by          uuid,
  updated_at          timestamptz  not null default now()
);
comment on table public.company_share_capital is
  'R-1851: a company''s authorised capital and face value per share (whole rupees). Paid-up = sum(company_shareholders.shares) x face_value.';

create table if not exists public.company_shareholders (
  id           uuid         primary key default gen_random_uuid(),
  tenant_id    uuid         not null references public.tenants(id) on delete cascade,
  name         text         not null check (length(btrim(name)) between 1 and 200),
  pan          text         check (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  shares       bigint       not null check (shares > 0),
  allotted_on  date,
  created_by   uuid,
  created_at   timestamptz  not null default now(),
  updated_at   timestamptz  not null default now()
);
comment on table public.company_shareholders is
  'R-1851: shareholders of a Pvt Ltd — name, PAN, number of fully paid shares, date of allotment.';

create index if not exists company_shareholders_tenant_idx on public.company_shareholders (tenant_id);
create unique index if not exists company_shareholders_tenant_pan_uq on public.company_shareholders (tenant_id, pan) where pan is not null;

alter table public.company_share_capital enable row level security;
alter table public.company_shareholders  enable row level security;

drop policy if exists "tenant isolation read" on public.company_share_capital;
drop policy if exists zzz_service_role_all on public.company_share_capital;
create policy "tenant isolation read" on public.company_share_capital for select to authenticated
  using (tenant_id = (select public.current_tenant_id())
         and (select public.current_user_has_role('owner', 'manager', 'accountant')));
create policy zzz_service_role_all on public.company_share_capital as permissive for all to service_role
  using (true) with check (true);

drop policy if exists "tenant isolation read" on public.company_shareholders;
drop policy if exists zzz_service_role_all on public.company_shareholders;
create policy "tenant isolation read" on public.company_shareholders for select to authenticated
  using (tenant_id = (select public.current_tenant_id())
         and (select public.current_user_has_role('owner', 'manager', 'accountant')));
create policy zzz_service_role_all on public.company_shareholders as permissive for all to service_role
  using (true) with check (true);

revoke all on public.company_share_capital from anon, authenticated;
revoke all on public.company_shareholders  from anon, authenticated;
grant select on public.company_share_capital to authenticated;
grant select on public.company_shareholders  to authenticated;
grant select, insert, update, delete on public.company_share_capital to service_role;
grant select, insert, update, delete on public.company_shareholders  to service_role;

-- ── 2. Authorised capital + face value ─────────────────────────────────────────────────────
create or replace function public.save_share_capital(p_authorised_capital bigint, p_face_value integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted boolean;
  v_type    text;
  v_tenant  uuid := public.current_tenant_id();
  v_shares  bigint;
begin
  /* R-1851: §17c guard + register role + Pvt Ltd only (production/CLAUDE.md). */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can change the share capital register' using errcode = '42501';
  end if;
  select business_type into v_type from public.tenants where id = v_tenant;
  if v_type is not null and v_type <> 'pvt_ltd' then
    raise exception 'Share capital is for a Pvt Ltd company — set the business type in Settings → Company first.';
  end if;
  if p_authorised_capital is null or p_authorised_capital <= 0 then
    raise exception 'Enter the authorised capital in whole rupees, more than ₹0.';
  end if;
  if p_face_value is null or p_face_value <= 0 then
    raise exception 'Enter the face value of one share in whole rupees, more than ₹0.';
  end if;
  select coalesce(sum(shares), 0) into v_shares from public.company_shareholders where tenant_id = v_tenant;
  if v_shares * p_face_value > p_authorised_capital then
    raise exception 'The shareholders already hold % shares × ₹% = ₹% — the authorised capital cannot be less.',
      v_shares, p_face_value, v_shares * p_face_value;
  end if;
  insert into public.company_share_capital (tenant_id, authorised_capital, face_value, updated_by, updated_at)
  values (v_tenant, p_authorised_capital, p_face_value, auth.uid(), now())
  on conflict (tenant_id) do update
    set authorised_capital = excluded.authorised_capital, face_value = excluded.face_value,
        updated_by = excluded.updated_by, updated_at = now();
end;
$$;
revoke all on function public.save_share_capital(bigint, integer) from public, anon;
grant execute on function public.save_share_capital(bigint, integer) to authenticated, service_role;

-- ── 3. Add / edit a shareholder ────────────────────────────────────────────────────────────
create or replace function public.save_shareholder(
  p_id           uuid,
  p_name         text,
  p_pan          text,
  p_shares       bigint,
  p_allotted_on  date
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted boolean;
  v_type    text;
  v_tenant  uuid := public.current_tenant_id();
  v_name    text := nullif(btrim(coalesce(p_name, '')), '');
  v_pan     text := nullif(upper(btrim(coalesce(p_pan, ''))), '');
  v_cap     public.company_share_capital;
  v_total   bigint;
  v_id      uuid;
begin
  /* R-1851: §17c guard + register role + Pvt Ltd only (production/CLAUDE.md). */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can change the share capital register' using errcode = '42501';
  end if;
  select business_type into v_type from public.tenants where id = v_tenant;
  if v_type is not null and v_type <> 'pvt_ltd' then
    raise exception 'Share capital is for a Pvt Ltd company — set the business type in Settings → Company first.';
  end if;
  -- one save at a time per company, so two holders added together cannot pass the limit
  select * into v_cap from public.company_share_capital where tenant_id = v_tenant for update;
  if not found then raise exception 'Set the authorised capital and face value first.'; end if;

  if v_name is null then raise exception 'Enter the shareholder''s name.'; end if;
  if length(v_name) > 200 then raise exception 'The name is too long (200 characters at most).'; end if;
  if v_pan is not null and v_pan !~ '^[A-Z]{5}[0-9]{4}[A-Z]$' then
    raise exception 'PAN must be 10 characters like ABCDE1234F (5 letters, 4 digits, 1 letter).';
  end if;
  if p_shares is null or p_shares <= 0 then raise exception 'Enter the number of shares, a whole number above 0.'; end if;
  if v_pan is not null and exists (select 1 from public.company_shareholders
              where tenant_id = v_tenant and pan = v_pan and id is distinct from p_id) then
    raise exception 'PAN % is already used by another shareholder.', v_pan;
  end if;
  if p_id is not null and not exists (select 1 from public.company_shareholders where id = p_id and tenant_id = v_tenant) then
    raise exception 'That shareholder is not in your company.';
  end if;

  select coalesce(sum(shares), 0) + p_shares into v_total
    from public.company_shareholders where tenant_id = v_tenant and id is distinct from p_id;
  if v_total * v_cap.face_value > v_cap.authorised_capital then
    raise exception 'That makes % shares × ₹% = ₹% — more than the authorised capital of ₹%. Raise the authorised capital first.',
      v_total, v_cap.face_value, v_total * v_cap.face_value, v_cap.authorised_capital;
  end if;

  if p_id is null then
    insert into public.company_shareholders (tenant_id, name, pan, shares, allotted_on, created_by)
    values (v_tenant, v_name, v_pan, p_shares, p_allotted_on, auth.uid())
    returning id into v_id;
    return v_id;
  end if;
  update public.company_shareholders
     set name = v_name, pan = v_pan, shares = p_shares, allotted_on = p_allotted_on, updated_at = now()
   where id = p_id and tenant_id = v_tenant;
  return p_id;
end;
$$;
revoke all on function public.save_shareholder(uuid, text, text, bigint, date) from public, anon;
grant execute on function public.save_shareholder(uuid, text, text, bigint, date) to authenticated, service_role;

-- ── 4. Delete a shareholder ────────────────────────────────────────────────────────────────
create or replace function public.delete_shareholder(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted boolean;
  v_type    text;
  v_tenant  uuid := public.current_tenant_id();
begin
  /* R-1851: §17c guard + register role + Pvt Ltd only (production/CLAUDE.md). */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can change the share capital register' using errcode = '42501';
  end if;
  select business_type into v_type from public.tenants where id = v_tenant;
  if v_type is not null and v_type <> 'pvt_ltd' then
    raise exception 'Share capital is for a Pvt Ltd company — set the business type in Settings → Company first.';
  end if;
  delete from public.company_shareholders where id = p_id and tenant_id = v_tenant;
  if not found then raise exception 'That shareholder is not in your company.'; end if;
end;
$$;
revoke all on function public.delete_shareholder(uuid) from public, anon;
grant execute on function public.delete_shareholder(uuid) to authenticated, service_role;

commit;
