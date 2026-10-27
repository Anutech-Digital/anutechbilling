-- R-1918 (26 Oct 2026): "＋ New vendor" on a money-out bank line saves the account no, IFSC and
-- UPI id the narration shows, so the NEXT line from the same vendor is guessed by them.
-- Migration 20261026003327_r1918_new_vendor_bank_details.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Proves:
--   A. A new vendor added from 'TPT' / 'UPI' lines is saved with bank_account_no, bank_ifsc, upi_id
--      (account spaces removed, IFSC upper case, UPI lower case).
--   B. The next line from them — no name word in it — is guessed by account no (IMPS) and by UPI id
--      (bank_debit_vendor_guess, the one auto-reconcile and the sheet use).
--   C. Wrong values are refused with the field's own words, and nothing is written: account with
--      letters, a 10-character IFSC, an IFSC without its account no, a bad UPI id.
--   D. The typed name is already a vendor: its EMPTY bank fields are filled; a vendor that already
--      has bank details keeps them (never overwritten).

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
  ('dddddddd-0000-0000-0000-000000191801','R1918 Co','r1918@example.in','07','R1918');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000191801','owner1918@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000191801','dddddddd-0000-0000-0000-000000191801','owner1918@example.in','Owner 1918','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000191801','dddddddd-0000-0000-0000-000000191801','HDFC Current','HDFC');

-- D: two vendors that already exist — one with no bank details, one with its own.
insert into public.vendors (id, tenant_id, name, bank_account_no, bank_ifsc, upi_id) values
  ('eeeeeeee-0000-0000-0000-000000191801','dddddddd-0000-0000-0000-000000191801','Verma Traders', null, null, null),
  ('eeeeeeee-0000-0000-0000-000000191802','dddddddd-0000-0000-0000-000000191801','Gupta Print House','123456789012','SBIN0001918','gupta@oksbi');

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000191801','dddddddd-0000-0000-0000-000000191801','bbbbbbbb-0000-0000-0000-000000191801','2026-10-10','50100784857169-TPT-INVOICE 45-SHARMA ASSOCIATES',10000,0,'U1','manual'),
  ('11111111-0000-0000-0000-000000191802','dddddddd-0000-0000-0000-000000191801','bbbbbbbb-0000-0000-0000-000000191801','2026-10-11','IMPS-529912345679-SA-HDFC-50100784857169-INV',5000,0,'U2','manual'),
  ('11111111-0000-0000-0000-000000191803','dddddddd-0000-0000-0000-000000191801','bbbbbbbb-0000-0000-0000-000000191801','2026-10-12','UPI-KAPOOR LEGAL-kapoorlegal@okhdfcbank-HDFC0001234-529912345680-FEES',3000,0,'U3','manual'),
  ('11111111-0000-0000-0000-000000191804','dddddddd-0000-0000-0000-000000191801','bbbbbbbb-0000-0000-0000-000000191801','2026-10-13','UPI-KL-kapoorlegal@okhdfcbank-HDFC0001234-529912345681-FEES',3000,0,'U4','manual'),
  ('11111111-0000-0000-0000-000000191805','dddddddd-0000-0000-0000-000000191801','bbbbbbbb-0000-0000-0000-000000191801','2026-10-14','NEFT DR-SBIN0004321-ANY NAME-NETBANK, MUM-N298252345678901-X',2000,0,'U5','manual'),
  ('11111111-0000-0000-0000-000000191806','dddddddd-0000-0000-0000-000000191801','bbbbbbbb-0000-0000-0000-000000191801','2026-10-15','NEFT DR-SBIN0004321-VERMA TRADERS-NETBANK, MUM-N298252345678902-X',2000,0,'U6','manual'),
  ('11111111-0000-0000-0000-000000191807','dddddddd-0000-0000-0000-000000191801','bbbbbbbb-0000-0000-0000-000000191801','2026-10-16','IMPS-529912345682-GUPTA PRINT HOUSE-ICIC-000405123456-X',2000,0,'U7','manual');

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000191801","role":"authenticated"}', true);

-- B (before): nobody has this account / UPI id yet — no guess.
do $$
begin
  if public.bank_debit_vendor_guess('11111111-0000-0000-0000-000000191802') is not null then
    raise exception 'FAIL B0: a vendor guessed before any vendor has the account'; end if;
  raise notice 'PASS B0: no vendor guessed before the new vendor is saved';
end $$;

