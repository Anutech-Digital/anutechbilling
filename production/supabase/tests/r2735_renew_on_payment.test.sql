-- R-2735 (13 Nov 2026, p0 money): a subscription billed in parts renews ONLY when the new term's first part
-- is PAID. Migration 20261113124936_r2735_renew_on_paid_part. Self-asserting, ONE transaction, rolled back.
-- Local DB only. RED without the migration (subscription_billings.renews_from does not exist; before it, the
-- app rolled renewal_date when the part was raised).
--
--   1. Part 1 of the new term billed (proforma sent, unpaid) → renewal_date and renewal_state unchanged.
--   2. Part-paid (Rs 590 of Rs 1,180) → nothing moves.
--   3. Paid in full → renewal_date one term on, 'renewed', reminders reset — once; a retry / second receipt
--      moves nothing.
--   4. Proforma cancelled (cancel_quote) → subscription untouched; the part's new proforma paid → renews.
--   5. 'Invoice on due date' customer: unpaid part invoice raised → no move; invoice paid later → renews.
--   6. Two terms behind: term 3's part paid first → no move; term 2's paid → rolls term 2 then term 3.
--   7. renewal_date changed by hand after billing → the mark no longer matches → no move.
--   8. A mid-term part (no mark) paid → nothing moves.

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
  ('b2735000-0000-0000-0000-0000000000f1', 'R2735 Renew Co', 'r2735@example.test', '07', 'R735');
update public.tenants set books_start_date = '2025-04-01' where id = 'b2735000-0000-0000-0000-0000000000f1';

/* One customer + subscription billed in parts (no sale quote: a renewal term's part is its own request).
   p_cycle quarterly / monthly, p_term months, p_start / p_renewal its current term. */
create function pg_temp.sub(p_n int, p_cycle text, p_term int, p_start date, p_renewal date, p_on_due boolean default false)
returns uuid language plpgsql as $f$
declare
  v_c uuid := ('b2735000-0000-0000-0000-0000000001' || lpad(p_n::text, 2, '0'))::uuid;
  v_s uuid := ('b2735000-0000-0000-0000-0000000002' || lpad(p_n::text, 2, '0'))::uuid;
begin
  insert into public.customers (id, tenant_id, name, state_code, country, invoice_parts_on_due_date)
  values (v_c, 'b2735000-0000-0000-0000-0000000000f1', 'R2735 C' || p_n, '07', 'India', p_on_due);
  insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle,
                                    term_months, start_date, renewal_date, renewal_state, reminder_count, status)
  values (v_s, 'b2735000-0000-0000-0000-0000000000f1', v_c, 'R2735 C' || p_n, 'Google Workspace Business Starter',
          'google'::vendor, 1, 333, p_cycle::billing_cycle, p_term, p_start, p_renewal, 'grace_period', 3, 'active');
  return v_s;
end $f$;

/* A laid part (period_end exclusive), optionally marked "paying me renews from → to". */
create function pg_temp.part(p_s uuid, p_k int, p_term date, p_idx int, p_start date, p_months int,
                             p_from date default null, p_to date default null) returns uuid language plpgsql as $f$
declare v_b uuid := ('b2735000-0000-0000-0000-0000000003' || lpad(p_k::text, 2, '0'))::uuid;
begin
  insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start,
                                            period_end, taxable_amount, tax_rate, renews_from, renews_to)
  values (v_b, 'b2735000-0000-0000-0000-0000000000f1', p_s, p_term, p_idx, p_start, p_start,
          (p_start + make_interval(months => p_months))::date, 1000, 18, p_from, p_to);
  return v_b;
end $f$;

create function pg_temp.pay(p_q text, p_amt int, p_ref text) returns void language sql as $f$
  insert into public.payments (tenant_id, quote_id, amount, method, reference, status, received_at)
  values ('b2735000-0000-0000-0000-0000000000f1', p_q, p_amt, 'bank_transfer', p_ref, 'received', now());
$f$;

create function pg_temp.st(p_s uuid) returns text language sql as $f$
  select s.renewal_date::text || ' ' || s.renewal_state::text || ' ' || s.reminder_count from public.subscriptions s where s.id = p_s;
$f$;

