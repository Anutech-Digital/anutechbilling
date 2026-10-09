-- Regression test: R-487 invoice lines carry the quote's cost (migration 20261009180000).
-- Self-asserting; one transaction; ROLLBACK. Synthetic tenant only.
--
-- Proves:
--   1. quote → generate_invoice: the invoice gets the quote's lines; a known quote cost is
--      kept, an unknown one is filled from the catalogue, own-service SUP- stays 0, and a
--      line unknown everywhere stays NULL (not 0).
--   2. Owner preview lists an old NULL-lines invoice; apply fills it without moving amount,
--      taxable value or tax; a non-owner is refused; anon cannot execute either RPC.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('aaaaaaaa-0487-0000-0000-000000000001','R487 Co','r487@example.in','07','R487');
insert into public.customers (id, tenant_id, name, state_code)
  values ('cccccccc-0487-0000-0000-000000000001','aaaaaaaa-0487-0000-0000-000000000001','Cust 487','07');
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('aaaaaaaa-0487-0000-0000-000000000001','invoice', public.indian_fiscal_year(public.ist_today()), 'INV', 0);
insert into public.items (id, tenant_id, name, vendor, msrp, wholesale, prices, item_type)
  values ('GW-STD-r487','aaaaaaaa-0487-0000-0000-000000000001','Google Workspace Standard','google',736,620,
          '{"annual":{"msrp":736,"wholesale":620},"monthly":{"msrp":920,"wholesale":780}}','subscription');

-- Line 1: known cost 7440. Line 2: cost 0, catalogue match by name → 620×12 = 7440.
-- Line 3: own support plan, cost 0 is real. Line 4: nothing anywhere → NULL.
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
  values ('Q-R487-1','aaaaaaaa-0487-0000-0000-000000000001','cccccccc-0487-0000-0000-000000000001','Cust 487',
          35400, 30000, 18, 'accepted', 'awaiting',
          '[{"id":"a","name":"Google Workspace Standard","qty":1,"rate":8000,"cost":7440,"item_id":"GW-STD-r487","commitment":"annual_yearly"},
            {"id":"b","name":"Google Workspace · Standard (annual)","qty":1,"rate":8000,"cost":0,"commitment":"annual_yearly"},
            {"id":"c","name":"Support","qty":1,"rate":4000,"cost":0,"item_id":"SUP-STANDARD-YR-x","commitment":"annual_yearly"},
            {"id":"d","name":"Mystery hosting","qty":1,"rate":10000,"cost":0,"commitment":"annual_yearly"}]'::jsonb);

do $$
declare v_inv text; v_lines jsonb;
begin
  select invoice_id into v_inv from public.generate_invoice('Q-R487-1');
  select line_items into v_lines from public.invoices where id = v_inv;
  if jsonb_typeof(v_lines) is distinct from 'array' or jsonb_array_length(v_lines) is distinct from 4 then
    raise exception 'FAIL 1: invoice % has no copied lines: %', v_inv, v_lines;
  end if;
  if (v_lines->0->>'cost')::int is distinct from 7440 then raise exception 'FAIL 1a: known quote cost lost: %', v_lines->0; end if;
  if (v_lines->1->>'cost')::int is distinct from 7440 then raise exception 'FAIL 1b: catalogue cost not filled: %', v_lines->1; end if;
  if (v_lines->2->>'cost')::int is distinct from 0 then raise exception 'FAIL 1c: support cost changed: %', v_lines->2; end if;
  if jsonb_typeof(v_lines->3->'cost') is distinct from 'null' then raise exception 'FAIL 1d: unknown cost must be NULL, got %', v_lines->3; end if;
  raise notice 'PASS 1: quote → invoice keeps cost, fills catalogue, unknown stays NULL';
end $$;

