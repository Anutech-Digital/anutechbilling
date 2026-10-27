-- R-1934: bank_debit_vendor_guess (migration 20261025151940) must not crash on a money-out
-- line whose narration shares no word with any vendor name. Before the fix it raised
-- 'record "v_top" is not assigned yet', which stopped the whole Auto-reconcile run (R-1657).
-- Self-asserting (RAISEs on failure), rolls back.
--
-- What it proves (as tenant A's accountant):
--   1. No vendor shares a word ("Bank fee")             → null, no error.
--   2. Exactly one vendor shares a word ("Sharma Rent")  → that vendor.
--   3. Two vendors share the same number of words        → null (not sure).
--   4. Two vendors, one shares more words                → the one with more.
--   5. Auto-reconcile over the account runs to the end with the no-match line in it.

begin;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code) values
  ('d1934000-0000-0000-0000-0000000000a1'::uuid, 'R1934 TEST A', 'r1934-a@example.in', '07');
insert into auth.users (id, email) values
  ('d1934000-0000-0000-0000-0000000000a2', 'acct-1934@example.test');
insert into public.users (id, tenant_id, email, role, is_active) values
  ('d1934000-0000-0000-0000-0000000000a2'::uuid, 'd1934000-0000-0000-0000-0000000000a1'::uuid, 'acct-1934@example.in', 'accountant', true);

insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date, is_active)
  values ('d1934000-0000-0000-0000-00000000ac01'::uuid, 'd1934000-0000-0000-0000-0000000000a1'::uuid,
          'R1934 HDFC', 'HDFC', 'current', 0, current_date, true);

insert into public.vendors (id, tenant_id, name) values
  ('d1934000-0000-0000-0000-0000000000e1'::uuid, 'd1934000-0000-0000-0000-0000000000a1'::uuid, 'Sharma Properties'),
  ('d1934000-0000-0000-0000-0000000000e2'::uuid, 'd1934000-0000-0000-0000-0000000000a1'::uuid, 'Verma Cloud Hosting'),
  ('d1934000-0000-0000-0000-0000000000e3'::uuid, 'd1934000-0000-0000-0000-0000000000a1'::uuid, 'Verma Cloud Telecom'),
  ('d1934000-0000-0000-0000-0000000000e4'::uuid, 'd1934000-0000-0000-0000-0000000000a1'::uuid, 'Gupta Telecom');

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, source) values
  ('d1934000-0000-0000-0000-0000000000f1'::uuid, 'd1934000-0000-0000-0000-0000000000a1'::uuid, 'd1934000-0000-0000-0000-00000000ac01'::uuid, current_date, 'Bank fee', 123, 'manual'),
  ('d1934000-0000-0000-0000-0000000000f2'::uuid, 'd1934000-0000-0000-0000-0000000000a1'::uuid, 'd1934000-0000-0000-0000-00000000ac01'::uuid, current_date, 'Sharma Rent', 7000, 'manual'),
  ('d1934000-0000-0000-0000-0000000000f3'::uuid, 'd1934000-0000-0000-0000-0000000000a1'::uuid, 'd1934000-0000-0000-0000-00000000ac01'::uuid, current_date, 'Telecom bill', 900, 'manual'),
  ('d1934000-0000-0000-0000-0000000000f4'::uuid, 'd1934000-0000-0000-0000-0000000000a1'::uuid, 'd1934000-0000-0000-0000-00000000ac01'::uuid, current_date, 'Verma Cloud Hosting', 4000, 'manual');

select set_config('request.jwt.claims', '{"sub":"d1934000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;

do $$
declare v uuid; r jsonb;
begin
  v := public.bank_debit_vendor_guess('d1934000-0000-0000-0000-0000000000f1'::uuid);
  if v is not null then raise exception 'FAIL 1: no shared word but guessed %', v; end if;
  raise notice 'PASS 1: no vendor shares a word -> null, no v_top error';

  v := public.bank_debit_vendor_guess('d1934000-0000-0000-0000-0000000000f2'::uuid);
  if v is distinct from 'd1934000-0000-0000-0000-0000000000e1'::uuid then
    raise exception 'FAIL 2: one vendor shares a word, got %', v;
  end if;
  raise notice 'PASS 2: one vendor shares a word -> that vendor';

  v := public.bank_debit_vendor_guess('d1934000-0000-0000-0000-0000000000f3'::uuid);
  if v is not null then raise exception 'FAIL 3: two vendors tie on "telecom" but guessed %', v; end if;
  raise notice 'PASS 3: two vendors tie -> null';

  v := public.bank_debit_vendor_guess('d1934000-0000-0000-0000-0000000000f4'::uuid);
  if v is distinct from 'd1934000-0000-0000-0000-0000000000e2'::uuid then
    raise exception 'FAIL 4: Verma Cloud Hosting shares 3 words (vs 2), got %', v;
  end if;
  raise notice 'PASS 4: the vendor sharing more words wins';

  r := public.auto_reconcile_bank_account('d1934000-0000-0000-0000-00000000ac01'::uuid);
  if (r->>'checked')::int <> 4 or not (r->>'done')::boolean or (r->>'failed')::int <> 0 then
    raise exception 'FAIL 5: auto-reconcile did not finish the account cleanly: %', r;
  end if;
  raise notice 'PASS 5: auto-reconcile runs to the end with a no-match line: %', r;
end $$;

reset role;
rollback;
