-- R-1705 (21 Oct 2026): rejecting an add-seats (pro-rata) quote takes the seats and MRR back.
--
-- The owner's path (local billing audit, T-A1): Manage seats +1 → subscription 10 → 11 seats,
-- MRR ₹2,700 → ₹2,970 at once; pro-rata quote (₹3,813) "sent"; "Mark rejected" (the quote page
-- does a plain `update quotes set status = 'rejected'`) left 11 seats and ₹2,970.
--
--   1. Owner's path, as written by addSeats() before R-1705 (link only in notes): reject →
--      10 seats, MRR 2,700, a contract amendment 11 → 10 logged, the draft PO cancelled, the
--      subscription's own outstanding untouched. (Fails without the migration.)
--   2. Same with the R-1705 link columns (exact MRR the seats added).
--   3. Reopening a quote whose seats were taken back is refused.
--   4. Money already received on the seat quote → reject refused, nothing changed.
--   5. Accept + pay → normal: seats stay, no second subscription, quote paid.
--   6. Replaced by a revision (expired + superseded_by) → nothing taken back, link handed over.
--
-- Fixture owns its data and rolls back.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code)
  values ('dd170500-0000-4000-8000-00000000a001', 'R1705 Tenant', 'r1705@test.invalid', '07');
insert into public.customers (id, tenant_id, name) values
  ('dd170500-0000-4000-8000-00000000c001', 'dd170500-0000-4000-8000-00000000a001', 'R1705 Cust');
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('dd170500-0000-4000-8000-00000000a001', 'purchase_order', public.indian_fiscal_year(current_date), 'PO', 9800);

-- six subscriptions, each at 10 seats / ₹2,700 with ₹18,232 owed on its own term
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, term_months,
                                  start_date, renewal_date, outstanding_amount)
select ('dd170500-0000-4000-8000-0000000000b' || n)::uuid, 'dd170500-0000-4000-8000-00000000a001',
       'dd170500-0000-4000-8000-00000000c001', 'R1705 Cust', 'Google Workspace Business Starter', 'google',
       10, 2700, 'active', 12, current_date - 30, current_date + 335, 18232
  from generate_series(1, 6) n;

-- What addSeats() does: quote insert, then seats/MRR on the subscription, then a draft PO.
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, status, payment_status,
                           line_items, is_renewal, is_add_seats, extension_months, notes)
select 'Q-R1705-' || n, 'dd170500-0000-4000-8000-00000000a001', 'dd170500-0000-4000-8000-00000000c001', 'R1705 Cust',
       'Google Workspace Business Starter', 1, 3813, 3231, 'sent', 'awaiting',
       '[{"name":"Google Workspace Business Starter · +1 seats (pro-rata)","qty":1,"rate":3231,"commitment":"annual_yearly"}]'::jsonb,
       false, true, 0,
       'Seats added from today.' || chr(10) || 'Add-seats pro-rata for subscription dd170500-0000-4000-8000-0000000000b' || n || '. Effective date ' || current_date || '.'
  from generate_series(1, 6) n;
update public.subscriptions set seats = 11, mrr = 2970
 where id::text like 'dd170500-0000-4000-8000-0000000000b%';
insert into public.purchase_orders (id, tenant_id, subscription_id, customer_id, customer_name, vendor, plan, seats, term_months, unit_cost_pm, total_cost, status, notes)
select 'PO-R1705-' || n, 'dd170500-0000-4000-8000-00000000a001', ('dd170500-0000-4000-8000-0000000000b' || n)::uuid,
       'dd170500-0000-4000-8000-00000000c001', 'R1705 Cust', 'google', 'Google Workspace Business Starter', 1, 11, 110, 1210, 'draft',
       'Auto-created for +1 seats added mid-term (pro-rata 335 days). Quote Q-R1705-' || n || '. Unit cost ₹110/seat/mo from catalog.'
  from generate_series(1, 6) n;

-- ── 1. owner's path, link only in the notes (pre-R-1705 quote) ──────────────
do $$
declare
  v_s  record;
  v_a  record;
  v_po text;
begin
  update public.quotes set status = 'rejected', rejected_reason = 'price' where id = 'Q-R1705-1';

  select seats, mrr, outstanding_amount into v_s from public.subscriptions where id = 'dd170500-0000-4000-8000-0000000000b1';
  if v_s.seats <> 10 or v_s.mrr <> 2700 then
    raise exception 'FAIL 1: seat quote rejected but the subscription kept % seats / MRR ₹% (expected 10 / ₹2,700). The added seat is never billed — the R-1705 bug.', v_s.seats, v_s.mrr;
  end if;
  if v_s.outstanding_amount <> 18232 then
    raise exception 'FAIL 1b: outstanding moved to % (expected the subscription''s own 18232)', v_s.outstanding_amount;
  end if;
  select seats_from, seats_to, mrr_from, mrr_to into v_a from public.contract_amendments
   where subscription_id = 'dd170500-0000-4000-8000-0000000000b1' order by created_at desc, seats_to asc limit 1;
  if v_a.seats_from is distinct from 11 or v_a.seats_to is distinct from 10 or v_a.mrr_from is distinct from 2970 or v_a.mrr_to is distinct from 2700 then
    raise exception 'FAIL 1c: no contract amendment 11→10 / 2970→2700 logged: %', row_to_json(v_a);
  end if;
  select status into v_po from public.purchase_orders where id = 'PO-R1705-1';
  if v_po <> 'cancelled' then
    raise exception 'FAIL 1d: the draft PO for the rejected seats is still %', v_po;
  end if;
  if (select to_jsonb(q)->>'add_seats_taken_back_at' from public.quotes q where id = 'Q-R1705-1') is null then
    raise exception 'FAIL 1e: add_seats_taken_back_at not set';
  end if;
  raise notice 'PASS 1: reject → 10 seats, MRR 2700, amendment 11→10 logged, draft PO cancelled, own outstanding kept';
