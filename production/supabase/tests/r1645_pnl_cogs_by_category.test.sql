-- Regression test: R-1645 — report_pnl.cogs_by_category splits the COGS bills per category, so
-- lib/accounting/pnl.ts can turn the licence estimate off only for the vendor that has a bill.
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r1645_pnl_cogs_by_category.test.sql
--
-- Tenant A, Oct 2026: a ₹500 Zoho bill, two Google bills (₹10,000 + ₹4,000), one COGS-Other
-- bill (₹700), a non-COGS bill (₹9,999 'Office') and a September Zoho bill (outside the
-- range). Tenant B has a Zoho bill too — it must not show up for A.
--   1. cogs_by_category = Google 14,000 (2 bills), Zoho 500 (1), COGS-Other 700 (1) — nothing
--      else; its parts add up to report_pnl.cogs (15,200) and cogs_count (4).
--   2. Every other output column is the old function's (cogs, cogs_count unchanged).
--   3. Mutation check: a fresh Zoho bill moves Zoho's entry (and only it) by its subtotal.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('d1645000-0000-0000-0000-0000000000a1', 'R1645 A', 'r1645-a@example.in', '07'),
  ('d1645000-0000-0000-0000-0000000000b1', 'R1645 B', 'r1645-b@example.in', '07');
insert into auth.users (id, email) values
  ('d1645000-0000-0000-0000-0000000000a2', 'r1645-user-a@example.test');
insert into public.users (id, tenant_id, email, role) values
  ('d1645000-0000-0000-0000-0000000000a2', 'd1645000-0000-0000-0000-0000000000a1', 'r1645-user-a@example.in', 'owner');

insert into public.vendor_bills (id, tenant_id, vendor_name, vendor_gstin, bill_date, category, subtotal, cgst, sgst, igst, total, status, document_type) values
  ('R1645-ZOHO',  'd1645000-0000-0000-0000-0000000000a1', 'Zoho Corporation', null, '2026-10-05', 'COGS-Zoho',      500,   0, 0, 0,   500, 'unpaid', 'tax_invoice'),
  ('R1645-G1',    'd1645000-0000-0000-0000-0000000000a1', 'Google',           null, '2026-10-06', 'COGS-Workspace', 10000, 0, 0, 0, 10000, 'unpaid', 'tax_invoice'),
  ('R1645-G2',    'd1645000-0000-0000-0000-0000000000a1', 'Google',           null, '2026-10-20', 'COGS-Workspace', 4000,  0, 0, 0,  4000, 'unpaid', 'tax_invoice'),
  ('R1645-OTH',   'd1645000-0000-0000-0000-0000000000a1', 'Some reseller',    null, '2026-10-07', 'COGS-Other',     700,   0, 0, 0,   700, 'unpaid', 'tax_invoice'),
  ('R1645-OFF',   'd1645000-0000-0000-0000-0000000000a1', 'Stationer',        null, '2026-10-08', 'Office',         9999,  0, 0, 0,  9999, 'unpaid', 'tax_invoice'),
  ('R1645-SEP',   'd1645000-0000-0000-0000-0000000000a1', 'Zoho Corporation', null, '2026-09-30', 'COGS-Zoho',      3333,  0, 0, 0,  3333, 'unpaid', 'tax_invoice'),
  ('R1645-B',     'd1645000-0000-0000-0000-0000000000b1', 'Zoho Corporation', null, '2026-10-05', 'COGS-Zoho',      77777, 0, 0, 0, 77777, 'unpaid', 'tax_invoice');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'd1645000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);

do $$
declare p record; g bigint; z bigint; o bigint; tot bigint; n int; cats int;
begin
  select * into p from public.report_pnl('2026-10-01', '2026-10-31');
  if p.cogs_by_category is null then raise exception 'FAIL 0: report_pnl has no cogs_by_category'; end if;
  select (c->>'subtotal')::bigint into g from jsonb_array_elements(p.cogs_by_category) c where c->>'category' = 'COGS-Workspace';
  select (c->>'subtotal')::bigint into z from jsonb_array_elements(p.cogs_by_category) c where c->>'category' = 'COGS-Zoho';
  select (c->>'subtotal')::bigint into o from jsonb_array_elements(p.cogs_by_category) c where c->>'category' = 'COGS-Other';
  if g is distinct from 14000 then raise exception 'FAIL 1a: Google % (want 14000): %', g, p.cogs_by_category; end if;
  if z is distinct from 500 then raise exception 'FAIL 1b: Zoho % (want 500 — no September bill, no tenant B bill): %', z, p.cogs_by_category; end if;
  if o is distinct from 700 then raise exception 'FAIL 1c: COGS-Other % (want 700)', o; end if;
  select count(*), sum((c->>'subtotal')::bigint), sum((c->>'n')::int) into cats, tot, n from jsonb_array_elements(p.cogs_by_category) c;
  if cats <> 3 then raise exception 'FAIL 1d: % categories (want 3 — Office is not COGS): %', cats, p.cogs_by_category; end if;
  if tot <> p.cogs or tot <> 15200 then raise exception 'FAIL 1e: parts % vs cogs % (want 15200)', tot, p.cogs; end if;
  if n <> p.cogs_count or n <> 4 then raise exception 'FAIL 1f: parts n % vs cogs_count % (want 4)', n, p.cogs_count; end if;
end $$;

-- 3: mutation — a new Zoho bill moves Zoho's entry by its subtotal, nothing else.
reset role;
insert into public.vendor_bills (id, tenant_id, vendor_name, vendor_gstin, bill_date, category, subtotal, cgst, sgst, igst, total, status, document_type) values
  ('R1645-ZOHO2', 'd1645000-0000-0000-0000-0000000000a1', 'Zoho Corporation', null, '2026-10-25', 'COGS-Zoho', 1250, 0, 0, 0, 1250, 'unpaid', 'tax_invoice');
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'd1645000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);
do $$
declare p record; g bigint; z bigint;
begin
  select * into p from public.report_pnl('2026-10-01', '2026-10-31');
  select (c->>'subtotal')::bigint into g from jsonb_array_elements(p.cogs_by_category) c where c->>'category' = 'COGS-Workspace';
  select (c->>'subtotal')::bigint into z from jsonb_array_elements(p.cogs_by_category) c where c->>'category' = 'COGS-Zoho';
  if z is distinct from 1750 then raise exception 'FAIL 3a: Zoho % after a ₹1,250 bill (want 1750)', z; end if;
  if g is distinct from 14000 then raise exception 'FAIL 3b: Google moved to % (want 14000)', g; end if;
  if p.cogs <> 16450 then raise exception 'FAIL 3c: cogs % (want 16450)', p.cogs; end if;
end $$;

reset role;
select 'R-1645 report_pnl cogs_by_category: all checks passed' as result;
rollback;
