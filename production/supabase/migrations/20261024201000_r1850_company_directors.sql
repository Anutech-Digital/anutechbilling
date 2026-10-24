-- deploy-peek: to_regclass('public.company_directors') is not null and to_regprocedure('public.save_company_director(uuid,text,text,text,text,date,date,date,integer,text,text)') is not null and to_regprocedure('public.delete_company_director(uuid)') is not null
-- deploy-key: r1850companydirectors
-- 20261024201000_r1850_company_directors.sql
--
-- R-1850 (epic R-1841, Phase 3 — Pvt Ltd): the directors register.
--
-- A company had no record of its directors (the only list was ResellerOS's own, hard-coded in
-- lib/platform.ts and read by nothing). DIR-3 KYC per DIN, DSC expiry, director salary (R-1852),
-- director loans s.185 (R-1853) and the ROC pack (R-1858) all need one list.
--
-- ══ THE DATA ═══════════════════════════════════════════════════════════════════════════
--   company_directors — one row per director: name, DIN (8 digits, required, unique in the
--   company), PAN, designation (Director / Managing Director / Whole-time / Additional /
--   Nominee), appointed / ceased dates, DSC expiry date, last DIR-3 KYC year, email, phone.
--   "Current" is not stored: a director is current until ceased_on (one fact, one place).
--   LLP designated partners are in firm_partners (R-1847), not here.
--
--   email / phone are a person's contact: the data gateway masks them for a role without
--   can_view_contact_details (R-1009 / R-1820, contact-mask.ts CONTACT_COLUMNS). The accountant
--   can edit a director while seeing a masked value, so save_company_director KEEPS the stored
--   email / phone when it is handed a masked one (contains "•") — "••••3210" is never saved.
--
-- Writes only through the functions (no direct insert/update/delete grants). §17c guard on both
-- functions; roles owner, manager, accountant (the R-1847 register roles). Only a Pvt Ltd (or an
-- empty business type, which means Pvt Ltd — R-1842) has a directors register. Reads: same
-- company AND one of those roles. Nothing existing is changed. Proof:
-- supabase/tests/r1850_company_directors.test.sql (one rollback).

begin;

