-- R-2761 (14 Nov 2026, p2 money) — R-2749 'held' undo moves are re-checked. Migration
-- 20261113231500_r2761_renewal_held_recheck. Self-asserting, ONE transaction, rolled back. Local DB only.
-- RED without the migration (no resolved_at / hold_kind; an expired → held → active sub stays renewed).
--
--   1. Expired sub, paid part un-paid → held (one OPEN held row, kind not_active); made active with the part
--      still unpaid → renewal_date back to renews_from ONCE, held row resolved; a retry moves nothing.
--   2. Held on an expired sub, part RE-PAID while expired → held resolved (nothing unpaid); made active →
--      no move back.
--   3. Quote linked → held (quote_linked); link cleared with the part unpaid → back once, held resolved.
--   4. Reason changes (expired → active while a quote is linked) → a new held row (quote_linked), the old one
--      resolved — only ONE open held row per subscription.
--   5. Hand change of renewal_date back to a forward move's from_date → a 'back' row (the stale forward is
--      closed, rev-r2749 LOW 3); roll / unroll write no extra row. 5b: a held sub's date changed by hand to
--      another date → held resolved, no back row.
--   7. (rev-r2761 MED 1) hold made by a full credit note (expired / quote linked / seat cut), the part billed
--      again through bill_subscription_instalment and paid → hold closed, date kept, no back row.
--   8. (LOW 2) seat-cut hold, the cut cancelled with the part unpaid → back once, hold closed.
--   9. (LOW 3) a second open hold on one subscription is refused (unique index).
--   6. Grants: the new trigger functions are not executable by anon / authenticated; authenticated cannot
--      update the moves table.

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
  ('b2761000-0000-0000-0000-0000000000f1', 'R2761 Held Co', 'r2761@example.test', '07', 'R761');
update public.tenants set books_start_date = '2025-04-01' where id = 'b2761000-0000-0000-0000-0000000000f1';

create function pg_temp.sub(p_n int) returns uuid language plpgsql as $f$
declare
  v_c uuid := ('b2761000-0000-0000-0000-0000000001' || lpad(p_n::text, 2, '0'))::uuid;
  v_s uuid := ('b2761000-0000-0000-0000-0000000002' || lpad(p_n::text, 2, '0'))::uuid;
begin
  insert into public.customers (id, tenant_id, name, state_code, country)
  values (v_c, 'b2761000-0000-0000-0000-0000000000f1', 'R2761 C' || p_n, '07', 'India');
  insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle,
                                    term_months, start_date, renewal_date, renewal_state, reminder_count, status)
  values (v_s, 'b2761000-0000-0000-0000-0000000000f1', v_c, 'R2761 C' || p_n, 'Google Workspace Business Starter',
          'google'::vendor, 1, 333, 'quarterly'::billing_cycle, 12, '2025-10-01', '2026-09-30', 'grace_period', 3, 'active');
  return v_s;
end $f$;

/* A paid renewal part (renews 2026-09-30 → 2027-09-30); returns its invoice id. */
create function pg_temp.paid_part(p_s uuid, p_k int) returns text language plpgsql as $f$
declare v_b uuid := ('b2761000-0000-0000-0000-0000000003' || lpad(p_k::text, 2, '0'))::uuid; r jsonb;
begin
  insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start,
                                            period_end, taxable_amount, tax_rate, renews_from, renews_to)
  values (v_b, 'b2761000-0000-0000-0000-0000000000f1', p_s, '2026-10-01', 1, '2026-10-01', '2026-10-01',
          '2027-01-01', 1000, 18, '2026-09-30', '2027-09-30');
  r := public.bill_subscription_instalment(v_b, false);
  insert into public.payments (tenant_id, quote_id, amount, method, reference, status, received_at)
  values ('b2761000-0000-0000-0000-0000000000f1', r->>'quote_id', 1180, 'bank_transfer', 'R2761-' || p_k, 'received', now());
  return (select invoice_id from public.subscription_billings where id = v_b);
end $f$;

create function pg_temp.st(p_s uuid) returns text language sql as $f$
  select s.renewal_date::text || ' ' || s.renewal_state::text from public.subscriptions s where s.id = p_s;
$f$;

create function pg_temp.moves(p_s uuid) returns text language sql as $f$
  select coalesce(string_agg(m.direction || ':' || m.from_date || '>' || m.to_date, ' ' order by m.id), '')
    from public.subscription_renewal_moves m where m.subscription_id = p_s;
