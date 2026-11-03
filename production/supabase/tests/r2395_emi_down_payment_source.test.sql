-- R-2395 (3 Nov 2026): change where an EMI asset's down payment was paid from — bank / FD /
-- Petty Cash / paid by owner (capital introduced). Migration 20261103023500_r2395_emi_down_payment_source.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- The staging case: a car (₹19,70,000, ₹2,00,000 down, HDFC loan ₹17,70,000) bought 3 Feb 2026;
-- its down-payment line sits on an FD that only opened on 29 Aug 2026 (opening ₹34,99,210), so the
-- FD shows ₹32,99,210. The owner paid the ₹2 L in cash.
--
-- Proves:
--   A. Set-up guard: the FD (opened 29 Aug) cannot pay a 3 Feb down payment — refused, nothing written.
--   B. Refused, nothing written: a sales login (42501), another company's owner, a locked month,
--      the same account again, neither / both sources.
--   C. FD → Paid by owner: FD balance back to ₹34,99,210 (+₹2 L), owner capital +₹2 L (one
--      capital_introduced row, no bank line), asset cost ₹19,70,000, loan ₹17,70,000 and the
--      schedule unchanged; one activity_log row (account → owner).
--   D. That capital row cannot be deleted on its own (delete_owner_equity_movement refused).
--   E. Owner → Petty Cash: the capital row goes, Petty Cash −₹2 L, line matched 'emi'.
--   F. Set-up with paid_by_owner: no bank line, a capital row of down + fee.
--   G. A Pvt Ltd company cannot pick Paid by owner.

begin;

create function pg_temp.r1643_fill_supplier() returns trigger language plpgsql as $r1643$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street, ' || coalesce(new.state, 'India'));
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := lpad(coalesce(nullif(btrim(new.state_code), ''), '07'), 2, '0') || 'AAACT1643F1Z5';
  end if;
  return new;
end $r1643$;
create trigger zz_r1643_test_supplier before insert on public.tenants
  for each row execute function pg_temp.r1643_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code, business_type) values
  ('dddddddd-0000-0000-0000-000000239501','R2395 Co','r2395@example.in','07','R2395','proprietor'),
  ('dddddddd-0000-0000-0000-000000239502','R2395 Other','r2395b@example.in','07','R2395B','proprietor'),
  ('dddddddd-0000-0000-0000-000000239503','R2395 Pvt','r2395c@example.in','07','R2395C','pvt_ltd');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000239501','owner2395@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000239502','sales2395@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000239503','other2395@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000239504','pvt2395@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000239501','dddddddd-0000-0000-0000-000000239501','owner2395@example.in','Owner 2395','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000239502','dddddddd-0000-0000-0000-000000239501','sales2395@example.in','Sales 2395','sales', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000239503','dddddddd-0000-0000-0000-000000239502','other2395@example.in','Other 2395','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000239504','dddddddd-0000-0000-0000-000000239503','pvt2395@example.in','Pvt 2395','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date) values
  ('bbbbbbbb-0000-0000-0000-000000239501','dddddddd-0000-0000-0000-000000239501','HDFC Current','HDFC','current', 1000000, '2026-01-01'),
  ('bbbbbbbb-0000-0000-0000-000000239502','dddddddd-0000-0000-0000-000000239501','HDFC FD','HDFC','current', 3499210, '2026-08-29'),
  ('bbbbbbbb-0000-0000-0000-000000239503','dddddddd-0000-0000-0000-000000239501','Cash box','Cash','cash', 300000, '2026-01-01'),
  ('bbbbbbbb-0000-0000-0000-000000239504','dddddddd-0000-0000-0000-000000239503','Pvt bank','SBI','current', 0, '2026-01-01');

create function pg_temp.r2395_input(p_extra jsonb default '{}'::jsonb) returns jsonb language sql as $f$
  select jsonb_build_object('name','Thar Roxx','block','vehicles','cost',1970000,'down_payment',200000,
    'processing_fee',0,'processing_fee_gst',0,'purchased_on','2026-02-03','lender','HDFC BANK',
    'lender_ref','168081883','interest_rate',0,'no_cost',true,
    'account_id','bbbbbbbb-0000-0000-0000-000000239501',
    'schedule','[{"seq":1,"due_on":"2026-03-05","emi":1770000,"principal":1770000,"interest":0,"balance_after":0}]'::jsonb) || p_extra;
