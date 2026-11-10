-- R-1916 (8 Nov 2026, slice 1, from the R-1906 audit B6): TDS on a vendor ADVANCE paid from the bank.
-- Migration: 20261108*_r1916_vendor_advance_tds.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Owner's path: a contractor's ₹90,000 bank line → Banking → "Paying a vendor?" → advance,
-- TDS 194J ₹10,000 withheld (TDS is due at credit or payment, whichever is earlier).
--   A. The advance is ₹1,00,000 gross (cash ₹90,000 + TDS ₹10,000); the payment row carries
--      TDS ₹10,000, 194J, base ₹1,00,000, deducted on the bank date (the 26Q / TDS-payable row).
--   B. Balance Sheet: TDS payable (dues_vendor_tds) +₹10,000, prepaid advances ₹1,00,000.
--   C. Un-reconcile the bank line → the advance and its TDS are gone (TDS payable back to 0).
--   D. The old 9-argument call (no TDS) still books a plain advance.
--   E. Guards: TDS without an advance, without a section, 194Q, more than 20% of the gross,
--      negative TDS, a sales user.

begin;

create function pg_temp.r1916_fill_supplier() returns trigger language plpgsql as $f$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street');
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := '07AAACT1643F1Z5';
  end if;
  return new;
end $f$;
create trigger zz_r1916_supplier before insert on public.tenants for each row execute function pg_temp.r1916_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000191601','R1916 Co','r1916@example.in','07','R1916');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000191601','owner1916@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000191602','sales1916@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000191601','dddddddd-0000-0000-0000-000000191601','owner1916@example.in','Owner 1916','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000191602','dddddddd-0000-0000-0000-000000191601','sales1916@example.in','Sales 1916','sales', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000191601','dddddddd-0000-0000-0000-000000191601','HDFC Current','HDFC');
insert into public.vendors (id, tenant_id, name, pan, default_category) values
  ('eeeeeeee-0000-0000-0000-000000191601','dddddddd-0000-0000-0000-000000191601','Sharma Design Studio','ABCPS1916K','Professional Fees');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000191601','dddddddd-0000-0000-0000-000000191601','bbbbbbbb-0000-0000-0000-000000191601','2026-10-05','NEFT SHARMA DESIGN ADV',90000,0,'S1','csv_upload'),
  ('11111111-0000-0000-0000-000000191602','dddddddd-0000-0000-0000-000000191601','bbbbbbbb-0000-0000-0000-000000191601','2026-10-06','NEFT SHARMA DESIGN ADV 2',5000,0,'S2','csv_upload');

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000191601","role":"authenticated"}', true);

-- ── A. ₹90,000 cash + ₹10,000 TDS 194J → a ₹1,00,000 advance with its TDS row ────────────────
do $$
declare r jsonb; a public.prepaid_advances; l public.bank_vendor_payment_lines;
begin
  r := public.reconcile_bank_debit_to_vendor(
         p_txn_id => '11111111-0000-0000-0000-000000191601', p_vendor_id => 'eeeeeeee-0000-0000-0000-000000191601',
         p_new_vendor => null, p_items => '[]'::jsonb, p_new_bill => null,
         p_advance => 90000, p_advance_category => null, p_bank_charge => 0, p_note => null,
         p_advance_tds => 10000, p_advance_tds_section => '194jb', p_advance_tds_override_reason => null);
  select * into a from public.prepaid_advances where vendor_id = 'eeeeeeee-0000-0000-0000-000000191601';
  if a.total_amount <> 100000 then
    raise exception 'A FAIL: advance gross ₹% — want ₹1,00,000 (cash ₹90,000 + TDS ₹10,000)', a.total_amount;
  end if;
  select * into l from public.bank_vendor_payment_lines where prepaid_advance_id = a.id;
  if l.cash <> 90000 or l.tds_amount <> 10000 or l.tds_section is distinct from '194JB'
     or l.tds_base <> 100000 or l.tds_on is distinct from date '2026-10-05' then
    raise exception 'A FAIL: payment row cash % tds % sec % base % on %', l.cash, l.tds_amount, l.tds_section, l.tds_base, l.tds_on;
  end if;
  if (r->'advance'->>'amount')::int <> 100000 or (r->'advance'->>'tds')::int <> 10000 or (r->>'tds_total')::int <> 10000 then
    raise exception 'A FAIL: RPC returned %', r;
  end if;
  raise notice 'A ok: advance ₹1,00,000 = cash ₹90,000 + TDS ₹10,000 (194JB, base ₹1,00,000, 05 Oct)';