$f$;

/* Open (unresolved) held rows: "kind,kind". */
create function pg_temp.open_held(p_s uuid) returns text language sql as $f$
  select coalesce(string_agg(coalesce(m.hold_kind, '?'), ',' order by m.id), '')
    from public.subscription_renewal_moves m
   where m.subscription_id = p_s and m.direction = 'held' and m.resolved_at is null;
$f$;

create function pg_temp.unpay(p_inv text) returns void language sql as $f$
  update public.invoices set status = 'pending', paid_date = null where id = p_inv;   -- what unreconcile_bank_receipt does
$f$;

create function pg_temp.link_quote(p_s uuid, p_n int, p_q text) returns void language plpgsql as $f$
begin
  insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, amount, subtotal, tax_rate, line_items,
                             is_renewal, renewal_subscription_id)
  values (p_q, 'b2761000-0000-0000-0000-0000000000f1', ('b2761000-0000-0000-0000-0000000001' || lpad(p_n::text, 2, '0'))::uuid,
          'R2761 C' || p_n, 'sent', 'none', 4720, 4000, 18, '[]'::jsonb, true, p_s);
  update public.subscriptions set renewal_quote_id = p_q where id = p_s;
end $f$;

-- ── 1. expired → held → active with the part still unpaid → back once ─────────────────────────────────
do $$
declare v_s uuid; v_inv text;
begin
  v_s := pg_temp.sub(1);
  v_inv := pg_temp.paid_part(v_s, 1);
  if pg_temp.st(v_s) <> '2027-09-30 renewed' then raise exception 'FAIL 1 setup: %', pg_temp.st(v_s); end if;
  update public.subscriptions set status = 'expired' where id = v_s;
  perform pg_temp.unpay(v_inv);
  if pg_temp.st(v_s) <> '2027-09-30 renewed' or pg_temp.open_held(v_s) <> 'not_active' then
    raise exception 'FAIL 1a: expired + unpaid → % / open held % (want date kept + one not_active hold)', pg_temp.st(v_s), pg_temp.open_held(v_s); end if;

  update public.subscriptions set status = 'active' where id = v_s;
  if pg_temp.st(v_s) <> '2026-09-30 pending' then
    raise exception 'FAIL 1b: made active, part unpaid → % (want 2026-09-30 pending)', pg_temp.st(v_s); end if;
  if pg_temp.moves(v_s) <> 'forward:2026-09-30>2027-09-30 held:2027-09-30>2026-09-30 back:2027-09-30>2026-09-30' then
    raise exception 'FAIL 1b: moves % (want forward, held, ONE back)', pg_temp.moves(v_s); end if;
  if pg_temp.open_held(v_s) <> '' then raise exception 'FAIL 1b: held still open: %', pg_temp.open_held(v_s); end if;

  if public.unroll_unpaid_renewal_terms(v_s, 'retry') <> 0 then raise exception 'FAIL 1c: retry moved again'; end if;
  update public.subscriptions set status = 'paused' where id = v_s;
  update public.subscriptions set status = 'expired' where id = v_s;
  update public.subscriptions set status = 'active' where id = v_s;
  if pg_temp.st(v_s) <> '2026-09-30 pending' or pg_temp.moves(v_s) not like '%back:2027-09-30>2026-09-30' then
    raise exception 'FAIL 1c: status changes after the move → % / %', pg_temp.st(v_s), pg_temp.moves(v_s); end if;
  raise notice 'PASS 1: held on an expired sub moves back once when it is made active with the part unpaid';
end $$;

-- ── 2. held, re-paid while expired → resolved; made active → no move ─────────────────────────────────
do $$
declare v_s uuid; v_inv text;
begin
  v_s := pg_temp.sub(2);
  v_inv := pg_temp.paid_part(v_s, 2);
  update public.subscriptions set status = 'expired' where id = v_s;
  perform pg_temp.unpay(v_inv);
  if pg_temp.open_held(v_s) <> 'not_active' then raise exception 'FAIL 2 setup: open held %', pg_temp.open_held(v_s); end if;
  update public.invoices set status = 'paid', paid_date = current_date where id = v_inv;
  if pg_temp.open_held(v_s) <> '' then
    raise exception 'FAIL 2a: part paid again → hold still open (%)', pg_temp.open_held(v_s); end if;
  update public.subscriptions set status = 'active' where id = v_s;
  if pg_temp.st(v_s) <> '2027-09-30 renewed' or pg_temp.moves(v_s) like '%back%' then
    raise exception 'FAIL 2b: re-paid then active → % / % (want renewed, no back)', pg_temp.st(v_s), pg_temp.moves(v_s); end if;
  raise notice 'PASS 2: part paid again while held → hold resolved, nothing moves';
