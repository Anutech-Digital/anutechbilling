-- Regression test for create_direct_invoice (0158).
--
-- Proves a direct one-off invoice is GST-correct and creates no recurring artefacts:
--   DOMESTIC (India)  → 18% intra-state, status pending, quotes.is_one_off = true, 0 subscriptions.
--   EXPORT   (Kuwait) → zero-rated: rate 0, tax 0, net = subtotal.
--
-- ─── REWRITTEN 22 Aug 2026 ──────────────────────────────────────────────────
-- The old version borrowed a real customer of the live tenant:
--
--     v_cust uuid := '53db44e6-6e90-4fec-8871-8d2288393a2a';  -- Anutech customer
--     update customers set country = 'India' where id = v_cust;
--
-- so it UPDATED a real customer's country twice — India, then Kuwait — to steer the GST
-- branch, and relied on the closing exception to put it back. It also asserted nothing: the
-- body ended `raise exception 'TESTRESULT >> %'` with the observed numbers interpolated and
-- the expected ones in a header comment, for a human to compare by eye.
--
-- And it had stopped running at all: customer 53db44e6… was deleted, so it died on the first
-- `update` with zero rows and then on the FK. Six sibling files broke the same way. See
-- AGENTS.md L11 — a fixture owns its data; it never borrows the live tenant's.
--
-- Now: its own tenant, its own two customers (one domestic, one export), real assertions.

begin;

-- R-1643: issuing a Tax Invoice needs the company's own GSTIN + address (supplier_invoice_problem).
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
  values ('c0de0001-0000-4000-8000-000000000001', 'DIRECT INVOICE TEST', 'di@example.in', '07', 'DIT1');

/* Two customers instead of one mutated one — the old file toggled `country` on a single row,
   which is why it needed to write to a real customer at all. */
insert into public.customers (id, tenant_id, name, country, state_code, state)
  values ('c0de0001-0000-4000-8000-0000000000c1', 'c0de0001-0000-4000-8000-000000000001',
          'Domestic Cust', 'India', '07', 'Delhi');
insert into public.customers (id, tenant_id, name, country)
  values ('c0de0001-0000-4000-8000-0000000000c2', 'c0de0001-0000-4000-8000-000000000001',
          'Export Cust', 'Kuwait');

do $$
declare
  v_dom  uuid := 'c0de0001-0000-4000-8000-0000000000c1';
  v_exp  uuid := 'c0de0001-0000-4000-8000-0000000000c2';
  v_li jsonb := '[{"name":"Setup fee","qty":1,"rate":10000}]'::jsonb;
  r record; inv record; n int; v_oneoff boolean;
begin
  -- ── DOMESTIC: 18% intra-state, one-off, no subscription ──────────────────
  select * into r from public.create_direct_invoice(v_dom, v_li, 'test domestic');

  select taxable_value, tax_amount, tax_rate, net_payable, status
    into inv from public.invoices where id = r.invoice_id;

  if inv.taxable_value <> 10000 then raise exception 'FAIL domestic: taxable_value %, expected 10000', inv.taxable_value; end if;
  if inv.tax_rate     <> 18    then raise exception 'FAIL domestic: tax_rate %, expected 18', inv.tax_rate; end if;
  if inv.tax_amount   <> 1800  then raise exception 'FAIL domestic: tax_amount %, expected 1800 (18%% of 10000)', inv.tax_amount; end if;
  if inv.net_payable  <> 11800 then raise exception 'FAIL domestic: net_payable %, expected 11800', inv.net_payable; end if;
  if inv.status       <> 'pending' then raise exception 'FAIL domestic: status %, expected pending', inv.status; end if;

  /* The two "not recurring" halves. A direct invoice is a one-time sale, so the quote must
     carry the flag and nothing must appear in subscriptions — otherwise a setup fee shows up
     in MRR and in the renewal cron. */
  select is_one_off into v_oneoff from public.quotes where id = r.quote_id;
  if v_oneoff is not true then raise exception 'FAIL domestic: quote.is_one_off is %, expected true', v_oneoff; end if;
  select count(*) into n from public.subscriptions where quote_id = r.quote_id;
  if n <> 0 then raise exception 'FAIL domestic: % subscription(s) created by a direct invoice, expected 0', n; end if;

  -- ── EXPORT: zero-rated ───────────────────────────────────────────────────
  select * into r from public.create_direct_invoice(v_exp, v_li, 'test export');

  select taxable_value, tax_amount, tax_rate, net_payable
    into inv from public.invoices where id = r.invoice_id;

  if inv.taxable_value <> 10000 then raise exception 'FAIL export: taxable_value %, expected 10000', inv.taxable_value; end if;
  if inv.tax_rate     <> 0     then raise exception 'FAIL export: tax_rate %, expected 0 (zero-rated export)', inv.tax_rate; end if;
  if inv.tax_amount   <> 0     then raise exception 'FAIL export: tax_amount %, expected 0', inv.tax_amount; end if;
  /* net = subtotal is the assertion that matters: charging GST on an export is money taken
     from the customer that the reseller then owes to nobody. */
  if inv.net_payable  <> 10000 then raise exception 'FAIL export: net_payable %, expected 10000 (= subtotal, no GST)', inv.net_payable; end if;

  raise notice 'PASS: domestic 18%% split + one-off + 0 subs; export zero-rated';
end $$;

-- A NOTICE does not survive `supabase db query -f`, so say it with a row.
select 'PASS' as create_direct_invoice;

rollback;
