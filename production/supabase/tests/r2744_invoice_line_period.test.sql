\set ON_ERROR_STOP on
-- R-2744: every invoice line stores its service period when the invoice is issued
-- (migration 20261113210500_r2744_invoice_line_service_period). Self-asserting, ONE transaction,
-- rolled back, synthetic tenant only — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r2744_invoice_line_period.test.sql
--
-- Expect "PASS r2744_invoice_line_period".
--   PARITY   invoice_line_service_period = lib/quotes/service-period.ts lineServicePeriod on every case
--            below (the SAME case list is run through the TS code by
--            src/lib/quotes/stored-line-period-r2744.test.ts — it reads it from this file)
--   STAMP    a renewal invoice made from a quote: each subscription line stores its own period, the
--            one-time line stores an explicit null (key present = stored at issue)
--   CUTOFF   R-2727 rule: no app_rule_dates row / invoice made before from_at -> the day-after rule
--   FROZEN   quote + subscription edited after issue -> the stored period does not move; editing the
--            stored period is refused (issued-invoice freeze)
--   KEEP     a caller that wrote service_period itself keeps it
--   NOQUOTE  an invoice with no quote (instalment / milestone / direct) is not stamped
--   SAFE     a broken quote row never blocks the invoice (unstamped, old computed path)
--   GRANTS   helpers not executable by anon / authenticated

begin;

