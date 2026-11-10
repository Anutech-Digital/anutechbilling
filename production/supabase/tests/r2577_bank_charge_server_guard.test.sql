\set ON_ERROR_STOP on
-- R-2577 (independent review of R-2192): the bank / SWIFT charge write-off is guarded on the SERVER.
-- Migration: 20261107221154_r2577_bank_charge_server_guard.sql
-- Self-asserting, ONE transaction, rolled back — run on the LOCAL DB only:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r2577_bank_charge_server_guard.test.sql
--
-- Expect "PASS r2577_bank_charge_server_guard". Every check is collected and failures listed together.
--
--   DOMESTIC   India customer, invoice ₹59,000 (taxable ₹50,000), NEFT ₹57,500, rest 'bank_charge'
--              → refused (check_violation), nothing booked, invoice still due.
--   DOM-TDS    same invoice, NEFT ₹54,000 (₹5,000 = 10% TDS on ₹50,000) → refused.
--   REMIT-TDS  India customer, the line an inward remittance, ₹5,000 short (10% TDS on ₹50,000) → refused.
--   FOREIGN    Singapore customer, ₹59,000 invoice, wire ₹58,500 → booked: ₹500 Bank Charges EXP-FXC,
--              invoice Paid (₹500 = 1% of ₹50,000, but a customer abroad deducts no Indian TDS).
--   TYPED      India customer, NEFT ₹57,500 whose narration carries 'USD1@1' (not this credit) → refused.
--   REMIT      India customer, the line an inward remittance (USD647.78@90), ₹700 short → booked.

begin;
select set_config('request.jwt.claims', '', true);

create temp table r2577_fail (msg text) on commit drop;

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

insert into auth.users (id, email) values ('e2577000-0000-4000-8000-0000000000a2', 'r2577-owner@example.test');
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e2577000-0000-0000-0000-0000000000a0', 'R2577 Co', 'r2577@example.in', '07', 'R257');
insert into public.users (id, tenant_id, email, full_name, role, is_active, created_at) values
  ('e2577000-0000-4000-8000-0000000000a2', 'e2577000-0000-0000-0000-0000000000a0', 'r2577-owner@example.in', 'R2577 Owner', 'owner', true, now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, country, domain) values
  ('e2577000-0000-4000-8000-0000000000c1', 'e2577000-0000-0000-0000-0000000000a0', 'R2577 Delhi Traders', '07', 'India', 'delhi2577.in'),
  ('e2577000-0000-4000-8000-0000000000c2', 'e2577000-0000-0000-0000-0000000000a0', 'R2577 Lion Pte', null, 'Singapore', 'lion2577.sg');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('e2577000-0000-4000-8000-0000000000ba', 'e2577000-0000-0000-0000-0000000000a0', 'R2577 Current', 'R2577 Bank');

-- Three invoices of ₹59,000 (taxable ₹50,000): IN-1 (India), SG (Singapore), IN-2 (India, remittance).
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items, is_one_off, created_date)
select v.id, 'e2577000-0000-0000-0000-0000000000a0', v.cust::uuid, v.cname,
       59000, 50000, 0, 18, 'accepted', 'awaiting', 'yearly',
       jsonb_build_array(jsonb_build_object('name', 'Service ' || v.id, 'qty', 1, 'rate', 50000, 'one_time', true)),
       true, '2026-10-10'
  from (values ('Q-R2577-IN1', 'e2577000-0000-4000-8000-0000000000c1', 'R2577 Delhi Traders'),
               ('Q-R2577-SG',  'e2577000-0000-4000-8000-0000000000c2', 'R2577 Lion Pte'),
               ('Q-R2577-IN2', 'e2577000-0000-4000-8000-0000000000c1', 'R2577 Delhi Traders')) as v(id, cust, cname);
