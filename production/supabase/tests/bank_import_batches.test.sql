-- R-1623 — bank statement import batches + "Remove import" (migration 20261020050000; refusal
-- and Activity log text in English since 20261023115842, R-1623b).
--
-- Self-asserting: RAISEs on failure. One transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/bank_import_batches.test.sql
--
-- What it proves:
--   1. import_bank_statement creates ONE batch per call and stamps every inserted line.
--   2. bank_import_history lists the batches AND the old (no-batch) imports, grouped by insert
--      time (> 60 s apart = another import); hand-typed lines are not listed.
--   3. remove_bank_import refuses: a sales role; another company; an empty reason; an import
--      with a reconciled line (message "1 of this import's 3 lines are reconciled — un-reconcile them first",
--      nothing deleted); a line booked by an expense with no match on the line itself; a
--      line inside the books lock.
--   4. It deletes ONLY that batch's lines, marks the batch removed (row kept), writes
--      activity_log, and refuses a second removal.
--   5. An old import (no batch) is removed by its insert-time range; the other old import and
--      the hand-typed line stay; a 'legacy' batch row records it.

begin;

-- ── Fixtures ─────────────────────────────────────────────────────────────────────────
insert into public.tenants (id, name, email, state_code) values
  ('c1623000-0000-0000-0000-0000000000a1'::uuid, 'R1623 A', 'r1623-a@example.in', '07'),
  ('c1623000-0000-0000-0000-0000000000b1'::uuid, 'R1623 B', 'r1623-b@example.in', '07');

insert into auth.users (id, email) values
  ('c1623000-0000-0000-0000-00000000a0a1', 'r1623-owner-a@example.test'),
  ('c1623000-0000-0000-0000-00000000a0a2', 'r1623-acct-a@example.test'),
  ('c1623000-0000-0000-0000-00000000a0a3', 'r1623-sales-a@example.test'),
  ('c1623000-0000-0000-0000-00000000b0b1', 'r1623-owner-b@example.test');
insert into public.users (id, tenant_id, email, role, full_name) values
  ('c1623000-0000-0000-0000-00000000a0a1', 'c1623000-0000-0000-0000-0000000000a1', 'r1623-owner-a@example.in', 'owner', 'Owner A'),
  ('c1623000-0000-0000-0000-00000000a0a2', 'c1623000-0000-0000-0000-0000000000a1', 'r1623-acct-a@example.in', 'accountant', 'Acct A'),
  ('c1623000-0000-0000-0000-00000000a0a3', 'c1623000-0000-0000-0000-0000000000a1', 'r1623-sales-a@example.in', 'sales', 'Sales A'),
  ('c1623000-0000-0000-0000-00000000b0b1', 'c1623000-0000-0000-0000-0000000000b1', 'r1623-owner-b@example.in', 'owner', 'Owner B');

insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date, is_active)
values ('c1623000-0000-0000-0000-0000000acc01'::uuid, 'c1623000-0000-0000-0000-0000000000a1'::uuid,
        'R1623 HDFC', 'HDFC', 'current', 10000, '2026-01-01', true);

-- Two OLD imports (no batch, as before this migration) 20 minutes apart, plus a hand-typed line.
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, balance_after, source, created_at)
select ('c1623000-0000-0000-0000-0000000001' || lpad(g::text, 2, '0'))::uuid,
       'c1623000-0000-0000-0000-0000000000a1', 'c1623000-0000-0000-0000-0000000acc01',
       date '2026-03-01' + g, 'OLD-ONE ' || g, 100, 0, 9900 - 100 * g, 'csv_upload',
       timestamptz '2026-10-17 11:29:05.123456+00' + (g || ' seconds')::interval   -- one import, a few seconds
  from generate_series(1, 4) g;
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, balance_after, source, created_at)
select ('c1623000-0000-0000-0000-0000000002' || lpad(g::text, 2, '0'))::uuid,
       'c1623000-0000-0000-0000-0000000000a1', 'c1623000-0000-0000-0000-0000000acc01',
       date '2026-04-01' + g, 'OLD-TWO ' || g, 0, 50, null, 'csv_upload',
       timestamptz '2026-10-17 11:49:00+00'
  from generate_series(1, 3) g;
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source, created_at)
values ('c1623000-0000-0000-0000-000000000301', 'c1623000-0000-0000-0000-0000000000a1', 'c1623000-0000-0000-0000-0000000acc01',
        '2026-03-03', 'TYPED BY HAND', 0, 700, 'manual', timestamptz '2026-10-17 11:29:06+00');

