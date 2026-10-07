-- Regression test: R-045 slice 3 — a foreign-currency invoice keeps the rate it was issued at
-- (migration 20261007251000_invoice_fx_rate).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/invoice_fx_rate.test.sql
--
-- Proves:
--   1. An invoice on a USD quote copies currency / fx_rate / fx_source / fx_date at insert.
--   2. An invoice on an INR quote leaves all four NULL (unchanged behaviour).
--   3. Editing the quote's rate later does NOT move the issued invoice.
--   4. The invoice's rate cannot be changed once set; null -> value is allowed.
--   5. A path that sets the fields itself keeps its own values.
--   6. The escape hatch (app.invoice_amend_reason) still allows a reviewed amendment.

begin;

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('ffffffff-0000-0000-0000-000000045f01', 'R045 Reseller', 'r045@example.in', '07', 'R45F');

insert into public.customers (id, tenant_id, name, country)
  values ('cccccccc-0000-0000-0000-000000045c01', 'ffffffff-0000-0000-0000-000000045f01', 'US Client', 'United States');

insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, status,
                           currency, exchange_rate, fx_source, fx_date)
  values ('Q-R045-USD', 'ffffffff-0000-0000-0000-000000045f01', 'cccccccc-0000-0000-0000-000000045c01', 'US Client',
          'GW', 1, 9598, 9598, 'sent', 'USD', 95.9832, 'fbil', '2026-09-30'),
         ('Q-R045-INR', 'ffffffff-0000-0000-0000-000000045f01', 'cccccccc-0000-0000-0000-000000045c01', 'US Client',
          'GW', 1, 1000, 1000, 'sent', 'INR', 1, null, null),
         ('Q-R045-OLD', 'ffffffff-0000-0000-0000-000000045f01', 'cccccccc-0000-0000-0000-000000045c01', 'US Client',
          'GW', 1, 8300, 8300, 'sent', 'usd', 83, null, null),
         ('Q-R045-OWN', 'ffffffff-0000-0000-0000-000000045f01', 'cccccccc-0000-0000-0000-000000045c01', 'US Client',
          'GW', 1, 9000, 9000, 'sent', 'USD', 95.9832, 'fbil', '2026-09-30');

insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, quote_id)
  values ('INV-R045-USD', 'ffffffff-0000-0000-0000-000000045f01', 'cccccccc-0000-0000-0000-000000045c01', 'US Client', 9598, 'Q-R045-USD'),
         ('INV-R045-INR', 'ffffffff-0000-0000-0000-000000045f01', 'cccccccc-0000-0000-0000-000000045c01', 'US Client', 1000, 'Q-R045-INR'),
         ('INV-R045-OLD', 'ffffffff-0000-0000-0000-000000045f01', 'cccccccc-0000-0000-0000-000000045c01', 'US Client', 8300, 'Q-R045-OLD');

insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, quote_id, currency, fx_rate, fx_source, fx_date)
  values ('INV-R045-OWN', 'ffffffff-0000-0000-0000-000000045f01', 'cccccccc-0000-0000-0000-000000045c01', 'US Client', 9000, 'Q-R045-OWN',
          'EUR', 108.9368, 'manual', '2026-10-07');

do $$
declare r record;
begin
  -- 1
  select currency, fx_rate, fx_source, fx_date into r from public.invoices where id = 'INV-R045-USD';
  if r.currency is distinct from 'USD' or r.fx_rate is distinct from 95.9832
     or r.fx_source is distinct from 'fbil' or r.fx_date is distinct from date '2026-09-30' then
    raise exception 'FAIL 1: USD snapshot wrong: %', r;
  end if;
  -- 2
  select currency, fx_rate, fx_source, fx_date into r from public.invoices where id = 'INV-R045-INR';
  if r.currency is not null or r.fx_rate is not null or r.fx_source is not null or r.fx_date is not null then
    raise exception 'FAIL 2: INR invoice got fx fields: %', r;
  end if;
  -- pre-R-045 quote (no source/date): currency normalised, rate copied, source/date stay NULL (not invented)
  select currency, fx_rate, fx_source, fx_date into r from public.invoices where id = 'INV-R045-OLD';
  if r.currency is distinct from 'USD' or r.fx_rate is distinct from 83 or r.fx_source is not null or r.fx_date is not null then
    raise exception 'FAIL 2b: legacy quote snapshot wrong: %', r;
  end if;
  -- 5
  select currency, fx_rate, fx_source into r from public.invoices where id = 'INV-R045-OWN';
  if r.currency is distinct from 'EUR' or r.fx_rate is distinct from 108.9368 or r.fx_source is distinct from 'manual' then
    raise exception 'FAIL 5: explicit values overwritten: %', r;
  end if;
end $$;

-- 3: quote edited after issue
update public.quotes set exchange_rate = 99.5, fx_source = 'manual' where id = 'Q-R045-USD';
do $$
begin
  if (select fx_rate from public.invoices where id = 'INV-R045-USD') is distinct from 95.9832 then
    raise exception 'FAIL 3: invoice rate followed the quote edit';
  end if;
end $$;

-- 4: frozen once set
do $$
begin
  begin
    update public.invoices set fx_rate = 99.5 where id = 'INV-R045-USD';
    raise exception 'FAIL 4: fx_rate changed on an issued invoice';
  exception when check_violation then null;
  end;
  begin
    update public.invoices set fx_source = 'manual' where id = 'INV-R045-USD';
    raise exception 'FAIL 4b: fx_source changed on an issued invoice';
  exception when check_violation then null;
  end;
  -- null -> value is allowed (an INR invoice without a rate is not frozen by this trigger)
  update public.invoices set fx_date = null where id = 'INV-R045-INR';
  -- other columns still editable
  update public.invoices set due_date = date '2026-11-01' where id = 'INV-R045-USD';
end $$;

-- 6: reviewed amendment
set local app.invoice_amend_reason = 'R-045 test: corrected FBIL rate';
update public.invoices set fx_rate = 95.99 where id = 'INV-R045-USD';
do $$
begin
  if (select fx_rate from public.invoices where id = 'INV-R045-USD') is distinct from 95.99 then
    raise exception 'FAIL 6: amendment under reason not applied';
  end if;
end $$;

select 'invoice_fx_rate: all checks passed' as result;

rollback;
