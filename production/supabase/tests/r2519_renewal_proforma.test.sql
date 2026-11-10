-- R-2519 (Pardeep, 6 Nov 2026 — "Zoho ki tarah proforma bhejna"; staging BITDECENTRO Q-A378-27-0947):
-- a renewal part's payment request is a Proforma Invoice like Zoho's PI/26-27/1296 (18 × ₹300).
-- Migration 20261106065103_r2519_renewal_proforma.
-- Self-asserting, ONE transaction, rolled back. Run on a dev/test DB only.
--
-- Monthly (flexible) subscription, 17 seats at ₹300 = ₹5,100 a month, its part began 5 days ago
-- and was not billed yet (billed late, like BITDECENTRO's 12 Oct part on 6 Nov).
--   A. Bill the part             → PI- number (own series), line 17 × ₹300 (per seat, with the period),
--                                  ₹6,018 with 18% GST, due TODAY (not the past part start) — notes agree.
--   B. Preview change 17 → 18     → set_part_request_terms: 18 × ₹300, ₹6,372; the subscription is NOT
--                                  changed yet (17 seats, ₹5,100).
--   C. Pay ₹6,372                 → tax invoice ₹6,372 raised at once; subscription 18 seats, MRR ₹5,400
--                                  (contract amendment logged); the part's taxable ₹5,400.
--   D. Change after payment       → refused.
--   E. Accepting a changed proforma puts its seats on too (trigger).
--   F. Cancel a proforma          → kept (status rejected + cancelled_at, reason, payment_status none),
--                                  subscription untouched, activity logged, the part can be billed again.
--   G. Undo while a NEW proforma holds the part → refused; after that one is cancelled → undone
--      (status sent, awaiting, part link back).
--   H. Cancel refused: money received / invoice raised; reason too short; another company.
--   I. An ordinary quote: cancel → undo puts status + payment status back.
--   J. As the company's OWNER (RLS / role path): change + cancel work; a sales user is refused.

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
  ('dddddddd-0000-0000-0000-000000251901','R2519 Co','r2519@example.in','07','RB19'),
  ('dddddddd-0000-0000-0000-000000251902','R2519 Other','r2519o@example.in','07','RB20');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000251901','owner2519@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000251902','sales2519@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000251901','dddddddd-0000-0000-0000-000000251901','owner2519@example.in','Owner 2519','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000251902','dddddddd-0000-0000-0000-000000251901','sales2519@example.in','Sales 2519','sales', now() - interval '1 day');

-- Inter-state customer (IGST 18%), no payment terms (prepaid).
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('cccccccc-0000-0000-0000-000000251901','dddddddd-0000-0000-0000-000000251901','Bitdecentro 2519','27','India');

-- Subscriptions 1..4: monthly flexible, 17 seats, ₹5,100 a month, no sale quote (renewal parts only).
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                                  billing_cycle, term_months, start_date, renewal_date, status, domain)
select ('eeeeeeee-0000-0000-0000-00000025190' || n)::uuid, 'dddddddd-0000-0000-0000-000000251901',
       'cccccccc-0000-0000-0000-000000251901', 'Bitdecentro 2519', 'Google Workspace Business Starter', 'google'::vendor,
       17, 5100, 'monthly'::billing_cycle, 1, public.ist_today() - 35, public.ist_today() + 25, 'active', 'bit' || n || '.in'
  from generate_series(1, 4) n;

-- Each one's current part: began 5 days ago, not billed yet.
insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                          period_start, period_end, taxable_amount, tax_rate)
select ('bbbbbbbb-0000-0000-0000-00000025190' || n)::uuid, 'dddddddd-0000-0000-0000-000000251901',
       ('eeeeeeee-0000-0000-0000-00000025190' || n)::uuid,
       public.ist_today() - 5, 1, public.ist_today() - 5, public.ist_today() - 5, public.ist_today() + 25, 5100, 18
  from generate_series(1, 4) n;

-- 5: a part that starts in 6 days (billed ahead, for G2); 6: a sale quote's own subscription (for K).
insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount, subtotal, status, payment_status, line_items, billing_cycle)
values ('TESTQ-R2519-SALE2', 'dddddddd-0000-0000-0000-000000251901', 'Bitdecentro 2519', 'cccccccc-0000-0000-0000-000000251901',
        18, 6018, 5100, 'sent', 'awaiting', '[{"name":"Google Workspace Business Starter","qty":17,"rate":300,"commitment":"flex_monthly"}]'::jsonb, 'monthly');
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                                  billing_cycle, term_months, start_date, renewal_date, status, domain, quote_id)
select ('eeeeeeee-0000-0000-0000-00000025190' || n)::uuid, 'dddddddd-0000-0000-0000-000000251901',
       'cccccccc-0000-0000-0000-000000251901', 'Bitdecentro 2519', 'Google Workspace Business Starter', 'google'::vendor,
       17, 5100, 'monthly'::billing_cycle, 1, public.ist_today() - 35, public.ist_today() + 25, 'active', 'bit' || n || '.in',
       case n when 6 then 'TESTQ-R2519-SALE2' end
  from generate_series(5, 6) n;
insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                          period_start, period_end, taxable_amount, tax_rate)
values ('bbbbbbbb-0000-0000-0000-000000251905', 'dddddddd-0000-0000-0000-000000251901', 'eeeeeeee-0000-0000-0000-000000251905',
        public.ist_today() + 6, 1, public.ist_today() + 6, public.ist_today() + 6, public.ist_today() + 36, 5100, 18),
       ('bbbbbbbb-0000-0000-0000-000000251906', 'dddddddd-0000-0000-0000-000000251901', 'eeeeeeee-0000-0000-0000-000000251906',
        public.ist_today() - 5, 1, public.ist_today() - 5, public.ist_today() - 5, public.ist_today() + 25, 5100, 18);

-- An ordinary sales quote (for I).
insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount, subtotal, status, payment_status, line_items)
values ('TESTQ-R2519-SALE', 'dddddddd-0000-0000-0000-000000251901', 'Bitdecentro 2519', 'cccccccc-0000-0000-0000-000000251901',
        18, 1180, 1000, 'sent', 'awaiting', '[{"name":"Setup","qty":1,"rate":1000}]'::jsonb);

do $$
declare
  r jsonb; v_q record; v_id text; v_id2 text; v_id3 text; v_inv text; v_i record; v_s record; v_n int; v_line jsonb;
