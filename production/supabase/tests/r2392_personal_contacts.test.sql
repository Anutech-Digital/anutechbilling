-- Regression test for R-2392 — migration 20261103003100_r2392_personal_contacts.sql
--
-- WHAT THIS PROVES (Pardeep's case: "Add a loan you took" → From a person → pick a contact)
--   1. Owner A adds a contact (Ramesh, family); a second active "ramesh " is refused (one
--      active contact per name, case-insensitive); a bad PAN / relation is refused.
--   2. A links a loan taken from Ramesh, an owe/hold advance and an income + expense row to
--      the contact: party is filled with the contact's name even when typed differently.
--   3. Renaming the contact renames the party on every linked row.
--   4. A cannot link a loan / owe-hold / transaction to owner B's contact (owner-safe
--      composite FK), even though B's contact id is known.
--   5. Owner B in the SAME tenant and a staff user see ZERO of A's contacts, cannot update
--      or delete them, and cannot plant a contact in A's name.
--   6. Deleting a contact keeps the linked rows (contact_id → null, party text stays).
--
-- SAFETY: synthetic identities in a synthetic tenant, one transaction, ends in ROLLBACK.

begin;

insert into auth.users (id, email) values
  ('c4c4c4c4-0000-0000-0000-000000239201', 'r2392-owner-a@example.test'),
  ('c4c4c4c4-0000-0000-0000-000000239202', 'r2392-owner-b@example.test'),
  ('c4c4c4c4-0000-0000-0000-000000239203', 'r2392-staff@example.test');

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('c4c4c4c4-0000-0000-0000-0000002392f0', 'R2392 T', 'r2392@example.test', '07', 'R292');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c4c4c4c4-0000-0000-0000-000000239201', 'c4c4c4c4-0000-0000-0000-0000002392f0', 'r2392-owner-a@example.test', 'R2392 Owner A', 'owner',   true),
  ('c4c4c4c4-0000-0000-0000-000000239202', 'c4c4c4c4-0000-0000-0000-0000002392f0', 'r2392-owner-b@example.test', 'R2392 Owner B', 'owner',   true),
  ('c4c4c4c4-0000-0000-0000-000000239203', 'c4c4c4c4-0000-0000-0000-0000002392f0', 'r2392-staff@example.test',   'R2392 Staff',   'support', true);

-- Owner B's own contact (made as the table owner, before the role switch).
insert into public.personal_contacts (id, tenant_id, owner_user_id, name, relation)
  values ('c4c4c4c4-0000-0000-0000-0000002392b1', 'c4c4c4c4-0000-0000-0000-0000002392f0', 'c4c4c4c4-0000-0000-0000-000000239202', 'B''s friend', 'friend');

set local role authenticated;

