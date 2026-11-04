\set ON_ERROR_STOP on
-- R-2336 (1 Nov 2026): Banking → Reconcile → Customer refund must not offer or book money that
-- came in AFTER the bank line. Migration 20261101065250_r2336_customer_refund_not_before_receipt.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <R-2322 migration if missing>; <this card's migration without begin/commit>;
--   <this file without begin/rollback>; rollback;
--
-- Owner's example (R-2322 localhost check, 1 Nov): on a 7 Apr 2026 ₹500 money-out line,
-- Customer refund → E2E Customer listed and PRE-PICKED unused advances received 12 and 14 Jun
-- 2026 — booking it dates the refund (bank date) two months before the money came in.
--
-- Proves:
--   A. customer_refundable_items(customer, as_of): an advance received 12 Jun is flagged for a
--      7 Apr line (dated_on 12 Jun, late_reason "This advance came in on 12 Jun 2026, after
--      this bank line (7 Apr 2026)."), not for a same-day (12 Jun) or a 23 Sep line; the old
--      one-argument call still answers (R-2322 callers keep working).
--   B. reconcile_bank_debit_as_customer_refund refuses the 12 Jun advance on the 7 Apr line
--      with that message (22023) and changes nothing; the same-day line books it.
--   C. Credit-note credit: the receipt that brought the money came in on 14 Jun → a 7 Apr line
--      is flagged and refused ("This payment came in on 14 Jun 2026, …"); a 23 Sep line books.

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
  ('d2336000-0000-0000-0000-0000000000a0', 'R2336 Co', 'r2336a@example.in', '07', 'R236');
insert into auth.users (id, email) values
  ('a2336000-0000-4000-8000-0000000000a1', 'owner2336@example.test');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('a2336000-0000-4000-8000-0000000000a1', 'd2336000-0000-0000-0000-0000000000a0', 'owner2336@example.in', 'Owner 2336', 'owner', true);
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('c2336000-0000-4000-8000-0000000000c1', 'd2336000-0000-0000-0000-0000000000a0', 'Adv 2336', '07', 'India'),
  ('c2336000-0000-4000-8000-0000000000c2', 'd2336000-0000-0000-0000-0000000000a0', 'Cn 2336',  '07', 'India');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('b2336000-0000-0000-0000-0000000000a0', 'd2336000-0000-0000-0000-0000000000a0', 'HDFC Current', 'HDFC');
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items) values
  ('Q-R2336-CN', 'd2336000-0000-0000-0000-0000000000a0', 'c2336000-0000-4000-8000-0000000000c2', 'Cn 2336', 11800, 10000, 18, 'accepted', 'awaiting', '[]'::jsonb);
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('12336000-0000-0000-0000-000000000001', 'd2336000-0000-0000-0000-0000000000a0', 'b2336000-0000-0000-0000-0000000000a0', '2026-06-12', 'NEFT ADV 2336',          0, 500, 'UTR2336ADV',  'manual'),
  ('12336000-0000-0000-0000-000000000002', 'd2336000-0000-0000-0000-0000000000a0', 'b2336000-0000-0000-0000-0000000000a0', '2026-04-07', 'UPI REFUND ADV 2336',  500,   0, 'UTR2336APR',  'manual'),
  ('12336000-0000-0000-0000-000000000003', 'd2336000-0000-0000-0000-0000000000a0', 'b2336000-0000-0000-0000-0000000000a0', '2026-06-12', 'UPI REFUND ADV 2336 S', 500,  0, 'UTR2336SAME', 'manual'),
  ('12336000-0000-0000-0000-000000000004', 'd2336000-0000-0000-0000-0000000000a0', 'b2336000-0000-0000-0000-0000000000a0', '2026-06-14', 'NEFT CN 2336',           0, 11800, 'UTR2336IN', 'manual'),
  ('12336000-0000-0000-0000-000000000005', 'd2336000-0000-0000-0000-0000000000a0', 'b2336000-0000-0000-0000-0000000000a0', '2026-04-07', 'REFUND CN 2336 APR',  1000,   0, 'UTR2336CA',   'manual'),
  ('12336000-0000-0000-0000-000000000006', 'd2336000-0000-0000-0000-0000000000a0', 'b2336000-0000-0000-0000-0000000000a0', '2026-09-23', 'REFUND CN 2336 SEP',  1000,   0, 'UTR2336CS',   'manual');

create temp table r2336_fail (msg text) on commit drop;
grant all on r2336_fail to authenticated;

create function pg_temp.r2336_try(p_txn uuid, p_pay uuid, p_reason text) returns text language plpgsql as $$
begin
  perform public.reconcile_bank_debit_as_customer_refund(p_txn, p_pay, p_reason);
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
grant execute on function pg_temp.r2336_try(uuid, uuid, text) to authenticated;

