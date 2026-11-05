-- R-2499: FY 2025-26 Zoho invoices → app sales (import_zoho_fy_sales / remove_zoho_fy_sales_import).
-- Owner / accountant only; no company → refused; dry run writes nothing; void / draft skipped;
-- before the books start / inside the books lock refused; an opening invoice's number and another
-- company's customer refused; IGST vs CGST + SGST kept; rerun = already (no second sale); one batch
-- row + one activity_log row per batch; undo while untouched, refused once money touched it; a
-- direct delete is still refused; no child bill / network copy trigger on an imported sale.
-- The money comes from the server's scan (zoho_sale_import_scan) — the picks carry none.
-- Self-asserting; the whole file rolls back.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < this file

begin;

insert into auth.users (id, email) values
  ('b2499000-0000-0000-0000-0000000000a1', 'r2499-owner@example.test'),
  ('b2499000-0000-0000-0000-0000000000a2', 'r2499-acct@example.test'),
  ('b2499000-0000-0000-0000-0000000000a3', 'r2499-mgr@example.test'),
  ('b2499000-0000-0000-0000-0000000000a4', 'r2499-nocompany@example.test');

insert into public.tenants (id, name, email, state_code, gstin, doc_code) values
  ('b2499000-0000-0000-0000-0000000000f0', 'R2499 T', 'r2499@example.test', '07', '07AAACR2499A1Z5', 'R2499'),
  ('b2499000-0000-0000-0000-0000000000f1', 'R2499 O', 'r2499o@example.test', '07', null, 'R2499O');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('b2499000-0000-0000-0000-0000000000a1', 'b2499000-0000-0000-0000-0000000000f0', 'r2499-owner@example.test', 'Owner', 'owner', true),
  ('b2499000-0000-0000-0000-0000000000a2', 'b2499000-0000-0000-0000-0000000000f0', 'r2499-acct@example.test', 'Acct', 'accountant', true),
  ('b2499000-0000-0000-0000-0000000000a3', 'b2499000-0000-0000-0000-0000000000f0', 'r2499-mgr@example.test', 'Mgr', 'manager', true);

update public.tenants set books_start_date = '2025-05-01' where id = 'b2499000-0000-0000-0000-0000000000f0';

insert into public.customers (id, tenant_id, name, gstin, state_code, country) values
  ('b2499000-0000-0000-0000-0000000000c1', 'b2499000-0000-0000-0000-0000000000f0', 'R2499 KA Buyer', '29AAACR2499B1Z5', '29', 'India'),
  ('b2499000-0000-0000-0000-0000000000c2', 'b2499000-0000-0000-0000-0000000000f0', 'R2499 DL Buyer', '07AAACR2499C1Z5', '07', 'India'),
  ('b2499000-0000-0000-0000-0000000000c9', 'b2499000-0000-0000-0000-0000000000f1', 'R2499 Other Co Buyer', null, '07', 'India');

insert into public.items (id, tenant_id, name, vendor, hsn, msrp, wholesale) values
  ('R2499-ITEM', 'b2499000-0000-0000-0000-0000000000f0', 'R2499 Cloud Seat', 'google', '998315', 1000, 800);

-- An opening invoice already carrying a Zoho number (R-1739) — R-2504 converts it, never a copy.
insert into public.invoice_import_batches (id, tenant_id) values ('b2499000-0000-0000-0000-0000000000b1', 'b2499000-0000-0000-0000-0000000000f0');
select set_config('app.opening_invoice_import', 'on', true);
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, net_payable, paid_amount, status, invoice_date, due_date,
  taxable_value, tax_amount, tax_rate, line_items, document_kind, opening_balance, external_number, import_batch_id)
values ('INV/25-26/R2499-06', 'b2499000-0000-0000-0000-0000000000f0', 'b2499000-0000-0000-0000-0000000000c2', 'R2499 DL Buyer',
  5900, 5900, 0, 'overdue', '2025-07-01', '2025-07-15', 0, 0, 0, '[]', 'opening_invoice', 5900, 'INV/25-26/R2499-06', 'b2499000-0000-0000-0000-0000000000b1');
select set_config('app.opening_invoice_import', '', true);

