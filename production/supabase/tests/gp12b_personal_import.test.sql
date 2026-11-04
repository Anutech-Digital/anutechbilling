-- Regression test for R-2128 (GP-12b) — migration 20261030074413_gp12b_personal_import.sql
--
-- WHAT THIS PROVES
--   1. personal_import_commit(batch) saves the batch row and its statement lines in ONE
--      call: source = 'import', import_batch_id set, owner/tenant stamped from the
--      session (never from the payload — a payload owner_user_id is ignored).
--   2. Committing the SAME statement twice adds 0 transactions the second time (dedupe
--      on (owner, account, dedupe_hash)), and leaves no empty batch behind.
--   3. An overlapping statement (2 old lines + 1 new) adds exactly the 1 new line.
--   4. Atomic: one bad line (amount 0) refuses the whole batch — no batch row, no lines.
--   5. A batch aimed at someone else's account is refused (the caller's RLS cannot see it).
--   6. A line with no dedupe_hash is refused — without it re-import would double money.
--   7. Owner B (same tenant, also owner) sees 0 of A's batches, categories and rules;
--      a staff user in the same tenant sees 0 rules.
--   8. Owner B cannot plant a rule / category in A's name (with_check).
--   9. Owner A's own category and rule writes work (not over-blocked).
--
-- SAFETY: synthetic identities in a synthetic tenant, one transaction, ends in ROLLBACK.

begin;

insert into auth.users (id, email) values
  ('c2c2c2c2-0000-0000-0000-000000012b01', 'gp12b-owner-a@example.test'),
  ('c2c2c2c2-0000-0000-0000-000000012b02', 'gp12b-owner-b@example.test'),
  ('c2c2c2c2-0000-0000-0000-000000012b03', 'gp12b-staff@example.test');

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('c2c2c2c2-0000-0000-0000-000000012bf0', 'GP12B T', 'gp12b@example.test', '07', 'GP2B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2c2c2c2-0000-0000-0000-000000012b01', 'c2c2c2c2-0000-0000-0000-000000012bf0', 'gp12b-owner-a@example.test', 'GP12B Owner A', 'owner',   true),
  ('c2c2c2c2-0000-0000-0000-000000012b02', 'c2c2c2c2-0000-0000-0000-000000012bf0', 'gp12b-owner-b@example.test', 'GP12B Owner B', 'owner',   true),
  ('c2c2c2c2-0000-0000-0000-000000012b03', 'c2c2c2c2-0000-0000-0000-000000012bf0', 'gp12b-staff@example.test',   'GP12B Staff',   'support', true);

insert into public.personal_accounts (id, tenant_id, owner_user_id, kind, label) values
  ('c2c2c2c2-0000-0000-0000-000000012ba1', 'c2c2c2c2-0000-0000-0000-000000012bf0', 'c2c2c2c2-0000-0000-0000-000000012b01', 'savings', 'A Savings'),
  ('c2c2c2c2-0000-0000-0000-000000012bb1', 'c2c2c2c2-0000-0000-0000-000000012bf0', 'c2c2c2c2-0000-0000-0000-000000012b02', 'savings', 'B Savings');

set local role authenticated;

