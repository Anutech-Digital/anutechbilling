-- R-1573 (P2 money, audit 18 Oct 2026): a debit note (late interest, extra charge) on a PAID
-- invoice must be chased, and the money paid for it must settle it — not turn into customer credit.
--
-- What it proves (each case on its own quote, ₹11,800 = ₹10,000 + 18% GST):
--   A. paid invoice + debit note ₹1,180 → Pending, paid_date cleared, amount due (net_payable −
--      paid_amount, src/lib/payments/amount-due.ts) = ₹1,180; paying ₹1,180 → Paid, no credit.
--   B. paid invoice + debit note ₹1,180, customer pays ₹2,000 → Paid, only ₹820 becomes credit.
--   C. invoice OVERPAID first (₹12,800 → ₹1,000 credit), then debit note ₹1,180 → Pending, due
--      ₹1,180 (the ₹1,000 is already the customer's credit); paying ₹1,180 → Paid, no 2nd credit.
--   D. advance before the invoice (adjusted, net_payable 0), debit note ₹590 → due ₹590; pay → Paid.
--   E. paid + credit note ₹1,180 (→ ₹1,180 credit) + debit note ₹590 → due ₹590; pay → Paid, no
--      new credit (the credit-note credit stays ₹1,180).
--   F. PENDING invoice + debit note ₹1,180, paid ₹12,980 in one go → Paid, no credit.
--   G. issue_debit_note on a pending invoice leaves status alone.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r1573_debit_note_paid_invoice.test.sql
--
-- Self-asserting; ROLLS BACK.

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


insert into public.tenants (id, name, email, state_code, doc_code) values
  ('15730000-0000-4000-8000-000000000001', 'R1573 TEST', 'r1573@example.in', '07', 'R157');
insert into auth.users (id, instance_id, aud, role, email) values
  ('15730000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r1573-user@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('15730000-0000-4000-8000-0000000000a1', '15730000-0000-4000-8000-000000000001', 'r1573-user@example.in', 'owner');
insert into public.customers (id, tenant_id, name, country, state_code, state) values
  ('15730000-0000-4000-8000-0000000000c1', '15730000-0000-4000-8000-000000000001', 'R1573 Cust', 'India', '07', 'Delhi');

insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate,
                           line_items, status, payment_status, payment_terms_days, is_one_off)
select 'R1573Q-' || n, '15730000-0000-4000-8000-000000000001', '15730000-0000-4000-8000-0000000000c1',
       'R1573 Cust', 11800, 10000, 18, '[]'::jsonb, 'sent', 'awaiting', 30, true
  from unnest(array['A','B','C','D','E','F','G']) n;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '15730000-0000-4000-8000-0000000000a1', 'role', 'authenticated')::text, true);

create function pg_temp.inv(p_q text) returns text language sql as $$
  select id from public.invoices where quote_id = p_q $$;
create function pg_temp.due(p_q text) returns integer language sql as $$
  select case when status in ('paid', 'void') then 0
              else greatest(0, coalesce(net_payable, amount) - coalesce(paid_amount, 0)) end
    from public.invoices where quote_id = p_q $$;
create function pg_temp.st(p_q text) returns text language sql as $$
  select status::text from public.invoices where quote_id = p_q $$;
create function pg_temp.credit(p_src text) returns integer language sql as $$
  select coalesce(sum(amount), 0)::int from public.customer_credits
   where customer_id = '15730000-0000-4000-8000-0000000000c1' and source = p_src and status = 'open' $$;