$f$;
create function pg_temp.r2395_bal(p_acc uuid) returns bigint language sql as $f$
  select a.opening_balance + coalesce((select sum(credit) - sum(debit) from public.bank_transactions t where t.bank_account_id = a.id), 0)
    from public.bank_accounts a where a.id = p_acc;
$f$;
create function pg_temp.r2395_capital(p_tenant uuid) returns bigint language sql as $f$
  select coalesce(sum(case kind when 'capital_introduced' then amount else -amount end), 0)
    from public.owner_equity_movements where tenant_id = p_tenant;
$f$;
create temp table r2395_ids (k text primary key, v uuid);
grant all on r2395_ids to public;

-- ── As the OWNER ─────────────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000239501","role":"authenticated"}', true);

-- A. The FD did not exist on 3 Feb 2026.
do $$ begin
  perform public.record_emi_asset_purchase(pg_temp.r2395_input(jsonb_build_object('account_id','bbbbbbbb-0000-0000-0000-000000239502')));
  raise exception 'FAIL A: a down payment from an FD that opened later was accepted';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'HDFC FD starts on 29 Aug 2026%' then raise exception 'FAIL A: wrong refusal: %', sqlerrm; end if;
end $$;
do $$ begin
  if exists (select 1 from public.emi_purchases where tenant_id = 'dddddddd-0000-0000-0000-000000239501') then
    raise exception 'FAIL A: the refused set-up left a purchase';
  end if;
end $$;

-- The staging data as it was: recorded from HDFC, then the line sits on the FD (old app, no guard).
insert into r2395_ids select 'thar', public.record_emi_asset_purchase(pg_temp.r2395_input());
select set_config('request.jwt.claims', '', true);
update public.bank_transactions set bank_account_id = 'bbbbbbbb-0000-0000-0000-000000239502'
 where id = (select down_bank_txn_id from public.emi_purchases where id = (select v from r2395_ids where k = 'thar'));
update public.emi_purchases set down_account_id = 'bbbbbbbb-0000-0000-0000-000000239502' where id = (select v from r2395_ids where k = 'thar');
do $$ begin
  if pg_temp.r2395_bal('bbbbbbbb-0000-0000-0000-000000239502') <> 3299210 then
    raise exception 'FAIL setup: FD should show 32,99,210, got %', pg_temp.r2395_bal('bbbbbbbb-0000-0000-0000-000000239502');
  end if;
end $$;

-- B. Refusals.
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000239502","role":"authenticated"}', true);
do $$ begin
  perform public.change_emi_down_payment_source((select v from r2395_ids where k = 'thar'), null, true);
  raise exception 'FAIL B: a sales login moved a down payment';
exception when insufficient_privilege then
  if sqlerrm not like 'Only an owner, manager or accountant%' then raise exception 'FAIL B: wrong refusal: %', sqlerrm; end if;
end $$;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000239503","role":"authenticated"}', true);
do $$ begin
  perform public.change_emi_down_payment_source((select v from r2395_ids where k = 'thar'), null, true);
  raise exception 'FAIL B: another company moved the down payment';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'That EMI purchase is not in your company%' then raise exception 'FAIL B: wrong refusal: %', sqlerrm; end if;
end $$;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000239501","role":"authenticated"}', true);
update public.tenants set books_locked_until = '2026-03-31' where id = 'dddddddd-0000-0000-0000-000000239501';
do $$ begin
  perform public.change_emi_down_payment_source((select v from r2395_ids where k = 'thar'), null, true);
  raise exception 'FAIL B: a down payment in a locked month was moved';
exception when check_violation then
  if sqlerrm not like 'Books are locked up to 31 Mar 2026%' then raise exception 'FAIL B: wrong refusal: %', sqlerrm; end if;
