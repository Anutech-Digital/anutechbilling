-- R-1575 (with R-1569): a REPLACED (superseded_by) or REJECTED quote takes no payment and no
-- invoice (migration 20261018165435_r1575_closed_quote_guard). Self-asserting; rolled back.
--
--   Q-CQ-OLD  accepted, then combined into Q-CQ-NEW (expired + superseded_by)
--   Q-CQ-NEW  the combined quote — live
--   Q-CQ-REJ  rejected
--
-- Proves:
--   A. record_payment on the replaced quote is refused, naming the replacing quote; nothing written.
--   B. record_payment on the replacing quote works (the path the webhook now takes).
--   C. record_payment on a rejected quote is refused with the Reopen next step.
--   D. generate_invoice on the replaced quote is refused, naming the replacing quote;
--      linking an invoice to the rejected quote is refused too.
--   E. generate_invoice on the live, paid quote still works.
--   F. a refused desk payment through record_payment_with_tds is refused the same way.

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
  values ('eeeeeeee-0000-0000-0000-000000001575','CQ TEST','cq@example.in','07','CQT1');
insert into public.quotes (id, tenant_id, customer_name, amount, subtotal, seats, tax_rate, status, payment_status, prospect_state_code, prospect_state, is_one_off)
  values ('Q-CQ-NEW','eeeeeeee-0000-0000-0000-000000001575','Gupta Co',2360,2000,1,18,'accepted','none','07','Delhi',true),
         ('Q-CQ-OLD','eeeeeeee-0000-0000-0000-000000001575','Gupta Co',1180,1000,1,18,'expired','none','07','Delhi',true),
         ('Q-CQ-REJ','eeeeeeee-0000-0000-0000-000000001575','Gupta Co',1180,1000,1,18,'rejected','none','07','Delhi',true);
insert into public.customers (id, tenant_id, name, contact_email, state_code, state, since, health)
  values ('eeeeeeee-0000-0000-0000-00000000c575','eeeeeeee-0000-0000-0000-000000001575','Gupta Co','gupta@example.in','07','Delhi',current_date,80);
update public.quotes set customer_id = 'eeeeeeee-0000-0000-0000-00000000c575'
 where tenant_id = 'eeeeeeee-0000-0000-0000-000000001575';
update public.quotes set superseded_by = 'Q-CQ-NEW', superseded_at = now() where id = 'Q-CQ-OLD';

do $$
declare v_msg text; v_n int; v_r jsonb; v_inv text;
begin
  -- A. replaced quote: refused, names the new quote, writes nothing
  begin
    perform public.record_payment('Q-CQ-OLD', 1180, 'razorpay', 'pay_CQ_OLD', 'old checkout');
    raise exception 'A FAILED: payment on a replaced quote was accepted';
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like '%replaced by Q-CQ-NEW%' or v_msg not like '%Record this payment on quote Q-CQ-NEW%' then
      raise exception 'A FAILED: wrong message: %', v_msg;
    end if;
  end;
  select count(*) into v_n from public.payments where quote_id = 'Q-CQ-OLD';
  if v_n <> 0 then raise exception 'A FAILED: % payment rows on the replaced quote', v_n; end if;
  if (select payment_status::text from public.quotes where id = 'Q-CQ-OLD') <> 'none' then
    raise exception 'A FAILED: replaced quote payment_status moved';
  end if;
  raise notice 'A ok — %', v_msg;

  -- B. the replacing quote takes it
  v_r := public.record_payment('Q-CQ-NEW', 1180, 'razorpay', 'pay_CQ_OLD', 'paid on replaced quote Q-CQ-OLD');
  if (v_r->>'payment_id') is null then raise exception 'B FAILED: %', v_r; end if;
  if (select payment_status::text from public.quotes where id = 'Q-CQ-NEW') <> 'partial' then
    raise exception 'B FAILED: new quote not partial';
  end if;
  raise notice 'B ok';

  -- C. rejected quote
  begin
    perform public.record_payment('Q-CQ-REJ', 1180, 'bank_transfer', 'NEFT-CQ-1', null);
    raise exception 'C FAILED: payment on a rejected quote was accepted';
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like '%was rejected%' or v_msg not like '%Reopen%' then
      raise exception 'C FAILED: wrong message: %', v_msg;
    end if;
  end;
  raise notice 'C ok — %', v_msg;

  -- D. no invoice on the replaced quote, none linked to the rejected one
  begin
    perform public.generate_invoice('Q-CQ-OLD');
    raise exception 'D FAILED: invoice issued on a replaced quote';
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like '%Issue the invoice from quote Q-CQ-NEW%' then
      raise exception 'D FAILED: wrong message: %', v_msg;
    end if;
  end;
  select count(*) into v_n from public.invoices where tenant_id = 'eeeeeeee-0000-0000-0000-000000001575';
  if v_n <> 0 then raise exception 'D FAILED: % invoice rows left behind', v_n; end if;
  begin
    update public.quotes set invoice_id = 'INV-CQ-X' where id = 'Q-CQ-REJ';
    raise exception 'D FAILED: invoice linked to a rejected quote';
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like '%was rejected%' then raise exception 'D FAILED: wrong message: %', v_msg; end if;
  end;
  raise notice 'D ok';

  -- E. the live quote still invoices
  v_r := public.record_payment('Q-CQ-NEW', 1180, 'bank_transfer', 'NEFT-CQ-2', null);
  select gi.invoice_id into v_inv from public.generate_invoice('Q-CQ-NEW') gi;
  if v_inv is null then raise exception 'E FAILED: no invoice on the live quote'; end if;
  raise notice 'E ok — %', v_inv;

  -- F. the TDS wrapper goes through the same row guard
  begin
    perform public.record_payment_with_tds('Q-CQ-OLD', 1180, 'bank_transfer', 'NEFT-CQ-TDS', null, 100, 1000, 1080, '194J', 10, null, null, null);
    raise exception 'F FAILED: TDS payment on a replaced quote was accepted';
  exception when check_violation then
    null;
  end;
  raise notice 'F ok';
end $$;

rollback;
