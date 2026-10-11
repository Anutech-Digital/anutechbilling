\set ON_ERROR_STOP on
-- R-1002 (P1 SECURITY, launch blocker): activity_log is readable by owner + manager only and
-- never holds a secret. Migration 20261011155000_r1002_activity_log_roles.
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r1002_activity_log.test.sql
--
-- Expect "PASS r1002_activity_log". Every check is collected and the failures are listed
-- together at the end, so on the old policy / trigger the run names every hole.
--
--   READ 0 rows   accountant, billing, sales, sales_senior, support, delivery, partner_agent,
--                 a deactivated manager, the owner of company B
--   READ all      owner, manager (of company A)
--   SECRETS       an employee PIN change logs `_redacted: ["pin_hash"]`, never the hash;
--                 deleting that employee logs the row without pin_hash; a row inserted with
--                 pin_hash / public_token / *_secret keys is stored without them;
--                 NO activity_log row in the whole DB carries a secret key (the purge ran).

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e1002000-0000-4000-8000-0000000000a1', 'r1002-owner@example.test'),
  ('e1002000-0000-4000-8000-0000000000a2', 'r1002-manager@example.test'),
  ('e1002000-0000-4000-8000-0000000000a3', 'r1002-accountant@example.test'),
  ('e1002000-0000-4000-8000-0000000000a4', 'r1002-billing@example.test'),
  ('e1002000-0000-4000-8000-0000000000a5', 'r1002-sales@example.test'),
  ('e1002000-0000-4000-8000-0000000000a6', 'r1002-salessr@example.test'),
  ('e1002000-0000-4000-8000-0000000000a7', 'r1002-support@example.test'),
  ('e1002000-0000-4000-8000-0000000000a8', 'r1002-delivery@example.test'),
  ('e1002000-0000-4000-8000-0000000000a9', 'r1002-partner@example.test'),
  ('e1002000-0000-4000-8000-0000000000aa', 'r1002-manager-off@example.test'),
  ('e1002000-0000-4000-8000-0000000000b1', 'r1002-owner-b@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e1002000-0000-0000-0000-0000000000a0', 'R1002 A', 'r1002a@example.in', '07', 'R12A'),
  ('e1002000-0000-0000-0000-0000000000b0', 'R1002 B', 'r1002b@example.in', '07', 'R12B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1002000-0000-4000-8000-0000000000a1', 'e1002000-0000-0000-0000-0000000000a0', 'r1002-owner@example.in',       'R1002 Owner',       'owner',         true),
  ('e1002000-0000-4000-8000-0000000000a2', 'e1002000-0000-0000-0000-0000000000a0', 'r1002-manager@example.in',     'R1002 Manager',     'manager',       true),
  ('e1002000-0000-4000-8000-0000000000a3', 'e1002000-0000-0000-0000-0000000000a0', 'r1002-accountant@example.in',  'R1002 Accountant',  'accountant',    true),
  ('e1002000-0000-4000-8000-0000000000a4', 'e1002000-0000-0000-0000-0000000000a0', 'r1002-billing@example.in',     'R1002 Billing',     'billing',       true),
  ('e1002000-0000-4000-8000-0000000000a5', 'e1002000-0000-0000-0000-0000000000a0', 'r1002-sales@example.in',       'R1002 Sales',       'sales',         true),
  ('e1002000-0000-4000-8000-0000000000a6', 'e1002000-0000-0000-0000-0000000000a0', 'r1002-salessr@example.in',     'R1002 Sales Sr',    'sales_senior',  true),
  ('e1002000-0000-4000-8000-0000000000a7', 'e1002000-0000-0000-0000-0000000000a0', 'r1002-support@example.in',     'R1002 Support',     'support',       true),
  ('e1002000-0000-4000-8000-0000000000a8', 'e1002000-0000-0000-0000-0000000000a0', 'r1002-delivery@example.in',    'R1002 Delivery',    'delivery',      true),
  ('e1002000-0000-4000-8000-0000000000a9', 'e1002000-0000-0000-0000-0000000000a0', 'r1002-partner@example.in',     'R1002 Partner',     'partner_agent', true),
  ('e1002000-0000-4000-8000-0000000000aa', 'e1002000-0000-0000-0000-0000000000a0', 'r1002-manager-off@example.in', 'R1002 Manager Off', 'manager',       false),
  ('e1002000-0000-4000-8000-0000000000b1', 'e1002000-0000-0000-0000-0000000000b0', 'r1002-owner-b@example.in',     'R1002 Owner B',     'owner',         true);

