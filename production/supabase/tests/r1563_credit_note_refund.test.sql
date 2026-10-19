\set ON_ERROR_STOP on
-- R-1563 + R-1566 (P1 money / GST, audit 18 Oct 2026): a credit note on an invoice that is
-- already paid must turn the extra money into customer credit and settle the invoice; a
-- payment on an invoiced quote can then be refunded for the part credit notes cover.
-- Migration: 20261018171947_r1563_credit_note_refund.
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r1563_credit_note_refund.test.sql
--
-- Expect "PASS r1563_credit_note_refund". Every check is collected and listed together.
--
-- R-1566 (issue_credit_note)
--   C1  Quote P ₹11,800 paid in full, invoiced (Paid). Credit note ₹1,180 → an OPEN
--       customer_credits row of ₹1,180 (source credit_note, the CN id, the invoice id);
--       the invoice stays Paid. A second note ₹1,000 adds only ₹1,000 (total ₹2,180).
--   C2  Quote Q ₹11,800 invoiced first, ₹10,000 paid (Pending, paid_amount 10,000).
--       Credit note ₹1,800 → nothing due: invoice Paid (paid_date set), NO credit (nothing
--       paid over). A second credit note ₹1,000 → ₹1,000 credit.
--   C3  Credit note on a draft / void invoice → refused.
-- R-1563 (refund_payment)
--   F1  Quote R ₹11,800 paid + invoiced, no credit note → refund REFUSED, and the message
--       names the next step (credit note on that invoice).
--   F2  Full credit note ₹11,800 on R → ₹11,800 credit; refund → booked with an RFV number,
--       cash amount 11,800; the customer's credit from that note is closed (paid out as
--       cash, not spendable again); the invoice is still Paid (nothing due after the note).
--   F3  Quote S ₹11,800 paid + invoiced, credit note ₹1,180 only → refund of the ₹11,800
--       payment REFUSED (it would pay back ₹10,620 the customer still owes); the ₹1,180
--       credit stays open.

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e1563000-0000-4000-8000-0000000000a2', 'r1563-owner@example.test');
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e1563000-0000-0000-0000-0000000000a0', 'R1563 A', 'r1563a@example.in', '07', 'R163');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1563000-0000-4000-8000-0000000000a2', 'e1563000-0000-0000-0000-0000000000a0', 'r1563-owner@example.in', 'R1563 Owner', 'owner', true);
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e1563000-0000-4000-8000-0000000000c1', 'e1563000-0000-0000-0000-0000000000a0', 'R1563 Cust P', '07', 'India'),
  ('e1563000-0000-4000-8000-0000000000c2', 'e1563000-0000-0000-0000-0000000000a0', 'R1563 Cust Q', '07', 'India'),
  ('e1563000-0000-4000-8000-0000000000c3', 'e1563000-0000-0000-0000-0000000000a0', 'R1563 Cust R', '07', 'India'),
  ('e1563000-0000-4000-8000-0000000000c4', 'e1563000-0000-0000-0000-0000000000a0', 'R1563 Cust S', '07', 'India');
-- One-off quotes (no subscription side effects).
insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
select 'Q-R1563-' || k, 'e1563000-0000-0000-0000-0000000000a0', null, c::uuid,
       'R1563 Cust ' || k, 11800, 10000, 18, 'accepted', 'awaiting', '[]'::jsonb
  from (values ('P', 'e1563000-0000-4000-8000-0000000000c1'),
               ('Q', 'e1563000-0000-4000-8000-0000000000c2'),
               ('R', 'e1563000-0000-4000-8000-0000000000c3'),
               ('S', 'e1563000-0000-4000-8000-0000000000c4')) v(k, c);
-- Draft + void invoices for C3.
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, net_payable, taxable_value, tax_amount, tax_rate, inter_state)
values ('INV-R1563-DRAFT', 'e1563000-0000-0000-0000-0000000000a0', 'e1563000-0000-4000-8000-0000000000c1', 'R1563 Cust P', 11800, 'draft', public.ist_today(), 11800, 10000, 1800, 18, false),
       ('INV-R1563-VOID',  'e1563000-0000-0000-0000-0000000000a0', 'e1563000-0000-4000-8000-0000000000c1', 'R1563 Cust P', 11800, 'void',  public.ist_today(), 11800, 10000, 1800, 18, false);

create temp table r1563_fail (msg text) on commit drop;
grant all on r1563_fail to authenticated;
create function pg_temp.r1563_open(p_customer uuid) returns integer language sql as $$
  select coalesce(sum(amount), 0)::int from public.customer_credits
   where customer_id = p_customer and status = 'open' $$;
grant execute on function pg_temp.r1563_open(uuid) to authenticated;

