-- R-2416 (3 Nov 2026, p1): the online payment fee policy — who pays Razorpay's fee on a bill.
-- Pardeep: the customer pays the fee by default, but for some customers / bills we absorb it.
-- Migration: 20261103112829_r2416_online_fee_policy.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Proves:
--   A. A tenant starts at "Customer pays, 2%, no threshold"; bad values are refused.
--   B. Customer "We absorb": needs a reason; sales is refused (message names who can);
--      an accountant may set it; back to Default clears it.
--   C. Bill waiver on a quote / invoice: owner or manager only (accountant and sales refused);
--      a waiver without a reason is refused.
--   D. payments.fee_bearer / fee_charged: an old row stays NULL; a captured payment can store
--      who bore the fee (the webhook's write, as the service role); bad values are refused.

begin;

create function pg_temp.r2416_fill_supplier() returns trigger language plpgsql as $f$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street');
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := '07AAACT1643F1Z5';
  end if;
  return new;
end $f$;
create trigger zz_r2416_supplier before insert on public.tenants for each row execute function pg_temp.r2416_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000241601','R2416 Co','r2416@example.in','07','R2416');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000241601','owner2416@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000241602','mgr2416@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000241603','acct2416@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000241604','sales2416@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000241601','dddddddd-0000-0000-0000-000000241601','owner2416@example.in','Owner 2416','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000241602','dddddddd-0000-0000-0000-000000241601','mgr2416@example.in','Manager 2416','manager', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000241603','dddddddd-0000-0000-0000-000000241601','acct2416@example.in','Accountant 2416','accountant', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000241604','dddddddd-0000-0000-0000-000000241601','sales2416@example.in','Sales 2416','sales', now() - interval '1 day');
insert into public.customers (id, tenant_id, name) values
  ('cccccccc-0000-0000-0000-000000241601','dddddddd-0000-0000-0000-000000241601','R2416 Key Account');
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount) values
  ('R2416-Q1','dddddddd-0000-0000-0000-000000241601','cccccccc-0000-0000-0000-000000241601','R2416 Key Account', 11800);
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, net_payable, taxable_value, tax_amount, tax_rate, status, invoice_date) values
  ('R2416-INV1','dddddddd-0000-0000-0000-000000241601','cccccccc-0000-0000-0000-000000241601','R2416 Key Account', 11800, 11800, 10000, 1800, 18, 'pending', '2026-11-03');
insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, reference, status, received_at) values
  ('eeeeeeee-0000-0000-0000-000000241601','dddddddd-0000-0000-0000-000000241601','R2416-Q1','cccccccc-0000-0000-0000-000000241601', 11800, 'razorpay', 'pay_R2416A', 'received', now());

-- ── A. Company defaults + bad values ───────────────────────────────────────────────────────────
do $$
declare t public.tenants;
begin
  select * into t from public.tenants where id = 'dddddddd-0000-0000-0000-000000241601';
  if t.online_fee_bearer <> 'customer' or t.online_fee_rate_pct <> 2 or t.online_fee_waive_above is not null then
    raise exception 'FAIL A1: defaults should be customer / 2%% / no threshold, got % / % / %',
      t.online_fee_bearer, t.online_fee_rate_pct, t.online_fee_waive_above;
  end if;
  begin
    update public.tenants set online_fee_rate_pct = 0 where id = t.id;
    raise exception 'FAIL A2: a 0%% rate was accepted';
  exception when check_violation then null;
  end;
  begin
    update public.tenants set online_fee_bearer = 'bank' where id = t.id;
    raise exception 'FAIL A3: bearer "bank" was accepted';
  exception when check_violation then null;
  end;
  update public.tenants set online_fee_bearer = 'business', online_fee_rate_pct = 2.15, online_fee_waive_above = 100000 where id = t.id;
  select * into t from public.tenants where id = t.id;
  if t.online_fee_rate_pct <> 2.15 or t.online_fee_bearer <> 'business' or t.online_fee_waive_above <> 100000 then
    raise exception 'FAIL A4: settings not saved';
  end if;
end $$;

-- ── B. Customer "We absorb for this customer" ──────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000241604","role":"authenticated"}', true);
do $$
declare msg text;
begin
  begin
    update public.customers set online_fee_override = 'absorb', online_fee_override_reason = 'Big client'
     where id = 'cccccccc-0000-0000-0000-000000241601';
    raise exception 'FAIL B1: sales set the customer fee override';
  exception when insufficient_privilege then
    get stacked diagnostics msg = message_text;
    if msg not like 'Only an owner, manager or accountant can change who pays the online fee%' then
      raise exception 'FAIL B1: wrong message: %', msg;
    end if;
  end;