end $$;

-- ── 2. with the R-1705 link columns (addSeats writes them from now on) ──────
update public.quotes set add_seats_subscription_id = 'dd170500-0000-4000-8000-0000000000b2', add_seats_mrr_added = 270
 where id = 'Q-R1705-2';
update public.subscriptions set mrr = 2971 where id = 'dd170500-0000-4000-8000-0000000000b2';  -- MRR moved since; take back exactly 270
do $$
declare v_s record;
begin
  update public.quotes set status = 'rejected' where id = 'Q-R1705-2';
  select seats, mrr into v_s from public.subscriptions where id = 'dd170500-0000-4000-8000-0000000000b2';
  if v_s.seats <> 10 or v_s.mrr <> 2701 then
    raise exception 'FAIL 2: expected 10 seats / ₹2,701 (2,971 − the 270 the seats added), got % / %', v_s.seats, v_s.mrr;
  end if;
  raise notice 'PASS 2: stored link → exactly the added MRR taken back';
end $$;

-- ── 3. reopen after take-back is refused ───────────────────────────────────
do $$
begin
  begin
    update public.quotes set status = 'sent', rejected_reason = null where id = 'Q-R1705-1';
    raise exception 'FAIL 3: a quote whose seats were taken back was reopened';
  exception when check_violation then
    if sqlerrm not like '%taken back%Manage seats%' then raise exception 'FAIL 3b: wrong message: %', sqlerrm; end if;
  end;
  raise notice 'PASS 3: reopen refused (add the seats again from Manage seats)';
end $$;

-- ── 4. money received → reject refused ─────────────────────────────────────
insert into public.payments (tenant_id, quote_id, customer_id, amount, method, reference, status)
  values ('dd170500-0000-4000-8000-00000000a001', 'Q-R1705-4', 'dd170500-0000-4000-8000-00000000c001', 1000, 'upi', 'r1705-4', 'received');
do $$
declare v_s record;
begin
  begin
    update public.quotes set status = 'rejected' where id = 'Q-R1705-4';
    raise exception 'FAIL 4: a part-paid seat quote was rejected';
  exception when check_violation then
    if sqlerrm not like '%received%' then raise exception 'FAIL 4b: wrong message: %', sqlerrm; end if;
  end;
  select seats, mrr into v_s from public.subscriptions where id = 'dd170500-0000-4000-8000-0000000000b4';
  if v_s.seats <> 11 or v_s.mrr <> 2970 then
    raise exception 'FAIL 4c: refused reject still changed the subscription: % / %', v_s.seats, v_s.mrr;
  end if;
  raise notice 'PASS 4: money received → reject refused, nothing changed';
end $$;

-- ── 5. accept + pay → normal ───────────────────────────────────────────────
do $$
declare v_s record; v_n int; v_q record;
begin
  perform public.record_payment('Q-R1705-5', 3813, 'bank_transfer', 'r1705-5');
  select seats, mrr into v_s from public.subscriptions where id = 'dd170500-0000-4000-8000-0000000000b5';
  select count(*) into v_n from public.subscriptions where customer_id = 'dd170500-0000-4000-8000-00000000c001';
  select status, payment_status, to_jsonb(q)->>'add_seats_taken_back_at' as tb into v_q from public.quotes q where id = 'Q-R1705-5';
  if v_s.seats <> 11 or v_s.mrr <> 2970 or v_n <> 6 then
    raise exception 'FAIL 5: paid seat quote changed the subscription (% / %) or made a duplicate (% subs)', v_s.seats, v_s.mrr, v_n;
  end if;
  if v_q.status <> 'accepted' or v_q.payment_status <> 'received' or v_q.tb is not null then
    raise exception 'FAIL 5b: quote after payment: %', row_to_json(v_q);
  end if;
  raise notice 'PASS 5: accept + pay → 11 seats kept, quote paid, no duplicate subscription';
end $$;

-- ── 6. replaced by a revision → nothing taken back ─────────────────────────
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, status, payment_status, line_items, is_add_seats, notes)
  values ('Q-R1705-6-R2', 'dd170500-0000-4000-8000-00000000a001', 'dd170500-0000-4000-8000-00000000c001', 'R1705 Cust',
          'Google Workspace Business Starter', 1, 3700, 'draft', 'awaiting', '[]'::jsonb, true, 'revision');
update public.quotes set add_seats_subscription_id = 'dd170500-0000-4000-8000-0000000000b6', add_seats_mrr_added = 270 where id = 'Q-R1705-6';
do $$
declare v_s record; v_r record;
begin
  update public.quotes set status = 'expired', superseded_by = 'Q-R1705-6-R2', superseded_at = now() where id = 'Q-R1705-6';
  select seats, mrr into v_s from public.subscriptions where id = 'dd170500-0000-4000-8000-0000000000b6';
  if v_s.seats <> 11 or v_s.mrr <> 2970 then
    raise exception 'FAIL 6: a quote replaced by its revision took the seats back (% / %)', v_s.seats, v_s.mrr;
  end if;
  select add_seats_subscription_id, add_seats_mrr_added into v_r from public.quotes where id = 'Q-R1705-6-R2';
  if v_r.add_seats_subscription_id is distinct from 'dd170500-0000-4000-8000-0000000000b6'::uuid or v_r.add_seats_mrr_added is distinct from 270 then
    raise exception 'FAIL 6b: link not handed to the revision: %', row_to_json(v_r);
  end if;
  raise notice 'PASS 6: replaced by a revision → seats kept, link handed over';
end $$;

rollback;