select set_config('request.jwt.claims', '{"sub":"e2577000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
select public.generate_invoice(q) from unnest(array['Q-R2577-IN1', 'Q-R2577-SG', 'Q-R2577-IN2']) q;

create function pg_temp.inv(p_quote text) returns text language sql as $f$ select invoice_id from public.quotes where id = p_quote $f$;
create function pg_temp.due(p_cust uuid, p_quote text) returns int language sql as $f$
  select o.amount_due::int from public.bank_credit_open_items(p_cust) o where o.invoice_id = pg_temp.inv(p_quote) $f$;

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, reference, credit, debit, source)
select v.id::uuid, 'e2577000-0000-0000-0000-0000000000a0', 'e2577000-0000-4000-8000-0000000000ba', '2026-10-20', v.d, v.r, v.amt, 0, 'manual'
  from (values ('e2577000-0000-4000-8000-0000000000d1', 'NEFT R2577 DELHI TRADERS',     'NEFTR2577A', 57500),
               ('e2577000-0000-4000-8000-0000000000d2', 'NEFT R2577 DELHI TRADERS TDS', 'NEFTR2577B', 54000),
               ('e2577000-0000-4000-8000-0000000000d3', 'INW R2577 DELHI USD600.0@90',  'INWR2577C',   54000),
               ('e2577000-0000-4000-8000-0000000000d4', 'INWARD SWIFT R2577 LION',      'SWIFTR2577D', 58500),
               ('e2577000-0000-4000-8000-0000000000d6', 'NEFT R2577 DELHI USD1@1',      'NEFTR2577F',  57500),
               ('e2577000-0000-4000-8000-0000000000d5', 'INW R2577 DELHI USD647.78@90', 'INWR2577E',   58300)) v(id, d, r, amt);

do $$
declare
  r jsonb; v_ok boolean; v_msg text;
  c_in constant uuid := 'e2577000-0000-4000-8000-0000000000c1';
  c_sg constant uuid := 'e2577000-0000-4000-8000-0000000000c2';
