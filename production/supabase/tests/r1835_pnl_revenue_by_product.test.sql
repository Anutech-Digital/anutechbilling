-- Regression test: R-1835 — report_pnl_revenue_by_product splits the P&L's Revenue by what was
-- sold, and the parts add up to report_pnl's Revenue to the rupee.
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r1835_pnl_revenue_by_product.test.sql
--
-- 1. revenue_family — table-driven: item vendor first, then hostingPlan, then the line's name.
-- 2. Tenant A, Oct 2026 (mixed invoices):
--      GW    Google Workspace item, 10 × 3,240                          → google 32,400
--      MIX   no items: "Microsoft 365 Business Basic" 5 × 1,000, a hosting line (hostingPlan)
--            1,500, "Domain …" 649, "Email migration" 5,000 — taxable 10,001 (a discount), shared
--            by qty × rate with the largest remainder: m365 4,116 · hosting 1,235 · domain 534 · other 4,116
--      QZ    quote-linked, no lines of its own → the quote's Zoho item 3 × 1,000 → zoho 3,000
--      SUP   SUP- support item                                            → support 2,000
--      PRJ   project milestone invoice (line "Website build")              → projects 50,000
--      NOL   no lines anywhere, amount 1,180 @18% (no taxable_value)       → other 1,000
--      left out: an opening (Zoho import) invoice, a draft, a September invoice, tenant B.
--    Notes in October: CN 1,000 on the September Google invoice → google; CN 3,001 on MIX →
--    pro-rata m365 1,235 · hosting 371 · domain 160 · other 1,235; DN 500 on PRJ → projects.
--    Σ invoiced = report_pnl.inv_taxable, Σ credit = cn_taxable, Σ debit = dn_taxable, and
--    Σ (invoiced − credit + debit) = Revenue (inv − cn + dn) — exactly.
-- 3. Mutation check: a new hosting invoice moves hosting (and only hosting) by its value; the
--    sums still equal report_pnl.
-- 4. No company → refused (fails closed); tenant B sees only its own invoice.

begin;

-- ── 1. revenue_family, table-driven ──────────────────────────────────────────────────────
do $$
declare r record; got text; bad text := '';
begin
  for r in select * from (values
    ('google',    '{"name":"anything"}',                                   'google'),
    ('microsoft', '{"name":"Google Workspace"}',                           'microsoft'),  -- item vendor wins
    ('zoho',      '{}',                                                    'zoho'),
    ('hosting',   '{"name":"x"}',                                          'hosting'),
    ('domain',    '{"name":"x"}',                                          'domain'),
    ('support',   '{"name":"Premium support"}',                            'support'),
    ('other',     '{"name":"Positive SSL (Yearly)"}',                      'other'),
    ('other',     '{"name":"Google Workspace Business Starter"}',          'google'),     -- vendor other → the text
    (null,        '{"name":"E2E Google Workspace Business Starter"}',      'google'),
    (null,        '{"name":"G Suite Basic"}',                              'google'),
    (null,        '{"name":"Business Starter · +1 seats (pro-rata)"}',     'google'),
    (null,        '{"name":"Business Plus"}',                              'google'),
    (null,        '{"name":"Microsoft 365 Business Basic"}',               'microsoft'),
    (null,        '{"name":"M365 E3"}',                                    'microsoft'),
    (null,        '{"name":"Office 365 E1"}',                              'microsoft'),
    (null,        '{"name":"Exchange Online Plan 1"}',                     'microsoft'),
    (null,        '{"name":"Business Premium"}',                           'microsoft'),
    (null,        '{"name":"Business Standard"}',                          'other'),      -- both vendors sell it
    (null,        '{"name":"Zoho Mail Lite"}',                             'zoho'),
    (null,        '{"name":"Standard hosting (billed yearly)"}',           'hosting'),
    (null,        '{"name":"Starter","hostingPlan":"starter"}',            'hosting'),
    (null,        '{"name":"cPanel account"}',                             'hosting'),
    (null,        '{"name":"Domain mytestshop.in — registration, 1 year"}','domain'),
    (null,        '{"name":"mytestshop.in","domain":"mytestshop.in","years":1}', 'domain'),
    (null,        '{"name":"T-N1 Email migration (one-time)"}',            'other'),
    (null,        '{"name":"Anutech Mail mailbox (Yearly)"}',              'other'),
    (null,        '{}',                                                    'other'),
    (null,        '{"name":"Zohoish thing"}',                              'other')       -- whole word only
  ) as t(vendor, line, want)
  loop
    got := public.revenue_family(r.vendor, r.line::jsonb);
    if got is distinct from r.want then bad := bad || format(E'\n  %s / %s → %s (want %s)', r.vendor, r.line, got, r.want); end if;
  end loop;
  if bad <> '' then raise exception 'FAIL 1: revenue_family:%', bad; end if;
