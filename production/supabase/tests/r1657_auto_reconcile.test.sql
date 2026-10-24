-- R-1657: auto_reconcile_bank_account (migration 20261024001702) — the browser's per-line
-- auto-reconcile loop, moved to the server. Self-asserting (RAISEs on failure), rolls back.
--
-- What it proves:
--   1. One call does the whole account: the one unambiguous exact match is applied (through
--      reconcile_bank_txn — the expense's reverse link is set too); an ambiguous pair, a
--      low-confidence one and a line with no candidate are left, each counted by reason.
--   2. Re-running touches nothing already matched (idempotent) and finds the same three left.
--   3. Chunks: p_limit 1 does one line and says done = false with last_id; passing last_id
--      back continues after it.
--   4. A sales user is refused up front; a user of another company is refused (not "0 lines").

begin;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code) values
  ('d1657000-0000-0000-0000-0000000000a1'::uuid, 'R1657 TEST A', 'r1657-a@example.in', '07'),
  ('d1657000-0000-0000-0000-0000000000b1'::uuid, 'R1657 TEST B', 'r1657-b@example.in', '07');

insert into auth.users (id, email) values
  ('d1657000-0000-0000-0000-0000000000a2', 'acct-a@example.test'),
  ('d1657000-0000-0000-0000-0000000000a3', 'sales-a@example.test'),
  ('d1657000-0000-0000-0000-0000000000b2', 'acct-b@example.test');
insert into public.users (id, tenant_id, email, role, is_active) values
  ('d1657000-0000-0000-0000-0000000000a2'::uuid, 'd1657000-0000-0000-0000-0000000000a1'::uuid, 'acct-a@example.in', 'accountant', true),
  ('d1657000-0000-0000-0000-0000000000a3'::uuid, 'd1657000-0000-0000-0000-0000000000a1'::uuid, 'sales-a@example.in', 'sales', true),
  ('d1657000-0000-0000-0000-0000000000b2'::uuid, 'd1657000-0000-0000-0000-0000000000b1'::uuid, 'acct-b@example.in', 'accountant', true);

insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date, is_active)
  values ('d1657000-0000-0000-0000-00000000ac01'::uuid, 'd1657000-0000-0000-0000-0000000000a1'::uuid,
          'R1657 HDFC', 'HDFC', 'current', 0, current_date, true);

-- Four money-OUT lines (ids sort in this order):
--   f1  5000  one expense, same day, same amount     → exact, unambiguous → reconciled
--   f2  7000  two expenses, same day, same amount     → ambiguous → review
--   f3   123  nothing within ₹100                     → no_match → review
--   f4  9000  one expense of 9050                     → low confidence → review
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, source) values
  ('d1657000-0000-0000-0000-0000000000f1'::uuid, 'd1657000-0000-0000-0000-0000000000a1'::uuid, 'd1657000-0000-0000-0000-00000000ac01'::uuid, current_date, 'AWS', 5000, 'manual'),
  ('d1657000-0000-0000-0000-0000000000f2'::uuid, 'd1657000-0000-0000-0000-0000000000a1'::uuid, 'd1657000-0000-0000-0000-00000000ac01'::uuid, current_date, 'Rent', 7000, 'manual'),
  ('d1657000-0000-0000-0000-0000000000f3'::uuid, 'd1657000-0000-0000-0000-0000000000a1'::uuid, 'd1657000-0000-0000-0000-00000000ac01'::uuid, current_date, 'Fee', 123, 'manual'),
  ('d1657000-0000-0000-0000-0000000000f4'::uuid, 'd1657000-0000-0000-0000-0000000000a1'::uuid, 'd1657000-0000-0000-0000-00000000ac01'::uuid, current_date, 'Travel', 9000, 'manual');
insert into public.expenses (id, tenant_id, category, expense_date, amount) values
  ('EXP-R1657-1',  'd1657000-0000-0000-0000-0000000000a1'::uuid, 'software', current_date, 5000),
  ('EXP-R1657-2a', 'd1657000-0000-0000-0000-0000000000a1'::uuid, 'rent',     current_date, 7000),
  ('EXP-R1657-2b', 'd1657000-0000-0000-0000-0000000000a1'::uuid, 'rent',     current_date, 7000),
  ('EXP-R1657-4',  'd1657000-0000-0000-0000-0000000000a1'::uuid, 'travel',   current_date, 9050);

