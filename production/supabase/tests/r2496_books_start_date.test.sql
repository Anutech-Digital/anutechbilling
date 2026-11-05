-- R-2496: tenants.books_start_date + set_books_start_date() + books_start_for().
-- Owner only; no company → refused; never a future date; never later than a money row already in
-- the books (opening invoices dated before the start are fine); an activity_log row on each change;
-- a direct table write cannot change it; books_start_for = the setting, else opening as_of + 1.
-- Self-asserting; the whole file rolls back.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < this file

begin;

insert into auth.users (id, email) values
  ('b2496000-0000-0000-0000-0000000000a1', 'r2496-owner@example.test'),
  ('b2496000-0000-0000-0000-0000000000a2', 'r2496-acct@example.test'),
  ('b2496000-0000-0000-0000-0000000000a4', 'r2496-nocompany@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('b2496000-0000-0000-0000-0000000000f0', 'R2496 T', 'r2496@example.test', '07', 'R2496'),
  ('b2496000-0000-0000-0000-0000000000f1', 'R2496 O', 'r2496o@example.test', '07', 'R2496O');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('b2496000-0000-0000-0000-0000000000a1', 'b2496000-0000-0000-0000-0000000000f0', 'r2496-owner@example.test', 'Owner', 'owner', true),
  ('b2496000-0000-0000-0000-0000000000a2', 'b2496000-0000-0000-0000-0000000000f0', 'r2496-acct@example.test', 'Acct', 'accountant', true);

-- A money row inside the books (an expense of 10 May 2025) and the other company's opening date.
insert into public.expenses (id, tenant_id, category, amount, expense_date) values
  ('EXP-R2496-1', 'b2496000-0000-0000-0000-0000000000f0', 'Office Rent', 10000, '2025-05-10');
-- Review fix: the other money tables count too — a statutory dues payment of 5 May 2025 (earliest).
insert into public.statutory_dues_payments (tenant_id, amount, paid_on) values
  ('b2496000-0000-0000-0000-0000000000f0', 5000, '2025-05-05');
insert into public.opening_balances (tenant_id, as_of, owner_capital, retained_earnings) values
  ('b2496000-0000-0000-0000-0000000000f1', '2026-03-31', 100000, 0);

do $$
begin
  if to_regprocedure('public.set_books_start_date(date)') is null then
    raise exception 'FAIL 0: set_books_start_date(date) does not exist';
  end if;
  if has_function_privilege('anon', 'public.set_books_start_date(date)', 'execute') then
    raise exception 'FAIL 0: anon can execute set_books_start_date';
  end if;
  if not has_function_privilege('authenticated', 'public.set_books_start_date(date)', 'execute') then
    raise exception 'FAIL 0: authenticated cannot execute set_books_start_date';
  end if;
  -- books_start_for: the other company never set it → its opening date + 1.
  if public.books_start_for('b2496000-0000-0000-0000-0000000000f1') is distinct from '2026-04-01'::date then
    raise exception 'FAIL 0b: books_start_for fallback is not opening as_of + 1 (got %)', public.books_start_for('b2496000-0000-0000-0000-0000000000f1');
  end if;
  if public.books_start_for('b2496000-0000-0000-0000-0000000000f0') is not null then
    raise exception 'FAIL 0c: books_start_for with nothing set is not null';
  end if;
end $$;

create function pg_temp.as_user(p uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$f$;

create function pg_temp.refused(p_date date, p_code text, p_msg text) returns boolean language plpgsql as $f$
begin
  perform public.set_books_start_date(p_date);
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
  t constant uuid := 'b2496000-0000-0000-0000-0000000000f0';
  v date;
  n int;
begin
  -- 1. accountant refused (owner only)
  perform pg_temp.as_user('b2496000-0000-0000-0000-0000000000a2');
  if not pg_temp.refused('2025-04-01', '42501', '%Only the owner%') then raise exception 'FAIL 1: accountant set the books start'; end if;

  -- 2. no company → fails closed
  perform pg_temp.as_user('b2496000-0000-0000-0000-0000000000a4');
  if not pg_temp.refused('2025-04-01', '28000', '%Sign in to your company%') then raise exception 'FAIL 2: user with no company passed'; end if;

  perform pg_temp.as_user('b2496000-0000-0000-0000-0000000000a1');
  -- 3. never a future date
  if not pg_temp.refused(((now() at time zone 'Asia/Kolkata')::date + 1), '22023', '%future%') then raise exception 'FAIL 3: future books start accepted'; end if;

  -- 4. not later than the earliest money row already in the books (the 5 May 2025 statutory dues
  --    payment, before the 10 May expense)
  if not pg_temp.refused('2025-06-01', '22023', '%a statutory dues payment dated 5 May 2025%') then raise exception 'FAIL 4: books start after a money row accepted'; end if;

  -- 5. owner sets 1 Apr 2025 (Excel, 5 Nov) → stored, read back by books_start_for, one audit row
  perform public.set_books_start_date('2025-04-01');
  select books_start_date into v from public.tenants where id = t;
  if v is distinct from '2025-04-01'::date then raise exception 'FAIL 5a: not stored (got %)', v; end if;
  if public.books_start_for(t) is distinct from '2025-04-01'::date then raise exception 'FAIL 5b: books_start_for did not read the setting'; end if;
  -- the same date again → no second audit row
  perform public.set_books_start_date('2025-04-01');

  -- 6. a direct table write by the owner cannot change it
  begin
    update public.tenants set books_start_date = '2024-04-01' where id = t;
    raise exception 'FAIL 6: direct update of books_start_date passed';
  exception when insufficient_privilege then null;
  end;

  -- 7. clear → falls back (nothing set for this company → null)
  perform public.set_books_start_date(null);
  if public.books_start_for(t) is not null then raise exception 'FAIL 7: clear did not clear'; end if;

  reset role;
  select count(*) into n from public.activity_log where tenant_id = t and action = 'books.start_date_set';
  if n <> 2 then raise exception 'FAIL 8: expected 2 audit rows (set, clear), got %', n; end if;
  if not exists (select 1 from public.activity_log where tenant_id = t and action = 'books.start_date_set'
                  and changes#>>'{books_start_date,new}' = '2025-04-01' and (changes#>'{books_start_date,old}') = 'null'::jsonb
                  and user_id = 'b2496000-0000-0000-0000-0000000000a1') then
    raise exception 'FAIL 8b: audit row lacks books_start_date {old, new} / user';
  end if;

  -- 9. the other company untouched
  select books_start_date into v from public.tenants where id = 'b2496000-0000-0000-0000-0000000000f1';
  if v is not null then raise exception 'FAIL 9: another company''s books start changed'; end if;

  raise notice 'R-2496 books start: all checks passed';
end $$;

rollback;
