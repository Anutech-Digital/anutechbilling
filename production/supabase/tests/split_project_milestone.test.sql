-- Regression test: split_project_milestone (migration 20260926160000).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/split_project_milestone.test.sql
--
-- What it proves (the 26 Sep case: ₹5,90,000 paid against the ₹23,60,000 "Advance baaki"):
--   1. The split makes a ₹5,90,000 milestone just before a ₹17,70,000 remainder; total unchanged.
--   2. Paying + invoicing the new part gives a ₹5,90,000 invoice (₹5,00,000 + GST), paid —
--      not a ₹23,60,000 one.
--   3. A milestone with a payment or an invoice, or an amount >= the milestone, is refused.
--   4. Another company's user cannot split.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000a8', 'SPLIT TEST A', 'sp-a@example.in', '07'),
  ('bbbbbbbb-0000-0000-0000-0000000000b8', 'SPLIT TEST B', 'sp-b@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000a0a8', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sp-a-user@example.in'),
  ('bbbbbbbb-0000-0000-0000-00000000b0b8', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sp-b-user@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000000a0a8', 'aaaaaaaa-0000-0000-0000-0000000000a8', 'sp-a-user@example.in', 'owner'),
  ('bbbbbbbb-0000-0000-0000-00000000b0b8', 'bbbbbbbb-0000-0000-0000-0000000000b8', 'sp-b-user@example.in', 'owner');

create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000a0a8', 'role', 'authenticated')::text, true);

insert into ids select 'p', public.create_project_sale(null::uuid, 'Demo Co'::text, 'Billing'::text, null::text,
  4500000, 18, false,
  '[{"label":"Advance baaki","total_amount":2360000,"due_date":null},{"label":"On delivery","total_amount":2950000,"due_date":null}]'::jsonb);
insert into ids select 'adv', id from public.project_milestones where project_id = (select v from ids where k = 'p') and label = 'Advance baaki';

-- 3. amount >= milestone refused
do $$ begin
  perform public.split_project_milestone((select v from ids where k = 'adv'), 2360000, 'x');
  raise exception 'FAIL: full-size split accepted';
exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end $$;

-- 4. other company refused
select set_config('request.jwt.claims', json_build_object('sub', 'bbbbbbbb-0000-0000-0000-00000000b0b8', 'role', 'authenticated')::text, true);
do $$ begin
  perform public.split_project_milestone((select v from ids where k = 'adv'), 590000, 'x');
  raise exception 'FAIL: cross-tenant split accepted';
exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end $$;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000a0a8', 'role', 'authenticated')::text, true);

-- 1
insert into ids select 'part', public.split_project_milestone((select v from ids where k = 'adv'), 590000, 'Doosri kist (advance)');
do $$ declare r text; begin
  select string_agg(label || ':' || total_amount, ', ' order by seq) into r
    from public.project_milestones where project_id = (select v from ids where k = 'p');
  if r <> 'Doosri kist (advance):590000, Advance baaki:1770000, On delivery:2950000' then raise exception 'FAIL: schedule %', r; end if;
  if (select sum(total_amount) from public.project_milestones where project_id = (select v from ids where k = 'p')) <> 5310000 then
    raise exception 'FAIL: total changed'; end if;
end $$;

-- 2. pay + invoice the part
select public.record_project_payment((select v from ids where k = 'part'), 590000, 'bank_transfer', null, '2026-08-07', null);
select public.raise_project_milestone_invoice((select v from ids where k = 'part'));
do $$ declare inv record; begin
  select i.* into inv from public.invoices i join public.project_milestones m on m.invoice_id = i.id where m.id = (select v from ids where k = 'part');
  if inv.amount <> 590000 or inv.taxable_value <> 500000 or inv.status::text <> 'paid' then
    raise exception 'FAIL: invoice % % %', inv.amount, inv.taxable_value, inv.status; end if;
end $$;

-- 3. a milestone with a payment / invoice cannot be split
do $$ begin
  perform public.split_project_milestone((select v from ids where k = 'part'), 100000, 'x');
  raise exception 'FAIL: invoiced milestone split';
exception when others then if sqlerrm like 'FAIL:%' then raise; end if; end $$;

select 'split_project_milestone: all assertions passed' as result;
rollback;
