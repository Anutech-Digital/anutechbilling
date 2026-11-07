\set ON_ERROR_STOP on
-- R-2551 (7 Nov 2026, p1 money): R-2538 made the TDS gross = the taxable value of the PART a receipt
-- pays on the bank-reconcile path (bank_credit_pay_item). record_multi_invoice_payment still wrote the
-- WHOLE invoice's taxable value as the gross on a part payment (and a null rate when none was given).
-- Migration 2026110709…_r2551_tds_gross_multi_invoice (record_multi_invoice_payment on
-- bank_credit_tds_gross). Self-asserting, ONE transaction, rolled back. RED without the migration
-- (A: gross ₹10,000, not ₹5,000).
--
--   A. ₹11,800 invoice (taxable ₹10,000), part paid ₹5,800 + ₹100 TDS 2% → gross ₹5,000, rate 2, net ₹5,800.
--   B. The same with no rate → gross ₹5,000 and rate 2 derived from it (was null).
--   C. The customer deducted 2% of the WHOLE invoice (₹200) from a ₹5,900 part, rate 2 → gross ₹10,000
--      (TDS × 100 ÷ rate — what 26AS shows), capped at the taxable.
--   D. An invoice with no taxable value → the quote's taxable AND the quote's total: part ₹5,900 → ₹5,000.
--   E. The whole invoice paid (₹11,600 + ₹200 TDS 2%) → gross = the whole taxable ₹10,000.
--   F. Two lines in one receipt, each a part → each line its own part's gross (F2's 10% does not fit → ₹1,000).
--   G. (review) A Zoho opening invoice (taxable 0) with TDS and no rate → still saved as before R-2551
--      (_record_opening_invoice_payment books the receipt ₹5,900 as the gross), never refused.
--   H. (review) No rate and TDS bigger than the part's taxable (₹1 + ₹50 TDS → rate 116%) → refused
--      in words, nothing saved.
--   I. (review) A's receipt retried with the same reference and no rate → the idempotent replay answer.

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e2551000-0000-4000-8000-0000000000a1', 'r2551-owner@example.test'),
  ('e2551000-0000-4000-8000-0000000000a2', 'r2551-billing@example.test');
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e2551000-0000-0000-0000-0000000000a0', 'R2551 A', 'r2551a@example.in', '07', 'R2551');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e2551000-0000-4000-8000-0000000000a1', 'e2551000-0000-0000-0000-0000000000a0', 'r2551-owner@example.in', 'R2551 Owner', 'owner', true),
  ('e2551000-0000-4000-8000-0000000000a2', 'e2551000-0000-0000-0000-0000000000a0', 'r2551-billing@example.in', 'R2551 Billing', 'billing', true);
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e2551000-0000-4000-8000-0000000000c1', 'e2551000-0000-0000-0000-0000000000a0', 'R2551 Cust', '07', 'India');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('e2551000-0000-4000-8000-0000000000ba', 'e2551000-0000-0000-0000-0000000000a0', 'R2551 Current', 'R2551 Bank');

-- Every invoice ₹11,800 = ₹10,000 + 18% GST; D has no taxable value of its own.
insert into public.invoices (id, tenant_id, customer_name, customer_id, amount, net_payable, taxable_value, invoice_date, quote_id)
select v.id, 'e2551000-0000-0000-0000-0000000000a0'::uuid, 'R2551', 'e2551000-0000-4000-8000-0000000000c1'::uuid,
       11800, 11800, v.tx, '2026-09-01'::date, null
  from (values ('R2551-A', 10000), ('R2551-B', 10000), ('R2551-C', 10000), ('R2551-D', null::int),
               ('R2551-E', 10000), ('R2551-F1', 10000), ('R2551-F2', 10000), ('R2551-H', 10000)) v(id, tx);

-- One-off quotes, each pointing at its own invoice (R-1525's set-up).
insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items, invoice_id)
select 'Q-' || i.id, i.tenant_id, null, i.customer_id, 'R2551', 11800, 10000, 18, 'accepted', 'invoiced', '[]'::jsonb, i.id
  from public.invoices i where i.id like 'R2551-%';
update public.invoices set quote_id = 'Q-' || id where id like 'R2551-%';

