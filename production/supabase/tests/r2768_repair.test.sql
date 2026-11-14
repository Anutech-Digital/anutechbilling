\set ON_ERROR_STOP on
-- R-2768: the two owner-approved data repairs (migration 20261114043932_r2768_repair_line_periods_quote_notes).
-- Self-asserting, ONE transaction, rolled back, synthetic tenants (the repair functions also see the
-- local data — it is rolled back with everything else). Safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r2768_repair.test.sql
--
-- Expect "PASS r2768_repair".
--   NOTES      r2768_repaired_notes = editor-notes.ts splitNotesForEditor + the edited-box save, on every case
--              below (the SAME list is run through the TS by src/lib/quotes/quote-notes-repair-r2768.test.ts)
--   A_PLAN     verdicts: stamp / skip_lines_differ / skip_pdf_own_lines / skip_no_lines / skip_partly_stamped;
--              stamped, void, draft and other-tenant-quote invoices are not in the plan
--   A_DRY      p_apply = false writes nothing
--   A_APPLY    every line gets the period invoice_lines_with_periods gives (explicit null for none); nothing
--              else on the row changes (updated_at too); the flag is cleared after the run
--   A_FREEZE   the freeze stays on: flag off -> adding the key refused; flag on -> any other change refused
--   B_APPLY    notes in the editor's shape; customer part has no id; first "subscription <id>" unchanged
--              (open-renewal-quotes + add-seats link); updated_at kept; draft / staff-only ids untouched
--   IDEMPOTENT a second run changes 0 rows
--   UNDO       r2768_undo(run) puts every before value back; a second undo changes nothing
--   GRANTS     no repair function is executable by anon / authenticated

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

