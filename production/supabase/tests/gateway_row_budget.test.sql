-- Regression test: public.gateway_rows_add() — R-1005 daily row budget for low roles on /api/sb.
--
--   1. Browser roles cannot execute it (grant) and the body refuses an authenticated session.
--   2. Rows add up; allowed flips to false once used reaches the limit; retry is inside the window.
--   3. p_rows = 0 only reads; a finished window starts again from the new rows.
--   4. Bad input is refused.
-- SAFETY: everything in one transaction, rolled back.

begin;

do $$
begin
  if has_function_privilege('anon', 'public.gateway_rows_add(text, integer, integer, integer)', 'execute') then
    raise exception 'FAIL 1: anon can execute gateway_rows_add';
  end if;
  if has_function_privilege('authenticated', 'public.gateway_rows_add(text, integer, integer, integer)', 'execute') then
    raise exception 'FAIL 1: authenticated can execute gateway_rows_add';
  end if;
  if not has_function_privilege('service_role', 'public.gateway_rows_add(text, integer, integer, integer)', 'execute') then
    raise exception 'FAIL 1: service_role cannot execute gateway_rows_add';
  end if;
end $$;

do $$
declare v_blocked boolean := false; v_msg text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', '3caa0f07-44d1-42ee-91b3-2123e04853b1', 'role', 'authenticated')::text, true);
  begin
    perform public.gateway_rows_add('probe', 5, 10, 60000);
  exception when others then
    v_blocked := true; v_msg := sqlerrm;
  end;
  perform set_config('request.jwt.claims', '', true);
  if not v_blocked then raise exception 'FAIL 1b: authenticated session was not refused'; end if;
  if v_msg not like '%service_role only%' then raise exception 'FAIL 1b: refused for the wrong reason: %', v_msg; end if;
end $$;

set local role service_role;
do $$
declare r record;
begin
  select * into r from public.gateway_rows_add('r1005-test-key', 0, 100, 60000);
  if r.used <> 0 or not r.allowed then raise exception 'FAIL 2: fresh key used=% allowed=%', r.used, r.allowed; end if;
  select * into r from public.gateway_rows_add('r1005-test-key', 60, 100, 60000);
  if r.used <> 60 or not r.allowed then raise exception 'FAIL 2: after 60 used=% allowed=%', r.used, r.allowed; end if;
  select * into r from public.gateway_rows_add('r1005-test-key', 0, 100, 60000);
  if r.used <> 60 then raise exception 'FAIL 3: p_rows=0 changed the count to %', r.used; end if;
  select * into r from public.gateway_rows_add('r1005-test-key', 40, 100, 60000);
  if r.used <> 100 or r.allowed then raise exception 'FAIL 2: at limit used=% allowed=%', r.used, r.allowed; end if;
  if r.retry_after_sec < 1 or r.retry_after_sec > 60 then raise exception 'FAIL 2: retry_after_sec=%', r.retry_after_sec; end if;
end $$;
reset role;

-- window over → starts again
update public.rate_limit_buckets set reset_at = now() - interval '1 second' where key = 'r1005-test-key';
set local role service_role;
do $$
declare r record;
begin
  select * into r from public.gateway_rows_add('r1005-test-key', 7, 100, 60000);
  if r.used <> 7 or not r.allowed then raise exception 'FAIL 3: new window used=% allowed=%', r.used, r.allowed; end if;
end $$;

do $$
declare v_ok boolean;
begin
  begin perform public.gateway_rows_add('k', -1, 10, 60000); v_ok := true; exception when others then v_ok := false; end;
  if v_ok then raise exception 'FAIL 4: negative rows accepted'; end if;
  begin perform public.gateway_rows_add('k', 1, 10, 999999999); v_ok := true; exception when others then v_ok := false; end;
  if v_ok then raise exception 'FAIL 4: window over 24h accepted'; end if;
end $$;
reset role;

select 'gateway_row_budget: all checks passed' as result;
rollback;