-- G: a Zoho opening invoice (R-1739 import — taxable 0, no quote).
select set_config('request.jwt.claims', json_build_object('sub', 'e2551000-0000-4000-8000-0000000000a1', 'role', 'authenticated')::text, true);
select public.import_opening_invoices(
  '[{"number":"ZB-R2551-G","invoice_date":"2026-02-10","due_date":"2026-03-12","customer_id":"e2551000-0000-4000-8000-0000000000c1","total":11800,"balance":11800}]'::jsonb,
  'Invoice.csv');
select set_config('request.jwt.claims', '', true);
create function pg_temp.r2551_opn() returns text language sql as $f$
  select id from public.invoices where upper(external_number) = 'ZB-R2551-G' and document_kind = 'opening_invoice' $f$;
grant execute on function pg_temp.r2551_opn() to authenticated;

create temp table r2551_fail (msg text) on commit drop;
grant all on r2551_fail to authenticated;

create function pg_temp.r2551_pay(p_ref text, p_received integer, p_alloc jsonb) returns text language plpgsql as $$
begin
  perform public.record_multi_invoice_payment('e2551000-0000-4000-8000-0000000000c1', '2026-10-05', 'bank_transfer',
            'e2551000-0000-4000-8000-0000000000ba', p_ref, p_received, p_alloc, false, null);
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
grant execute on function pg_temp.r2551_pay(text, integer, jsonb) to authenticated;

-- 'gross|tds|net|rate' of the ONE TDS row on an invoice (or a note when there is not exactly one).
create function pg_temp.r2551_tds(p_inv text) returns text language sql as $$
  select case count(*) when 1 then max(gross_amount::text || '|' || tds_amount || '|' || net_paid || '|' || coalesce(rate_pct::numeric(6,2)::text, 'null'))
              else count(*) || ' rows' end
    from public.tds_receivable where invoice_id = p_inv and tenant_id = 'e2551000-0000-0000-0000-0000000000a0'
$$;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'e2551000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);

do $$
declare v_e text;
begin
  v_e := pg_temp.r2551_pay('UTR-R2551-A', 5800, '[{"invoice_id":"R2551-A","amount":5800,"tds_amount":100,"tds_section":"194C","tds_rate_pct":2}]');
  if v_e is not null then insert into r2551_fail values ('A failed: ' || v_e); end if;
  v_e := pg_temp.r2551_pay('UTR-R2551-B', 5800, '[{"invoice_id":"R2551-B","amount":5800,"tds_amount":100,"tds_section":"194C"}]');
  if v_e is not null then insert into r2551_fail values ('B failed: ' || v_e); end if;
  v_e := pg_temp.r2551_pay('UTR-R2551-C', 5700, '[{"invoice_id":"R2551-C","amount":5700,"tds_amount":200,"tds_section":"194C","tds_rate_pct":2}]');
  if v_e is not null then insert into r2551_fail values ('C failed: ' || v_e); end if;
  v_e := pg_temp.r2551_pay('UTR-R2551-D', 5800, '[{"invoice_id":"R2551-D","amount":5800,"tds_amount":100,"tds_section":"194C","tds_rate_pct":2}]');
  if v_e is not null then insert into r2551_fail values ('D failed: ' || v_e); end if;
  v_e := pg_temp.r2551_pay('UTR-R2551-E', 11600, '[{"invoice_id":"R2551-E","amount":11600,"tds_amount":200,"tds_section":"194C","tds_rate_pct":2}]');
  if v_e is not null then insert into r2551_fail values ('E failed: ' || v_e); end if;
  v_e := pg_temp.r2551_pay('UTR-R2551-F', 8650,
           '[{"invoice_id":"R2551-F1","amount":5800,"tds_amount":100,"tds_section":"194C","tds_rate_pct":2},{"invoice_id":"R2551-F2","amount":2850,"tds_amount":100,"tds_section":"194J","tds_rate_pct":10}]');
  if v_e is not null then insert into r2551_fail values ('F failed: ' || v_e); end if;
  v_e := pg_temp.r2551_pay('UTR-R2551-G', 5800, jsonb_build_array(jsonb_build_object('invoice_id', pg_temp.r2551_opn(), 'amount', 5800, 'tds_amount', 100, 'tds_section', '194J')));
  if v_e is not null then insert into r2551_fail values ('G (opening, no rate) refused: ' || v_e); end if;
  v_e := pg_temp.r2551_pay('UTR-R2551-H', 1, '[{"invoice_id":"R2551-H","amount":1,"tds_amount":50,"tds_section":"194C"}]');
  if v_e is null or v_e not like '22023:%more than the taxable value%' then insert into r2551_fail values ('H: want refused (rate over 100%), got ' || coalesce(v_e, 'saved')); end if;
  begin
    if not coalesce((public.record_multi_invoice_payment('e2551000-0000-4000-8000-0000000000c1', '2026-10-05', 'bank_transfer',
            'e2551000-0000-4000-8000-0000000000ba', 'UTR-R2551-A', 5800,
            '[{"invoice_id":"R2551-A","amount":5800,"tds_amount":100,"tds_section":"194C"}]'::jsonb, false, null)->>'idempotent_replay')::boolean, false) then
      insert into r2551_fail values ('I: retry of A is not an idempotent replay');
    end if;
  exception when others then insert into r2551_fail values ('I: retry of A refused: ' || sqlerrm);
  end;
