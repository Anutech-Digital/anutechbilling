-- R-2026 (28 Oct 2026): Reconcile → "A new sale" asks Commitment first, then Payment — the quote
-- builder's pair (line commitment + quote billing_cycle). reconcile_bank_credit_new_sale takes the
-- chosen cycle; the rest is the existing split-billing path.
-- Migration 20261028020622_r2026_new_sale_billing_cycle.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Proves:
--   A. Annual commitment + Quarterly, 10 seats × ₹1,632/yr (₹136/user/month): the bank paid the
--      first quarter (₹4,080 + 18% = ₹4,814) → quote billing_cycle quarterly, total for the year
--      ₹19,258; ONE subscription, billing_cycle quarterly, renews in 12 months (the commitment);
--      no whole-year tax invoice; the subscription owes nothing today (only Q1 has fallen due).
--   B. Monthly flex asked to bill quarterly → refused (check_violation), nothing written.
--   C. Monthly flex with no cycle → quote monthly, subscription monthly, renews in 1 month.
--   D. An unknown cycle → refused (22023).
--   E. No cycle on an annual sale → yearly (the old behaviour).

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
  ('dddddddd-0000-0000-0000-000000202601','R2026 Co','r2026@example.in','07','R2026');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000202601','owner2026@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000202601','dddddddd-0000-0000-0000-000000202601','owner2026@example.in','Owner 2026','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000202601','dddddddd-0000-0000-0000-000000202601','Acme 2026','07','acme2026.in');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000202601','dddddddd-0000-0000-0000-000000202601','HDFC Current','HDFC');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000202601','dddddddd-0000-0000-0000-000000202601','bbbbbbbb-0000-0000-0000-000000202601','2026-10-21','NEFT ACME 2026 Q1',0,4814,'UTR2026A','manual'),
  ('11111111-0000-0000-0000-000000202602','dddddddd-0000-0000-0000-000000202601','bbbbbbbb-0000-0000-0000-000000202601','2026-10-21','NEFT ACME 2026 FLEX',0,1888,'UTR2026B','manual'),
  ('11111111-0000-0000-0000-000000202603','dddddddd-0000-0000-0000-000000202601','bbbbbbbb-0000-0000-0000-000000202601','2026-10-21','NEFT ACME 2026 FLEX2',0,1888,'UTR2026C','manual'),
  ('11111111-0000-0000-0000-000000202604','dddddddd-0000-0000-0000-000000202601','bbbbbbbb-0000-0000-0000-000000202601','2026-10-21','NEFT ACME 2026 YEAR',0,11800,'UTR2026D','manual');

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000202601","role":"authenticated"}', true);

-- A. Annual commitment, billed quarterly; the bank paid the first quarter.
do $$
declare r jsonb; q record; s record; n int;
begin
  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000202601', 'cccccccc-0000-0000-0000-000000202601',
         '[{"item_id":null,"name":"Google Workspace Business Starter","qty":10,"rate":1632,"cost":1400,"commitment":"annual_yearly"}]'::jsonb,
         true, '2026-10-21', null, 0, null, null, 'quarterly');
  select * into q from public.quotes where id = r->>'quote_id';
  if q.billing_cycle is distinct from 'quarterly' or q.subtotal is distinct from 16320 or q.amount is distinct from 19258 or q.is_one_off then
    raise exception 'FAIL A: quote cycle % subtotal % amount % one-off %', q.billing_cycle, q.subtotal, q.amount, q.is_one_off; end if;
  select count(*) into n from public.subscriptions where quote_id = q.id;
  if n is distinct from 1 then raise exception 'FAIL A: % subscriptions (want 1)', n; end if;
  select * into s from public.subscriptions where quote_id = q.id;
  if s.billing_cycle::text is distinct from 'quarterly' or s.seats is distinct from 10
     or s.start_date is distinct from '2026-10-21' or s.renewal_date is distinct from '2027-10-21' then
    raise exception 'FAIL A: sub cycle % seats % % → %', s.billing_cycle, s.seats, s.start_date, s.renewal_date; end if;
  if exists (select 1 from public.invoices i where i.quote_id = q.id and i.status <> 'void') then
    raise exception 'FAIL A: a whole-year invoice was raised on a quarterly sale'; end if;
  if (select amount from public.payments where id = (r->>'payment_id')::uuid) is distinct from 4814 then
    raise exception 'FAIL A: payment amount'; end if;
  if coalesce(s.outstanding_amount, 0) <> 0 then
    raise exception 'FAIL A: subscription owes % today (only Q1 is due, and it is paid)', s.outstanding_amount; end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000202601') is null then
    raise exception 'FAIL A: bank line not reconciled'; end if;
  raise notice 'PASS A: annual + quarterly → quote & subscription quarterly, renews 2027-10-21, Q1 ₹4,814 paid, nothing owed today';