-- R-1643: issuing a Tax Invoice needs the company's own GSTIN + address. Rolled back with the test.
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

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ── PARITY ─────────────────────────────────────────────────────────────────────
do $parity$
declare
  v_fails text[] := '{}';
  v_case  jsonb;
  v_got   jsonb;
  v_n     int := 0;
  -- R2744-PARITY-CASES (read by stored-line-period-r2744.test.ts; keep the JSON between the markers)
  v_cases jsonb := $cases$[
{"name":"new sale annual, line start_date","quote":{"created_date":"2026-11-14"},"line":{"commitment":"annual_yearly","start_date":"2026-12-01"},"expect":{"from":"2026-12-01","to":"2027-11-30","months":12}},
{"name":"new sale monthly, no start_date -> quote date","quote":{"created_date":"2026-11-14"},"line":{"commitment":"monthly"},"expect":{"from":"2026-11-14","to":"2026-12-13","months":1}},
{"name":"new sale 3-year domain line","quote":{"created_date":"2026-11-14"},"line":{"commitment":"annual_yearly","start_date":"2026-12-01","years":3},"expect":{"from":"2026-12-01","to":"2029-11-30","months":36}},
{"name":"years as a string","quote":{"created_date":"2026-11-14"},"line":{"commitment":"annual_monthly","years":"2"},"expect":{"from":"2026-11-14","to":"2028-11-13","months":24}},
{"name":"years out of range -> 1","quote":{"created_date":"2026-11-14"},"line":{"commitment":"annual_yearly","years":11},"expect":{"from":"2026-11-14","to":"2027-11-13","months":12}},
{"name":"commitment with spaces and capitals","quote":{"created_date":"2026-11-14"},"line":{"commitment":" Annual_Yearly "},"expect":{"from":"2026-11-14","to":"2027-11-13","months":12}},
{"name":"one_time line","quote":{"created_date":"2026-11-14"},"line":{"commitment":"annual_yearly","one_time":true},"expect":null},
{"name":"one_time commitment","quote":{"created_date":"2026-11-14"},"line":{"commitment":"one_time"},"expect":null},
{"name":"no commitment","quote":{"created_date":"2026-11-14"},"line":{"name":"Setup"},"expect":null},
{"name":"unknown commitment","quote":{"created_date":"2026-11-14"},"line":{"commitment":"weekly"},"expect":null},
{"name":"one-off quote","quote":{"created_date":"2026-11-14","is_one_off":true},"line":{"commitment":"annual_yearly"},"expect":null},
{"name":"leap day start","quote":{"created_date":"2028-02-01"},"line":{"commitment":"annual_yearly","start_date":"2028-02-29"},"expect":{"from":"2028-02-29","to":"2029-02-27","months":12}},
{"name":"start_date with a time","quote":{"created_date":"2026-11-14"},"line":{"commitment":"monthly","start_date":"2026-12-01T00:00:00Z"},"expect":{"from":"2026-12-01","to":"2026-12-31","months":1}},
{"name":"bad start_date -> quote date","quote":{"created_date":"2026-11-14"},"line":{"commitment":"monthly","start_date":"2026-02-30"},"expect":{"from":"2026-11-14","to":"2026-12-13","months":1}},
{"name":"add-seats dated line","quote":{"created_date":"2026-11-14","is_add_seats":true},"line":{"name":"Business Starter (pro-rata from 2026-11-14 to 2027-03-31)","commitment":"annual_yearly"},"expect":{"from":"2026-11-14","to":"2027-03-31","months":null}},
{"name":"current term dated line","quote":{"created_date":"2026-11-14"},"line":{"name":"Seats (current term 2026-01-01 to 2026-12-31)"},"expect":{"from":"2026-01-01","to":"2026-12-31","months":null}},
{"name":"add-seats without dates","quote":{"created_date":"2026-11-14","is_add_seats":true},"line":{"name":"Business Starter","commitment":"annual_yearly"},"expect":null},
{"name":"impossible range date -> not a range","quote":{"created_date":"2026-11-14"},"line":{"name":"X (pro-rata from 2026-02-30 to 2026-03-31)","commitment":"annual_yearly","start_date":"2026-02-01"},"expect":{"from":"2026-02-01","to":"2027-01-31","months":12}},
{"name":"range backwards -> not a range","quote":{"created_date":"2026-11-14"},"line":{"name":"X (pro-rata from 2026-05-01 to 2026-03-31)","commitment":"monthly","start_date":"2026-02-01"},"expect":{"from":"2026-02-01","to":"2026-02-28","months":1}},
{"name":"renewal, last-day (Zoho) row -> day after","quote":{"created_date":"2026-10-01","is_renewal":true,"extension_months":12,"renewal_term_date":"2026-10-26"},"sub":{"start_date":"2025-10-27","term_months":12},"ruleFrom":"2026-11-13T19:21:33Z","createdAt":"2026-11-14T10:00:00Z","line":{"commitment":"annual_yearly"},"expect":{"from":"2026-10-27","to":"2027-10-26","months":12}},
{"name":"renewal, app-made anniversary row, after the rule -> ON renewal date","quote":{"created_date":"2026-11-01","is_renewal":true,"extension_months":12,"renewal_term_date":"2026-12-01"},"sub":{"start_date":"2025-12-01","term_months":12},"ruleFrom":"2026-11-13T19:21:33Z","createdAt":"2026-11-14T10:00:00Z","line":{"commitment":"annual_yearly"},"expect":{"from":"2026-12-01","to":"2027-11-30","months":12}},
{"name":"same, invoice made before the rule -> day after","quote":{"created_date":"2026-11-01","is_renewal":true,"extension_months":12,"renewal_term_date":"2026-12-01"},"sub":{"start_date":"2025-12-01","term_months":12},"ruleFrom":"2026-11-13T19:21:33Z","createdAt":"2026-11-13T19:21:32Z","line":{"commitment":"annual_yearly"},"expect":{"from":"2026-12-02","to":"2027-12-01","months":12}},
{"name":"same, no rule row -> day after","quote":{"created_date":"2026-11-01","is_renewal":true,"extension_months":12,"renewal_term_date":"2026-12-01"},"sub":{"start_date":"2025-12-01","term_months":12},"createdAt":"2026-11-14T10:00:00Z","line":{"commitment":"annual_yearly"},"expect":{"from":"2026-12-02","to":"2027-12-01","months":12}},
{"name":"renewal, subscription not found -> day after","quote":{"created_date":"2026-11-01","is_renewal":true,"extension_months":12,"renewal_term_date":"2026-12-01"},"ruleFrom":"2026-11-13T19:21:33Z","createdAt":"2026-11-14T10:00:00Z","line":{"commitment":"annual_yearly"},"expect":{"from":"2026-12-02","to":"2027-12-01","months":12}},
{"name":"renewal, second anniversary (2 terms)","quote":{"created_date":"2026-11-01","is_renewal":true,"extension_months":12,"renewal_term_date":"2026-12-01"},"sub":{"start_date":"2024-12-01","term_months":12},"ruleFrom":"2026-11-13T19:21:33Z","createdAt":"2026-11-14T10:00:00Z","line":{"commitment":"annual_yearly","start_date":"2030-01-01"},"expect":{"from":"2026-12-01","to":"2027-11-30","months":12}},
{"name":"renewal without renewal_term_date","quote":{"created_date":"2026-11-01","is_renewal":true,"extension_months":12},"line":{"commitment":"annual_yearly"},"expect":null},
{"name":"renewal, monthly line on 12 months -> conflict","quote":{"created_date":"2026-11-01","is_renewal":true,"extension_months":12,"renewal_term_date":"2026-12-01"},"line":{"commitment":"monthly"},"expect":null},
{"name":"monthly renewal of a monthly anniversary row","quote":{"created_date":"2026-11-01","is_renewal":true,"extension_months":1,"renewal_term_date":"2026-11-15"},"sub":{"start_date":"2026-09-15","term_months":1},"ruleFrom":"2026-11-13T19:21:33Z","createdAt":"2026-11-14T10:00:00Z","line":{"commitment":"monthly"},"expect":{"from":"2026-11-15","to":"2026-12-14","months":1}},
{"name":"extension 1 month at month end, anniversary","quote":{"created_date":"2026-11-01","is_extension":true,"extension_months":1,"renewal_term_date":"2027-01-31"},"sub":{"start_date":"2026-01-31","term_months":12},"ruleFrom":"2026-11-13T19:21:33Z","createdAt":"2026-11-14T10:00:00Z","line":{"commitment":"annual_yearly"},"expect":{"from":"2027-01-31","to":"2027-02-27","months":1}},
{"name":"extension 1 month at month end, last-day row","quote":{"created_date":"2026-11-01","is_extension":true,"extension_months":1,"renewal_term_date":"2027-01-30"},"line":{"commitment":"annual_yearly"},"expect":{"from":"2027-01-31","to":"2027-02-28","months":1}},
{"name":"extension 0 months","quote":{"created_date":"2026-11-01","is_extension":true,"extension_months":0,"renewal_term_date":"2027-01-30"},"line":{"commitment":"annual_yearly"},"expect":null},
{"name":"renewal, one-time line","quote":{"created_date":"2026-11-01","is_renewal":true,"extension_months":12,"renewal_term_date":"2026-12-01"},"line":{"commitment":"annual_yearly","one_time":true},"expect":null},
{"name":"renewal, start after renewal_term_date (not an anniversary)","quote":{"created_date":"2026-11-01","is_renewal":true,"extension_months":12,"renewal_term_date":"2026-12-01"},"sub":{"start_date":"2027-01-01","term_months":12},"ruleFrom":"2026-11-13T19:21:33Z","createdAt":"2026-11-14T10:00:00Z","line":{"commitment":"annual_yearly"},"expect":{"from":"2026-12-02","to":"2027-12-01","months":12}}
]$cases$;
  -- R2744-PARITY-CASES-END
