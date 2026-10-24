-- R-1819 (security audit 24 Oct 2026): the project functions check the caller's ROLE.
-- raise_project_milestone_invoice and create_project_direct_invoice issue a GST Tax Invoice,
-- and accept_project_quote turns a quotation into an invoiceable project — before R-1819 any
-- member of the company (sales, support, delivery) could call them (the audit's rollback probe:
-- a sales user issued ₹1,18,000 and ₹59,000 Tax Invoices). create_project_quote is for the
-- people who sell (not support / partner agents).
--
-- Self-asserting, ONE transaction, rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/r1819_project_money_roles.test.sql
--
-- Before the migration is applied, prove it in one rollback (CLAUDE.md §17c): strip the
-- migration's begin/commit and this file's begin/rollback and pipe
--   begin; <r1819 migration> <this test> rollback;
-- Expect "PASS r1819". Without the migration it FAILs at step 1 (sales issues the invoice).
--
-- Each function is checked for its OWN refusal message (create_project_direct_invoice calls
-- accept_project_quote, whose guard would also refuse — the message tells them apart).
--
-- Proves:
--   1. sales, sales_senior, support, delivery: no milestone invoice, no direct project invoice,
--      no accepting a quotation — 42501 each, nothing saved, no number spent.
--   2. create_project_quote: sales, sales_senior, delivery may; support may not (42501).
--   3. a login with no company: refused before anything (28000; accept keeps its R-714 42501).
--   4. owner / manager / accountant / billing still raise, create and accept.
--   5. trusted callers still work: service_role (the public accept link) accepts; a direct DB
--      session (scripts, the cron's SQL path) raises a milestone invoice.

begin;

select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email)
select ('e1819000-0000-4000-8000-0000000000' || k)::uuid, 'r1819-' || k || '@example.test'
  from unnest(array['01','02','03','04','05','06','07','08','09']) k;

insert into public.tenants (id, name, email, state_code, state, address, doc_code, gstin, gst_registration) values
  ('e1819000-0000-0000-0000-0000000000f1', 'R1819 Reg', 'r1819@example.in', '07', 'Delhi', 'R street, Delhi', 'R89R', '07AAACR1819R1Z1', 'registered');

-- 09 has an auth login but no users row → no company
insert into public.users (id, tenant_id, email, full_name, role, is_active)
select ('e1819000-0000-4000-8000-0000000000' || k)::uuid, 'e1819000-0000-0000-0000-0000000000f1',
       'r1819-' || k || '@example.in', 'R1819 ' || r, r::user_role, true
  from (values ('01', 'owner'), ('02', 'manager'), ('03', 'accountant'), ('04', 'billing'),
               ('05', 'sales'), ('06', 'sales_senior'), ('07', 'support'), ('08', 'delivery')) v(k, r);

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e1819000-0000-4000-8000-0000000000cf', 'e1819000-0000-0000-0000-0000000000f1', 'R1819 Cust', '07', 'India');

-- e1 / e2: active projects with one milestone each; q1 / q2: quotations
insert into public.project_sales (id, tenant_id, customer_id, customer_name, title, taxable_amount, gst_amount, total_amount, gst_rate, status) values
  ('e1819000-0000-4000-8000-0000000000e1', 'e1819000-0000-0000-0000-0000000000f1', 'e1819000-0000-4000-8000-0000000000cf', 'R1819 Cust', 'R1819 build 1', 100000, 18000, 118000, 18, 'active'),
  ('e1819000-0000-4000-8000-0000000000e2', 'e1819000-0000-0000-0000-0000000000f1', 'e1819000-0000-4000-8000-0000000000cf', 'R1819 Cust', 'R1819 build 2', 100000, 18000, 118000, 18, 'active'),
  ('e1819000-0000-4000-8000-0000000000a1', 'e1819000-0000-0000-0000-0000000000f1', 'e1819000-0000-4000-8000-0000000000cf', 'R1819 Cust', 'R1819 quote 1', 100000, 18000, 118000, 18, 'quoted'),
  ('e1819000-0000-4000-8000-0000000000a2', 'e1819000-0000-0000-0000-0000000000f1', 'e1819000-0000-4000-8000-0000000000cf', 'R1819 Cust', 'R1819 quote 2', 100000, 18000, 118000, 18, 'quoted');
