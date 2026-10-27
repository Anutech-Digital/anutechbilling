-- R-1919: ONE vendor guess — bank_debit_vendor_guess (auto-reconcile, R-1867/R-1911) answers in the
-- same order as the Reconcile sheet's guessVendor (src/lib/banking/debit-pay-for.ts):
--   UPI id → account no → masked account tail → Category Rule → learned alias → name words; a tie names nobody.
-- The narrations, vendors, rules and aliases are the SAME as src/lib/banking/vendor-guess-one-order.test.ts
-- (that vitest fails if a case below is missing or expects something else).
-- Then the owner's path: a line nobody is guessed for → matched to a vendor by hand → the NEXT line
-- with the same payee is guessed (sheet and auto-reconcile); un-reconciling forgets it; another
-- company never sees it.
-- Self-asserting (RAISEs on failure), rolls back.

begin;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code) values
  ('d1919000-0000-0000-0000-0000000000a1'::uuid, 'R1919 TEST A', 'r1919-a@example.in', '07'),
  ('d1919000-0000-0000-0000-0000000000b1'::uuid, 'R1919 TEST B', 'r1919-b@example.in', '07');
insert into auth.users (id, email) values
  ('d1919000-0000-0000-0000-0000000000a2', 'acct-1919a@example.test'),
  ('d1919000-0000-0000-0000-0000000000b2', 'acct-1919b@example.test');
insert into public.users (id, tenant_id, email, role, is_active) values
  ('d1919000-0000-0000-0000-0000000000a2'::uuid, 'd1919000-0000-0000-0000-0000000000a1'::uuid, 'acct-1919a@example.in', 'accountant', true),
  ('d1919000-0000-0000-0000-0000000000b2'::uuid, 'd1919000-0000-0000-0000-0000000000b1'::uuid, 'acct-1919b@example.in', 'accountant', true);

insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date, is_active) values
  ('d1919000-0000-0000-0000-00000000ac01'::uuid, 'd1919000-0000-0000-0000-0000000000a1'::uuid, 'R1919 HDFC', 'HDFC', 'current', 0, current_date, true),
  ('d1919000-0000-0000-0000-00000000bc01'::uuid, 'd1919000-0000-0000-0000-0000000000b1'::uuid, 'R1919 B HDFC', 'HDFC', 'current', 0, current_date, true);

-- vN = d1919000-…-0000000000eN (same names / UPI / account numbers as the vitest).
insert into public.vendors (id, tenant_id, name, upi_id, bank_account_no) values
  ('d1919000-0000-0000-0000-0000000000e1'::uuid, 'd1919000-0000-0000-0000-0000000000a1'::uuid, 'Sharma Associates', 'sharma@okhdfcbank', '50100123456789'),
  ('d1919000-0000-0000-0000-0000000000e2'::uuid, 'd1919000-0000-0000-0000-0000000000a1'::uuid, 'Sharma Traders', null, null),
  ('d1919000-0000-0000-0000-0000000000e3'::uuid, 'd1919000-0000-0000-0000-0000000000a1'::uuid, 'Facebook India Online Services', null, null),
  ('d1919000-0000-0000-0000-0000000000e4'::uuid, 'd1919000-0000-0000-0000-0000000000a1'::uuid, 'Kapoor Legal Associates', null, '11112222334455'),
  ('d1919000-0000-0000-0000-0000000000e5'::uuid, 'd1919000-0000-0000-0000-0000000000a1'::uuid, 'Kapoor Stationers', null, '99998888774455'),
  ('d1919000-0000-0000-0000-0000000000e6'::uuid, 'd1919000-0000-0000-0000-0000000000a1'::uuid, 'Gupta Cloud', null, '50100999888777'),
  ('d1919000-0000-0000-0000-0000000000e7'::uuid, 'd1919000-0000-0000-0000-0000000000a1'::uuid, 'Gupta Telecom', null, null),
  -- Company B has its own "RK Infra" — it must never get A's learned alias.
  ('d1919000-0000-0000-0000-0000000000f1'::uuid, 'd1919000-0000-0000-0000-0000000000b1'::uuid, 'Rao Kumar Builders', null, null);

