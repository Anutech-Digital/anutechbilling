-- R-724 attack test — storage buckets follow ROLES, not just the tenant folder.
-- Migration: 20261011133000_r724_storage_roles.sql (public.storage_object_allowed + bucket policies).
--
-- Before the fix every bucket policy only checked "first folder = your tenant", so a SALES login
-- read KYC / salary files, vendor bills, reimbursement receipts, payment receipts and TDS
-- certificates with its own token, and could overwrite {tenant}/_enroll/{colleague}.jpg — the
-- face the attendance check compares against — and then clock in as that colleague.
-- This file FAILS on the old policies (case 1) and PASSES on the new ones.
--
--   1. sales: sees NO employee-docs / documents / tds-certificates object of its tenant that it
--      did not upload itself, and no colleague's selfie or enrol photo.
--   2. sales: cannot insert KYC, reimbursement, payment-receipt, vault or TDS files.
--   3. sales: cannot write a colleague's selfie, ANY _enroll photo (its own too — server only),
--      and an UPDATE of a colleague's enrol photo changes 0 rows.
--   4. sales: its OWN selfie path works (insert + read back), and only its own.
--   5. sales: a project-cost bill (vendor-bills/) and a bug-report screenshot (feedback/) can be
--      uploaded, and read back only because it uploaded them.
--   6. owner sees everything; accountant reads + writes employee docs, sees money files but not the
--      owner/manager vault; billing sees bills / reimbursements / receipts but not KYC.
--   7. another tenant's owner: nothing in this tenant, cannot insert into it.
--   8. delete: sales deletes 0 employee-docs; the accountant can delete an employee document.
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.

begin;

insert into auth.users (id, email) values
  ('c7240000-0000-0000-0000-0000000000a1', 'r724-owner@example.test'),
  ('c7240000-0000-0000-0000-0000000000a2', 'r724-acct@example.test'),
  ('c7240000-0000-0000-0000-0000000000a3', 'r724-sales@example.test'),
  ('c7240000-0000-0000-0000-0000000000a4', 'r724-colleague@example.test'),
  ('c7240000-0000-0000-0000-0000000000a5', 'r724-billing@example.test'),
  ('c7240000-0000-0000-0000-0000000000b1', 'r724-other-owner@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c7240000-0000-0000-0000-0000000000f0', 'R724 T',  'r724@example.test',  '07', 'R724'),
  ('c7240000-0000-0000-0000-0000000000f1', 'R724 T2', 'r724b@example.test', '07', 'R72B');

insert into public.employees (id, tenant_id, name) values
  ('c7240000-0000-0000-0000-0000000000e3', 'c7240000-0000-0000-0000-0000000000f0', 'R724 Sales Emp'),
  ('c7240000-0000-0000-0000-0000000000e4', 'c7240000-0000-0000-0000-0000000000f0', 'R724 Colleague Emp');

insert into public.users (id, tenant_id, email, full_name, role, is_active, employee_id) values
  ('c7240000-0000-0000-0000-0000000000a1', 'c7240000-0000-0000-0000-0000000000f0', 'r724-owner@example.test',       'R724 Owner',     'owner',      true, null),
  ('c7240000-0000-0000-0000-0000000000a2', 'c7240000-0000-0000-0000-0000000000f0', 'r724-acct@example.test',        'R724 Acct',      'accountant', true, null),
  ('c7240000-0000-0000-0000-0000000000a3', 'c7240000-0000-0000-0000-0000000000f0', 'r724-sales@example.test',       'R724 Sales',     'sales',      true, 'c7240000-0000-0000-0000-0000000000e3'),
  ('c7240000-0000-0000-0000-0000000000a4', 'c7240000-0000-0000-0000-0000000000f0', 'r724-colleague@example.test',   'R724 Colleague', 'sales',      true, 'c7240000-0000-0000-0000-0000000000e4'),
  ('c7240000-0000-0000-0000-0000000000a5', 'c7240000-0000-0000-0000-0000000000f0', 'r724-billing@example.test',     'R724 Billing',   'billing',    true, null),
  ('c7240000-0000-0000-0000-0000000000b1', 'c7240000-0000-0000-0000-0000000000f1', 'r724-other-owner@example.test', 'R724 Other',     'owner',      true, null);