-- ── 2. old invoice with NULL lines: preview + apply as owner ───────────────────
insert into auth.users (id, email) values
  ('bbbbbbbb-0487-0000-0000-000000000001','owner487@example.in'),
  ('bbbbbbbb-0487-0000-0000-000000000002','staff487@example.in');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('bbbbbbbb-0487-0000-0000-000000000001','aaaaaaaa-0487-0000-0000-000000000001','owner487@example.in','Owner','owner',true),
  ('bbbbbbbb-0487-0000-0000-000000000002','aaaaaaaa-0487-0000-0000-000000000001','staff487@example.in','Staff','sales',true);

insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
  values ('Q-R487-2','aaaaaaaa-0487-0000-0000-000000000001','cccccccc-0487-0000-0000-000000000001','Cust 487',
          9440, 8000, 18, 'accepted', 'invoiced',
          '[{"id":"a","name":"Google Workspace Standard","qty":1,"rate":8000,"cost":0,"commitment":"annual_yearly"}]'::jsonb);
-- An invoice issued before the fix: no lines. Insert with '[]'-less NULL by bypassing the
-- trigger's quote copy (quote_id set after insert, the once-set path).
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, taxable_value, tax_amount, tax_rate, inter_state)
  values ('INV-R487-OLD','aaaaaaaa-0487-0000-0000-000000000001','cccccccc-0487-0000-0000-000000000001','Cust 487',
          9440,'paid', public.ist_today(), 8000, 1440, 18, false);
update public.invoices set quote_id = 'Q-R487-2' where id = 'INV-R487-OLD';

-- non-owner refused
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"bbbbbbbb-0487-0000-0000-000000000002"}', true);
set local role authenticated;
do $$
declare v_err boolean := false;
begin
  begin perform * from public.invoice_cost_fill_preview(); exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 2a: staff could preview'; end if;
  v_err := false;
  begin perform public.invoice_cost_fill_apply(array['INV-R487-OLD']); exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 2a: staff could apply'; end if;
  raise notice 'PASS 2a: non-owner refused';
end $$;
reset role;

select set_config('request.jwt.claims', '{"role":"authenticated","sub":"bbbbbbbb-0487-0000-0000-000000000001"}', true);
set local role authenticated;
do $$
declare v_n int; v_cost int; v_src text; v_res jsonb; v_inv record; v_before record;
begin
  select count(*), max(cost_new), max(source) into v_n, v_cost, v_src
    from public.invoice_cost_fill_preview() where invoice_id = 'INV-R487-OLD';
  if v_n is distinct from 1 or v_cost is distinct from 7440 or v_src is distinct from 'catalog' then
    raise exception 'FAIL 2b: preview wrong: n=% cost=% src=%', v_n, v_cost, v_src;
  end if;
  -- preview wrote nothing
  if (select line_items from public.invoices where id = 'INV-R487-OLD') is not null then
    raise exception 'FAIL 2b: preview changed the invoice';
  end if;

  select amount, taxable_value, tax_amount into v_before from public.invoices where id = 'INV-R487-OLD';
  v_res := public.invoice_cost_fill_apply(array['INV-R487-OLD']);
  if (v_res->>'invoices_updated')::int is distinct from 1 then raise exception 'FAIL 2c: apply result %', v_res; end if;
  select amount, taxable_value, tax_amount, line_items into v_inv from public.invoices where id = 'INV-R487-OLD';
  if (v_inv.line_items->0->>'cost')::int is distinct from 7440 then raise exception 'FAIL 2c: cost not filled %', v_inv.line_items; end if;
  if v_inv.amount is distinct from v_before.amount or v_inv.taxable_value is distinct from v_before.taxable_value or v_inv.tax_amount is distinct from v_before.tax_amount then
    raise exception 'FAIL 2c: issued amounts moved';
  end if;
  raise notice 'PASS 2b/2c: owner preview then apply fills cost, amounts unchanged';
end $$;
reset role;

do $$
begin
  if has_function_privilege('anon', 'public.invoice_cost_fill_preview()', 'execute')
     or has_function_privilege('anon', 'public.invoice_cost_fill_apply(text[])', 'execute') then
    raise exception 'FAIL 3: anon can execute the R-487 RPCs';
  end if;
  raise notice 'PASS 3: anon has no execute';
end $$;

rollback;