-- What the server read from Zoho (whole rupees — normalise.ts did paise → rupees).
create function pg_temp.p(num text, d text, status text, taxable int, tax int, head text, pos text, rate numeric, problems jsonb default '[]')
returns jsonb language sql as $f$
  select jsonb_build_object('number', num, 'date', d, 'dueDate', d, 'status', status, 'customerName', 'Buyer', 'gstin', '',
    'posStateCode', pos, 'head', head, 'currency', 'INR', 'fxRate', null, 'taxable', taxable, 'tax', tax, 'amount', taxable + tax,
    'taxRate', rate, 'appGstTreatment', 'registered_regular', 'problems', problems,
    'lines', jsonb_build_array(jsonb_build_object('name', 'R2499 Cloud Seat', 'description', 'seats', 'hsn', '998315', 'qty', 10, 'rate', taxable / 10.0, 'taxable', taxable, 'zohoItemId', 'z-item')));
$f$;

insert into public.zoho_sale_import_scan (tenant_id, fy, zoho_invoice_id, number, invoice_date, zoho_status, payload, detailed_at) values
  ('b2499000-0000-0000-0000-0000000000f0', '2025-26', 'z1', 'INV/25-26/R2499-01', '2025-05-10', 'paid',     pg_temp.p('INV/25-26/R2499-01', '2025-05-10', 'paid', 100000, 18000, 'igst', '29', 18), now()),
  ('b2499000-0000-0000-0000-0000000000f0', '2025-26', 'z2', 'INV/25-26/R2499-02', '2025-06-01', 'overdue',  pg_temp.p('INV/25-26/R2499-02', '2025-06-01', 'overdue', 1000, 180, 'cgst_sgst', '07', 18), now()),
  ('b2499000-0000-0000-0000-0000000000f0', '2025-26', 'z3', 'INV/25-26/R2499-03', '2025-06-02', 'void',     pg_temp.p('INV/25-26/R2499-03', '2025-06-02', 'void', 500, 90, 'igst', '29', 18), now()),
  ('b2499000-0000-0000-0000-0000000000f0', '2025-26', 'z4', 'INV/25-26/R2499-04', '2025-06-03', 'draft',    pg_temp.p('INV/25-26/R2499-04', '2025-06-03', 'draft', 500, 90, 'igst', '29', 18), now()),
  ('b2499000-0000-0000-0000-0000000000f0', '2025-26', 'z5', 'INV/25-26/R2499-05', '2025-04-20', 'paid',     pg_temp.p('INV/25-26/R2499-05', '2025-04-20', 'paid', 500, 90, 'igst', '29', 18), now()),
  ('b2499000-0000-0000-0000-0000000000f0', '2025-26', 'z6', 'INV/25-26/R2499-06', '2025-07-01', 'overdue',  pg_temp.p('INV/25-26/R2499-06', '2025-07-01', 'overdue', 5000, 900, 'cgst_sgst', '07', 18), now()),
  ('b2499000-0000-0000-0000-0000000000f0', '2025-26', 'z7', 'INV/25-26/R2499-07', '2025-07-02', 'paid',     pg_temp.p('INV/25-26/R2499-07', '2025-07-02', 'paid', 500, 90, 'cgst_sgst', '07', 18), now()),
  ('b2499000-0000-0000-0000-0000000000f0', '2025-26', 'z8', 'INV/25-26/R2499-08', '2025-07-03', 'paid',     pg_temp.p('INV/25-26/R2499-08', '2025-07-03', 'paid', 500, 90, 'igst', '29', null,
     '["Lines carry different GST rates (5%, 18%) — one invoice here has one rate."]'), now()),
  ('b2499000-0000-0000-0000-0000000000f0', '2025-26', 'z9', 'INV/25-26/R2499-09', '2025-05-20', 'paid',     pg_temp.p('INV/25-26/R2499-09', '2025-05-20', 'paid', 2000, 360, 'igst', '29', 18), now()),
  -- the other company's scan row: never readable from T
  ('b2499000-0000-0000-0000-0000000000f1', '2025-26', 'zo', 'INV/25-26/R2499-OT', '2025-05-10', 'paid',     pg_temp.p('INV/25-26/R2499-OT', '2025-05-10', 'paid', 100, 18, 'igst', '29', 18), now());

