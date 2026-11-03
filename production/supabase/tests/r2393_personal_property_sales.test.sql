-- Regression test for R-2393 — migration 20261103073146_r2393_personal_property_sales.sql
--
-- WHAT THIS PROVES (Pardeep's case: his daughter's flat, ₹5 lakh byana kept as cash)
--   1. Owner A has a real-estate holding and an open R-2386 advance of ₹5 L (cash). A sale
--      deal is made for the flat (buyer = a People contact); a second live deal on the same
--      flat is refused.
--   2. The byana is MOVED into the deal: the owe-hold entry is settled 'converted_to_sale',
--      the receipt carries it, and NO ledger row is made (its cash was already counted).
--      An instalment by bank makes a transfer_in 'Property sale' row on the account.
--      A payment above the agreed price is refused. Deleting a moved byana re-opens it.
--   3. Registry with a final payment and TDS 1%: deal registered, holding sold_on, the final
--      payment's transfer_in row exists; a second registry is refused.
--   4. A second deal is cancelled with part refund: transfer_out refund row + other_income
--      'Forfeited advance' (no account) for the rest; payments on a cancelled deal refused.
--   5. Renaming the buyer contact renames the deal's party (R-2392 trigger).
--   6. Owner B in the SAME tenant sees 0 deals / receipts and cannot add a receipt to A's deal;
--      A cannot make a deal on B's holding (owner-safe FK).
--
-- SAFETY: synthetic identities in a synthetic tenant, one transaction, ends in ROLLBACK.

begin;

insert into auth.users (id, email) values
  ('c5c5c5c5-0000-0000-0000-000000239301', 'r2393-owner-a@example.test'),
  ('c5c5c5c5-0000-0000-0000-000000239302', 'r2393-owner-b@example.test');

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('c5c5c5c5-0000-0000-0000-0000002393f0', 'R2393 T', 'r2393@example.test', '07', 'R293');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c5c5c5c5-0000-0000-0000-000000239301', 'c5c5c5c5-0000-0000-0000-0000002393f0', 'r2393-owner-a@example.test', 'R2393 Owner A', 'owner', true),
  ('c5c5c5c5-0000-0000-0000-000000239302', 'c5c5c5c5-0000-0000-0000-0000002393f0', 'r2393-owner-b@example.test', 'R2393 Owner B', 'owner', true);

-- Owner B's own property (made as the table owner, before the role switch).
insert into public.personal_holdings (id, tenant_id, owner_user_id, asset_class, name, invested, current_value)
  values ('c5c5c5c5-0000-0000-0000-0000002393b1', 'c5c5c5c5-0000-0000-0000-0000002393f0', 'c5c5c5c5-0000-0000-0000-000000239302', 'real_estate', 'B flat', 100, 200);

set local role authenticated;