-- Three plain audit rows for company A (what every reader below looks for).
insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes) values
  ('e1002000-0000-0000-0000-0000000000a0', 'e1002000-0000-4000-8000-0000000000a1', 'update', 'salary_payments', 'r1002-s1', 'R1002 salary', '{"net": {"old": 1, "new": 2}}'),
  ('e1002000-0000-0000-0000-0000000000a0', 'e1002000-0000-4000-8000-0000000000a1', 'update', 'leads',           'r1002-l1', 'R1002 lead',   '{"stage": {"old": "new", "new": "won"}}'),
  ('e1002000-0000-0000-0000-0000000000a0', 'e1002000-0000-4000-8000-0000000000a1', 'login',  'session',          null,      'R1002 login',  null);

-- A row written WITH secret keys by some writer (not log_row_change) — must be stored clean.
insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes) values
  ('e1002000-0000-0000-0000-0000000000a0', null, 'delete', 'r1002_probe', 'r1002-p1', 'R1002 probe',
   '{"old": {"name": "keep", "pin_hash": "r1002-leak-1", "public_token": "r1002-leak-2", "api_key_enc": "r1002-leak-3", "pin_code": "110001"},
     "client_secret": {"old": "r1002-leak-4", "new": "r1002-leak-5"}, "amount": {"old": 1, "new": 2}}');

create temp table r1002_fail (n serial, label text, detail text);
grant all on r1002_fail to authenticated;
grant usage on sequence r1002_fail_n_seq to authenticated;

-- ── READ: who sees company A's log ───────────────────────────────────────────────
create function pg_temp.r1002_sees(sub uuid) returns bigint
language plpgsql as $f$
declare v bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', sub)::text, true);
  set local role authenticated;
  select count(*) into v from public.activity_log
   where tenant_id = 'e1002000-0000-0000-0000-0000000000a0' and label like 'R1002 %';
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return v;
end $f$;

do $$
declare
  r record;
  v bigint;
begin
  for r in select * from (values
      ('owner',              'e1002000-0000-4000-8000-0000000000a1'::uuid, true),
      ('manager',            'e1002000-0000-4000-8000-0000000000a2'::uuid, true),
      ('accountant',         'e1002000-0000-4000-8000-0000000000a3'::uuid, false),
      ('billing',            'e1002000-0000-4000-8000-0000000000a4'::uuid, false),
      ('sales',              'e1002000-0000-4000-8000-0000000000a5'::uuid, false),
      ('sales_senior',       'e1002000-0000-4000-8000-0000000000a6'::uuid, false),
      ('support',            'e1002000-0000-4000-8000-0000000000a7'::uuid, false),
      ('delivery',           'e1002000-0000-4000-8000-0000000000a8'::uuid, false),
      ('partner_agent',      'e1002000-0000-4000-8000-0000000000a9'::uuid, false),
      ('deactivated manager','e1002000-0000-4000-8000-0000000000aa'::uuid, false),
      ('owner of company B', 'e1002000-0000-4000-8000-0000000000b1'::uuid, false)
    ) as t(label, sub, allowed)
  loop
    v := pg_temp.r1002_sees(r.sub);
    if r.allowed and v < 4 then
      insert into r1002_fail(label, detail) values ('read ' || r.label, format('expected all 4 rows, saw %s', v));
    elsif not r.allowed and v <> 0 then
      insert into r1002_fail(label, detail) values ('read ' || r.label, format('expected 0 rows, saw %s', v));
    else
      raise notice 'ok   read %: % row(s)', r.label, v;
    end if;
  end loop;
end $$;

-- ── SECRETS: a PIN change through the real trigger ───────────────────────────────
insert into public.employees (id, tenant_id, name, monthly_gross) values
  ('e1002000-0000-4000-8000-0000000e0001', 'e1002000-0000-0000-0000-0000000000a0', 'R1002 Emp', 20000);