-- ── NOTES ──────────────────────────────────────────────────────────────────────
do $notes$
declare
  v_fails text[] := '{}';
  v_case  jsonb;
  v_got   text;
  v_n     int := 0;
  -- R2768-NOTES-CASES (read by quote-notes-repair-r2768.test.ts; keep the JSON between the markers)
  v_cases jsonb := $cases$[{"name":"operator renewal, plan + 12 months","notes":"Renewal quote (operator-generated) for subscription c2458000-1111-4222-8333-944455550311","lines":[{"name":"Business Starter","commitment":"annual_yearly"}],"plan":"Business Starter","ext":12,"expect":"Renewal of Business Starter for 12 months.\n\nStaff only (not shown to the customer):\nRenewal quote (operator-generated) for subscription c2458000-1111-4222-8333-944455550311"},
   {"name":"auto renewal + typed sentence, plan null, period from line","notes":"Auto-generated renewal quote for subscription c2458000-1111-4222-8333-944455550311. Please pay by the 5th.","lines":[{"name":"Workspace Plus","commitment":"annual_yearly"}],"plan":null,"ext":null,"expect":"Renewal of Workspace Plus for 12 months. Please pay by the 5th.\n\nStaff only (not shown to the customer):\nAuto-generated renewal quote for subscription c2458000-1111-4222-8333-944455550311."},
   {"name":"renewal + typed line on next line","notes":"Renewal quote for subscription c2458000-1111-4222-8333-944455550311\nCall Ravi before renewal.","lines":[{"name":"Business Starter","commitment":"annual_yearly"}],"plan":"Business Starter","ext":12,"expect":"Renewal of Business Starter for 12 months.\nCall Ravi before renewal.\n\nStaff only (not shown to the customer):\nRenewal quote for subscription c2458000-1111-4222-8333-944455550311"},
   {"name":"3-month extension with new date","notes":"3-month extension for subscription c2458000-1111-4222-8333-944455550311. On payment the renewal date advances by 3 months (to 30 Jun 2027).","lines":[{"name":"Business Starter · 3-month extension","commitment":"annual_yearly"}],"plan":"Business Starter","ext":3,"expect":"3-month extension. Your renewal date moves to 30 Jun 2027.\n\nStaff only (not shown to the customer):\n3-month extension for subscription c2458000-1111-4222-8333-944455550311. On payment the renewal date advances by 3 months (to 30 Jun 2027)."},
   {"name":"2-year extension, no tail","notes":"2-year extension for subscription c2458000-1111-4222-8333-944455550311.","lines":[{"name":"Business Starter · 2-year extension","commitment":"annual_yearly"}],"plan":"Business Starter","ext":24,"expect":"2-year extension of your subscription.\n\nStaff only (not shown to the customer):\n2-year extension for subscription c2458000-1111-4222-8333-944455550311."},
   {"name":"1-year extension with tail and typed text","notes":"1-year extension for subscription 129f0d2b-bc06-47dc-9672-58fb417ec012. On payment the renewal date advances by 1 year (to 9 Oct 2028). Thank you!","lines":[{"name":"R818 Second License · 1-year extension","commitment":"annual_yearly"}],"plan":"R818 Second License","ext":12,"expect":"1-year extension. Your renewal date moves to 9 Oct 2028. Thank you!\n\nStaff only (not shown to the customer):\n1-year extension for subscription 129f0d2b-bc06-47dc-9672-58fb417ec012. On payment the renewal date advances by 1 year (to 9 Oct 2028)."},
   {"name":"domain renewal with price","notes":"Domain renewal for example.in (subscription c2458000-1111-4222-8333-944455550311), at ResellerClub live renewal price of ₹799 + GST.","lines":[{"name":"Domain renewal example.in","commitment":"annual_yearly"}],"plan":"Domain","ext":12,"expect":"Renewal of example.in for 12 months.\n\nStaff only (not shown to the customer):\nDomain renewal for example.in (subscription c2458000-1111-4222-8333-944455550311), at ResellerClub live renewal price of ₹799 + GST."},
   {"name":"domain renewal without price","notes":"Domain renewal for shop.co.in (subscription c2458000-1111-4222-8333-944455550311).","lines":[{"name":"Domain renewal shop.co.in","commitment":"annual_yearly"}],"plan":null,"ext":null,"expect":"Renewal of shop.co.in for 12 months.\n\nStaff only (not shown to the customer):\nDomain renewal for shop.co.in (subscription c2458000-1111-4222-8333-944455550311)."},
   {"name":"domain renewal, two + GST in text","notes":"Domain renewal for a.in (subscription c2458000-1111-4222-8333-944455550311), at ₹799 + GST. Second fee ₹100 + GST.","lines":[{"name":"Domain a.in","commitment":"annual_yearly"}],"plan":null,"ext":24,"expect":"Renewal of a.in for 2 years. Second fee ₹100 + GST.\n\nStaff only (not shown to the customer):\nDomain renewal for a.in (subscription c2458000-1111-4222-8333-944455550311), at ₹799 + GST."},
   {"name":"legacy add-seats with effective date","notes":"Add-seats pro-rata for subscription c2458000-1111-4222-8333-944455550311. Effective date 2026-09-25 (backdated by E2E Owner on 2026-10-10). 188 of 365 days remaining (factor 51.5068%). CGST 9% + SGST 9%.","lines":[{"name":"Business Starter · +1 seats (pro-rata from 2026-09-25 to 2027-03-31)","commitment":"annual_yearly"}],"plan":"Business Starter","ext":0,"expect":"Additional seats from 25 Sep 2026 to 31 Mar 2027 (pro-rata).\n\nStaff only (not shown to the customer):\nAdd-seats pro-rata for subscription c2458000-1111-4222-8333-944455550311. Effective date 2026-09-25 (backdated by E2E Owner on 2026-10-10). 188 of 365 days remaining (factor 51.5068%). CGST 9% + SGST 9%."},
   {"name":"legacy add-seats, date from lines, two windows","notes":"Add-seats pro-rata for subscription c2458000-1111-4222-8333-944455550311. 340 of 365 days remaining (factor 93.1507%).","lines":[{"name":"Business Starter · +1 seats (previous term, pro-rata from 2026-09-01 to 2026-09-14)","commitment":"annual_yearly"},
   {"name":"Business Starter · +1 seats (current term 2026-09-15 to 2027-09-14)","commitment":"annual_yearly"}],"plan":"Business Starter","ext":0,"expect":"Additional seats from 1 Sep 2026 to 14 Sep 2027 (pro-rata).\n\nStaff only (not shown to the customer):\nAdd-seats pro-rata for subscription c2458000-1111-4222-8333-944455550311. 340 of 365 days remaining (factor 93.1507%)."},
   {"name":"legacy add-seats, no dates anywhere","notes":"Add-seats pro-rata for subscription c2458000-1111-4222-8333-944455550311.","lines":[{"name":"Business Starter · +1 seats","commitment":"annual_yearly"}],"plan":null,"ext":null,"expect":"Additional seats, charged pro-rata for the rest of the term.\n\nStaff only (not shown to the customer):\nAdd-seats pro-rata for subscription c2458000-1111-4222-8333-944455550311."},
   {"name":"renewal with an existing staff part","notes":"Renewal quote (operator-generated) for subscription c2458000-1111-4222-8333-944455550311\n\nStaff only (not shown to the customer):\nbackdated by Pardeep on 2026-10-10","lines":[{"name":"Business Starter","commitment":"annual_yearly"}],"plan":"Business Starter","ext":12,"expect":"Renewal of Business Starter for 12 months.\n\nStaff only (not shown to the customer):\nRenewal quote (operator-generated) for subscription c2458000-1111-4222-8333-944455550311\nbackdated by Pardeep on 2026-10-10"},
   {"name":"typed note with (subscription id: uuid), no lead","notes":"Thanks for renewing (subscription id: 129f0d2b-bc06-47dc-9672-58fb417ec012). See you next year.","lines":[{"name":"Business Starter","commitment":"annual_yearly"}],"plan":"Business Starter","ext":12,"expect":"Thanks for renewing. See you next year.\n\nStaff only (not shown to the customer):\nThanks for renewing (subscription id: 129f0d2b-bc06-47dc-9672-58fb417ec012)."},
   {"name":"renewal + factor sentence","notes":"Renewal quote for subscription c2458000-1111-4222-8333-944455550311. Pro-rata factor 93.15% applied. Pay soon.","lines":[{"name":"Business Starter","commitment":"annual_yearly"}],"plan":"Business Starter","ext":12,"expect":"Renewal of Business Starter for 12 months. Pay soon.\n\nStaff only (not shown to the customer):\nRenewal quote for subscription c2458000-1111-4222-8333-944455550311.\nPro-rata factor 93.15% applied."},
   {"name":"monthly line, ext null -> 1 month","notes":"Renewal quote for subscription c2458000-1111-4222-8333-944455550311","lines":[{"name":"Business Starter","commitment":"monthly"}],"plan":"Business Starter","ext":null,"expect":"Renewal of Business Starter for 1 month.\n\nStaff only (not shown to the customer):\nRenewal quote for subscription c2458000-1111-4222-8333-944455550311"},
   {"name":"two lines, plan null -> no name","notes":"Renewal quote for subscription c2458000-1111-4222-8333-944455550311","lines":[{"name":"Business Starter","commitment":"annual_yearly"},
   {"name":"Archive","commitment":"annual_monthly"}],"plan":null,"ext":12,"expect":"Renewal for 12 months.\n\nStaff only (not shown to the customer):\nRenewal quote for subscription c2458000-1111-4222-8333-944455550311"},
   {"name":"plan with a uuid -> no name","notes":"Renewal quote for subscription c2458000-1111-4222-8333-944455550311","lines":[{"name":"x","commitment":"annual_yearly"}],"plan":"Plan 129f0d2b-bc06-47dc-9672-58fb417ec012","ext":12,"expect":"Renewal for 12 months.\n\nStaff only (not shown to the customer):\nRenewal quote for subscription c2458000-1111-4222-8333-944455550311"},
   {"name":"24 months -> 2 years","notes":"Renewal quote for subscription c2458000-1111-4222-8333-944455550311","lines":[{"name":"Business Starter","commitment":"annual_yearly"}],"plan":"Business Starter","ext":24,"expect":"Renewal of Business Starter for 2 years.\n\nStaff only (not shown to the customer):\nRenewal quote for subscription c2458000-1111-4222-8333-944455550311"},
   {"name":"annual + monthly lines, ext null -> next term","notes":"Renewal quote for subscription c2458000-1111-4222-8333-944455550311","lines":[{"name":"Business Starter","commitment":"annual_yearly"},
   {"name":"Archive","commitment":"monthly"}],"plan":"Business Starter","ext":null,"expect":"Renewal of Business Starter for the next term.\n\nStaff only (not shown to the customer):\nRenewal quote for subscription c2458000-1111-4222-8333-944455550311"},
   {"name":"no uuid at all -> unchanged","notes":"Thank you for your business.","lines":[{"name":"Business Starter","commitment":"annual_yearly"}],"plan":"Business Starter","ext":12,"expect":null},
   {"name":"upper-case lead and id","notes":"RENEWAL QUOTE FOR SUBSCRIPTION C2458000-1111-4222-8333-944455550311","lines":[{"name":"Business Starter","commitment":"annual_yearly"}],"plan":"Business Starter","ext":12,"expect":"Renewal of Business Starter for 12 months.\n\nStaff only (not shown to the customer):\nRENEWAL QUOTE FOR SUBSCRIPTION C2458000-1111-4222-8333-944455550311"},
   {"name":"0-month extension","notes":"0-month extension for subscription c2458000-1111-4222-8333-944455550311.","lines":[{"name":"Business Starter","commitment":"annual_yearly"}],"plan":"Business Starter","ext":0,"expect":"Extension of your subscription.\n\nStaff only (not shown to the customer):\n0-month extension for subscription c2458000-1111-4222-8333-944455550311."},
   {"name":"empty plan -> no name","notes":"Renewal quote for subscription c2458000-1111-4222-8333-944455550311","lines":[{"name":"Business Starter","commitment":"annual_yearly"}],"plan":"","ext":12,"expect":"Renewal for 12 months.\n\nStaff only (not shown to the customer):\nRenewal quote for subscription c2458000-1111-4222-8333-944455550311"},
   {"name":"second id later in the customer part","notes":"Renewal quote for subscription c2458000-1111-4222-8333-944455550311. Old subscription 129f0d2b-bc06-47dc-9672-58fb417ec012 merged.","lines":[{"name":"Business Starter","commitment":"annual_yearly"}],"plan":"Business Starter","ext":12,"expect":"Renewal of Business Starter for 12 months. Old merged.\n\nStaff only (not shown to the customer):\nRenewal quote for subscription c2458000-1111-4222-8333-944455550311.\nOld subscription 129f0d2b-bc06-47dc-9672-58fb417ec012 merged."},
   {"name":"spaces and blank lines","notes":"  Renewal quote for subscription c2458000-1111-4222-8333-944455550311  \n\n\n  Extra line here.  ","lines":[{"name":"Business Starter","commitment":"annual_yearly"}],"plan":"Business Starter","ext":12,"expect":"Renewal of Business Starter for 12 months.\nExtra line here.\n\nStaff only (not shown to the customer):\nRenewal quote for subscription c2458000-1111-4222-8333-944455550311"},
   {"name":"extension named in line, no flags","notes":"Renewal quote for subscription c2458000-1111-4222-8333-944455550311","lines":[{"name":"Business Starter · 3-month extension","commitment":"annual_yearly"}],"plan":null,"ext":null,"expect":"Renewal of Business Starter · 3-month extension for 3 months.\n\nStaff only (not shown to the customer):\nRenewal quote for subscription c2458000-1111-4222-8333-944455550311"},
   {"name":"dated line -> next term","notes":"Renewal quote for subscription c2458000-1111-4222-8333-944455550311","lines":[{"name":"Business Starter (current term 2026-09-15 to 2027-09-14)","commitment":"annual_yearly"}],"plan":"Business Starter","ext":null,"expect":"Renewal of Business Starter for the next term.\n\nStaff only (not shown to the customer):\nRenewal quote for subscription c2458000-1111-4222-8333-944455550311"},
   {"name":"lines not an array","notes":"Renewal quote for subscription c2458000-1111-4222-8333-944455550311","lines":null,"plan":null,"ext":null,"expect":"Renewal for the next term.\n\nStaff only (not shown to the customer):\nRenewal quote for subscription c2458000-1111-4222-8333-944455550311"},
   {"name":"id only in staff part already -> unchanged","notes":"Renewal of Business Starter for 12 months.\n\nStaff only (not shown to the customer):\nRenewal quote for subscription c2458000-1111-4222-8333-944455550311","lines":[{"name":"Business Starter","commitment":"annual_yearly"}],"plan":"Business Starter","ext":12,"expect":"Renewal of Business Starter for 12 months.\n\nStaff only (not shown to the customer):\nRenewal quote for subscription c2458000-1111-4222-8333-944455550311"},
   {"name":"bare uuid in typed text","notes":"Ref 129f0d2b-bc06-47dc-9672-58fb417ec012 noted. Thanks!","lines":[{"name":"Business Starter","commitment":"annual_yearly"}],"plan":"Business Starter","ext":12,"expect":"Ref  noted. Thanks!\n\nStaff only (not shown to the customer):\nRef 129f0d2b-bc06-47dc-9672-58fb417ec012 noted."},
   {"name":"renewal lead, staff phrase backdated in rest","notes":"Renewal quote for subscription c2458000-1111-4222-8333-944455550311. Start backdated by Owner on 2026-10-01.","lines":[{"name":"Business Starter","commitment":"annual_yearly"}],"plan":"Business Starter","ext":12,"expect":"Renewal of Business Starter for 12 months.\n\nStaff only (not shown to the customer):\nRenewal quote for subscription c2458000-1111-4222-8333-944455550311.\nStart backdated by Owner on 2026-10-01."},
   {"name":"domain lead + newline rest","notes":"Domain renewal for z.in (subscription c2458000-1111-4222-8333-944455550311), at ₹899 + GST.\nAuto-renew is on.","lines":[{"name":"Domain z.in","commitment":"annual_yearly"}],"plan":null,"ext":12,"expect":"Renewal of z.in for 12 months.\nAuto-renew is on.\n\nStaff only (not shown to the customer):\nDomain renewal for z.in (subscription c2458000-1111-4222-8333-944455550311), at ₹899 + GST."},
   {"name":"invalid month in legacy date","notes":"Add-seats pro-rata for subscription c2458000-1111-4222-8333-944455550311. Effective date 2026-13-05.","lines":[{"name":"Business Starter","commitment":"annual_yearly"}],"plan":null,"ext":0,"expect":"Additional seats from 5 undefined 2026 (pro-rata).\n\nStaff only (not shown to the customer):\nAdd-seats pro-rata for subscription c2458000-1111-4222-8333-944455550311. Effective date 2026-13-05."}]$cases$;
  -- R2768-NOTES-CASES-END
