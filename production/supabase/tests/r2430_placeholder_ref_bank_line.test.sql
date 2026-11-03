-- R-2430 (3 Nov 2026, p1 money): two DIFFERENT bank credits whose reference is a placeholder
-- (000000000000000) paying the SAME quote / invoice — the second was a silent "idempotent replay"
-- (nothing booked, no error). Migration 20261103192837_r2430_placeholder_ref_bank_line
-- (bank_line_payment_reference + reconcile_bank_credit_to_item / bank_credit_book_advance /
-- reconcile_bank_credit_split redefined).
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
-- RED without the migration (A: the second ₹5,000 line books nothing).
--
-- Proves:
--   RULE  bank_line_payment_reference: real UTR → itself (trimmed); zeros / NA / empty → BANK-<line id>.
--   A. "This money is for" (reconcile_bank_credit_to_item): two ₹5,000 lines, both 000000000000000,
--      on ONE ₹11,800 invoice → TWO receipts (₹10,000 received), each line matched to its own.
--   B. The same bank line booked twice (un-reconciled keeping the receipt, then reconciled again)
--      → the SAME receipt (replay), still ₹10,000 — booked once.
--   C. Split (reconcile_bank_credit_split): two zero-ref lines on one quote → two receipts.
--   D. New sale path (reconcile_bank_credit_new_sale → to_item) with a zero ref → receipt BANK-<id>.
--   E. Advance (reconcile_bank_credit_as_advance) with a zero ref → quote + receipt carry BANK-<id>.
--   F. A real UTR keeps its own (trimmed) reference, as before.

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
  ('dddddddd-0000-0000-0000-000000243001','R2430 Co','r2430@example.in','07','R2430');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000243001','owner2430@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000243001','dddddddd-0000-0000-0000-000000243001','owner2430@example.in','Owner 2430','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, domain, country) values
  ('cccccccc-0000-0000-0000-000000243001','dddddddd-0000-0000-0000-000000243001','Acme 2430','07','acme2430.in','India');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000243001','dddddddd-0000-0000-0000-000000243001','HDFC Current','HDFC');

-- One-off quotes of ₹11,800 (10,000 + 18%): Q-A (to_item), Q-C (split), Q-F (real UTR).
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items, is_one_off, created_date)
select v.id, 'dddddddd-0000-0000-0000-000000243001', 'cccccccc-0000-0000-0000-000000243001', 'Acme 2430',
       11800, 10000, 0, 18, 'accepted', 'awaiting', 'yearly',
       jsonb_build_array(jsonb_build_object('name', 'Service ' || v.id, 'qty', 1, 'rate', 10000, 'one_time', true)),
       true, '2026-10-10'
  from (values ('Q-R2430-A'), ('Q-R2430-C'), ('Q-R2430-F')) as v(id);

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000243001','dddddddd-0000-0000-0000-000000243001','bbbbbbbb-0000-0000-0000-000000243001','2026-10-20','NEFT ACME 2430 PART 1',0,5000,'000000000000000','manual'),
  ('11111111-0000-0000-0000-000000243002','dddddddd-0000-0000-0000-000000243001','bbbbbbbb-0000-0000-0000-000000243001','2026-10-21','NEFT ACME 2430 PART 2',0,5000,'000000000000000','manual'),
  ('11111111-0000-0000-0000-000000243003','dddddddd-0000-0000-0000-000000243001','bbbbbbbb-0000-0000-0000-000000243001','2026-10-22','NEFT ACME 2430 SPLIT 1',0,5000,'000000000000000','manual'),
  ('11111111-0000-0000-0000-000000243004','dddddddd-0000-0000-0000-000000243001','bbbbbbbb-0000-0000-0000-000000243001','2026-10-23','NEFT ACME 2430 SPLIT 2',0,5000,'0000-0000-0000','manual'),
  ('11111111-0000-0000-0000-000000243005','dddddddd-0000-0000-0000-000000243001','bbbbbbbb-0000-0000-0000-000000243001','2026-10-24','NEFT ACME 2430 SALE',0,1180,'000000000000000','manual'),
  ('11111111-0000-0000-0000-000000243006','dddddddd-0000-0000-0000-000000243001','bbbbbbbb-0000-0000-0000-000000243001','2026-10-25','NEFT ACME 2430 ADVANCE',0,2000,'NA','manual'),
  ('11111111-0000-0000-0000-000000243007','dddddddd-0000-0000-0000-000000243001','bbbbbbbb-0000-0000-0000-000000243001','2026-10-26','NEFT ACME 2430 REAL',0,5000,' R2430UTR778899 ','manual');

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000243001","role":"authenticated"}', true);
select public.generate_invoice(q) from unnest(array['Q-R2430-A','Q-R2430-C','Q-R2430-F']) q;

