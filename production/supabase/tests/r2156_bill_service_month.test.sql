-- Regression test: R-2156 slice 1 — the management P&L puts a COGS bill in the month the licence
-- was USED (vendor_bill_service_period + report_pnl_cogs_matched); report_pnl (GST / as invoiced,
-- by bill date) is unchanged.
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r2156_bill_service_month.test.sql
--
-- Owner's case (30 Oct): Google bill dated 7 Oct 2026, reference "Google Portal Bill (Aug 2026)"
-- → August cost, not October.

begin;

-- ── vendor_bill_service_period: the rules, one by one ──────────────────────────────────────
do $$
declare r record;
begin
  -- A: a month + year in the bill no / notes wins.
  select * into r from public.vendor_bill_service_period('2026-10-07', 'COGS-Workspace', '5667984259', 'Google Portal Bill (Aug 2026)', null, null);
  if r.service_from <> '2026-08-01' or r.service_to <> '2026-08-31' or r.basis <> 'reference' then
    raise exception 'FAIL A1: Aug reference gave % .. % (%)', r.service_from, r.service_to, r.basis; end if;
  select * into r from public.vendor_bill_service_period('2026-10-07', 'COGS-Zoho', 'INV-1', 'Licences for September 2026', null, null);
  if r.service_from <> '2026-09-01' or r.service_to <> '2026-09-30' or r.basis <> 'reference' then
    raise exception 'FAIL A2: "September 2026" gave % .. % (%)', r.service_from, r.service_to, r.basis; end if;
  select * into r from public.vendor_bill_service_period('2026-10-07', 'COGS-Other', 'Jul-2026', 'to Sep 2026', null, null);
  if r.service_from <> '2026-07-01' or r.service_to <> '2026-09-30' then
    raise exception 'FAIL A3: "Jul-2026 .. Sep 2026" gave % .. %', r.service_from, r.service_to; end if;
  select * into r from public.vendor_bill_service_period('2026-10-07', 'COGS-Other', null, 'aug''2026 usage', null, null);
  if r.service_from <> '2026-08-01' then raise exception 'FAIL A4: "aug''2026" gave %', r.service_from; end if;

  -- B: Google / Microsoft with no month text → the month before the bill.
  select * into r from public.vendor_bill_service_period('2026-10-07', 'COGS-Workspace', '5667984259', null, null, null);
  if r.service_from <> '2026-09-01' or r.service_to <> '2026-09-30' or r.basis <> 'vendor_default' then
    raise exception 'FAIL B1: Google no-month gave % .. % (%)', r.service_from, r.service_to, r.basis; end if;
  select * into r from public.vendor_bill_service_period('2026-01-03', 'COGS-M365', 'MS-1', '', null, null);
  if r.service_from <> '2025-12-01' or r.service_to <> '2025-12-31' or r.basis <> 'vendor_default' then
    raise exception 'FAIL B2: Microsoft Jan bill gave % .. % (%)', r.service_from, r.service_to, r.basis; end if;

  -- C: any other bill with no month text → its own month (as today).
  select * into r from public.vendor_bill_service_period('2026-10-07', 'COGS-Zoho', 'Z-1', 'Zoho renewal', null, null);
  if r.service_from <> '2026-10-01' or r.service_to <> '2026-10-31' or r.basis <> 'bill_month' then
    raise exception 'FAIL C: Zoho no-month gave % .. % (%)', r.service_from, r.service_to, r.basis; end if;

  -- D: the bill's own service period wins over text and the vendor default.
  select * into r from public.vendor_bill_service_period('2026-10-07', 'COGS-Workspace', 'X', 'Google Portal Bill (Aug 2026)', '2026-07-01', '2026-07-31');
  if r.service_from <> '2026-07-01' or r.service_to <> '2026-07-31' or r.basis <> 'set' then
    raise exception 'FAIL D: explicit period gave % .. % (%)', r.service_from, r.service_to, r.basis; end if;

  -- G: numbers are never a month.
  select * into r from public.vendor_bill_service_period('2026-10-07', 'COGS-Other', '08/2026', '2026-08 bill 5667984259', null, null);
  if r.basis <> 'bill_month' or r.service_from <> '2026-10-01' then
    raise exception 'FAIL G: numeric text read as a month: % (%)', r.service_from, r.basis; end if;

  -- H: a month far from the bill date (typo) is ignored.
  select * into r from public.vendor_bill_service_period('2026-10-07', 'COGS-Workspace', null, 'Google Portal Bill (Aug 2019)', null, null);
  if r.basis <> 'vendor_default' or r.service_from <> '2026-09-01' then
    raise exception 'FAIL H1: "Aug 2019" on a 2026 bill used: % (%)', r.service_from, r.basis; end if;
  select * into r from public.vendor_bill_service_period('2026-10-07', 'COGS-Other', null, 'prepaid Oct 2027', null, null);
  if r.basis <> 'reference' or r.service_from <> '2027-10-01' then
    raise exception 'FAIL H2: 12 months ahead should be read: % (%)', r.service_from, r.basis; end if;
  select * into r from public.vendor_bill_service_period('2026-10-07', 'COGS-Other', null, 'prepaid Nov 2027', null, null);
  if r.basis <> 'bill_month' then
    raise exception 'FAIL H3: 13 months ahead should be ignored: % (%)', r.service_from, r.basis; end if;
