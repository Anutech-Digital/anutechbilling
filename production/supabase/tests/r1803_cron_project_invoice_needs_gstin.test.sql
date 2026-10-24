-- R-1803 (R-1643 follow-up): the renewal / instalment cron and project invoices refuse a Tax
-- Invoice when the company's own GSTIN or address is missing — before any number is taken.
-- Migration 20261023202157_r1803_cron_project_invoice_needs_supplier_gstin. Asserts the LIVE
-- functions. Self-asserting, ONE transaction, rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/r1803_cron_project_invoice_needs_gstin.test.sql
--
-- Before the migration is applied, prove it in one rollback (CLAUDE.md §17c): strip the
-- migrations' begin/commit and this file's begin/rollback and pipe
--   begin; <r1643 migration> <r1803 migration> <this test> rollback;
-- Expect "PASS r1803". Without the R-1803 migration the same test FAILs at step 1.
--
-- Companies: N = new (no GSTIN, no address) · G = GSTIN, no address · R = registered, complete.
-- Proves:
--   1. CRON — one pass over N, G and R the way /api/cron/billing does it (each instalment on
--      its own; a refusal is recorded and the loop carries on): N and G are refused with the
--      Settings → Company message (23514), R is issued INV-…-0001. N/G: instalment stays
--      unbilled, no invoice row, no number spent.
--   2. PROJECT MILESTONE — raise_project_milestone_invoice refused for N, issued for R.
--   3. DIRECT PROJECT INVOICE — create_project_direct_invoice (as N's owner) refused; no
--      project, quote or number left behind.
--   4. N adds its GSTIN + address → the next run issues its instalment as INV-…-0001 and its
--      milestone as INV-…-0002 (the refused calls burnt nothing).

begin;

select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e1803000-0000-4000-8000-00000000000a', 'r1803-owner-n@example.test');

insert into public.tenants (id, name, email, state_code, state, address, doc_code, gstin, gst_registration) values
  ('e1803000-0000-0000-0000-0000000000a1', 'R1803 N New',    'r1803n@example.in', '07', 'Delhi', null,              'R83N', null,              null),
  ('e1803000-0000-0000-0000-0000000000b1', 'R1803 G NoAddr', 'r1803g@example.in', '07', 'Delhi', ' ',               'R83G', '07AAACR1803G1Z1', 'registered'),
  ('e1803000-0000-0000-0000-0000000000f1', 'R1803 R Reg',    'r1803r@example.in', '07', 'Delhi', 'R street, Delhi', 'R83R', '07AAACR1803R1Z1', 'registered');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1803000-0000-4000-8000-00000000000a', 'e1803000-0000-0000-0000-0000000000a1', 'r1803-owner-n@example.in', 'R1803 Owner N', 'owner', true);

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e1803000-0000-4000-8000-0000000000ca', 'e1803000-0000-0000-0000-0000000000a1', 'R1803 Cust N', '07', 'India'),
  ('e1803000-0000-4000-8000-0000000000cb', 'e1803000-0000-0000-0000-0000000000b1', 'R1803 Cust G', '07', 'India'),
  ('e1803000-0000-4000-8000-0000000000cf', 'e1803000-0000-0000-0000-0000000000f1', 'R1803 Cust R', '07', 'India');

-- one quarterly subscription + one instalment due today per company
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle)
select ('e1803000-0000-4000-8000-00000000005' || k)::uuid, t::uuid, c::uuid, 'R1803 Cust ' || k,
       'Workspace Starter', 'google'::vendor, 2, 2000, 'quarterly'::billing_cycle
  from (values ('a', 'e1803000-0000-0000-0000-0000000000a1', 'e1803000-0000-4000-8000-0000000000ca'),
               ('b', 'e1803000-0000-0000-0000-0000000000b1', 'e1803000-0000-4000-8000-0000000000cb'),
               ('f', 'e1803000-0000-0000-0000-0000000000f1', 'e1803000-0000-4000-8000-0000000000cf')) v(k, t, c);

insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                          period_start, period_end, taxable_amount, tax_rate)
select ('e1803000-0000-4000-8000-0000000000b' || k)::uuid, t::uuid, ('e1803000-0000-4000-8000-00000000005' || k)::uuid,
       public.ist_today(), 1, public.ist_today(), public.ist_today(), public.ist_today() + 89, 2000, 18
  from (values ('a', 'e1803000-0000-0000-0000-0000000000a1'),
               ('b', 'e1803000-0000-0000-0000-0000000000b1'),
               ('f', 'e1803000-0000-0000-0000-0000000000f1')) v(k, t);

-- one active project with one milestone for N and for R
insert into public.project_sales (id, tenant_id, customer_id, customer_name, title, taxable_amount, gst_amount, total_amount, gst_rate, status) values
  ('e1803000-0000-4000-8000-0000000000e1', 'e1803000-0000-0000-0000-0000000000a1', 'e1803000-0000-4000-8000-0000000000ca', 'R1803 Cust N', 'R1803 N build', 100000, 18000, 118000, 18, 'active'),
  ('e1803000-0000-4000-8000-0000000000e3', 'e1803000-0000-0000-0000-0000000000f1', 'e1803000-0000-4000-8000-0000000000cf', 'R1803 Cust R', 'R1803 R build', 100000, 18000, 118000, 18, 'active');
insert into public.project_milestones (id, tenant_id, project_id, label, total_amount, seq) values
  ('e1803000-0000-4000-8000-0000000000d1', 'e1803000-0000-0000-0000-0000000000a1', 'e1803000-0000-4000-8000-0000000000e1', 'Phase 1', 118000, 1),
  ('e1803000-0000-4000-8000-0000000000d3', 'e1803000-0000-0000-0000-0000000000f1', 'e1803000-0000-4000-8000-0000000000e3', 'Phase 1', 118000, 1);

create temp table r1803_out (step text, who text, invoice_id text, sqlstate text, msg text);
grant all on r1803_out to authenticated;

-- ── 1. the billing cron's pass: every instalment on its own, a refusal does not stop it ──
do $$
declare b record; v_id text; v_state text; v_msg text;
begin
  for b in select id, right(id::text, 1) as k from public.subscription_billings
            where id in ('e1803000-0000-4000-8000-0000000000ba', 'e1803000-0000-4000-8000-0000000000bb',
                         'e1803000-0000-4000-8000-0000000000bf')
            order by id
  loop
    begin
      select r.invoice_id into v_id from public.raise_subscription_billing(b.id) r;
      insert into r1803_out values ('1', b.k, v_id, null, null);
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      insert into r1803_out values ('1', b.k, null, v_state, v_msg);
    end;
  end loop;
end $$;

-- ── 2. project milestone invoices ─────────────────────────────────────────────────────
do $$
declare m record; v_id text; v_state text; v_msg text;
begin
  for m in select id, case when tenant_id = 'e1803000-0000-0000-0000-0000000000a1' then 'a' else 'f' end as k
             from public.project_milestones
            where id in ('e1803000-0000-4000-8000-0000000000d1', 'e1803000-0000-4000-8000-0000000000d3')
  loop
    begin
      v_id := public.raise_project_milestone_invoice(m.id);
      insert into r1803_out values ('2', m.k, v_id, null, null);
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      insert into r1803_out values ('2', m.k, null, v_state, v_msg);
    end;
  end loop;
end $$;