end $$;
update public.tenants set books_locked_until = null where id = 'dddddddd-0000-0000-0000-000000239501';
do $$ begin
  perform public.change_emi_down_payment_source((select v from r2395_ids where k = 'thar'), 'bbbbbbbb-0000-0000-0000-000000239502', false);
  raise exception 'FAIL B: the same account again was accepted';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'The down payment is already on HDFC FD%' then raise exception 'FAIL B: wrong refusal: %', sqlerrm; end if;
end $$;
do $$ begin
  perform public.change_emi_down_payment_source((select v from r2395_ids where k = 'thar'), null, false);
  raise exception 'FAIL B: no source was accepted';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'Pick where the down payment was paid from%' then raise exception 'FAIL B: wrong refusal: %', sqlerrm; end if;
end $$;
do $$ begin
  perform public.change_emi_down_payment_source((select v from r2395_ids where k = 'thar'), 'bbbbbbbb-0000-0000-0000-000000239503', true);
  raise exception 'FAIL B: both sources were accepted';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'Pick either an account or Paid by owner%' then raise exception 'FAIL B: wrong refusal: %', sqlerrm; end if;
end $$;
do $$ begin
  if pg_temp.r2395_bal('bbbbbbbb-0000-0000-0000-000000239502') <> 3299210
     or pg_temp.r2395_capital('dddddddd-0000-0000-0000-000000239501') <> 0 then
    raise exception 'FAIL B: a refused move wrote something';
  end if;
end $$;

-- C. FD → paid by owner.
do $$
declare v_r jsonb; v_p public.emi_purchases; v_fa public.fixed_assets; v_n integer; v_log public.activity_log;
begin
  v_r := public.change_emi_down_payment_source((select v from r2395_ids where k = 'thar'), null, true);
  if (v_r ->> 'amount')::integer <> 200000 or v_r -> 'before' ->> 'kind' <> 'account' or v_r -> 'after' ->> 'kind' <> 'owner' then
    raise exception 'FAIL C: wrong result %', v_r;
  end if;
  if pg_temp.r2395_bal('bbbbbbbb-0000-0000-0000-000000239502') <> 3499210 then
    raise exception 'FAIL C: FD should be back to 34,99,210, got %', pg_temp.r2395_bal('bbbbbbbb-0000-0000-0000-000000239502');
  end if;
  if pg_temp.r2395_capital('dddddddd-0000-0000-0000-000000239501') <> 200000 then
    raise exception 'FAIL C: owner capital should be +2,00,000, got %', pg_temp.r2395_capital('dddddddd-0000-0000-0000-000000239501');
  end if;
  select count(*) into v_n from public.owner_equity_movements
   where emi_purchase_id = (select v from r2395_ids where k = 'thar') and kind = 'capital_introduced'
     and bank_txn_id is null and bank_account_id is null and movement_date = '2026-02-03' and amount = 200000;
  if v_n <> 1 then raise exception 'FAIL C: expected one owner capital row with no bank line, got %', v_n; end if;
  select * into v_p from public.emi_purchases where id = (select v from r2395_ids where k = 'thar');
  if v_p.total_cost <> 1970000 or v_p.financed <> 1770000 or v_p.down_payment <> 200000
     or v_p.down_bank_txn_id is not null or v_p.down_account_id is not null then
    raise exception 'FAIL C: purchase changed wrongly: cost % financed % down % line % acc %',
      v_p.total_cost, v_p.financed, v_p.down_payment, v_p.down_bank_txn_id, v_p.down_account_id;
  end if;
  select * into v_fa from public.fixed_assets where emi_purchase_id = v_p.id;
  if v_fa.cost <> 1970000 then raise exception 'FAIL C: asset cost changed: %', v_fa.cost; end if;
  if (select count(*) from public.emi_schedule where purchase_id = v_p.id) <> 1 then raise exception 'FAIL C: the schedule changed'; end if;
  if exists (select 1 from public.bank_transactions where tenant_id = v_p.tenant_id and description like 'Down payment:%') then
    raise exception 'FAIL C: the old down-payment line is still there';
  end if;
  select * into v_log from public.activity_log where entity_id = v_p.id::text and action = 'emi_down_payment_moved';
  if v_log.id is null or v_log.changes -> 'before' ->> 'account_name' <> 'HDFC FD' or v_log.changes -> 'after' ->> 'kind' <> 'owner' then
    raise exception 'FAIL C: no audit row old → new: %', v_log.changes;
  end if;
