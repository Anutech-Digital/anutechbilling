-- R-1913 (25 Oct 2026, from the R-1906 audit B2 + B3): a vendor advance set off against a bill —
-- in part, and against a bill already in the books — with no second expense row.
-- Migration: 20261025164002_r1913_apply_vendor_advance.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Proves (owner's path: Verma Contractors, ₹30,000 advance from the bank, ₹50,000 bill):
--   A. B2 — apply_vendor_advance on the recorded ₹50,000 bill: ₹30,000 applied, ₹20,000 still due
--      (open items, Balance Sheet expenses payable), advance left ₹0, still ONE expense row,
--      prepaid asset ₹0.
--   B. The ₹20,000 bank line pays the rest → bill paid; un-reconciling it reopens ₹20,000.
--   C. Undo the advance → advance ₹30,000 back, bill ₹50,000 due again.
--   D. An advance bigger than the bill settles it: paid by advance, ₹10,000 advance left;
--      undo puts it back.
--   E. B3 — Prepaid → Book invoice with the bill number of a bill already on the Expenses page →
--      refused (sentence says Apply advance), no second expense row.
--   F. B2 on the Prepaid page — a ₹50,000 invoice against a ₹30,000 advance → ONE unpaid bill of
--      ₹50,000 with ₹30,000 applied, returns −20,000 (still due).
--   G. F5 — an advance whose vendor name differs from the vendor's name (renamed) is still found by
--      vendor_id.
--   H. Guards: no advance; more than due; another company's bill; a sales user; no company;
--      a COGS bill; cutting the bill's amount below the advance; deleting the bill gives the
--      advance back; un-reconciling the advance's bank line says where to undo.

begin;

create function pg_temp.r1913_fill_supplier() returns trigger language plpgsql as $f$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street');
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := '07AAACT1643F1Z5';
  end if;
  return new;
end $f$;
create trigger zz_r1913_supplier before insert on public.tenants for each row execute function pg_temp.r1913_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000191301','R1913 Co','r1913@example.in','07','R1913'),
  ('dddddddd-0000-0000-0000-000000191302','R1913 Other Co','r1913b@example.in','07','R1913B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000191301','owner1913@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000191302','sales1913@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000191303','owner1913b@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000191301','dddddddd-0000-0000-0000-000000191301','owner1913@example.in','Owner 1913','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000191302','dddddddd-0000-0000-0000-000000191301','sales1913@example.in','Sales 1913','sales', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000191303','dddddddd-0000-0000-0000-000000191302','owner1913b@example.in','Owner 1913B','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000191301','dddddddd-0000-0000-0000-000000191301','HDFC Current','HDFC');
insert into public.vendors (id, tenant_id, name, gstin, pan, default_category) values
  ('eeeeeeee-0000-0000-0000-000000191301','dddddddd-0000-0000-0000-000000191301','Verma Contractors','07AAKFV1913A1Z5','AAKFV1913A','Repairs & Maintenance'),
  ('eeeeeeee-0000-0000-0000-000000191302','dddddddd-0000-0000-0000-000000191301','Sharma Associates','07AAKFS1913A1Z5','AAKFS1913A','Professional Services'),
  ('eeeeeeee-0000-0000-0000-000000191303','dddddddd-0000-0000-0000-000000191301','Gupta Printers','07AAKFG1913A1Z5','AAKFG1913A','Printing & Stationery'),
  ('eeeeeeee-0000-0000-0000-000000191304','dddddddd-0000-0000-0000-000000191301','Google Cloud India','29AACCG1913B1Z9','AACCG1913B','COGS-Workspace');

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000191301','dddddddd-0000-0000-0000-000000191301','bbbbbbbb-0000-0000-0000-000000191301','2026-10-01','IMPS VERMA CONTRACTORS ADV',30000,0,'I1','csv_upload'),
  ('11111111-0000-0000-0000-000000191302','dddddddd-0000-0000-0000-000000191301','bbbbbbbb-0000-0000-0000-000000191301','2026-10-21','IMPS VERMA CONTRACTORS VC-1',20000,0,'I2','csv_upload'),
  ('11111111-0000-0000-0000-000000191303','dddddddd-0000-0000-0000-000000191301','bbbbbbbb-0000-0000-0000-000000191301','2026-10-02','IMPS SHARMA ASSOCIATES ADV',30000,0,'I3','csv_upload');

-- Owner 1913 signs in.
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000191301","role":"authenticated"}', true);

-- Verma: ₹30,000 advance from the bank (Banking → Record payment, no bills).
select public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191301','eeeeeeee-0000-0000-0000-000000191301', null, '[]'::jsonb, null, 30000, 'Repairs & Maintenance');
-- Verma's ₹50,000 bill VC-1 recorded on the Expenses page, unpaid.
insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, bill_type, bill_no, paid, payment_method) values
  ('EXP-R1913-VC1','dddddddd-0000-0000-0000-000000191301','Repairs & Maintenance','Verma Contractors','eeeeeeee-0000-0000-0000-000000191301','2026-10-18',50000,0,'none','VC-1',false,null);

-- ── A. B2: apply the ₹30,000 advance to the ₹50,000 bill ─────────────────────────────────────
do $$
declare r jsonb; v_due int; v_left int; n_exp int; v_pay bigint; v_pre bigint; v_applied int;
begin
  r := public.apply_vendor_advance('expense', 'EXP-R1913-VC1');
  if (r->>'applied')::int <> 30000 or (r->>'still_due')::int <> 20000 or (r->>'advance_left')::int <> 0 or (r->>'settled')::boolean then
    raise exception 'A FAIL: apply_vendor_advance returned %', r;
  end if;
  select amount_due into v_due from public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000191301') where doc_id = 'EXP-R1913-VC1';
  if v_due is distinct from 20000 then raise exception 'A FAIL: open item due % (want 20000)', v_due; end if;
  select sum(total_amount - consumed_amount) into v_left from public.prepaid_advances where tenant_id = 'dddddddd-0000-0000-0000-000000191301' and vendor_id = 'eeeeeeee-0000-0000-0000-000000191301';
  if v_left <> 0 then raise exception 'A FAIL: advance left % (want 0)', v_left; end if;
  select count(*) into n_exp from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000191301' and vendor_id = 'eeeeeeee-0000-0000-0000-000000191301';
  if n_exp <> 1 then raise exception 'A FAIL: % expense rows for Verma (want 1 — no second cost row)', n_exp; end if;
  select paid::int, advance_applied into n_exp, v_applied from public.expenses where id = 'EXP-R1913-VC1';
  if n_exp <> 0 or v_applied <> 30000 then raise exception 'A FAIL: bill paid=% applied=%', n_exp, v_applied; end if;
  select expenses_payable, prepaid_advances into v_pay, v_pre from public.report_balance_sheet();
  if v_pay <> 20000 or v_pre <> 0 then raise exception 'A FAIL: Balance Sheet expenses payable % prepaid % (want 20000 / 0)', v_pay, v_pre; end if;
  raise notice 'A ok: ₹30,000 advance on the ₹50,000 bill — ₹20,000 due, one expense row, BS payable 20000, prepaid 0';
end $$;

-- ── B. The ₹20,000 bank line pays the rest; un-reconcile reopens it ──────────────────────────
do $$
declare r jsonb; v_paid boolean; v_due int; msg text;
begin
  begin
    perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191302','eeeeeeee-0000-0000-0000-000000191301', null,
      '[{"source":"expense","doc_id":"EXP-R1913-VC1","amount":50000,"tds_amount":0}]'::jsonb);
    raise exception 'B FAIL: paying the whole ₹50,000 again was accepted';
  exception when others then msg := sqlerrm; end;
  if msg not like '%₹20000 left to pay after the advance%' then raise exception 'B FAIL: wrong refusal: %', msg; end if;
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191302','eeeeeeee-0000-0000-0000-000000191301', null,
      '[{"source":"expense","doc_id":"EXP-R1913-VC1","amount":20000,"tds_amount":0}]'::jsonb);
  select paid into v_paid from public.expenses where id = 'EXP-R1913-VC1';
  if not v_paid then raise exception 'B FAIL: bill not paid after the ₹20,000 line'; end if;
  begin
    perform public.undo_vendor_advance('EXP-R1913-VC1');
    raise exception 'B FAIL: undo of the advance accepted while a bank line paid the rest';
  exception when others then msg := sqlerrm; end;
  if msg not like '%un-reconcile that line first%' then raise exception 'B FAIL: wrong refusal: %', msg; end if;
  update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = '11111111-0000-0000-0000-000000191302';
  select amount_due into v_due from public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000191301') where doc_id = 'EXP-R1913-VC1';
  if v_due is distinct from 20000 then raise exception 'B FAIL: after un-reconcile due % (want 20000)', v_due; end if;
  raise notice 'B ok: bank line pays the ₹20,000 left (not ₹50,000); un-reconcile reopens ₹20,000';
