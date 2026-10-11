\set ON_ERROR_STOP on
-- Regression test: R-712 (+ the users.email part of R-729). Migration
-- 20261011041200_r712_users_self_update.sql. Rolled back — safe anywhere.
--
-- Before R-712 every signed-up account owns its own company, and the users guard only asked
-- "is the caller an owner ANYWHERE?". With users_self_update = USING (id = auth.uid()) and no
-- WITH CHECK, one PostgREST PATCH /users?id=eq.<me> {tenant_id:<victim>} made the caller an
-- owner inside the victim company. Same hole let a deactivated owner switch themself back on,
-- let anyone point their login at any employee record (attendance in someone else's name), and
-- let anyone change a users.email — the login callback re-links a users row by email, so an
-- email copied from an invitee (or written onto the owner's row) captures that first login.
--
--   BLOCKED  owner of A moves own row to tenant B                  (the CRITICAL one)
--   BLOCKED  owner of B pulls a login of A into B with a plain PATCH (RLS: 0 rows)
--   BLOCKED  sales of A links own login to a colleague's employee record (email mismatch)
--   BLOCKED  sales of A links own login to an employee already linked to another user
--   BLOCKED  deactivated owner of A sets own is_active = true
--   BLOCKED  sales of A sets own email to a pending invitee's email
--   BLOCKED  sales of A sets own email to the owner's email
--   BLOCKED  sales of A rewrites the OWNER's email (row takeover through the callback)
--   BLOCKED  sales of A sets a teammate's employee_id
--   ALLOWED  sales of A changes own full_name
--   ALLOWED  sales of A links own employee record through set_my_employee (email matches)
--   ALLOWED  active owner of A changes a teammate's role / employee_id / email
--   ALLOWED  the service connection (no auth.uid()) moves a row between tenants

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('71200000-0000-4000-8000-000000000001', 'R712 A', 'r712-a@example.in', '07', 'R71A'),
  ('71200000-0000-4000-8000-000000000002', 'R712 B', 'r712-b@example.in', '07', 'R71B');

insert into auth.users (id, instance_id, aud, role, email) values
  ('71200000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r712-owner-a@example.in'),
  ('71200000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r712-sales-a@example.in'),
  ('71200000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r712-owner-b@example.in'),
  ('71200000-0000-4000-8000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r712-old-owner@example.in'),
  ('71200000-0000-4000-8000-00000000000e', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r712-support-a@example.in');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('71200000-0000-4000-8000-00000000000a', '71200000-0000-4000-8000-000000000001', 'r712-owner-a@example.in',   'Owner A',   'owner',   true),
  ('71200000-0000-4000-8000-00000000000b', '71200000-0000-4000-8000-000000000001', 'r712-sales-a@example.in',   'Sales A',   'sales',   true),
  ('71200000-0000-4000-8000-00000000000c', '71200000-0000-4000-8000-000000000002', 'r712-owner-b@example.in',   'Owner B',   'owner',   true),
  ('71200000-0000-4000-8000-00000000000d', '71200000-0000-4000-8000-000000000001', 'r712-old-owner@example.in', 'Old Owner', 'owner',   false),
  ('71200000-0000-4000-8000-00000000000e', '71200000-0000-4000-8000-000000000001', 'r712-support-a@example.in', 'Support A', 'support', true);

/* e1 = a colleague's record (someone else's email); e2 = the sales person's own record;
   e3 = already linked to the support login. */
insert into public.employees (id, tenant_id, name, email) values
  ('71200000-0000-4000-8000-0000000000e1', '71200000-0000-4000-8000-000000000001', 'Colleague',  'r712-colleague@example.in'),
  ('71200000-0000-4000-8000-0000000000e2', '71200000-0000-4000-8000-000000000001', 'Sales A',    'r712-sales-a@example.in'),
  ('71200000-0000-4000-8000-0000000000e3', '71200000-0000-4000-8000-000000000001', 'Support A',  null);
update public.users set employee_id = '71200000-0000-4000-8000-0000000000e3'
 where id = '71200000-0000-4000-8000-00000000000e';

/* B's owner invited someone; their first Google login should land in B. */
insert into public.team_invites (tenant_id, email, role)
  values ('71200000-0000-4000-8000-000000000002', 'r712-invitee@example.in', 'sales');

do $$
declare
  c_a        constant uuid := '71200000-0000-4000-8000-000000000001';
  c_b        constant uuid := '71200000-0000-4000-8000-000000000002';
  c_owner_a  constant uuid := '71200000-0000-4000-8000-00000000000a';
  c_sales_a  constant uuid := '71200000-0000-4000-8000-00000000000b';
  c_old      constant uuid := '71200000-0000-4000-8000-00000000000d';
  v_err  boolean; v_msg text; v_n int;
  v_t uuid; v_e uuid; v_s text; v_b boolean;
begin
  set local role authenticated;

  -- ── 1. BLOCKED: owner of A moves own row into B ───────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', c_owner_a, 'role', 'authenticated')::text, true);
  if auth.uid() <> c_owner_a then raise exception 'SETUP FAIL: impersonation did not take'; end if;
  v_err := false;
  begin
    update public.users set tenant_id = c_b where id = c_owner_a;
  exception when others then v_err := true; v_msg := sqlerrm; end;
  select tenant_id into v_t from public.users where id = c_owner_a;
  if not v_err or v_t <> c_a then
    raise exception 'FAIL 1: an owner of tenant A moved their own login into tenant B (tenant now %)', v_t;
  end if;

  -- ── 1b. BLOCKED: owner of B pulls A's sales login into B with a plain PATCH ─
  perform set_config('request.jwt.claims', json_build_object('sub', '71200000-0000-4000-8000-00000000000c', 'role', 'authenticated')::text, true);
  v_err := false; v_n := 0;
  begin
    update public.users set tenant_id = c_b where id = c_sales_a;
    get diagnostics v_n = row_count;
  exception when others then v_err := true; end;
  if v_n <> 0 then raise exception 'FAIL 1b: an owner of B moved a login of A into B with a plain PATCH'; end if;

  -- ── 2. BLOCKED: sales links own login to a colleague's employee record ──
  perform set_config('request.jwt.claims', json_build_object('sub', c_sales_a, 'role', 'authenticated')::text, true);
  v_err := false;
  begin
    update public.users set employee_id = '71200000-0000-4000-8000-0000000000e1' where id = c_sales_a;
  exception when others then v_err := true; v_msg := sqlerrm; end;
  select employee_id into v_e from public.users where id = c_sales_a;
  if not v_err or v_e is not null then
    raise exception 'FAIL 2: a sales login linked itself to a colleague''s employee record (attendance fraud)';
  end if;

  -- ── 3. BLOCKED: sales links to an employee already linked to another user ─
  v_err := false;
  begin
    update public.users set employee_id = '71200000-0000-4000-8000-0000000000e3' where id = c_sales_a;
  exception when others then v_err := true; v_msg := sqlerrm; end;
  if not v_err then
    raise exception 'FAIL 3: a sales login took over an employee record already linked to another user';
  end if;

  -- ── 4. BLOCKED: sales sets own email to a pending invitee's email ────────
  v_err := false;
  begin
    update public.users set email = 'r712-invitee@example.in' where id = c_sales_a;
  exception when others then v_err := true; v_msg := sqlerrm; end;
  select email into v_s from public.users where id = c_sales_a;
  if not v_err or v_s <> 'r712-sales-a@example.in' then
    raise exception 'FAIL 4: a sales login copied an invitee''s email onto itself (first-login capture)';
  end if;

  -- ── 5. BLOCKED: sales sets own email to the owner's email ───────────────
  v_err := false;
  begin
    update public.users set email = 'r712-owner-a@example.in' where id = c_sales_a;
  exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 5: a sales login copied the owner''s email onto itself'; end if;

  -- ── 6. BLOCKED: sales rewrites the OWNER's email ─────────────────────────
  v_err := false;
  begin
    update public.users set email = 'r712-attacker@example.in' where id = c_owner_a;
  exception when others then v_err := true; v_msg := sqlerrm; end;
  select email into v_s from public.users where id = c_owner_a;
  if not v_err or v_s <> 'r712-owner-a@example.in' then
    raise exception 'FAIL 6: a sales login rewrote the owner''s email (owner row takeover on next login)';
  end if;
  if v_msg not like 'Only an owner%' then raise exception 'FAIL 6: blocked, but not by the guard: %', v_msg; end if;

  -- ── 7. BLOCKED: sales sets a teammate's employee_id ──────────────────────
  v_err := false;
  begin
    update public.users set employee_id = '71200000-0000-4000-8000-0000000000e1' where id = c_owner_a;
  exception when others then v_err := true; v_msg := sqlerrm; end;
  if not v_err then raise exception 'FAIL 7: a sales login set a teammate''s employee_id'; end if;
  if v_msg not like 'Only an owner%' then raise exception 'FAIL 7: blocked, but not by the guard: %', v_msg; end if;

  -- ── 8. ALLOWED: sales renames self ───────────────────────────────────────
  update public.users set full_name = 'Sales A Renamed' where id = c_sales_a;
  get diagnostics v_n = row_count;
  select full_name into v_s from public.users where id = c_sales_a;
  if v_n <> 1 or v_s <> 'Sales A Renamed' then raise exception 'FAIL 8: an ordinary self rename was blocked'; end if;

  -- ── 9. ALLOWED: set_my_employee with the matching email ──────────────────
  begin
    perform public.set_my_employee('71200000-0000-4000-8000-0000000000e2');
  exception when others then
    raise exception 'FAIL 9: set_my_employee (email matches) was blocked: %', sqlerrm;
  end;
  select employee_id into v_e from public.users where id = c_sales_a;
  if v_e is distinct from '71200000-0000-4000-8000-0000000000e2'::uuid then
    raise exception 'FAIL 9: set_my_employee did not link the record';
  end if;

  -- ── 10. BLOCKED: deactivated owner switches self back on ─────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', c_old, 'role', 'authenticated')::text, true);
  v_err := false;
  begin
    update public.users set is_active = true where id = c_old;
  exception when others then v_err := true; v_msg := sqlerrm; end;
  if not v_err then
    raise exception 'FAIL 10: a deactivated owner switched their own login back on';
  end if;

  -- ── 11. ALLOWED: the active owner manages a teammate ─────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', c_owner_a, 'role', 'authenticated')::text, true);
  begin
    update public.users
       set role = 'manager', employee_id = '71200000-0000-4000-8000-0000000000e1', email = 'r712-sales-new@example.in'
     where id = c_sales_a;
  exception when others then
    raise exception 'FAIL 11: the active owner was blocked from managing a teammate: %', sqlerrm;
  end;
  select role::text, email into v_s, v_msg from public.users where id = c_sales_a;
  if v_s <> 'manager' or v_msg <> 'r712-sales-new@example.in' then
    raise exception 'FAIL 11: owner update did not stick (role %, email %)', v_s, v_msg;
  end if;

  -- ── 12. BLOCKED even for the owner: a teammate's email onto an invitee's ──
  v_err := false;
  begin
    update public.users set email = 'r712-invitee@example.in' where id = c_sales_a;
  exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 12: an owner put another tenant''s invitee email on a teammate'; end if;
end $$;

reset role;

-- ── 13. ALLOWED: the service connection (no auth.uid()) ───────────────────────
do $$
declare v_t uuid;
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  if auth.uid() is not null then raise exception 'SETUP FAIL: auth.uid() still set'; end if;
  update public.users set tenant_id = '71200000-0000-4000-8000-000000000002'
   where id = '71200000-0000-4000-8000-00000000000e';
  select tenant_id into v_t from public.users where id = '71200000-0000-4000-8000-00000000000e';
  if v_t <> '71200000-0000-4000-8000-000000000002' then
    raise exception 'FAIL 13: the service path could not move a row (carve-out gone)';
  end if;
end $$;

select 'PASS — R-712: no self tenant move, no employee/email/is_active self-grab, owner check is same-tenant + active; renames and owner admin still work' as result;

rollback;