end $$;

-- ── report_pnl_cogs_matched on real rows ───────────────────────────────────────────────────
insert into public.tenants (id, name, email, state_code) values
  ('d2156000-0000-0000-0000-0000000000a1', 'R2156 A', 'r2156-a@example.in', '07'),
  ('d2156000-0000-0000-0000-0000000000b1', 'R2156 B', 'r2156-b@example.in', '07');
insert into auth.users (id, email) values
  ('d2156000-0000-0000-0000-0000000000a2', 'r2156-user-a@example.test');
insert into public.users (id, tenant_id, email, role) values
  ('d2156000-0000-0000-0000-0000000000a2', 'd2156000-0000-0000-0000-0000000000a1', 'r2156-user-a@example.in', 'owner');

insert into public.vendor_bills (id, tenant_id, vendor_name, bill_no, notes, bill_date, category, subtotal, cgst, sgst, igst, total, status, document_type, service_from, service_to) values
  -- Google, dated 7 Oct, for August (the owner's case).
  ('R2156-GAUG', 'd2156000-0000-0000-0000-0000000000a1', 'Google', '5667984259', 'Google Portal Bill (Aug 2026)', '2026-10-07', 'COGS-Workspace', 1033617, 0, 0, 0, 1033617, 'unpaid', 'tax_invoice', null, null),
  -- Zoho, own month (Oct).
  ('R2156-ZOCT', 'd2156000-0000-0000-0000-0000000000a1', 'Zoho', 'Z-9', null, '2026-10-12', 'COGS-Zoho', 451, 0, 0, 0, 451, 'unpaid', 'tax_invoice', null, null),
  -- Three months, set on the bill: 1,000 → 333 / 333 / 334.
  ('R2156-Q3',   'd2156000-0000-0000-0000-0000000000a1', 'Some reseller', 'R-3', null, '2026-10-01', 'COGS-Other', 1000, 0, 0, 0, 1000, 'unpaid', 'tax_invoice', '2026-10-01', '2026-12-31'),
  -- A vendor credit (negative) over two months: -101 → -50 / -51.
  ('R2156-CR',   'd2156000-0000-0000-0000-0000000000a1', 'Some reseller', 'CR-1', null, '2026-10-20', 'COGS-Other', -101, 0, 0, 0, -101, 'unpaid', 'tax_invoice', '2026-10-01', '2026-11-30'),
  -- Zero adds nothing.
  ('R2156-ZERO', 'd2156000-0000-0000-0000-0000000000a1', 'Zoho', 'Z-0', null, '2026-10-15', 'COGS-Zoho', 0, 0, 0, 0, 0, 'unpaid', 'tax_invoice', null, null),
  -- Not COGS: never in either view.
  ('R2156-OFF',  'd2156000-0000-0000-0000-0000000000a1', 'Stationer', 'S-1', 'Oct 2026', '2026-10-08', 'Office', 9999, 0, 0, 0, 9999, 'unpaid', 'tax_invoice', null, null),
  -- Tenant B's Google bill for October: never in A's report.
  ('R2156-B',    'd2156000-0000-0000-0000-0000000000b1', 'Google', 'B-1', 'Oct 2026', '2026-11-05', 'COGS-Workspace', 777777, 0, 0, 0, 777777, 'unpaid', 'tax_invoice', null, null);

-- The service period must be both-or-neither, in order, at most 36 months.
do $$
begin
  begin
    insert into public.vendor_bills (id, tenant_id, vendor_name, bill_date, category, subtotal, total, service_from)
    values ('R2156-BAD1', 'd2156000-0000-0000-0000-0000000000a1', 'X', '2026-10-01', 'COGS-Other', 1, 1, '2026-10-01');
    raise exception 'FAIL CK1: service_from without service_to was saved';
  exception when check_violation then null; end;
  begin
    insert into public.vendor_bills (id, tenant_id, vendor_name, bill_date, category, subtotal, total, service_from, service_to)
    values ('R2156-BAD2', 'd2156000-0000-0000-0000-0000000000a1', 'X', '2026-10-01', 'COGS-Other', 1, 1, '2026-10-01', '2026-09-30');
    raise exception 'FAIL CK2: service_to before service_from was saved';
  exception when check_violation then null; end;
  begin
    insert into public.vendor_bills (id, tenant_id, vendor_name, bill_date, category, subtotal, total, service_from, service_to)
    values ('R2156-BAD3', 'd2156000-0000-0000-0000-0000000000a1', 'X', '2026-10-01', 'COGS-Other', 1, 1, '2026-10-01', '2029-10-01');
    raise exception 'FAIL CK3: a 36-month+ service period was saved';
  exception when check_violation then null; end;
end $$;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'd2156000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);

do $$
declare m record; g record; aug record; v bigint; bill jsonb;
begin
  -- Owner's case: October (management) = Zoho 451 + 333 (Q3) - 50 (credit) — NOT the Aug Google bill.
  select * into m from public.report_pnl_cogs_matched('2026-10-01', '2026-10-31');
  if m.cogs <> 451 + 333 - 50 then raise exception 'FAIL A5: Oct matched cogs % (want 734): %', m.cogs, m.bills; end if;
  if exists (select 1 from jsonb_array_elements(m.bills) x where x->>'id' = 'R2156-GAUG') then
    raise exception 'FAIL A6: the Aug Google bill is still in October: %', m.bills; end if;
  if exists (select 1 from jsonb_array_elements(m.bills) x where x->>'id' in ('R2156-OFF', 'R2156-B')) then
    raise exception 'FAIL J1: non-COGS or other tenant bill in A''s report: %', m.bills; end if;
  -- Count = bills with a share in the range, a zero bill included (like report_pnl.cogs_count).
  if m.cogs_count <> 4 then raise exception 'FAIL A7: Oct bill count % (want 4: Zoho, zero Zoho, Q3, credit) %', m.cogs_count, m.bills; end if;

  -- August (management) carries the Google bill in full, with its reference basis.
  select * into aug from public.report_pnl_cogs_matched('2026-08-01', '2026-08-31');
  if aug.cogs <> 1033617 then raise exception 'FAIL A8: Aug matched cogs % (want 1033617)', aug.cogs; end if;
  select x into bill from jsonb_array_elements(aug.bills) x where x->>'id' = 'R2156-GAUG';
  if bill->>'basis' <> 'reference' or bill->>'service_from' <> '2026-08-01' or (bill->>'amount')::bigint <> 1033617 then
    raise exception 'FAIL A9: Aug bill row %', bill; end if;
  select (c->>'subtotal')::bigint into v from jsonb_array_elements(aug.cogs_by_category) c where c->>'category' = 'COGS-Workspace';
  if v is distinct from 1033617::bigint then raise exception 'FAIL A10: Aug cogs_by_category %', aug.cogs_by_category; end if;

  -- E: the 3-month bill: 333 / 333 / 334; the credit -50 / -51 (I).
  select * into m from public.report_pnl_cogs_matched('2026-11-01', '2026-11-30');
  if m.cogs <> 333 - 51 then raise exception 'FAIL E1: Nov % (want 282): %', m.cogs, m.bills; end if;
  select * into m from public.report_pnl_cogs_matched('2026-12-01', '2026-12-31');
  if m.cogs <> 334 then raise exception 'FAIL E2: Dec % (want 334)', m.cogs; end if;
  -- E: half of November (15 of 30 days) = half of Nov's share, by days.
  select * into m from public.report_pnl_cogs_matched('2026-11-16', '2026-11-30');
  select (x->>'amount')::bigint into v from jsonb_array_elements(m.bills) x where x->>'id' = 'R2156-Q3';
  if v <> round(333 * 15 / 30.0) then raise exception 'FAIL E3: half Nov of Q3 = % (want 167)', v; end if;

  -- F: a range covering every service month sums to exactly what report_pnl sums by bill date.
  select * into m from public.report_pnl_cogs_matched('2026-01-01', '2027-12-31');
  select * into g from public.report_pnl('2026-01-01', '2027-12-31');
  if m.cogs <> g.cogs then raise exception 'FAIL F: matched % vs report_pnl % over the whole range', m.cogs, g.cogs; end if;
  if m.cogs <> 1033617 + 451 + 1000 - 101 then raise exception 'FAIL F2: whole range %', m.cogs; end if;

  -- K: report_pnl (GST / as invoiced) still puts the Aug Google bill in October, by bill date.
  select * into g from public.report_pnl('2026-10-01', '2026-10-31');
  if g.cogs <> 1033617 + 451 + 1000 - 101 + 0 then raise exception 'FAIL K: report_pnl Oct cogs % changed', g.cogs; end if;
  select * into g from public.report_pnl('2026-08-01', '2026-08-31');
  if g.cogs <> 0 then raise exception 'FAIL K2: report_pnl Aug cogs % (want 0, bill date is Oct)', g.cogs; end if;

  -- J: B's Google bill (Oct, by reference) never reaches A, in any month.
  select * into m from public.report_pnl_cogs_matched('2026-01-01', '2027-12-31');
  if exists (select 1 from jsonb_array_elements(m.bills) x where x->>'id' = 'R2156-B') then
    raise exception 'FAIL J2: tenant B bill visible to A'; end if;

  -- Bad range refused like report_pnl.
  begin
    perform public.report_pnl_cogs_matched('2026-10-31', '2026-10-01');
    raise exception 'FAIL R1: from > to accepted';
  exception when invalid_parameter_value then null; end;
end $$;

-- J: no company on the login → refused.
reset role;
insert into auth.users (id, email) values ('d2156000-0000-0000-0000-0000000000c2', 'r2156-nobody@example.test');
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'd2156000-0000-0000-0000-0000000000c2', 'role', 'authenticated')::text, true);
do $$
begin
  begin
    perform public.report_pnl_cogs_matched('2026-10-01', '2026-10-31');
    raise exception 'FAIL J3: a login with no company got a report';
  exception when insufficient_privilege then null; end;
end $$;

rollback;
