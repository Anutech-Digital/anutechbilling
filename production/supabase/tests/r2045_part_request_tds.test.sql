\set ON_ERROR_STOP on
-- R-2045 (28 Oct 2026, Pardeep): a part payment request (R-2044) paid net of TDS counts as FULLY
-- paid when bank + TDS covers it: ONE tax invoice for the FULL part, status Paid, and the TDS is
-- a TDS receivable on THAT invoice — the way a TDS receipt on an invoice is booked.
-- Migration 20261028082218_r2045_part_request_tds. Self-asserting, ONE transaction,
-- rolled back:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r2045_part_request_tds.test.sql
--
-- Quarterly parts, 18% GST, through the Record payment sheet's RPC (record_desk_payment) as a
-- billing user:
--   A. Owner's case: Q2 taxable ₹4,080 + GST = ₹4,814; 194J 10% on the taxable → TDS ₹408,
--      bank ₹4,406 → one paid tax invoice ₹4,814; TDS receivable ₹408 on that invoice.
--   B. Card's case: part ₹7,080 (taxable 6,000 + GST 1,080) paid ₹6,372 + TDS ₹708 → one paid
--      tax invoice ₹7,080; TDS receivable ₹708 on that invoice (₹708 > 10% × 6,000 is only a
--      warning in the sheet, never a block).
--   C. Bank reconcile (reconcile_bank_credit_to_item, "the rest is TDS") on a ₹7,080 part with
--      a ₹6,372 bank line → same: one paid invoice ₹7,080, TDS ₹708 on it.
--   D. instalment_credit counts bank + TDS: nothing left over after the part's invoice.
--   E. Bank short and no TDS (₹6,372 only) → no invoice yet (R-2044 unchanged).

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

insert into auth.users (id, email) values ('e2045000-0000-4000-8000-0000000000a2', 'r2045-billing@example.test');
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('dddddddd-0000-0000-0000-000000204501','R2045 Co','r2045@example.in','07','R2045');
insert into public.users (id, tenant_id, email, full_name, role, is_active)
  values ('e2045000-0000-4000-8000-0000000000a2','dddddddd-0000-0000-0000-000000204501','r2045-billing@example.in','R2045 Billing','billing',true);
insert into public.customers (id, tenant_id, name, state_code, country)
  values ('cccccccc-0000-0000-0000-000000204501','dddddddd-0000-0000-0000-000000204501','Delhi 2045','07','India');
insert into public.bank_accounts (id, tenant_id, name, bank_name)
  values ('e2045000-0000-4000-8000-0000000000ba','dddddddd-0000-0000-0000-000000204501','R2045 Current','R2045 Bank');

-- Four sales, part 1 paid at the sale: 1 = owner's ₹4,080 part, 2..4 = ₹6,000 parts.
insert into public.quotes (id, tenant_id, customer_name, customer_id, tax_rate, amount, subtotal, billing_cycle, line_items)
select 'TESTQ-R2045-' || n, 'dddddddd-0000-0000-0000-000000204501', 'Delhi 2045',
       'cccccccc-0000-0000-0000-000000204501', 18, tx * 4 * 118 / 100, tx * 4, 'quarterly',
       jsonb_build_array(jsonb_build_object('name', 'Workspace Starter', 'qty', 1, 'rate', tx * 4, 'commitment', 'annual_quarterly'))
  from (values (1, 4080), (2, 6000), (3, 6000), (4, 6000)) v(n, tx);
insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, status, reference, received_at, created_at)
select gen_random_uuid(), 'dddddddd-0000-0000-0000-000000204501', 'TESTQ-R2045-' || n,
       'cccccccc-0000-0000-0000-000000204501', tx * 118 / 100, 'upi', 'received', 'R2045-SALE-' || n, now(), now()
  from (values (1, 4080), (2, 6000), (3, 6000), (4, 6000)) v(n, tx);
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                                  billing_cycle, quote_id, start_date, status)
select ('eeeeeeee-0000-0000-0000-00000020450' || n)::uuid, 'dddddddd-0000-0000-0000-000000204501',
       'cccccccc-0000-0000-0000-000000204501', 'Delhi 2045', 'Workspace Starter', 'google'::vendor, 2, 1000,
       'quarterly'::billing_cycle, 'TESTQ-R2045-' || n, public.ist_today() - 92, 'active'
  from generate_series(1, 4) n;
insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                          period_start, period_end, taxable_amount, tax_rate)
select ('bbbbbbbb-0000-0000-0000-0000002045' || n || p)::uuid, 'dddddddd-0000-0000-0000-000000204501',
       ('eeeeeeee-0000-0000-0000-00000020450' || n)::uuid,
       public.ist_today() - 92, p,
       case p when 1 then public.ist_today() - 92 else public.ist_today() end,
       case p when 1 then public.ist_today() - 92 else public.ist_today() end,
       case p when 1 then public.ist_today() - 1 else public.ist_today() + 89 end,
       case n when 1 then 4080 else 6000 end, 18
  from generate_series(1, 4) n, generate_series(1, 2) p;
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, reference, credit, debit)
  values ('e2045000-0000-4000-8000-0000000000b3', 'dddddddd-0000-0000-0000-000000204501', 'e2045000-0000-4000-8000-0000000000ba',
          public.ist_today(), 'NEFT Delhi 2045 Q2', 'R2045-UTR-C', 6372, 0);

-- Part 1 of each sale invoiced, part 2 becomes its payment request (as the billing cron does).
create temp table r2045_req (n int primary key, q text) on commit drop;
grant all on r2045_req to authenticated;
do $$
declare r jsonb; n int;
begin
  for n in 1..4 loop
    r := public.bill_subscription_instalment(('bbbbbbbb-0000-0000-0000-0000002045' || n || '1')::uuid, false);
    if r->>'action' <> 'invoice' then raise exception 'setup: part 1 of sale % → %', n, r; end if;
    r := public.bill_subscription_instalment(('bbbbbbbb-0000-0000-0000-0000002045' || n || '2')::uuid, false);
    if r->>'action' <> 'request' then raise exception 'setup: part 2 of sale % → %', n, r; end if;
    insert into r2045_req values (n, r->>'quote_id');
  end loop;
end $$;

create temp table r2045_fail (msg text) on commit drop;
grant all on r2045_fail to authenticated;

-- What a part ended up with: its invoice, and the TDS receivable rows of the payment.
create function pg_temp.r2045_check(p_case text, p_n int, p_gross int, p_tds int) returns void language plpgsql as $f$
declare v_q text; v_inv text; v_i record; v_cnt int; v_tcnt int; v_tsum int; v_tinv text;
begin
  select q into v_q from r2045_req where n = p_n;
  select invoice_id into v_inv from public.subscription_billings
   where id = ('bbbbbbbb-0000-0000-0000-0000002045' || p_n || '2')::uuid;
  if v_inv is null then
    insert into r2045_fail values (p_case || ': no tax invoice for the part (bank + TDS should pay it in full)');
    return;
  end if;
  select * into v_i from public.invoices where id = v_inv;
  if v_i.amount <> p_gross or v_i.status::text <> 'paid' or coalesce(v_i.paid_amount, 0) <> p_gross then
    insert into r2045_fail values (format('%s: invoice %s amount %s status %s paid %s (want %s, paid, paid %s)',
      p_case, v_inv, v_i.amount, v_i.status, v_i.paid_amount, p_gross, p_gross));
  end if;
  if (select invoice_id from public.quotes where id = v_q) is distinct from v_inv then
    insert into r2045_fail values (p_case || ': the request does not point at its invoice');
  end if;
  select count(*) into v_cnt from public.subscription_billings b
   where b.subscription_id = ('eeeeeeee-0000-0000-0000-00000020450' || p_n)::uuid and b.invoice_id is not null;
  if v_cnt <> 2 then insert into r2045_fail values (p_case || ': ' || v_cnt || ' invoiced parts (want 2: part 1 and part 2)'); end if;
  select count(*), coalesce(sum(t.tds_amount), 0)::int, max(t.invoice_id) into v_tcnt, v_tsum, v_tinv
    from public.tds_receivable t join public.payments p on p.id = t.payment_id
   where p.quote_id = v_q;
  if v_tcnt <> 1 or v_tsum <> p_tds then
    insert into r2045_fail values (format('%s: %s TDS receivable row(s), ₹%s (want 1, ₹%s)', p_case, v_tcnt, v_tsum, p_tds));
  elsif v_tinv is distinct from v_inv then
    insert into r2045_fail values (format('%s: TDS receivable is on invoice %s, not on the part''s invoice %s', p_case, coalesce(v_tinv, 'none'), v_inv));
  end if;
