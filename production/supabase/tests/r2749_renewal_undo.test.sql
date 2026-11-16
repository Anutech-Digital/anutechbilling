-- R-2749 (14 Nov 2026, p1 money) — R-2735 follow-ups. Migration 20261113193305_r2749_renewal_undo.
-- Self-asserting, ONE transaction, rolled back. Local DB only. RED without the migration
-- (subscription_renewal_moves does not exist; an undone paid part leaves renewal_date on the new term).
--
--   1. Paid part → renewed (one 'forward' move logged). Full credit note on its invoice → renewal_date back to
--      renews_from, not renewed, ONE 'back' move; the credit note's second trigger run moves nothing more.
--      The part billed again and paid → forward once more.
--   2. Bank un-reconcile (invoice paid → pending) → back once; invoice paid again → forward once.
--   3. Two terms rolled in a cascade; term 1's invoice un-paid → back two terms (term 2 waits again, oldest
--      first); term 1 paid again → both roll forward.
--   4. Date changed by hand after the roll → the undo does not touch it (no logged move ends there).
--   5. Partial credit note (invoice still paid) → nothing moves.
--   6. Won't renew while the marked part's proforma is open → refused with a plain message; after the
--      proforma is cancelled it is allowed. Won't renew on a sub with no open part → allowed.
--   7. A paid renewal part on an EXPIRED subscription → no roll; status back to active → the waiting roll runs.
--   8. Grants + RLS: unroll function service_role only; moves table RLS on, select by own tenant only.

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
  ('b2749000-0000-0000-0000-0000000000f1', 'R2749 Undo Co', 'r2749@example.test', '07', 'R749');
update public.tenants set books_start_date = '2025-04-01' where id = 'b2749000-0000-0000-0000-0000000000f1';

create function pg_temp.sub(p_n int, p_cycle text, p_term int, p_start date, p_renewal date)
returns uuid language plpgsql as $f$
declare
  v_c uuid := ('b2749000-0000-0000-0000-0000000001' || lpad(p_n::text, 2, '0'))::uuid;
  v_s uuid := ('b2749000-0000-0000-0000-0000000002' || lpad(p_n::text, 2, '0'))::uuid;
begin
  insert into public.customers (id, tenant_id, name, state_code, country)
  values (v_c, 'b2749000-0000-0000-0000-0000000000f1', 'R2749 C' || p_n, '07', 'India');
  insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle,
                                    term_months, start_date, renewal_date, renewal_state, reminder_count, status)
  values (v_s, 'b2749000-0000-0000-0000-0000000000f1', v_c, 'R2749 C' || p_n, 'Google Workspace Business Starter',
          'google'::vendor, 1, 333, p_cycle::billing_cycle, p_term, p_start, p_renewal, 'grace_period', 3, 'active');
  return v_s;
end $f$;

create function pg_temp.part(p_s uuid, p_k int, p_term date, p_idx int, p_start date, p_months int,
                             p_from date default null, p_to date default null) returns uuid language plpgsql as $f$
declare v_b uuid := ('b2749000-0000-0000-0000-0000000003' || lpad(p_k::text, 2, '0'))::uuid;
begin
  insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start,
                                            period_end, taxable_amount, tax_rate, renews_from, renews_to)
  values (v_b, 'b2749000-0000-0000-0000-0000000000f1', p_s, p_term, p_idx, p_start, p_start,
          (p_start + make_interval(months => p_months))::date, 1000, 18, p_from, p_to);
  return v_b;
end $f$;

create function pg_temp.pay(p_q text, p_amt int, p_ref text) returns void language sql as $f$
  insert into public.payments (tenant_id, quote_id, amount, method, reference, status, received_at)
  values ('b2749000-0000-0000-0000-0000000000f1', p_q, p_amt, 'bank_transfer', p_ref, 'received', now());
$f$;

create function pg_temp.st(p_s uuid) returns text language sql as $f$
  select s.renewal_date::text || ' ' || s.renewal_state::text from public.subscriptions s where s.id = p_s;
$f$;

create function pg_temp.moves(p_s uuid) returns text language sql as $f$
  select coalesce(string_agg(m.direction || ':' || m.from_date || '>' || m.to_date, ' ' order by m.id), '')
    from public.subscription_renewal_moves m where m.subscription_id = p_s;
$f$;

