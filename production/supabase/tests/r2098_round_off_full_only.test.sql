-- R-2098 follow-up (29 Oct 2026, coordinator for Pardeep): the ≤ ₹50 round-off on a multi-item bank
-- credit is allowed ONLY when, after it, EVERY ticked item (and a new sale) is settled in full. If
-- any item stays part-paid there is no write-off — the short amount simply stays due on that item.
-- Migration 20261029135500_r2098_round_off_full_only (replaces reconcile_bank_credit_split).
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Proves:
--   P1. A full + B part, ₹40 short, "round-off" → refused (check_violation), nothing written.
--       (Old function: accepted, wrote a ₹40 round-off while B stayed part-paid.)
--   P2. A full + B part, ₹10 extra, "round-off" → refused (put it on B or keep it as advance).
--   P3. A full + B part, exact → saved; B stays part-due (₹770), no round-off row.
--   P4. A part + a NEW SALE (part), ₹20 short, "round-off" → refused.
--   F.  C + D both in full, ₹20 short, "round-off" → allowed (round_off 20, both paid).

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
  ('dddddddd-0000-0000-0000-000000209811','R2098R Co','r2098r@example.in','07','R2098R');
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000209811','owner2098r@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000209811','dddddddd-0000-0000-0000-000000209811','owner2098r@example.in','Owner 2098R','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000209811','dddddddd-0000-0000-0000-000000209811','Acme 2098R','07','acme2098r.in');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000209811','dddddddd-0000-0000-0000-000000209811','HDFC Current','HDFC');

-- A 590, B 1,180, C 590, D 1,180, E 590 (all invoiced, one-off).
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items, is_one_off, created_date)
select v.id, 'dddddddd-0000-0000-0000-000000209811', 'cccccccc-0000-0000-0000-000000209811', 'Acme 2098R',
       round(v.sub * 1.18)::int, v.sub, 0, 18, 'accepted', 'awaiting', 'yearly',
       jsonb_build_array(jsonb_build_object('name', 'Service ' || v.id, 'qty', 1, 'rate', v.sub, 'one_time', true)),
       true, '2026-10-10'
  from (values ('Q-RA', 500), ('Q-RB', 1000), ('Q-RC', 500), ('Q-RD', 1000), ('Q-RE', 500)) as v(id, sub);

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000209811','dddddddd-0000-0000-0000-000000209811','bbbbbbbb-0000-0000-0000-000000209811','2026-10-24','NEFT ACME 2098R PART',0,1000,'UTR2098R1','manual'),
  ('11111111-0000-0000-0000-000000209812','dddddddd-0000-0000-0000-000000209811','bbbbbbbb-0000-0000-0000-000000209811','2026-10-24','NEFT ACME 2098R FULL',0,1750,'UTR2098R2','manual'),
  ('11111111-0000-0000-0000-000000209813','dddddddd-0000-0000-0000-000000209811','bbbbbbbb-0000-0000-0000-000000209811','2026-10-24','NEFT ACME 2098R SALE',0,1000,'UTR2098R3','manual');

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000209811","role":"authenticated"}', true);
select public.generate_invoice(q) from unnest(array['Q-RA','Q-RB','Q-RC','Q-RD','Q-RE']) q;

create function pg_temp.inv(p_quote text) returns text language sql as $f$ select invoice_id from public.quotes where id = p_quote $f$;
create function pg_temp.two(a text, a_amt int, b text, b_amt int) returns jsonb language sql as $f$
  select jsonb_build_array(jsonb_build_object('invoice_id', pg_temp.inv(a), 'amount', a_amt),
                           jsonb_build_object('invoice_id', pg_temp.inv(b), 'amount', b_amt)) $f$;
create function pg_temp.nothing_written() returns boolean language sql as $f$
  select not exists (select 1 from public.payments where tenant_id = 'dddddddd-0000-0000-0000-000000209811')
     and not exists (select 1 from public.bank_receipt_round_offs where tenant_id = 'dddddddd-0000-0000-0000-000000209811')
     and (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000209811') is null $f$;

-- ── P1. part item + ₹40 short + round-off → refused ─────────────────────────────────────────
do $$
begin
  begin
    perform public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000209811', 'cccccccc-0000-0000-0000-000000209811',
              pg_temp.two('Q-RA', 590, 'Q-RB', 450), null, 'round_off');
    raise exception 'FAIL P1: round-off accepted while % stays part-paid', pg_temp.inv('Q-RB');
  exception when check_violation then
    if sqlerrm not like '%' || pg_temp.inv('Q-RB') || '%paid in part%' then raise exception 'FAIL P1: wrong message %', sqlerrm; end if;
  end;
  if not pg_temp.nothing_written() then raise exception 'FAIL P1: something was written'; end if;
  raise notice 'PASS P1: part-paid item + ₹40 short → no round-off, refused, nothing written';