end $$;

-- D. The capital row is the down payment — not deletable on its own.
do $$ begin
  perform public.delete_owner_equity_movement((select id from public.owner_equity_movements
                                                where emi_purchase_id = (select v from r2395_ids where k = 'thar')));
  raise exception 'FAIL D: the down-payment capital row was deleted on its own';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'This capital entry is the down payment of Thar Roxx%' then raise exception 'FAIL D: wrong refusal: %', sqlerrm; end if;
end $$;
do $$ begin
  perform public.change_emi_down_payment_source((select v from r2395_ids where k = 'thar'), null, true);
  raise exception 'FAIL D: owner → owner was accepted';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'The down payment is already recorded as paid by the owner%' then raise exception 'FAIL D: wrong refusal: %', sqlerrm; end if;
end $$;

-- E. Owner → Petty Cash.
do $$
declare v_p public.emi_purchases; v_t public.bank_transactions;
begin
  perform public.change_emi_down_payment_source((select v from r2395_ids where k = 'thar'), 'bbbbbbbb-0000-0000-0000-000000239503', false);
  if pg_temp.r2395_capital('dddddddd-0000-0000-0000-000000239501') <> 0 then raise exception 'FAIL E: the capital row is still there'; end if;
  if pg_temp.r2395_bal('bbbbbbbb-0000-0000-0000-000000239503') <> 100000 then
    raise exception 'FAIL E: Cash box should be 1,00,000, got %', pg_temp.r2395_bal('bbbbbbbb-0000-0000-0000-000000239503');
  end if;
  select * into v_p from public.emi_purchases where id = (select v from r2395_ids where k = 'thar');
  select * into v_t from public.bank_transactions where id = v_p.down_bank_txn_id;
  if v_t.bank_account_id <> 'bbbbbbbb-0000-0000-0000-000000239503' or v_t.debit <> 200000 or v_t.txn_date <> '2026-02-03'
     or v_t.matched_to_type <> 'emi' or v_t.matched_to_id <> v_p.id::text or v_p.down_account_id <> v_t.bank_account_id then
    raise exception 'FAIL E: wrong new line %', row_to_json(v_t);
  end if;
  if pg_temp.r2395_bal('bbbbbbbb-0000-0000-0000-000000239502') <> 3499210 then raise exception 'FAIL E: the FD moved again'; end if;
end $$;

-- F. Set-up with Paid by owner.
do $$
declare v_id uuid; v_p public.emi_purchases;
begin
  v_id := public.record_emi_asset_purchase(pg_temp.r2395_input(jsonb_build_object(
    'name','Laptop','block','computers','account_id',null,'paid_by_owner',true,'processing_fee',1000)));
  select * into v_p from public.emi_purchases where id = v_id;
  if v_p.down_bank_txn_id is not null or v_p.down_account_id is not null then raise exception 'FAIL F: a bank line was made'; end if;
  if not exists (select 1 from public.owner_equity_movements where emi_purchase_id = v_id and amount = 201000 and bank_txn_id is null) then
    raise exception 'FAIL F: no capital row of down + fee';
  end if;
end $$;

-- G. A Pvt Ltd company has no owner capital.
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000239504","role":"authenticated"}', true);
do $$ begin
  perform public.record_emi_asset_purchase(pg_temp.r2395_input(jsonb_build_object('account_id',null,'paid_by_owner',true)));
  raise exception 'FAIL G: a Pvt Ltd booked owner capital';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not like 'A Pvt Ltd company has no owner capital entries%' then raise exception 'FAIL G: wrong refusal: %', sqlerrm; end if;
end $$;

select 'R-2395 emi down payment source: all checks passed' as result;

rollback;