-- ── 1. Paid → renewed; full credit note → back once; billed again + paid → forward once ─────────────────
do $$
declare v_s uuid; v_b uuid; r jsonb; v_inv text; v_q text;
begin
  v_s := pg_temp.sub(1, 'quarterly', 12, '2025-10-01', '2026-09-30');
  v_b := pg_temp.part(v_s, 1, '2026-10-01', 1, '2026-10-01', 3, '2026-09-30', '2027-09-30');
  r := public.bill_subscription_instalment(v_b, false);
  perform pg_temp.pay(r->>'quote_id', 1180, 'R2749-1A');
  v_inv := (select invoice_id from public.subscription_billings where id = v_b);
  if pg_temp.st(v_s) <> '2027-09-30 renewed' or pg_temp.moves(v_s) <> 'forward:2026-09-30>2027-09-30' then
    raise exception 'FAIL 1a: paid → % / moves % (want renewed + one forward move)', pg_temp.st(v_s), pg_temp.moves(v_s); end if;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform public.issue_credit_note(v_inv, (select amount from public.invoices where id = v_inv), 'cancellation', 'R2749 test full CN', null);
  perform set_config('request.jwt.claims', '', true);
  if (select invoice_id from public.subscription_billings where id = v_b) is not null then
    raise exception 'FAIL 1b: full credit note did not free the part (R-2095)'; end if;
  if pg_temp.st(v_s) <> '2026-09-30 pending' then
    raise exception 'FAIL 1b: full credit note → % (want 2026-09-30 pending)', pg_temp.st(v_s); end if;
  if pg_temp.moves(v_s) <> 'forward:2026-09-30>2027-09-30 back:2027-09-30>2026-09-30' then
    raise exception 'FAIL 1b: moves % (want forward then ONE back)', pg_temp.moves(v_s); end if;
  if public.unroll_unpaid_renewal_terms(v_s, 'retry') <> 0 then
    raise exception 'FAIL 1b: a second undo moved it again: %', pg_temp.st(v_s); end if;
  raise notice 'PASS 1b: full credit note → renewal date back to 30 Sep 2026, not renewed, exactly once';

  /* R-2095: the credit note's money is customer credit and re-pays the freed part when it is billed again
     (invoice raised paid) — or, without that credit, a new proforma is paid. Either way: paid → forward. */
  r := public.bill_subscription_instalment(v_b, false);
  v_q := r->>'quote_id';
  if r->>'action' = 'request' then
    perform pg_temp.pay(v_q, 1180, 'R2749-1C');
  elsif r->>'action' <> 'invoice' then
    raise exception 'FAIL 1c: freed part not billed again: %', r;
  end if;
  if pg_temp.st(v_s) <> '2027-09-30 renewed'
     or pg_temp.moves(v_s) <> 'forward:2026-09-30>2027-09-30 back:2027-09-30>2026-09-30 forward:2026-09-30>2027-09-30' then
    raise exception 'FAIL 1c: re-paid → % / %', pg_temp.st(v_s), pg_temp.moves(v_s); end if;
  raise notice 'PASS 1c: re-billed + paid → forward once more';
end $$;

-- ── 2. Un-reconcile (invoice paid → pending) → back; paid again → forward ───────────────────────────────
do $$
declare v_s uuid; v_b uuid; r jsonb; v_inv text;
begin
  v_s := pg_temp.sub(2, 'quarterly', 12, '2025-10-01', '2026-09-30');
  v_b := pg_temp.part(v_s, 2, '2026-10-01', 1, '2026-10-01', 3, '2026-09-30', '2027-09-30');
  r := public.bill_subscription_instalment(v_b, false);
  perform pg_temp.pay(r->>'quote_id', 1180, 'R2749-2');
  v_inv := (select invoice_id from public.subscription_billings where id = v_b);
  update public.invoices set status = 'pending', paid_date = null where id = v_inv;   -- what unreconcile_bank_receipt does
  if pg_temp.st(v_s) <> '2026-09-30 pending' then
    raise exception 'FAIL 2: invoice un-paid → % (want 2026-09-30 pending)', pg_temp.st(v_s); end if;
  update public.invoices set status = 'overdue' where id = v_inv;   -- another non-paid change: no second move
  if pg_temp.moves(v_s) <> 'forward:2026-09-30>2027-09-30 back:2027-09-30>2026-09-30' then
    raise exception 'FAIL 2: moves %', pg_temp.moves(v_s); end if;
  update public.invoices set status = 'paid', paid_date = current_date where id = v_inv;
  if pg_temp.st(v_s) <> '2027-09-30 renewed' then
    raise exception 'FAIL 2: paid again → % (want 2027-09-30 renewed)', pg_temp.st(v_s); end if;
  raise notice 'PASS 2: un-reconcile → back once; paid again → forward once';
