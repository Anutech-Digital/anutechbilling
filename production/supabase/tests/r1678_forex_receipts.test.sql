-- R-1678 (+ R-2171's export-invoice-from-USD-receipt part), 5 Nov 2026, p1 money:
-- a ₹ receipt that settles a foreign-currency invoice, several USD invoices on one inward credit,
-- the "Exchange gain / loss (realised)" ledger, and the inward remittance reference on an export
-- invoice. Migration 20261105175200_r1678_forex_receipts_export_ref.
-- Self-asserting, ONE transaction, rolled back. Local/test DB only.
-- RED without the migration (A: reconcile_bank_credit_split refuses p_rest 'fx').
--
--   A. Peak Performance (R-2094 #7): USD 139 invoice @ 95.007 = ₹13,206; the bank credits ₹12,976 in
--      ₹ (no "USD…@" in the narration) → ONE receipt of ₹13,206 settles the invoice in full (paid,
--      nothing due), and ₹230 is an "Exchange gain / loss (realised)" line (a loss) on the bank
--      line's date, tied to the line. No TDS, no round-off, no settlement shortfall; the P&L shows
--      the ₹230 under that ledger; the Trial Balance stays balanced. The invoice keeps its rate.
--   B. Timbergloss (R-2094 #10): USD 759 @ 95.17 = ₹72,234; "INW … USD759.0@93.55" ₹71,004 →
--      paid in full, ₹1,230 loss; the invoice records the inward reference 050826I049900010.
--   C. Several USD invoices on ONE inward credit (R-2094 #27, Bot Workshop): $1,000 @ 90 (₹90,000)
--      + $500 @ 92 (₹46,000), "INW … USD1500.0@95" ₹1,42,500 → both paid in full; the ₹6,500 gain
--      is split by each invoice's USD: ₹5,000 + ₹1,500 (fx_parts); one gain line of −₹6,500;
--      both invoices carry the inward reference; TB balanced.
--   D. Refused, nothing booked: 'fx' on a ₹ invoice; 'fx' with an item paid in part; 'fx' with a new
--      sale; a ₹ receipt more than 10% away from the invoices' ₹ value (not an exchange difference);
--      a remittance in another currency; a remittance with more dollars than are due.
--   E. Un-reconciling A's line removes its exchange line.
--   F. A new export sale from a USD inward credit (reconcile_bank_credit_new_sale_fx, R-2440/R-2444):
--      invoice dated the bank line's date (not today), overseas, place of supply 96, 0% GST, USD at
--      the bank's rate, and the inward reference recorded.
--   G. R-2427's single-invoice path books its exchange difference under the same ledger name.

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
  ('dddddddd-0000-0000-0000-000000167801','R1678 Export Co','r1678@example.in','07','R1678');
insert into public.tenant_luts (tenant_id, fy_start, arn, valid_from, valid_upto)
select 'dddddddd-0000-0000-0000-000000167801'::uuid, g.fy::date, 'AD07TESTLUT' || to_char(g.fy, 'YY'), g.fy::date, (g.fy + interval '1 year' - interval '1 day')::date
  from generate_series('2024-04-01'::date, public.lut_fy_start(public.ist_today()), interval '1 year') as g(fy)
on conflict (tenant_id, fy_start) do nothing;

insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000167801','owner1678@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000167801','dddddddd-0000-0000-0000-000000167801','owner1678@example.in','Owner 1678','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, country, domain) values
  ('cccccccc-0000-0000-0000-000000167801','dddddddd-0000-0000-0000-000000167801','Peak Performance Hackers',null,'United States','peak1678.example'),
  ('cccccccc-0000-0000-0000-000000167802','dddddddd-0000-0000-0000-000000167801','Timbergloss Industries',null,'United Arab Emirates','timber1678.example'),
  ('cccccccc-0000-0000-0000-000000167803','dddddddd-0000-0000-0000-000000167801','The Bot Workshop LLC',null,'United States','bot1678.example'),
  ('cccccccc-0000-0000-0000-000000167804','dddddddd-0000-0000-0000-000000167801','Acme India 1678','07','India','acme1678.in');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000167801','dddddddd-0000-0000-0000-000000167801','HDFC Current','HDFC');

insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items, is_one_off, created_date,
                           currency, exchange_rate)
select v.id, 'dddddddd-0000-0000-0000-000000167801'::uuid, v.cust, v.cname, v.amt, v.amt, 0, 0, 'accepted', 'awaiting', 'yearly',
       jsonb_build_array(jsonb_build_object('name', 'Services ' || v.id, 'qty', 1, 'rate', v.amt, 'one_time', true)),
       true, '2026-07-01', v.cur, v.rate
  from (values
    ('Q-R1678-PEAK',  'cccccccc-0000-0000-0000-000000167801'::uuid, 'Peak Performance Hackers', 13206, 'USD', 95.007::numeric),
    ('Q-R1678-TIMB',  'cccccccc-0000-0000-0000-000000167802'::uuid, 'Timbergloss Industries',   72234, 'USD', 95.17::numeric),
    ('Q-R1678-BOT1',  'cccccccc-0000-0000-0000-000000167803'::uuid, 'The Bot Workshop LLC',     90000, 'USD', 90::numeric),
    ('Q-R1678-BOT2',  'cccccccc-0000-0000-0000-000000167803'::uuid, 'The Bot Workshop LLC',     46000, 'USD', 92::numeric),
    ('Q-R1678-BOT3',  'cccccccc-0000-0000-0000-000000167803'::uuid, 'The Bot Workshop LLC',     47000, 'USD', 94::numeric),
    ('Q-R1678-EUR',   'cccccccc-0000-0000-0000-000000167803'::uuid, 'The Bot Workshop LLC',     50000, 'EUR', 100::numeric),
    ('Q-R1678-INR',   'cccccccc-0000-0000-0000-000000167804'::uuid, 'Acme India 1678',          10000, 'INR', 1::numeric)
  ) as v(id, cust, cname, amt, cur, rate);

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000167801','dddddddd-0000-0000-0000-000000167801','bbbbbbbb-0000-0000-0000-000000167801','2026-09-03','NEFT CR-CITI0000001-PEAK PERFORMANCE HACKERS',0,12976,'CITIN26000001','manual'),
  ('11111111-0000-0000-0000-000000167802','dddddddd-0000-0000-0000-000000167801','bbbbbbbb-0000-0000-0000-000000167801','2026-08-05','INW 050826I049900010 USD759.0@93.55',0,71004,null,'manual'),
  ('11111111-0000-0000-0000-000000167803','dddddddd-0000-0000-0000-000000167801','bbbbbbbb-0000-0000-0000-000000167801','2026-09-10','INW 100926I049900020 USD1500.0@95',0,142500,null,'manual'),
  ('11111111-0000-0000-0000-000000167804','dddddddd-0000-0000-0000-000000167801','bbbbbbbb-0000-0000-0000-000000167801','2026-09-11','NEFT CR-ACME INDIA',0,9000,'UTR1678004','manual'),
  ('11111111-0000-0000-0000-000000167805','dddddddd-0000-0000-0000-000000167801','bbbbbbbb-0000-0000-0000-000000167801','2026-09-12','NEFT CR-BOT WORKSHOP',0,40000,'UTR1678005','manual'),
  ('11111111-0000-0000-0000-000000167806','dddddddd-0000-0000-0000-000000167801','bbbbbbbb-0000-0000-0000-000000167801','2026-09-13','INW 130926I049900060 EUR500.0@100',0,50000,null,'manual'),
  ('11111111-0000-0000-0000-000000167807','dddddddd-0000-0000-0000-000000167801','bbbbbbbb-0000-0000-0000-000000167801','2026-09-14','INW 140926I049900070 USD600.0@94',0,56400,null,'manual'),
  ('11111111-0000-0000-0000-000000167808','dddddddd-0000-0000-0000-000000167801','bbbbbbbb-0000-0000-0000-000000167801','2026-08-07','INW 070826I049902623 USD1024.0@93.6',0,95846,null,'manual'),
  ('11111111-0000-0000-0000-000000167809','dddddddd-0000-0000-0000-000000167801','bbbbbbbb-0000-0000-0000-000000167801','2026-08-20','INW 200826I049900090 USD1000.0@84.5',0,84500,null,'manual');

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000167801","role":"authenticated"}', true);
select public.generate_invoice(q) from unnest(array['Q-R1678-PEAK','Q-R1678-TIMB','Q-R1678-BOT1','Q-R1678-BOT2','Q-R1678-BOT3','Q-R1678-EUR','Q-R1678-INR']) q;

create function pg_temp.inv(p_quote text) returns text language sql as $f$ select invoice_id from public.quotes where id = p_quote $f$;

/* Dr − Cr of the derived Trial Balance (copy of tb_money_events_balanced.test.sql's tb_gap). */
create function pg_temp.tb_gap() returns bigint language plpgsql as $$
declare
  b record; p record;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_fy date;
  v_dues bigint; v_gst bigint; v_assets bigint; v_liab bigint; v_profit bigint;
begin
  select * into b from public.report_balance_sheet(null);
  v_fy := make_date(b.fy_start_year, 4, 1);
  select * into p from public.report_pnl(v_fy, v_today);
  v_dues := b.dues_salary_tds + b.dues_pf + b.dues_esi + b.dues_vendor_tds
          - coalesce((select sum((x->>'amount')::bigint) from jsonb_array_elements(b.dues_paid) x), 0);
  v_gst  := b.gst_output - b.bills_gst
          - coalesce((select sum((x->>'amount')::bigint) from jsonb_array_elements(b.tax_payments) x where x->>'kind' = 'gst'), 0);
  v_assets := b.cash_and_bank + b.undeposited_funds + b.receivables + b.project_receivable + b.tds_receivable
            + b.employee_loans + b.prepaid_advances + b.emi_unregistered_cost
            - b.expenses_paid_unbanked;
  v_liab   := b.credit_card_payable + b.payables + b.advances_from_customers + b.salary_payable + v_dues
            + b.reimbursements_payable + b.emi_loans_payable + b.business_loans_payable + v_gst
            + b.expenses_payable + b.salary_other_deductions;
  v_profit := (p.inv_taxable - p.cn_taxable + p.dn_taxable) - p.cogs - p.commissions
            - coalesce((select sum((x->>'amount')::bigint) from jsonb_array_elements(p.expense_groups) x), 0);
  return v_assets - v_liab - v_profit;
end $$;

do $$
declare
  c_t   constant uuid := 'dddddddd-0000-0000-0000-000000167801';
  c_fx  constant text := 'Exchange gain / loss (realised)';
  r jsonb; ok boolean; v_msg text; n int; i record; p record; e record; v_inv text; v_inv2 text; g bigint; v_part jsonb;
  v_pnl jsonb;
begin
  select currency, fx_rate, amount into i from public.invoices where id = pg_temp.inv('Q-R1678-PEAK');
  if i.currency is distinct from 'USD' or i.fx_rate is distinct from 95.007 or i.amount <> 13206 then
    raise exception 'FIXTURE: Peak invoice is % % ₹%', i.currency, i.fx_rate, i.amount;
  end if;
  g := pg_temp.tb_gap();

  -- ── A. ₹ receipt short of a USD invoice → exchange loss, invoice paid ─────────────────────
  v_inv := pg_temp.inv('Q-R1678-PEAK');
  r := public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000167801', 'cccccccc-0000-0000-0000-000000167801',
         jsonb_build_array(jsonb_build_object('invoice_id', v_inv, 'amount', 13206)), null, 'fx');
  select status, paid_amount, fx_rate into i from public.invoices where id = v_inv;
  if i.status <> 'paid' then raise exception 'FAIL A: invoice is % (₹230 must not stay due)', i.status; end if;
  if i.fx_rate <> 95.007 then raise exception 'FAIL A: invoice rate moved to %', i.fx_rate; end if;
  select id, amount, bank_txn_id into p from public.payments where quote_id = 'Q-R1678-PEAK' and status = 'received';
  if p.amount <> 13206 then raise exception 'FAIL A: receipt is ₹%, not the ₹13,206 due', p.amount; end if;
  if p.bank_txn_id is distinct from '11111111-0000-0000-0000-000000167801'::uuid then raise exception 'FAIL A: receipt not tied to the line'; end if;
  select category, amount, expense_date, paid, reconciled_txn_id into e from public.expenses
   where tenant_id = c_t and reconciled_txn_id = '11111111-0000-0000-0000-000000167801';
  if not found or e.category <> c_fx or e.amount <> 230 or e.expense_date <> '2026-09-03' or not e.paid then
    raise exception 'FAIL A: exchange line is % ₹% % paid=%', e.category, e.amount, e.expense_date, e.paid;
  end if;
  select count(*) into n from public.tds_receivable where tenant_id = c_t;
  if n <> 0 then raise exception 'FAIL A: the difference was booked as TDS'; end if;
  select count(*) into n from public.bank_receipt_round_offs where tenant_id = c_t;
  if n <> 0 then raise exception 'FAIL A: the difference was booked as round-off'; end if;
  select count(*) into n from public.report_settlement_shortfalls('2026-04-01', '2027-03-31') s where s.payment_id = p.id;
  if n <> 0 then raise exception 'FAIL A: the receipt also shows as a settlement shortfall'; end if;
  if (r->>'forex_difference')::int <> 230 or (r->>'bank_charges')::int <> 0 then raise exception 'FAIL A: result %', r; end if;
  select expense_groups into v_pnl from public.report_pnl('2026-09-01', '2026-09-30');
  if not exists (select 1 from jsonb_array_elements(v_pnl) x where x::text like '%' || c_fx || '%' and x::text like '%230%') then
    raise exception 'FAIL A: P&L does not show the ₹230 under "%": %', c_fx, v_pnl;
  end if;
  g := g - 12976;   -- the bank line's ₹ (in cash & bank already) now has its other side: the gap closes by exactly that
  if pg_temp.tb_gap() <> g then raise exception 'FAIL A: Trial Balance moved by % beyond the credit', pg_temp.tb_gap() - g; end if;
  raise notice 'A PASS: USD 139 @ 95.007 paid with ₹12,976 → invoice paid, ₹230 exchange loss, TB balanced';

  -- ── B. INW remittance at another rate on one invoice → loss + inward reference ─────────────
  v_inv := pg_temp.inv('Q-R1678-TIMB');
  r := public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000167802', 'cccccccc-0000-0000-0000-000000167802',
         jsonb_build_array(jsonb_build_object('invoice_id', v_inv, 'amount', 72234)), null, 'fx');
  select status, export_inward_ref into i from public.invoices where id = v_inv;
  if i.status <> 'paid' or i.export_inward_ref is distinct from '050826I049900010' then
    raise exception 'FAIL B: invoice % ref %', i.status, i.export_inward_ref;
  end if;
  select amount, category into e from public.expenses where tenant_id = c_t and reconciled_txn_id = '11111111-0000-0000-0000-000000167802';
  if e.amount <> 1230 or e.category <> c_fx then raise exception 'FAIL B: exchange line % ₹%', e.category, e.amount; end if;
  g := g - 71004;
  if pg_temp.tb_gap() <> g then raise exception 'FAIL B: Trial Balance moved by % beyond the credit', pg_temp.tb_gap() - g; end if;
  raise notice 'B PASS: USD 759 @ 95.17 paid at 93.55 → ₹1,230 loss, inward ref recorded';

  -- ── C. several USD invoices on one inward credit → split by each invoice's USD ─────────────
  v_inv := pg_temp.inv('Q-R1678-BOT1');
  v_inv2 := pg_temp.inv('Q-R1678-BOT2');
  r := public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000167803', 'cccccccc-0000-0000-0000-000000167803',
         jsonb_build_array(jsonb_build_object('invoice_id', v_inv, 'amount', 90000), jsonb_build_object('invoice_id', v_inv2, 'amount', 46000)),
         null, 'fx');
  select count(*) into n from public.invoices where id in (v_inv, v_inv2) and status = 'paid' and export_inward_ref = '100926I049900020';
  if n <> 2 then raise exception 'FAIL C: % of 2 invoices paid with the inward ref', n; end if;
  select amount into e from public.expenses where tenant_id = c_t and reconciled_txn_id = '11111111-0000-0000-0000-000000167803' and category = c_fx;
  if e.amount <> -6500 then raise exception 'FAIL C: gain line ₹%', e.amount; end if;
  if jsonb_array_length(r->'fx_parts') <> 2 then raise exception 'FAIL C: fx_parts %', r->'fx_parts'; end if;
  for v_part in select value from jsonb_array_elements(r->'fx_parts') loop
    if (v_part->>'invoice_id' = v_inv and ((v_part->>'forex')::int <> -5000 or (v_part->>'bank_share')::int <> 95000 or (v_part->>'foreign_due')::numeric <> 1000))
       or (v_part->>'invoice_id' = v_inv2 and ((v_part->>'forex')::int <> -1500 or (v_part->>'bank_share')::int <> 47500 or (v_part->>'foreign_due')::numeric <> 500)) then
      raise exception 'FAIL C: part %', v_part;
    end if;
  end loop;
  g := g - 142500;
  if pg_temp.tb_gap() <> g then raise exception 'FAIL C: Trial Balance moved by % beyond the credit', pg_temp.tb_gap() - g; end if;
  raise notice 'C PASS: $1,000 + $500 on one USD 1,500 @ 95 credit → both paid, gain ₹5,000 + ₹1,500';

  -- ── D. refusals (nothing booked) ─────────────────────────────────────────────────────────
  -- D1. 'fx' on a ₹ invoice.
  ok := false;
  begin
    perform public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000167804', 'cccccccc-0000-0000-0000-000000167804',
              jsonb_build_array(jsonb_build_object('invoice_id', pg_temp.inv('Q-R1678-INR'), 'amount', 10000)), null, 'fx');
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like '%is in ₹%exchange%';
    if not ok then raise exception 'FAIL D1: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL D1: a ₹ invoice took an exchange difference'; end if;
  -- D2. part payment of a USD invoice with 'fx'.
  ok := false;
  begin
    perform public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000167805', 'cccccccc-0000-0000-0000-000000167803',
              jsonb_build_array(jsonb_build_object('invoice_id', pg_temp.inv('Q-R1678-BOT3'), 'amount', 40000)), null, 'fx');
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like '%in full%';
    if not ok then raise exception 'FAIL D2: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL D2: a part payment was settled as an exchange difference'; end if;
  -- D3. 'fx' with a new sale.
  ok := false;
  begin
    perform public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000167805', 'cccccccc-0000-0000-0000-000000167803',
              jsonb_build_array(jsonb_build_object('invoice_id', pg_temp.inv('Q-R1678-BOT3'), 'amount', 47000)),
              '{"lines":[{"item_id":null,"name":"x","qty":1,"rate":1000,"cost":0,"commitment":"one_time"}],"billing_cycle":"yearly","amount":1000}'::jsonb, 'fx');
  exception when sqlstate '22023' or check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like '%new sale%';
    if not ok then raise exception 'FAIL D3: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL D3: a new sale was booked with an exchange difference'; end if;
  -- D4. ₹40,000 for a ₹47,000 USD invoice = 15% short: not an exchange difference.
  ok := false;
  begin
    perform public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000167805', 'cccccccc-0000-0000-0000-000000167803',
              jsonb_build_array(jsonb_build_object('invoice_id', pg_temp.inv('Q-R1678-BOT3'), 'amount', 47000)), null, 'fx');
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like '%more than 10%%';
    if not ok then raise exception 'FAIL D4: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL D4: a 15%% gap was booked as an exchange difference'; end if;
  -- D5. EUR remittance on a USD invoice.
  ok := false;
  begin
    perform public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000167806', 'cccccccc-0000-0000-0000-000000167803',
              jsonb_build_array(jsonb_build_object('invoice_id', pg_temp.inv('Q-R1678-BOT3'), 'amount', 47000)), null, 'fx');
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like '%came in EUR%';
    if not ok then raise exception 'FAIL D5: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL D5: EUR money settled a USD invoice'; end if;
  -- D6. USD 600 in for USD 500 due — the extra is an advance, not an exchange difference.
  ok := false;
  begin
    perform public.reconcile_bank_credit_split('11111111-0000-0000-0000-000000167807', 'cccccccc-0000-0000-0000-000000167803',
              jsonb_build_array(jsonb_build_object('invoice_id', pg_temp.inv('Q-R1678-BOT3'), 'amount', 47000)), null, 'fx');
  exception when check_violation then
    get stacked diagnostics v_msg = message_text;
    ok := v_msg like '%advance%';
    if not ok then raise exception 'FAIL D6: wrong message "%"', v_msg; end if;
  end;
  if not ok then raise exception 'FAIL D6: more dollars than due were booked as an exchange gain'; end if;
  select count(*) into n from public.bank_transactions where tenant_id = c_t and matched_to_type is not null
     and id in ('11111111-0000-0000-0000-000000167804','11111111-0000-0000-0000-000000167805','11111111-0000-0000-0000-000000167806','11111111-0000-0000-0000-000000167807');
  if n <> 0 then raise exception 'FAIL D: % refused lines were reconciled', n; end if;
  if (select status from public.invoices where id = pg_temp.inv('Q-R1678-BOT3')) <> 'pending' then raise exception 'FAIL D: BOT3 was paid'; end if;
  raise notice 'D PASS: ₹ invoice, part payment, new sale, 15%% gap, other currency, extra dollars refused';

  -- ── E. un-reconcile A's line → its exchange line goes ──────────────────────────────────────
  update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = '11111111-0000-0000-0000-000000167801';
  select count(*) into n from public.expenses where tenant_id = c_t and reconciled_txn_id = '11111111-0000-0000-0000-000000167801';
  if n <> 0 then raise exception 'FAIL E: % exchange lines left after un-reconcile', n; end if;
  -- E2. B's INW line un-reconciled → the inward reference it stamped is cleared too (a re-match records the right one).
  update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = '11111111-0000-0000-0000-000000167802';
  if (select export_inward_ref from public.invoices where id = pg_temp.inv('Q-R1678-TIMB')) is not null then
    raise exception 'FAIL E2: the inward reference stayed after the line was un-reconciled';
  end if;
  -- E3. A word after "INW" is not a reference (needs a digit).
  if public.bank_inward_ref('INW TRANSFER USD1000.0@84.5 ACME') is not null
     or public.bank_inward_ref('INW 070826I049902623 USD1024.0@93.6') is distinct from '070826I049902623' then
    raise exception 'FAIL E3: bank_inward_ref % / %', public.bank_inward_ref('INW TRANSFER USD1000.0@84.5 ACME'), public.bank_inward_ref('INW 070826I049902623 USD1024.0@93.6');
  end if;
  raise notice 'E PASS: un-reconciled lines → exchange line and inward reference removed; "INW TRANSFER" is no reference';

  -- ── F. new export sale from a USD inward credit ───────────────────────────────────────────
  r := public.reconcile_bank_credit_new_sale_fx('11111111-0000-0000-0000-000000167808', 'cccccccc-0000-0000-0000-000000167802',
         '[{"item_id":null,"name":"Website design","qty":1,"rate":95846,"cost":0,"commitment":"one_time"}]'::jsonb,
         false, null, null, 'yearly', null, 'USD', 93.6, 1024);
  select invoice_date, gst_treatment, pos_state_code, tax_rate, tax_amount, currency, fx_rate, customer_country, export_inward_ref, document_kind
    into i from public.invoices where id = r->>'invoice_id';
  if i.invoice_date <> '2026-08-07' or i.gst_treatment <> 'overseas' or i.pos_state_code <> '96' or i.tax_rate <> 0
     or coalesce(i.tax_amount, 0) <> 0 or i.currency <> 'USD' or i.fx_rate <> 93.6 or i.customer_country <> 'United Arab Emirates'
     or i.document_kind <> 'tax_invoice' or i.export_inward_ref is distinct from '070826I049902623' then
    raise exception 'FAIL F: export invoice %', row_to_json(i);
  end if;
  raise notice 'F PASS: USD sale → export invoice dated the credit, overseas, POS 96, 0%%, USD @ 93.6, inward ref';

  -- ── G. R-2427's single-invoice path → the same ledger ──────────────────────────────────────
  update public.quotes set exchange_rate = 83 where id = 'Q-R1678-BOT3';
  insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                             status, payment_status, billing_cycle, line_items, is_one_off, created_date, currency, exchange_rate)
  values ('Q-R1678-G', c_t, 'cccccccc-0000-0000-0000-000000167803', 'The Bot Workshop LLC', 83000, 83000, 0, 0, 'accepted', 'awaiting', 'yearly',
          '[{"name":"Services G","qty":1,"rate":83000,"one_time":true}]'::jsonb, true, '2026-07-01', 'USD', 83);
  perform public.generate_invoice('Q-R1678-G');
  r := public.reconcile_bank_credit_fx_invoice('11111111-0000-0000-0000-000000167809', pg_temp.inv('Q-R1678-G'), 'USD', 84.5, 1000);
  select category, amount into e from public.expenses where tenant_id = c_t and reconciled_txn_id = '11111111-0000-0000-0000-000000167809';
  if e.category <> c_fx or e.amount <> -1500 then raise exception 'FAIL G: % ₹%', e.category, e.amount; end if;
  if (select export_inward_ref from public.invoices where id = pg_temp.inv('Q-R1678-G')) is distinct from '200826I049900090' then
    raise exception 'FAIL G: no inward ref';
  end if;
  raise notice 'G PASS: R-2427 path books under "%" and records the inward ref', c_fx;
end $$;

select 'R-1678 forex receipts + export inward ref: ALL PASS' as result;

rollback;
