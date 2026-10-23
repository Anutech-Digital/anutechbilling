-- A milestone invoice is dated the day it is issued (R-003, 26 Sep 2026).
--
-- WHAT IT PROVES
--   1. Two milestones invoiced in one session, whose payments arrived MONTHS apart and
--      out of order, produce invoice numbers and invoice dates that run the same way.
--      Before this change the second one carried the earlier payment's date, so a
--      higher number could sit under an earlier date — which is what a back-dated
--      invoice looks like under CGST Rule 46, and how GSTR-1 would list it.
--   2. `paid_date` still holds the REAL receipt date. Forcing both columns to today
--      would have fixed the series and broken the ledger, which is the more expensive
--      half: it would say the money arrived when the paperwork did.
--   3. `due_date` never lands before the invoice date.
--
-- The fixture owns its data (L11) and rolls back.
-- R-1616 (19 Oct 2026): "today" is public.ist_today(), the day raise_project_milestone_invoice
-- stamps (R-1581: a document day is the IST day). It used current_date (UTC in the DB),
-- so the test failed every night between 00:00 and 05:30 IST.
begin;

-- R-1643 / R-1803: issuing a Tax Invoice (also instalment + project invoices) needs the company's own GSTIN + address (supplier_invoice_problem).
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


insert into public.tenants (id, name, email)
values ('dd000003-0000-4000-8000-000000000003', 'R003 Test Tenant', 'r003@test.invalid')
on conflict (id) do nothing;

insert into public.project_sales (id, tenant_id, customer_name, title, taxable_amount, gst_amount, total_amount, gst_rate, status)
values ('dd000003-0000-4000-8000-0000000000a1', 'dd000003-0000-4000-8000-000000000003',
        'R003 Customer', 'R003 ERP build', 200000, 36000, 236000, 18, 'active');

-- Two milestones. The one invoiced SECOND was paid EARLIER — the exact ordering that
-- produced INV-…0003 dated before INV-…0002 on Pardeep's machine.
insert into public.project_milestones (id, tenant_id, project_id, label, total_amount, seq)
values
  ('dd000003-0000-4000-8000-0000000000b1', 'dd000003-0000-4000-8000-000000000003',
   'dd000003-0000-4000-8000-0000000000a1', 'Phase 1', 118000, 1),
  ('dd000003-0000-4000-8000-0000000000b2', 'dd000003-0000-4000-8000-000000000003',
   'dd000003-0000-4000-8000-0000000000a1', 'Phase 2', 118000, 2);

insert into public.project_payments (tenant_id, project_id, milestone_id, amount, received_at)
values
  ('dd000003-0000-4000-8000-000000000003', 'dd000003-0000-4000-8000-0000000000a1',
   'dd000003-0000-4000-8000-0000000000b1', 118000, date '2026-08-07'),
  ('dd000003-0000-4000-8000-000000000003', 'dd000003-0000-4000-8000-0000000000a1',
   'dd000003-0000-4000-8000-0000000000b2', 118000, date '2026-07-08');

do $$
declare
  v_first   text;
  v_second  text;
  v_d1      date;
  v_d2      date;
  v_paid2   date;
  v_due1    date;
begin
  -- Raised in milestone order; their payments are in the opposite order.
  v_first  := public.raise_project_milestone_invoice('dd000003-0000-4000-8000-0000000000b1');
  v_second := public.raise_project_milestone_invoice('dd000003-0000-4000-8000-0000000000b2');

  select invoice_date, due_date into v_d1, v_due1 from public.invoices where id = v_first;
  select invoice_date, paid_date into v_d2, v_paid2 from public.invoices where id = v_second;

  -- 1. The later number must not carry the earlier date.
  if v_second <= v_first then
    raise exception 'SETUP FAIL: the second invoice number % is not after the first % — the series is not doing what this test assumes', v_second, v_first;
  end if;
  if v_d2 < v_d1 then
    raise exception 'FAIL 1: % is dated % but the earlier % is dated % — a higher number with an earlier date', v_second, v_d2, v_first, v_d1;
  end if;
  if v_d1 <> public.ist_today() or v_d2 <> public.ist_today() then
    raise exception 'FAIL 1b: invoices are dated % and %, not today IST (%) — something is still dating them from the payment', v_d1, v_d2, public.ist_today();
  end if;

  -- 2. The money keeps its own date. This is the half a blunter fix would have lost.
  if v_paid2 is distinct from date '2026-07-08' then
    raise exception 'FAIL 2: paid_date is % — the real receipt date (8 Jul 2026) was overwritten with the document date', v_paid2;
  end if;

  -- 3. Due date cannot precede the invoice.
  if v_due1 < v_d1 then
    raise exception 'FAIL 3: due_date % is before invoice_date %', v_due1, v_d1;
  end if;

  raise notice 'PASS: both invoices dated today, numbers and dates run the same way, and the 8 Jul receipt kept its date';
end $$;

rollback;