end $$;

-- ── C. Undo the advance ──────────────────────────────────────────────────────────────────────
do $$
declare r jsonb; v_left int; v_due int; v_applied int; n int;
begin
  r := public.undo_vendor_advance('EXP-R1913-VC1');
  if (r->>'given_back')::int <> 30000 then raise exception 'C FAIL: %', r; end if;
  select sum(total_amount - consumed_amount) into v_left from public.prepaid_advances where vendor_id = 'eeeeeeee-0000-0000-0000-000000191301';
  select amount_due into v_due from public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000191301') where doc_id = 'EXP-R1913-VC1';
  select advance_applied into v_applied from public.expenses where id = 'EXP-R1913-VC1';
  select count(*) into n from public.vendor_advance_applications where expense_id = 'EXP-R1913-VC1';
  if v_left <> 30000 or v_due <> 50000 or v_applied <> 0 or n <> 0 then
    raise exception 'C FAIL: left % due % applied % rows %', v_left, v_due, v_applied, n;
  end if;
  raise notice 'C ok: undo gives the ₹30,000 back, bill ₹50,000 due again';
end $$;

-- ── D. Advance bigger than the bill settles it ───────────────────────────────────────────────
insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, bill_type, bill_no, paid, payment_method) values
  ('EXP-R1913-VC2','dddddddd-0000-0000-0000-000000191301','Repairs & Maintenance','Verma Contractors','eeeeeeee-0000-0000-0000-000000191301','2026-10-19',20000,0,'none','VC-2',false,null);
