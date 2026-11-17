\set ON_ERROR_STOP on
-- R-2243: why customers leave — subscriptions.leave_reason_code written by cancel_subscription and
-- set_subscription_non_renewing.   Migration: 20261117051500_r2243_leave_reason.
-- Self-asserting, ONE transaction, rolled back:
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r2243_leave_reason.test.sql
-- Expect "PASS r2243_leave_reason".
--
--   COLUMN   a code outside the list is refused by the table check
--   CANCEL   code stored next to the sentence; a bad code refused; "Other" without a note refused,
--            "Other — note" accepted; a call WITHOUT a code still works (older callers), code stays null
--   WON'T    code stored; bad code refused; "Other" without a note refused
--   UNDO     Undo clears the code with the reason
--   LATER    Won't renew then Cancel: the cancel's code replaces it (one fact, one place)

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e2243000-0000-4000-8000-0000000000a1', 'r2243-owner@example.test');
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e2243000-0000-0000-0000-0000000000a0', 'R2243 A', 'r2243a@example.in', '07', 'R43A');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e2243000-0000-4000-8000-0000000000a1', 'e2243000-0000-0000-0000-0000000000a0', 'r2243-owner@example.in', 'R2243 Owner', 'owner', true);
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e2243000-0000-4000-8000-0000000000c1', 'e2243000-0000-0000-0000-0000000000a0', 'R2243 Leaving Co', '07', 'India');
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, renewal_date)
select ('e2243000-0000-4000-8000-0000000000d' || n)::uuid, 'e2243000-0000-0000-0000-0000000000a0',
       'e2243000-0000-4000-8000-0000000000c1', 'R2243 Leaving Co', 'Plan ' || n, 'google', 1, 300, 'active',
       (now() at time zone 'Asia/Kolkata')::date + 30
  from generate_series(1, 4) n;

