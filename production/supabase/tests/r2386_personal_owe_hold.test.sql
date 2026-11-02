-- Regression test for R-2386 — migration 20261102183751_r2386_personal_owe_hold.sql
--
-- WHAT THIS PROVES (Pardeep's case: ₹5 lakh byana for his daughter's property sale, kept as
-- cash with his brother)
--   1. Owner A records the advance (₹5,00,000) linked to her own cash account, and ₹1,00,000
--      held for a child; owner/tenant come from the session.
--   2. Net worth: assets (cash ₹5,00,000 + savings ₹2,00,000) − OPEN owe/hold (₹6,00,000)
--      − card dues (₹50,000) = ₹50,000. Settling the held money (handed over) drops it from
--      the open total: net worth ₹1,50,000.
--   3. "Convert into sale" settles an advance; it is refused for held money.
--   4. A settled row needs its date and way; an open row may not carry them.
--   5. Amount 0 / negative and an unknown kind are refused.
--   6. Owner B in the SAME tenant (also an owner) and a staff user see ZERO of A's rows,
--      cannot update or delete them, and cannot plant a row in A's name.
--   7. A cannot link an entry to B's account (owner-safe composite FK).
--
-- SAFETY: synthetic identities in a synthetic tenant, one transaction, ends in ROLLBACK.

begin;

insert into auth.users (id, email) values
  ('c3c3c3c3-0000-0000-0000-000000238601', 'r2386-owner-a@example.test'),
  ('c3c3c3c3-0000-0000-0000-000000238602', 'r2386-owner-b@example.test'),
  ('c3c3c3c3-0000-0000-0000-000000238603', 'r2386-staff@example.test');

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('c3c3c3c3-0000-0000-0000-0000002386f0', 'R2386 T', 'r2386@example.test', '07', 'R286');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c3c3c3c3-0000-0000-0000-000000238601', 'c3c3c3c3-0000-0000-0000-0000002386f0', 'r2386-owner-a@example.test', 'R2386 Owner A', 'owner',   true),
  ('c3c3c3c3-0000-0000-0000-000000238602', 'c3c3c3c3-0000-0000-0000-0000002386f0', 'r2386-owner-b@example.test', 'R2386 Owner B', 'owner',   true),
  ('c3c3c3c3-0000-0000-0000-000000238603', 'c3c3c3c3-0000-0000-0000-0000002386f0', 'r2386-staff@example.test',   'R2386 Staff',   'support', true);

insert into public.personal_accounts (id, tenant_id, owner_user_id, kind, label, balance) values
  ('c3c3c3c3-0000-0000-0000-0000002386a1', 'c3c3c3c3-0000-0000-0000-0000002386f0', 'c3c3c3c3-0000-0000-0000-000000238601', 'cash',        'Cash with brother (held)', 500000),
  ('c3c3c3c3-0000-0000-0000-0000002386a2', 'c3c3c3c3-0000-0000-0000-0000002386f0', 'c3c3c3c3-0000-0000-0000-000000238601', 'savings',     'A Savings',                200000),
  ('c3c3c3c3-0000-0000-0000-0000002386a3', 'c3c3c3c3-0000-0000-0000-0000002386f0', 'c3c3c3c3-0000-0000-0000-000000238601', 'credit_card', 'A Card',                    50000),
  ('c3c3c3c3-0000-0000-0000-0000002386b1', 'c3c3c3c3-0000-0000-0000-0000002386f0', 'c3c3c3c3-0000-0000-0000-000000238602', 'savings',     'B Savings',                 10000);

set local role authenticated;