-- ── 1–3. Quarterly annual term 1 Oct 2025 – 30 Sep 2026; part 1 of the next term billed, paid in two halves ──
do $$
declare v_s uuid; v_b uuid; r jsonb; v_q text; v_n int;
begin
  v_s := pg_temp.sub(1, 'quarterly', 12, '2025-10-01', '2026-09-30');
  v_b := pg_temp.part(v_s, 1, '2026-10-01', 1, '2026-10-01', 3, '2026-09-30', '2027-09-30');
  r := public.bill_subscription_instalment(v_b, false);
  if r->>'action' <> 'request' then raise exception 'FAIL 1: want a proforma, got %', r; end if;
  v_q := r->>'quote_id';
  if pg_temp.st(v_s) <> '2026-09-30 grace_period 3' then
    raise exception 'FAIL 1: billing the part moved the subscription: % (want 2026-09-30 grace_period 3)', pg_temp.st(v_s); end if;
  raise notice 'PASS 1: proforma % raised, renewal_date still 30 Sep 2026', v_q;

  perform pg_temp.pay(v_q, 590, 'R2735-1A');
  if pg_temp.st(v_s) <> '2026-09-30 grace_period 3' then
    raise exception 'FAIL 2: part-paid moved the subscription: %', pg_temp.st(v_s); end if;
  raise notice 'PASS 2: part-paid → not renewed';

  perform pg_temp.pay(v_q, 590, 'R2735-1B');
  if pg_temp.st(v_s) <> '2027-09-30 renewed 0' then
    raise exception 'FAIL 3: paid in full → % (want 2027-09-30 renewed 0)', pg_temp.st(v_s); end if;
  v_n := public.roll_paid_renewal_terms(v_s);
  perform pg_temp.pay(v_q, 1180, 'R2735-1C');   -- a second receipt / webhook retry
  if v_n <> 0 or pg_temp.st(v_s) <> '2027-09-30 renewed 0' then
    raise exception 'FAIL 3: second call rolled % / state % (want 0 / 2027-09-30 once)', v_n, pg_temp.st(v_s); end if;
  raise notice 'PASS 3: paid in full → renewed to 30 Sep 2027, exactly once';
end $$;

-- ── 4. Proforma cancelled → untouched; the part's new proforma paid → renews ─────────────────────────
do $$
declare v_s uuid; v_b uuid; r jsonb; v_q text;
begin
  v_s := pg_temp.sub(2, 'quarterly', 12, '2025-10-01', '2026-09-30');
  v_b := pg_temp.part(v_s, 2, '2026-10-01', 1, '2026-10-01', 3, '2026-09-30', '2027-09-30');
  r := public.bill_subscription_instalment(v_b, false);
  perform public.cancel_quote(r->>'quote_id', 'R2735 test cancel');
  if pg_temp.st(v_s) <> '2026-09-30 grace_period 3' then
    raise exception 'FAIL 4: cancel moved the subscription: %', pg_temp.st(v_s); end if;
  r := public.bill_subscription_instalment(v_b, false);
  v_q := r->>'quote_id';
  if v_q is null or v_q = '' then raise exception 'FAIL 4: freed part not billed again: %', r; end if;
  perform pg_temp.pay(v_q, 1180, 'R2735-4');
  if pg_temp.st(v_s) <> '2027-09-30 renewed 0' then
    raise exception 'FAIL 4: re-billed proforma paid → % (want 2027-09-30 renewed 0)', pg_temp.st(v_s); end if;
  raise notice 'PASS 4: cancel leaves the subscription alone; the new proforma paid renews it';
end $$;

-- ── 5. 'Invoice on due date': unpaid invoice → no move; paid later → renews ───────────────────────
do $$
declare v_s uuid; v_b uuid; r jsonb; v_inv text;
begin
  v_s := pg_temp.sub(3, 'quarterly', 12, '2025-10-01', '2026-09-30', true);
  v_b := pg_temp.part(v_s, 3, '2026-10-01', 1, '2026-10-01', 3, '2026-09-30', '2027-09-30');
  r := public.bill_subscription_instalment(v_b, false);
  v_inv := r->>'invoice_id';
  if r->>'action' <> 'invoice' or (select status::text from public.invoices where id = v_inv) = 'paid' then
    raise exception 'FAIL 5: want an UNPAID part invoice, got % / %', r, (select status from public.invoices where id = v_inv); end if;
  if pg_temp.st(v_s) <> '2026-09-30 grace_period 3' then
    raise exception 'FAIL 5: an unpaid invoice moved the subscription: %', pg_temp.st(v_s); end if;
  update public.invoices set status = 'paid', paid_amount = amount, paid_date = current_date where id = v_inv;
  if pg_temp.st(v_s) <> '2027-09-30 renewed 0' then
    raise exception 'FAIL 5: invoice paid → % (want 2027-09-30 renewed 0)', pg_temp.st(v_s); end if;
  raise notice 'PASS 5: invoice-on-due-date part renews when its invoice is paid';
