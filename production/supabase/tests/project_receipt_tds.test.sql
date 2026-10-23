-- Regression test: record_project_receipt_with_tds (migration 20260926100000).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/project_receipt_tds.test.sql
--
-- What it proves (the Demo Co case: ₹5,00,000 + GST, 10% TDS, ₹5,40,000 banked):
--   1. The ₹5,90,000 milestone is settled by ₹5,40,000 (bank) + ₹50,000 (TDS) and marked paid.
--   2. The invoice is ₹5,90,000 = ₹5,00,000 taxable + ₹90,000 GST, born paid.
--   3. The bank line is reconciled to the net project payment.
--   4. A tds_receivable row: 194J, 10%, base ₹5,00,000, TDS ₹50,000, net ₹5,40,000, linked to the
--      invoice, pending_cert, FY2627.
--   5. Zero TDS is refused; another company's user cannot book.

begin;

-- R-1643 / R-1803: issuing a Tax Invoice (also instalment + project invoices) needs the company's own GSTIN + address (supplier_invoice_problem).
-- Every company this test creates gets both unless the test sets them itself (an unregistered
-- one gets only the address). Rolled back with the test.
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


insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000a5', 'PRTDS TEST A', 'prtds-a@example.in', '07'),
  ('bbbbbbbb-0000-0000-0000-0000000000b5', 'PRTDS TEST B', 'prtds-b@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000a0a5', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'prtds-a-user@example.in'),
  ('bbbbbbbb-0000-0000-0000-00000000b0b5', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'prtds-b-user@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000000a0a5', 'aaaaaaaa-0000-0000-0000-0000000000a5', 'prtds-a-user@example.in', 'owner'),
  ('bbbbbbbb-0000-0000-0000-00000000b0b5', 'bbbbbbbb-0000-0000-0000-0000000000b5', 'prtds-b-user@example.in', 'owner');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance, opening_balance_date) values
  ('aaaaaaaa-0000-0000-0000-0000000ba005', 'aaaaaaaa-0000-0000-0000-0000000000a5', 'Test HDFC', 'HDFC', 0, '2026-04-01');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
  ('aaaaaaaa-0000-0000-0000-0000000b6001', 'aaaaaaaa-0000-0000-0000-0000000000a5', 'aaaaaaaa-0000-0000-0000-0000000ba005', '2026-07-08', 'TPT-ACCOUNTING SOFTWARE', 0, 540000, 'manual');

create temp table ids (k text primary key, v text);
grant all on ids to authenticated;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000a0a5', 'role', 'authenticated')::text, true);

insert into ids select 'p', public.create_project_quote(null::uuid, 'Demo Co'::text, 'Complete ERP'::text, null::text,
  '[{"name":"Complete ERP","qty":1,"rate":500000,"amount":500000}]'::jsonb, 18, false,
  '[{"label":"Full payment","total_amount":590000,"due_date":null}]'::jsonb)::text;
select public.accept_project_quote((select v from ids where k = 'p')::uuid);
insert into ids select 'm', id::text from public.project_milestones where project_id = (select v from ids where k = 'p')::uuid;

-- 5. zero TDS refused
do $$ begin
  perform public.record_project_receipt_with_tds((select v from ids where k = 'm')::uuid, 540000, 0, '194J', 10, 500000,
    '2026-07-08', 'aaaaaaaa-0000-0000-0000-0000000b6001', 'ref', true);
  raise exception 'FAIL: zero TDS accepted';
exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end $$;

-- 5. another company cannot book
select set_config('request.jwt.claims', json_build_object('sub', 'bbbbbbbb-0000-0000-0000-00000000b0b5', 'role', 'authenticated')::text, true);
do $$ begin
  perform public.record_project_receipt_with_tds((select v from ids where k = 'm')::uuid, 540000, 50000, '194J', 10, 500000,
    '2026-07-08', 'aaaaaaaa-0000-0000-0000-0000000b6001', 'ref', true);
  raise exception 'FAIL: cross-tenant booking accepted';
exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end $$;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000a0a5', 'role', 'authenticated')::text, true);

-- the booking
insert into ids select 'r', public.record_project_receipt_with_tds((select v from ids where k = 'm')::uuid, 540000, 50000, '194J', 10, 500000,
  '2026-07-08', 'aaaaaaaa-0000-0000-0000-0000000b6001', 'TPT-ACCOUNTING SOFTWARE', true)::text;

do $$
declare r jsonb := (select v from ids where k = 'r')::jsonb; inv record; t record; m record;
begin
  -- 1
  select * into m from public.project_milestones where id = (select v from ids where k = 'm')::uuid;
  if m.status <> 'paid' then raise exception 'FAIL: milestone %', m.status; end if;
  if (select sum(amount) from public.project_payments where milestone_id = m.id) <> 590000 then raise exception 'FAIL: settled total'; end if;
  if (select count(*) from public.project_payments where milestone_id = m.id and method = 'tds' and amount = 50000 and bank_txn_id is null) <> 1 then
    raise exception 'FAIL: TDS payment row'; end if;
  -- 2
  select * into inv from public.invoices where id = r->>'invoice_id';
  if inv.amount <> 590000 or inv.taxable_value <> 500000 or inv.tax_amount <> 90000 or inv.status::text <> 'paid' then
    raise exception 'FAIL: invoice % % % %', inv.amount, inv.taxable_value, inv.tax_amount, inv.status; end if;
  -- 3
  if (select matched_to_type || ':' || matched_to_id from public.bank_transactions where id = 'aaaaaaaa-0000-0000-0000-0000000b6001')
     is distinct from 'project:' || (r->>'net_payment') then raise exception 'FAIL: bank line not on the net payment'; end if;
  -- 4
  select * into t from public.tds_receivable where id = r->>'tds_receivable';
  if t.section <> '194J' or t.rate_pct <> 10 or t.gross_amount <> 500000 or t.tds_amount <> 50000 or t.net_paid <> 540000
     or t.invoice_id is distinct from inv.id or t.status <> 'pending_cert' or t.fiscal_year <> 'FY2627'
     or t.payment_received_date <> '2026-07-08' then
    raise exception 'FAIL: tds row % % % % % %', t.section, t.rate_pct, t.gross_amount, t.tds_amount, t.net_paid, t.fiscal_year; end if;
end $$;

select 'project_receipt_tds: all assertions passed' as result;
rollback;
