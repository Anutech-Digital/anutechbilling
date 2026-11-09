-- R-2629: the Zoho FY purchase import keeps the Zoho bill's reference_number in the notes
-- (" Ref: <reference>."), so a bill that names its month ("Google Portal Bill (Aug 2025)") is placed
-- in that month by vendor_bill_service_period (management P&L, R-2156). Money columns, the undo
-- fingerprint (_r2502_bill_sig) and re-import ("already") are unchanged. Existing imported bills are
-- NOT changed: zoho_bill_reference_report(tenant) only lists what a repair would move (service_role).
-- Self-asserting; the whole file rolls back.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < this file

begin;

insert into auth.users (id, email) values
  ('b2629000-0000-0000-0000-0000000000a1', 'r2629-owner@example.test');
insert into public.tenants (id, name, email, state_code, gstin, doc_code) values
  ('b2629000-0000-0000-0000-0000000000f0', 'R2629 T', 'r2629@example.test', '07', '07AAACR2629A1Z5', 'R2629'),
  ('b2629000-0000-0000-0000-0000000000f1', 'R2629 O', 'r2629o@example.test', '07', null, 'R2629O');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('b2629000-0000-0000-0000-0000000000a1', 'b2629000-0000-0000-0000-0000000000f0', 'r2629-owner@example.test', 'Owner', 'owner', true);
update public.tenants set books_start_date = '2025-04-01' where id = 'b2629000-0000-0000-0000-0000000000f0';
insert into public.vendors (id, tenant_id, name, gstin) values
  ('b2629000-0000-0000-0000-0000000000d1', 'b2629000-0000-0000-0000-0000000000f0', 'R2629 Google', '07AAACG2629A1Z5');

create function pg_temp.ln(acct text, taxable int, tax int) returns jsonb language sql as $f$
  select jsonb_build_object('accountId', acct, 'accountName', acct || ' name', 'description', 'line ' || acct, 'hsn', '998431', 'qty', 1,
    'taxable', taxable, 'tax', tax, 'itcEligible', true);
$f$;
-- ref = null → the key is missing (a scan read before R-2629).
create function pg_temp.doc(zid text, num text, d text, acct text, taxable int, igst int, ref text) returns jsonb language sql as $f$
  select jsonb_build_object('kind', 'bills', 'zohoId', zid, 'number', num, 'date', d, 'dueDate', d, 'status', 'open',
    'vendorZohoId', 'VZG', 'vendorName', 'R2629 Google', 'gstin', '07AAACG2629A1Z5', 'gstTreatment', '', 'currency', 'INR',
    'taxable', taxable, 'igst', igst, 'cgst', 0, 'sgst', 0, 'tax', igst, 'total', taxable + igst,
    'rcm', false, 'rcmTax', 0, 'tdsAmount', 0, 'tdsSection', null, 'lines', jsonb_build_array(pg_temp.ln(acct, taxable, igst)),
    'paidThrough', '', 'problems', '[]'::jsonb)
    || case when ref is null then '{}'::jsonb else jsonb_build_object('reference', ref) end;
$f$;

insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at)
select 'b2629000-0000-0000-0000-0000000000f0', 'bills', '2025-26', x.zid, x.p->>'number', (x.p->>'date')::date, 'open', x.p, now()
from (values
  -- A: the owner's case — dated 7 Oct, reference names August.
  ('g1', pg_temp.doc('g1', '5667984259', '2025-10-07', 'A-COGS', 100000, 18000, 'Google Portal Bill (Aug 2025)')),
  -- B: an old scan payload with no reference key.
  ('g2', pg_temp.doc('g2', 'GB-2', '2025-10-08', 'A-COGS', 5000, 900, null)),
  -- C: reference = the bill number (Zoho often repeats it).
  ('g3', pg_temp.doc('g3', 'GB-3', '2025-10-09', 'A-COGS', 3000, 540, ' gb-3 ')),
  -- F: a very long reference.
  ('g5', pg_temp.doc('g5', 'GB-5', '2025-10-10', 'A-COGS', 1000, 180, repeat('Long reference ', 60))),
  -- G: an expense bill (not COGS) with a reference.
  ('g4', pg_temp.doc('g4', 'RENT-4', '2025-10-11', 'A-SW', 2000, 360, 'Sep 2025 software')),
  -- H: bills already imported before R-2629 (rows below), their scans now read with a reference.
  ('old1', pg_temp.doc('old1', 'OLD-1', '2025-10-07', 'A-COGS', 700, 126, 'Google Portal Bill (Aug 2025)')),
  ('old2', pg_temp.doc('old2', 'OLD-2', '2025-10-07', 'A-COGS', 800, 144, null)),
  ('old3', pg_temp.doc('old3', 'OLD-3', '2025-10-07', 'A-COGS', 900, 162, 'OLD-3'))
) as x(zid, p);

