\set ON_ERROR_STOP on
-- R-1711: cancelling a subscription must never zero its balance while its GST invoice stays
-- open. "Clear the ₹X still due" may close only the part NO open invoice asks for; the part an
-- open invoice asks for is reduced by a credit note on that invoice (CGST s.34) first.
-- Migration: 20261024023359_r1711_cancel_keeps_invoice_due.
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r1711_cancel_keeps_invoice_due.test.sql
--
-- Expect "PASS r1711_cancel_keeps_invoice_due".
--
--   OPEN      S1 owes ₹18,232 and its own-quote invoice is open for ₹18,232 → clear refused
--             (names the invoice, says credit note); S1 still active, still owes ₹18,232
--   CN        a ₹18,232 cancellation credit note on that invoice → S1 owes 0 at once (R-2178: the
--             note re-syncs the stored balance) → cancel + clear clears 0; the invoice owes 0 — the two agree
--   PARTIAL   S2 owes ₹1,500, its instalment invoice ₹1,000 → clear closes ₹500 only; S2 keeps
--             ₹1,000 and the result names the invoice
--   NO-INV    S3 (postpaid, no invoice) owes ₹956 → clear closes all of it (R-455 unchanged)
--   KEEP      S4 with an open invoice, cancel WITHOUT clear → allowed, balance unchanged
--   WRITTEN   S5's only open invoice is written off → it asks for nothing; clear closes all

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e1711000-0000-4000-8000-0000000000a1', 'r1711-owner@example.test');
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e1711000-0000-0000-0000-0000000000a0', 'R1711 A', 'r1711a@example.in', '07', 'R17A');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1711000-0000-4000-8000-0000000000a1', 'e1711000-0000-0000-0000-0000000000a0', 'r1711-owner@example.in', 'R1711 Owner', 'owner', true);
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e1711000-0000-4000-8000-0000000000c1', 'e1711000-0000-0000-0000-0000000000a0', 'R1711 Leaving Co', '07', 'India');

insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items) values
  ('Q-R17-1', 'e1711000-0000-0000-0000-0000000000a0', null, 'e1711000-0000-4000-8000-0000000000c1', 'R1711 Leaving Co', 18232, 15451, 18, 'accepted', 'invoiced', '[]'::jsonb),
  ('Q-R17-4', 'e1711000-0000-0000-0000-0000000000a0', null, 'e1711000-0000-4000-8000-0000000000c1', 'R1711 Leaving Co',  1180,  1000, 18, 'accepted', 'invoiced', '[]'::jsonb),
  ('Q-R17-5', 'e1711000-0000-0000-0000-0000000000a0', null, 'e1711000-0000-4000-8000-0000000000c1', 'R1711 Leaving Co',   590,   500, 18, 'accepted', 'invoiced', '[]'::jsonb);

