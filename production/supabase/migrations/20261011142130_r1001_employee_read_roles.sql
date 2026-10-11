-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.my_employee_profile()') and prosrc like '%R-1001%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.my_employee_link_choices()') and prosrc like '%R-1001%') and exists(select 1 from pg_policy where polrelid = to_regclass('public.employees') and polname = 'employees_read_roles') and exists(select 1 from pg_policy where polrelid = to_regclass('public.employee_loans') and polname = 'employee_loans_read_roles') and exists(select 1 from pg_policy where polrelid = to_regclass('public.employee_loan_repayments') and polname = 'employee_loan_repayments_read_roles') and exists(select 1 from pg_policy where polrelid = to_regclass('public.employee_documents') and polname = 'employee_documents_read_roles')
-- deploy-key: r1001employees
-- 20261011142130_r1001_employee_read_roles.sql
--
-- R-1001 (P1 SECURITY, launch blocker, data-leak audit 11 Oct 2026): employee personal data
-- is readable by owner, manager and accountant only.
--
-- ══ WHAT WAS OPEN, measured on the local DB 11 Oct ═══════════════════════════════
--
--   employees                 SELECT "tenant isolation read" (baseline) = tenant only. Any
--                             member — sales, support, delivery, billing — read every
--                             colleague's salary, PAN, PF/ESI no., phone, address, date of
--                             birth and emergency contact (pin_hash was already column-hidden).
--   employee_loans            SELECT "tenant isolation read" = tenant only.
--   employee_loan_repayments  SELECT/INSERT/DELETE "tenant isolation …" = tenant only.
--   employee_documents        ONE "tenant all" policy (ALL commands) = tenant only: anyone
--                             could list, add and delete a colleague's documents.
--   (supabase/tests/r1001_employee_read.test.sql on the old policies: sales, support,
--   delivery, billing, sales_senior and partner_agent all read the victim's row, loan,
--   repayment and document.)
--
-- ══ ROLE TABLE (Pardeep's decision via the Super Manager, card R-1001) ════════════
--
--   role            employees  loans  repayments  documents   own row (my_employee_profile)
--   owner           read       read   read        read+write  yes
--   manager         read       read   read        read+write  yes
--   accountant      read       read   read        read+write  yes
--   billing         —          —      —           —           yes
--   sales           —          —      —           —           yes
--   sales_senior    —          —      —           —           yes
--   support         —          —      —           —           yes
--   delivery        —          —      —           —           yes
--   partner_agent   —          —      —           —           yes
--   inactive user / no company (null current_tenant_id())  — nothing anywhere
--   service_role / direct DB session (R-454 trust rule) — trusted: zzz_service_role_all on
--     Cloud SQL (kept; re-created here only if missing), BYPASSRLS / owner locally.
--
--   Every read policy is (tenant_id = current_tenant_id() AND current_user_has_role(...)),
--   so the tenant must match AND the role must be one of the three. A caller with no
--   company has a null current_tenant_id() and gets no rows (fail closed).
--
--   Writes: employees and employee_loans write policies are NOT changed here (R-719 / role
--   hardening own them). employee_documents writes (its old ALL policy) become owner /
--   manager / accountant too — the same three as employees writes. employee_loan_repayments
--   INSERT/DELETE stay tenant-only (pay_salary and the loan screens write them; out of scope).
--
-- ══ WHAT EVERYONE ELSE USES INSTEAD ══════════════════════════════════════════════
--
--   my_employee_profile()       SECURITY DEFINER, jsonb: the CALLER's own linked employee
--                               row (users.employee_id), safe columns only — never pin_hash,
--                               never the owner's private notes. null when not linked.
--   my_employee_link_choices()  SECURITY DEFINER, jsonb [{id, name}]: the first-time "Select
--                               your profile" list on My Attendance — active, not linked to
--                               another login, and the employee's e-mail is empty or equals
--                               the caller's (exactly what set_my_employee accepts). Names only.
--   Server routes (attendance self / network / face enroll) read the caller's own row through
--   the server client scoped to tenant + linked employee in code. The kiosk is run logged in
--   as the owner and the PIN is checked inside mark_attendance (definer) — unchanged.
--
-- Storage bucket employee-docs: R-724, not touched here.
-- Staging: the deploy script rewrites auth.role() -> public.current_request_role() (R-161).
-- Test: supabase/tests/r1001_employee_read.test.sql (rolled back).

begin;

-- ── employees ───────────────────────────────────────────────────────────────────
drop policy if exists "tenant isolation read" on public.employees;
drop policy if exists employees_read_roles on public.employees;
create policy employees_read_roles on public.employees
  for select to authenticated
  using (tenant_id = public.current_tenant_id()
         and public.current_user_has_role('owner', 'manager', 'accountant'));

-- ── employee_loans ──────────────────────────────────────────────────────────────
drop policy if exists "tenant isolation read" on public.employee_loans;
drop policy if exists employee_loans_read_roles on public.employee_loans;
create policy employee_loans_read_roles on public.employee_loans
  for select to authenticated
  using (tenant_id = public.current_tenant_id()
         and public.current_user_has_role('owner', 'manager', 'accountant'));

-- ── employee_loan_repayments ────────────────────────────────────────────────────
drop policy if exists "tenant isolation read" on public.employee_loan_repayments;
drop policy if exists employee_loan_repayments_read_roles on public.employee_loan_repayments;
create policy employee_loan_repayments_read_roles on public.employee_loan_repayments
  for select to authenticated
  using (tenant_id = public.current_tenant_id()
         and public.current_user_has_role('owner', 'manager', 'accountant'));

-- ── employee_documents (the old ALL policy is split: read + write, same three roles) ──
drop policy if exists "employee_documents tenant all" on public.employee_documents;
drop policy if exists employee_documents_read_roles on public.employee_documents;
drop policy if exists employee_documents_insert_roles on public.employee_documents;
drop policy if exists employee_documents_update_roles on public.employee_documents;
drop policy if exists employee_documents_delete_roles on public.employee_documents;
create policy employee_documents_read_roles on public.employee_documents
  for select to authenticated
  using (tenant_id = public.current_tenant_id()
         and public.current_user_has_role('owner', 'manager', 'accountant'));
create policy employee_documents_insert_roles on public.employee_documents
  for insert to authenticated
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant'));
create policy employee_documents_update_roles on public.employee_documents
  for update to authenticated
  using (tenant_id = public.current_tenant_id()
         and public.current_user_has_role('owner', 'manager', 'accountant'))
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant'));
create policy employee_documents_delete_roles on public.employee_documents
  for delete to authenticated
  using (tenant_id = public.current_tenant_id()
         and public.current_user_has_role('owner', 'manager', 'accountant'));

-- ── service_role stays trusted on Cloud SQL (no BYPASSRLS there): keep / restore the
--    zzz_service_role_all policy on all four tables. Created only where a service_role
--    role exists and the policy is missing, so it never replaces an existing one.
do $$
declare t text;
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach t in array array['employees', 'employee_loans', 'employee_loan_repayments', 'employee_documents'] loop
      if not exists (select 1 from pg_policy
                      where polrelid = to_regclass('public.' || t) and polname = 'zzz_service_role_all') then
        execute format('create policy zzz_service_role_all on public.%I as permissive for all to service_role using (true) with check (true)', t);
      end if;
    end loop;
  end if;
end $$;

-- ── my_employee_profile(): the caller's OWN employee row, safe columns ────────────
create or replace function public.my_employee_profile()
 returns jsonb
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  /* R-1001: every role reads its own linked employee row here (employees SELECT is owner /
     manager / accountant only). Identity = auth.uid() -> users.employee_id, same tenant,
     active login. service_role / a direct session has no caller, so no row (R-454: nothing
     to trust it with); a caller with no company gets null. pin_hash and notes are never
     returned. */
  select jsonb_build_object(
           'id', e.id, 'tenant_id', e.tenant_id, 'name', e.name, 'designation', e.designation,
           'email', e.email, 'phone', e.phone, 'joining_date', e.joining_date,
           'date_of_birth', e.date_of_birth, 'address', e.address,
           'emergency_contact_name', e.emergency_contact_name,
           'emergency_contact_phone', e.emergency_contact_phone,
           'is_active', e.is_active, 'monthly_gross', e.monthly_gross,
           'basic_monthly', e.basic_monthly, 'da_monthly', e.da_monthly,
           'leave_allowance', e.leave_allowance, 'pan', e.pan, 'pf_no', e.pf_no, 'esi_no', e.esi_no,
           'pf_applicable', e.pf_applicable, 'esi_applicable', e.esi_applicable,
           'biometric_id', e.biometric_id, 'pin_set', e.pin_set,
           'attendance_anywhere', e.attendance_anywhere,
           'attendance_consent_at', e.attendance_consent_at,
           'attendance_consent_source', e.attendance_consent_source,
           'face_enrolled_at', e.face_enrolled_at, 'face_ref_path', e.face_ref_path)
    from public.users u
    join public.employees e on e.id = u.employee_id and e.tenant_id = u.tenant_id
   where u.id = auth.uid()
     and u.is_active
     and u.tenant_id = public.current_tenant_id()
   limit 1
$function$;

revoke all on function public.my_employee_profile() from public, anon;
grant execute on function public.my_employee_profile() to authenticated, service_role;
comment on function public.my_employee_profile() is
  'R-1001: the caller''s own linked employee row (safe columns, no pin_hash/notes) for every role.';

-- ── my_employee_link_choices(): names a not-yet-linked login may link to ──────────
create or replace function public.my_employee_link_choices()
 returns jsonb
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  /* R-1001: the "Select your profile" list on My Attendance. Same rule set_my_employee
     enforces — active employee of the caller's company, not linked to another login, e-mail
     empty or the caller's own — so it never offers a name the link would refuse. id + name
     only. No caller / no company -> empty list. */
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name) order by e.name), '[]'::jsonb)
    from public.users me
    join public.employees e on e.tenant_id = me.tenant_id
   where me.id = auth.uid()
     and me.is_active
     and me.tenant_id = public.current_tenant_id()
     and e.is_active
     and (e.email is null or btrim(e.email) = '' or lower(e.email) = lower(coalesce(me.email, '')))
     and not exists (select 1 from public.users o where o.employee_id = e.id and o.id <> me.id)
$function$;

revoke all on function public.my_employee_link_choices() from public, anon;
grant execute on function public.my_employee_link_choices() to authenticated, service_role;
comment on function public.my_employee_link_choices() is
  'R-1001: active, unlinked employees (id, name) the caller may link to via set_my_employee.';

commit;
