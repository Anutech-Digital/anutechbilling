-- R-2661: Zoho Books API calls counted per company per IST day (zoho_api_day_calls + zoho_day_calls_add),
-- Zoho's own per-day refusal kept once, one reader at a time (zoho_reader_take / _release), a signed-in
-- user reads only their own company's rows, the RPCs are service_role only.
-- Self-asserting; the whole file rolls back.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < this file

begin;

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('b2661000-0000-0000-0000-0000000000f0', 'R2661 T', 'r2661@example.test', '07', 'R2661'),
  ('b2661000-0000-0000-0000-0000000000f1', 'R2661 O', 'r2661o@example.test', '07', 'R2661O');

-- 1. add twice = the sum; the first call makes the row; the other company's day is untouched.
do $$
declare
  r record;
begin
  select * into r from public.zoho_day_calls_add('b2661000-0000-0000-0000-0000000000f0', '2026-11-13', 3, false, null);
  if r.total <> 3 or r.hit_at is not null then raise exception 'R2661: first add should answer 3 / no hit, got % / %', r.total, r.hit_at; end if;
  select * into r from public.zoho_day_calls_add('b2661000-0000-0000-0000-0000000000f0', '2026-11-13', 2, false, null);
  if r.total <> 5 then raise exception 'R2661: second add should answer 5, got %', r.total; end if;
  if (select calls from public.zoho_api_day_calls where tenant_id = 'b2661000-0000-0000-0000-0000000000f0' and day = '2026-11-13') <> 5 then
    raise exception 'R2661: row should hold 5';
  end if;
  if exists (select 1 from public.zoho_api_day_calls where tenant_id = 'b2661000-0000-0000-0000-0000000000f1') then
    raise exception 'R2661: the other company got a row';
  end if;
  -- another day is another row
  select * into r from public.zoho_day_calls_add('b2661000-0000-0000-0000-0000000000f0', '2026-11-14', 1, false, null);
  if r.total <> 1 then raise exception 'R2661: a new day starts at its own count, got %', r.total; end if;
end $$;

-- 2. Zoho's per-day refusal marks the day ONCE (first time + words kept; a later one does not move it).
do $$
declare
  r record;
  v_first timestamptz;
begin
  select * into r from public.zoho_day_calls_add('b2661000-0000-0000-0000-0000000000f0', '2026-11-13', 1, true, 'API request limit for the day exceeded');
  if r.total <> 6 or r.hit_at is null then raise exception 'R2661: refusal should count the call and mark the day'; end if;
  v_first := r.hit_at;
  select * into r from public.zoho_day_calls_add('b2661000-0000-0000-0000-0000000000f0', '2026-11-13', 1, true, 'again');
  if r.hit_at <> v_first then raise exception 'R2661: limit_hit_at moved on a second refusal'; end if;
  if (select last_refusal from public.zoho_api_day_calls where tenant_id = 'b2661000-0000-0000-0000-0000000000f0' and day = '2026-11-13') <> 'again' then
    raise exception 'R2661: last_refusal should be the latest words';
  end if;
  -- negative / null calls add nothing
  select * into r from public.zoho_day_calls_add('b2661000-0000-0000-0000-0000000000f0', '2026-11-13', -4, false, null);
  if r.total <> 7 then raise exception 'R2661: a negative add should add nothing, got %', r.total; end if;
  select * into r from public.zoho_day_calls_add('b2661000-0000-0000-0000-0000000000f0', '2026-11-13', null, false, null);
  if r.total <> 7 then raise exception 'R2661: a null add should add nothing, got %', r.total; end if;
end $$;

-- 3. One reader at a time: the first takes it; a second is told who holds it; the holder renews; after
--    release (or an expired lease) the second gets it; a release by someone else changes nothing.
do $$
declare
  v text;