do $$
begin
  if to_regprocedure('public.import_zoho_fy_sales(text,jsonb,boolean)') is null then
    raise exception 'FAIL 0: import_zoho_fy_sales(text,jsonb,boolean) does not exist';
  end if;
  if has_function_privilege('anon', 'public.import_zoho_fy_sales(text,jsonb,boolean)', 'execute')
     or has_function_privilege('anon', 'public.remove_zoho_fy_sales_import(uuid,text)', 'execute') then
    raise exception 'FAIL 0: anon can execute the import / remove';
  end if;
  if has_table_privilege('authenticated', 'public.zoho_sale_import_scan', 'select')
     or has_table_privilege('authenticated', 'public.zoho_sale_import_scan', 'insert') then
    raise exception 'FAIL 0: a login can read or write the server scan';
  end if;
  if (select count(*) from pg_trigger where tgrelid = 'public.invoices'::regclass
        and tgname in ('trg_mirror_invoice_to_child', 'trg_network_invoice_issue')
        and pg_get_triggerdef(oid) like '%zoho_invoice_id IS NULL%') <> 2 then
    raise exception 'FAIL 0: the child-bill / network-copy triggers do not skip an imported sale';
  end if;
end $$;

create function pg_temp.as_user(p uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$f$;

create function pg_temp.picks() returns jsonb language sql as $f$
  select jsonb_build_array(
    jsonb_build_object('zoho_invoice_id', 'z1', 'customer_id', 'b2499000-0000-0000-0000-0000000000c1', 'item_ids', jsonb_build_array('R2499-ITEM')),
    jsonb_build_object('zoho_invoice_id', 'z2', 'customer_id', 'b2499000-0000-0000-0000-0000000000c2', 'item_ids', jsonb_build_array('NOT-OURS')),
    jsonb_build_object('zoho_invoice_id', 'z3', 'customer_id', 'b2499000-0000-0000-0000-0000000000c1'),
    jsonb_build_object('zoho_invoice_id', 'z4', 'customer_id', 'b2499000-0000-0000-0000-0000000000c1'),
    jsonb_build_object('zoho_invoice_id', 'z5', 'customer_id', 'b2499000-0000-0000-0000-0000000000c1'),
    jsonb_build_object('zoho_invoice_id', 'z6', 'customer_id', 'b2499000-0000-0000-0000-0000000000c2'),
    jsonb_build_object('zoho_invoice_id', 'z7', 'customer_id', 'b2499000-0000-0000-0000-0000000000c9'),
    jsonb_build_object('zoho_invoice_id', 'z8', 'customer_id', 'b2499000-0000-0000-0000-0000000000c1'),
    jsonb_build_object('zoho_invoice_id', 'zo', 'customer_id', 'b2499000-0000-0000-0000-0000000000c1'));
$f$;

create function pg_temp.refused(p_who uuid, p_code text, p_msg text) returns boolean language plpgsql as $f$
begin
  perform pg_temp.as_user(p_who);
  perform public.import_zoho_fy_sales('2025-26', pg_temp.picks(), true);
  return false;
exception when others then
  if sqlstate <> p_code or sqlerrm not like p_msg then
    raise exception 'wrong refusal: % %', sqlstate, sqlerrm;
  end if;
  return true;
end $f$;

grant execute on function pg_temp.as_user(uuid), pg_temp.picks(), pg_temp.refused(uuid, text, text) to authenticated;

set local role authenticated;

do $$
declare
  t constant uuid := 'b2499000-0000-0000-0000-0000000000f0';
  r jsonb;
  reasons text;
  n int;
  inv record;
  v_batch uuid;
begin
  -- 1. manager refused, no company refused (owner / accountant only)
  if not pg_temp.refused('b2499000-0000-0000-0000-0000000000a3', '42501', '%owner or an accountant%') then raise exception 'FAIL 1: manager imported'; end if;
  if not pg_temp.refused('b2499000-0000-0000-0000-0000000000a4', '28000', '%sign-in%') then raise exception 'FAIL 1b: no-company login imported'; end if;

  -- 2. dry run (accountant): two would come in; the rest skipped with reasons; NOTHING written
  perform pg_temp.as_user('b2499000-0000-0000-0000-0000000000a2');
  r := public.import_zoho_fy_sales('2025-26', pg_temp.picks(), true);
  if (r->>'dry_run')::boolean is not true or (r->>'imported')::int <> 2 or r->>'batch_id' is not null then
    raise exception 'FAIL 2: dry run result %', r;
  end if;
  select string_agg((s->>'zoho_invoice_id') || '=' || (s->>'reason'), ' | ' order by s->>'zoho_invoice_id') into reasons
    from jsonb_array_elements(r->'skipped') s;
  if reasons not like '%z3=Void in Zoho%' then raise exception 'FAIL 2a: void not skipped: %', reasons; end if;
  if reasons not like '%z4=Draft in Zoho%' then raise exception 'FAIL 2b: draft not skipped: %', reasons; end if;
  if reasons not like '%z5=Dated 20 Apr 2025, before the books start (01 May 2025)%' then raise exception 'FAIL 2c: before books start not refused: %', reasons; end if;
  if reasons not like '%z6=INV/25-26/R2499-06 is already an opening invoice%R-2504%' then raise exception 'FAIL 2d: opening invoice clash not refused: %', reasons; end if;
  if reasons not like '%z7=No customer%' then raise exception 'FAIL 2e: other company''s customer accepted: %', reasons; end if;
  if reasons not like '%z8=Lines carry different GST rates%' then raise exception 'FAIL 2f: scan problem not refused: %', reasons; end if;
  if reasons not like '%zo=Not read from Zoho yet%' then raise exception 'FAIL 2g: other company''s scan row was read: %', reasons; end if;
  if (r->>'taxable')::int <> 101000 or (r->>'tax')::int <> 18180 then raise exception 'FAIL 2h: dry-run totals %', r; end if;
  if exists (select 1 from public.invoices where tenant_id = t and zoho_invoice_id is not null)
     or exists (select 1 from public.zoho_sale_import_batches where tenant_id = t)
     or exists (select 1 from public.activity_log where tenant_id = t and action like 'zoho_fy_sales.%') then
    raise exception 'FAIL 2i: the dry run wrote something';
  end if;

  -- 3. import (owner): Zoho's number, date and GST split, a sale by the existing predicate
  perform pg_temp.as_user('b2499000-0000-0000-0000-0000000000a1');
  r := public.import_zoho_fy_sales('2025-26', pg_temp.picks(), false);
  v_batch := (r->>'batch_id')::uuid;
  if (r->>'imported')::int <> 2 or v_batch is null or jsonb_array_length(r->'skipped') <> 7 then raise exception 'FAIL 3: import result %', r; end if;

  select * into inv from public.invoices where tenant_id = t and zoho_invoice_id = 'z1';
  if inv.id <> 'INV/25-26/R2499-01' or inv.external_number <> 'INV/25-26/R2499-01' or inv.invoice_date <> '2025-05-10'
     or inv.document_kind <> 'tax_invoice' or not public.invoice_is_sale(inv.document_kind)
     or inv.taxable_value <> 100000 or inv.tax_amount <> 18000 or inv.amount <> 118000 or inv.tax_rate <> 18
     or inv.inter_state is not true or inv.pos_state_code <> '29' or inv.paid_amount <> 0 or inv.quote_id is not null
     or inv.status <> 'overdue' or inv.sale_import_batch_id <> v_batch or inv.gst_treatment <> 'registered_regular' then
    raise exception 'FAIL 3a: IGST invoice stored wrong: %', to_jsonb(inv);
  end if;
  if inv.line_items->0->>'item_id' <> 'R2499-ITEM' or (inv.line_items->0->>'amount')::int <> 100000 or inv.line_items->0->>'hsn' <> '998315' then
    raise exception 'FAIL 3b: lines not mapped to the catalogue: %', inv.line_items;
  end if;
  select * into inv from public.invoices where tenant_id = t and zoho_invoice_id = 'z2';
  if inv.inter_state is not false or inv.tax_amount <> 180 or inv.taxable_value <> 1000 or inv.pos_state_code <> '07' then
    raise exception 'FAIL 3c: CGST + SGST invoice stored wrong: %', to_jsonb(inv);
  end if;
  if inv.line_items->0 ? 'item_id' then raise exception 'FAIL 3d: another company''s / unknown item id kept: %', inv.line_items; end if;

  select count(*) into n from public.zoho_sale_import_batches where id = v_batch and tenant_id = t and imported_count = 2 and skipped_count = 7 and taxable_total = 101000 and tax_total = 18180;
  if n <> 1 then raise exception 'FAIL 3e: batch row wrong'; end if;
  select count(*) into n from public.activity_log where tenant_id = t and action = 'zoho_fy_sales.imported' and entity_id = v_batch::text;
  if n <> 1 then raise exception 'FAIL 3f: % activity rows for the batch', n; end if;

  -- 4. rerun: same Zoho ids → already, never a second sale
  r := public.import_zoho_fy_sales('2025-26', pg_temp.picks(), false);
  if (r->>'imported')::int <> 0 or (r->>'already')::int <> 2 then raise exception 'FAIL 4: rerun %', r; end if;
  select count(*) into n from public.invoices where tenant_id = t and zoho_invoice_id is not null;
  if n <> 2 then raise exception 'FAIL 4b: % imported invoices after a rerun', n; end if;

  -- 5. a direct delete of an imported sale is still refused
  begin
    delete from public.invoices where tenant_id = t and zoho_invoice_id = 'z2';
  exception when others then null;   -- refused outright is fine too
  end;
  if not exists (select 1 from public.invoices where tenant_id = t and zoho_invoice_id = 'z2') then
    raise exception 'FAIL 5: imported sale deleted directly';
  end if;

  -- 6. undo the batch while untouched (accountant)
  perform pg_temp.as_user('b2499000-0000-0000-0000-0000000000a2');
  r := public.remove_zoho_fy_sales_import(v_batch, 'R2499 test undo');
  if (r->>'removed')::int <> 2 then raise exception 'FAIL 6: undo %', r; end if;
  if exists (select 1 from public.invoices where tenant_id = t and zoho_invoice_id is not null) then raise exception 'FAIL 6b: rows left after undo'; end if;
  if not exists (select 1 from public.zoho_sale_import_batches where id = v_batch and removed_at is not null and removed_rows = 2) then raise exception 'FAIL 6c: batch not marked removed'; end if;
  perform pg_temp.as_user('b2499000-0000-0000-0000-0000000000a1');   -- the owner reads the activity log
  if not exists (select 1 from public.activity_log where tenant_id = t and action = 'zoho_fy_sales.import_removed') then raise exception 'FAIL 6d: no activity row for the undo'; end if;
end $$;

-- 7. books lock: a sale dated inside the lock is refused; undo refused once money touched a batch
reset role;
update public.tenants set books_locked_until = '2025-05-15' where id = 'b2499000-0000-0000-0000-0000000000f0';
set local role authenticated;

do $$
declare
  t constant uuid := 'b2499000-0000-0000-0000-0000000000f0';
  r jsonb;
  v_batch uuid;
begin
  perform pg_temp.as_user('b2499000-0000-0000-0000-0000000000a1');
  r := public.import_zoho_fy_sales('2025-26', jsonb_build_array(
         jsonb_build_object('zoho_invoice_id', 'z1', 'customer_id', 'b2499000-0000-0000-0000-0000000000c1'),
         jsonb_build_object('zoho_invoice_id', 'z9', 'customer_id', 'b2499000-0000-0000-0000-0000000000c1')), false);
  if (r->>'imported')::int <> 1 or r->'skipped'->0->>'zoho_invoice_id' <> 'z1' or r->'skipped'->0->>'reason' not like '%inside the books lock%' then
    raise exception 'FAIL 7: books lock not respected: %', r;
  end if;
  v_batch := (r->>'batch_id')::uuid;
  perform set_config('r2499.batch', v_batch::text, true);
end $$;

reset role;
-- the delete guard itself (no RLS here): an imported sale is not deleted without its batch's undo
do $$
begin
  begin
    delete from public.invoices where zoho_invoice_id = 'z9' and tenant_id = 'b2499000-0000-0000-0000-0000000000f0';
    raise exception 'FAIL 7b: delete guard let an imported sale go';
  exception when restrict_violation then null;
  end;
end $$;
update public.invoices set paid_amount = 100 where zoho_invoice_id = 'z9' and tenant_id = 'b2499000-0000-0000-0000-0000000000f0';
set local role authenticated;

do $$
begin
  perform pg_temp.as_user('b2499000-0000-0000-0000-0000000000a1');
  begin
    perform public.remove_zoho_fy_sales_import(current_setting('r2499.batch')::uuid, 'R2499 test undo');
    raise exception 'FAIL 8: a touched batch was removed';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like '%cannot be removed%INV/25-26/R2499-09%' then raise exception 'FAIL 8b: wrong refusal %', sqlerrm; end if;
  end;
end $$;

select 'r2499_zoho_fy_sales_import: all checks passed' as result;

rollback;