-- A. New vendors from the bank line, with their bank details.
do $$
declare v public.vendors;
begin
  perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191801', null,
    '{"name":"Sharma Associates","bank_account_no":"5010 0784 8571 69","bank_ifsc":"hdfc0001234","upi_id":null}'::jsonb,
    '[]'::jsonb, null, 10000, 'Professional Services');
  select * into v from public.vendors where tenant_id = 'dddddddd-0000-0000-0000-000000191801' and name = 'Sharma Associates';
  if v.bank_account_no is distinct from '50100784857169' or v.bank_ifsc is distinct from 'HDFC0001234' or v.upi_id is not null then
    raise exception 'FAIL A1: Sharma saved as % / % / %', v.bank_account_no, v.bank_ifsc, v.upi_id; end if;

  perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191803', null,
    '{"name":"Kapoor Legal","upi_id":" KapoorLegal@OkHdfcBank "}'::jsonb,
    '[]'::jsonb, null, 3000, 'Professional Services');
  select * into v from public.vendors where tenant_id = 'dddddddd-0000-0000-0000-000000191801' and name = 'Kapoor Legal';
  if v.upi_id is distinct from 'kapoorlegal@okhdfcbank' or v.bank_account_no is not null or v.bank_ifsc is not null then
    raise exception 'FAIL A2: Kapoor saved as % / % / %', v.bank_account_no, v.bank_ifsc, v.upi_id; end if;
  raise notice 'PASS A: new vendors saved with account no + IFSC (Sharma) and UPI id (Kapoor Legal)';
end $$;

-- B. The next line from each — no name word — is guessed by account no / UPI id.
do $$
declare g uuid;
begin
  g := public.bank_debit_vendor_guess('11111111-0000-0000-0000-000000191802');
  if g is distinct from (select id from public.vendors where tenant_id = 'dddddddd-0000-0000-0000-000000191801' and name = 'Sharma Associates') then
    raise exception 'FAIL B1: IMPS line with the account no guessed %', g; end if;
  g := public.bank_debit_vendor_guess('11111111-0000-0000-0000-000000191804');
  if g is distinct from (select id from public.vendors where tenant_id = 'dddddddd-0000-0000-0000-000000191801' and name = 'Kapoor Legal') then
    raise exception 'FAIL B2: UPI line guessed %', g; end if;
  raise notice 'PASS B: next lines guessed — Sharma by account no, Kapoor Legal by UPI id';
end $$;

-- C. Wrong values refused with the field's words; nothing written.
do $$
declare n_before int; n_after int; msg text; bad jsonb; want text;
begin
  select count(*) into n_before from public.vendors where tenant_id = 'dddddddd-0000-0000-0000-000000191801';
  for bad, want in values
    ('{"name":"Bad One","bank_account_no":"50100AB4521","bank_ifsc":"HDFC0001234"}'::jsonb, 'account number has digits only'),
    ('{"name":"Bad Two","bank_account_no":"50100784851111","bank_ifsc":"IDFB002015"}'::jsonb, 'needs 11 characters'),
    ('{"name":"Bad Three","bank_ifsc":"SBIN0004321"}'::jsonb, 'account number that goes with this IFSC'),
    ('{"name":"Bad Four","upi_id":"not-a-upi"}'::jsonb, 'UPI ID looks wrong')
  loop
    begin
      perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191805', null, bad, '[]'::jsonb, null, 2000, 'Other');
      raise exception 'FAIL C: % was accepted', bad;
    exception when sqlstate '22023' then
      get stacked diagnostics msg = message_text;
      if strpos(msg, want) = 0 then raise exception 'FAIL C: % gave "%"', bad, msg; end if;
    end;
  end loop;
  select count(*) into n_after from public.vendors where tenant_id = 'dddddddd-0000-0000-0000-000000191801';
  if n_after <> n_before then raise exception 'FAIL C: vendors % → %', n_before, n_after; end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000191805') is not null then
    raise exception 'FAIL C: the line was reconciled'; end if;
  raise notice 'PASS C: bad account / IFSC / IFSC-alone / UPI refused with their own words, nothing written';
end $$;

-- D. Typed name is an existing vendor: empty fields filled, saved ones kept.
do $$
declare v public.vendors;
begin
  perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191806', null,
    '{"name":"Verma Traders","bank_account_no":"778899001122","bank_ifsc":"SBIN0004321","upi_id":"verma@oksbi"}'::jsonb,
    '[]'::jsonb, null, 2000, 'Other');
  select * into v from public.vendors where id = 'eeeeeeee-0000-0000-0000-000000191801';
  if v.bank_account_no is distinct from '778899001122' or v.bank_ifsc is distinct from 'SBIN0004321' or v.upi_id is distinct from 'verma@oksbi' then
    raise exception 'FAIL D1: Verma filled as % / % / %', v.bank_account_no, v.bank_ifsc, v.upi_id; end if;

  perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191807', null,
    '{"name":"Gupta Print House","bank_account_no":"000405123456","bank_ifsc":"ICIC0000405","upi_id":"other@okicici"}'::jsonb,
    '[]'::jsonb, null, 2000, 'Other');
  select * into v from public.vendors where id = 'eeeeeeee-0000-0000-0000-000000191802';
  if v.bank_account_no is distinct from '123456789012' or v.bank_ifsc is distinct from 'SBIN0001918' or v.upi_id is distinct from 'gupta@oksbi' then
    raise exception 'FAIL D2: Gupta overwritten to % / % / %', v.bank_account_no, v.bank_ifsc, v.upi_id; end if;
  if (select count(*) from public.vendors where tenant_id = 'dddddddd-0000-0000-0000-000000191801' and name in ('Verma Traders', 'Gupta Print House')) <> 2 then
    raise exception 'FAIL D: a second vendor was created'; end if;
  raise notice 'PASS D: existing vendor''s empty bank fields filled; saved details never overwritten';
end $$;

rollback;