begin
  if pg_temp.due(c_in, 'Q-R2577-IN1') is distinct from 59000 or pg_temp.due(c_sg, 'Q-R2577-SG') is distinct from 59000 then
    raise exception 'setup: the invoices are not ₹59,000 due (IN1 %, SG %)', pg_temp.due(c_in, 'Q-R2577-IN1'), pg_temp.due(c_sg, 'Q-R2577-SG');
  end if;

  -- DOMESTIC: ₹1,500 short on an Indian NEFT — a short payment, never a bank charge.
  v_ok := false;
  begin
    perform public.reconcile_bank_credit_split('e2577000-0000-4000-8000-0000000000d1', c_in,
      jsonb_build_array(jsonb_build_object('invoice_id', pg_temp.inv('Q-R2577-IN1'), 'amount', 59000)), null, 'bank_charge');
  exception when check_violation then v_ok := sqlerrm like '%customer is in India%'; v_msg := sqlerrm;
  end;
  if not v_ok then insert into r2577_fail values ('DOMESTIC: ₹1,500 short on an Indian NEFT was not refused as a bank charge (' || coalesce(v_msg, 'accepted') || ')'); end if;

  -- DOM-TDS: ₹5,000 = 10% TDS on ₹50,000.
  v_ok := false; v_msg := null;
  begin
    perform public.reconcile_bank_credit_split('e2577000-0000-4000-8000-0000000000d2', c_in,
      jsonb_build_array(jsonb_build_object('invoice_id', pg_temp.inv('Q-R2577-IN1'), 'amount', 59000)), null, 'bank_charge');
  exception when check_violation then v_ok := true; v_msg := sqlerrm;
  end;
  if not v_ok then insert into r2577_fail values ('DOM-TDS: a 10% TDS gap of an Indian customer was booked as a bank charge'); end if;

  -- REMIT-TDS: an Indian customer paying from abroad, the gap exactly 10% of the taxable — TDS, refused.
  v_ok := false; v_msg := null;
  begin
    perform public.reconcile_bank_credit_split('e2577000-0000-4000-8000-0000000000d3', c_in,
      jsonb_build_array(jsonb_build_object('invoice_id', pg_temp.inv('Q-R2577-IN2'), 'amount', 59000)), null, 'bank_charge');
  exception when check_violation then v_ok := sqlerrm like '%10 per cent TDS%'; v_msg := sqlerrm;
  end;
  if not v_ok then insert into r2577_fail values ('REMIT-TDS: a gap of 10% TDS on ₹50,000 was not refused (' || coalesce(v_msg, 'accepted') || ')'); end if;

  -- TYPED: a remittance-looking token that is not this credit is not a remittance.
  v_ok := false; v_msg := null;
  begin
    perform public.reconcile_bank_credit_split('e2577000-0000-4000-8000-0000000000d6', c_in,
      jsonb_build_array(jsonb_build_object('invoice_id', pg_temp.inv('Q-R2577-IN1'), 'amount', 59000)), null, 'bank_charge');
  exception when check_violation then v_ok := sqlerrm like '%customer is in India%'; v_msg := sqlerrm;
  end;
  if not v_ok then insert into r2577_fail values ('TYPED: "USD1@1" in an Indian NEFT narration let a ₹1,500 gap through (' || coalesce(v_msg, 'accepted') || ')'); end if;

  if exists (select 1 from public.expenses where tenant_id = 'e2577000-0000-0000-0000-0000000000a0')
     or exists (select 1 from public.payments where tenant_id = 'e2577000-0000-0000-0000-0000000000a0')
     or exists (select 1 from public.bank_transactions where tenant_id = 'e2577000-0000-0000-0000-0000000000a0' and matched_to_type is not null) then
    insert into r2577_fail values ('a refused bank charge wrote something (expense / receipt / reconciled line)');
  end if;
  if (select status from public.invoices where id = pg_temp.inv('Q-R2577-IN1')) = 'paid' then
    insert into r2577_fail values ('DOMESTIC: the Indian invoice is Paid after a refused bank charge');
  end if;

  -- FOREIGN: ₹500 SWIFT charge on a Singapore wire — booked (R-2192's path).
  r := public.reconcile_bank_credit_split('e2577000-0000-4000-8000-0000000000d4', c_sg,
         jsonb_build_array(jsonb_build_object('invoice_id', pg_temp.inv('Q-R2577-SG'), 'amount', 59000)), null, 'bank_charge');
  if (r->>'bank_charge')::int is distinct from 500 then
    insert into r2577_fail values ('FOREIGN: result ' || r::text || ' (want bank_charge 500)');
  end if;
  if (select status from public.invoices where id = pg_temp.inv('Q-R2577-SG')) is distinct from 'paid' then
    insert into r2577_fail values ('FOREIGN: the invoice is not Paid after the wire + ₹500 bank charge');
  end if;
  if not exists (select 1 from public.expenses where id = 'EXP-FXC-e2577000-0000-4000-8000-0000000000d4'
                  and category = 'Bank Charges' and amount = 500) then
    insert into r2577_fail values ('FOREIGN: no ₹500 Bank Charges expense on the wire line');
  end if;

  -- REMIT: an Indian customer paying through an inward remittance — the remitting bank's ₹700 charge is real.
  r := public.reconcile_bank_credit_split('e2577000-0000-4000-8000-0000000000d5', c_in,
         jsonb_build_array(jsonb_build_object('invoice_id', pg_temp.inv('Q-R2577-IN2'), 'amount', 59000)), null, 'bank_charge');
  if (r->>'bank_charge')::int is distinct from 700
     or not exists (select 1 from public.expenses where id = 'EXP-FXC-e2577000-0000-4000-8000-0000000000d5' and amount = 700) then
    insert into r2577_fail values ('REMIT: ₹700 short on an inward remittance was not booked as a bank charge (' || coalesce(r::text, 'null') || ')');
  end if;
end $$;

do $$
declare v_msgs text;
begin
  select string_agg(msg, E'\n  - ') into v_msgs from r2577_fail;
  if v_msgs is not null then
    raise exception E'FAIL r2577_bank_charge_server_guard:\n  - %', v_msgs;
  end if;
  raise notice 'PASS r2577_bank_charge_server_guard';
end $$;

rollback;
