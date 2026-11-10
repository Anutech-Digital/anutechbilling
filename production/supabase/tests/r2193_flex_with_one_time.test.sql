-- R-2193 (G-ZOHO, Zoho Books audit 31 Oct 2026): one bank credit paid for a Monthly flex plan AND a
-- one-time line (domain / setup), and we had to book TWO sales: the drawer refused the mix and the
-- server's R-381 trigger (quote_line_terms_mixed) counted the one-time line (no commitment) as annual.
-- Migration 20261107233022_r2193_flex_with_one_time.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
--   A. 10 seats Monthly flex Rs 264 + domain one-time Rs 1,200 (domain typed FIRST), one bank credit
--      Rs 4,531 = month 1 + domain -> one sale; the quote lists the flex line first (every screen
--      reads the term off line 1); part 1 invoice carries both lines, Rs 4,531, Paid.
--   B. Month 2 (the next term's part) is asked for as Rs 264 x 10 only - a Rs 3,115 request, no domain.
--   C. Annual + Monthly flex on one sale is still refused, with the one-term message.
--   D. quote_line_terms_mixed: flex + one-time = not mixed; flex + annual (or a line with no
--      commitment, the old default) = mixed.
--   E. A flex + one-time quote saved with the one-time line first (signed-in insert) is let in by the
--      R-381 trigger and quote_split_due does not split it into 12 parts.
--   F. An annual sale with a setup line keeps the typed order (only flex sales are reordered).

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
  ('dddddddd-0000-0000-0000-000000219301','R2193 Flex Co','r2193@example.in','07','R193');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000219301','owner2193@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000219301','dddddddd-0000-0000-0000-000000219301','owner2193@example.in','Owner 2193','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000219301','dddddddd-0000-0000-0000-000000219301','Flex 2193','07','flex2193.in');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000219301','dddddddd-0000-0000-0000-000000219301','HDFC Current','HDFC');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000219301','dddddddd-0000-0000-0000-000000219301','bbbbbbbb-0000-0000-0000-000000219301','2026-10-01','NEFT FLEX 2193',0,4531,'UTR2193A','manual'),
  ('11111111-0000-0000-0000-000000219302','dddddddd-0000-0000-0000-000000219301','bbbbbbbb-0000-0000-0000-000000219301','2026-10-02','NEFT FLEX 2193 C',0,20000,'UTR2193C','manual'),
  ('11111111-0000-0000-0000-000000219303','dddddddd-0000-0000-0000-000000219301','bbbbbbbb-0000-0000-0000-000000219301','2026-10-03','NEFT FLEX 2193 F',0,19765,'UTR2193F','manual');

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000219301","role":"authenticated"}', true);

do $$
declare r jsonb; q record; i record; v_sub uuid; v_b1 uuid := gen_random_uuid(); v_b2 uuid := gen_random_uuid();
        v_ok boolean := false; v_msg text;
