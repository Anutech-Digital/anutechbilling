-- Regression test: add_project_receipt_milestone (migration 20260925200000).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/project_receipt_milestone.test.sql
--
-- What it proves:
--   1. On a project paid in full, a second receipt gets its own milestone for exactly
--      its amount, and the project grows by the same amount, taxable + GST at its rate.
--   2. The existing milestone, payment and total paid are untouched.
--   3. A quote-built project (line items) gets a matching line, so the quote adds up.
--   4. The new milestone takes a payment + bank link like any other (record_project_payment).
--   5. Another company's user cannot add to this company's project; a zero amount is refused.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000a3', 'PRM TEST A', 'prm-a@example.in', '07'),
  ('bbbbbbbb-0000-0000-0000-0000000000b3', 'PRM TEST B', 'prm-b@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000a0a3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'prm-a-user@example.in'),
  ('bbbbbbbb-0000-0000-0000-00000000b0b3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'prm-b-user@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000000a0a3', 'aaaaaaaa-0000-0000-0000-0000000000a3', 'prm-a-user@example.in', 'owner'),
  ('bbbbbbbb-0000-0000-0000-00000000b0b3', 'bbbbbbbb-0000-0000-0000-0000000000b3', 'prm-b-user@example.in', 'owner');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance, opening_balance_date) values
  ('aaaaaaaa-0000-0000-0000-0000000ba003', 'aaaaaaaa-0000-0000-0000-0000000000a3', 'Test HDFC', 'HDFC', 0, '2026-04-01');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
  ('aaaaaaaa-0000-0000-0000-0000000b9001', 'aaaaaaaa-0000-0000-0000-0000000000a3', 'aaaaaaaa-0000-0000-0000-0000000ba003', '2026-08-07', 'TPT-PO 00038', 0, 540000, 'manual'),
  ('aaaaaaaa-0000-0000-0000-0000000b9002', 'aaaaaaaa-0000-0000-0000-0000000000a3', 'aaaaaaaa-0000-0000-0000-0000000ba003', '2026-07-08', 'TPT-ACCOUNTING SOFTWARE', 0, 540000, 'manual');

create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000a0a3', 'role', 'authenticated')::text, true);

-- A project paid in full by the first receipt.
insert into ids select 'p', public.create_project_sale(null::uuid, 'Demo Co'::text, 'Complete ERP'::text, null::text,
  457627, 18, false, '[{"label":"Full payment","total_amount":540000,"due_date":null}]'::jsonb);
insert into ids select 'm1', id from public.project_milestones where project_id = (select v from ids where k = 'p');
select public.record_project_payment((select v from ids where k = 'm1'), 540000, 'bank_transfer', null, '2026-08-07',
  'aaaaaaaa-0000-0000-0000-0000000b9001');

-- 5. zero refused
do $$ begin
  perform public.add_project_receipt_milestone((select v from ids where k = 'p'), 0, 'x');
  raise exception 'FAIL: zero amount accepted';
exception when others then
  if sqlerrm like 'FAIL:%' then raise; end if;
end $$;

-- 1. second receipt -> its own milestone, project grows
insert into ids select 'm2', public.add_project_receipt_milestone((select v from ids where k = 'p'), 540000, 'Phase 2');
do $$
declare p record; m record;
begin
  select * into p from public.project_sales where id = (select v from ids where k = 'p');
  if p.total_amount <> 1080000 then raise exception 'FAIL: total %', p.total_amount; end if;
  if p.taxable_amount <> 915254 or p.gst_amount <> 164746 then
    raise exception 'FAIL: taxable/gst % / %', p.taxable_amount, p.gst_amount; end if;
  if jsonb_array_length(p.line_items) <> 0 then raise exception 'FAIL: line item added to a project with none'; end if;
  select * into m from public.project_milestones where id = (select v from ids where k = 'm2');
  if m.total_amount <> 540000 or m.seq <> 2 or m.label <> 'Phase 2' or m.status <> 'pending' then
    raise exception 'FAIL: milestone % % % %', m.total_amount, m.seq, m.label, m.status; end if;
  -- 2. the first milestone is untouched
  select * into m from public.project_milestones where id = (select v from ids where k = 'm1');
  if m.status <> 'paid' or m.total_amount <> 540000 then raise exception 'FAIL: first milestone changed'; end if;
end $$;

-- 4. the new milestone takes a payment + bank link
select public.record_project_payment((select v from ids where k = 'm2'), 540000, 'bank_transfer', null, '2026-07-08',
  'aaaaaaaa-0000-0000-0000-0000000b9002');
do $$ begin
  if (select matched_to_type from public.bank_transactions where id = 'aaaaaaaa-0000-0000-0000-0000000b9002') is distinct from 'project' then
    raise exception 'FAIL: bank line not reconciled'; end if;
  if (select status from public.project_milestones where id = (select v from ids where k = 'm2')) <> 'paid' then
    raise exception 'FAIL: new milestone not paid'; end if;
  if (select sum(amount) from public.project_payments where project_id = (select v from ids where k = 'p')) <> 1080000 then
    raise exception 'FAIL: payments total'; end if;
end $$;

-- 3. a quote-built project gets a matching line item
update public.project_sales set line_items = '[{"name":"ERP","qty":1,"rate":457627,"amount":457627}]'::jsonb
 where id = (select v from ids where k = 'p');
select public.add_project_receipt_milestone((select v from ids where k = 'p'), 118000, 'Support');
do $$ declare li jsonb; begin
  select line_items into li from public.project_sales where id = (select v from ids where k = 'p');
  if jsonb_array_length(li) <> 2 or (li->1->>'amount')::int <> 100000 or li->1->>'name' <> 'Support' then
    raise exception 'FAIL: line item %', li; end if;
end $$;

-- 5. another company cannot add to it
select set_config('request.jwt.claims', json_build_object('sub', 'bbbbbbbb-0000-0000-0000-00000000b0b3', 'role', 'authenticated')::text, true);
do $$ begin
  perform public.add_project_receipt_milestone((select v from ids where k = 'p'), 1000, 'x');
  raise exception 'FAIL: cross-tenant add accepted';
exception when others then
  if sqlerrm like 'FAIL:%' then raise; end if;
end $$;

select 'project_receipt_milestone: all assertions passed' as result;
rollback;