do $$
declare
  v_a   uuid := 'c2c2c2c2-0000-0000-0000-000000012b01';
  v_b   uuid := 'c2c2c2c2-0000-0000-0000-000000012b02';
  v_st  uuid := 'c2c2c2c2-0000-0000-0000-000000012b03';
  v_t   uuid := 'c2c2c2c2-0000-0000-0000-000000012bf0';
  v_sav uuid := 'c2c2c2c2-0000-0000-0000-000000012ba1';
  v_bsv uuid := 'c2c2c2c2-0000-0000-0000-000000012bb1';
  v_batch jsonb;
  v_res   jsonb;
  n       integer;
  v_blocked boolean;
  v_msg   text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', v_a::text, 'role', 'authenticated')::text, true);

  v_batch := jsonb_build_object(
    'account_id', v_sav,
    'file_name', 'hdfc-oct.csv',
    'file_kind', 'csv',
    'statement_from', '2026-10-01',
    'statement_to', '2026-10-31',
    'owner_user_id', v_b,                         -- must be IGNORED
    'rows', jsonb_build_array(
      jsonb_build_object('kind', 'expense', 'amount', 450, 'occurred_on', '2026-10-03', 'category', 'Food',
                         'raw_description', 'UPI/SWIGGY/123', 'reference', 'UTR1', 'balance_after', 9550, 'dedupe_hash', 'h1'),
      jsonb_build_object('kind', 'salary',  'amount', 50000, 'occurred_on', '2026-10-01', 'category', 'Salary',
                         'raw_description', 'NEFT SALARY', 'dedupe_hash', 'h2')));

  ------------------------------------------- 1. first commit saves batch + lines
  v_res := public.personal_import_commit(v_batch);
  if (v_res->>'inserted')::int <> 2 or (v_res->>'skipped')::int <> 0 then
    raise exception 'FAIL 1: first commit returned %, expected inserted 2 skipped 0', v_res;
  end if;
  select count(*) into n from public.personal_transactions
   where import_batch_id = (v_res->>'batch_id')::uuid and source = 'import'
     and owner_user_id = v_a and tenant_id = v_t and account_id = v_sav;
  if n <> 2 then raise exception 'FAIL 1: % lines stamped with the batch / owner / tenant, expected 2', n; end if;
  select count(*) into n from public.personal_import_batches
   where id = (v_res->>'batch_id')::uuid and owner_user_id = v_a and inserted_count = 2 and account_id = v_sav;
  if n <> 1 then raise exception 'FAIL 1: the batch row is missing or not owned by the caller'; end if;

  ------------------------------------------- 2. the same statement again adds 0 rows
  v_res := public.personal_import_commit(v_batch);
  if (v_res->>'inserted')::int <> 0 or (v_res->>'skipped')::int <> 2 then
    raise exception 'FAIL 2: second commit returned %, expected inserted 0 skipped 2', v_res;
  end if;
  select count(*) into n from public.personal_transactions where owner_user_id = v_a;
  if n <> 2 then raise exception 'FAIL 2: committing twice left % transactions, expected 2', n; end if;
  select count(*) into n from public.personal_import_batches;
  if n <> 1 then raise exception 'FAIL 2: an all-duplicate commit left an empty batch (% batches, expected 1)', n; end if;

  ------------------------------------------- 3. overlapping statement adds only the new line
  v_res := public.personal_import_commit(jsonb_set(v_batch, '{rows}', (v_batch->'rows') || jsonb_build_array(
    jsonb_build_object('kind', 'expense', 'amount', 99, 'occurred_on', '2026-10-05', 'dedupe_hash', 'h3'))));
  if (v_res->>'inserted')::int <> 1 or (v_res->>'skipped')::int <> 2 then
    raise exception 'FAIL 3: overlapping commit returned %, expected inserted 1 skipped 2', v_res;
  end if;

  ------------------------------------------- 4. one bad line refuses the whole batch
  v_blocked := false;
  begin
    perform public.personal_import_commit(jsonb_build_object('account_id', v_sav, 'file_name', 'bad.csv', 'rows',
      jsonb_build_array(
        jsonb_build_object('kind', 'expense', 'amount', 10, 'occurred_on', '2026-10-06', 'dedupe_hash', 'h4'),
        jsonb_build_object('kind', 'expense', 'amount', 0,  'occurred_on', '2026-10-06', 'dedupe_hash', 'h5'))));
  exception when others then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 4: a batch with an amount-0 line was accepted'; end if;
  select count(*) into n from public.personal_transactions where dedupe_hash = 'h4';
  if n <> 0 then raise exception 'FAIL 4: half a batch landed — the good line of a refused batch was saved'; end if;
  select count(*) into n from public.personal_import_batches where file_name = 'bad.csv';
  if n <> 0 then raise exception 'FAIL 4: a refused batch left its batch row'; end if;

  ------------------------------------------- 5. someone else's account is refused
  v_blocked := false;
  begin
    perform public.personal_import_commit(jsonb_set(v_batch, '{account_id}', to_jsonb(v_bsv)));
  exception when others then v_blocked := true; v_msg := sqlerrm;
  end;
  if not v_blocked then raise exception 'FAIL 5: owner A imported lines into owner B''s account'; end if;

  ------------------------------------------- 6. a line without dedupe_hash is refused
  v_blocked := false;
  begin
    perform public.personal_import_commit(jsonb_build_object('account_id', v_sav, 'rows',
      jsonb_build_array(jsonb_build_object('kind', 'expense', 'amount', 5, 'occurred_on', '2026-10-07'))));
  exception when others then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 6: a statement line without dedupe_hash was imported'; end if;

  ------------------------------------------- 9. A's own category + rule
  insert into public.personal_categories (tenant_id, owner_user_id, name, direction)
    values (v_t, v_a, 'Pets', 'expense');
  insert into public.personal_category_rules (tenant_id, owner_user_id, match_text, category)
    values (v_t, v_a, 'zomato', 'Food');
  select count(*) into n from public.personal_category_rules;
  if n <> 1 then raise exception 'FAIL 9: owner A sees % of their own rules, expected 1', n; end if;

  v_blocked := false;
  begin
    insert into public.personal_category_rules (tenant_id, owner_user_id, match_text, category)
      values (v_t, v_a, 'ZOMATO', 'Eating out');
  exception when unique_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 9: two rules for the same text (case-insensitive) — which one wins would be a guess'; end if;

  ------------------------------------------- 7. owner B sees none of it
  perform set_config('request.jwt.claims', json_build_object('sub', v_b::text, 'role', 'authenticated')::text, true);
  select count(*) into n from public.personal_import_batches;
  if n <> 0 then raise exception 'FAIL 7: a second owner reads % of owner A''s import batches', n; end if;
  select count(*) into n from public.personal_categories;
  if n <> 0 then raise exception 'FAIL 7: a second owner reads % of owner A''s categories', n; end if;
  select count(*) into n from public.personal_category_rules;
  if n <> 0 then raise exception 'FAIL 7: a second owner reads % of owner A''s category rules', n; end if;

  ------------------------------------------- 8. owner B cannot plant rows in A's name
  v_blocked := false;
  begin
    insert into public.personal_category_rules (tenant_id, owner_user_id, match_text, category)
      values (v_t, v_a, 'planted', 'Food');
  exception when others then v_blocked := true; v_msg := sqlerrm;
  end;
  if not v_blocked or v_msg not like '%row-level security%' then
    raise exception 'FAIL 8: owner B wrote a rule into owner A''s vault (or was stopped by something else: %)', v_msg;
  end if;

  ------------------------------------------- 7b. same-tenant staff see 0 rules
  perform set_config('request.jwt.claims', json_build_object('sub', v_st::text, 'role', 'authenticated')::text, true);
  select count(*) into n from public.personal_category_rules;
  if n <> 0 then raise exception 'FAIL 7: a team member in the same tenant reads % private rules', n; end if;
  select count(*) into n from public.personal_import_batches;
  if n <> 0 then raise exception 'FAIL 7: a team member reads % import batches', n; end if;
end $$;

select 'PASS' as gp12b_personal_import;

rollback;