begin
  for v_case in select * from jsonb_array_elements(v_cases) loop
    v_n := v_n + 1;
    v_got := public.r2768_repaired_notes(v_case->>'notes', v_case->'lines', v_case->>'plan', (v_case->>'ext')::int);
    if v_got is distinct from (v_case->>'expect') then
      v_fails := v_fails || format(E'NOTES %s:\n  got  %s\n  want %s', v_case->>'name', to_jsonb(v_got), v_case->'expect');
    end if;
  end loop;
  if array_length(v_fails, 1) > 0 then raise exception E'FAIL r2768 notes:\n%', array_to_string(v_fails, E'\n'); end if;
  if v_n < 30 then raise exception 'FAIL NOTES: only % cases read', v_n; end if;
  raise notice 'PASS notes (% cases)', v_n;
end $notes$;

-- ── fixtures ───────────────────────────────────────────────────────────────────
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('aaaaaaaa-2768-0000-0000-000000000001','R2768 Co','r2768@example.in','07','R2768'),
         ('aaaaaaaa-2768-0000-0000-000000000002','R2768 Other','r2768b@example.in','07','R2768B');
insert into public.customers (id, tenant_id, name, state_code)
  values ('cccccccc-2768-0000-0000-000000000001','aaaaaaaa-2768-0000-0000-000000000001','Cust 2768','07'),
         ('cccccccc-2768-0000-0000-000000000002','aaaaaaaa-2768-0000-0000-000000000002','Cust 2768 B','07');
