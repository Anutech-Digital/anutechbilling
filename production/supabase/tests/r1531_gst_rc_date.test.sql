-- R-1531: tenants.gst_rc_date — the GST registration certificate date (Section 31(3)(a)).
-- Migration 20261019002811_r1531_gst_rc_date. Self-asserting, ONE transaction, rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/r1531_gst_rc_date.test.sql
--
-- Before the migration is applied, prove it in one rollback (CLAUDE.md §17c): strip the
-- migration's begin/commit and this file's begin/rollback and pipe
--   begin; <migration> <this test> rollback;
-- Expect "PASS r1531_gst_rc_date".
--
-- Proves:
--   1. The owner saves the certificate date through RLS (one row), like gst_registered_from.
--   2. A certificate dated before the effective date is refused (23514).
--   3. Another company's owner cannot set it (zero rows — tenants_self_update).
--   4. NULL is allowed (not entered yet) and existing rows are untouched (NULL).

begin;

select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e1531000-0000-4000-8000-00000000000a', 'r1531-owner-a@example.test'),
  ('e1531000-0000-4000-8000-00000000000b', 'r1531-owner-b@example.test');

insert into public.tenants (id, name, email, state_code, state, address, doc_code, gstin, gst_registration, gst_registered_from) values
  ('e1531000-0000-0000-0000-0000000000a1', 'R1531 A', 'r1531a@example.in', '07', 'Delhi', 'A street, Delhi', 'R31A', '07AAACR1531A1Z1', 'registered', date '2026-09-01'),
  ('e1531000-0000-0000-0000-0000000000b1', 'R1531 B', 'r1531b@example.in', '07', 'Delhi', 'B street, Delhi', 'R31B', '07AAACR1531B1Z1', 'registered', null);

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1531000-0000-4000-8000-00000000000a', 'e1531000-0000-0000-0000-0000000000a1', 'r1531-owner-a@example.in', 'R1531 Owner A', 'owner', true),
  ('e1531000-0000-4000-8000-00000000000b', 'e1531000-0000-0000-0000-0000000000b1', 'r1531-owner-b@example.in', 'R1531 Owner B', 'owner', true);

do $$
begin
  if exists (select 1 from public.tenants where id = 'e1531000-0000-0000-0000-0000000000a1' and gst_rc_date is not null) then
    raise exception 'FAIL 4: a new tenant row should start with no certificate date';
  end if;
end $$;

-- 1. owner A saves it
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"e1531000-0000-4000-8000-00000000000a"}', true);
do $$
declare n int;
begin
  update public.tenants set gst_rc_date = date '2026-10-10' where id = 'e1531000-0000-0000-0000-0000000000a1';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL 1: owner could not save the certificate date (% rows)', n; end if;

  -- 2. before the effective date → refused
  begin
    update public.tenants set gst_rc_date = date '2026-08-31' where id = 'e1531000-0000-0000-0000-0000000000a1';
    raise exception 'FAIL 2: a certificate before the effective date was accepted';
  exception when check_violation then
    null;
  end;

  -- 4. back to NULL is fine
  update public.tenants set gst_rc_date = null where id = 'e1531000-0000-0000-0000-0000000000a1';
  update public.tenants set gst_rc_date = date '2026-10-10' where id = 'e1531000-0000-0000-0000-0000000000a1';
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

-- 3. owner B cannot touch A
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"e1531000-0000-4000-8000-00000000000b"}', true);
do $$
declare n int;
begin
  update public.tenants set gst_rc_date = date '2026-09-15' where id = 'e1531000-0000-0000-0000-0000000000a1';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 3: another company changed the certificate date (% rows)', n; end if;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

do $$
begin
  if (select gst_rc_date from public.tenants where id = 'e1531000-0000-0000-0000-0000000000a1') <> date '2026-10-10' then
    raise exception 'FAIL 1/3: certificate date is not the one the owner saved';
  end if;
  raise notice 'PASS r1531_gst_rc_date';
end $$;

rollback;
