\set ON_ERROR_STOP on
-- R-2848 (15 Nov 2026, p1 money) — R-2809b: paying a renewal quote billed together (R-2847) renews EACH linked yearly
-- subscription once, by its own term; cancel / undo let go of or move back each one.
-- Migration 20261115134526_r2848_renewal_together_payment (needs R-2847's 20261115125834). Self-asserting, ONE
-- transaction, rolled back. Local DB only. RED without the migration (R-2847's gate refuses every together quote).
--
--   N  gate open: r2847_together_payment_ready() is true
--   A  full payment → each sub: its own term + 12 months, renewed, its own mrr / seats, link cleared, one forward move,
--      one draft PO each
--   B  part payment → nothing renewed; the payment that completes it renews both
--   C  same reference again / an overpayment → nothing renewed again, overpay → customer credit
--   D  invoice raised before the payment → renewed when the payment makes it paid;  O  each invoice line its own period
--   G  un-reconcile (receipt refunded + invoice due) → both back once; re-reconciled → both forward once
--   H  part credit note → nothing moves; full credit note → both back once;  H2 payment deleted (no invoice) → back
--   I  a member with a new quote linked → held (one open held row), the other moves back; link cleared → moves back
--   J  R-2761 re-check on a PAID together term → nothing moves
--   E  cancel_quote → every member let go + link rows released; E2 single renewal quote cancelled → link cleared;
--      E3 Undo cancel of that single quote → linked back
--   F  undo cancel of that together quote / a payment on it → refused;  F2 activate on credit → refused
--   P  a member's renewal date moved since the quote → payment refused, nothing recorded
--   K  deleting a subscription waiting on a live together quote → refused
--   L  tax_rate outside 0/5/12/18/28 → refused (together + single);  M  qty 0 / rate < 0 / other company's item → refused

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
  ('c2848000-0000-0000-0000-0000000000f1', 'R2848 Together Co', 'r2848@example.test', '07', 'R848'),
  ('c2848000-0000-0000-0000-0000000000f2', 'R2848 Other Co', 'r2848o@example.test', '07', 'R84P');

create function pg_temp.t() returns uuid language sql immutable as $f$ select 'c2848000-0000-0000-0000-0000000000f1'::uuid $f$;

create function pg_temp.cust(p_n int) returns uuid language plpgsql as $f$
declare v_c uuid := ('c2848000-0000-0000-0000-0000000001' || lpad(p_n::text, 2, '0'))::uuid;
begin
  insert into public.customers (id, tenant_id, name, state_code, state, country)
  values (v_c, pg_temp.t(), 'R2848 C' || p_n, '07', 'Delhi', 'India');
  return v_c;
end $f$;

create function pg_temp.sub(p_n int, p_c uuid, p_plan text, p_seats int, p_renewal date) returns uuid
language plpgsql as $f$
declare v_s uuid := ('c2848000-0000-0000-0000-0000000002' || lpad(p_n::text, 2, '0'))::uuid;
begin
  insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle,
                                    term_months, start_date, renewal_date, renewal_state, reminder_count, status, domain)
  values (v_s, pg_temp.t(), p_c, (select name from public.customers where id = p_c), p_plan,
          'google'::vendor, p_seats, 1000, 'yearly'::billing_cycle, 12, p_renewal - 365, p_renewal, 'grace_period', 1,
          'active', 'r2848-' || p_n || '.example.test');
  return v_s;
end $f$;

create function pg_temp.sid(p_n int) returns uuid language sql immutable as $f$
  select ('c2848000-0000-0000-0000-0000000002' || lpad(p_n::text, 2, '0'))::uuid $f$;

/* The app's price for one subscription (createRenewalQuote's p_quote shape). */
create function pg_temp.q(p_plan text, p_seats int, p_subtotal int, p_rate int default 18, p_lines jsonb default null) returns jsonb
language sql immutable as $f$
  select jsonb_build_object(
    'customer_name', 'R2848', 'plan', p_plan, 'seats', p_seats,
    'amount', p_subtotal + round(p_subtotal * p_rate / 100.0)::int, 'subtotal', p_subtotal,
    'total_cost', (p_subtotal * 0.8)::int, 'tax_rate', p_rate,
    'created_date', '2026-10-20', 'expires_date', '2026-11-30', 'extension_months', 12, 'notes', 'R-2848 test',
    'line_items', coalesce(p_lines, jsonb_build_array(jsonb_build_object('id', 'renewal-1', 'name', p_plan, 'qty', p_seats,
                                    'rate', p_subtotal / p_seats, 'cost', 0, 'commitment', 'annual_yearly'))))
$f$;

create function pg_temp.part(p_s uuid, p_q jsonb) returns jsonb language sql immutable as $f$
  select jsonb_build_object('subscription_id', p_s, 'quote', p_q) $f$;

/* Customer p_c + two yearly subs (31 Oct: Standard 20 seats ₹2,64,000; 15 Nov: Starter 10 seats ₹84,000) + ONE
   together quote (₹3,48,000 + 18% = ₹4,10,640). Returns the quote id. */
create function pg_temp.mk(p_c int, p_a int, p_b int) returns text language plpgsql as $f$
declare v_c uuid; a uuid; b uuid; r jsonb;
begin
  v_c := pg_temp.cust(p_c);
  a := pg_temp.sub(p_a, v_c, 'Business Standard', 20, '2026-10-31');
  b := pg_temp.sub(p_b, v_c, 'Business Starter', 10, '2026-11-15');
  r := public.create_renewal_quote_together(pg_temp.t(),
         jsonb_build_array(pg_temp.part(a, pg_temp.q('Business Standard', 20, 264000)),
                           pg_temp.part(b, pg_temp.q('Business Starter', 10, 84000))));
  return r->>'quote_id';
end $f$;

create function pg_temp.pay(p_q text, p_amt int, p_ref text) returns jsonb language plpgsql as $f$
declare r jsonb;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.record_payment(p_q, p_amt, 'bank_transfer', p_ref, 'R-2848 test');
  perform set_config('request.jwt.claims', '', true);
  return r;
exception when others then
  perform set_config('request.jwt.claims', '', true);
  raise;
end $f$;

create function pg_temp.try(p_sql text) returns text language plpgsql as $f$
begin
  execute p_sql;
  perform set_config('request.jwt.claims', '', true);
  return 'OK';
exception when others then
  perform set_config('request.jwt.claims', '', true);
  return sqlstate || ' ' || sqlerrm;
end $f$;

create function pg_temp.st(p_s uuid) returns text language sql as $f$
  select s.renewal_date::text || ' ' || s.renewal_state::text from public.subscriptions s where s.id = p_s $f$;

create function pg_temp.moves(p_s uuid) returns text language sql as $f$
  select coalesce(string_agg(m.direction || ':' || m.from_date || '>' || m.to_date, ' ' order by m.id), '')
    from public.subscription_renewal_moves m where m.subscription_id = p_s $f$;

-- ── N — the gate is open ────────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not public.r2847_together_payment_ready() then
    raise exception 'FAIL N: r2847_together_payment_ready() is still false — R-2848 must open it';
  end if;
  raise notice 'PASS N: together quotes can be made (record_payment renews every linked subscription)';
end $$;

-- ── A — full payment renews EACH by its own term ────────────────────────────────────────────────────────────
do $$
declare v_q text; a uuid := pg_temp.sid(1); b uuid := pg_temp.sid(2); r jsonb; v_s record; v_n int;
begin
  v_q := pg_temp.mk(1, 1, 2);
  r := pg_temp.pay(v_q, 410640, 'R2848-A1');
  if (r->>'together')::boolean is not true or (r->>'together_renewed')::int <> 2 or (r->>'is_fully_paid')::boolean is not true then
    raise exception 'FAIL A: result %', r; end if;
  select * into v_s from public.subscriptions where id = a;
  if v_s.renewal_date <> '2027-10-31' or v_s.renewal_state::text <> 'renewed' or v_s.mrr <> 22000 or v_s.seats <> 20
     or v_s.renewal_quote_id is not null or v_s.reminder_count <> 0 or v_s.status::text <> 'active' then
    raise exception 'FAIL A: Standard % % mrr % seats % link % (want 2027-10-31 renewed, 22000, 20, null)',
      v_s.renewal_date, v_s.renewal_state, v_s.mrr, v_s.seats, v_s.renewal_quote_id; end if;
  select * into v_s from public.subscriptions where id = b;
  if v_s.renewal_date <> '2027-11-15' or v_s.renewal_state::text <> 'renewed' or v_s.mrr <> 7000 or v_s.seats <> 10
     or v_s.renewal_quote_id is not null then
    raise exception 'FAIL A: Starter % % mrr % seats % (want 2027-11-15 renewed, 7000, 10) — the quote total must never be one sub''s mrr',
      v_s.renewal_date, v_s.renewal_state, v_s.mrr, v_s.seats; end if;
  if pg_temp.moves(a) <> 'forward:2026-10-31>2027-10-31' or pg_temp.moves(b) <> 'forward:2026-11-15>2027-11-15' then
    raise exception 'FAIL A: moves % / %', pg_temp.moves(a), pg_temp.moves(b); end if;
  select count(*) into v_n from public.subscription_renewal_moves where quote_id = v_q and direction = 'forward';
  if v_n <> 2 then raise exception 'FAIL A: % forward moves carry the quote id (want 2)', v_n; end if;
  select count(*) into v_n from public.renewal_quote_subscriptions where quote_id = v_q and renewed_at is not null;
  if v_n <> 2 then raise exception 'FAIL A: % link rows renewed (want 2)', v_n; end if;
  select count(*) into v_n from public.purchase_orders where subscription_id in (a, b) and status::text = 'draft'
     and ((subscription_id = a and seats = 20 and plan = 'Business Standard') or (subscription_id = b and seats = 10 and plan = 'Business Starter'));
  if v_n <> 2 then raise exception 'FAIL A: % draft POs (want one per subscription)', v_n; end if;
  select count(*) into v_n from public.subscriptions where tenant_id = pg_temp.t() and quote_id = v_q;
  if v_n <> 0 then raise exception 'FAIL A: the payment filed % NEW subscriptions', v_n; end if;
  raise notice 'PASS A: one payment renewed Standard to 31 Oct 2027 (₹22,000/month, 20 seats) and Starter to 15 Nov 2027 (₹7,000/month, 10 seats)';
end $$;

-- ── C — retry / overpayment renew nothing again ─────────────────────────────────────────────────────────────
do $$
declare v_q text; a uuid := pg_temp.sid(1); b uuid := pg_temp.sid(2); r jsonb; v_n int;
begin
  select quote_id into v_q from public.renewal_quote_subscriptions where subscription_id = a;
  r := pg_temp.pay(v_q, 410640, 'R2848-A1');
  if (r->>'idempotent_replay')::boolean is not true then raise exception 'FAIL C: same reference was not a replay: %', r; end if;
  r := pg_temp.pay(v_q, 5000, 'R2848-A2');
  if pg_temp.st(a) <> '2027-10-31 renewed' or pg_temp.st(b) <> '2027-11-15 renewed'
     or pg_temp.moves(a) <> 'forward:2026-10-31>2027-10-31' or pg_temp.moves(b) <> 'forward:2026-11-15>2027-11-15' then
    raise exception 'FAIL C: renewed again: % / % (moves % / %)', pg_temp.st(a), pg_temp.st(b), pg_temp.moves(a), pg_temp.moves(b); end if;
  select count(*) into v_n from public.purchase_orders where subscription_id in (a, b);
  if v_n <> 2 then raise exception 'FAIL C: % POs after the overpayment (want 2)', v_n; end if;
  if (r->>'overpaid_credit')::int <> 5000 then raise exception 'FAIL C: overpaid credit % (want 5000)', r->>'overpaid_credit'; end if;
  raise notice 'PASS C: same reference = replay, an extra ₹5,000 = customer credit, nothing renewed twice';
end $$;

-- ── B — part payment renews none ────────────────────────────────────────────────────────────────────────────
do $$
declare v_q text; a uuid := pg_temp.sid(3); b uuid := pg_temp.sid(4); r jsonb;
begin
  v_q := pg_temp.mk(2, 3, 4);
  r := pg_temp.pay(v_q, 100000, 'R2848-B1');
  if pg_temp.st(a) <> '2026-10-31 grace_period' or pg_temp.st(b) <> '2026-11-15 grace_period'
     or (select count(*) from public.subscriptions where id in (a, b) and renewal_quote_id = v_q) <> 2
     or (r->>'together_renewed')::int <> 0 then
    raise exception 'FAIL B: part payment changed % / % (result %)', pg_temp.st(a), pg_temp.st(b), r; end if;
  r := pg_temp.pay(v_q, 310640, 'R2848-B2');
  if pg_temp.st(a) <> '2027-10-31 renewed' or pg_temp.st(b) <> '2027-11-15 renewed' then
    raise exception 'FAIL B: the completing payment → % / %', pg_temp.st(a), pg_temp.st(b); end if;
  raise notice 'PASS B: ₹1,00,000 of ₹4,10,640 renewed nothing; the rest renewed both';
end $$;

-- ── H2 — a payment deleted (no invoice) → both back once ────────────────────────────────────────────────────
do $$
declare a uuid := pg_temp.sid(3); b uuid := pg_temp.sid(4);
begin
  delete from public.payments where reference = 'R2848-B2' and tenant_id = pg_temp.t();
  if pg_temp.st(a) <> '2026-10-31 pending' or pg_temp.st(b) <> '2026-11-15 pending' then
    raise exception 'FAIL H2: payment deleted → % / % (want back, pending)', pg_temp.st(a), pg_temp.st(b); end if;
  if pg_temp.moves(a) <> 'forward:2026-10-31>2027-10-31 back:2027-10-31>2026-10-31' then
    raise exception 'FAIL H2: moves %', pg_temp.moves(a); end if;
  if exists (select 1 from public.renewal_quote_subscriptions where subscription_id in (a, b) and renewed_at is not null) then
    raise exception 'FAIL H2: link rows still marked renewed'; end if;
  if public.unroll_unpaid_renewal_terms(a, 'retry') <> 0 then raise exception 'FAIL H2: moved back twice'; end if;
  raise notice 'PASS H2: a deleted payment moved both subscriptions back once';
end $$;

-- ── D + O — invoice before payment; each line its own period ───────────────────────────────────────────────
do $$
declare v_q text; a uuid := pg_temp.sid(5); b uuid := pg_temp.sid(6); v_inv text; v_l jsonb; r jsonb;
begin
  v_q := pg_temp.mk(3, 5, 6);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select gi.invoice_id into v_inv from public.generate_invoice(v_q) gi;
  perform set_config('request.jwt.claims', '', true);
  if (select status::text from public.invoices where id = v_inv) <> 'pending' then
    raise exception 'FAIL D: invoice % is % (want pending)', v_inv, (select status from public.invoices where id = v_inv); end if;
  select line_items into v_l from public.invoices where id = v_inv;
  if jsonb_array_length(v_l) <> 2 or jsonb_typeof(v_l->0->'service_period') is distinct from 'object'
     or jsonb_typeof(v_l->1->'service_period') is distinct from 'object'
     or v_l->0->'service_period'->>'from' not in ('2026-10-31', '2026-11-01') or v_l->0->'service_period'->>'to' not in ('2027-10-30', '2027-10-31')
     or v_l->1->'service_period'->>'from' not in ('2026-11-15', '2026-11-16') or v_l->1->'service_period'->>'to' not in ('2027-11-14', '2027-11-15') then
    raise exception 'FAIL O: invoice line periods %', v_l; end if;
  if pg_temp.st(a) <> '2026-10-31 grace_period' then raise exception 'FAIL D: invoicing renewed %', pg_temp.st(a); end if;
  r := pg_temp.pay(v_q, 410640, 'R2848-D1');
  if (select status::text from public.invoices where id = v_inv) <> 'paid' then raise exception 'FAIL D: invoice not paid'; end if;
  if pg_temp.st(a) <> '2027-10-31 renewed' or pg_temp.st(b) <> '2027-11-15 renewed' then
    raise exception 'FAIL D: paid in full against its invoice → % / %', pg_temp.st(a), pg_temp.st(b); end if;
  if (select count(*) from public.purchase_orders where subscription_id in (a, b)) <> 2 then
    raise exception 'FAIL D: POs %', (select count(*) from public.purchase_orders where subscription_id in (a, b)); end if;
  raise notice 'PASS D/O: one GST invoice, line 1 % to %, line 2 % to %; paying it renewed both',
    v_l->0->'service_period'->>'from', v_l->0->'service_period'->>'to', v_l->1->'service_period'->>'from', v_l->1->'service_period'->>'to';
end $$;

-- ── G — invoice paid → pending → back once; paid again → forward once ──────────────────────────────────────
do $$
declare a uuid := pg_temp.sid(5); b uuid := pg_temp.sid(6); v_inv text;
begin
  select q.invoice_id into v_inv from public.quotes q join public.renewal_quote_subscriptions l on l.quote_id = q.id where l.subscription_id = a;
  /* a bank un-reconcile: the receipt goes, the invoice is due again */
  update public.payments set status = 'refunded' where reference = 'R2848-D1' and tenant_id = pg_temp.t();
  update public.invoices set status = 'pending' where id = v_inv;
  if pg_temp.st(a) <> '2026-10-31 pending' or pg_temp.st(b) <> '2026-11-15 pending' then
    raise exception 'FAIL G: un-paid invoice → % / %', pg_temp.st(a), pg_temp.st(b); end if;
  /* re-reconciled: the receipt is back and the invoice paid */
  update public.payments set status = 'received' where reference = 'R2848-D1' and tenant_id = pg_temp.t();
  update public.invoices set status = 'paid' where id = v_inv;
  if pg_temp.st(a) <> '2027-10-31 renewed' or pg_temp.st(b) <> '2027-11-15 renewed' then
    raise exception 'FAIL G: paid again → % / %', pg_temp.st(a), pg_temp.st(b); end if;
  if pg_temp.moves(b) <> 'forward:2026-11-15>2027-11-15 back:2027-11-15>2026-11-15 forward:2026-11-15>2027-11-15' then
    raise exception 'FAIL G: moves %', pg_temp.moves(b); end if;
  if (select count(*) from public.purchase_orders where subscription_id in (a, b)) <> 2 then
    raise exception 'FAIL G: paid again made another PO'; end if;
  raise notice 'PASS G: un-reconciled (receipt refunded, invoice due) → both back once; re-reconciled → both forward once (no new PO)';
end $$;

-- ── H — part credit note moves nothing; full credit note → both back once ──────────────────────────────────
do $$
declare a uuid := pg_temp.sid(1); b uuid := pg_temp.sid(2); v_q text; v_inv text;
begin
  select quote_id into v_q from public.renewal_quote_subscriptions where subscription_id = a;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select gi.invoice_id into v_inv from public.generate_invoice(v_q) gi;
  perform set_config('request.jwt.claims', '', true);
  if (select status::text from public.invoices where id = v_inv) <> 'paid' then
    raise exception 'FAIL H: invoice after full payment is % (want paid)', (select status from public.invoices where id = v_inv); end if;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform public.issue_credit_note(v_inv, 1000, 'discount', 'R2848 test part CN', null);
  perform set_config('request.jwt.claims', '', true);
  if pg_temp.st(a) <> '2027-10-31 renewed' or pg_temp.st(b) <> '2027-11-15 renewed' then
    raise exception 'FAIL H: part credit note moved % / %', pg_temp.st(a), pg_temp.st(b); end if;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform public.issue_credit_note(v_inv, (select amount from public.invoices where id = v_inv) - 1000, 'cancellation', 'R2848 test full CN', null);
  perform set_config('request.jwt.claims', '', true);
  if pg_temp.st(a) <> '2026-10-31 pending' or pg_temp.st(b) <> '2026-11-15 pending' then
    raise exception 'FAIL H: fully credited → % / %', pg_temp.st(a), pg_temp.st(b); end if;
  if pg_temp.moves(a) <> 'forward:2026-10-31>2027-10-31 back:2027-10-31>2026-10-31' then
    raise exception 'FAIL H: moves %', pg_temp.moves(a); end if;
  raise notice 'PASS H: ₹1,000 credit note moved nothing; crediting the rest moved both back once';
end $$;

-- ── I — a member with a new quote linked is held; the other moves back ─────────────────────────────────────
do $$
declare v_q text; a uuid := pg_temp.sid(7); b uuid := pg_temp.sid(8); v_n int;
begin
  v_q := pg_temp.mk(4, 7, 8);
  perform pg_temp.pay(v_q, 410640, 'R2848-I1');
  insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
  values ('Q-R2848-NEXT', pg_temp.t(), pg_temp.cust(14), 'R2848 next', 1180, 1000, 18, 'sent', 'awaiting', '[]'::jsonb);
  update public.subscriptions set renewal_quote_id = 'Q-R2848-NEXT' where id = b;
  delete from public.payments where reference = 'R2848-I1' and tenant_id = pg_temp.t();
  if pg_temp.st(a) <> '2026-10-31 pending' then raise exception 'FAIL I: free member → %', pg_temp.st(a); end if;
  if pg_temp.st(b) <> '2027-11-15 renewed' then raise exception 'FAIL I: held member moved → %', pg_temp.st(b); end if;
  select count(*) into v_n from public.subscription_renewal_moves
   where subscription_id = b and direction = 'held' and resolved_at is null and hold_kind = 'quote_linked';
  if v_n <> 1 then raise exception 'FAIL I: % open quote_linked holds (want 1): %', v_n, pg_temp.moves(b); end if;
  update public.subscriptions set renewal_quote_id = null where id = b;
  if pg_temp.st(b) <> '2026-11-15 pending' then raise exception 'FAIL I: link cleared, still unpaid → %', pg_temp.st(b); end if;
  if exists (select 1 from public.subscription_renewal_moves where subscription_id = b and direction = 'held' and resolved_at is null) then
    raise exception 'FAIL I: hold still open'; end if;
  raise notice 'PASS I: a member with a next quote linked was held (R-2761), the other moved back; unlinking moved it back';
end $$;

-- ── J — R-2761 re-check never moves a PAID together term ───────────────────────────────────────────────────
do $$
declare v_q text; a uuid := pg_temp.sid(9); b uuid := pg_temp.sid(10);
begin
  v_q := pg_temp.mk(5, 9, 10);
  perform pg_temp.pay(v_q, 410640, 'R2848-J1');
  insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
  values ('Q-R2848-J', pg_temp.t(), pg_temp.cust(15), 'R2848 J', 1180, 1000, 18, 'sent', 'awaiting', '[]'::jsonb);
  update public.subscriptions set renewal_quote_id = 'Q-R2848-J' where id = a;
  update public.subscriptions set renewal_quote_id = null where id = a;   -- subscriptions_r2761_recheck_held
  if public.unroll_unpaid_renewal_terms(a, 'test recheck') <> 0 or pg_temp.st(a) <> '2027-10-31 renewed' then
    raise exception 'FAIL J: a paid together term moved back: % (%)', pg_temp.st(a), pg_temp.moves(a); end if;
  raise notice 'PASS J: R-2761 re-checks leave a paid together renewal alone';
end $$;

-- ── E — cancel lets go of every member; E2 a single renewal quote too (rev-r2847 MED-2) ────────────────────
do $$
declare v_q text; a uuid := pg_temp.sid(11); b uuid := pg_temp.sid(12); c uuid; r jsonb; v_q1 text;
begin
  v_q := pg_temp.mk(6, 11, 12);
  perform public.cancel_quote(v_q, 'R2848 test cancel');
  if exists (select 1 from public.subscriptions where id in (a, b) and renewal_quote_id is not null) then
    raise exception 'FAIL E: a member still linked to the cancelled quote'; end if;
  if exists (select 1 from public.renewal_quote_subscriptions where quote_id = v_q and released_at is null) then
    raise exception 'FAIL E: link rows not released'; end if;
  r := public.create_renewal_quote(a, pg_temp.t(), pg_temp.q('Business Standard', 20, 264000));
  if (r->>'created')::boolean is not true or r->>'quote_id' = v_q then
    raise exception 'FAIL E: create_renewal_quote after the cancel → % (want a new quote)', r; end if;

  c := pg_temp.sub(13, pg_temp.cust(7), 'Business Plus', 5, '2026-12-01');
  r := public.create_renewal_quote(c, pg_temp.t(), pg_temp.q('Business Plus', 5, 90000));
  v_q1 := r->>'quote_id';
  perform public.cancel_quote(v_q1, 'R2848 test cancel single');
  if (select renewal_quote_id from public.subscriptions where id = c) is not null then
    raise exception 'FAIL E2: single renewal quote cancelled, subscription still linked to it'; end if;
  /* E3 — Undo cancel links the subscription back (code review: a reopened quote must never find no subscription) */
  perform public.undo_cancel_quote(v_q1);
  if (select renewal_quote_id from public.subscriptions where id = c) is distinct from v_q1 then
    raise exception 'FAIL E3: undo cancel did not link % back (now %)', v_q1, (select renewal_quote_id from public.subscriptions where id = c); end if;
  raise notice 'PASS E/E2/E3: cancel let go of every member (links released); a single renewal quote too';
end $$;

-- ── F — a closed together quote is never reopened or paid; F2 never activated on credit ────────────────────
do $$
declare v_q text; v_msg text; v_live text;
begin
  select quote_id into v_q from public.renewal_quote_subscriptions where subscription_id = pg_temp.sid(11) and released_at is not null;
  v_msg := pg_temp.try(format('select public.undo_cancel_quote(%L)', v_q));
  if v_msg not like '23514 Quote % renewed several subscriptions together and was closed%' then
    raise exception 'FAIL F: undo cancel → %', v_msg; end if;
  v_msg := pg_temp.try(format('select pg_temp.pay(%L, 410640, %L)', v_q, 'R2848-F1'));
  if v_msg not like 'P0001 Renewal quote % renewed several subscriptions together but was closed%' then
    raise exception 'FAIL F: paying the closed quote → %', v_msg; end if;
  if exists (select 1 from public.payments where reference = 'R2848-F1') then raise exception 'FAIL F: payment stored'; end if;
  v_live := pg_temp.mk(8, 16, 17);
  update public.quotes set status = 'accepted' where id = v_live;
  v_msg := pg_temp.try(format('update public.quotes set credit_activated_at = now() where id = %L', v_live));
  if v_msg not like '23514 Quote % renews several subscriptions together — it cannot be activated on credit%' then
    raise exception 'FAIL F2: activate on credit → %', v_msg; end if;
  raise notice 'PASS F/F2: closed together quote not reopened / not paid; never activated on credit';
end $$;

-- ── P — a member's date moved since the quote → every payment refused ──────────────────────────────────────
do $$
declare v_q text; v_msg text;
begin
  select quote_id into v_q from public.renewal_quote_subscriptions where subscription_id = pg_temp.sid(16);
  update public.subscriptions set renewal_date = '2026-12-31' where id = pg_temp.sid(16);
  v_msg := pg_temp.try(format('select pg_temp.pay(%L, 1000, %L)', v_q, 'R2848-P1'));
  if v_msg not like 'P0001 Renewal quote % renews several subscriptions together, but the renewal date of Business Standard (quoted for the term due 31 Oct 2026, now due 31 Dec 2026) changed%' then
    raise exception 'FAIL P: %', v_msg; end if;
  if exists (select 1 from public.payments where reference = 'R2848-P1') then raise exception 'FAIL P: payment stored'; end if;
  update public.subscriptions set renewal_date = '2026-10-31' where id = pg_temp.sid(16);
  raise notice 'PASS P: moved renewal date → refused, nothing recorded: %', v_msg;
end $$;

-- ── K — a subscription waiting on a live together quote is not deleted ─────────────────────────────────────
do $$
declare v_msg text;
begin
  v_msg := pg_temp.try(format('delete from public.subscriptions where id = %L', pg_temp.sid(17)));
  if v_msg not like '23514 Subscription Business Starter is on renewal quote % (billed together%' then
    raise exception 'FAIL K: delete → %', v_msg; end if;
  raise notice 'PASS K: delete refused while the together quote is live';
end $$;

-- ── L / M — GST rate and line checks (rev-r2847 MED-1, LOW-4) ──────────────────────────────────────────────
do $$
declare v_c uuid; a uuid; b uuid; v_msg text; v_item text := 'R2848-OTHER-ITEM';
begin
  v_c := pg_temp.cust(9);
  a := pg_temp.sub(18, v_c, 'Business Standard', 20, '2026-10-31');
  b := pg_temp.sub(19, v_c, 'Business Starter', 10, '2026-11-15');
  v_msg := pg_temp.try(format('select public.create_renewal_quote_together(%L, %L::jsonb)', pg_temp.t(),
             jsonb_build_array(pg_temp.part(a, pg_temp.q('Business Standard', 20, 264000, 25)),
                               pg_temp.part(b, pg_temp.q('Business Starter', 10, 84000, 25)))));
  if v_msg not like '22023 The renewal of Business Standard has GST at 25% — only 0, 5, 12, 18 or 28% can be on a quote%' then
    raise exception 'FAIL L: together at 25%% → %', v_msg; end if;
  v_msg := pg_temp.try(format('select public.create_renewal_quote(%L, %L, %L::jsonb)', a, pg_temp.t(),
             pg_temp.q('Business Standard', 20, 264000, -18)));
  if v_msg not like '22023 The renewal quote for subscription % has GST at -18%%' then
    raise exception 'FAIL L: single at -18%% → %', v_msg; end if;

  /* qty 0 line (seats still add up) */
  v_msg := pg_temp.try(format('select public.create_renewal_quote_together(%L, %L::jsonb)', pg_temp.t(),
             jsonb_build_array(pg_temp.part(a, pg_temp.q('Business Standard', 20, 264000, 18,
                                 '[{"name":"Business Standard","qty":20,"rate":13200},{"name":"Free","qty":0,"rate":0}]'::jsonb)),
                               pg_temp.part(b, pg_temp.q('Business Starter', 10, 84000)))));
  if v_msg not like '22023 The renewal of Business Standard has a line with no seats, a price below 0%' then
    raise exception 'FAIL M: qty 0 → %', v_msg; end if;
  /* a negative rate (lines still add up to the subtotal) */
  v_msg := pg_temp.try(format('select public.create_renewal_quote_together(%L, %L::jsonb)', pg_temp.t(),
             jsonb_build_array(pg_temp.part(a, pg_temp.q('Business Standard', 20, 264000, 18,
                                 '[{"name":"Business Standard","qty":19,"rate":14000},{"name":"Discount","qty":1,"rate":-2000}]'::jsonb)),
                               pg_temp.part(b, pg_temp.q('Business Starter', 10, 84000)))));
  if v_msg not like '22023 The renewal of Business Standard has a line with no seats, a price below 0%' then
    raise exception 'FAIL M: rate < 0 → %', v_msg; end if;
  /* another company's item */
  insert into public.items (id, tenant_id, name, vendor, msrp, wholesale)
  values (v_item, 'c2848000-0000-0000-0000-0000000000f2', 'Other Co item', 'google', 100, 80);
  v_msg := pg_temp.try(format('select public.create_renewal_quote_together(%L, %L::jsonb)', pg_temp.t(),
             jsonb_build_array(pg_temp.part(a, pg_temp.q('Business Standard', 20, 264000, 18,
                                 jsonb_build_array(jsonb_build_object('name', 'Business Standard', 'qty', 20, 'rate', 13200, 'item_id', v_item)))),
                               pg_temp.part(b, pg_temp.q('Business Starter', 10, 84000)))));
  if v_msg not like '22023 The renewal of Business Standard has a line with no seats, a price below 0 or an item that is not in your Items%' then
    raise exception 'FAIL M: other company''s item → %', v_msg; end if;
  if exists (select 1 from public.quotes where customer_id = v_c) then raise exception 'FAIL L/M: a quote was made'; end if;
  raise notice 'PASS L/M: GST 25%% / -18%%, qty 0, rate < 0 and another company''s item refused';
end $$;

select 'PASS r2848_renewal_together_payment' as result;

rollback;