-- Act as tenant A's accountant.
select set_config('request.jwt.claims', '{"sub":"d1657000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;

-- ── 3 first (before anything is matched): chunks ────────────────────────────
do $$
declare r jsonb; r2 jsonb;
begin
  r := public.auto_reconcile_bank_account('d1657000-0000-0000-0000-00000000ac01'::uuid, null, 1);
  if (r->>'checked')::int <> 1 or (r->>'done')::boolean or r->>'last_id' <> 'd1657000-0000-0000-0000-0000000000f1'
     or (r->>'reconciled')::int <> 1 then
    raise exception 'FAIL 3a: first chunk of 1 wrong: %', r;
  end if;
  r2 := public.auto_reconcile_bank_account('d1657000-0000-0000-0000-00000000ac01'::uuid, (r->>'last_id')::uuid, 1);
  if r2->>'last_id' <> 'd1657000-0000-0000-0000-0000000000f2' or (r2->>'ambiguous')::int <> 1 then
    raise exception 'FAIL 3b: second chunk did not continue after last_id: %', r2;
  end if;
  raise notice 'PASS 3: chunks of 1 continue from last_id, done=false until the end';
end $$;

-- ── 1 + 2: a whole-account run (f1 is already matched by 3a, so this is also the re-run) ──
do $$
declare r jsonb; v_type text; v_id text; v_link uuid;
begin
  r := public.auto_reconcile_bank_account('d1657000-0000-0000-0000-00000000ac01'::uuid);
  if (r->>'checked')::int <> 3 or (r->>'reconciled')::int <> 0 or (r->>'review')::int <> 3
     or (r->>'ambiguous')::int <> 1 or (r->>'no_match')::int <> 1 or (r->>'low_confidence')::int <> 1
     or (r->>'failed')::int <> 0 or not (r->>'done')::boolean then
    raise exception 'FAIL 1a: summary wrong: %', r;
  end if;
  select matched_to_type, matched_to_id into v_type, v_id from public.bank_transactions where id = 'd1657000-0000-0000-0000-0000000000f1'::uuid;
  if v_type is distinct from 'expense' or v_id is distinct from 'EXP-R1657-1' then
    raise exception 'FAIL 1b: f1 not matched to its expense (%, %)', v_type, v_id;
  end if;
  select reconciled_txn_id into v_link from public.expenses where id = 'EXP-R1657-1';
  if v_link is distinct from 'd1657000-0000-0000-0000-0000000000f1'::uuid then
    raise exception 'FAIL 1c: expense reverse link not set — not applied through reconcile_bank_txn';
  end if;
  if exists (select 1 from public.bank_transactions where id in ('d1657000-0000-0000-0000-0000000000f2'::uuid,
       'd1657000-0000-0000-0000-0000000000f3'::uuid, 'd1657000-0000-0000-0000-0000000000f4'::uuid) and matched_to_id is not null) then
    raise exception 'FAIL 1d: an ambiguous / low / no-match line was matched — the match rule changed';
  end if;
  raise notice 'PASS 1+2: exact unambiguous applied with its reverse link; ambiguous, low and no-match left and counted; re-run skips matched';
end $$;

-- ── 4: refused callers ──────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"d1657000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
do $$
declare ok boolean := false;
begin
  begin
    perform public.auto_reconcile_bank_account('d1657000-0000-0000-0000-00000000ac01'::uuid);
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then raise exception 'FAIL 4a: a sales user ran auto-reconcile'; end if;
  raise notice 'PASS 4a: sales refused';
end $$;

select set_config('request.jwt.claims', '{"sub":"d1657000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
do $$
declare ok boolean := false;
begin
  begin
    perform public.auto_reconcile_bank_account('d1657000-0000-0000-0000-00000000ac01'::uuid);
  exception when no_data_found then ok := true;
  end;
  if not ok then raise exception 'FAIL 4b: another company''s user was not refused'; end if;
  raise notice 'PASS 4b: other company refused';
end $$;

reset role;
rollback;