end $$;

-- B. Monthly flex cannot be billed quarterly.
do $$
declare ok boolean := false;
begin
  begin
    perform public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000202602', 'cccccccc-0000-0000-0000-000000202601',
      '[{"name":"Google Workspace Business Starter","qty":10,"rate":160,"commitment":"monthly"}]'::jsonb,
      true, '2026-10-21', null, 0, null, null, 'quarterly');
  exception when check_violation then ok := sqlerrm like '%billed monthly only%'; end;
  if not ok then raise exception 'FAIL B: monthly flex billed quarterly was not refused'; end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000202602') is not null then
    raise exception 'FAIL B: bank line changed'; end if;
  raise notice 'PASS B: Monthly flex + quarterly refused, nothing written';
end $$;

-- C. Monthly flex, no cycle given → monthly.
do $$
declare r jsonb; q record; s record;
begin
  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000202603', 'cccccccc-0000-0000-0000-000000202601',
         '[{"name":"Google Workspace Business Starter","qty":10,"rate":160,"commitment":"monthly"}]'::jsonb,
         true, '2026-10-21', null);
  select * into q from public.quotes where id = r->>'quote_id';
  if q.billing_cycle is distinct from 'monthly' then raise exception 'FAIL C: quote cycle %', q.billing_cycle; end if;
  select * into s from public.subscriptions where quote_id = q.id;
  if s.billing_cycle::text is distinct from 'monthly' or s.renewal_date is distinct from '2026-11-21' then
    raise exception 'FAIL C: sub % renews %', s.billing_cycle, s.renewal_date; end if;
  raise notice 'PASS C: Monthly flex → monthly quote and subscription, renews in a month';
end $$;

-- D. An unknown cycle is refused.
do $$
declare ok boolean := false;
begin
  begin
    perform public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000202604', 'cccccccc-0000-0000-0000-000000202601',
      '[{"name":"Plan","qty":5,"rate":2000,"commitment":"annual_yearly"}]'::jsonb,
      true, '2026-10-21', null, 0, null, null, 'weekly');
  exception when sqlstate '22023' then ok := true; end;
  if not ok then raise exception 'FAIL D: weekly accepted'; end if;
  raise notice 'PASS D: unknown cycle refused';
end $$;

-- E. Annual with no cycle → yearly (as before R-2026).
do $$
declare r jsonb; q record;
begin
  r := public.reconcile_bank_credit_new_sale('11111111-0000-0000-0000-000000202604', 'cccccccc-0000-0000-0000-000000202601',
         '[{"name":"Plan","qty":5,"rate":2000,"commitment":"annual_yearly"}]'::jsonb,
         true, '2026-10-21', null);
  select * into q from public.quotes where id = r->>'quote_id';
  if q.billing_cycle is distinct from 'yearly' or r->>'invoice_issued' is null then
    raise exception 'FAIL E: cycle % invoice %', q.billing_cycle, r->>'invoice_issued'; end if;
  raise notice 'PASS E: annual with no cycle → yearly, whole-year invoice issued';
end $$;

rollback;