do $$
declare r jsonb; e public.expenses; n int; v_pay bigint;
begin
  r := public.apply_vendor_advance('expense', 'EXP-R1913-VC2', null, '2026-10-20');
  select * into e from public.expenses where id = 'EXP-R1913-VC2';
  if not e.paid or e.payment_method <> 'advance' or e.paid_date <> '2026-10-20' or (r->>'advance_left')::int <> 10000 then
    raise exception 'D FAIL: paid % method % date % left %', e.paid, e.payment_method, e.paid_date, r->>'advance_left';
  end if;
  select count(*) into n from public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000191301') where doc_id = 'EXP-R1913-VC2';
  if n <> 0 then raise exception 'D FAIL: a bill settled by the advance is still an open item (or a recorded payment)'; end if;
  select expenses_payable into v_pay from public.report_balance_sheet();
  if v_pay <> 50000 then raise exception 'D FAIL: BS expenses payable % (want 50000 = VC-1 only)', v_pay; end if;
  r := public.undo_vendor_advance('EXP-R1913-VC2');
  select * into e from public.expenses where id = 'EXP-R1913-VC2';
  if e.paid or e.payment_method is not null or e.paid_date is not null or e.advance_applied <> 0 then
    raise exception 'D FAIL: undo left paid % method % date %', e.paid, e.payment_method, e.paid_date;
  end if;
  raise notice 'D ok: ₹30,000 advance settles the ₹20,000 bill (paid by advance, ₹10,000 left); undo reopens it';