do $$
declare
  c_adv  constant uuid := 'c2336000-0000-4000-8000-0000000000c1';
  c_cn   constant uuid := 'c2336000-0000-4000-8000-0000000000c2';
  l_adv  constant uuid := '12336000-0000-0000-0000-000000000001';
  l_apr  constant uuid := '12336000-0000-0000-0000-000000000002';
  l_same constant uuid := '12336000-0000-0000-0000-000000000003';
  l_in   constant uuid := '12336000-0000-0000-0000-000000000004';
  l_capr constant uuid := '12336000-0000-0000-0000-000000000005';
  l_csep constant uuid := '12336000-0000-0000-0000-000000000006';
  v_adv uuid; v_pay uuid; v_inv text; v_e text; v_n int; v_r jsonb; v_t text; v_d date; v_reason text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'a2336000-0000-4000-8000-0000000000a1', 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- ════ A. the list, per bank line date ═══════════════════════════════════════════════════════
  perform public.reconcile_bank_credit_as_advance(l_adv, c_adv);
  set local role postgres;
  select matched_to_id::uuid into v_adv from public.bank_transactions where id = l_adv;
  set local role authenticated;

  select dated_on, late_reason into v_d, v_reason
    from public.customer_refundable_items(c_adv, '2026-04-07'::date) where payment_id = v_adv;
  if not found then insert into r2336_fail values ('A: the 12 Jun advance is missing from the 7 Apr list (want it shown, flagged)'); end if;
  if v_d is distinct from '2026-06-12'::date then insert into r2336_fail values ('A: dated_on ' || coalesce(v_d::text, 'null') || ' (want 2026-06-12)'); end if;
  if v_reason is distinct from 'This advance came in on 12 Jun 2026, after this bank line (7 Apr 2026).' then
    insert into r2336_fail values ('A: late_reason on the 7 Apr list: ' || coalesce(v_reason, 'null'));
  end if;
  select count(*) into v_n from public.customer_refundable_items(c_adv, '2026-06-12'::date) where payment_id = v_adv and late_reason is null;
  if v_n <> 1 then insert into r2336_fail values ('A: same-day (12 Jun) line flags the 12 Jun advance'); end if;
  select count(*) into v_n from public.customer_refundable_items(c_adv, '2026-09-23'::date) where payment_id = v_adv and late_reason is null and refundable = 500;
  if v_n <> 1 then insert into r2336_fail values ('A: 23 Sep line does not offer the 12 Jun advance'); end if;
  select count(*) into v_n from public.customer_refundable_items(c_adv, null) where payment_id = v_adv and late_reason is null;
  if v_n <> 1 then insert into r2336_fail values ('A: no date given → nothing is flagged'); end if;
  select count(*) into v_n from public.customer_refundable_items(c_adv) where payment_id = v_adv;
  if v_n <> 1 then insert into r2336_fail values ('A: the old one-argument call stopped answering'); end if;

  -- ════ B. the server refuses the 7 Apr line, books the same-day one ══════════════════════════
  v_e := pg_temp.r2336_try(l_apr, v_adv, 'Advance not needed any more');
  if v_e is distinct from '22023: This advance came in on 12 Jun 2026, after this bank line (7 Apr 2026).' then
    insert into r2336_fail values ('B: 7 Apr refund of a 12 Jun advance not refused right: ' || coalesce(v_e, 'BOOKED'));
  end if;
  set local role postgres;
  select matched_to_type into v_t from public.bank_transactions where id = l_apr;
  if v_t is not null or (select status from public.payments where id = v_adv) <> 'received' then
    insert into r2336_fail values ('B: refused refund still changed something');
  end if;
  set local role authenticated;
  v_e := pg_temp.r2336_try(l_same, v_adv, 'Advance not needed any more');
  if v_e is not null then insert into r2336_fail values ('B: same-day refund refused: ' || v_e); end if;

  -- ════ C. credit-note credit whose receipt came in on 14 Jun ═════════════════════════════════
  select invoice_id into v_inv from public.generate_invoice('Q-R2336-CN');
  perform public.record_desk_payment('Q-R2336-CN', 11800, 'bank_transfer', 'UTR2336IN', null, null, 0, '2026-06-14'::date, null);
  select id into v_pay from public.payments where quote_id = 'Q-R2336-CN';
  perform public.reconcile_bank_txn(l_in, 'payment', v_pay::text, 'manual');
  perform public.issue_credit_note(v_inv, 2360, 'other', 'Two seats removed', null);

  select late_reason into v_reason from public.customer_refundable_items(c_cn, '2026-04-07'::date) where payment_id = v_pay and kind = 'credit_note';
  if v_reason is distinct from 'This payment came in on 14 Jun 2026, after this bank line (7 Apr 2026).' then
    insert into r2336_fail values ('C: late_reason for the credit-note credit on 7 Apr: ' || coalesce(v_reason, 'null'));
  end if;
  v_e := pg_temp.r2336_try(l_capr, v_pay, 'Two seats removed, money back');
  if v_e is distinct from '22023: This payment came in on 14 Jun 2026, after this bank line (7 Apr 2026).' then
    insert into r2336_fail values ('C: 7 Apr credit-note refund not refused right: ' || coalesce(v_e, 'BOOKED'));
  end if;
  begin
    v_r := public.reconcile_bank_debit_as_customer_refund(l_csep, v_pay, 'Two seats removed, money back');
  exception when others then insert into r2336_fail values ('C: 23 Sep credit-note refund raised: ' || sqlerrm);
  end;
  if coalesce(v_r->>'kind', '') <> 'credit_note' or (v_r->>'amount')::int <> 1000 then
    insert into r2336_fail values ('C: 23 Sep result wrong: ' || coalesce(v_r::text, 'null'));
  end if;
end $$;

do $$
declare v_msgs text;
begin
  select string_agg(msg, E'\n') into v_msgs from r2336_fail;
  if v_msgs is not null then raise exception E'FAIL r2336_customer_refund_not_before_receipt:\n%', v_msgs; end if;
  raise notice 'PASS r2336_customer_refund_not_before_receipt';
end $$;

rollback;