create function pg_temp.inv(p_quote text) returns text language sql as $f$ select invoice_id from public.quotes where id = p_quote $f$;
create function pg_temp.received(p_quote text) returns bigint language sql as $f$
  select coalesce(sum(amount), 0) from public.payments where quote_id = p_quote and status = 'received' $f$;

-- ── RULE ─────────────────────────────────────────────────────────────────────────────────────
do $$
declare v_id uuid := '11111111-0000-0000-0000-000000243001';
begin
  if public.bank_line_payment_reference(' R2430UTR778899 ', v_id) <> 'R2430UTR778899' then
    raise exception 'FAIL RULE: a real UTR is not kept as the reference'; end if;
  if public.bank_line_payment_reference('000000000000000', v_id) <> 'BANK-' || v_id::text
     or public.bank_line_payment_reference('NA', v_id) <> 'BANK-' || v_id::text
     or public.bank_line_payment_reference('', v_id) <> 'BANK-' || v_id::text
     or public.bank_line_payment_reference(null, v_id) <> 'BANK-' || v_id::text then
    raise exception 'FAIL RULE: a placeholder / empty reference is not BANK-<line id>'; end if;
  raise notice 'PASS RULE: real UTR kept, placeholder → BANK-<line id>';
end $$;

-- ── A. two zero-ref ₹5,000 lines on one invoice → two receipts ────────────────────────────────
do $$
declare r1 jsonb; r2 jsonb; n int;
begin
  r1 := public.reconcile_bank_credit_to_item('11111111-0000-0000-0000-000000243001', null, pg_temp.inv('Q-R2430-A'));
  r2 := public.reconcile_bank_credit_to_item('11111111-0000-0000-0000-000000243002', null, pg_temp.inv('Q-R2430-A'));
  if r1->>'payment_id' = r2->>'payment_id' then
    raise exception 'FAIL A: the second zero-ref line was a replay of the first (payment %) — ₹5,000 not booked', r2->>'payment_id'; end if;
  if pg_temp.received('Q-R2430-A') <> 10000 then
    raise exception 'FAIL A: ₹% received on the quote (want ₹10,000)', pg_temp.received('Q-R2430-A'); end if;
  select count(*) into n from public.payments where quote_id = 'Q-R2430-A' and status = 'received';
  if n <> 2 then raise exception 'FAIL A: % receipts (want 2)', n; end if;
  if (select matched_to_id from public.bank_transactions where id = '11111111-0000-0000-0000-000000243002') <> r2->>'payment_id' then
    raise exception 'FAIL A: line 2 not matched to its own receipt'; end if;
  if (select reference from public.payments where id = (r2->>'payment_id')::uuid) <> 'BANK-11111111-0000-0000-0000-000000243002' then
    raise exception 'FAIL A: line 2''s receipt reference is not BANK-<line id>'; end if;
  if (select paid_amount from public.invoices where id = pg_temp.inv('Q-R2430-A')) <> 10000 then
    raise exception 'FAIL A: invoice paid_amount % (want 10,000)', (select paid_amount from public.invoices where id = pg_temp.inv('Q-R2430-A')); end if;
  raise notice 'PASS A: two zero-ref ₹5,000 lines → two receipts, ₹10,000 received';
end $$;