-- The owner is signed in (auth.uid() set) — log_row_change records the change.
select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', 'e1002000-0000-4000-8000-0000000000a1')::text, true);
update public.employees set pin_hash = 'r1002-pin-hash-secret' where id = 'e1002000-0000-4000-8000-0000000e0001';
delete from public.employees where id = 'e1002000-0000-4000-8000-0000000e0001';
select set_config('request.jwt.claims', '', true);

do $$
declare
  v_upd jsonb;
  v_del jsonb;
begin
  select changes into v_upd from public.activity_log
   where entity = 'employees' and entity_id = 'e1002000-0000-4000-8000-0000000e0001' and action = 'update'
   order by id desc limit 1;
  select changes into v_del from public.activity_log
   where entity = 'employees' and entity_id = 'e1002000-0000-4000-8000-0000000e0001' and action = 'delete'
   order by id desc limit 1;

  if v_upd is null then
    insert into r1002_fail(label, detail) values ('pin update', 'no activity_log row for the PIN change (the change must still be recorded)');
  else
    if v_upd ? 'pin_hash' or v_upd::text like '%r1002-pin-hash-secret%' then
      insert into r1002_fail(label, detail) values ('pin update', 'pin_hash copied into the log: ' || left(v_upd::text, 120));
    end if;
    if not coalesce(v_upd->'_redacted' ? 'pin_hash', false) then
      insert into r1002_fail(label, detail) values ('pin update', 'expected _redacted ["pin_hash"], got ' || left(v_upd::text, 120));
    end if;
  end if;

  if v_del is null then
    insert into r1002_fail(label, detail) values ('employee delete', 'no activity_log row for the delete');
  elsif coalesce(v_del->'old' ? 'pin_hash', false) or v_del::text like '%r1002-pin-hash-secret%' then
    insert into r1002_fail(label, detail) values ('employee delete', 'deleted row logged with pin_hash');
  elsif not coalesce(v_del->'old' ? 'name', false) then
    insert into r1002_fail(label, detail) values ('employee delete', 'deleted row lost its ordinary columns');
  end if;
end $$;

-- ── SECRETS: any writer — the probe row inserted above ───────────────────────────
do $$
declare v jsonb;
begin
  select changes into v from public.activity_log where entity = 'r1002_probe';
  if v::text ~ 'r1002-leak-' then
    insert into r1002_fail(label, detail) values ('probe row', 'secret values stored: ' || left(v::text, 160));
  end if;
  if not (coalesce(v->'old'->>'name', '') = 'keep' and coalesce(v->'old'->>'pin_code', '') = '110001' and v ? 'amount') then
    insert into r1002_fail(label, detail) values ('probe row', 'ordinary keys were stripped too: ' || left(v::text, 160));
  end if;
end $$;

-- ── SECRETS: nothing left anywhere (the purge) ───────────────────────────────────
-- Same denylist as public.audit_secret_key(), written out so this check runs on the old DB too.
do $$
declare v bigint;
begin
  select count(*) into v
    from public.activity_log l
   where l.changes is not null and jsonb_typeof(l.changes) = 'object'
     and exists (
       select 1 from (
         select k from jsonb_object_keys(l.changes) k
         union all
         select k from jsonb_object_keys(case when jsonb_typeof(l.changes->'old') = 'object' then l.changes->'old' else '{}' end) k
         union all
         select k from jsonb_object_keys(case when jsonb_typeof(l.changes->'new') = 'object' then l.changes->'new' else '{}' end) k
       ) keys
       where lower(k) = 'pin_hash'
          or lower(k) ~ '(^|_)(secrets?|password|passwd|passphrase|tokens?|hash|salt|otp|cipher|ciphertext|nonce|vault|credentials?|encrypted)(_|$)'
          or lower(k) ~ '(private_key|api_key|key_enc|enc_key)');
  if v > 0 then
    insert into r1002_fail(label, detail) values ('purge', format('%s activity_log row(s) still carry a secret key', v));
  else
    raise notice 'ok   purge: no row carries a secret key';
  end if;
end $$;

-- ── Verdict ───────────────────────────────────────────────────────────────────────
do $$
declare v text;
begin
  select string_agg(format('  FAIL %s: %s', label, detail), E'\n' order by n) into v from r1002_fail;
  if v is not null then
    raise exception E'r1002_activity_log — % failure(s):\n%', (select count(*) from r1002_fail), v;
  end if;
  raise notice 'PASS r1002_activity_log';
end $$;

rollback;