end $$;

-- ── 3. quote linked → held; link cleared with the part unpaid → back once ────────────────────────────
do $$
declare v_s uuid; v_inv text;
begin
  v_s := pg_temp.sub(3);
  v_inv := pg_temp.paid_part(v_s, 3);
  perform pg_temp.link_quote(v_s, 3, 'Q-R2761-3');
  perform pg_temp.unpay(v_inv);
  if pg_temp.st(v_s) <> '2027-09-30 renewed' or pg_temp.open_held(v_s) <> 'quote_linked' then
    raise exception 'FAIL 3a: linked + unpaid → % / %', pg_temp.st(v_s), pg_temp.open_held(v_s); end if;
  update public.quotes set status = 'rejected', cancelled_at = now() where id = 'Q-R2761-3';
  update public.subscriptions set renewal_quote_id = null where id = v_s;
  if pg_temp.st(v_s) <> '2026-09-30 pending' or pg_temp.open_held(v_s) <> ''
     or (select count(*) from public.subscription_renewal_moves where subscription_id = v_s and direction = 'back') <> 1 then
    raise exception 'FAIL 3b: link cleared → % / open held % / %', pg_temp.st(v_s), pg_temp.open_held(v_s), pg_temp.moves(v_s); end if;
  raise notice 'PASS 3: quote link cleared with the part unpaid → back once, hold resolved';
end $$;

-- ── 4. reason changes → one open held row with the new reason ───────────────────────────────────────
do $$
declare v_s uuid; v_inv text;
begin
  v_s := pg_temp.sub(4);
  v_inv := pg_temp.paid_part(v_s, 4);
  update public.subscriptions set status = 'expired' where id = v_s;
  perform pg_temp.unpay(v_inv);
  perform pg_temp.link_quote(v_s, 4, 'Q-R2761-4');
  update public.subscriptions set status = 'active' where id = v_s;
  if pg_temp.st(v_s) <> '2027-09-30 renewed' or pg_temp.open_held(v_s) <> 'quote_linked' then
    raise exception 'FAIL 4: active while a quote is linked → % / open held % (want date kept, ONE quote_linked hold)',
      pg_temp.st(v_s), pg_temp.open_held(v_s); end if;
  if (select count(*) from public.subscription_renewal_moves where subscription_id = v_s and direction = 'held' and resolved_at is not null) <> 1 then
    raise exception 'FAIL 4: the old not_active hold is not resolved'; end if;
  raise notice 'PASS 4: hold reason changed → new hold, old one resolved';
end $$;

-- ── 5. hand change back to from_date → a back row; roll / unroll write none extra ───────────────────
do $$
declare v_s uuid; v_inv text;
begin
  v_s := pg_temp.sub(5);
  v_inv := pg_temp.paid_part(v_s, 5);
  update public.subscriptions set renewal_date = '2026-09-30' where id = v_s;   -- by hand
  if pg_temp.moves(v_s) <> 'forward:2026-09-30>2027-09-30 back:2027-09-30>2026-09-30' then
    raise exception 'FAIL 5a: hand change back → moves % (want the forward closed by a back row)', pg_temp.moves(v_s); end if;

  -- an automatic move back (sub 1 style) writes exactly one back row, not two
  v_s := pg_temp.sub(6);
  v_inv := pg_temp.paid_part(v_s, 6);
  perform pg_temp.unpay(v_inv);
  if pg_temp.moves(v_s) <> 'forward:2026-09-30>2027-09-30 back:2027-09-30>2026-09-30' then
    raise exception 'FAIL 5a: automatic back wrote % (want one back row)', pg_temp.moves(v_s); end if;

  -- 5b. held sub, date changed by hand to another date → hold resolved, no back row
  v_s := pg_temp.sub(7);
  v_inv := pg_temp.paid_part(v_s, 7);
  update public.subscriptions set status = 'expired' where id = v_s;
  perform pg_temp.unpay(v_inv);
  update public.subscriptions set renewal_date = '2027-03-31' where id = v_s;
  if pg_temp.open_held(v_s) <> '' or pg_temp.moves(v_s) like '%back%' then
    raise exception 'FAIL 5b: hand change of a held sub → open held % / %', pg_temp.open_held(v_s), pg_temp.moves(v_s); end if;
  raise notice 'PASS 5: hand change back closes the forward; other hand change resolves the hold';