insert into public.project_milestones (id, tenant_id, project_id, label, total_amount, seq) values
  ('e1819000-0000-4000-8000-0000000000d1', 'e1819000-0000-0000-0000-0000000000f1', 'e1819000-0000-4000-8000-0000000000e1', 'Phase 1', 118000, 1),
  ('e1819000-0000-4000-8000-0000000000d2', 'e1819000-0000-0000-0000-0000000000f1', 'e1819000-0000-4000-8000-0000000000e2', 'Phase 1', 118000, 1);

create temp table r1819_out (who text, fn text, result text, sqlstate text, msg text);
grant all on r1819_out to authenticated, service_role;

-- One call per (user, function), each in its own sub-transaction so a refusal does not stop the
-- next one — and a call that SUCCEEDS for a non-money role is recorded, then asserted below.
create function pg_temp.r1819_try(p_who text, p_fn text) returns void language plpgsql as $$
declare v text; v_state text; v_msg text; r record;
begin
  perform set_config('request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', 'e1819000-0000-4000-8000-0000000000' || p_who)::text, true);
  begin
    if p_fn = 'raise' then
      v := public.raise_project_milestone_invoice('e1819000-0000-4000-8000-0000000000d1');
    elsif p_fn = 'direct' then
      select * into r from public.create_project_direct_invoice(
        'e1819000-0000-4000-8000-0000000000cf', 'R1819 Cust', 'R1819 direct ' || p_who, null,
        '[{"name":"Custom software","qty":1,"rate":50000,"amount":50000}]'::jsonb, 18, false);
      v := r.invoice_id;
    elsif p_fn = 'accept' then
      v := public.accept_project_quote('e1819000-0000-4000-8000-0000000000a1');
    elsif p_fn = 'quote' then
      v := public.create_project_quote(
        'e1819000-0000-4000-8000-0000000000cf', 'R1819 Cust', 'R1819 quote by ' || p_who, null,
        '[{"name":"Custom software","qty":1,"rate":10000,"amount":10000}]'::jsonb, 18, false,
        '[{"label":"Full amount","total_amount":11800}]'::jsonb)::text;
    end if;
    insert into r1819_out values (p_who, p_fn, v, null, null);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    insert into r1819_out values (p_who, p_fn, null, v_state, v_msg);
  end;
end $$;
grant execute on function pg_temp.r1819_try(text, text) to authenticated;

set local role authenticated;

-- ── 1–3. non-money roles and the no-company login ────────────────────────────────────
select pg_temp.r1819_try(w, f)
  from unnest(array['05','06','07','08','09']) w,
       unnest(array['raise','direct','accept','quote']) f;

reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare r record; o record;
begin
  -- 1. the three invoice-making calls: refused with each function's OWN message
  for r in select * from (values
             ('raise',  'can raise a project invoice'),
             ('direct', 'can create a project invoice'),
             ('accept', 'can mark a project quotation accepted')) v(fn, want),
           unnest(array['05','06','07','08']) u(w)
  loop
    select * into o from r1819_out where who = r.w and fn = r.fn;
    if o.sqlstate is distinct from '42501' or o.msg not like '%' || r.want || '%' then
      raise exception 'FAIL 1: role % / % expected 42501 "%", got %', r.w, r.fn, r.want,
        coalesce('result ' || o.result, o.sqlstate || ' ' || o.msg);
    end if;
  end loop;

  -- 2. create_project_quote: the people who sell may, support may not
  for o in select * from r1819_out where fn = 'quote' and who in ('05','06','08') loop
    if o.result is null then raise exception 'FAIL 2: role % could not create a project quotation: % %', o.who, o.sqlstate, o.msg; end if;
  end loop;
  select * into o from r1819_out where fn = 'quote' and who = '07';
  if o.sqlstate is distinct from '42501' or o.msg not like '%cannot create a project quotation%' then
    raise exception 'FAIL 2: support expected 42501 on create_project_quote, got %', coalesce('result ' || o.result, o.sqlstate || ' ' || o.msg);
  end if;

  -- 3. no company: refused before anything
  for o in select * from r1819_out where who = '09' and fn in ('raise','direct','quote') loop
    if o.sqlstate is distinct from '28000' then
      raise exception 'FAIL 3: no-company login / % expected 28000, got %', o.fn, coalesce('result ' || o.result, o.sqlstate || ' ' || o.msg);
    end if;
  end loop;
  select * into o from r1819_out where who = '09' and fn = 'accept';
  if o.sqlstate is distinct from '42501' then
    raise exception 'FAIL 3: no-company login / accept expected 42501, got %', coalesce('result ' || o.result, o.sqlstate || ' ' || o.msg);
  end if;

  -- nothing was issued, accepted or numbered
  if exists (select 1 from public.invoices where tenant_id = 'e1819000-0000-0000-0000-0000000000f1') then
    raise exception 'FAIL 1: an invoice was issued by a non-money role'; end if;
  if exists (select 1 from public.document_series where tenant_id = 'e1819000-0000-0000-0000-0000000000f1' and doc_type = 'invoice' and last_number > 0) then
    raise exception 'FAIL 1: an invoice number was spent'; end if;
  if (select status from public.project_sales where id = 'e1819000-0000-4000-8000-0000000000a1') <> 'quoted' then
    raise exception 'FAIL 1: a non-money role accepted the quotation'; end if;
  if (select invoice_id from public.project_milestones where id = 'e1819000-0000-4000-8000-0000000000d1') is not null then
    raise exception 'FAIL 1: the milestone is marked invoiced'; end if;
  if exists (select 1 from public.project_sales where tenant_id = 'e1819000-0000-0000-0000-0000000000f1' and title like 'R1819 direct%') then
    raise exception 'FAIL 1: create_project_direct_invoice left a project behind'; end if;
  raise notice 'PASS 1-3: sales / sales_senior / support / delivery / no-company refused; sellers still quote';
end $$;

-- ── 4. the money roles still work ──────────────────────────────────────────────────────
set local role authenticated;
select pg_temp.r1819_try('04', 'raise');    -- billing
select pg_temp.r1819_try('03', 'direct');   -- accountant
select pg_temp.r1819_try('02', 'accept');   -- manager
select pg_temp.r1819_try('01', 'quote');    -- owner
reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare o record;
begin
  for o in select * from r1819_out where (who, fn) in (('04','raise'), ('03','direct'), ('02','accept'), ('01','quote')) loop
    if o.result is null then raise exception 'FAIL 4: % / % refused: % %', o.who, o.fn, o.sqlstate, o.msg; end if;
  end loop;
  if (select result from r1819_out where who = '04' and fn = 'raise') !~ '^INV-R89R-' then
    raise exception 'FAIL 4: billing milestone invoice gave %', (select result from r1819_out where who = '04' and fn = 'raise'); end if;
  if (select result from r1819_out where who = '03' and fn = 'direct') !~ '^INV-R89R-' then
    raise exception 'FAIL 4: accountant direct invoice gave %', (select result from r1819_out where who = '03' and fn = 'direct'); end if;
  if (select result from r1819_out where who = '02' and fn = 'accept') <> 'accepted' then
    raise exception 'FAIL 4: manager accept gave %', (select result from r1819_out where who = '02' and fn = 'accept'); end if;
  raise notice 'PASS 4: billing raises, accountant invoices, manager accepts, owner quotes';
end $$;

-- ── 5. trusted callers: service_role (public accept link) and a direct DB session ─────────
set local role service_role;
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
do $$
begin
  if public.accept_project_quote('e1819000-0000-4000-8000-0000000000a2') <> 'accepted' then
    raise exception 'FAIL 5: service_role could not accept the quotation'; end if;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare v text;
begin
  v := public.raise_project_milestone_invoice('e1819000-0000-4000-8000-0000000000d2');
  if v !~ '^INV-R89R-' then raise exception 'FAIL 5: direct DB session milestone invoice gave %', v; end if;
  raise notice 'PASS 5: service_role accepts, a direct DB session raises %', v;
  raise notice 'PASS r1819';
end $$;

rollback;