begin
  for v_case in select * from jsonb_array_elements(v_cases) loop
    v_n := v_n + 1;
    v_got := public.invoice_line_service_period(
      v_case->'line', v_case->'quote', v_case->'sub',
      nullif(v_case->>'ruleFrom', '')::timestamptz,
      coalesce(nullif(v_case->>'createdAt', ''), '2026-11-14T10:00:00Z')::timestamptz);
    if v_got is distinct from (case when jsonb_typeof(v_case->'expect') = 'null' then null else v_case->'expect' end) then
      v_fails := v_fails || format('PARITY %s: got %s, want %s', v_case->>'name', v_got, v_case->'expect');
    end if;
  end loop;
  if v_n < 30 then v_fails := v_fails || format('PARITY: only %s cases read', v_n); end if;
  if array_length(v_fails, 1) > 0 then raise exception E'FAIL r2744 parity:\n%', array_to_string(v_fails, E'\n'); end if;
  raise notice 'PASS parity (% cases)', v_n;
end $parity$;

-- ── fixtures ───────────────────────────────────────────────────────────────────
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('aaaaaaaa-2744-0000-0000-000000000001','R2744 Co','r2744@example.in','07','R2744');
insert into public.customers (id, tenant_id, name, state_code)
  values ('cccccccc-2744-0000-0000-000000000001','aaaaaaaa-2744-0000-0000-000000000001','Cust 2744','07');