insert into public.invoices (id, tenant_id, customer_name, customer_id, amount, net_payable, paid_amount, taxable_value, tax_amount, tax_rate, inter_state, invoice_date, due_date, status, quote_id, written_off_at) values
  ('R17-OWN',  'e1711000-0000-0000-0000-0000000000a0', 'R1711 Leaving Co', 'e1711000-0000-4000-8000-0000000000c1', 18232, 18232, 0, 15451, 2781, 18, false, '2026-10-20', '2026-10-30', 'pending', 'Q-R17-1', null),
  ('R17-INST', 'e1711000-0000-0000-0000-0000000000a0', 'R1711 Leaving Co', 'e1711000-0000-4000-8000-0000000000c1',  1180,  1180, 180,  1000,  180, 18, false, '2026-10-20', '2026-10-30', 'pending', null,      null),
  ('R17-S4',   'e1711000-0000-0000-0000-0000000000a0', 'R1711 Leaving Co', 'e1711000-0000-4000-8000-0000000000c1',  1180,  1180,   0,  1000,  180, 18, false, '2026-10-20', '2026-10-30', 'overdue', 'Q-R17-4', null),
  ('R17-WO',   'e1711000-0000-0000-0000-0000000000a0', 'R1711 Leaving Co', 'e1711000-0000-4000-8000-0000000000c1',   590,   590,   0,   500,   90, 18, false, '2026-10-20', '2026-10-30', 'pending', 'Q-R17-5', now());

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, quote_id, outstanding_amount, start_date, renewal_date) values
  ('e1711000-0000-4000-8000-0000000000d1', 'e1711000-0000-0000-0000-0000000000a0', 'e1711000-0000-4000-8000-0000000000c1', 'R1711 Leaving Co', 'Business Plus',    'google', 10, 1288, 'active', 'Q-R17-1', 18232, '2026-10-01', '2027-09-30'),
  ('e1711000-0000-4000-8000-0000000000d2', 'e1711000-0000-0000-0000-0000000000a0', 'e1711000-0000-4000-8000-0000000000c1', 'R1711 Leaving Co', 'Business Starter', 'google',  1,  125, 'active', null,      1500,  '2026-10-01', '2027-09-30'),
  ('e1711000-0000-4000-8000-0000000000d3', 'e1711000-0000-0000-0000-0000000000a0', 'e1711000-0000-4000-8000-0000000000c1', 'R1711 Leaving Co', 'Vault',            'google',  1,  956, 'active', null,       956,  '2026-10-01', '2026-10-31'),
  ('e1711000-0000-4000-8000-0000000000d4', 'e1711000-0000-0000-0000-0000000000a0', 'e1711000-0000-4000-8000-0000000000c1', 'R1711 Leaving Co', 'Archiving',        'google',  1,  100, 'active', 'Q-R17-4',  1180,  '2026-10-01', '2027-09-30'),
  ('e1711000-0000-4000-8000-0000000000d5', 'e1711000-0000-0000-0000-0000000000a0', 'e1711000-0000-4000-8000-0000000000c1', 'R1711 Leaving Co', 'Voice',            'google',  1,   50, 'active', 'Q-R17-5',   590,  '2026-10-01', '2027-09-30');
insert into public.subscription_billings (tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, tax_rate, invoice_id) values
  ('e1711000-0000-0000-0000-0000000000a0', 'e1711000-0000-4000-8000-0000000000d2', '2026-10-01', 1, '2026-10-01', '2026-10-01', '2026-10-31', 1000, 18, 'R17-INST');

create temp table r1711_fail (msg text) on commit drop;
grant all on r1711_fail to authenticated;

create function pg_temp.r1711_try(p_sub uuid, p_clear boolean) returns text language plpgsql as $$
begin
  perform public.cancel_subscription(p_sub, '2026-10-24', 'Customer moved to another provider', p_clear);
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
grant execute on function pg_temp.r1711_try(uuid, boolean) to authenticated;

