-- deploy-peek: (to_regprocedure('public.storage_object_allowed(text,text,text,uuid)') is not null and exists(select 1 from pg_policy where polrelid = to_regclass('storage.objects') and polname = 'r724 private files select') and not exists(select 1 from pg_policy where polrelid = to_regclass('storage.objects') and polname = 'employee-docs tenant read'))
-- deploy-key: r724storage
-- deploy-user: postgres
-- 20261011143000_r724_storage_roles.sql
--
-- R-724 (P1 SECURITY, audit 10 Oct 2026): private files follow the caller's ROLE, not only the
-- tenant folder.
--
-- ══ WHAT WAS OPEN (20261002190000_storage_policies.sql) ════════════════════════════════════
--
--   Every private-bucket policy was "first folder = your tenant". So with the token the app
--   already gives every member, a SALES / support / delivery login could, straight through the
--   storage API:
--     • list + download employee-docs: KYC, salary documents, vendor bills, reimbursement receipts;
--     • list + download documents: the owner's document vault, payment receipts, inbound bills,
--       everyone's bug-report screenshots; and tds-certificates (Form 16A);
--     • overwrite {tenant}/_enroll/{colleagueId}.jpg — the reference face the attendance check
--       compares against — bypassing the owner check in /api/attendance/face/enroll, and then
--       clock in as that colleague; or write a colleague's daily selfie.
--   documents + tds-certificates policies were also `to public`.
--   supabase/tests/r724_storage_roles.test.sql fails on those policies ("sales sees 3
--   employee-docs files").
--
-- ══ WHAT CHANGES ═══════════════════════════════════════════════════════════════════════════
--
--   One rule function, public.storage_object_allowed(bucket, name, op, owner), and four
--   policies `to authenticated` (select / insert / update / delete) for the four private
--   buckets. Every case still needs "first folder = your tenant" AND an active login (R-722).
--   Roles: money = owner, manager, accountant, billing · HR = owner, manager, accountant
--   (salary roles) · OM = owner, manager.
--
--   employee-docs
--     {t}/{employeeId}/…           KYC, salary docs   HR: read, upload, delete.  Others: nothing.
--     {t}/reimbursements/…          receipts           money: read, upload.       HR: delete.
--     {t}/vendor-bills/…            bill files         money: read, upload.       HR: delete.
--                                                      Any member may upload a bill it owns (a
--                                                      project cost from Projects) and read back
--                                                      only what it uploaded.
--   attendance-selfies
--     {t}/{date}/{employeeId}_in|out.jpg               the employee linked to the login: upload +
--                                                      re-take + read its OWN; money roles read all
--                                                      (Attendance Register = owner/manager/billing,
--                                                      payroll = + accountant).
--     {t}/_enroll/{employeeId}.jpg                     NO direct write for anyone — only the server
--                                                      (service_role) after the enrol route's
--                                                      owner/self check. HR may read.
--   documents
--     {t}/{file}  (vault) and anything unknown         OM: read, upload, replace, delete.
--     {t}/payments/…, {t}/inbound-bills/…              money: read. Written by the server only.
--     {t}/feedback/…  (bug-report screenshots)         any member uploads its own; OM + uploader read.
--   tds-certificates                                   money: everything.
--   logos (public bucket) is unchanged.
--
--   App routes that wrote other people's paths with the browser token now use the server
--   client after their own checks: /api/attendance/face/enroll (_enroll), /api/attendance/mark
--   (kiosk selfie after the PIN RPC), /api/attendance/self (reads the caller's own _enroll).
--
--   service_role keeps zzz_service_role_all (Cloud SQL: no BYPASSRLS). The demo-visitor
--   RESTRICTIVE policies are untouched.
--
-- Runs as postgres on Cloud SQL (member of supabase_storage_admin, which owns storage.objects),
-- same as 20261002190000 / 20261009220100. Idempotent.
-- Test: supabase/tests/r724_storage_roles.test.sql (rolled back).

begin;

create or replace function public.storage_object_allowed(p_bucket text, p_name text, p_op text, p_owner uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_uid    uuid := auth.uid();
  v_tenant uuid := public.current_tenant_id();
  v_parts  text[];
  v_n      int;
  v_folder text;
  v_file   text;
  v_role   text;
  v_emp    uuid;
  v_mine   boolean;
  v_money  boolean;
  v_hr     boolean;
  v_om     boolean;
  v_own    boolean;
begin
  /* R-724. The one rule for who may touch a file in a private bucket. Folder 1 is always the
     caller's tenant; the rest depends on the bucket, the folder and the caller's role. */
  if v_uid is null or v_tenant is null or p_name is null or p_op not in ('select', 'insert', 'update', 'delete') then
    return false;
  end if;

  v_parts := string_to_array(p_name, '/');
  v_n     := coalesce(cardinality(v_parts), 0);
  if v_n < 2 or v_parts[1] <> v_tenant::text or '' = any (v_parts) or '.' = any (v_parts) or '..' = any (v_parts) then
    return false;
  end if;
  v_folder := case when v_n >= 3 then v_parts[2] end;
  v_file   := v_parts[v_n];

  select u.role::text, u.employee_id into v_role, v_emp
    from public.users u where u.id = v_uid and u.is_active;
  if v_role is null then return false; end if;

  v_money := v_role in ('owner', 'manager', 'accountant', 'billing');
  v_hr    := v_role in ('owner', 'manager', 'accountant');
  v_om    := v_role in ('owner', 'manager');
  v_mine  := p_owner is not null and p_owner = v_uid;

  if p_bucket = 'employee-docs' then
    if v_folder in ('vendor-bills', 'reimbursements') then
      return case p_op
        when 'select' then v_money or v_mine
        when 'insert' then v_money or (v_folder = 'vendor-bills' and v_mine)
        when 'delete' then v_hr
        else false
      end;
    end if;
    -- {t}/{employeeId}/… — KYC, salary, letters.
    return case p_op when 'update' then false else v_hr end;

  elsif p_bucket = 'attendance-selfies' then
    if v_folder = '_enroll' then
      return p_op = 'select' and v_hr;
    end if;
    v_own := v_n = 3 and v_emp is not null and left(v_file, 37) = v_emp::text || '_';
    return case p_op
      when 'select' then v_money or v_own
      when 'insert' then v_own
      when 'update' then v_own
      else false
    end;

  elsif p_bucket = 'documents' then
    if v_folder = 'feedback' then
      return case p_op
        when 'select' then v_om or v_mine
        when 'insert' then v_mine
        else false
      end;
    elsif v_folder in ('payments', 'inbound-bills') then
      return p_op = 'select' and v_money;
    end if;
    return v_om;

  elsif p_bucket = 'tds-certificates' then
    return v_money;
  end if;

  return false;
end;
$function$;

comment on function public.storage_object_allowed(text, text, text, uuid) is
  'R-724: who may select/insert/update/delete a file in employee-docs, attendance-selfies, documents and tds-certificates — tenant folder AND role (and own employee / own upload where the app needs it). Used by the "r724 private files *" policies on storage.objects.';

revoke all on function public.storage_object_allowed(text, text, text, uuid) from public, anon;
grant execute on function public.storage_object_allowed(text, text, text, uuid) to authenticated, service_role, supabase_storage_admin;
grant usage on schema public to supabase_storage_admin;

set local role supabase_storage_admin;

-- The tenant-only policies this replaces.
drop policy if exists "att selfies read"              on storage.objects;
drop policy if exists "att selfies insert"            on storage.objects;
drop policy if exists "att selfies update"            on storage.objects;
drop policy if exists "documents_select_own_tenant"   on storage.objects;
drop policy if exists "documents_insert_own_tenant"   on storage.objects;
drop policy if exists "documents_update_own_tenant"   on storage.objects;
drop policy if exists "documents_delete_own_tenant"   on storage.objects;
drop policy if exists "employee-docs tenant read"     on storage.objects;
drop policy if exists "employee-docs tenant insert"   on storage.objects;
drop policy if exists "employee-docs tenant delete"   on storage.objects;
drop policy if exists "tds_cert_select_own_tenant"    on storage.objects;
drop policy if exists "tds_cert_insert_own_tenant"    on storage.objects;
drop policy if exists "tds_cert_update_own_tenant"    on storage.objects;
drop policy if exists "tds_cert_delete_own_tenant"    on storage.objects;

drop policy if exists "r724 private files select" on storage.objects;
create policy "r724 private files select" on storage.objects for select to authenticated
  using (bucket_id in ('employee-docs', 'attendance-selfies', 'documents', 'tds-certificates')
         and public.storage_object_allowed(bucket_id, name, 'select', owner));

drop policy if exists "r724 private files insert" on storage.objects;
create policy "r724 private files insert" on storage.objects for insert to authenticated
  with check (bucket_id in ('employee-docs', 'attendance-selfies', 'documents', 'tds-certificates')
              and public.storage_object_allowed(bucket_id, name, 'insert', owner));

drop policy if exists "r724 private files update" on storage.objects;
create policy "r724 private files update" on storage.objects for update to authenticated
  using (bucket_id in ('employee-docs', 'attendance-selfies', 'documents', 'tds-certificates')
         and public.storage_object_allowed(bucket_id, name, 'update', owner))
  with check (bucket_id in ('employee-docs', 'attendance-selfies', 'documents', 'tds-certificates')
              and public.storage_object_allowed(bucket_id, name, 'update', owner));

drop policy if exists "r724 private files delete" on storage.objects;
create policy "r724 private files delete" on storage.objects for delete to authenticated
  using (bucket_id in ('employee-docs', 'attendance-selfies', 'documents', 'tds-certificates')
         and public.storage_object_allowed(bucket_id, name, 'delete', owner));

-- Server routes (service key) keep full access — Cloud SQL has no BYPASSRLS.
drop policy if exists zzz_service_role_all on storage.objects;
create policy zzz_service_role_all on storage.objects as permissive for all to service_role using (true) with check (true);

reset role;
commit;
