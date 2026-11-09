-- Regression test: R-2623 — the owner sets a vendor bill's service period (the month(s) the
-- licence was used) on the bill. vendor_bills_service_periods(ids) shows each bill's period with
-- its basis (set / reference / vendor_default / bill_month); a bill in a books-locked (filed)
-- month may change ONLY service_from / service_to (management P&L) — anything else is refused as
-- before; report_pnl (GST / as invoiced) does not move.
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r2623_bill_service_period_edit.test.sql

begin;

insert into public.tenants (id, name, email, state_code, books_locked_until) values
  ('e2623000-0000-0000-0000-0000000000a1', 'R2623 A', 'r2623a@example.test', '07', '2026-10-31'),
  ('e2623000-0000-0000-0000-0000000000b1', 'R2623 B', 'r2623b@example.test', '07', null);
insert into auth.users (id, instance_id, aud, role, email) values
  ('e2623000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r2623-owner@example.test');
insert into public.users (id, tenant_id, email, role) values
  ('e2623000-0000-0000-0000-0000000000a2', 'e2623000-0000-0000-0000-0000000000a1', 'r2623-owner@example.test', 'owner');

-- Written by the system (no JWT → the books lock does not apply to these inserts).
insert into public.vendor_bills (id, tenant_id, vendor_name, bill_no, bill_date, category, subtotal, cgst, sgst, igst, total, status, paid_amount, notes) values
  -- Google bill dated 7 Oct, no month in the text → Sep (vendor default). October is LOCKED.
  ('R2623-G', 'e2623000-0000-0000-0000-0000000000a1', 'Google', '5667984259', '2026-10-07', 'COGS-Workspace', 100000, 0, 0, 18000, 118000, 'partial', 50000, null),
  -- Zoho bill whose notes name August.
  ('R2623-Z', 'e2623000-0000-0000-0000-0000000000a1', 'Zoho', 'Z-1', '2026-11-03', 'COGS-Zoho', 3000, 0, 0, 540, 3540, 'unpaid', 0, 'Licences for Aug 2026'),
  -- Other bill, no text → its own month.
  ('R2623-O', 'e2623000-0000-0000-0000-0000000000a1', 'Other', 'O-1', '2026-11-05', 'COGS-Other', 500, 0, 0, 0, 500, 'unpaid', 0, null),
  -- Another company's bill.
  ('R2623-B', 'e2623000-0000-0000-0000-0000000000b1', 'Google', 'B-1', '2026-10-07', 'COGS-Workspace', 7000, 0, 0, 0, 7000, 'unpaid', 0, null);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'e2623000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);

do $$
declare
  r record;
  n int;
  g_before bigint;
  g_after bigint;
  m record;
  msg text;