end $$;

-- ── 2. Fixture ─────────────────────────────────────────────────────────────────────────
insert into public.tenants (id, name, email, state_code) values
  ('d1835000-0000-0000-0000-0000000000a1', 'R1835 A', 'r1835-a@example.in', '07'),
  ('d1835000-0000-0000-0000-0000000000b1', 'R1835 B', 'r1835-b@example.in', '07');
insert into auth.users (id, email) values
  ('d1835000-0000-0000-0000-0000000000a2', 'r1835-user-a@example.test'),
  ('d1835000-0000-0000-0000-0000000000b2', 'r1835-user-b@example.test'),
  ('d1835000-0000-0000-0000-0000000000c2', 'r1835-nobody@example.test');
insert into public.users (id, tenant_id, email, role) values
  ('d1835000-0000-0000-0000-0000000000a2', 'd1835000-0000-0000-0000-0000000000a1', 'r1835-user-a@example.in', 'owner'),
  ('d1835000-0000-0000-0000-0000000000b2', 'd1835000-0000-0000-0000-0000000000b1', 'r1835-user-b@example.in', 'owner');

insert into public.items (id, tenant_id, name, vendor, msrp, wholesale) values
  ('R1835-GW',   'd1835000-0000-0000-0000-0000000000a1', 'Google Workspace Business Starter', 'google',  3240, 1320),
  ('R1835-ZOHO', 'd1835000-0000-0000-0000-0000000000a1', 'Mail Lite',                         'zoho',    1000, 600),
  ('SUP-R1835',  'd1835000-0000-0000-0000-0000000000a1', 'Premium support plan',              'support', 2000, 0);

insert into public.quotes (id, tenant_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items) values
  ('Q-R1835-Z', 'd1835000-0000-0000-0000-0000000000a1', 'Cust A', 3540, 3000, 18, 'sent', 'awaiting',
   '[{"id":"q1","name":"Mail Lite","item_id":"R1835-ZOHO","qty":3,"rate":1000}]');

-- QZ is an invoice issued before 20261009180000 (no lines of its own, the quote has them): the
-- copy-quote-lines trigger is off for this one insert so its line_items stay NULL.
alter table public.invoices disable trigger trg_invoice_copy_quote_lines;
insert into public.invoices (id, tenant_id, customer_name, amount, taxable_value, tax_amount, tax_rate, status, invoice_date, document_kind, quote_id, line_items) values
  ('R1835-QZ',  'd1835000-0000-0000-0000-0000000000a1', 'Cust A', 3540,  3000,  540,  18, 'overdue', '2026-10-07', 'tax_invoice', 'Q-R1835-Z', null);
alter table public.invoices enable trigger trg_invoice_copy_quote_lines;
do $$ begin
  if (select line_items from public.invoices where id = 'R1835-QZ') is not null then
    raise exception 'FAIL 0: fixture — QZ should have no lines of its own';
  end if;
end $$;

insert into public.invoices (id, tenant_id, customer_name, amount, taxable_value, tax_amount, tax_rate, status, invoice_date, document_kind, quote_id, line_items) values
  ('R1835-GW',  'd1835000-0000-0000-0000-0000000000a1', 'Cust A', 38232, 32400, 5832, 18, 'paid',    '2026-10-03', 'tax_invoice', null,
   '[{"id":"l1","name":"Business Starter","item_id":"R1835-GW","qty":10,"rate":3240}]'),
  ('R1835-MIX', 'd1835000-0000-0000-0000-0000000000a1', 'Cust A', 11801, 10001, 1800, 18, 'pending', '2026-10-05', 'tax_invoice', null,
   '[{"id":"l1","name":"Microsoft 365 Business Basic","qty":5,"rate":1000},
     {"id":"l2","name":"Standard hosting (billed yearly)","hostingPlan":"standard","qty":1,"rate":1500},
     {"id":"l3","name":"Domain mix.in — registration, 1 year","qty":1,"rate":649},
     {"id":"l4","name":"Email migration (one-time)","qty":1,"rate":5000}]'),
  ('R1835-SUP', 'd1835000-0000-0000-0000-0000000000a1', 'Cust A', 2360,  2000,  360,  18, 'paid',    '2026-10-08', 'tax_invoice', null,
   '[{"id":"l1","name":"Support","item_id":"SUP-R1835","qty":1,"rate":2000}]'),
  ('R1835-PRJ', 'd1835000-0000-0000-0000-0000000000a1', 'Cust A', 59000, 50000, 9000, 18, 'paid',    '2026-10-09', 'tax_invoice', null,
   '[{"id":"l1","name":"Website build — milestone 1","qty":1,"rate":50000}]'),
  ('R1835-NOL', 'd1835000-0000-0000-0000-0000000000a1', 'Cust A', 1180,  null,  null, 18, 'paid',    '2026-10-10', 'tax_invoice', null, null),
  -- left out of invoiced:
  ('R1835-DRF', 'd1835000-0000-0000-0000-0000000000a1', 'Cust A', 11800, 10000, 1800, 18, 'draft',   '2026-10-12', 'tax_invoice', null,
   '[{"id":"l1","name":"Google Workspace","qty":1,"rate":10000}]'),
  ('R1835-SEP', 'd1835000-0000-0000-0000-0000000000a1', 'Cust A', 9177,  7777,  1400, 18, 'paid',    '2026-09-20', 'tax_invoice', null,
   '[{"id":"l1","name":"Google Workspace Business Starter","qty":1,"rate":7777}]'),
  ('R1835-B',   'd1835000-0000-0000-0000-0000000000b1', 'Cust B', 117999, 99999, 18000, 18, 'paid',  '2026-10-03', 'tax_invoice', null,
   '[{"id":"l1","name":"Google Workspace","qty":1,"rate":99999}]');