do $$
declare
  v_a     uuid := 'c5c5c5c5-0000-0000-0000-000000239301';
  v_b     uuid := 'c5c5c5c5-0000-0000-0000-000000239302';
  v_t     uuid := 'c5c5c5c5-0000-0000-0000-0000002393f0';
  v_bh    uuid := 'c5c5c5c5-0000-0000-0000-0000002393b1';
  v_flat  uuid;
  v_plot  uuid;
  v_cash  uuid;
  v_bank  uuid;
  v_buyer uuid;
  v_hold  uuid;
  v_sale  uuid;
  v_sale2 uuid;
  v_r     jsonb;
  v_rec   uuid;
  n       integer;
  v_txt   text;
  v_blocked boolean;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', v_a::text, 'role', 'authenticated')::text, true);

  ------------------------------------------- 1. holding, cash, byana, deal
  insert into public.personal_accounts (tenant_id, owner_user_id, kind, label)
    values (v_t, v_a, 'cash', 'Cash with brother') returning id into v_cash;
  insert into public.personal_accounts (tenant_id, owner_user_id, kind, label)
    values (v_t, v_a, 'savings', 'SBI') returning id into v_bank;
  insert into public.personal_holdings (tenant_id, owner_user_id, asset_class, name, invested, current_value)
    values (v_t, v_a, 'real_estate', 'Daughter flat', 2500000, 6000000) returning id into v_flat;
  insert into public.personal_holdings (tenant_id, owner_user_id, asset_class, name, invested, current_value)
    values (v_t, v_a, 'real_estate', 'Plot', 100000, 1000000) returning id into v_plot;
  insert into public.personal_contacts (tenant_id, owner_user_id, name) values (v_t, v_a, 'Buyer Ram') returning id into v_buyer;
  insert into public.personal_owe_hold (tenant_id, owner_user_id, kind, party, occurred_on, amount, account_id)
    values (v_t, v_a, 'advance_received', 'Buyer Ram', '2026-10-01', 500000, v_cash) returning id into v_hold;

  insert into public.personal_property_sales (tenant_id, owner_user_id, holding_id, contact_id, party, agreement_date, agreed_price, stamp_value)
    values (v_t, v_a, v_flat, v_buyer, 'typed', '2026-10-01', 6500000, 6000000) returning id into v_sale;
  select party into v_txt from public.personal_property_sales where id = v_sale;
  if v_txt <> 'Buyer Ram' then raise exception 'FAIL 1: party not filled from the contact (%)', v_txt; end if;

  v_blocked := false;
  begin
    insert into public.personal_property_sales (tenant_id, owner_user_id, holding_id, party, agreed_price)
      values (v_t, v_a, v_flat, 'Other', 100);
  exception when unique_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 1: a second live deal on the same flat was accepted'; end if;

  ------------------------------------------- 2. byana moved, instalment, above price, undo
  v_r := public.personal_property_sale_add_receipt(v_sale, 'byana', null, null, 'cash', null, v_hold, null);
  if (v_r ->> 'received_total')::bigint <> 500000 or not (v_r ->> 'cash_warning')::boolean then
    raise exception 'FAIL 2: byana result %', v_r;
  end if;
  select count(*) into n from public.personal_owe_hold where id = v_hold and status = 'settled' and settled_how = 'converted_to_sale';
  if n <> 1 then raise exception 'FAIL 2: the advance was not settled as converted_to_sale'; end if;
  select count(*) into n from public.personal_property_sale_receipts where sale_id = v_sale and owe_hold_id = v_hold and tx_id is null and account_id = v_cash and received_on = '2026-10-01';
  if n <> 1 then raise exception 'FAIL 2: byana receipt not linked to the advance (or a ledger row was made)'; end if;
  select count(*) into n from public.personal_transactions where owner_user_id = v_a;
  if n <> 0 then raise exception 'FAIL 2: moving the byana made % ledger rows', n; end if;

  v_r := public.personal_property_sale_add_receipt(v_sale, 'instalment', '2026-10-15', 1000000, 'bank', v_bank, null, 'cheque 123');
  v_rec := (v_r ->> 'receipt_id')::uuid;
  if (v_r ->> 'cash_warning')::boolean then raise exception 'FAIL 2: a bank payment got the cash warning'; end if;
  select count(*) into n from public.personal_transactions t
    join public.personal_property_sale_receipts r on r.tx_id = t.id
   where r.id = v_rec and t.kind = 'transfer_in' and t.category = 'Property sale' and t.amount = 1000000 and t.account_id = v_bank and t.party = 'Buyer Ram';
  if n <> 1 then raise exception 'FAIL 2: the instalment did not put a transfer_in row on the account'; end if;

  v_blocked := false;
  begin
    perform public.personal_property_sale_add_receipt(v_sale, 'instalment', null, 5000001, 'bank', v_bank, null, null);
  exception when sqlstate '22023' then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 2: a payment above the agreed price was accepted'; end if;

  -- undo the byana → the advance is open again; re-add it
  select id into v_rec from public.personal_property_sale_receipts where owe_hold_id = v_hold;
  perform public.personal_property_sale_delete_receipt(v_rec);
  select count(*) into n from public.personal_owe_hold where id = v_hold and status = 'open' and settled_how is null;
  if n <> 1 then raise exception 'FAIL 2: deleting the moved byana did not re-open the advance'; end if;
  perform public.personal_property_sale_add_receipt(v_sale, 'byana', null, null, 'cash', null, v_hold, null);

  ------------------------------------------- 3. registry: final payment + TDS 1%
  v_r := public.personal_property_sale_register(v_sale, '2026-11-02', 65000, 4935000, 'bank', v_bank, null);
  if (v_r ->> 'balance_due')::bigint <> 0 or (v_r ->> 'received_total')::bigint <> 6435000 then
    raise exception 'FAIL 3: registry result %', v_r;
  end if;
  select count(*) into n from public.personal_property_sales where id = v_sale and status = 'registered' and registry_date = '2026-11-02' and tds_deducted = 65000;
  if n <> 1 then raise exception 'FAIL 3: the deal is not registered with TDS'; end if;
  select count(*) into n from public.personal_holdings where id = v_flat and sold_on = '2026-11-02';
  if n <> 1 then raise exception 'FAIL 3: the flat is not marked sold'; end if;
  select count(*) into n from public.personal_transactions where owner_user_id = v_a and kind = 'transfer_in' and category = 'Property sale';
  if n <> 2 then raise exception 'FAIL 3: expected 2 Property sale ledger rows (instalment + final), got %', n; end if;

  v_blocked := false;
  begin
    perform public.personal_property_sale_register(v_sale, '2026-11-03', 0, null, 'bank', null, null);
  exception when sqlstate 'P0001' then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 3: a second registry was accepted'; end if;

  ------------------------------------------- 4. cancel: part refund, rest forfeited
  insert into public.personal_property_sales (tenant_id, owner_user_id, holding_id, party, agreed_price)
    values (v_t, v_a, v_plot, 'Plot buyer', 1000000) returning id into v_sale2;
  perform public.personal_property_sale_add_receipt(v_sale2, 'byana', '2026-10-20', 100000, 'bank', v_bank, null, null);
  v_r := public.personal_property_sale_cancel(v_sale2, '2026-11-01', 60000, v_bank, null);
  if (v_r ->> 'forfeited')::bigint <> 40000 then raise exception 'FAIL 4: cancel result %', v_r; end if;
  select count(*) into n from public.personal_transactions where owner_user_id = v_a and kind = 'transfer_out' and category = 'Property sale refund' and amount = 60000 and account_id = v_bank;
  if n <> 1 then raise exception 'FAIL 4: no refund row'; end if;
  select count(*) into n from public.personal_transactions where owner_user_id = v_a and kind = 'other_income' and income_source = 'other' and category = 'Forfeited advance' and amount = 40000 and account_id is null;
  if n <> 1 then raise exception 'FAIL 4: no forfeited-advance income row'; end if;
  select count(*) into n from public.personal_holdings where id = v_plot and sold_on is null;
  if n <> 1 then raise exception 'FAIL 4: a cancelled deal marked the plot sold'; end if;
  v_blocked := false;
  begin
    perform public.personal_property_sale_add_receipt(v_sale2, 'instalment', null, 1000, 'bank', null, null, null);
  exception when sqlstate 'P0001' then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 4: a payment on a cancelled deal was accepted'; end if;

  ------------------------------------------- 5. buyer rename follows the contact
  update public.personal_contacts set name = 'Ram Kumar' where id = v_buyer;
  select party into v_txt from public.personal_property_sales where id = v_sale;
  if v_txt <> 'Ram Kumar' then raise exception 'FAIL 5: the deal party did not follow the rename (%)', v_txt; end if;

  ------------------------------------------- 6. owner B / cross-owner
  v_blocked := false;
  begin
    insert into public.personal_property_sales (tenant_id, owner_user_id, holding_id, party, agreed_price)
      values (v_t, v_a, v_bh, 'X', 100);
  exception when foreign_key_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 6: A made a deal on B''s holding'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_b::text, 'role', 'authenticated')::text, true);
  select count(*) into n from public.personal_property_sales;
  if n <> 0 then raise exception 'FAIL 6: owner B sees % of A''s deals', n; end if;
  select count(*) into n from public.personal_property_sale_receipts;
  if n <> 0 then raise exception 'FAIL 6: owner B sees % of A''s receipts', n; end if;
  v_blocked := false;
  begin
    perform public.personal_property_sale_add_receipt(v_sale, 'instalment', null, 1000, 'bank', null, null, null);
  exception when sqlstate 'P0002' then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 6: owner B added a receipt to A''s deal'; end if;

  raise notice 'R-2393 personal_property_sales: all checks passed';
end $$;

rollback;
