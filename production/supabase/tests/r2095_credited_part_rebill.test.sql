-- R-2095 P0 (30 Oct 2026): a part invoice that credit notes cancel frees its period for a new invoice.
-- Self-asserting, ONE transaction, rolled back. Run on a dev/test DB only.
--
-- Staging, MOTION PHILM: one quote, Business Starter 57 × ₹3,200 + Business Standard 13 × ₹11,000 a
-- year, billed quarterly (Q1 ₹81,350 + GST = ₹95,993). Q1 was invoiced (INV-…-0004), then fully
-- reversed by two credit notes (CN-…-0001 / 0002) to re-issue it. The schedule still said Q1 was
-- invoiced by the credited invoice; there was no Generate; the credited invoice still read 'Paid'.
--
--   A. Both credit notes together cover the invoice → both Q1 parts lose the link (kept in
--      credited_invoice_ids); the money the notes gave back (open customer credit) re-pays Q1:
--      split_sale_invoice_status says 'ready'; bill_subscription_instalment raises ONE new invoice,
--      paid, ₹95,993; the notes' credit is used by that invoice (not spendable twice).
--   B. A partial credit note keeps the link (the invoice still bills the period).
--   C. An unpaid part invoice fully credited → the period is free and, with no money behind it,
--      gets a payment request (not the closed sale quote, not an 'already invoiced').

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

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('dddddddd-0000-0000-0000-000000209501','R2095 Co','r2095a@example.in','07','R95A');

-- Customer 1: the MOTION PHILM case. Customer 2: partial note. Customer 3: unpaid, invoiced on due date.
insert into public.customers (id, tenant_id, name, state_code, country, invoice_parts_on_due_date)
select ('cccccccc-0000-0000-0000-00000020950' || n)::uuid, 'dddddddd-0000-0000-0000-000000209501',
       'Cust 2095-' || n, '07', 'India', n = 3
  from generate_series(1, 3) n;

insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount, subtotal, billing_cycle, status, line_items)
select 'TESTQ-R2095-' || n, c.tenant_id, c.name, c.id, 18, 383972, 325400, 'quarterly', 'accepted',
       '[{"name":"Google Workspace Business Starter","qty":57,"rate":3200,"commitment":"annual_quarterly"},
         {"name":"Google Workspace Business Standard","qty":13,"rate":11000,"commitment":"annual_quarterly"}]'::jsonb
  from generate_series(1, 3) n
  join public.customers c on c.id = ('cccccccc-0000-0000-0000-00000020950' || n)::uuid;

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                                  billing_cycle, quote_id, start_date, status, created_at)
select ('eeeeeeee-0000-0000-0000-0000002095' || n || k)::uuid, q.tenant_id, q.customer_id, q.customer_name,
       case k when 1 then 'Google Workspace Business Starter' else 'Google Workspace Business Standard' end,
       'google'::vendor, case k when 1 then 57 else 13 end, case k when 1 then 15200 else 11917 end,
       'quarterly'::billing_cycle, q.id, public.ist_today() - 7, 'active',
       now() - interval '1 hour' + make_interval(secs => k)
  from generate_series(1, 3) n
  cross join generate_series(1, 2) k
  join public.quotes q on q.id = 'TESTQ-R2095-' || n;

insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                          period_start, period_end, taxable_amount, tax_rate)
select ('bbbbbbbb-0000-0000-0000-000002095' || n || k || '1')::uuid, s.tenant_id, s.id,
       s.start_date, 1, s.start_date, s.start_date, (s.start_date + interval '3 months')::date,
       s.mrr * 3, 18
  from generate_series(1, 3) n
  cross join generate_series(1, 2) k
  join public.subscriptions s on s.id = ('eeeeeeee-0000-0000-0000-0000002095' || n || k)::uuid;

do $$
begin
  perform public.record_payment('TESTQ-R2095-1', 95993, 'upi', 'R2095-PAY-1');
  perform public.record_payment('TESTQ-R2095-2', 95993, 'upi', 'R2095-PAY-2');
end $$;

do $$
declare
  r jsonb; v_inv text; v_new text; v_n integer; v_i record; v_st record; v_open integer; v_used integer;
