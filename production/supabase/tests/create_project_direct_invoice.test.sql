-- Regression test for create_project_direct_invoice (0160).
--
-- Proves a direct PROJECT invoice composes create → accept → raise atomically and is
-- GST-correct: the project ends 'active' and one pending tax invoice is raised for the
-- full amount.
--
-- ─── REWRITTEN 22 Aug 2026 ──────────────────────────────────────────────────
-- It borrowed a live customer (`53db44e6…`, since deleted, so the file no longer ran) AND
-- impersonated a real ANUTECH user:
--
--     perform set_config('request.jwt.claim.sub', '3caa0f07-44d1-42ee-91b3-2123e04853b1', true);
--
-- which is Pardeep. `create_project_direct_invoice` is not service-role aware — it needs
-- `current_tenant_id()` to resolve — and borrowing a real person's id was the shortest way
-- to get one. The consequence is that the whole test ran inside the live tenant, creating a
-- project and a GST invoice in ANUTECH's books, undone only by the closing exception. See
-- AGENTS.md L11.
--
-- It also asserted nothing: seven values were formatted into one message with the expected
-- figures in brackets beside them, for a human to compare by eye.
--
-- Now it creates its own auth user and its own tenant, so `current_tenant_id()` resolves to
-- a tenant that exists only inside this transaction.
--
-- ⚠️ THIS TEST FAILS TODAY, AND NOT BECAUSE OF THE TEST. The first run of the rewrite hit:
--
--     ERROR 42702: column reference "project_id" is ambiguous
--     QUERY: select id from public.project_milestones where project_id = v_pid order by seq limit 1
--     CONTEXT: PL/pgSQL function create_project_direct_invoice(...)
--
--    The function is `RETURNS TABLE(invoice_id text, project_id uuid)`, so `project_id` is a
--    PL/pgSQL variable inside the body and that line cannot be planned. **Every call has
--    always failed**, which is why `project_sales` and `project_milestones` both have 0 rows
--    while `create-project-quote-dialog.tsx:46` has been wired to it since 0160.
--
--    Fix written, not applied:
--    supabase/migrations/20260822200000_fix_project_direct_invoice_ambiguous_column.sql
--    Apply that and this file should go green.

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

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('c0de0005-0000-4000-8000-000000000001', 'PROJECT INVOICE TEST', 'proj@example.in', '07', 'PJT1');

/* Its own operator, rather than a real director's uuid. public.users.id references
   auth.users(id), so the auth row has to exist first — and it must be an id with no
   public.users row of its own, which is why a literal in a reserved-looking range beats
   `select … limit 1` (that mistake is what stopped hierarchy_peer_isolation from ever
   reaching an assertion). */
insert into auth.users (id, email)
  values ('c0de0005-0000-4000-8000-0000000000a1', 'project-tester@example.test');

insert into public.users (id, tenant_id, email, full_name, role, is_active)
  values ('c0de0005-0000-4000-8000-0000000000a1', 'c0de0005-0000-4000-8000-000000000001',
          'project-tester@example.test', 'Project Tester', 'owner', true);

insert into public.customers (id, tenant_id, name, country, state_code, state)
  values ('c0de0005-0000-4000-8000-0000000000c1', 'c0de0005-0000-4000-8000-000000000001',
          'Project Cust', 'India', '07', 'Delhi');

do $$
declare
  v_cust uuid := 'c0de0005-0000-4000-8000-0000000000c1';
  v_user uuid := 'c0de0005-0000-4000-8000-0000000000a1';
  v_li jsonb := '[{"name":"Custom software","qty":1,"rate":200000,"amount":200000}]'::jsonb;
  r record; inv record; v_proj text; n int;
begin
  /* The synthetic operator, so current_tenant_id() lands on the synthetic tenant. */
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);

  select * into r from public.create_project_direct_invoice(
    v_cust, 'TEST', 'TEST Project', null, v_li, 18, false);

  select taxable_value, tax_amount, tax_rate, amount, status, net_payable
    into inv from public.invoices where id = r.invoice_id;

  if inv.taxable_value <> 200000 then raise exception 'FAIL: taxable_value %, expected 200000', inv.taxable_value; end if;
  if inv.tax_rate     <> 18     then raise exception 'FAIL: tax_rate %, expected 18', inv.tax_rate; end if;
  if inv.tax_amount   <> 36000  then raise exception 'FAIL: tax_amount %, expected 36000 (18%% of 200000)', inv.tax_amount; end if;
  if inv.amount       <> 236000 then raise exception 'FAIL: amount %, expected 236000', inv.amount; end if;
  if inv.net_payable  <> 236000 then raise exception 'FAIL: net_payable %, expected 236000 (nothing paid yet)', inv.net_payable; end if;
  if inv.status       <> 'pending' then raise exception 'FAIL: status %, expected pending', inv.status; end if;

  /* "Atomically" is the claim in the header, so assert the other half actually happened —
     an invoice raised against a project still sitting in draft would be a half-committed
     sale that nobody is tracking. */
  select status into v_proj from public.project_sales where id = r.project_id;
  if v_proj <> 'active' then raise exception 'FAIL: project status %, expected active', v_proj; end if;

  /* Exactly one invoice. The function composes three steps; if it ever raises twice the
     tenant gets two GST documents for one sale and a gap-free series stops being gap-free.

     Counted on this transaction's own synthetic tenant, not on a quote id. This line read
     `where quote_id = r.quote_id` until 29 Aug 2026 and had never run: the function is
     `RETURNS TABLE(invoice_id text, project_id uuid)`, so `r` has no `quote_id` and the
     block died with 42703 before reaching any assertion. Every assertion above it was
     passing and nobody could see that the last one was not.

     The tenant is created a few lines up and lives only inside this transaction, so any
     invoice under it came from the call being tested — which is exactly what "raised twice"
     would show up in, and it does not depend on how project → quote → invoice is linked. */
  select count(*) into n from public.invoices where tenant_id = 'c0de0005-0000-4000-8000-000000000001';
  if n <> 1 then raise exception 'FAIL: % invoices raised for one project sale, expected 1', n; end if;

  raise notice 'PASS: project active, one pending invoice, 18%% GST on 200000';
end $$;

select 'PASS' as create_project_direct_invoice;

rollback;
