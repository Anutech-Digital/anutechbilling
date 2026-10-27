-- R-1860 (Pardeep, 24 Oct 2026): tenants.sell_mode — "What do you sell?"
--
-- Self-asserting, ONE transaction, rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/r1860_tenant_sell_mode.test.sql
--
-- Before the migration is applied, prove it in one rollback (CLAUDE.md §17c):
--   begin; <r1860 migration> <this test minus begin/rollback> rollback;
-- Expect "PASS r1860".
--
-- Proves:
--   1. a new tenant (no sell_mode given) reads 'both'; every existing tenant reads 'both'.
--   2. 'one_time' and 'subscriptions' are stored; a typo or null is refused (check / not null).
--   3. the owner can change it through the owner-only tenant update policy; a sales login
--      updates zero rows (RLS), so the value stays.

begin;

do $$
declare n int;
begin
  select count(*) into n from public.tenants where sell_mode is distinct from 'both';
  if n <> 0 then raise exception 'FAIL 1: % existing tenant(s) not both', n; end if;
end $$;

insert into auth.users (id, email) values
  ('e1860000-0000-4000-8000-000000000001', 'r1860-01@example.test'),
  ('e1860000-0000-4000-8000-000000000002', 'r1860-02@example.test');

insert into public.tenants (id, name, email, state_code, state, address)
values ('e1860000-0000-0000-0000-0000000000f1', 'R1860 Co', 'r1860@example.in', '07', 'Delhi', 'R street, Delhi');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1860000-0000-4000-8000-000000000001', 'e1860000-0000-0000-0000-0000000000f1', 'r1860-01@example.in', 'Owner', 'owner', true),
  ('e1860000-0000-4000-8000-000000000002', 'e1860000-0000-0000-0000-0000000000f1', 'r1860-02@example.in', 'Seller', 'sales', true);

do $$
begin
  if (select sell_mode from public.tenants where id = 'e1860000-0000-0000-0000-0000000000f1') <> 'both' then
    raise exception 'FAIL 1: new tenant default is not both';
  end if;

  update public.tenants set sell_mode = 'one_time' where id = 'e1860000-0000-0000-0000-0000000000f1';
  update public.tenants set sell_mode = 'subscriptions' where id = 'e1860000-0000-0000-0000-0000000000f1';

  begin
    update public.tenants set sell_mode = 'onetime' where id = 'e1860000-0000-0000-0000-0000000000f1';
    raise exception 'FAIL 2: typo accepted';
  exception when check_violation then null;
  end;
  begin
    update public.tenants set sell_mode = null where id = 'e1860000-0000-0000-0000-0000000000f1';
    raise exception 'FAIL 2: null accepted';
  exception when not_null_violation then null;
  end;
end $$;

-- 3. sales login: zero rows, value unchanged
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e1860000-0000-4000-8000-000000000002","role":"authenticated"}', true);
update public.tenants set sell_mode = 'both' where id = 'e1860000-0000-0000-0000-0000000000f1';
reset role;
do $$
begin
  if (select sell_mode from public.tenants where id = 'e1860000-0000-0000-0000-0000000000f1') <> 'subscriptions' then
    raise exception 'FAIL 3: a sales login changed sell_mode';
  end if;
end $$;

-- 3. owner login: changes it
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e1860000-0000-4000-8000-000000000001","role":"authenticated"}', true);
update public.tenants set sell_mode = 'one_time' where id = 'e1860000-0000-0000-0000-0000000000f1';
reset role;
do $$
begin
  if (select sell_mode from public.tenants where id = 'e1860000-0000-0000-0000-0000000000f1') <> 'one_time' then
    raise exception 'FAIL 3: the owner could not change sell_mode';
  end if;
  raise notice 'PASS r1860';
end $$;

rollback;