-- One app-made subscription per renewal quote (quotes_one_renewal_per_term).
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, start_date, renewal_date, term_months)
  select ('dddddddd-2768-0000-0000-00000000000' || n)::uuid, 'aaaaaaaa-2768-0000-0000-000000000001','cccccccc-2768-0000-0000-000000000001',
         'Cust 2768','Business Starter','google',2,500,'2025-12-01','2026-12-01',12
    from generate_series(1, 9) n;
-- Renewal quote: two subscription lines + a one-time line; the same lines for every A fixture.
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status,
                           is_renewal, extension_months, renewal_term_date, renewal_subscription_id, created_date, line_items, notes, plan)
  select 'Q-R2768-' || n, 'aaaaaaaa-2768-0000-0000-000000000001','cccccccc-2768-0000-0000-000000000001','Cust 2768',
         14160, 12000, 18, 'accepted', 'awaiting', true, 12, '2026-12-01', ('dddddddd-2768-0000-0000-00000000000' || n)::uuid, '2026-11-01',
         '[{"id":"a","name":"Business Starter","qty":2,"rate":5000,"cost":4000,"commitment":"annual_yearly"},
           {"id":"b","name":"Archive add-on","qty":1,"rate":1000,"cost":800,"commitment":"annual_monthly"},
           {"id":"c","name":"Migration help","qty":1,"rate":1000,"cost":0,"one_time":true}]'::jsonb,
         null, 'Business Starter'
    from generate_series(1, 9) n;