end $$;

-- ── 3. Cascade of two terms; term 1 un-paid → back two terms; term 1 paid → both forward ───────────────
do $$
declare v_s uuid; v_b2 uuid; v_b3 uuid; r2 jsonb; r3 jsonb; v_inv2 text;
begin
  v_s := pg_temp.sub(3, 'monthly', 3, '2026-04-01', '2026-06-30');
  v_b2 := pg_temp.part(v_s, 3, '2026-07-01', 1, '2026-07-01', 1, '2026-06-30', '2026-09-30');
  v_b3 := pg_temp.part(v_s, 4, '2026-10-01', 1, '2026-10-01', 1, '2026-09-30', '2026-12-31');
  r2 := public.bill_subscription_instalment(v_b2, false);
  r3 := public.bill_subscription_instalment(v_b3, false);
  perform pg_temp.pay(r3->>'quote_id', 1180, 'R2749-3B');
  perform pg_temp.pay(r2->>'quote_id', 1180, 'R2749-3A');
  if pg_temp.st(v_s) <> '2026-12-31 renewed' then raise exception 'FAIL 3: setup → %', pg_temp.st(v_s); end if;
  v_inv2 := (select invoice_id from public.subscription_billings where id = v_b2);
  update public.invoices set status = 'pending', paid_date = null where id = v_inv2;
  if pg_temp.st(v_s) <> '2026-06-30 pending' then
    raise exception 'FAIL 3: term 1 un-paid → % (want 2026-06-30 pending: term 2 waits behind term 1)', pg_temp.st(v_s); end if;
  update public.invoices set status = 'paid', paid_date = current_date where id = v_inv2;
  if pg_temp.st(v_s) <> '2026-12-31 renewed' then
    raise exception 'FAIL 3: term 1 paid again → % (want 2026-12-31 renewed)', pg_temp.st(v_s); end if;
  raise notice 'PASS 3: cascade undone oldest-first and redone';
end $$;

-- ── 4. Hand-changed date after the roll → undo leaves it ────────────────────────────────────────────
do $$
declare v_s uuid; v_b uuid; r jsonb; v_inv text;
begin
  v_s := pg_temp.sub(4, 'quarterly', 12, '2025-10-01', '2026-09-30');
  v_b := pg_temp.part(v_s, 5, '2026-10-01', 1, '2026-10-01', 3, '2026-09-30', '2027-09-30');
  r := public.bill_subscription_instalment(v_b, false);
  perform pg_temp.pay(r->>'quote_id', 1180, 'R2749-4');
  update public.subscriptions set renewal_date = '2027-10-15' where id = v_s;
  v_inv := (select invoice_id from public.subscription_billings where id = v_b);
  update public.invoices set status = 'pending', paid_date = null where id = v_inv;
  if (select renewal_date from public.subscriptions where id = v_s) <> '2027-10-15' then
    raise exception 'FAIL 4: a hand-changed date was moved back: %', pg_temp.st(v_s); end if;
  raise notice 'PASS 4: hand-changed date is not moved back';
end $$;

-- ── 5. Partial credit note → invoice still paid → nothing moves ─────────────────────────────────────
do $$
declare v_s uuid; v_b uuid; r jsonb; v_inv text;
begin
  v_s := pg_temp.sub(5, 'quarterly', 12, '2025-10-01', '2026-09-30');
  v_b := pg_temp.part(v_s, 6, '2026-10-01', 1, '2026-10-01', 3, '2026-09-30', '2027-09-30');
  r := public.bill_subscription_instalment(v_b, false);
  perform pg_temp.pay(r->>'quote_id', 1180, 'R2749-5');
  v_inv := (select invoice_id from public.subscription_billings where id = v_b);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform public.issue_credit_note(v_inv, 100, 'discount', 'R2749 test partial CN', null);
  perform set_config('request.jwt.claims', '', true);
  if pg_temp.st(v_s) <> '2027-09-30 renewed' then
    raise exception 'FAIL 5: partial credit note moved it: %', pg_temp.st(v_s); end if;
  raise notice 'PASS 5: partial credit note → still renewed';