-- an imported Zoho opening invoice (only the import may write one) — not revenue
select set_config('app.opening_invoice_import', 'on', true);
insert into public.invoice_import_batches (id, tenant_id) values
  ('d1835000-0000-0000-0000-0000000000e1', 'd1835000-0000-0000-0000-0000000000a1');
insert into public.invoices (id, tenant_id, customer_name, amount, taxable_value, tax_amount, tax_rate, status, invoice_date, document_kind,
                             opening_balance, external_number, import_batch_id, line_items) values
  ('R1835-OPN', 'd1835000-0000-0000-0000-0000000000a1', 'Cust A', 10000, 10000, 0, 0, 'pending', '2026-10-11', 'opening_invoice',
   10000, 'ZB-1', 'd1835000-0000-0000-0000-0000000000e1', '[{"id":"l1","name":"Google Workspace","qty":1,"rate":10000}]');
select set_config('app.opening_invoice_import', '', true);

insert into public.project_sales (id, tenant_id, customer_name, title, gst_rate, inter_state, taxable_amount, gst_amount, total_amount, status) values
  ('d1835000-0000-0000-0000-0000000000f1', 'd1835000-0000-0000-0000-0000000000a1', 'Cust A', 'Website', 18, false, 50000, 9000, 59000, 'active');
insert into public.project_milestones (id, tenant_id, project_id, seq, label, total_amount, invoice_id) values
  ('d1835000-0000-0000-0000-0000000000f2', 'd1835000-0000-0000-0000-0000000000a1', 'd1835000-0000-0000-0000-0000000000f1', 1, 'M1', 59000, 'R1835-PRJ');

insert into public.credit_notes (id, tenant_id, invoice_id, customer_name, reason_code, amount, taxable_value, tax_amount, tax_rate, credit_date) values
  ('CN-R1835-SEP', 'd1835000-0000-0000-0000-0000000000a1', 'R1835-SEP', 'Cust A', 'other', 1180, 1000, 180, 18, '2026-10-15'),
  ('CN-R1835-MIX', 'd1835000-0000-0000-0000-0000000000a1', 'R1835-MIX', 'Cust A', 'other', 3541, 3001, 540, 18, '2026-10-16');
insert into public.debit_notes (id, tenant_id, invoice_id, customer_name, reason_code, amount, taxable_value, tax_amount, tax_rate, debit_date) values
  ('DN-R1835-PRJ', 'd1835000-0000-0000-0000-0000000000a1', 'R1835-PRJ', 'Cust A', 'other', 590, 500, 90, 18, '2026-10-17');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'd1835000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);

create temp table r1835_want (family text, invoiced bigint, credit_notes bigint, debit_notes bigint, invoice_count int) on commit drop;
insert into r1835_want values
  ('google',    32400, 1000, 0,   1),
  ('microsoft', 4116,  1235, 0,   1),
  ('hosting',   1235,  371,  0,   1),
  ('domain',    534,   160,  0,   1),
  ('other',     5116,  1235, 0,   2),
  ('zoho',      3000,  0,    0,   1),
  ('support',   2000,  0,    0,   1),
  ('projects',  50000, 0,    500, 1);