end $$;

-- ── 6. Two terms behind (monthly, 3-month terms): term 3 paid first waits; term 2 paid → both roll ─────
do $$
declare v_s uuid; v_b2 uuid; v_b3 uuid; r2 jsonb; r3 jsonb;
begin
  v_s := pg_temp.sub(4, 'monthly', 3, '2026-04-01', '2026-06-30');
  v_b2 := pg_temp.part(v_s, 4, '2026-07-01', 1, '2026-07-01', 1, '2026-06-30', '2026-09-30');
  v_b3 := pg_temp.part(v_s, 5, '2026-10-01', 1, '2026-10-01', 1, '2026-09-30', '2026-12-31');
  r2 := public.bill_subscription_instalment(v_b2, false);
  r3 := public.bill_subscription_instalment(v_b3, false);
  perform pg_temp.pay(r3->>'quote_id', 1180, 'R2735-6B');
  if pg_temp.st(v_s) <> '2026-06-30 grace_period 3' then
    raise exception 'FAIL 6: the later term paid first moved the subscription: %', pg_temp.st(v_s); end if;
  perform pg_temp.pay(r2->>'quote_id', 1180, 'R2735-6A');
  if pg_temp.st(v_s) <> '2026-12-31 renewed 0' then
    raise exception 'FAIL 6: both paid → % (want 2026-12-31 renewed 0)', pg_temp.st(v_s); end if;
  raise notice 'PASS 6: oldest term first, then the already-paid later term';
end $$;

-- ── 7. renewal_date changed by hand after billing → no move ──────────────────────────────────────────
do $$
declare v_s uuid; v_b uuid; r jsonb;
begin
  v_s := pg_temp.sub(5, 'quarterly', 12, '2025-10-01', '2026-09-30');
  v_b := pg_temp.part(v_s, 6, '2026-10-01', 1, '2026-10-01', 3, '2026-09-30', '2027-09-30');
  r := public.bill_subscription_instalment(v_b, false);
  update public.subscriptions set renewal_date = '2026-10-15' where id = v_s;
  perform pg_temp.pay(r->>'quote_id', 1180, 'R2735-7');
  if (select renewal_date from public.subscriptions where id = v_s) <> '2026-10-15' then
    raise exception 'FAIL 7: a hand-changed renewal date was rolled: %', pg_temp.st(v_s); end if;
  raise notice 'PASS 7: hand-changed renewal date → no automatic move';
end $$;

-- ── 8. A mid-term part (no mark) paid → nothing moves ───────────────────────────────────────────────
do $$
declare v_s uuid; v_b uuid; r jsonb;
begin
  v_s := pg_temp.sub(6, 'quarterly', 12, '2025-10-01', '2026-09-30');
  v_b := pg_temp.part(v_s, 7, '2025-10-01', 4, '2026-07-01', 3);
  r := public.bill_subscription_instalment(v_b, false);
  perform pg_temp.pay(r->>'quote_id', 1180, 'R2735-8');
  if (select invoice_id from public.subscription_billings where id = v_b) is null then
    raise exception 'FAIL 8: the paid mid-term part has no invoice: %', r; end if;
  if pg_temp.st(v_s) <> '2026-09-30 grace_period 3' then
    raise exception 'FAIL 8: a mid-term part moved the subscription: %', pg_temp.st(v_s); end if;
  raise notice 'PASS 8: mid-term part paid → renewal date unchanged';
end $$;

-- ── 9. Grants: not callable by a request login ────────────────────────────────────────────────────
do $$
begin
  if has_function_privilege('authenticated', 'public.roll_paid_renewal_terms(uuid)', 'execute')
     or has_function_privilege('anon', 'public.roll_paid_renewal_terms(uuid)', 'execute') then
    raise exception 'FAIL 9: roll_paid_renewal_terms is executable by anon / authenticated'; end if;
  raise notice 'PASS 9: roll_paid_renewal_terms is service_role only';
end $$;

rollback;