end $$;

-- ── P2. part item + ₹10 extra + round-off → refused ────────────────────────────────────────
do $$
begin
  begin
    perform public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000209811', 'cccccccc-0000-0000-0000-000000209811',
              pg_temp.two('Q-RA', 590, 'Q-RB', 400), null, 'round_off');
    raise exception 'FAIL P2: round-off gain accepted while % stays part-paid', pg_temp.inv('Q-RB');
  exception when check_violation then
    if sqlerrm not like '%paid in part%' then raise exception 'FAIL P2: wrong message %', sqlerrm; end if;
  end;
  if not pg_temp.nothing_written() then raise exception 'FAIL P2: something was written'; end if;
  raise notice 'PASS P2: part-paid item + ₹10 extra → no round-off gain, refused';
end $$;

-- ── P3. part item, exact → saved, B stays part-due ─────────────────────────────────────────
do $$
declare r jsonb; v_b record;
begin
  r := public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000209811', 'cccccccc-0000-0000-0000-000000209811',
         pg_temp.two('Q-RA', 590, 'Q-RB', 410), null, null);
  if (r->>'round_off')::int <> 0 then raise exception 'FAIL P3: result %', r; end if;
  if (select status from public.invoices where id = pg_temp.inv('Q-RA')) <> 'paid' then raise exception 'FAIL P3: A not paid'; end if;
  select * into v_b from public.invoices where id = pg_temp.inv('Q-RB');
  if v_b.status = 'paid' or coalesce(v_b.paid_amount, 0) <> 410 then
    raise exception 'FAIL P3: B status % paid %', v_b.status, v_b.paid_amount; end if;
  if exists (select 1 from public.bank_receipt_round_offs where bank_txn_id = '11111111-0000-0000-0000-000000209811') then
    raise exception 'FAIL P3: a round-off row on an exact line'; end if;
  raise notice 'PASS P3: A paid, B part-paid ₹410 (₹770 still due), no round-off';
end $$;

-- ── P4. part item + part NEW SALE + ₹20 short + round-off → refused ───────────────────────
do $$
begin
  begin
    perform public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000209813', 'cccccccc-0000-0000-0000-000000209811',
              jsonb_build_array(jsonb_build_object('invoice_id', pg_temp.inv('Q-RE'), 'amount', 590)),
              '{"lines":[{"name":"Setup","qty":1,"rate":5000,"commitment":"one_time"}],"amount":430}'::jsonb, 'round_off');
    raise exception 'FAIL P4: round-off accepted while the new sale stays part-paid';
  exception when check_violation then
    if sqlerrm not like '%new sale%paid in part%' then raise exception 'FAIL P4: wrong message %', sqlerrm; end if;
  end;
  if exists (select 1 from public.payments where bank_txn_id = '11111111-0000-0000-0000-000000209813')
     or (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000209813') is not null then
    raise exception 'FAIL P4: something was written'; end if;
  raise notice 'PASS P4: part-paid new sale + ₹20 short → no round-off, refused';
end $$;

-- ── F. every item in full, ₹20 short → round-off allowed ───────────────────────────────────
do $$
declare r jsonb; n int;
begin
  r := public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000209812', 'cccccccc-0000-0000-0000-000000209811',
         pg_temp.two('Q-RC', 590, 'Q-RD', 1180), null, 'round_off');
  if (r->>'round_off')::int <> 20 then raise exception 'FAIL F: result %', r; end if;
  select count(*) into n from public.invoices where id in (pg_temp.inv('Q-RC'), pg_temp.inv('Q-RD')) and status = 'paid';
  if n <> 2 then raise exception 'FAIL F: % of 2 invoices paid', n; end if;
  if (select sum(amount) from public.bank_receipt_round_offs where bank_txn_id = '11111111-0000-0000-0000-000000209812') <> 20 then
    raise exception 'FAIL F: round-off row missing'; end if;
  raise notice 'PASS F: both items in full, ₹20 short written off';
end $$;

select 'R-2098 round-off only when every item is settled: ALL PASS' as result;

rollback;