delete from public.app_rule_dates where key = 'r2727_invoice_period_rule';   -- the day-after rule (old invoices)

-- Old invoices = issued before R-2744: no stamp. NULL lines need the copy trigger off too.
alter table public.invoices disable trigger trg_invoice_stamp_line_periods;
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, taxable_value, tax_amount, tax_rate, inter_state, quote_id, line_items, updated_at)
  select 'INV-R2768-' || n, 'aaaaaaaa-2768-0000-0000-000000000001','cccccccc-2768-0000-0000-000000000001','Cust 2768',
         14160, 'pending', public.ist_today() - 30, 12000, 2160, 18, false, 'Q-R2768-' || n,
         case n
           -- 1: the quote's lines + an internal cost the cost-fill wrote later -> stamp
           when 1 then '[{"id":"a","name":"Business Starter","qty":2,"rate":5000,"cost":4100,"cost_source":"bill","commitment":"annual_yearly"},
                         {"id":"b","name":"Archive add-on","qty":1,"rate":1000,"cost":800,"commitment":"annual_monthly"},
                         {"id":"c","name":"Migration help","qty":1,"rate":1000,"cost":0,"one_time":true}]'::jsonb
           -- 2: the one_time key is missing on the invoice -> lines differ
           when 2 then '[{"id":"a","name":"Business Starter","qty":2,"rate":5000,"cost":4000,"commitment":"annual_yearly"},
                         {"id":"b","name":"Archive add-on","qty":1,"rate":1000,"cost":800,"commitment":"annual_monthly"},
                         {"id":"c","name":"Migration help","qty":1,"rate":1000,"cost":0}]'::jsonb
           -- 4: partly stamped (one line has the key)
           when 4 then '[{"id":"a","name":"Business Starter","qty":2,"rate":5000,"cost":4000,"commitment":"annual_yearly","service_period":null},
                         {"id":"b","name":"Archive add-on","qty":1,"rate":1000,"cost":800,"commitment":"annual_monthly"},
                         {"id":"c","name":"Migration help","qty":1,"rate":1000,"cost":0,"one_time":true}]'::jsonb
           else null end,   -- 3, 5, 6: the copy trigger fills the quote's lines
         '2026-10-01T10:00:00Z'
    from generate_series(1, 6) n;
-- 3: the quote was re-priced after issue (R-375: the PDF prints the invoice's own lines)
update public.quotes set amount = 15340, subtotal = 13000 where id = 'Q-R2768-3';
-- 5 void, 6 draft
update public.invoices set status = 'void' where id = 'INV-R2768-5';
update public.invoices set status = 'draft' where id = 'INV-R2768-6';
alter table public.invoices disable trigger trg_invoice_copy_quote_lines;
-- 7, 8: NULL lines (old invoices printing the quote's lines)
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, taxable_value, tax_amount, tax_rate, inter_state, quote_id, line_items, updated_at)
  values ('INV-R2768-7','aaaaaaaa-2768-0000-0000-000000000001','cccccccc-2768-0000-0000-000000000001','Cust 2768',
          14160, 'pending', public.ist_today() - 30, 12000, 2160, 18, false, 'Q-R2768-7', null, '2026-10-01T10:00:00Z'),
         ('INV-R2768-8','aaaaaaaa-2768-0000-0000-000000000001','cccccccc-2768-0000-0000-000000000001','Cust 2768',
          14160, 'pending', public.ist_today() - 30, 12000, 2160, 18, false, 'Q-R2768-8', null, '2026-10-01T10:00:00Z');
alter table public.invoices enable trigger trg_invoice_copy_quote_lines;
alter table public.invoices enable trigger trg_invoice_stamp_line_periods;
-- 9: issued after R-2744 -> already stamped by the trigger, not in the plan
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, taxable_value, tax_amount, tax_rate, inter_state, quote_id)
  values ('INV-R2768-9','aaaaaaaa-2768-0000-0000-000000000001','cccccccc-2768-0000-0000-000000000001','Cust 2768',
          14160, 'pending', public.ist_today(), 12000, 2160, 18, false, 'Q-R2768-9');