do $$
declare p record; diff text; si bigint; sc bigint; sd bigint; net bigint;
begin
  select * into p from public.report_pnl('2026-10-01', '2026-10-31');
  select coalesce(sum(r.invoiced), 0), coalesce(sum(r.credit_notes), 0), coalesce(sum(r.debit_notes), 0),
         coalesce(sum(r.invoiced - r.credit_notes + r.debit_notes), 0)
    into si, sc, sd, net
    from public.report_pnl_revenue_by_product('2026-10-01', '2026-10-31') r;
  if si <> p.inv_taxable then raise exception 'FAIL 2a: Σ invoiced % <> report_pnl.inv_taxable %', si, p.inv_taxable; end if;
  if sc <> p.cn_taxable then raise exception 'FAIL 2b: Σ credit % <> report_pnl.cn_taxable %', sc, p.cn_taxable; end if;
  if sd <> p.dn_taxable then raise exception 'FAIL 2c: Σ debit % <> report_pnl.dn_taxable %', sd, p.dn_taxable; end if;
  if net <> p.inv_taxable - p.cn_taxable + p.dn_taxable or net <> 98401 - 4001 + 500 then
    raise exception 'FAIL 2d: Σ net % <> Revenue % (want 94900)', net, p.inv_taxable - p.cn_taxable + p.dn_taxable;
  end if;
  select string_agg(format('%s: got %s want %s', coalesce(g.family, w.family), row(g.invoiced, g.credit_notes, g.debit_notes, g.invoice_count),
                           row(w.invoiced, w.credit_notes, w.debit_notes, w.invoice_count)), E'\n  ')
    into diff
    from public.report_pnl_revenue_by_product('2026-10-01', '2026-10-31') g
    full join r1835_want w on w.family = g.family
   where row(g.invoiced, g.credit_notes, g.debit_notes, g.invoice_count) is distinct from row(w.invoiced, w.credit_notes, w.debit_notes, w.invoice_count);
  if diff is not null then raise exception E'FAIL 2e: families differ:\n  %', diff; end if;
end $$;

-- ── 3. Mutation: a new ₹2,000 hosting invoice moves hosting only ─────────────────────────
reset role;
insert into public.invoices (id, tenant_id, customer_name, amount, taxable_value, tax_amount, tax_rate, status, invoice_date, document_kind, line_items) values
  ('R1835-H2', 'd1835000-0000-0000-0000-0000000000a1', 'Cust A', 2360, 2000, 360, 18, 'paid', '2026-10-20', 'tax_invoice',
   '[{"id":"l1","name":"Business hosting (billed yearly)","qty":1,"rate":2000}]');
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'd1835000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);
do $$
declare p record; h bigint; g bigint; si bigint;
begin
  select * into p from public.report_pnl('2026-10-01', '2026-10-31');
  select r.invoiced into h from public.report_pnl_revenue_by_product('2026-10-01', '2026-10-31') r where r.family = 'hosting';
  select r.invoiced into g from public.report_pnl_revenue_by_product('2026-10-01', '2026-10-31') r where r.family = 'google';
  select sum(r.invoiced) into si from public.report_pnl_revenue_by_product('2026-10-01', '2026-10-31') r;
  if h is distinct from 3235 then raise exception 'FAIL 3a: hosting % after a ₹2,000 hosting invoice (want 3235)', h; end if;
  if g is distinct from 32400 then raise exception 'FAIL 3b: google moved to % (want 32400)', g; end if;
  if si <> p.inv_taxable then raise exception 'FAIL 3c: Σ invoiced % <> inv_taxable %', si, p.inv_taxable; end if;
end $$;

-- ── 4. Tenant B sees only its own; no company → refused ─────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub', 'd1835000-0000-0000-0000-0000000000b2', 'role', 'authenticated')::text, true);
do $$
declare n int; g bigint;
begin
  select count(*), sum(r.invoiced) filter (where r.family = 'google') into n, g
    from public.report_pnl_revenue_by_product('2026-10-01', '2026-10-31') r;
  if n <> 1 or g is distinct from 99999 then raise exception 'FAIL 4a: tenant B sees % families, google % (want 1, 99999)', n, g; end if;
end $$;
select set_config('request.jwt.claims', json_build_object('sub', 'd1835000-0000-0000-0000-0000000000c2', 'role', 'authenticated')::text, true);
do $$
begin
  perform * from public.report_pnl_revenue_by_product('2026-10-01', '2026-10-31');
  raise exception 'FAIL 4b: a login with no company was not refused';
exception when insufficient_privilege then
  if sqlerrm not like 'P&L nahi ban sakta%' then raise exception 'FAIL 4c: wrong refusal: %', sqlerrm; end if;
end $$;

reset role;
select 'R-1835 report_pnl_revenue_by_product: all checks passed' as result;
rollback;