end $$;

-- ── B. Balance Sheet: TDS payable +₹10,000, prepaid ₹1,00,000 ──────────────────────────────────
do $$
declare bs record;
begin
  select * into bs from public.report_balance_sheet(date '2026-10-31');
  if bs.dues_vendor_tds <> 10000 then
    raise exception 'B FAIL: TDS payable (dues_vendor_tds) ₹% — want ₹10,000 from the advance', bs.dues_vendor_tds;
  end if;
  if bs.prepaid_advances <> 100000 then
    raise exception 'B FAIL: prepaid advances ₹% — want ₹1,00,000', bs.prepaid_advances;
  end if;
  raise notice 'B ok: Balance Sheet TDS payable ₹10,000, prepaid ₹1,00,000';
end $$;

-- ── C. Un-reconcile → advance and TDS gone ────────────────────────────────────────────────────
update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = '11111111-0000-0000-0000-000000191601';
do $$
declare bs record; n int;
begin
  select count(*) into n from public.prepaid_advances where vendor_id = 'eeeeeeee-0000-0000-0000-000000191601';
  if n <> 0 then raise exception 'C FAIL: % advance(s) left after un-reconcile', n; end if;
  select * into bs from public.report_balance_sheet(date '2026-10-31');
  if bs.dues_vendor_tds <> 0 then raise exception 'C FAIL: TDS payable ₹% after un-reconcile', bs.dues_vendor_tds; end if;
  raise notice 'C ok: un-reconcile removed the advance and its TDS';
end $$;

-- ── D. The old 9-argument call still books a plain advance ─────────────────────────────────────
do $$
declare r jsonb; a public.prepaid_advances;
begin
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191602','eeeeeeee-0000-0000-0000-000000191601', null, '[]'::jsonb, null, 5000, null);
  select * into a from public.prepaid_advances where vendor_id = 'eeeeeeee-0000-0000-0000-000000191601';
  if a.total_amount <> 5000 then raise exception 'D FAIL: plain advance ₹%', a.total_amount; end if;
  update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = '11111111-0000-0000-0000-000000191602';
  raise notice 'D ok: 9-argument call unchanged';
end $$;

-- ── E. Guards ──────────────────────────────────────────────────────────────────────────────────
create function pg_temp.r1916_try(p_adv integer, p_tds integer, p_sec text) returns text language plpgsql as $f$
begin
  perform public.reconcile_bank_debit_to_vendor(
    p_txn_id => '11111111-0000-0000-0000-000000191601', p_vendor_id => 'eeeeeeee-0000-0000-0000-000000191601',
    p_new_vendor => null,
    p_items => '[]'::jsonb, p_new_bill => null,
    p_advance => p_adv, p_advance_category => null, p_bank_charge => 0, p_note => null,
    p_advance_tds => p_tds, p_advance_tds_section => p_sec, p_advance_tds_override_reason => null);
  return 'ACCEPTED';
exception when others then
  return sqlerrm;
end $f$;

do $$
declare m text;
begin
  m := pg_temp.r1916_try(0, 10000, '194J');
  if m = 'ACCEPTED' then raise exception 'E FAIL: TDS with no advance accepted'; end if;
  m := pg_temp.r1916_try(90000, 10000, null);
  if m not ilike '%section%' then raise exception 'E FAIL: no section → %', m; end if;
  m := pg_temp.r1916_try(90000, 10000, '194Q');
  if m not ilike '%194Q%' then raise exception 'E FAIL: 194Q → %', m; end if;
  m := pg_temp.r1916_try(70000, 30000, '194J');
  if m not ilike '%20%' then raise exception 'E FAIL: 30%% TDS → %', m; end if;
  m := pg_temp.r1916_try(90000, -1, '194J');
  if m = 'ACCEPTED' then raise exception 'E FAIL: negative TDS accepted'; end if;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000191602","role":"authenticated"}', true);
  m := pg_temp.r1916_try(90000, 10000, '194J');
  if m = 'ACCEPTED' then raise exception 'E FAIL: sales user booked an advance with TDS'; end if;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000191601","role":"authenticated"}', true);
  raise notice 'E ok: guards hold';
end $$;

rollback;