-- H: rows the import wrote before R-2629 (notes without the reference).
select set_config('app.zoho_purchase_import', 'on', true);
insert into public.zoho_fy_import_batches (id, tenant_id, kind, fy) values ('b2629000-0000-0000-0000-0000000000b0', 'b2629000-0000-0000-0000-0000000000f0', 'bills', '2025-26');
insert into public.vendor_bills (id, tenant_id, vendor_id, vendor_name, bill_no, bill_date, category, subtotal, cgst, sgst, igst, total,
  status, paid_amount, currency, fx_rate, document_type, notes, zoho_doc_id, purchase_import_batch_id)
values
  ('BILL-R2629-OLD1', 'b2629000-0000-0000-0000-0000000000f0', 'b2629000-0000-0000-0000-0000000000d1', 'R2629 Google', 'OLD-1', '2025-10-07',
   'COGS-Workspace', 700, 0, 0, 126, 826, 'unpaid', 0, 'INR', 1, 'tax_invoice', 'Imported from Zoho Books (bill OLD-1).', 'bills:old1', 'b2629000-0000-0000-0000-0000000000b0'),
  ('BILL-R2629-OLD2', 'b2629000-0000-0000-0000-0000000000f0', 'b2629000-0000-0000-0000-0000000000d1', 'R2629 Google', 'OLD-2', '2025-10-07',
   'COGS-Workspace', 800, 0, 0, 144, 944, 'unpaid', 0, 'INR', 1, 'tax_invoice', 'Imported from Zoho Books (bill OLD-2).', 'bills:old2', 'b2629000-0000-0000-0000-0000000000b0'),
  ('BILL-R2629-OLD3', 'b2629000-0000-0000-0000-0000000000f0', 'b2629000-0000-0000-0000-0000000000d1', 'R2629 Google', 'OLD-3', '2025-10-07',
   'COGS-Workspace', 900, 0, 0, 162, 1062, 'unpaid', 0, 'INR', 1, 'tax_invoice', 'Imported from Zoho Books (bill OLD-3).', 'bills:old3', 'b2629000-0000-0000-0000-0000000000b0');
select set_config('app.zoho_purchase_import', '', true);