end $$;

-- ── 6. Won't renew while the renewal part's proforma is open → refused; cancelled → allowed ─────────
do $$
declare v_s uuid; v_b uuid; r jsonb; v_err text; v_s2 uuid;
begin
  v_s := pg_temp.sub(6, 'quarterly', 12, '2025-10-01', '2026-09-30');
  v_b := pg_temp.part(v_s, 7, '2026-10-01', 1, '2026-10-01', 3, '2026-09-30', '2027-09-30');
  r := public.bill_subscription_instalment(v_b, false);
  begin
    update public.subscriptions set auto_renew = false where id = v_s;
    raise exception 'FAIL 6: Won''t renew allowed while proforma % is open', r->>'quote_id';
  exception when invalid_parameter_value then
    get stacked diagnostics v_err = message_text;
  end;
  if v_err not like '%' || (r->>'quote_id') || '%' or v_err not like '%Cancel%' then
    raise exception 'FAIL 6: message does not name the proforma / say cancel: %', v_err; end if;
  perform public.cancel_quote(r->>'quote_id', 'R2749 test cancel');
  update public.subscriptions set auto_renew = false where id = v_s;
  if (select auto_renew from public.subscriptions where id = v_s) then raise exception 'FAIL 6: not set after cancel'; end if;
  v_s2 := pg_temp.sub(7, 'quarterly', 12, '2025-10-01', '2026-09-30');
  update public.subscriptions set auto_renew = false where id = v_s2;
  raise notice 'PASS 6: Won''t renew refused while the part proforma is open (%), allowed after cancel / with no open part', v_err;
end $$;

-- ── 7. Paid renewal part on an expired subscription → reactivated → rolls ───────────────────────────
do $$
declare v_s uuid; v_b uuid; r jsonb;
begin
  v_s := pg_temp.sub(8, 'quarterly', 12, '2025-10-01', '2026-09-30');
  v_b := pg_temp.part(v_s, 8, '2026-10-01', 1, '2026-10-01', 3, '2026-09-30', '2027-09-30');
  r := public.bill_subscription_instalment(v_b, false);
  update public.subscriptions set status = 'expired' where id = v_s;
  perform pg_temp.pay(r->>'quote_id', 1180, 'R2749-7');
  if pg_temp.st(v_s) <> '2026-09-30 grace_period' then
    raise exception 'FAIL 7: expired sub rolled: %', pg_temp.st(v_s); end if;
  update public.subscriptions set status = 'active' where id = v_s;
  if pg_temp.st(v_s) <> '2027-09-30 renewed' then
    raise exception 'FAIL 7: reactivated → % (want 2027-09-30 renewed)', pg_temp.st(v_s); end if;
  raise notice 'PASS 7: paid part on an expired sub renews when it is made active again';
end $$;