create temp table r1623_ids (k text primary key, v uuid);
grant all on r1623_ids to authenticated;

set local role authenticated;

-- ── 1. Import creates a batch and stamps its lines ───────────────────────────────────
do $$
declare v jsonb; v_b uuid; v_n int; v_stamped int; v_bl record;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1623000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  v := public.import_bank_statement('c1623000-0000-0000-0000-0000000acc01',
    '[{"txn_date":"2026-05-02","description":"JAN A","debit":100,"credit":0,"balance_after":9800.4},
      {"txn_date":"2026-05-03","description":"JAN B","debit":0,"credit":300,"balance_after":10100},
      {"txn_date":"2026-05-04","description":"JAN C","debit":200,"credit":0,"balance_after":9900,"category":"bank_charges","category_source":"rule","category_confidence":100}]'::jsonb,
    'jan.pdf', 'pdf');
  v_b := (v->>'batch_id')::uuid;
  if (v->>'inserted')::int <> 3 then raise exception 'FAIL 1a: inserted % (want 3)', v->>'inserted'; end if;
  select count(*) into v_stamped from public.bank_transactions where import_batch_id = v_b;
  if v_stamped <> 3 then raise exception 'FAIL 1b: % lines stamped with the batch (want 3)', v_stamped; end if;
  select * into v_bl from public.bank_import_batches where id = v_b;
  if v_bl.line_count <> 3 or v_bl.file_name <> 'jan.pdf' or v_bl.source <> 'pdf'
     or v_bl.txn_from <> '2026-05-02' or v_bl.txn_to <> '2026-05-04'
     or v_bl.created_by <> 'c1623000-0000-0000-0000-00000000a0a1' then
    raise exception 'FAIL 1c: batch row wrong: %', row_to_json(v_bl);
  end if;
  if exists (select 1 from public.bank_transactions where import_batch_id = v_b and source <> 'csv_upload') then
    raise exception 'FAIL 1d: imported lines must keep source csv_upload';
  end if;
  insert into r1623_ids values ('jan', v_b);

  v := public.import_bank_statement('c1623000-0000-0000-0000-0000000acc01',
    '[{"txn_date":"2026-06-02","description":"FEB A","debit":10,"credit":0},
      {"txn_date":"2026-06-03","description":"FEB B","debit":0,"credit":20}]'::jsonb, 'feb.csv', 'csv');
  insert into r1623_ids values ('feb', (v->>'batch_id')::uuid);
  if (v->>'batch_id')::uuid = v_b then raise exception 'FAIL 1e: second import reused the first batch'; end if;
  raise notice 'PASS 1: one batch per import, every line stamped';
end $$;

-- ── 2. History: batches + old imports grouped by insert time ─────────────────────────
do $$
declare v_b int; v_l int; v_one record; v_two record;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1623000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  select count(*) filter (where kind = 'batch'), count(*) filter (where kind = 'legacy') into v_b, v_l
    from public.bank_import_history('c1623000-0000-0000-0000-0000000acc01');
  if v_b <> 2 or v_l <> 2 then raise exception 'FAIL 2a: % batches / % old imports (want 2 / 2)', v_b, v_l; end if;
  select * into v_one from public.bank_import_history('c1623000-0000-0000-0000-0000000acc01')
   where kind = 'legacy' and legacy_from like '2026-10-17T11:29%';
  select * into v_two from public.bank_import_history('c1623000-0000-0000-0000-0000000acc01')
   where kind = 'legacy' and legacy_from like '2026-10-17T11:49%';
  if v_one.line_count <> 4 or v_two.line_count <> 3 then
    raise exception 'FAIL 2b: old import sizes % / % (want 4 / 3 — the hand-typed line is not an import)', v_one.line_count, v_two.line_count;
  end if;
  if v_one.legacy_from <> '2026-10-17T11:29:06.123456Z' or v_one.legacy_to <> '2026-10-17T11:29:09.123456Z' then
    raise exception 'FAIL 2c: old import range lost precision: % .. %', v_one.legacy_from, v_one.legacy_to;
  end if;
  if v_one.txn_from <> '2026-03-02' or v_one.txn_to <> '2026-03-05' or v_one.first_balance <> 9800 or v_one.last_balance <> 9500 then
    raise exception 'FAIL 2d: old import dates/balances wrong: %', row_to_json(v_one);
  end if;
  if (select imported_by from public.bank_import_history('c1623000-0000-0000-0000-0000000acc01') where batch_id = (select v from r1623_ids where k = 'jan')) <> 'Owner A' then
    raise exception 'FAIL 2e: batch does not say who imported it';
  end if;
  -- another company sees nothing of A's account
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1623000-0000-0000-0000-00000000b0b1', 'role', 'authenticated')::text, true);
  if exists (select 1 from public.bank_import_history('c1623000-0000-0000-0000-0000000acc01')) then
    raise exception 'FAIL 2f: another company can list A''s imports';
  end if;
  if exists (select 1 from public.bank_import_batches) then
    raise exception 'FAIL 2g: another company can read A''s batch rows';
  end if;
  raise notice 'PASS 2: history = 2 batches + 2 old imports grouped by insert time; tenant-isolated';