insert into public.txn_category_rules (id, tenant_id, pattern, category, direction) values
  ('d1919000-0000-0000-0000-0000000000c1'::uuid, 'd1919000-0000-0000-0000-0000000000a1'::uuid, 'PAYUFACEBOOK', 'Advertising', 'debit'),
  ('d1919000-0000-0000-0000-0000000000c2'::uuid, 'd1919000-0000-0000-0000-0000000000a1'::uuid, 'GUPTA', 'Internet', 'any'),
  ('d1919000-0000-0000-0000-0000000000c3'::uuid, 'd1919000-0000-0000-0000-0000000000a1'::uuid, 'TRADERS', 'Sales', 'credit');

insert into public.vendor_narration_aliases (tenant_id, narration_key, vendor_id) values
  ('d1919000-0000-0000-0000-0000000000a1'::uuid, 'payufacebook',      'd1919000-0000-0000-0000-0000000000e2'::uuid),
  ('d1919000-0000-0000-0000-0000000000a1'::uuid, 'sharma associates', 'd1919000-0000-0000-0000-0000000000e2'::uuid),
  ('d1919000-0000-0000-0000-0000000000a1'::uuid, 'ms tiwari',         'd1919000-0000-0000-0000-0000000000e4'::uuid),
  ('d1919000-0000-0000-0000-0000000000a1'::uuid, 'ms tiwari',         'd1919000-0000-0000-0000-0000000000e5'::uuid);

-- The shared cases: (id, narration, expected vendor code or null).
create temp table r1919_cases (id text, description text, vendor text) on commit drop;
insert into r1919_cases values
  ('C1', 'UPI/412345678/KAPOOR LEGAL/sharma@okhdfcbank/fees', 'v1'),
  ('C2', 'NEFT TO A/C 50100999888777 PAYUFACEBOOK', 'v6'),
  ('C3', 'K4UHU5ENAJ52FPOTCU/PAYUFACEBOOK', 'v3'),
  ('C4', 'IMPS-612256087508-SHARMA ASSOCIATES-FINO-XXXX6722-RENT', 'v2'),
  ('C5', 'NEFT-KAPOOR LEGAL ASSOCIATES-KL201', 'v4'),
  ('C6', 'NEFT GUPTA PAYMENT', null),
  ('C7', 'IMPS-612256087509-MS TIWARI-SBIN-XXXX1234-RENT', null),
  ('C8', 'Bank fee', null),
  ('C9', 'SHARMA TRADERS REFUND', 'v2'),
  ('C10', 'IMPS-612256080000-KAPOOR LEGAL-HDFC-XXXXXX8777-HOSTING', 'v6'),
  ('C11', 'NEFT DR-HDFC0001234-KAPOOR-NETBANK, MUM-XXXXXXXX4455-FEES', null);

create temp table r1919_tails (id text, description text, tail text) on commit drop;
insert into r1919_tails values
  ('T1', 'IMPS-612256080000-KAPOOR LEGAL-HDFC-XXXXXX8777-HOSTING', '8777'),
  ('T2', 'IMPS-621856395591-RAVI KUMAR-ICIC-XX XXXXXX4658-SALARY', '4658'),
  ('T3', 'IMPS-612256080000-RAVI KUMAR-HDFC-50100123456789-RENT', null),
  ('T4', '50100123456789-TPT-RENT-SHARMA ASSOCIATES', null),
  ('T5', 'NEFT DR-HDFC0001234-KAPOOR-NETBANK, MUM-****4455-FEES', '4455'),
  ('T6', 'Bank fee', null);

