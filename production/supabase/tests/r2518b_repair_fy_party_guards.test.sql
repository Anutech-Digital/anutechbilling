-- R-2518b (6 Nov 2026, independent review v8 of R-2518): repair_split_merged_bank_sale must not move
-- tax between financial years or between CGST+SGST and IGST, and its backup rows are owner/accountant only.
-- Migration 20261106063400_r2518b_repair_fy_party_guards. Self-asserting, ONE transaction, rolled back.
-- Run on a local/test DB only. Dates are relative to ist_today(), so the test does not age.
--
--   A. MEDIUM 5: a merged sale dated in the PREVIOUS financial year (IST) is refused — even a dry run —
--      because the credit note would be dated today (this FY) while the new invoices keep the old date
--      (old FY): taxable value and GST would move between years. Nothing changes.
--   B. LOW 6: a sale from THIS financial year whose customer has since changed state (place of supply)
--      or GSTIN is refused — the new invoices would take the new party facts (CGST+SGST ↔ IGST, B2B ↔ B2C).
--   C. Control: the same sale with the customer as at the sale passes the dry run.
--   D. Optional LOW: after a real run, an accountant reads the backup row; a sales login does not.

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
  ('dddddddd-0000-0000-0000-000000251811','R2518b Zoho Co','r2518b@example.in','07','R25B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000251811','owner2518b@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000251812','acct2518b@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000251813','sales2518b@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000251811','dddddddd-0000-0000-0000-000000251811','owner2518b@example.in','Owner 2518b','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000251812','dddddddd-0000-0000-0000-000000251811','acct2518b@example.in','Acct 2518b','accountant', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000251813','dddddddd-0000-0000-0000-000000251811','sales2518b@example.in','Sales 2518b','sales', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, gstin, domain) values
  ('cccccccc-0000-0000-0000-000000251811','dddddddd-0000-0000-0000-000000251811','Old Year Buyer','07',null,'oldyear.in'),
  ('cccccccc-0000-0000-0000-000000251812','dddddddd-0000-0000-0000-000000251811','Moving Buyer','07','07AAACM2518B1Z5','moving.in');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000251811','dddddddd-0000-0000-0000-000000251811','HDFC Current','HDFC');
-- line 1: 15 days before this FY began (IST) = last FY; line 2: today (IST) = this FY.
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000251811','dddddddd-0000-0000-0000-000000251811','bbbbbbbb-0000-0000-0000-000000251811',
     make_date(extract(year from public.ist_today())::int - case when extract(month from public.ist_today()) >= 4 then 0 else 1 end, 4, 1) - 15,
     'UPI OLD YEAR BUYER',0,2478,'UTR2518BA','manual'),
  ('11111111-0000-0000-0000-000000251812','dddddddd-0000-0000-0000-000000251811','bbbbbbbb-0000-0000-0000-000000251811',
     public.ist_today(), 'UPI MOVING BUYER',0,2478,'UTR2518BB','manual');

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000251811","role":"authenticated"}', true);

create temp table r2518b_ids (k text primary key, v text);
grant all on r2518b_ids to authenticated;

do $$
declare
  c_lines  constant jsonb := '[{"id":"g1","item_id":null,"name":"Seat","qty":10,"rate":180,"cost":0,"commitment":"one_time"},
                               {"id":"g2","item_id":null,"name":"Storage","qty":1,"rate":300,"cost":0,"commitment":"one_time"}]';
  c_groups constant jsonb := '[{"external_number":"INV/25-26/0901","line_ids":["g1"]},{"external_number":"INV/25-26/0902","line_ids":["g2"]}]';
  r jsonb; v_old text; v_new text; ok boolean; v_msg text; v_fy_inv text; v_fy_now text;