end $$;

-- ── 3. Refusals ──────────────────────────────────────────────────────────────────────
do $$
declare v_jan uuid := (select v from r1623_ids where k = 'jan'); v_msg text; v_n int;
begin
  -- 3a. sales role
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1623000-0000-0000-0000-00000000a0a3', 'role', 'authenticated')::text, true);
  begin
    perform public.remove_bank_import('c1623000-0000-0000-0000-0000000acc01', v_jan, null, null, 'galat file');
    raise exception 'FAIL 3a: a sales user removed an import';
  exception when insufficient_privilege then
    if sqlerrm not like 'Only an owner or accountant can remove an import.%' then raise exception 'FAIL 3a msg: %', sqlerrm; end if;
  end;
  -- 3b. sales cannot import either
  begin
    perform public.import_bank_statement('c1623000-0000-0000-0000-0000000acc01', '[{"txn_date":"2026-05-09","description":"X","debit":1,"credit":0}]', 'x.csv', 'csv');
    raise exception 'FAIL 3b: a sales user imported';
  exception when insufficient_privilege then null;
  end;

  -- 3c. another company's owner
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1623000-0000-0000-0000-00000000b0b1', 'role', 'authenticated')::text, true);
  begin
    perform public.remove_bank_import('c1623000-0000-0000-0000-0000000acc01', v_jan, null, null, 'galat file');
    raise exception 'FAIL 3c: another company removed A''s import';
  exception when no_data_found then
    if sqlerrm not like 'This bank account was not found%' then raise exception 'FAIL 3c msg: %', sqlerrm; end if;
  end;
  begin
    perform public.import_bank_statement('c1623000-0000-0000-0000-0000000acc01', '[{"txn_date":"2026-05-09","description":"X","debit":1,"credit":0}]', 'x.csv', 'csv');
    raise exception 'FAIL 3d: another company imported into A''s account';
  exception when no_data_found then null;
  end;

  -- 3e. no session company at all
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1623000-0000-0000-0000-00000000ffff', 'role', 'authenticated')::text, true);
  begin
    perform public.remove_bank_import('c1623000-0000-0000-0000-0000000acc01', v_jan, null, null, 'galat file');
    raise exception 'FAIL 3e: a user with no company removed an import';
  exception when invalid_authorization_specification then null;
  end;

  -- 3f. empty reason
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1623000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  begin
    perform public.remove_bank_import('c1623000-0000-0000-0000-0000000acc01', v_jan, null, null, '  ');
    raise exception 'FAIL 3f: removed with no reason';
  exception when invalid_parameter_value then null;
  end;
  select count(*) into v_n from public.bank_transactions where import_batch_id = v_jan;
  if v_n <> 3 then raise exception 'FAIL 3: a refusal deleted lines (% left, want 3)', v_n; end if;
  raise notice 'PASS 3a-f: sales / other company / no company / no reason refused, nothing deleted';
end $$;

-- 3g. a reconciled line refuses the WHOLE removal, with the §24 message
reset role;
update public.bank_transactions set matched_to_type = 'manual', matched_at = now()
 where id = (select id from public.bank_transactions where description = 'JAN B' and tenant_id = 'c1623000-0000-0000-0000-0000000000a1');