-- ── B. the same line booked again → booked once ──────────────────────────────────────────────
do $$
declare v_pay text; r jsonb; n int;
begin
  v_pay := (select matched_to_id from public.bank_transactions where id = '11111111-0000-0000-0000-000000243002');
  perform public.unreconcile_bank_receipt('11111111-0000-0000-0000-000000243002', false);   -- keep the receipt
  r := public.reconcile_bank_credit_to_item('11111111-0000-0000-0000-000000243002', null, pg_temp.inv('Q-R2430-A'));
  if r->>'payment_id' <> v_pay then
    raise exception 'FAIL B: re-reconciling the same line made receipt % (want the same %)', r->>'payment_id', v_pay; end if;
  select count(*) into n from public.payments where quote_id = 'Q-R2430-A' and status = 'received';
  if n <> 2 or pg_temp.received('Q-R2430-A') <> 10000 then
    raise exception 'FAIL B: % receipts / ₹% after the retry (want 2 / ₹10,000)', n, pg_temp.received('Q-R2430-A'); end if;
  begin
    perform public.reconcile_bank_credit_to_item('11111111-0000-0000-0000-000000243002', null, pg_temp.inv('Q-R2430-A'));
    raise exception 'FAIL B: a second click on a reconciled line was accepted';
  exception when check_violation then null;
  end;
  raise notice 'PASS B: the same bank line booked twice → one receipt';
end $$;

-- ── C. split path: two zero-ref lines on one quote → two receipts ────────────────────────────
do $$
declare r1 jsonb; r2 jsonb;
begin
  r1 := public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000243003', 'cccccccc-0000-0000-0000-000000243001',
          jsonb_build_array(jsonb_build_object('invoice_id', pg_temp.inv('Q-R2430-C'), 'amount', 5000)), null, null);
  r2 := public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000243004', 'cccccccc-0000-0000-0000-000000243001',
          jsonb_build_array(jsonb_build_object('invoice_id', pg_temp.inv('Q-R2430-C'), 'amount', 5000)), null, null);
  if pg_temp.received('Q-R2430-C') <> 10000 or r1->>'payment_id' = r2->>'payment_id' then
    raise exception 'FAIL C: ₹% received, payments % / % (want ₹10,000 on two receipts)', pg_temp.received('Q-R2430-C'), r1->>'payment_id', r2->>'payment_id'; end if;
  raise notice 'PASS C: split — two zero-ref lines on one quote → two receipts';
end $$;

-- ── D. new sale from a zero-ref line → receipt BANK-<id> ─────────────────────────────────────
do $$
declare r jsonb;
begin
  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000243005', 'cccccccc-0000-0000-0000-000000243001',
         '[{"item_id":null,"name":"Setup service","qty":1,"rate":1000,"cost":0,"commitment":"one_time"}]'::jsonb,
         false, null, null, 0, null, null, 'yearly');
  if (select reference from public.payments where id = (r->>'payment_id')::uuid) <> 'BANK-11111111-0000-0000-0000-000000243005' then
    raise exception 'FAIL D: new-sale receipt reference % (want BANK-<line id>)', (select reference from public.payments where id = (r->>'payment_id')::uuid); end if;
  raise notice 'PASS D: new sale from a zero-ref line → BANK-<line id>';
end $$;

-- ── E. advance from a placeholder line → BANK-<id> ───────────────────────────────────────────
do $$
declare r jsonb;
begin
  r := public.reconcile_bank_credit_as_advance('11111111-0000-0000-0000-000000243006', 'cccccccc-0000-0000-0000-000000243001');
  if (select reference from public.payments where id = (r->>'payment_id')::uuid) <> 'BANK-11111111-0000-0000-0000-000000243006'
     or (select payment_reference from public.quotes where id = r->>'quote_id') <> 'BANK-11111111-0000-0000-0000-000000243006' then
    raise exception 'FAIL E: advance reference not BANK-<line id>'; end if;
  raise notice 'PASS E: advance from a placeholder line → BANK-<line id>';
end $$;

-- ── F. a real UTR keeps its own reference ────────────────────────────────────────────────────
do $$
declare r jsonb;
begin
  r := public.reconcile_bank_credit_to_item('11111111-0000-0000-0000-000000243007', null, pg_temp.inv('Q-R2430-F'));
  if (select reference from public.payments where id = (r->>'payment_id')::uuid) <> 'R2430UTR778899' then
    raise exception 'FAIL F: real UTR receipt reference %', (select reference from public.payments where id = (r->>'payment_id')::uuid); end if;
  raise notice 'PASS F: a real UTR stays the receipt''s reference';
end $$;

select 'R-2430 placeholder ref per bank line: ALL PASS' as result;

rollback;