do $$
declare r jsonb; v_inv text; v_pd date;
begin
  -- ── A ──────────────────────────────────────────────────────────────────────
  perform public.generate_invoice('R1573Q-A');
  perform public.record_payment('R1573Q-A', 11800, 'upi', 'R1573-A1', null);
  if pg_temp.st('R1573Q-A') <> 'paid' then raise exception 'FAIL A setup: invoice not paid'; end if;
  v_inv := pg_temp.inv('R1573Q-A');
  r := public.issue_debit_note(v_inv, 1180, 'additional_charge', 'Late payment interest', null);
  select paid_date into v_pd from public.invoices where id = v_inv;
  if pg_temp.st('R1573Q-A') <> 'pending' then
    raise exception 'FAIL A1: debit note on a paid invoice left it %, want pending (it is never chased)', pg_temp.st('R1573Q-A');
  end if;
  if v_pd is not null then raise exception 'FAIL A2: paid_date % kept on a reopened invoice', v_pd; end if;
  if pg_temp.due('R1573Q-A') <> 1180 then
    raise exception 'FAIL A3: amount due % after the debit note, want 1180', pg_temp.due('R1573Q-A');
  end if;
  if coalesce((r->>'invoice_reopened')::boolean, false) is not true then
    raise exception 'FAIL A4: issue_debit_note result does not say invoice_reopened: %', r;
  end if;
  r := public.record_payment('R1573Q-A', 1180, 'upi', 'R1573-A2', null);
  if pg_temp.st('R1573Q-A') <> 'paid' then raise exception 'FAIL A5: paying the debit note left the invoice %', pg_temp.st('R1573Q-A'); end if;
  if coalesce((r->>'overpaid_credit')::int, -1) <> 0 then
    raise exception 'FAIL A6: paying the debit note made ₹% customer credit, want 0', r->>'overpaid_credit';
  end if;
  if pg_temp.credit('overpayment') <> 0 then raise exception 'FAIL A7: open overpayment credit %', pg_temp.credit('overpayment'); end if;
  if (select paid_date from public.invoices where id = v_inv) is null then raise exception 'FAIL A8: paid_date not set again'; end if;

  -- ── B ──────────────────────────────────────────────────────────────────────
  perform public.generate_invoice('R1573Q-B');
  perform public.record_payment('R1573Q-B', 11800, 'upi', 'R1573-B1', null);
  perform public.issue_debit_note(pg_temp.inv('R1573Q-B'), 1180, 'additional_charge', 'Late payment interest', null);
  r := public.record_payment('R1573Q-B', 2000, 'upi', 'R1573-B2', null);
  if pg_temp.st('R1573Q-B') <> 'paid' then raise exception 'FAIL B1: invoice %', pg_temp.st('R1573Q-B'); end if;
  if (r->>'overpaid_credit')::int <> 820 then raise exception 'FAIL B2: overpaid credit %, want 820', r->>'overpaid_credit'; end if;
  if pg_temp.credit('overpayment') <> 820 then raise exception 'FAIL B3: open overpayment credit %, want 820', pg_temp.credit('overpayment'); end if;

  -- ── C ──────────────────────────────────────────────────────────────────────
  perform public.generate_invoice('R1573Q-C');
  r := public.record_payment('R1573Q-C', 12800, 'upi', 'R1573-C1', null);
  if (r->>'overpaid_credit')::int <> 1000 then raise exception 'FAIL C setup: overpaid credit %', r->>'overpaid_credit'; end if;
  perform public.issue_debit_note(pg_temp.inv('R1573Q-C'), 1180, 'additional_charge', 'Late payment interest', null);
  if pg_temp.st('R1573Q-C') <> 'pending' or pg_temp.due('R1573Q-C') <> 1180 then
    raise exception 'FAIL C1: after the debit note % due %, want pending 1180', pg_temp.st('R1573Q-C'), pg_temp.due('R1573Q-C');
  end if;
  r := public.record_payment('R1573Q-C', 1180, 'upi', 'R1573-C2', null);
  if pg_temp.st('R1573Q-C') <> 'paid' then raise exception 'FAIL C2: invoice %', pg_temp.st('R1573Q-C'); end if;
  if (r->>'overpaid_credit')::int <> 0 then
    raise exception 'FAIL C3: paying the debit note made ₹% more credit (the ₹1,000 was already credited)', r->>'overpaid_credit';
  end if;
  if pg_temp.credit('overpayment') <> 1820 then raise exception 'FAIL C4: open overpayment credit %, want 820 + 1000', pg_temp.credit('overpayment'); end if;
  r := public.record_payment('R1573Q-C', 500, 'upi', 'R1573-C3', null);
  if (r->>'overpaid_credit')::int <> 500 then raise exception 'FAIL C5: a later extra ₹500 made credit %', r->>'overpaid_credit'; end if;

  -- ── D ──────────────────────────────────────────────────────────────────────
  perform public.record_payment('R1573Q-D', 11800, 'upi', 'R1573-D1', null);
  perform public.generate_invoice('R1573Q-D');
  if pg_temp.st('R1573Q-D') <> 'paid' then raise exception 'FAIL D setup: advance-adjusted invoice %', pg_temp.st('R1573Q-D'); end if;
  perform public.issue_debit_note(pg_temp.inv('R1573Q-D'), 590, 'additional_charge', 'Late payment interest', null);
  if pg_temp.st('R1573Q-D') <> 'pending' or pg_temp.due('R1573Q-D') <> 590 then
    raise exception 'FAIL D1: after the debit note % due %, want pending 590', pg_temp.st('R1573Q-D'), pg_temp.due('R1573Q-D');
  end if;
  r := public.record_payment('R1573Q-D', 590, 'upi', 'R1573-D2', null);
  if pg_temp.st('R1573Q-D') <> 'paid' or (r->>'overpaid_credit')::int <> 0 then
    raise exception 'FAIL D2: invoice % credit %', pg_temp.st('R1573Q-D'), r->>'overpaid_credit';
  end if;

  -- ── E ──────────────────────────────────────────────────────────────────────
  perform public.generate_invoice('R1573Q-E');
  perform public.record_payment('R1573Q-E', 11800, 'upi', 'R1573-E1', null);
  perform public.issue_credit_note(pg_temp.inv('R1573Q-E'), 1180, 'other', 'discount after payment', null);
  if pg_temp.credit('credit_note') <> 1180 then raise exception 'FAIL E setup: credit-note credit %', pg_temp.credit('credit_note'); end if;
  perform public.issue_debit_note(pg_temp.inv('R1573Q-E'), 590, 'additional_charge', 'Late payment interest', null);
  if pg_temp.st('R1573Q-E') <> 'pending' or pg_temp.due('R1573Q-E') <> 590 then
    raise exception 'FAIL E1: after the debit note % due %, want pending 590', pg_temp.st('R1573Q-E'), pg_temp.due('R1573Q-E');
  end if;
  r := public.record_payment('R1573Q-E', 590, 'upi', 'R1573-E2', null);
  if pg_temp.st('R1573Q-E') <> 'paid' or (r->>'overpaid_credit')::int <> 0 then
    raise exception 'FAIL E2: invoice % credit %', pg_temp.st('R1573Q-E'), r->>'overpaid_credit';
  end if;
  if pg_temp.credit('credit_note') <> 1180 then raise exception 'FAIL E3: credit-note credit now %', pg_temp.credit('credit_note'); end if;

  -- ── F ──────────────────────────────────────────────────────────────────────
  perform public.generate_invoice('R1573Q-F');
  perform public.issue_debit_note(pg_temp.inv('R1573Q-F'), 1180, 'additional_charge', 'Late payment interest', null);
  r := public.record_payment('R1573Q-F', 12980, 'upi', 'R1573-F1', null);
  if pg_temp.st('R1573Q-F') <> 'paid' or (r->>'overpaid_credit')::int <> 0 then
    raise exception 'FAIL F1: invoice % credit % (₹12,980 = invoice + debit note, nothing extra)', pg_temp.st('R1573Q-F'), r->>'overpaid_credit';
  end if;

  -- ── G ──────────────────────────────────────────────────────────────────────
  perform public.generate_invoice('R1573Q-G');
  perform public.record_payment('R1573Q-G', 5000, 'upi', 'R1573-G1', null);
  r := public.issue_debit_note(pg_temp.inv('R1573Q-G'), 1180, 'additional_charge', 'Late payment interest', null);
  if pg_temp.st('R1573Q-G') <> 'pending' or pg_temp.due('R1573Q-G') <> 7980 then
    raise exception 'FAIL G1: pending invoice after debit note % due %, want pending 7980', pg_temp.st('R1573Q-G'), pg_temp.due('R1573Q-G');
  end if;
  if coalesce((r->>'invoice_reopened')::boolean, true) is not false then raise exception 'FAIL G2: invoice_reopened on a pending invoice: %', r; end if;

  raise notice 'PASS: r1573_debit_note_paid_invoice';
end $$;

rollback;
