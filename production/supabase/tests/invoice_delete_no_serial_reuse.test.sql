-- Regression test: deleting an invoice must NOT reuse its GST serial (MONEY-3, migration 0118).
-- Self-asserting; rolled back:  psql "$DATABASE_URL" -f invoice_delete_no_serial_reuse.test.sql
--
-- Proves the document-series counter is NOT rolled back on delete, so the next
-- invoice takes a FRESH number (a deleted number is retired, never reissued —
-- CGST Rule 46 forbids two supplies sharing one invoice number).
--
-- ── CHANGED 29 Sep 2026 (R-014), and why this is not "fixing the test to match the
--    code" (AGENTS.md L8) ─────────────────────────────────────────────────────────
-- This file used to call `delete_subscription_invoice` on a freshly ISSUED invoice.
-- Migration 20260929130000 now refuses exactly that, deliberately: an issued invoice is
-- corrected with a credit note, not deleted. The claim this file exists to make —
-- "removing an invoice does NOT free its number" — is unchanged and still worth pinning,
-- so it is now made through the one route that legitimately removes an issued invoice:
-- the reviewed, transaction-scoped `app.invoice_amend_reason` escape hatch.
--
-- The two facts are complementary rather than in conflict. R-014 says a deleted number
-- never comes back, which is the REASON deleting an issued invoice is refused; this file
-- is the proof of that premise. If it ever goes green with the counter rolled back, R-014's
-- refusal message is a lie and both need revisiting.

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
  values ('aaaa4444-0000-0000-0000-000000000004','DEL TEST','d@example.in','07','DELT');
insert into public.customers (id, tenant_id, name, state_code)
  values ('bbbb4444-0000-0000-0000-000000000004','aaaa4444-0000-0000-0000-000000000004','Cust Del','07');
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('aaaa4444-0000-0000-0000-000000000004','invoice', public.indian_fiscal_year(current_date), 'INV', 5);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
  values ('Q-DEL-TEST','aaaa4444-0000-0000-0000-000000000004','bbbb4444-0000-0000-0000-000000000004','Cust Del',
          118000, 100000, 18, 'sent', 'awaiting', '[]'::jsonb);
do $$
declare v_inv text; v_after_gen int; v_after_del int; v_next text;
begin
  select invoice_id into v_inv from public.generate_invoice('Q-DEL-TEST');
  select last_number into v_after_gen from public.document_series
   where tenant_id='aaaa4444-0000-0000-0000-000000000004' and doc_type='invoice';
  /* R-014: the RPC refuses an issued invoice now (correctly). The stated-reason hatch is
     the reviewed-maintenance route, and it is what this assertion needs — the question is
     what the COUNTER does when a row goes, not which door the row went through. */
  perform set_config('app.invoice_amend_reason', 'serial-reuse regression test', true);
  perform public.delete_subscription_invoice(v_inv);
  perform set_config('app.invoice_amend_reason', '', true);
  select last_number into v_after_del from public.document_series
   where tenant_id='aaaa4444-0000-0000-0000-000000000004' and doc_type='invoice';
  if v_after_gen <> 6 then raise exception 'FAIL: series after gen expected 6, got %', v_after_gen; end if;
  if v_after_del <> 6 then raise exception 'FAIL: series ROLLED BACK to % — serial-reuse bug present', v_after_del; end if;
  update public.quotes set invoice_id=null, payment_status='awaiting' where id='Q-DEL-TEST';
  select invoice_id into v_next from public.generate_invoice('Q-DEL-TEST');
  if v_next not like '%0007' then raise exception 'FAIL: next invoice reused a number: %', v_next; end if;
  raise notice 'PASS: deleted %, series stayed 6, next = % (no reuse)', v_inv, v_next;
end $$;
rollback;