-- ── 1. The register ──────────────────────────────────────────────────────────────────────
create table if not exists public.company_directors (
  id             uuid         primary key default gen_random_uuid(),
  tenant_id      uuid         not null references public.tenants(id) on delete cascade,
  name           text         not null check (length(btrim(name)) between 1 and 200),
  din            text         not null check (din ~ '^[0-9]{8}$'),
  pan            text         check (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  designation    text         not null default 'director'
                 check (designation in ('director', 'managing_director', 'whole_time_director', 'additional_director', 'nominee_director')),
  appointed_on   date,
  ceased_on      date,
  dsc_expiry     date,
  last_kyc_year  integer      check (last_kyc_year is null or last_kyc_year between 2018 and 2100),
  email          text         check (email is null or length(email) <= 320),
  phone          text         check (phone is null or length(phone) <= 20),
  created_by     uuid,
  created_at     timestamptz  not null default now(),
  updated_at     timestamptz  not null default now(),
  constraint company_directors_ceased_after_appointed check (ceased_on is null or appointed_on is null or ceased_on >= appointed_on)
);

comment on table public.company_directors is
  'R-1850: directors of a Pvt Ltd — DIN, PAN, designation, appointed/ceased, DSC expiry, last DIR-3 KYC year, contact. Current = ceased_on is null or in the future.';

create unique index if not exists company_directors_tenant_din_uq on public.company_directors (tenant_id, din);

alter table public.company_directors enable row level security;

drop policy if exists "tenant isolation read" on public.company_directors;
drop policy if exists zzz_service_role_all on public.company_directors;
create policy "tenant isolation read" on public.company_directors for select to authenticated
  using (tenant_id = (select public.current_tenant_id())
         and (select public.current_user_has_role('owner', 'manager', 'accountant')));
-- Cloud SQL has no BYPASSRLS: the service role needs its own policy.
create policy zzz_service_role_all on public.company_directors as permissive for all to service_role
  using (true) with check (true);

revoke all on public.company_directors from anon, authenticated;
grant select on public.company_directors to authenticated;
grant select, insert, update, delete on public.company_directors to service_role;

-- ── 2. Add / edit a director ───────────────────────────────────────────────────────────────
create or replace function public.save_company_director(
  p_id             uuid,
  p_name           text,
  p_din            text,
  p_pan            text,
  p_designation    text,
  p_appointed_on   date,
  p_ceased_on      date,
  p_dsc_expiry     date,
  p_last_kyc_year  integer,
  p_email          text,
  p_phone          text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted  boolean;
  v_tenant   uuid := public.current_tenant_id();
  v_type     text;
  v_name     text := nullif(btrim(coalesce(p_name, '')), '');
  v_din      text := nullif(btrim(coalesce(p_din, '')), '');
  v_pan      text := nullif(upper(btrim(coalesce(p_pan, ''))), '');
  v_desig    text := coalesce(nullif(btrim(coalesce(p_designation, '')), ''), 'director');
  v_email    text := nullif(btrim(coalesce(p_email, '')), '');
  v_phone    text := nullif(regexp_replace(coalesce(p_phone, ''), '[\s()-]', '', 'g'), '');
  v_row      public.company_directors;
  v_id       uuid;
begin
  /* R-1850: §17c guard + register role (production/CLAUDE.md). */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can change the directors register' using errcode = '42501';
  end if;
  select business_type into v_type from public.tenants where id = v_tenant;
  if v_type is not null and v_type <> 'pvt_ltd' then
    raise exception 'The directors register is for a Pvt Ltd company — set the business type in Settings → Company first.';
  end if;

  if v_name is null then raise exception 'Enter the director''s name.'; end if;
  if length(v_name) > 200 then raise exception 'The name is too long (200 characters at most).'; end if;
  if v_din is null then raise exception 'Enter the director''s DIN (8 digits).'; end if;
  if v_din !~ '^[0-9]{8}$' then raise exception 'DIN must be 8 digits.'; end if;
  if v_pan is not null and v_pan !~ '^[A-Z]{5}[0-9]{4}[A-Z]$' then
    raise exception 'PAN must be 10 characters like ABCDE1234F (5 letters, 4 digits, 1 letter).';
  end if;
  if v_desig not in ('director', 'managing_director', 'whole_time_director', 'additional_director', 'nominee_director') then
    raise exception 'Pick a designation: Director, Managing Director, Whole-time, Additional or Nominee.';
  end if;
  if p_ceased_on is not null and p_appointed_on is not null and p_ceased_on < p_appointed_on then
    raise exception 'The cessation date cannot be before the appointment date.';
  end if;
  if p_last_kyc_year is not null and (p_last_kyc_year < 2018 or p_last_kyc_year > extract(year from now() at time zone 'Asia/Kolkata')) then
    raise exception 'Last KYC year must be between 2018 and this year.';
  end if;
  if exists (select 1 from public.company_directors
              where tenant_id = v_tenant and din = v_din and id is distinct from p_id) then
    raise exception 'DIN % is already in the directors register.', v_din;
  end if;

  if p_id is not null then
    select * into v_row from public.company_directors where id = p_id and tenant_id = v_tenant for update;
    if not found then raise exception 'That director is not in your company.'; end if;
  end if;

  -- A masked contact (R-1009: the caller cannot see the real one) keeps the stored value.
  if v_email is not null and position('•' in v_email) > 0 then v_email := v_row.email; end if;
  if v_phone is not null and position('•' in v_phone) > 0 then v_phone := v_row.phone; end if;
  if v_email is not null and (length(v_email) > 320 or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$') then
    raise exception 'Enter a valid email, e.g. name@company.in.';
  end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9]{10,15}$' then
    raise exception 'Enter a phone number of 10 to 15 digits.';
  end if;

  if p_id is null then
    insert into public.company_directors
      (tenant_id, name, din, pan, designation, appointed_on, ceased_on, dsc_expiry, last_kyc_year,
       email, phone, created_by)
    values
      (v_tenant, v_name, v_din, v_pan, v_desig, p_appointed_on, p_ceased_on, p_dsc_expiry, p_last_kyc_year,
       v_email, v_phone, auth.uid())
    returning id into v_id;
    return v_id;
  end if;

  update public.company_directors
     set name = v_name, din = v_din, pan = v_pan, designation = v_desig,
         appointed_on = p_appointed_on, ceased_on = p_ceased_on, dsc_expiry = p_dsc_expiry,
         last_kyc_year = p_last_kyc_year, email = v_email, phone = v_phone, updated_at = now()
   where id = p_id;
  return p_id;
end;
$$;

revoke all on function public.save_company_director(uuid, text, text, text, text, date, date, date, integer, text, text) from public, anon;
grant execute on function public.save_company_director(uuid, text, text, text, text, date, date, date, integer, text, text) to authenticated, service_role;

-- ── 3. Delete a director added by mistake (one who left gets a cessation date instead) ─────
create or replace function public.delete_company_director(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted  boolean;
  v_tenant   uuid := public.current_tenant_id();
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can change the directors register' using errcode = '42501';
  end if;
  delete from public.company_directors where id = p_id and tenant_id = v_tenant;
  if not found then raise exception 'That director is not in your company.'; end if;
end;
$$;

revoke all on function public.delete_company_director(uuid) from public, anon;
grant execute on function public.delete_company_director(uuid) to authenticated, service_role;

commit;
