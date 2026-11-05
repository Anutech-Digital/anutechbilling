\set ON_ERROR_STOP on
-- R-2485: ONE answer to "is this a direct request login?" for every DB guard —
-- public.is_direct_request_login(). True for authenticated / anon / authenticator (Supabase,
-- PostgREST) AND the Cloud SQL logins that never `set role`: app_runtime (signed-in user via
-- the data gateway), app_anon (visitor), app_jobs (cron jobs). False for the migration owner
-- (what a SECURITY DEFINER body runs as), service_role / app_service (the server's admin client)
-- and psql / scripts.
-- R-2482 proved the gateway runs as app_runtime with no `set role`; attendance_direct_write_guard
-- only checked current_user <> 'authenticated', so a gateway login could edit its own attendance
-- times. The other guards each kept their own role list, and the lists disagreed (app_jobs,
-- app_anon, authenticator missing in some).
-- Migration: 20261105004823_r2485_direct_request_login_helper.sql. Rolled back — safe anywhere.
--
--   1  the helper: true for each request login, false for the owner, service_role / app_service
--      and inside a SECURITY DEFINER function
--   2  attendance: app_runtime / app_jobs / app_anon cannot change attendance times (RED before
--      R-2485 — the guard let every role except `authenticated` through); reviewed_at alone still
--      saves; the owner (correct_attendance path) still writes
--   3  tenants (R-720 + R-2110) and the R-2445 GSTIN-owner proof: app_jobs / app_anon refused
--   4  tenant_domains: app_anon cannot insert a verified domain
--   5  role_column_write_guard (R-719): app_jobs with no team role cannot change other columns
--   6  quotes insert (R-2447): app_jobs cannot insert an already-approved quote
--   7  users insert (R-2482) and phone verified (R-1903) still refuse the gateway logins
--   8  every guard: trigger present + enabled on its table, body calls the helper, says R-2485;
--      no public function body still lists request roles against current_user itself
--
-- The guard FUNCTIONS are fired on rolled-back temp copies of their tables (`like`), so a case
-- tests the guard itself — not the table grants or RLS that also stand in front of it (on Cloud
-- SQL, cloudsql/09 hands grants back; the trigger is the wall that must hold). Case 8 checks the
-- real triggers are on the real tables.

begin;

-- CI's plain Supabase has no gateway logins: stand-ins with the memberships
-- db/ops/10-runtime-roles.sql gives the real ones, only for this transaction.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_runtime') then
    create role app_runtime nologin in role authenticated;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_anon') then
    create role app_anon nologin in role anon;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_jobs') then
    create role app_jobs nologin in role authenticated;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_service') then
    create role app_service nologin in role service_role;
  end if;
end $$;
grant app_runtime to current_user;
grant app_anon to current_user;
grant app_jobs to current_user;
grant app_service to current_user;

create temp table r2485_result (step text, who text, msg text);
grant all on r2485_result to public;

-- ── 1: the helper ────────────────────────────────────────────────────────────────────────
do $$
declare r text; v boolean;
begin
  if to_regprocedure('public.is_direct_request_login()') is null then
    raise exception 'FAIL 1: public.is_direct_request_login() does not exist (R-2485)';
  end if;
  foreach r in array array['authenticated', 'anon', 'app_runtime', 'app_anon', 'app_jobs'] loop
    execute format('set local role %I', r);
    v := public.is_direct_request_login();
    reset role;
    if v is distinct from true then raise exception 'FAIL 1: helper says % is not a request login', r; end if;
  end loop;
  foreach r in array array['service_role', 'app_service'] loop
    execute format('set local role %I', r);
    v := public.is_direct_request_login();
    reset role;
    if v is distinct from false then raise exception 'FAIL 1: helper says % (the server) is a request login', r; end if;
  end loop;
  if public.is_direct_request_login() then
    raise exception 'FAIL 1: helper says the migration owner (%) is a request login', current_user;
  end if;
  if (select prosecdef from pg_proc where oid = 'public.is_direct_request_login()'::regprocedure) then
    raise exception 'FAIL 1: the helper is SECURITY DEFINER — current_user inside would always be its owner';
  end if;
  if (select prosrc not like '%authenticator%' from pg_proc where oid = 'public.is_direct_request_login()'::regprocedure) then
    raise exception 'FAIL 1: the helper list lost authenticator';
  end if;
end $$;

-- Inside a SECURITY DEFINER body (current_user = its owner) the helper is false even for app_runtime.
create function public.r2485_definer_probe() returns boolean
  language sql security definer set search_path = '' as $$ select public.is_direct_request_login() $$;
grant execute on function public.r2485_definer_probe() to authenticated;
do $$
declare v boolean;
begin
  set local role app_runtime;
  v := public.r2485_definer_probe();
  reset role;
  if v then raise exception 'FAIL 1: helper is true inside a SECURITY DEFINER function — definer paths would be refused'; end if;
end $$;

-- ── 2: attendance ────────────────────────────────────────────────────────────────────────
create temp table r2485_att (like public.attendance including defaults);
create trigger r2485_att_guard before insert or update or delete on r2485_att
  for each row execute function public.attendance_direct_write_guard();
grant all on r2485_att to public;
alter table r2485_att alter column id set default gen_random_uuid();
do $$
begin
  -- one row, every NOT NULL column without a default filled from a type-appropriate value
  execute (
    select 'insert into r2485_att (' || string_agg(quote_ident(a.attname), ', ') || ') values (' ||
           string_agg(case
             when t.typname = 'uuid' then 'gen_random_uuid()'
             when t.typname = 'date' then 'current_date'
             when t.typname in ('timestamptz', 'timestamp') then 'now()'
             when t.typname in ('int2', 'int4', 'int8', 'numeric') then '0'
             when t.typname = 'bool' then 'false'
             else quote_literal('x') end, ', ') || ')'
      from pg_attribute a join pg_type t on t.oid = a.atttypid
     where a.attrelid = 'r2485_att'::regclass and a.attnum > 0 and not a.attisdropped
       and a.attnotnull and a.atthasdef is false);
end $$;
update r2485_att set check_in = now() - interval '9 hours';

do $$
declare r text; m text;
begin
  foreach r in array array['app_runtime', 'app_jobs', 'app_anon', 'authenticated'] loop
    execute format('set local role %I', r);
    begin
      update r2485_att set check_in = check_in - interval '2 hours';
      m := 'UPDATED';
    exception when others then m := sqlerrm;
    end;
    reset role;
    insert into r2485_result values ('2 time edit', r, m);
    execute format('set local role %I', r);
    begin
      insert into r2485_att (id, tenant_id, employee_id, work_date)
        select gen_random_uuid(), tenant_id, employee_id, work_date + 1 from r2485_att limit 1;
      m := 'INSERTED';
    exception when others then m := sqlerrm;
    end;
    reset role;
    insert into r2485_result values ('2 insert', r, m);
  end loop;
end $$;
do $$
declare v record;
begin
  for v in select * from r2485_result where step like '2 %' loop
    if v.msg not like 'Attendance times can only be changed by the owner%' then
      raise exception 'FAIL 2: % as % was not refused by the attendance guard: "%" (R-2485: gateway logins bypassed it)', v.step, v.who, v.msg;
    end if;
  end loop;
  if (select count(*) from r2485_result where step like '2 %') <> 8 then raise exception 'FAIL 2: case count'; end if;
end $$;
-- reviewed_at alone still saves as a request login; the owner path writes times.
do $$
declare m text;
begin
  set local role app_runtime;
  begin
    update r2485_att set reviewed_at = now();
    m := 'OK';
  exception when others then m := sqlerrm;
  end;
  reset role;
  if m <> 'OK' then raise exception 'FAIL 2b: marking reviewed as app_runtime was refused: "%"', m; end if;
  update r2485_att set check_out = now();   -- the owner (SECURITY DEFINER correct_attendance) path
end $$;

-- ── 3: tenants (R-720 column guard + R-2445 GSTIN-owner proof) ──────────────────────────────
create temp table r2485_ten (like public.tenants including defaults);
create trigger r2485_ten_cols before insert or update on r2485_ten
  for each row execute function public.r720_tenants_column_guard();
create trigger r2485_ten_owner before insert or update on r2485_ten
  for each row execute function public.r2445_tenants_owner_guard();
grant all on r2485_ten to public;
insert into r2485_ten (id, name, email, state_code, doc_code, tier, gstin)
  values ('24850000-0000-4000-8000-0000000000a1', 'ZZ R2485 Co', 'r2485@example.invalid', '07', 'R85A', 'reseller',
          '07AAAAA0000A1Z5');
do $$
declare r text; m text;
begin
  foreach r in array array['app_jobs', 'app_anon', 'app_runtime'] loop
    execute format('set local role %I', r);
    begin update r2485_ten set tier = 'distributor'; m := 'UPDATED';
    exception when others then m := sqlerrm; end;
    reset role;
    insert into r2485_result values ('3 tier', r, m);
    execute format('set local role %I', r);
    begin update r2485_ten set gstin_owner_verified_at = now(), gstin_owner_verified_gstin = '07AAAAA0000A1Z5',
                               gstin_owner_verified_how = 'gstn'; m := 'UPDATED';
    exception when others then m := sqlerrm; end;
    reset role;
    insert into r2485_result values ('3 gstin owner', r, m);
  end loop;
end $$;
do $$
declare v record;
begin
  for v in select * from r2485_result where step like '3 %' loop
    if (v.step = '3 tier' and v.msg not like 'Workspace tier and parent distributor are set by the platform%')
       or (v.step = '3 gstin owner' and v.msg not like 'GSTIN ownership is recorded only by the ResellerOS check%') then
      raise exception 'FAIL 3: % as % not refused by its guard: "%"', v.step, v.who, v.msg;
    end if;
  end loop;
  if (select count(*) from r2485_result where step like '3 %') <> 6 then raise exception 'FAIL 3: case count'; end if;
end $$;
update r2485_ten set tier = 'distributor';   -- the platform (owner) still may

-- ── 4: tenant_domains ──────────────────────────────────────────────────────────────────────
create temp table r2485_dom (like public.tenant_domains including defaults);
create trigger r2485_dom_guard before insert or update on r2485_dom
  for each row execute function public.r720_tenant_domains_guard();
grant all on r2485_dom to public;
do $$
declare r text; m text;
begin
  foreach r in array array['app_anon', 'app_jobs', 'app_runtime'] loop
    execute format('set local role %I', r);
    begin
      insert into r2485_dom (id, tenant_id, domain, verified_at)
        values (gen_random_uuid(), '24850000-0000-4000-8000-0000000000a1', 'r2485-' || r || '.example.invalid', now());
      m := 'INSERTED';
    exception when others then m := sqlerrm;
    end;
    reset role;
    if m not like 'A domain is marked verified only after the DNS check%' then
      raise exception 'FAIL 4: % inserted a verified domain: "%"', r, m;
    end if;
  end loop;
end $$;

-- ── 5: role_column_write_guard (R-719) ─────────────────────────────────────────────────────
create temp table r2485_rc (id int primary key, note text, amount int);
create trigger r2485_rc_guard before update on r2485_rc
  for each row execute function public.role_column_write_guard('owner,manager', 'note');
grant all on r2485_rc to public;
insert into r2485_rc values (1, 'a', 100);
do $$
declare r text; m text;
begin
  foreach r in array array['app_jobs', 'app_anon', 'app_runtime'] loop
    execute format('set local role %I', r);
    perform set_config('app.user_id', '', true);
    begin update r2485_rc set amount = 1; m := 'UPDATED';
    exception when others then m := sqlerrm; end;
    reset role;
    if m not like 'Your role can change only note on r2485_rc%' then
      raise exception 'FAIL 5: % with no team role changed a money column: "%"', r, m;
    end if;
  end loop;
  set local role app_jobs;
  update r2485_rc set note = 'b';   -- the allowed column still saves
  reset role;
  update r2485_rc set amount = 2;   -- the owner still may
end $$;

-- ── 6: quotes insert (R-2447 / R-2470) ─────────────────────────────────────────────────────
create temp table r2485_q (like public.quotes including defaults);
create trigger r2485_q_guard before insert on r2485_q
  for each row execute function public.tg_quote_insert_approval_guard();
grant all on r2485_q to public;
do $$
declare r text; m text;
begin
  foreach r in array array['app_jobs', 'app_anon', 'app_runtime'] loop
    execute format('set local role %I', r);
    begin
      insert into r2485_q (id, tenant_id, approval_status) values ('Q-R2485-' || r, '24850000-0000-4000-8000-0000000000a1', 'approved');
      m := 'INSERTED';
    exception when others then m := sqlerrm;
    end;
    reset role;
    if m not like 'A new quote cannot be saved already approved%' then
      raise exception 'FAIL 6: % inserted an already-approved quote: "%"', r, m;
    end if;
  end loop;
end $$;

-- ── 7: users insert (R-2482) + phone verified (R-1903) ─────────────────────────────────────
create temp table r2485_u (like public.users including defaults);
create trigger r2485_u_ins before insert on r2485_u
  for each row execute function public.tg_users_insert_server_only();
create trigger r2485_u_phone before update on r2485_u
  for each row execute function public.r1903_users_phone_verified_guard();
grant all on r2485_u to public;
insert into r2485_u (id, tenant_id, email, role, phone)
  values ('24850000-0000-4000-8000-0000000000e1', '24850000-0000-4000-8000-0000000000a1', 'r2485-u@example.invalid', 'owner', '9999999999');
do $$
declare r text; m text;
begin
  foreach r in array array['app_runtime', 'app_anon', 'app_jobs'] loop
    execute format('set local role %I', r);
    begin
      insert into r2485_u (id, tenant_id, email, role)
        values (gen_random_uuid(), '24850000-0000-4000-8000-0000000000a1', 'r2485-x@example.invalid', 'owner');
      m := 'INSERTED';
    exception when others then m := sqlerrm;
    end;
    reset role;
    if m not like 'Team members are added through an invite or an approved join request.%' then
      raise exception 'FAIL 7: % inserted a users row: "%"', r, m;
    end if;
    execute format('set local role %I', r);
    perform set_config('app.r1903_phone_verify', 'on', true);   -- a login cannot borrow the RPC's flag
    begin
      update r2485_u set phone_verified_at = now();
      m := 'UPDATED';
    exception when others then m := sqlerrm;
    end;
    perform set_config('app.r1903_phone_verify', '', true);
    reset role;
    if m not like 'A mobile number is marked verified only by its OTP.%' then
      raise exception 'FAIL 7: % marked a phone verified: "%"', r, m;
    end if;
  end loop;
  -- verify_phone_otp's path (owner + flag) still works
  perform set_config('app.r1903_phone_verify', 'on', true);
  update r2485_u set phone_verified_at = now();
  perform set_config('app.r1903_phone_verify', '', true);
end $$;

-- ── 8: real triggers on real tables; bodies use the helper; no raw role list left ────────────
do $$
declare v record; n int;
begin
  for v in select * from (values
      ('public.attendance',     'trg_attendance_direct_write_guard', 'attendance_direct_write_guard'),
      ('public.users',          'trg_users_insert_server_only',      'tg_users_insert_server_only'),
      ('public.users',          'users_phone_verified_guard',        'r1903_users_phone_verified_guard'),
      ('public.tenants',        'a00_r720_tenants_column_guard',     'r720_tenants_column_guard'),
      ('public.tenants',        'a01_r2445_tenants_owner_guard',     'r2445_tenants_owner_guard'),
      ('public.tenant_domains', 'a00_r720_tenant_domains_guard',     'r720_tenant_domains_guard'),
      ('public.quotes',         null,                                'tg_quote_insert_approval_guard')) as t(tbl, trg, fn)
  loop
    if v.trg is not null and not exists (select 1 from pg_trigger where tgname = v.trg
                                          and tgrelid = to_regclass(v.tbl) and tgenabled <> 'D') then
      raise exception 'FAIL 8: trigger % missing or disabled on %', v.trg, v.tbl;
    end if;
    if v.trg is null and not exists (select 1 from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
                                      where tg.tgrelid = to_regclass(v.tbl) and p.proname = v.fn and tg.tgenabled <> 'D') then
      raise exception 'FAIL 8: no enabled trigger on % runs %', v.tbl, v.fn;
    end if;
    if not exists (select 1 from pg_proc where proname = v.fn and pronamespace = 'public'::regnamespace
                     and prosrc like '%is_direct_request_login()%' and prosrc like '%R-2485%') then
      raise exception 'FAIL 8: % does not use public.is_direct_request_login() (R-2485)', v.fn;
    end if;
  end loop;
  if not exists (select 1 from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
                  where p.proname = 'role_column_write_guard' and tg.tgenabled <> 'D' and tg.tgrelid::regclass::text not like '%r2485%') then
    raise exception 'FAIL 8: no table runs role_column_write_guard';
  end if;
  if not exists (select 1 from pg_proc where proname = 'role_column_write_guard' and prosrc like '%is_direct_request_login()%') then
    raise exception 'FAIL 8: role_column_write_guard does not use the helper';
  end if;
  select count(*) into n from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname <> 'is_direct_request_login'
     and p.prosrc ~* 'current_user(\s*::\s*text)?\s*(=|<>|!=|\min\M|\mnot\s+in\M)\s*\(?\s*''(authenticated|anon|authenticator|app_runtime|app_anon|app_jobs)''';
  if n > 0 then
    raise exception 'FAIL 8: % public function(s) still list request roles against current_user: %', n,
      (select string_agg(proname, ', ') from pg_proc p where p.pronamespace = 'public'::regnamespace
         and p.proname <> 'is_direct_request_login'
         and p.prosrc ~* 'current_user(\s*::\s*text)?\s*(=|<>|!=|\min\M|\mnot\s+in\M)\s*\(?\s*''(authenticated|anon|authenticator|app_runtime|app_anon|app_jobs)''');
  end if;
end $$;

rollback;