end $$;

-- ── 7. rev-r2761 MED 1: hold made by a FULL CREDIT NOTE, then the part billed again (real path:
--       bill_subscription_instalment → paid invoice INSERTED from customer credit, or a proforma paid) →
--       hold closed, date unchanged, no back row. Expired, quote-linked and seat-cut holds. ───────────────
create function pg_temp.full_cn_and_rebill(p_s uuid, p_k int) returns text language plpgsql as $f$
declare v_b uuid := ('b2761000-0000-0000-0000-0000000003' || lpad(p_k::text, 2, '0'))::uuid; v_inv text; r jsonb;
begin
  v_inv := (select invoice_id from public.subscription_billings where id = v_b);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform public.issue_credit_note(v_inv, (select amount from public.invoices where id = v_inv), 'cancellation', 'R2761 test full CN', null);
  perform set_config('request.jwt.claims', '', true);
  if (select invoice_id from public.subscription_billings where id = v_b) is not null then
    raise exception 'FAIL 7 setup: full credit note did not free the part'; end if;
  if pg_temp.open_held(p_s) = '' then raise exception 'FAIL 7 setup: no open hold after the credit note (% / %)', pg_temp.st(p_s), pg_temp.moves(p_s); end if;
  r := public.bill_subscription_instalment(v_b, false);
  if r->>'action' = 'request' then
    insert into public.payments (tenant_id, quote_id, amount, method, reference, status, received_at)
    values ('b2761000-0000-0000-0000-0000000000f1', r->>'quote_id', (select amount from public.quotes where id = r->>'quote_id'),
            'bank_transfer', 'R2761-7-' || p_k, 'received', now());
  elsif r->>'action' <> 'invoice' then
    raise exception 'FAIL 7: freed part not billed again: %', r;
  end if;
  if (select i.status::text from public.subscription_billings b join public.invoices i on i.id = b.invoice_id where b.id = v_b) <> 'paid' then
    raise exception 'FAIL 7: re-billed part invoice not paid (%)', r; end if;
  return pg_temp.open_held(p_s);
end $f$;

do $$
declare v_s uuid; v_inv text; v_left text;
begin
  -- 7a. expired sub
  v_s := pg_temp.sub(8);
  v_inv := pg_temp.paid_part(v_s, 8);
  update public.subscriptions set status = 'expired' where id = v_s;
  v_left := pg_temp.full_cn_and_rebill(v_s, 8);
  if v_left <> '' or pg_temp.st(v_s) <> '2027-09-30 renewed' or pg_temp.moves(v_s) like '%back%' then
    raise exception 'FAIL 7a: expired, re-billed paid → open hold % / % / %', v_left, pg_temp.st(v_s), pg_temp.moves(v_s); end if;

  -- 7b. quote linked
  v_s := pg_temp.sub(9);
  v_inv := pg_temp.paid_part(v_s, 9);
  perform pg_temp.link_quote(v_s, 9, 'Q-R2761-9');
  v_left := pg_temp.full_cn_and_rebill(v_s, 9);
  if v_left <> '' or pg_temp.st(v_s) <> '2027-09-30 renewed' or pg_temp.moves(v_s) like '%back%' then
    raise exception 'FAIL 7b: quote linked, re-billed paid → open hold % / % / %', v_left, pg_temp.st(v_s), pg_temp.moves(v_s); end if;

  -- 7c. seat cut scheduled on an ACTIVE sub
  v_s := pg_temp.sub(10);
  update public.subscriptions set seats = 5 where id = v_s;
  v_inv := pg_temp.paid_part(v_s, 10);
  insert into public.subscription_seat_reductions (tenant_id, subscription_id, idempotency_key, timing, status, seats_before,
                                                   seats_removed, seats_after, effective_date)
  values ('b2761000-0000-0000-0000-0000000000f1', v_s, 'r2761-7c', 'end_of_term', 'scheduled', 5, 2, 3, '2027-09-30');
  v_left := pg_temp.full_cn_and_rebill(v_s, 10);
  if v_left <> '' or pg_temp.st(v_s) <> '2027-09-30 renewed' or pg_temp.moves(v_s) like '%back%' then
    raise exception 'FAIL 7c: seat cut, re-billed paid → open hold % / % / %', v_left, pg_temp.st(v_s), pg_temp.moves(v_s); end if;
  raise notice 'PASS 7: a hold made by a full credit note closes when the part is billed again and paid (expired / quote / seat cut)';
