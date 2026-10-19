-- R-1615 attack test — the 14 SECURITY DEFINER functions R-1560 found honour R-731 (MFA) and
-- R-722 (inactive) through public.current_tenant_id().
-- Migration: 20261018225100_r1615_definer_tenant_gate.sql
--
-- Before the fix each took the tenant from `users where id = auth.uid()`, so:
--   • a deactivated user or an MFA user on a password-only (aal1) session could spend a prepaid
--     advance, clone partner items, read partner MRR / catalog, punch-undo / link attendance,
--     write the activity log;
--   • an MFA owner on aal1 could list and claim stranded logins.
-- This file FAILS on the old bodies and PASSES on the new ones.
--
--   1. MFA owner on aal1 and a deactivated owner: every writer / plpgsql reader refused with
--      28000 and that function's own words; log_activity writes nothing; the SQL readers return
--      no rows; nothing in the data moved.
--   2. Active sales user (not owner/manager): sync_partner_item refused 42501 (items RLS rule).
--   3. Plain active owner (no MFA): every function works as before.
--   4. MFA owner on aal2: consume_prepaid_advance works.
--   5. Parent-company owner: get_partner_metrics shows the child.
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r1615_definer_tenant_gate.test.sql

begin;

-- ── fixture ─────────────────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('c1615000-0000-0000-0000-0000000000a1', 'r1615-plain@example.test'),
  ('c1615000-0000-0000-0000-0000000000a2', 'r1615-mfa@example.test'),
  ('c1615000-0000-0000-0000-0000000000a3', 'r1615-gone@example.test'),
  ('c1615000-0000-0000-0000-0000000000a4', 'r1615-sales@example.test'),
  ('c1615000-0000-0000-0000-0000000000b1', 'r1615-parent@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c1615000-0000-0000-0000-0000000000f0', 'R1615 Parent', 'r1615p@example.test', '07', 'R165P');
insert into public.tenants (id, name, email, state_code, doc_code, parent_tenant_id) values
  ('c1615000-0000-0000-0000-0000000000f1', 'R1615 Child', 'r1615c@example.test', '07', 'R165C',
   'c1615000-0000-0000-0000-0000000000f0');

insert into public.employees (id, tenant_id, name, email) values
  ('c1615000-0000-0000-0000-0000000000e1', 'c1615000-0000-0000-0000-0000000000f1', 'R1615 Plain', 'r1615-plain@example.test'),
  ('c1615000-0000-0000-0000-0000000000e2', 'c1615000-0000-0000-0000-0000000000f1', 'R1615 Mfa',   'r1615-mfa@example.test'),
  ('c1615000-0000-0000-0000-0000000000e3', 'c1615000-0000-0000-0000-0000000000f1', 'R1615 Gone',  'r1615-gone@example.test');

insert into public.users (id, tenant_id, email, full_name, role, is_active, employee_id) values
  ('c1615000-0000-0000-0000-0000000000a1', 'c1615000-0000-0000-0000-0000000000f1', 'r1615-plain@example.test',  'R1615 Plain',  'owner',  true,  'c1615000-0000-0000-0000-0000000000e1'),
  ('c1615000-0000-0000-0000-0000000000a2', 'c1615000-0000-0000-0000-0000000000f1', 'r1615-mfa@example.test',    'R1615 Mfa',    'owner',  true,  'c1615000-0000-0000-0000-0000000000e2'),
  ('c1615000-0000-0000-0000-0000000000a3', 'c1615000-0000-0000-0000-0000000000f1', 'r1615-gone@example.test',   'R1615 Gone',   'owner',  false, 'c1615000-0000-0000-0000-0000000000e3'),
  ('c1615000-0000-0000-0000-0000000000a4', 'c1615000-0000-0000-0000-0000000000f1', 'r1615-sales@example.test',  'R1615 Sales',  'sales',  true,  null),
  ('c1615000-0000-0000-0000-0000000000b1', 'c1615000-0000-0000-0000-0000000000f0', 'r1615-parent@example.test', 'R1615 Parent', 'owner',  true,  null);

insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, secret, created_at, updated_at)
  values ('c1615000-0000-0000-0000-0000000000d1', 'c1615000-0000-0000-0000-0000000000a2', 'test', 'totp', 'verified', 'JBSWY3DPEHPK3PXP', now(), now());

-- a punch just now for each employee (so undo is inside its 15 minutes)
insert into public.attendance (tenant_id, employee_id, work_date, check_in)
select 'c1615000-0000-0000-0000-0000000000f1', e, (now() at time zone 'Asia/Kolkata')::date, now()
  from unnest(array['c1615000-0000-0000-0000-0000000000e1', 'c1615000-0000-0000-0000-0000000000e2',
                    'c1615000-0000-0000-0000-0000000000e3']::uuid[]) e;

insert into public.prepaid_advances (id, tenant_id, vendor_name, category, total_amount, paid_date)
  values ('c1615000-0000-0000-0000-0000000000c1', 'c1615000-0000-0000-0000-0000000000f1', 'R1615 Vendor', 'Software', 10000, '2026-10-01');

insert into public.items (id, tenant_id, name, vendor, kind, msrp, wholesale, partner_price, is_partner_visible, is_active)
  values ('R1615-GWS-ab12', 'c1615000-0000-0000-0000-0000000000f0', 'R1615 Workspace', 'google', 'main', 700, 400, 500, true, true);

set local role authenticated;

-- ── 1. refusals: MFA owner on aal1, deactivated owner ───────────────────────────────
do $$
declare
  v_who  record;
  v_call text;
  v_msg  text;
  v_st   text;
  v_n    int;
  /* call → a word from ITS OWN refusal message (proves its own guard fired) */
  v_calls constant text[][] := array[
    array['select public.consume_prepaid_advance(''c1615000-0000-0000-0000-0000000000c1'', 100, current_date, ''R1615 sneak'')', 'prepaid advance'],
    -- (the 2-argument overload cannot be called at all — a 2-argument call is ambiguous with
    --  the 3-argument one's default; the app calls the 3-argument one by name)
    array['select public.sync_partner_item(''R1615-GWS-ab12'', 900, null)',               'partner item'],
    array['select count(*) from public.my_attendance_history(14)',                        'Your attendance'],
    array['select public.my_attendance_today()',                                           'Your attendance'],
    array['select public.record_attendance_consent()',                                     'attendance consent'],
    array['select public.set_my_employee(''c1615000-0000-0000-0000-0000000000e1'')',       'Linking your employee'],
    array['select public.undo_my_last_punch()',                                            'Undoing a punch'],
    array['select count(*) from public.list_stranded_auth_users()',                        'waiting to join'],
    array['select public.merge_stranded_user_into_tenant(''nobody-r1615@example.test'', ''c1615000-0000-0000-0000-0000000000f1'', ''support'')', 'Claiming a colleague']
  ];
  i int;
begin
  for v_who in
    select * from (values
      ('c1615000-0000-0000-0000-0000000000a2'::uuid, 'MFA owner on aal1'),
      ('c1615000-0000-0000-0000-0000000000a3'::uuid, 'deactivated owner')) as w(uid, label)
  loop
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_who.uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);

    for i in 1 .. array_length(v_calls, 1) loop
      v_call := v_calls[i][1];
      begin
        execute v_call;
        raise exception 'FAIL 1: % ran "%" — definer ignores MFA / is_active', v_who.label, v_call;
      exception
        when others then
          get stacked diagnostics v_st = returned_sqlstate, v_msg = message_text;
          if v_msg like 'FAIL%' then raise; end if;
          if v_st <> '28000' or position(v_calls[i][2] in v_msg) = 0 then
            raise exception 'FAIL 1: % on "%" refused by the wrong guard: % %', v_who.label, v_call, v_st, v_msg;
          end if;
      end;
    end loop;

    -- log_activity: quiet, writes nothing
    perform public.log_activity('r1615_probe', 'session', null, 'R1615 probe');

    -- SQL readers: no rows
    select count(*) into v_n from public.get_my_tenant_with_parent();
    if v_n <> 0 then raise exception 'FAIL 1: % sees get_my_tenant_with_parent', v_who.label; end if;
    select count(*) into v_n from public.get_partner_catalog();
    if v_n <> 0 then raise exception 'FAIL 1: % sees get_partner_catalog', v_who.label; end if;
  end loop;

  perform set_config('request.jwt.claims', '', true);
