-- R-1914 (26 Oct 2026, from the R-1906 audit B4): a COGS vendor's advance (Google, AWS) is set off
-- against that vendor's COGS bill (vendor_bills) — it no longer becomes an 'Other' expense.
-- Migration: 20261026032214_r1914_cogs_vendor_advance.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Proves (owner's path: Google Cloud India, default category COGS-Workspace):
--   A. Banking → "Paying a vendor?" → ₹11,800 as an advance: saved under the vendor's COGS head
--      (COGS-Workspace), not 'Other'; a COGS head typed by hand is accepted too.
--   B. Google's ₹11,800 COGS bill → apply_vendor_advance('vendor_bill') → bill Paid, advance ₹0,
--      Balance Sheet payables 0 / prepaid 0, P&L COGS ₹10,000 (pre-GST), and NO expense row.
--   C. Undo → bill unpaid again, advance ₹11,800 back.
--   D. Part: AWS ₹5,000 advance on an ₹11,800 bill → partial, ₹6,800 due (open items); the bank
--      line pays the ₹6,800 → paid; un-reconciling that line leaves it partial with ₹6,800 due.
--   E. Prepaid → Book invoice on a COGS advance is refused (it would land as opex) — says Bills.
--   F. 194Q (buyer above ₹10 crore): the advance stops short of the 194Q TDS still due on the
--      bill (vendor_bill_194q_calc) — ₹11,790 applied, ₹10 left for the TDS.
--   G. Guards: cutting the bill below the advance; deleting the bill gives the advance back;
--      another company's bill; a sales user.

begin;

create function pg_temp.r1914_fill_supplier() returns trigger language plpgsql as $f$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street');
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := '07AAACT1643F1Z5';
  end if;
  return new;
end $f$;
create trigger zz_r1914_supplier before insert on public.tenants for each row execute function pg_temp.r1914_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000191401','R1914 Co','r1914@example.in','07','R1914'),
  ('dddddddd-0000-0000-0000-000000191402','R1914 Other Co','r1914b@example.in','07','R1914B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000191401','owner1914@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000191402','sales1914@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000191401','dddddddd-0000-0000-0000-000000191401','owner1914@example.in','Owner 1914','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000191402','dddddddd-0000-0000-0000-000000191401','sales1914@example.in','Sales 1914','sales', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000191401','dddddddd-0000-0000-0000-000000191401','HDFC Current','HDFC');
insert into public.vendors (id, tenant_id, name, gstin, pan, default_category) values
  ('eeeeeeee-0000-0000-0000-000000191401','dddddddd-0000-0000-0000-000000191401','Google Cloud India','29AACCG1914B1Z9','AACCG1914B','COGS-Workspace'),
  ('eeeeeeee-0000-0000-0000-000000191402','dddddddd-0000-0000-0000-000000191401','Amazon Web Services India','29AACCA1914B1Z9','AACCA1914B','COGS-Other'),
  ('eeeeeeee-0000-0000-0000-000000191403','dddddddd-0000-0000-0000-000000191401','Big Distributor','07AAACB1914A1Z5','AAACB1914A','COGS-Hardware');

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000191401','dddddddd-0000-0000-0000-000000191401','bbbbbbbb-0000-0000-0000-000000191401','2026-10-01','NEFT GOOGLE CLOUD INDIA ADV',11800,0,'G1','csv_upload'),
  ('11111111-0000-0000-0000-000000191402','dddddddd-0000-0000-0000-000000191401','bbbbbbbb-0000-0000-0000-000000191401','2026-10-02','NEFT AMAZON WEB SERVICES ADV',5000,0,'A1','csv_upload'),
  ('11111111-0000-0000-0000-000000191403','dddddddd-0000-0000-0000-000000191401','bbbbbbbb-0000-0000-0000-000000191401','2026-10-21','NEFT AMAZON WEB SERVICES INV',6800,0,'A2','csv_upload'),
  ('11111111-0000-0000-0000-000000191404','dddddddd-0000-0000-0000-000000191401','bbbbbbbb-0000-0000-0000-000000191401','2026-10-03','NEFT BIG DISTRIBUTOR ADV',11800,0,'B1','csv_upload');

-- Owner 1914 signs in.
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000191401","role":"authenticated"}', true);

-- ── A. The advance keeps the vendor's COGS head ──────────────────────────────────────────────
do $$
declare r jsonb; a public.prepaid_advances;
begin
  -- Google: no category picked → the vendor's own head (COGS-Workspace), not 'Other'.
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191401','eeeeeeee-0000-0000-0000-000000191401', null, '[]'::jsonb, null, 11800, null);
  select * into a from public.prepaid_advances where vendor_id = 'eeeeeeee-0000-0000-0000-000000191401';
  if a.category is distinct from 'COGS-Workspace' or a.total_amount <> 11800 then
    raise exception 'A FAIL: Google advance saved as % (₹%) — want COGS-Workspace', a.category, a.total_amount;
  end if;
  -- AWS: a COGS head picked by hand is accepted (was "Pick the expense category…").
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191402','eeeeeeee-0000-0000-0000-000000191402', null, '[]'::jsonb, null, 5000, 'COGS-Other');
  if r->'advance'->>'category' is distinct from 'COGS-Other' then raise exception 'A FAIL: AWS advance %', r->'advance'; end if;
  raise notice 'A ok: advances saved as COGS-Workspace / COGS-Other (not Other, not refused)';
end $$;

-- Google's ₹11,800 COGS bill (₹10,000 + IGST ₹1,800), recorded on the Bills page, unpaid.
insert into public.vendor_bills (id, tenant_id, vendor_id, vendor_name, bill_no, bill_date, due_date, category, subtotal, cgst, sgst, igst, total, status, paid_amount) values
  ('BILL-R1914-G1','dddddddd-0000-0000-0000-000000191401','eeeeeeee-0000-0000-0000-000000191401','Google Cloud India','GCI-1','2026-10-10','2026-10-25','COGS-Workspace',10000,0,0,1800,11800,'unpaid',0),
  ('BILL-R1914-A1','dddddddd-0000-0000-0000-000000191401','eeeeeeee-0000-0000-0000-000000191402','Amazon Web Services India','AWS-1','2026-10-11','2026-10-25','COGS-Other',10000,0,0,1800,11800,'unpaid',0),
  ('BILL-R1914-X1','dddddddd-0000-0000-0000-000000191402',null,'Google Cloud India','X-1','2026-10-10',null,'COGS-Workspace',1000,0,0,0,1000,'unpaid',0);

-- ── B. Apply the Google advance to the Google COGS bill ──────────────────────────────────────
do $$
declare r jsonb; b public.vendor_bills; v_left int; n int; v_pay bigint; v_pre bigint; v_cogs numeric;
begin
  r := public.apply_vendor_advance('vendor_bill', 'BILL-R1914-G1');
  if (r->>'applied')::int <> 11800 or (r->>'still_due')::int <> 0 or not (r->>'settled')::boolean or (r->>'advance_left')::int <> 0 then
    raise exception 'B FAIL: apply_vendor_advance returned %', r;
  end if;
  select * into b from public.vendor_bills where id = 'BILL-R1914-G1';
  if b.status <> 'paid' or b.paid_amount <> 11800 or b.advance_applied <> 11800 then
    raise exception 'B FAIL: bill status % paid % applied %', b.status, b.paid_amount, b.advance_applied;
  end if;
  select sum(total_amount - consumed_amount) into v_left from public.prepaid_advances where vendor_id = 'eeeeeeee-0000-0000-0000-000000191401';
  if v_left <> 0 then raise exception 'B FAIL: Google advance left % (want 0)', v_left; end if;
  select count(*) into n from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000191401';
  if n <> 0 then raise exception 'B FAIL: % expense rows — the COGS cost was booked again as opex', n; end if;
  select count(*) into n from public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000191401') where doc_id = 'BILL-R1914-G1';
  if n <> 0 then raise exception 'B FAIL: the settled bill is still an open item'; end if;
  select payables, prepaid_advances into v_pay, v_pre from public.report_balance_sheet();
  -- AWS bill ₹11,800 still unpaid; AWS advance ₹5,000 still prepaid.
  if v_pay <> 11800 or v_pre <> 5000 then raise exception 'B FAIL: Balance Sheet payables % prepaid % (want 11800 / 5000)', v_pay, v_pre; end if;
  select cogs into v_cogs from public.report_pnl('2026-10-01', '2026-10-31');
  if v_cogs <> 20000 then raise exception 'B FAIL: P&L COGS % (want 20000 = Google 10000 + AWS 10000)', v_cogs; end if;
  raise notice 'B ok: Google bill Paid by the advance, advance 0, no expense row, BS payables 11800 / prepaid 5000, P&L COGS 20000';
end $$;

-- ── C. Undo ──────────────────────────────────────────────────────────────────────────────────
do $$
declare r jsonb; b public.vendor_bills; v_left int; n int;
begin
  r := public.undo_vendor_advance('BILL-R1914-G1');
  if (r->>'given_back')::int <> 11800 then raise exception 'C FAIL: %', r; end if;
  select * into b from public.vendor_bills where id = 'BILL-R1914-G1';
  select sum(total_amount - consumed_amount) into v_left from public.prepaid_advances where vendor_id = 'eeeeeeee-0000-0000-0000-000000191401';
  select count(*) into n from public.vendor_advance_applications where vendor_bill_id = 'BILL-R1914-G1';
  if b.status <> 'unpaid' or b.paid_amount <> 0 or b.advance_applied <> 0 or v_left <> 11800 or n <> 0 then
    raise exception 'C FAIL: status % paid % applied % left % rows %', b.status, b.paid_amount, b.advance_applied, v_left, n;
  end if;
  raise notice 'C ok: undo gives ₹11,800 back and the bill is unpaid again';
end $$;

-- ── D. Part: AWS ₹5,000 advance on the ₹11,800 bill, bank pays the rest ──────────────────────
do $$
declare r jsonb; b public.vendor_bills; v_due int;
begin
  r := public.apply_vendor_advance('vendor_bill', 'BILL-R1914-A1');
  if (r->>'applied')::int <> 5000 or (r->>'still_due')::int <> 6800 or (r->>'settled')::boolean then raise exception 'D FAIL: %', r; end if;
  select * into b from public.vendor_bills where id = 'BILL-R1914-A1';
  if b.status <> 'partial' or b.paid_amount <> 5000 then raise exception 'D FAIL: status % paid %', b.status, b.paid_amount; end if;
  select amount_due into v_due from public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000191402') where doc_id = 'BILL-R1914-A1';
  if v_due is distinct from 6800 then raise exception 'D FAIL: open item due % (want 6800)', v_due; end if;
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191403','eeeeeeee-0000-0000-0000-000000191402', null,
      '[{"source":"vendor_bill","doc_id":"BILL-R1914-A1","amount":6800,"tds_amount":0}]'::jsonb);
  select * into b from public.vendor_bills where id = 'BILL-R1914-A1';
  if b.status <> 'paid' or b.paid_amount <> 11800 then raise exception 'D FAIL: after bank status % paid %', b.status, b.paid_amount; end if;
  update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = '11111111-0000-0000-0000-000000191403';
  select * into b from public.vendor_bills where id = 'BILL-R1914-A1';
  if b.status <> 'partial' or b.paid_amount <> 5000 or b.advance_applied <> 5000 then
    raise exception 'D FAIL: after un-reconcile status % paid % applied %', b.status, b.paid_amount, b.advance_applied;
  end if;
  raise notice 'D ok: ₹5,000 advance → partial, ₹6,800 due; bank pays it → paid; un-reconcile → partial ₹6,800 due';
end $$;

-- ── E. Prepaid → Book invoice on a COGS advance is refused ───────────────────────────────────
do $$
declare msg text; n int;
begin
  begin
    perform public.consume_prepaid_fifo('Google Cloud India', 11800, 1800, '2026-10-20', null, null, 'eeeeeeee-0000-0000-0000-000000191401', 'GCI-9');
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%goods (COGS)%Bills page%Apply advance%' then raise exception 'E FAIL: wrong / no refusal: %', msg; end if;
  select count(*) into n from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000191401';
  if n <> 0 then raise exception 'E FAIL: % expense rows', n; end if;
  raise notice 'E ok: Book invoice on a COGS advance refused — "%"', msg;
end $$;

-- ── F. 194Q: the advance leaves the TDS still due on the bill ────────────────────────────────
update public.tenants set tds_194q_buyer = true where id = 'dddddddd-0000-0000-0000-000000191401';
insert into public.vendor_bills (id, tenant_id, vendor_id, vendor_name, bill_no, bill_date, due_date, category, subtotal, cgst, sgst, igst, total, status, paid_amount) values
  ('BILL-R1914-B0','dddddddd-0000-0000-0000-000000191401','eeeeeeee-0000-0000-0000-000000191403','Big Distributor','BD-0','2026-05-01',null,'COGS-Hardware',6000000,0,0,0,6000000,'paid',6000000),
  ('BILL-R1914-B1','dddddddd-0000-0000-0000-000000191401','eeeeeeee-0000-0000-0000-000000191403','Big Distributor','BD-1','2026-10-12',null,'COGS-Hardware',10000,900,900,0,11800,'unpaid',0);
do $$
declare r jsonb; b public.vendor_bills; q record; msg text;
begin
  perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191404','eeeeeeee-0000-0000-0000-000000191403', null, '[]'::jsonb, null, 11800, null);
  select * into q from public.vendor_bill_194q_calc('BILL-R1914-B1');
  if q.tds_due <> 10 then raise exception 'F setup: 194Q due % (want 10)', q.tds_due; end if;
  begin perform public.apply_vendor_advance('vendor_bill', 'BILL-R1914-B1', 11800); msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%194Q%' then raise exception 'F FAIL: applying over the 194Q TDS accepted / wrong refusal: %', msg; end if;
  r := public.apply_vendor_advance('vendor_bill', 'BILL-R1914-B1');
  select * into b from public.vendor_bills where id = 'BILL-R1914-B1';
  if (r->>'applied')::int <> 11790 or (r->>'still_due')::int <> 10 or b.status <> 'partial' or (r->>'tds_due')::int <> 10 then
    raise exception 'F FAIL: % / status %', r, b.status;
  end if;
  raise notice 'F ok: 194Q — ₹11,790 applied, ₹10 TDS left on the bill';
end $$;

-- ── G. Guards ────────────────────────────────────────────────────────────────────────────────
do $$
declare msg text; v_left int; n int;
begin
  -- cutting the AWS bill below the ₹5,000 advance on it
  begin update public.vendor_bills set total = 4000, subtotal = 4000, igst = 0 where id = 'BILL-R1914-A1'; msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%Undo advance%' then raise exception 'G FAIL amount cut: %', msg; end if;
  -- another company's bill
  begin perform public.apply_vendor_advance('vendor_bill', 'BILL-R1914-X1'); msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%not found in your company%' then raise exception 'G FAIL other company: %', msg; end if;
  -- deleting the AWS bill gives the ₹5,000 back
  delete from public.vendor_bills where id = 'BILL-R1914-A1';
  select sum(total_amount - consumed_amount) into v_left from public.prepaid_advances where vendor_id = 'eeeeeeee-0000-0000-0000-000000191402';
  select count(*) into n from public.vendor_advance_applications where vendor_bill_id = 'BILL-R1914-A1';
  if v_left <> 5000 or n <> 0 then raise exception 'G FAIL delete: left % rows %', v_left, n; end if;
  raise notice 'G ok: bill cut below the advance refused, other company refused, delete gives the advance back';
end $$;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000191402","role":"authenticated"}', true);
do $$
declare msg text;
begin
  begin perform public.apply_vendor_advance('vendor_bill', 'BILL-R1914-G1'); msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like 'Only an owner, manager, accountant or billing user%' then raise exception 'G FAIL sales role: %', msg; end if;
  raise notice 'G ok: a sales user is refused';
end $$;

rollback;