create temp table r1919_keys (id text, description text, key text) on commit drop;
insert into r1919_keys values
  ('K1', 'IMPS-612256087508-PRASHANT BHAIYA-FINO-XXXX6722-SALARY', 'prashant bhaiya'),
  ('K2', 'NEFT DR-BKID0006087-PRATIK-NETBANK, MUM-N283-INV', 'pratik'),
  ('K3', 'UPI/412345678/SHARMA ASSOC/sharma@okhdfcbank/fees', 'sharma assoc'),
  ('K4', 'UPI-RAVI KUMAR-ravi@ybl-SBIN0001234-412345-rent', 'ravi kumar'),
  ('K5', '50100123456789-TPT-RENT OCT-SHARMA ASSOCIATES', 'sharma associates'),
  ('K6', 'K4UHU5ENAJ52FPOTCU/PAYUFACEBOOK', 'payufacebook'),
  ('K7', 'POS 416021XXXXXX1234 FACEBK ADS', 'pos facebk ads'),
  ('K8', '12345 678', null),
  ('K9', '', null);
grant select on r1919_cases, r1919_keys, r1919_tails to authenticated;

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, source)
select md5('r1919-' || c.id)::uuid, 'd1919000-0000-0000-0000-0000000000a1'::uuid, 'd1919000-0000-0000-0000-00000000ac01'::uuid,
       current_date, c.description, 1000, 'manual'
  from r1919_cases c;

-- The owner's path: two lines to "RK INFRA" (nobody guessed), and one in company B.
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, source) values
  ('d1919000-0000-0000-0000-0000000001a1'::uuid, 'd1919000-0000-0000-0000-0000000000a1'::uuid, 'd1919000-0000-0000-0000-00000000ac01'::uuid,
   current_date, 'IMPS-612256081111-RK INFRA-FINO-XXXX6722-RENT SEP', 25000, 'manual'),
  ('d1919000-0000-0000-0000-0000000001a2'::uuid, 'd1919000-0000-0000-0000-0000000000a1'::uuid, 'd1919000-0000-0000-0000-00000000ac01'::uuid,
   current_date, 'IMPS-612256082222-RK INFRA-FINO-XXXX6722-RENT OCT', 11800, 'manual'),
  ('d1919000-0000-0000-0000-0000000001b1'::uuid, 'd1919000-0000-0000-0000-0000000000b1'::uuid, 'd1919000-0000-0000-0000-00000000bc01'::uuid,
   current_date, 'IMPS-612256083333-RK INFRA-FINO-XXXX6722-RENT OCT', 11800, 'manual');
-- Sharma Traders has an open COGS bill for exactly the second line — auto-reconcile can pay it once it knows the vendor.
insert into public.vendor_bills (id, tenant_id, vendor_id, vendor_name, bill_no, bill_date, due_date, category, subtotal, igst, total, status, paid_amount) values
  ('BILL-R1919-ST1', 'd1919000-0000-0000-0000-0000000000a1', 'd1919000-0000-0000-0000-0000000000e2', 'Sharma Traders', 'ST-1',
   current_date - 10, current_date + 20, 'COGS-Hardware', 10000, 1800, 11800, 'unpaid', 0);

