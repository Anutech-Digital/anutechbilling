-- R-2025 (27 Oct 2026): money paid from someone else's account — the payer recorded on the
-- receipt and learned as the customer's KNOWN payer. Migration 20261027120512_r2025_customer_payers.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Proves:
--   A. The Shree Nandik line (staging narration) answered "group company" for Links and booked as
--      Links' advance: the receipt carries payer_name + payer_relation, its customer and the
--      holder quote stay Links (GST party unchanged), and customer_payers learns the payer
--      (uses 1, first_seen = the line, IFSC kept).
--   B. The next line from the same payer: uses 2, last_seen = that line, first_seen unchanged.
--   C. A line answered for Links but booked to Acme learns nothing and writes no payer.
--   D. Guards (nothing written): a sales login 42501, another company's line P0002, a reconciled
--      line / money-out line / bad relation 22023, no company 28000.
--   E. By hand: an accountant adds the same payer for Acme (so it is ambiguous — the app then does
--      not guess); a duplicate is refused 23505; a billing login cannot add or delete 42501; edit
--      and delete by the owner.
--   F. RLS: the other company sees none of these rows; a direct insert from the browser is refused.
--   G. payer_name_key is the same rule as payerKey() in customer-payer.ts.

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
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000202501','Orbit Software R2025','r2025@example.in','07','R2025'),
  ('dddddddd-0000-0000-0000-000000202502','R2025 Other','r2025b@example.in','07','R2025B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000202501','owner2025@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000202502','sales2025@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000202503','nocompany2025@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000202504','billing2025@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000202505','acct2025@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000202506','other2025@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000202501','dddddddd-0000-0000-0000-000000202501','owner2025@example.in','Owner 2025','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000202502','dddddddd-0000-0000-0000-000000202501','sales2025@example.in','Sales 2025','sales', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000202504','dddddddd-0000-0000-0000-000000202501','billing2025@example.in','Billing 2025','billing', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000202505','dddddddd-0000-0000-0000-000000202501','acct2025@example.in','Accountant 2025','accountant', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000202506','dddddddd-0000-0000-0000-000000202502','other2025@example.in','Other 2025','owner', now() - interval '1 day');

insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000202501','dddddddd-0000-0000-0000-000000202501','Links Infotech 2025','07','links2025.in'),
  ('cccccccc-0000-0000-0000-000000202502','dddddddd-0000-0000-0000-000000202501','Acme 2025','07','acme2025.in'),
  ('cccccccc-0000-0000-0000-000000202503','dddddddd-0000-0000-0000-000000202502','Gamma 2025','07','gamma2025.in');

insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000202501','dddddddd-0000-0000-0000-000000202501','IndusInd Current','IndusInd'),
  ('bbbbbbbb-0000-0000-0000-000000202502','dddddddd-0000-0000-0000-000000202502','Other bank','SBI');

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000202501','dddddddd-0000-0000-0000-000000202501','bbbbbbbb-0000-0000-0000-000000202501','2026-10-23',
   'NEFT CR-INDB0000006-SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED-ORBIT SOFTWARE-INDBH23101090759',0,16709,'INDBH23101090759','manual'),
  ('11111111-0000-0000-0000-000000202502','dddddddd-0000-0000-0000-000000202501','bbbbbbbb-0000-0000-0000-000000202501','2026-10-25',
   'NEFT CR-INDB0000006-SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED-ORBIT SOFTWARE-INDBH23101090999',0,5000,'INDBH23101090999','manual'),
  ('11111111-0000-0000-0000-000000202503','dddddddd-0000-0000-0000-000000202501','bbbbbbbb-0000-0000-0000-000000202501','2026-10-25',
   'NEFT CR-HDFC0000240-RAJESH KUMAR-ORBIT SOFTWARE-N2025',0,7000,'N2025','manual'),
  ('11111111-0000-0000-0000-000000202504','dddddddd-0000-0000-0000-000000202501','bbbbbbbb-0000-0000-0000-000000202501','2026-10-25',
   'RENT PAID',3000,0,'RENT2025','manual'),
  ('11111111-0000-0000-0000-000000202505','dddddddd-0000-0000-0000-000000202502','bbbbbbbb-0000-0000-0000-000000202502','2026-10-25',
   'NEFT CR-X-SOMEONE-OTHER-U1',0,4000,'U2025X','manual');

-- ── G. the key ──────────────────────────────────────────────────────────────
do $$
begin
  if public.payer_name_key('  Shree  Nandik Tech. ') is distinct from 'shree nandik tech'
     or public.payer_name_key('A1') is not null
     or public.payer_name_key('SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED') is distinct from 'shree nandik technologies private limited' then
    raise exception 'FAIL G: payer_name_key is not the payerKey() rule';
  end if;
  raise notice 'PASS G: payer_name_key = payerKey()';
end $$;

-- ── As the OWNER ─────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000202501","role":"authenticated"}', true);