begin
  -- S1: periods with their basis, one call for many bills; another company's id gives nothing.
  select count(*) into n from public.vendor_bills_service_periods(array['R2623-G', 'R2623-Z', 'R2623-O', 'R2623-B']);
  if n <> 3 then raise exception 'FAIL S1a: % rows (want 3 — B is another company)', n; end if;
  select * into r from public.vendor_bills_service_periods(array['R2623-G']);
  if r.service_from <> '2026-09-01' or r.service_to <> '2026-09-30' or r.basis <> 'vendor_default' then
    raise exception 'FAIL S1b: Google auto gave % .. % (%)', r.service_from, r.service_to, r.basis; end if;
  select * into r from public.vendor_bills_service_periods(array['R2623-Z']);
  if r.service_from <> '2026-08-01' or r.basis <> 'reference' then
    raise exception 'FAIL S1c: Zoho reference gave % (%)', r.service_from, r.basis; end if;
  select * into r from public.vendor_bills_service_periods(array['R2623-O']);
  if r.service_from <> '2026-11-01' or r.service_to <> '2026-11-30' or r.basis <> 'bill_month' then
    raise exception 'FAIL S1d: other bill gave % .. % (%)', r.service_from, r.service_to, r.basis; end if;
  select count(*) into n from public.vendor_bills_service_periods(null);
  if n <> 0 then raise exception 'FAIL S1e: null ids gave % rows', n; end if;

  select (public.report_pnl('2026-10-01', '2026-10-31')).cogs into g_before;

  -- S2 + S3: the owner sets August on the LOCKED October bill — allowed (service columns only);
  -- no money column moves.
  update public.vendor_bills set service_from = '2026-08-01', service_to = '2026-08-31' where id = 'R2623-G';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL S3: setting the period on a locked-month bill was refused'; end if;
  select * into r from public.vendor_bills_service_periods(array['R2623-G']);
  if r.service_from <> '2026-08-01' or r.service_to <> '2026-08-31' or r.basis <> 'set' then
    raise exception 'FAIL S2a: after set gave % .. % (%)', r.service_from, r.service_to, r.basis; end if;
  select * into r from public.vendor_bills where id = 'R2623-G';
  if r.subtotal <> 100000 or r.total <> 118000 or r.paid_amount <> 50000 or r.status <> 'partial' or r.bill_date <> '2026-10-07' then
    raise exception 'FAIL S2b: a money column moved (% % % %)', r.subtotal, r.total, r.paid_amount, r.status; end if;
  select * into m from public.report_pnl_cogs_matched('2026-08-01', '2026-08-31');
  if m.cogs <> 100000 + 3000 then raise exception 'FAIL S2c: matched Aug cogs % (want 103000)', m.cogs; end if;

  -- S6: the GST / as-invoiced P&L did not move.
  select (public.report_pnl('2026-10-01', '2026-10-31')).cogs into g_after;
  if g_after is distinct from g_before then raise exception 'FAIL S6: report_pnl Oct cogs % -> %', g_before, g_after; end if;

  -- S1 'Use auto': both columns back to NULL → worked out again.
  update public.vendor_bills set service_from = null, service_to = null where id = 'R2623-G';
  select * into r from public.vendor_bills_service_periods(array['R2623-G']);
  if r.basis <> 'vendor_default' then raise exception 'FAIL S1f: after clearing basis %', r.basis; end if;

  -- S4: on the locked bill, any other column changed with (or without) the period is refused.
  begin
    update public.vendor_bills set service_from = '2026-08-01', service_to = '2026-08-31', subtotal = 1 where id = 'R2623-G';
    raise exception 'FAIL S4a: amount changed on a locked-month bill';
  exception when check_violation then
    get stacked diagnostics msg = message_text;
    if msg not like 'Books % tak lock hain%' then raise exception 'FAIL S4b: wrong refusal: %', msg; end if;
  end;
  begin
    update public.vendor_bills set notes = 'x' where id = 'R2623-G';
    raise exception 'FAIL S4c: notes changed on a locked-month bill';
  exception when check_violation then null; end;
  begin
    update public.vendor_bills set bill_date = '2026-11-07' where id = 'R2623-G';
    raise exception 'FAIL S4d: bill date moved out of the lock';
  exception when check_violation then null; end;

  -- A bad period is still refused by the R-2156 constraint (the form maps the name to words).
  begin
    update public.vendor_bills set service_from = '2026-09-01', service_to = '2026-08-31' where id = 'R2623-O';
    raise exception 'FAIL S8a: to before from accepted';
  exception when check_violation then
    get stacked diagnostics msg = constraint_name;
    if msg <> 'vendor_bills_service_period_check' then raise exception 'FAIL S8b: constraint %', msg; end if;
  end;
  begin
    update public.vendor_bills set service_from = '2026-09-01' where id = 'R2623-O';
    raise exception 'FAIL S8c: from without to accepted';
  exception when check_violation then null; end;

  -- S7: another company's bill: RLS hides it, nothing changes.
  update public.vendor_bills set service_from = '2026-08-01', service_to = '2026-08-31' where id = 'R2623-B';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL S7: changed another company''s bill'; end if;
end $$;

-- S5: a bill accepted from the network (amounts locked) still takes a period — the network lock
-- lists the columns it guards and the service columns are not among them.
reset role;
do $$
begin
  if position('service_from' in pg_get_functiondef('public.tg_network_bill_lock()'::regprocedure)) > 0 then
    raise exception 'FAIL S5: tg_network_bill_lock now guards service_from — the owner could not set the period on an accepted bill';
  end if;
  -- The books lock on vendor_bills frees exactly the two service columns.
  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'public.vendor_bills'::regclass and t.tgname = 'trg_books_lock'
                    and pg_get_triggerdef(t.oid) like '%tg_books_locked(''bill_date'', '''', ''service_from,service_to'')%') then
    raise exception 'FAIL S3b: trg_books_lock on vendor_bills is not (bill_date, '''', service_from,service_to)';
  end if;
end $$;

-- Unlocked company: the same edits go through (books lock not involved).
update public.tenants set books_locked_until = null where id = 'e2623000-0000-0000-0000-0000000000a1';
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'e2623000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);
do $$
declare n int;
begin
  update public.vendor_bills set notes = 'unlocked edit', service_from = '2026-07-01', service_to = '2026-09-30' where id = 'R2623-G';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL U1: unlocked edit refused'; end if;
end $$;

-- No company on the login → no rows (and no error leak of other bills).
reset role;
insert into auth.users (id, email) values ('e2623000-0000-0000-0000-0000000000c2', 'r2623-nobody@example.test');
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'e2623000-0000-0000-0000-0000000000c2', 'role', 'authenticated')::text, true);
do $$
declare n int;
begin
  select count(*) into n from public.vendor_bills_service_periods(array['R2623-G', 'R2623-B']);
  if n <> 0 then raise exception 'FAIL J: a login with no company saw % periods', n; end if;
end $$;

rollback;