do $$
declare
  d1 constant uuid := 'e1711000-0000-4000-8000-0000000000d1';
  d2 constant uuid := 'e1711000-0000-4000-8000-0000000000d2';
  d3 constant uuid := 'e1711000-0000-4000-8000-0000000000d3';
  d4 constant uuid := 'e1711000-0000-4000-8000-0000000000d4';
  d5 constant uuid := 'e1711000-0000-4000-8000-0000000000d5';
  v_e text; v_r jsonb; v_s record; v_n int;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'e1711000-0000-4000-8000-0000000000a1', 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- ════ OPEN ════════════════════════════════════════════════════════════════════════
  v_e := pg_temp.r1711_try(d1, true);
  if v_e is null or v_e not like '22023:%R17-OWN%credit note%' then
    insert into r1711_fail values ('clear with an open invoice not refused: ' || coalesce(v_e, 'ran'));
  end if;
  select status::text as status, outstanding_amount into v_s from public.subscriptions where id = d1;
  if v_s.status <> 'active' or v_s.outstanding_amount <> 18232 then
    insert into r1711_fail values ('S1 changed by a refused cancel: ' || row_to_json(v_s)::text);
  end if;

  -- ════ CN ══════════════════════════════════════════════════════════════════════════
  begin
    perform public.issue_credit_note('R17-OWN', 18232, 'cancellation', 'Unused part — customer left', null);
    -- R-2178: the credit note itself brings S1's stored balance to what the invoice owes (0),
    -- as a receipt would; cancel then has nothing left to clear.
    if (select outstanding_amount from public.subscriptions where id = d1) <> 0 then
      insert into r1711_fail values ('S1 still owes after a full credit note (R-2178): ' || (select outstanding_amount from public.subscriptions where id = d1));
    end if;
    v_r := public.cancel_subscription(d1, '2026-10-24', 'Customer moved to another provider', true);
    if (v_r->>'due_cleared')::int <> 0 or coalesce((v_r->>'due_kept')::int, -1) <> 0 then
      insert into r1711_fail values ('S1 after credit note result wrong: ' || v_r::text);
    end if;
  exception when others then insert into r1711_fail values ('S1 credit note + cancel raised: ' || sqlerrm);
  end;
  select s.status::text as status, s.outstanding_amount, s.cancel_due_cleared,
         greatest(0, coalesce(i.net_payable, i.amount) - coalesce(i.paid_amount, 0)) as inv_due
    into v_s from public.subscriptions s, public.invoices i where s.id = d1 and i.id = 'R17-OWN';
  if v_s.status <> 'cancelled' or v_s.outstanding_amount <> 0 or coalesce(v_s.cancel_due_cleared, 0) <> 0 or v_s.inv_due <> 0 then
    insert into r1711_fail values ('S1 balance and invoice disagree: ' || row_to_json(v_s)::text);
  end if;

  -- ════ PARTIAL ═════════════════════════════════════════════════════════════════════
  begin
    v_r := public.cancel_subscription(d2, '2026-10-24', 'Customer moved to another provider', true);
    if (v_r->>'due_cleared')::int <> 500 or (v_r->>'due_kept')::int <> 1000
       or v_r->'open_invoices' is distinct from '["R17-INST"]'::jsonb then
      insert into r1711_fail values ('S2 partial result wrong: ' || v_r::text);
    end if;
  exception when others then insert into r1711_fail values ('S2 cancel raised: ' || sqlerrm);
  end;
  select outstanding_amount, cancel_due_cleared into v_s from public.subscriptions where id = d2;
  if v_s.outstanding_amount <> 1000 or v_s.cancel_due_cleared <> 500 then
    insert into r1711_fail values ('S2 should keep ₹1,000 (the open invoice): ' || row_to_json(v_s)::text);
  end if;

  -- ════ NO-INV ══════════════════════════════════════════════════════════════════════
  begin
    v_r := public.cancel_subscription(d3, '2026-10-24', 'Refunded, customer left', true);
    if (v_r->>'due_cleared')::int <> 956 then
      insert into r1711_fail values ('S3 (no invoice) not cleared: ' || v_r::text);
    end if;
  exception when others then insert into r1711_fail values ('S3 cancel raised: ' || sqlerrm);
  end;

  -- ════ KEEP ════════════════════════════════════════════════════════════════════════
  v_e := pg_temp.r1711_try(d4, false);
  if v_e is not null then insert into r1711_fail values ('S4 cancel without clear refused: ' || v_e); end if;
  select status::text as status, outstanding_amount into v_s from public.subscriptions where id = d4;
  if v_s.status <> 'cancelled' or v_s.outstanding_amount <> 1180 then
    insert into r1711_fail values ('S4 wrong: ' || row_to_json(v_s)::text);
  end if;

  -- ════ WRITTEN ═════════════════════════════════════════════════════════════════════
  begin
    v_r := public.cancel_subscription(d5, '2026-10-24', 'Customer moved to another provider', true);
    if (v_r->>'due_cleared')::int <> 590 then
      insert into r1711_fail values ('S5 (invoice written off) not cleared: ' || v_r::text);
    end if;
  exception when others then insert into r1711_fail values ('S5 cancel raised: ' || sqlerrm);
  end;

  set local role postgres;
  select count(*) into v_n from r1711_fail;
  if v_n > 0 then
    raise exception 'FAIL r1711_cancel_keeps_invoice_due: %', (select string_agg(msg, E'\n') from r1711_fail);
  end if;
  raise notice 'PASS r1711_cancel_keeps_invoice_due';
end $$;

rollback;
