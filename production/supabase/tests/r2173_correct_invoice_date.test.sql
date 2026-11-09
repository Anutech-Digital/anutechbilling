-- R-2173 (9 Nov 2026, p1 money, slice 1): correct an issued invoice's date while its GST month is not filed.
-- Migration 20261109132649_r2173_correct_invoice_date. Self-asserting, ONE transaction, rolled back.
-- RED without the migration (correct_invoice_date does not exist).
--
--   E. (runs first, nothing filed yet) a new date in another financial year -> refused (R-2632), nothing changed.
--   A. GST filed up to Aug 2026 (owner). The accountant moves a PAID 30 Oct invoice to 15 Sep: invoice_date and
--      due_date move by the same days, paid status/amount/paid_date unchanged, one activity_log
--      invoice.date_corrected with old/new/reason; report_pnl_monthly moves the revenue from Oct to Sep.
--   B. An invoice dated in a filed month (20 Aug) -> refused "GST for Aug 2026 is already filed".
--   C. A new date in a filed month (10 Aug), inside the books lock (Jun), or in a GSTR-1-marked month (Jul) -> refused.
--   D. An invoice with an IRN -> refused.
--   F. Future date / the same date / a short reason / a repeat of A -> refused; no second log row.
--   G. Sales role -> 42501; another company's invoice -> 42501; a direct UPDATE of invoice_date -> freeze trigger.
--   H. Draft, void, opening balance, Zoho-imported, foreign currency -> refused.
--   I. With a credit note, a debit note, a business-network copy, a child company's mirrored bill -> refused.

begin;

insert into auth.users (id, email) values
  ('b2173000-0000-0000-0000-0000000000a1', 'r2173-owner@example.test'),
  ('b2173000-0000-0000-0000-0000000000a2', 'r2173-acct@example.test'),
  ('b2173000-0000-0000-0000-0000000000a3', 'r2173-sales@example.test'),
  ('b2173000-0000-0000-0000-0000000000a4', 'r2173-other@example.test');

insert into public.tenants (id, name, email, state_code, gstin, doc_code, address) values
  ('b2173000-0000-0000-0000-0000000000f0', 'R2173 T', 'r2173@example.test', '07', '07AAACR2173A1Z5', 'R2173', 'Test street, Delhi'),
  ('b2173000-0000-0000-0000-0000000000f1', 'R2173 O', 'r2173o@example.test', '07', '07AAACR2173B1Z5', 'R2173O', 'Test street, Delhi');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('b2173000-0000-0000-0000-0000000000a1', 'b2173000-0000-0000-0000-0000000000f0', 'r2173-owner@example.test', 'Owner', 'owner', true),
  ('b2173000-0000-0000-0000-0000000000a2', 'b2173000-0000-0000-0000-0000000000f0', 'r2173-acct@example.test', 'Acct', 'accountant', true),
  ('b2173000-0000-0000-0000-0000000000a3', 'b2173000-0000-0000-0000-0000000000f0', 'r2173-sales@example.test', 'Sales', 'sales', true),
  ('b2173000-0000-0000-0000-0000000000a4', 'b2173000-0000-0000-0000-0000000000f1', 'r2173-other@example.test', 'Other', 'owner', true);

insert into public.customers (id, tenant_id, name, state_code, country, domain) values
  ('b2173000-0000-0000-0000-0000000000c1', 'b2173000-0000-0000-0000-0000000000f0', 'R2173 Buyer', '07', 'India', 'r2173buyer.in'),
  ('b2173000-0000-0000-0000-0000000000c2', 'b2173000-0000-0000-0000-0000000000f1', 'R2173 Other Buyer', '07', 'India', 'r2173other.in');

-- One plain INR tax invoice per case (inserted, so the freeze trigger - UPDATE only - lets them in).
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, net_payable, status, invoice_date, due_date,
                             taxable_value, tax_amount, tax_rate, inter_state, paid_amount, paid_date, document_kind, line_items)
