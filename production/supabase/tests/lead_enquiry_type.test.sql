-- Regression test: leads.enquiry_type + create_project_quote_from_lead (migration 20260926110000).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/lead_enquiry_type.test.sql
--
-- What it proves:
--   1. Existing / new leads default to 'subscription'; anything but subscription|project is refused.
--   2. A project lead gets a project QUOTATION (status quoted, line item, milestones) for its company,
--      linked on leads.project_id, and the lead moves New → Quote Sent with value = taxable.
--   3. An existing customer with the lead's company name is used, not duplicated.
--   4. A second quotation for the same lead is refused.
--   5. A lead with no company quotes the contact's name.
--   6. Another company's user cannot quote this lead.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000a6', 'LEADPRJ TEST A', 'lp-a@example.in', '07'),
  ('bbbbbbbb-0000-0000-0000-0000000000b6', 'LEADPRJ TEST B', 'lp-b@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000a0a6', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'lp-a-user@example.in'),
  ('bbbbbbbb-0000-0000-0000-00000000b0b6', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'lp-b-user@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000000a0a6', 'aaaaaaaa-0000-0000-0000-0000000000a6', 'lp-a-user@example.in', 'owner'),
  ('bbbbbbbb-0000-0000-0000-00000000b0b6', 'bbbbbbbb-0000-0000-0000-0000000000b6', 'lp-b-user@example.in', 'owner');
insert into public.customers (id, tenant_id, name) values
  ('aaaaaaaa-0000-0000-0000-0000000c0006', 'aaaaaaaa-0000-0000-0000-0000000000a6', 'Demo Co');
insert into public.leads (id, tenant_id, company, contact_name, stage) values
  ('L-TEST-SUB', 'aaaaaaaa-0000-0000-0000-0000000000a6', 'Acme', 'Rajesh', 'new');
insert into public.leads (id, tenant_id, company, contact_name, stage, enquiry_type, requirement, project_timeline, value) values
  ('L-TEST-PRJ', 'aaaaaaaa-0000-0000-0000-0000000000a6', 'demo co', 'Deepak', 'new', 'project', 'Complete ERP', '6 months', 500000),
  ('L-TEST-NOCO', 'aaaaaaaa-0000-0000-0000-0000000000a6', '', 'Priya Sharma', 'contact', 'project', 'School app', null, null);

-- 1
do $$ begin
  if (select enquiry_type from public.leads where id = 'L-TEST-SUB') <> 'subscription' then raise exception 'FAIL: default not subscription'; end if;
  begin
    update public.leads set enquiry_type = 'other' where id = 'L-TEST-SUB';
    raise exception 'FAIL: bad enquiry_type accepted';
  exception when check_violation then null; end;
end $$;

set local role authenticated;

-- 6. another company cannot quote it
select set_config('request.jwt.claims', json_build_object('sub', 'bbbbbbbb-0000-0000-0000-00000000b0b6', 'role', 'authenticated')::text, true);
do $$ begin
  perform public.create_project_quote_from_lead('L-TEST-PRJ', 'ERP', null, '[{"name":"ERP","qty":1,"rate":500000,"amount":500000}]'::jsonb, 18, false, '[]'::jsonb);
  raise exception 'FAIL: cross-tenant quote accepted';
exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end $$;

select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000a0a6', 'role', 'authenticated')::text, true);

-- 2 + 3
create temp table pid as select public.create_project_quote_from_lead('L-TEST-PRJ', 'Complete ERP', 'Complete ERP · 6 months',
  '[{"name":"Complete ERP","qty":1,"rate":500000,"amount":500000}]'::jsonb, 18, false,
  '[{"label":"Advance","total_amount":295000,"due_date":null},{"label":"On delivery","total_amount":295000,"due_date":null}]'::jsonb) as id;
do $$ declare p record; l record; begin
  select * into p from public.project_sales where id = (select id from pid);
  if p.status <> 'quoted' or p.taxable_amount <> 500000 or p.total_amount <> 590000 or jsonb_array_length(p.line_items) <> 1 then
    raise exception 'FAIL: project % % %', p.status, p.taxable_amount, p.total_amount; end if;
  if p.customer_id is distinct from 'aaaaaaaa-0000-0000-0000-0000000c0006' then raise exception 'FAIL: existing customer not used'; end if;
  if (select count(*) from public.project_milestones where project_id = p.id) <> 2 then raise exception 'FAIL: milestones'; end if;
  select * into l from public.leads where id = 'L-TEST-PRJ';
  if l.project_id is distinct from p.id or l.stage::text <> 'quote' or l.value <> 500000 then
    raise exception 'FAIL: lead % % %', l.project_id, l.stage, l.value; end if;
end $$;

-- 4. second quotation refused
do $$ begin
  perform public.create_project_quote_from_lead('L-TEST-PRJ', 'Again', null, '[{"name":"x","qty":1,"rate":1,"amount":1}]'::jsonb, 18, false, '[]'::jsonb);
  raise exception 'FAIL: second quotation accepted';
exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end $$;

-- 5. no company → the contact's name
do $$ declare v uuid; begin
  v := public.create_project_quote_from_lead('L-TEST-NOCO', 'School app', null, '[{"name":"School app","qty":1,"rate":100000,"amount":100000}]'::jsonb, 18, false, '[]'::jsonb);
  if (select customer_name from public.project_sales where id = v) <> 'Priya Sharma' then raise exception 'FAIL: contact name not used'; end if;
  if (select stage::text from public.leads where id = 'L-TEST-NOCO') <> 'quote' then raise exception 'FAIL: contacted lead not moved to quote'; end if;
end $$;

select 'lead_enquiry_type: all assertions passed' as result;
rollback;
