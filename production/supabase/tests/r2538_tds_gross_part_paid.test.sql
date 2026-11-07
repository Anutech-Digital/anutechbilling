-- R-2538 (7 Nov 2026, p1 money): the automatic TDS row on a sale billed in parts used the WHOLE quote
-- subtotal as its gross (staging: TDS-CD79F6A752 on receipt RV-A378-27-0184, part 1 of Q-A378-27-0191 —
-- gross ₹1,57,500, the part paid was ₹78,750). The same in bank_credit_pay_item's Zoho-sale branch on a
-- part payment (R-2542 review #1), the rate stayed null when the caller gave none, a replay was matched
-- by reference alone (#2) and a written-off invoice was not refused (#3).
-- Migration 20261107074500_r2538_tds_gross_part_paid (bank_credit_pay_item). Self-asserting, ONE
-- transaction, rolled back. RED without the migration (A: gross = ₹1,57,500, not ₹78,750).
--
--   A. Half-yearly sale from a bank receipt (R-2095's owner case): ₹91,350 bank + ₹1,575 TDS 2% 194C on a
--      ₹1,57,500/yr sale → ONE TDS row, gross ₹78,750 (the part's taxable), rate 2, net ₹91,350.
--   B. The same with no rate given → rate 2 derived from the part's gross, not 1 from the whole year.
--   C. Zoho FY sale ₹11,800 paid in two parts (₹5,800 + ₹100 TDS each, no rate) → two TDS rows of gross
--      ₹5,000 and rate 2 each; the invoice is paid.
--   D. Replay compares amounts: a paid Zoho sale, a NEW line with the SAME reference but a different
--      amount → refused, no second receipt; the same reference + same amount (line un-reconciled, receipt
--      kept) → the same receipt; a NEW reference on the paid sale → refused ("is paid").
--   E. A draft Zoho sale → refused, nothing saved.
--   F. A written-off Zoho sale → not listed, refused, nothing saved.
--   G. Another company's bank line vs this company's Zoho sale → refused both ways, nothing saved.
--   H. reconcile_bank_credit_split over two Zoho sales → both paid, two receipts, the line matched.
--   I. (review) The customer deducted 2% of the WHOLE year (₹3,150) from part 1, rate 2 given → gross
--      ₹1,57,500 (TDS × 100 ÷ rate, what 26AS shows), not a ₹78,750 row that contradicts its own rate.
--   J. (review) A Zoho receipt booked with ₹100 TDS, line freed (receipt kept), matched again with the TDS
--      left empty → the same receipt, not refused.
--   K. (review) A Zoho sale part-paid, the rest written off, line freed (receipt kept), matched again →
--      the same receipt; a NEW line on it is still refused.

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

insert into auth.users (id, email) values
  ('b2538000-0000-0000-0000-0000000000a1', 'r2538-owner@example.test'),
  ('b2538000-0000-0000-0000-0000000000a2', 'r2538-other@example.test');
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('b2538000-0000-0000-0000-0000000000f0', 'R2538 T', 'r2538@example.test', '07', 'R2538'),
  ('b2538000-0000-0000-0000-0000000000f1', 'R2538 O', 'r2538o@example.test', '07', 'R2538O');
insert into public.users (id, tenant_id, email, full_name, role, is_active, created_at) values
  ('b2538000-0000-0000-0000-0000000000a1', 'b2538000-0000-0000-0000-0000000000f0', 'r2538-owner@example.test', 'Owner', 'owner', true, now() - interval '1 day'),
  ('b2538000-0000-0000-0000-0000000000a2', 'b2538000-0000-0000-0000-0000000000f1', 'r2538-other@example.test', 'Other', 'owner', true, now() - interval '1 day');
update public.tenants set books_start_date = '2025-04-01' where id in ('b2538000-0000-0000-0000-0000000000f0', 'b2538000-0000-0000-0000-0000000000f1');

insert into public.customers (id, tenant_id, name, gstin, state_code, country, domain) values
  ('b2538000-0000-0000-0000-0000000000c1', 'b2538000-0000-0000-0000-0000000000f0', 'R2538 Half Buyer', '07AAACR2538B1Z5', '07', 'India', 'half2538.in'),
  ('b2538000-0000-0000-0000-0000000000c2', 'b2538000-0000-0000-0000-0000000000f1', 'R2538 Other Buyer', null, '07', 'India', 'other2538.in');
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_number_last4, opening_balance_date) values
  ('b2538000-0000-0000-0000-0000000000d1', 'b2538000-0000-0000-0000-0000000000f0', 'Current', 'HDFC', '2538', '2025-04-01'),
  ('b2538000-0000-0000-0000-0000000000d2', 'b2538000-0000-0000-0000-0000000000f1', 'Other Current', 'ICICI', '2539', '2025-04-01');

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  -- A, B: two half-yearly sales, H1 paid net of 2% TDS (₹92,925 − ₹1,575)
  ('b2538000-0000-0000-0000-0000000000e1', 'b2538000-0000-0000-0000-0000000000f0', 'b2538000-0000-0000-0000-0000000000d1', '2026-06-19', 'NEFT HALF 2538 A', 0, 91350, 'R2538UTRA', 'manual'),
  ('b2538000-0000-0000-0000-0000000000e2', 'b2538000-0000-0000-0000-0000000000f0', 'b2538000-0000-0000-0000-0000000000d1', '2026-06-19', 'NEFT HALF 2538 B', 0, 91350, 'R2538UTRB', 'manual'),
  -- C: the ₹11,800 Zoho sale in two parts of ₹5,900 (₹5,800 bank + ₹100 TDS)
  ('b2538000-0000-0000-0000-0000000000e3', 'b2538000-0000-0000-0000-0000000000f0', 'b2538000-0000-0000-0000-0000000000d1', '2026-01-05', 'NEFT PART 1', 0, 5800, 'R2538UTRC1', 'manual'),
  ('b2538000-0000-0000-0000-0000000000e4', 'b2538000-0000-0000-0000-0000000000f0', 'b2538000-0000-0000-0000-0000000000d1', '2026-01-06', 'NEFT PART 2', 0, 5800, 'R2538UTRC2', 'manual'),
  -- D: the ₹1,180 Zoho sale paid in full; then the same reference with ₹500; then a new reference
  ('b2538000-0000-0000-0000-0000000000e5', 'b2538000-0000-0000-0000-0000000000f0', 'b2538000-0000-0000-0000-0000000000d1', '2026-01-07', 'NEFT FULL', 0, 1180, 'R2538UTRD', 'manual'),
  ('b2538000-0000-0000-0000-0000000000e6', 'b2538000-0000-0000-0000-0000000000f0', 'b2538000-0000-0000-0000-0000000000d1', '2026-01-08', 'NEFT SAME REF OTHER AMOUNT', 0, 500, 'R2538UTRD', 'manual'),
  ('b2538000-0000-0000-0000-0000000000e7', 'b2538000-0000-0000-0000-0000000000f0', 'b2538000-0000-0000-0000-0000000000d1', '2026-01-09', 'NEFT NEW REF', 0, 1180, 'R2538UTRD2', 'manual'),
  -- E, F: draft / written-off
  ('b2538000-0000-0000-0000-0000000000e8', 'b2538000-0000-0000-0000-0000000000f0', 'b2538000-0000-0000-0000-0000000000d1', '2026-01-10', 'NEFT DRAFT', 0, 5900, 'R2538UTRE', 'manual'),
  ('b2538000-0000-0000-0000-0000000000e9', 'b2538000-0000-0000-0000-0000000000f0', 'b2538000-0000-0000-0000-0000000000d1', '2026-01-11', 'NEFT WRITTEN OFF', 0, 5900, 'R2538UTRF', 'manual'),
  -- H: split over two Zoho sales (₹5,900 + ₹1,180)
  ('b2538000-0000-0000-0000-0000000000ea', 'b2538000-0000-0000-0000-0000000000f0', 'b2538000-0000-0000-0000-0000000000d1', '2026-01-12', 'NEFT SPLIT', 0, 7080, 'R2538UTRH', 'manual'),
  -- G: the OTHER company's line
  ('b2538000-0000-0000-0000-0000000000eb', 'b2538000-0000-0000-0000-0000000000f1', 'b2538000-0000-0000-0000-0000000000d2', '2026-01-13', 'NEFT OTHER CO', 0, 5900, 'R2538UTRG', 'manual'),
  -- I: H1 of a half-yearly sale, the customer kept 2% of the whole year (₹92,925 − ₹3,150)
  ('b2538000-0000-0000-0000-0000000000ec', 'b2538000-0000-0000-0000-0000000000f0', 'b2538000-0000-0000-0000-0000000000d1', '2026-06-19', 'NEFT HALF 2538 I', 0, 89775, 'R2538UTRI', 'manual'),
  -- J: the ₹1,180 Zoho sale paid ₹1,080 + ₹100 TDS
  ('b2538000-0000-0000-0000-0000000000ed', 'b2538000-0000-0000-0000-0000000000f0', 'b2538000-0000-0000-0000-0000000000d1', '2026-01-14', 'NEFT TDS REPLAY', 0, 1080, 'R2538UTRJ', 'manual'),
  -- K: the ₹1,180 Zoho sale part-paid ₹1,130 (₹50 written off later); then a new line
  ('b2538000-0000-0000-0000-0000000000ee', 'b2538000-0000-0000-0000-0000000000f0', 'b2538000-0000-0000-0000-0000000000d1', '2026-01-15', 'NEFT WO REPLAY', 0, 1130, 'R2538UTRK', 'manual'),
  ('b2538000-0000-0000-0000-0000000000ef', 'b2538000-0000-0000-0000-0000000000f0', 'b2538000-0000-0000-0000-0000000000d1', '2026-01-16', 'NEFT WO NEW', 0, 50, 'R2538UTRK2', 'manual');

-- The Zoho FY sales (R-2499's import): C ₹10,000+1,800; D ₹1,000+180; E ₹5,000+900 (draft); F ₹5,000+900
-- (written off); H1 ₹5,000+900, H2 ₹1,000+180.
create function pg_temp.s(num text, d text, taxable int, tax int)
returns jsonb language sql as $f$
  select jsonb_build_object('number', num, 'date', d, 'dueDate', d, 'status', 'sent', 'customerName', 'Buyer', 'gstin', '',
    'posStateCode', '07', 'head', 'cgst_sgst', 'currency', 'INR', 'fxRate', null, 'taxable', taxable, 'tax', tax, 'amount', taxable + tax,
    'taxRate', 18, 'appGstTreatment', 'registered_regular', 'problems', '[]'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('name', 'R2538 Seat', 'hsn', '998315', 'qty', 1, 'rate', taxable, 'taxable', taxable)));
$f$;
insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at) values
  ('b2538000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'zc', 'INV/25-26/R2538-C', '2025-11-10', 'sent', pg_temp.s('INV/25-26/R2538-C', '2025-11-10', 10000, 1800), now()),
  ('b2538000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'zd', 'INV/25-26/R2538-D', '2025-11-11', 'sent', pg_temp.s('INV/25-26/R2538-D', '2025-11-11', 1000, 180), now()),
  ('b2538000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'ze', 'INV/25-26/R2538-E', '2025-11-12', 'sent', pg_temp.s('INV/25-26/R2538-E', '2025-11-12', 5000, 900), now()),
  ('b2538000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'zf', 'INV/25-26/R2538-F', '2025-11-13', 'sent', pg_temp.s('INV/25-26/R2538-F', '2025-11-13', 5000, 900), now()),
  ('b2538000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'zh1', 'INV/25-26/R2538-H1', '2025-11-14', 'sent', pg_temp.s('INV/25-26/R2538-H1', '2025-11-14', 5000, 900), now()),
  ('b2538000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'zh2', 'INV/25-26/R2538-H2', '2025-11-15', 'sent', pg_temp.s('INV/25-26/R2538-H2', '2025-11-15', 1000, 180), now()),
  ('b2538000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'zj', 'INV/25-26/R2538-J', '2025-11-16', 'sent', pg_temp.s('INV/25-26/R2538-J', '2025-11-16', 1000, 180), now()),
  ('b2538000-0000-0000-0000-0000000000f0', 'invoices', '2025-26', 'zk', 'INV/25-26/R2538-K', '2025-11-17', 'sent', pg_temp.s('INV/25-26/R2538-K', '2025-11-17', 1000, 180), now());

create function pg_temp.as_user(p uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$f$;
create function pg_temp.zs(p text) returns text language sql as $f$
  select id from public.invoices where zoho_invoice_id = p and tenant_id = 'b2538000-0000-0000-0000-0000000000f0' $f$;
create function pg_temp.received(p_inv text) returns bigint language sql as $f$
  select coalesce(sum(amount), 0) from public.payments where invoice_id = p_inv and status = 'received' $f$;
create function pg_temp.matched(p_txn uuid) returns text language sql as $f$
  select matched_to_id from public.bank_transactions where id = p_txn $f$;
grant execute on function pg_temp.as_user(uuid), pg_temp.zs(text), pg_temp.received(text), pg_temp.matched(uuid) to authenticated;

set local role authenticated;
select pg_temp.as_user('b2538000-0000-0000-0000-0000000000a1');

do $$
declare r jsonb;
begin
  r := public.import_zoho_fy_sales('2025-26', (select jsonb_agg(jsonb_build_object('zoho_invoice_id', z, 'customer_id', 'b2538000-0000-0000-0000-0000000000c1'))
                                               from unnest(array['zc', 'zd', 'ze', 'zf', 'zh1', 'zh2', 'zj', 'zk']) z), false);
  if (r->>'imported')::int <> 8 then raise exception 'SETUP: sales import %', r; end if;
end $$;

-- ── A. half-yearly sale, H1 paid net of 2% TDS → gross = the part's taxable ──────────────────
do $$
declare r jsonb; q record; t record; n int;
begin
  r := public.reconcile_bank_credit_new_sale('b2538000-0000-0000-0000-0000000000e1', 'b2538000-0000-0000-0000-0000000000c1',
         '[{"item_id":null,"name":"Microsoft 365 Basic","qty":50,"rate":3150,"cost":0,"commitment":"annual_yearly"}]'::jsonb,
         true, '2026-06-19', null, 1575, 2, '194C', 'half_yearly');
  select * into q from public.quotes where id = r->>'quote_id';
  if q.subtotal <> 157500 or q.amount <> 185850 then raise exception 'FAIL A setup: quote subtotal % amount % (want 1,57,500 / 1,85,850)', q.subtotal, q.amount; end if;
  select count(*) into n from public.tds_receivable where tenant_id = 'b2538000-0000-0000-0000-0000000000f0';
  if n <> 1 then raise exception 'FAIL A: % TDS rows (want 1)', n; end if;
  select * into t from public.tds_receivable where tenant_id = 'b2538000-0000-0000-0000-0000000000f0';
  if t.gross_amount <> 78750 then
    raise exception 'FAIL A: TDS gross ₹% = the whole year''s subtotal (want ₹78,750, the part paid)', t.gross_amount; end if;
  if t.tds_amount <> 1575 or t.net_paid <> 91350 or t.rate_pct <> 2 or t.section <> '194C' then
    raise exception 'FAIL A: TDS row % (want ₹1,575 / net ₹91,350 / 2%% / 194C)', to_jsonb(t); end if;
  raise notice 'PASS A: half-yearly H1 with 2%% TDS → gross ₹78,750 (the part), not ₹1,57,500';
end $$;

-- ── B. no rate given → derived from the part's gross ─────────────────────────────────────────
do $$
declare r jsonb; t record;
begin
  r := public.reconcile_bank_credit_new_sale('b2538000-0000-0000-0000-0000000000e2', 'b2538000-0000-0000-0000-0000000000c1',
         '[{"item_id":null,"name":"Microsoft 365 Basic","qty":50,"rate":3150,"cost":0,"commitment":"annual_yearly"}]'::jsonb,
         true, '2026-06-19', null, 1575, null, '194C', 'half_yearly');
  select * into t from public.tds_receivable where payment_id = (r->>'payment_id')::uuid;
  if not found then raise exception 'FAIL B: no TDS row on the receipt'; end if;
  if t.gross_amount <> 78750 or t.rate_pct is distinct from 2 then
    raise exception 'FAIL B: gross ₹% rate % (want ₹78,750 / 2 — rate derived from the part, not 1 from the year)', t.gross_amount, t.rate_pct; end if;
  raise notice 'PASS B: no rate given → 2%% from the part''s gross';
end $$;

-- ── C. Zoho sale paid in two parts, ₹100 TDS each, no rate ───────────────────────────────────
do $$
declare v_inv text := pg_temp.zs('zc'); r jsonb; n int; bad int;
begin
  r := public.reconcile_bank_credit_to_item('b2538000-0000-0000-0000-0000000000e3', null, v_inv, 100, null, '194J');
  if (select status::text from public.invoices where id = v_inv) = 'paid' or pg_temp.received(v_inv) <> 5900 then
    raise exception 'FAIL C: after part 1: % / ₹% (want pending, ₹5,900)', (select status from public.invoices where id = v_inv), pg_temp.received(v_inv); end if;
  r := public.reconcile_bank_credit_to_item('b2538000-0000-0000-0000-0000000000e4', null, v_inv, 100, null, '194J');
  if (select status::text from public.invoices where id = v_inv) <> 'paid' or pg_temp.received(v_inv) <> 11800 then
    raise exception 'FAIL C: after part 2: % / ₹% (want paid, ₹11,800)', (select status from public.invoices where id = v_inv), pg_temp.received(v_inv); end if;
  select count(*), count(*) filter (where gross_amount <> 5000 or rate_pct is distinct from 2 or tds_amount <> 100 or net_paid <> 5800)
    into n, bad from public.tds_receivable where invoice_id = v_inv;
  if n <> 2 or bad <> 0 then
    raise exception 'FAIL C: % TDS rows, % wrong (want 2 rows of gross ₹5,000 / 2%% / ₹100 / net ₹5,800): %', n, bad,
      (select jsonb_agg(jsonb_build_object('gross', gross_amount, 'rate', rate_pct, 'tds', tds_amount)) from public.tds_receivable where invoice_id = v_inv); end if;
  raise notice 'PASS C: two parts on the Zoho sale → two TDS rows of gross ₹5,000, rate 2';
end $$;

-- ── D. replay compares amounts ───────────────────────────────────────────────────────────────
do $$
declare v_inv text := pg_temp.zs('zd'); r jsonb; v_pay text;
begin
  r := public.reconcile_bank_credit_to_item('b2538000-0000-0000-0000-0000000000e5', null, v_inv);
  v_pay := r->>'payment_id';
  if (select status::text from public.invoices where id = v_inv) <> 'paid' then raise exception 'FAIL D setup: not paid'; end if;

  /* same reference, different amount → refused, no second receipt */
  begin
    perform public.reconcile_bank_credit_to_item('b2538000-0000-0000-0000-0000000000e6', null, v_inv);
    raise exception 'FAIL D1: a ₹500 line with the paid receipt''s reference was accepted';
  exception when others then
    if sqlerrm like 'FAIL D1%' then raise; end if;
    if sqlerrm not like '%R2538UTRD%' or sqlerrm not like '%1,180%' then raise exception 'FAIL D1: wrong refusal: %', sqlerrm; end if;
  end;
  if pg_temp.received(v_inv) <> 1180 or pg_temp.matched('b2538000-0000-0000-0000-0000000000e6') is not null then
    raise exception 'FAIL D1: something was saved (₹% received)', pg_temp.received(v_inv); end if;

  /* same reference, same amount (line freed, receipt kept) → the same receipt */
  perform public.unreconcile_bank_receipt('b2538000-0000-0000-0000-0000000000e5', false);
  r := public.reconcile_bank_credit_to_item('b2538000-0000-0000-0000-0000000000e5', null, v_inv);
  if r->>'payment_id' <> v_pay or pg_temp.received(v_inv) <> 1180 then
    raise exception 'FAIL D2: re-booking the freed line made receipt % (want the same %)', r->>'payment_id', v_pay; end if;

  /* a NEW reference on the paid sale → refused */
  begin
    perform public.reconcile_bank_credit_to_item('b2538000-0000-0000-0000-0000000000e7', null, v_inv);
    raise exception 'FAIL D3: a new reference on a paid Zoho sale was accepted';
  exception when check_violation then
    if sqlerrm not like '%is paid%' then raise exception 'FAIL D3: wrong refusal: %', sqlerrm; end if;
  end;
  if pg_temp.received(v_inv) <> 1180 or pg_temp.matched('b2538000-0000-0000-0000-0000000000e7') is not null then
    raise exception 'FAIL D3: something was saved'; end if;
  raise notice 'PASS D: same reference + other amount refused; same amount → same receipt; new reference on a paid sale refused';
end $$;

-- ── E. a draft Zoho sale → refused ───────────────────────────────────────────────────────────
reset role;
alter table public.invoices disable trigger user;
update public.invoices set status = 'draft' where id = pg_temp.zs('ze');
update public.invoices set written_off_at = now() where id = pg_temp.zs('zf');
alter table public.invoices enable trigger user;
set local role authenticated;
do $$
declare v_inv text := pg_temp.zs('ze');
begin
  begin
    perform public.reconcile_bank_credit_to_item('b2538000-0000-0000-0000-0000000000e8', null, v_inv);
    raise exception 'FAIL E: a draft Zoho sale took a receipt';
  exception when check_violation then
    if sqlerrm not like '%is draft%' then raise exception 'FAIL E: wrong refusal: %', sqlerrm; end if;
  end;
  if pg_temp.received(v_inv) <> 0 or pg_temp.matched('b2538000-0000-0000-0000-0000000000e8') is not null then
    raise exception 'FAIL E: something was saved'; end if;
  raise notice 'PASS E: a draft Zoho sale is refused, nothing saved';
end $$;

-- ── F. a written-off Zoho sale → not listed, refused ─────────────────────────────────────────
do $$
declare v_inv text := pg_temp.zs('zf');
begin
  if exists (select 1 from public.bank_credit_open_items('b2538000-0000-0000-0000-0000000000c1') o where o.invoice_id = v_inv) then
    raise exception 'FAIL F: a written-off sale is listed as open'; end if;
  begin
    perform public.reconcile_bank_credit_to_item('b2538000-0000-0000-0000-0000000000e9', null, v_inv);
    raise exception 'FAIL F: a written-off Zoho sale took a receipt';
  exception when check_violation then
    if sqlerrm not ilike '%written off%' then raise exception 'FAIL F: wrong refusal: %', sqlerrm; end if;
  end;
  if pg_temp.received(v_inv) <> 0 or pg_temp.matched('b2538000-0000-0000-0000-0000000000e9') is not null then
    raise exception 'FAIL F: something was saved'; end if;
  raise notice 'PASS F: a written-off Zoho sale is refused, nothing saved';
end $$;

-- ── G. another company's line vs this company's Zoho sale ────────────────────────────────────
do $$
declare v_inv text := pg_temp.zs('zh1');
begin
  /* this company's login, the other company's line */
  begin
    perform public.reconcile_bank_credit_to_item('b2538000-0000-0000-0000-0000000000eb', null, v_inv);
    raise exception 'FAIL G1: this company booked on another company''s line';
  exception when others then
    if sqlerrm like 'FAIL G1%' then raise; end if;
  end;
  if pg_temp.received(v_inv) <> 0 or pg_temp.matched('b2538000-0000-0000-0000-0000000000eb') is not null then
    raise exception 'FAIL G1: something was saved'; end if;
  /* the other company's login, its own line, this company's sale */
  perform pg_temp.as_user('b2538000-0000-0000-0000-0000000000a2');
  begin
    perform public.reconcile_bank_credit_to_item('b2538000-0000-0000-0000-0000000000eb', null, v_inv);
    raise exception 'FAIL G2: another company paid this company''s Zoho sale from its own line';
  exception when others then
    if sqlerrm like 'FAIL G2%' then raise; end if;
  end;
  perform pg_temp.as_user('b2538000-0000-0000-0000-0000000000a1');
  if pg_temp.received(v_inv) <> 0 or pg_temp.matched('b2538000-0000-0000-0000-0000000000eb') is not null
     or exists (select 1 from public.payments where tenant_id = 'b2538000-0000-0000-0000-0000000000f1') then
    raise exception 'FAIL G2: something was saved'; end if;
  raise notice 'PASS G: another company''s line vs this company''s sale → refused both ways';
end $$;

-- ── H. split over two Zoho sales ─────────────────────────────────────────────────────────────
do $$
declare r jsonb; h1 text := pg_temp.zs('zh1'); h2 text := pg_temp.zs('zh2'); n int;
begin
  r := public.reconcile_bank_credit_split('b2538000-0000-0000-0000-0000000000ea', 'b2538000-0000-0000-0000-0000000000c1',
         jsonb_build_array(jsonb_build_object('invoice_id', h1, 'amount', 5900), jsonb_build_object('invoice_id', h2, 'amount', 1180)));
  if (select status::text from public.invoices where id = h1) <> 'paid' or (select status::text from public.invoices where id = h2) <> 'paid'
     or pg_temp.received(h1) <> 5900 or pg_temp.received(h2) <> 1180 then
    raise exception 'FAIL H: % ₹% / % ₹% (want both paid) — %', (select status from public.invoices where id = h1), pg_temp.received(h1),
      (select status from public.invoices where id = h2), pg_temp.received(h2), r; end if;
  select count(*) into n from public.payments where invoice_id in (h1, h2) and status = 'received' and bank_txn_id = 'b2538000-0000-0000-0000-0000000000ea';
  if n <> 2 then raise exception 'FAIL H: % receipts on the split line (want 2)', n; end if;
  if (select matched_to_type from public.bank_transactions where id = 'b2538000-0000-0000-0000-0000000000ea') is null then
    raise exception 'FAIL H: the split line is not matched'; end if;
  raise notice 'PASS H: split over two Zoho sales → both paid, two receipts';
end $$;

-- ── I. the customer deducted on the whole year from part 1, rate given ──────────────────────
do $$
declare r jsonb; t record;
begin
  r := public.reconcile_bank_credit_new_sale('b2538000-0000-0000-0000-0000000000ec', 'b2538000-0000-0000-0000-0000000000c1',
         '[{"item_id":null,"name":"Microsoft 365 Basic","qty":50,"rate":3150,"cost":0,"commitment":"annual_yearly"}]'::jsonb,
         true, '2026-06-19', null, 3150, 2, '194C', 'half_yearly');
  select * into t from public.tds_receivable where payment_id = (r->>'payment_id')::uuid;
  if not found then raise exception 'FAIL I: no TDS row on the receipt'; end if;
  if t.gross_amount <> 157500 or t.rate_pct <> 2 or t.tds_amount <> 3150 then
    raise exception 'FAIL I: gross ₹% rate % TDS ₹% (want ₹1,57,500 / 2 / ₹3,150 — 2%% of the year the customer deducted on)',
      t.gross_amount, t.rate_pct, t.tds_amount; end if;
  raise notice 'PASS I: 2%% of the whole year kept from part 1 → gross ₹1,57,500, consistent with its rate';
end $$;

-- ── J. replay of a receipt booked with TDS, TDS left empty the second time ───────────────────
do $$
declare v_inv text := pg_temp.zs('zj'); r jsonb; v_pay text;
begin
  r := public.reconcile_bank_credit_to_item('b2538000-0000-0000-0000-0000000000ed', null, v_inv, 100, null, '194J');
  v_pay := r->>'payment_id';
  if pg_temp.received(v_inv) <> 1180 then raise exception 'FAIL J setup: ₹% received (want ₹1,180)', pg_temp.received(v_inv); end if;
  perform public.unreconcile_bank_receipt('b2538000-0000-0000-0000-0000000000ed', false);
  r := public.reconcile_bank_credit_to_item('b2538000-0000-0000-0000-0000000000ed', null, v_inv);
  if r->>'payment_id' <> v_pay or pg_temp.received(v_inv) <> 1180
     or (select count(*) from public.tds_receivable where invoice_id = v_inv) <> 1 then
    raise exception 'FAIL J: re-match without TDS gave receipt % (want the same %), ₹% received', r->>'payment_id', v_pay, pg_temp.received(v_inv); end if;
  raise notice 'PASS J: a freed TDS receipt is matched back with the TDS left empty';
end $$;

-- ── K. written off after a part payment: the kept receipt goes back, new money refused ───────
do $$
declare v_inv text := pg_temp.zs('zk'); r jsonb;
begin
  r := public.reconcile_bank_credit_to_item('b2538000-0000-0000-0000-0000000000ee', null, v_inv);
  if pg_temp.received(v_inv) <> 1130 then raise exception 'FAIL K setup: ₹% received (want ₹1,130)', pg_temp.received(v_inv); end if;
  perform public.unreconcile_bank_receipt('b2538000-0000-0000-0000-0000000000ee', false);
end $$;
reset role;
alter table public.invoices disable trigger user;
update public.invoices set written_off_at = now() where id = pg_temp.zs('zk');
alter table public.invoices enable trigger user;
set local role authenticated;
do $$
declare v_inv text := pg_temp.zs('zk'); r jsonb; v_pay uuid;
begin
  select id into v_pay from public.payments where invoice_id = v_inv and status = 'received';
  r := public.reconcile_bank_credit_to_item('b2538000-0000-0000-0000-0000000000ee', null, v_inv);
  if (r->>'payment_id')::uuid is distinct from v_pay or pg_temp.received(v_inv) <> 1130
     or pg_temp.matched('b2538000-0000-0000-0000-0000000000ee') is null then
    raise exception 'FAIL K1: the freed line did not go back to its receipt (% vs %): %', r->>'payment_id', v_pay, r; end if;
  begin
    perform public.reconcile_bank_credit_to_item('b2538000-0000-0000-0000-0000000000ef', null, v_inv);
    raise exception 'FAIL K2: a written-off sale took new money';
  exception when check_violation then
    if sqlerrm not ilike '%written off%' then raise exception 'FAIL K2: wrong refusal: %', sqlerrm; end if;
  end;
  if pg_temp.received(v_inv) <> 1130 then raise exception 'FAIL K2: something was saved'; end if;
  raise notice 'PASS K: written-off sale — kept receipt matched back, new money refused';
end $$;

rollback;