create function pg_temp.as_user(p uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$f$;
create function pg_temp.picks() returns jsonb language sql as $f$
  select jsonb_build_array(
    jsonb_build_object('zoho_id', 'g1', 'vendor_id', 'b2629000-0000-0000-0000-0000000000d1'),
    jsonb_build_object('zoho_id', 'g2', 'vendor_id', 'b2629000-0000-0000-0000-0000000000d1'),
    jsonb_build_object('zoho_id', 'g3', 'vendor_id', 'b2629000-0000-0000-0000-0000000000d1'),
    jsonb_build_object('zoho_id', 'g5', 'vendor_id', 'b2629000-0000-0000-0000-0000000000d1'),
    jsonb_build_object('zoho_id', 'g4', 'vendor_id', 'b2629000-0000-0000-0000-0000000000d1'));
$f$;
grant execute on function pg_temp.as_user(uuid), pg_temp.picks() to authenticated;

create temp table r2629_out (k text primary key, v jsonb) on commit drop;
grant all on r2629_out to authenticated;

set local role authenticated;
do $$
declare r jsonb; b public.vendor_bills; e public.expenses; sp record; v_sig text;
begin
  perform pg_temp.as_user('b2629000-0000-0000-0000-0000000000a1');
  perform public.save_zoho_account_categories('[{"zoho_account_id":"A-COGS","category":"COGS-Workspace"},
    {"zoho_account_id":"A-SW","zoho_account_name":"Software","category":"Software"}]');
  r := public.import_zoho_fy_purchases('bills', '2025-26', pg_temp.picks(), false);
  if (r->>'imported')::int <> 5 then raise exception 'FAIL 0: import %', r; end if;
  insert into r2629_out values ('batch', to_jsonb(r->>'batch_id'));

  -- A: reference kept; management month = August; money as Zoho's.
  select * into b from public.vendor_bills where zoho_doc_id = 'bills:g1';
  if b.notes is distinct from 'Imported from Zoho Books (bill 5667984259). Ref: Google Portal Bill (Aug 2025).' then
    raise exception 'FAIL A1: notes %', b.notes; end if;
  if b.subtotal <> 100000 or b.igst <> 18000 or b.cgst <> 0 or b.sgst <> 0 or b.total <> 118000 or b.bill_date <> '2025-10-07'
     or b.category <> 'COGS-Workspace' or b.status <> 'unpaid' then
    raise exception 'FAIL A2: money changed %', to_jsonb(b); end if;
  select * into sp from public.vendor_bill_service_period(b.bill_date, b.category, b.bill_no, b.notes, b.service_from, b.service_to);
  if sp.service_from <> '2025-08-01' or sp.service_to <> '2025-08-31' or sp.basis <> 'reference' then
    raise exception 'FAIL A3: period % .. % (%)', sp.service_from, sp.service_to, sp.basis; end if;
  -- D (part): the undo fingerprint is the R-2502c one, unchanged by notes.
  if b.zoho_import_sig is distinct from public._r2502_bill_sig(b) then raise exception 'FAIL D1: sig % vs %', b.zoho_import_sig, public._r2502_bill_sig(b); end if;
  v_sig := b.zoho_import_sig;
  insert into r2629_out values ('sig_g1', to_jsonb(v_sig));

  -- B: no reference → notes exactly as before, Google default (previous month).
  select * into b from public.vendor_bills where zoho_doc_id = 'bills:g2';
  if b.notes is distinct from 'Imported from Zoho Books (bill GB-2).' then raise exception 'FAIL B1: notes %', b.notes; end if;
  select * into sp from public.vendor_bill_service_period(b.bill_date, b.category, b.bill_no, b.notes, b.service_from, b.service_to);
  if sp.service_from <> '2025-09-01' or sp.basis <> 'vendor_default' then raise exception 'FAIL B2: % (%)', sp.service_from, sp.basis; end if;

  -- C: reference = bill number → not repeated.
  select * into b from public.vendor_bills where zoho_doc_id = 'bills:g3';
  if b.notes is distinct from 'Imported from Zoho Books (bill GB-3).' then raise exception 'FAIL C: notes %', b.notes; end if;

  -- F: a long reference is cut; notes stay within 500.
  select * into b from public.vendor_bills where zoho_doc_id = 'bills:g5';
  if char_length(b.notes) > 500 or b.notes not like 'Imported from Zoho Books (bill GB-5). Ref: Long reference%' then
    raise exception 'FAIL F: notes (%) %', char_length(b.notes), b.notes; end if;

  -- G: an expense bill keeps its reference too; money unchanged.
  select * into e from public.expenses where zoho_doc_id = 'bills:g4';
  if e.notes not like 'Imported from Zoho Books (bill RENT-4). Ref: Sep 2025 software.%' then raise exception 'FAIL G1: notes %', e.notes; end if;
  if e.amount <> 2360 or e.gst_paid <> 360 or e.category <> 'Software' then raise exception 'FAIL G2: money %', to_jsonb(e); end if;
  if e.zoho_import_sig is distinct from public._r2502_expense_sig(e) then raise exception 'FAIL G3: expense sig'; end if;

  -- D: the same import again → all "already", nothing written, fingerprint the same.
  r := public.import_zoho_fy_purchases('bills', '2025-26', pg_temp.picks(), false);
  if (r->>'imported')::int <> 0 or (r->>'already')::int <> 5 then raise exception 'FAIL D2: rerun %', r; end if;
  if (select count(*) from public.vendor_bills where tenant_id = 'b2629000-0000-0000-0000-0000000000f0' and zoho_doc_id like 'bills:g%') <> 4 then
    raise exception 'FAIL D3: rerun wrote rows'; end if;
  if (select zoho_import_sig from public.vendor_bills where zoho_doc_id = 'bills:g1') is distinct from v_sig then raise exception 'FAIL D4: sig moved'; end if;

  -- I: a login cannot read the report (zoho_fy_scan is service_role only → permission denied).
  begin
    perform * from public.zoho_bill_reference_report('b2629000-0000-0000-0000-0000000000f0');
    raise exception 'FAIL I1: authenticated ran the report';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- H: the read-only report — existing imported bills and what a repair would move.
do $$
declare r record; n int; v_before text;
begin
  if has_function_privilege('anon', 'public.zoho_bill_reference_report(uuid)', 'execute')
     then
    raise exception 'FAIL I2: anon can run the report'; end if;
  if not has_function_privilege('service_role', 'public.zoho_bill_reference_report(uuid)', 'execute') then
    raise exception 'FAIL I3: service_role cannot run the report'; end if;
  select md5(string_agg(id || coalesce(notes, ''), ',' order by id)) into v_before from public.vendor_bills where tenant_id = 'b2629000-0000-0000-0000-0000000000f0';

  select * into r from public.zoho_bill_reference_report('b2629000-0000-0000-0000-0000000000f0') where bill_id = 'BILL-R2629-OLD1';
  if not found or r.reference <> 'Google Portal Bill (Aug 2025)' or not r.reference_read or r.now_from <> '2025-09-01' or r.now_basis <> 'vendor_default'
     or r.new_from <> '2025-08-01' or r.new_to <> '2025-08-31' or r.new_basis <> 'reference' or not r.changes then
    raise exception 'FAIL H1: old1 %', to_jsonb(r); end if;
  select * into r from public.zoho_bill_reference_report('b2629000-0000-0000-0000-0000000000f0') where bill_id = 'BILL-R2629-OLD2';
  if not found or r.reference_read or r.changes or r.reference is not null then raise exception 'FAIL H2: old2 (scan without reference) %', to_jsonb(r); end if;
  -- Nothing to move (reference = number) → not listed, so the report reaches 0 after a repair.
  if exists (select 1 from public.zoho_bill_reference_report('b2629000-0000-0000-0000-0000000000f0') where bill_id = 'BILL-R2629-OLD3') then
    raise exception 'FAIL H3: old3 (reference = number) listed'; end if;
  -- Bills imported with R-2629 already carry their reference → not listed; GB-2's scan has no reference key → listed as not read.
  if exists (select 1 from public.zoho_bill_reference_report('b2629000-0000-0000-0000-0000000000f0') where bill_no in ('5667984259', 'GB-3', 'GB-5')) then
    raise exception 'FAIL H4: bills imported with R-2629 listed'; end if;
  if not exists (select 1 from public.zoho_bill_reference_report('b2629000-0000-0000-0000-0000000000f0') where bill_no = 'GB-2' and not reference_read and not changes) then
    raise exception 'FAIL H4b: GB-2 (scan read before R-2629) not listed as not read'; end if;
  -- The note helper: dots-only reference → nothing; number written with other spacing → not repeated.
  if public._r2629_ref_note('{"number":"X","reference":"..."}') <> '' then raise exception 'FAIL H9: dots-only reference gave a note'; end if;
  if public._r2629_ref_note('{"number":"INV  12","reference":"inv 12"}') <> '' then raise exception 'FAIL H10: number repeated'; end if;
  if public._r2629_ref_note('{"number":"X","reference":"Aug 2025."}') <> ' Ref: Aug 2025.' then raise exception 'FAIL H11: % ', public._r2629_ref_note('{"number":"X","reference":"Aug 2025."}'); end if;
  select count(*) into n from public.zoho_bill_reference_report('b2629000-0000-0000-0000-0000000000f0') where changes;
  if n <> 1 then raise exception 'FAIL H5: % bills would change, expected 1', n; end if;
  -- Other company: nothing; all companies (null) includes this one's.
  if exists (select 1 from public.zoho_bill_reference_report('b2629000-0000-0000-0000-0000000000f1')) then raise exception 'FAIL H6: other company rows'; end if;
  if not exists (select 1 from public.zoho_bill_reference_report(null) where bill_id = 'BILL-R2629-OLD1') then raise exception 'FAIL H7: all-companies report'; end if;
  -- Read-only: nothing changed.
  if (select md5(string_agg(id || coalesce(notes, ''), ',' order by id)) from public.vendor_bills where tenant_id = 'b2629000-0000-0000-0000-0000000000f0') <> v_before then
    raise exception 'FAIL H8: the report changed a bill'; end if;
end $$;

-- E: undo of a batch imported with references still works (fingerprint unchanged by notes).
set local role authenticated;
do $$
declare r jsonb;
begin
  perform pg_temp.as_user('b2629000-0000-0000-0000-0000000000a1');
  r := public.remove_zoho_fy_purchase_import((select (v #>> '{}')::uuid from r2629_out where k = 'batch'), 'r2629 test undo');
  if exists (select 1 from public.vendor_bills where zoho_doc_id in ('bills:g1', 'bills:g2', 'bills:g3', 'bills:g5'))
     or exists (select 1 from public.expenses where zoho_doc_id = 'bills:g4') then
    raise exception 'FAIL E: undo left rows %', r; end if;
end $$;
reset role;

rollback;
