-- R-2941 — database guards for "Working with" (R-2933) and Remind (R-2928).
-- Migration: 20261120011930_r2941_task_guards.sql
--
-- THE CASES (each FAILS LOUDLY — the file is self-asserting; every refusal must carry the
-- guard's OWN message, so a refusal by RLS / a foreign key does not pass for the wrong reason)
--   0. Shape: both trigger functions + triggers exist and are enabled, SECURITY DEFINER,
--      search_path '', RLS still on for task_collaborators, anon has no rights on it.
--   1. Own company, own task, own teammates: 3 collaborators go in (the route's path).
--   2. A 4th collaborator by direct insert is refused; a single INSERT of 4 rows is refused
--      whole; a swap at the limit (delete one, add one) works; re-adding the same person hits
--      the unique rule, not the limit.
--   3. No "does this uuid exist" oracle: another company's task, another company's user, a task
--      that does not exist and a user that does not exist all get the SAME message; a row for
--      another company's tenant_id is refused before anything is looked up.
--   4. Remind columns: a normal user cannot reset last_followup_at, cannot change
--      followup_count, cannot plant them on a new task (the insert keeps "never reminded");
--      the same user CAN still edit the title. The server path (service_role) can stamp and
--      roll back.
--   5. The server path is held to the invariants too: service_role cannot add a 4th person or
--      a person of another company.
--
-- NOT PROVEN HERE: two sessions inserting at the same moment. This file is one transaction, so
-- it cannot run two sessions; case 6 proves the guard holds the row lock on the task (mode
-- "For No Key Update") that makes a second session wait and then count the first one's row.
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.

begin;

-- ── 0. shape ────────────────────────────────────────────────────────────────────────
do $$
declare
  v_sig text;
  v_p record;
  v_t record;
begin
  foreach v_sig in array array['public.task_collaborators_guard()', 'public.tasks_followup_guard()'] loop
    if to_regprocedure(v_sig) is null then
      raise exception 'FAIL 0: % does not exist — migration not applied', v_sig;
    end if;
    select p.prosecdef, p.proconfig into v_p from pg_proc p where p.oid = to_regprocedure(v_sig);
    if not v_p.prosecdef or not ('search_path=""' = any (v_p.proconfig)) then
      raise exception 'FAIL 0: % must be SECURITY DEFINER with search_path '''' (got %, %)', v_sig, v_p.prosecdef, v_p.proconfig;
    end if;
  end loop;
  for v_t in select * from (values
      ('trg_task_collaborators_guard', 'public.task_collaborators'),
      ('trg_tasks_followup_guard',     'public.tasks')) as x(tg, tbl) loop
    if not exists (select 1 from pg_trigger t where t.tgname = v_t.tg and t.tgrelid = to_regclass(v_t.tbl) and t.tgenabled <> 'D') then
      raise exception 'FAIL 0: trigger % on % is missing or disabled', v_t.tg, v_t.tbl;
    end if;
  end loop;
  if not (select relrowsecurity from pg_class where oid = to_regclass('public.task_collaborators')) then
    raise exception 'FAIL 0: RLS is off on task_collaborators';
  end if;
  if has_table_privilege('anon', 'public.task_collaborators', 'select')
     or has_table_privilege('anon', 'public.task_collaborators', 'insert') then
    raise exception 'FAIL 0: anon has rights on task_collaborators';
  end if;
end $$;

-- ── fixture (superuser) ─────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('c2941000-0000-0000-0000-0000000000a1', 'r2941-owner@example.test'),
  ('c2941000-0000-0000-0000-0000000000a2', 'r2941-p2@example.test'),
  ('c2941000-0000-0000-0000-0000000000a3', 'r2941-p3@example.test'),
  ('c2941000-0000-0000-0000-0000000000a4', 'r2941-p4@example.test'),
  ('c2941000-0000-0000-0000-0000000000a5', 'r2941-p5@example.test'),
  ('c2941000-0000-0000-0000-0000000000b1', 'r2941-owner-b@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c2941000-0000-0000-0000-0000000000f1', 'R2941 A', 'r2941-a@example.test', '07', 'RGA1'),
  ('c2941000-0000-0000-0000-0000000000f2', 'R2941 B', 'r2941-b@example.test', '07', 'RGB1');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2941000-0000-0000-0000-0000000000a1', 'c2941000-0000-0000-0000-0000000000f1', 'r2941-owner@example.test',   'Owner A', 'owner', true),
  ('c2941000-0000-0000-0000-0000000000a2', 'c2941000-0000-0000-0000-0000000000f1', 'r2941-p2@example.test',      'P2',      'sales', true),
  ('c2941000-0000-0000-0000-0000000000a3', 'c2941000-0000-0000-0000-0000000000f1', 'r2941-p3@example.test',      'P3',      'sales', true),
  ('c2941000-0000-0000-0000-0000000000a4', 'c2941000-0000-0000-0000-0000000000f1', 'r2941-p4@example.test',      'P4',      'sales', true),
  ('c2941000-0000-0000-0000-0000000000a5', 'c2941000-0000-0000-0000-0000000000f1', 'r2941-p5@example.test',      'P5',      'sales', true),
  ('c2941000-0000-0000-0000-0000000000b1', 'c2941000-0000-0000-0000-0000000000f2', 'r2941-owner-b@example.test', 'Owner B', 'owner', true);

insert into public.tasks (id, tenant_id, owner_id, title, due_at) values
  ('c2941000-0000-0000-0000-0000000000d1', 'c2941000-0000-0000-0000-0000000000f1', 'c2941000-0000-0000-0000-0000000000a1', 'R2941 task A',  now() + interval '1 day'),
  ('c2941000-0000-0000-0000-0000000000d2', 'c2941000-0000-0000-0000-0000000000f1', 'c2941000-0000-0000-0000-0000000000a1', 'R2941 task A2', now() + interval '1 day'),
  ('c2941000-0000-0000-0000-0000000000d9', 'c2941000-0000-0000-0000-0000000000f2', 'c2941000-0000-0000-0000-0000000000b1', 'R2941 task B',  now() + interval '1 day');

set local role authenticated;

do $$
declare
  v_ta   uuid := 'c2941000-0000-0000-0000-0000000000f1';
  v_tb   uuid := 'c2941000-0000-0000-0000-0000000000f2';
  v_a1   uuid := 'c2941000-0000-0000-0000-0000000000a1';
  v_a2   uuid := 'c2941000-0000-0000-0000-0000000000a2';
  v_a3   uuid := 'c2941000-0000-0000-0000-0000000000a3';
  v_a4   uuid := 'c2941000-0000-0000-0000-0000000000a4';
  v_a5   uuid := 'c2941000-0000-0000-0000-0000000000a5';
  v_b1   uuid := 'c2941000-0000-0000-0000-0000000000b1';
  v_task uuid := 'c2941000-0000-0000-0000-0000000000d1';
  v_task2 uuid := 'c2941000-0000-0000-0000-0000000000d2';
  v_taskb uuid := 'c2941000-0000-0000-0000-0000000000d9';
  v_none uuid := 'c2941000-0000-0000-0000-00000000dead';
  v_msg  text;
  v_msgs text[] := '{}';
  v_n    integer;
  v_ts   timestamptz;
  v_new  uuid;
  v_case record;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', v_a2::text, 'role', 'authenticated')::text, true);
  if public.current_tenant_id() is distinct from v_ta then
    raise exception 'SETUP FAIL: current_tenant_id() is % — the impersonation did not take', public.current_tenant_id();
  end if;

  ------------------------------------------------------------ 1. the route's path works
  insert into public.task_collaborators (tenant_id, task_id, user_id, added_by) values
    (v_ta, v_task, v_a2, v_a2), (v_ta, v_task, v_a3, v_a2), (v_ta, v_task, v_a4, v_a2);
  select count(*) into v_n from public.task_collaborators where task_id = v_task;
  if v_n <> 3 then raise exception 'FAIL 1: expected 3 collaborators, got %', v_n; end if;

  ------------------------------------------------------------ 2. the limit of 3
  v_msg := null;
  begin
    insert into public.task_collaborators (tenant_id, task_id, user_id) values (v_ta, v_task, v_a5);
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null then raise exception 'FAIL 2a: a 4th collaborator went in by direct insert'; end if;
  if v_msg not like 'R-2941: a task can have up to 3 people%' then raise exception 'FAIL 2a: refused, but not by the guard: %', v_msg; end if;

  v_msg := null;
  begin
    insert into public.task_collaborators (tenant_id, task_id, user_id) values
      (v_ta, v_task2, v_a2), (v_ta, v_task2, v_a3), (v_ta, v_task2, v_a4), (v_ta, v_task2, v_a5);
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null then raise exception 'FAIL 2b: one INSERT of 4 rows went in'; end if;
  if v_msg not like 'R-2941: a task can have up to 3 people%' then raise exception 'FAIL 2b: refused, but not by the guard: %', v_msg; end if;
  select count(*) into v_n from public.task_collaborators where task_id = v_task2;
  if v_n <> 0 then raise exception 'FAIL 2b: the refused INSERT left % rows', v_n; end if;

  -- swap at the limit: remove one, add one
  delete from public.task_collaborators where task_id = v_task and user_id = v_a4;
  insert into public.task_collaborators (tenant_id, task_id, user_id) values (v_ta, v_task, v_a5);
  select count(*) into v_n from public.task_collaborators where task_id = v_task;
  if v_n <> 3 then raise exception 'FAIL 2c: swap at the limit left % rows', v_n; end if;

  -- the same person again: the unique rule answers, not the limit
  v_msg := null;
  begin
    insert into public.task_collaborators (tenant_id, task_id, user_id) values (v_ta, v_task, v_a2);
  exception when unique_violation then v_msg := 'unique';
            when others then v_msg := sqlerrm;
  end;
  if v_msg is distinct from 'unique' then raise exception 'FAIL 2d: a repeat of the same person should hit the unique rule, got %', v_msg; end if;

  ------------------------------------------------------------ 3. no existence oracle
  for v_case in select * from (values
      ('other company''s task', v_taskb, v_a3),
      ('other company''s user', v_task2, v_b1),
      ('both from the other company', v_taskb, v_b1),
      ('task that does not exist', v_none, v_a3),
      ('user that does not exist', v_task2, v_none)) as x(what, task_id, user_id) loop
    v_msg := null;
    begin
      insert into public.task_collaborators (tenant_id, task_id, user_id) values (v_ta, v_case.task_id, v_case.user_id);
    exception when others then v_msg := sqlstate || ' ' || sqlerrm;
    end;
    if v_msg is null then raise exception 'FAIL 3: % went in', v_case.what; end if;
    if v_msg not like '% R-2941: this task or this person is not in this company%' then
      raise exception 'FAIL 3: % refused, but not by the guard: %', v_case.what, v_msg;
    end if;
    v_msgs := v_msgs || v_msg;
  end loop;
  if (select count(distinct m) from unnest(v_msgs) m) <> 1 then
    raise exception 'FAIL 3: the refusals differ, so they tell which uuid exists: %', v_msgs;
  end if;

  -- a row for the other company's tenant_id: refused before any lookup, same answer whether
  -- the task / user exist there or not
  v_msgs := '{}';
  for v_case in select * from (values (v_taskb, v_b1), (v_none, v_none)) as x(task_id, user_id) loop
    v_msg := null;
    begin
      insert into public.task_collaborators (tenant_id, task_id, user_id) values (v_tb, v_case.task_id, v_case.user_id);
    exception when others then v_msg := sqlstate || ' ' || sqlerrm;
    end;
    if v_msg is null then raise exception 'FAIL 3b: a row for another company went in'; end if;
    if v_msg not like '42501 R-2941:%' then raise exception 'FAIL 3b: refused, but not by the guard: %', v_msg; end if;
    v_msgs := v_msgs || v_msg;
  end loop;
  if v_msgs[1] <> v_msgs[2] then raise exception 'FAIL 3b: the refusals differ: %', v_msgs; end if;

  ------------------------------------------------------------ 4. Remind columns
  -- the server stamps (service_role = the admin client of POST /api/tasks/remind)
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_ts := now() - interval '5 minutes';
  update public.tasks set last_followup_at = v_ts, followup_count = 1 where id = v_task;
  select followup_count into v_n from public.tasks where id = v_task;
  if v_n <> 1 then raise exception 'FAIL 4a: the server path could not stamp the reminder'; end if;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_a2::text, 'role', 'authenticated')::text, true);

  v_msg := null;
  begin
    update public.tasks set last_followup_at = null where id = v_task;
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null then raise exception 'FAIL 4b: a normal user reset last_followup_at'; end if;
  if v_msg not like 'R-2941: only the Remind button%' then raise exception 'FAIL 4b: refused, but not by the guard: %', v_msg; end if;

  v_msg := null;
  begin
    update public.tasks set followup_count = 0 where id = v_task;
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null then raise exception 'FAIL 4c: a normal user changed followup_count'; end if;
  if v_msg not like 'R-2941: only the Remind button%' then raise exception 'FAIL 4c: refused, but not by the guard: %', v_msg; end if;

  -- no over-block: the same user edits the task, and may send the two columns back unchanged
  update public.tasks set title = 'R2941 task A (edited)', last_followup_at = v_ts, followup_count = 1 where id = v_task;
  if (select title from public.tasks where id = v_task) <> 'R2941 task A (edited)' then
    raise exception 'FAIL 4d: a normal edit of the task did not go through';
  end if;
  if (select last_followup_at from public.tasks where id = v_task) is distinct from v_ts then
    raise exception 'FAIL 4d: the stamp moved';
  end if;

  -- a new task cannot be born "already reminded"
  insert into public.tasks (tenant_id, owner_id, title, due_at, last_followup_at, followup_count)
    values (v_ta, v_a3, 'R2941 planted', now() + interval '1 day', now() + interval '10 years', 7)
    returning id into v_new;
  if exists (select 1 from public.tasks where id = v_new and (last_followup_at is not null or followup_count <> 0)) then
    raise exception 'FAIL 4e: a user planted reminder values on a new task';
  end if;

  -- the server rolls a stamp back (remind-notice.server.ts when the notice could not be written)
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  update public.tasks set last_followup_at = null, followup_count = 0 where id = v_task;
  if exists (select 1 from public.tasks where id = v_task and (last_followup_at is not null or followup_count <> 0)) then
    raise exception 'FAIL 4f: the server path could not roll the stamp back';
  end if;

  ------------------------------------------------------------ 5. the server path keeps the invariants
  v_msg := null;
  begin
    insert into public.task_collaborators (tenant_id, task_id, user_id) values (v_ta, v_task, v_a4);
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'R-2941: a task can have up to 3 people%' then
    raise exception 'FAIL 5a: service_role added a 4th person (or another error): %', v_msg;
  end if;
  v_msg := null;
  begin
    insert into public.task_collaborators (tenant_id, task_id, user_id) values (v_ta, v_task2, v_b1);
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg is null or v_msg not like 'R-2941: this task or this person is not in this company%' then
    raise exception 'FAIL 5b: service_role added another company''s person (or another error): %', v_msg;
  end if;
  -- and it can still add an own-company person where there is room
  insert into public.task_collaborators (tenant_id, task_id, user_id) values (v_ta, v_task2, v_a2);
end $$;

reset role;

-- ── 6. the guard holds the task row while it counts ─────────────────────────────────
-- A second session's insert for the same task waits on this lock, so it counts only after the
-- first one committed. pgrowlocks shows the lock mode: the foreign key alone takes only
-- "For Key Share" (which two sessions can hold together); the guard must hold
-- "For No Key Update". Where the extension is not available the case is skipped with a notice.
do $$
declare
  v_modes  text[];
  v_schema text;
begin
  begin
    create extension if not exists pgrowlocks;
  exception when others then
    raise notice 'R-2941 case 6 SKIPPED: pgrowlocks cannot be used on this database (%)', sqlerrm;
    return;
  end;
  select n.nspname into v_schema from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pgrowlocks';

  insert into public.tasks (id, tenant_id, owner_id, title, due_at) values
    ('c2941000-0000-0000-0000-0000000000d3', 'c2941000-0000-0000-0000-0000000000f1', 'c2941000-0000-0000-0000-0000000000a1', 'R2941 lock probe', now() + interval '1 day');
  insert into public.task_collaborators (tenant_id, task_id, user_id) values
    ('c2941000-0000-0000-0000-0000000000f1', 'c2941000-0000-0000-0000-0000000000d3', 'c2941000-0000-0000-0000-0000000000a2');
  execute format($q$select l.modes from %I.pgrowlocks('public.tasks') l
             where l.locked_row = (select t.ctid from public.tasks t where t.id = 'c2941000-0000-0000-0000-0000000000d3')$q$, v_schema)
    into v_modes;
  if v_modes is null or not ('For No Key Update' = any (v_modes) or 'For Update' = any (v_modes)) then
    raise exception 'FAIL 6: adding a person did not lock the task row against a second writer (lock modes: %)', v_modes;
  end if;
end $$;

rollback;
