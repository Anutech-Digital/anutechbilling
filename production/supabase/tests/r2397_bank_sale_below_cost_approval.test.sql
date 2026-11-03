-- R-2397 (3 Nov 2026, G-RECON): a NEW SALE booked from a bank credit below cost waits for the
-- owner's approval — the same rule as Manage-seats quotes (R-2213 / R-2344, approvers R-2367 / R-2383).
-- Migration 20261103024934_r2397_bank_sale_below_cost_approval.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
--   A. New sale below cost (₹800/seat sold, cost ₹1,000) → NOT reconciled: needs_approval, the quote is
--      approval pending + below_cost, linked to the line; no payment; the line stays unmatched.
--   B. Saving the same line again → refused, names the waiting quote (no second quote).
--   C. The maker (owner A) cannot approve it (R-2367); owner B approves → picking the quote on the
--      line records the money and reconciles the line.
--   D. At-cost or above (rate ₹1,200, cost ₹1,000) and unknown cost (cost 0) → booked as before.
--   E. Split: a below-cost new sale + an open item → nothing paid, the item stays open, the line
--      unmatched, the sale's quote waits.
--   F. R-2360 overload (Zoho number): same — not reconciled, the number goes on the quote's notes.
--   G. Relink of an old one-off sale to a below-cost new sale → refused before anything changes.
--   H. bank_sale_lines_below_cost mirrors linesBelowCost (rounding at −0.5 bps, SUP- lines).

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
  ('dddddddd-0000-0000-0000-000000239701','R2397 Margin Co','r2397@example.in','07','R239');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000239701','ownera2397@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000239702','ownerb2397@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000239701','dddddddd-0000-0000-0000-000000239701','ownera2397@example.in','Owner A 2397','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000239702','dddddddd-0000-0000-0000-000000239701','ownerb2397@example.in','Owner B 2397','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000239701','dddddddd-0000-0000-0000-000000239701','Margin Buyer','07','marginbuyer.in');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000239701','dddddddd-0000-0000-0000-000000239701','HDFC Current','HDFC');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000239701','dddddddd-0000-0000-0000-000000239701','bbbbbbbb-0000-0000-0000-000000239701','2026-09-01','NEFT MARGIN A',0,944,'UTR2397A','manual'),
  ('11111111-0000-0000-0000-000000239702','dddddddd-0000-0000-0000-000000239701','bbbbbbbb-0000-0000-0000-000000239701','2026-09-02','NEFT MARGIN D',0,1416,'UTR2397D','manual'),
  ('11111111-0000-0000-0000-000000239703','dddddddd-0000-0000-0000-000000239701','bbbbbbbb-0000-0000-0000-000000239701','2026-09-03','NEFT MARGIN D2',0,1416,'UTR2397D2','manual'),
  ('11111111-0000-0000-0000-000000239704','dddddddd-0000-0000-0000-000000239701','bbbbbbbb-0000-0000-0000-000000239701','2026-09-04','NEFT MARGIN E',0,2360,'UTR2397E','manual'),
  ('11111111-0000-0000-0000-000000239705','dddddddd-0000-0000-0000-000000239701','bbbbbbbb-0000-0000-0000-000000239701','2026-09-05','NEFT MARGIN F',0,944,'UTR2397F','manual'),
  ('11111111-0000-0000-0000-000000239706','dddddddd-0000-0000-0000-000000239701','bbbbbbbb-0000-0000-0000-000000239701','2026-09-06','NEFT MARGIN OPEN',0,1416,'UTR2397O','manual');

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000239701","role":"authenticated"}', true);

do $$
declare
  c_below constant jsonb := '[{"item_id":null,"name":"Setup service","qty":1,"rate":800,"cost":1000,"commitment":"one_time"}]';
  c_at    constant jsonb := '[{"item_id":null,"name":"Setup service","qty":1,"rate":1200,"cost":1000,"commitment":"one_time"}]';
  c_unk   constant jsonb := '[{"item_id":null,"name":"Setup service","qty":1,"rate":1200,"cost":0,"commitment":"one_time"}]';
  r jsonb; v_q text; v_open text; ok boolean; v_msg text; n int; v_q2 record;