-- Files that already exist in tenant T (as the server / their uploader would have stored them).
insert into storage.objects (bucket_id, name, owner) values
  ('employee-docs',      'c7240000-0000-0000-0000-0000000000f0/c7240000-0000-0000-0000-0000000000e4/kyc-aadhaar.pdf', 'c7240000-0000-0000-0000-0000000000a1'),
  ('employee-docs',      'c7240000-0000-0000-0000-0000000000f0/vendor-bills/b1-bill.pdf',        'c7240000-0000-0000-0000-0000000000a2'),
  ('employee-docs',      'c7240000-0000-0000-0000-0000000000f0/reimbursements/r1-receipt.pdf',   'c7240000-0000-0000-0000-0000000000a2'),
  ('documents',          'c7240000-0000-0000-0000-0000000000f0/v1-gst-certificate.pdf',          null),
  ('documents',          'c7240000-0000-0000-0000-0000000000f0/payments/p1-utr.png',             null),
  ('documents',          'c7240000-0000-0000-0000-0000000000f0/inbound-bills/m1-invoice.pdf',    null),
  ('documents',          'c7240000-0000-0000-0000-0000000000f0/feedback/fb1/s1-owner.png',       'c7240000-0000-0000-0000-0000000000a1'),
  ('tds-certificates',   'c7240000-0000-0000-0000-0000000000f0/t1/16a.pdf',                      'c7240000-0000-0000-0000-0000000000a2'),
  ('attendance-selfies', 'c7240000-0000-0000-0000-0000000000f0/2026-10-11/c7240000-0000-0000-0000-0000000000e4_in.jpg', null),
  ('attendance-selfies', 'c7240000-0000-0000-0000-0000000000f0/_enroll/c7240000-0000-0000-0000-0000000000e4.jpg',       null),
  ('attendance-selfies', 'c7240000-0000-0000-0000-0000000000f0/_enroll/c7240000-0000-0000-0000-0000000000e3.jpg',       null);

-- Helper: true when an INSERT of this object is refused by RLS for the current caller.
create function pg_temp.r724_insert_refused(p_bucket text, p_name text, p_owner uuid) returns boolean
language plpgsql as $$
begin
  insert into storage.objects (bucket_id, name, owner) values (p_bucket, p_name, p_owner);
  return false;
exception when insufficient_privilege then
  return true;
end $$;

create function pg_temp.r724_seen(p_bucket text, p_tenant text) returns int
language sql as $$
  select count(*)::int from storage.objects where bucket_id = p_bucket and name like p_tenant || '/%'
$$;

grant execute on function pg_temp.r724_insert_refused(text, text, uuid) to authenticated;
grant execute on function pg_temp.r724_seen(text, text) to authenticated;

set local role authenticated;