end $$;

reset role;
do $$
declare v_n int;
begin
  select count(*) into v_n from public.activity_log where action = 'r1615_probe';
  if v_n <> 0 then raise exception 'FAIL 1: refused log_activity still wrote % row(s)', v_n; end if;
  select count(*) into v_n from public.expenses where tenant_id = 'c1615000-0000-0000-0000-0000000000f1';
  if v_n <> 0 then raise exception 'FAIL 1: refused consume still booked an expense'; end if;
  select count(*) into v_n from public.items where tenant_id = 'c1615000-0000-0000-0000-0000000000f1';
  if v_n <> 0 then raise exception 'FAIL 1: refused sync still cloned the item'; end if;
  select count(*) into v_n from public.attendance where tenant_id = 'c1615000-0000-0000-0000-0000000000f1';
  if v_n <> 3 then raise exception 'FAIL 1: refused undo still deleted a punch (% left)', v_n; end if;
  select count(*) into v_n from public.employees
   where tenant_id = 'c1615000-0000-0000-0000-0000000000f1' and attendance_consent_at is not null;
  if v_n <> 0 then raise exception 'FAIL 1: refused consent still recorded'; end if;
end $$;

-- ── 2. active sales user: sync_partner_item needs owner/manager ─────────────────────
set local role authenticated;
do $$
declare v_msg text; v_st text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1615000-0000-0000-0000-0000000000a4', 'role', 'authenticated')::text, true);
  begin
    perform public.sync_partner_item('R1615-GWS-ab12', 900, null);
    raise exception 'FAIL 2: sales user cloned a partner item into the price list';
  exception when others then
    get stacked diagnostics v_st = returned_sqlstate, v_msg = message_text;
    if v_msg like 'FAIL%' then raise; end if;
    if v_st <> '42501' or position('owner or manager' in v_msg) = 0 then
      raise exception 'FAIL 2: sales sync refused by the wrong guard: % %', v_st, v_msg;
    end if;
  end;
  -- but the sales user still reads the parent link (any active member)
  if (select count(*) from public.get_my_tenant_with_parent()) <> 1 then
    raise exception 'FAIL 2: active sales user lost get_my_tenant_with_parent';
  end if;
end $$;