end $f$;
grant execute on function pg_temp.r2045_check(text, int, int, int) to authenticated;

do $$
declare v_r jsonb; v_q text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2045000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);

  -- A. owner's case: ₹4,406 bank + ₹408 TDS (10% of 4,080) on a ₹4,814 part — the sheet sends bank + TDS.
  select q into v_q from r2045_req where n = 1;
  v_r := public.record_desk_payment(v_q, 4406 + 408, 'bank_transfer', 'R2045-A', null, null, 0,
                                    public.ist_today(), 'e2045000-0000-4000-8000-0000000000ba',
                                    408, 4080, 4406, '194J', 10, null, null, null);
  perform pg_temp.r2045_check('A', 1, 4814, 408);

  -- B. card's case: ₹6,372 bank + ₹708 TDS on a ₹7,080 part.
  select q into v_q from r2045_req where n = 2;
  v_r := public.record_desk_payment(v_q, 6372 + 708, 'bank_transfer', 'R2045-B', null, null, 0,
                                    public.ist_today(), 'e2045000-0000-4000-8000-0000000000ba',
                                    708, 6000, 6372, '194J', 10, null, null, null);
  perform pg_temp.r2045_check('B', 2, 7080, 708);

  -- C. bank reconcile: ₹6,372 line, the ₹708 rest booked as TDS.
  select q into v_q from r2045_req where n = 3;
  v_r := public.reconcile_bank_credit_to_item('e2045000-0000-4000-8000-0000000000b3', v_q, null, 708, 10, '194J');
  perform pg_temp.r2045_check('C', 3, 7080, 708);

  -- D. bank + TDS fully absorbed by the part's invoice — no credit left to pay a later part.
  set local role postgres;   -- instalment_credit is service_role only
  if public.instalment_credit('eeeeeeee-0000-0000-0000-000000204502') <> 0 then
    insert into r2045_fail values ('D: instalment_credit after B = '
      || public.instalment_credit('eeeeeeee-0000-0000-0000-000000204502') || ' (want 0)');
  end if;

  set local role authenticated;

  -- E. ₹6,372 with no TDS: part paid in part → no invoice yet.
  select q into v_q from r2045_req where n = 4;
  v_r := public.record_desk_payment(v_q, 6372, 'bank_transfer', 'R2045-E', null, null, 0,
                                    public.ist_today(), 'e2045000-0000-4000-8000-0000000000ba');
  if (select invoice_id from public.subscription_billings where id = 'bbbbbbbb-0000-0000-0000-000000204542') is not null then
    insert into r2045_fail values ('E: a part paid ₹6,372 of ₹7,080 without TDS was invoiced');
  end if;
end $$;

do $$
declare v_msgs text;
begin
  select string_agg(msg, E'\n') into v_msgs from r2045_fail;
  if v_msgs is not null then raise exception E'R-2045 FAIL:\n%', v_msgs; end if;
  raise notice 'PASS r2045_part_request_tds';
end $$;

rollback;
