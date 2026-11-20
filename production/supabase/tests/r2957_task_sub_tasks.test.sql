-- R-2957 — a task can have sub-tasks: tasks.parent_task_id + tasks.is_goal, the database guard
-- (public.tasks_goal_guard) and the two SQL counters (nav_badges, today_inbox).
-- Migration: <timestamp>_r2957_task_sub_tasks.sql
--
-- THE CASES (each FAILS LOUDLY; every refusal must carry the guard's OWN message, so a refusal
-- by RLS / a foreign key does not pass for the wrong reason)
--   0. Shape: both columns (parent nullable, is_goal not null default false), the foreign key
--      with ON DELETE SET NULL, the index, the trigger (enabled) and its function (SECURITY
--      INVOKER, search_path ''); the four RLS policies of tasks are the same four.
--   1. Old rows and a plain new task: parent null, is_goal false (a task-creating write that
--      names neither column keeps working).
--   2. Attaching the first sub-task turns the parent into a goal by itself; a second one too.
--   3. Another company's task as parent, and a parent that does not exist: the SAME message and
--      SQLSTATE (no "does this uuid exist" answer) — also when the row names the other company.
--   4. One level: a sub-task cannot get a sub-task; a task that has sub-tasks cannot become one.
--   5. A goal cannot become a sub-task (also a goal with no sub-tasks); a sub-task cannot be
--      marked a goal; a task cannot be its own parent.
--   6. A goal with sub-tasks cannot stop being a goal; once they are moved out, it can.
--   7. The server path (service_role) is held to the same rules.
--   8. Deleting a goal leaves its sub-tasks as separate tasks (parent → null), not refused.
--   9. The guard locks the parent row ("For No Key Update") so two writes at the same moment
--      go one after the other (pgrowlocks; skipped with a notice where it is not available).
--  10. Counters: nav_badges().tasks and today_inbox() count the sub-tasks and NOT the goal row.
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.

begin;