-- A. answer, then book as Links' advance
do $$
declare r jsonb; v_pay uuid; p public.payments; q public.quotes; k public.customer_payers;
begin
  r := public.set_bank_line_payer('11111111-0000-0000-0000-000000202501', 'cccccccc-0000-0000-0000-000000202501',
         'SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED', 'group_company', 'Sister company of Links', 'INDB0000006', null, null);
  if r ->> 'key' is distinct from 'shree nandik technologies private limited' then raise exception 'FAIL A: answer not stored (%)', r; end if;
  if (select count(*) from public.customer_payers where tenant_id = 'dddddddd-0000-0000-0000-000000202501') <> 0 then
    raise exception 'FAIL A: learned before the line was reconciled'; end if;

  r := public.reconcile_bank_credit_as_advance('11111111-0000-0000-0000-000000202501', 'cccccccc-0000-0000-0000-000000202501');
  v_pay := (r ->> 'payment_id')::uuid;
  select * into p from public.payments where id = v_pay;
  if p.payer_name is distinct from 'SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED' or p.payer_relation is distinct from 'group_company' then
    raise exception 'FAIL A: receipt payer % / %', p.payer_name, p.payer_relation; end if;
  if p.customer_id is distinct from 'cccccccc-0000-0000-0000-000000202501' or p.amount <> 16709 then
    raise exception 'FAIL A: receipt customer/amount changed'; end if;
  select * into q from public.quotes where id = p.quote_id;
  if q.customer_id is distinct from 'cccccccc-0000-0000-0000-000000202501' or q.customer_name is distinct from 'Links Infotech 2025' then
    raise exception 'FAIL A: the GST party moved off the customer'; end if;
  select * into k from public.customer_payers where customer_id = 'cccccccc-0000-0000-0000-000000202501';
  if k.id is null or k.uses <> 1 or k.first_seen_txn is distinct from '11111111-0000-0000-0000-000000202501'
     or k.relation <> 'group_company' or k.ifsc is distinct from 'INDB0000006' or k.note is distinct from 'Sister company of Links' then
    raise exception 'FAIL A: not learned right (%)', row_to_json(k); end if;
  raise notice 'PASS A: receipt says who paid, customer unchanged, payer learned for Links';
end $$;

-- B. next line from the same payer
do $$
declare k public.customer_payers;
begin
  perform public.set_bank_line_payer('11111111-0000-0000-0000-000000202502', 'cccccccc-0000-0000-0000-000000202501',
         'SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED', 'group_company', null, 'INDB0000006', null, null);
  perform public.reconcile_bank_credit_as_advance('11111111-0000-0000-0000-000000202502', 'cccccccc-0000-0000-0000-000000202501');
  select * into k from public.customer_payers where customer_id = 'cccccccc-0000-0000-0000-000000202501';
  if k.uses <> 2 or k.last_seen_txn is distinct from '11111111-0000-0000-0000-000000202502'
     or k.first_seen_txn is distinct from '11111111-0000-0000-0000-000000202501' or k.note is distinct from 'Sister company of Links' then
    raise exception 'FAIL B: second use (%)', row_to_json(k); end if;
  if (select count(*) from public.customer_payers where tenant_id = 'dddddddd-0000-0000-0000-000000202501') <> 1 then
    raise exception 'FAIL B: a second row instead of one known payer'; end if;
  raise notice 'PASS B: same payer again → uses 2, one row';
end $$;

-- C. answered for Links, booked to Acme → nothing learned, no payer on Acme's receipt
do $$
declare r jsonb;
begin
  perform public.set_bank_line_payer('11111111-0000-0000-0000-000000202503', 'cccccccc-0000-0000-0000-000000202501',
         'RAJESH KUMAR', 'director', null, null, null, null);
  r := public.reconcile_bank_credit_as_advance('11111111-0000-0000-0000-000000202503', 'cccccccc-0000-0000-0000-000000202502');
  if (select payer_name from public.payments where id = (r ->> 'payment_id')::uuid) is not null then
    raise exception 'FAIL C: payer written on the other customer''s receipt'; end if;
  if exists (select 1 from public.customer_payers where payer_name_key = 'rajesh kumar') then
    raise exception 'FAIL C: learned for the wrong customer'; end if;
  raise notice 'PASS C: booked to another customer → nothing learned';
end $$;

-- D. guards
do $$
begin
  begin perform public.set_bank_line_payer('11111111-0000-0000-0000-000000202501', 'cccccccc-0000-0000-0000-000000202501', 'X PAYER', 'director', null, null, null, null);
    raise exception 'FAIL D: reconciled line accepted';
  exception when sqlstate '22023' then null; end;
  begin perform public.set_bank_line_payer('11111111-0000-0000-0000-000000202504', 'cccccccc-0000-0000-0000-000000202501', 'X PAYER', 'director', null, null, null, null);
    raise exception 'FAIL D: money-out line accepted';
  exception when sqlstate '22023' then null; end;
  begin perform public.set_bank_line_payer('11111111-0000-0000-0000-000000202505', 'cccccccc-0000-0000-0000-000000202501', 'X PAYER', 'director', null, null, null, null);
    raise exception 'FAIL D: other company''s line accepted';
  exception when sqlstate 'P0002' then null; end;
  begin perform public.set_bank_line_payer('11111111-0000-0000-0000-000000202502', 'cccccccc-0000-0000-0000-000000202501', 'X PAYER', 'cousin', null, null, null, null);
    raise exception 'FAIL D: bad relation accepted';
  exception when sqlstate '22023' then null; end;
  raise notice 'PASS D(owner): reconciled / money-out / other company / bad relation refused';