-- ── 9. Cascade undone NEWEST first, then the older term → back to the start (a 'back' row of the newer
--       term must not hide the older term's forward move) ──────────────────────────────────────────────
do $$
declare v_s uuid; v_b2 uuid; v_b3 uuid; r2 jsonb; r3 jsonb;
begin
  v_s := pg_temp.sub(9, 'monthly', 3, '2026-04-01', '2026-06-30');
  v_b2 := pg_temp.part(v_s, 9, '2026-07-01', 1, '2026-07-01', 1, '2026-06-30', '2026-09-30');
  v_b3 := pg_temp.part(v_s, 10, '2026-10-01', 1, '2026-10-01', 1, '2026-09-30', '2026-12-31');
  r2 := public.bill_subscription_instalment(v_b2, false);
  perform pg_temp.pay(r2->>'quote_id', 1180, 'R2749-9A');
  r3 := public.bill_subscription_instalment(v_b3, false);
  perform pg_temp.pay(r3->>'quote_id', 1180, 'R2749-9B');
  if pg_temp.st(v_s) <> '2026-12-31 renewed' then raise exception 'FAIL 9: setup → %', pg_temp.st(v_s); end if;
  update public.invoices set status = 'pending', paid_date = null
   where id = (select invoice_id from public.subscription_billings where id = v_b3);
  if pg_temp.st(v_s) <> '2026-09-30 pending' then raise exception 'FAIL 9: newer term undone → %', pg_temp.st(v_s); end if;
  update public.invoices set status = 'pending', paid_date = null
   where id = (select invoice_id from public.subscription_billings where id = v_b2);
  if pg_temp.st(v_s) <> '2026-06-30 pending' then
    raise exception 'FAIL 9: then the older term undone → % (want 2026-06-30 pending)', pg_temp.st(v_s); end if;
  raise notice 'PASS 9: newer then older undone → back to the start';
end $$;

-- ── 10. HELD: a quote linked on renewal_quote_id / a seat cut scheduled / a cancelled sub → date kept,
--        ONE 'held' row for the report (even when the undo fires twice); undo also resets reminders ───────
do $$
declare v_s uuid; v_b uuid; r jsonb; v_inv text; v_held int;
begin
  -- 10a. linked renewal quote
  v_s := pg_temp.sub(10, 'quarterly', 12, '2025-10-01', '2026-09-30');
  v_b := pg_temp.part(v_s, 11, '2026-10-01', 1, '2026-10-01', 3, '2026-09-30', '2027-09-30');
  r := public.bill_subscription_instalment(v_b, false);
  perform pg_temp.pay(r->>'quote_id', 1180, 'R2749-10A');
  insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, amount, subtotal, tax_rate, line_items,
                             is_renewal, renewal_subscription_id)
  values ('Q-R2749-REN', 'b2749000-0000-0000-0000-0000000000f1', 'b2749000-0000-0000-0000-000000000110', 'R2749 C10', 'sent', 'none',
          4720, 4000, 18, '[]'::jsonb, true, v_s);
  update public.subscriptions set renewal_quote_id = 'Q-R2749-REN' where id = v_s;
  v_inv := (select invoice_id from public.subscription_billings where id = v_b);
  update public.invoices set status = 'pending', paid_date = null where id = v_inv;
  update public.invoices set status = 'overdue' where id = v_inv;
  perform public.unroll_unpaid_renewal_terms(v_s, 'retry');
  select count(*) into v_held from public.subscription_renewal_moves where subscription_id = v_s and direction = 'held';
  if pg_temp.st(v_s) <> '2027-09-30 renewed' or v_held <> 1 then
    raise exception 'FAIL 10a: linked quote → % / held rows % (want date kept + ONE held row)', pg_temp.st(v_s), v_held; end if;

  -- 10b. seat cut scheduled for the end of the current term
  v_s := pg_temp.sub(11, 'quarterly', 12, '2025-10-01', '2026-09-30');
  update public.subscriptions set seats = 5 where id = v_s;
  v_b := pg_temp.part(v_s, 12, '2026-10-01', 1, '2026-10-01', 3, '2026-09-30', '2027-09-30');
  r := public.bill_subscription_instalment(v_b, false);
  perform pg_temp.pay(r->>'quote_id', 1180, 'R2749-10B');
  insert into public.subscription_seat_reductions (tenant_id, subscription_id, idempotency_key, timing, status, seats_before,
                                                   seats_removed, seats_after, effective_date)
  values ('b2749000-0000-0000-0000-0000000000f1', v_s, 'r2749-10b', 'end_of_term', 'scheduled', 5, 2, 3, '2027-09-30');
  update public.invoices set status = 'pending', paid_date = null
   where id = (select invoice_id from public.subscription_billings where id = v_b);
  if pg_temp.st(v_s) <> '2027-09-30 renewed'
     or (select status from public.subscription_seat_reductions where idempotency_key = 'r2749-10b' and subscription_id = v_s) <> 'scheduled' then
    raise exception 'FAIL 10b: seat cut scheduled → % (want date + cut kept)', pg_temp.st(v_s); end if;

  -- 10c. cancelled subscription keeps its recorded end
  v_s := pg_temp.sub(12, 'quarterly', 12, '2025-10-01', '2026-09-30');
  v_b := pg_temp.part(v_s, 13, '2026-10-01', 1, '2026-10-01', 3, '2026-09-30', '2027-09-30');
  r := public.bill_subscription_instalment(v_b, false);
  perform pg_temp.pay(r->>'quote_id', 1180, 'R2749-10C');
  update public.subscriptions set status = 'cancelled', auto_renew = false where id = v_s;
  update public.invoices set status = 'pending', paid_date = null
   where id = (select invoice_id from public.subscription_billings where id = v_b);
  if pg_temp.st(v_s) <> '2027-09-30 renewed'
     or not exists (select 1 from public.subscription_renewal_moves where subscription_id = v_s and direction = 'held') then
    raise exception 'FAIL 10c: cancelled sub → % (want end kept + held row)', pg_temp.st(v_s); end if;

  -- 10d. a back move resets reminders (sub 2 was moved back then forward; move it back again after reminders)
  update public.subscriptions set reminder_count = 2, last_reminder_sent_at_v2 = now()
   where id = 'b2749000-0000-0000-0000-000000000202';
  update public.invoices set status = 'pending', paid_date = null
   where id = (select invoice_id from public.subscription_billings where id = 'b2749000-0000-0000-0000-000000000302');
  if (select reminder_count || ' ' || coalesce(last_reminder_sent_at_v2::text, '-') from public.subscriptions
       where id = 'b2749000-0000-0000-0000-000000000202') <> '0 -' then
    raise exception 'FAIL 10d: back move kept the reminders of the rolled-forward date'; end if;
  raise notice 'PASS 10: linked quote / scheduled seat cut / cancelled sub → held (one row); a back move resets reminders';
