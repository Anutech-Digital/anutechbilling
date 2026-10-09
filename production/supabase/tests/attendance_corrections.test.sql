-- R-603 (9 Oct 2026): owner fixes a missed punch. Migration 20261009214500_attendance_corrections.
-- Self-asserting, ONE transaction, rolled back. scripts/test-sql.mjs runs it after the migrations.
--
-- Proves:
--   A. owner adds a missing day → row with source 'manual' + corrected_by/at/note.
--   B. owner fixes a forgotten checkout on a kiosk row → same row updated, still one row.
--   C. guards: no note, check_out <= check_in, check_out without check_in, future date,
--      other tenant's employee, a 'sales' user — all refused, nothing written.
--   D. both times null → row deleted (absent).

begin;

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000060301','R603 Co','r603@example.in','07','R603A'),
  ('dddddddd-0000-0000-0000-000000060302','R603 Other','r603b@example.in','07','R603B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000060301','owner603@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000060302','sales603@example.in');
insert into public.users (id, tenant_id, email, full_name, role) values
  ('aaaaaaaa-0000-0000-0000-000000060301','dddddddd-0000-0000-0000-000000060301','owner603@example.in','Owner 603','owner'),
  ('aaaaaaaa-0000-0000-0000-000000060302','dddddddd-0000-0000-0000-000000060301','sales603@example.in','Sales 603','sales');
insert into public.employees (id, tenant_id, name) values
  ('eeeeeeee-0000-0000-0000-000000060301','dddddddd-0000-0000-0000-000000060301','Ravi 603'),
  ('eeeeeeee-0000-0000-0000-000000060302','dddddddd-0000-0000-0000-000000060302','Other 603');
-- A kiosk punch with no checkout, 2 days ago (IST).
insert into public.attendance (tenant_id, employee_id, work_date, check_in, source)
  values ('dddddddd-0000-0000-0000-000000060301','eeeeeeee-0000-0000-0000-000000060301',
          (now() at time zone 'Asia/Kolkata')::date - 2,
          (((now() at time zone 'Asia/Kolkata')::date - 2)::text || 'T09:00:00+05:30')::timestamptz, 'kiosk');

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000060301","role":"authenticated"}', true);

-- A. add a missing day (yesterday)
do $$
declare d date := (now() at time zone 'Asia/Kolkata')::date - 1; r text; v record;
begin
  r := public.correct_attendance('eeeeeeee-0000-0000-0000-000000060301', d,
         (d::text || 'T09:30:00+05:30')::timestamptz, (d::text || 'T18:00:00+05:30')::timestamptz, '  Kiosk was down  ');
  if r <> 'saved' then raise exception 'FAIL A: returned %', r; end if;
  select * into v from public.attendance where employee_id = 'eeeeeeee-0000-0000-0000-000000060301' and work_date = d;
  if v.source <> 'manual' then raise exception 'FAIL A: source %', v.source; end if;
  if v.corrected_by <> 'aaaaaaaa-0000-0000-0000-000000060301' or v.corrected_at is null then raise exception 'FAIL A: corrected_by/at'; end if;
  if v.correction_note <> 'Kiosk was down' then raise exception 'FAIL A: note not trimmed: %', v.correction_note; end if;
  if v.check_in <> (d::text || 'T04:00:00Z')::timestamptz then raise exception 'FAIL A: check_in %', v.check_in; end if;
  raise notice 'PASS A: missing day added as manual with who + why';
end $$;

-- B. forgotten checkout on the kiosk row
do $$
declare d date := (now() at time zone 'Asia/Kolkata')::date - 2; n int; v record;
begin
  perform public.correct_attendance('eeeeeeee-0000-0000-0000-000000060301', d,
         (d::text || 'T09:00:00+05:30')::timestamptz, (d::text || 'T17:45:00+05:30')::timestamptz, 'Forgot checkout');
  select count(*) into n from public.attendance where employee_id = 'eeeeeeee-0000-0000-0000-000000060301' and work_date = d;
  if n <> 1 then raise exception 'FAIL B: % rows', n; end if;
  select * into v from public.attendance where employee_id = 'eeeeeeee-0000-0000-0000-000000060301' and work_date = d;
  if v.check_out is null or v.source <> 'manual' or v.correction_note <> 'Forgot checkout' then raise exception 'FAIL B: row not updated'; end if;
  raise notice 'PASS B: kiosk row updated in place';
end $$;

-- C. guards
do $$
declare d date := (now() at time zone 'Asia/Kolkata')::date - 3; ok boolean; n int;
begin
  ok := false; begin perform public.correct_attendance('eeeeeeee-0000-0000-0000-000000060301', d, (d::text||'T09:00:00+05:30')::timestamptz, null, ' x ');
    exception when others then ok := true; end;
  if not ok then raise exception 'FAIL C1: short note accepted'; end if;

  ok := false; begin perform public.correct_attendance('eeeeeeee-0000-0000-0000-000000060301', d, (d::text||'T09:00:00+05:30')::timestamptz, (d::text||'T09:00:00+05:30')::timestamptz, 'Bad times');
    exception when others then ok := true; end;
  if not ok then raise exception 'FAIL C2: check_out = check_in accepted'; end if;

  ok := false; begin perform public.correct_attendance('eeeeeeee-0000-0000-0000-000000060301', d, null, (d::text||'T18:00:00+05:30')::timestamptz, 'Out only');
    exception when others then ok := true; end;
  if not ok then raise exception 'FAIL C3: check_out without check_in accepted'; end if;

  ok := false; begin perform public.correct_attendance('eeeeeeee-0000-0000-0000-000000060301', (now() at time zone 'Asia/Kolkata')::date + 1, now() + interval '1 day', null, 'Future day');
    exception when others then ok := true; end;
  if not ok then raise exception 'FAIL C4: future date accepted'; end if;

  ok := false; begin perform public.correct_attendance('eeeeeeee-0000-0000-0000-000000060302', d, (d::text||'T09:00:00+05:30')::timestamptz, null, 'Other tenant');
    exception when others then ok := true; end;
  if not ok then raise exception 'FAIL C5: other tenant employee accepted'; end if;

  select count(*) into n from public.attendance where work_date = d and employee_id in ('eeeeeeee-0000-0000-0000-000000060301','eeeeeeee-0000-0000-0000-000000060302');
  if n <> 0 then raise exception 'FAIL C: refusals wrote % rows', n; end if;
  raise notice 'PASS C1-C5: note / times / future / tenant guards hold';
end $$;

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000060302","role":"authenticated"}', true);
do $$
declare d date := (now() at time zone 'Asia/Kolkata')::date - 3; ok boolean := false;
begin
  begin perform public.correct_attendance('eeeeeeee-0000-0000-0000-000000060301', d, (d::text||'T09:00:00+05:30')::timestamptz, null, 'Sales tries');
    exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL C6: sales user allowed'; end if;
  raise notice 'PASS C6: sales user refused';
end $$;

-- D. mark absent
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000060301","role":"authenticated"}', true);
do $$
declare d date := (now() at time zone 'Asia/Kolkata')::date - 1; r text;
begin
  r := public.correct_attendance('eeeeeeee-0000-0000-0000-000000060301', d, null, null, 'Was on leave');
  if r <> 'absent' then raise exception 'FAIL D: returned %', r; end if;
  if exists (select 1 from public.attendance where employee_id = 'eeeeeeee-0000-0000-0000-000000060301' and work_date = d) then
    raise exception 'FAIL D: row still there'; end if;
  raise notice 'PASS D: both times empty marks the day absent';
end $$;

rollback;