-- An app-made subscription (started 1 Dec 2025, renews ON 1 Dec 2026 = start + one term).
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, start_date, renewal_date, term_months)
  values ('dddddddd-2744-0000-0000-000000000001','aaaaaaaa-2744-0000-0000-000000000001','cccccccc-2744-0000-0000-000000000001',
          'Cust 2744','Business Starter','google',2,500,'2025-12-01','2026-12-01',12);
-- Renewal quote: two subscription lines + a one-time setup line.
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status,
                           is_renewal, extension_months, renewal_term_date, renewal_subscription_id, created_date, line_items)
  values ('Q-R2744-1','aaaaaaaa-2744-0000-0000-000000000001','cccccccc-2744-0000-0000-000000000001','Cust 2744',
          14160, 12000, 18, 'accepted', 'awaiting', true, 12, '2026-12-01', 'dddddddd-2744-0000-0000-000000000001', '2026-11-01',
          '[{"id":"a","name":"Business Starter","qty":2,"rate":5000,"cost":4000,"commitment":"annual_yearly"},
            {"id":"b","name":"Archive add-on","qty":1,"rate":1000,"cost":800,"commitment":"annual_monthly"},
            {"id":"c","name":"Migration help","qty":1,"rate":1000,"cost":0,"one_time":true}]'::jsonb);

-- The R-2727 rule went live a day ago on this database (rolled back with the test).
insert into public.app_rule_dates (key, from_at) values ('r2727_invoice_period_rule', now() - interval '1 day')
  on conflict (key) do update set from_at = excluded.from_at;

-- ── STAMP ──────────────────────────────────────────────────────────────────────
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, taxable_value, tax_amount, tax_rate, inter_state, quote_id)
  values ('INV-R2744-1','aaaaaaaa-2744-0000-0000-000000000001','cccccccc-2744-0000-0000-000000000001','Cust 2744',
          14160,'pending', public.ist_today(), 12000, 2160, 18, false, 'Q-R2744-1');

do $$
declare v jsonb := (select line_items from public.invoices where id = 'INV-R2744-1');
begin
  if jsonb_array_length(v) <> 3 then raise exception 'FAIL STAMP: lines not copied: %', v; end if;
  if v->0->'service_period' is distinct from '{"from":"2026-12-01","to":"2027-11-30","months":12}'::jsonb
     or v->1->'service_period' is distinct from '{"from":"2026-12-01","to":"2027-11-30","months":12}'::jsonb then
    raise exception 'FAIL STAMP: subscription lines: %', v;
  end if;
  if not (v->2 ? 'service_period') or jsonb_typeof(v->2->'service_period') <> 'null' then
    raise exception 'FAIL STAMP: one-time line must store an explicit null: %', v->2;
  end if;
  if (v->0->>'cost')::int is distinct from 4000 then raise exception 'FAIL STAMP: copied cost lost: %', v->0; end if;
  raise notice 'PASS stamp';
end $$;

