\set ON_ERROR_STOP on
-- R-1676 (P1): one bank credit (UTR / UPI ref) is recorded once per company.
-- Migration: 20261019125620_r1676_payment_ref_once (trg_payments_ref_once,
-- assert_payment_ref_unused, payment_reference_duplicates, record_multi_invoice_payment batch).
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r1676_payment_ref_once.test.sql
--
-- Expect "PASS r1676_payment_ref_once". Every check is collected and failures listed together.
--
--   FIRST     a UTR on invoice 1 → recorded
--   DUP       the same UTR on invoice 2 → refused, naming the existing invoice; nothing saved
--   NORMALISE lower-case / spaces / hyphens, and UPI vs bank transfer → still the same credit
--   REPLAY    the same UTR again on invoice 1 → idempotent replay (unchanged)
--   OTHER CO  the same UTR in another company → recorded (per tenant)
--   NOT BANK  cash / cheque refs and a junk "NA" may repeat
--   MULTI     one new UTR across 2 invoices in one call → 2 rows; a used UTR → refused
--   REFUNDED  a refunded payment does not block its UTR
--   EDIT      changing a payment's reference to a used UTR → refused
--   LIST      payment_reference_duplicates() lists an old duplicate; a multi receipt is one credit

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e1676000-0000-4000-8000-0000000000a2', 'r1676-billing@example.test'),
  ('e1676000-0000-4000-8000-0000000000b2', 'r1676-billing-b@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e1676000-0000-0000-0000-0000000000a0', 'R1676 A', 'r1676a@example.in', '07', 'R16A'),
  ('e1676000-0000-0000-0000-0000000000b0', 'R1676 B', 'r1676b@example.in', '07', 'R16B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1676000-0000-4000-8000-0000000000a2', 'e1676000-0000-0000-0000-0000000000a0', 'r1676-billing@example.in',   'R1676 Billing',   'billing', true),
  ('e1676000-0000-4000-8000-0000000000b2', 'e1676000-0000-0000-0000-0000000000b0', 'r1676-billing-b@example.in', 'R1676 Billing B', 'billing', true);

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e1676000-0000-4000-8000-0000000000c1', 'e1676000-0000-0000-0000-0000000000a0', 'R1676 Cust T7', '07', 'India'),
  ('e1676000-0000-4000-8000-0000000000c2', 'e1676000-0000-0000-0000-0000000000a0', 'R1676 Cust T9', '07', 'India'),
  ('e1676000-0000-4000-8000-0000000000cb', 'e1676000-0000-0000-0000-0000000000b0', 'R1676 B Cust',  '07', 'India');

insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('e1676000-0000-4000-8000-0000000000ba', 'e1676000-0000-0000-0000-0000000000a0', 'R1676 Current', 'R1676 Bank');

insert into public.invoices (id, tenant_id, customer_name, customer_id, amount, net_payable, taxable_value, invoice_date, quote_id)
select v.id, v.t::uuid, 'R1676', v.c::uuid, v.amt, v.amt, v.tx, v.d::date, null
  from (values
    ('R16-I1', 'e1676000-0000-0000-0000-0000000000a0', 'e1676000-0000-4000-8000-0000000000c1', 1180, 1000, '2026-09-01'),
    ('R16-I2', 'e1676000-0000-0000-0000-0000000000a0', 'e1676000-0000-4000-8000-0000000000c2', 1180, 1000, '2026-09-02'),
    ('R16-I3', 'e1676000-0000-0000-0000-0000000000a0', 'e1676000-0000-4000-8000-0000000000c2', 1180, 1000, '2026-09-03'),
    ('R16-I4', 'e1676000-0000-0000-0000-0000000000a0', 'e1676000-0000-4000-8000-0000000000c2', 1180, 1000, '2026-09-04'),
    ('R16-I5', 'e1676000-0000-0000-0000-0000000000a0', 'e1676000-0000-4000-8000-0000000000c2', 1180, 1000, '2026-09-05'),
    ('R16-I6', 'e1676000-0000-0000-0000-0000000000a0', 'e1676000-0000-4000-8000-0000000000c2', 1180, 1000, '2026-09-06'),
    ('R16-I7', 'e1676000-0000-0000-0000-0000000000a0', 'e1676000-0000-4000-8000-0000000000c2', 1180, 1000, '2026-09-07'),
    ('R16-I8', 'e1676000-0000-0000-0000-0000000000a0', 'e1676000-0000-4000-8000-0000000000c2', 1180, 1000, '2026-09-08'),
    ('R16-I9', 'e1676000-0000-0000-0000-0000000000a0', 'e1676000-0000-4000-8000-0000000000c2', 1180, 1000, '2026-09-09'),
    ('R16-BI', 'e1676000-0000-0000-0000-0000000000b0', 'e1676000-0000-4000-8000-0000000000cb', 1180, 1000, '2026-09-01')
  ) v(id, t, c, amt, tx, d);

insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items, invoice_id)
select 'Q-' || i.id, i.tenant_id, null, i.customer_id, 'R1676', i.amount, i.taxable_value, 18, 'accepted', 'invoiced', '[]'::jsonb, i.id
  from public.invoices i where i.id like 'R16-%';
update public.invoices set quote_id = 'Q-' || id where id like 'R16-%';

create temp table r1676_fail (msg text) on commit drop;
grant all on r1676_fail to authenticated;

-- record_payment as the current claims; null on success, else 'SQLSTATE: message'.
create function pg_temp.r1676_pay(p_quote text, p_method text, p_ref text) returns text language plpgsql as $$
begin
  perform public.record_payment(p_quote, 1180, p_method, p_ref, null);
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function pg_temp.r1676_multi(p_ref text, p_alloc jsonb, p_received integer) returns text language plpgsql as $$
begin
  perform public.record_multi_invoice_payment('e1676000-0000-4000-8000-0000000000c2', '2026-10-05', 'bank_transfer',
            'e1676000-0000-4000-8000-0000000000ba', p_ref, p_received, p_alloc, true, null);
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function pg_temp.r1676_as(p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
end $$;
grant execute on function pg_temp.r1676_pay(text, text, text) to authenticated;
grant execute on function pg_temp.r1676_multi(text, jsonb, integer) to authenticated;
grant execute on function pg_temp.r1676_as(text) to authenticated;

do $$
declare
  v_e text; v_n int; v_r jsonb;
begin
  set local role authenticated;
  perform pg_temp.r1676_as('e1676000-0000-4000-8000-0000000000a2');

  -- ════ FIRST ═══════════════════════════════════════════════════════════════════════
  v_e := pg_temp.r1676_pay('Q-R16-I1', 'bank_transfer', 'TESTUTR123456');
  if v_e is not null then insert into r1676_fail values ('first UTR refused: ' || v_e); end if;

  -- ════ DUP: same UTR on another customer's invoice ══════════════════════════════════
  v_e := pg_temp.r1676_pay('Q-R16-I2', 'bank_transfer', 'TESTUTR123456');
  if v_e is null or v_e not like 'P0001: Ye UTR pehle se R16-I1 par hai — reference TESTUTR123456 is already recorded (R1676 Cust T7, ₹1180, %' then
    insert into r1676_fail values ('duplicate UTR not refused / wrong message: ' || coalesce(v_e, 'ran'));
  end if;
  if v_e is not null and v_e not like '%Several invoices%' then
    insert into r1676_fail values ('refusal has no next step: ' || v_e);
  end if;

  -- ════ NORMALISE ═══════════════════════════════════════════════════════════════════
  v_e := pg_temp.r1676_pay('Q-R16-I2', 'bank_transfer', '  testutr 1234-56 ');
  if v_e is null or v_e not like 'P0001: Ye UTR pehle se R16-I1 par hai%' then
    insert into r1676_fail values ('case/space variant not refused: ' || coalesce(v_e, 'ran'));
  end if;
  v_e := pg_temp.r1676_pay('Q-R16-I2', 'upi', 'TESTUTR123456');
  if v_e is null or v_e not like 'P0001: Ye UTR pehle se%' then
    insert into r1676_fail values ('same ref as UPI not refused: ' || coalesce(v_e, 'ran'));
  end if;

  -- ════ REPLAY on the same invoice is unchanged ══════════════════════════════════════
  begin
    v_r := public.record_payment('Q-R16-I1', 1180, 'bank_transfer', 'TESTUTR123456', null);
    if not coalesce((v_r->>'idempotent_replay')::boolean, false) then
      insert into r1676_fail values ('replay not idempotent: ' || v_r::text);
    end if;
  exception when others then insert into r1676_fail values ('replay raised: ' || sqlerrm);
  end;

  -- ════ NOT BANK: cash / cheque / junk refs may repeat ═══════════════════════════════
  v_e := pg_temp.r1676_pay('Q-R16-I3', 'cheque', '000123');
  if v_e is not null then insert into r1676_fail values ('cheque 1 refused: ' || v_e); end if;
  v_e := pg_temp.r1676_pay('Q-R16-I4', 'cheque', '000123');
  if v_e is not null then insert into r1676_fail values ('same cheque no. (other bank) refused: ' || v_e); end if;
  v_e := pg_temp.r1676_pay('Q-R16-I5', 'upi', 'NA');
  if v_e is not null then insert into r1676_fail values ('junk ref 1 refused: ' || v_e); end if;
  v_e := pg_temp.r1676_pay('Q-R16-I6', 'upi', 'NA');
  if v_e is not null then insert into r1676_fail values ('junk ref 2 refused (rule must skip refs under 6 chars): ' || v_e); end if;

  -- ════ MULTI ═══════════════════════════════════════════════════════════════════════
  v_e := pg_temp.r1676_multi('MULTIUTR987654', '[{"invoice_id":"R16-I7","amount":1180},{"invoice_id":"R16-I8","amount":1180}]', 2360);
  if v_e is not null then insert into r1676_fail values ('multi-invoice receipt refused: ' || v_e); end if;
  v_e := pg_temp.r1676_multi('testutr123456', '[{"invoice_id":"R16-I9","amount":1180}]', 1180);
  if v_e is null or v_e not like 'P0001: Ye UTR pehle se R16-I1 par hai%' then
    insert into r1676_fail values ('multi with a used UTR not refused: ' || coalesce(v_e, 'ran'));
  end if;
  -- the batch marker does not leak past the call
  v_e := pg_temp.r1676_pay('Q-R16-I9', 'bank_transfer', 'MULTIUTR987654');
  if v_e is null or v_e not like 'P0001: Ye UTR pehle se R16-I_ par hai%' then
    insert into r1676_fail values ('multi UTR re-used afterwards not refused: ' || coalesce(v_e, 'ran'));
  end if;

  -- ════ OTHER COMPANY ═══════════════════════════════════════════════════════════════
  perform pg_temp.r1676_as('e1676000-0000-4000-8000-0000000000b2');
  v_e := pg_temp.r1676_pay('Q-R16-BI', 'bank_transfer', 'TESTUTR123456');
  if v_e is not null then insert into r1676_fail values ('same UTR in another company refused: ' || v_e); end if;
  perform pg_temp.r1676_as('e1676000-0000-4000-8000-0000000000a2');

  set local role postgres;
  select count(*) into v_n from public.payments
   where tenant_id = 'e1676000-0000-0000-0000-0000000000a0' and upper(replace(reference, ' ', '')) like '%TESTUTR%';
  if v_n <> 1 then insert into r1676_fail values ('company A should hold the UTR once, holds ' || v_n); end if;
  if (select count(*) from public.payments where reference = 'MULTIUTR987654') <> 2 then
    insert into r1676_fail values ('multi receipt should be 2 rows');
  end if;
  if (select status::text from public.invoices where id = 'R16-I2') = 'paid' then
    insert into r1676_fail values ('refused duplicate still marked R16-I2 paid');
  end if;

  -- ════ EDIT: a direct reference change to a used UTR ════════════════════════════════
  begin
    update public.payments set reference = 'TestUtr123456'
     where quote_id = 'Q-R16-I5' and tenant_id = 'e1676000-0000-0000-0000-0000000000a0';
    insert into r1676_fail values ('editing a reference to a used UTR was allowed');
  exception when others then
    if sqlerrm not like 'Ye UTR pehle se R16-I1 par hai%' then
      insert into r1676_fail values ('edit refused with wrong message: ' || sqlerrm);
    end if;
  end;

  -- ════ REFUNDED: does not block ════════════════════════════════════════════════════
  update public.payments set status = 'refunded', refunded_at = now()
   where quote_id = 'Q-R16-I1' and tenant_id = 'e1676000-0000-0000-0000-0000000000a0';
  set local role authenticated;
  v_e := pg_temp.r1676_pay('Q-R16-I2', 'bank_transfer', 'TESTUTR123456');
  if v_e is not null then insert into r1676_fail values ('UTR of a refunded payment still blocked: ' || v_e); end if;
  set local role postgres;

  -- ════ LIST: an old duplicate (written before the rule) ═════════════════════════════
  alter table public.payments disable trigger trg_payments_ref_once;
  insert into public.payments (tenant_id, quote_id, customer_id, amount, method, reference, status)
  values ('e1676000-0000-0000-0000-0000000000a0', 'Q-R16-I3', 'e1676000-0000-4000-8000-0000000000c2', 100, 'upi', 'testutr123456', 'received');
  alter table public.payments enable trigger trg_payments_ref_once;
  set local role authenticated;
  select count(*) into v_n from public.payment_reference_duplicates() d
   where d.reference_key = 'TESTUTR123456' and d.credits = 2 and d.payments = 2;
  if v_n <> 1 then insert into r1676_fail values ('old duplicate not listed by payment_reference_duplicates()'); end if;
  if exists (select 1 from public.payment_reference_duplicates() d where d.reference_key = 'MULTIUTR987654') then
    insert into r1676_fail values ('a multi-invoice receipt is listed as a duplicate');
  end if;
  -- another company sees nothing of A's
  perform pg_temp.r1676_as('e1676000-0000-4000-8000-0000000000b2');
  if exists (select 1 from public.payment_reference_duplicates()) then
    insert into r1676_fail values ('company B sees company A duplicates');
  end if;
  -- the assert helper is not callable by an app login
  begin
    perform public.assert_payment_ref_unused('e1676000-0000-0000-0000-0000000000a0', 'upi', 'MULTIUTR987654', null);
    insert into r1676_fail values ('assert_payment_ref_unused callable by authenticated');
  exception when insufficient_privilege then null;
  end;
  set local role postgres;
end $$;

do $$
declare v_msgs text;
begin
  select string_agg(msg, E'\n  - ') into v_msgs from r1676_fail;
  if v_msgs is not null then
    raise exception E'FAIL r1676_payment_ref_once:\n  - %', v_msgs;
  end if;
  raise notice 'PASS r1676_payment_ref_once';
end $$;

rollback;