end $$;

-- ── E. B3: Prepaid → Book invoice of a bill already on the Expenses page ─────────────────────
do $$
declare msg text; n int;
begin
  begin
    perform public.consume_prepaid_fifo('Verma Contractors', 20000, 0, '2026-10-20', null, null, 'eeeeeeee-0000-0000-0000-000000191301', 'vc-2');
    raise exception 'E FAIL: the recorded bill VC-2 was booked a second time from the advance';
  exception when others then msg := sqlerrm; end;
  if msg not like '%VC-2%already on the Expenses page%Apply advance%' then raise exception 'E FAIL: wrong refusal: %', msg; end if;
  select count(*) into n from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000191301' and upper(bill_no) = 'VC-2';
  if n <> 1 then raise exception 'E FAIL: % rows for VC-2', n; end if;
  raise notice 'E ok: B3 refused — "%"', msg;
end $$;

-- ── F. B2 on the Prepaid page: ₹50,000 invoice, ₹30,000 advance ──────────────────────────────
do $$
declare v_ret int; e public.expenses; n int; v_left int;
begin
  v_ret := public.consume_prepaid_fifo('Verma Contractors', 50000, 0, '2026-10-22', null, null, 'eeeeeeee-0000-0000-0000-000000191301', 'VC-3');
  if v_ret <> -20000 then raise exception 'F FAIL: returned % (want -20000 = ₹20,000 still due)', v_ret; end if;
  select count(*) into n from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000191301' and bill_no = 'VC-3';
  select * into e from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000191301' and bill_no = 'VC-3';
  if n <> 1 or e.amount <> 50000 or e.advance_applied <> 30000 or e.paid or e.prepaid_advance_id is not null then
    raise exception 'F FAIL: rows % amount % applied % paid %', n, e.amount, e.advance_applied, e.paid;
  end if;
  select sum(total_amount - consumed_amount) into v_left from public.prepaid_advances where vendor_id = 'eeeeeeee-0000-0000-0000-000000191301';
  if v_left <> 0 then raise exception 'F FAIL: advance left %', v_left; end if;
  raise notice 'F ok: ₹50,000 invoice on a ₹30,000 advance → one bill, ₹30,000 applied, ₹20,000 due';
end $$;

-- ── G. F5: a renamed vendor's advance is found by vendor_id ──────────────────────────────────
select public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191303','eeeeeeee-0000-0000-0000-000000191302', null, '[]'::jsonb, null, 30000, 'Professional Services');
update public.prepaid_advances set vendor_name = 'Sharma & Associates (old name)' where vendor_id = 'eeeeeeee-0000-0000-0000-000000191302';
insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, bill_type, bill_no, paid, payment_method, tds_amount, tds_section) values
  ('EXP-R1913-PS1','dddddddd-0000-0000-0000-000000191301','Professional Services','Sharma Associates','eeeeeeee-0000-0000-0000-000000191302','2026-10-10',59000,9000,'gst','PS-1',false,null,5000,'194J');
do $$
declare r jsonb; v int; msg text;
begin
  -- the Prepaid page by the vendor id, with the advance under its old name: ₹1,000 invoice drawn from it
  v := public.consume_prepaid_fifo('Sharma Associates', 1000, 0, '2026-10-22', null, null, 'eeeeeeee-0000-0000-0000-000000191302', 'PS-9');
  if v <> 29000 then raise exception 'G FAIL: consume by vendor id returned % (want 29000 left)', v; end if;
  r := public.apply_vendor_advance('expense', 'EXP-R1913-PS1');
  if (r->>'applied')::int <> 29000 or (r->>'still_due')::int <> 25000 then raise exception 'G FAIL: %', r; end if;
  raise notice 'G ok: the renamed vendor''s advance is found by vendor id (₹59,000 bill − TDS ₹5,000 − ₹29,000 = ₹25,000 due)';