end $$;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000202502","role":"authenticated"}', true);
do $$
begin
  begin perform public.set_bank_line_payer('11111111-0000-0000-0000-000000202502', 'cccccccc-0000-0000-0000-000000202501', 'X PAYER', 'director', null, null, null, null);
    raise exception 'FAIL D: sales login accepted';
  exception when sqlstate '42501' then null; end;
  raise notice 'PASS D(sales): 42501';
end $$;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000202503","role":"authenticated"}', true);
do $$
begin
  begin perform public.save_customer_payer(null, 'cccccccc-0000-0000-0000-000000202501', 'X PAYER', 'director', null, null, null, null);
    raise exception 'FAIL D: no-company login accepted';
  exception when sqlstate '28000' then null; end;
  raise notice 'PASS D(no company): 28000';
end $$;

-- E. by hand
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000202505","role":"authenticated"}', true);
do $$
declare v_id uuid;
begin
  v_id := public.save_customer_payer(null, 'cccccccc-0000-0000-0000-000000202502', 'Shree Nandik Technologies Private Limited',
            'third_party', 'Pays for Acme too', null, null, '4521');
  if (select count(distinct customer_id) from public.customer_payers
       where tenant_id = 'dddddddd-0000-0000-0000-000000202501' and payer_name_key = 'shree nandik technologies private limited') <> 2 then
    raise exception 'FAIL E: same payer for two customers not stored'; end if;
  if (select uses from public.customer_payers where id = v_id) <> 0 then raise exception 'FAIL E: hand-added payer has uses'; end if;
  begin perform public.save_customer_payer(null, 'cccccccc-0000-0000-0000-000000202502', 'SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED', 'director', null, null, null, null);
    raise exception 'FAIL E: duplicate accepted';
  exception when sqlstate '23505' then null; end;
  begin perform public.save_customer_payer(null, 'cccccccc-0000-0000-0000-000000202502', 'OTHER PAYER', 'director', null, null, null, '12ab');
    raise exception 'FAIL E: bad account tail accepted';
  exception when sqlstate '22023' then null; end;
  raise notice 'PASS E(accountant): added for Acme too (ambiguous), duplicate / bad tail refused';
end $$;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000202504","role":"authenticated"}', true);
do $$
declare v_id uuid := (select id from public.customer_payers where customer_id = 'cccccccc-0000-0000-0000-000000202502');
begin
  begin perform public.save_customer_payer(null, 'cccccccc-0000-0000-0000-000000202502', 'BILLING PAYER', 'director', null, null, null, null);
    raise exception 'FAIL E: billing login added a payer';
  exception when sqlstate '42501' then null; end;
  begin perform public.delete_customer_payer(v_id);
    raise exception 'FAIL E: billing login deleted a payer';
  exception when sqlstate '42501' then null; end;
  if not exists (select 1 from public.customer_payers where id = v_id) then raise exception 'FAIL E: row gone'; end if;
  raise notice 'PASS E(billing): cannot add or delete (42501)';
end $$;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000202501","role":"authenticated"}', true);
do $$
declare v_id uuid := (select id from public.customer_payers where customer_id = 'cccccccc-0000-0000-0000-000000202502');
begin
  perform public.save_customer_payer(v_id, 'cccccccc-0000-0000-0000-000000202502', 'SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED',
            'group_company', null, null, null, null);
  if (select relation from public.customer_payers where id = v_id) <> 'group_company' then raise exception 'FAIL E: edit'; end if;
  perform public.delete_customer_payer(v_id);
  if exists (select 1 from public.customer_payers where id = v_id) then raise exception 'FAIL E: delete'; end if;
  raise notice 'PASS E(owner): edit + delete';
end $$;

-- F. RLS, as the browser role
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000202506","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from public.customer_payers) <> 0 then raise exception 'FAIL F: other company sees known payers'; end if;
  raise notice 'PASS F: other company sees none';
end $$;
reset role;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000202501","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from public.customer_payers) <> 1 then raise exception 'FAIL F: own company should see its 1 known payer'; end if;
  begin
    insert into public.customer_payers (tenant_id, customer_id, payer_name, payer_name_key, relation)
    values ('dddddddd-0000-0000-0000-000000202501', 'cccccccc-0000-0000-0000-000000202501', 'DIRECT', 'direct', 'director');
    raise exception 'FAIL F: direct insert from the browser accepted';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS F: own company reads, browser cannot write directly';
end $$;
reset role;

rollback;