begin
  -- A. flex + domain one-time, one bank credit -> one sale, month 1 invoice has both, Paid
  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000219301', 'cccccccc-0000-0000-0000-000000219301',
         '[{"item_id":null,"name":"Domain flex2193.in","qty":1,"rate":1200,"cost":0,"commitment":"one_time"},
           {"item_id":null,"name":"Google Workspace Business Starter","qty":10,"rate":264,"cost":0,"commitment":"monthly"}]'::jsonb,
         true, '2026-10-01', null, 0, null, null, 'monthly');
  select * into q from public.quotes where id = r->>'quote_id';
  if q.amount is distinct from 4531 or q.subtotal is distinct from 3840 or q.billing_cycle is distinct from 'monthly' then
    raise exception 'FAIL A: quote amount % subtotal % cycle % (want 4,531 / 3,840 / monthly)', q.amount, q.subtotal, q.billing_cycle;
  end if;
  if q.line_items->0->>'commitment' is distinct from 'monthly' or (q.line_items->1->>'one_time') is distinct from 'true' then
    raise exception 'FAIL A: the flex line is not line 1 (screens read the term off line 1): %', q.line_items;
  end if;
  select s.id into v_sub from public.subscriptions s where s.quote_id = q.id;
  if v_sub is null or (select count(*) from public.subscriptions s where s.quote_id = q.id) <> 1 then
    raise exception 'FAIL A: want exactly one subscription (the seats), got %', r->'subscriptions';
  end if;
  /* The billing cron lays the term's one part from the subscription (mrr Rs 2,640) and raises it. */
  insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                            period_start, period_end, taxable_amount, tax_rate)
  values (v_b1, 'dddddddd-0000-0000-0000-000000219301', v_sub, '2026-10-01', 1, '2026-10-01', '2026-10-01', '2026-11-01', 2640, 18);
  r := public.bill_subscription_instalment(v_b1, false);
  if r->>'action' <> 'invoice' then raise exception 'FAIL A: month 1 not invoiced: %', r; end if;
  select * into i from public.invoices where id = r->>'invoice_id';
  if i.amount <> 4531 or i.status::text <> 'paid' then
    raise exception 'FAIL A: month 1 invoice % amount % status % (want 4,531 paid)', i.id, i.amount, i.status;
  end if;
  if not (i.line_items @> jsonb_build_array(jsonb_build_object('one_time_of', q.id)))
     or jsonb_array_length(i.line_items) <> 2 then
    raise exception 'FAIL A: month 1 invoice lines are not seats + domain: %', i.line_items;
  end if;
  raise notice 'A PASS: one sale, month 1 % = seats + domain Rs 4,531 paid', i.id;

  -- B. month 2 = seats only
  insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                            period_start, period_end, taxable_amount, tax_rate)
  values (v_b2, 'dddddddd-0000-0000-0000-000000219301', v_sub, '2026-11-01', 1, '2026-11-01', '2026-11-01', '2026-12-01', 2640, 18);
  r := public.bill_subscription_instalment(v_b2, false);
  /* Month 2 is not paid yet: the billing step asks for it (R-2519 payment request) - seats only. */
  if r->>'action' <> 'request' or (r->>'gross')::int <> 3115 then
    raise exception 'FAIL B: month 2 should be a Rs 3,115 payment request (seats only): %', r;
  end if;
  if exists (select 1 from public.quotes pq, jsonb_array_elements(pq.line_items) l
              where pq.id = r->>'quote_id'
                and (l ? 'one_time_of' or l->>'name' ilike 'Domain flex2193%'))
     or (select jsonb_array_length(line_items) from public.quotes where id = r->>'quote_id') <> 1 then
    raise exception 'FAIL B: month 2 request % carries the one-time domain again: %', r->>'quote_id',
      (select line_items from public.quotes where id = r->>'quote_id');
  end if;
  raise notice 'B PASS: month 2 request % = Rs 3,115 seats only', r->>'quote_id';

  -- C. annual + flex still refused, with the one-term message
  begin
    perform public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000219302', 'cccccccc-0000-0000-0000-000000219301',
         '[{"item_id":null,"name":"Google Workspace Business Starter","qty":10,"rate":264,"cost":0,"commitment":"monthly"},
           {"item_id":null,"name":"Microsoft 365 Basic","qty":5,"rate":3150,"cost":0,"commitment":"annual_yearly"}]'::jsonb,
         true, '2026-10-02', null, 0, null, null, 'monthly');
  exception when check_violation then v_ok := true; v_msg := sqlerrm;
  end;
  if not v_ok or v_msg !~* 'one billing term' then
    raise exception 'FAIL C: annual + Monthly flex on one sale was not refused with the one-term message (%)', v_msg;
  end if;
  raise notice 'C PASS: annual + flex refused - %', v_msg;

  -- D. the helper
  if public.quote_line_terms_mixed('[{"commitment":"monthly"},{"one_time":true}]'::jsonb)
     or public.quote_line_terms_mixed('[{"commitment":"monthly"},{"commitment":"one_time"}]'::jsonb) then
    raise exception 'FAIL D: Monthly flex + one-time still counted as mixed terms';
  end if;
  if not public.quote_line_terms_mixed('[{"commitment":"monthly"},{"commitment":"annual_yearly"}]'::jsonb)
     or not public.quote_line_terms_mixed('[{"commitment":"monthly"},{"name":"old line"}]'::jsonb) then
    raise exception 'FAIL D: Monthly flex + annual (or a line with no commitment) no longer counted as mixed';
  end if;
  raise notice 'D PASS: helper';

  -- E. a flex + one-time quote saved by a signed-in user with the one-time line FIRST (not the bank
  --    sale, which orders the lines): the R-381 trigger lets it in, and quote_split_due never splits it
  insert into public.quotes (id, tenant_id, customer_id, customer_name, tax_rate, amount, subtotal, billing_cycle, status, is_one_off, line_items)
  values ('TESTQ-R2193-E', 'dddddddd-0000-0000-0000-000000219301', 'cccccccc-0000-0000-0000-000000219301', 'Flex 2193', 18, 4531, 3840,
          'monthly', 'accepted', false,
          '[{"name":"Domain flex2193.in","qty":1,"rate":1200,"one_time":true},{"name":"Starter","qty":10,"rate":264,"commitment":"monthly"}]'::jsonb);
  if public.quote_split_due('TESTQ-R2193-E', '2026-10-01', '2027-09-30') is not null then
    raise exception 'FAIL E: a flex quote with its one-time line first was split into parts (Rs %)',
      public.quote_split_due('TESTQ-R2193-E', '2026-10-01', '2027-09-30');
  end if;
  raise notice 'E PASS: one-time line first - flex quote not split';

  -- F. an annual sale with a setup line keeps the typed order (Zoho mirrors print as typed)
  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000219303', 'cccccccc-0000-0000-0000-000000219301',
         '[{"item_id":null,"name":"Setup fee","qty":1,"rate":1000,"cost":0,"commitment":"one_time"},
           {"item_id":null,"name":"Microsoft 365 Basic","qty":5,"rate":3150,"cost":0,"commitment":"annual_yearly"}]'::jsonb,
         true, '2026-10-03', null, 0, null, null, 'yearly');
  if (select line_items->0->>'name' from public.quotes where id = r->>'quote_id') is distinct from 'Setup fee' then
    raise exception 'FAIL F: an annual sale''s lines were reordered: %', (select line_items from public.quotes where id = r->>'quote_id');
  end if;
  raise notice 'F PASS: annual + setup keeps the typed order';
end $$;

select 'R-2193 Monthly flex + one-time on one sale: ALL PASS' as result;

rollback;