create function pg_temp.r2243_as(p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
end $$;
create function pg_temp.r2243_cancel(p_sub uuid, p_reason text, p_code text) returns text language plpgsql as $$
begin
  if p_code is null then
    perform public.cancel_subscription(p_sub, (now() at time zone 'Asia/Kolkata')::date, p_reason, false);
  else
    perform public.cancel_subscription(p_sub, (now() at time zone 'Asia/Kolkata')::date, p_reason, false, p_code);
  end if;
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function pg_temp.r2243_nr(p_sub uuid, p_on boolean, p_reason text, p_code text) returns text language plpgsql as $$
begin
  perform public.set_subscription_non_renewing(p_sub, p_on, p_reason, null, p_code);
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
grant execute on function pg_temp.r2243_as(text) to authenticated, service_role;
grant execute on function pg_temp.r2243_cancel(uuid, text, text) to authenticated, service_role;
grant execute on function pg_temp.r2243_nr(uuid, boolean, text, text) to authenticated, service_role;

do $$
declare
  d1 constant uuid := 'e2243000-0000-4000-8000-0000000000d1';
  d2 constant uuid := 'e2243000-0000-4000-8000-0000000000d2';
  d3 constant uuid := 'e2243000-0000-4000-8000-0000000000d3';
  d4 constant uuid := 'e2243000-0000-4000-8000-0000000000d4';
  v_e text; v_s record;
begin
  -- COLUMN: the table check refuses a code outside the list (superuser, no RLS in the way).
  begin
    update public.subscriptions set leave_reason_code = 'because' where id = d1;
    raise exception 'FAIL: table accepted a code outside the list';
  exception when check_violation then null;
  end;

  perform set_config('request.jwt.claims', '', true);
  set local role authenticated;
  perform pg_temp.r2243_as('e2243000-0000-4000-8000-0000000000a1');

  -- CANCEL
  v_e := pg_temp.r2243_cancel(d1, 'Price too high — found it cheaper', 'price');
  if v_e is not null then raise exception 'FAIL: cancel with code refused: %', v_e; end if;
  select * into v_s from public.subscriptions where id = d1;
  if v_s.status <> 'cancelled' or v_s.leave_reason_code <> 'price' or v_s.cancel_reason <> 'Price too high — found it cheaper' then
    raise exception 'FAIL: cancel did not store status/code/sentence: % % %', v_s.status, v_s.leave_reason_code, v_s.cancel_reason;
  end if;

  v_e := pg_temp.r2243_cancel(d2, 'Moved to another provider', 'bogus');
  if v_e is null or v_e not like '22023:%' then raise exception 'FAIL: bad code not refused: %', coalesce(v_e, 'accepted'); end if;
  if (select status from public.subscriptions where id = d2) <> 'active' then raise exception 'FAIL: refused cancel still changed the row'; end if;

  v_e := pg_temp.r2243_cancel(d2, 'Other', 'other');
  if v_e is null or v_e not like '22023:%' then raise exception 'FAIL: Other without note not refused: %', coalesce(v_e, 'accepted'); end if;
  v_e := pg_temp.r2243_cancel(d2, 'Other — went abroad', 'other');
  if v_e is not null then raise exception 'FAIL: Other with a note refused: %', v_e; end if;
  if (select leave_reason_code from public.subscriptions where id = d2) <> 'other' then raise exception 'FAIL: Other not stored'; end if;

  -- an older caller (no code) still works; the code stays null
  v_e := pg_temp.r2243_cancel(d3, 'Customer closed their office', null);
  if v_e is not null then raise exception 'FAIL: cancel without code refused: %', v_e; end if;
  if (select leave_reason_code from public.subscriptions where id = d3) is not null then raise exception 'FAIL: code invented'; end if;

  -- WON'T RENEW
  v_e := pg_temp.r2243_nr(d4, true, 'Business closed', 'bogus');
  if v_e is null or v_e not like '22023:%' then raise exception 'FAIL: bad code not refused (won''t renew): %', coalesce(v_e, 'accepted'); end if;
  v_e := pg_temp.r2243_nr(d4, true, 'Other', 'other');
  if v_e is null or v_e not like '22023:%' then raise exception 'FAIL: Other without note not refused (won''t renew): %', coalesce(v_e, 'accepted'); end if;
  v_e := pg_temp.r2243_nr(d4, true, 'Business closed', 'closed');
  if v_e is not null then raise exception 'FAIL: won''t renew refused: %', v_e; end if;
  select * into v_s from public.subscriptions where id = d4;
  if v_s.auto_renew or v_s.leave_reason_code <> 'closed' or v_s.non_renew_reason <> 'Business closed' then
    raise exception 'FAIL: won''t renew did not store code/sentence: % % %', v_s.auto_renew, v_s.leave_reason_code, v_s.non_renew_reason;
  end if;

  -- LATER: cancel after Won't renew replaces the code
  v_e := pg_temp.r2243_cancel(d4, 'Not using it', 'not_using');
  if v_e is not null then raise exception 'FAIL: cancel after won''t renew refused: %', v_e; end if;
  if (select leave_reason_code from public.subscriptions where id = d4) <> 'not_using' then raise exception 'FAIL: cancel code did not replace'; end if;

  reset role;
end $$;

-- UNDO: on a fresh subscription (d1..d4 are all cancelled now)
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, renewal_date)
values ('e2243000-0000-4000-8000-0000000000d9', 'e2243000-0000-0000-0000-0000000000a0',
        'e2243000-0000-4000-8000-0000000000c1', 'R2243 Leaving Co', 'Undo plan', 'google', 1, 300, 'active',
        (now() at time zone 'Asia/Kolkata')::date + 30);
do $$
declare
  d9 constant uuid := 'e2243000-0000-4000-8000-0000000000d9';
  v_e text; v_s record;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2243000-0000-4000-8000-0000000000a1', 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_e := pg_temp.r2243_nr(d9, true, 'Fewer users / downsizing', 'downsized');
  if v_e is not null then raise exception 'FAIL: won''t renew refused: %', v_e; end if;
  v_e := pg_temp.r2243_nr(d9, false, null, null);
  if v_e is not null then raise exception 'FAIL: undo refused: %', v_e; end if;
  select * into v_s from public.subscriptions where id = d9;
  if not v_s.auto_renew or v_s.leave_reason_code is not null or v_s.non_renew_reason is not null then
    raise exception 'FAIL: undo did not clear code and reason: % % %', v_s.auto_renew, v_s.leave_reason_code, v_s.non_renew_reason;
  end if;
  reset role;
end $$;

do $$ begin raise notice 'PASS r2243_leave_reason'; end $$;
rollback;
