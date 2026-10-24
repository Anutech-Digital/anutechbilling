-- R-1132: set_books_lock() — owner and accountant lock; only the owner opens; others refused;
-- no company → refused (fails closed). Self-asserting; the whole file rolls back.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < this file

begin;

insert into auth.users (id, email) values
  ('b1132000-0000-0000-0000-0000000000a1', 'r1132-owner@example.test'),
  ('b1132000-0000-0000-0000-0000000000a2', 'r1132-acct@example.test'),
  ('b1132000-0000-0000-0000-0000000000a3', 'r1132-mgr@example.test'),
  ('b1132000-0000-0000-0000-0000000000a4', 'r1132-nocompany@example.test'),
  ('b1132000-0000-0000-0000-0000000000b2', 'r1132-other-acct@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('b1132000-0000-0000-0000-0000000000f0', 'R1132 T', 'r1132@example.test', '07', 'R1132'),
  ('b1132000-0000-0000-0000-0000000000f1', 'R1132 O', 'r1132o@example.test', '07', 'R1132O');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('b1132000-0000-0000-0000-0000000000a1', 'b1132000-0000-0000-0000-0000000000f0', 'r1132-owner@example.test', 'Owner', 'owner', true),
  ('b1132000-0000-0000-0000-0000000000a2', 'b1132000-0000-0000-0000-0000000000f0', 'r1132-acct@example.test', 'Acct', 'accountant', true),
  ('b1132000-0000-0000-0000-0000000000a3', 'b1132000-0000-0000-0000-0000000000f0', 'r1132-mgr@example.test', 'Mgr', 'manager', true),
  ('b1132000-0000-0000-0000-0000000000b2', 'b1132000-0000-0000-0000-0000000000f1', 'r1132-other-acct@example.test', 'Other Acct', 'accountant', true);

do $$
begin
  if has_function_privilege('anon', 'public.set_books_lock(date)', 'execute') then
    raise exception 'FAIL 0: anon can execute set_books_lock';
  end if;
  if not has_function_privilege('authenticated', 'public.set_books_lock(date)', 'execute') then
    raise exception 'FAIL 0: authenticated cannot execute set_books_lock';
  end if;
end $$;

create function pg_temp.as_user(p uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$f$;

create function pg_temp.refused(p_until date, p_code text, p_msg text) returns boolean language plpgsql as $f$
begin
  perform public.set_books_lock(p_until);
  return false;
exception when others then
  if sqlstate <> p_code or sqlerrm not like p_msg then
    raise exception 'wrong refusal: % %', sqlstate, sqlerrm;
  end if;
  return true;
end $f$;

grant execute on function pg_temp.as_user(uuid), pg_temp.refused(date, text, text) to authenticated;

set local role authenticated;

do $$
declare
  t constant uuid := 'b1132000-0000-0000-0000-0000000000f0';
  o constant uuid := 'b1132000-0000-0000-0000-0000000000f1';
  v date;
begin
  -- 1. accountant locks — the R-1132 hole
  perform pg_temp.as_user('b1132000-0000-0000-0000-0000000000a2');
  perform public.set_books_lock('2026-08-31');
  perform public.set_books_lock('2026-09-30');
  select books_locked_until into v from public.tenants where id = t;
  if v is distinct from '2026-09-30'::date then raise exception 'FAIL 1: accountant could not lock (got %)', v; end if;

  -- 2. accountant cannot move it back or open it
  if not pg_temp.refused('2026-08-31', '42501', '%Only the owner can open%') then raise exception 'FAIL 2a: accountant moved the lock back'; end if;
  if not pg_temp.refused(null, '42501', '%Only the owner can open%') then raise exception 'FAIL 2b: accountant removed the lock'; end if;

  -- 3. no future dates
  if not pg_temp.refused(((now() at time zone 'Asia/Kolkata')::date + 1), '22023', '%up to today%') then raise exception 'FAIL 3: future lock accepted'; end if;

  -- 4. manager refused
  perform pg_temp.as_user('b1132000-0000-0000-0000-0000000000a3');
  if not pg_temp.refused('2026-09-30', '42501', '%owner or the accountant%') then raise exception 'FAIL 4: manager set the lock'; end if;

  -- 5. no company → fails closed
  perform pg_temp.as_user('b1132000-0000-0000-0000-0000000000a4');
  if not pg_temp.refused('2026-09-30', '28000', '%Sign in to your company%') then raise exception 'FAIL 5: user with no company passed'; end if;

  -- 6. owner can move it back and open it
  perform pg_temp.as_user('b1132000-0000-0000-0000-0000000000a1');
  perform public.set_books_lock('2026-07-31');
  perform public.set_books_lock(null);
  reset role;
  select books_locked_until into v from public.tenants where id = t;
  if v is not null then raise exception 'FAIL 6: owner could not open the books (got %)', v; end if;

  -- 7. only the caller's own company moved
  select books_locked_until into v from public.tenants where id = o;
  if v is not null then raise exception 'FAIL 7: another company''s lock changed'; end if;

  raise notice 'R-1132 set_books_lock: all checks passed';
end $$;

rollback;