select set_config('request.jwt.claims', '{"sub":"d1919000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;

do $$
declare
  c record; v uuid; want uuid; k text; n int; m record;
begin
  -- 1. The narration key, same as narrationKey().
  for c in select * from r1919_keys order by id loop
    k := public.bank_narration_key(c.description);
    if k is distinct from c.key then raise exception 'FAIL %: key of "%" is %, expected %', c.id, c.description, k, c.key; end if;
  end loop;
  raise notice 'PASS K1-K9: bank_narration_key gives the same keys as narrationKey()';

  for c in select * from r1919_tails order by id loop
    k := public.bank_narration_account_tail(c.description);
    if k is distinct from c.tail then raise exception 'FAIL %: tail of "%" is %, expected %', c.id, c.description, k, c.tail; end if;
  end loop;
  raise notice 'PASS T1-T6: bank_narration_account_tail reads the same tails as R-1918 bankDetailsFromNarration';

  -- 2. The one order, same cases as guessVendor().
  for c in select * from r1919_cases order by id loop
    v := public.bank_debit_vendor_guess(md5('r1919-' || c.id)::uuid);
    want := case when c.vendor is null then null else ('d1919000-0000-0000-0000-0000000000e' || substr(c.vendor, 2))::uuid end;
    if v is distinct from want then
      raise exception 'FAIL %: "%" guessed %, expected % (%)', c.id, c.description, v, want, c.vendor;
    end if;
    raise notice 'PASS %: % -> %', c.id, c.description, coalesce(c.vendor, 'no guess');
  end loop;

  -- 3. Owner's path: no guess for RK INFRA → picked Sharma Traders by hand (an advance) → learned.
  if public.bank_debit_vendor_guess('d1919000-0000-0000-0000-0000000001a1') is not null then
    raise exception 'FAIL 3a: RK INFRA was guessed before any payment';
  end if;
  perform public.reconcile_bank_debit_to_vendor('d1919000-0000-0000-0000-0000000001a1', 'd1919000-0000-0000-0000-0000000000e2',
    null, '[]'::jsonb, null, 25000, 'Rent');
  select count(*) into n from public.vendor_narration_aliases
   where narration_key = 'rk infra' and vendor_id = 'd1919000-0000-0000-0000-0000000000e2';
  if n <> 1 then raise exception 'FAIL 3b: the save did not learn "rk infra" -> Sharma Traders (% rows)', n; end if;
  v := public.bank_debit_vendor_guess('d1919000-0000-0000-0000-0000000001a2');
  if v is distinct from 'd1919000-0000-0000-0000-0000000000e2'::uuid then
    raise exception 'FAIL 3c: the next RK INFRA line guessed %, expected Sharma Traders', v;
  end if;
  raise notice 'PASS 3: after one manual pick the next RK INFRA line is guessed (learned alias)';

  -- 4. Auto-reconcile uses the same guess: it finds Sharma Traders' bill for the second line.
  select * into m from public.bank_debit_vendor_auto_match('d1919000-0000-0000-0000-0000000001a2') limit 1;
  if m.vendor_id is distinct from 'd1919000-0000-0000-0000-0000000000e2'::uuid or m.doc_id is distinct from 'BILL-R1919-ST1' then
    raise exception 'FAIL 4: auto-match gave % / %, expected Sharma Traders / BILL-R1919-ST1', m.vendor_id, m.doc_id;
  end if;
  raise notice 'PASS 4: auto-reconcile picks the same learned vendor and its bill';

  -- 5. Un-reconcile the hand-matched line → the alias it taught is forgotten.
  update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = 'd1919000-0000-0000-0000-0000000001a1';
  select count(*) into n from public.vendor_narration_aliases where narration_key = 'rk infra';
  if n <> 0 then raise exception 'FAIL 5: un-reconcile kept % "rk infra" alias row(s)', n; end if;
  if public.bank_debit_vendor_guess('d1919000-0000-0000-0000-0000000001a2') is not null then
    raise exception 'FAIL 5b: still guessed after the only payment that taught it was undone';
  end if;
  raise notice 'PASS 5: un-reconciling forgets what that payment taught';

  -- Learn it again for the isolation check.
  perform public.reconcile_bank_debit_to_vendor('d1919000-0000-0000-0000-0000000001a1', 'd1919000-0000-0000-0000-0000000000e2',
    null, '[]'::jsonb, null, 25000, 'Rent');
end $$;

-- 6. Company B: never sees A's aliases, and its RK INFRA line is not guessed from them.
select set_config('request.jwt.claims', '{"sub":"d1919000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
do $$
declare n int;
begin
  select count(*) into n from public.vendor_narration_aliases;
  if n <> 0 then raise exception 'FAIL 6a: company B reads % alias rows of company A', n; end if;
  if public.bank_debit_vendor_guess('d1919000-0000-0000-0000-0000000001b1') is not null then
    raise exception 'FAIL 6b: company B''s line was guessed from company A''s alias';
  end if;
  begin
    insert into public.vendor_narration_aliases (tenant_id, narration_key, vendor_id)
      values ('d1919000-0000-0000-0000-0000000000b1', 'rk infra', 'd1919000-0000-0000-0000-0000000000f1');
    raise exception 'FAIL 6c: a user wrote an alias directly';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS 6: aliases are per company and written only by a vendor-payment save';
end $$;

reset role;
rollback;