begin
  -- A: last FY's merged sale
  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000251811', 'cccccccc-0000-0000-0000-000000251811',
         c_lines, false, null, null, 0, null, null, 'yearly');
  v_old := r->>'invoice_id';
  if v_old is null or (select amount from public.invoices where id = v_old) <> 2478 then raise exception 'FAIL A setup: %', r; end if;
  v_fy_inv := public.indian_fiscal_year((select invoice_date from public.invoices where id = v_old));
  v_fy_now := public.indian_fiscal_year(public.ist_today());
  if v_fy_inv = v_fy_now then raise exception 'FAIL A setup: invoice % is in this FY (%)', v_old, v_fy_inv; end if;
  ok := false;
  begin
    perform public.repair_split_merged_bank_sale(v_old, c_groups, true);
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like '%financial year%' and v_msg like '%' || v_fy_inv || '%' and v_msg like '%' || v_fy_now || '%';
  end;
  if not ok then raise exception 'FAIL A: a last-FY merged sale was not refused (%)', v_msg; end if;
  ok := false;
  begin
    perform public.repair_split_merged_bank_sale(v_old, c_groups, false);
  exception when check_violation then ok := true;
  end;
  if not ok then raise exception 'FAIL A: a last-FY merged sale was split for real'; end if;
  if (select status::text from public.invoices where id = v_old) <> 'paid' or exists (select 1 from public.credit_notes where invoice_id = v_old)
     or exists (select 1 from public.bank_sale_split_repairs where invoice_id = v_old) then
    raise exception 'FAIL A: the refused repair changed something';
  end if;
  raise notice 'A PASS: % (%) refused — today is %', v_old, v_fy_inv, v_fy_now;

  -- B: this FY, the party changed since the sale
  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000251812', 'cccccccc-0000-0000-0000-000000251812',
         c_lines, false, null, null, 0, null, null, 'yearly');
  v_new := r->>'invoice_id';
  if v_new is null or (select pos_state_code from public.invoices where id = v_new) is distinct from '07'
     or (select customer_gstin from public.invoices where id = v_new) is distinct from '07AAACM2518B1Z5' then
    raise exception 'FAIL B setup: % / %', r, (select row(pos_state_code, customer_gstin) from public.invoices where id = v_new);
  end if;
  insert into r2518b_ids values ('new', v_new);

  update public.customers set state_code = '09', gstin = '09AAACM2518B1Z5' where id = 'cccccccc-0000-0000-0000-000000251812';
  ok := false;
  begin
    perform public.repair_split_merged_bank_sale(v_new, c_groups, true);
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like '%place of supply%';
  end;
  if not ok then raise exception 'FAIL B: a customer who moved state (07 → 09) was not refused (%)', v_msg; end if;

  update public.customers set state_code = '07', gstin = null where id = 'cccccccc-0000-0000-0000-000000251812';
  ok := false;
  begin
    perform public.repair_split_merged_bank_sale(v_new, c_groups, true);
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like '%GSTIN%';
  end;
  if not ok then raise exception 'FAIL B: a customer whose GSTIN was removed was not refused (%)', v_msg; end if;

  update public.customers set gstin = '07AAACN2518B1Z5' where id = 'cccccccc-0000-0000-0000-000000251812';
  ok := false;
  begin
    perform public.repair_split_merged_bank_sale(v_new, c_groups, true);
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like '%GSTIN%';
  end;
  if not ok then raise exception 'FAIL B: a customer whose GSTIN changed was not refused (%)', v_msg; end if;
  raise notice 'B PASS: state moved / GSTIN removed / GSTIN changed → refused';

  -- C: back as at the sale → the dry run goes through, nothing changes
  update public.customers set gstin = '07AAACM2518B1Z5' where id = 'cccccccc-0000-0000-0000-000000251812';
  r := public.repair_split_merged_bank_sale(v_new, c_groups, true);
  if (r->>'dry_run')::boolean is not true or jsonb_array_length(r->'booked'->'parts') <> 2
     or exists (select 1 from public.credit_notes where invoice_id = v_new) then
    raise exception 'FAIL C: the same-FY, same-party dry run: %', r;
  end if;
  raise notice 'C PASS: same FY + same party → dry run books 2 sales, nothing changed';

  -- the real run (for D)
  r := public.repair_split_merged_bank_sale(v_new, c_groups, false);
  insert into r2518b_ids values ('rid', r->>'repair_id');
end $$;

-- D: who reads the backup row (RLS, as the signed-in role)
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000251812","role":"authenticated"}', true);
do $$
begin
  if (select count(*) from public.bank_sale_split_repairs where id = (select v::uuid from r2518b_ids where k = 'rid')) <> 1 then
    raise exception 'FAIL D: the accountant cannot read the backup row';
  end if;
end $$;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000251811","role":"authenticated"}', true);
do $$
begin
  if (select count(*) from public.bank_sale_split_repairs where id = (select v::uuid from r2518b_ids where k = 'rid')) <> 1 then
    raise exception 'FAIL D: the owner cannot read the backup row';
  end if;
end $$;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000251813","role":"authenticated"}', true);
do $$
begin
  if (select count(*) from public.bank_sale_split_repairs) <> 0 then
    raise exception 'FAIL D: a sales login reads the repair backup (full invoice / receipt rows)';
  end if;
  raise notice 'D PASS: owner + accountant read the backup row; sales does not';
end $$;
reset role;

select 'R-2518b repair FY + party guards: ALL PASS' as result;

rollback;