begin
  -- ── A. the MOTION PHILM case ──────────────────────────────────────────────────────────────
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000002095111', false);
  v_inv := r->>'invoice_id';
  if v_inv is null or (select status::text from public.invoices where id = v_inv) <> 'paid'
     or (select amount from public.invoices where id = v_inv) <> 95993 then
    raise exception 'A setup FAIL: Q1 not invoiced paid ₹95,993: %', r;
  end if;

  perform public.issue_credit_note(v_inv, 50000, 'other', 'Re-issue Q1', null);
  -- one note of two: Q1 still invoiced by it
  if (select count(*) from public.subscription_billings where invoice_id = v_inv) <> 2 then
    raise exception 'A FAIL: a partial credit note freed the period';
  end if;
  perform public.issue_credit_note(v_inv, 45993, 'other', 'Re-issue Q1', null);

  select count(*) into v_n from public.subscription_billings
   where id in ('bbbbbbbb-0000-0000-0000-000002095111', 'bbbbbbbb-0000-0000-0000-000002095121')
     and invoice_id is null and v_inv = any(credited_invoice_ids);
  if v_n <> 2 then
    raise exception 'A FAIL: after credit notes covering % in full, % of 2 Q1 parts are free (want 2)', v_inv, v_n;
  end if;

  select * into v_st from public.split_sale_invoice_status(array['TESTQ-R2095-1']) limit 1;
  if v_st.state is distinct from 'ready' or v_st.gross is distinct from 95993 then
    raise exception 'A FAIL: pending list says % gross % for the credited Q1 (want ready / 95,993)', v_st.state, v_st.gross;
  end if;

  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000002095111', false);
  v_new := r->>'invoice_id';
  if r->>'action' <> 'invoice' or v_new is null or v_new = v_inv then
    raise exception 'A FAIL: Generate Q1 again gave % (want a new invoice)', r;
  end if;
  select * into v_i from public.invoices where id = v_new;
  if v_i.amount <> 95993 or v_i.status::text <> 'paid' or v_i.paid_amount <> 95993 then
    raise exception 'A FAIL: new Q1 invoice % % paid % (want 95,993 / paid / 95,993)', v_i.amount, v_i.status, v_i.paid_amount;
  end if;
  if (select count(*) from public.subscription_billings where invoice_id = v_new) <> 2 then
    raise exception 'A FAIL: the new invoice does not bill both Q1 parts';
  end if;
  select coalesce(sum(amount) filter (where status = 'open'), 0), coalesce(sum(amount) filter (where used_invoice_id = v_new), 0)
    into v_open, v_used
    from public.customer_credits where customer_id = 'cccccccc-0000-0000-0000-000000209501';
  if v_open <> 0 or v_used <> 95993 then
    raise exception 'A FAIL: credit-note credit open % / used by the new invoice % (want 0 / 95,993)', v_open, v_used;
  end if;
  if public.instalment_credit('eeeeeeee-0000-0000-0000-000000209511') <> 0 then
    raise exception 'A FAIL: pool % after re-invoicing (want 0 — the money is spent once)',
      public.instalment_credit('eeeeeeee-0000-0000-0000-000000209511');
  end if;

  -- ── B. a partial credit note alone keeps the link ─────────────────────────────────────────
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000002095211', false);
  v_inv := r->>'invoice_id';
  perform public.issue_credit_note(v_inv, 1000, 'other', 'Discount', null);
  if (select count(*) from public.subscription_billings where invoice_id = v_inv) <> 2 then
    raise exception 'B FAIL: a partial credit note freed the period';
  end if;

  -- ── C. unpaid part invoice (invoiced on due date) fully credited → a request, no re-invoice ─
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000002095311', false);
  v_inv := r->>'invoice_id';
  if v_inv is null or (select status::text from public.invoices where id = v_inv) = 'paid' then
    raise exception 'C setup FAIL: %', r;
  end if;
  update public.customers set invoice_parts_on_due_date = false where id = 'cccccccc-0000-0000-0000-000000209503';
  perform public.issue_credit_note(v_inv, 95993, 'other', 'Cancel', null);
  if exists (select 1 from public.subscription_billings where invoice_id = v_inv) then
    raise exception 'C FAIL: a fully credited unpaid invoice still bills the period';
  end if;
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000002095311', true);
  if r->>'action' <> 'request' then
    raise exception 'C FAIL: an unpaid freed Q1 answers % (want a payment request)', r;
  end if;
end $$;

select 'R-2095 credited part rebill: ALL PASS' as result;

rollback;