-- ── 1–5. sales ──────────────────────────────────────────────────────────────────────
do $$
declare
  t    text := 'c7240000-0000-0000-0000-0000000000f0';
  me   uuid := 'c7240000-0000-0000-0000-0000000000a3';
  e3   text := 'c7240000-0000-0000-0000-0000000000e3';
  e4   text := 'c7240000-0000-0000-0000-0000000000e4';
  v_n  int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', me, 'role', 'authenticated')::text, true);

  -- 1. reads
  v_n := pg_temp.r724_seen('employee-docs', t);
  if v_n <> 0 then raise exception 'FAIL 1: sales sees % employee-docs files (KYC / bills / receipts), expected 0', v_n; end if;
  v_n := pg_temp.r724_seen('documents', t);
  if v_n <> 0 then raise exception 'FAIL 1: sales sees % documents files (vault / payment receipts / inbound bills / others'' screenshots), expected 0', v_n; end if;
  v_n := pg_temp.r724_seen('tds-certificates', t);
  if v_n <> 0 then raise exception 'FAIL 1: sales sees % TDS certificates, expected 0', v_n; end if;
  v_n := pg_temp.r724_seen('attendance-selfies', t);
  if v_n <> 0 then raise exception 'FAIL 1: sales sees % selfie / enrol photos of colleagues, expected 0', v_n; end if;
  raise notice 'PASS 1: sales reads no money / HR / colleague files';

  -- 2. inserts into money / HR places
  if not pg_temp.r724_insert_refused('employee-docs', t || '/' || e4 || '/fake-kyc.pdf', me) then
    raise exception 'FAIL 2: sales uploaded into a colleague''s employee-docs folder'; end if;
  if not pg_temp.r724_insert_refused('employee-docs', t || '/' || e3 || '/own-kyc.pdf', me) then
    raise exception 'FAIL 2: sales uploaded into employee-docs (KYC is HR only)'; end if;
  if not pg_temp.r724_insert_refused('employee-docs', t || '/reimbursements/x-receipt.pdf', me) then
    raise exception 'FAIL 2: sales uploaded a reimbursement receipt'; end if;
  if not pg_temp.r724_insert_refused('documents', t || '/payments/x-utr.png', me) then
    raise exception 'FAIL 2: sales uploaded a payment receipt'; end if;
  if not pg_temp.r724_insert_refused('documents', t || '/x-vault.pdf', me) then
    raise exception 'FAIL 2: sales uploaded into the company documents vault'; end if;
  if not pg_temp.r724_insert_refused('tds-certificates', t || '/t9/x.pdf', me) then
    raise exception 'FAIL 2: sales uploaded a TDS certificate'; end if;
  raise notice 'PASS 2: sales cannot upload HR / money files';

  -- 3. selfies + face enrolment of others
  if not pg_temp.r724_insert_refused('attendance-selfies', t || '/2026-10-12/' || e4 || '_in.jpg', me) then
    raise exception 'FAIL 3: sales wrote a colleague''s attendance selfie'; end if;
  if not pg_temp.r724_insert_refused('attendance-selfies', t || '/_enroll/x' || e4 || '.jpg', me) then
    raise exception 'FAIL 3: sales wrote into _enroll'; end if;
  if not pg_temp.r724_insert_refused('attendance-selfies', t || '/_enroll/' || e3 || '-2.jpg', me) then
    raise exception 'FAIL 3: sales wrote its own _enroll photo directly (server only)'; end if;
  update storage.objects set metadata = '{"r724":"swapped"}'::jsonb
   where bucket_id = 'attendance-selfies' and name = t || '/_enroll/' || e4 || '.jpg';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 3: sales overwrote a colleague''s enrol photo (% rows) — clock-in as them', v_n; end if;
  update storage.objects set metadata = '{"r724":"swapped"}'::jsonb
   where bucket_id = 'attendance-selfies' and name = t || '/_enroll/' || e3 || '.jpg';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 3: sales replaced its own enrol photo directly (% rows) — server only', v_n; end if;
  raise notice 'PASS 3: no colleague selfie, no _enroll write';

  -- 4. own selfie path
  if pg_temp.r724_insert_refused('attendance-selfies', t || '/2026-10-12/' || e3 || '_in.jpg', me) then
    raise exception 'FAIL 4: sales could not upload its OWN selfie (over-block)'; end if;
  update storage.objects set metadata = '{"r724":"retake"}'::jsonb
   where bucket_id = 'attendance-selfies' and name = t || '/2026-10-12/' || e3 || '_in.jpg';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 4: sales could not replace its OWN selfie (% rows, upsert needs it)', v_n; end if;
  v_n := pg_temp.r724_seen('attendance-selfies', t);
  if v_n <> 1 then raise exception 'FAIL 4: sales sees % selfies, expected exactly its own 1', v_n; end if;
  raise notice 'PASS 4: own selfie upload + re-take + read back';

  -- 5. drop-box folders: project cost bill + bug-report screenshot
  if pg_temp.r724_insert_refused('employee-docs', t || '/vendor-bills/s1-project-cost.pdf', me) then
    raise exception 'FAIL 5: sales could not attach a bill to a project cost (over-block)'; end if;
  if pg_temp.r724_insert_refused('documents', t || '/feedback/fb2/s2-sales.png', me) then
    raise exception 'FAIL 5: sales could not attach a bug-report screenshot (over-block)'; end if;
  v_n := pg_temp.r724_seen('employee-docs', t);
  if v_n <> 1 then raise exception 'FAIL 5: sales sees % employee-docs files, expected only its own bill', v_n; end if;
  v_n := pg_temp.r724_seen('documents', t);
  if v_n <> 1 then raise exception 'FAIL 5: sales sees % documents files, expected only its own screenshot', v_n; end if;
  if not pg_temp.r724_insert_refused('employee-docs', t || '/vendor-bills/s2-spoof.pdf', 'c7240000-0000-0000-0000-0000000000a2') then
    raise exception 'FAIL 5: sales uploaded a bill claiming another uploader'; end if;
  raise notice 'PASS 5: project bill + screenshot upload, read back only own';
end $$;

-- ── 6. owner / accountant / billing ─────────────────────────────────────────────────
do $$
declare
  t    text := 'c7240000-0000-0000-0000-0000000000f0';
  e4   text := 'c7240000-0000-0000-0000-0000000000e4';
  v_n  int;