-- ── 3. plain active owner: everything works ─────────────────────────────────────────
do $$
declare
  v_left int;
  v_id   text;
  v_j    jsonb;
  v_n    int;
  v_msg  text;
  v_st   text;
  v_r    record;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1615000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);

  v_left := public.consume_prepaid_advance('c1615000-0000-0000-0000-0000000000c1', 1000, current_date, 'R1615 ok');
  if v_left <> 9000 then raise exception 'FAIL 3: consume left % (want 9000)', v_left; end if;

  perform public.log_activity('r1615_ok', 'session', null, 'R1615 ok');

  select * into v_r from public.get_my_tenant_with_parent();
  if v_r.id is distinct from 'c1615000-0000-0000-0000-0000000000f1'::uuid
     or v_r.parent_tenant_id is distinct from 'c1615000-0000-0000-0000-0000000000f0'::uuid then
    raise exception 'FAIL 3: get_my_tenant_with_parent wrong: %', row_to_json(v_r);
  end if;

  select count(*) into v_n from public.get_partner_catalog() where id = 'R1615-GWS-ab12' and not already_synced;
  if v_n <> 1 then raise exception 'FAIL 3: partner catalog missing the item'; end if;

  v_id := public.sync_partner_item(p_partner_item_id => 'R1615-GWS-ab12', p_link_existing_id => null);
  if v_id is null then raise exception 'FAIL 3: sync returned null'; end if;
  if public.sync_partner_item('R1615-GWS-ab12', 950, null) <> v_id then
    raise exception 'FAIL 3: second sync did not refresh the same clone';
  end if;
  select count(*) into v_n from public.get_partner_catalog() where id = 'R1615-GWS-ab12' and already_synced;
  if v_n <> 1 then raise exception 'FAIL 3: catalog does not show the item as synced'; end if;

  v_j := public.my_attendance_today();
  if not (v_j->>'linked')::boolean or v_j->>'employee_name' <> 'R1615 Plain' or v_j->>'check_in' is null then
    raise exception 'FAIL 3: my_attendance_today wrong: %', v_j;
  end if;
  select count(*) into v_n from public.my_attendance_history(14);
  if v_n <> 1 then raise exception 'FAIL 3: my_attendance_history gave % rows', v_n; end if;
  perform public.record_attendance_consent();
  perform public.set_my_employee('c1615000-0000-0000-0000-0000000000e1');
  if public.undo_my_last_punch() <> 'undo_checkin' then raise exception 'FAIL 3: undo did not undo the check-in'; end if;

  perform count(*) from public.list_stranded_auth_users();
  begin
    perform public.merge_stranded_user_into_tenant('nobody-r1615@example.test', 'c1615000-0000-0000-0000-0000000000f1', 'support');
    raise exception 'FAIL 3: merge of an unknown address succeeded';
  exception when others then
    get stacked diagnostics v_st = returned_sqlstate, v_msg = message_text;
    if v_msg like 'FAIL%' then raise; end if;
    -- past the owner gate: the R-721 "no invite / no request" answer
    if v_st <> '42501' or position('Cannot claim' in v_msg) = 0 then
      raise exception 'FAIL 3: owner merge stopped by the wrong guard: % %', v_st, v_msg;
    end if;
  end;
  -- an owner cannot aim the merge at another company
  begin
    perform public.merge_stranded_user_into_tenant('nobody-r1615@example.test', 'c1615000-0000-0000-0000-0000000000f0', 'support');
    raise exception 'FAIL 3: merge into another company passed the owner gate';
  exception when others then
    get stacked diagnostics v_st = returned_sqlstate, v_msg = message_text;
    if v_msg like 'FAIL%' then raise; end if;
    if v_st <> '42501' or position('Only the owner' in v_msg) = 0 then
      raise exception 'FAIL 3: cross-company merge refused by the wrong guard: % %', v_st, v_msg;
    end if;
  end;

  -- ── 4. MFA owner on aal2: works ──
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1615000-0000-0000-0000-0000000000a2', 'role', 'authenticated', 'aal', 'aal2')::text, true);
  v_left := public.consume_prepaid_advance('c1615000-0000-0000-0000-0000000000c1', 500, current_date, 'R1615 aal2');
  if v_left <> 8500 then raise exception 'FAIL 4: aal2 consume left % (want 8500)', v_left; end if;
  if not (public.my_attendance_today()->>'linked')::boolean then raise exception 'FAIL 4: aal2 attendance not linked'; end if;

  -- ── 5. parent owner sees the child in partner metrics ──
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1615000-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.get_partner_metrics() where tenant_id = 'c1615000-0000-0000-0000-0000000000f1';
  if v_n <> 1 then raise exception 'FAIL 5: parent owner does not see the child in partner metrics'; end if;

  perform set_config('request.jwt.claims', '', true);
end $$;

reset role;
do $$
declare v_n int;
begin
  select count(*) into v_n from public.activity_log
   where action = 'r1615_ok' and user_id = 'c1615000-0000-0000-0000-0000000000a1';
  if v_n <> 1 then raise exception 'FAIL 3: owner log_activity wrote % row(s)', v_n; end if;
  select count(*) into v_n from public.employees
   where id = 'c1615000-0000-0000-0000-0000000000e1' and attendance_consent_at is not null;
  if v_n <> 1 then raise exception 'FAIL 3: owner consent not recorded'; end if;
  select count(*) into v_n from public.attendance where employee_id = 'c1615000-0000-0000-0000-0000000000e1';
  if v_n <> 0 then raise exception 'FAIL 3: owner undo left the check-in'; end if;
  raise notice 'R-1615 definer tenant gate: all checks passed';
end $$;

rollback;