-- Other tenant: an invoice pointing at tenant 1's quote id -> never joined (tenant-safe)
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, created_date, line_items)
  values ('Q-R2768-X','aaaaaaaa-2768-0000-0000-000000000001','cccccccc-2768-0000-0000-000000000001','Cust 2768',
          14160, 12000, 18, 'accepted', 'awaiting', '2026-11-01',
          '[{"id":"a","name":"Business Starter","qty":2,"rate":5000,"commitment":"annual_yearly"}]');
alter table public.invoices disable trigger trg_invoice_stamp_line_periods;
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, taxable_value, tax_amount, tax_rate, inter_state, quote_id, line_items)
  values ('INV-R2768-X','aaaaaaaa-2768-0000-0000-000000000002','cccccccc-2768-0000-0000-000000000002','Cust 2768 B',
          14160, 'pending', public.ist_today() - 30, 12000, 2160, 18, false, 'Q-R2768-X',
          '[{"id":"a","name":"Business Starter","qty":2,"rate":5000,"commitment":"annual_yearly"}]');
alter table public.invoices enable trigger trg_invoice_stamp_line_periods;

create temp table r2768_inv_before on commit drop as
  select id, to_jsonb(i) as row from public.invoices i where id like 'INV-R2768-%';

-- ── A_PLAN + A_DRY ─────────────────────────────────────────────────────────────
do $$
declare v jsonb; r record;
begin
  select coalesce(jsonb_object_agg(invoice_id, verdict), '{}') into v
    from public.r2768_invoice_line_period_plan() where invoice_id like 'INV-R2768-%';
  if v is distinct from '{"INV-R2768-1":"stamp","INV-R2768-2":"skip_lines_differ","INV-R2768-3":"skip_pdf_own_lines",
                           "INV-R2768-4":"skip_partly_stamped","INV-R2768-7":"skip_no_lines","INV-R2768-8":"skip_no_lines"}'::jsonb then
    raise exception 'FAIL A_PLAN: %', v;
  end if;
  v := public.r2768_repair_invoice_line_periods(false);
  if (v->>'changed')::int <> 0 or v->>'run_id' is not null then raise exception 'FAIL A_DRY: %', v; end if;
  for r in select b.id from r2768_inv_before b join public.invoices i on i.id = b.id where to_jsonb(i) is distinct from b.row loop
    raise exception 'FAIL A_DRY: % changed', r.id;
  end loop;
  raise notice 'PASS a_plan + a_dry';
end $$;

-- ── A_APPLY ────────────────────────────────────────────────────────────────────
create temp table r2768_runs (repair text, run_id uuid, result jsonb) on commit drop;
insert into r2768_runs select 'A', (x->>'run_id')::uuid, x from (select public.r2768_repair_invoice_line_periods(true) as x) s;
do $$
declare v jsonb := (select line_items from public.invoices where id = 'INV-R2768-1'); r record;
begin
  if v->0->'service_period' is distinct from '{"from":"2026-12-02","to":"2027-12-01","months":12}'::jsonb
     or v->1->'service_period' is distinct from '{"from":"2026-12-02","to":"2027-12-01","months":12}'::jsonb
     or not (v->2 ? 'service_period') or jsonb_typeof(v->2->'service_period') <> 'null' then
    raise exception 'FAIL A_APPLY: periods %', v;
  end if;
  if public.r2768_lines_without(v, array['service_period']) is distinct from (select b.row->'line_items' from r2768_inv_before b where b.id = 'INV-R2768-1') then
    raise exception 'FAIL A_APPLY: something besides service_period changed in the lines';
  end if;
  for r in select b.id from r2768_inv_before b join public.invoices i on i.id = b.id
            where (to_jsonb(i) - 'line_items') is distinct from (b.row - 'line_items')
               or (b.id <> 'INV-R2768-1' and to_jsonb(i)->'line_items' is distinct from b.row->'line_items') loop
    raise exception 'FAIL A_APPLY: % changed beyond the stamp (updated_at / amount / other invoice)', r.id;
  end loop;
  if not exists (select 1 from public.r2768_repair_log g join r2768_runs u on u.run_id = g.run_id
                  where g.repair = 'A' and g.row_id = 'INV-R2768-1' and g.after = v) then
    raise exception 'FAIL A_APPLY: no log row';
  end if;
  if coalesce(current_setting('app.r2768_repair', true), '') <> '' then raise exception 'FAIL A_APPLY: flag left on'; end if;
  raise notice 'PASS a_apply';
end $$;