do $$
declare
  c1 constant uuid := 'e1563000-0000-4000-8000-0000000000c1';
  c2 constant uuid := 'e1563000-0000-4000-8000-0000000000c2';
  c3 constant uuid := 'e1563000-0000-4000-8000-0000000000c3';
  c4 constant uuid := 'e1563000-0000-4000-8000-0000000000c4';
  v_r jsonb; v_cn jsonb; v_inv text; v_pay uuid; v_msg text; v_n int; v_s text; v_d date; v_ok boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', 'e1563000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);

  -- ════ C1: credit note on a fully paid invoice → customer credit ══════════════════════
  v_r := public.record_desk_payment('Q-R1563-P', 11800, 'bank_transfer', 'R1563-P', null, null, 0, '2026-10-01', null);
  select invoice_id into v_inv from public.generate_invoice('Q-R1563-P');
  select status::text into v_s from public.invoices where id = v_inv;
  if v_s <> 'paid' then insert into r1563_fail values ('C1 setup: invoice is ' || v_s || ' (want paid)'); end if;

  v_msg := null;
  begin
    v_cn := public.issue_credit_note(v_inv, 1180, 'other', 'Discount after payment', null);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is not null then
    insert into r1563_fail values ('C1: credit note refused: ' || v_msg);
  else
    if pg_temp.r1563_open(c1) <> 1180 then
      insert into r1563_fail values ('C1: after a ₹1,180 credit note on a PAID invoice the customer has open credit ₹' ||
        pg_temp.r1563_open(c1) || ' (want ₹1,180 — the money the company now owes the customer)');
    end if;
    begin
      execute $q$select exists(select 1 from public.customer_credits
                   where customer_id = $1 and status = 'open' and source = 'credit_note'
                     and source_credit_note_id = $2 and source_invoice_id = $3 and amount = 1180)$q$
        into v_ok using c1, v_cn->>'credit_note_id', v_inv;
    exception when undefined_column then v_ok := false; end;
    if not coalesce(v_ok, false) then
      insert into r1563_fail values ('C1: the credit is not traced to credit note ' || (v_cn->>'credit_note_id') || ' / invoice ' || v_inv);
    end if;
    select status::text into v_s from public.invoices where id = v_inv;
    if v_s <> 'paid' then insert into r1563_fail values ('C1: invoice moved to ' || v_s || ' (want paid)'); end if;
    if (v_cn->>'customer_credit')::int is distinct from 1180 then
      insert into r1563_fail values ('C1: result customer_credit = ' || coalesce(v_cn->>'customer_credit', 'null') || ' (want 1180, the screen shows it)');
    end if;
    -- A second note credits only ITS amount — the first ₹1,180 is not made credit again.
    v_msg := null;
    begin
      v_cn := public.issue_credit_note(v_inv, 1000, 'other', 'Second discount', null);
    exception when others then v_msg := sqlerrm; end;
    if v_msg is not null then
      insert into r1563_fail values ('C1: second credit note refused: ' || v_msg);
    elsif pg_temp.r1563_open(c1) <> 2180 then
      insert into r1563_fail values ('C1: after a second ₹1,000 note the open credit is ₹' || pg_temp.r1563_open(c1) || ' (want ₹2,180 = ₹1,180 + ₹1,000)');
    end if;
  end if;

  -- ════ C2: part-paid invoice settled by a credit note ═════════════════════════════════
  select invoice_id into v_inv from public.generate_invoice('Q-R1563-Q');
  v_r := public.record_desk_payment('Q-R1563-Q', 10000, 'bank_transfer', 'R1563-Q', null, null, 0, '2026-10-02', null);
  select status::text, paid_amount into v_s, v_n from public.invoices where id = v_inv;
  if v_s = 'paid' or v_n <> 10000 then
    insert into r1563_fail values ('C2 setup: invoice ' || v_s || ', paid_amount ' || v_n || ' (want pending, 10000)');
  end if;
  v_msg := null;
  begin
    v_cn := public.issue_credit_note(v_inv, 1800, 'other', 'Rate corrected', null);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is not null then
    insert into r1563_fail values ('C2: credit note refused: ' || v_msg);
  else
    select status::text, paid_date into v_s, v_d from public.invoices where id = v_inv;
    if v_s <> 'paid' or v_d is null then
      insert into r1563_fail values ('C2: ₹10,000 paid on an invoice now worth ₹10,000 is still ' || v_s ||
        coalesce(' (paid ' || v_d || ')', ' with no paid date') || ' (want paid — otherwise reminders chase money not owed)');
    end if;
    if pg_temp.r1563_open(c2) <> 0 then
      insert into r1563_fail values ('C2: credit ₹' || pg_temp.r1563_open(c2) || ' made although nothing was paid over (want 0)');
    end if;
    v_msg := null;
    begin
      v_cn := public.issue_credit_note(v_inv, 1000, 'other', 'Further discount', null);
    exception when others then v_msg := sqlerrm; end;
    if v_msg is not null then
      insert into r1563_fail values ('C2: second credit note refused: ' || v_msg);
    elsif pg_temp.r1563_open(c2) <> 1000 then
      insert into r1563_fail values ('C2: after a further ₹1,000 note the open credit is ₹' || pg_temp.r1563_open(c2) || ' (want ₹1,000)');
    end if;
  end if;

  -- ════ C3: no credit note on a draft / void invoice ═══════════════════════════════════
  v_msg := null;
  begin
    perform public.issue_credit_note('INV-R1563-DRAFT', 1000, 'other', 'x', null);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null then insert into r1563_fail values ('C3: credit note on a DRAFT invoice went through'); end if;
  v_msg := null;
  begin
    perform public.issue_credit_note('INV-R1563-VOID', 1000, 'other', 'x', null);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null then insert into r1563_fail values ('C3: credit note on a VOID invoice went through'); end if;
  v_msg := null;
  begin
    perform public.issue_debit_note('INV-R1563-VOID', 1000, 'other', 'x', null);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null then insert into r1563_fail values ('C3: debit note on a VOID invoice went through'); end if;

  -- ════ F1: refund on an invoiced quote with no credit note ═══════════════════════════
  v_r := public.record_desk_payment('Q-R1563-R', 11800, 'bank_transfer', 'R1563-R', null, null, 0, '2026-10-01', null);
  v_pay := (v_r->>'payment_id')::uuid;
  select invoice_id into v_inv from public.generate_invoice('Q-R1563-R');
  v_msg := null;
  begin
    perform public.refund_payment(v_pay, 'Customer ne cancel kiya');
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null then
    insert into r1563_fail values ('F1: refund of a payment on invoiced quote R went through with NO credit note (GSTR would still show the full sale)');
  elsif v_msg not ilike '%credit note%' or v_msg not like '%' || v_inv || '%' then
    insert into r1563_fail values ('F1: refusal does not name the next step (credit note on ' || v_inv || '): ' || v_msg);
  end if;

  -- ════ F2: full credit note, then the refund is booked ═══════════════════════════════
  v_msg := null;
  begin
    v_cn := public.issue_credit_note(v_inv, 11800, 'cancellation', 'Order cancelled', null);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is not null then
    insert into r1563_fail values ('F2: full credit note refused: ' || v_msg);
  else
    if pg_temp.r1563_open(c3) <> 11800 then
      insert into r1563_fail values ('F2: after a full credit note the open credit is ₹' || pg_temp.r1563_open(c3) || ' (want ₹11,800)');
    end if;
    v_msg := null;
    begin
      v_r := public.refund_payment(v_pay, 'Customer ne cancel kiya');
    exception when others then v_msg := sqlerrm; end;
    if v_msg is not null then
      insert into r1563_fail values ('F2: refund refused even after a full credit note: ' || v_msg);
    else
      if v_r->>'refund_voucher_no' is null then
        insert into r1563_fail values ('F2: refund has no RFV number');
      end if;
      if (v_r->>'amount')::int is distinct from 11800 then
        insert into r1563_fail values ('F2: refund cash amount ' || coalesce(v_r->>'amount', 'null') || ' (want 11800)');
      end if;
      if pg_temp.r1563_open(c3) <> 0 then
        insert into r1563_fail values ('F2: after the refund the customer still has open credit ₹' || pg_temp.r1563_open(c3) || ' (want 0 — it went back as cash)');
      end if;
      select status::text into v_s from public.invoices where id = v_inv;
      if v_s <> 'paid' then insert into r1563_fail values ('F2: invoice is ' || v_s || ' after the refund (want paid — nothing due after a full credit note)'); end if;
      if exists (select 1 from public.subscriptions where quote_id = 'Q-R1563-R' and coalesce(outstanding_amount, 0) <> 0) then
        insert into r1563_fail values ('F2: a subscription shows money due after a full credit note + refund');
      end if;
    end if;
  end if;

  -- ════ F3: credit note smaller than the payment → refund refused ═════════════════════
  v_r := public.record_desk_payment('Q-R1563-S', 11800, 'bank_transfer', 'R1563-S', null, null, 0, '2026-10-01', null);
  v_pay := (v_r->>'payment_id')::uuid;
  select invoice_id into v_inv from public.generate_invoice('Q-R1563-S');
  perform public.issue_credit_note(v_inv, 1180, 'other', 'Discount', null);
  v_msg := null;
  begin
    perform public.refund_payment(v_pay, 'Customer ne cancel kiya');
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null then
    insert into r1563_fail values ('F3: ₹11,800 refunded against a ₹1,180 credit note (₹10,620 the customer still owes paid back)');
  elsif v_msg not ilike '%credit note%' then
    insert into r1563_fail values ('F3: refusal does not say a bigger credit note is needed: ' || v_msg);
  end if;
  if pg_temp.r1563_open(c4) <> 1180 then
    insert into r1563_fail values ('F3: open credit is ₹' || pg_temp.r1563_open(c4) || ' (want the ₹1,180 untouched)');
  end if;
end $$;

do $$
declare v_list text;
begin
  select string_agg(msg, E'\n  ') into v_list from r1563_fail;
  if v_list is not null then
    raise exception E'FAIL r1563_credit_note_refund:\n  %', v_list;
  end if;
  raise notice 'PASS r1563_credit_note_refund';
end $$;

rollback;
