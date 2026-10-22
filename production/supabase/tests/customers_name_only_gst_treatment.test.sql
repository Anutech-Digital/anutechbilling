-- R-1742 (22 Oct 2026): customers_name_only() returns the GST treatment.
-- Migration: 20261022043947_r1742_customers_name_only_treatment.sql.
--
-- Owner's path: a SALES user opens the quote builder and picks an SEZ unit in Delhi that
-- nobody manages yet — it reaches the picker only through customers_name_only(). The seller
-- is in Delhi too, so without the treatment the quote showed CGST + SGST while the invoice
-- charges IGST. Before the migration the column does not exist and this file FAILS.
--
--   1. sales sees the unclaimed SEZ customer by name WITH gst_treatment = sez_with_payment.
--   2. still no phone / email / GSTIN / address column (R-1004 unchanged).
--   3. still empty for the owner (full-read role), and anon cannot execute it.
--
-- SAFETY: synthetic tenant + identities, one transaction ending in ROLLBACK.

begin;

insert into auth.users (id, email) values
  ('c1742000-0000-4000-8000-0000000000a1', 'r1742-owner@example.test'),
  ('c1742000-0000-4000-8000-0000000000a5', 'r1742-sales@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c1742000-0000-4000-8000-0000000000f0', 'R1742 T', 'r1742@example.test', '07', 'R1742');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c1742000-0000-4000-8000-0000000000a1', 'c1742000-0000-4000-8000-0000000000f0', 'r1742-owner@example.test', 'Owner', 'owner', true),
  ('c1742000-0000-4000-8000-0000000000a5', 'c1742000-0000-4000-8000-0000000000f0', 'r1742-sales@example.test', 'Sales', 'sales', true);

-- Unclaimed SEZ unit in Delhi (GSTIN 07…), and an unclaimed regular customer.
insert into public.customers (id, tenant_id, name, gstin, state_code, country, contact_email, contact_phone, account_manager_id, gst_treatment) values
  ('c1742000-0000-4000-8000-0000000000c1', 'c1742000-0000-4000-8000-0000000000f0', 'R1742 SEZ Unit', '07AAACS1234E1ZP', '07', 'India', 'sez@example.test', '9999999999', null, 'sez_with_payment'),
  ('c1742000-0000-4000-8000-0000000000c2', 'c1742000-0000-4000-8000-0000000000f0', 'R1742 Regular', '07AABCU9603R1ZM', '07', 'India', 'reg@example.test', '9999999998', null, 'registered_regular');

set local role authenticated;

do $$
declare v_t text; v_n int; v_cols text;
begin
  -- 1. sales: the SEZ customer by name, with its treatment
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1742000-0000-4000-8000-0000000000a5', 'role', 'authenticated')::text, true);
  select n.gst_treatment into v_t from public.customers_name_only() n where n.id = 'c1742000-0000-4000-8000-0000000000c1';
  if v_t is distinct from 'sez_with_payment' then
    raise exception 'FAIL 1: sales name-only SEZ customer treatment = % (expected sez_with_payment)', v_t;
  end if;
  select n.gst_treatment into v_t from public.customers_name_only() n where n.id = 'c1742000-0000-4000-8000-0000000000c2';
  if v_t is distinct from 'registered_regular' then
    raise exception 'FAIL 1b: regular customer treatment = %', v_t;
  end if;
  raise notice 'PASS 1: sales sees the SEZ customer by name with gst_treatment sez_with_payment';

  -- 2. no contact / GSTIN columns
  select string_agg(p, ',') into v_cols
    from unnest((select proargnames from pg_proc where oid = to_regprocedure('public.customers_name_only()'))) p;
  if v_cols ~ '(phone|email|address|contact_|(^|,)gstin(,|$))' then
    raise exception 'FAIL 2: customers_name_only exposes %', v_cols;
  end if;
  raise notice 'PASS 2: columns %', v_cols;

  -- 3. owner: empty (reads the table in full)
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1742000-0000-4000-8000-0000000000a1', 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.customers_name_only() n where n.name like 'R1742 %';
  if v_n <> 0 then raise exception 'FAIL 3: owner gets % name-only rows', v_n; end if;
  if has_function_privilege('anon', 'public.customers_name_only()', 'execute') then
    raise exception 'FAIL 3b: anon can execute customers_name_only()';
  end if;
  if not has_function_privilege('authenticated', 'public.customers_name_only()', 'execute') then
    raise exception 'FAIL 3c: authenticated lost execute on customers_name_only()';
  end if;
  raise notice 'PASS 3: owner empty, anon refused, authenticated keeps execute';
end $$;

rollback;