set local role authenticated;
do $$
declare v_jan uuid := (select v from r1623_ids where k = 'jan'); v_n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1623000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  begin
    perform public.remove_bank_import('c1623000-0000-0000-0000-0000000acc01', v_jan, null, null, 'galat file');
    raise exception 'FAIL 3g: removed an import with a reconciled line';
  exception when raise_exception then
    if sqlerrm not like '1 of this import''s 3 lines are reconciled — un-reconcile them first.%' then raise exception 'FAIL 3g msg: %', sqlerrm; end if;
  end;
  select count(*) into v_n from public.bank_transactions where import_batch_id = v_jan;
  if v_n <> 3 then raise exception 'FAIL 3g: lines deleted despite the refusal (% left)', v_n; end if;
  raise notice 'PASS 3g: reconciled line → "1 of this import''s 3 lines are reconciled — un-reconcile them first", nothing deleted';
end $$;

-- 3h. a line booked by an expense (reverse link only) also refuses
reset role;
update public.bank_transactions set matched_to_type = null, matched_at = null where description = 'JAN B' and tenant_id = 'c1623000-0000-0000-0000-0000000000a1';
insert into public.expenses (id, tenant_id, category, expense_date, amount, reconciled_txn_id)
values ('EXP-R1623-1', 'c1623000-0000-0000-0000-0000000000a1', 'software', '2026-05-04', 200,
        (select id from public.bank_transactions where description = 'JAN C' and tenant_id = 'c1623000-0000-0000-0000-0000000000a1'));
set local role authenticated;
do $$
declare v_jan uuid := (select v from r1623_ids where k = 'jan');
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1623000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  begin
    perform public.remove_bank_import('c1623000-0000-0000-0000-0000000acc01', v_jan, null, null, 'galat file');
    raise exception 'FAIL 3h: removed an import whose line an expense is booked against';
  exception when raise_exception then
    if sqlerrm not like '1 of this import''s 3 lines are reconciled%' then raise exception 'FAIL 3h msg: %', sqlerrm; end if;
  end;
  raise notice 'PASS 3h: a line booked by an expense refuses too';
end $$;

-- 3i. books lock
reset role;
delete from public.expenses where id = 'EXP-R1623-1';
update public.tenants set books_locked_until = '2026-05-31' where id = 'c1623000-0000-0000-0000-0000000000a1';
set local role authenticated;
do $$
declare v_jan uuid := (select v from r1623_ids where k = 'jan'); v_n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1623000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  begin
    perform public.remove_bank_import('c1623000-0000-0000-0000-0000000acc01', v_jan, null, null, 'galat file');
    raise exception 'FAIL 3i: removed lines inside the books lock';
  exception when raise_exception then
    if sqlerrm not like '3 of this import''s lines (the first dated 02 May 2026) are in closed books — the books are locked up to 31 May 2026.%Month-end close%' then
      raise exception 'FAIL 3i msg: %', sqlerrm;
    end if;
  end;
  select count(*) into v_n from public.bank_transactions where import_batch_id = v_jan;
  if v_n <> 3 then raise exception 'FAIL 3i: lines deleted despite the lock (% left)', v_n; end if;
  raise notice 'PASS 3i: books lock refuses with the unlock step';
end $$;
reset role;
update public.tenants set books_locked_until = null where id = 'c1623000-0000-0000-0000-0000000000a1';
set local role authenticated;

-- ── 4. Remove a batch: only its lines, batch kept + marked, activity logged ──────────
do $$
declare
  v_jan uuid := (select v from r1623_ids where k = 'jan');
  v_feb uuid := (select v from r1623_ids where k = 'feb');
  v jsonb; v_b record; v_n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1623000-0000-0000-0000-00000000a0a2', 'role', 'authenticated')::text, true);   -- accountant
  v := public.remove_bank_import('c1623000-0000-0000-0000-0000000acc01', v_jan, null, null, 'galat statement chadh gaya');
  if (v->>'removed')::int <> 3 then raise exception 'FAIL 4a: removed % (want 3)', v->>'removed'; end if;
  if exists (select 1 from public.bank_transactions where import_batch_id = v_jan) then raise exception 'FAIL 4b: batch lines still there'; end if;
  select count(*) into v_n from public.bank_transactions where import_batch_id = v_feb;
  if v_n <> 2 then raise exception 'FAIL 4c: the OTHER batch lost lines (% left, want 2)', v_n; end if;
  select count(*) into v_n from public.bank_transactions where tenant_id = 'c1623000-0000-0000-0000-0000000000a1' and import_batch_id is null;
  if v_n <> 8 then raise exception 'FAIL 4d: old / typed lines touched (% left, want 8)', v_n; end if;
  select * into v_b from public.bank_import_batches where id = v_jan;
  if v_b.removed_at is null or v_b.removed_by <> 'c1623000-0000-0000-0000-00000000a0a2'
     or v_b.remove_reason <> 'galat statement chadh gaya' or v_b.removed_lines <> 3 or v_b.line_count <> 3 then
    raise exception 'FAIL 4e: batch not marked removed: %', row_to_json(v_b);
  end if;
  begin
    perform public.remove_bank_import('c1623000-0000-0000-0000-0000000acc01', v_jan, null, null, 'phir se');
    raise exception 'FAIL 4f: removed the same import twice';
  exception when raise_exception then
    if sqlerrm not like 'This import was already removed on %' then raise exception 'FAIL 4f msg: %', sqlerrm; end if;
  end;
  raise notice 'PASS 4: only that batch''s 3 lines deleted; batch kept and marked removed; second removal refused';