begin
  -- owner
  perform set_config('request.jwt.claims', json_build_object('sub', 'c7240000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  v_n := pg_temp.r724_seen('employee-docs', t);
  if v_n <> 4 then raise exception 'FAIL 6: owner sees % employee-docs files, expected 4', v_n; end if;
  v_n := pg_temp.r724_seen('documents', t);
  if v_n <> 5 then raise exception 'FAIL 6: owner sees % documents files, expected 5', v_n; end if;
  v_n := pg_temp.r724_seen('attendance-selfies', t);
  if v_n <> 4 then raise exception 'FAIL 6: owner sees % selfie / enrol photos, expected 4', v_n; end if;
  v_n := pg_temp.r724_seen('tds-certificates', t);
  if v_n <> 1 then raise exception 'FAIL 6: owner sees % TDS certificates, expected 1', v_n; end if;
  if pg_temp.r724_insert_refused('documents', t || '/v2-vault.pdf', 'c7240000-0000-0000-0000-0000000000a1') then
    raise exception 'FAIL 6: owner could not add to the documents vault'; end if;
  if not pg_temp.r724_insert_refused('attendance-selfies', t || '/_enroll/' || e4 || '-x.jpg', 'c7240000-0000-0000-0000-0000000000a1') then
    raise exception 'FAIL 6: owner wrote _enroll directly (server only — the enrol route does it)'; end if;
  raise notice 'PASS 6a: owner sees every file of the workspace';

  -- accountant
  perform set_config('request.jwt.claims', json_build_object('sub', 'c7240000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);
  v_n := pg_temp.r724_seen('employee-docs', t);
  if v_n <> 4 then raise exception 'FAIL 6: accountant sees % employee-docs files, expected 4', v_n; end if;
  if pg_temp.r724_insert_refused('employee-docs', t || '/' || e4 || '/a1-salary-slip.pdf', 'c7240000-0000-0000-0000-0000000000a2') then
    raise exception 'FAIL 6: accountant could not upload an employee document'; end if;
  if pg_temp.r724_insert_refused('employee-docs', t || '/reimbursements/a2-receipt.pdf', 'c7240000-0000-0000-0000-0000000000a2') then
    raise exception 'FAIL 6: accountant could not upload a reimbursement receipt'; end if;
  v_n := pg_temp.r724_seen('documents', t);   -- payments + inbound-bills (not vault, not screenshots)
  if v_n <> 2 then raise exception 'FAIL 6: accountant sees % documents files, expected 2 (receipt + inbound bill)', v_n; end if;
  v_n := pg_temp.r724_seen('tds-certificates', t);
  if v_n <> 1 then raise exception 'FAIL 6: accountant sees % TDS certificates, expected 1', v_n; end if;
  raise notice 'PASS 6b: accountant reads + writes HR and money files';

  -- billing
  perform set_config('request.jwt.claims', json_build_object('sub', 'c7240000-0000-0000-0000-0000000000a5', 'role', 'authenticated')::text, true);
  v_n := pg_temp.r724_seen('employee-docs', t);   -- 2 vendor bills + 2 reimbursement receipts, no KYC / salary slip
  if v_n <> 4 then raise exception 'FAIL 6: billing sees % employee-docs files, expected 4 (bills + receipts only)', v_n; end if;
  select count(*) into v_n from storage.objects
   where bucket_id = 'employee-docs' and name like t || '/' || e4 || '/%';
  if v_n <> 0 then raise exception 'FAIL 6: billing sees % KYC / salary files, expected 0', v_n; end if;
  v_n := pg_temp.r724_seen('documents', t);
  if v_n <> 2 then raise exception 'FAIL 6: billing sees % documents files, expected 2', v_n; end if;
  raise notice 'PASS 6c: billing sees bills / receipts, not KYC';
end $$;

-- ── 7. other tenant's owner ─────────────────────────────────────────────────────────
do $$
declare
  t    text := 'c7240000-0000-0000-0000-0000000000f0';
  v_n  int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c7240000-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text, true);
  select count(*) into v_n from storage.objects where name like t || '/%';
  if v_n <> 0 then raise exception 'FAIL 7: another tenant''s owner sees % files of this tenant', v_n; end if;
  if not pg_temp.r724_insert_refused('employee-docs', t || '/vendor-bills/evil.pdf', 'c7240000-0000-0000-0000-0000000000b1') then
    raise exception 'FAIL 7: another tenant''s owner uploaded into this tenant'; end if;
  if not pg_temp.r724_insert_refused('documents', t || '/feedback/x/evil.png', 'c7240000-0000-0000-0000-0000000000b1') then
    raise exception 'FAIL 7: another tenant''s owner uploaded a screenshot into this tenant'; end if;
  raise notice 'PASS 7: other tenant gets nothing';
end $$;

-- ── 8. delete ───────────────────────────────────────────────────────────────────────
do $$ begin perform set_config('storage.allow_delete_query', 'true', true); end $$;
do $$
declare
  t    text := 'c7240000-0000-0000-0000-0000000000f0';
  e4   text := 'c7240000-0000-0000-0000-0000000000e4';
  v_n  int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c7240000-0000-0000-0000-0000000000a3', 'role', 'authenticated')::text, true);
  delete from storage.objects where bucket_id in ('employee-docs', 'documents', 'attendance-selfies')
     and name like t || '/%' and coalesce(owner::text, '') <> 'c7240000-0000-0000-0000-0000000000a3';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 8: sales deleted % HR / money / colleague files', v_n; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', 'c7240000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);
  delete from storage.objects where bucket_id = 'employee-docs' and name = t || '/' || e4 || '/a1-salary-slip.pdf';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 8: accountant could not delete an employee document (% rows)', v_n; end if;
  raise notice 'PASS 8: delete follows the same roles';
end $$;

reset role;
rollback;
