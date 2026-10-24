-- deploy-peek: exists(select 1 from information_schema.columns where table_schema='public' and table_name='company_directors' and column_name='kyc_details_changed_on')
-- deploy-key: r1857directorkycchange
-- 20261024234500_r1857_director_kyc_change.sql
--
-- R-1857 (epic R-1841, Phase 4 — compliance per person): when a director's mobile or email
-- changes, DIR-3 KYC Web is due within 30 days.
--
-- Source: Rule 12A(2) of the Companies (Appointment and Qualification of Directors) Rules, 2014,
-- as substituted by G.S.R. 943(E) dated 31 Dec 2025 (in force 31 Mar 2026): "in the event of
-- change in his personal mobile number, email address or residential address" the DIN holder
-- files DIR-3 KYC Web within thirty days of the change. (Text as reproduced at
-- https://taxguru.in/?p=1014465 and ICAI CLCGC 02-01-2026; CA/CS confirm step on the card.)
--
-- ══ THE DATA ═══════════════════════════════════════════════════════════════════════════
--   company_directors.kyc_details_changed_on — the IST day save_company_director saw a NEW
--   email or phone for an existing director. The Compliance Calendar (lib/compliance/
--   obligations.ts personObligations) turns it into a "DIR-3 KYC Web — update <name>'s details,
--   due +30 days" row, which also reaches Today and the reminder mail. Not a change: adding a
--   director, editing other fields, a masked value sent back by a role that cannot see the
--   contact (R-1009 — the stored one is kept), and clearing a value (nothing new to file).
--   Set only by the function (authenticated has no direct write on the table — R-1850).
--
-- save_company_director keeps its signature and every R-1850 rule (§17c guard, roles owner /
-- manager / accountant, Pvt Ltd only, DIN / PAN / dates / KYC year / contact checks); the only
-- new lines are marked R-1857. Proof: supabase/tests/r1857_director_kyc_change.test.sql (one
-- rollback) and the unchanged r1850_company_directors.test.sql.

begin;

alter table public.company_directors add column if not exists kyc_details_changed_on date;

comment on column public.company_directors.kyc_details_changed_on is
  'R-1857: IST day a new email / phone was saved for this director — DIR-3 KYC Web due within 30 days (Rule 12A(2)).';

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
  v_changed  date;
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

  /* R-1857: a NEW email or phone (after the masked value is resolved) → DIR-3 KYC Web within
     30 days (Rule 12A(2)). Clearing one is not a new detail to file. */
  v_changed := v_row.kyc_details_changed_on;
  if (v_email is not null and lower(v_email) is distinct from lower(v_row.email))
     or (v_phone is not null and v_phone is distinct from v_row.phone) then
    v_changed := (now() at time zone 'Asia/Kolkata')::date;
  end if;

  update public.company_directors
     set name = v_name, din = v_din, pan = v_pan, designation = v_desig,
         appointed_on = p_appointed_on, ceased_on = p_ceased_on, dsc_expiry = p_dsc_expiry,
         last_kyc_year = p_last_kyc_year, email = v_email, phone = v_phone,
         kyc_details_changed_on = v_changed, updated_at = now()
   where id = p_id;
  return p_id;
end;
$$;

revoke all on function public.save_company_director(uuid, text, text, text, text, date, date, date, integer, text, text) from public, anon;
grant execute on function public.save_company_director(uuid, text, text, text, text, date, date, date, integer, text, text) to authenticated, service_role;

commit;
