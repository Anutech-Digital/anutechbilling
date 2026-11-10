-- R-2519c (re-review v14 small follow-ups, 6 Nov 2026). Migration 2026110609xxxx_r2519c_proforma_small_fixes.
-- Self-asserting, ONE transaction, rolled back. Run on a dev/test DB only.
--
--   D. A part request (or a cancelled one) is never DELETED by a signed-in user — only cancelled.
--      An ordinary quote still deletes.
--   S3. Monthly Flexible (BITDECENTRO: the wrong Oct proforma Q-A378-27-0947 while the Nov row is laid):
--       the LATEST REQUESTED period's proforma CAN be cancelled though a later row is laid (unrequested);
--       freed_parts_due lists the freed Oct row (earliest first) so the billing job bills it again first.
--       (R-2519d, coordinator — replaces R-2519c's refusal.)
--   G. The guard does not trust a forged JWT role claim: a direct client login claiming service_role
--      still cannot write the guarded columns.
--   R. A payment on a CANCELLED quote is refused with "Undo cancel" (not "Reopen").

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
  ('dddddddd-0000-0000-0000-000000251961','R2519C Co','r2519c@example.in','07','RC61');
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000251961','owner2519c@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000251961','dddddddd-0000-0000-0000-000000251961','owner2519c@example.in','Owner 2519c','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('cccccccc-0000-0000-0000-000000251961','dddddddd-0000-0000-0000-000000251961','Bit 2519c','27','India');

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                                  billing_cycle, term_months, start_date, renewal_date, status, domain)
select ('eeeeeeee-0000-0000-0000-00000025196' || n)::uuid, 'dddddddd-0000-0000-0000-000000251961', 'cccccccc-0000-0000-0000-000000251961',
       'Bit 2519c', 'Google Workspace Business Starter', 'google'::vendor, 17, 5100, 'monthly'::billing_cycle, 1,
       public.ist_today() - 65, public.ist_today() + 25, 'active', 'c' || n || '.in'
  from generate_series(1, 2) n;
insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                          period_start, period_end, taxable_amount, tax_rate) values
  -- 1: one current part (D, R)
  ('bbbbbbbb-0000-0000-0000-000000251961', 'dddddddd-0000-0000-0000-000000251961', 'eeeeeeee-0000-0000-0000-000000251961',
   public.ist_today() - 5, 1, public.ist_today() - 5, public.ist_today() - 5, public.ist_today() + 25, 5100, 18),
  -- 2: S3 — term A (earlier, billed) and term B (laid, NOT requested)
  ('bbbbbbbb-0000-0000-0000-00000025196a', 'dddddddd-0000-0000-0000-000000251961', 'eeeeeeee-0000-0000-0000-000000251962',
   public.ist_today() - 35, 1, public.ist_today() - 35, public.ist_today() - 35, public.ist_today() - 5, 5100, 18),
  ('bbbbbbbb-0000-0000-0000-00000025196b', 'dddddddd-0000-0000-0000-000000251961', 'eeeeeeee-0000-0000-0000-000000251962',
   public.ist_today() - 5, 1, public.ist_today() - 5, public.ist_today() - 5, public.ist_today() + 25, 5100, 18);
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
values ('TESTQ-R2519C-SALE', 'dddddddd-0000-0000-0000-000000251961', 'cccccccc-0000-0000-0000-000000251961', 'Bit 2519c',
        1180, 1000, 18, 'sent', 'awaiting', '[{"name":"Setup","qty":1,"rate":1000}]'::jsonb);

create temp table r2519c_ids(k text primary key, id text) on commit drop;
grant select on r2519c_ids to authenticated;

do $$
declare r jsonb; v_c text;
begin
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-000000251961', false);
  insert into r2519c_ids values ('open', r->>'quote_id');
  -- S3: Oct (A) billed; Nov (B) laid, not requested → cancelling Oct is allowed …
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-00000025196a', false);
  perform public.cancel_quote(r->>'quote_id', 'Wrong seats on the Oct proforma');
  -- … and the freed Oct row is due for billing again, before Nov
  if (select array_agg(billing_id order by period_start) from public.freed_parts_due(public.ist_today()) f
       where f.subscription_id = 'eeeeeeee-0000-0000-0000-000000251962') is distinct from array['bbbbbbbb-0000-0000-0000-00000025196a'::uuid] then
    raise exception 'S3 FAIL: freed_parts_due does not list the freed Oct row: %',
      (select array_agg(billing_id) from public.freed_parts_due(public.ist_today()) f where f.subscription_id = 'eeeeeeee-0000-0000-0000-000000251962'); end if;
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-00000025196a', false);
  if r->>'action' <> 'request' then raise exception 'S3 FAIL: Oct not billed again: %', r; end if;
  if exists (select 1 from public.freed_parts_due(public.ist_today()) f where f.subscription_id = 'eeeeeeee-0000-0000-0000-000000251962') then
    raise exception 'S3 FAIL: Oct still listed after it was billed'; end if;
  -- with Nov now requested, the Oct proforma (earlier) cannot be freed again
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-00000025196b', false);
  begin
    perform public.cancel_quote((select id from public.quotes where subscription_billing_id = 'bbbbbbbb-0000-0000-0000-00000025196a'), 'Oct again, Nov requested');
    raise exception 'S3 FAIL: freed Oct while Nov has a proforma';
  exception when invalid_parameter_value then null; end;
  raise notice 'S3 PASS: Oct cancelled while Nov laid → listed first → billed again; refused once Nov is requested';
  -- R: a cancelled proforma refuses a payment with the Undo cancel words
  select q.id into v_c from public.quotes q where q.subscription_billing_id = 'bbbbbbbb-0000-0000-0000-000000251961';
  perform public.cancel_quote(v_c, 'For the payment message');
  insert into r2519c_ids values ('cancelled', v_c);
  begin
    perform public.record_payment(v_c, 6018, 'upi', 'R2519C-PAY');
    raise exception 'R FAIL: a cancelled proforma took a payment';
  exception when check_violation then
    if sqlerrm not like '%Undo cancel%' or sqlerrm like '%Reopen%' then raise exception 'R FAIL: message %', sqlerrm; end if;
    raise notice 'R PASS: %', sqlerrm;
  end;
end $$;

-- D + G as the OWNER (a direct client login)
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000251961","role":"authenticated"}', true);
set local role authenticated;
do $$
declare n int;
begin
  begin
    delete from public.quotes where id = (select id from r2519c_ids where k = 'cancelled');
    get diagnostics n = row_count;
    if n > 0 then raise exception 'D FAIL: deleted a cancelled proforma'; end if;
    raise exception 'D FAIL: delete of a cancelled proforma was not refused (0 rows, no error)';
  exception when invalid_parameter_value then raise notice 'D PASS (cancelled proforma): %', sqlerrm; end;
  delete from public.quotes where id = 'TESTQ-R2519C-SALE';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'D FAIL: an ordinary quote no longer deletes (% rows)', n; end if;
  raise notice 'D PASS: an ordinary quote still deletes';
end $$;
reset role;
-- G: a forged role claim on a direct client login
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000251961","role":"service_role"}', true);
set local role authenticated;
do $$
begin
  begin
    update public.quotes set proforma_seats = 1, proforma_seat_rate = 1 where id = (select id from r2519c_ids where k = 'open');
    raise exception 'G FAIL: a forged service_role claim wrote the guarded columns';
  exception when insufficient_privilege then raise notice 'G PASS: %', sqlerrm; end;
end $$;
reset role;

select 'R-2519c proforma small fixes: ALL PASS' as result;

rollback;