begin
  -- A
  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000239701', 'cccccccc-0000-0000-0000-000000239701',
         c_below, false, null, null, 0, null, null, 'yearly');
  v_q := r->>'quote_id';
  if (r->>'needs_approval')::boolean is not true or (r->>'reconciled')::boolean is not false or v_q is null then
    raise exception 'FAIL A: a below-cost sale was not stopped (%)', r;
  end if;
  select q.approval_status::text as st, q.approval_tier::text as tier, q.below_cost, q.approval_bank_txn_id, q.approval_requested_by
    into v_q2 from public.quotes q where q.id = v_q;
  if v_q2.st <> 'pending' or v_q2.tier <> 'owner' or not v_q2.below_cost
     or v_q2.approval_bank_txn_id is distinct from '11111111-0000-0000-0000-000000239701'::uuid
     or v_q2.approval_requested_by is distinct from 'aaaaaaaa-0000-0000-0000-000000239701'::uuid then
    raise exception 'FAIL A: quote % not in Needs approval (%)', v_q, row_to_json(v_q2);
  end if;
  if exists (select 1 from public.payments where quote_id = v_q) then raise exception 'FAIL A: money booked on %', v_q; end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000239701') is not null then
    raise exception 'FAIL A: the bank line was reconciled';
  end if;
  if r->>'reason' not like 'This price is below cost%' || v_q || '%' then raise exception 'FAIL A: reason "%"', r->>'reason'; end if;
  raise notice 'A PASS: % waits for approval, line unmatched — %', v_q, r->>'reason';

  -- B
  ok := false;
  begin
    perform public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000239701', 'cccccccc-0000-0000-0000-000000239701',
              c_below, false, null, null, 0, null, null, 'yearly');
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like 'Quote ' || v_q || ' for this bank line already waits%';
    if not ok then raise exception 'FAIL B: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL B: a second save made another quote'; end if;
  raise notice 'B PASS: %', v_msg;

  -- C: the maker cannot approve
  ok := false;
  begin
    update public.quotes set approval_status = 'approved', approved_at = now() where id = v_q;
  exception when others then ok := true;
  end;
  if not ok then raise exception 'FAIL C: the maker approved their own below-cost sale'; end if;
  raise notice 'C1 PASS: maker refused';
end $$;

-- C2: owner B approves, then the line is paid by picking the quote
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000239702","role":"authenticated"}', true);
do $$
declare v_q text; r jsonb;
begin
  select id into v_q from public.quotes where approval_bank_txn_id = '11111111-0000-0000-0000-000000239701';
  update public.quotes set approval_status = 'approved', approved_at = now() where id = v_q;
  r := public.reconcile_bank_credit_to_item('11111111-0000-0000-0000-000000239701', v_q, null, 0, null, null, false, null, null);
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000239701') is null
     or not exists (select 1 from public.payments where quote_id = v_q and status = 'received') then
    raise exception 'FAIL C2: approved quote % was not paid on the line (%)', v_q, r;
  end if;
  raise notice 'C2 PASS: approved by owner B, % paid and the line reconciled', v_q;
end $$;

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000239701","role":"authenticated"}', true);
do $$
declare
  c_below constant jsonb := '[{"item_id":null,"name":"Setup service","qty":1,"rate":800,"cost":1000,"commitment":"one_time"}]';
  c_at    constant jsonb := '[{"item_id":null,"name":"Setup service","qty":1,"rate":1200,"cost":1000,"commitment":"one_time"}]';
  c_unk   constant jsonb := '[{"item_id":null,"name":"Setup service","qty":1,"rate":1200,"cost":0,"commitment":"one_time"}]';
  r jsonb; v_open text; v_sale text; n int; ok boolean; v_msg text;