end $$;

-- ── H. Guards ────────────────────────────────────────────────────────────────────────────────
insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, bill_type, bill_no, paid, payment_method) values
  ('EXP-R1913-GP1','dddddddd-0000-0000-0000-000000191301','Printing & Stationery','Gupta Printers','eeeeeeee-0000-0000-0000-000000191303','2026-10-10',5000,0,'none','GP-1',false,null),
  ('EXP-R1913-OTH','dddddddd-0000-0000-0000-000000191302','Repairs & Maintenance','Verma Contractors',null,'2026-10-10',5000,0,'none','X-1',false,null);
do $$
declare msg text; v_left int; n int;
begin
  -- no advance with Gupta
  begin perform public.apply_vendor_advance('expense', 'EXP-R1913-GP1'); msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like 'No advance is left with Gupta Printers%' then raise exception 'H FAIL no-advance: %', msg; end if;
  -- another company's bill
  begin perform public.apply_vendor_advance('expense', 'EXP-R1913-OTH'); msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%not found in your company%' then raise exception 'H FAIL other company: %', msg; end if;
  -- a COGS bill
  begin perform public.apply_vendor_advance('vendor_bill', 'BILL-X'); msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%COGS%' then raise exception 'H FAIL cogs: %', msg; end if;
  -- PS-1: ₹24,000 due, no advance left → more than due / no advance
  begin perform public.apply_vendor_advance('expense', 'EXP-R1913-PS1', 25000); msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%No advance is left%' and coalesce(msg, '') not like '%apply at most%' then raise exception 'H FAIL more than due: %', msg; end if;
  -- cutting PS-1 below the advance applied
  begin update public.expenses set amount = 20000 where id = 'EXP-R1913-PS1'; msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%undo the advance on it first%' then raise exception 'H FAIL amount cut: %', msg; end if;
  -- un-reconciling Sharma's advance line while it is used
  begin update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = '11111111-0000-0000-0000-000000191303'; msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%Undo advance%' then raise exception 'H FAIL unreconcile advance: %', msg; end if;
  -- deleting PS-1 gives Sharma's ₹29,000 back
  delete from public.expenses where id = 'EXP-R1913-PS1';
  select sum(total_amount - consumed_amount) into v_left from public.prepaid_advances where vendor_id = 'eeeeeeee-0000-0000-0000-000000191302';
  select count(*) into n from public.vendor_advance_applications where expense_id = 'EXP-R1913-PS1';
  if v_left <> 29000 or n <> 0 then raise exception 'H FAIL delete: left % rows %', v_left, n; end if;
  raise notice 'H ok: guards (no advance, other company, COGS, more than due, amount cut, un-reconcile, delete gives back)';
end $$;

-- a sales user cannot apply; a login with no company cannot
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000191302","role":"authenticated"}', true);
do $$
declare msg text;
begin
  begin perform public.apply_vendor_advance('expense', 'EXP-R1913-GP1'); msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like 'Only an owner, manager, accountant or billing user%' then raise exception 'H FAIL sales role: %', msg; end if;
  begin perform public.undo_vendor_advance('EXP-R1913-VC1'); msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like 'Only an owner, manager, accountant or billing user%' then raise exception 'H FAIL sales undo: %', msg; end if;
end $$;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000199999","role":"authenticated"}', true);
do $$
declare msg text;
begin
  begin perform public.apply_vendor_advance('expense', 'EXP-R1913-GP1'); msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like 'No company on this login%' then raise exception 'H FAIL no company: %', msg; end if;
  raise notice 'H ok: sales user and a login with no company are refused';
end $$;

rollback;