end $$;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000241603","role":"authenticated"}', true);
do $$
declare c public.customers;
begin
  begin
    update public.customers set online_fee_override = 'absorb', online_fee_override_reason = ' '
     where id = 'cccccccc-0000-0000-0000-000000241601';
    raise exception 'FAIL B2: absorb without a reason was accepted';
  exception when check_violation then null;
  end;
  update public.customers set online_fee_override = 'absorb', online_fee_override_reason = 'Key account since 2019'
   where id = 'cccccccc-0000-0000-0000-000000241601';
  select * into c from public.customers where id = 'cccccccc-0000-0000-0000-000000241601';
  if c.online_fee_override is distinct from 'absorb' or c.online_fee_override_reason is distinct from 'Key account since 2019' then
    raise exception 'FAIL B3: accountant could not set absorb';
  end if;
  update public.customers set online_fee_override = null, online_fee_override_reason = null
   where id = 'cccccccc-0000-0000-0000-000000241601';
  select * into c from public.customers where id = 'cccccccc-0000-0000-0000-000000241601';
  if c.online_fee_override is not null then raise exception 'FAIL B4: Default did not clear the override'; end if;
  -- Other customer edits by any role still work (the guard only watches the fee columns).
end $$;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000241604","role":"authenticated"}', true);
do $$
begin
  update public.customers set name = 'R2416 Key Account Ltd' where id = 'cccccccc-0000-0000-0000-000000241601';
  if not exists (select 1 from public.customers where id = 'cccccccc-0000-0000-0000-000000241601' and name = 'R2416 Key Account Ltd') then
    raise exception 'FAIL B5: an ordinary customer edit by sales was blocked';
  end if;
end $$;

-- ── C. Waive online fee for this bill ──────────────────────────────────────────────────────────
do $$
declare msg text;
begin
  begin
    update public.quotes set online_fee_waived = true, online_fee_waive_reason = 'Promised on call' where id = 'R2416-Q1';
    raise exception 'FAIL C1: sales waived the fee on a quote';
  exception when insufficient_privilege then
    get stacked diagnostics msg = message_text;
    if msg not like 'Only an owner or manager can waive the online fee on a bill%' then
      raise exception 'FAIL C1: wrong message: %', msg;
    end if;
  end;
end $$;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000241603","role":"authenticated"}', true);
do $$
begin
  begin
    update public.invoices set online_fee_waived = true, online_fee_waive_reason = 'Promised on call' where id = 'R2416-INV1';
    raise exception 'FAIL C2: an accountant waived the fee on an invoice';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000241602","role":"authenticated"}', true);
do $$
begin
  begin
    update public.quotes set online_fee_waived = true, online_fee_waive_reason = null where id = 'R2416-Q1';
    raise exception 'FAIL C3: a waiver without a reason was accepted';
  exception when check_violation then null;
  end;
  update public.quotes   set online_fee_waived = true, online_fee_waive_reason = 'Promised on call' where id = 'R2416-Q1';
  update public.invoices set online_fee_waived = true, online_fee_waive_reason = 'Promised on call' where id = 'R2416-INV1';
  if not exists (select 1 from public.quotes where id = 'R2416-Q1' and online_fee_waived and online_fee_waive_reason = 'Promised on call')
     or not exists (select 1 from public.invoices where id = 'R2416-INV1' and online_fee_waived) then
    raise exception 'FAIL C4: manager could not waive the fee';
  end if;
end $$;

-- ── D. Who bore the fee on a payment ───────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare p public.payments;
begin
  select * into p from public.payments where id = 'eeeeeeee-0000-0000-0000-000000241601';
  if p.fee_bearer is not null or p.fee_charged is not null then
    raise exception 'FAIL D1: a payment without a policy decision should stay NULL';
  end if;
  update public.payments set fee_bearer = 'business', fee_charged = 0
   where id = p.id and fee_bearer is null;
  select * into p from public.payments where id = p.id;
  if p.fee_bearer is distinct from 'business' or p.fee_charged is distinct from 0 then
    raise exception 'FAIL D2: fee_bearer / fee_charged not stored';
  end if;
  begin
    update public.payments set fee_bearer = 'razorpay' where id = p.id;
    raise exception 'FAIL D3: fee_bearer "razorpay" was accepted';
  exception when check_violation then null;
  end;
  begin
    update public.payments set fee_charged = -1 where id = p.id;
    raise exception 'FAIL D4: a negative fee_charged was accepted';
  exception when check_violation then null;
  end;
  -- The service role (webhook) may write a bill waiver too — a trusted call passes the guard.
  update public.quotes set online_fee_waived = false, online_fee_waive_reason = null where id = 'R2416-Q1';
end $$;

select 'R-2416 online fee policy: all assertions passed' as result;

rollback;
