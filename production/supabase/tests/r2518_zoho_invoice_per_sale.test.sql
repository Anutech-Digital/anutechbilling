-- R-2518 (6 Nov 2026, G-RECON): one bank receipt that paid TWO Zoho invoices books ONE app invoice per
-- Zoho invoice, each with its own lines, GST and Zoho number; the read-only facts behind "paid but
-- paid_amount 0"; and the owner-only repair (+ undo) of a merged bank sale.
-- Migration 20261106043700_r2518_zoho_invoice_per_sale. Self-asserting, ONE transaction, rolled back.
-- Run on a local/test DB only.
--
--   A. Staging's case: UPI ₹6,294 = Zoho INV/26-27/0516 ₹3,243 (15 × 180 + 1 × 48) + INV/26-27/0517
--      ₹3,051 (14 × 180 + 1 × 66). reconcile_bank_credit_split with p_sale = an ARRAY of two sales →
--      two quotes, two invoices (2 lines each, taxable 2,748 / 2,586, total 3,243 / 3,051), each
--      carrying its Zoho number; both receipts on the line.
--   B. Refused, nothing saved: a Zoho number twice in one call; a Zoho number already in the app.
--   C. One sale as an object still books exactly as before.
--   D. The R-2360 wrapper refuses one Zoho number for several sales.
--   E. paid_amount 0 on a bank-receipt sale is by design: the money is in adjusted_advances
--      (received before the invoice) and net_payable is 0.
--   F. Repair: a merged sale (all four lines on one invoice) → dry run changes nothing; an accountant
--      is refused; the owner's run credit-notes the merged invoice and books two invoices with their
--      Zoho numbers on the same line; its subscriptions stay; a backup row exists.
--   G. Undo: the two per-Zoho invoices are credit-noted and the four lines are ONE sale again.

begin;

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

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000251801','R2518 Zoho Co','r2518@example.in','07','R251');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000251801','owner2518@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000251802','acct2518@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000251801','dddddddd-0000-0000-0000-000000251801','owner2518@example.in','Owner 2518','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000251802','dddddddd-0000-0000-0000-000000251801','acct2518@example.in','Acct 2518','accountant', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000251801','dddddddd-0000-0000-0000-000000251801','Kite Buyer','07','kitebuyer.in');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000251801','dddddddd-0000-0000-0000-000000251801','HDFC Current','HDFC');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000251801','dddddddd-0000-0000-0000-000000251801','bbbbbbbb-0000-0000-0000-000000251801','2026-06-29','UPI KITE BUYER A',0,6294,'UTR2518A','manual'),
  ('11111111-0000-0000-0000-000000251802','dddddddd-0000-0000-0000-000000251801','bbbbbbbb-0000-0000-0000-000000251801','2026-06-30','UPI KITE BUYER B',0,6294,'UTR2518B','manual'),
  ('11111111-0000-0000-0000-000000251803','dddddddd-0000-0000-0000-000000251801','bbbbbbbb-0000-0000-0000-000000251801','2026-07-01','UPI KITE BUYER C',0,1180,'UTR2518C','manual'),
  ('11111111-0000-0000-0000-000000251804','dddddddd-0000-0000-0000-000000251801','bbbbbbbb-0000-0000-0000-000000251801',greatest(public.ist_today() - 3, make_date(extract(year from public.ist_today())::int - case when extract(month from public.ist_today()) >= 4 then 0 else 1 end, 4, 1)),'UPI KITE BUYER D',0,6294,'UTR2518D','manual'),
  ('11111111-0000-0000-0000-000000251805','dddddddd-0000-0000-0000-000000251801','bbbbbbbb-0000-0000-0000-000000251801',public.ist_today(),'UPI KITE BUYER F',0,6294,'UTR2518F','manual');

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000251801","role":"authenticated"}', true);

create temp table r2518_ids (k text primary key, v text);

do $$
declare
  c_t   constant uuid := 'dddddddd-0000-0000-0000-000000251801';
  c_c   constant uuid := 'cccccccc-0000-0000-0000-000000251801';
  c_inv1 constant jsonb := '[{"item_id":null,"name":"Workspace seat","qty":15,"rate":180,"cost":0,"commitment":"one_time"},
                             {"item_id":null,"name":"Extra storage","qty":1,"rate":48,"cost":0,"commitment":"one_time"}]';
  c_inv2 constant jsonb := '[{"item_id":null,"name":"Workspace seat","qty":14,"rate":180,"cost":0,"commitment":"one_time"},
                             {"item_id":null,"name":"Extra storage","qty":1,"rate":66,"cost":0,"commitment":"one_time"}]';
  r jsonb; p jsonb; ok boolean; v_msg text; n int; v_i1 text; v_i2 text; v_inv record;