-- ── A_FREEZE ───────────────────────────────────────────────────────────────────
do $$
declare v_refused boolean;
begin
  -- flag off: adding the key to an unstamped invoice is refused (the freeze as before)
  v_refused := false;
  begin
    update public.invoices set line_items = (select jsonb_agg(l || '{"service_period":null}' order by i) from jsonb_array_elements(line_items) with ordinality e(l, i))
     where id = 'INV-R2768-2';
  exception when others then v_refused := true; end;
  if not v_refused then raise exception 'FAIL A_FREEZE: key added without the flag'; end if;
  perform set_config('app.r2768_repair', 'on', true);
  -- flag on + another column -> refused
  v_refused := false;
  begin
    update public.invoices set amount = amount + 1,
           line_items = (select jsonb_agg(l || '{"service_period":null}' order by i) from jsonb_array_elements(line_items) with ordinality e(l, i))
     where id = 'INV-R2768-2';
  exception when others then v_refused := true; end;
  if not v_refused then raise exception 'FAIL A_FREEZE: amount changed under the flag'; end if;
  -- flag on + a line's rate changed with the key -> refused
  v_refused := false;
  begin
    update public.invoices set line_items = jsonb_set((select jsonb_agg(l || '{"service_period":null}' order by i) from jsonb_array_elements(line_items) with ordinality e(l, i)), '{0,rate}', '1')
     where id = 'INV-R2768-2';
  exception when others then v_refused := true; end;
  if not v_refused then raise exception 'FAIL A_FREEZE: line rate changed under the flag'; end if;
  -- flag on + editing a STORED period -> refused
  v_refused := false;
  begin
    update public.invoices set line_items = jsonb_set(line_items, '{0,service_period}', '{"from":"2027-01-01","to":"2027-12-31","months":12}')
     where id = 'INV-R2768-1';
  exception when others then v_refused := true; end;
  if not v_refused then raise exception 'FAIL A_FREEZE: stored period edited under the flag'; end if;
  -- flag on + removing periods NOT recorded in the log (R-2744 stamped at issue) -> refused
  v_refused := false;
  begin
    update public.invoices set line_items = public.r2768_lines_without(line_items, array['service_period']) where id = 'INV-R2768-9';
  exception when others then v_refused := true; end;
  if not v_refused then raise exception 'FAIL A_FREEZE: an issue-time stamp removed under the flag'; end if;
  perform set_config('app.r2768_repair', '', true);
  raise notice 'PASS a_freeze';
end $$;

-- ── B fixtures + B_APPLY ───────────────────────────────────────────────────────
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status,
                           is_renewal, is_add_seats, extension_months, created_date, line_items, notes, plan, updated_at)
  values
  ('Q-R2768-B1','aaaaaaaa-2768-0000-0000-000000000001','cccccccc-2768-0000-0000-000000000001','Cust 2768',5900,5000,18,'sent','none',
   true, false, 12, '2026-11-01', '[{"name":"Business Starter","qty":1,"rate":5000,"commitment":"annual_yearly"}]',
   'Renewal quote (operator-generated) for subscription dddddddd-2768-0000-0000-000000000001', 'Business Starter', '2026-10-01T10:00:00Z'),
  ('Q-R2768-B2','aaaaaaaa-2768-0000-0000-000000000001','cccccccc-2768-0000-0000-000000000001','Cust 2768',5900,5000,18,'accepted','awaiting',
   false, true, 0, '2026-11-01', '[{"name":"Business Starter · +1 seats (pro-rata from 2026-09-25 to 2027-03-31)","qty":1,"rate":5000,"commitment":"annual_yearly"}]',
   'Add-seats pro-rata for subscription dddddddd-2768-0000-0000-000000000001. Effective date 2026-09-25 (backdated by E2E Owner on 2026-10-10). 188 of 365 days remaining (factor 51.5068%).',
   'Business Starter', '2026-10-01T10:00:00Z'),
  ('Q-R2768-B3','aaaaaaaa-2768-0000-0000-000000000001','cccccccc-2768-0000-0000-000000000001','Cust 2768',5900,5000,18,'draft','none',
   true, false, 12, '2026-11-01', '[{"name":"Business Starter","qty":1,"rate":5000,"commitment":"annual_yearly"}]',
   'Renewal quote (operator-generated) for subscription dddddddd-2768-0000-0000-000000000001', 'Business Starter', '2026-10-01T10:00:00Z'),
  ('Q-R2768-B4','aaaaaaaa-2768-0000-0000-000000000001','cccccccc-2768-0000-0000-000000000001','Cust 2768',5900,5000,18,'sent','none',
   true, false, 12, '2026-11-01', '[{"name":"Business Starter","qty":1,"rate":5000,"commitment":"annual_yearly"}]',
   E'Renewal of Business Starter for 12 months.\n\nStaff only (not shown to the customer):\nRenewal quote (operator-generated) for subscription dddddddd-2768-0000-0000-000000000001',
   'Business Starter', '2026-10-01T10:00:00Z');

create temp table r2768_q_before on commit drop as
  select id, to_jsonb(q) as row,
         lower((regexp_match(q.notes, 'subscription ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', 'i'))[1]) as link_ts,
         substring(q.notes from 'subscription ([0-9a-fA-F-]{36})') as link_sql
    from public.quotes q where q.notes is not null;