-- ── CUTOFF ─────────────────────────────────────────────────────────────────────
-- Two more app-made subscriptions like the first (one renewal quote per subscription term).
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, start_date, renewal_date, term_months)
  select ('dddddddd-2744-0000-0000-00000000000' || n)::uuid, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
         start_date, renewal_date, term_months
    from public.subscriptions, generate_series(2, 3) n where id = 'dddddddd-2744-0000-0000-000000000001';
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status,
                           is_renewal, extension_months, renewal_term_date, renewal_subscription_id, created_date, line_items)
  select 'Q-R2744-' || n, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status,
         is_renewal, extension_months, renewal_term_date, ('dddddddd-2744-0000-0000-00000000000' || n)::uuid, created_date, line_items
    from public.quotes, generate_series(2, 3) n where id = 'Q-R2744-1';
update public.app_rule_dates set from_at = now() + interval '1 day' where key = 'r2727_invoice_period_rule';
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, taxable_value, tax_amount, tax_rate, inter_state, quote_id)
  values ('INV-R2744-2','aaaaaaaa-2744-0000-0000-000000000001','cccccccc-2744-0000-0000-000000000001','Cust 2744',
          14160,'pending', public.ist_today(), 12000, 2160, 18, false, 'Q-R2744-2');
delete from public.app_rule_dates where key = 'r2727_invoice_period_rule';
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, taxable_value, tax_amount, tax_rate, inter_state, quote_id)
  values ('INV-R2744-3','aaaaaaaa-2744-0000-0000-000000000001','cccccccc-2744-0000-0000-000000000001','Cust 2744',
          14160,'pending', public.ist_today(), 12000, 2160, 18, false, 'Q-R2744-3');
do $$
begin
  if (select line_items->0->'service_period' from public.invoices where id = 'INV-R2744-2')
     is distinct from '{"from":"2026-12-02","to":"2027-12-01","months":12}'::jsonb then
    raise exception 'FAIL CUTOFF: made before the rule must keep the day-after rule';
  end if;
  if (select line_items->0->'service_period' from public.invoices where id = 'INV-R2744-3')
     is distinct from '{"from":"2026-12-02","to":"2027-12-01","months":12}'::jsonb then
    raise exception 'FAIL CUTOFF: no rule row must keep the day-after rule';
  end if;
  raise notice 'PASS cutoff';
end $$;

-- ── FROZEN ─────────────────────────────────────────────────────────────────────
update public.quotes set renewal_term_date = '2027-03-01', created_date = '2026-01-01',
       line_items = jsonb_set(line_items, '{0,start_date}', '"2030-01-01"')
 where id = 'Q-R2744-1';
update public.subscriptions set start_date = '2025-06-01' where id = 'dddddddd-2744-0000-0000-000000000001';
do $$
declare v_refused boolean := false;
begin
  if (select line_items->0->'service_period' from public.invoices where id = 'INV-R2744-1')
     is distinct from '{"from":"2026-12-01","to":"2027-11-30","months":12}'::jsonb then
    raise exception 'FAIL FROZEN: stored period moved after the quote / subscription changed';
  end if;
  begin
    update public.invoices set line_items = jsonb_set(line_items, '{0,service_period}', '{"from":"2027-03-02","to":"2028-03-01","months":12}')
     where id = 'INV-R2744-1';
  exception when others then v_refused := true;
  end;
  if not v_refused then raise exception 'FAIL FROZEN: the stored period of an issued invoice could be edited'; end if;
  raise notice 'PASS frozen';
end $$;