begin
  -- D
  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000239702', 'cccccccc-0000-0000-0000-000000239701',
         c_at, false, null, null, 0, null, null, 'yearly');
  if r ? 'needs_approval' or (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000239702') is null then
    raise exception 'FAIL D: an at-cost-or-above sale changed (%)', r;
  end if;
  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000239703', 'cccccccc-0000-0000-0000-000000239701',
         c_unk, false, null, null, 0, null, null, 'yearly');
  if r ? 'needs_approval' or (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000239703') is null then
    raise exception 'FAIL D: an unknown-cost sale was stopped (%)', r;
  end if;
  raise notice 'D PASS: above cost and unknown cost booked as before';

  -- E: split — an open (at-cost) quote + a below-cost new sale
  r := public.bank_sale_park_for_approval('11111111-0000-0000-0000-000000239706', 'cccccccc-0000-0000-0000-000000239701', c_at, 'yearly');
  v_open := r->>'quote_id';
  update public.quotes set approval_status = 'not_required', approval_tier = null, below_cost = false, approval_bank_txn_id = null where id = v_open;
  r := public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000239704', 'cccccccc-0000-0000-0000-000000239701',
         jsonb_build_array(jsonb_build_object('quote_id', v_open, 'amount', 1416)),
         jsonb_build_object('lines', c_below, 'billing_cycle', 'yearly', 'create_subscription', false, 'amount', 944), null);
  v_sale := r->>'quote_id';
  if (r->>'needs_approval')::boolean is not true or r->>'kind' <> 'split' then raise exception 'FAIL E: split not stopped (%)', r; end if;
  if exists (select 1 from public.payments where quote_id in (v_open, v_sale))
     or (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000239704') is not null then
    raise exception 'FAIL E: something was paid / reconciled on the split';
  end if;
  if (select approval_status::text from public.quotes where id = v_sale) <> 'pending' then raise exception 'FAIL E: sale quote % not pending', v_sale; end if;
  raise notice 'E PASS: split stopped, % waits, % still open', v_sale, v_open;

  -- F: R-2360 overload with a Zoho number
  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000239705', 'cccccccc-0000-0000-0000-000000239701',
         c_below, false, null, null, 0, null, null, 'yearly', 'INV/26-27/2397');
  if (r->>'needs_approval')::boolean is not true or (r->>'external_number_saved')::boolean is not false
     or (select notes from public.quotes where id = r->>'quote_id') not like '%Zoho invoice number: INV/26-27/2397%'
     or (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000239705') is not null then
    raise exception 'FAIL F: Zoho overload (%)', r;
  end if;
  raise notice 'F PASS: Zoho overload waits too, number on the quote notes';

  -- G: relink refused before anything is undone (the check runs before the line is looked at)
  ok := false;
  begin
    perform public.relink_bank_one_off_sale('11111111-0000-0000-0000-000000239702',
      jsonb_build_object('path', 'new_sale', 'customer_id', 'cccccccc-0000-0000-0000-000000239701', 'lines', c_below, 'create_subscription', false));
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like 'This price is below cost%Nothing was changed%';
    if not ok then raise exception 'FAIL G: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL G: relink to a below-cost sale was not refused'; end if;
  raise notice 'G PASS: %', v_msg;

  -- H: the rule
  if public.bank_sale_lines_below_cost('[{"qty":1,"rate":"10000","cost":10000}]') then raise exception 'FAIL H: at cost is not below'; end if;
  if public.bank_sale_lines_below_cost('[{"qty":1,"rate":"10000.5","cost":10001}]') then raise exception 'FAIL H: −0.49 bps rounds to 0'; end if;
  if not public.bank_sale_lines_below_cost('[{"qty":1,"rate":"9998","cost":10000}]') then raise exception 'FAIL H: −2 bps is below'; end if;
  if public.bank_sale_lines_below_cost('[{"qty":2,"rate":"500","cost":600},{"qty":1,"rate":"300","cost":0}]') then raise exception 'FAIL H: unknown cost is not below'; end if;
  if not public.bank_sale_lines_below_cost('[{"qty":2,"rate":"500","cost":600},{"item_id":"SUP-STD-YR","qty":1,"rate":"100","cost":0}]') then raise exception 'FAIL H: a SUP- line is a known ₹0'; end if;
  raise notice 'H PASS: rule mirrors linesBelowCost';
end $$;

select 'R-2397 below-cost bank sale waits for approval: ALL PASS' as result;

rollback;