end $$;

-- ── 8. rev-r2761 LOW 2: seat-cut hold, the cut is cancelled with the part still unpaid → back once ──────
do $$
declare v_s uuid; v_inv text;
begin
  v_s := pg_temp.sub(11);
  update public.subscriptions set seats = 5 where id = v_s;
  v_inv := pg_temp.paid_part(v_s, 11);
  insert into public.subscription_seat_reductions (tenant_id, subscription_id, idempotency_key, timing, status, seats_before,
                                                   seats_removed, seats_after, effective_date)
  values ('b2761000-0000-0000-0000-0000000000f1', v_s, 'r2761-8', 'end_of_term', 'scheduled', 5, 2, 3, '2027-09-30');
  perform pg_temp.unpay(v_inv);
  if pg_temp.open_held(v_s) <> 'seat_cut' or pg_temp.st(v_s) <> '2027-09-30 renewed' then
    raise exception 'FAIL 8 setup: % / %', pg_temp.open_held(v_s), pg_temp.st(v_s); end if;
  update public.subscription_seat_reductions set status = 'cancelled' where subscription_id = v_s and idempotency_key = 'r2761-8';
  if pg_temp.st(v_s) <> '2026-09-30 pending' or pg_temp.open_held(v_s) <> ''
     or (select count(*) from public.subscription_renewal_moves where subscription_id = v_s and direction = 'back') <> 1 then
    raise exception 'FAIL 8: cut cancelled → % / open held % / %', pg_temp.st(v_s), pg_temp.open_held(v_s), pg_temp.moves(v_s); end if;
  raise notice 'PASS 8: seat cut cancelled with the part unpaid → back once, hold closed';
end $$;

-- ── 9. rev-r2761 LOW 3: one open hold per subscription is enforced ─────────────────────────────────────
do $$
declare v_s uuid := 'b2761000-0000-0000-0000-000000000204';   -- sub 4: one open quote_linked hold
begin
  if pg_temp.open_held(v_s) <> 'quote_linked' then raise exception 'FAIL 9 setup: %', pg_temp.open_held(v_s); end if;
  begin
    insert into public.subscription_renewal_moves (tenant_id, subscription_id, direction, from_date, to_date, why, hold_kind)
    values ('b2761000-0000-0000-0000-0000000000f1', v_s, 'held', '2027-09-30', '2026-09-30', 'second open hold', 'not_active');
    raise exception 'FAIL 9: a second open hold was allowed';
  exception when unique_violation then
    raise notice 'PASS 9: a second open hold is refused (unique index)';
  end;
end $$;

-- ── 6. Grants ──────────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if has_function_privilege('authenticated', 'public.tg_r2761_recheck_held()', 'execute')
     or has_function_privilege('authenticated', 'public.tg_r2761_renewal_date_changed()', 'execute')
     or has_function_privilege('authenticated', 'public.tg_r2761_part_paid_recheck()', 'execute')
     or has_function_privilege('authenticated', 'public.tg_r2761_part_linked_recheck()', 'execute')
     or has_function_privilege('authenticated', 'public.tg_r2761_cut_cancelled_recheck()', 'execute')
     or has_function_privilege('anon', 'public.tg_r2761_recheck_held()', 'execute') then
    raise exception 'FAIL 6: R-2761 trigger functions executable by anon / authenticated'; end if;
  if has_function_privilege('authenticated', 'public.unroll_unpaid_renewal_terms(uuid,text)', 'execute') then
    raise exception 'FAIL 6: unroll executable by authenticated'; end if;
  if has_table_privilege('authenticated', 'public.subscription_renewal_moves', 'update') then
    raise exception 'FAIL 6: authenticated can update moves'; end if;
  raise notice 'PASS 6: grants';
end $$;

rollback;