do $$
declare
  v_a    uuid := 'c3c3c3c3-0000-0000-0000-000000238601';
  v_b    uuid := 'c3c3c3c3-0000-0000-0000-000000238602';
  v_st   uuid := 'c3c3c3c3-0000-0000-0000-000000238603';
  v_t    uuid := 'c3c3c3c3-0000-0000-0000-0000002386f0';
  v_cash uuid := 'c3c3c3c3-0000-0000-0000-0000002386a1';
  v_bsv  uuid := 'c3c3c3c3-0000-0000-0000-0000002386b1';
  v_adv  uuid;
  v_held uuid;
  v_net  bigint;
  n      integer;
  v_blocked boolean;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', v_a::text, 'role', 'authenticated')::text, true);

  ------------------------------------------- 1. A records the byana and the held money
  insert into public.personal_owe_hold (tenant_id, owner_user_id, kind, party, occurred_on, amount, note, account_id)
    values (v_t, v_a, 'advance_received', 'Buyer of the plot', '2026-11-01', 500000, 'Daughter''s property sale', v_cash)
    returning id into v_adv;
  insert into public.personal_owe_hold (tenant_id, owner_user_id, kind, party, occurred_on, amount)
    values (v_t, v_a, 'held_for_other', 'Daughter', '2026-11-01', 100000)
    returning id into v_held;
  select count(*) into n from public.personal_owe_hold where owner_user_id = v_a and status = 'open';
  if n <> 2 then raise exception 'FAIL 1: A sees % open rows, expected 2', n; end if;

  ------------------------------------------- 2. net worth = assets − open owe/hold − card dues
  select coalesce(sum(balance) filter (where kind <> 'credit_card'), 0)
       - coalesce(sum(balance) filter (where kind = 'credit_card'), 0)
       - (select coalesce(sum(amount), 0) from public.personal_owe_hold where status = 'open')
    into v_net
    from public.personal_accounts where is_active;
  if v_net <> 50000 then raise exception 'FAIL 2: net worth % with both open, expected 50000', v_net; end if;

  update public.personal_owe_hold
     set status = 'settled', settled_on = '2026-11-02', settled_how = 'handed_over'
   where id = v_held;
  select coalesce(sum(balance) filter (where kind <> 'credit_card'), 0)
       - coalesce(sum(balance) filter (where kind = 'credit_card'), 0)
       - (select coalesce(sum(amount), 0) from public.personal_owe_hold where status = 'open')
    into v_net
    from public.personal_accounts where is_active;
  if v_net <> 150000 then raise exception 'FAIL 2: net worth % after handing over, expected 150000', v_net; end if;

  ------------------------------------------- 3. convert into sale: advance yes, held money no
  v_blocked := false;
  begin
    update public.personal_owe_hold set settled_how = 'converted_to_sale' where id = v_held;
  exception when check_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 3: held money was "converted into sale"'; end if;

  update public.personal_owe_hold
     set status = 'settled', settled_on = '2026-11-20', settled_how = 'converted_to_sale',
         settle_note = 'Advance became part of the sale price'
   where id = v_adv;
  select count(*) into n from public.personal_owe_hold where status = 'open';
  if n <> 0 then raise exception 'FAIL 3: % rows still open after converting the advance', n; end if;

  ------------------------------------------- 4. settled needs date + way; open may not carry them
  v_blocked := false;
  begin
    update public.personal_owe_hold set settled_on = null where id = v_adv;
  exception when check_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 4: a settled row without a date was accepted'; end if;
  v_blocked := false;
  begin
    insert into public.personal_owe_hold (tenant_id, owner_user_id, kind, party, amount, settled_how)
      values (v_t, v_a, 'held_for_other', 'Son', 100, 'handed_over');
  exception when check_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 4: an open row with a settlement way was accepted'; end if;

  ------------------------------------------- 5. bad amount / kind refused
  v_blocked := false;
  begin
    insert into public.personal_owe_hold (tenant_id, owner_user_id, kind, party, amount)
      values (v_t, v_a, 'advance_received', 'X', 0);
  exception when check_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 5: amount 0 was accepted'; end if;
  v_blocked := false;
  begin
    insert into public.personal_owe_hold (tenant_id, owner_user_id, kind, party, amount)
      values (v_t, v_a, 'loan_taken', 'X', 10);
  exception when check_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 5: an unknown kind was accepted'; end if;

  ------------------------------------------- 7. A cannot link to B's account
  v_blocked := false;
  begin
    insert into public.personal_owe_hold (tenant_id, owner_user_id, kind, party, amount, account_id)
      values (v_t, v_a, 'held_for_other', 'X', 10, v_bsv);
  exception when foreign_key_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 7: an entry was linked to another person''s account'; end if;

  ------------------------------------------- 6. owner B and staff see nothing of A's
  perform set_config('request.jwt.claims', json_build_object('sub', v_b::text, 'role', 'authenticated')::text, true);
  select count(*) into n from public.personal_owe_hold;
  if n <> 0 then raise exception 'FAIL 6: owner B (same tenant) sees % of A''s rows', n; end if;
  update public.personal_owe_hold set amount = 1 where id = v_adv;
  delete from public.personal_owe_hold where id = v_adv;
  v_blocked := false;
  begin
    insert into public.personal_owe_hold (tenant_id, owner_user_id, kind, party, amount)
      values (v_t, v_a, 'held_for_other', 'Planted by B', 10);
  exception when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 6: owner B planted a row in A''s name'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_st::text, 'role', 'authenticated')::text, true);
  select count(*) into n from public.personal_owe_hold;
  if n <> 0 then raise exception 'FAIL 6: a staff user sees % of A''s rows', n; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_a::text, 'role', 'authenticated')::text, true);
  select count(*) into n from public.personal_owe_hold where id = v_adv and amount = 500000;
  if n <> 1 then raise exception 'FAIL 6: B''s update/delete reached A''s advance'; end if;

  raise notice 'R-2386 personal_owe_hold: all checks passed';
end $$;

rollback;