end $$;

-- ── 11. Cancel subscription (status + auto_renew in one update) with an open part → allowed;
--        a VOID part invoice is not an open part ─────────────────────────────────────────────────────
do $$
declare v_s uuid; v_b uuid; r jsonb;
begin
  v_s := pg_temp.sub(13, 'quarterly', 12, '2025-10-01', '2026-09-30');
  v_b := pg_temp.part(v_s, 14, '2026-10-01', 1, '2026-10-01', 3, '2026-09-30', '2027-09-30');
  r := public.bill_subscription_instalment(v_b, false);
  update public.subscriptions set status = 'cancelled', auto_renew = false where id = v_s;
  if (select status::text from public.subscriptions where id = v_s) <> 'cancelled' then raise exception 'FAIL 11: cancel refused'; end if;

  v_s := pg_temp.sub(14, 'quarterly', 12, '2025-10-01', '2026-09-30');
  v_b := pg_temp.part(v_s, 15, '2026-10-01', 1, '2026-10-01', 3, '2026-09-30', '2027-09-30');
  r := public.bill_subscription_instalment(v_b, false);
  perform pg_temp.pay(r->>'quote_id', 1180, 'R2749-11');
  update public.invoices set status = 'void', paid_date = null
   where id = (select invoice_id from public.subscription_billings where id = v_b);
  update public.subscriptions set auto_renew = false where id = v_s;   -- void invoice: not open → allowed
  raise notice 'PASS 11: cancel with an open part allowed; a void part invoice does not block Won''t renew';
end $$;

-- ── 8. Grants + RLS ───────────────────────────────────────────────────────────────────────────────
do $$
begin
  if has_function_privilege('authenticated', 'public.unroll_unpaid_renewal_terms(uuid,text)', 'execute')
     or has_function_privilege('anon', 'public.unroll_unpaid_renewal_terms(uuid,text)', 'execute') then
    raise exception 'FAIL 8: unroll_unpaid_renewal_terms executable by anon / authenticated'; end if;
  if not (select relrowsecurity from pg_class where oid = 'public.subscription_renewal_moves'::regclass) then
    raise exception 'FAIL 8: RLS off on subscription_renewal_moves'; end if;
  if not exists (select 1 from pg_policies where tablename = 'subscription_renewal_moves' and 'service_role' = any(roles)) then
    raise exception 'FAIL 8: no service_role policy'; end if;
  if has_table_privilege('authenticated', 'public.subscription_renewal_moves', 'insert') then
    raise exception 'FAIL 8: authenticated can insert moves'; end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"00000000-0000-0000-0000-00000000dead"}', true);
do $$
begin
  if exists (select 1 from public.subscription_renewal_moves where tenant_id = 'b2749000-0000-0000-0000-0000000000f1') then
    raise exception 'FAIL 8: a login of another company sees the moves'; end if;
  raise notice 'PASS 8: service_role-only function; moves table RLS on, other company sees nothing';
end $$;
reset role;

rollback;