-- ── 0. shape ────────────────────────────────────────────────────────────────────────
do $$
declare
  v_p record;
  v_n integer;
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tasks'
                  and column_name = 'parent_task_id' and data_type = 'uuid' and is_nullable = 'YES') then
    raise exception 'FAIL 0: tasks.parent_task_id (uuid, nullable) is missing — migration not applied';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tasks'
                  and column_name = 'is_goal' and data_type = 'boolean' and is_nullable = 'NO' and column_default = 'false') then
    raise exception 'FAIL 0: tasks.is_goal (boolean not null default false) is missing';
  end if;
  if not exists (select 1 from pg_constraint c where c.conrelid = to_regclass('public.tasks') and c.contype = 'f'
                  and c.confrelid = to_regclass('public.tasks') and c.confdeltype = 'n') then
    raise exception 'FAIL 0: the parent_task_id foreign key (tasks → tasks, ON DELETE SET NULL) is missing';
  end if;
  if to_regclass('public.idx_tasks_tenant_parent') is null or to_regclass('public.idx_tasks_parent') is null then
    raise exception 'FAIL 0: the sub-task indexes are missing';
  end if;
  select p.prosecdef, p.proconfig into v_p from pg_proc p where p.oid = to_regprocedure('public.tasks_goal_guard()');
  if not found then raise exception 'FAIL 0: public.tasks_goal_guard() does not exist'; end if;
  if v_p.prosecdef or not ('search_path=""' = any (v_p.proconfig)) then
    raise exception 'FAIL 0: tasks_goal_guard must be SECURITY INVOKER with search_path '''' (got definer %, %)', v_p.prosecdef, v_p.proconfig;
  end if;
  if not exists (select 1 from pg_trigger t where t.tgname = 'trg_tasks_goal_guard' and t.tgrelid = to_regclass('public.tasks') and t.tgenabled <> 'D') then
    raise exception 'FAIL 0: trigger trg_tasks_goal_guard on tasks is missing or disabled';
  end if;
  select count(*) into v_n from pg_policy where polrelid = to_regclass('public.tasks')
     and polname in ('tasks_select', 'tasks_insert', 'tasks_update', 'tasks_delete');
  if v_n <> 4 or (select count(*) from pg_policy where polrelid = to_regclass('public.tasks')) <> 4 then
    raise exception 'FAIL 0: the RLS policies of tasks changed (expected exactly the 4 tenant policies)';
  end if;
  if not (select relrowsecurity from pg_class where oid = to_regclass('public.tasks')) then
    raise exception 'FAIL 0: RLS is off on tasks';
  end if;
end $$;

-- ── fixture (superuser) ─────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('c2957000-0000-0000-0000-0000000000a1', 'r2957-owner@example.test'),
  ('c2957000-0000-0000-0000-0000000000a2', 'r2957-rep@example.test'),
  ('c2957000-0000-0000-0000-0000000000b1', 'r2957-owner-b@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c2957000-0000-0000-0000-0000000000f1', 'R2957 A', 'r2957-a@example.test', '07', 'RHA1'),
  ('c2957000-0000-0000-0000-0000000000f2', 'R2957 B', 'r2957-b@example.test', '07', 'RHB1');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2957000-0000-0000-0000-0000000000a1', 'c2957000-0000-0000-0000-0000000000f1', 'r2957-owner@example.test',   'Owner A', 'owner', true),
  ('c2957000-0000-0000-0000-0000000000a2', 'c2957000-0000-0000-0000-0000000000f1', 'r2957-rep@example.test',     'Rep A',   'sales', true),
  ('c2957000-0000-0000-0000-0000000000b1', 'c2957000-0000-0000-0000-0000000000f2', 'r2957-owner-b@example.test', 'Owner B', 'owner', true);

-- All overdue (due an hour ago) and owned by Rep A, so every one of them is in both counters.
insert into public.tasks (id, tenant_id, owner_id, title, due_at) values
  ('c2957000-0000-0000-0000-0000000000d1', 'c2957000-0000-0000-0000-0000000000f1', 'c2957000-0000-0000-0000-0000000000a2', 'R2957 big job',  now() - interval '1 hour'),
  ('c2957000-0000-0000-0000-0000000000d2', 'c2957000-0000-0000-0000-0000000000f1', 'c2957000-0000-0000-0000-0000000000a2', 'R2957 step one', now() - interval '1 hour'),
  ('c2957000-0000-0000-0000-0000000000d3', 'c2957000-0000-0000-0000-0000000000f1', 'c2957000-0000-0000-0000-0000000000a2', 'R2957 step two', now() - interval '1 hour'),
  ('c2957000-0000-0000-0000-0000000000d4', 'c2957000-0000-0000-0000-0000000000f1', 'c2957000-0000-0000-0000-0000000000a2', 'R2957 other',    now() - interval '1 hour'),
  ('c2957000-0000-0000-0000-0000000000d9', 'c2957000-0000-0000-0000-0000000000f2', 'c2957000-0000-0000-0000-0000000000b1', 'R2957 task B',   now() - interval '1 hour');

set local role authenticated;

do $$
declare
  v_ta    uuid := 'c2957000-0000-0000-0000-0000000000f1';
  v_tb    uuid := 'c2957000-0000-0000-0000-0000000000f2';
  v_a2    uuid := 'c2957000-0000-0000-0000-0000000000a2';
  v_goal  uuid := 'c2957000-0000-0000-0000-0000000000d1';
  v_s1    uuid := 'c2957000-0000-0000-0000-0000000000d2';
  v_s2    uuid := 'c2957000-0000-0000-0000-0000000000d3';
  v_other uuid := 'c2957000-0000-0000-0000-0000000000d4';
  v_taskb uuid := 'c2957000-0000-0000-0000-0000000000d9';
  v_none  uuid := 'c2957000-0000-0000-0000-00000000dead';
  v_new   uuid;
  v_msg   text;
  v_state text;
  v_msgs  text[] := '{}';
  v_n     integer;
  v_b     boolean;
  v_case  record;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', v_a2::text, 'role', 'authenticated')::text, true);
  if public.current_tenant_id() is distinct from v_ta then
    raise exception 'SETUP FAIL: current_tenant_id() is % — the impersonation did not take', public.current_tenant_id();
  end if;

  ------------------------------------------------------------ 1. plain tasks are untouched
  select count(*) into v_n from public.tasks where parent_task_id is not null or is_goal;
  if v_n <> 0 then raise exception 'FAIL 1: % existing rows have a parent or are goals', v_n; end if;
  insert into public.tasks (tenant_id, owner_id, title, due_at) values (v_ta, v_a2, 'R2957 plain', now() + interval '1 day')
    returning id into v_new;
  if (select parent_task_id is not null or is_goal from public.tasks where id = v_new) then
    raise exception 'FAIL 1: a plain new task did not start with no parent and is_goal false';
  end if;
  delete from public.tasks where id = v_new;

  ------------------------------------------------------------ 2. first sub-task makes the goal
  update public.tasks set parent_task_id = v_goal where id = v_s1;
  select is_goal into v_b from public.tasks where id = v_goal;
  if not v_b then raise exception 'FAIL 2: the parent did not become a goal when its first sub-task was attached'; end if;
  -- a new task created straight under the goal
  insert into public.tasks (tenant_id, owner_id, title, due_at, parent_task_id) values (v_ta, v_a2, 'R2957 step three', now() + interval '1 day', v_goal)
    returning id into v_new;
  select count(*) into v_n from public.tasks where parent_task_id = v_goal;
  if v_n <> 2 then raise exception 'FAIL 2: expected 2 sub-tasks, got %', v_n; end if;
  delete from public.tasks where id = v_new;

  ------------------------------------------------------------ 3. no existence oracle
  for v_case in select * from (values
      ('another company''s task',                    v_ta, v_taskb),
      ('a task that does not exist',                 v_ta, v_none),
      ('another company''s task, their tenant_id',   v_tb, v_taskb)) as x(what, tenant, parent) loop
    v_msg := null; v_state := null;
    begin
      insert into public.tasks (tenant_id, owner_id, title, due_at, parent_task_id)
        values (v_case.tenant, v_a2, 'R2957 probe', now() + interval '1 day', v_case.parent);
    exception when others then v_msg := sqlerrm; v_state := sqlstate;
    end;
    if v_msg is null then raise exception 'FAIL 3: a sub-task under % went in', v_case.what; end if;
    -- All three are the guard's own answer: it runs before row-level security checks the new row, and for a
    -- signed-in user another company's task is simply not there.
    if v_state <> '23503' or v_msg not like 'R-2957: this goal is not in this company%' then
      raise exception 'FAIL 3 (%): refused, but not by the guard: % %', v_case.what, v_state, v_msg;
    end if;
    v_msgs := v_msgs || (v_state || ' ' || v_msg);
  end loop;
  if v_msgs[1] is distinct from v_msgs[2] or v_msgs[1] is distinct from v_msgs[3] then
    raise exception 'FAIL 3: "another company" and "does not exist" answer differently: %', v_msgs;
  end if;
  -- the same on an update of an existing task
  v_msg := null;
  begin update public.tasks set parent_task_id = v_taskb where id = v_other;
  exception when others then v_msg := sqlstate || ' ' || sqlerrm; end;
  if v_msg is distinct from v_msgs[1] then raise exception 'FAIL 3: moving a task under another company''s task: %', v_msg; end if;

  ------------------------------------------------------------ 4. one level only
  v_msg := null;
  begin update public.tasks set parent_task_id = v_s1 where id = v_other;
  exception when others then v_msg := sqlstate || ' ' || sqlerrm; end;
  if v_msg is null then raise exception 'FAIL 4a: a sub-task got a sub-task of its own'; end if;
  if v_msg not like '23514 R-2957: a sub-task cannot have sub-tasks%' then raise exception 'FAIL 4a: refused, but not by the guard: %', v_msg; end if;

  -- v_other gets a sub-task of its own first, then tries to go under the goal
  update public.tasks set parent_task_id = v_other where id = v_s2;
  v_msg := null;
  begin update public.tasks set parent_task_id = v_goal, is_goal = false where id = v_other;
  exception when others then v_msg := sqlstate || ' ' || sqlerrm; end;
  if v_msg is null then raise exception 'FAIL 4b: a task that has sub-tasks became a sub-task'; end if;
  if v_msg not like '23514 R-2957: a goal cannot be a sub-task%' then raise exception 'FAIL 4b: refused, but not by the guard: %', v_msg; end if;

  ------------------------------------------------------------ 5. goal / sub-task / self
  v_msg := null;
  begin update public.tasks set parent_task_id = v_goal where id = v_other;   -- v_other is a goal now
  exception when others then v_msg := sqlstate || ' ' || sqlerrm; end;
  if v_msg is null or v_msg not like '23514 R-2957: a goal cannot be a sub-task%' then raise exception 'FAIL 5a: a goal went under another goal: %', v_msg; end if;

  v_msg := null;
  begin update public.tasks set is_goal = true where id = v_s1;               -- v_s1 is a sub-task
  exception when others then v_msg := sqlstate || ' ' || sqlerrm; end;
  if v_msg is null or v_msg not like '23514 R-2957: a goal cannot be a sub-task%' then raise exception 'FAIL 5b: a sub-task was marked a goal: %', v_msg; end if;

  v_msg := null;
  begin
    insert into public.tasks (tenant_id, owner_id, title, due_at, parent_task_id, is_goal)
      values (v_ta, v_a2, 'R2957 both', now() + interval '1 day', v_goal, true);
  exception when others then v_msg := sqlstate || ' ' || sqlerrm; end;
  if v_msg is null or v_msg not like '23514 R-2957: a goal cannot be a sub-task%' then raise exception 'FAIL 5c: a new row is both goal and sub-task: %', v_msg; end if;

  -- a goal with no sub-tasks (marked by hand) still cannot go under a goal
  insert into public.tasks (tenant_id, owner_id, title, due_at, is_goal) values (v_ta, v_a2, 'R2957 empty goal', now() + interval '1 day', true)
    returning id into v_new;
  v_msg := null;
  begin update public.tasks set parent_task_id = v_goal where id = v_new;
  exception when others then v_msg := sqlstate || ' ' || sqlerrm; end;
  if v_msg is null or v_msg not like '23514 R-2957: a goal cannot be a sub-task%' then raise exception 'FAIL 5d: an empty goal went under a goal: %', v_msg; end if;
  -- …but it can be turned back into a task (no sub-tasks), and then it can
  update public.tasks set is_goal = false where id = v_new;
  update public.tasks set parent_task_id = v_goal where id = v_new;
  delete from public.tasks where id = v_new;

  v_msg := null;
  begin update public.tasks set parent_task_id = v_s2 where id = v_s2;
  exception when others then v_msg := sqlstate || ' ' || sqlerrm; end;
  if v_msg is null or v_msg not like '23514 R-2957: a task cannot be its own sub-task%' then raise exception 'FAIL 5e: a task became its own parent: %', v_msg; end if;

  ------------------------------------------------------------ 6. a goal with sub-tasks stays a goal
  v_msg := null;
  begin update public.tasks set is_goal = false where id = v_other;
  exception when others then v_msg := sqlstate || ' ' || sqlerrm; end;
  if v_msg is null then raise exception 'FAIL 6: is_goal was cleared on a task that still has sub-tasks'; end if;
  if v_msg not like '23514 R-2957: this goal still has sub-tasks%' then raise exception 'FAIL 6: refused, but not by the guard: %', v_msg; end if;
  -- move the sub-task out ("Move out of goal"): it is a separate task again, and the goal can be turned back
  update public.tasks set parent_task_id = null where id = v_s2;
  update public.tasks set parent_task_id = v_goal where id = v_s2;   -- "Add to goal": an existing task goes under the goal
  update public.tasks set parent_task_id = null where id = v_s2;
  update public.tasks set is_goal = false where id = v_other;
  if (select is_goal from public.tasks where id = v_other) then raise exception 'FAIL 6: an empty goal could not be turned back into a task'; end if;
  -- an unrelated edit of a sub-task and of a goal still works
  update public.tasks set title = 'R2957 step one (edited)', status = 'done' where id = v_s1;
  update public.tasks set status = 'pending' where id = v_s1;
  update public.tasks set title = 'R2957 big job (edited)' where id = v_goal;

  ------------------------------------------------------------ 10. the counters (as Rep A)
  -- Now: goal d1 (overdue) with one sub-task d2 (overdue); d3 and d4 are separate overdue tasks.
  -- Work = d2, d3, d4 → 3. The goal row is not counted.
  v_n := (public.nav_badges('{}')->>'tasks')::int;
  if v_n <> 3 then raise exception 'FAIL 10a: nav_badges().tasks = % (expected 3: the sub-task and two tasks, not the goal)', v_n; end if;
  select count(*) into v_n from public.today_inbox() i where i.kind = 'task';
  if v_n <> 3 then raise exception 'FAIL 10b: today_inbox() lists % tasks (expected 3, not the goal)', v_n; end if;
  if exists (select 1 from public.today_inbox() i where i.kind = 'task' and i.id = v_goal::text) then
    raise exception 'FAIL 10b: today_inbox() lists the goal row';
  end if;
  if not exists (select 1 from public.today_inbox() i where i.kind = 'task' and i.id = v_s1::text) then
    raise exception 'FAIL 10b: today_inbox() does not list the sub-task';
  end if;
end $$;

reset role;
select set_config('request.jwt.claims', '', true);

-- ── 7. the server path is held to the same rules ────────────────────────────────────
set local role service_role;
do $$
declare
  v_ta    uuid := 'c2957000-0000-0000-0000-0000000000f1';
  v_goal  uuid := 'c2957000-0000-0000-0000-0000000000d1';
  v_s1    uuid := 'c2957000-0000-0000-0000-0000000000d2';
  v_other uuid := 'c2957000-0000-0000-0000-0000000000d4';
  v_taskb uuid := 'c2957000-0000-0000-0000-0000000000d9';
  v_msg   text;
begin
  v_msg := null;
  begin insert into public.tasks (tenant_id, title, due_at, parent_task_id) values (v_ta, 'R2957 server probe', now() + interval '1 day', v_taskb);
  exception when others then v_msg := sqlstate || ' ' || sqlerrm; end;
  if v_msg is null or v_msg not like '23503 R-2957: this goal is not in this company%' then raise exception 'FAIL 7a: server path put a sub-task under another company''s task: %', v_msg; end if;

  v_msg := null;
  begin update public.tasks set parent_task_id = v_s1 where id = v_other;
  exception when others then v_msg := sqlstate || ' ' || sqlerrm; end;
  if v_msg is null or v_msg not like '23514 R-2957: a sub-task cannot have sub-tasks%' then raise exception 'FAIL 7b: server path made a second level: %', v_msg; end if;

  v_msg := null;
  begin update public.tasks set is_goal = false where id = v_goal;
  exception when others then v_msg := sqlstate || ' ' || sqlerrm; end;
  if v_msg is null or v_msg not like '23514 R-2957: this goal still has sub-tasks%' then raise exception 'FAIL 7c: server path cleared is_goal with sub-tasks: %', v_msg; end if;

  -- and a task with no parent still goes in on the server path (what every RPC that raises a task does)
  insert into public.tasks (tenant_id, title, due_at) values (v_ta, 'R2957 server task', now() + interval '1 day');
end $$;
reset role;

-- ── 9. the guard holds the parent row while it checks ───────────────────────────────
-- The foreign key alone takes "For Key Share" on the parent (two sessions can hold it together);
-- the guard must hold "For No Key Update", so a second writer for the same parent waits.
do $$
declare
  v_modes  text[];
  v_schema text;
begin
  begin
    create extension if not exists pgrowlocks;
  exception when others then
    raise notice 'R-2957 case 9 SKIPPED: pgrowlocks cannot be used on this database (%)', sqlerrm;
    return;
  end;
  select n.nspname into v_schema from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pgrowlocks';
  -- A fresh goal row nobody has written to since its insert, already a goal — so the attach does not
  -- update it and no earlier (refused) write of this file left a lock on it: any lock is the guard's.
  insert into public.tasks (id, tenant_id, title, due_at, is_goal) values ('c2957000-0000-0000-0000-0000000000e1', 'c2957000-0000-0000-0000-0000000000f1', 'R2957 lock probe goal', now() + interval '1 day', true);
  insert into public.tasks (id, tenant_id, title, due_at) values ('c2957000-0000-0000-0000-0000000000e2', 'c2957000-0000-0000-0000-0000000000f1', 'R2957 lock probe step', now() + interval '1 day');
  update public.tasks set parent_task_id = 'c2957000-0000-0000-0000-0000000000e1' where id = 'c2957000-0000-0000-0000-0000000000e2';
  execute format($q$select l.modes from %I.pgrowlocks('public.tasks') l
             where l.locked_row = (select t.ctid from public.tasks t where t.id = 'c2957000-0000-0000-0000-0000000000e1')$q$, v_schema)
    into v_modes;
  if v_modes is null or not ('For No Key Update' = any (v_modes) or 'For Update' = any (v_modes)) then
    raise exception 'FAIL 9: attaching a sub-task did not lock the goal row against a second writer (lock modes: %)', v_modes;
  end if;
end $$;

-- ── 8. deleting a goal frees its sub-tasks ──────────────────────────────────────────
do $$
declare
  v_n integer;
begin
  update public.tasks set parent_task_id = 'c2957000-0000-0000-0000-0000000000d1' where id = 'c2957000-0000-0000-0000-0000000000d3';
  if (select count(*) from public.tasks where parent_task_id = 'c2957000-0000-0000-0000-0000000000d1') <> 2 then raise exception 'FAIL 8: setup — the goal should have 2 sub-tasks'; end if;
  delete from public.tasks where id = 'c2957000-0000-0000-0000-0000000000d1';
  select count(*) into v_n from public.tasks
   where id in ('c2957000-0000-0000-0000-0000000000d2', 'c2957000-0000-0000-0000-0000000000d3') and parent_task_id is null and not is_goal;
  if v_n <> 2 then raise exception 'FAIL 8: after deleting the goal, % of its 2 sub-tasks are separate tasks', v_n; end if;
end $$;

rollback;