insert into r2768_runs select 'B', (x->>'run_id')::uuid, x from (select public.r2768_repair_quote_notes(true) as x) s;
do $$
declare r record; v_n int;
begin
  if (select notes from public.quotes where id = 'Q-R2768-B1')
     is distinct from E'Renewal of Business Starter for 12 months.\n\nStaff only (not shown to the customer):\nRenewal quote (operator-generated) for subscription dddddddd-2768-0000-0000-000000000001' then
    raise exception 'FAIL B_APPLY: B1 %', (select notes from public.quotes where id = 'Q-R2768-B1');
  end if;
  if (select notes from public.quotes where id = 'Q-R2768-B2') not like E'Additional seats from 25 Sep 2026 to 31 Mar 2027 (pro-rata).\n\nStaff only (not shown to the customer):\nAdd-seats pro-rata for subscription dddddddd-2768-0000-0000-000000000001.%' then
    raise exception 'FAIL B_APPLY: B2 %', (select notes from public.quotes where id = 'Q-R2768-B2');
  end if;
  -- draft and already-split notes untouched
  for r in select b.id from r2768_q_before b join public.quotes q on q.id = b.id
            where b.id in ('Q-R2768-B3', 'Q-R2768-B4') and to_jsonb(q) is distinct from b.row loop
    raise exception 'FAIL B_APPLY: % should be untouched', r.id;
  end loop;
  -- every changed quote: only notes changed (updated_at kept), customer part has no id, the link holds
  for r in select b.id, b.link_ts, b.link_sql, q.notes, (to_jsonb(q) - 'notes') = (b.row - 'notes') as same_rest
             from r2768_q_before b join public.quotes q on q.id = b.id
            where q.notes is distinct from b.row->>'notes' loop
    if not r.same_rest then raise exception 'FAIL B_APPLY: % changed more than notes', r.id; end if;
    if split_part(r.notes, 'Staff only (not shown to the customer):', 1) ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' then
      raise exception 'FAIL B_APPLY: % customer part still has an id', r.id;
    end if;
    if lower((regexp_match(r.notes, 'subscription ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', 'i'))[1]) is distinct from r.link_ts
       or substring(r.notes from 'subscription ([0-9a-fA-F-]{36})') is distinct from r.link_sql then
      raise exception 'FAIL B_APPLY: % renewal / add-seats link moved', r.id;
    end if;
  end loop;
  select count(*) into v_n from public.r2768_quote_notes_plan() p where p.verdict = 'rewrite';
  if v_n <> 0 then raise exception 'FAIL B_APPLY: % rewritable quotes left', v_n; end if;
  if coalesce(current_setting('app.r2768_repair', true), '') <> '' then raise exception 'FAIL B_APPLY: flag left on'; end if;
  raise notice 'PASS b_apply';
end $$;

-- ── IDEMPOTENT ─────────────────────────────────────────────────────────────────
do $$
declare a jsonb := public.r2768_repair_invoice_line_periods(true); b jsonb := public.r2768_repair_quote_notes(true);
begin
  if (a->>'changed')::int <> 0 or (b->>'changed')::int <> 0 then raise exception 'FAIL IDEMPOTENT: % / %', a, b; end if;
  if coalesce((a->'plan'->>'stamp')::int, 0) <> 0 or coalesce((b->'plan'->>'rewrite')::int, 0) <> 0 then
    raise exception 'FAIL IDEMPOTENT: plan not empty % / %', a->'plan', b->'plan';
  end if;
  raise notice 'PASS idempotent';
end $$;

-- ── UNDO ───────────────────────────────────────────────────────────────────────
do $$
declare r record; u jsonb;
begin
  for r in select * from r2768_runs where run_id is not null and repair in ('A', 'B') and (result->>'changed')::int > 0 loop
    u := public.r2768_undo(r.run_id);
    if (u->>'undone')::int <> (r.result->>'changed')::int then raise exception 'FAIL UNDO: % %', r.repair, u; end if;
    u := public.r2768_undo(r.run_id);
    if (u->>'undone')::int <> 0 then raise exception 'FAIL UNDO: second undo %', u; end if;
  end loop;
  for r in select b.id from r2768_inv_before b join public.invoices i on i.id = b.id where to_jsonb(i) is distinct from b.row loop
    raise exception 'FAIL UNDO: invoice % not back to before', r.id;
  end loop;
  for r in select b.id from r2768_q_before b join public.quotes q on q.id = b.id where to_jsonb(q) is distinct from b.row loop
    raise exception 'FAIL UNDO: quote % not back to before', r.id;
  end loop;
  raise notice 'PASS undo';
end $$;

-- ── GRANTS ─────────────────────────────────────────────────────────────────────
do $$
declare f text;
begin
  foreach f in array array['public.r2768_repair_invoice_line_periods(boolean)', 'public.r2768_repair_quote_notes(boolean)',
                           'public.r2768_undo(uuid)', 'public.r2768_invoice_line_period_plan()', 'public.r2768_quote_notes_plan()',
                           'public.r2768_freeze_allows(text,jsonb,jsonb)', 'public.r2768_repaired_notes(text,jsonb,text,integer)'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception 'FAIL GRANTS: % executable by anon/authenticated', f;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.r2768_repair_log', 'insert')
     or has_table_privilege('anon', 'public.r2768_repair_log', 'select') then
    raise exception 'FAIL GRANTS: r2768_repair_log writable by authenticated / readable by anon';
  end if;
  raise notice 'PASS grants';
end $$;

do $$ begin raise notice 'PASS r2768_repair'; end $$;
rollback;