begin
  -- A. the part → a Proforma Invoice
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000251901', false);
  if r->>'action' <> 'request' then raise exception 'A FAIL: %', r; end if;
  v_id := r->>'quote_id';
  if v_id not like 'PI-RB19-%' then raise exception 'A FAIL: number % is not from the PI series', v_id; end if;
  if not exists (select 1 from public.document_series where tenant_id = 'dddddddd-0000-0000-0000-000000251901' and doc_type = 'proforma') then
    raise exception 'A FAIL: no proforma series row'; end if;
  select q.* into v_q from public.quotes q where q.id = v_id;
  v_line := v_q.line_items->0;
  if (v_line->>'qty')::int <> 17 or (v_line->>'rate')::int <> 300 or (v_line->>'per_seat')::boolean is not true
     or (v_line->>'period_start')::date <> public.ist_today() - 5 or (v_line->>'period_end')::date <> public.ist_today() + 24
     or v_line->>'name' not like 'Google Workspace Business Starter · bit1.in · 17 seats · %' then
    raise exception 'A FAIL: line %', v_line; end if;
  if v_q.subtotal <> 5100 or v_q.amount <> 6018 or v_q.status::text <> 'sent' then
    raise exception 'A FAIL: subtotal % amount % status %', v_q.subtotal, v_q.amount, v_q.status; end if;
  if (select due_on from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000251901') <> public.ist_today() then
    raise exception 'A FAIL: due_on % (want today — billed late)', (select due_on from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000251901'); end if;
  if v_q.notes not like '%Due on ' || to_char(public.ist_today(), 'FMDD Mon YYYY') || '%' then
    raise exception 'A FAIL: notes name another due date: %', v_q.notes; end if;
  raise notice 'A PASS: % — 17 × ₹300, ₹6,018, due today', v_id;

  -- B. the preview's seat change 17 → 18
  r := public.set_part_request_terms(v_id, 18, 300);
  select q.* into v_q from public.quotes q where q.id = v_id;
  if v_q.subtotal <> 5400 or v_q.amount <> 6372 or (v_q.line_items->0->>'qty')::int <> 18 or (v_q.line_items->0->>'rate')::int <> 300
     or v_q.line_items->0->>'name' not like '%· 18 seats ·%' or v_q.proforma_seats <> 18 or v_q.proforma_seat_rate <> 300
     or jsonb_array_length(v_q.line_items) <> 1 then
    raise exception 'B FAIL: %', row_to_json(v_q); end if;
  select s.seats, s.mrr into v_s from public.subscriptions s where s.id = 'eeeeeeee-0000-0000-0000-000000251901';
  if v_s.seats <> 17 or v_s.mrr <> 5100 then raise exception 'B FAIL: subscription changed before payment: % / %', v_s.seats, v_s.mrr; end if;
  raise notice 'B PASS: proforma 18 × ₹300 = ₹6,372; subscription still 17';

  -- C. paid → tax invoice for what was paid, seats on the subscription
  perform public.record_payment(v_id, 6372, 'upi', 'R2519-PAY-1');
  select invoice_id into v_inv from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000251901';
  if v_inv is null then raise exception 'C FAIL: no tax invoice raised on payment'; end if;
  select * into v_i from public.invoices where id = v_inv;
  if v_i.amount <> 6372 or v_i.status::text <> 'paid' then raise exception 'C FAIL: invoice % amount % status %', v_i.id, v_i.amount, v_i.status; end if;
  if (select (l->>'qty')::int from jsonb_array_elements(v_i.line_items) l limit 1) <> 18 then
    raise exception 'C FAIL: invoice line %', v_i.line_items; end if;
  select s.seats, s.mrr into v_s from public.subscriptions s where s.id = 'eeeeeeee-0000-0000-0000-000000251901';
  if v_s.seats <> 18 or v_s.mrr <> 5400 then raise exception 'C FAIL: subscription % seats, mrr % (want 18 / 5400)', v_s.seats, v_s.mrr; end if;
  if (select taxable_amount from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000251901') <> 5400 then
    raise exception 'C FAIL: part taxable not 5400'; end if;
  if not exists (select 1 from public.contract_amendments a where a.subscription_id = 'eeeeeeee-0000-0000-0000-000000251901') then
    raise exception 'C FAIL: no contract amendment for the seat change'; end if;
  if (select proforma_terms_applied_at from public.quotes where id = v_id) is null then raise exception 'C FAIL: not marked applied'; end if;
  raise notice 'C PASS: paid → % ₹6,372, subscription 18 seats / ₹5,400', v_inv;

  -- D. no change after payment
  begin
    perform public.set_part_request_terms(v_id, 19, 300);
    raise exception 'D FAIL: changed a paid proforma';
  exception when invalid_parameter_value then raise notice 'D PASS: %', sqlerrm;
  end;

  -- E. accepted proforma → seats on the subscription
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000251902', false);
  v_id2 := r->>'quote_id';
  perform public.set_part_request_terms(v_id2, 20, 300);
  update public.quotes set status = 'accepted' where id = v_id2;
  select s.seats, s.mrr into v_s from public.subscriptions s where s.id = 'eeeeeeee-0000-0000-0000-000000251902';
  if v_s.seats <> 20 or v_s.mrr <> 6000 then raise exception 'E FAIL: % / %', v_s.seats, v_s.mrr; end if;
  raise notice 'E PASS: accepted → 20 seats';
  begin perform public.cancel_quote(v_id2, 'Customer backed out, test');
    raise exception 'E FAIL: cancelled an accepted proforma whose seats are on the subscription';
  exception when invalid_parameter_value then raise notice 'E PASS (cancel refused): %', sqlerrm; end;

  -- F. cancel a proforma — kept, subscription untouched, part free again
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000251903', false);
  v_id3 := r->>'quote_id';
  r := public.cancel_quote(v_id3, 'Customer will renew at 18 seats');
  select q.* into v_q from public.quotes q where q.id = v_id3;
  if v_q.status::text <> 'rejected' or v_q.cancelled_at is null or v_q.cancel_reason <> 'Customer will renew at 18 seats'
     or v_q.payment_status::text <> 'none' or v_q.subscription_billing_id is not null
     or v_q.cancelled_part_billing_id <> 'bbbbbbbb-0000-0000-0000-000000251903' or v_q.cancelled_from_status <> 'sent' then
    raise exception 'F FAIL: %', row_to_json(v_q); end if;
  select s.status::text as status, s.seats into v_s from public.subscriptions s where s.id = 'eeeeeeee-0000-0000-0000-000000251903';
  if v_s.status <> 'active' or v_s.seats <> 17 then raise exception 'F FAIL: subscription touched %', row_to_json(v_s); end if;
  if not exists (select 1 from public.activity_log where entity_id = v_id3 and action = 'quote.cancelled') then
    raise exception 'F FAIL: no activity row'; end if;
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000251903', false);
  if r->>'action' <> 'request' or r->>'quote_id' = v_id3 then raise exception 'F FAIL: part not billable again: %', r; end if;
  raise notice 'F PASS: % cancelled, kept; part re-billed as %', v_id3, r->>'quote_id';
  begin update public.quotes set status = 'sent' where id = v_id3;
    raise exception 'F FAIL: a plain Reopen re-opened a cancelled quote';
  exception when invalid_parameter_value then raise notice 'F PASS (Reopen refused): %', sqlerrm; end;

  -- G. undo is refused while the new proforma holds the part; fine once that one is cancelled
  begin
    perform public.undo_cancel_quote(v_id3);
    raise exception 'G FAIL: undo took a part another proforma holds';
  exception when invalid_parameter_value then raise notice 'G PASS (refused): %', sqlerrm;
  end;
  perform public.cancel_quote(r->>'quote_id', 'Made by mistake, test');
  perform public.undo_cancel_quote(v_id3);
  select q.* into v_q from public.quotes q where q.id = v_id3;
  if v_q.status::text <> 'sent' or v_q.payment_status::text <> 'awaiting' or v_q.cancelled_at is not null
     or v_q.subscription_billing_id <> 'bbbbbbbb-0000-0000-0000-000000251903' then
    raise exception 'G FAIL: undo %', row_to_json(v_q); end if;
  if (select due_on from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000251903') is distinct from public.ist_today() then
    raise exception 'G FAIL: due date not back to today'; end if;
  -- G2. billed ahead (part starts in 6 days): cancel → undo keeps the due date at the part start
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000251905', false);
  if (select due_on from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000251905') <> public.ist_today() + 6 then
    raise exception 'G2 FAIL: ahead part due %', (select due_on from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000251905'); end if;
  perform public.cancel_quote(r->>'quote_id', 'Testing the undo date');
  perform public.undo_cancel_quote(r->>'quote_id');
  if (select due_on from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000251905') <> public.ist_today() + 6 then
    raise exception 'G2 FAIL: undo moved the due date to %', (select due_on from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000251905'); end if;
  raise notice 'G2 PASS: ahead proforma keeps its due date through cancel / undo';
  raise notice 'G PASS: undo → sent, awaiting, part linked again';

  -- H. refusals
  begin perform public.cancel_quote(v_id, 'Paid already, try');
    raise exception 'H FAIL: cancelled a paid proforma';
  exception when invalid_parameter_value then raise notice 'H PASS (paid): %', sqlerrm; end;
  begin perform public.cancel_quote('TESTQ-R2519-SALE', 'no');
    raise exception 'H FAIL: short reason accepted';
  exception when invalid_parameter_value then raise notice 'H PASS (reason): %', sqlerrm; end;

  -- I. ordinary quote: cancel → undo
  perform public.cancel_quote('TESTQ-R2519-SALE', 'Customer chose another vendor');
  if (select status::text from public.quotes where id = 'TESTQ-R2519-SALE') <> 'rejected' then raise exception 'I FAIL: not closed'; end if;
  perform public.undo_cancel_quote('TESTQ-R2519-SALE');
  select q.* into v_q from public.quotes q where q.id = 'TESTQ-R2519-SALE';
  if v_q.status::text <> 'sent' or v_q.payment_status::text <> 'awaiting' then raise exception 'I FAIL: %', row_to_json(v_q); end if;
  raise notice 'I PASS: ordinary quote cancel / undo';

  -- K. a cancelled SALE quote whose subscription's part got its own proforma cannot be undone
  perform public.cancel_quote('TESTQ-R2519-SALE2', 'Customer wants monthly proformas');
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000251906', false);
  if r->>'action' <> 'request' then raise exception 'K FAIL: part not billed after the sale quote was cancelled: %', r; end if;
  begin perform public.undo_cancel_quote('TESTQ-R2519-SALE2');
    raise exception 'K FAIL: undo reopened a sale quote whose part now has %', r->>'quote_id';
  exception when invalid_parameter_value then raise notice 'K PASS: %', sqlerrm; end;
end $$;

-- J. as the company's OWNER (role + company checks), then a SALES user (refused).
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000251901","role":"authenticated"}', true);
set local role authenticated;
do $$
declare r jsonb; v_id text;
begin
  select q.id into v_id from public.quotes q where q.subscription_billing_id = 'bbbbbbbb-0000-0000-0000-000000251903';
  r := public.set_part_request_terms(v_id, 18, 300);
  if (r->>'amount')::int <> 6372 then raise exception 'J FAIL: owner change %', r; end if;
  r := public.cancel_quote(v_id, 'Owner cancels it, test');
  if r->>'status' <> 'cancelled' then raise exception 'J FAIL: owner cancel %', r; end if;
  raise notice 'J PASS: owner can change and cancel';
  -- a direct edit of the guarded columns (PostgREST) is refused — seats only through the RPCs
  begin
    update public.quotes set proforma_seats = 1, proforma_seat_rate = 1 where id = 'TESTQ-R2519-SALE';
    raise exception 'J FAIL: a direct update set proforma_seats';
  exception when insufficient_privilege then raise notice 'J PASS (direct edit refused): %', sqlerrm; end;
end $$;
reset role;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000251902","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin perform public.cancel_quote('TESTQ-R2519-SALE', 'Sales tries to cancel');
    raise exception 'J FAIL: sales user cancelled';
  exception when insufficient_privilege then raise notice 'J PASS (sales refused): %', sqlerrm; end;
end $$;
reset role;

select 'R-2519 renewal proforma + cancel: ALL PASS' as result;

rollback;