do $$
declare
  v_a    uuid := 'c4c4c4c4-0000-0000-0000-000000239201';
  v_b    uuid := 'c4c4c4c4-0000-0000-0000-000000239202';
  v_st   uuid := 'c4c4c4c4-0000-0000-0000-000000239203';
  v_t    uuid := 'c4c4c4c4-0000-0000-0000-0000002392f0';
  v_bc   uuid := 'c4c4c4c4-0000-0000-0000-0000002392b1';
  v_c    uuid;
  v_loan uuid;
  v_oh   uuid;
  v_in   uuid;
  v_out  uuid;
  v_party text;
  n      integer;
  v_blocked boolean;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', v_a::text, 'role', 'authenticated')::text, true);

  ------------------------------------------- 1. A adds Ramesh; duplicates / bad PAN refused
  insert into public.personal_contacts (tenant_id, owner_user_id, name, relation, phone, pan)
    values (v_t, v_a, 'Ramesh', 'family', '9810000000', 'ABCDE1234F')
    returning id into v_c;

  v_blocked := false;
  begin
    insert into public.personal_contacts (tenant_id, owner_user_id, name) values (v_t, v_a, 'ramesh ');
  exception when unique_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 1: a second active "ramesh " was accepted'; end if;

  v_blocked := false;
  begin
    insert into public.personal_contacts (tenant_id, owner_user_id, name, pan) values (v_t, v_a, 'Suresh', 'abc123');
  exception when check_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 1: a bad PAN was accepted'; end if;

  v_blocked := false;
  begin
    insert into public.personal_contacts (tenant_id, owner_user_id, name, relation) values (v_t, v_a, 'Suresh', 'customer');
  exception when check_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 1: an unknown relation was accepted'; end if;

  ------------------------------------------- 2. link a loan, owe/hold, income, expense — party = name
  insert into public.personal_loans (tenant_id, owner_user_id, direction, loan_kind, party, principal, start_date, repay_type, contact_id)
    values (v_t, v_a, 'taken', 'person', 'typed differently', 200000, '2026-11-01', 'no_interest', v_c)
    returning id into v_loan;
  select party into v_party from public.personal_loans where id = v_loan;
  if v_party <> 'Ramesh' then raise exception 'FAIL 2: loan party is "%", expected Ramesh', v_party; end if;

  insert into public.personal_owe_hold (tenant_id, owner_user_id, kind, party, occurred_on, amount, contact_id)
    values (v_t, v_a, 'advance_received', 'x', '2026-11-01', 50000, v_c)
    returning id into v_oh;
  insert into public.personal_transactions (tenant_id, owner_user_id, kind, amount, occurred_on, party, contact_id)
    values (v_t, v_a, 'other_income', 1000, '2026-11-01', null, v_c)
    returning id into v_in;
  insert into public.personal_transactions (tenant_id, owner_user_id, kind, category, amount, occurred_on, party, contact_id)
    values (v_t, v_a, 'expense', 'Gifts', 700, '2026-11-02', 'R.', v_c)
    returning id into v_out;
  select count(*) into n from (
    select party from public.personal_owe_hold where id = v_oh
    union all select party from public.personal_transactions where id in (v_in, v_out)) s
   where party = 'Ramesh';
  if n <> 3 then raise exception 'FAIL 2: only % of owe/hold + 2 transactions carry the contact name', n; end if;

  -- Free text still works with no contact (banks / NBFC).
  insert into public.personal_loans (tenant_id, owner_user_id, direction, loan_kind, party, principal, start_date, repay_type)
    values (v_t, v_a, 'taken', 'home', 'SBI Home Loan', 100000, '2026-11-01', 'no_interest');

  ------------------------------------------- 3. rename follows to every linked row
  update public.personal_contacts set name = 'Ramesh Bhai' where id = v_c;
  select count(*) into n from (
    select party from public.personal_loans where contact_id = v_c
    union all select party from public.personal_owe_hold where contact_id = v_c
    union all select party from public.personal_transactions where contact_id = v_c) s
   where party = 'Ramesh Bhai';
  if n <> 4 then raise exception 'FAIL 3: % of 4 linked rows took the new name', n; end if;
  select count(*) into n from public.personal_loans where party = 'SBI Home Loan' and contact_id is null;
  if n <> 1 then raise exception 'FAIL 3: the unlinked bank loan changed'; end if;

  ------------------------------------------- 4. A cannot link B's contact
  v_blocked := false;
  begin
    insert into public.personal_loans (tenant_id, owner_user_id, direction, loan_kind, party, principal, start_date, repay_type, contact_id)
      values (v_t, v_a, 'given', 'person', 'x', 100, '2026-11-01', 'no_interest', v_bc);
  exception when foreign_key_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 4: a loan was linked to owner B''s contact'; end if;
  v_blocked := false;
  begin
    update public.personal_owe_hold set contact_id = v_bc where id = v_oh;
  exception when foreign_key_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 4: an owe/hold row was linked to owner B''s contact'; end if;
  v_blocked := false;
  begin
    update public.personal_transactions set contact_id = v_bc where id = v_in;
  exception when foreign_key_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 4: a transaction was linked to owner B''s contact'; end if;
  select count(*) into n from public.personal_contacts where id = v_bc;
  if n <> 0 then raise exception 'FAIL 4: owner A can see owner B''s contact'; end if;

  ------------------------------------------- 5. owner B and staff see nothing of A's
  perform set_config('request.jwt.claims', json_build_object('sub', v_b::text, 'role', 'authenticated')::text, true);
  select count(*) into n from public.personal_contacts where owner_user_id = v_a;
  if n <> 0 then raise exception 'FAIL 5: owner B (same tenant) sees % of A''s contacts', n; end if;
  select count(*) into n from public.personal_contacts;
  if n <> 1 then raise exception 'FAIL 5: owner B sees % contacts, expected only their own 1', n; end if;
  update public.personal_contacts set name = 'Hacked' where id = v_c;
  delete from public.personal_contacts where id = v_c;
  v_blocked := false;
  begin
    insert into public.personal_contacts (tenant_id, owner_user_id, name) values (v_t, v_a, 'Planted by B');
  exception when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 5: owner B planted a contact in A''s name'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_st::text, 'role', 'authenticated')::text, true);
  select count(*) into n from public.personal_contacts;
  if n <> 0 then raise exception 'FAIL 5: a staff user sees % contacts', n; end if;
  update public.personal_contacts set name = 'Hacked' where id = v_c;
  v_blocked := false;
  begin
    insert into public.personal_contacts (tenant_id, owner_user_id, name) values (v_t, v_a, 'Planted by staff');
  exception when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL 5: a staff user planted a contact in A''s name'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_a::text, 'role', 'authenticated')::text, true);
  select count(*) into n from public.personal_contacts where id = v_c and name = 'Ramesh Bhai';
  if n <> 1 then raise exception 'FAIL 5: B''s / staff''s update or delete reached A''s contact'; end if;

  ------------------------------------------- 6. delete keeps the rows, drops only the link
  delete from public.personal_contacts where id = v_c;
  select count(*) into n from public.personal_loans where id = v_loan and contact_id is null and party = 'Ramesh Bhai';
  if n <> 1 then raise exception 'FAIL 6: the loan lost its party or kept a dead link'; end if;
  select count(*) into n from public.personal_transactions where id in (v_in, v_out) and contact_id is null and party = 'Ramesh Bhai';
  if n <> 2 then raise exception 'FAIL 6: % of 2 transactions kept the party after the contact was deleted', n; end if;

  raise notice 'R-2392 personal_contacts: all checks passed';
end $$;

rollback;