select v.id, 'b2173000-0000-0000-0000-0000000000f0', 'b2173000-0000-0000-0000-0000000000c1', 'R2173 Buyer', 1180, 1180,
       v.status::public.invoice_status, v.d::date, (v.d::date + 15), 1000, 180, 18, false,
       case when v.status = 'paid' then 1180 else 0 end, case when v.status = 'paid' then v.d::date end,
       'tax_invoice', '[{"name":"R2173 Seat","qty":1,"rate":1000}]'::jsonb
  from (values ('INV-R2173-A', 'paid', '2026-10-30'), ('INV-R2173-B', 'pending', '2026-08-20'),
               ('INV-R2173-C', 'pending', '2026-10-28'), ('INV-R2173-D', 'pending', '2026-10-27'),
               ('INV-R2173-E', 'pending', '2026-10-25'), ('INV-R2173-F', 'pending', '2026-10-24'),
               ('INV-R2173-G', 'pending', '2026-10-23'), ('INV-R2173-HD', 'draft', '2026-10-22'),
               ('INV-R2173-HV', 'void', '2026-10-21'), ('INV-R2173-HF', 'pending', '2026-10-20'),
               ('INV-R2173-I1', 'pending', '2026-10-19'), ('INV-R2173-I2', 'pending', '2026-10-18'),
               ('INV-R2173-I3', 'pending', '2026-10-17'), ('INV-R2173-I4', 'pending', '2026-10-16')) v(id, status, d);
update public.invoices set gst_irn = 'R2173IRN0001' where id = 'INV-R2173-D';
-- foreign currency (set as the server would: currency + rate frozen on the row)
update public.invoices set currency = 'USD', fx_rate = 83.5, fx_source = 'manual', fx_date = '2026-10-20' where id = 'INV-R2173-HF';
-- opening balance invoice (only the opening import may write one)
insert into public.invoice_import_batches (id, tenant_id) values ('b2173000-0000-0000-0000-0000000000b1', 'b2173000-0000-0000-0000-0000000000f0');
insert into public.zoho_fy_import_batches (id, tenant_id, kind, fy) values ('b2173000-0000-0000-0000-0000000000b2', 'b2173000-0000-0000-0000-0000000000f0', 'invoices', '2026-27');
select set_config('app.opening_invoice_import', 'on', true);
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, net_payable, status, invoice_date, due_date, paid_amount, document_kind, opening_balance, external_number, import_batch_id)
values ('INV-R2173-HO', 'b2173000-0000-0000-0000-0000000000f0', 'b2173000-0000-0000-0000-0000000000c1', 'R2173 Buyer', 1180, 1180, 'pending', '2026-10-15', '2026-10-30', 0, 'opening_invoice', 1180, 'ZO-R2173', 'b2173000-0000-0000-0000-0000000000b1');
select set_config('app.opening_invoice_import', '', true);
-- Zoho-imported sale (only the FY import may write one)
select set_config('app.zoho_sale_import', 'on', true);
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, net_payable, status, invoice_date, due_date,
                             taxable_value, tax_amount, tax_rate, inter_state, paid_amount, document_kind, zoho_invoice_id, external_number, sale_import_batch_id)
values ('INV-R2173-HZ', 'b2173000-0000-0000-0000-0000000000f0', 'b2173000-0000-0000-0000-0000000000c1', 'R2173 Buyer', 1180, 1180, 'pending', '2026-10-14', '2026-10-29',
        1000, 180, 18, false, 0, 'tax_invoice', 'zr2173', 'INV/26-27/R2173', 'b2173000-0000-0000-0000-0000000000b2');
select set_config('app.zoho_sale_import', '', true);
-- another company's invoice
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, net_payable, status, invoice_date, due_date,
                             taxable_value, tax_amount, tax_rate, inter_state, paid_amount, document_kind)
values ('INV-R2173-OT', 'b2173000-0000-0000-0000-0000000000f1', 'b2173000-0000-0000-0000-0000000000c2', 'R2173 Other Buyer', 1180, 1180, 'pending', '2026-10-25', '2026-11-09',
        1000, 180, 18, false, 0, 'tax_invoice');