end $$;

reset role;
do $$
declare v_a record;
begin
  select * into v_a from public.activity_log
   where tenant_id = 'c1623000-0000-0000-0000-0000000000a1' and action = 'bank_import.removed'
   order by id desc limit 1;
  if v_a is null or v_a.user_id <> 'c1623000-0000-0000-0000-00000000a0a2' or (v_a.changes->>'lines')::int <> 3
     or v_a.changes->>'file' <> 'jan.pdf' or v_a.changes->>'reason' <> 'galat statement chadh gaya' then
    raise exception 'FAIL 4g: activity_log row missing or wrong: %', row_to_json(v_a);
  end if;
  -- R-1623b: the label the Activity log shows is English
  if v_a.label <> 'Import removed: 3 lines (jan.pdf) — galat statement chadh gaya' then
    raise exception 'FAIL 4g label: %', v_a.label;
  end if;
  raise notice 'PASS 4g: activity_log says who removed what and why, in English';
end $$;
set local role authenticated;

-- ── 5. Remove an OLD import by its insert-time range ─────────────────────────────────
do $$
declare v_one record; v jsonb; v_n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1623000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  select * into v_one from public.bank_import_history('c1623000-0000-0000-0000-0000000acc01')
   where kind = 'legacy' and legacy_from like '2026-10-17T11:29%';
  -- a range cut through the middle of the import is refused
  begin
    perform public.remove_bank_import('c1623000-0000-0000-0000-0000000acc01', null,
      '2026-10-17T11:29:07.123456Z', v_one.legacy_to, 'aadha');
    raise exception 'FAIL 5a: removed half an old import';
  exception when invalid_parameter_value then null;
  end;
  v := public.remove_bank_import('c1623000-0000-0000-0000-0000000acc01', null, v_one.legacy_from, v_one.legacy_to, '17 Oct ka galat import');
  if (v->>'removed')::int <> 4 then raise exception 'FAIL 5b: removed % (want 4)', v->>'removed'; end if;
  select count(*) into v_n from public.bank_transactions where description like 'OLD-ONE%' and tenant_id = 'c1623000-0000-0000-0000-0000000000a1';
  if v_n <> 0 then raise exception 'FAIL 5c: % OLD-ONE lines left', v_n; end if;
  select count(*) into v_n from public.bank_transactions where description like 'OLD-TWO%' and tenant_id = 'c1623000-0000-0000-0000-0000000000a1';
  if v_n <> 3 then raise exception 'FAIL 5d: the other old import lost lines (% left)', v_n; end if;
  if not exists (select 1 from public.bank_transactions where description = 'TYPED BY HAND') then
    raise exception 'FAIL 5e: the hand-typed line inserted a second later was deleted';
  end if;
  if not exists (select 1 from public.bank_import_history('c1623000-0000-0000-0000-0000000acc01')
                  where kind = 'batch' and source = 'legacy' and removed_at is not null and removed_lines = 4
                    and imported_at = timestamptz '2026-10-17 11:29:06.123456+00') then
    raise exception 'FAIL 5f: removed old import not kept in the history';
  end if;
  if (select count(*) from public.bank_import_history('c1623000-0000-0000-0000-0000000acc01') where kind = 'legacy') <> 1 then
    raise exception 'FAIL 5g: history still lists the removed old import as live';
  end if;
  raise notice 'PASS 5: old import removed by insert-time range; the other import and the typed line stay';
end $$;

rollback;