-- ── 3. direct project invoice, as N's owner ──────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('role', 'authenticated', 'sub', 'e1803000-0000-4000-8000-00000000000a')::text, true);
do $$
declare v_state text; v_msg text; r record;
begin
  select * into r from public.create_project_direct_invoice(
    'e1803000-0000-4000-8000-0000000000ca', 'R1803 Cust N', 'R1803 direct', null,
    '[{"name":"Custom software","qty":1,"rate":50000,"amount":50000}]'::jsonb, 18, false);
  insert into r1803_out values ('3', 'a', r.invoice_id, null, null);
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  insert into r1803_out values ('3', 'a', null, v_state, v_msg);
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare r record;
begin
  -- refusals: N and G in the cron, N on the milestone, N on the direct project invoice
  for r in select * from (values ('1', 'a', 'GSTIN and address are not on record'),
                                 ('1', 'b', 'address is not on record'),
                                 ('2', 'a', 'GSTIN and address are not on record'),
                                 ('3', 'a', 'GSTIN and address are not on record')) v(step, who, want)
  loop
    if not exists (select 1 from r1803_out o where o.step = r.step and o.who = r.who
                     and o.sqlstate = '23514' and o.msg like '%' || r.want || '%'
                     and o.msg like '%Settings → Company%') then
      raise exception 'FAIL %/%: expected a 23514 refusal naming "%", got %', r.step, r.who, r.want,
        (select coalesce(o.invoice_id, o.sqlstate || ' ' || o.msg) from r1803_out o where o.step = r.step and o.who = r.who);
    end if;
  end loop;
  if not exists (select 1 from r1803_out where step = '1' and who = 'a' and msg like '%next billing run%') then
    raise exception 'FAIL 1: the cron refusal does not say the next billing run issues it'; end if;

  -- the cron carried on: R's instalment and R's milestone issued, numbers 0001 / 0002
  if (select invoice_id from r1803_out where step = '1' and who = 'f') !~ '^INV-R83R-[0-9]{2}-0001$' then
    raise exception 'FAIL 1: R instalment gave % (the batch did not carry on?)', (select coalesce(invoice_id, msg) from r1803_out where step = '1' and who = 'f'); end if;
  if (select invoice_id from r1803_out where step = '2' and who = 'f') !~ '^INV-R83R-[0-9]{2}-0002$' then
    raise exception 'FAIL 2: R milestone gave %', (select coalesce(invoice_id, msg) from r1803_out where step = '2' and who = 'f'); end if;

  -- nothing saved and no number spent for N / G
  if exists (select 1 from public.invoices where tenant_id in ('e1803000-0000-0000-0000-0000000000a1', 'e1803000-0000-0000-0000-0000000000b1')) then
    raise exception 'FAIL: an invoice row exists for N or G'; end if;
  if exists (select 1 from public.document_series where tenant_id in ('e1803000-0000-0000-0000-0000000000a1', 'e1803000-0000-0000-0000-0000000000b1') and last_number > 0) then
    raise exception 'FAIL: a number was spent for N or G'; end if;
  if exists (select 1 from public.subscription_billings where id in ('e1803000-0000-4000-8000-0000000000ba', 'e1803000-0000-4000-8000-0000000000bb') and invoice_id is not null) then
    raise exception 'FAIL 1: a refused instalment is marked billed'; end if;
  if (select invoice_id from public.project_milestones where id = 'e1803000-0000-4000-8000-0000000000d1') is not null then
    raise exception 'FAIL 2: the refused milestone is marked invoiced'; end if;
  if (select count(*) from public.project_sales where tenant_id = 'e1803000-0000-0000-0000-0000000000a1') <> 1
     or exists (select 1 from public.quotes where tenant_id = 'e1803000-0000-0000-0000-0000000000a1') then
    raise exception 'FAIL 3: create_project_direct_invoice left a project or quote behind'; end if;
  raise notice 'PASS 1-3: cron + project invoices refused without GSTIN/address, batch carried on, nothing saved';
end $$;

-- ── 4. N fills Settings → Company; the next run issues its documents from 0001 ─────────
update public.tenants set gstin = '07AAACR1803N1Z1', address = 'N street, Delhi'
 where id = 'e1803000-0000-0000-0000-0000000000a1';

do $$
declare v_inst text; v_ms text;
begin
  select r.invoice_id into v_inst from public.raise_subscription_billing('e1803000-0000-4000-8000-0000000000ba') r;
  v_ms := public.raise_project_milestone_invoice('e1803000-0000-4000-8000-0000000000d1');
  if v_inst !~ '^INV-R83N-[0-9]{2}-0001$' or v_ms !~ '^INV-R83N-[0-9]{2}-0002$' then
    raise exception 'FAIL 4: after the fix N got % and % (a refused call burnt a number?)', v_inst, v_ms; end if;
  raise notice 'PASS 4: after Settings → Company N issues % and %', v_inst, v_ms;
  raise notice 'PASS r1803';
end $$;

rollback;