-- ── KEEP + NOQUOTE ─────────────────────────────────────────────────────────────
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, created_date, line_items)
  values ('Q-R2744-4','aaaaaaaa-2744-0000-0000-000000000001','cccccccc-2744-0000-0000-000000000001','Cust 2744',
          5900, 5000, 18, 'accepted', 'awaiting', '2026-11-01', '[{"id":"a","name":"Business Starter","qty":1,"rate":5000,"commitment":"annual_yearly"}]');
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, taxable_value, tax_amount, tax_rate, inter_state, quote_id, line_items)
  values ('INV-R2744-4','aaaaaaaa-2744-0000-0000-000000000001','cccccccc-2744-0000-0000-000000000001','Cust 2744',
          5900,'pending', public.ist_today(), 5000, 900, 18, false, 'Q-R2744-4',
          '[{"id":"a","name":"Business Starter","qty":1,"rate":5000,"commitment":"annual_yearly","service_period":{"from":"2026-12-15","to":"2027-12-14","months":12}},
            {"id":"b","name":"Business Starter","qty":1,"rate":0,"commitment":"annual_yearly"}]');
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, taxable_value, tax_amount, tax_rate, inter_state, line_items)
  values ('INV-R2744-5','aaaaaaaa-2744-0000-0000-000000000001','cccccccc-2744-0000-0000-000000000001','Cust 2744',
          5900,'pending', public.ist_today(), 5000, 900, 18, false,
          '[{"id":"a","name":"Instalment 1 of 4","qty":1,"rate":5000,"commitment":"annual_yearly"}]');
do $$
declare v jsonb := (select line_items from public.invoices where id = 'INV-R2744-4');
begin
  if v->0->'service_period' is distinct from '{"from":"2026-12-15","to":"2027-12-14","months":12}'::jsonb then
    raise exception 'FAIL KEEP: caller''s own period replaced: %', v->0;
  end if;
  if v->1->'service_period' is distinct from '{"from":"2026-11-01","to":"2027-10-31","months":12}'::jsonb then
    raise exception 'FAIL KEEP: a line without its own period must be stamped: %', v->1;
  end if;
  if (select line_items->0 ? 'service_period' from public.invoices where id = 'INV-R2744-5') then
    raise exception 'FAIL NOQUOTE: a quote-less invoice was stamped';
  end if;
  raise notice 'PASS keep + noquote';
end $$;

-- ── SAFE: a quote whose line_items is not an array of objects never blocks the invoice ──
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, created_date, line_items)
  values ('Q-R2744-6','aaaaaaaa-2744-0000-0000-000000000001','cccccccc-2744-0000-0000-000000000001','Cust 2744',
          5900, 5000, 18, 'accepted', 'awaiting', '2026-11-01', '[]');
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, taxable_value, tax_amount, tax_rate, inter_state, quote_id, line_items)
  values ('INV-R2744-6','aaaaaaaa-2744-0000-0000-000000000001','cccccccc-2744-0000-0000-000000000001','Cust 2744',
          5900,'pending', public.ist_today(), 5000, 900, 18, false, 'Q-R2744-6', '["not an object", 7]');
do $$
begin
  if (select line_items from public.invoices where id = 'INV-R2744-6') is distinct from '["not an object", 7]'::jsonb then
    raise exception 'FAIL SAFE: non-object lines were changed';
  end if;
  raise notice 'PASS safe';
end $$;

-- ── GRANTS ─────────────────────────────────────────────────────────────────────
do $$
begin
  if has_function_privilege('anon', 'public.invoice_line_service_period(jsonb, jsonb, jsonb, timestamptz, timestamptz)', 'execute')
     or has_function_privilege('authenticated', 'public.invoice_line_service_period(jsonb, jsonb, jsonb, timestamptz, timestamptz)', 'execute')
     or has_function_privilege('anon', 'public.invoice_lines_with_periods(jsonb, jsonb, jsonb, timestamptz, timestamptz)', 'execute')
     or has_function_privilege('authenticated', 'public.invoice_lines_with_periods(jsonb, jsonb, jsonb, timestamptz, timestamptz)', 'execute') then
    raise exception 'FAIL GRANTS: R-2744 helpers executable by anon / authenticated';
  end if;
  if not has_function_privilege('service_role', 'public.invoice_line_service_period(jsonb, jsonb, jsonb, timestamptz, timestamptz)', 'execute') then
    raise exception 'FAIL GRANTS: service_role cannot run the period helper (the backfill report)';
  end if;
  raise notice 'PASS grants';
  raise notice 'PASS r2744_invoice_line_period';
end $$;

rollback;