begin
  v := public.zoho_reader_take('b2661000-0000-0000-0000-0000000000f0', '2026-11-13', 'FY receipts 2025-26', now() + interval '3 minutes');
  if v is not null then raise exception 'R2661: the first reader should take the lease, got %', v; end if;
  v := public.zoho_reader_take('b2661000-0000-0000-0000-0000000000f0', '2026-11-13', 'Reconcile from Zoho', now() + interval '3 minutes');
  if v <> 'FY receipts 2025-26' then raise exception 'R2661: the second reader should be told the holder, got %', v; end if;
  v := public.zoho_reader_take('b2661000-0000-0000-0000-0000000000f0', '2026-11-13', 'FY receipts 2025-26', now() + interval '5 minutes');
  if v is not null then raise exception 'R2661: the holder should renew'; end if;
  -- another company is not in the way
  v := public.zoho_reader_take('b2661000-0000-0000-0000-0000000000f1', '2026-11-13', 'Reconcile from Zoho', now() + interval '3 minutes');
  if v is not null then raise exception 'R2661: another company blocked by this one'; end if;
  if public.zoho_reader_release('b2661000-0000-0000-0000-0000000000f0', '2026-11-13', 'Reconcile from Zoho') then
    raise exception 'R2661: a non-holder released the lease';
  end if;
  if not public.zoho_reader_release('b2661000-0000-0000-0000-0000000000f0', '2026-11-13', 'FY receipts 2025-26') then
    raise exception 'R2661: the holder could not release';
  end if;
  v := public.zoho_reader_take('b2661000-0000-0000-0000-0000000000f0', '2026-11-13', 'Reconcile from Zoho', now() + interval '3 minutes');
  if v is not null then raise exception 'R2661: after release the second reader should get it'; end if;
  -- an expired lease is free
  update public.zoho_api_day_calls set reader_until = now() - interval '1 second' where tenant_id = 'b2661000-0000-0000-0000-0000000000f0' and day = '2026-11-13';
  v := public.zoho_reader_take('b2661000-0000-0000-0000-0000000000f0', '2026-11-13', 'FY sales 2025-26', now() + interval '3 minutes');
  if v is not null then raise exception 'R2661: an expired lease should be free, got %', v; end if;
  -- the lease never touched the count
  if (select calls from public.zoho_api_day_calls where tenant_id = 'b2661000-0000-0000-0000-0000000000f0' and day = '2026-11-13') <> 7 then
    raise exception 'R2661: the reader lease changed the count';
  end if;
end $$;

-- 4. A signed-in user of company O sees nothing of company T; the RPCs are not theirs to call.
create temp table r2661_user as select gen_random_uuid() as id;
insert into auth.users (id, email) select id, 'r2661-user@example.test' from r2661_user;
insert into public.users (id, tenant_id, email, role) select id, 'b2661000-0000-0000-0000-0000000000f1', 'r2661-user@example.test', 'owner' from r2661_user;
do $$
declare
  v_uid uuid := (select id from r2661_user);
  n integer;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  select count(*) into n from public.zoho_api_day_calls where tenant_id = 'b2661000-0000-0000-0000-0000000000f0';
  if n <> 0 then raise exception 'R2661: a user of another company saw % row(s)', n; end if;
  select count(*) into n from public.zoho_api_day_calls where tenant_id = 'b2661000-0000-0000-0000-0000000000f1';
  if n <> 1 then raise exception 'R2661: a user should see own company''s row, saw %', n; end if;
  begin
    perform public.zoho_day_calls_add('b2661000-0000-0000-0000-0000000000f1', '2026-11-13', 1, false, null);
    raise exception 'R2661: authenticated could call zoho_day_calls_add';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.zoho_reader_take('b2661000-0000-0000-0000-0000000000f1', '2026-11-13', 'x', now());
    raise exception 'R2661: authenticated could call zoho_reader_take';
  exception when insufficient_privilege then null;
  end;
  perform set_config('role', 'postgres', true);
end $$;

rollback;