-- I: credit note, debit note, network copy, mirrored child bill
insert into public.credit_notes (id, tenant_id, invoice_id, customer_id, customer_name, credit_date, reason_code, reason, amount, taxable_value, tax_amount, tax_rate, inter_state)
values ('CN-R2173-1', 'b2173000-0000-0000-0000-0000000000f0', 'INV-R2173-I1', 'b2173000-0000-0000-0000-0000000000c1', 'R2173 Buyer', '2026-10-25', 'other', 'test', 118, 100, 18, 18, false);
insert into public.debit_notes (id, tenant_id, invoice_id, customer_id, customer_name, debit_date, reason_code, reason, amount, taxable_value, tax_amount, tax_rate, inter_state)
values ('DN-R2173-1', 'b2173000-0000-0000-0000-0000000000f0', 'INV-R2173-I2', 'b2173000-0000-0000-0000-0000000000c1', 'R2173 Buyer', '2026-10-25', 'other', 'test', 118, 100, 18, 18, false);
insert into public.network_documents (kind, seller_tenant_id, buyer_tenant_id, seller_invoice_id, seller_gstin, buyer_gstin, seller_name, doc_number, doc_date, fy, taxable_value, total)
values ('invoice', 'b2173000-0000-0000-0000-0000000000f0', 'b2173000-0000-0000-0000-0000000000f1', 'INV-R2173-I3', '07AAACR2173A1Z5', '07AAACR2173B1Z5', 'R2173 T', 'INV-R2173-I3', '2026-10-17', 'FY2627', 1000, 1180);
insert into public.vendor_bills (id, tenant_id, vendor_name, bill_no, bill_date, total, source_tenant_invoice_id)
values ('VB-R2173-1', 'b2173000-0000-0000-0000-0000000000f1', 'R2173 T', 'INV-R2173-I4', '2026-10-16', 1180, 'INV-R2173-I4');

