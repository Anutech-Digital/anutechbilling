-- R-401 (7 Oct 2026): a signed-in user can save a quote — every trigger helper is callable.
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK. LOCAL / CI only:
--
--   node scripts/test-sql.mjs --local authenticated_quote_write_cloudsql
--
-- WHY: R-400. 20261007160000 added trigger trg_quotes_one_billing_term, whose (invoker)
-- function calls public.quote_line_terms_mixed(jsonb) — with no GRANT. Local Supabase gives
-- every new function EXECUTE to authenticated and PUBLIC by default, so every test was green;
-- Cloud SQL (staging/live) does not, and every quote save there failed "permission denied for
-- function quote_line_terms_mixed". The other SQL tests run as the DB owner, so they could not
-- see it. This one writes a quote AS role authenticated with a real tenant user's JWT claims.
--
-- In CI (.github/workflows/sql-tests.yml) the local default privileges are revoked before the
-- 20261001+ migrations are applied (Cloud SQL emulation), so a function those migrations
-- create without an explicit grant is NOT executable by authenticated here either — exactly as
-- on staging. On a plain local DB the test still passes; it only bites under the emulation.
-- Repo-scan twin: src/lib/security/invoker-function-grants.test.ts.
--
-- Proves:
--   1. authenticated holds EXECUTE on the R-381 helper (the R-400 hole).
--   2. authenticated INSERT of a quote into its own tenant succeeds (all insert triggers run).
--   3. authenticated UPDATE of line_items / status succeeds (the update triggers run).
begin;

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('eeeeeeee-0000-0000-0000-000000000401', 'R401 TEST', 'r401@example.in', '06', 'R401');
insert into auth.users (id, instance_id, aud, role, email) values
  ('eeeeeeee-0000-0000-0000-00000000a401', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r401-owner@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('eeeeeeee-0000-0000-0000-00000000a401', 'eeeeeeee-0000-0000-0000-000000000401', 'r401-owner@example.in', 'owner');

do $$
begin
  if not has_function_privilege('authenticated', 'public.quote_line_terms_mixed(jsonb)', 'EXECUTE') then
    raise exception 'FAIL 1: authenticated cannot EXECUTE quote_line_terms_mixed(jsonb) — every quote save 403s on Cloud SQL (R-400)';
  end if;
  raise notice 'PASS 1: authenticated may execute the R-381 helper';
end $$;

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'eeeeeeee-0000-0000-0000-00000000a401', 'role', 'authenticated')::text, true);

do $$
begin
  -- 2
  insert into public.quotes (id, tenant_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
    values ('Q-R401-AUTH', 'eeeeeeee-0000-0000-0000-000000000401', 'R401 Co', 1180, 1000, 18, 'draft', 'none',
            '[{"name":"Workspace","qty":1,"rate":1000,"commitment":"annual_yearly"}]'::jsonb);
  if not exists (select 1 from public.quotes where id = 'Q-R401-AUTH') then
    raise exception 'FAIL 2: the inserted quote is not visible to its own tenant';
  end if;
  raise notice 'PASS 2: authenticated quote insert';

  -- 3
  update public.quotes
     set line_items = '[{"name":"Workspace","qty":2,"rate":1000,"commitment":"annual_yearly"}]'::jsonb,
         amount = 2360, subtotal = 2000
   where id = 'Q-R401-AUTH';
  update public.quotes set status = 'sent' where id = 'Q-R401-AUTH';
  if (select (line_items->0->>'qty')::int from public.quotes where id = 'Q-R401-AUTH') <> 2 then
    raise exception 'FAIL 3: the line_items update did not apply';
  end if;
  raise notice 'PASS 3: authenticated quote update';
end $$;

reset role;
rollback;
