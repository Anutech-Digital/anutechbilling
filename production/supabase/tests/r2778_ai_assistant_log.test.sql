\set ON_ERROR_STOP on
-- R-2778 (H-05, G-HELPAI, security): the Help AI assistant log + the "AI on behalf of <person>"
-- marker on activity_log. Migration 20261116xxxxxx_r2778_ai_assistant_log.
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r2778_ai_assistant_log.test.sql
--
-- Expect "PASS r2778_ai_assistant_log". Failures are collected and listed together.
--
--   LOG READ      owner/manager of company A read A's rows; the owner of company B reads 0 of
--                 them; sales / accountant / a deactivated manager read 0.
--   LOG WRITE     only log_ai_assistant_event(): tenant and user come from the login (no such
--                 argument); a client INSERT / UPDATE / DELETE on the table is refused; a bad
--                 outcome is refused; long text is cut; anon cannot call it; a deactivated user
--                 writes nothing; a burst is capped.
--   MARKER        with header x-actor-via: ai + x-actor-conversation = a conversation THIS user
--                 logged in the last day, log_row_change() and log_activity() store via='ai';
--                 header absent / unknown conversation / another person's conversation / an old
--                 conversation → via stays null (the row is the person's own, as before).

begin;
select set_config('request.jwt.claims', '', true);
select set_config('request.headers', '', true);

insert into auth.users (id, email) values
  ('e2778000-0000-4000-8000-0000000000a1', 'r2778-owner@example.test'),
  ('e2778000-0000-4000-8000-0000000000a2', 'r2778-manager@example.test'),
  ('e2778000-0000-4000-8000-0000000000a3', 'r2778-sales@example.test'),
  ('e2778000-0000-4000-8000-0000000000a4', 'r2778-accountant@example.test'),
  ('e2778000-0000-4000-8000-0000000000aa', 'r2778-manager-off@example.test'),
  ('e2778000-0000-4000-8000-0000000000b1', 'r2778-owner-b@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e2778000-0000-0000-0000-0000000000a0', 'R2778 A', 'r2778a@example.in', '07', 'R78A'),
  ('e2778000-0000-0000-0000-0000000000b0', 'R2778 B', 'r2778b@example.in', '07', 'R78B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e2778000-0000-4000-8000-0000000000a1', 'e2778000-0000-0000-0000-0000000000a0', 'r2778-owner@example.in',       'R2778 Owner',       'owner',      true),
  ('e2778000-0000-4000-8000-0000000000a2', 'e2778000-0000-0000-0000-0000000000a0', 'r2778-manager@example.in',     'R2778 Manager',     'manager',    true),
  ('e2778000-0000-4000-8000-0000000000a3', 'e2778000-0000-0000-0000-0000000000a0', 'r2778-sales@example.in',       'R2778 Sales',       'sales',      true),
  ('e2778000-0000-4000-8000-0000000000a4', 'e2778000-0000-0000-0000-0000000000a0', 'r2778-accountant@example.in',  'R2778 Accountant',  'accountant', true),
  ('e2778000-0000-4000-8000-0000000000aa', 'e2778000-0000-0000-0000-0000000000a0', 'r2778-manager-off@example.in', 'R2778 Manager Off', 'manager',    false),
  ('e2778000-0000-4000-8000-0000000000b1', 'e2778000-0000-0000-0000-0000000000b0', 'r2778-owner-b@example.in',     'R2778 Owner B',     'owner',      true);

insert into public.customers (id, tenant_id, name, contact_email) values
  ('e2778000-0000-0000-0000-0000000000c1', 'e2778000-0000-0000-0000-0000000000a0', 'R2778 Cust', 'c@r2778.example');

create temp table r2778_fail (n serial, label text, detail text);
grant all on r2778_fail to authenticated, anon;
grant usage on sequence r2778_fail_n_seq to authenticated, anon;

-- act as a signed-in person (or nobody) for the next statements
create function pg_temp.r2778_as(sub uuid, headers text default '') returns void
language plpgsql as $f$
begin
  perform set_config('request.jwt.claims',
    case when sub is null then '' else json_build_object('role', 'authenticated', 'sub', sub)::text end, true);
  perform set_config('request.headers', coalesce(headers, ''), true);
  if sub is null then reset role; else set local role authenticated; end if;
end $f$;
create function pg_temp.r2778_back() returns void language plpgsql as $f$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.headers', '', true);
end $f$;
grant execute on function pg_temp.r2778_as(uuid, text), pg_temp.r2778_back() to authenticated, anon;

do $t$
declare
  c_a    constant uuid := 'e2778000-0000-0000-0000-0000000000a0';
  c_b    constant uuid := 'e2778000-0000-0000-0000-0000000000b0';
  u_own  constant uuid := 'e2778000-0000-4000-8000-0000000000a1';
  u_man  constant uuid := 'e2778000-0000-4000-8000-0000000000a2';
  u_sal  constant uuid := 'e2778000-0000-4000-8000-0000000000a3';
  u_acc  constant uuid := 'e2778000-0000-4000-8000-0000000000a4';
  u_off  constant uuid := 'e2778000-0000-4000-8000-0000000000aa';
  u_ob   constant uuid := 'e2778000-0000-4000-8000-0000000000b1';
  conv1  constant uuid := 'e2778000-0000-4000-8000-00000000c001';  -- the owner's question
  conv2  constant uuid := 'e2778000-0000-4000-8000-00000000c002';  -- the sales person's question
  conv3  constant uuid := 'e2778000-0000-4000-8000-00000000c003';  -- the owner's, but two days old
  conv4  constant uuid := 'e2778000-0000-4000-8000-00000000c004';  -- never logged
  cust   constant uuid := 'e2778000-0000-0000-0000-0000000000c1';
  v_n    bigint;
  v_row  record;
  v_hdr  text;
begin
  -- ── LOG WRITE (through the one function, as the person) ────────────────────────
  perform pg_temp.r2778_as(u_own);
  perform public.log_ai_assistant_event(conv1, 'question', null, null, 'How much is overdue?', 'started', null, null, null, null, null, null);
  perform public.log_ai_assistant_event(conv1, 'tool', 'overdue_receivables', 'read', 'no inputs', 'did', null, 3, 120, null, null, null);
  perform public.log_ai_assistant_event(conv1, 'tool', 'payroll_secret_tool', 'read', null, 'refused', null, null, 0, null, null, null);
  perform public.log_ai_assistant_event(conv1, 'answer', null, null, null, 'did', null, null, 2500, 'test-model', 1200, 300);
  perform pg_temp.r2778_back();

  perform pg_temp.r2778_as(u_sal);
  perform public.log_ai_assistant_event(conv2, 'question', null, null, 'sales question', 'started', null, null, null, null, null, null);
  perform pg_temp.r2778_back();

  -- an old conversation of the owner (written as the DB owner so created_at can be set)
  insert into public.ai_assistant_log (tenant_id, user_id, conversation_id, kind, outcome, created_at)
  values (c_a, u_own, conv3, 'question', 'started', now() - interval '2 days');

  select * into v_row from public.ai_assistant_log where conversation_id = conv1 and kind = 'question';
  if v_row.tenant_id is distinct from c_a or v_row.user_id is distinct from u_own then
    insert into r2778_fail(label, detail) values ('W1 tenant/user from login', format('got %s / %s', v_row.tenant_id, v_row.user_id)); end if;
  select * into v_row from public.ai_assistant_log where conversation_id = conv1 and kind = 'tool' and tool = 'overdue_receivables';
  if v_row.row_count is distinct from 3 or v_row.duration_ms is distinct from 120 or v_row.tier is distinct from 'read' then
    insert into r2778_fail(label, detail) values ('W2 tool row fields', row_to_json(v_row)::text); end if;

  -- unknown stays null (greatest(null, 0) used to store a false 0); a negative is not stored
  select * into v_row from public.ai_assistant_log where conversation_id = conv1 and kind = 'question';
  if v_row.row_count is not null or v_row.duration_ms is not null or v_row.tokens_in is not null or v_row.tokens_out is not null then
    insert into r2778_fail(label, detail) values ('W13 unknown numbers must stay null', row_to_json(v_row)::text); end if;
  select * into v_row from public.ai_assistant_log where conversation_id = conv1 and kind = 'answer';
  if v_row.tokens_in is distinct from 1200 or v_row.tokens_out is distinct from 300 or v_row.row_count is not null then
    insert into r2778_fail(label, detail) values ('W14 known numbers stored, unknown null', row_to_json(v_row)::text); end if;

  -- direct INSERT / UPDATE / DELETE by a signed-in user (own tenant, own id) → refused
  perform pg_temp.r2778_as(u_own);
  begin
    insert into public.ai_assistant_log (tenant_id, user_id, conversation_id, kind, outcome) values (c_a, u_own, conv1, 'question', 'did');
    insert into r2778_fail(label, detail) values ('W3 direct insert (own ids)', 'was allowed');
  exception when others then null; end;
  begin
    insert into public.ai_assistant_log (tenant_id, user_id, conversation_id, kind, outcome) values (c_b, u_ob, conv1, 'question', 'did');
    insert into r2778_fail(label, detail) values ('W4 direct insert (other tenant/user)', 'was allowed');
  exception when others then null; end;
  begin
    update public.ai_assistant_log set outcome = 'did' where conversation_id = conv1;
    get diagnostics v_n = row_count;
    if v_n > 0 then insert into r2778_fail(label, detail) values ('W5 update', format('%s rows changed', v_n)); end if;
  exception when others then null; end;
  begin
    delete from public.ai_assistant_log where conversation_id = conv1;
    get diagnostics v_n = row_count;
    if v_n > 0 then insert into r2778_fail(label, detail) values ('W6 delete', format('%s rows deleted', v_n)); end if;
  exception when others then null; end;
  -- bad outcome refused; long text cut
  begin
    perform public.log_ai_assistant_event(conv1, 'tool', 'x_tool', 'read', null, 'hacked', null, null, null, null, null, null);
    insert into r2778_fail(label, detail) values ('W7 bad outcome', 'was accepted');
  exception when others then null; end;
  perform public.log_ai_assistant_event(conv1, 'question', null, null, repeat('q', 5000), 'started', null, null, null, null, null, null);
  perform public.log_ai_assistant_event(conv1, 'tool', repeat('t', 300), 'read', repeat('a', 5000), 'did',
    (select array_agg(i::text) from generate_series(1, 100) i), 100, 1, repeat('m', 300), 1, 1);
  perform pg_temp.r2778_back();
  select max(length(question)) into v_n from public.ai_assistant_log where conversation_id = conv1;
  if v_n > 500 then insert into r2778_fail(label, detail) values ('W8 question cap', format('%s chars', v_n)); end if;
  select * into v_row from public.ai_assistant_log where conversation_id = conv1 and kind = 'tool' order by id desc limit 1;
  if length(v_row.tool) > 64 or length(v_row.args_summary) > 300 or coalesce(cardinality(v_row.row_ids), 0) > 20 or length(v_row.model) > 80 then
    insert into r2778_fail(label, detail) values ('W9 caps', format('tool %s args %s ids %s model %s', length(v_row.tool), length(v_row.args_summary), cardinality(v_row.row_ids), length(v_row.model))); end if;

  -- anon cannot call it; a deactivated user writes nothing
  perform pg_temp.r2778_as(null);
  set local role anon;
  begin
    perform public.log_ai_assistant_event(conv4, 'question', null, null, 'anon', 'started', null, null, null, null, null, null);
    insert into r2778_fail(label, detail) values ('W10 anon call', 'was allowed');
  exception when insufficient_privilege then null; end;
  reset role;
  perform pg_temp.r2778_as(u_off);
  perform public.log_ai_assistant_event(conv4, 'question', null, null, 'deactivated', 'started', null, null, null, null, null, null);
  perform pg_temp.r2778_back();
  if exists (select 1 from public.ai_assistant_log where conversation_id = conv4) then
    insert into r2778_fail(label, detail) values ('W11 deactivated user wrote a row', ''); end if;

  -- ── LOG READ ──────────────────────────────────────────────────────────────────
  perform pg_temp.r2778_as(u_own);   select count(*) into v_n from public.ai_assistant_log where tenant_id = c_a; perform pg_temp.r2778_back();
  if v_n < 5 then insert into r2778_fail(label, detail) values ('R1 owner reads A', format('%s rows', v_n)); end if;
  perform pg_temp.r2778_as(u_man);   select count(*) into v_n from public.ai_assistant_log where tenant_id = c_a; perform pg_temp.r2778_back();
  if v_n < 5 then insert into r2778_fail(label, detail) values ('R2 manager reads A', format('%s rows', v_n)); end if;
  perform pg_temp.r2778_as(u_ob);    select count(*) into v_n from public.ai_assistant_log where tenant_id = c_a; perform pg_temp.r2778_back();
  if v_n <> 0 then insert into r2778_fail(label, detail) values ('R3 owner of B reads A (tenant leak)', format('%s rows', v_n)); end if;
  perform pg_temp.r2778_as(u_ob);    select count(*) into v_n from public.ai_assistant_log; perform pg_temp.r2778_back();
  if v_n <> 0 then insert into r2778_fail(label, detail) values ('R4 owner of B sees any row', format('%s rows', v_n)); end if;
  perform pg_temp.r2778_as(u_sal);   select count(*) into v_n from public.ai_assistant_log; perform pg_temp.r2778_back();
  if v_n <> 0 then insert into r2778_fail(label, detail) values ('R5 sales reads the log (owner/manager only)', format('%s rows', v_n)); end if;
  perform pg_temp.r2778_as(u_acc);   select count(*) into v_n from public.ai_assistant_log; perform pg_temp.r2778_back();
  if v_n <> 0 then insert into r2778_fail(label, detail) values ('R6 accountant reads the log', format('%s rows', v_n)); end if;
  perform pg_temp.r2778_as(u_off);   select count(*) into v_n from public.ai_assistant_log; perform pg_temp.r2778_back();
  if v_n <> 0 then insert into r2778_fail(label, detail) values ('R7 deactivated manager reads the log', format('%s rows', v_n)); end if;
  perform pg_temp.r2778_as(null);    set local role anon;
  begin
    select count(*) into v_n from public.ai_assistant_log;
    if v_n <> 0 then insert into r2778_fail(label, detail) values ('R8 anon reads', format('%s rows', v_n)); end if;
  exception when insufficient_privilege then null; end;
  reset role;

  -- ── MARKER on activity_log ────────────────────────────────────────────────────
  -- (a) header absent → the owner's own change, no marker
  perform pg_temp.r2778_as(u_own);
  update public.customers set name = 'R2778 Cust a' where id = cust;
  perform pg_temp.r2778_back();
  select * into v_row from public.activity_log where entity = 'customers' and entity_id = cust::text order by id desc limit 1;
  if v_row.id is null then insert into r2778_fail(label, detail) values ('M0 no activity row for own change', '');
  elsif v_row.via is not null or v_row.via_conversation_id is not null or v_row.user_id is distinct from u_own then
    insert into r2778_fail(label, detail) values ('M1 header absent must leave via null', format('via=%s user=%s', v_row.via, v_row.user_id)); end if;

  -- (b) header + the owner's own logged conversation → via ai, still the owner's user_id
  v_hdr := json_build_object('x-actor-via', 'ai', 'x-actor-conversation', conv1)::text;
  perform pg_temp.r2778_as(u_own, v_hdr);
  update public.customers set name = 'R2778 Cust b' where id = cust;
  perform pg_temp.r2778_back();
  select * into v_row from public.activity_log where entity = 'customers' and entity_id = cust::text order by id desc limit 1;
  if v_row.via is distinct from 'ai' or v_row.via_conversation_id is distinct from conv1 or v_row.user_id is distinct from u_own then
    insert into r2778_fail(label, detail) values ('M2 AI write must be marked', format('via=%s conv=%s user=%s', v_row.via, v_row.via_conversation_id, v_row.user_id)); end if;

  -- (c) forged: conversation nobody logged / another person's / two days old / not a uuid / via=other / not json
  foreach v_hdr in array array[
    json_build_object('x-actor-via', 'ai', 'x-actor-conversation', conv4)::text,
    json_build_object('x-actor-via', 'ai', 'x-actor-conversation', conv2)::text,
    json_build_object('x-actor-via', 'ai', 'x-actor-conversation', conv3)::text,
    json_build_object('x-actor-via', 'ai', 'x-actor-conversation', 'not-a-uuid')::text,
    json_build_object('x-actor-via', 'ai')::text,
    json_build_object('x-actor-via', 'human', 'x-actor-conversation', conv1)::text,
    'not json at all'
  ] loop
    perform pg_temp.r2778_as(u_own, v_hdr);
    update public.customers set name = 'R2778 Cust c ' || md5(v_hdr) where id = cust;
    perform pg_temp.r2778_back();
    select * into v_row from public.activity_log where entity = 'customers' and entity_id = cust::text order by id desc limit 1;
    if v_row.via is not null or v_row.via_conversation_id is not null then
      insert into r2778_fail(label, detail) values ('M3 forged marker honoured', v_hdr); end if;
    if v_row.user_id is distinct from u_own then
      insert into r2778_fail(label, detail) values ('M3b write lost its actor', v_hdr); end if;
  end loop;

  -- (d) log_activity() path
  perform pg_temp.r2778_as(u_own, json_build_object('x-actor-via', 'ai', 'x-actor-conversation', conv1)::text);
  perform public.log_activity('r2778_probe', 'r2778', 'p1', 'R2778 probe');
  perform pg_temp.r2778_back();
  select * into v_row from public.activity_log where entity = 'r2778' and action = 'r2778_probe' order by id desc limit 1;
  if v_row.via is distinct from 'ai' or v_row.via_conversation_id is distinct from conv1 then
    insert into r2778_fail(label, detail) values ('M4 log_activity marker', format('via=%s', v_row.via)); end if;
  perform pg_temp.r2778_as(u_own);
  perform public.log_activity('r2778_probe2', 'r2778', 'p2', 'R2778 probe 2');
  perform pg_temp.r2778_back();
  select * into v_row from public.activity_log where entity = 'r2778' and action = 'r2778_probe2' order by id desc limit 1;
  if v_row.via is not null then insert into r2778_fail(label, detail) values ('M5 log_activity without header marked', format('via=%s', v_row.via)); end if;

  -- (e) SQL/RPC path: app.actor_via + app.actor_conversation (like R-051's app.actor_id)
  perform pg_temp.r2778_as(u_own);
  perform set_config('app.actor_via', 'ai', true);
  perform set_config('app.actor_conversation', conv1::text, true);
  update public.customers set name = 'R2778 Cust e' where id = cust;
  perform set_config('app.actor_via', '', true);
  perform set_config('app.actor_conversation', '', true);
  perform pg_temp.r2778_back();
  select * into v_row from public.activity_log where entity = 'customers' and entity_id = cust::text order by id desc limit 1;
  if v_row.via is distinct from 'ai' then insert into r2778_fail(label, detail) values ('M6 app.actor_via path', format('via=%s', v_row.via)); end if;

  -- (f) the manager reads the marker; another company reads none
  perform pg_temp.r2778_as(u_man);
  select count(*) into v_n from public.activity_log where via = 'ai' and tenant_id = c_a;
  perform pg_temp.r2778_back();
  if v_n < 3 then insert into r2778_fail(label, detail) values ('M7 manager sees AI rows', format('%s rows', v_n)); end if;
  perform pg_temp.r2778_as(u_ob);
  select count(*) into v_n from public.activity_log where via = 'ai';
  perform pg_temp.r2778_back();
  if v_n <> 0 then insert into r2778_fail(label, detail) values ('M8 other company sees AI rows', format('%s rows', v_n)); end if;

  -- via only accepts 'ai'
  begin
    insert into public.activity_log (tenant_id, user_id, action, entity, via) values (c_a, u_own, 'x', 'x', 'robot');
    insert into r2778_fail(label, detail) values ('M9 via accepts any text', '');
  exception when check_violation then null; end;

  -- ── burst cap (last: it fills the log for the sales person) ───────────────────
  perform pg_temp.r2778_as(u_sal);
  for i in 1..150 loop
    perform public.log_ai_assistant_event(conv2, 'tool', 'burst_tool', 'read', null, 'did', null, null, 1, null, null, null);
  end loop;
  perform pg_temp.r2778_back();
  select count(*) into v_n from public.ai_assistant_log where user_id = u_sal and tool = 'burst_tool';
  if v_n > 120 then insert into r2778_fail(label, detail) values ('W12 burst cap', format('%s rows from one person in a minute', v_n)); end if;
end $t$;

select case when exists (select 1 from r2778_fail)
  then (select string_agg(label || ' :: ' || detail, E'\n' order by n) from r2778_fail)
  else 'PASS r2778_ai_assistant_log' end as result \gset
\echo :result
do $$ begin
  if exists (select 1 from r2778_fail) then raise exception 'R-2778 FAILED: % check(s)', (select count(*) from r2778_fail); end if;
end $$;

rollback;
