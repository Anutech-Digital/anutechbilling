-- R-1763 — a subscription imported from Zoho Books keeps its Zoho invoice and its current term is
-- never invoiced again here (migration 20261022*_r1763_zoho_import_billed_in_zoho).
--
-- Self-asserting: RAISEs on failure. One transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/zoho_import_billed_in_zoho_r1763.test.sql
--
-- The owner's case (22 Oct, local import): ska-group-like subscription opened in the drawer
-- said "THIS TERM … DATE PASSED · scheduled, not invoiced" and external_ref was null. Worse, a
-- MONTHLY imported subscription is split-billed, and the billing cron would lay this term's
-- instalment into subscription_billings and invoice it — Zoho already did.
--
-- What it proves:
--   1. The import step stores external_source 'zoho_books', external_ref = the Zoho invoice
--      number, external_ref_date, and billed_externally_until = the imported renewal date.
--   2. An instalment for a period inside the imported term is refused ("already billed in
--      Zoho Books (INV-…)"); the NEXT term's instalment is allowed.
--   3. An instalment row filed before the mark cannot be invoiced (invoice_id set) afterwards.
--   4. A subscription made here (no billed_externally_until) bills as before.

begin;

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c1763000-0000-0000-0000-0000000000a1'::uuid, 'T-R1763 A', 'r1763-a@example.in', '07', 'TRC');
insert into auth.users (id, email) values ('c1763000-0000-0000-0000-00000000a0a1', 'r1763-owner-a@example.test');
insert into public.users (id, tenant_id, email, role, full_name) values
  ('c1763000-0000-0000-0000-00000000a0a1', 'c1763000-0000-0000-0000-0000000000a1', 'r1763-owner-a@example.in', 'owner', 'Owner A');
insert into public.zoho_books_import_runs (id, tenant_id, org_id, since, phase, scanned_at) values
  ('c1763000-0000-0000-0000-0000000f0001', 'c1763000-0000-0000-0000-0000000000a1', '60000003', '2024-10-22', 'ready', now());

set local role authenticated;

-- ── 1. Import stores the Zoho source ─────────────────────────────────────────────────────
do $$
declare v jsonb; n int := 0; r record;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1763000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  v := public.zoho_books_import_begin('c1763000-0000-0000-0000-0000000f0001',
    '[{"zoho_id":"z-1","name":"T-SKA Group","gstin":null,"gst_treatment":null,"state":"Delhi","state_code":"07",
       "payment_terms_days":15,"customer_type":"business","contact_name":null,"contact_email":null,"contact_phone":null,"since":"2025-06-20"}]'::jsonb,
    '[{"zoho_customer_id":"z-1","customer_name":"T-SKA Group","plan":"Google Workspace Business Starter - User License (Resale)","vendor":"google",
       "seats":4,"mrr":600,"start_date":"2025-06-20","renewal_date":"2027-06-19","domain":"t-ska.in","billing_cycle":"yearly","term_months":12,
       "source_invoice":"INV-T-000871","source_invoice_date":"2026-06-22","prorata_seats":0,"from_service_expiry":false},
      {"zoho_customer_id":"z-1","customer_name":"T-SKA Group","plan":"Microsoft 365 Business Basic","vendor":"microsoft",
       "seats":2,"mrr":300,"start_date":"2026-10-01","renewal_date":"2026-10-31","domain":"t-ska-m.in","billing_cycle":"monthly","term_months":1,
       "source_invoice":"INV-T-000990","source_invoice_date":"2026-10-01","prorata_seats":0,"from_service_expiry":false}]'::jsonb,
    '[]'::jsonb);
  while not coalesce((v->>'done')::boolean, false) and n < 10 loop
    v := public.zoho_books_import_step('c1763000-0000-0000-0000-0000000f0001', 150);
    n := n + 1;
  end loop;
  select external_source, external_ref, external_ref_date, billed_externally_until into r
    from public.subscriptions where tenant_id = 'c1763000-0000-0000-0000-0000000000a1' and domain = 't-ska.in';
  if r.external_source is distinct from 'zoho_books' or r.external_ref is distinct from 'INV-T-000871'
     or r.external_ref_date is distinct from '2026-06-22'::date or r.billed_externally_until is distinct from '2027-06-19'::date then
    raise exception 'FAIL 1: imported subscription source = %', row_to_json(r);
  end if;
  raise notice 'PASS 1: imported subscription keeps Zoho INV-T-000871 (22 Jun 2026), billed in Zoho until 19 Jun 2027';
end $$;

reset role;

-- ── 2–4. subscription_billings guard ─────────────────────────────────────────────────────
do $$
declare v_sub uuid; v_here uuid; v_bill uuid;
begin
  select id into v_sub from public.subscriptions where tenant_id = 'c1763000-0000-0000-0000-0000000000a1' and domain = 't-ska-m.in';

  begin
    insert into public.subscription_billings (tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount)
    values ('c1763000-0000-0000-0000-0000000000a1', v_sub, '2026-10-01', 1, '2026-10-01', '2026-10-01', '2026-11-01', 600);
    raise exception 'FAIL 2a: an instalment of the term Zoho billed was laid';
  exception when others then
    if sqlerrm not like '%already billed in Zoho Books (INV-T-000990)%' then raise; end if;
  end;
  insert into public.subscription_billings (tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount)
  values ('c1763000-0000-0000-0000-0000000000a1', v_sub, '2026-11-01', 1, '2026-11-01', '2026-11-01', '2026-12-01', 600);
  raise notice 'PASS 2: this term refused (billed in Zoho), next term laid as usual';

  -- 3. A row filed before the mark cannot be invoiced after it.
  update public.subscriptions set billed_externally_until = null where id = v_sub;
  insert into public.subscription_billings (tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount)
  values ('c1763000-0000-0000-0000-0000000000a1', v_sub, '2026-10-01', 1, '2026-10-01', '2026-10-01', '2026-11-01', 600)
  returning id into v_bill;
  update public.subscriptions set billed_externally_until = '2026-10-31' where id = v_sub;
  insert into public.invoices (id, tenant_id, customer_name, amount) values ('INV-T1763-1', 'c1763000-0000-0000-0000-0000000000a1', 'T-SKA Group', 708);
  begin
    update public.subscription_billings set invoice_id = 'INV-T1763-1' where id = v_bill;
    raise exception 'FAIL 3: a period billed in Zoho was invoiced here';
  exception when others then
    if sqlerrm not like '%already billed in Zoho Books%' then raise; end if;
  end;
  update public.subscription_billings set taxable_amount = 650 where id = v_bill;   -- other edits still fine
  raise notice 'PASS 3: an instalment filed earlier cannot be invoiced once the term is billed in Zoho';

  -- 4. Made here: no mark, bills as before.
  insert into public.subscriptions (tenant_id, customer_name, plan, vendor, seats, mrr, domain, start_date, renewal_date, billing_cycle, term_months)
  values ('c1763000-0000-0000-0000-0000000000a1', 'T-SKA Group', 'Microsoft 365 Business Basic', 'microsoft', 1, 150, 't-here.in',
          '2026-10-01', '2026-10-31', 'monthly', 1) returning id into v_here;
  insert into public.subscription_billings (tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount)
  values ('c1763000-0000-0000-0000-0000000000a1', v_here, '2026-10-01', 1, '2026-10-01', '2026-10-01', '2026-11-01', 150)
  returning id into v_bill;
  update public.subscription_billings set invoice_id = 'INV-T1763-1' where id = v_bill;
  raise notice 'PASS 4: a subscription made here is laid and invoiced as before';
end $$;

rollback;