end $$;

set local role postgres;
do $$
declare v text;
begin
  v := pg_temp.r2551_tds('R2551-A');
  if v is distinct from '5000|100|5800|2.00' then insert into r2551_fail values ('A: want gross 5000 (the part), got ' || coalesce(v, 'null')); end if;
  v := pg_temp.r2551_tds('R2551-B');
  if v is distinct from '5000|100|5800|2.00' then insert into r2551_fail values ('B: want gross 5000, rate 2 derived, got ' || coalesce(v, 'null')); end if;
  v := pg_temp.r2551_tds('R2551-C');
  if v is distinct from '10000|200|5700|2.00' then insert into r2551_fail values ('C: want gross 10000 (TDS x 100 / rate), got ' || coalesce(v, 'null')); end if;
  v := pg_temp.r2551_tds('R2551-D');
  if v is distinct from '5000|100|5800|2.00' then insert into r2551_fail values ('D: want gross 5000 from the quote, got ' || coalesce(v, 'null')); end if;
  v := pg_temp.r2551_tds('R2551-E');
  if v is distinct from '10000|200|11600|2.00' then insert into r2551_fail values ('E: want gross 10000 (whole), got ' || coalesce(v, 'null')); end if;
  v := pg_temp.r2551_tds('R2551-F1');
  if v is distinct from '5000|100|5800|2.00' then insert into r2551_fail values ('F1: want gross 5000, got ' || coalesce(v, 'null')); end if;
  -- ₹2,850 + ₹100 = ₹2,950 of ₹11,800 → ₹2,500; 10% of ₹2,500 = ₹250 ≠ ₹100 → the rate does not fit → ₹1,000.
  v := pg_temp.r2551_tds('R2551-F2');
  if v is distinct from '1000|100|2850|10.00' then insert into r2551_fail values ('F2: want gross 1000 (TDS x 100 / 10), got ' || coalesce(v, 'null')); end if;
  v := pg_temp.r2551_tds(pg_temp.r2551_opn());
  if v is distinct from '5900|100|5800|1.69' then insert into r2551_fail values ('G: want the opening receipt as before (5900|100|5800|1.69), got ' || coalesce(v, 'null')); end if;
  if exists (select 1 from public.payments where invoice_id = 'R2551-H') or pg_temp.r2551_tds('R2551-H') <> '0 rows' then
    insert into r2551_fail values ('H: something was saved');
  end if;
  if (select count(*) from public.tds_receivable where invoice_id = 'R2551-A') <> 1 then
    insert into r2551_fail values ('I: the retry added a TDS row');
  end if;
  if exists (select 1 from public.tds_receivable where tenant_id = 'e2551000-0000-0000-0000-0000000000a0' and gross_amount is null) then
    insert into r2551_fail values ('a TDS row has a null gross');
  end if;
end $$;

do $$
declare v_list text;
begin
  select string_agg('  - ' || msg, E'\n') into v_list from r2551_fail;
  if v_list is not null then
    raise exception E'FAIL r2551_tds_gross_desk_multi:\n%', v_list;
  end if;
  raise notice 'PASS r2551_tds_gross_desk_multi';
end $$;

rollback;