begin
  -- A
  r := public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000251801', c_c, '[]'::jsonb,
         jsonb_build_array(
           jsonb_build_object('lines', c_inv1, 'billing_cycle', 'yearly', 'create_subscription', false, 'amount', 3243, 'external_number', 'INV/26-27/0516'),
           jsonb_build_object('lines', c_inv2, 'billing_cycle', 'yearly', 'create_subscription', false, 'amount', 3051, 'external_number', 'INV/26-27/0517')),
         null);
  select count(*) into n from jsonb_array_elements(r->'parts') x where (x->>'new_quote')::boolean;
  if n <> 2 then raise exception 'FAIL A: % new sales booked (want 2) — %', n, r; end if;
  v_i1 := r->'parts'->0->>'invoice_id';
  v_i2 := r->'parts'->1->>'invoice_id';
  if v_i1 is null or v_i2 is null or v_i1 = v_i2 then raise exception 'FAIL A: not two invoices (% / %)', v_i1, v_i2; end if;
  select * into v_inv from public.invoices where id = v_i1;
  if v_inv.external_number is distinct from 'INV/26-27/0516' or v_inv.amount <> 3243 or v_inv.taxable_value <> 2748 then
    raise exception 'FAIL A: first invoice % = % / ₹% / taxable %', v_i1, v_inv.external_number, v_inv.amount, v_inv.taxable_value;
  end if;
  select * into v_inv from public.invoices where id = v_i2;
  if v_inv.external_number is distinct from 'INV/26-27/0517' or v_inv.amount <> 3051 or v_inv.taxable_value <> 2586 then
    raise exception 'FAIL A: second invoice % = % / ₹% / taxable %', v_i2, v_inv.external_number, v_inv.amount, v_inv.taxable_value;
  end if;
  if (select jsonb_array_length(q.line_items) from public.quotes q join public.invoices i on i.quote_id = q.id where i.id = v_i1) <> 2
     or (select jsonb_array_length(q.line_items) from public.quotes q join public.invoices i on i.quote_id = q.id where i.id = v_i2) <> 2 then
    raise exception 'FAIL A: each sale should carry its own 2 lines';
  end if;
  if (select count(*) from public.payments where bank_txn_id = '11111111-0000-0000-0000-000000251801') <> 2
     or (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000251801') is distinct from 'payment' then
    raise exception 'FAIL A: the line should carry both receipts and be reconciled';
  end if;
  if (r->'parts'->0->>'external_number_saved')::boolean is not true then raise exception 'FAIL A: result does not say the number was saved (%)', r; end if;
  raise notice 'A PASS: % (INV/26-27/0516) + % (INV/26-27/0517) on one line', v_i1, v_i2;
  insert into r2518_ids values ('a1', v_i1), ('a2', v_i2);

  -- B
  ok := false;
  begin
    perform public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000251802', c_c, '[]'::jsonb,
      jsonb_build_array(
        jsonb_build_object('lines', c_inv1, 'billing_cycle', 'yearly', 'create_subscription', false, 'amount', 3243, 'external_number', 'INV/26-27/0600'),
        jsonb_build_object('lines', c_inv2, 'billing_cycle', 'yearly', 'create_subscription', false, 'amount', 3051, 'external_number', ' inv/26-27/0600 ')),
      null);
  exception when sqlstate '22023' then
    get stacked diagnostics v_msg = message_text; ok := v_msg like 'Zoho invoice % is on two of these new sales%';
  end;
  if not ok then raise exception 'FAIL B: the same Zoho number on two sales was not refused (%)', v_msg; end if;
  ok := false;
  begin
    perform public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000251802', c_c, '[]'::jsonb,
      jsonb_build_array(
        jsonb_build_object('lines', c_inv1, 'billing_cycle', 'yearly', 'create_subscription', false, 'amount', 3243, 'external_number', 'INV/26-27/0601'),
        jsonb_build_object('lines', c_inv2, 'billing_cycle', 'yearly', 'create_subscription', false, 'amount', 3051, 'external_number', 'inv/26-27/0516')),
      null);
  exception when unique_violation then
    get stacked diagnostics v_msg = message_text; ok := v_msg = 'Zoho invoice inv/26-27/0516 is already in the app as ' || v_i1 || '. Nothing was saved.';
  end;
  if not ok then raise exception 'FAIL B: a Zoho number already in the app was not refused (%)', v_msg; end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000251802') is not null
     or (select count(*) from public.quotes where tenant_id = c_t) <> 2 then
    raise exception 'FAIL B: a refused call left something behind';
  end if;
  raise notice 'B PASS: duplicate / held Zoho numbers refused, nothing saved';

  -- C
  r := public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000251803', c_c, '[]'::jsonb,
         '{"lines":[{"item_id":null,"name":"Setup","qty":1,"rate":1000,"cost":0,"commitment":"one_time"}],"billing_cycle":"yearly","create_subscription":false,"amount":1180}'::jsonb,
         null);
  select x into p from jsonb_array_elements(r->'parts') x where (x->>'new_quote')::boolean;
  if p is null or (select amount from public.invoices where id = p->>'invoice_id') <> 1180
     or (select external_number from public.invoices where id = p->>'invoice_id') is not null or p ? 'external_number' then
    raise exception 'FAIL C: one sale as an object changed (%)', r;
  end if;
  raise notice 'C PASS: one sale as an object unchanged';

  -- D
  ok := false;
  begin
    perform public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000251802', c_c, '[]'::jsonb,
      jsonb_build_array(
        jsonb_build_object('lines', c_inv1, 'billing_cycle', 'yearly', 'create_subscription', false, 'amount', 3243),
        jsonb_build_object('lines', c_inv2, 'billing_cycle', 'yearly', 'create_subscription', false, 'amount', 3051)),
      null, 'INV/26-27/0700');
  exception when sqlstate '22023' then ok := true;
  end;
  if not ok then raise exception 'FAIL D: one Zoho number for two sales was accepted'; end if;
  raise notice 'D PASS: the wrapper refuses one number for several sales';

  -- E (by design)
  select * into v_inv from public.invoices where id = v_i1;
  if v_inv.status <> 'paid' or coalesce(v_inv.paid_amount, 0) <> 0 or coalesce(v_inv.net_payable, -1) <> 0
     or (select coalesce(sum((a->>'amount')::numeric), 0) from jsonb_array_elements(v_inv.adjusted_advances) a) <> v_inv.amount then
    raise exception 'FAIL E: bank-sale invoice money facts changed: status %, paid_amount %, net_payable %, advances %',
      v_inv.status, v_inv.paid_amount, v_inv.net_payable, v_inv.adjusted_advances;
  end if;
  raise notice 'E PASS: paid, paid_amount 0, net_payable 0, adjusted_advances = amount (money received before the invoice)';