create function pg_temp.as_user(p uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$f$;
create function pg_temp.refused(p_id text, p_date date, p_reason text, p_like text, p_state text default '22023')
returns void language plpgsql as $f$
declare v_msg text; v_state text; v_before date;
begin
  select invoice_date into v_before from public.invoices where id = p_id;
  begin
    perform public.correct_invoice_date(p_id, p_date, p_reason);
  exception when others then
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
  end;
  if v_msg is null then raise exception 'FAIL %: % -> % was NOT refused', p_like, p_id, p_date; end if;
  if v_state <> p_state or v_msg not ilike p_like then
    raise exception 'FAIL %: % -> % refused with [%] %', p_like, p_id, p_date, v_state, v_msg;
  end if;
  if (select invoice_date from public.invoices where id = p_id) is distinct from v_before then
    raise exception 'FAIL %: % date changed although refused', p_like, p_id;
  end if;
end $f$;
create function pg_temp.logs(p_id text) returns bigint language sql as $f$
  select count(*) from public.activity_log where action = 'invoice.date_corrected' and entity_id = p_id $f$;
grant execute on function pg_temp.as_user(uuid), pg_temp.refused(text, date, text, text, text), pg_temp.logs(text) to authenticated;

set local role authenticated;

-- ── E. Another financial year (nothing filed yet) ──────────────────────────────────────────────────
select pg_temp.as_user('b2173000-0000-0000-0000-0000000000a1');
select pg_temp.refused('INV-R2173-E', '2026-03-20', 'Receipt was in March', '%financial year FY2627%needs a new number%R-2632%');

-- ── Owner files GST up to Aug 2026; GSTR-1 for Jul is also marked; books locked to Jun ─────────────
select public.set_gst_filed_through('2026-08-15');
reset role;
select set_config('request.jwt.claims', '', true);
update public.tenants set books_locked_until = '2026-06-30' where id = 'b2173000-0000-0000-0000-0000000000f0';
set local role authenticated;

-- ── A. Accountant moves the paid 30 Oct invoice to 15 Sep ──────────────────────────────────────────
select pg_temp.as_user('b2173000-0000-0000-0000-0000000000a2');
do $$
declare r jsonb; p0 jsonb; p1 jsonb; v public.invoices; l public.activity_log;
begin
  p0 := public.report_pnl_monthly('2026-09-01', '2026-10-31');
  r := public.correct_invoice_date('INV-R2173-A', '2026-09-15', 'Receipt came on 15 Sep - raised late');
  if r->>'new_date' <> '2026-09-15' or r->>'old_date' <> '2026-10-30' then raise exception 'FAIL A: result %', r; end if;
  select * into v from public.invoices where id = 'INV-R2173-A';
  if v.invoice_date <> '2026-09-15' or v.due_date <> '2026-09-30' then
    raise exception 'FAIL A: date % due % (want 2026-09-15 / 2026-09-30)', v.invoice_date, v.due_date;
  end if;
  if v.status <> 'paid' or v.paid_amount <> 1180 or v.paid_date <> '2026-10-30' or v.amount <> 1180 or v.taxable_value <> 1000 then
    raise exception 'FAIL A: money fields changed: % % % % %', v.status, v.paid_amount, v.paid_date, v.amount, v.taxable_value;
  end if;
  perform pg_temp.as_user('b2173000-0000-0000-0000-0000000000a1');  -- the log is read by owner/manager (RLS)
  select * into l from public.activity_log where action = 'invoice.date_corrected' and entity_id = 'INV-R2173-A';
  if l.id is null or l.user_id <> 'b2173000-0000-0000-0000-0000000000a2'
     or l.changes->'invoice_date'->>'old' <> '2026-10-30' or l.changes->'invoice_date'->>'new' <> '2026-09-15'
     or l.changes->>'reason' <> 'Receipt came on 15 Sep - raised late' then
    raise exception 'FAIL A: log row %', row_to_json(l);
  end if;
  p1 := public.report_pnl_monthly('2026-09-01', '2026-10-31');
  if coalesce((select (e->>'revenue')::bigint from jsonb_array_elements(p1) e where e->>'month' = '2026-09'), 0)
     - coalesce((select (e->>'revenue')::bigint from jsonb_array_elements(p0) e where e->>'month' = '2026-09'), 0) <> 1000
     or coalesce((select (e->>'revenue')::bigint from jsonb_array_elements(p0) e where e->>'month' = '2026-10'), 0)
     - coalesce((select (e->>'revenue')::bigint from jsonb_array_elements(p1) e where e->>'month' = '2026-10'), 0) <> 1000 then
    raise exception 'FAIL A: P&L did not move 1000 from Oct to Sep: before % after %', p0, p1;
  end if;
end $$;

-- ── B. Old date in a filed month ───────────────────────────────────────────────────────────────────
select pg_temp.refused('INV-R2173-B', '2026-10-01', 'Wrong date typed', 'GST for Aug 2026 is already filed (GST returns are filed up to August 2026%cannot be re-dated%credit note%');

-- ── C. New date in a filed month / books lock / GSTR-1 mark ────────────────────────────────────────
select pg_temp.refused('INV-R2173-C', '2026-08-10', 'Receipt in August', 'GST for Aug 2026 is already filed%cannot be moved to 10 Aug 2026%');
select pg_temp.refused('INV-R2173-C', '2026-06-10', 'Receipt in June', 'GST for Jun 2026 is already filed (%') ;
reset role;
select set_config('request.jwt.claims', '', true);
update public.tenants set gst_filed_through = null where id = 'b2173000-0000-0000-0000-0000000000f0';
set local role authenticated;
select pg_temp.as_user('b2173000-0000-0000-0000-0000000000a2');
-- the books lock alone names the lock
select pg_temp.refused('INV-R2173-G', '2026-06-10', 'Receipt in June', 'GST for Jun 2026 is already filed (the books are locked up to 30 Jun 2026%');
reset role;
select set_config('request.jwt.claims', '', true);
insert into public.compliance_log (tenant_id, obligation_key, period_key) values ('b2173000-0000-0000-0000-0000000000f0', 'gst_gstr1', '2026-10');
set local role authenticated;
select pg_temp.as_user('b2173000-0000-0000-0000-0000000000a2');
-- Oct GSTR-1 marked filed -> the Oct invoice cannot leave Oct
select pg_temp.refused('INV-R2173-C', '2026-09-10', 'Receipt in Sept', 'GST for Oct 2026 is already filed (GSTR-1 for Oct 2026 is marked filed%');
reset role;
select set_config('request.jwt.claims', '', true);
delete from public.compliance_log where tenant_id = 'b2173000-0000-0000-0000-0000000000f0';
update public.tenants set gst_filed_through = '2026-08-31' where id = 'b2173000-0000-0000-0000-0000000000f0';
set local role authenticated;
select pg_temp.as_user('b2173000-0000-0000-0000-0000000000a1');

-- ── D. IRN ─────────────────────────────────────────────────────────────────────────────────────────
select pg_temp.refused('INV-R2173-D', '2026-09-20', 'Receipt in Sept', '%has an IRN (e-invoice)%');

-- ── F. Future / same / short reason / repeat ───────────────────────────────────────────────────────
select pg_temp.refused('INV-R2173-F', public.ist_today() + 1, 'Typed wrong', '%cannot be dated in the future%');
select pg_temp.refused('INV-R2173-F', '2026-10-24', 'Typed wrong', '%is already dated 24 Oct 2026%');
select pg_temp.refused('INV-R2173-F', '2026-09-24', 'oops', '%at least 5 characters%');
select pg_temp.refused('INV-R2173-F', null, 'Typed wrong', '%Pick the correct date%');
select pg_temp.refused('INV-R2173-A', '2026-09-15', 'Receipt came on 15 Sep - raised late', '%is already dated 15 Sep 2026%');
do $$ begin
  if pg_temp.logs('INV-R2173-A') <> 1 then raise exception 'FAIL F: repeat wrote another log row'; end if;
end $$;

-- ── G. Roles, other company, direct update ─────────────────────────────────────────────────────────
select pg_temp.as_user('b2173000-0000-0000-0000-0000000000a3');
select pg_temp.refused('INV-R2173-G', '2026-09-23', 'Sales tries it', 'Only the owner or the accountant%', '42501');
select pg_temp.as_user('b2173000-0000-0000-0000-0000000000a1');
select pg_temp.refused('INV-R2173-OT', '2026-10-01', 'Not my company', '%was not found in your company%', '42501');
do $$
declare ok boolean := false;
begin
  begin
    update public.invoices set invoice_date = '2026-09-23' where id = 'INV-R2173-G';
  exception when others then ok := sqlerrm ilike '%invoice_date%';
  end;
  if not ok and (select invoice_date from public.invoices where id = 'INV-R2173-G') <> '2026-10-23' then
    raise exception 'FAIL G: a direct UPDATE changed invoice_date';
  end if;
  if current_setting('app.invoice_amend_reason', true) is not null and current_setting('app.invoice_amend_reason', true) <> '' then
    raise exception 'FAIL G: amend reason left set after the RPC: %', current_setting('app.invoice_amend_reason', true);
  end if;
end $$;

-- ── H. Not an issued INR sale of ours ──────────────────────────────────────────────────────────────
select pg_temp.refused('INV-R2173-HD', '2026-10-01', 'Draft date', '%a draft%');
select pg_temp.refused('INV-R2173-HV', '2026-10-01', 'Void date', '%is void, not an issued invoice%');
select pg_temp.refused('INV-R2173-HO', '2026-10-01', 'Opening date', '%an opening balance%');
select pg_temp.refused('INV-R2173-HZ', '2026-10-01', 'Zoho date', '%imported from Zoho Books%');
select pg_temp.refused('INV-R2173-HF', '2026-10-01', 'USD date', '%is in USD%new rate%');

-- ── I. Documents that already carry the date ──────────────────────────────────────────────────────
select pg_temp.refused('INV-R2173-I1', '2026-10-01', 'Has credit note', '%credit or debit note%');
select pg_temp.refused('INV-R2173-I2', '2026-10-01', 'Has debit note', '%credit or debit note%');
select pg_temp.refused('INV-R2173-I3', '2026-10-01', 'Network copy', '%business network%');
select pg_temp.refused('INV-R2173-I4', '2026-10-01', 'Mirrored bill', '%business network%');

do $$ begin
  if (select count(*) from public.activity_log where action = 'invoice.date_corrected'
        and entity_id like 'INV-R2173-%') <> 1 then
    raise exception 'FAIL: only A should be logged';
  end if;
  raise notice 'R-2173 correct_invoice_date: all cases passed';
end $$;

rollback;
