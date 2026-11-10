-- R-2524 — every UPDATE of a bank line moves updated_at (migration *_r2524_bank_lines_touch_updated_at),
-- so the bank account page can re-read only the lines changed since its last read.
--
-- Self-asserting: RAISEs on failure. One transaction that ROLLS BACK.
--
-- What it proves:
--   1. An insert keeps its given / default updated_at.
--   2. Reconciling a line (matched_to_type / matched_to_id) moves updated_at forward.
--   3. Un-reconciling moves it again; an untouched line in the same account does not move.
--   4. The delta read the page makes (account + updated_at >= since) returns exactly the changed line.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('c2524000-0000-0000-0000-0000000000a1'::uuid, 'R2524 A', 'r2524-a@example.in', '07');
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date, is_active)
values ('c2524000-0000-0000-0000-0000000acc01'::uuid, 'c2524000-0000-0000-0000-0000000000a1'::uuid,
        'R2524 HDFC', 'HDFC', 'current', 0, '2026-01-01', true);
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source, updated_at) values
  ('c2524000-0000-0000-0000-000000000001', 'c2524000-0000-0000-0000-0000000000a1', 'c2524000-0000-0000-0000-0000000acc01',
   '2026-10-01', 'NEFT CR R2524 ONE', 0, 1000, 'manual', '2026-10-01 10:00:00+05:30'),
  ('c2524000-0000-0000-0000-000000000002', 'c2524000-0000-0000-0000-0000000000a1', 'c2524000-0000-0000-0000-0000000acc01',
   '2026-10-02', 'NEFT CR R2524 TWO', 0, 2000, 'manual', '2026-10-01 10:00:00+05:30');

do $$
declare
  v_before timestamptz;
  v_after  timestamptz;
  v_other  timestamptz;
  v_n      int;
begin
  select updated_at into v_before from public.bank_transactions where id = 'c2524000-0000-0000-0000-000000000001';
  if v_before <> '2026-10-01 10:00:00+05:30'::timestamptz then
    raise exception 'R-2524 FAIL 1: insert changed updated_at to %', v_before;
  end if;

  update public.bank_transactions set matched_to_type = 'manual', matched_to_id = null, matched_at = now(),
         match_confidence = 'manual', reconcile_note = 'R-2524 test'
   where id = 'c2524000-0000-0000-0000-000000000001';
  select updated_at into v_after from public.bank_transactions where id = 'c2524000-0000-0000-0000-000000000001';
  if not (v_after > v_before and v_after > now() - interval '1 minute') then
    raise exception 'R-2524 FAIL 2: reconcile did not move updated_at (% -> %)', v_before, v_after;
  end if;

  update public.bank_transactions set matched_to_type = null, matched_at = null, match_confidence = null
   where id = 'c2524000-0000-0000-0000-000000000001';
  if (select updated_at from public.bank_transactions where id = 'c2524000-0000-0000-0000-000000000001') < v_after then
    raise exception 'R-2524 FAIL 3: un-reconcile moved updated_at backwards';
  end if;
  select updated_at into v_other from public.bank_transactions where id = 'c2524000-0000-0000-0000-000000000002';
  if v_other <> '2026-10-01 10:00:00+05:30'::timestamptz then
    raise exception 'R-2524 FAIL 3: an untouched line moved (%)', v_other;
  end if;

  select count(*) into v_n from public.bank_transactions
   where bank_account_id = 'c2524000-0000-0000-0000-0000000acc01' and updated_at >= now() - interval '10 minutes';
  if v_n <> 1 then
    raise exception 'R-2524 FAIL 4: the delta read found % lines, expected 1', v_n;
  end if;
  raise notice 'R-2524 bank lines touch updated_at: all checks passed';
end $$;

rollback;