end $$;

-- F: a merged sale (the old way) → repair
do $$
declare
  c_c   constant uuid := 'cccccccc-0000-0000-0000-000000251801';
  c_all constant jsonb := '[{"id":"l1","item_id":null,"name":"Workspace seat","qty":15,"rate":180,"cost":0,"commitment":"annual_yearly","domain":"kitebuyer.in"},
                            {"id":"l2","item_id":null,"name":"Extra storage","qty":1,"rate":48,"cost":0,"commitment":"one_time"},
                            {"id":"l3","item_id":null,"name":"Workspace seat","qty":14,"rate":180,"cost":0,"commitment":"annual_yearly","domain":"branch.kitebuyer.in"},
                            {"id":"l4","item_id":null,"name":"Extra storage","qty":1,"rate":66,"cost":0,"commitment":"one_time"}]';
  c_groups constant jsonb := '[{"external_number":"INV/26-27/0816","line_ids":["l1","l2"]},{"external_number":"INV/26-27/0817","line_ids":["l3","l4"]}]';
  r jsonb; v_m text; v_q text; n_subs int; n_q int; ok boolean; v_rid uuid; v_a text; v_b text;
begin
  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000251804', c_c, c_all, true, (select txn_date from public.bank_transactions where id = '11111111-0000-0000-0000-000000251804'), null, 0, null, null, 'yearly');
  v_m := r->>'invoice_id';
  select quote_id into v_q from public.invoices where id = v_m;
  if v_m is null or (select amount from public.invoices where id = v_m) <> 6294 then raise exception 'FAIL F setup: merged sale (%)', r; end if;
  select count(*) into n_subs from public.subscriptions where quote_id = v_q;
  select count(*) into n_q from public.quotes where tenant_id = 'dddddddd-0000-0000-0000-000000251801';

  -- dry run: nothing changes
  r := public.repair_split_merged_bank_sale(v_m, c_groups, true);
  if (r->>'dry_run')::boolean is not true or jsonb_array_length(r->'booked'->'parts') <> 2 then raise exception 'FAIL F dry: %', r; end if;
  if (select status::text from public.invoices where id = v_m) <> 'paid' or exists (select 1 from public.credit_notes where invoice_id = v_m)
     or exists (select 1 from public.bank_sale_split_repairs) or (select count(*) from public.quotes where tenant_id = 'dddddddd-0000-0000-0000-000000251801') <> n_q
     or (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000251804') is distinct from 'payment' then
    raise exception 'FAIL F: the dry run changed something';
  end if;
  raise notice 'F PASS (dry run): would book % + %, nothing changed', r->'booked'->'parts'->0->>'invoice_id', r->'booked'->'parts'->1->>'invoice_id';

  -- an accountant is refused
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000251802","role":"authenticated"}', true);
  ok := false;
  begin perform public.repair_split_merged_bank_sale(v_m, c_groups, false);
  exception when insufficient_privilege then ok := true; end;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000251801","role":"authenticated"}', true);
  if not ok then raise exception 'FAIL F: an accountant could run the repair'; end if;

  -- a group set that misses a line is refused
  ok := false;
  begin perform public.repair_split_merged_bank_sale(v_m, '[{"external_number":"INV/26-27/0816","line_ids":["l1","l2"]},{"external_number":"INV/26-27/0817","line_ids":["l3"]}]'::jsonb, false);
  exception when sqlstate '22023' then ok := true; end;
  if not ok then raise exception 'FAIL F: groups missing a line were accepted'; end if;

  -- the real run
  r := public.repair_split_merged_bank_sale(v_m, c_groups, false);
  v_rid := (r->>'repair_id')::uuid;
  v_a := r->'booked'->'parts'->0->>'invoice_id';
  v_b := r->'booked'->'parts'->1->>'invoice_id';
  if not exists (select 1 from public.credit_notes where invoice_id = v_m) then raise exception 'FAIL F: merged invoice % not credit-noted', v_m; end if;
  if (select external_number from public.invoices where id = v_a) is distinct from 'INV/26-27/0816'
     or (select external_number from public.invoices where id = v_b) is distinct from 'INV/26-27/0817'
     or (select amount from public.invoices where id = v_a) <> 3243 or (select amount from public.invoices where id = v_b) <> 3051 then
    raise exception 'FAIL F: per-Zoho invoices wrong (%)', r;
  end if;
  if (select invoice_date from public.invoices where id = v_a) <> (select txn_date from public.bank_transactions where id = '11111111-0000-0000-0000-000000251804') then   -- R-2518b: the bank date (3 days back, inside this FY — the repair refuses another FY)
    raise exception 'FAIL F: new invoice dated % (want the bank date %)', (select invoice_date from public.invoices where id = v_a), (select txn_date from public.bank_transactions where id = '11111111-0000-0000-0000-000000251804');
  end if;
  if (select count(*) from public.payments where bank_txn_id = '11111111-0000-0000-0000-000000251804') <> 2
     or exists (select 1 from public.payments where quote_id = v_q) then
    raise exception 'FAIL F: receipts on the line are wrong after the repair';
  end if;
  if (select count(*) from public.subscriptions where quote_id = v_q) <> n_subs then
    raise exception 'FAIL F: the merged sale''s subscriptions changed (% → %)', n_subs, (select count(*) from public.subscriptions where quote_id = v_q);
  end if;
  if (select count(*) from public.subscriptions s join public.quotes q on q.id = s.quote_id where q.id in (select quote_id from public.invoices where id in (v_a, v_b))) <> 0 then
    raise exception 'FAIL F: the repair made new subscriptions';
  end if;
  if not exists (select 1 from public.bank_sale_split_repairs where id = v_rid and backup->'invoice'->>'id' = v_m and result is not null) then
    raise exception 'FAIL F: no backup row';
  end if;
  raise notice 'F PASS: % credit-noted; % (INV/26-27/0816) + % (INV/26-27/0817) on the line; % subscriptions kept', v_m, v_a, v_b, n_subs;
  insert into r2518_ids values ('rid', v_rid::text), ('fa', v_a), ('fb', v_b);
end $$;

-- G: undo
do $$
declare
  v_rid uuid := (select v::uuid from r2518_ids where k = 'rid');
  r jsonb; v_new text;
begin
  r := public.undo_split_merged_bank_sale(v_rid, true);
  if exists (select 1 from public.credit_notes where invoice_id = (select v from r2518_ids where k = 'fa'))
     or (select undone_at from public.bank_sale_split_repairs where id = v_rid) is not null then
    raise exception 'FAIL G: the undo dry run changed something';
  end if;
  r := public.undo_split_merged_bank_sale(v_rid, false);
  if not exists (select 1 from public.credit_notes where invoice_id = (select v from r2518_ids where k = 'fa'))
     or not exists (select 1 from public.credit_notes where invoice_id = (select v from r2518_ids where k = 'fb')) then
    raise exception 'FAIL G: per-Zoho invoices not credit-noted (%)', r;
  end if;
  v_new := r->'booked'->'parts'->0->>'invoice_id';
  if jsonb_array_length(r->'booked'->'parts') <> 1 or (select amount from public.invoices where id = v_new) <> 6294
     or (select jsonb_array_length(q.line_items) from public.quotes q join public.invoices i on i.quote_id = q.id where i.id = v_new) <> 4 then
    raise exception 'FAIL G: the original lines were not booked again as one sale (%)', r;
  end if;
  if (select undone_at from public.bank_sale_split_repairs where id = v_rid) is null then raise exception 'FAIL G: repair not marked undone'; end if;
  begin
    perform public.undo_split_merged_bank_sale(v_rid, false);
    raise exception 'FAIL G: undone twice';
  exception when check_violation then null;
  end;
  if (select external_number from public.invoices where id = (select v from r2518_ids where k = 'fa')) is not null
     or public.invoice_external_number_holder('dddddddd-0000-0000-0000-000000251801', 'INV/26-27/0816', null) is not null then
    raise exception 'FAIL G: the cancelled invoice still holds INV/26-27/0816';
  end if;
  raise notice 'G PASS: undo → % (4 lines, ₹6,294) on the line; the Zoho numbers are free again', v_new;
end $$;

-- H: the amount rule never writes off — short → the last sale part-paid; extra → advance. Billed in parts → repair refused.
do $$
declare r jsonb; ok boolean := false; v_inv text;
begin
  r := public.bank_sale_split_amounts('[{"amount":3243},{"amount":3051}]'::jsonb, 6260);
  if r->'rest' <> 'null'::jsonb or (r->'sales'->1->>'amount')::int <> 3017 then raise exception 'FAIL H: short by 34 → %', r; end if;
  r := public.bank_sale_split_amounts('[{"amount":3243},{"amount":3051}]'::jsonb, 6300);
  if r->>'rest' <> 'advance' then raise exception 'FAIL H: extra 6 → %', r; end if;
  -- the undo's merged sale (G), its quote made "billed quarterly" / "0% GST" here only to prove the refusals
  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000251805', 'cccccccc-0000-0000-0000-000000251801',
         '[{"id":"q1","item_id":null,"name":"Seat","qty":2,"rate":1000,"cost":0,"commitment":"one_time"},{"id":"q2","item_id":null,"name":"Setup","qty":1,"rate":100,"cost":0,"commitment":"one_time"}]'::jsonb,
         false, null, null, 0, null, null, 'yearly');
  v_inv := r->>'invoice_id';
  update public.quotes set billing_cycle = 'quarterly' where id = r->>'quote_id';
  begin
    perform public.repair_split_merged_bank_sale(v_inv, '[{"external_number":"Z1","line_ids":["q1"]},{"external_number":"Z2","line_ids":["q2"]}]'::jsonb, false);
  exception when check_violation then
    ok := sqlerrm like '%is billed in parts%';
  end;
  if not ok then raise exception 'FAIL H: a sale billed in parts was split'; end if;
  update public.quotes set billing_cycle = 'yearly', tax_rate = 0 where id = r->>'quote_id';
  ok := false;
  begin
    perform public.repair_split_merged_bank_sale(v_inv, '[{"external_number":"Z1","line_ids":["q1"]},{"external_number":"Z2","line_ids":["q2"]}]'::jsonb, false);
  exception when check_violation then
    ok := sqlerrm like '%GST rate%';
  end;
  if not ok then raise exception 'FAIL H: a sale whose GST rate changed was split'; end if;
  raise notice 'H PASS: no write-off on a shortfall; extra = advance; billed in parts / changed GST rate refused';
end $$;

select 'R-2518 one app invoice per Zoho invoice + repair: ALL PASS' as result;

rollback;
